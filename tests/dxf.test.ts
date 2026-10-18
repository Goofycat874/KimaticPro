import { describe, expect, it } from 'vitest';
import { parseDXF, sketchToDXF } from '../src/core/dxf';
import { sketchProfileEntities } from '../src/core/sketch';
import type { SketchEntity, Vec2 } from '../src/core/types';

const area = (pts: Vec2[]) => Math.abs(pts.reduce((s, p, i) => { const q = pts[(i + 1) % pts.length]; return s + p[0] * q[1] - q[0] * p[1]; }, 0) / 2);
const solidArea = (es: SketchEntity[]) => sketchProfileEntities(es).reduce((s, p) => s + area(p.outer) - p.holes.reduce((h, x) => h + area(x), 0), 0);
const dxf = (body: string, units = 4) => `0\nSECTION\n2\nHEADER\n9\n$INSUNITS\n70\n${units}\n0\nENDSEC\n0\nSECTION\n2\nENTITIES\n${body}0\nENDSEC\n0\nEOF\n`;
const line = (a: Vec2, b: Vec2) => `0\nLINE\n8\n0\n10\n${a[0]}\n20\n${a[1]}\n11\n${b[0]}\n21\n${b[1]}\n`;

describe('DXF', () => {
  it('round-trips a sketch with a hole, an arc and a slot', () => {
    const es: SketchEntity[] = [
      { id: 'r', kind: 'rect', x: 0, y: 0, w: 60, h: 40 },
      { id: 'c', kind: 'circle', cx: 20, cy: 20, r: 6 },
      { id: 's', kind: 'slot', x1: 40, y1: 12, x2: 40, y2: 28, r: 4 },
    ];
    const back = parseDXF(sketchToDXF(es)).entities;
    expect(Math.abs(solidArea(back) - solidArea(es))).toBeLessThan(0.5);
    expect(back.some((e) => e.kind === 'circle')).toBe(true);
  });

  it('joins loose LINEs into a closed outline', () => {
    const body = line([0, 0], [10, 0]) + line([10, 10], [10, 0]) + line([10, 10], [0, 10]) + line([0, 10], [0, 0]);
    const r = parseDXF(dxf(body));
    expect(r.entities.length).toBe(1);
    expect(r.entities[0]).toMatchObject({ kind: 'polyline', closed: true });
    expect(solidArea(r.entities)).toBeCloseTo(100, 6);
  });

  it('reads LWPOLYLINE bulges as exact arcs (a D shape)', () => {
    // straight 10 wide box with a half circle on the right: bulge 1 = 180°
    const body = '0\nLWPOLYLINE\n8\n0\n90\n4\n70\n1\n10\n0\n20\n0\n10\n10\n20\n0\n42\n1\n10\n10\n20\n10\n10\n0\n20\n10\n';
    const r = parseDXF(dxf(body));
    expect(r.entities.some((e) => e.kind === 'arc')).toBe(true);
    expect(solidArea(r.entities)).toBeCloseTo(100 + (Math.PI * 25) / 2, 0);
  });

  it('converts inches to millimetres', () => {
    const r = parseDXF(dxf('0\nCIRCLE\n8\n0\n10\n1\n20\n1\n40\n0.5\n', 1));
    expect(r.entities[0]).toMatchObject({ kind: 'circle', cx: 25.4, cy: 25.4, r: 12.7 });
  });

  it('evaluates NURBS splines and counts what it skipped', () => {
    // a quadratic B-spline with a clamped knot vector passes through its end points
    const body = '0\nSPLINE\n8\n0\n70\n8\n71\n2\n72\n6\n73\n3\n40\n0\n40\n0\n40\n0\n40\n1\n40\n1\n40\n1\n10\n0\n20\n0\n10\n5\n20\n10\n10\n10\n20\n0\n0\nTEXT\n8\n0\n1\nhi\n0\n3DFACE\n8\n0\n';
    const r = parseDXF(dxf(body));
    const p = (r.entities[0] as any).points as Vec2[];
    expect(p[0][0]).toBeCloseTo(0); expect(p[p.length - 1][0]).toBeCloseTo(10, 4);
    // the peak of a quadratic Bézier with control y=10 is y=5
    expect(Math.max(...p.map((q) => q[1]))).toBeCloseTo(5, 2);
    expect(r.skipped).toEqual({ '3DFACE': 1 });
  });
});
