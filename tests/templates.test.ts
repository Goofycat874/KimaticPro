import { describe, expect, it } from 'vitest';
import { evaluate } from '../src/core/evaluator';
import { computeVolume } from '../src/core/geometry';
import { TEMPLATES } from '../src/core/templates';

describe('templates', () => {
  for (const t of TEMPLATES) {
    it(`${t.name} evaluates cleanly`, () => {
      const r = evaluate(t.build());
      expect(r.errors).toEqual({});
      expect(r.bodies.length).toBeGreaterThan(0);
      for (const b of r.bodies) expect(computeVolume(b.geometry, b.matrix), b.name).toBeGreaterThan(0);
    });
  }
});

describe('template geometry', () => {
  it('cuts leave no stray tool geometry behind', () => {
    for (const t of TEMPLATES) {
      const doc = t.build();
      const r = evaluate(doc);
      for (const b of r.bodies) {
        b.geometry.computeBoundingBox();
        const bb = b.geometry.boundingBox!.clone().applyMatrix4(b.matrix);
        expect(bb.max.y, `${t.name}/${b.name}`).toBeLessThan(120);
      }
    }
    const mug = evaluate(TEMPLATES.find((t) => t.id === 'mug')!.build()).bodies[0];
    mug.geometry.computeBoundingBox();
    expect(mug.geometry.boundingBox!.clone().applyMatrix4(mug.matrix).max.y).toBeCloseTo(90, 3);
  });
});
