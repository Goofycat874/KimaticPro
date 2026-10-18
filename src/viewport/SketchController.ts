import * as THREE from 'three';
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { store } from '../core/store';
import {
  addDimension, addSketchEntity, parseRefKey, pickForConstraint, refKey, setDimension, setDimensionOffset, setSketchEntities, sketchFillet, sketchTrim, updateSketchEntity,
} from '../core/actions';
import { arcThrough, entityCircle, entityLines, entityOutline, entityPoints, entitySnapPoints, planeMatrix, profileToShape, sketchProfiles } from '../core/sketch';
import { ORIGIN, analyzeSketch, dragRef, isDimension, keepKeys, measure, refCircle, refLine, refPoint, solveSketch, withValues } from '../core/constraints';
import { uid, type ConstraintType, type SketchConstraint, type SketchEntity, type SketchFeature, type SkRef, type Vec2 } from '../core/types';
import { featureOf } from '../core/evaluator';
import { trimPreview } from '../core/sketchEdit';
import { createGrid } from './grid';

export interface SketchHost {
  camera: () => THREE.Camera;
  dom: HTMLElement;
  size: () => { w: number; h: number };
  invalidate: () => void;
  hud: HTMLElement;
  labels: HTMLElement;
  accent: () => string;
}

const fmt = (v: number) => (Math.round(v * 100) / 100).toString();
const COLORS = { free: '#7cc4ff', fixed: '#f1f5f9', plain: '#e5e7eb', construction: '#f59e0b', hover: '#fbbf24', dim: '#a5b4fc', bad: '#f87171' };

/** What a snapped cursor landed on, so drawing can add constraints automatically. */
interface SnapInfo { ref?: SkRef; mid?: SkRef; axis?: 'h' | 'v' }

interface Dims { lines: Vec2[][]; label: Vec2; text: string }

interface OverlayItem { el: HTMLElement; at: Vec2; n?: Vec2; px: [number, number] }

const GLYPH: Partial<Record<ConstraintType, string>> = {
  horizontal: 'H', vertical: 'V', parallel: '∥', perpendicular: '⊥', equal: '=', tangent: 'T', concentric: '◎',
  midpoint: 'M', onCurve: '⌖', symmetric: '⇋', fix: '⚓',
};

/**
 * Draws every sketch and runs the interactive drawing tools, constraints and dimensions.
 * All maths happens in 2D sketch space (u, v) on the sketch plane.
 */
export class SketchController {
  readonly group = new THREE.Group();
  private display = new THREE.Group();
  private hoverGroup = new THREE.Group();
  private draftGroup = new THREE.Group();
  private grid = createGrid({ axes: true, size: 4000 });
  private materials: LineMaterial[] = [];
  private hoverMaterials: LineMaterial[] = [];
  private draftMaterials: LineMaterial[] = [];
  private cursorDot: THREE.Mesh;
  private ray = new THREE.Raycaster();
  private overlay = document.createElement('div');
  private items: OverlayItem[] = [];
  private input: HTMLInputElement | null = null;

  private draft: Vec2[] = [];
  private draftSnaps: SnapInfo[] = [];
  private cursor: Vec2 = [0, 0];
  private snapKind: 'grid' | 'point' | 'axis' | 'mid' = 'grid';
  private snapInfo: SnapInfo = {};
  private typed = '';
  private typedDims: { type: ConstraintType; ref: (id: string) => SkRef; value: number }[] = [];
  private drag: null | {
    ref: SkRef; start: Vec2; last: Vec2; ids: string[]; current: SketchEntity[];
  } = null;
  private box: { start: Vec2; end: Vec2; add: boolean } | null = null;
  private labelDrag: { id: string; base: Vec2 } | null = null;
  private hoverRef: SkRef | null = null;
  private hoverRefs: SkRef[] = [];
  private dimPicks: SkRef[] = [];
  private trimHover: Vec2[] | null = null;

  constructor(private host: SketchHost) {
    this.group.add(this.display, this.hoverGroup, this.draftGroup, this.grid.mesh);
    this.grid.mesh.visible = false;
    this.cursorDot = new THREE.Mesh(new THREE.CircleGeometry(1, 20), new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false, transparent: true }));
    this.cursorDot.renderOrder = 10;
    this.cursorDot.visible = false;
    this.group.add(this.cursorDot);
    this.overlay.className = 'sk-overlay';
    host.labels.appendChild(this.overlay);
  }

  get active(): SketchFeature | undefined {
    const f = featureOf(store.doc, store.state.sketchId);
    return f?.type === 'sketch' ? f : undefined;
  }

  /** Entities as evaluated (dimensions driven by parameters already applied). */
  private get entities(): SketchEntity[] {
    const sk = store.state.result.sketches.find((s) => s.featureId === store.state.sketchId);
    return sk?.entities ?? this.active?.entities ?? [];
  }

  private get ents() { return new Map(this.entities.map((e) => [e.id, e])); }

  get busy() { return this.draft.length > 0 || this.drag !== null || this.box !== null || this.labelDrag !== null; }

  private lineMat(color: string | number, width = 2, opacity = 1, list = this.materials, dashed = false) {
    const { w, h } = this.host.size();
    const m = new LineMaterial({ color: new THREE.Color(color as any).getHex(), linewidth: width, transparent: opacity < 1, opacity, depthTest: false, dashed });
    if (dashed) { const u = 1 / this.pxPerUnit(); m.dashSize = 7 * u; m.gapSize = 4 * u; }
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

  private dots(points: Vec2[], color: string, size = 7) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(points.flatMap(([x, y]) => [x, y, 0.06]), 3));
    const p = new THREE.Points(geo, new THREE.PointsMaterial({ color, size, sizeAttenuation: false, depthTest: false, transparent: true }));
    p.renderOrder = 7;
    return p;
  }

  setResolution(w: number, h: number) {
    for (const m of [...this.materials, ...this.hoverMaterials, ...this.draftMaterials]) m.resolution.set(w, h);
  }

  private clear(g: THREE.Group) {
    g.traverse((o: any) => { o.geometry?.dispose(); o.material?.dispose?.(); });
    g.clear();
  }

  // -------------------------------------------------------------------------
  // display

  /** Rebuild sketch visuals from the evaluated document. */
  rebuild() {
    this.clear(this.display);
    this.materials = [];
    const { result, sketchId, sketchSelection, mode } = store.state;
    const accent = this.host.accent();
    const editing = mode === 'sketch';
    for (const sk of result.sketches) {
      const isActive = sk.featureId === sketchId && editing;
      const isSelected = store.state.selectedFeature === sk.featureId;
      if (!sk.visible && !isActive && !isSelected) continue;
      const g = new THREE.Group();
      g.matrixAutoUpdate = false;
      g.matrix.copy(sk.matrix);
      const feature = featureOf(store.doc, sk.featureId);
      const constraints = feature?.type === 'sketch' ? withValues(feature.constraints ?? [], result.vars ?? {}) : [];
      const info = isActive && constraints.length ? analyzeSketch(sk.entities, constraints) : null;
      const base = this.lineMat(isActive ? COLORS.plain : '#94a3b8', isActive ? 2 : 1.5, isActive ? 1 : 0.85);
      const free = this.lineMat(COLORS.free, 2);
      const fixed = this.lineMat(COLORS.fixed, 2);
      const sel = this.lineMat(accent, 3.2);
      const cons = this.lineMat(COLORS.construction, 1.5, 0.9, this.materials, true);
      const selKeys = new Set(isActive ? sketchSelection : []);
      for (const e of sk.entities) {
        const o = entityOutline(e);
        const whole = selKeys.has(e.id);
        const mat = whole ? sel : e.construction ? cons : info ? (info.fixed.has(e.id) ? fixed : free) : base;
        const l = this.line(o.points, o.closed, mat);
        if (l) g.add(l);
        if (!isActive) continue;
        // selected segments and points
        entityLines(e).forEach(([a, b], s) => {
          if (selKeys.has(refKey({ e: e.id, s }))) { const x = this.line([a, b], false, sel, 0.03); if (x) g.add(x); }
        });
      }
      if (isActive) {
        // key points: end points, corners and centres
        const pts: Vec2[] = [], fixedPts: Vec2[] = [], selPts: Vec2[] = [];
        for (const e of sk.entities) {
          const list = entityPoints(e);
          const shown = e.kind === 'polygon' ? [0] : e.kind === 'rect' ? [0, 1, 2, 3] : list.map((_, i) => i);
          for (const i of shown) {
            const key = refKey({ e: e.id, p: i });
            if (selKeys.has(key)) selPts.push(list[i]);
            else if (info?.fixedPoints.has(`${e.id}:${i}`)) fixedPts.push(list[i]);
            else pts.push(list[i]);
          }
        }
        if (pts.length) g.add(this.dots(pts, info ? COLORS.free : '#cbd5e1', 6));
        if (fixedPts.length) g.add(this.dots(fixedPts, COLORS.fixed, 6));
        if (selPts.length) g.add(this.dots(selPts, accent, 9));
        g.add(this.dots([[0, 0]], selKeys.has(`${ORIGIN}.p0`) ? accent : '#fbbf24', 8));
        if (store.state.showConstraints) this.drawDimensions(g, sk.entities, constraints, info?.failing ?? []);
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
    if (editing && this.active) {
      const m = planeMatrix(this.active.plane);
      this.grid.mesh.matrixAutoUpdate = false;
      this.grid.mesh.matrix.copy(m);
      this.grid.mesh.visible = true;
    } else {
      this.grid.mesh.visible = false;
      this.cursorDot.visible = false;
      this.cancel();
    }
    this.buildOverlay();
    this.drawHover();
    this.host.invalidate();
  }

  /** Geometry of a dimension: extension/dimension lines, label spot and text. */
  private dimGeometry(ents: Map<string, SketchEntity>, c: SketchConstraint): Dims | null {
    const u = 1 / this.pxPerUnit();
    const v = c.value ?? measure(ents, c) ?? 0;
    const off = c.offset;
    const text = c.type === 'radius' ? `R${fmt(v)}` : c.type === 'diameter' ? `⌀${fmt(v)}` : c.type === 'angle' ? `${fmt(v)}°` : fmt(v);
    if (c.type === 'radius' || c.type === 'diameter') {
      const ci = refCircle(ents, c.refs[0]);
      if (!ci) return null;
      const o = off ?? [ci.r * 0.75 + 14 * u, ci.r * 0.75 + 14 * u];
      const label: Vec2 = [ci.c[0] + o[0], ci.c[1] + o[1]];
      const d = Math.hypot(o[0], o[1]) || 1;
      const dir: Vec2 = [o[0] / d, o[1] / d];
      const edge: Vec2 = [ci.c[0] + dir[0] * ci.r, ci.c[1] + dir[1] * ci.r];
      const from: Vec2 = c.type === 'diameter' ? [ci.c[0] - dir[0] * ci.r, ci.c[1] - dir[1] * ci.r] : ci.c;
      const lines: Vec2[][] = [[from, edge, d > ci.r ? label : edge], ...this.arrow(edge, dir, u)];
      if (c.type === 'diameter') lines.push(...this.arrow(from, [-dir[0], -dir[1]], u));
      return { lines, label, text };
    }
    if (c.type === 'angle') {
      const la = refLine(ents, c.refs[0]), lb = refLine(ents, c.refs[1]);
      if (!la || !lb) return null;
      const X = intersect(la, lb);
      if (!X) return null;
      // measure from the intersection towards each segment's far end
      const far = (l: [Vec2, Vec2]) => (dist(l[0], X) > dist(l[1], X) ? l[0] : l[1]);
      const a0 = Math.atan2(far(la)[1] - X[1], far(la)[0] - X[0]);
      let a1 = Math.atan2(far(lb)[1] - X[1], far(lb)[0] - X[0]);
      let sweep = a1 - a0;
      while (sweep > Math.PI) sweep -= Math.PI * 2;
      while (sweep < -Math.PI) sweep += Math.PI * 2;
      a1 = a0 + sweep;
      const r0 = Math.min(dist(far(la), X), dist(far(lb), X)) * 0.6;
      const o = off ?? [Math.cos(a0 + sweep / 2) * r0, Math.sin(a0 + sweep / 2) * r0];
      const r = Math.max(4 * u, Math.hypot(o[0], o[1]));
      const arc: Vec2[] = [];
      for (let i = 0; i <= 24; i++) { const t = a0 + (sweep * i) / 24; arc.push([X[0] + Math.cos(t) * r, X[1] + Math.sin(t) * r]); }
      return { lines: [arc], label: [X[0] + o[0], X[1] + o[1]], text };
    }
    // linear: find the two measured points
    let A: Vec2 | null = null, B: Vec2 | null = null;
    if (c.refs.length === 1) { const l = refLine(ents, c.refs[0]); if (l) [A, B] = l; }
    else {
      const pa = refPoint(ents, c.refs[0]), pb = refPoint(ents, c.refs[1]);
      const la = refLine(ents, c.refs[0]), lb = refLine(ents, c.refs[1]);
      if (pa && pb) { A = pa; B = pb; }
      else if (pa && lb) { A = pa; B = foot(pa, lb); }
      else if (pb && la) { A = foot(pb, la); B = pb; }
      else if (la && lb) { A = foot(lb[0], la); B = lb[0]; }
    }
    if (!A || !B) return null;
    const mid: Vec2 = [(A[0] + B[0]) / 2, (A[1] + B[1]) / 2];
    let A2: Vec2, B2: Vec2, label: Vec2;
    if (c.type === 'hdistance' || c.type === 'vdistance') {
      const k = c.type === 'hdistance' ? 1 : 0;
      const o = off ?? (k === 1 ? [0, Math.max(A[1], B[1]) - mid[1] + 16 * u] : [Math.max(A[0], B[0]) - mid[0] + 16 * u, 0]);
      label = [mid[0] + o[0], mid[1] + o[1]];
      A2 = k === 1 ? [A[0], label[1]] : [label[0], A[1]];
      B2 = k === 1 ? [B[0], label[1]] : [label[0], B[1]];
    } else {
      const d = dist(A, B) || 1;
      const n: Vec2 = [-(B[1] - A[1]) / d, (B[0] - A[0]) / d];
      const o = off ?? [n[0] * 16 * u, n[1] * 16 * u];
      label = [mid[0] + o[0], mid[1] + o[1]];
      const s = o[0] * n[0] + o[1] * n[1];
      A2 = [A[0] + n[0] * s, A[1] + n[1] * s];
      B2 = [B[0] + n[0] * s, B[1] + n[1] * s];
    }
    const L = dist(A2, B2) || 1;
    const t: Vec2 = [(B2[0] - A2[0]) / L, (B2[1] - A2[1]) / L];
    const lines: Vec2[][] = [[A, A2], [B, B2], [A2, B2], ...this.arrow(A2, [-t[0], -t[1]], u), ...this.arrow(B2, t, u)];
    // extend the dimension line out to a label placed beyond the ends
    const along = (label[0] - A2[0]) * t[0] + (label[1] - A2[1]) * t[1];
    if (along < 0) lines.push([A2, [A2[0] + t[0] * along, A2[1] + t[1] * along]]);
    if (along > L) lines.push([B2, [A2[0] + t[0] * along, A2[1] + t[1] * along]]);
    return { lines, label, text };
  }

  /** Two short strokes forming an arrow head at `p` pointing along `dir`. */
  private arrow(p: Vec2, dir: Vec2, u: number): Vec2[][] {
    const len = 7 * u, a = 0.42;
    const back: Vec2 = [-dir[0] * len, -dir[1] * len];
    const rot = (v: Vec2, t: number): Vec2 => [v[0] * Math.cos(t) - v[1] * Math.sin(t), v[0] * Math.sin(t) + v[1] * Math.cos(t)];
    const l = rot(back, a), r = rot(back, -a);
    return [[[p[0] + l[0], p[1] + l[1]], p, [p[0] + r[0], p[1] + r[1]]]];
  }

  private drawDimensions(g: THREE.Group, entities: SketchEntity[], cs: SketchConstraint[], failing: string[]) {
    const ents = new Map(entities.map((e) => [e.id, e]));
    const ok = this.lineMat(COLORS.dim, 1.2, 0.95);
    const bad = this.lineMat(COLORS.bad, 1.4);
    const sel = this.lineMat(this.host.accent(), 1.8);
    for (const c of cs) {
      if (!isDimension(c.type)) continue;
      const d = this.dimGeometry(ents, c);
      if (!d) continue;
      const mat = store.state.sketchSelection.includes(`#${c.id}`) ? sel : failing.includes(c.id) ? bad : ok;
      for (const pts of d.lines) { const l = this.line(pts, false, mat, 0.05); if (l) g.add(l); }
    }
  }

  /** HTML labels: dimension values and constraint glyphs. */
  private buildOverlay() {
    this.overlay.replaceChildren();
    this.items = [];
    const sk = this.active;
    if (!sk || store.state.mode !== 'sketch' || !store.state.showConstraints) { this.updateOverlay(); return; }
    const entities = this.entities;
    const ents = new Map(entities.map((e) => [e.id, e]));
    const cs = withValues(sk.constraints ?? [], store.state.result.vars ?? {});
    const failing = new Set(cs.length ? analyzeSketch(entities, cs).failing : []);
    const sel = new Set(store.state.sketchSelection);
    const stack = new Map<string, number>();
    const add = (c: SketchConstraint, el: HTMLElement, at: Vec2, n: Vec2 | undefined, px: [number, number]) => {
      el.classList.toggle('on', sel.has(`#${c.id}`));
      el.classList.toggle('bad', failing.has(c.id));
      el.addEventListener('pointerenter', () => { this.hoverRefs = c.refs; this.drawHover(); });
      el.addEventListener('pointerleave', () => { this.hoverRefs = []; this.drawHover(); });
      el.addEventListener('pointerdown', (e) => e.stopPropagation());
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        const key = `#${c.id}`;
        const cur = store.state.sketchSelection;
        store.set({ sketchSelection: e.shiftKey || e.ctrlKey || e.metaKey ? (cur.includes(key) ? cur.filter((k) => k !== key) : [...cur, key]) : [key] });
      });
      this.overlay.appendChild(el);
      this.items.push({ el, at, n, px });
    };
    for (const c of cs) {
      if (isDimension(c.type)) {
        const d = this.dimGeometry(ents, c);
        if (!d) continue;
        const el = document.createElement('div');
        el.className = 'sk-dim';
        el.innerHTML = c.expr ? `<i>ƒx</i>${d.text}` : d.text;
        el.title = c.expr ? `${c.expr} = ${d.text} · double-click to edit` : 'Double-click to change · drag to move';
        el.addEventListener('dblclick', (e) => { e.stopPropagation(); this.editDimension(c.id); });
        el.addEventListener('pointerdown', (e) => {
          if (e.button !== 0) return;
          const hit = this.planeHit(e);
          if (hit) this.labelDrag = { id: c.id, base: [d.label[0] - hit[0], d.label[1] - hit[1]] };
          (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
        });
        el.addEventListener('pointermove', (e) => this.moveLabel(e, c, ents));
        el.addEventListener('pointerup', () => { if (this.labelDrag) { this.labelDrag = null; store.endTransient('Move dimension'); } });
        add(c, el, d.label, undefined, [0, 0]);
        continue;
      }
      const glyph = GLYPH[c.type];
      // joined points already read as joined; their constraints live in the inspector list
      if (!glyph || c.type === 'coincident') continue;
      // put the glyph next to each line/circle it ties, or next to its point
      const spots: { at: Vec2; n?: Vec2; key: string }[] = [];
      const refs = c.type === 'symmetric' ? c.refs.slice(0, 2) : c.type === 'midpoint' || c.type === 'onCurve' || c.type === 'fix' ? c.refs.slice(0, 1) : c.refs;
      for (const r of refs) {
        const p = refPoint(ents, r);
        if (p) { spots.push({ at: p, key: refKey(r) }); continue; }
        const l = refLine(ents, r);
        if (l && r.e !== ORIGIN) {
          const d = dist(l[0], l[1]) || 1;
          spots.push({ at: [(l[0][0] + l[1][0]) / 2, (l[0][1] + l[1][1]) / 2], n: [-(l[1][1] - l[0][1]) / d, (l[1][0] - l[0][0]) / d], key: refKey(r) });
          continue;
        }
        const ci = refCircle(ents, r);
        if (ci) spots.push({ at: [ci.c[0], ci.c[1] + ci.r], n: [0, 1], key: refKey(r) });
      }
      for (const s of spots) {
        const k = stack.get(s.key) ?? 0;
        stack.set(s.key, k + 1);
        const el = document.createElement('div');
        el.className = 'sk-glyph';
        el.textContent = glyph;
        el.title = `${c.type[0].toUpperCase()}${c.type.slice(1)} · click, then Delete to remove`;
        add(c, el, s.at, s.n, s.n ? [k * 18, 16] : [12 + k * 18, -14]);
      }
    }
    this.updateOverlay();
  }

  /** Keep the HTML labels glued to the sketch as the camera moves. */
  updateOverlay() {
    const sk = this.active;
    if (!sk || !this.items.length) return;
    const m = planeMatrix(sk.plane);
    const cam = this.host.camera();
    const { w, h } = this.host.size();
    const toScreen = (p: Vec2) => {
      const v = new THREE.Vector3(p[0], p[1], 0).applyMatrix4(m).project(cam);
      return [((v.x + 1) / 2) * w, ((1 - v.y) / 2) * h];
    };
    for (const it of this.items) {
      let [x, y] = toScreen(it.at);
      if (it.n) {
        const [x2, y2] = toScreen([it.at[0] + it.n[0], it.at[1] + it.n[1]]);
        const l = Math.hypot(x2 - x, y2 - y) || 1;
        const nx = (x2 - x) / l, ny = (y2 - y) / l;
        x += nx * it.px[1] - ny * it.px[0];
        y += ny * it.px[1] + nx * it.px[0];
      } else { x += it.px[0]; y += it.px[1]; }
      it.el.style.transform = `translate(${x}px, ${y}px) translate(-50%, -50%)`;
    }
    if (this.input) {
      const id = this.input.dataset.id!;
      const c = sk.constraints?.find((x) => x.id === id);
      const d = c && this.dimGeometry(this.ents, c);
      if (d) { const [x, y] = toScreen(d.label); this.input.style.transform = `translate(${x}px, ${y}px) translate(-50%, -50%)`; }
    }
  }

  private moveLabel(e: PointerEvent, c: SketchConstraint, ents: Map<string, SketchEntity>) {
    if (!this.labelDrag || this.labelDrag.id !== c.id) return;
    const hit = this.planeHit(e);
    if (!hit) return;
    // offsets are relative to the dimension's natural anchor (its label with no offset)
    const zero = this.dimGeometry(ents, { ...c, offset: [0, 0] });
    if (!zero) return;
    const target: Vec2 = [hit[0] + this.labelDrag.base[0], hit[1] + this.labelDrag.base[1]];
    setDimensionOffset(c.id, [target[0] - zero.label[0], target[1] - zero.label[1]], true);
  }

  /** Inline box for typing a dimension's value (numbers or expressions like `width / 2`). */
  editDimension(id: string) {
    const c = this.active?.constraints?.find((x) => x.id === id);
    if (!c) return;
    this.closeInput();
    const input = document.createElement('input');
    input.className = 'sk-dim-input';
    input.dataset.id = id;
    input.value = c.expr ?? fmt(c.value ?? 0);
    input.spellcheck = false;
    let done = false;
    const finish = (save: boolean) => {
      if (done) return;
      done = true;
      const text = input.value.trim();
      this.closeInput();
      if (save && text && text !== (c.expr ?? fmt(c.value ?? 0))) setDimension(id, text);
    };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') finish(true);
      if (e.key === 'Escape') finish(false);
    });
    input.addEventListener('blur', () => finish(true));
    input.addEventListener('pointerdown', (e) => e.stopPropagation());
    this.host.labels.appendChild(input);
    this.input = input;
    this.updateOverlay();
    requestAnimationFrame(() => { input.focus(); input.select(); });
  }

  private closeInput() {
    this.input?.remove();
    this.input = null;
  }

  /** Highlight whatever's under the cursor (or what a hovered constraint ties together). */
  private drawHover() {
    this.clear(this.hoverGroup);
    this.hoverMaterials = [];
    const sk = this.active;
    if (!sk || store.state.mode !== 'sketch') return;
    this.hoverGroup.matrixAutoUpdate = false;
    this.hoverGroup.matrix.copy(planeMatrix(sk.plane));
    const ents = this.ents;
    const mat = this.lineMat(COLORS.hover, 3, 1, this.hoverMaterials);
    const pts: Vec2[] = [];
    const refs = this.hoverRefs.length ? this.hoverRefs : this.hoverRef ? [this.hoverRef] : [];
    for (const r of refs) {
      const p = refPoint(ents, r);
      if (p) { pts.push(p); continue; }
      const l = r.e === ORIGIN ? null : refLine(ents, r);
      if (l) { const x = this.line(l, false, mat, 0.04); if (x) this.hoverGroup.add(x); continue; }
      const e = ents.get(r.e);
      if (e) { const o = entityOutline(e); const x = this.line(o.points, o.closed, mat, 0.04); if (x) this.hoverGroup.add(x); }
      else if (r.e === ORIGIN && r.s !== undefined) {
        const L = 4000;
        const x = this.line(r.s === 0 ? [[-L, 0], [L, 0]] : [[0, -L], [0, L]], false, mat, 0.04);
        if (x) this.hoverGroup.add(x);
      }
    }
    if (pts.length) this.hoverGroup.add(this.dots(pts, COLORS.hover, 11));
    this.host.invalidate();
  }

  updateGrid(camera: THREE.Camera, distance: number, dark: boolean) {
    this.grid.update(camera, distance);
    this.grid.setColor(dark ? '#9fb4ff' : '#3355aa', dark ? 0.9 : 0.6);
    this.updateOverlay();
  }

  // -------------------------------------------------------------------------
  // input

  private planeHit(e: { clientX: number; clientY: number }): Vec2 | null {
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

  /** Screen pixels per sketch unit near the cursor. */
  private pxPerUnit(): number {
    const sk = this.active;
    if (!sk) return 1;
    const m = planeMatrix(sk.plane);
    const cam = this.host.camera();
    const { w, h } = this.host.size();
    const a = new THREE.Vector3(this.cursor[0], this.cursor[1], 0).applyMatrix4(m).project(cam);
    const b = new THREE.Vector3(this.cursor[0] + 1, this.cursor[1], 0).applyMatrix4(m).project(cam);
    return Math.hypot((a.x - b.x) * w / 2, (a.y - b.y) * h / 2) || 1;
  }

  private gridSnap(p: Vec2): Vec2 {
    const s = store.state.snap;
    return s ? [Math.round(p[0] / s) * s, Math.round(p[1] / s) * s] : p;
  }

  private snap(raw: Vec2): Vec2 {
    const tol = 10 / this.pxPerUnit();
    let best: Vec2 | null = null;
    let bestD = tol;
    let info: SnapInfo = {};
    const consider = (p: Vec2, i: SnapInfo) => {
      const d = Math.hypot(p[0] - raw[0], p[1] - raw[1]);
      if (d < bestD) { bestD = d; best = p; info = i; }
    };
    consider([0, 0], { ref: { e: ORIGIN, p: 0 } });
    this.draft.forEach((p) => consider(p, {}));
    for (const e of this.entities) {
      const n = entityPoints(e).length;
      entitySnapPoints(e).forEach((p, i) => consider(p, i < n ? { ref: { e: e.id, p: i } } : {}));
    }
    if (best) { this.snapKind = 'point'; this.snapInfo = info; return [best[0], best[1]]; }
    for (const e of this.entities) {
      entityLines(e).forEach(([a, b], s) => consider([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], { mid: { e: e.id, s } }));
    }
    if (best) { this.snapKind = 'mid'; this.snapInfo = info; return [best[0], best[1]]; }
    let p = this.gridSnap(raw);
    this.snapKind = 'grid';
    this.snapInfo = {};
    // horizontal / vertical inference from the previous point
    const prev = this.draft[this.draft.length - 1];
    const tool = store.state.sketchTool;
    if (prev && (tool === 'line' || tool === 'spline')) {
      if (Math.abs(raw[1] - prev[1]) < tol) { p = [p[0], prev[1]]; this.snapKind = 'axis'; this.snapInfo = { axis: 'h' }; }
      else if (Math.abs(raw[0] - prev[0]) < tol) { p = [prev[0], p[1]]; this.snapKind = 'axis'; this.snapInfo = { axis: 'v' }; }
    }
    return p;
  }

  /** The point, segment or curve under the cursor. */
  private hitRef(at: Vec2, opts: { inside?: boolean; axes?: boolean } = {}): SkRef | null {
    const tol = 8 / this.pxPerUnit();
    const ents = this.entities;
    let best: SkRef | null = null, bestD = tol;
    // shape points come first so they win over the origin when they sit on it
    const pts: [Vec2, SkRef][] = [];
    for (const e of ents) entityPoints(e).forEach((p, i) => { if (e.kind !== 'polygon' || i === 0) pts.push([p, { e: e.id, p: i }]); });
    pts.push([[0, 0], { e: ORIGIN, p: 0 }]);
    for (const [p, r] of pts) { const d = dist(p, at); if (d < bestD) { bestD = d; best = r; } }
    if (best) return best;
    bestD = tol;
    for (const e of ents) {
      const lines = entityLines(e);
      lines.forEach(([a, b], s) => { const d = segDist(at, a, b); if (d < bestD) { bestD = d; best = { e: e.id, s }; } });
      if (lines.length && e.kind !== 'slot') continue;
      const o = entityOutline(e, 64);
      const ps = o.closed ? [...o.points, o.points[0]] : o.points;
      for (let i = 0; i < ps.length - 1; i++) { const d = segDist(at, ps[i], ps[i + 1]); if (d < bestD) { bestD = d; best = { e: e.id }; } }
    }
    if (best) return best;
    if (opts.inside) {
      for (const e of [...ents].reverse()) {
        const o = entityOutline(e, 48);
        if (o.closed && pointIn(at, o.points)) return { e: e.id };
      }
    }
    if (opts.axes) {
      if (Math.abs(at[1]) < tol * 0.8) return { e: ORIGIN, s: 0 };
      if (Math.abs(at[0]) < tol * 0.8) return { e: ORIGIN, s: 1 };
    }
    return null;
  }

  /** A segment or curve under the cursor, ignoring end points (for trimming near a corner). */
  private hitCurve(at: Vec2): SkRef | null {
    const tol = 8 / this.pxPerUnit();
    let best: SkRef | null = null, bestD = tol;
    for (const e of this.entities) {
      const lines = entityLines(e);
      lines.forEach(([a, b], s) => { const d = segDist(at, a, b); if (d < bestD) { bestD = d; best = { e: e.id, s }; } });
      if (lines.length && e.kind !== 'slot') continue;
      const o = entityOutline(e, 64);
      const ps = o.closed ? [...o.points, o.points[0]] : o.points;
      for (let i = 0; i < ps.length - 1; i++) { const d = segDist(at, ps[i], ps[i + 1]); if (d < bestD) { bestD = d; best = { e: e.id }; } }
    }
    return best;
  }

  private setHover(r: SkRef | null) {
    const same = r && this.hoverRef ? refKey(r) === refKey(this.hoverRef) : r === this.hoverRef;
    if (same) return;
    this.hoverRef = r;
    this.drawHover();
  }

  pointerMove(e: PointerEvent) {
    const raw = this.planeHit(e);
    if (!raw) return;
    const tool = store.state.sketchTool;
    const picking = tool === 'select' || tool === 'constrain' || tool === 'dimension' || tool === 'trim' || tool === 'fillet';
    this.cursor = picking ? raw : this.snap(raw);
    if (this.labelDrag) return;
    if (this.drag) { this.dragTo(raw); return; }
    if (this.box) { this.box.end = raw; this.updateDraft(); return; }
    if (tool === 'trim' || tool === 'fillet') {
      let h = this.hitRef(raw);
      // fillet wants corners; trim wants curves, not their end points
      if (tool === 'fillet' && h && h.p === undefined) h = null;
      if (tool === 'trim' && h?.p !== undefined) h = this.hitCurve(raw);
      if (h?.e === ORIGIN) h = null;
      this.setHover(tool === 'fillet' ? h : null);
      this.trimHover = tool === 'trim' && h ? trimPreview(this.entities, h, raw) : null;
      this.host.dom.style.cursor = h ? 'pointer' : 'crosshair';
    } else if (tool === 'select' || tool === 'constrain' || tool === 'dimension') {
      const h = this.hitRef(raw, { inside: tool === 'select', axes: tool !== 'select' });
      this.setHover(h);
      this.host.dom.style.cursor = h ? (tool === 'select' ? 'move' : 'pointer') : tool === 'select' ? 'default' : 'crosshair';
    } else {
      if (this.hoverRef) this.setHover(null);
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
      const hit = this.hitRef(raw, { inside: true });
      const cur = store.state.sketchSelection;
      const multi = e.shiftKey || e.ctrlKey || e.metaKey || store.state.multiSelect;
      if (!hit) {
        this.box = { start: raw, end: raw, add: multi };
        if (!multi) store.set({ sketchSelection: [] });
        return true;
      }
      const key = refKey(hit);
      const next = multi ? (cur.includes(key) ? cur.filter((x) => x !== key) : [...cur, key]) : cur.includes(key) ? cur : [key];
      store.set({ sketchSelection: next });
      if (hit.e !== ORIGIN) {
        // dragging a whole shape moves every whole shape that's selected with it
        const wholes = next.map(parseRefKey).filter((r): r is SkRef => !!r && r.p === undefined && r.s === undefined && r.e !== ORIGIN).map((r) => r.e);
        const ids = hit.p === undefined && hit.s === undefined && wholes.includes(hit.e) ? wholes : [hit.e];
        this.drag = { ref: hit, start: raw, last: [0, 0], ids, current: JSON.parse(JSON.stringify(this.entities)) };
      }
      return true;
    }
    return true;
  }

  /** Drag geometry and let the solver keep every constraint satisfied. */
  private dragTo(raw: Vec2) {
    const d = this.drag!;
    const sk = this.active;
    if (!sk) return;
    const total = this.gridSnap([raw[0] - d.start[0], raw[1] - d.start[1]]);
    const inc: Vec2 = [total[0] - d.last[0], total[1] - d.last[1]];
    const target = d.ref.p !== undefined ? this.gridSnap(raw) : raw;
    if (d.ref.p === undefined && !isResizable(d.current, d.ref) && !inc[0] && !inc[1]) return;
    d.last = total;
    const keep: string[] = [];
    const next = d.current.map((e) => {
      if (!d.ids.includes(e.id)) return e;
      const r = d.ids.length > 1 ? dragRef(e, { e: e.id, s: -1 }, target, inc) : dragRef(e, d.ref, target, inc);
      keep.push(...keepKeys(e.id, r.keep));
      return r.entity;
    });
    const cs = sk.constraints ?? [];
    let out = next;
    if (cs.length || next.some((e) => e.kind === 'arc')) {
      const r = solveSketch(next, withValues(cs, store.state.result.vars ?? {}), { keep: new Set(keep) });
      if (!r.ok) return;
      out = r.entities;
    }
    d.current = out;
    setSketchEntities(out);
  }

  pointerUp(e: PointerEvent, wasClick: boolean) {
    if (this.labelDrag) return;
    if (this.drag) {
      this.drag = null;
      store.endTransient('Move sketch shapes');
      return;
    }
    if (this.box) {
      const b = this.box;
      this.box = null;
      if (!wasClick) {
        const x0 = Math.min(b.start[0], b.end[0]), x1 = Math.max(b.start[0], b.end[0]);
        const y0 = Math.min(b.start[1], b.end[1]), y1 = Math.max(b.start[1], b.end[1]);
        const inside = this.entities.filter((en) => entityOutline(en, 24).points.every(([x, y]) => x >= x0 && x <= x1 && y >= y0 && y <= y1)).map((en) => en.id);
        const cur = b.add ? store.state.sketchSelection : [];
        store.set({ sketchSelection: [...new Set([...cur, ...inside])] });
      }
      this.updateDraft();
      return;
    }
    if (e.button !== 0 || !wasClick) return;
    const tool = store.state.sketchTool;
    if (tool === 'select') return;
    const raw = this.planeHit(e);
    if (tool === 'constrain') {
      const hit = raw && this.hitRef(raw, { axes: true });
      if (hit) pickForConstraint(hit);
      else store.set({ sketchSelection: [] });
      return;
    }
    if (tool === 'dimension') { if (raw) this.dimensionClick(raw); return; }
    if (tool === 'trim' && raw) {
      let h = this.hitRef(raw);
      if (h?.p !== undefined) h = this.hitCurve(raw);
      if (h && h.e !== ORIGIN) sketchTrim(h, raw);
      this.trimHover = null;
      return;
    }
    if (tool === 'fillet' && raw) {
      const h = this.hitRef(raw);
      if (h?.p !== undefined && h.e !== ORIGIN) sketchFillet(h);
      else store.toast('Click a corner point to round it.');
      return;
    }
    // touch has no hover, so the cursor is wherever the finger lifted
    if (e.pointerType !== 'mouse' && raw) this.cursor = this.snap(raw);
    this.click(this.cursor, e.detail >= 2);
  }

  // -------------------------------------------------------------------------
  // dimension tool

  private dimensionClick(at: Vec2) {
    const hit = this.hitRef(at, { axes: true });
    const picks = this.dimPicks;
    if (hit && picks.length < 2 && !picks.some((p) => refKey(p) === refKey(hit))) {
      picks.push(hit);
      store.set({ sketchSelection: picks.map(refKey) });
      this.updateDraft();
      return;
    }
    const plan = this.dimPlan(at);
    if (!plan) {
      if (!hit) { this.dimPicks = []; store.set({ sketchSelection: [] }); }
      return;
    }
    const zero = this.dimGeometry(this.ents, { id: 'tmp', type: plan.type, refs: plan.refs, value: 0, offset: [0, 0] });
    const offset: [number, number] | undefined = zero ? [at[0] - zero.label[0], at[1] - zero.label[1]] : undefined;
    this.dimPicks = [];
    store.set({ sketchSelection: [] });
    const id = addDimension(plan.type, plan.refs, offset);
    this.clear(this.draftGroup);
    if (id) requestAnimationFrame(() => this.editDimension(id));
  }

  /** Which dimension the current picks make, given where the label would go. */
  private dimPlan(at: Vec2): { type: ConstraintType; refs: SkRef[] } | null {
    const ents = this.ents;
    const picks = this.dimPicks;
    const kind = (r: SkRef) => (refPoint(ents, r) ? 'point' : refLine(ents, r) ? 'line' : refCircle(ents, r) ? 'circle' : null);
    const centre = (r: SkRef): SkRef => ({ e: r.e, p: 0 });
    if (picks.length === 1) {
      const k = kind(picks[0]);
      if (k === 'line' && picks[0].e !== ORIGIN) return { type: 'distance', refs: picks };
      if (k === 'circle') return { type: ents.get(picks[0].e)?.kind === 'arc' ? 'radius' : 'diameter', refs: picks };
      return null;
    }
    if (picks.length !== 2) return null;
    let [a, b] = picks;
    let ka = kind(a), kb = kind(b);
    if (ka === 'circle') { a = centre(a); ka = 'point'; }
    if (kb === 'circle') { b = centre(b); kb = 'point'; }
    if (ka === 'point' && kb === 'point') {
      const A = refPoint(ents, a)!, B = refPoint(ents, b)!;
      const inX = at[0] >= Math.min(A[0], B[0]) && at[0] <= Math.max(A[0], B[0]);
      const inY = at[1] >= Math.min(A[1], B[1]) && at[1] <= Math.max(A[1], B[1]);
      if (inX && !inY) return { type: 'hdistance', refs: [a, b] };
      if (inY && !inX) return { type: 'vdistance', refs: [a, b] };
      return { type: 'distance', refs: [a, b] };
    }
    if (ka === 'line' && kb === 'line') {
      const la = refLine(ents, a)!, lb = refLine(ents, b)!;
      const u = unit2(la), v = unit2(lb);
      return Math.abs(u[0] * v[1] - u[1] * v[0]) < 1e-6 ? { type: 'distance', refs: [a, b] } : { type: 'angle', refs: [a, b] };
    }
    if (ka === 'point' && kb === 'line') return { type: 'distance', refs: [a, b] };
    if (ka === 'line' && kb === 'point') return { type: 'distance', refs: [b, a] };
    return null;
  }

  // -------------------------------------------------------------------------
  // drawing tools

  private click(p: Vec2, dbl: boolean) {
    const tool = store.state.sketchTool;
    const d = this.draft;
    const same = (a: Vec2, b: Vec2) => Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-6;
    const snapped = { ...this.snapInfo };
    switch (tool) {
      case 'line':
      case 'spline': {
        if (dbl) { this.finishOpen(); return; }
        if (d.length >= 2 && same(p, d[0])) { this.commitPoly(true); return; }
        if (d.length && same(p, d[d.length - 1])) { this.finishOpen(); return; }
        d.push(p);
        this.draftSnaps.push(snapped);
        break;
      }
      case 'rect':
      case 'crect':
      case 'circle':
      case 'polygon': {
        if (!d.length) { d.push(p); this.draftSnaps.push(snapped); break; }
        this.draftSnaps.push(snapped);
        this.commitTwoPoint(d[0], p);
        break;
      }
      case 'slot': {
        if (d.length < 2) {
          if (d.length === 1 && same(d[0], p)) return;
          d.push(p);
          this.draftSnaps.push(snapped);
          break;
        }
        const r = segDist(p, d[0], d[1]);
        if (r > 0) {
          const id = uid('k');
          addSketchEntity({ id, kind: 'slot', x1: d[0][0], y1: d[0][1], x2: d[1][0], y2: d[1][1], r }, this.snapConstraints(id, [0, 1]));
        }
        this.cancel();
        break;
      }
      case 'arc': {
        if (d.length < 2) {
          if (d.length === 1 && same(d[0], p)) return;
          d.push(p);
          this.draftSnaps.push(snapped);
          break;
        }
        const arc = arcThrough(d[0], p, d[1]);
        if (arc) {
          const id = uid('k');
          // arcs run anticlockwise, so the first click may have become the end point
          const flipped = arc.x1 !== d[0][0] || arc.y1 !== d[0][1];
          addSketchEntity({ id, kind: 'arc', ...arc }, this.snapConstraints(id, flipped ? [2, 1] : [1, 2]));
        }
        this.cancel();
        break;
      }
    }
    this.typed = '';
    this.updateDraft();
  }

  /** Coincident / midpoint constraints for draft points that snapped onto existing geometry. */
  private snapConstraints(id: string, pointIndex: (number | null)[]): SketchConstraint[] {
    const out: SketchConstraint[] = [];
    this.draftSnaps.forEach((s, i) => {
      const p = pointIndex[i];
      if (p === null || p === undefined) return;
      if (s.ref) out.push({ id: uid('c'), type: 'coincident', refs: [{ e: id, p }, s.ref] });
      else if (s.mid) out.push({ id: uid('c'), type: 'midpoint', refs: [{ e: id, p }, s.mid] });
    });
    for (const t of this.typedDims) out.push({ id: uid('d'), type: t.type, refs: [t.ref(id)], value: t.value });
    return out;
  }

  private commitTwoPoint(a: Vec2, b: Vec2) {
    const tool = store.state.sketchTool;
    const id = uid('k');
    let e: SketchEntity | null = null;
    if (tool === 'rect') {
      const w = b[0] - a[0], h = b[1] - a[1];
      if (Math.abs(w) > 1e-6 && Math.abs(h) > 1e-6) e = { id, kind: 'rect', x: Math.min(a[0], b[0]), y: Math.min(a[1], b[1]), w: Math.abs(w), h: Math.abs(h) };
    } else if (tool === 'crect') {
      const w = Math.abs(b[0] - a[0]) * 2, h = Math.abs(b[1] - a[1]) * 2;
      if (w > 1e-6 && h > 1e-6) e = { id, kind: 'rect', x: a[0] - w / 2, y: a[1] - h / 2, w, h };
    } else if (tool === 'circle') {
      const r = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (r > 1e-6) e = { id, kind: 'circle', cx: a[0], cy: a[1], r };
    } else if (tool === 'polygon') {
      const r = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const rot = (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI - 90;
      if (r > 1e-6) e = { id, kind: 'polygon', cx: a[0], cy: a[1], r, sides: store.state.polygonSides, rotation: Math.round(rot * 100) / 100 };
    }
    if (e) {
      // which of the new shape's points each click became
      const pts = entityPoints(e);
      const which = (p: Vec2) => { const i = pts.findIndex((q) => Math.hypot(q[0] - p[0], q[1] - p[1]) < 1e-6); return i < 0 ? null : i; };
      const idx = [which(a), tool === 'circle' ? null : which(b)];
      const cs = this.snapConstraints(id, idx);
      // a circle drawn out to an existing point passes through it
      const edge = this.draftSnaps[1];
      if (tool === 'circle' && edge?.ref) cs.push({ id: uid('c'), type: 'onCurve', refs: [edge.ref, { e: id }] });
      addSketchEntity(e, cs);
    }
    this.cancel();
  }

  private commitPoly(closed: boolean) {
    const pts = [...this.draft];
    const tool = store.state.sketchTool;
    if (pts.length >= (closed ? 3 : 2)) {
      const id = uid('k');
      const cs = this.snapConstraints(id, pts.map((_, i) => i));
      if (tool !== 'spline') {
        // level or upright segments (inferred while drawing, or exactly aligned) keep that way
        const n = closed ? pts.length : pts.length - 1;
        for (let i = 0; i < n; i++) {
          const a = pts[i], b = pts[(i + 1) % pts.length];
          const inferred = this.draftSnaps[i + 1]?.axis;
          const h = inferred === 'h' || Math.abs(a[1] - b[1]) < 1e-9, v = inferred === 'v' || Math.abs(a[0] - b[0]) < 1e-9;
          if (h !== v) cs.push({ id: uid('c'), type: h ? 'horizontal' : 'vertical', refs: [{ e: id, s: i }] });
        }
      }
      addSketchEntity(tool === 'spline'
        ? { id, kind: 'spline', points: pts, closed }
        : { id, kind: 'polyline', points: pts, closed }, cs);
    }
    this.cancel();
  }

  private finishOpen() { this.commitPoly(false); }

  cancel() {
    this.draft = [];
    this.draftSnaps = [];
    this.typedDims = [];
    this.typed = '';
    this.dimPicks = [];
    this.trimHover = null;
    this.box = null;
    this.clear(this.draftGroup);
    this.host.hud.style.display = 'none';
  }

  /** Keyboard: typed dimensions, Enter to finish, Esc to cancel. */
  key(e: KeyboardEvent): boolean {
    // fillet: type a radius
    if (store.state.sketchTool === 'fillet') {
      if (/^[0-9.]$/.test(e.key)) { this.typed += e.key; this.updateDraft(); return true; }
      if (e.key === 'Backspace' && this.typed) { this.typed = this.typed.slice(0, -1); this.updateDraft(); return true; }
      if (e.key === 'Enter' && this.typed) {
        const r = parseFloat(this.typed);
        this.typed = '';
        if (r > 0) store.set({ sketchFilletR: r });
        this.updateDraft();
        return true;
      }
    }
    if (store.state.sketchTool === 'dimension' && this.dimPicks.length && e.key === 'Escape') {
      this.dimPicks = []; store.set({ sketchSelection: [] }); this.clear(this.draftGroup); this.host.invalidate(); return true;
    }
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

  /** Typed sizes place the point exactly and become real dimensions you can change later. */
  private applyTyped() {
    const nums = this.typed.split(',').map(Number).filter((n) => !Number.isNaN(n));
    this.typed = '';
    if (!nums.length) return;
    const tool = store.state.sketchTool;
    const a = this.draft[0];
    const last = this.draft[this.draft.length - 1];
    this.snapInfo = {};
    if (tool === 'line' || tool === 'spline') {
      const ang = Math.atan2(this.cursor[1] - last[1], this.cursor[0] - last[0]);
      const len = nums[0];
      const angle = nums.length > 1 ? (nums[1] * Math.PI) / 180 : ang;
      if (tool === 'line' && len > 0) {
        const s = this.draft.length - 1;
        this.typedDims.push({ type: 'distance', ref: (id) => ({ e: id, s }), value: len });
      }
      this.click([last[0] + Math.cos(angle) * len, last[1] + Math.sin(angle) * len], false);
    } else if (tool === 'rect' || tool === 'crect') {
      const w = Math.abs(nums[0]), h = Math.abs(nums[1] ?? nums[0]);
      this.typedDims.push({ type: 'hdistance', ref: (id) => ({ e: id, s: 0 }), value: w }, { type: 'vdistance', ref: (id) => ({ e: id, s: 1 }), value: h });
      const sx = Math.sign(this.cursor[0] - a[0]) || 1, sy = Math.sign(this.cursor[1] - a[1]) || 1;
      const b: Vec2 = tool === 'rect' ? [a[0] + sx * w, a[1] + sy * h] : [a[0] + w / 2, a[1] + h / 2];
      this.draftSnaps.push({});
      this.commitTwoPoint(a, b);
    } else if (tool === 'circle' || tool === 'polygon') {
      const r = tool === 'circle' ? nums[0] / 2 : nums[0];
      this.typedDims.push(tool === 'circle'
        ? { type: 'diameter', ref: (id) => ({ e: id }), value: nums[0] }
        : { type: 'radius', ref: (id) => ({ e: id }), value: nums[0] });
      this.draftSnaps.push({});
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
    const drawing = tool !== 'select' && tool !== 'constrain' && tool !== 'dimension' && tool !== 'trim' && tool !== 'fillet';
    this.cursorDot.visible = drawing;
    this.cursorDot.matrixAutoUpdate = false;
    const s = (this.snapKind === 'point' || this.snapKind === 'mid' ? 5 : 3.5) / ppu;
    this.cursorDot.matrix.copy(m).multiply(new THREE.Matrix4().makeTranslation(this.cursor[0], this.cursor[1], 0.05)).multiply(new THREE.Matrix4().makeScale(s, s, s));
    (this.cursorDot.material as THREE.MeshBasicMaterial).color.set(
      this.snapKind === 'point' ? '#fbbf24' : this.snapKind === 'mid' ? '#f472b6' : this.snapKind === 'axis' ? '#22d3ee' : '#ffffff');

    const d = this.draft;
    const c = this.cursor;
    let label = '';
    let hint = 'type a number for exact size';
    const mat = this.lineMat(this.host.accent(), 2.5, 1, this.draftMaterials);
    const add = (pts: Vec2[], closed: boolean, mt = mat) => { const l = this.line(pts, closed, mt, 0.04); if (l) this.draftGroup.add(l); };

    if (this.box) {
      const [a, b] = [this.box.start, this.box.end];
      add([a, [b[0], a[1]], b, [a[0], b[1]]], true, this.lineMat('#93c5fd', 1.2, 0.9, this.draftMaterials, true));
    }
    if (tool === 'trim' && this.trimHover && this.trimHover.length >= 2) {
      add(this.trimHover, false, this.lineMat('#f87171', 4, 1, this.draftMaterials));
      label = 'Trim'; hint = 'click to cut this piece away';
    }
    if (tool === 'fillet') {
      label = this.typed ? `R ${this.typed}` : `R ${fmt(store.state.sketchFilletR)} mm`;
      hint = this.typed ? 'Enter to use this radius' : 'click a corner · type a number to change';
    }
    if (tool === 'dimension' && this.dimPicks.length) {
      const plan = this.dimPlan(c);
      if (plan) {
        const zero = this.dimGeometry(this.ents, { id: 'tmp', type: plan.type, refs: plan.refs, offset: [0, 0] });
        const off: Vec2 | undefined = zero ? [c[0] - zero.label[0], c[1] - zero.label[1]] : undefined;
        const g = this.dimGeometry(this.ents, { id: 'tmp', type: plan.type, refs: plan.refs, offset: off });
        if (g) {
          const dm = this.lineMat(COLORS.dim, 1.4, 1, this.draftMaterials);
          for (const pts of g.lines) add(pts, false, dm);
          label = g.text;
          hint = 'click to place · then type the size';
        }
      } else { label = 'Pick one more'; hint = 'a point, line or circle'; }
    }
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
        case 'arc': {
          if (d.length === 1) { add([d[0], c], false); label = `${fmt(dist(d[0], c))} mm`; hint = 'click the arc’s end'; }
          else {
            const arc = arcThrough(d[0], c, d[1]);
            if (arc) {
              add(entityOutline({ id: 't', kind: 'arc', ...arc }).points, false);
              label = `R ${fmt(Math.hypot(arc.x1 - arc.cx, arc.y1 - arc.cy))} mm`;
            } else add([d[0], d[1]], false);
            hint = 'move to bend it, then click';
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
        : `<b>${label}</b><span>${hint}</span>`;
    } else hud.style.display = 'none';
    this.host.invalidate();
  }
}

function isResizable(es: SketchEntity[], r: SkRef) {
  const e = es.find((x) => x.id === r.e);
  return !!e && (e.kind === 'circle' || e.kind === 'arc') && r.p === undefined && r.s === undefined;
}

function typedHint(tool: string) {
  if (tool === 'rect' || tool === 'crect') return 'width,height';
  if (tool === 'circle') return 'diameter';
  if (tool === 'polygon') return 'radius';
  return 'length[,angle]';
}

const dist = (a: Vec2, b: Vec2) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const unit2 = (l: [Vec2, Vec2]): Vec2 => { const d = dist(l[0], l[1]) || 1; return [(l[1][0] - l[0][0]) / d, (l[1][1] - l[0][1]) / d]; };

function foot(p: Vec2, l: [Vec2, Vec2]): Vec2 {
  const u = unit2(l);
  const t = (p[0] - l[0][0]) * u[0] + (p[1] - l[0][1]) * u[1];
  return [l[0][0] + u[0] * t, l[0][1] + u[1] * t];
}

function intersect(a: [Vec2, Vec2], b: [Vec2, Vec2]): Vec2 | null {
  const d1: Vec2 = [a[1][0] - a[0][0], a[1][1] - a[0][1]], d2: Vec2 = [b[1][0] - b[0][0], b[1][1] - b[0][1]];
  const den = d1[0] * d2[1] - d1[1] * d2[0];
  if (Math.abs(den) < 1e-12) return null;
  const t = ((b[0][0] - a[0][0]) * d2[1] - (b[0][1] - a[0][1]) * d2[0]) / den;
  return [a[0][0] + d1[0] * t, a[0][1] + d1[1] * t];
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
  return dragRef(e, { e: e.id, s: -1 }, [0, 0], [dx, dy]).entity;
}

export { updateSketchEntity, entityCircle };
