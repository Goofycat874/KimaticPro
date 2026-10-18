import { describe, expect, it } from 'vitest';
import { filletCorner, mirrorEntities, offsetEntities, trimAt } from '../src/core/sketchEdit';
import { solveSketch } from '../src/core/constraints';
import { arcInfo, sketchProfileEntities } from '../src/core/sketch';
import type { SketchConstraint, SketchEntity, Vec2 } from '../src/core/types';

const area = (pts: Vec2[]) => Math.abs(pts.reduce((s, p, i) => { const q = pts[(i + 1) % pts.length]; return s + p[0] * q[1] - q[0] * p[1]; }, 0) / 2);
const solid = (es: SketchEntity[]) => sketchProfileEntities(es).reduce((s, p) => s + area(p.outer), 0);
const square = (): SketchEntity => ({ id: 'sq', kind: 'polyline', points: [[0, 0], [10, 0], [10, 10], [0, 10]], closed: true });

describe('sketch fillet', () => {
  it('rounds a corner of a closed outline, keeps it solid and its constraints solvable', () => {
    const cs: SketchConstraint[] = [
      { id: 'h', type: 'horizontal', refs: [{ e: 'sq', s: 0 }] },
      { id: 'v', type: 'vertical', refs: [{ e: 'sq', s: 1 }] },
      { id: 'w', type: 'distance', refs: [{ e: 'sq', s: 0 }], value: 10 },
      { id: 'o', type: 'coincident', refs: [{ e: 'sq', p: 0 }, { e: '$o', p: 0 }] },
    ];
    const r = filletCorner([square()], cs, { e: 'sq', p: 2 }, 2);
    if (typeof r === 'string') throw new Error(r);
    expect(r.entities.map((e) => e.kind).sort()).toEqual(['arc', 'polyline']);
    expect(solid(r.entities)).toBeCloseTo(100 - 4 * (1 - Math.PI / 4), 2);
    // the original constraints survived, re-pointed, plus tangents and a radius
    expect(r.constraints.filter((c) => ['h', 'v', 'w', 'o'].includes(c.id)).length).toBe(4);
    expect(r.constraints.filter((c) => c.type === 'tangent').length).toBe(2);
    const solved = solveSketch(r.entities, r.constraints);
    expect(solved.ok).toBe(true);
    expect(arcInfo(solved.entities.find((e) => e.kind === 'arc') as any).r).toBeCloseTo(2, 6);
  });

  it('rounds an open polyline corner and a rectangle', () => {
    const open: SketchEntity = { id: 'p', kind: 'polyline', points: [[0, 0], [10, 0], [10, 10]], closed: false };
    const r = filletCorner([open], [], { e: 'p', p: 1 }, 3);
    if (typeof r === 'string') throw new Error(r);
    expect(r.entities.length).toBe(3);
    expect(typeof filletCorner([open], [], { e: 'p', p: 0 }, 3)).toBe('string');
    expect(typeof filletCorner([open], [], { e: 'p', p: 1 }, 30)).toBe('string');
    const rect: SketchEntity = { id: 'r', kind: 'rect', x: 0, y: 0, w: 20, h: 10 };
    const rr = filletCorner([rect], [], { e: 'r', p: 0 }, 2);
    expect(typeof rr !== 'string' && (rr.entities[0] as any).radius).toBe(2);
  });
});

describe('trim', () => {
  it('cuts a line back to where it crosses another', () => {
    const es: SketchEntity[] = [
      { id: 'h', kind: 'polyline', points: [[0, 5], [10, 5]], closed: false },
      { id: 'v', kind: 'polyline', points: [[5, 0], [5, 10]], closed: false },
    ];
    const r = trimAt(es, [], { e: 'h', s: 0 }, [8, 5]);
    if (typeof r === 'string') throw new Error(r);
    expect((r.entities.find((e) => e.id === 'h') as any).points).toEqual([[0, 5], [5, 5]]);
  });

  it('turns a crossed circle into an arc and splits a segment in the middle', () => {
    const es: SketchEntity[] = [
      { id: 'c', kind: 'circle', cx: 0, cy: 0, r: 5 },
      { id: 'l', kind: 'polyline', points: [[-10, 0], [10, 0]], closed: false },
    ];
    const r = trimAt(es, [], { e: 'c' }, [0, 5]);
    if (typeof r === 'string') throw new Error(r);
    const arc = r.entities.find((e) => e.kind === 'arc') as any;
    expect(arcInfo(arc).sweep).toBeCloseTo(Math.PI, 6);
    expect(arcInfo(arc).mid[1]).toBeCloseTo(-5, 6);
    // trimming the line between the circle's sides leaves two pieces
    const r2 = trimAt(es, [], { e: 'l', s: 0 }, [0, 0]);
    if (typeof r2 === 'string') throw new Error(r2);
    const pieces = r2.entities.filter((e) => e.kind === 'polyline') as any[];
    expect(pieces.map((p) => p.points)).toEqual([[[-10, 0], [-5, 0]], [[5, 0], [10, 0]]]);
  });

  it('keeps constraints on the parts that are left', () => {
    const cs: SketchConstraint[] = [
      { id: 'h', type: 'horizontal', refs: [{ e: 'sq', s: 2 }] },
      { id: 'v', type: 'vertical', refs: [{ e: 'sq', s: 1 }] },
      { id: 'o', type: 'coincident', refs: [{ e: 'sq', p: 0 }, { e: '$o', p: 0 }] },
      { id: 'gone', type: 'horizontal', refs: [{ e: 'sq', s: 0 }] },
    ];
    const es: SketchEntity[] = [square(), { id: 'cut', kind: 'polyline', points: [[3, -2], [3, 2]], closed: false }];
    const r = trimAt(es, cs, { e: 'sq', s: 0 }, [1, 0]);
    if (typeof r === 'string') throw new Error(r);
    expect(r.constraints.map((c) => c.id).sort()).toEqual(['h', 'o', 'v']);
    expect(solveSketch(r.entities, r.constraints).ok).toBe(true);
    // the re-pointed refs still describe the same geometry
    const sq = r.entities.find((e) => e.id === 'sq') as any;
    const o = r.constraints.find((c) => c.id === 'o')!;
    expect(sq.points[o.refs[0].p!]).toEqual([0, 0]);
  });

  it('opens a closed outline where a side is trimmed', () => {
    const es: SketchEntity[] = [square(), { id: 'cut', kind: 'polyline', points: [[3, -2], [3, 2]], closed: false }];
    const r = trimAt(es, [], { e: 'sq', s: 0 }, [1, 0]);
    if (typeof r === 'string') throw new Error(r);
    const sq = r.entities.find((e) => e.id === 'sq') as any;
    expect(sq.closed).toBe(false);
    expect(sq.points[0]).toEqual([3, 0]);
    expect(sq.points[sq.points.length - 1]).toEqual([0, 0]);
  });
});

describe('offset and mirror', () => {
  it('offsets outwards whichever way the loop was drawn', () => {
    const cw: SketchEntity = { id: 'cw', kind: 'polyline', points: [[0, 0], [0, 10], [10, 10], [10, 0]], closed: true };
    for (const e of [square(), cw]) expect(area((offsetEntities([e], [e.id], 1)[0] as any).points)).toBeCloseTo(144, 6);
    expect((offsetEntities([{ id: 'c', kind: 'circle', cx: 0, cy: 0, r: 5 }], ['c'], -2)[0] as any).r).toBe(3);
    const rr = offsetEntities([{ id: 'r', kind: 'rect', x: 0, y: 0, w: 10, h: 4 }], ['r'], 2)[0] as any;
    expect([rr.x, rr.y, rr.w, rr.h, rr.radius]).toEqual([-2, -2, 14, 8, 2]);
  });

  it('offsets a loop made of separate lines and an arc consistently outwards', () => {
    const es: SketchEntity[] = [
      { id: 'l', kind: 'polyline', points: [[10, 10], [0, 10], [0, 0], [10, 0]], closed: false },
      { id: 'a', kind: 'arc', cx: 10, cy: 5, x1: 10, y1: 0, x2: 10, y2: 10 },
    ];
    const made = offsetEntities(es, ['l', 'a'], 1);
    const arc = made.find((e) => e.kind === 'arc') as any;
    expect(arcInfo(arc).r).toBeCloseTo(6, 6);
    const line = made.find((e) => e.kind === 'polyline') as any;
    expect(line.points[1][0]).toBeCloseTo(-1, 6);
    expect(line.points[1][1]).toBeCloseTo(11, 6);
  });

  it('mirrors shapes across a line, keeping arcs anticlockwise', () => {
    const es: SketchEntity[] = [
      { id: 'p', kind: 'polyline', points: [[1, 0], [3, 2]], closed: false },
      { id: 'a', kind: 'arc', cx: 5, cy: 0, x1: 7, y1: 0, x2: 5, y2: 2 },
    ];
    const m = mirrorEntities(es, ['p', 'a'], [[0, 0], [0, 1]]);
    expect((m[0] as any).points).toEqual([[-1, 0], [-3, 2]]);
    const a = arcInfo(m[1] as any);
    expect(a.sweep).toBeCloseTo(Math.PI / 2, 6);
    expect(a.mid[0]).toBeLessThan(-5);
    expect(a.mid[1]).toBeGreaterThan(0);
  });
});
