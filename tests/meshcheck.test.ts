import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { checkMesh } from '../src/core/meshcheck';
import { evaluate } from '../src/core/evaluator';
import { TEMPLATES } from '../src/core/templates';
import { SHAPES, buildShape } from '../src/core/primitives';

describe('mesh check', () => {
  it('flags an open mesh', () => {
    const g = new THREE.PlaneGeometry(10, 10);
    expect(checkMesh(g).openLength).toBeCloseTo(40, 3);
  });
  it('shapes are watertight', () => {
    const open: Record<string, number> = {};
    for (const s of SHAPES) {
      const r = checkMesh(buildShape(s.id, {}));
      if (r.openLength > 0.5) open[s.id] = +r.openLength.toFixed(2);
    }
    // the spring is an open tube by construction
    expect(Object.keys(open).filter((k) => k !== 'spring')).toEqual([]);
  });
  it('metric nuts and bolts are watertight from M2 to M20', () => {
    const sizes: [number, number][] = [[2, 0.4], [3, 0.5], [4, 0.7], [6, 1], [8, 1.25], [12, 1.75], [20, 2.5]];
    for (const [d, pitch] of sizes) {
      expect(checkMesh(buildShape('nut', { diameter: d, pitch, width: d * 1.6, height: d * 0.8 })).openLength, `nut M${d}`).toBeLessThan(0.5);
      expect(checkMesh(buildShape('bolt', { diameter: d, pitch, headWidth: d * 1.6, headHeight: d * 0.7, length: d * 2.5 })).openLength, `bolt M${d}`).toBeLessThan(0.5);
    }
  });
  it('template bodies are watertight', () => {
    const bad: string[] = [];
    for (const t of TEMPLATES) {
      for (const b of evaluate(t.build()).bodies) {
        const r = checkMesh(b.geometry, b.matrix);
        if (r.openLength > 0.5) bad.push(`${t.id}/${b.name}: ${r.openLength.toFixed(2)}mm`);
      }
    }
    expect(bad).toEqual([]);
  });
});
