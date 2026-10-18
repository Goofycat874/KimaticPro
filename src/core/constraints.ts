// Sketch constraint solver.
//
// Every sketch entity exposes its numbers (corner, centre, radius …) as solver
// variables, and each constraint is one or two equations that should be zero.
// The solver nudges the variables with damped least squares, taking the
// smallest change that satisfies everything, so under-constrained sketches
// move as little as possible and dragged geometry stays where you put it.

import type { ConstraintType, SketchConstraint, SketchEntity, SkRef, Vec2 } from './types';
import { entityCircle, entityLines, entityPoints } from './sketch';
import { evalExpr } from './expr';

export const ORIGIN = '$o';

// ---------------------------------------------------------------------------
// variables

const KEYS: Record<string, string[]> = {
  rect: ['x', 'y', 'w', 'h'],
  circle: ['cx', 'cy', 'r'],
  polygon: ['cx', 'cy', 'r', 'rotation'],
  slot: ['x1', 'y1', 'x2', 'y2', 'r'],
  arc: ['cx', 'cy', 'x1', 'y1', 'x2', 'y2'],
};

export function paramCount(e: SketchEntity) {
  return e.kind === 'polyline' || e.kind === 'spline' ? e.points.length * 2 : KEYS[e.kind].length;
}

function getParam(e: SketchEntity, k: number): number {
  if (e.kind === 'polyline' || e.kind === 'spline') return e.points[k >> 1][k & 1];
  return (e as any)[KEYS[e.kind][k]];
}

function setParam(e: SketchEntity, k: number, v: number) {
  if (e.kind === 'polyline' || e.kind === 'spline') e.points[k >> 1][k & 1] = v;
  else (e as any)[KEYS[e.kind][k]] = v;
}

const clone = (es: SketchEntity[]): SketchEntity[] => JSON.parse(JSON.stringify(es));

// ---------------------------------------------------------------------------
// geometry lookups for references

type Ents = Map<string, SketchEntity>;

export function refPoint(ents: Ents, r: SkRef): Vec2 | null {
  if (r.e === ORIGIN) return r.p === 0 ? [0, 0] : null;
  const e = ents.get(r.e);
  if (!e || r.p === undefined) return null;
  return entityPoints(e)[r.p] ?? null;
}

export function refLine(ents: Ents, r: SkRef): [Vec2, Vec2] | null {
  if (r.e === ORIGIN) return r.s === 0 ? [[0, 0], [1, 0]] : r.s === 1 ? [[0, 0], [0, 1]] : null;
  const e = ents.get(r.e);
  if (!e || r.p !== undefined) return null;
  return entityLines(e)[r.s ?? 0] ?? null;
}

export function refCircle(ents: Ents, r: SkRef): { c: Vec2; r: number } | null {
  if (r.e === ORIGIN || r.p !== undefined || r.s !== undefined) return null;
  const e = ents.get(r.e);
  return e ? entityCircle(e) : null;
}

const sub = (a: Vec2, b: Vec2): Vec2 => [a[0] - b[0], a[1] - b[1]];
const len = (a: Vec2) => Math.hypot(a[0], a[1]);
const cross = (a: Vec2, b: Vec2) => a[0] * b[1] - a[1] * b[0];
const dot = (a: Vec2, b: Vec2) => a[0] * b[0] + a[1] * b[1];
const unit = (a: Vec2): Vec2 => { const l = len(a) || 1e-12; return [a[0] / l, a[1] / l]; };
const lineDist = (p: Vec2, l: [Vec2, Vec2]) => cross(unit(sub(l[1], l[0])), sub(p, l[0]));

// ---------------------------------------------------------------------------
// equations

/** The measured size a dimension constraint controls (mm, or degrees for angles). */
export function measure(ents: Ents, c: SketchConstraint): number | null {
  const [a, b] = c.refs;
  switch (c.type) {
    case 'distance': {
      if (c.refs.length === 1) { const l = refLine(ents, a); return l && len(sub(l[1], l[0])); }
      const pa = refPoint(ents, a), pb = refPoint(ents, b);
      if (pa && pb) return len(sub(pa, pb));
      const la = refLine(ents, a), lb = refLine(ents, b);
      if (pa && lb) return Math.abs(lineDist(pa, lb));
      if (pb && la) return Math.abs(lineDist(pb, la));
      if (la && lb) return Math.abs(lineDist(lb[0], la));
      return null;
    }
    case 'hdistance':
    case 'vdistance': {
      const k = c.type === 'hdistance' ? 0 : 1;
      if (c.refs.length === 1) { const l = refLine(ents, a); return l && Math.abs(l[1][k] - l[0][k]); }
      const pa = refPoint(ents, a), pb = refPoint(ents, b);
      return pa && pb ? Math.abs(pb[k] - pa[k]) : null;
    }
    case 'radius':
    case 'diameter': {
      const ci = refCircle(ents, a);
      return ci && (c.type === 'radius' ? ci.r : ci.r * 2);
    }
    case 'angle': {
      const la = refLine(ents, a), lb = refLine(ents, b);
      if (!la || !lb) return null;
      const u = sub(la[1], la[0]), v = sub(lb[1], lb[0]);
      return (Math.atan2(Math.abs(cross(u, v)), dot(u, v)) * 180) / Math.PI;
    }
    default:
      return null;
  }
}

export const isDimension = (t: ConstraintType) =>
  t === 'distance' || t === 'hdistance' || t === 'vdistance' || t === 'radius' || t === 'diameter' || t === 'angle';

/** Residuals of one constraint (all zero when it's satisfied), or null if its references are gone. */
function residuals(ents: Ents, c: SketchConstraint): number[] | null {
  const [a, b, d] = c.refs;
  if (isDimension(c.type)) {
    const m = measure(ents, c);
    if (m === null || c.value === undefined) return null;
    return [c.type === 'angle' ? ((m - c.value) * Math.PI) / 180 : m - c.value];
  }
  switch (c.type) {
    case 'coincident': {
      const pa = refPoint(ents, a), pb = refPoint(ents, b);
      return pa && pb ? [pa[0] - pb[0], pa[1] - pb[1]] : null;
    }
    case 'horizontal':
    case 'vertical': {
      const k = c.type === 'horizontal' ? 1 : 0;
      if (c.refs.length === 1) { const l = refLine(ents, a); return l && [l[1][k] - l[0][k]]; }
      const pa = refPoint(ents, a), pb = refPoint(ents, b);
      return pa && pb ? [pb[k] - pa[k]] : null;
    }
    case 'parallel':
    case 'perpendicular': {
      const la = refLine(ents, a), lb = refLine(ents, b);
      if (!la || !lb) return null;
      const u = unit(sub(la[1], la[0])), v = unit(sub(lb[1], lb[0]));
      return [c.type === 'parallel' ? cross(u, v) : dot(u, v)];
    }
    case 'equal': {
      const la = refLine(ents, a), lb = refLine(ents, b);
      if (la && lb) return [len(sub(la[1], la[0])) - len(sub(lb[1], lb[0]))];
      const ca = refCircle(ents, a), cb = refCircle(ents, b);
      return ca && cb ? [ca.r - cb.r] : null;
    }
    case 'tangent': {
      const l = refLine(ents, a) ?? refLine(ents, b);
      const ca = refCircle(ents, a), cb = refCircle(ents, b);
      if (l && (ca || cb)) { const ci = (ca ?? cb)!; return [Math.abs(lineDist(ci.c, l)) - ci.r]; }
      if (ca && cb) { const dd = len(sub(ca.c, cb.c)); return [c.inner ? dd - Math.abs(ca.r - cb.r) : dd - (ca.r + cb.r)]; }
      return null;
    }
    case 'concentric': {
      const ca = refCircle(ents, a), cb = refCircle(ents, b);
      return ca && cb ? [ca.c[0] - cb.c[0], ca.c[1] - cb.c[1]] : null;
    }
    case 'midpoint': {
      const p = refPoint(ents, a), l = refLine(ents, b);
      return p && l ? [p[0] - (l[0][0] + l[1][0]) / 2, p[1] - (l[0][1] + l[1][1]) / 2] : null;
    }
    case 'onCurve': {
      const p = refPoint(ents, a);
      if (!p) return null;
      const l = refLine(ents, b);
      if (l) return [lineDist(p, l)];
      const ci = refCircle(ents, b);
      return ci ? [len(sub(p, ci.c)) - ci.r] : null;
    }
    case 'symmetric': {
      const pa = refPoint(ents, a), pb = refPoint(ents, b), l = refLine(ents, d);
      if (!pa || !pb || !l) return null;
      const mid: Vec2 = [(pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2];
      return [lineDist(mid, l), dot(unit(sub(l[1], l[0])), sub(pb, pa))];
    }
    case 'fix': {
      const p = refPoint(ents, a);
      return p && c.at ? [p[0] - c.at[0], p[1] - c.at[1]] : null;
    }
  }
  return null;
}

/** Built-in equations: an arc's end point stays on its circle. */
function arcResidual(e: SketchEntity): number | null {
  if (e.kind !== 'arc') return null;
  return Math.hypot(e.x2 - e.cx, e.y2 - e.cy) - Math.hypot(e.x1 - e.cx, e.y1 - e.cy);
}

/** Evaluate dimension expressions (e.g. `width / 2`) against the design's parameters. */
export function withValues(cs: SketchConstraint[], vars: Record<string, number>, errors?: string[]): SketchConstraint[] {
  if (!cs.some((c) => c.expr)) return cs;
  return cs.map((c) => {
    if (!c.expr) return c;
    try { return { ...c, value: evalExpr(c.expr, vars) }; } catch (e: any) { errors?.push(`${c.expr}: ${e.message}`); return c; }
  });
}

// ---------------------------------------------------------------------------
// solving

export interface SolveOptions {
  /** Variables (`entityId:index`) the solver should try hard not to change — e.g. what you're dragging. */
  keep?: Set<string>;
  /** Also work out the degrees of freedom left (slower). */
  analyze?: boolean;
}

export interface SolveResult {
  entities: SketchEntity[];
  ok: boolean;
  /** Constraints that couldn't be met. */
  failing: string[];
  /** Degrees of freedom left (when analysed). */
  dof: number;
  /** Entities whose position and size are completely set by constraints (when analysed). */
  fixed: Set<string>;
  /** Fully constrained points, as `entityId:pointIndex` (when analysed). */
  fixedPoints: Set<string>;
}

interface Eq { c?: SketchConstraint; ent?: string; deps: string[]; rows: number }

export function solveSketch(input: SketchEntity[], constraints: SketchConstraint[], opts: SolveOptions = {}): SolveResult {
  const entities = clone(input);
  const ents: Ents = new Map(entities.map((e) => [e.id, e]));

  // variables
  const varEnt: SketchEntity[] = [], varK: number[] = [], varKey: string[] = [];
  const offset = new Map<string, number>();
  for (const e of entities) {
    offset.set(e.id, varEnt.length);
    for (let k = 0; k < paramCount(e); k++) { varEnt.push(e); varK.push(k); varKey.push(`${e.id}:${k}`); }
  }
  const n = varEnt.length;
  const x = new Float64Array(n);
  for (let j = 0; j < n; j++) x[j] = getParam(varEnt[j], varK[j]);

  // equations (constraints whose references still exist)
  const eqs: Eq[] = [];
  for (const c of constraints) {
    const r = residuals(ents, c);
    if (!r) continue;
    eqs.push({ c, deps: [...new Set(c.refs.map((r) => r.e).filter((id) => ents.has(id)))], rows: r.length });
  }
  for (const e of entities) if (e.kind === 'arc') eqs.push({ ent: e.id, deps: [e.id], rows: 1 });
  const m = eqs.reduce((s, q) => s + q.rows, 0);
  const rowOf: number[] = [];
  { let r = 0; for (const q of eqs) { rowOf.push(r); r += q.rows; } }
  const byEnt = new Map<string, number[]>();
  eqs.forEach((q, i) => { for (const id of q.deps) { if (!byEnt.has(id)) byEnt.set(id, []); byEnt.get(id)!.push(i); } });

  const evalEq = (q: Eq): number[] => (q.c ? residuals(ents, q.c) ?? new Array(q.rows).fill(0) : [arcResidual(ents.get(q.ent!)!) ?? 0]);
  const F = () => {
    const f = new Float64Array(m);
    eqs.forEach((q, i) => { const r = evalEq(q); for (let k = 0; k < q.rows; k++) f[rowOf[i] + k] = r[k]; });
    return f;
  };
  const write = (v: Float64Array) => { for (let j = 0; j < n; j++) setParam(varEnt[j], varK[j], v[j]); };
  const jacobian = () => {
    const J = new Float64Array(m * n);
    for (let j = 0; j < n; j++) {
      const list = byEnt.get(varEnt[j].id);
      if (!list) continue;
      const x0 = x[j];
      const h = 1e-6 * Math.max(1, Math.abs(x0));
      setParam(varEnt[j], varK[j], x0 + h);
      const plus = list.map((i) => evalEq(eqs[i]));
      setParam(varEnt[j], varK[j], x0 - h);
      const minus = list.map((i) => evalEq(eqs[i]));
      setParam(varEnt[j], varK[j], x0);
      list.forEach((i, li) => { for (let k = 0; k < eqs[i].rows; k++) J[(rowOf[i] + k) * n + j] = (plus[li][k] - minus[li][k]) / (2 * h); });
    }
    return J;
  };

  const w = new Float64Array(n).fill(1);
  if (opts.keep) for (let j = 0; j < n; j++) if (opts.keep.has(varKey[j])) w[j] = 1e-4;

  const TOL = 1e-8;
  const norm2 = (f: Float64Array) => { let s = 0; for (const v of f) s += v * v; return s; };
  const maxAbs = (f: Float64Array) => { let s = 0; for (const v of f) s = Math.max(s, Math.abs(v)); return s; };
  let f = m ? F() : new Float64Array(0);
  let err = norm2(f);
  let mu = 1e-9;
  for (let iter = 0; iter < 80 && m && maxAbs(f) > TOL; iter++) {
    const J = jacobian();
    // A = J W Jᵀ + μI, solve A y = -f, step = W Jᵀ y  (smallest weighted change)
    const A = new Float64Array(m * m);
    let trace = 0;
    for (let r = 0; r < m; r++) {
      for (let s = r; s < m; s++) {
        let v = 0;
        for (let j = 0; j < n; j++) v += J[r * n + j] * w[j] * J[s * n + j];
        A[r * m + s] = v; A[s * m + r] = v;
      }
      trace += A[r * m + r];
    }
    let improved = false;
    for (let tries = 0; tries < 12; tries++) {
      const damp = mu * (trace / m + 1e-12) + 1e-14;
      const M = A.slice();
      for (let r = 0; r < m; r++) M[r * m + r] += damp;
      const y = solveLinear(M, Array.from(f, (v) => -v), m);
      if (!y) { mu *= 10; continue; }
      const xn = new Float64Array(n);
      for (let j = 0; j < n; j++) {
        let v = 0;
        for (let r = 0; r < m; r++) v += J[r * n + j] * y[r];
        xn[j] = x[j] + w[j] * v;
      }
      write(xn);
      const fn = F();
      const en = norm2(fn);
      if (en < err || maxAbs(fn) <= TOL) {
        x.set(xn); f = fn; err = en;
        mu = Math.max(mu / 10, 1e-12);
        improved = true;
        break;
      }
      write(x);
      mu *= 10;
    }
    if (!improved) break;
  }
  write(x);
  // keep shapes sensible: radii can't go negative
  for (const e of entities) if ('r' in e && (e as any).r < 0) (e as any).r = -(e as any).r;

  const failing: string[] = [];
  eqs.forEach((q, i) => {
    for (let k = 0; k < q.rows; k++) if (Math.abs(f[rowOf[i] + k]) > 1e-6 && q.c) { failing.push(q.c.id); break; }
  });
  const ok = maxAbs(f) <= 1e-6;

  let dof = n;
  const fixed = new Set<string>();
  const fixedPoints = new Set<string>();
  if (opts.analyze) {
    const J = m ? jacobian() : new Float64Array(0);
    const { rank, determined } = analyse(J, m, n);
    dof = n - rank;
    const pointVars = (e: SketchEntity, p: number): number[] => {
      // which variables move point p of entity e
      const base = entityPoints(e)[p];
      const out: number[] = [];
      for (let k = 0; k < paramCount(e); k++) {
        const v0 = getParam(e, k);
        setParam(e, k, v0 + 1e-3);
        const q = entityPoints(e)[p];
        setParam(e, k, v0);
        if (Math.abs(q[0] - base[0]) + Math.abs(q[1] - base[1]) > 1e-9) out.push(k);
      }
      return out;
    };
    for (const e of entities) {
      const o = offset.get(e.id)!;
      let all = true;
      for (let k = 0; k < paramCount(e); k++) if (!determined[o + k]) { all = false; break; }
      if (all) fixed.add(e.id);
      const pts = entityPoints(e);
      for (let p = 0; p < pts.length; p++) {
        if (all || pointVars(e, p).every((k) => determined[o + k])) fixedPoints.add(`${e.id}:${p}`);
      }
    }
  }
  return { entities, ok, failing, dof, fixed, fixedPoints };
}

/** Gaussian elimination with partial pivoting; null if singular. */
function solveLinear(A: Float64Array, b: number[], m: number): number[] | null {
  const M = A, y = b.slice();
  for (let col = 0; col < m; col++) {
    let piv = col, best = Math.abs(M[col * m + col]);
    for (let r = col + 1; r < m; r++) { const v = Math.abs(M[r * m + col]); if (v > best) { best = v; piv = r; } }
    if (best < 1e-300) return null;
    if (piv !== col) {
      for (let k = 0; k < m; k++) { const t = M[col * m + k]; M[col * m + k] = M[piv * m + k]; M[piv * m + k] = t; }
      const t = y[col]; y[col] = y[piv]; y[piv] = t;
    }
    const d = M[col * m + col];
    for (let r = col + 1; r < m; r++) {
      const fct = M[r * m + col] / d;
      if (!fct) continue;
      for (let k = col; k < m; k++) M[r * m + k] -= fct * M[col * m + k];
      y[r] -= fct * y[col];
    }
  }
  for (let r = m - 1; r >= 0; r--) {
    let v = y[r];
    for (let k = r + 1; k < m; k++) v -= M[r * m + k] * y[k];
    y[r] = v / M[r * m + r];
  }
  return y.every(Number.isFinite) ? y : null;
}

/**
 * Rank of the Jacobian, and which variables it pins down completely: a variable is
 * determined when no remaining freedom (null-space direction) can move it.
 */
function analyse(J: Float64Array, m: number, n: number): { rank: number; determined: boolean[] } {
  const R = Float64Array.from(J);
  let scale = 0;
  for (const v of R) scale = Math.max(scale, Math.abs(v));
  const eps = 1e-7 * Math.max(1, scale);
  const pivotCols: number[] = [];
  let row = 0;
  for (let col = 0; col < n && row < m; col++) {
    let piv = row, best = Math.abs(R[row * n + col]);
    for (let r = row + 1; r < m; r++) { const v = Math.abs(R[r * n + col]); if (v > best) { best = v; piv = r; } }
    if (best < eps) continue;
    if (piv !== row) for (let k = 0; k < n; k++) { const t = R[row * n + k]; R[row * n + k] = R[piv * n + k]; R[piv * n + k] = t; }
    const d = R[row * n + col];
    for (let k = 0; k < n; k++) R[row * n + k] /= d;
    for (let r = 0; r < m; r++) {
      if (r === row) continue;
      const fct = R[r * n + col];
      if (!fct) continue;
      for (let k = 0; k < n; k++) R[r * n + k] -= fct * R[row * n + k];
    }
    pivotCols.push(col);
    row++;
  }
  const isPivot = new Array(n).fill(false);
  pivotCols.forEach((c) => (isPivot[c] = true));
  const free: number[] = [];
  for (let j = 0; j < n; j++) if (!isPivot[j]) free.push(j);
  const determined = new Array(n).fill(false);
  pivotCols.forEach((c, r) => {
    determined[c] = free.every((fc) => Math.abs(R[r * n + fc]) < 1e-6);
  });
  return { rank: pivotCols.length, determined };
}

// ---------------------------------------------------------------------------
// direct edits (dragging), before the solver tidies up

/**
 * Move part of an entity the way you'd expect when dragging it — a rectangle corner
 * keeps the opposite corner, a circle's outline changes its size — and return the
 * variables that changed so the solver keeps them.
 */
export function dragRef(e: SketchEntity, ref: SkRef, target: Vec2, delta: Vec2): { entity: SketchEntity; keep: number[] } {
  const out = JSON.parse(JSON.stringify(e)) as SketchEntity;
  const all = Array.from({ length: paramCount(e) }, (_, k) => k);
  const translate = () => {
    for (let k = 0; k < paramCount(out); k++) {
      if (out.kind === 'polyline' || out.kind === 'spline') setParam(out, k, getParam(out, k) + delta[k & 1]);
      else {
        const key = KEYS[out.kind][k];
        if (key.startsWith('x') || key === 'cx') setParam(out, k, getParam(out, k) + delta[0]);
        else if (key.startsWith('y') || key === 'cy') setParam(out, k, getParam(out, k) + delta[1]);
      }
    }
    return { entity: out, keep: all };
  };
  if (ref.s === -1) return translate();
  if (ref.p !== undefined) {
    const p = ref.p;
    switch (out.kind) {
      case 'polyline':
      case 'spline':
        out.points[p] = [target[0], target[1]];
        return { entity: out, keep: [p * 2, p * 2 + 1] };
      case 'rect': {
        if (p === 4) return translate();
        const x2 = out.x + out.w, y2 = out.y + out.h;
        if (p === 0 || p === 3) { out.x = target[0]; out.w = x2 - target[0]; } else out.w = target[0] - out.x;
        if (p === 0 || p === 1) { out.y = target[1]; out.h = y2 - target[1]; } else out.h = target[1] - out.y;
        return { entity: out, keep: all };
      }
      case 'circle':
        return translate();
      case 'polygon': {
        if (p === 0) return translate();
        // corner p sits at rotation + 90° + (p-1)·360/sides
        out.r = Math.hypot(target[0] - out.cx, target[1] - out.cy);
        const a = (Math.atan2(target[1] - out.cy, target[0] - out.cx) * 180) / Math.PI;
        out.rotation = a - 90 - ((p - 1) * 360) / out.sides;
        return { entity: out, keep: [2, 3] };
      }
      case 'slot':
        if (p === 0) { out.x1 = target[0]; out.y1 = target[1]; return { entity: out, keep: [0, 1] }; }
        out.x2 = target[0]; out.y2 = target[1];
        return { entity: out, keep: [2, 3] };
      case 'arc':
        if (p === 0) return translate();
        if (p === 1) { out.x1 = target[0]; out.y1 = target[1]; return { entity: out, keep: [2, 3] }; }
        out.x2 = target[0]; out.y2 = target[1];
        return { entity: out, keep: [4, 5] };
    }
  }
  if (ref.s !== undefined) {
    const s = ref.s;
    if (out.kind === 'polyline') {
      const i = s, j = (s + 1) % out.points.length;
      for (const q of [i, j]) out.points[q] = [out.points[q][0] + delta[0], out.points[q][1] + delta[1]];
      return { entity: out, keep: [i * 2, i * 2 + 1, j * 2, j * 2 + 1] };
    }
    if (out.kind === 'rect') {
      if (s === 0) { out.y += delta[1]; out.h -= delta[1]; return { entity: out, keep: [1, 3] }; }
      if (s === 1) { out.w += delta[0]; return { entity: out, keep: [2] }; }
      if (s === 2) { out.h += delta[1]; return { entity: out, keep: [3] }; }
      out.x += delta[0]; out.w -= delta[0];
      return { entity: out, keep: [0, 2] };
    }
    return translate();
  }
  // whole entity: dragging a circle or arc outline resizes it
  if (out.kind === 'circle') {
    out.r = Math.max(1e-3, Math.hypot(target[0] - out.cx, target[1] - out.cy));
    return { entity: out, keep: [2] };
  }
  if (out.kind === 'arc') {
    const r0 = Math.hypot(out.x1 - out.cx, out.y1 - out.cy) || 1;
    const k = Math.max(1e-3, Math.hypot(target[0] - out.cx, target[1] - out.cy)) / r0;
    out.x1 = out.cx + (out.x1 - out.cx) * k; out.y1 = out.cy + (out.y1 - out.cy) * k;
    out.x2 = out.cx + (out.x2 - out.cx) * k; out.y2 = out.cy + (out.y2 - out.cy) * k;
    return { entity: out, keep: [2, 3, 4, 5] };
  }
  return translate();
}

/** Memoised analysis of a sketch for display: what's fully constrained, what fails. */
let lastKey = '';
let lastInfo: SolveResult | null = null;
export function analyzeSketch(entities: SketchEntity[], constraints: SketchConstraint[]): SolveResult {
  const key = JSON.stringify([entities, constraints]);
  if (key !== lastKey || !lastInfo) {
    lastInfo = solveSketch(entities, constraints, { analyze: true });
    // analysis runs on the stored geometry; report failures against that, not the re-solved copy
    lastKey = key;
  }
  return lastInfo;
}

/** Turn per-entity parameter indices into solver keep keys. */
export const keepKeys = (id: string, ks: number[]) => ks.map((k) => `${id}:${k}`);

/** Drop constraints that point at entities, points or segments that no longer exist. */
export function liveConstraints(entities: SketchEntity[], cs: SketchConstraint[]): SketchConstraint[] {
  const ents: Ents = new Map(entities.map((e) => [e.id, e]));
  return cs.filter((c) => residuals(ents, c) !== null);
}
