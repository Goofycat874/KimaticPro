import * as THREE from 'three';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { store } from '../core/store';
import { togglePickRef } from '../core/actions';
import type { Vec3 } from '../core/types';

export interface PickView {
  bodyId: string;
  mesh: THREE.Mesh;
  edges: THREE.LineSegments;
}

export interface PickHost {
  camera: () => THREE.Camera;
  canvas: HTMLCanvasElement;
  size: () => { w: number; h: number };
  views: () => PickView[];
  invalidate: () => void;
}

interface Hit { bodyId: string; sid: number; point: THREE.Vector3; view: PickView }

/**
 * Edge and face picking for the precise tools. Precise bodies know which B-rep edge
 * or face each segment/triangle belongs to, so a click selects the whole edge or face.
 */
export class PickController {
  readonly group = new THREE.Group();
  private hoverGroup = new THREE.Group();
  private pickedGroup = new THREE.Group();
  private ray = new THREE.Raycaster();
  private hover: Hit | null = null;
  private mats: LineMaterial[] = [];

  constructor(private host: PickHost) {
    this.group.add(this.pickedGroup, this.hoverGroup);
    this.group.renderOrder = 40;
  }

  private ndc(e: { clientX: number; clientY: number }) {
    const r = this.host.canvas.getBoundingClientRect();
    return new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  }

  /** World units covered by `px` screen pixels near `at`. */
  private worldPerPixel(at: THREE.Vector3, px: number) {
    const cam = this.host.camera() as THREE.PerspectiveCamera | THREE.OrthographicCamera;
    const h = this.host.size().h;
    if ((cam as THREE.OrthographicCamera).isOrthographicCamera) {
      const o = cam as THREE.OrthographicCamera;
      return ((o.top - o.bottom) / o.zoom / h) * px;
    }
    const p = cam as THREE.PerspectiveCamera;
    const d = p.position.distanceTo(at);
    return ((2 * d * Math.tan((p.fov * Math.PI) / 360)) / h) * px;
  }

  private hitTest(e: { clientX: number; clientY: number }): Hit | null {
    const kind = store.state.pick?.kind;
    if (!kind) return null;
    this.ray.setFromCamera(this.ndc(e), this.host.camera());
    const views = this.host.views().filter((v) => v.mesh.visible);
    const meshHits = this.ray.intersectObjects(views.map((v) => v.mesh), false);
    const front = meshHits[0];
    if (kind === 'faces') {
      if (!front || front.faceIndex == null) return null;
      const view = views.find((v) => v.mesh === front.object)!;
      const triFace = (view.mesh.geometry.userData.triFace as Int32Array | null) ?? null;
      const sid = triFace ? triFace[front.faceIndex] : -2 - front.faceIndex;
      return { bodyId: view.bodyId, sid, point: front.point.clone(), view };
    }
    // edges: nearest segment to the ray, but not hidden behind the surface
    const near = front?.point ?? this.ray.ray.at(1000, new THREE.Vector3());
    this.ray.params.Line = { threshold: this.worldPerPixel(near, 7) };
    // edge lines are normally click-through, so call the real line raycast directly
    const raw: THREE.Intersection[] = [];
    for (const v of views) THREE.LineSegments.prototype.raycast.call(v.edges, this.ray, raw);
    const hits = raw.sort((a, b) => a.distance - b.distance)
      .filter((h) => !front || h.distance <= front.distance + this.worldPerPixel(h.point, 10));
    const h = hits[0];
    if (!h || h.index == null) return null;
    const view = views.find((v) => v.edges === h.object)!;
    const seg = Math.floor(h.index / 2);
    const ids = view.mesh.geometry.userData.edgeIds as Int32Array | undefined;
    const sid = ids ? ids[seg] : -2 - seg;
    // closest point on that segment, in world space
    const pos = (h.object as THREE.LineSegments).geometry.getAttribute('position');
    const a = new THREE.Vector3().fromBufferAttribute(pos, seg * 2).applyMatrix4(h.object.matrixWorld);
    const b = new THREE.Vector3().fromBufferAttribute(pos, seg * 2 + 1).applyMatrix4(h.object.matrixWorld);
    const point = new THREE.Vector3();
    this.ray.ray.distanceSqToSegment(a, b, undefined, point);
    return { bodyId: view.bodyId, sid, point, view };
  }

  move(e: PointerEvent) {
    const h = this.hitTest(e);
    const same = h && this.hover && h.bodyId === this.hover.bodyId && h.sid === this.hover.sid;
    if (same || (!h && !this.hover)) return;
    this.hover = h;
    this.clear(this.hoverGroup);
    if (h) this.highlight(this.hoverGroup, h.view, h.sid, '#fbbf24', 0.45);
    this.host.canvas.style.cursor = h ? 'pointer' : 'crosshair';
    this.host.invalidate();
  }

  click(e: PointerEvent) {
    const h = this.hitTest(e);
    if (!h) return;
    if (!h.view.mesh.geometry.userData.precise) {
      store.toast('That body is a mesh (threads or STL), so it can’t be filleted or shelled.', 'error');
      return;
    }
    togglePickRef(h.bodyId, h.point.toArray() as Vec3, h.sid);
  }

  /** Redraw the persistent highlights for everything picked so far. */
  sync() {
    this.clear(this.pickedGroup);
    const p = store.state.pick;
    if (!p) { this.clear(this.hoverGroup); this.hover = null; this.host.invalidate(); return; }
    const views = this.host.views();
    for (const r of p.refs) {
      const v = views.find((x) => x.bodyId === r.bodyId);
      if (!v) continue;
      const sid = r.sid >= 0 ? r.sid : this.nearestSid(v, new THREE.Vector3(...r.point), p.kind);
      if (sid !== null) this.highlight(this.pickedGroup, v, sid, '#2f7bff', 0.5);
    }
    this.host.invalidate();
  }

  /** For refs loaded from a saved step: find the edge/face nearest the remembered point. */
  private nearestSid(v: PickView, world: THREE.Vector3, kind: 'edges' | 'faces'): number | null {
    const g = v.mesh.geometry;
    const inv = v.mesh.matrixWorld.clone().invert();
    const p = world.clone().applyMatrix4(inv);
    let best: number | null = null, bestD = Infinity;
    if (kind === 'edges') {
      const ids = g.userData.edgeIds as Int32Array | undefined;
      const pos = (v.edges.geometry.getAttribute('position'));
      const a = new THREE.Vector3(), b = new THREE.Vector3(), line = new THREE.Line3(), c = new THREE.Vector3();
      for (let s = 0; s < pos.count / 2; s++) {
        a.fromBufferAttribute(pos, s * 2); b.fromBufferAttribute(pos, s * 2 + 1);
        line.set(a, b);
        const d = line.closestPointToPoint(p, true, c).distanceTo(p);
        if (d < bestD) { bestD = d; best = ids ? ids[s] : -2 - s; }
      }
    } else {
      const tri = g.userData.triFace as Int32Array | undefined;
      const pos = g.getAttribute('position'), idx = g.index;
      const t = new THREE.Triangle(), c = new THREE.Vector3();
      const n = (idx ? idx.count : pos.count) / 3;
      for (let i = 0; i < n; i++) {
        const ia = idx ? idx.getX(i * 3) : i * 3, ib = idx ? idx.getX(i * 3 + 1) : i * 3 + 1, ic = idx ? idx.getX(i * 3 + 2) : i * 3 + 2;
        t.set(new THREE.Vector3().fromBufferAttribute(pos, ia), new THREE.Vector3().fromBufferAttribute(pos, ib), new THREE.Vector3().fromBufferAttribute(pos, ic));
        const d = t.closestPointToPoint(p, c).distanceTo(p);
        if (d < bestD) { bestD = d; best = tri ? tri[i] : -2 - i; }
      }
    }
    return bestD < 2 ? best : null;
  }

  private highlight(group: THREE.Group, v: PickView, sid: number, color: string, opacity: number) {
    const kind = store.state.pick?.kind;
    const g = v.mesh.geometry;
    if (kind === 'edges') {
      const ids = g.userData.edgeIds as Int32Array | undefined;
      const pos = v.edges.geometry.getAttribute('position');
      const pts: number[] = [];
      for (let s = 0; s < pos.count / 2; s++) {
        if ((ids ? ids[s] : -2 - s) !== sid) continue;
        for (const k of [s * 2, s * 2 + 1]) pts.push(pos.getX(k), pos.getY(k), pos.getZ(k));
      }
      if (!pts.length) return;
      const geo = new LineSegmentsGeometry().setPositions(pts);
      const mat = new LineMaterial({ color: new THREE.Color(color).getHex(), linewidth: 5, depthTest: false, transparent: true });
      const { w, h } = this.host.size();
      mat.resolution.set(w, h);
      this.mats.push(mat);
      const line = new LineSegments2(geo, mat);
      line.matrixAutoUpdate = false;
      line.matrix.copy(v.mesh.matrixWorld);
      line.renderOrder = 41;
      group.add(line);
    } else {
      const tri = g.userData.triFace as Int32Array | undefined;
      const pos = g.getAttribute('position'), idx = g.index;
      const out: number[] = [];
      const n = (idx ? idx.count : pos.count) / 3;
      for (let i = 0; i < n; i++) {
        if ((tri ? tri[i] : -2 - i) !== sid) continue;
        for (let k = 0; k < 3; k++) {
          const vi = idx ? idx.getX(i * 3 + k) : i * 3 + k;
          out.push(pos.getX(vi), pos.getY(vi), pos.getZ(vi));
        }
      }
      if (!out.length) return;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(out, 3));
      const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
        color, transparent: true, opacity, depthTest: true, side: THREE.DoubleSide,
        polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
      }));
      mesh.matrixAutoUpdate = false;
      mesh.matrix.copy(v.mesh.matrixWorld);
      mesh.renderOrder = 41;
      group.add(mesh);
    }
  }

  setResolution(w: number, h: number) { for (const m of this.mats) m.resolution.set(w, h); }

  private clear(g: THREE.Group) {
    g.traverse((o: any) => {
      o.geometry?.dispose();
      if (o.material) { this.mats = this.mats.filter((m) => m !== o.material); o.material.dispose(); }
    });
    g.clear();
  }

  reset() {
    this.hover = null;
    this.clear(this.hoverGroup);
    this.clear(this.pickedGroup);
  }
}
