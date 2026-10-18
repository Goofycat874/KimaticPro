// DXF in and out for sketches: bring in 2D outlines from other CAD, Inkscape or
// laser-cutting files, and send sketches out to laser cutters and CNC.

import { uid, type SketchEntity, type Vec2 } from './types';
import { arcInfo, entityOutline } from './sketch';
import { sheetToDXF, type Prim } from './drawingSheet';

interface Raw { type: string; codes: [number, string][] }

const num = (r: Raw, code: number, fallback = 0) => {
  const c = r.codes.find((x) => x[0] === code);
  return c ? parseFloat(c[1]) : fallback;
};
const all = (r: Raw, code: number) => r.codes.filter((x) => x[0] === code).map((x) => parseFloat(x[1]));
const str = (r: Raw, code: number) => r.codes.find((x) => x[0] === code)?.[1] ?? '';

const UNIT_MM: Record<number, number> = { 0: 1, 1: 25.4, 2: 304.8, 4: 1, 5: 10, 6: 1000, 8: 0.0000254, 9: 0.0254, 10: 914.4 };

/** Split a DXF file into its sections' entities. */
function readDXF(text: string) {
  const lines = text.split(/\r?\n/);
  const pairs: [number, string][] = [];
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = parseInt(lines[i].trim(), 10);
    if (Number.isNaN(code)) { i--; continue; }
    pairs.push([code, lines[i + 1].trim()]);
  }
  let units = 0;
  const entities: Raw[] = [];
  const blocks = new Map<string, Raw[]>();
  let section = '';
  let block: { name: string; items: Raw[] } | null = null;
  let cur: Raw | null = null;
  const flush = () => {
    if (!cur) return;
    if (section === 'ENTITIES') entities.push(cur);
    else if (section === 'BLOCKS' && block && cur.type !== 'BLOCK' && cur.type !== 'ENDBLK') block.items.push(cur);
    cur = null;
  };
  for (let i = 0; i < pairs.length; i++) {
    const [code, value] = pairs[i];
    if (code === 0) {
      flush();
      if (value === 'SECTION') { section = pairs[i + 1]?.[1] ?? ''; i++; continue; }
      if (value === 'ENDSEC') { section = ''; continue; }
      if (value === 'EOF') break;
      if (section === 'BLOCKS' && value === 'BLOCK') { block = { name: '', items: [] }; cur = { type: 'BLOCK', codes: [] }; continue; }
      if (section === 'BLOCKS' && value === 'ENDBLK') { if (block) blocks.set(block.name, block.items); block = null; continue; }
      cur = { type: value, codes: [] };
      continue;
    }
    if (section === 'HEADER' && code === 9 && value === '$INSUNITS') { units = parseInt(pairs[i + 1]?.[1] ?? '0', 10); i++; continue; }
    if (cur) {
      cur.codes.push([code, value]);
      if (cur.type === 'BLOCK' && code === 2 && block) block.name = value;
    }
  }
  flush();
  return { units, entities, blocks };
}

/** Points along a NURBS curve (de Boor), for DXF splines given by control points. */
function nurbs(ctrl: Vec2[], weights: number[], knots: number[], degree: number, samples: number): Vec2[] {
  const n = ctrl.length;
  const w = weights.length === n ? weights : ctrl.map(() => 1);
  const t0 = knots[degree], t1 = knots[n];
  const out: Vec2[] = [];
  for (let s = 0; s <= samples; s++) {
    let t = t0 + ((t1 - t0) * s) / samples;
    if (s === samples) t = t1 - 1e-9 * (t1 - t0);
    let k = degree;
    while (k < n - 1 && t >= knots[k + 1]) k++;
    const d = Array.from({ length: degree + 1 }, (_, j) => {
      const i = k - degree + j;
      return [ctrl[i][0] * w[i], ctrl[i][1] * w[i], w[i]];
    });
    for (let r = 1; r <= degree; r++) {
      for (let j = degree; j >= r; j--) {
        const i = k - degree + j;
        const den = knots[i + degree - r + 1] - knots[i];
        const a = den ? (t - knots[i]) / den : 0;
        for (let q = 0; q < 3; q++) d[j][q] = (1 - a) * d[j - 1][q] + a * d[j][q];
      }
    }
    const [x, y, ww] = d[degree];
    out.push([x / ww, y / ww]);
  }
  return out;
}

export interface DxfImport { entities: SketchEntity[]; skipped: Record<string, number>; scale: number }

/** Turn the 2D geometry in a DXF file into sketch entities (in millimetres). */
export function parseDXF(text: string): DxfImport {
  const { units, entities, blocks } = readDXF(text);
  const scale = UNIT_MM[units] ?? 1;
  const out: SketchEntity[] = [];
  const lines: [Vec2, Vec2][] = [];
  const skipped: Record<string, number> = {};
  type Xf = (p: Vec2) => Vec2;

  const arcFrom = (c: Vec2, r: number, a0: number, a1: number, xf: Xf, flip: boolean) => {
    // flip: entity drawn with its normal pointing down (-Z), which mirrors it
    let [s0, s1] = flip ? [Math.PI - a1, Math.PI - a0] : [a0, a1];
    const cc: Vec2 = flip ? [-c[0], c[1]] : c;
    const p = (a: number): Vec2 => xf([cc[0] + Math.cos(a) * r, cc[1] + Math.sin(a) * r]);
    const C = xf(cc), P1 = p(s0);
    // a mirroring transform (negative block scale) reverses the direction
    const mid = p((s0 + (s1 < s0 ? s1 + Math.PI * 2 : s1)) / 2);
    const cross = (P1[0] - C[0]) * (mid[1] - C[1]) - (P1[1] - C[1]) * (mid[0] - C[0]);
    if (cross < 0) { const t = s0; s0 = s1; s1 = t; }
    const A = p(s0), B = p(s1);
    out.push({ id: uid('k'), kind: 'arc', cx: C[0], cy: C[1], x1: A[0], y1: A[1], x2: B[0], y2: B[1] });
  };

  const bulgeSegs = (pts: Vec2[], bulges: number[], closed: boolean, xf: Xf) => {
    const n = pts.length;
    let run: Vec2[] = [xf(pts[0])];
    const flushRun = (isClosed = false) => {
      if (run.length >= 2) out.push({ id: uid('k'), kind: 'polyline', points: run, closed: isClosed });
    };
    const segs = closed ? n : n - 1;
    const allStraight = bulges.every((b) => !b);
    if (allStraight) {
      const p = pts.map(xf);
      out.push({ id: uid('k'), kind: 'polyline', points: p, closed: closed && n > 2 });
      return;
    }
    for (let i = 0; i < segs; i++) {
      const a = pts[i], b = pts[(i + 1) % n];
      const bulge = bulges[i] ?? 0;
      if (!bulge) { run.push(xf(b)); continue; }
      flushRun();
      const th = 4 * Math.atan(bulge);
      const dx = b[0] - a[0], dy = b[1] - a[1];
      const c = Math.hypot(dx, dy);
      const h = (c / 2) / Math.tan(th / 2);
      const cen: Vec2 = [(a[0] + b[0]) / 2 - (dy / c) * h, (a[1] + b[1]) / 2 + (dx / c) * h];
      const r = Math.abs(c / (2 * Math.sin(th / 2)));
      const ang = (p: Vec2) => Math.atan2(p[1] - cen[1], p[0] - cen[0]);
      if (bulge > 0) arcFrom(cen, r, ang(a), ang(b), xf, false);
      else arcFrom(cen, r, ang(b), ang(a), xf, false);
      run = [xf(b)];
    }
    flushRun();
  };

  const add = (r: Raw, xf: Xf, depth = 0) => {
    const flip = num(r, 230, 1) < 0;
    const fx = (p: Vec2): Vec2 => (flip ? [-p[0], p[1]] : p);
    switch (r.type) {
      case 'LINE':
        lines.push([xf(fx([num(r, 10), num(r, 20)])), xf(fx([num(r, 11), num(r, 21)]))]);
        break;
      case 'CIRCLE': {
        const c = xf(fx([num(r, 10), num(r, 20)]));
        const e = xf(fx([num(r, 10) + num(r, 40), num(r, 20)]));
        out.push({ id: uid('k'), kind: 'circle', cx: c[0], cy: c[1], r: Math.hypot(e[0] - c[0], e[1] - c[1]) });
        break;
      }
      case 'ARC':
        arcFrom([num(r, 10), num(r, 20)], num(r, 40), (num(r, 50) * Math.PI) / 180, (num(r, 51) * Math.PI) / 180, xf, flip);
        break;
      case 'LWPOLYLINE': {
        const xs = all(r, 10), ys = all(r, 20);
        const pts: Vec2[] = xs.map((x, i) => fx([x, ys[i]]));
        // bulge (42) belongs to the vertex before it
        const bulges: number[] = new Array(pts.length).fill(0);
        let vi = -1;
        for (const [code, v] of r.codes) { if (code === 10) vi++; else if (code === 42 && vi >= 0) bulges[vi] = parseFloat(v); }
        if (pts.length >= 2) bulgeSegs(pts, flip ? bulges.map((b) => -b) : bulges, (num(r, 70) & 1) === 1, xf);
        break;
      }
      case 'POLYLINE': {
        const v = (r as any).vertices as Raw[] | undefined;
        if (!v || (num(r, 70) & (16 | 64))) { skipped.POLYLINE = (skipped.POLYLINE ?? 0) + 1; break; }
        const pts = v.map((x) => fx([num(x, 10), num(x, 20)]));
        if (pts.length >= 2) bulgeSegs(pts, v.map((x) => (flip ? -1 : 1) * num(x, 42)), (num(r, 70) & 1) === 1, xf);
        break;
      }
      case 'SPLINE': {
        const deg = num(r, 71, 3);
        const knots = all(r, 40), weights = all(r, 41);
        const cx = all(r, 10), cy = all(r, 20), fxs = all(r, 11), fys = all(r, 21);
        const closed = (num(r, 70) & 1) === 1;
        let pts: Vec2[];
        if (cx.length > deg && knots.length === cx.length + deg + 1) {
          pts = nurbs(cx.map((x, i) => [x, cy[i]]), weights, knots, deg, Math.max(32, cx.length * 8));
        } else if (fxs.length >= 2) {
          const fit = fxs.map((x, i) => xf(fx([x, fys[i]])));
          out.push({ id: uid('k'), kind: 'spline', points: fit, closed });
          break;
        } else { skipped.SPLINE = (skipped.SPLINE ?? 0) + 1; break; }
        const p = pts.map((q) => xf(fx(q)));
        if (closed && Math.hypot(p[0][0] - p[p.length - 1][0], p[0][1] - p[p.length - 1][1]) < 1e-6) p.pop();
        out.push({ id: uid('k'), kind: 'polyline', points: p, closed });
        break;
      }
      case 'ELLIPSE': {
        const c: Vec2 = [num(r, 10), num(r, 20)], maj: Vec2 = [num(r, 11), num(r, 21)];
        const ratio = num(r, 40, 1);
        let t0 = num(r, 41, 0), t1 = num(r, 42, Math.PI * 2);
        if (t1 <= t0) t1 += Math.PI * 2;
        const full = t1 - t0 >= Math.PI * 2 - 1e-6;
        const n = Math.max(24, Math.ceil(((t1 - t0) / (Math.PI * 2)) * 96));
        const pts: Vec2[] = [];
        for (let i = 0; i < (full ? n : n + 1); i++) {
          const t = t0 + ((t1 - t0) * i) / n;
          pts.push(xf(fx([c[0] + maj[0] * Math.cos(t) - maj[1] * ratio * Math.sin(t), c[1] + maj[1] * Math.cos(t) + maj[0] * ratio * Math.sin(t)])));
        }
        out.push({ id: uid('k'), kind: 'polyline', points: pts, closed: full });
        break;
      }
      case 'INSERT': {
        const items = blocks.get(str(r, 2));
        if (!items || depth > 4) break;
        const at: Vec2 = [num(r, 10), num(r, 20)], sx = num(r, 41, 1), sy = num(r, 42, 1);
        const rot = (num(r, 50) * Math.PI) / 180, c = Math.cos(rot), s = Math.sin(rot);
        const inner: Xf = (p) => xf(fx([at[0] + (p[0] * sx) * c - (p[1] * sy) * s, at[1] + (p[0] * sx) * s + (p[1] * sy) * c]));
        for (const it of attachVertices(items)) add(it, inner, depth + 1);
        break;
      }
      case 'TEXT': case 'MTEXT': case 'DIMENSION': case 'HATCH': case 'POINT': case 'ATTRIB': case 'ATTDEF': case 'VIEWPORT': case 'SEQEND': case 'VERTEX':
        break;
      default:
        skipped[r.type] = (skipped[r.type] ?? 0) + 1;
    }
  };

  const toMM: Xf = (p) => [p[0] * scale, p[1] * scale];
  for (const r of attachVertices(entities)) add(r, toMM);
  out.push(...joinLines(lines));
  // drop float noise from unit conversion (12.699999999999996 → 12.7)
  const clean = (v: any): any => (typeof v === 'number' ? Math.round(v * 1e9) / 1e9 : Array.isArray(v) ? v.map(clean) : v);
  const cleaned = out.map((e) => Object.fromEntries(Object.entries(e).map(([k, v]) => [k, clean(v)])) as SketchEntity);
  return { entities: cleaned, skipped, scale };
}

/** Old-style POLYLINEs list their points as VERTEX entities that follow; tuck them in. */
function attachVertices(list: Raw[]): Raw[] {
  const out: Raw[] = [];
  let poly: (Raw & { vertices?: Raw[] }) | null = null;
  for (const r of list) {
    if (r.type === 'POLYLINE') { poly = { ...r, vertices: [] }; out.push(poly); continue; }
    if (r.type === 'VERTEX' && poly) { poly.vertices!.push(r); continue; }
    if (r.type === 'SEQEND') { poly = null; continue; }
    out.push(r);
  }
  return out;
}

/** Join loose LINEs that meet end to end into polylines (closed where they loop). */
function joinLines(lines: [Vec2, Vec2][]): SketchEntity[] {
  const key = (p: Vec2) => `${Math.round(p[0] * 1e5)},${Math.round(p[1] * 1e5)}`;
  const at = new Map<string, number[]>();
  lines.forEach(([a, b], i) => {
    if (Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-9) return;
    for (const p of [a, b]) { const k = key(p); if (!at.has(k)) at.set(k, []); at.get(k)!.push(i); }
  });
  const used = new Uint8Array(lines.length);
  const out: SketchEntity[] = [];
  const other = (i: number, p: Vec2): Vec2 => (key(lines[i][0]) === key(p) ? lines[i][1] : lines[i][0]);
  const nextFrom = (p: Vec2) => {
    const list = at.get(key(p)) ?? [];
    // only follow unambiguous joins (exactly two lines meet)
    if (list.length !== 2) return -1;
    return list.find((i) => !used[i]) ?? -1;
  };
  for (let i = 0; i < lines.length; i++) {
    if (used[i] || Math.hypot(lines[i][0][0] - lines[i][1][0], lines[i][0][1] - lines[i][1][1]) < 1e-9) continue;
    used[i] = 1;
    const pts: Vec2[] = [lines[i][0], lines[i][1]];
    // grow forwards, then backwards
    for (let j = nextFrom(pts[pts.length - 1]); j >= 0; j = nextFrom(pts[pts.length - 1])) { used[j] = 1; pts.push(other(j, pts[pts.length - 1])); }
    for (let j = nextFrom(pts[0]); j >= 0; j = nextFrom(pts[0])) { used[j] = 1; pts.unshift(other(j, pts[0])); }
    const closed = pts.length > 3 && key(pts[0]) === key(pts[pts.length - 1]);
    if (closed) pts.pop();
    out.push({ id: uid('k'), kind: 'polyline', points: pts, closed });
  }
  return out;
}

/** Sketch entities as a DXF (millimetres, 1:1). Construction lines go on their own layer. */
export function sketchToDXF(entities: SketchEntity[]): string {
  const prims: Prim[] = [];
  for (const e of entities) {
    const layer = e.construction ? 'center' : 'visible';
    if (e.kind === 'circle') prims.push({ k: 'arc', c: [e.cx, e.cy], r: e.r, a0: 0, a1: Math.PI * 2, layer });
    else if (e.kind === 'arc') {
      const a = arcInfo(e);
      prims.push({ k: 'arc', c: [e.cx, e.cy], r: a.r, a0: a.a0, a1: a.a0 + a.sweep, layer });
    } else if (e.kind === 'slot') {
      const dx = e.x2 - e.x1, dy = e.y2 - e.y1, L = Math.hypot(dx, dy) || 1;
      const nx = (-dy / L) * e.r, ny = (dx / L) * e.r, ang = Math.atan2(dy, dx);
      prims.push({ k: 'path', pts: [[e.x1 + nx, e.y1 + ny], [e.x2 + nx, e.y2 + ny]], layer });
      prims.push({ k: 'path', pts: [[e.x1 - nx, e.y1 - ny], [e.x2 - nx, e.y2 - ny]], layer });
      prims.push({ k: 'arc', c: [e.x2, e.y2], r: e.r, a0: ang - Math.PI / 2, a1: ang + Math.PI / 2, layer });
      prims.push({ k: 'arc', c: [e.x1, e.y1], r: e.r, a0: ang + Math.PI / 2, a1: ang + Math.PI * 1.5, layer });
    } else {
      const o = entityOutline(e, 96);
      prims.push({ k: 'path', pts: o.points, closed: o.closed, layer });
    }
  }
  return sheetToDXF({ w: 0, h: 0, prims, scale: 1, fits: true });
}
