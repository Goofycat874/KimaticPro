import { beforeAll, describe, expect, it } from 'vitest';
import * as R from 'replicad';
import opencascade from 'replicad-opencascadejs';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { runFeatures } from '../src/core/evalCore';
import { brepKernel } from '../src/kernel/brep';
import { projectBodies } from '../src/kernel/projection';
import { layoutSheet, sheetToDXF, sheetToPDF, sheetToSVG, type SheetOptions } from '../src/core/drawingSheet';
import { identityTRS, type DesignDoc, type Feature } from '../src/core/types';

beforeAll(async () => {
  const oc = await (opencascade as any)({ wasmBinary: readFileSync('node_modules/replicad-opencascadejs/dist/replicad_single.wasm') });
  R.setOC(oc);
}, 60_000);

const app = { color: '#888888', material: 'pla' };
const ground = { origin: [0, 0, 0] as [number, number, number], normal: [0, 1, 0] as [number, number, number], xDir: [1, 0, 0] as [number, number, number], label: 'g' };
/** An 80 × 50 × 12 plate with two Ø10 holes and one Ø16 hole. */
const plate = (): DesignDoc => {
  const features: Feature[] = [
    { id: 's', type: 'sketch', name: 'S', plane: ground, visible: false, entities: [
      { id: 'r', kind: 'rect', x: 0, y: 0, w: 80, h: 50 },
      { id: 'h1', kind: 'circle', cx: 15, cy: 25, r: 5 },
      { id: 'h2', kind: 'circle', cx: 65, cy: 25, r: 5 },
      { id: 'h3', kind: 'circle', cx: 40, cy: 25, r: 8 },
    ] },
    { id: 'e', type: 'extrude', name: 'Plate', sketchId: 's', distance: 12, symmetric: false, roundEdges: 0, transform: identityTRS(), op: 'new', targets: [], appearance: app },
  ];
  return { format: 'kimatic', version: 1, name: 'Plate', units: 'mm', features, bodyState: {}, marker: features.length };
};
const opts: SheetOptions = {
  size: 'A4', angle: 'third', views: { front: true, top: true, right: true, iso: true }, hidden: true, dims: true, centerMarks: true,
  scale: 'auto', title: 'Mounting plate', author: 'Test', material: 'PLA', date: '2026-10-18',
};

describe('technical drawings', () => {
  it('projects standard views with hidden lines and exact circles', () => {
    const r = runFeatures(brepKernel, plate());
    const views = projectBodies(r.bodies, ['front', 'top', 'right', 'iso']);
    const size = (k: string) => { const b = views[k].box!; return [b[2] - b[0], b[3] - b[1]].map((v) => Math.round(v * 100) / 100); };
    expect(size('front')).toEqual([80, 12]);
    expect(size('top')).toEqual([80, 50]);
    expect(size('right')).toEqual([50, 12]);
    // from above, the three holes are full circles; from the front they're hidden lines
    const circles = views.top.visible.filter((c) => c.t === 'A' && c.a1 - c.a0 > 6.28);
    expect(circles.length).toBeGreaterThanOrEqual(3);
    expect(views.front.hidden.length).toBeGreaterThan(0);
  });

  it('lays the sheet out and writes SVG, PDF and DXF', () => {
    const r = runFeatures(brepKernel, plate());
    const views = projectBodies(r.bodies, ['front', 'top', 'right', 'iso']);
    const sheet = layoutSheet(views, opts);
    expect(sheet.fits).toBe(true);
    expect(sheet.scale).toBe(1);
    const texts = sheet.prims.filter((p) => p.k === 'text').map((p: any) => p.text);
    expect(texts).toContain('80');
    expect(texts).toContain('12');
    expect(texts).toContain('50');
    expect(texts).toContain('2× Ø10');
    expect(texts).toContain('Ø16');
    const svg = sheetToSVG(sheet);
    expect(svg.startsWith('<svg')).toBe(true);
    const pdf = sheetToPDF(sheet);
    const pdfText = new TextDecoder('latin1').decode(pdf);
    expect(pdfText.startsWith('%PDF-1.4')).toBe(true);
    // the xref table must point at each object
    const xref = Number(/startxref\n(\d+)/.exec(pdfText)![1]);
    expect(pdfText.slice(xref, xref + 4)).toBe('xref');
    const offs = [...pdfText.slice(xref).matchAll(/(\d{10}) 00000 n/g)].map((m) => Number(m[1]));
    offs.forEach((o, i) => expect(pdfText.startsWith(`${i + 1} 0 obj`, o)).toBe(true));
    const dxf = sheetToDXF(layoutSheet(views, { ...opts, frame: false, scale: 1 }));
    expect(dxf).toContain('CIRCLE');
    expect(dxf.trim().endsWith('EOF')).toBe(true);
    mkdirSync('.scratch', { recursive: true });
    writeFileSync('.scratch/plate.svg', svg);
    writeFileSync('.scratch/plate.pdf', pdf);
    writeFileSync('.scratch/plate.dxf', dxf);
  });

  it('first-angle puts the top view below the front view', () => {
    const r = runFeatures(brepKernel, plate());
    const views = projectBodies(r.bodies, ['front', 'top', 'right']);
    const third = layoutSheet(views, { ...opts, views: { ...opts.views, iso: false } });
    const first = layoutSheet(views, { ...opts, angle: 'first', views: { ...opts.views, iso: false } });
    const label = (s: any, t: string) => s.prims.find((p: any) => p.k === 'text' && p.text === t).at;
    expect(label(third, 'TOP')[1]).toBeGreaterThan(label(third, 'FRONT')[1]);
    expect(label(first, 'TOP')[1]).toBeLessThan(label(first, 'FRONT')[1]);
    expect(label(first, 'RIGHT')[0]).toBeLessThan(label(first, 'FRONT')[0]);
  });
});
