import * as THREE from 'three';
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { store } from '../core/store';
import { addSketchEntity, updateSketchEntity } from '../core/actions';
import { entityOutline, entitySnapPoints, planeMatrix, profileToShape, sketchProfiles } from '../core/sketch';
import { uid, type SketchEntity, type SketchFeature, type Vec2 } from '../core/types';
import { featureOf } from '../core/evaluator';
import { createGrid } from './grid';

export interface SketchHost {
  camera: () => THREE.Camera;
  dom: HTMLElement;
  size: () => { w: number; h: number };
  invalidate: () => void;
  hud: HTMLElement;
  accent: () => string;
}

const fmt = (v: number) => (Math.round(v * 100) / 100).toString();

/**
 * Draws every sketch and runs the interactive drawing tools.
 * All maths happens in 2D sketch space (u, v) on the sketch plane.
 */
export class SketchController {
  readonly group = new THREE.Group();
  private display = new THREE.Group();
  private draftGroup = new THREE.Group();
  private grid = createGrid({ axes: true, size: 4000 });
  private materials: LineMaterial[] = [];
  private draftMaterials: LineMaterial[] = [];
  private cursorDot: THREE.Mesh;
  private ray = new THREE.Raycaster();

  private draft: Vec2[] = [];
  private cursor: Vec2 = [0, 0];
  private snapKind: 'grid' | 'point' | 'axis' = 'grid';
  private typed = '';
  private drag: { start: Vec2; ids: string[]; original: SketchEntity[] } | null = null;
  private hoverEntity: string | null = null;

  constructor(private host: SketchHost) {
    this.group.add(this.display, this.draftGroup, this.grid.mesh);
    this.grid.mesh.visible = false;
    this.cursorDot = new THREE.Mesh(new THREE.CircleGeometry(1, 20), new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false, transparent: true }));
    this.cursorDot.renderOrder = 10;
    this.cursorDot.visible = false;
    this.group.add(this.cursorDot);
  }

  get active(): SketchFeature | undefined {
    const f = featureOf(store.doc, store.state.sketchId);
    return f?.type === 'sketch' ? f : undefined;
  }

  get busy() { return this.draft.length > 0 || this.drag !== null; }

  private lineMat(color: string | number, width = 2, opacity = 1, list = this.materials) {
    const { w, h } = this.host.size();
    const m = new LineMaterial({ color: new THREE.Color(color as any).getHex(), linewidth: width, transparent: opacity < 1, opacity, depthTest: false });
    m.resolution.set(w, h);
    list.push(m);
    return m;
  }

  private line(points: Vec2[], closed: boolean, mat: LineMaterial, lift = 0.02) {
    const pts = closed ? [...points, points[0]] : points;
    if (pts.length < 2) return null;
    const geo = new LineGeometry();
    geo.setPositions(pts.flatMap(([x, y]) => [x, y, lift]));
    const l = new Line2(geo, mat);
    l.computeLineDistances();
    l.renderOrder = 5;
    return l;
  }

  setResolution(w: number, h: number) {
    for (const m of [...this.materials, ...this.draftMaterials]) m.resolution.set(w, h);
  }

  private clear(g: THREE.Group) {
    g.traverse((o: any) => { o.geometry?.dispose(); o.material?.dispose?.(); });
    g.clear();
  }

  /** Rebuild sketch visuals from the evaluated document. */
  rebuild() {
    this.clear(this.display);
    this.materials = [];
    const { result, sketchId, sketchSelection, mode } = store.state;
    const accent = this.host.accent();
    for (const sk of result.sketches) {
      const isActive = sk.featureId === sketchId && mode === 'sketch';
      const isSelected = store.state.selectedFeature === sk.featureId;
      if (!sk.visible && !isActive && !isSelected) continue;
      const g = new THREE.Group();
      g.matrixAutoUpdate = false;
      g.matrix.copy(sk.matrix);
      const base = this.lineMat(isActive ? '#e5e7eb' : '#94a3b8', isActive ? 2 : 1.5, isActive ? 1 : 0.85);
      const sel = this.lineMat(accent, 3);
      const hov = this.lineMat('#fbbf24', 2.5);
      for (const e of sk.entities) {
        const o = entityOutline(e);
        const mat = isActive && sketchSelection.includes(e.id) ? sel : isActive && this.hoverEntity === e.id ? hov : base;
        const l = this.line(o.points, o.closed, mat);
        if (l) g.add(l);
      }
      // filled profiles show what will become solid
      for (const p of sketchProfiles(sk.entities)) {
        const geo = new THREE.ShapeGeometry(profileToShape(p), 32);
        const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
          color: accent, transparent: true, opacity: isActive ? 0.16 : 0.1, side: THREE.DoubleSide, depthWrite: false,
        }));
        m.position.z = 0.01;
        m.renderOrder = 4;
        g.add(m);
      }
      this.display.add(g);
    }
    if (mode === 'sketch' && this.active) {
      const m = planeMatrix(this.active.plane);
      this.grid.mesh.matrixAutoUpdate = false;
      this.grid.mesh.matrix.copy(m);
      this.grid.mesh.visible = true;
    } else {
      this.grid.mesh.visible = false;
      this.cursorDot.visible = false;
      this.cancel();
    }
    this.host.invalidate();
  }

  updateGrid(camera: THREE.Camera, distance: number, dark: boolean) {
    this.grid.update(camera, distance);
    this.grid.setColor(dark ? '#9fb4ff' : '#3355aa', dark ? 0.9 : 0.6);
  }

  // -------------------------------------------------------------------------
  // input

  private planeHit(e: PointerEvent | MouseEvent): Vec2 | null {
    const sk = this.active;
    if (!sk) return null;
    const r = this.host.dom.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    this.ray.setFromCamera(ndc, this.host.camera() as any);
    const m = planeMatrix(sk.plane);
    const n = new THREE.Vector3(...sk.plane.normal).normalize();
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(n, new THREE.Vector3(...sk.plane.origin));
    const hit = this.ray.ray.intersectPlane(plane, new THREE.Vector3());
    if (!hit) return null;
    const local = hit.applyMatrix4(m.clone().invert());
    return [local.x, local.y];
  }

  /** Pixel distance between two sketch-space points. */
  private pxPerUnit(): number {
    const sk = this.active!;
    const m = planeMatrix(sk.plane);
    const cam = this.host.camera();
    const { w, h } = this.host.size();
    const a = new THREE.Vector3(this.cursor[0], this.cursor[1], 0).applyMatrix4(m).project(cam);
    const b = new THREE.Vector3(this.cursor[0] + 1, this.cursor[1], 0).applyMatrix4(m).project(cam);
    return Math.hypot((a.x - b.x) * w / 2, (a.y - b.y) * h / 2) || 1;
  }

  private snap(raw: Vec2): Vec2 {
    const sk = this.active!;
    const ppu = this.pxPerUnit();
    const tol = 10 / ppu;
    let best: Vec2 | null = null;
    let bestD = tol;
    const cands: Vec2[] = [[0, 0], ...this.draft];
    for (const e of sk.entities) cands.push(...entitySnapPoints(e));
    for (const p of cands) {
      const d = Math.hypot(p[0] - raw[0], p[1] - raw[1]);
      if (d < bestD) { bestD = d; best = p; }
    }
    if (best) { this.snapKind = 'point'; return [best[0], best[1]]; }
    const s = store.state.snap || 1;
    let p: Vec2 = [Math.round(raw[0] / s) * s, Math.round(raw[1] / s) * s];
    this.snapKind = 'grid';
    // horizontal / vertical inference from the previous point
    const prev = this.draft[this.draft.length - 1];
    if (prev && (store.state.sketchTool === 'line' || store.state.sketchTool === 'spline')) {
      if (Math.abs(raw[1] - prev[1]) < tol) { p = [p[0], prev[1]]; this.snapKind = 'axis'; }
      else if (Math.abs(raw[0] - prev[0]) < tol) { p = [prev[0], p[1]]; this.snapKind = 'axis'; }
    }
    return p;
  }

  private hitEntity(at: Vec2): string | null {
    const sk = this.active;
    if (!sk) return null;
    const tol = 8 / this.pxPerUnit();
    let best: string | null = null;
    let bestD = tol;
    for (const e of sk.entities) {
      const o = entityOutline(e, 48);
      const pts = o.closed ? [...o.points, o.points[0]] : o.points;
      for (let i = 0; i < pts.length - 1; i++) {
        const d = segDist(at, pts[i], pts[i + 1]);
        if (d < bestD) { bestD = d; best = e.id; }
      }
    }
    // clicking inside a closed shape also selects it
    if (!best) {
      for (const e of [...sk.entities].reverse()) {
        const o = entityOutline(e, 48);
        if (o.closed && pointIn(at, o.points)) return e.id;
      }
    }
    return best;
  }

  pointerMove(e: PointerEvent) {
    const raw = this.planeHit(e);
    if (!raw) return;
    const tool = store.state.sketchTool;
    this.cursor = tool === 'select' ? raw : this.snap(raw);
    if (this.drag) {
      const s = store.state.snap || 1;
      const dx = Math.round((raw[0] - this.drag.start[0]) / s) * s;
      const dy = Math.round((raw[1] - this.drag.start[1]) / s) * s;
      store.transient((doc) => {
        const sk = doc.features.find((f) => f.id === store.state.sketchId) as SketchFeature | undefined;
        if (!sk) return;
        for (const orig of this.drag!.original) {
          const idx = sk.entities.findIndex((x) => x.id === orig.id);
          if (idx >= 0) sk.entities[idx] = translateEntity(orig, dx, dy);
        }
      });
    } else if (tool === 'select') {
      const h = this.hitEntity(raw);
      if (h !== this.hoverEntity) { this.hoverEntity = h; this.rebuild(); }
      this.host.dom.style.cursor = h ? 'move' : 'default';
    } else {
      this.host.dom.style.cursor = 'crosshair';
    }
    this.updateDraft();
  }

  pointerDown(e: PointerEvent) {
    if (e.button !== 0) return false;
    const tool = store.state.sketchTool;
    const raw = this.planeHit(e);
    if (!raw) return false;
    if (tool === 'select') {
      const hit = this.hitEntity(raw);
      const cur = store.state.sketchSelection;
      let next = hit ? (e.shiftKey ? (cur.includes(hit) ? cur.filter((x) => x !== hit) : [...cur, hit]) : (cur.includes(hit) ? cur : [hit])) : (e.shiftKey ? cur : []);
      store.set({ sketchSelection: next });
      if (hit && this.active) {
        this.drag = { start: raw, ids: next, original: this.active.entities.filter((x) => next.includes(x.id)).map((x) => JSON.parse(JSON.stringify(x))) };
      }
      this.rebuild();
      return true;
    }
    return true;
  }

  pointerUp(e: PointerEvent, wasClick: boolean) {
    if (this.drag) {
      this.drag = null;
      store.endTransient('Move sketch shapes');
      return;
    }
    if (e.button !== 0 || !wasClick) return;
    const tool = store.state.sketchTool;
    if (tool === 'select') return;
    // touch has no hover, so the cursor is wherever the finger lifted
    if (e.pointerType !== 'mouse') {
      const raw = this.planeHit(e);
      if (raw) this.cursor = this.snap(raw);
    }
    this.click(this.cursor, e.detail >= 2);
  }

  private click(p: Vec2, dbl: boolean) {
    const tool = store.state.sketchTool;
    const d = this.draft;
    const same = (a: Vec2, b: Vec2) => Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-6;
    switch (tool) {
      case 'line':
      case 'spline': {
        if (dbl) { this.finishOpen(); return; }
        if (d.length >= 2 && same(p, d[0])) { this.commitPoly(true); return; }
        if (d.length && same(p, d[d.length - 1])) { this.finishOpen(); return; }
        d.push(p);
        break;
      }
      case 'rect':
      case 'crect':
      case 'circle':
      case 'polygon': {
        if (!d.length) { d.push(p); break; }
        this.commitTwoPoint(d[0], p);
        break;
      }
      case 'slot': {
        if (d.length < 2) {
          if (d.length === 1 && same(d[0], p)) return;
          d.push(p);
          break;
        }
        const r = segDist(p, d[0], d[1]);
        if (r > 0) addSketchEntity({ id: uid('k'), kind: 'slot', x1: d[0][0], y1: d[0][1], x2: d[1][0], y2: d[1][1], r });
        this.cancel();
        break;
      }
    }
    this.typed = '';
    this.updateDraft();
  }

  private commitTwoPoint(a: Vec2, b: Vec2) {
    const tool = store.state.sketchTool;
    const id = uid('k');
    if (tool === 'rect') {
      const w = b[0] - a[0], h = b[1] - a[1];
      if (Math.abs(w) > 1e-6 && Math.abs(h) > 1e-6) {
        addSketchEntity({ id, kind: 'rect', x: Math.min(a[0], b[0]), y: Math.min(a[1], b[1]), w: Math.abs(w), h: Math.abs(h) });
      }
    } else if (tool === 'crect') {
      const w = Math.abs(b[0] - a[0]) * 2, h = Math.abs(b[1] - a[1]) * 2;
      if (w > 1e-6 && h > 1e-6) addSketchEntity({ id, kind: 'rect', x: a[0] - w / 2, y: a[1] - h / 2, w, h });
    } else if (tool === 'circle') {
      const r = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (r > 1e-6) addSketchEntity({ id, kind: 'circle', cx: a[0], cy: a[1], r });
    } else if (tool === 'polygon') {
      const r = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const rot = (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI - 90;
      if (r > 1e-6) addSketchEntity({ id, kind: 'polygon', cx: a[0], cy: a[1], r, sides: store.state.polygonSides, rotation: Math.round(rot * 100) / 100 });
    }
    this.cancel();
  }

  private commitPoly(closed: boolean) {
    const pts = [...this.draft];
    const tool = store.state.sketchTool;
    if (pts.length >= (closed ? 3 : 2)) {
      addSketchEntity(tool === 'spline'
        ? { id: uid('k'), kind: 'spline', points: pts, closed }
        : { id: uid('k'), kind: 'polyline', points: pts, closed });
    }
    this.cancel();
  }

  private finishOpen() { this.commitPoly(false); }

  cancel() {
    this.draft = [];
    this.typed = '';
    this.clear(this.draftGroup);
    this.host.hud.style.display = 'none';
  }

  /** Keyboard: typed dimensions, Enter to finish, Esc to cancel. */
  key(e: KeyboardEvent): boolean {
    if (!this.draft.length) return false;
    if (e.key === 'Escape') { this.cancel(); this.host.invalidate(); return true; }
    if (/^[0-9.,\-]$/.test(e.key)) { this.typed += e.key === ',' ? ',' : e.key; this.updateDraft(); return true; }
    if (e.key === 'Backspace') { this.typed = this.typed.slice(0, -1); this.updateDraft(); return true; }
    if (e.key === 'Enter') {
      if (this.typed) this.applyTyped();
      else if (store.state.sketchTool === 'line' || store.state.sketchTool === 'spline') this.finishOpen();
      this.updateDraft();
      return true;
    }
    return false;
  }

  private applyTyped() {
    const nums = this.typed.split(',').map(Number).filter((n) => !Number.isNaN(n));
    this.typed = '';
    if (!nums.length) return;
    const tool = store.state.sketchTool;
    const a = this.draft[0];
    const last = this.draft[this.draft.length - 1];
    if (tool === 'line' || tool === 'spline') {
      const ang = Math.atan2(this.cursor[1] - last[1], this.cursor[0] - last[0]);
      const len = nums[0];
      const angle = nums.length > 1 ? (nums[1] * Math.PI) / 180 : ang;
      this.click([last[0] + Math.cos(angle) * len, last[1] + Math.sin(angle) * len], false);
    } else if (tool === 'rect' || tool === 'crect') {
      const w = nums[0], h = nums[1] ?? nums[0];
      const sx = Math.sign(this.cursor[0] - a[0]) || 1, sy = Math.sign(this.cursor[1] - a[1]) || 1;
      const b: Vec2 = tool === 'rect' ? [a[0] + sx * w, a[1] + sy * h] : [a[0] + w / 2, a[1] + h / 2];
      this.commitTwoPoint(a, b);
    } else if (tool === 'circle' || tool === 'polygon') {
      const r = tool === 'circle' ? nums[0] / 2 : nums[0];
      this.commitTwoPoint(a, [a[0] + r, a[1]]);
    }
  }

  private updateDraft() {
    const sk = this.active;
    this.clear(this.draftGroup);
    this.draftMaterials = [];
    if (!sk || store.state.mode !== 'sketch') return;
    const m = planeMatrix(sk.plane);
    this.draftGroup.matrixAutoUpdate = false;
    this.draftGroup.matrix.copy(m);
    const tool = store.state.sketchTool;

    // cursor marker
    const ppu = this.pxPerUnit();
    this.cursorDot.visible = tool !== 'select';
    this.cursorDot.matrixAutoUpdate = false;
    const s = (this.snapKind === 'point' ? 5 : 3.5) / ppu;
    this.cursorDot.matrix.copy(m).multiply(new THREE.Matrix4().makeTranslation(this.cursor[0], this.cursor[1], 0.05)).multiply(new THREE.Matrix4().makeScale(s, s, s));
    (this.cursorDot.material as THREE.MeshBasicMaterial).color.set(this.snapKind === 'point' ? '#fbbf24' : this.snapKind === 'axis' ? '#22d3ee' : '#ffffff');

    const d = this.draft;
    const c = this.cursor;
    let label = '';
    const mat = this.lineMat(this.host.accent(), 2.5, 1, this.draftMaterials);
    const add = (pts: Vec2[], closed: boolean) => { const l = this.line(pts, closed, mat, 0.04); if (l) this.draftGroup.add(l); };

    if (d.length) {
      switch (tool) {
        case 'line': {
          add([...d, c], false);
          const last = d[d.length - 1];
          const len = Math.hypot(c[0] - last[0], c[1] - last[1]);
          const ang = (Math.atan2(c[1] - last[1], c[0] - last[0]) * 180) / Math.PI;
          label = `${fmt(len)} mm  ∠ ${fmt(ang)}°`;
          break;
        }
        case 'spline': {
          const tmp = entityOutline({ id: 't', kind: 'spline', points: [...d, c], closed: false });
          add(tmp.points, false);
          label = `${d.length + 1} points`;
          break;
        }
        case 'rect': {
          add([d[0], [c[0], d[0][1]], c, [d[0][0], c[1]]], true);
          label = `${fmt(Math.abs(c[0] - d[0][0]))} × ${fmt(Math.abs(c[1] - d[0][1]))} mm`;
          break;
        }
        case 'crect': {
          const w = Math.abs(c[0] - d[0][0]), h = Math.abs(c[1] - d[0][1]);
          add([[d[0][0] - w, d[0][1] - h], [d[0][0] + w, d[0][1] - h], [d[0][0] + w, d[0][1] + h], [d[0][0] - w, d[0][1] + h]], true);
          label = `${fmt(w * 2)} × ${fmt(h * 2)} mm`;
          break;
        }
        case 'circle': {
          const r = Math.hypot(c[0] - d[0][0], c[1] - d[0][1]);
          add(entityOutline({ id: 't', kind: 'circle', cx: d[0][0], cy: d[0][1], r }).points, true);
          add([d[0], c], false);
          label = `Ø ${fmt(r * 2)} mm`;
          break;
        }
        case 'polygon': {
          const r = Math.hypot(c[0] - d[0][0], c[1] - d[0][1]);
          const rot = (Math.atan2(c[1] - d[0][1], c[0] - d[0][0]) * 180) / Math.PI - 90;
          add(entityOutline({ id: 't', kind: 'polygon', cx: d[0][0], cy: d[0][1], r, sides: store.state.polygonSides, rotation: rot }).points, true);
          label = `R ${fmt(r)} mm · ${store.state.polygonSides} sides`;
          break;
        }
        case 'slot': {
          if (d.length === 1) { add([d[0], c], false); label = `${fmt(Math.hypot(c[0] - d[0][0], c[1] - d[0][1]))} mm`; }
          else {
            const r = segDist(c, d[0], d[1]);
            add(entityOutline({ id: 't', kind: 'slot', x1: d[0][0], y1: d[0][1], x2: d[1][0], y2: d[1][1], r }).points, true);
            label = `W ${fmt(r * 2)} mm`;
          }
          break;
        }
      }
    }
    // HUD next to the cursor
    const hud = this.host.hud;
    if (label || this.typed) {
      const p = new THREE.Vector3(c[0], c[1], 0).applyMatrix4(m).project(this.host.camera());
      const { w, h } = this.host.size();
      hud.style.display = 'block';
      hud.style.left = `${((p.x + 1) / 2) * w + 18}px`;
      hud.style.top = `${((1 - p.y) / 2) * h + 14}px`;
      hud.innerHTML = this.typed
        ? `<b>${this.typed}</b><span>${typedHint(tool)} · Enter ↵</span>`
        : `<b>${label}</b><span>type a number for exact size</span>`;
    } else hud.style.display = 'none';
    this.host.invalidate();
  }
}

function typedHint(tool: string) {
  if (tool === 'rect' || tool === 'crect') return 'width,height';
  if (tool === 'circle') return 'diameter';
  if (tool === 'polygon') return 'radius';
  return 'length[,angle]';
}

function segDist(p: Vec2, a: Vec2, b: Vec2) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  let t = l2 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

function pointIn([x, y]: Vec2, poly: Vec2[]) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function translateEntity(e: SketchEntity, dx: number, dy: number): SketchEntity {
  switch (e.kind) {
    case 'polyline':
    case 'spline':
      return { ...e, points: e.points.map(([x, y]) => [x + dx, y + dy] as Vec2) };
    case 'rect':
      return { ...e, x: e.x + dx, y: e.y + dy };
    case 'circle':
    case 'polygon':
      return { ...e, cx: e.cx + dx, cy: e.cy + dy };
    case 'slot':
      return { ...e, x1: e.x1 + dx, y1: e.y1 + dy, x2: e.x2 + dx, y2: e.y2 + dy };
  }
}

export { updateSketchEntity };
