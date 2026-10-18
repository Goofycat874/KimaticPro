// A tiny, safe maths expression language for dimensions: `width / 2 + 3`, `sqrt(a^2 + b^2)`.
// Hand-written parser — design files are shared, so nothing here may ever run code.

/** ISO metric coarse pitch for a diameter (M3 → 0.5, M8 → 1.25 …). */
export function metricPitch(d: number) {
  const table: [number, number][] = [[2, 0.4], [2.5, 0.45], [3, 0.5], [4, 0.7], [5, 0.8], [6, 1], [8, 1.25], [10, 1.5], [12, 1.75], [16, 2], [20, 2.5], [24, 3]];
  let best = table[0];
  for (const t of table) if (Math.abs(t[0] - d) < Math.abs(best[0] - d)) best = t;
  return best[1];
}

const FUNCS: Record<string, (...a: number[]) => number> = {
  metric_pitch: metricPitch,
  sin: (x) => Math.sin((x * Math.PI) / 180),
  cos: (x) => Math.cos((x * Math.PI) / 180),
  tan: (x) => Math.tan((x * Math.PI) / 180),
  asin: (x) => (Math.asin(x) * 180) / Math.PI,
  acos: (x) => (Math.acos(x) * 180) / Math.PI,
  atan: (x) => (Math.atan(x) * 180) / Math.PI,
  sqrt: Math.sqrt, abs: Math.abs, round: Math.round, floor: Math.floor, ceil: Math.ceil,
  min: Math.min, max: Math.max, pow: Math.pow,
};
const CONSTS: Record<string, number> = { pi: Math.PI, PI: Math.PI, e: Math.E };

/** Length units you can type after a number, in millimetres. */
const UNITS: Record<string, number> = { mm: 1, cm: 10, m: 1000, in: 25.4, '"': 25.4, ft: 304.8 };

type Tok = { t: 'num'; v: number } | { t: 'id'; v: string } | { t: 'op'; v: string };

function lex(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (/[0-9.]/.test(c)) {
      const m = /^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/.exec(src.slice(i));
      if (!m) throw new Error(`Bad number near “${src.slice(i, i + 5)}”`);
      i += m[0].length;
      // a trailing unit converts to millimetres: 10mm, 2in, 3/8", 1.5cm, 0.1m, 2ft, 45deg
      const u = /^(?:(mm|cm|in|ft|m|deg)(?![A-Za-z0-9_])|(°|"))/.exec(src.slice(i));
      const unit = u ? (u[1] ?? u[2]) : '';
      const k = UNITS[unit] ?? 1;
      const n = out.length;
      // 3/8" means three-eighths of an inch: scale the numerator of a plain fraction
      if (k !== 1 && n >= 2 && out[n - 1].t === 'op' && out[n - 1].v === '/' && out[n - 2].t === 'num' && !(n >= 3 && out[n - 3].t === 'op' && /[*/^%]/.test(String(out[n - 3].v)))) {
        (out[n - 2] as { v: number }).v *= k;
        out.push({ t: 'num', v: parseFloat(m[0]) });
      } else out.push({ t: 'num', v: parseFloat(m[0]) * k });
      if (u) i += u[0].length;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i))!;
      out.push({ t: 'id', v: m[0] });
      i += m[0].length;
      continue;
    }
    if ('+-*/^%(),'.includes(c)) {
      out.push({ t: 'op', v: c });
      i++;
      // (a + b)in → (a + b) * 25.4
      if (c === ')') {
        const u = /^(?:(mm|cm|in|ft|m)(?![A-Za-z0-9_])|("))/.exec(src.slice(i));
        if (u) { out.push({ t: 'op', v: '*' }, { t: 'num', v: UNITS[u[1] ?? u[2]] }); i += u[0].length; }
      }
      continue;
    }
    throw new Error(`Unexpected “${c}”`);
  }
  return out;
}

export function evalExpr(src: string, vars: Record<string, number> = {}): number {
  const toks = lex(src.replace(/^=/, ''));
  let p = 0;
  const peek = () => toks[p];
  const isOp = (v: string) => peek()?.t === 'op' && (peek() as any).v === v;
  const expect = (v: string) => { if (!isOp(v)) throw new Error(`Expected “${v}”`); p++; };

  const primary = (): number => {
    const t = peek();
    if (!t) throw new Error('Unexpected end');
    if (t.t === 'num') { p++; return t.v; }
    if (t.t === 'op' && t.v === '(') { p++; const v = sum(); expect(')'); return v; }
    if (t.t === 'op' && (t.v === '-' || t.v === '+')) { p++; const v = power(); return t.v === '-' ? -v : v; }
    if (t.t === 'id') {
      p++;
      if (isOp('(')) {
        const f = FUNCS[t.v];
        if (!f) throw new Error(`Unknown function “${t.v}”`);
        p++;
        const args: number[] = [];
        if (!isOp(')')) { args.push(sum()); while (isOp(',')) { p++; args.push(sum()); } }
        expect(')');
        return f(...args);
      }
      if (t.v in vars) return vars[t.v];
      if (t.v in CONSTS) return CONSTS[t.v];
      throw new Error(`Unknown name “${t.v}”`);
    }
    throw new Error(`Unexpected “${(t as any).v}”`);
  };
  const power = (): number => {
    const b = primary();
    if (isOp('^')) { p++; return Math.pow(b, power()); }
    return b;
  };
  const product = (): number => {
    let v = power();
    while (isOp('*') || isOp('/') || isOp('%')) {
      const o = (toks[p++] as any).v;
      const r = power();
      v = o === '*' ? v * r : o === '/' ? v / r : v % r;
    }
    return v;
  };
  const sum = (): number => {
    let v = product();
    while (isOp('+') || isOp('-')) {
      const o = (toks[p++] as any).v;
      const r = product();
      v = o === '+' ? v + r : v - r;
    }
    return v;
  };
  const v = sum();
  if (p < toks.length) throw new Error(`Unexpected “${(toks[p] as any).v}”`);
  if (!Number.isFinite(v)) throw new Error('Result is not a number');
  return v;
}

/** True when the text uses names (parameters), not just numbers and maths. */
export const usesNames = (src: string) => {
  try { return lex(src.replace(/^=/, '')).some((t) => t.t === 'id' && !(t.v in CONSTS) && !(t.v in FUNCS)); } catch { return false; }
};

export const isValidName = (n: string) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(n) && !(n in FUNCS) && !(n in CONSTS);

/** Resolve user parameters in order; later ones may use earlier ones. */
export function resolveParams(params: { name: string; expr: string }[]) {
  const vars: Record<string, number> = {};
  const errors: Record<string, string> = {};
  for (const p of params) {
    try { vars[p.name] = evalExpr(p.expr, vars); } catch (e: any) { errors[p.name] = e.message; vars[p.name] = NaN; }
  }
  return { vars, errors };
}

/** Write `value` at a dotted path like `params.width` or `transform.position.1`. */
export function setPath(obj: any, path: string, value: number) {
  const keys = path.split('.');
  let o = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (o[keys[i]] === undefined) return;
    o = o[keys[i]];
  }
  o[keys[keys.length - 1]] = value;
}
