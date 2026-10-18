import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { execFileSync } from 'child_process';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { analyzePrint, arrangeOnBed, build3MF, overhangArea, printerById } from '../src/core/printing';
import { evaluate } from '../src/core/evaluator';
import { TEMPLATES } from '../src/core/templates';
import { buildShape } from '../src/core/primitives';

describe('printing', () => {
  it('writes a valid 3MF zip', () => {
    const r = evaluate(TEMPLATES[0].build());
    const data = build3MF(r.bodies.map((b) => ({ name: b.name, geometry: b.geometry, matrix: b.matrix, color: b.appearance.color })));
    const dir = mkdtempSync(join(tmpdir(), '3mf-'));
    const f = join(dir, 'a.3mf');
    writeFileSync(f, data);
    // python's zipfile validates CRCs and structure
    const out = execFileSync('python3', ['-c', `import zipfile,sys;z=zipfile.ZipFile(sys.argv[1]);assert z.testzip() is None;print(','.join(z.namelist()));m=z.read('3D/3dmodel.model').decode();print(m.count('<triangle '), 'unit=\"millimeter\"' in m)`, f]).toString();
    expect(out).toContain('3D/3dmodel.model');
    expect(out).toContain('True');
  });
  it('flags overhangs, floating parts and oversize designs', () => {
    const m = new THREE.Matrix4();
    // a sphere resting on the bed has a big downward-facing lower half
    expect(overhangArea(buildShape('sphere', { radius: 10 }), m)).toBeGreaterThan(50);
    expect(overhangArea(buildShape('box', {}), m)).toBe(0);
    const doc = TEMPLATES.find((t) => t.id === 'snowman')!.build();
    const rep = analyzePrint(evaluate(doc).bodies, printerById('bambu-x1'), { infill: 0.15, walls: 1.2, layer: 0.2 });
    expect(rep.fits).toBe(true);
    // stacked snowballs support each other
    expect(rep.issues.some((i) => i.text.includes('floating'))).toBe(false);
    const lifted = evaluate({ ...doc, features: [{ ...(doc.features[0] as any), transform: { position: [100, 20, 0], rotation: [0, 0, 0], scale: [1, 1, 1] } }], marker: 1 });
    expect(analyzePrint(lifted.bodies, printerById('bambu-x1'), { infill: 0.15, walls: 1.2, layer: 0.2 }).issues.some((i) => i.text.includes('floating'))).toBe(true);
    expect(rep.grams).toBeGreaterThan(1);
    const big = analyzePrint(evaluate(doc).bodies, { id: 'x', name: 'Tiny', x: 20, y: 20, z: 20 }, { infill: 0.15, walls: 1.2, layer: 0.2 });
    expect(big.fits).toBe(false);
  });
  it('arranges parts without overlap inside the bed', () => {
    const boxes = Array.from({ length: 7 }, (_, i) => ({ id: String(i), box: new THREE.Box3(new THREE.Vector3(0, 5, 0), new THREE.Vector3(40, 20, 30)) }));
    const off = arrangeOnBed(boxes, 200);
    const placed = boxes.map((b) => b.box.clone().translate(off.get(b.id)!));
    for (const p of placed) { expect(p.min.y).toBeCloseTo(0); expect(p.max.x).toBeLessThanOrEqual(100.01); expect(p.min.x).toBeGreaterThanOrEqual(-100.01); }
    for (let i = 0; i < placed.length; i++) for (let j = i + 1; j < placed.length; j++) {
      const a = placed[i].clone().expandByScalar(-0.01);
      expect(a.intersectsBox(placed[j]), `${i}-${j}`).toBe(false);
    }
  });
});
