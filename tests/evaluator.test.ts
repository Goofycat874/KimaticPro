import { describe, expect, it } from 'vitest';
import { evaluate } from '../src/core/evaluator';
import { computeVolume } from '../src/core/geometry';
import { SHAPES, buildShape } from '../src/core/primitives';
import { sketchProfiles } from '../src/core/sketch';
import type { DesignDoc, Feature } from '../src/core/types';
import { identityTRS } from '../src/core/types';

const app = { color: '#3b82f6', material: 'pla' };
const doc = (features: Feature[]): DesignDoc => ({
  format: 'kimatic', version: 1, name: 't', units: 'mm', features, bodyState: {}, marker: features.length,
});
const vol = (b: { geometry: any; matrix: any }) => computeVolume(b.geometry, b.matrix);

describe('primitives', () => {
  it('every shape builds a non-empty geometry resting on the ground', () => {
    for (const s of SHAPES) {
      const g = buildShape(s.id, {});
      g.computeBoundingBox();
      expect(g.getAttribute('position').count, s.id).toBeGreaterThan(0);
      expect(g.boundingBox!.min.y, s.id).toBeCloseTo(0, 3);
    }
  });
  it('box volume is exact', () => {
    expect(computeVolume(buildShape('box', { width: 10, height: 20, depth: 30 }))).toBeCloseTo(6000, 3);
  });
});

describe('evaluator', () => {
  it('cuts a hole through a box', () => {
    const r = evaluate(doc([
      { id: 'a', type: 'primitive', name: 'Box', shape: 'box', params: { width: 20, height: 10, depth: 20 }, transform: identityTRS(), op: 'new', targets: [], appearance: app },
      { id: 'b', type: 'primitive', name: 'Hole', shape: 'cylinder', params: { radius: 5, height: 30, sides: 128 }, transform: { ...identityTRS(), position: [0, -5, 0] }, op: 'cut', targets: ['a'], appearance: app },
    ]));
    expect(r.bodies).toHaveLength(1);
    expect(r.ghosts).toHaveLength(1);
    const expected = 20 * 10 * 20 - Math.PI * 25 * 10;
    expect(Math.abs(vol(r.bodies[0]) - expected) / expected).toBeLessThan(0.01);
  });

  it('joins and patterns', () => {
    const r = evaluate(doc([
      { id: 'a', type: 'primitive', name: 'Box', shape: 'box', params: { width: 10, height: 10, depth: 10 }, transform: identityTRS(), op: 'new', targets: [], appearance: app },
      { id: 'p', type: 'pattern', name: 'Pattern', bodyIds: ['a'], kind: 'linear', count: 4, spacing: 20, direction: 'x', angle: 360, axis: 'y', center: [0, 0, 0] },
      { id: 'm', type: 'mirror', name: 'Mirror', bodyIds: ['a'], plane: 'yz', offset: -20 },
    ]));
    expect(r.bodies).toHaveLength(5);
    for (const b of r.bodies) expect(vol(b)).toBeCloseTo(1000, 1);
  });

  it('extrudes a sketch with a hole (washer) and revolves', () => {
    const sketch: Feature = {
      id: 's', type: 'sketch', name: 'Sketch', visible: true,
      plane: { origin: [0, 0, 0], normal: [0, 1, 0], xDir: [1, 0, 0], label: 'top' },
      entities: [
        { id: 'c1', kind: 'circle', cx: 0, cy: 0, r: 10 },
        { id: 'c2', kind: 'circle', cx: 0, cy: 0, r: 5 },
      ],
    };
    expect(sketchProfiles((sketch as any).entities)).toHaveLength(1);
    const r = evaluate(doc([
      sketch,
      { id: 'e', type: 'extrude', name: 'Extrude', sketchId: 's', distance: 10, symmetric: false, roundEdges: 0, op: 'new', targets: [], transform: identityTRS(), appearance: app },
    ]));
    const expected = Math.PI * (100 - 25) * 10;
    expect(Math.abs(vol(r.bodies[0]) - expected) / expected).toBeLessThan(0.01);

    const rev = evaluate(doc([
      { ...sketch, entities: [{ id: 'r', kind: 'rect', x: 5, y: 0, w: 5, h: 10 }] } as Feature,
      { id: 'v', type: 'revolve', name: 'Revolve', sketchId: 's', axis: 'y', angle: 180, op: 'new', targets: [], transform: identityTRS(), appearance: app },
    ]));
    const half = (Math.PI * (100 - 25) * 10) / 2;
    expect(Math.abs(vol(rev.bodies[0]) - half) / half).toBeLessThan(0.02);
  });
});
