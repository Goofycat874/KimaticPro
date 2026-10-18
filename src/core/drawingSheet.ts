// 2D technical drawings: lay projected views out on a sheet with dimensions and a
// title block, then write the sheet as SVG, PDF or DXF. Pure functions — the
// projections themselves come from the precise geometry engine.

import type { Vec2 } from './types';

export type ViewName = 'front' | 'back' | 'top' | 'bottom' | 'right' | 'left' | 'iso';

/** A projected curve: a straight line, an exact anticlockwise arc (radians), or a polyline. */
export type DCurve =
  | { t: 'L'; a: Vec2; b: Vec2 }
  | { t: 'A'; c: Vec2; r: number; a0: number; a1: number }
  | { t: 'P'; pts: Vec2[] };

export interface ProjView { visible: DCurve[]; hidden: DCurve[]; box: [number, number, number, number] | null }

export type Layer = 'visible' | 'hidden' | 'center' | 'dim' | 'frame' | 'thin';

export type Prim =
  | { k: 'path'; pts: Vec2[]; layer: Layer; closed?: boolean }
  | { k: 'arc'; c: Vec2; r: number; a0: number; a1: number; layer: Layer }
  | { k: 'fill'; pts: Vec2[]; layer: Layer }
  | { k: 'text'; at: Vec2; text: string; size: number; anchor: 'start' | 'middle' | 'end'; rot?: number; layer: Layer; bold?: boolean };

const STYLE: Record<Layer, { w: number; dash?: number[]; grey?: boolean }> = {
  visible: { w: 0.35 },
  hidden: { w: 0.2, dash: [2, 1], grey: true },
  center: { w: 0.13, dash: [6, 1, 1, 1], grey: true },
  dim: { w: 0.18 },
  frame: { w: 0.5 },
  thin: { w: 0.25 },
};

export type SheetSize = 'A4' | 'A3' | 'A2' | 'Letter' | 'Tabloid';
export const SHEETS: Record<SheetSize, [number, number]> = {
  A4: [297, 210], A3: [420, 297], A2: [594, 420], Letter: [279.4, 215.9], Tabloid: [431.8, 279.4],
};

export interface SheetOptions {
  size: SheetSize;
  angle: 'third' | 'first';
  views: { front: boolean; top: boolean; right: boolean; iso: boolean };
  hidden: boolean;
  dims: boolean;
  centerMarks: boolean;
  scale: number | 'auto';
  title: string;
  author: string;
  material: string;
  date: string;
  /** Border and title block (off for 1:1 DXF for laser cutters and CAM). */
  frame?: boolean;
}

export interface Sheet { w: number; h: number; prims: Prim[]; scale: number; fits: boolean }

const SCALES = [20, 10, 5, 4, 2, 1, 1 / 2, 1 / 2.5, 1 / 4, 1 / 5, 1 / 10, 1 / 20, 1 / 25, 1 / 50, 1 / 100];

export const scaleLabel = (s: number) => (s >= 1 ? `${+s.toFixed(2)}:1` : `1:${+(1 / s).toFixed(2)}`);
export const fmtNum = (v: number) => (Math.round(v * 100) / 100).toString();

const TAU = Math.PI * 2;

// ---------------------------------------------------------------------------
// layout

export function layoutSheet(views: Record<string, ProjView>, o: SheetOptions): Sheet {
  const frame = o.frame !== false;
  const [W, H] = frame ? SHEETS[o.size] : [0, 0];
  const M = 10, TBW = 170, TBH = 32;
  const prims: Prim[] = [];
  const has = (k: 'front' | 'top' | 'right' | 'iso') => o.views[k] && !!views[k]?.box;
  const size = (k: string) => { const b = views[k].box!; return [b[2] - b[0], b[3] - b[1]]; };
  const F = has('front') ? size('front') : [0, 0];
  const T = has('top') ? size('top') : [0, 0];
  const Rt = has('right') ? size('right') : [0, 0];
  const I = has('iso') ? size('iso') : [0, 0];
  const G = o.dims ? 26 : 14;
  const third = o.angle === 'third';
  // a 2×2 grid: front with top above/below it and right beside it; iso in the free corner
  const colFront = F[0], colSide = Math.max(Rt[0], I[0]);
  const rowFront = F[1], rowOther = Math.max(T[1], I[1]);
  const cols = colSide > 0 ? 2 : 1, rows = rowOther > 0 ? 2 : 1;
  const needW = (s: number) => s * (colFront + colSide) + G * (cols - 1);
  const needH = (s: number) => s * (rowFront + rowOther) + G * (rows - 1);

  // leave room for the dimensions and view names that sit left of and below the views
  const area = frame
    ? { x0: M + (o.dims ? 24 : 8), y0: M + TBH + (o.dims ? 32 : 16), x1: W - M - 8, y1: H - M - 8 }
    : { x0: 0, y0: 0, x1: 1e9, y1: 1e9 };
  const aw = area.x1 - area.x0, ah = area.y1 - area.y0;
  let s = typeof o.scale === 'number' ? o.scale : 1;
  let fits = true;
  if (o.scale === 'auto' && frame) {
    const ok = SCALES.find((c) => needW(c) <= aw && needH(c) <= ah);
    s = ok ?? SCALES[SCALES.length - 1];
    fits = !!ok;
  } else if (frame) fits = needW(s) <= aw && needH(s) <= ah;

  // cell origins (bottom-left), centring the whole arrangement in the area
  const totalW = needW(s), totalH = needH(s);
  const ox = frame ? area.x0 + (aw - totalW) / 2 : 0;
  const oy = frame ? area.y0 + (ah - totalH) / 2 : 0;
  const cw = [colFront * s, colSide * s];
  const rh = [rowFront * s, rowOther * s];
  // third angle: [front | right] on the bottom row, [top | iso] above. First angle mirrors both ways.
  const gc = cols > 1 ? G : 0, gr = rows > 1 ? G : 0;
  const colX = (c: 'front' | 'side') => (third === (c === 'front') ? ox : ox + (third ? cw[0] : cw[1]) + gc);
  const rowY = (r: 'front' | 'other') => (third === (r === 'front') ? oy : oy + (third ? rh[0] : rh[1]) + gr);
  const at: Record<string, Vec2> = {};
  if (has('front')) at.front = [colX('front'), rowY('front')];
  if (has('top')) at.top = [colX('front'), rowY('other')];
  if (has('right')) at.right = [colX('side'), rowY('front')];
  if (has('iso')) at.iso = [colX('side') + (cw[1] - I[0] * s) / 2, rowY('other') + (rh[1] - I[1] * s) / 2];

  const placed: { name: string; box: [number, number, number, number]; map: (p: Vec2) => Vec2 }[] = [];
  for (const name of ['front', 'top', 'right', 'iso'] as const) {
    if (!at[name]) continue;
    const v = views[name];
    const b = v.box!;
    const [px, py] = at[name];
    const map = (p: Vec2): Vec2 => [px + (p[0] - b[0]) * s, py + (p[1] - b[1]) * s];
    placed.push({ name, box: [px, py, px + (b[2] - b[0]) * s, py + (b[3] - b[1]) * s], map });
    const iso = name === 'iso';
    for (const c of v.visible) prims.push(...curvePrims(c, map, s, 'visible'));
    if (o.hidden && !iso) for (const c of v.hidden) prims.push(...curvePrims(c, map, s, 'hidden'));
    if (o.centerMarks && !iso) {
      for (const c of uniqueCircles([...v.visible, ...(o.hidden ? v.hidden : [])])) {
        const r = c.r * s;
        if (r < 1.2) continue;
        const [cx, cy] = map(c.c);
        const e = r + 2;
        prims.push({ k: 'path', pts: [[cx - e, cy], [cx + e, cy]], layer: 'center' }, { k: 'path', pts: [[cx, cy - e], [cx, cy + e]], layer: 'center' });
      }
    }
  }

  // dimensions: overall sizes plus hole diameters
  if (o.dims) {
    const byName = Object.fromEntries(placed.map((p) => [p.name, p]));
    const f = byName.front, t = byName.top, r = byName.right;
    if (f) {
      prims.push(...linearDim([f.box[0], f.box[1]], [f.box[2], f.box[1]], [0, -1], 9, fmtNum(F[0])));
      prims.push(...linearDim([f.box[0], f.box[1]], [f.box[0], f.box[3]], [-1, 0], 9, fmtNum(F[1])));
    }
    if (t) prims.push(...linearDim([t.box[0], t.box[1]], [t.box[0], t.box[3]], [-1, 0], 9, fmtNum(T[1])));
    else if (r) prims.push(...linearDim([r.box[0], r.box[1]], [r.box[2], r.box[1]], [0, -1], 9, fmtNum(Rt[0])));
    const done = new Set<string>();
    const taken: [number, number, number, number][] = [];
    let count = 0;
    for (const p of [f, t, r]) {
      if (!p) continue;
      const circles = uniqueCircles(views[p.name].visible);
      const groups = new Map<string, { c: Vec2; r: number }[]>();
      for (const c of circles) {
        const k = c.r.toFixed(2);
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k)!.push(c);
      }
      for (const [k, list] of groups) {
        if (done.has(k) || count >= 8 || list[0].r * s < 1) continue;
        done.add(k);
        count++;
        const c = list.reduce((a, b) => (b.c[0] + b.c[1] > a.c[0] + a.c[1] ? b : a));
        const text = `${list.length > 1 ? `${list.length}× ` : ''}Ø${fmtNum(c.r * 2)}`;
        prims.push(...diameterCallout(p.map(c.c), c.r * s, text, taken));
      }
    }
  }

  // view names
  for (const p of placed) {
    const label = { front: 'FRONT', top: 'TOP', right: 'RIGHT', iso: 'ISOMETRIC' }[p.name]!;
    const below = o.dims && (p.name === 'front' || (p.name === 'right' && !has('top'))) ? 22 : 7;
    prims.push({ k: 'text', at: [(p.box[0] + p.box[2]) / 2, p.box[1] - below], text: label, size: 3, anchor: 'middle', layer: 'thin', bold: true });
  }

  if (frame) prims.push(...frameAndTitle(W, H, M, TBW, TBH, o, s));
  return { w: W, h: H, prims, scale: s, fits };
}

function curvePrims(c: DCurve, map: (p: Vec2) => Vec2, s: number, layer: Layer): Prim[] {
  if (c.t === 'L') return [{ k: 'path', pts: [map(c.a), map(c.b)], layer }];
  if (c.t === 'P') return [{ k: 'path', pts: c.pts.map(map), layer }];
  return [{ k: 'arc', c: map(c.c), r: c.r * s, a0: c.a0, a1: c.a1, layer }];
}

/** Full circles, without the duplicates projections sometimes produce. */
function uniqueCircles(cs: DCurve[]): { c: Vec2; r: number }[] {
  const out: { c: Vec2; r: number }[] = [];
  for (const c of cs) {
    if (c.t !== 'A' || c.a1 - c.a0 < TAU - 1e-6) continue;
    if (out.some((o) => Math.abs(o.r - c.r) < 1e-4 && Math.hypot(o.c[0] - c.c[0], o.c[1] - c.c[1]) < 1e-4)) continue;
    out.push({ c: c.c, r: c.r });
  }
  return out;
}

function arrowHead(tip: Vec2, dir: Vec2): Prim {
  const L = 2.8, Wd = 0.9;
  const bx = tip[0] - dir[0] * L, by = tip[1] - dir[1] * L;
  return { k: 'fill', pts: [tip, [bx - dir[1] * Wd, by + dir[0] * Wd], [bx + dir[1] * Wd, by - dir[0] * Wd]], layer: 'dim' };
}

/** A linear dimension between two sheet points, offset along unit `n`. */
function linearDim(a: Vec2, b: Vec2, n: Vec2, off: number, text: string): Prim[] {
  const A: Vec2 = [a[0] + n[0] * off, a[1] + n[1] * off], B: Vec2 = [b[0] + n[0] * off, b[1] + n[1] * off];
  const len = Math.hypot(B[0] - A[0], B[1] - A[1]) || 1;
  const u: Vec2 = [(B[0] - A[0]) / len, (B[1] - A[1]) / len];
  const out: Prim[] = [
    { k: 'path', pts: [[a[0] + n[0] * 1, a[1] + n[1] * 1], [a[0] + n[0] * (off + 2), a[1] + n[1] * (off + 2)]], layer: 'dim' },
    { k: 'path', pts: [[b[0] + n[0] * 1, b[1] + n[1] * 1], [b[0] + n[0] * (off + 2), b[1] + n[1] * (off + 2)]], layer: 'dim' },
    { k: 'path', pts: [A, B], layer: 'dim' },
    arrowHead(A, [-u[0], -u[1]]), arrowHead(B, u),
  ];
  const vertical = Math.abs(u[1]) > Math.abs(u[0]);
  // text sits on the far side of the line from the part
  const mid: Vec2 = [(A[0] + B[0]) / 2 + n[0] * 1.2, (A[1] + B[1]) / 2 + n[1] * 1.2];
  out.push(vertical
    ? { k: 'text', at: [mid[0] + (n[0] < 0 ? -0.2 : 3), mid[1]], text, size: 3.2, anchor: 'middle', rot: 90, layer: 'dim' }
    : { k: 'text', at: [mid[0], mid[1] + (n[1] < 0 ? -3.4 : 0.4)], text, size: 3.2, anchor: 'middle', layer: 'dim' });
  return out;
}

/** Leader + "Ø10" label, turned to the first angle whose label doesn't collide with earlier ones. */
function diameterCallout(c: Vec2, r: number, text: string, taken: [number, number, number, number][]): Prim[] {
  const tw = textWidth(text, 3.2) + 1;
  const place = (deg: number) => {
    const a = (deg * Math.PI) / 180;
    const d: Vec2 = [Math.cos(a), Math.sin(a)];
    const edge: Vec2 = [c[0] + d[0] * r, c[1] + d[1] * r];
    const knee: Vec2 = [edge[0] + d[0] * 7, edge[1] + d[1] * 7];
    const right = d[0] >= 0;
    const box: [number, number, number, number] = right ? [knee[0], knee[1] - 1, knee[0] + tw, knee[1] + 4.5] : [knee[0] - tw, knee[1] - 1, knee[0], knee[1] + 4.5];
    return { d, edge, knee, right, box };
  };
  const hit = (b: [number, number, number, number]) => taken.some((t) => b[0] < t[2] && b[2] > t[0] && b[1] < t[3] && b[3] > t[1]);
  let pl = place(45);
  for (const deg of [45, 70, 20, 135, 110, 160, -20, -45]) { const q = place(deg); if (!hit(q.box)) { pl = q; break; } }
  taken.push(pl.box);
  const { d, edge, knee } = pl;
  const end: Vec2 = [knee[0] + (pl.right ? tw : -tw), knee[1]];
  if (!pl.right) {
    return [
      { k: 'path', pts: [edge, knee, end], layer: 'dim' },
      arrowHead(edge, [-d[0], -d[1]]),
      { k: 'text', at: [knee[0] - 0.5, knee[1] + 0.8], text, size: 3.2, anchor: 'end', layer: 'dim' },
    ];
  }
  return [
    { k: 'path', pts: [edge, knee, end], layer: 'dim' },
    arrowHead(edge, [-d[0], -d[1]]),
    { k: 'text', at: [knee[0] + 0.5, knee[1] + 0.8], text, size: 3.2, anchor: 'start', layer: 'dim' },
  ];
}

function rect(x0: number, y0: number, x1: number, y1: number, layer: Layer): Prim {
  return { k: 'path', pts: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]], closed: true, layer };
}

function frameAndTitle(W: number, H: number, M: number, TBW: number, TBH: number, o: SheetOptions, s: number): Prim[] {
  const out: Prim[] = [rect(M, M, W - M, H - M, 'frame')];
  const x0 = W - M - TBW, y0 = M, x1 = W - M, y1 = M + TBH;
  out.push(rect(x0, y0, x1, y1, 'frame'));
  // rows: title (12) on top, then two rows of 10
  const r1 = y0 + 10, r2 = y0 + 20;
  out.push({ k: 'path', pts: [[x0, r2], [x1, r2]], layer: 'thin' }, { k: 'path', pts: [[x0, r1], [x1, r1]], layer: 'thin' });
  const symX = x1 - 44;
  out.push({ k: 'path', pts: [[symX, r2], [symX, y1]], layer: 'thin' });
  const cell = (cx0: number, cy0: number, cx1: number, label: string, value: string, divider = true) => {
    if (divider) out.push({ k: 'path', pts: [[cx1, cy0], [cx1, cy0 + 10]], layer: 'thin' });
    out.push({ k: 'text', at: [cx0 + 1.5, cy0 + 7.2], text: label, size: 1.8, anchor: 'start', layer: 'thin' });
    out.push({ k: 'text', at: [cx0 + 1.5, cy0 + 2.2], text: value, size: 3, anchor: 'start', layer: 'thin' });
  };
  cell(x0, r1, x0 + 60, 'DRAWN BY', o.author || '—');
  cell(x0 + 60, r1, x0 + 100, 'DATE', o.date);
  cell(x0 + 100, r1, x1, 'MATERIAL', o.material || '—', false);
  cell(x0, y0, x0 + 34, 'SCALE', scaleLabel(s));
  cell(x0 + 34, y0, x0 + 60, 'UNITS', 'mm');
  cell(x0 + 60, y0, x0 + 100, 'SHEET', `${o.size} · 1/1`);
  out.push({ k: 'text', at: [x0 + 102, y0 + 7.2], text: 'MADE WITH', size: 1.8, anchor: 'start', layer: 'thin' });
  out.push({ k: 'text', at: [x0 + 102, y0 + 2.2], text: 'KimaticPro', size: 3.2, anchor: 'start', layer: 'thin', bold: true });
  out.push({ k: 'text', at: [x0 + 2, r2 + 3.6], text: o.title || 'Untitled', size: 5, anchor: 'start', layer: 'thin', bold: true });
  // projection symbol: a truncated cone seen from the side and from its end
  const cx = symX + 22, cy = r2 + 7;
  const trap = (x: number, narrowRight: boolean): Prim => {
    const big = 3, small = 1.6, L = 9;
    const xa = x, xb = x + L;
    const [ha, hb] = narrowRight ? [big, small] : [small, big];
    return { k: 'path', pts: [[xa, cy - ha], [xb, cy - hb], [xb, cy + hb], [xa, cy + ha]], closed: true, layer: 'thin' };
  };
  const circles = (x: number): Prim[] => [
    { k: 'arc', c: [x, cy], r: 3, a0: 0, a1: TAU, layer: 'thin' },
    { k: 'arc', c: [x, cy], r: 1.6, a0: 0, a1: TAU, layer: 'thin' },
  ];
  if (o.angle === 'third') out.push(trap(cx - 14, true), ...circles(cx + 6));
  else out.push(...circles(cx - 10), trap(cx - 2, false));
  out.push({ k: 'text', at: [cx - 2, r2 + 1.2], text: o.angle === 'third' ? 'THIRD ANGLE' : 'FIRST ANGLE', size: 1.6, anchor: 'middle', layer: 'thin' });
  return out;
}

// ---------------------------------------------------------------------------
// writers

const arcPoints = (c: Vec2, r: number, a0: number, a1: number): Vec2[] => {
  const n = Math.max(8, Math.ceil(((a1 - a0) / TAU) * 96));
  const pts: Vec2[] = [];
  for (let i = 0; i <= n; i++) { const t = a0 + ((a1 - a0) * i) / n; pts.push([c[0] + Math.cos(t) * r, c[1] + Math.sin(t) * r]); }
  return pts;
};

const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const n2 = (v: number) => (Math.round(v * 1000) / 1000).toString();

export function sheetToSVG(sh: Sheet): string {
  const H = sh.h;
  const Y = (y: number) => n2(H - y);
  const stroke = (l: Layer) => {
    const st = STYLE[l];
    return `fill="none" stroke="${st.grey ? '#333' : '#000'}" stroke-width="${st.w}"${st.dash ? ` stroke-dasharray="${st.dash.join(' ')}"` : ''} stroke-linecap="round" stroke-linejoin="round"`;
  };
  const body: string[] = [];
  for (const p of sh.prims) {
    if (p.k === 'path') {
      const pts = p.pts.map(([x, y]) => `${n2(x)},${Y(y)}`).join(' ');
      body.push(p.closed ? `<polygon points="${pts}" ${stroke(p.layer)}/>` : `<polyline points="${pts}" ${stroke(p.layer)}/>`);
    } else if (p.k === 'arc') {
      if (p.a1 - p.a0 >= TAU - 1e-6) body.push(`<circle cx="${n2(p.c[0])}" cy="${Y(p.c[1])}" r="${n2(p.r)}" ${stroke(p.layer)}/>`);
      else {
        const s0: Vec2 = [p.c[0] + Math.cos(p.a0) * p.r, p.c[1] + Math.sin(p.a0) * p.r];
        const s1: Vec2 = [p.c[0] + Math.cos(p.a1) * p.r, p.c[1] + Math.sin(p.a1) * p.r];
        const large = p.a1 - p.a0 > Math.PI ? 1 : 0;
        // anticlockwise with y up is clockwise on screen once y is flipped (sweep flag 0)
        body.push(`<path d="M${n2(s0[0])} ${Y(s0[1])} A${n2(p.r)} ${n2(p.r)} 0 ${large} 0 ${n2(s1[0])} ${Y(s1[1])}" ${stroke(p.layer)}/>`);
      }
    } else if (p.k === 'fill') {
      body.push(`<polygon points="${p.pts.map(([x, y]) => `${n2(x)},${Y(y)}`).join(' ')}" fill="#000"/>`);
    } else {
      const anchor = p.anchor === 'middle' ? 'middle' : p.anchor === 'end' ? 'end' : 'start';
      const rot = p.rot ? ` transform="rotate(${-p.rot} ${n2(p.at[0])} ${Y(p.at[1])})"` : '';
      body.push(`<text x="${n2(p.at[0])}" y="${Y(p.at[1])}" font-size="${p.size}" font-family="Helvetica, Arial, sans-serif"${p.bold ? ' font-weight="700"' : ''} text-anchor="${anchor}"${rot}>${esc(p.text)}</text>`);
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${sh.w}mm" height="${sh.h}mm" viewBox="0 0 ${sh.w} ${sh.h}">`
    + `<rect width="${sh.w}" height="${sh.h}" fill="#fff"/>${body.join('')}</svg>`;
}

// Helvetica advance widths (per 1000 em) for the characters drawings use
const HELV: Record<string, number> = { ' ': 278, '.': 278, ',': 278, '-': 333, ':': 278, '/': 278, '·': 278, '×': 584, 'Ø': 778, '°': 400, '—': 1000, '(': 333, ')': 333 };
export function textWidth(t: string, size: number, bold = false) {
  let w = 0;
  for (const ch of t) {
    w += HELV[ch] ?? (/[0-9]/.test(ch) ? 556 : /[IJijlft]/.test(ch) ? 278 : /[MWmw]/.test(ch) ? 833 : /[A-Z]/.test(ch) ? 680 : 540);
  }
  return (w / 1000) * size * (bold ? 1.06 : 1);
}

/** Text as a PDF string in WinAnsi encoding. */
function pdfString(t: string) {
  let out = '';
  const map: Record<string, number> = { 'Ø': 0xd8, '×': 0xd7, '°': 0xb0, '·': 0xb7, '—': 0x97, 'é': 0xe9, 'ü': 0xfc, 'ö': 0xf6, 'ä': 0xe4 };
  for (const ch of t) {
    if (ch === '(' || ch === ')' || ch === '\\') out += `\\${ch}`;
    else if (map[ch] !== undefined) out += `\\${map[ch].toString(8)}`;
    else if (ch.charCodeAt(0) < 128) out += ch;
    else out += '?';
  }
  return `(${out})`;
}

/** A single-page vector PDF of the sheet (real millimetres, Helvetica text). */
export function sheetToPDF(sh: Sheet): Uint8Array {
  const k = 72 / 25.4;
  const ops: string[] = [`${k.toFixed(6)} 0 0 ${k.toFixed(6)} 0 0 cm`, '1 J 1 j'];
  let cur = '';
  const style = (l: Layer, fill = false) => {
    const st = STYLE[l];
    const key = `${l}${fill}`;
    if (cur === key) return;
    cur = key;
    ops.push(`${st.w} w ${st.dash ? `[${st.dash.join(' ')}] 0 d` : '[] 0 d'} ${st.grey ? '0.2 G 0.2 g' : '0 G 0 g'}`);
  };
  const path = (pts: Vec2[], closed: boolean) => {
    ops.push(pts.map(([x, y], i) => `${n2(x)} ${n2(y)} ${i ? 'l' : 'm'}`).join(' ') + (closed ? ' s' : ' S'));
  };
  for (const p of sh.prims) {
    if (p.k === 'path') { style(p.layer); path(p.pts, !!p.closed); }
    else if (p.k === 'arc') { style(p.layer); path(arcPoints(p.c, p.r, p.a0, p.a1), false); }
    else if (p.k === 'fill') { style(p.layer, true); ops.push(p.pts.map(([x, y], i) => `${n2(x)} ${n2(y)} ${i ? 'l' : 'm'}`).join(' ') + ' h f'); }
    else {
      const w = textWidth(p.text, p.size, p.bold);
      const shift = p.anchor === 'middle' ? -w / 2 : p.anchor === 'end' ? -w : 0;
      const t = ((p.rot ?? 0) * Math.PI) / 180, c = Math.cos(t), s = Math.sin(t);
      const x = p.at[0] + c * shift, y = p.at[1] + s * shift;
      ops.push(`BT /${p.bold ? 'F2' : 'F1'} ${p.size} Tf ${n2(c)} ${n2(s)} ${n2(-s)} ${n2(c)} ${n2(x)} ${n2(y)} Tm ${pdfString(p.text)} Tj ET`);
      cur = '';
    }
  }
  const content = ops.join('\n');
  const W = n2(sh.w * k), H = n2(sh.h * k);
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Contents 4 0 R /Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> >>`,
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  const bytes = new Uint8Array(out.length);
  for (let i = 0; i < out.length; i++) bytes[i] = out.charCodeAt(i) & 0xff;
  return bytes;
}

/** AutoCAD R12 DXF: lines, exact arcs and circles, text — opens in every CAD and laser/CNC program. */
export function sheetToDXF(sh: Sheet): string {
  const L: string[] = [];
  const g = (code: number, v: string | number) => L.push(String(code), typeof v === 'number' ? n2(v) : v);
  const layerName: Record<Layer, string> = { visible: 'VISIBLE', hidden: 'HIDDEN', center: 'CENTER', dim: 'DIMENSIONS', frame: 'BORDER', thin: 'NOTES' };
  g(0, 'SECTION'); g(2, 'HEADER'); g(9, '$ACADVER'); g(1, 'AC1009'); g(9, '$INSUNITS'); g(70, 4); g(0, 'ENDSEC');
  g(0, 'SECTION'); g(2, 'TABLES');
  g(0, 'TABLE'); g(2, 'LTYPE'); g(70, 3);
  const ltype = (name: string, desc: string, dashes: number[]) => {
    g(0, 'LTYPE'); g(2, name); g(70, 0); g(3, desc); g(72, 65); g(73, dashes.length); g(40, dashes.reduce((a, b) => a + Math.abs(b), 0));
    for (const d of dashes) g(49, d);
  };
  ltype('CONTINUOUS', 'Solid line', []);
  ltype('DASHED', 'Dashed __ __ __', [3, -1.5]);
  ltype('CENTER', 'Center ____ _ ____', [12, -2, 2, -2]);
  g(0, 'ENDTAB');
  g(0, 'TABLE'); g(2, 'LAYER'); g(70, 6);
  const layer = (name: string, color: number, lt: string) => { g(0, 'LAYER'); g(2, name); g(70, 0); g(62, color); g(6, lt); };
  layer('VISIBLE', 7, 'CONTINUOUS'); layer('HIDDEN', 8, 'DASHED'); layer('CENTER', 1, 'CENTER');
  layer('DIMENSIONS', 3, 'CONTINUOUS'); layer('BORDER', 7, 'CONTINUOUS'); layer('NOTES', 7, 'CONTINUOUS');
  g(0, 'ENDTAB'); g(0, 'ENDSEC');
  g(0, 'SECTION'); g(2, 'ENTITIES');
  const deg = (a: number) => (((a * 180) / Math.PI) % 360 + 360) % 360;
  for (const p of sh.prims) {
    const ly = layerName[p.layer];
    if (p.k === 'path') {
      if (p.pts.length === 2 && !p.closed) {
        g(0, 'LINE'); g(8, ly); g(10, p.pts[0][0]); g(20, p.pts[0][1]); g(30, 0); g(11, p.pts[1][0]); g(21, p.pts[1][1]); g(31, 0);
      } else {
        g(0, 'POLYLINE'); g(8, ly); g(66, 1); g(70, p.closed ? 1 : 0);
        for (const [x, y] of p.pts) { g(0, 'VERTEX'); g(8, ly); g(10, x); g(20, y); g(30, 0); }
        g(0, 'SEQEND'); g(8, ly);
      }
    } else if (p.k === 'arc') {
      if (p.a1 - p.a0 >= TAU - 1e-6) { g(0, 'CIRCLE'); g(8, ly); g(10, p.c[0]); g(20, p.c[1]); g(30, 0); g(40, p.r); }
      else { g(0, 'ARC'); g(8, ly); g(10, p.c[0]); g(20, p.c[1]); g(30, 0); g(40, p.r); g(50, deg(p.a0)); g(51, deg(p.a1)); }
    } else if (p.k === 'fill') {
      const [a, b, c] = p.pts;
      g(0, 'SOLID'); g(8, ly); g(10, a[0]); g(20, a[1]); g(30, 0); g(11, b[0]); g(21, b[1]); g(31, 0); g(12, c[0]); g(22, c[1]); g(32, 0); g(13, c[0]); g(23, c[1]); g(33, 0);
    } else {
      const txt = p.text.replace(/Ø/g, '%%c').replace(/°/g, '%%d').replace(/×/g, 'x').replace(/·/g, '-').replace(/—/g, '-');
      g(0, 'TEXT'); g(8, ly); g(10, p.at[0]); g(20, p.at[1]); g(30, 0); g(40, p.size); g(1, txt);
      if (p.rot) g(50, p.rot);
      const h = p.anchor === 'middle' ? 1 : p.anchor === 'end' ? 2 : 0;
      if (h) { g(72, h); g(11, p.at[0]); g(21, p.at[1]); g(31, 0); }
    }
  }
  g(0, 'ENDSEC'); g(0, 'EOF');
  return L.join('\n') + '\n';
}
