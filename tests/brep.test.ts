import { beforeAll, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import * as R from 'replicad';
import opencascade from 'replicad-opencascadejs';
import { readFileSync } from 'fs';
import { runFeatures } from '../src/core/evalCore';
import { meshKernel } from '../src/core/meshKernel';
import { brepKernel, solidGeometry, exportStep, importStepText, type BSolid } from '../src/kernel/brep';
import { computeVolume } from '../src/core/geometry';
import { SHAPES } from '../src/core/primitives';
import { TEMPLATES } from '../src/core/templates';
import { identityTRS, type DesignDoc, type Feature } from '../src/core/types';

beforeAll(async () => {
  const oc = await (opencascade as any)({ wasmBinary: readFileSync('node_modules/replicad-opencascadejs/dist/replicad_single.wasm') });
  R.setOC(oc);
}, 60_000);

const app = { color: '#888888', material: 'pla' };
const doc = (features: Feature[]): DesignDoc => ({ format: 'kimatic', version: 1, name: 't', units: 'mm', features, bodyState: {}, marker: features.length });
const bvol = (b: { solid: BSolid; key: string; matrix: THREE.Matrix4 }) =>
  b.solid.kind === 'brep' ? R.measureVolume(b.solid.shape) * Math.abs(b.matrix.determinant()) : computeVolume(b.solid.geo, b.matrix);
const box = (bb: THREE.Box3) => [...bb.min.toArray(), ...bb.max.toArray()].map((v) => Math.round(v * 10) / 10);

describe('precise kernel matches the preview kernel', () => {
  for (const s of SHAPES) {
    it(`shape: ${s.id}`, () => {
      const d = doc([{ id: 'a', type: 'primitive', name: s.label, shape: s.id, params: {}, transform: { ...identityTRS(), position: [5, 2, -3], rotation: [10, 20, 30] }, op: 'new', targets: [], appearance: app }]);
      const m = runFeatures(meshKernel, d), b = runFeatures(brepKernel, d);
      expect(b.errors).toEqual({});
      const mb = meshKernel.bounds(m.bodies[0]), bb = brepKernel.bounds(b.bodies[0]);
      // tessellation makes the mesh slightly smaller on curves
      for (let i = 0; i < 6; i++) expect(Math.abs(box(mb)[i] - box(bb)[i]), `${s.id} bounds ${box(mb)} vs ${box(bb)}`).toBeLessThan(Math.max(0.6, mb.getSize(new THREE.Vector3()).length() * 0.02));
      const mv = computeVolume(m.bodies[0].solid, m.bodies[0].matrix), bv = bvol(b.bodies[0]);
      expect(Math.abs(mv - bv) / bv, `${s.id} volume ${mv} vs ${bv}`).toBeLessThan(0.04);
    }, 30_000);
  }

  for (const t of TEMPLATES) {
    it(`template: ${t.name}`, () => {
      const d = t.build();
      const m = runFeatures(meshKernel, d), b = runFeatures(brepKernel, d);
      expect(b.errors).toEqual({});
      expect(b.bodies.map((x) => x.id)).toEqual(m.bodies.map((x) => x.id));
      for (let i = 0; i < m.bodies.length; i++) {
        const mv = computeVolume(m.bodies[i].solid, m.bodies[i].matrix), bv = bvol(b.bodies[i]);
        // spline sweeps: the preview uses a Catmull-Rom path, the precise kernel a B-spline through the same points
        const tol = d.features.some((f) => f.type === 'sweep') ? 0.15 : 0.05;
        expect(Math.abs(mv - bv) / bv, `${t.id}/${m.bodies[i].name} ${mv} vs ${bv}`).toBeLessThan(tol);
      }
    }, 60_000);
  }
});

describe('precise-only features', () => {
  const base: Feature = { id: 'b', type: 'primitive', name: 'Box', shape: 'box', params: { width: 20, height: 20, depth: 20 }, transform: identityTRS(), op: 'new', targets: [], appearance: app };
  it('fillets one picked edge', () => {
    // the top-front edge of the box runs along X at y = 20, z = 10
    const r = runFeatures(brepKernel, doc([base, { id: 'f', type: 'fillet', name: 'Fillet', bodyId: 'b', mode: 'fillet', edges: [[3, 20, 10]], radius: 4 }]));
    expect(r.errors).toEqual({});
    expect(bvol(r.bodies[0])).toBeCloseTo(8000 - (16 - 4 * Math.PI) * 20, 1);
  });
  it('chamfers every edge when none are picked', () => {
    const r = runFeatures(brepKernel, doc([base, { id: 'f', type: 'fillet', name: 'Chamfer', bodyId: 'b', mode: 'chamfer', edges: [], radius: 1 }]));
    expect(r.errors).toEqual({});
    expect(bvol(r.bodies[0])).toBeLessThan(8000 - 12 * 20 * 0.4);
  });
  it('shells through the picked face (and the top by default)', () => {
    const picked = runFeatures(brepKernel, doc([base, { id: 's', type: 'shell', name: 'Shell', bodyId: 'b', faces: [[0, 20, 0]], thickness: 2 }]));
    expect(bvol(picked.bodies[0])).toBeCloseTo(8000 - 16 * 16 * 18, 1);
    const auto = runFeatures(brepKernel, doc([base, { id: 's', type: 'shell', name: 'Shell', bodyId: 'b', faces: [], thickness: 2 }]));
    expect(bvol(auto.bodies[0])).toBeCloseTo(8000 - 16 * 16 * 18, 1);
  });
  it('the preview kernel passes fillets through untouched', () => {
    const r = runFeatures(meshKernel, doc([base, { id: 'f', type: 'fillet', name: 'Fillet', bodyId: 'b', mode: 'fillet', edges: [], radius: 2 }]));
    expect(r.errors).toEqual({});
    expect(computeVolume(r.bodies[0].solid, r.bodies[0].matrix)).toBeCloseTo(8000, 1);
  });
  it('round-trips STEP', async () => {
    const r = runFeatures(brepKernel, doc([base, { id: 'f', type: 'fillet', name: 'Fillet', bodyId: 'b', mode: 'fillet', edges: [], radius: 2 }]));
    const { blob } = exportStep(r.bodies.map((b) => ({ name: b.name, color: '#ff0000', solid: b.solid, matrix: b.matrix })));
    const text = await blob!.text();
    expect(text).toContain('ISO-10303-21');
    const back = importStepText(text)!;
    expect(R.measureVolume(back)).toBeCloseTo(bvol(r.bodies[0]), 0);
    const bb = back.boundingBox.bounds;
    expect(bb[0][1]).toBeCloseTo(0, 3);
    expect(bb[1][1]).toBeCloseTo(20, 3);
  });
  it('meshes for display', () => {
    const r = runFeatures(brepKernel, doc([base]));
    const g = solidGeometry(r.bodies[0].solid, r.bodies[0].key);
    expect(g.getAttribute('position').count).toBeGreaterThan(8);
  });
});
