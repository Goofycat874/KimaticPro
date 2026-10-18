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

describe('sketches with joined curves and constraints', () => {
  const plane = { origin: [0, 0, 0] as [number, number, number], normal: [0, 1, 0] as [number, number, number], xDir: [1, 0, 0] as [number, number, number], label: 'g' };
  // a D shape: three lines and a half circle, drawn as separate pieces
  const dShape = (): Feature[] => [
    { id: 's', type: 'sketch', name: 'S', plane, visible: true, entities: [
      { id: 'l', kind: 'polyline', points: [[10, 10], [0, 10], [0, 0], [10, 0]], closed: false },
      { id: 'a', kind: 'arc', cx: 10, cy: 5, x1: 10, y1: 0, x2: 10, y2: 10 },
    ] },
    { id: 'e', type: 'extrude', name: 'E', sketchId: 's', distance: 4, symmetric: false, roundEdges: 0, transform: identityTRS(), op: 'new', targets: [], appearance: app },
  ];
  it('extrudes lines + an arc exactly, matching the preview', () => {
    const want = (100 + (Math.PI * 25) / 2) * 4;
    const b = runFeatures(brepKernel, doc(dShape()));
    expect(b.errors).toEqual({});
    expect(b.bodies[0].solid.kind).toBe('brep');
    expect(Math.abs(bvol(b.bodies[0]) - want)).toBeLessThan(1e-3);
    const m = runFeatures(meshKernel, doc(dShape()));
    expect(Math.abs(computeVolume(m.bodies[0].solid, m.bodies[0].matrix) - want) / want).toBeLessThan(0.01);
  });

  it('re-solves a sketch when a parameter drives a dimension', () => {
    const fs = dShape();
    (fs[0] as any).constraints = [
      { id: 'h1', type: 'horizontal', refs: [{ e: 'l', s: 0 }] },
      { id: 'v1', type: 'vertical', refs: [{ e: 'l', s: 1 }] },
      { id: 'h2', type: 'horizontal', refs: [{ e: 'l', s: 2 }] },
      { id: 'j1', type: 'coincident', refs: [{ e: 'a', p: 1 }, { e: 'l', p: 3 }] },
      { id: 'j2', type: 'coincident', refs: [{ e: 'a', p: 2 }, { e: 'l', p: 0 }] },
      { id: 'w', type: 'distance', refs: [{ e: 'l', s: 1 }], value: 10, expr: 'h' },
    ];
    const d = { ...doc(fs), params: [{ name: 'h', expr: '20' }] };
    const b = runFeatures(brepKernel, d);
    expect(b.errors).toEqual({});
    const bb = brepKernel.bounds(b.bodies[0]);
    // the straight side is now 20 long, and the arc grew to match (radius 10)
    expect(Math.round((bb.max.z - bb.min.z) * 1000) / 1000).toBe(20);
  });
});

describe('exact mass properties', () => {
  it('matches the textbook box: mass, centre and inertia, combined across bodies', async () => {
    const { massProperties } = await import('../src/kernel/massProps');
    const box = (id: string, x: number): Feature => ({ id, type: 'primitive', name: id, shape: 'box', params: { width: 10, height: 20, depth: 30, round: 0 }, transform: { ...identityTRS(), position: [x, 0, 0] }, op: 'new', targets: [], appearance: app });
    const r = runFeatures(brepKernel, doc([box('a', 0)]));
    const b = r.bodies[0];
    const p = massProperties([{ name: 'a', solid: b.solid, matrix: b.matrix, material: 'pla' }]);
    const m = 6000 * 1.24 / 1000;
    expect(p.volume).toBeCloseTo(6000, 3);
    expect(p.mass).toBeCloseTo(m, 6);
    expect(p.center[1]).toBeCloseTo(10, 6); // boxes sit on the ground
    expect(p.inertia[0][0]).toBeCloseTo((m / 12) * (20 ** 2 + 30 ** 2), 3);
    expect(p.inertia[1][1]).toBeCloseTo((m / 12) * (10 ** 2 + 30 ** 2), 3);
    expect(p.principal[0]).toBeCloseTo((m / 12) * (10 ** 2 + 20 ** 2), 3);
    // two boxes 40 mm apart: parallel axis theorem about the shared centre
    const two = runFeatures(brepKernel, doc([box('a', -20), box('b', 20)]));
    const q = massProperties(two.bodies.map((x) => ({ name: x.name, solid: x.solid, matrix: x.matrix, material: 'pla' })));
    expect(q.center[0]).toBeCloseTo(0, 6);
    expect(q.inertia[1][1]).toBeCloseTo(2 * ((m / 12) * (10 ** 2 + 30 ** 2) + m * 400), 2);
  });
});

describe('hole tool', () => {
  const box: Feature = { id: 'b', type: 'primitive', name: 'Box', shape: 'box', params: { width: 20, height: 20, depth: 20, round: 0 }, transform: identityTRS(), op: 'new', targets: [], appearance: app };
  const hole = (extra: any): Feature => ({ id: 'h', type: 'hole', name: 'Hole', bodyId: 'b', at: [0, 20, 0], normal: [0, 1, 0], kind: 'simple', diameter: 3.4, depth: 0, cbDiameter: 6.5, cbDepth: 3.4, csDiameter: 6.7, csAngle: 90, drillPoint: true, ...extra } as Feature);
  const vols = (f: Feature) => {
    const m = runFeatures(meshKernel, doc([box, f])), b = runFeatures(brepKernel, doc([box, f]));
    expect(b.errors).toEqual({});
    return [computeVolume(m.bodies[0].solid as any, m.bodies[0].matrix), bvol(b.bodies[0])];
  };
  it('drills through, counterbores and countersinks exactly', () => {
    const r = 1.7;
    const [m1, b1] = vols(hole({}));
    expect(b1).toBeCloseTo(8000 - Math.PI * r * r * 20, 2);
    expect(Math.abs(m1 - b1) / b1).toBeLessThan(0.01);
    const [, b2] = vols(hole({ kind: 'counterbore' }));
    expect(b2).toBeCloseTo(8000 - Math.PI * r * r * (20 - 3.4) - Math.PI * 3.25 * 3.25 * 3.4, 2);
    const [, b3] = vols(hole({ kind: 'countersink' }));
    expect(b3).toBeLessThan(b1);
    // a blind hole with a drill point removes a cone at the bottom
    const [, b4] = vols(hole({ depth: 8 }));
    const tip = r * Math.tan((31 * Math.PI) / 180);
    expect(b4).toBeCloseTo(8000 - Math.PI * r * r * 8 - (Math.PI * r * r * tip) / 3, 2);
  });
});
