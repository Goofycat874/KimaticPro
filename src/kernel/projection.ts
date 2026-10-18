import * as R from 'replicad';
import * as THREE from 'three';
import { transformedShape, type BSolid } from './brep';
import type { DCurve, ProjView, ViewName } from '../core/drawingSheet';
import type { Vec2, Vec3 } from '../core/types';

// Hidden-line projections of exact solids, for 2D technical drawings.

/** Viewing direction (towards the viewer) and the sheet's right-hand direction for each standard view. */
const CAMERAS: Record<ViewName, { dir: Vec3; x: Vec3 }> = {
  front: { dir: [0, 0, 1], x: [1, 0, 0] },
  back: { dir: [0, 0, -1], x: [-1, 0, 0] },
  top: { dir: [0, 1, 0], x: [1, 0, 0] },
  bottom: { dir: [0, -1, 0], x: [1, 0, 0] },
  right: { dir: [1, 0, 0], x: [0, 0, -1] },
  left: { dir: [-1, 0, 0], x: [0, 0, 1] },
  iso: { dir: [1, 1, 1], x: [1, 0, -1] },
};

function collect(o: any, out: R.Curve2D[]) {
  if (!o) return;
  if (o.curves) out.push(...o.curves);
  else if (o.blueprints) for (const b of o.blueprints) collect(b, out);
}

const pt = (p: R.Point2D): Vec2 => [p[0], p[1]];
const TAU = Math.PI * 2;
const norm = (a: number) => ((a % TAU) + TAU) % TAU;

/** Lines stay lines, circles stay exact arcs, everything else becomes a fine polyline. */
function curvesOf(d: R.Drawing): DCurve[] {
  const all: R.Curve2D[] = [];
  collect((d as any).innerShape, all);
  const out: DCurve[] = [];
  for (const c of all) {
    const type = c.geomType;
    const f = c.firstParameter, l = c.lastParameter;
    if (type === 'LINE') { out.push({ t: 'L', a: pt(c.firstPoint), b: pt(c.lastPoint) }); continue; }
    if (type === 'CIRCLE') {
      const ad = c.adaptor();
      const circ = ad.Circle();
      const loc = circ.Location();
      const center: Vec2 = [loc.X(), loc.Y()];
      const r = circ.Radius();
      loc.delete(); circ.delete(); ad.delete();
      const ang = (p: R.Point2D) => Math.atan2(p[1] - center[1], p[0] - center[0]);
      const p0 = c.firstPoint, p1 = c.lastPoint;
      if (Math.hypot(p0[0] - p1[0], p0[1] - p1[1]) < 1e-7) { out.push({ t: 'A', c: center, r, a0: 0, a1: TAU }); continue; }
      const a0 = ang(p0), a1 = ang(p1), am = ang(c.value((f + l) / 2));
      const sweep = norm(a1 - a0);
      // store anticlockwise: from a0 to a1 if the middle lies on that side, otherwise the other way round
      out.push(norm(am - a0) < sweep ? { t: 'A', c: center, r, a0, a1: a0 + sweep } : { t: 'A', c: center, r, a0: a1, a1: a1 + (TAU - sweep) });
      continue;
    }
    const n = 48;
    const pts: Vec2[] = [];
    for (let i = 0; i <= n; i++) pts.push(pt(c.value(f + ((l - f) * i) / n)));
    out.push({ t: 'P', pts });
  }
  return out;
}

/** Join arcs of the same circle that meet end to end (a hole often comes back as two halves). */
function mergeArcs(curves: DCurve[]): DCurve[] {
  const out: DCurve[] = [];
  const groups: { c: Vec2; r: number; spans: [number, number][] }[] = [];
  for (const cv of curves) {
    if (cv.t !== 'A') { out.push(cv); continue; }
    let g = groups.find((x) => Math.abs(x.r - cv.r) < 1e-6 && Math.abs(x.c[0] - cv.c[0]) < 1e-6 && Math.abs(x.c[1] - cv.c[1]) < 1e-6);
    if (!g) { g = { c: cv.c, r: cv.r, spans: [] }; groups.push(g); }
    const a0 = norm(cv.a0);
    g.spans.push([a0, a0 + (cv.a1 - cv.a0)]);
  }
  for (const g of groups) {
    const spans = g.spans.sort((a, b) => a[0] - b[0]);
    const merged: [number, number][] = [];
    for (const sp of spans) {
      const last = merged[merged.length - 1];
      if (last && sp[0] <= last[1] + 1e-6) last[1] = Math.max(last[1], sp[1]);
      else merged.push([...sp]);
    }
    // the last span may wrap round into the first
    if (merged.length > 1) {
      const first = merged[0], last = merged[merged.length - 1];
      if (last[1] >= first[0] + TAU - 1e-6) { first[0] = last[0] - TAU; first[1] = Math.max(first[1], last[1] - TAU); merged.pop(); }
    }
    for (const [a0, a1] of merged) {
      out.push(a1 - a0 >= TAU - 1e-6 ? { t: 'A', c: g.c, r: g.r, a0: 0, a1: TAU } : { t: 'A', c: g.c, r: g.r, a0, a1 });
    }
  }
  return out;
}

function boxOf(curves: DCurve[]): [number, number, number, number] | null {
  const b = new THREE.Box2();
  const add = (p: Vec2) => b.expandByPoint(new THREE.Vector2(p[0], p[1]));
  for (const c of curves) {
    if (c.t === 'L') { add(c.a); add(c.b); }
    else if (c.t === 'P') c.pts.forEach(add);
    else {
      // sample the arc so the box hugs it
      for (let i = 0; i <= 32; i++) { const t = c.a0 + ((c.a1 - c.a0) * i) / 32; add([c.c[0] + Math.cos(t) * c.r, c.c[1] + Math.sin(t) * c.r]); }
    }
  }
  return b.isEmpty() ? null : [b.min.x, b.min.y, b.max.x, b.max.y];
}

/** Project bodies (in world space) into each requested standard view. */
export function projectBodies(bodies: { solid: BSolid; matrix: THREE.Matrix4 }[], views: ViewName[]): Record<string, ProjView> {
  const shapes = bodies.filter((b) => b.solid.kind === 'brep').map((b) => transformedShape((b.solid as any).shape, b.matrix));
  const out: Record<string, ProjView> = {};
  if (!shapes.length) return out;
  const all = shapes.length === 1 ? shapes[0] : R.makeCompound(shapes);
  for (const v of views) {
    const cam = CAMERAS[v];
    const { visible, hidden } = R.drawProjection(all, new R.ProjectionCamera([0, 0, 0], cam.dir, cam.x));
    const vis = mergeArcs(curvesOf(visible)), hid = mergeArcs(curvesOf(hidden));
    out[v] = { visible: vis, hidden: hid, box: boxOf([...vis, ...hid]) };
  }
  all.delete();
  if (shapes.length > 1) shapes.forEach((s) => s.delete());
  return out;
}
