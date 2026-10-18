import { describe, expect, it } from 'vitest';
import { evaluate } from '../src/core/evaluator';
import { computeVolume } from '../src/core/geometry';
import { checkMesh } from '../src/core/meshcheck';
import { evalExpr, resolveParams, usesNames } from '../src/core/expr';
import { identityTRS, type DesignDoc, type Feature } from '../src/core/types';

const app = { color: '#fff', material: 'pla' };
const top = (y: number) => ({ origin: [0, y, 0] as [number, number, number], normal: [0, 1, 0] as [number, number, number], xDir: [1, 0, 0] as [number, number, number], label: 'x' });
const doc = (features: Feature[], params?: DesignDoc['params']): DesignDoc => ({ format: 'kimatic', version: 1, name: 't', units: 'mm', features, bodyState: {}, marker: features.length, params });
const vol = (b: any) => computeVolume(b.geometry, b.matrix);
const near = (a: number, b: number, tol = 0.02) => expect(Math.abs(a - b) / b, `${a} vs ${b}`).toBeLessThan(tol);

describe('expressions', () => {
  it('evaluates maths safely', () => {
    expect(evalExpr('2 + 3 * 4')).toBe(14);
    expect(evalExpr('(2 + 3) * 4')).toBe(20);
    expect(evalExpr('2^3^2')).toBe(512);
    expect(evalExpr('-w / 2', { w: 10 })).toBe(-5);
    expect(evalExpr('sqrt(9) + max(1, 4) + 10mm')).toBe(17);
    expect(() => evalExpr('alert(1)')).toThrow();
    expect(() => evalExpr('constructor')).toThrow();
    expect(usesNames('w*2')).toBe(true);
    expect(usesNames('pi*2')).toBe(false);
  });
  it('resolves parameters that reference each other', () => {
    const { vars, errors } = resolveParams([{ name: 'w', expr: '40' }, { name: 'h', expr: 'w / 2' }, { name: 'bad', expr: 'nope + 1' }]);
    expect(vars.h).toBe(20);
    expect(errors.bad).toBeTruthy();
  });
  it('drives feature dimensions', () => {
    const r = evaluate(doc([
      { id: 'b', type: 'primitive', name: 'Box', shape: 'box', params: { width: 1, height: 10, depth: 10 }, exprs: { 'params.width': 'w * 2' }, transform: identityTRS(), op: 'new', targets: [], appearance: app },
    ], [{ name: 'w', expr: '15' }]));
    near(vol(r.bodies[0]), 30 * 10 * 10, 0.001);
  });
});

describe('loft / sweep / split', () => {
  it('lofts a circle into a smaller circle (a frustum)', () => {
    const r = evaluate(doc([
      { id: 's1', type: 'sketch', name: 'a', plane: top(0), visible: true, entities: [{ id: 'c', kind: 'circle', cx: 0, cy: 0, r: 20 }] },
      { id: 's2', type: 'sketch', name: 'b', plane: top(30), visible: true, entities: [{ id: 'c', kind: 'circle', cx: 0, cy: 0, r: 10 }] },
      { id: 'l', type: 'loft', name: 'Loft', sketchIds: ['s1', 's2'], smooth: false, op: 'new', targets: [], transform: identityTRS(), appearance: app },
    ]));
    expect(r.errors).toEqual({});
    near(vol(r.bodies[0]), (Math.PI * 30 / 3) * (400 + 200 + 100));
    expect(checkMesh(r.bodies[0].geometry).openLength).toBeLessThan(0.01);
  });
  it('lofts a square into a circle on a different plane order', () => {
    const r = evaluate(doc([
      { id: 's1', type: 'sketch', name: 'a', plane: top(0), visible: true, entities: [{ id: 'r', kind: 'rect', x: -10, y: -10, w: 20, h: 20 }] },
      { id: 's2', type: 'sketch', name: 'b', plane: top(20), visible: true, entities: [{ id: 'c', kind: 'circle', cx: 0, cy: 0, r: 8 }] },
      { id: 's3', type: 'sketch', name: 'c', plane: top(40), visible: true, entities: [{ id: 'r', kind: 'rect', x: -6, y: -6, w: 12, h: 12, radius: 2 }] },
      { id: 'l', type: 'loft', name: 'Loft', sketchIds: ['s1', 's2', 's3'], smooth: true, op: 'new', targets: [], transform: identityTRS(), appearance: app },
    ]));
    expect(r.errors).toEqual({});
    expect(vol(r.bodies[0])).toBeGreaterThan(4000);
  });
  it('sweeps a circle along a straight path into a cylinder', () => {
    const r = evaluate(doc([
      { id: 'p', type: 'sketch', name: 'profile', plane: top(0), visible: true, entities: [{ id: 'c', kind: 'circle', cx: 0, cy: 0, r: 5 }] },
      { id: 'q', type: 'sketch', name: 'path', plane: { origin: [0, 0, 0], normal: [0, 0, 1], xDir: [1, 0, 0], label: 'f' }, visible: true, entities: [{ id: 'l', kind: 'polyline', points: [[0, 0], [0, 50]], closed: false }] },
      { id: 'w', type: 'sweep', name: 'Sweep', profileId: 'p', pathId: 'q', twist: 0, op: 'new', targets: [], transform: identityTRS(), appearance: app },
    ]));
    expect(r.errors).toEqual({});
    near(vol(r.bodies[0]), Math.PI * 25 * 50, 0.03);
  });
  it('splits a body into two parts whose volumes add up', () => {
    const r = evaluate(doc([
      { id: 'b', type: 'primitive', name: 'Box', shape: 'box', params: { width: 20, height: 40, depth: 20 }, transform: identityTRS(), op: 'new', targets: [], appearance: app },
      { id: 's', type: 'split', name: 'Split', bodyId: 'b', axis: 'y', offset: 10 },
    ]));
    expect(r.bodies).toHaveLength(2);
    const [a, b] = r.bodies.map(vol).sort((x, y) => x - y);
    near(a, 20 * 20 * 10, 0.001);
    near(b, 20 * 20 * 30, 0.001);
  });
});

describe('units in typed values', () => {
  it('converts lengths to millimetres', () => {
    expect(evalExpr('2in')).toBeCloseTo(50.8);
    expect(evalExpr('3/8"')).toBeCloseTo(9.525);
    expect(evalExpr('1.5cm + 2mm')).toBeCloseTo(17);
    expect(evalExpr('0.1m')).toBeCloseTo(100);
    expect(evalExpr('1ft')).toBeCloseTo(304.8);
    expect(evalExpr('45deg')).toBe(45);
    expect(evalExpr('2 * min(1in, 30)')).toBeCloseTo(50.8);
    expect(evalExpr('(1 + 1)in')).toBeCloseTo(50.8);
    expect(evalExpr('1 + 1/2in')).toBeCloseTo(13.7);
    expect(evalExpr('w / 2', { w: 10 })).toBe(5);
  });
});
