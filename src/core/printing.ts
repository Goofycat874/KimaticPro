import * as THREE from 'three';
import { bodyBounds, type EvalBody } from './evaluator';
import { checkMesh } from './meshcheck';
import { computeArea, computeVolume } from './geometry';
import { materialById } from './materials';

export interface Printer {
  id: string;
  name: string;
  /** Build volume in mm: x = width, y = height, z = depth (Y-up, like the viewport). */
  x: number;
  y: number;
  z: number;
}

export const PRINTERS: Printer[] = [
  { id: 'bambu-x1', name: 'Bambu Lab X1 / P1 / A1', x: 256, y: 256, z: 256 },
  { id: 'bambu-a1mini', name: 'Bambu Lab A1 mini', x: 180, y: 180, z: 180 },
  { id: 'prusa-mk4', name: 'Prusa MK4 / MK3S', x: 250, y: 220, z: 210 },
  { id: 'prusa-mini', name: 'Prusa MINI', x: 180, y: 180, z: 180 },
  { id: 'ender3', name: 'Creality Ender 3 (V2/V3)', x: 220, y: 250, z: 220 },
  { id: 'k1', name: 'Creality K1 / K1C', x: 220, y: 250, z: 220 },
  { id: 'voron', name: 'Voron 2.4 (350)', x: 350, y: 340, z: 350 },
  { id: 'resin', name: 'Resin (Elegoo Mars class)', x: 143, y: 175, z: 89 },
];

export const printerById = (id: string) => PRINTERS.find((p) => p.id === id) ?? PRINTERS[0];

export interface PrintSettings {
  infill: number; // 0..1
  walls: number; // mm of shell thickness
  layer: number; // mm
}

export interface BodyPrintReport {
  id: string;
  name: string;
  size: THREE.Vector3;
  floating: boolean;
  belowBed: boolean;
  openLength: number;
  overhangArea: number;
  volume: number;
}

export interface PrintReport {
  bodies: BodyPrintReport[];
  fits: boolean;
  extent: THREE.Box3;
  grams: number;
  meters: number;
  hours: number;
  issues: { level: 'ok' | 'warn' | 'bad'; text: string }[];
}

/** Faces pointing down more steeply than 45°, above the bed (they need support). */
export function overhangArea(geo: THREE.BufferGeometry, matrix: THREE.Matrix4) {
  const pos = geo.getAttribute('position');
  const idx = geo.index;
  const n = (idx ? idx.count : pos.count) / 3;
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const tri = new THREE.Triangle();
  const normal = new THREE.Vector3();
  let area = 0;
  for (let t = 0; t < n; t++) {
    a.fromBufferAttribute(pos, idx ? idx.getX(t * 3) : t * 3).applyMatrix4(matrix);
    b.fromBufferAttribute(pos, idx ? idx.getX(t * 3 + 1) : t * 3 + 1).applyMatrix4(matrix);
    c.fromBufferAttribute(pos, idx ? idx.getX(t * 3 + 2) : t * 3 + 2).applyMatrix4(matrix);
    tri.set(a, b, c);
    tri.getNormal(normal);
    if (normal.y < -0.7072 && Math.min(a.y, b.y, c.y) > 0.3) area += tri.getArea();
  }
  return area;
}

export function analyzePrint(bodies: EvalBody[], printer: Printer, s: PrintSettings): PrintReport {
  const reports: BodyPrintReport[] = [];
  const extent = new THREE.Box3();
  const boxes = new Map(bodies.filter((b) => b.visible).map((b) => [b.id, bodyBounds(b)]));
  // a part resting on (or overlapping) a lower part is supported — slicers merge overlapping parts
  const supported = (id: string, bb: THREE.Box3) => [...boxes].some(([other, ob]) =>
    other !== id && ob.min.y < bb.min.y - 0.01 && ob.clone().expandByScalar(0.05).intersectsBox(bb));
  let grams = 0, used = 0;
  for (const b of bodies) {
    if (!b.visible) continue;
    const bb = bodyBounds(b);
    extent.union(bb);
    const volume = computeVolume(b.geometry, b.matrix);
    const area = computeArea(b.geometry, b.matrix);
    const shell = Math.min(volume, area * s.walls * 0.5);
    const solid = shell + (volume - shell) * s.infill;
    used += solid;
    grams += (solid / 1000) * materialById(b.appearance.material).density;
    reports.push({
      id: b.id, name: b.name, size: bb.getSize(new THREE.Vector3()), volume,
      floating: bb.min.y > 0.05 && !supported(b.id, bb), belowBed: bb.min.y < -0.05,
      openLength: checkMesh(b.geometry, b.matrix).openLength,
      overhangArea: overhangArea(b.geometry, b.matrix),
    });
  }
  const size = extent.isEmpty() ? new THREE.Vector3() : extent.getSize(new THREE.Vector3());
  // the bed is centred on the origin
  const fits = extent.isEmpty() || (
    extent.min.x >= -printer.x / 2 - 0.01 && extent.max.x <= printer.x / 2 + 0.01 &&
    extent.min.z >= -printer.z / 2 - 0.01 && extent.max.z <= printer.z / 2 + 0.01 &&
    extent.max.y <= printer.y + 0.01
  );
  const issues: PrintReport['issues'] = [];
  if (!reports.length) issues.push({ level: 'bad', text: 'Nothing to print yet — add a shape first.' });
  if (!fits) {
    const tooBig = size.x > printer.x || size.z > printer.z || size.y > printer.y;
    issues.push({ level: 'bad', text: tooBig
      ? `Too big for the ${printer.name} (${printer.x}×${printer.z}×${printer.y} mm). Scale it down or split it.`
      : 'Some parts hang off the bed. Use “Arrange on bed” to fit them.' });
  }
  for (const r of reports) {
    if (r.belowBed) issues.push({ level: 'bad', text: `${r.name} goes below the bed. Use “Drop to bed”.` });
    else if (r.floating) issues.push({ level: 'warn', text: `${r.name} is floating above the bed. Use “Drop to bed” unless it sits on another part.` });
    if (r.openLength > 0.5) issues.push({ level: 'warn', text: `${r.name} has small gaps (${r.openLength.toFixed(1)} mm of open edges). Most slicers repair this automatically.` });
    if (r.overhangArea > 25) issues.push({ level: 'warn', text: `${r.name} has ${(r.overhangArea / 100).toFixed(1)} cm² of steep overhangs (shown red). Try “Lay flat” on another face, or enable supports.` });
  }
  if (reports.length && issues.every((i) => i.level === 'ok')) issues.push({ level: 'ok', text: 'Looks printable! Export it and slice away.' });
  const meters = used / (Math.PI * 0.875 * 0.875) / 1000; // 1.75 mm filament
  // rough: ~12 mm³/s average volumetric flow on a modern printer, plus travel overhead
  const hours = used / 12 / 3600 * 1.35 * (0.2 / Math.max(0.05, s.layer)) ** 0.35;
  return { bodies: reports, fits, extent, grams, meters, hours, issues };
}

/**
 * Packs bodies onto the bed in rows (largest first), centred on the origin.
 * Returns the world offset to apply to each body.
 */
export function arrangeOnBed(boxes: { id: string; box: THREE.Box3 }[], bedX: number, gap = 6) {
  const items = boxes.map((b) => ({ ...b, size: b.box.getSize(new THREE.Vector3()) }))
    .sort((a, b) => b.size.z - a.size.z || b.size.x - a.size.x);
  const rows: { items: typeof items; width: number; depth: number }[] = [];
  let row = { items: [] as typeof items, width: 0, depth: 0 };
  for (const it of items) {
    const w = it.size.x + (row.items.length ? gap : 0);
    if (row.items.length && row.width + w > bedX) { rows.push(row); row = { items: [], width: 0, depth: 0 }; }
    row.width += it.size.x + (row.items.length ? gap : 0);
    row.depth = Math.max(row.depth, it.size.z);
    row.items.push(it);
  }
  if (row.items.length) rows.push(row);
  const totalDepth = rows.reduce((s, r) => s + r.depth, 0) + gap * Math.max(0, rows.length - 1);
  const offsets = new Map<string, THREE.Vector3>();
  let z = -totalDepth / 2;
  for (const r of rows) {
    let x = -r.width / 2;
    for (const it of r.items) {
      const target = new THREE.Vector3(x + it.size.x / 2, 0, z + r.depth / 2);
      const c = it.box.getCenter(new THREE.Vector3());
      offsets.set(it.id, new THREE.Vector3(target.x - c.x, -it.box.min.y, target.z - c.z));
      x += it.size.x + gap;
    }
    z += r.depth + gap;
  }
  return offsets;
}

// ---------------------------------------------------------------------------
// 3MF — the modern slicer format: real units, multiple objects, colours.

const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(data: Uint8Array) {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = crcTable[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Minimal ZIP writer (stored, no compression) — all a 3MF package needs. */
export function zip(files: { name: string; data: Uint8Array }[]): Uint8Array {
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name);
    const crc = crc32(f.data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(8, 0, true); // stored
    local.setUint32(14, crc, true);
    local.setUint32(18, f.data.length, true);
    local.setUint32(22, f.data.length, true);
    local.setUint16(26, name.length, true);
    chunks.push(new Uint8Array(local.buffer), name, f.data);
    const cen = new DataView(new ArrayBuffer(46));
    cen.setUint32(0, 0x02014b50, true);
    cen.setUint16(4, 20, true);
    cen.setUint16(6, 20, true);
    cen.setUint32(16, crc, true);
    cen.setUint32(20, f.data.length, true);
    cen.setUint32(24, f.data.length, true);
    cen.setUint16(28, name.length, true);
    cen.setUint32(42, offset, true);
    central.push(new Uint8Array(cen.buffer), name);
    offset += 30 + name.length + f.data.length;
  }
  const cenSize = central.reduce((s, c) => s + c.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, cenSize, true);
  end.setUint32(16, offset, true);
  const all = [...chunks, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(all.reduce((s, c) => s + c.length, 0));
  let p = 0;
  for (const c of all) { out.set(c, p); p += c.length; }
  return out;
}

const xmlEscape = (s: string) => s.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]!);

/** Builds a .3mf (Z-up, millimetres) with one object per body and its colour. */
export function build3MF(bodies: { name: string; geometry: THREE.BufferGeometry; matrix: THREE.Matrix4; color: string }[]): Uint8Array {
  const fmt = (v: number) => (Math.round(v * 1e5) / 1e5).toString();
  const mats = bodies.map((b, i) => `<base name="${xmlEscape(b.name || `Body ${i + 1}`)}" displaycolor="${b.color.toUpperCase()}FF"/>`).join('');
  const objects: string[] = [];
  const items: string[] = [];
  const v = new THREE.Vector3();
  bodies.forEach((b, i) => {
    const pos = b.geometry.getAttribute('position');
    const idx = b.geometry.index;
    // weld exact duplicates so slicers see a connected mesh
    const map = new Map<string, number>();
    const verts: string[] = [];
    const remap: number[] = [];
    for (let k = 0; k < pos.count; k++) {
      v.fromBufferAttribute(pos, k).applyMatrix4(b.matrix);
      // Y-up → Z-up
      const x = fmt(v.x), y = fmt(-v.z), z = fmt(v.y);
      const key = `${x},${y},${z}`;
      let id = map.get(key);
      if (id === undefined) { id = verts.length; map.set(key, id); verts.push(`<vertex x="${x}" y="${y}" z="${z}"/>`); }
      remap.push(id);
    }
    const tris: string[] = [];
    const n = idx ? idx.count : pos.count;
    for (let k = 0; k < n; k += 3) {
      const a = remap[idx ? idx.getX(k) : k], bb = remap[idx ? idx.getX(k + 1) : k + 1], c = remap[idx ? idx.getX(k + 2) : k + 2];
      if (a === bb || bb === c || a === c) continue;
      tris.push(`<triangle v1="${a}" v2="${bb}" v3="${c}"/>`);
    }
    const id = i + 2;
    objects.push(`<object id="${id}" name="${xmlEscape(b.name || `Body ${i + 1}`)}" type="model" pid="1" pindex="${i}"><mesh><vertices>${verts.join('')}</vertices><triangles>${tris.join('')}</triangles></mesh></object>`);
    items.push(`<item objectid="${id}"/>`);
  });
  const model = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
<metadata name="Application">KimaticPro</metadata>
<resources><basematerials id="1">${mats}</basematerials>${objects.join('')}</resources>
<build>${items.join('')}</build>
</model>`;
  const types = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>`;
  const rels = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>`;
  const enc = new TextEncoder();
  return zip([
    { name: '[Content_Types].xml', data: enc.encode(types) },
    { name: '_rels/.rels', data: enc.encode(rels) },
    { name: '3D/3dmodel.model', data: enc.encode(model) },
  ]);
}

/** Rotation that turns world-space `normal` to point straight down (onto the bed). */
export function layFlatQuaternion(normal: THREE.Vector3) {
  return new THREE.Quaternion().setFromUnitVectors(normal.clone().normalize(), new THREE.Vector3(0, -1, 0));
}
