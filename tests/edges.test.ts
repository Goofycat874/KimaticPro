import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { evaluate } from '../src/core/evaluator';
import { featureEdges } from '../src/viewport/edges';
import { identityTRS } from '../src/core/types';

describe('feature edges', () => {
  it('hides boolean seams on flat faces but keeps real edges', () => {
    const app = { color: '#fff', material: 'pla' };
    const r = evaluate({
      format: 'kimatic', version: 1, name: 't', units: 'mm', bodyState: {}, marker: 2,
      features: [
        { id: 'a', type: 'primitive', name: 'Box', shape: 'box', params: { width: 20, height: 10, depth: 20 }, transform: identityTRS(), op: 'new', targets: [], appearance: app },
        { id: 'b', type: 'primitive', name: 'Hole', shape: 'cylinder', params: { radius: 5, height: 30, sides: 32 }, transform: { ...identityTRS(), position: [0, -5, 0] }, op: 'cut', targets: ['a'], appearance: app },
      ],
    });
    const g = r.bodies[0].geometry;
    const pos = featureEdges(g).getAttribute('position');
    // every drawn edge must lie on a real feature: the box outline or a hole rim
    for (let i = 0; i < pos.count; i += 2) {
      const a = new THREE.Vector3().fromBufferAttribute(pos, i);
      const b = new THREE.Vector3().fromBufferAttribute(pos, i + 1);
      const onRim = (v: THREE.Vector3) => Math.abs(Math.hypot(v.x, v.z) - 5) < 0.2;
      const onBoxEdge = (v: THREE.Vector3) => [Math.abs(v.x) > 9.99, Math.abs(v.y) > 4.99, Math.abs(v.z) > 9.99].filter(Boolean).length >= 2;
      expect(onRim(a) && onRim(b) || onBoxEdge(a) && onBoxEdge(b), `${a.toArray()} -> ${b.toArray()}`).toBe(true);
    }
  });
});
