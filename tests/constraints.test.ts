import { describe, expect, it } from 'vitest';
import { dragRef, keepKeys, measure, solveSketch } from '../src/core/constraints';
import { arcInfo, arcThrough, chainLoops, sketchProfileEntities } from '../src/core/sketch';
import type { SketchConstraint, SketchEntity, Vec2 } from '../src/core/types';

const poly = (id: string, points: Vec2[], closed = false): SketchEntity => ({ id, kind: 'polyline', points, closed });
const c = (id: string, type: SketchConstraint['type'], refs: SketchConstraint['refs'], extra: Partial<SketchConstraint> = {}): SketchConstraint => ({ id, type, refs, ...extra });
const close = (a: number, b: number, tol = 1e-5) => expect(Math.abs(a - b), `${a} vs ${b}`).toBeLessThan(tol);

/** Four separate lines meeting at the corners, roughly a box. */
function looseBox() {
  const es = [
    poly('a', [[0, 0], [10, 0.5]]),
    poly('b', [[10, 0.5], [11, 9]]),
    poly('c', [[11, 9], [-0.5, 10]]),
    poly('d', [[-0.5, 10], [0, 0]]),
  ];
  const cs: SketchConstraint[] = [
    c('k1', 'coincident', [{ e: 'a', p: 1 }, { e: 'b', p: 0 }]),
    c('k2', 'coincident', [{ e: 'b', p: 1 }, { e: 'c', p: 0 }]),
    c('k3', 'coincident', [{ e: 'c', p: 1 }, { e: 'd', p: 0 }]),
    c('k4', 'coincident', [{ e: 'd', p: 1 }, { e: 'a', p: 0 }]),
  ];
  return { es, cs };
}

describe('sketch solver', () => {
  it('squares up a box with horizontal / vertical and dimensions', () => {
    const { es, cs } = looseBox();
    cs.push(
      c('h1', 'horizontal', [{ e: 'a', s: 0 }]), c('h2', 'horizontal', [{ e: 'c', s: 0 }]),
      c('v1', 'vertical', [{ e: 'b', s: 0 }]), c('v2', 'vertical', [{ e: 'd', s: 0 }]),
      c('w', 'distance', [{ e: 'a', s: 0 }], { value: 40 }),
      c('h', 'distance', [{ e: 'b', s: 0 }], { value: 25 }),
    );
    const r = solveSketch(es, cs, { analyze: true });
    expect(r.ok).toBe(true);
    const ents = new Map(r.entities.map((e) => [e.id, e]));
    for (const k of cs) if (k.value) close(measure(ents, k)!, k.value);
    const a = r.entities[0] as any, b = r.entities[1] as any;
    close(a.points[0][1], a.points[1][1]);
    close(b.points[0][0], b.points[1][0]);
    // still free to slide around: x and y position
    expect(r.dof).toBe(2);
    expect(r.fixed.size).toBe(0);
  });

  it('becomes fully constrained when pinned to the origin', () => {
    const { es, cs } = looseBox();
    cs.push(
      c('h1', 'horizontal', [{ e: 'a', s: 0 }]), c('h2', 'horizontal', [{ e: 'c', s: 0 }]),
      c('v1', 'vertical', [{ e: 'b', s: 0 }]), c('v2', 'vertical', [{ e: 'd', s: 0 }]),
      c('w', 'distance', [{ e: 'a', s: 0 }], { value: 40 }),
      c('h', 'distance', [{ e: 'b', s: 0 }], { value: 25 }),
      c('o', 'coincident', [{ e: 'a', p: 0 }, { e: '$o', p: 0 }]),
    );
    const r = solveSketch(es, cs, { analyze: true });
    expect(r.ok).toBe(true);
    expect(r.dof).toBe(0);
    expect(r.fixed.size).toBe(4);
    const pts = (r.entities[2] as any).points;
    close(Math.abs(pts[0][0]), 40); close(Math.abs(pts[0][1]), 25);
  });

  it('reports conflicting constraints instead of pretending', () => {
    const es = [poly('a', [[0, 0], [10, 1]])];
    const r = solveSketch(es, [
      c('h', 'horizontal', [{ e: 'a', s: 0 }]),
      c('v', 'vertical', [{ e: 'a', s: 0 }]),
      c('l', 'distance', [{ e: 'a', s: 0 }], { value: 10 }),
    ]);
    expect(r.ok).toBe(false);
    expect(r.failing.length).toBeGreaterThan(0);
  });

  it('handles circles: tangent, concentric, equal, diameter', () => {
    const es: SketchEntity[] = [
      { id: 'c1', kind: 'circle', cx: 0, cy: 0, r: 5 },
      { id: 'c2', kind: 'circle', cx: 1, cy: 1, r: 2 },
      { id: 'c3', kind: 'circle', cx: 20, cy: 3, r: 4 },
      poly('l', [[-10, 12], [30, 14]]),
    ];
    const cs = [
      c('d', 'diameter', [{ e: 'c1' }], { value: 20 }),
      c('cc', 'concentric', [{ e: 'c1' }, { e: 'c2' }]),
      c('eq', 'equal', [{ e: 'c3' }, { e: 'c2' }]),
      c('t', 'tangent', [{ e: 'l', s: 0 }, { e: 'c1' }]),
      c('t2', 'tangent', [{ e: 'c1' }, { e: 'c3' }]),
    ];
    const r = solveSketch(es, cs);
    expect(r.ok).toBe(true);
    const [c1, c2, c3] = r.entities as any[];
    close(c1.r, 10); close(c1.cx, c2.cx); close(c1.cy, c2.cy); close(c3.r, c2.r);
    close(Math.hypot(c3.cx - c1.cx, c3.cy - c1.cy), c1.r + c3.r);
  });

  it('keeps arc end points on their circle', () => {
    const es: SketchEntity[] = [{ id: 'a', kind: 'arc', cx: 0, cy: 0, x1: 10, y1: 0, x2: 0, y2: 7 }];
    const r = solveSketch(es, [c('r', 'radius', [{ e: 'a' }], { value: 12 })]);
    expect(r.ok).toBe(true);
    const a = r.entities[0] as any;
    close(Math.hypot(a.x1 - a.cx, a.y1 - a.cy), 12);
    close(Math.hypot(a.x2 - a.cx, a.y2 - a.cy), 12);
  });

  it('solves angles, midpoints, symmetry and points on lines', () => {
    const es = [poly('a', [[0, 0], [10, 0]]), poly('b', [[0, 0], [8, 5]]), poly('p', [[3, 3], [7, 4]])];
    const cs = [
      c('fix', 'fix', [{ e: 'a', p: 0 }], { at: [0, 0] }),
      c('h', 'horizontal', [{ e: 'a', s: 0 }]),
      c('j', 'coincident', [{ e: 'a', p: 0 }, { e: 'b', p: 0 }]),
      c('ang', 'angle', [{ e: 'a', s: 0 }, { e: 'b', s: 0 }], { value: 30 }),
      c('mid', 'midpoint', [{ e: 'p', p: 0 }, { e: 'a', s: 0 }]),
      c('on', 'onCurve', [{ e: 'p', p: 1 }, { e: 'b', s: 0 }]),
    ];
    const r = solveSketch(es, cs);
    expect(r.ok).toBe(true);
    const ents = new Map(r.entities.map((e) => [e.id, e]));
    close(measure(ents, cs[3])!, 30, 1e-4);
    const a = (r.entities[0] as any).points, p = (r.entities[2] as any).points, b = (r.entities[1] as any).points;
    close(p[0][0], (a[0][0] + a[1][0]) / 2); close(p[0][1], 0);
    // p1 lies on line b
    const cr = (b[1][0] - b[0][0]) * (p[1][1] - b[0][1]) - (b[1][1] - b[0][1]) * (p[1][0] - b[0][0]);
    close(cr, 0, 1e-4);

    const sym = solveSketch([poly('q', [[-3, 2], [4, 5]])], [c('s', 'symmetric', [{ e: 'q', p: 0 }, { e: 'q', p: 1 }, { e: '$o', s: 1 }])]);
    expect(sym.ok).toBe(true);
    const q = (sym.entities[0] as any).points;
    close(q[0][0], -q[1][0]); close(q[0][1], q[1][1]);
  });

  it('dragging a point moves connected geometry and keeps the point under the cursor', () => {
    const { es, cs } = looseBox();
    const solved = solveSketch(es, cs).entities;
    const { entity, keep } = dragRef(solved[1], { e: 'b', p: 1 }, [20, 20], [0, 0]);
    const start = solved.map((e) => (e.id === 'b' ? entity : e));
    const r = solveSketch(start, cs, { keep: new Set(keepKeys('b', keep)) });
    expect(r.ok).toBe(true);
    const b = (r.entities[1] as any).points, cc = (r.entities[2] as any).points;
    close(b[1][0], 20, 1e-2); close(b[1][1], 20, 1e-2);
    close(cc[0][0], b[1][0]); close(cc[0][1], b[1][1]);
  });

  it('dimensions can follow a changed value', () => {
    const es: SketchEntity[] = [{ id: 'r', kind: 'rect', x: 0, y: 0, w: 10, h: 5 }];
    const r = solveSketch(es, [c('w', 'hdistance', [{ e: 'r', s: 0 }], { value: 32 }), c('o', 'coincident', [{ e: 'r', p: 0 }, { e: '$o', p: 0 }])], { analyze: true });
    expect(r.ok).toBe(true);
    close((r.entities[0] as any).w, 32);
    expect(r.dof).toBe(1); // height still free
  });
});

describe('sketch loops', () => {
  it('joins separate lines into a closed profile', () => {
    const es = [poly('a', [[0, 0], [10, 0]]), poly('b', [[10, 0], [10, 10]]), poly('c', [[10, 10], [0, 10], [0, 0]])];
    const loops = chainLoops(es);
    expect(loops.length).toBe(1);
    const ps = sketchProfileEntities(es);
    expect(ps.length).toBe(1);
    expect(ps[0].outerEntity.kind).toBe('chain');
  });

  it('a line across a box makes two regions', () => {
    const es = [poly('box', [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]), poly('diag', [[0, 0], [10, 10]])];
    expect(chainLoops(es).length).toBe(2);
  });

  it('lines plus an arc make a D shape, with dangling lines ignored', () => {
    const arc = arcThrough([10, 0], [15, 5], [10, 10])!;
    const es: SketchEntity[] = [
      poly('l', [[10, 10], [0, 10], [0, 0], [10, 0]]),
      { id: 'a', kind: 'arc', ...arc },
      poly('tail', [[0, 0], [-5, -5]]),
    ];
    const ps = sketchProfileEntities(es);
    expect(ps.length).toBe(1);
    const area = (pts: Vec2[]) => Math.abs(pts.reduce((s, p, i) => { const q = pts[(i + 1) % pts.length]; return s + p[0] * q[1] - q[0] * p[1]; }, 0) / 2);
    close(area(ps[0].outer), 100 + Math.PI * 25 / 2, 0.5);
    const info = arcInfo(es[1] as any);
    close(info.r, 5);
  });

  it('construction lines never become solid', () => {
    const es: SketchEntity[] = [{ id: 'r', kind: 'rect', x: 0, y: 0, w: 5, h: 5, construction: true }];
    expect(sketchProfileEntities(es).length).toBe(0);
  });

  it('a circle inside a joined loop is a hole', () => {
    const es: SketchEntity[] = [
      poly('a', [[0, 0], [20, 0], [20, 20]]), poly('b', [[20, 20], [0, 20], [0, 0]]),
      { id: 'h', kind: 'circle', cx: 10, cy: 10, r: 3 },
    ];
    const ps = sketchProfileEntities(es);
    expect(ps.length).toBe(1);
    expect(ps[0].holes.length).toBe(1);
  });
});
