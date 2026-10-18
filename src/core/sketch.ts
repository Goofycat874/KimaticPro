import * as THREE from 'three';
import type { PlaneDef, SketchEntity, Vec2, Vec3 } from './types';

/** Points tracing an entity's outline in sketch space. */
export function entityOutline(e: SketchEntity, segments = 64): { points: Vec2[]; closed: boolean } {
  switch (e.kind) {
    case 'polyline':
      return { points: e.points, closed: e.closed };
    case 'rect': {
      const r = Math.max(0, Math.min(e.radius ?? 0, Math.abs(e.w) / 2 - 1e-4, Math.abs(e.h) / 2 - 1e-4));
      if (r <= 1e-4) {
        return { points: [[e.x, e.y], [e.x + e.w, e.y], [e.x + e.w, e.y + e.h], [e.x, e.y + e.h]], closed: true };
      }
      // rounded corners, counter-clockwise from the bottom-right
      if (e.w < 0 || e.h < 0) return entityOutline({ ...e, x: Math.min(e.x, e.x + e.w), y: Math.min(e.y, e.y + e.h), w: Math.abs(e.w), h: Math.abs(e.h) }, segments);
      const pts: Vec2[] = [];
      const n = 10;
      const corners: [number, number, number][] = [
        [e.x + e.w - r, e.y + r, -Math.PI / 2], [e.x + e.w - r, e.y + e.h - r, 0],
        [e.x + r, e.y + e.h - r, Math.PI / 2], [e.x + r, e.y + r, Math.PI],
      ];
      for (const [cx, cy, a0] of corners) {
        for (let i = 0; i <= n; i++) {
          const a = a0 + (i / n) * (Math.PI / 2);
          pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
        }
      }
      return { points: pts, closed: true };
    }
    case 'circle': {
      const pts: Vec2[] = [];
      for (let i = 0; i < segments; i++) {
        const a = (i / segments) * Math.PI * 2;
        pts.push([e.cx + Math.cos(a) * e.r, e.cy + Math.sin(a) * e.r]);
      }
      return { points: pts, closed: true };
    }
    case 'polygon': {
      const pts: Vec2[] = [];
      const rot = (e.rotation * Math.PI) / 180 + Math.PI / 2;
      for (let i = 0; i < e.sides; i++) {
        const a = rot + (i / e.sides) * Math.PI * 2;
        pts.push([e.cx + Math.cos(a) * e.r, e.cy + Math.sin(a) * e.r]);
      }
      return { points: pts, closed: true };
    }
    case 'spline': {
      if (e.points.length < 2) return { points: e.points, closed: false };
      const curve = new THREE.CatmullRomCurve3(
        e.points.map(([x, y]) => new THREE.Vector3(x, y, 0)),
        e.closed,
        'centripetal',
      );
      const n = Math.max(24, e.points.length * 16);
      const pts = curve.getSpacedPoints(n).map((v) => [v.x, v.y] as Vec2);
      if (e.closed) pts.pop();
      return { points: pts, closed: e.closed };
    }
    case 'arc': {
      const a = arcInfo(e);
      const n = Math.max(6, Math.ceil((a.sweep / (Math.PI * 2)) * segments));
      const pts: Vec2[] = [];
      for (let i = 0; i <= n; i++) {
        const t = a.a0 + (i / n) * a.sweep;
        pts.push([e.cx + Math.cos(t) * a.r, e.cy + Math.sin(t) * a.r]);
      }
      return { points: pts, closed: false };
    }
    case 'slot': {
      const dx = e.x2 - e.x1, dy = e.y2 - e.y1;
      const ang = Math.atan2(dy, dx);
      const pts: Vec2[] = [];
      const half = 24;
      for (let i = 0; i <= half; i++) {
        const a = ang + Math.PI / 2 + (i / half) * Math.PI;
        pts.push([e.x1 + Math.cos(a) * e.r, e.y1 + Math.sin(a) * e.r]);
      }
      for (let i = 0; i <= half; i++) {
        const a = ang - Math.PI / 2 + (i / half) * Math.PI;
        pts.push([e.x2 + Math.cos(a) * e.r, e.y2 + Math.sin(a) * e.r]);
      }
      return { points: pts, closed: true };
    }
  }
}

export interface ArcInfo { r: number; a0: number; a1: number; sweep: number; start: Vec2; end: Vec2; mid: Vec2 }

/** Radius, angles and real end points of an arc (the end point is projected onto the circle). */
export function arcInfo(e: Extract<SketchEntity, { kind: 'arc' }>): ArcInfo {
  const r = Math.hypot(e.x1 - e.cx, e.y1 - e.cy);
  const a0 = Math.atan2(e.y1 - e.cy, e.x1 - e.cx);
  const a1 = Math.atan2(e.y2 - e.cy, e.x2 - e.cx);
  let sweep = (((a1 - a0) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
  if (sweep < 1e-9) sweep = Math.PI * 2;
  const at = (t: number): Vec2 => [e.cx + Math.cos(t) * r, e.cy + Math.sin(t) * r];
  return { r, a0, a1, sweep, start: [e.x1, e.y1], end: at(a0 + sweep), mid: at(a0 + sweep / 2) };
}

/** Arc through three points, running counter-clockwise from `a` to `b` via `m` (null if they're in a line). */
export function arcThrough(a: Vec2, m: Vec2, b: Vec2): { cx: number; cy: number; x1: number; y1: number; x2: number; y2: number } | null {
  const d = 2 * (a[0] * (m[1] - b[1]) + m[0] * (b[1] - a[1]) + b[0] * (a[1] - m[1]));
  if (Math.abs(d) < 1e-9) return null;
  const sq = (p: Vec2) => p[0] * p[0] + p[1] * p[1];
  const cx = (sq(a) * (m[1] - b[1]) + sq(m) * (b[1] - a[1]) + sq(b) * (a[1] - m[1])) / d;
  const cy = (sq(a) * (b[0] - m[0]) + sq(m) * (a[0] - b[0]) + sq(b) * (m[0] - a[0])) / d;
  // d > 0 means a → m → b turns left, i.e. runs counter-clockwise
  return d > 0 ? { cx, cy, x1: a[0], y1: a[1], x2: b[0], y2: b[1] } : { cx, cy, x1: b[0], y1: b[1], x2: a[0], y2: a[1] };
}

/**
 * Named points of an entity, in a fixed order that constraints refer to by index:
 * polyline/spline points; rect corners (from bottom-left, anticlockwise) then centre;
 * circle centre; polygon centre then corners; slot centres; arc centre, start, end.
 */
export function entityPoints(e: SketchEntity): Vec2[] {
  switch (e.kind) {
    case 'polyline':
    case 'spline':
      return e.points;
    case 'rect':
      return [[e.x, e.y], [e.x + e.w, e.y], [e.x + e.w, e.y + e.h], [e.x, e.y + e.h], [e.x + e.w / 2, e.y + e.h / 2]];
    case 'circle':
      return [[e.cx, e.cy]];
    case 'polygon':
      return [[e.cx, e.cy], ...entityOutline(e).points];
    case 'slot':
      return [[e.x1, e.y1], [e.x2, e.y2]];
    case 'arc': {
      const a = arcInfo(e);
      return [[e.cx, e.cy], a.start, a.end];
    }
  }
}

/** Straight segments of an entity, by index: polyline segments, rect sides (bottom, right, top, left), polygon sides, slot centre line. */
export function entityLines(e: SketchEntity): [Vec2, Vec2][] {
  switch (e.kind) {
    case 'polyline': {
      const out: [Vec2, Vec2][] = [];
      const n = e.points.length;
      for (let i = 0; i < n - 1; i++) out.push([e.points[i], e.points[i + 1]]);
      if (e.closed && n > 2) out.push([e.points[n - 1], e.points[0]]);
      return out;
    }
    case 'rect':
    case 'polygon': {
      const p = e.kind === 'rect' ? entityPoints(e).slice(0, 4) : entityPoints(e).slice(1);
      return p.map((a, i) => [a, p[(i + 1) % p.length]] as [Vec2, Vec2]);
    }
    case 'slot':
      return [[[e.x1, e.y1], [e.x2, e.y2]]];
    default:
      return [];
  }
}

/** The circle an entity sits on, for radius, tangent and concentric constraints. */
export function entityCircle(e: SketchEntity): { c: Vec2; r: number } | null {
  switch (e.kind) {
    case 'circle':
    case 'polygon':
      return { c: [e.cx, e.cy], r: e.r };
    case 'arc':
      return { c: [e.cx, e.cy], r: Math.hypot(e.x1 - e.cx, e.y1 - e.cy) };
    case 'slot':
      return { c: [e.x1, e.y1], r: e.r };
    default:
      return null;
  }
}

/** Key points users can snap to: corners, centres and end points. */
export function entitySnapPoints(e: SketchEntity): Vec2[] {
  if (e.kind === 'circle') return [[e.cx, e.cy], [e.cx + e.r, e.cy], [e.cx - e.r, e.cy], [e.cx, e.cy + e.r], [e.cx, e.cy - e.r]];
  if (e.kind === 'arc') return [...entityPoints(e), arcInfo(e).mid];
  return entityPoints(e);
}

function signedArea(pts: Vec2[]) {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[(i + 1) % pts.length];
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
}

export function pointInPolygon([x, y]: Vec2, poly: Vec2[]) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export interface Profile {
  outer: Vec2[];
  holes: Vec2[][];
}

/**
 * Turn the closed loops of a sketch into fillable profiles.
 * Loops nested inside other loops become holes (odd depth) or islands (even depth),
 * so drawing a circle inside a circle gives you a washer automatically.
 */
export function sketchProfiles(entities: SketchEntity[]): Profile[] {
  return sketchProfileEntities(entities).map((p) => ({ outer: p.outer, holes: p.holes }));
}

/** One piece of a loop made by joining separate lines, arcs and open curves end to end. */
export type ChainSeg =
  | { t: 'line'; a: Vec2; b: Vec2 }
  | { t: 'arc'; a: Vec2; b: Vec2; m: Vec2 }
  | { t: 'pts'; pts: Vec2[] };

export interface ChainLoop { kind: 'chain'; id: string; segs: ChainSeg[] }

/** Where a closed loop came from: one closed entity, or several open ones joined up. */
export type LoopSource = SketchEntity | ChainLoop;

export interface EntityProfile extends Profile {
  outerEntity: LoopSource;
  holeEntities: LoopSource[];
}

export function loopOutline(src: LoopSource, segments = 64): Vec2[] {
  if (src.kind !== 'chain') return entityOutline(src, segments).points;
  const out: Vec2[] = [];
  for (const s of src.segs) {
    const pts = segPoints(s, segments);
    out.push(...pts.slice(0, -1));
  }
  return out;
}

function segPoints(s: ChainSeg, segments = 64): Vec2[] {
  if (s.t === 'line') return [s.a, s.b];
  if (s.t === 'pts') return s.pts;
  const arc = arcThrough(s.a, s.m, s.b);
  if (!arc) return [s.a, s.b];
  const pts = entityOutline({ id: '', kind: 'arc', ...arc }, segments).points;
  // arcThrough always runs anticlockwise; flip back if this piece runs the other way
  const d = (p: Vec2, q: Vec2) => Math.hypot(p[0] - q[0], p[1] - q[1]);
  return d(pts[0], s.a) <= d(pts[pts.length - 1], s.a) ? pts : pts.reverse();
}

const reverseSeg = (s: ChainSeg): ChainSeg =>
  s.t === 'line' ? { t: 'line', a: s.b, b: s.a } : s.t === 'arc' ? { t: 'arc', a: s.b, b: s.a, m: s.m } : { t: 'pts', pts: [...s.pts].reverse() };

/**
 * Closed regions formed by open curves that meet end to end, like four lines drawn
 * as a box or two lines and an arc. Works like a map: every bounded area between
 * connected curves becomes its own loop.
 */
export function chainLoops(entities: SketchEntity[], tol = 1e-4): ChainLoop[] {
  const segs: ChainSeg[] = [];
  for (const e of entities) {
    if (e.construction) continue;
    if (e.kind === 'polyline' && !e.closed) {
      for (let i = 0; i < e.points.length - 1; i++) segs.push({ t: 'line', a: e.points[i], b: e.points[i + 1] });
    } else if (e.kind === 'spline' && !e.closed && e.points.length >= 2) {
      segs.push({ t: 'pts', pts: entityOutline(e).points });
    } else if (e.kind === 'arc') {
      const a = arcInfo(e);
      if (a.sweep < Math.PI * 2 - 1e-6) segs.push({ t: 'arc', a: a.start, b: a.end, m: a.mid });
    }
  }
  if (!segs.length) return [];
  const first = (s: ChainSeg): Vec2 => (s.t === 'pts' ? s.pts[0] : s.a);
  const last = (s: ChainSeg): Vec2 => (s.t === 'pts' ? s.pts[s.pts.length - 1] : s.b);
  // merge end points into nodes
  const nodes: Vec2[] = [];
  const nodeOf = (p: Vec2) => {
    for (let i = 0; i < nodes.length; i++) if (Math.abs(nodes[i][0] - p[0]) < tol && Math.abs(nodes[i][1] - p[1]) < tol) return i;
    nodes.push(p);
    return nodes.length - 1;
  };
  let edges = segs
    .map((s) => ({ s, u: nodeOf(first(s)), v: nodeOf(last(s)), pts: segPoints(s, 32) }))
    .filter((e) => e.u !== e.v || e.pts.length > 2);
  // drop dangling ends: they can't bound a region
  for (;;) {
    const deg = new Array(nodes.length).fill(0);
    for (const e of edges) { deg[e.u]++; deg[e.v]++; }
    const keep = edges.filter((e) => deg[e.u] > 1 && deg[e.v] > 1);
    if (keep.length === edges.length) break;
    edges = keep;
  }
  if (!edges.length) return [];
  // half-edge h: edge h>>1, forwards when even; leaves its origin at angle `ang`
  const H = edges.length * 2;
  const origin = (h: number) => (h & 1 ? edges[h >> 1].v : edges[h >> 1].u);
  const dest = (h: number) => (h & 1 ? edges[h >> 1].u : edges[h >> 1].v);
  const ang = (h: number) => {
    const p = edges[h >> 1].pts;
    const [a, b] = h & 1 ? [p[p.length - 1], p[p.length - 2]] : [p[0], p[1]];
    return Math.atan2(b[1] - a[1], b[0] - a[0]);
  };
  const around = new Map<number, number[]>();
  for (let h = 0; h < H; h++) {
    const o = origin(h);
    if (!around.has(o)) around.set(o, []);
    around.get(o)!.push(h);
  }
  for (const list of around.values()) list.sort((a, b) => ang(a) - ang(b));
  // walk each face keeping it on the left: at each node take the next edge clockwise from where we came in
  const next = (h: number) => {
    const twin = h ^ 1;
    const list = around.get(dest(h))!;
    const i = list.indexOf(twin);
    return list[(i - 1 + list.length) % list.length];
  };
  const seen = new Uint8Array(H);
  const out: ChainLoop[] = [];
  for (let h0 = 0; h0 < H; h0++) {
    if (seen[h0]) continue;
    const cycle: number[] = [];
    let h = h0;
    while (!seen[h] && cycle.length <= H) { seen[h] = 1; cycle.push(h); h = next(h); }
    if (h !== h0) continue;
    const loopSegs = cycle.map((x) => (x & 1 ? reverseSeg(edges[x >> 1].s) : edges[x >> 1].s));
    const loop: ChainLoop = { kind: 'chain', id: `chain:${out.length}`, segs: loopSegs };
    if (signedArea(loopOutline(loop, 32)) > 1e-6) out.push(loop);
  }
  return out;
}

/** Same as sketchProfiles, but remembers which entity each loop came from (for exact curves). */
export function sketchProfileEntities(entities: SketchEntity[]): EntityProfile[] {
  const closed: { e: LoopSource; pts: Vec2[] }[] = entities
    .filter((e) => !e.construction)
    .map((e) => ({ e: e as LoopSource, o: entityOutline(e) }))
    .filter(({ o }) => o.closed && o.points.length >= 3)
    .map(({ e, o }) => ({ e, pts: o.points }));
  for (const c of chainLoops(entities)) closed.push({ e: c, pts: loopOutline(c) });
  const loops = closed
    .map((l) => ({ ...l, area: Math.abs(signedArea(l.pts)) }))
    .filter((l) => l.area > 1e-6)
    .sort((a, b) => b.area - a.area);

  const depth: number[] = [];
  const parent: number[] = [];
  loops.forEach((l, i) => {
    let p = -1;
    for (let j = i - 1; j >= 0; j--) {
      if (pointInPolygon(l.pts[0], loops[j].pts) && pointInPolygon(centroid(l.pts), loops[j].pts)) {
        if (p === -1 || loops[j].area < loops[p].area) p = j;
      }
    }
    parent[i] = p;
    depth[i] = p === -1 ? 0 : depth[p] + 1;
  });

  const profiles: EntityProfile[] = [];
  const indexOf = new Map<number, number>();
  loops.forEach((l, i) => {
    if (depth[i] % 2 === 0) {
      indexOf.set(i, profiles.length);
      profiles.push({ outer: l.pts, holes: [], outerEntity: l.e, holeEntities: [] });
    } else {
      const pi = indexOf.get(parent[i]);
      if (pi !== undefined) { profiles[pi].holes.push(l.pts); profiles[pi].holeEntities.push(l.e); }
    }
  });
  return profiles;
}

function centroid(pts: Vec2[]): Vec2 {
  let x = 0, y = 0;
  for (const p of pts) { x += p[0]; y += p[1]; }
  return [x / pts.length, y / pts.length];
}

export function profileToShape(p: Profile): THREE.Shape {
  const ccw = (pts: Vec2[]) => (signedArea(pts) < 0 ? [...pts].reverse() : pts);
  const cw = (pts: Vec2[]) => (signedArea(pts) > 0 ? [...pts].reverse() : pts);
  const shape = new THREE.Shape(ccw(p.outer).map(([x, y]) => new THREE.Vector2(x, y)));
  for (const h of p.holes) shape.holes.push(new THREE.Path(cw(h).map(([x, y]) => new THREE.Vector2(x, y))));
  return shape;
}

/** Matrix taking sketch space (u, v, w=normal) to world space. */
export function planeMatrix(plane: PlaneDef): THREE.Matrix4 {
  const n = new THREE.Vector3(...plane.normal).normalize();
  const x = new THREE.Vector3(...plane.xDir).normalize();
  const y = new THREE.Vector3().crossVectors(n, x).normalize();
  const m = new THREE.Matrix4().makeBasis(x, y, n);
  m.setPosition(new THREE.Vector3(...plane.origin));
  return m;
}

export const STANDARD_PLANES: Record<'top' | 'front' | 'right', PlaneDef> = {
  // Y is up in KimaticPro, so the "Top" plane is the ground (XZ).
  top: { origin: [0, 0, 0], normal: [0, 1, 0], xDir: [1, 0, 0], label: 'Top (ground)' },
  front: { origin: [0, 0, 0], normal: [0, 0, 1], xDir: [1, 0, 0], label: 'Front' },
  right: { origin: [0, 0, 0], normal: [1, 0, 0], xDir: [0, 0, -1], label: 'Right' },
};

/** Build a sketch plane on a picked face. */
export function planeFromFace(point: Vec3, normal: Vec3): PlaneDef {
  const n = new THREE.Vector3(...normal).normalize();
  const ref = Math.abs(n.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
  const x = new THREE.Vector3().crossVectors(ref, n).normalize();
  if (Math.abs(n.y) > 0.9) x.set(1, 0, 0).projectOnPlane(n).normalize();
  return {
    origin: point.map((v) => Math.round(v * 1000) / 1000) as Vec3,
    normal: n.toArray() as Vec3,
    xDir: x.toArray() as Vec3,
    label: 'Face',
  };
}
