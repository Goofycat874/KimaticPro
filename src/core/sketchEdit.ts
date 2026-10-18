// Sketch editing tools: trim, corner fillet, offset and mirror.
// Pure functions over entities + constraints, so they're easy to test.

import { uid, type SketchConstraint, type SketchEntity, type SkRef, type Vec2 } from './types';
import { arcInfo, arcThrough, entityLines, entityOutline, entityPoints, pointInPolygon, sketchProfileEntities } from './sketch';
import { liveConstraints } from './constraints';

const TAU = Math.PI * 2;
const sub = (a: Vec2, b: Vec2): Vec2 => [a[0] - b[0], a[1] - b[1]];
const add = (a: Vec2, b: Vec2): Vec2 => [a[0] + b[0], a[1] + b[1]];
const mul = (a: Vec2, k: number): Vec2 => [a[0] * k, a[1] * k];
const len = (a: Vec2) => Math.hypot(a[0], a[1]);
const unit = (a: Vec2): Vec2 => mul(a, 1 / (len(a) || 1));
const cross = (a: Vec2, b: Vec2) => a[0] * b[1] - a[1] * b[0];
const dot = (a: Vec2, b: Vec2) => a[0] * b[0] + a[1] * b[1];
const lerp = (a: Vec2, b: Vec2, t: number): Vec2 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
const norm = (a: number) => ((a % TAU) + TAU) % TAU;

export interface Edit { entities: SketchEntity[]; constraints: SketchConstraint[] }

/** Rectangles and polygons become plain closed polylines so their sides can be edited one by one. */
export function asPolyline(e: SketchEntity): SketchEntity {
  if (e.kind === 'rect' && !(e.radius && e.radius > 0)) return { id: e.id, kind: 'polyline', points: entityPoints(e).slice(0, 4), closed: true, construction: e.construction };
  if (e.kind === 'polygon') return { id: e.id, kind: 'polyline', points: entityPoints(e).slice(1), closed: true, construction: e.construction };
  return e;
}

// ---------------------------------------------------------------------------
// corner fillet

/**
 * Round the corner at point `p` of a polyline (or rectangle/polygon) with an arc of
 * radius `r`, tangent to both sides. Existing constraints are kept and re-pointed.
 */
export function filletCorner(entities: SketchEntity[], constraints: SketchConstraint[], ref: SkRef, r: number): Edit | string {
  const orig = entities.find((x) => x.id === ref.e);
  if (!orig || ref.p === undefined) return 'Click a corner point.';
  if (orig.kind === 'rect' && ref.p < 4) {
    const max = Math.min(Math.abs(orig.w), Math.abs(orig.h)) / 2;
    if (r >= max) return `That radius is too big for this rectangle (max ${Math.round(max * 100) / 100} mm).`;
    return { entities: entities.map((x) => (x.id === orig.id ? { ...orig, radius: r } : x)), constraints };
  }
  const e = asPolyline(orig);
  if (e.kind !== 'polyline') return 'Corners can be rounded on lines, rectangles and polygons.';
  const pts = e.points, n = pts.length;
  // polygon point 0 is its centre: corners start at 1
  const i = orig.kind === 'polygon' ? ref.p - 1 : ref.p;
  if (i < 0 || i >= n) return 'Click a corner point.';
  if (!e.closed && (i === 0 || i === n - 1)) return 'That’s an end, not a corner. Click where two lines meet.';
  const V = pts[i], A = pts[(i - 1 + n) % n], B = pts[(i + 1) % n];
  const u1 = unit(sub(A, V)), u2 = unit(sub(B, V));
  const theta = Math.acos(Math.max(-1, Math.min(1, dot(u1, u2))));
  if (theta < 1e-3 || Math.PI - theta < 1e-3) return 'Those lines are in a straight line — there’s no corner to round.';
  const t = r / Math.tan(theta / 2);
  if (t >= len(sub(A, V)) - 1e-6 || t >= len(sub(B, V)) - 1e-6) return 'That radius is too big for these lines.';
  const P1 = add(V, mul(u1, t)), P2 = add(V, mul(u2, t));
  const C = add(V, mul(unit(add(u1, u2)), r / Math.sin(theta / 2)));
  const M = add(C, mul(unit(sub(V, C)), r));
  const arcGeo = arcThrough(P1, M, P2)!;
  const arc: SketchEntity = { id: uid('k'), kind: 'arc', ...arcGeo, construction: e.construction };
  // which arc end is P1 (arcs run anticlockwise)
  const p1End = Math.hypot(arcGeo.x1 - P1[0], arcGeo.y1 - P1[1]) < 1e-9 ? 1 : 2;
  const p2End = 3 - p1End;
  const out: SketchEntity[] = [];
  const pointMap = new Map<number, SkRef>();
  const segMap = new Map<number, SkRef>();
  if (e.closed) {
    // open the loop at the corner: P2, p(i+1) … p(i-1), P1
    const id = e.id;
    const list: Vec2[] = [P2];
    for (let k = 1; k < n; k++) list.push(pts[(i + k) % n]);
    list.push(P1);
    out.push({ id, kind: 'polyline', points: list, closed: false, construction: e.construction });
    for (let j = 0; j < n; j++) if (j !== i) pointMap.set(j, { e: id, p: (j - i + n) % n });
    for (let s = 0; s < n; s++) segMap.set(s, { e: id, s: (s - i + n) % n });
    pointMap.set(-1, { e: id, p: n }); // P1
    pointMap.set(-2, { e: id, p: 0 }); // P2
  } else {
    const a = { id: e.id, pts: [...pts.slice(0, i), P1] }, b = { id: uid('k'), pts: [P2, ...pts.slice(i + 1)] };
    out.push({ id: a.id, kind: 'polyline', points: a.pts, closed: false, construction: e.construction });
    out.push({ id: b.id, kind: 'polyline', points: b.pts, closed: false, construction: e.construction });
    for (let j = 0; j < n; j++) if (j < i) pointMap.set(j, { e: a.id, p: j }); else if (j > i) pointMap.set(j, { e: b.id, p: j - i });
    for (let s = 0; s < n - 1; s++) segMap.set(s, s < i ? { e: a.id, s } : { e: b.id, s: s - i });
    pointMap.set(-1, { e: a.id, p: i });
    pointMap.set(-2, { e: b.id, p: 0 });
  }
  // re-point constraints at the old polyline; ones on the removed corner point go
  const remap = (rf: SkRef): SkRef | null => {
    if (rf.e !== orig.id) return rf;
    if (rf.p !== undefined) {
      const j = orig.kind === 'polygon' ? rf.p - 1 : rf.p;
      if (j === i) return null;
      return pointMap.get(j) ?? null;
    }
    if (rf.s !== undefined) return segMap.get(rf.s) ?? null;
    return null;
  };
  const kept: SketchConstraint[] = [];
  for (const c of constraints) {
    const refs = c.refs.map(remap);
    if (refs.every(Boolean)) kept.push({ ...c, refs: refs as SkRef[] });
  }
  const seg1 = e.closed ? segMap.get((i - 1 + n) % n)! : segMap.get(i - 1)!;
  const seg2 = e.closed ? segMap.get(i)! : segMap.get(i)!;
  kept.push(
    { id: uid('c'), type: 'coincident', refs: [{ e: arc.id, p: p1End }, pointMap.get(-1)!] },
    { id: uid('c'), type: 'coincident', refs: [{ e: arc.id, p: p2End }, pointMap.get(-2)!] },
    { id: uid('c'), type: 'tangent', refs: [seg1, { e: arc.id }] },
    { id: uid('c'), type: 'tangent', refs: [seg2, { e: arc.id }] },
    { id: uid('d'), type: 'radius', refs: [{ e: arc.id }], value: r },
  );
  const next = entities.flatMap((x) => (x.id === orig.id ? [...out, arc] : [x]));
  return { entities: next, constraints: liveConstraints(next, kept) };
}

// ---------------------------------------------------------------------------
// trim

type Piece =
  | { t: 'line'; a: Vec2; b: Vec2 }
  | { t: 'circ'; c: Vec2; r: number; a0: number; sweep: number };

/** Every entity as straight lines and circular arcs (curvy ones are fine-grained lines). */
function piecesOf(e: SketchEntity): Piece[] {
  if (e.kind === 'circle') return [{ t: 'circ', c: [e.cx, e.cy], r: e.r, a0: 0, sweep: TAU }];
  if (e.kind === 'arc') { const a = arcInfo(e); return [{ t: 'circ', c: [e.cx, e.cy], r: a.r, a0: a.a0, sweep: a.sweep }]; }
  if (e.kind === 'slot') {
    const ang = Math.atan2(e.y2 - e.y1, e.x2 - e.x1);
    const n: Vec2 = [-Math.sin(ang) * e.r, Math.cos(ang) * e.r];
    return [
      { t: 'line', a: add([e.x1, e.y1], n), b: add([e.x2, e.y2], n) },
      { t: 'line', a: sub([e.x1, e.y1], n), b: sub([e.x2, e.y2], n) },
      { t: 'circ', c: [e.x2, e.y2], r: e.r, a0: ang - Math.PI / 2, sweep: Math.PI },
      { t: 'circ', c: [e.x1, e.y1], r: e.r, a0: ang + Math.PI / 2, sweep: Math.PI },
    ];
  }
  if (e.kind === 'polyline' || e.kind === 'rect' || e.kind === 'polygon') return entityLines(e).map(([a, b]) => ({ t: 'line', a, b }));
  const o = entityOutline(e, 64);
  const ps = o.closed ? [...o.points, o.points[0]] : o.points;
  return ps.slice(1).map((b, k) => ({ t: 'line', a: ps[k], b }));
}

const onArc = (p: Piece & { t: 'circ' }, ang: number) => norm(ang - p.a0) <= p.sweep + 1e-9;

/** Points where two pieces cross. */
function intersections(p: Piece, q: Piece): Vec2[] {
  if (p.t === 'line' && q.t === 'line') {
    const d1 = sub(p.b, p.a), d2 = sub(q.b, q.a);
    const den = cross(d1, d2);
    if (Math.abs(den) < 1e-12) return [];
    const t = cross(sub(q.a, p.a), d2) / den, u = cross(sub(q.a, p.a), d1) / den;
    return t >= -1e-9 && t <= 1 + 1e-9 && u >= -1e-9 && u <= 1 + 1e-9 ? [lerp(p.a, p.b, t)] : [];
  }
  if (p.t === 'circ' && q.t === 'line') return intersections(q, p);
  if (p.t === 'line' && q.t === 'circ') {
    const d = sub(p.b, p.a), f = sub(p.a, q.c);
    const A = dot(d, d), B = 2 * dot(f, d), C = dot(f, f) - q.r * q.r;
    const disc = B * B - 4 * A * C;
    if (disc < 0 || A < 1e-18) return [];
    const s = Math.sqrt(disc);
    return [(-B - s) / (2 * A), (-B + s) / (2 * A)]
      .filter((t, k, arr) => t >= -1e-9 && t <= 1 + 1e-9 && (k === 0 || Math.abs(t - arr[0]) > 1e-12))
      .map((t) => lerp(p.a, p.b, t))
      .filter((pt) => onArc(q, Math.atan2(pt[1] - q.c[1], pt[0] - q.c[0])));
  }
  const a = p as Piece & { t: 'circ' }, b = q as Piece & { t: 'circ' };
  const dv = sub(b.c, a.c), d = len(dv);
  if (d < 1e-12 || d > a.r + b.r + 1e-9 || d < Math.abs(a.r - b.r) - 1e-9) return [];
  const x = (d * d + a.r * a.r - b.r * b.r) / (2 * d);
  const h = Math.sqrt(Math.max(0, a.r * a.r - x * x));
  const m = add(a.c, mul(dv, x / d));
  const nrm: Vec2 = [-dv[1] / d, dv[0] / d];
  const pts = h < 1e-12 ? [m] : [add(m, mul(nrm, h)), sub(m, mul(nrm, h))];
  return pts.filter((pt) => onArc(a, Math.atan2(pt[1] - a.c[1], pt[0] - a.c[0])) && onArc(b, Math.atan2(pt[1] - b.c[1], pt[0] - b.c[0])));
}

/** The bit of the clicked line/circle/arc between its nearest crossings (for previews), as points. */
export function trimPreview(entities: SketchEntity[], ref: SkRef, at: Vec2): Vec2[] | null {
  const r = trimPlan(entities, ref, at);
  return r ? r.removed : null;
}

interface TrimPlan { removed: Vec2[]; replace: SketchEntity[]; remap?: (r: SkRef) => SkRef | null }

function trimPlan(entities: SketchEntity[], ref: SkRef, at: Vec2): TrimPlan | null {
  const orig = entities.find((x) => x.id === ref.e);
  if (!orig) return null;
  const e = asPolyline(orig);
  const others: Piece[] = [];
  for (const x of entities) if (x.id !== orig.id) others.push(...piecesOf(x));
  if (e.kind === 'polyline') {
    const segs = entityLines(e);
    // the clicked segment: nearest to the cursor
    let s = ref.s ?? -1;
    if (s < 0 || s >= segs.length) {
      let best = Infinity;
      segs.forEach(([a, b], k) => { const d = segDist(at, a, b); if (d < best) { best = d; s = k; } });
    }
    const [A, B] = segs[s];
    // the polyline's own other sides count too (shared corners land at t = 0 or 1 and are ignored)
    const own = segs.filter((_, k) => k !== s).map(([a, b]) => ({ t: 'line', a, b }) as Piece);
    const L = len(sub(B, A)) || 1;
    const ts = [...others, ...own].flatMap((q) => intersections({ t: 'line', a: A, b: B }, q))
      .map((p) => dot(sub(p, A), sub(B, A)) / (L * L)).filter((t) => t > 1e-6 && t < 1 - 1e-6);
    const tc = Math.max(0, Math.min(1, dot(sub(at, A), sub(B, A)) / (L * L)));
    const lo = Math.max(0, ...ts.filter((t) => t < tc)), hi = Math.min(1, ...ts.filter((t) => t > tc));
    const P = lerp(A, B, lo), Q = lerp(A, B, hi);
    const pts = e.points, n = pts.length;
    const replace: SketchEntity[] = [];
    const push = (points: Vec2[]) => replace.push({ id: replace.length ? uid('k') : e.id, kind: 'polyline', points, closed: false, construction: e.construction });
    const q0 = hi < 1 ? 1 : 0;
    let remap: (r: SkRef) => SkRef | null;
    if (e.closed) {
      // open the loop at the gap: Q, p(s+1) … round to … p(s), P
      const list: Vec2[] = hi < 1 ? [Q] : [];
      for (let k = 1; k <= n; k++) list.push(pts[(s + k) % n]);
      if (lo > 0) list.push(P);
      if (list.length >= 2) push(list);
      const id = replace[0]?.id;
      remap = (r) => {
        if (!id) return null;
        if (r.p !== undefined) return { e: id, p: q0 + ((r.p - s - 1 + n) % n) };
        if (r.s !== undefined && r.s !== s) return { e: id, s: q0 + ((r.s - s - 1 + n) % n) };
        return null;
      };
    } else {
      const before = lo > 0 ? [...pts.slice(0, s + 1), P] : pts.slice(0, s + 1);
      const after = hi < 1 ? [Q, ...pts.slice(s + 1)] : pts.slice(s + 1);
      if (before.length >= 2) push(before);
      if (after.length >= 2) push(after);
      const bId = before.length >= 2 ? replace[0].id : null;
      const aId = after.length >= 2 ? replace[replace.length - 1].id : null;
      remap = (r) => {
        if (r.p !== undefined) return r.p <= s ? (bId ? { e: bId, p: r.p } : null) : aId ? { e: aId, p: r.p - s - 1 + q0 } : null;
        if (r.s !== undefined && r.s !== s) return r.s < s ? (bId ? { e: bId, s: r.s } : null) : aId ? { e: aId, s: r.s - s - 1 + q0 } : null;
        return null;
      };
    }
    // a rectangle or polygon's own point numbering differs from the polyline it became
    const offset = orig.kind === 'polygon' ? 1 : 0;
    const base = remap;
    remap = (r) => (r.p !== undefined ? (orig.kind === 'rect' && r.p === 4 ? null : base({ ...r, p: r.p - offset })) : base(r));
    return { removed: [P, Q], replace, remap };
  }
  if (e.kind === 'circle' || e.kind === 'arc') {
    const p = piecesOf(e)[0] as Piece & { t: 'circ' };
    const angs = others.flatMap((q) => intersections(p, q)).map((pt) => norm(Math.atan2(pt[1] - p.c[1], pt[0] - p.c[0]) - p.a0));
    const tc = norm(Math.atan2(at[1] - p.c[1], at[0] - p.c[0]) - p.a0);
    const full = e.kind === 'circle';
    const cuts = angs.filter((x) => (full ? true : x > 1e-6 && x < p.sweep - 1e-6));
    if (full && cuts.length < 2) return { removed: arcPts(p.c, p.r, 0, TAU), replace: [] };
    let lo: number, hi: number;
    if (full) {
      const sorted = [...cuts].sort((x, y) => x - y);
      hi = sorted.find((x) => x > tc) ?? sorted[0] + TAU;
      lo = [...sorted].reverse().find((x) => x < tc) ?? sorted[sorted.length - 1] - TAU;
      // keep the rest: from hi round to lo + 2π
      const keep = mkArc(p.c, p.r, p.a0 + hi, p.a0 + lo + TAU, e.id, e.construction);
      return { removed: arcPts(p.c, p.r, p.a0 + lo, p.a0 + hi), replace: [keep] };
    }
    lo = Math.max(0, ...cuts.filter((x) => x < tc));
    hi = Math.min(p.sweep, ...cuts.filter((x) => x > tc));
    const replace: SketchEntity[] = [];
    if (lo > 1e-6) replace.push(mkArc(p.c, p.r, p.a0, p.a0 + lo, e.id, e.construction));
    if (hi < p.sweep - 1e-6) replace.push(mkArc(p.c, p.r, p.a0 + hi, p.a0 + p.sweep, replace.length ? uid('k') : e.id, e.construction));
    return { removed: arcPts(p.c, p.r, p.a0 + lo, p.a0 + hi), replace };
  }
  return null;
}

const arcPts = (c: Vec2, r: number, a0: number, a1: number): Vec2[] => {
  const n = Math.max(4, Math.ceil(((a1 - a0) / TAU) * 64));
  return Array.from({ length: n + 1 }, (_, k) => { const t = a0 + ((a1 - a0) * k) / n; return [c[0] + Math.cos(t) * r, c[1] + Math.sin(t) * r] as Vec2; });
};

function mkArc(c: Vec2, r: number, a0: number, a1: number, id: string, construction?: boolean): SketchEntity {
  return { id, kind: 'arc', cx: c[0], cy: c[1], x1: c[0] + Math.cos(a0) * r, y1: c[1] + Math.sin(a0) * r, x2: c[0] + Math.cos(a1) * r, y2: c[1] + Math.sin(a1) * r, construction };
}

function segDist(p: Vec2, a: Vec2, b: Vec2) {
  const d = sub(b, a), l2 = dot(d, d);
  const t = l2 ? Math.max(0, Math.min(1, dot(sub(p, a), d) / l2)) : 0;
  return len(sub(p, lerp(a, b, t)));
}

/** Cut away the clicked piece of a line, circle or arc up to the nearest crossings. */
export function trimAt(entities: SketchEntity[], constraints: SketchConstraint[], ref: SkRef, at: Vec2): Edit | string {
  const orig = entities.find((x) => x.id === ref.e);
  if (!orig) return 'Click a line, circle or arc to trim.';
  if (orig.kind === 'spline' || orig.kind === 'slot' || (orig.kind === 'rect' && orig.radius)) return 'Trim works on lines, rectangles, polygons, circles and arcs.';
  const plan = trimPlan(entities, ref, at);
  if (!plan) return 'Nothing to trim there.';
  const next = entities.flatMap((x) => (x.id === orig.id ? plan.replace : [x]));
  // constraints on the trimmed shape no longer point at the same things
  // keep constraints that still mean the same thing on the trimmed pieces
  const kept: SketchConstraint[] = [];
  for (const c of constraints) {
    if (c.refs.every((r) => r.e !== orig.id)) { kept.push(c); continue; }
    if (!plan.remap) continue;
    const refs = c.refs.map((r) => (r.e === orig.id ? plan.remap!(r) : r));
    if (refs.every(Boolean)) kept.push({ ...c, refs: refs as SkRef[] });
  }
  return { entities: next, constraints: liveConstraints(next, kept) };
}

// ---------------------------------------------------------------------------
// offset and mirror

/** Copies of shapes moved outwards by `d` (inwards when negative). */
export function offsetEntities(entities: SketchEntity[], ids: string[], d: number): SketchEntity[] {
  const out: SketchEntity[] = [];
  // open pieces that together close a region go outwards from that region
  const regions = sketchProfileEntities(entities.filter((e) => ids.includes(e.id)));
  const inside = (p: Vec2) => regions.some((r) => pointInPolygon(p, r.outer) && !r.holes.some((h) => pointInPolygon(p, h)));
  const eps = 1e-3;
  for (const e of entities) {
    if (!ids.includes(e.id)) continue;
    const id = uid('k');
    switch (e.kind) {
      case 'circle': if (e.r + d > 1e-6) out.push({ ...e, id, r: e.r + d }); break;
      case 'slot': if (e.r + d > 1e-6) out.push({ ...e, id, r: e.r + d }); break;
      case 'rect': {
        const w = Math.abs(e.w) + 2 * d, h = Math.abs(e.h) + 2 * d;
        if (w > 1e-6 && h > 1e-6) out.push({ ...e, id, x: Math.min(e.x, e.x + e.w) - d, y: Math.min(e.y, e.y + e.h) - d, w, h, radius: e.radius ? Math.max(0, e.radius + d) : (d > 0 ? d : undefined) });
        break;
      }
      case 'polygon': { const r = e.r + d / Math.cos(Math.PI / e.sides); if (r > 1e-6) out.push({ ...e, id, r }); break; }
      case 'arc': {
        const a = arcInfo(e);
        const radial = unit(sub(a.mid, [e.cx, e.cy]));
        const grow = regions.length && inside(add(a.mid, mul(radial, eps))) ? -d : d;
        if (a.r + grow > 1e-6) out.push(mkArc([e.cx, e.cy], a.r + grow, a.a0, a.a0 + a.sweep, id, e.construction));
        break;
      }
      case 'polyline':
      case 'spline': {
        const pts = e.kind === 'spline' ? entityOutline(e, 64).points : e.points;
        let dd = d;
        if (!e.closed && regions.length && pts.length >= 2) {
          // offsetPolyline puts open lines on their right; flip if that's inside the region
          const u = unit(sub(pts[1], pts[0]));
          const mid = lerp(pts[0], pts[1], 0.5);
          if (inside(add(mid, mul([u[1], -u[0]], eps)))) dd = -d;
        }
        const off = offsetPolyline(pts, e.closed, dd);
        if (off) out.push({ id, kind: 'polyline', points: off, closed: e.closed, construction: e.construction });
        break;
      }
    }
  }
  return out;
}

/** Mitred offset of a polyline; "outwards" for closed loops whichever way they were drawn. */
function offsetPolyline(pts: Vec2[], closed: boolean, d: number): Vec2[] | null {
  const n = pts.length;
  if (n < 2) return null;
  let area = 0;
  for (let i = 0; i < n; i++) area += cross(pts[i], pts[(i + 1) % n]);
  // for an anticlockwise loop the outside is on the right of each edge
  const side = closed ? (area > 0 ? 1 : -1) : 1;
  const nrm = (a: Vec2, b: Vec2): Vec2 => { const u = unit(sub(b, a)); return [u[1] * side, -u[0] * side]; };
  const out: Vec2[] = [];
  for (let i = 0; i < n; i++) {
    const prev = i > 0 ? pts[i - 1] : closed ? pts[n - 1] : null;
    const next = i < n - 1 ? pts[i + 1] : closed ? pts[0] : null;
    const n1 = prev ? nrm(prev, pts[i]) : null, n2 = next ? nrm(pts[i], next) : null;
    if (n1 && n2) {
      const m = unit(add(n1, n2));
      const k = dot(m, n1);
      out.push(add(pts[i], mul(m, d / Math.max(0.2, k))));
    } else out.push(add(pts[i], mul((n1 ?? n2)!, d)));
  }
  return out;
}

/** Mirrored copies of shapes across a line. */
export function mirrorEntities(entities: SketchEntity[], ids: string[], line: [Vec2, Vec2]): SketchEntity[] {
  const [A, B] = line;
  const u = unit(sub(B, A));
  const m = (p: Vec2): Vec2 => { const v = sub(p, A); const along = mul(u, dot(v, u)); return add(A, sub(mul(along, 2), v)); };
  const out: SketchEntity[] = [];
  for (const e of entities) {
    if (!ids.includes(e.id)) continue;
    const id = uid('k');
    switch (e.kind) {
      case 'polyline': case 'spline': out.push({ ...e, id, points: e.points.map(m) }); break;
      case 'circle': { const c = m([e.cx, e.cy]); out.push({ ...e, id, cx: c[0], cy: c[1] }); break; }
      case 'slot': { const a = m([e.x1, e.y1]), b = m([e.x2, e.y2]); out.push({ ...e, id, x1: a[0], y1: a[1], x2: b[0], y2: b[1] }); break; }
      case 'arc': {
        // mirroring flips direction: the old end becomes the new start
        const c = m([e.cx, e.cy]), a = arcInfo(e), s = m(a.end), t = m(a.start);
        out.push({ id, kind: 'arc', cx: c[0], cy: c[1], x1: s[0], y1: s[1], x2: t[0], y2: t[1], construction: e.construction });
        break;
      }
      case 'rect': {
        if (Math.abs(u[0]) < 1e-9 || Math.abs(u[1]) < 1e-9) {
          const [p, q] = [m([e.x, e.y]), m([e.x + e.w, e.y + e.h])];
          out.push({ ...e, id, x: Math.min(p[0], q[0]), y: Math.min(p[1], q[1]), w: Math.abs(e.w), h: Math.abs(e.h) });
        } else out.push({ id, kind: 'polyline', points: entityPoints(e).slice(0, 4).map(m), closed: true, construction: e.construction });
        break;
      }
      case 'polygon': out.push({ id, kind: 'polyline', points: entityPoints(e).slice(1).map(m), closed: true, construction: e.construction }); break;
    }
  }
  return out;
}
