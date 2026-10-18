/// <reference lib="webworker" />
import * as R from 'replicad';
import opencascade from 'replicad-opencascadejs';
import wasmUrl from 'replicad-opencascadejs/wasm?url';
import { runFeatures, type CoreResult } from '../core/evalCore';
import { brepKernel, exportStep, importStepText, solidGeometry, type BSolid } from './brep';
import type { BodyPayload, EvalPayload, GhostPayload, MeshPayload, PropsPayload, Request } from './protocol';
import { encodePositions } from '../core/geometry';
import type { DesignDoc } from '../core/types';

// Runs OpenCascade off the main thread so the interface never stalls on heavy geometry.

let ready: Promise<void> | null = null;
const init = () => (ready ??= (opencascade as any)({ locateFile: () => wasmUrl }).then((oc: any) => { R.setOC(oc); }));

// meshing is the expensive part of a display update, so it's cached per solid
const meshes = new Map<string, MeshPayload>();

function meshOf(solid: BSolid, key: string): MeshPayload {
  const hit = meshes.get(key);
  if (hit) return hit;
  const geo = solidGeometry(solid, key);
  const out: MeshPayload = {
    key,
    precise: solid.kind === 'brep',
    positions: geo.getAttribute('position').array as Float32Array,
    normals: (geo.getAttribute('normal')?.array as Float32Array) ?? null,
    index: geo.index ? new Uint32Array(geo.index.array) : null,
    edges: null,
    edgeIds: null,
    triFace: null,
  };
  if (solid.kind === 'brep') {
    const bb = solid.shape.boundingBox;
    const diag = Math.hypot(bb.width, bb.height, bb.depth) || 1;
    const opts = { tolerance: Math.min(0.05, Math.max(0.005, diag * 0.0005)), angularTolerance: 12 };
    const faces = solid.shape.mesh(opts).faceGroups;
    const triFace = new Int32Array((out.index?.length ?? 0) / 3);
    for (const g of faces) for (let t = g.start / 3; t < (g.start + g.count) / 3; t++) triFace[t] = g.faceId;
    out.triFace = triFace;
    const e = solid.shape.meshEdges(opts);
    // polyline per edge → line segments, remembering which edge each came from
    const seg: number[] = [], ids: number[] = [];
    for (const g of e.edgeGroups) {
      for (let i = g.start; i < g.start + g.count - 1; i++) {
        seg.push(e.lines[i * 3], e.lines[i * 3 + 1], e.lines[i * 3 + 2], e.lines[(i + 1) * 3], e.lines[(i + 1) * 3 + 1], e.lines[(i + 1) * 3 + 2]);
        ids.push(g.edgeId);
      }
    }
    out.edges = new Float32Array(seg);
    out.edgeIds = new Int32Array(ids);
  }
  meshes.set(key, out);
  if (meshes.size > 300) meshes.delete(meshes.keys().next().value!);
  return out;
}

let last: { doc: DesignDoc; result: CoreResult<BSolid> } | null = null;

function evaluateDoc(doc: DesignDoc) {
  if (last && last.doc === doc) return last.result;
  const result = runFeatures(brepKernel, doc);
  last = { doc, result };
  return result;
}

async function handle(req: Request): Promise<any> {
  await init();
  switch (req.type) {
    case 'init':
      return true;
    case 'eval': {
      const t0 = performance.now();
      const r = evaluateDoc(req.doc);
      const bodies: BodyPayload[] = r.bodies.map((b) => ({ ...meshOf(b.solid, b.key), id: b.id, matrix: b.matrix.toArray() }));
      const ghosts: GhostPayload[] = r.ghosts.map((g) => ({ ...meshOf(g.solid, g.key), featureId: g.featureId, bodyId: g.bodyId, matrix: g.matrix.toArray() }));
      const out: EvalPayload = { bodies, ghosts, errors: r.errors, ms: performance.now() - t0 };
      return out;
    }
    case 'step': {
      const r = evaluateDoc(req.doc);
      const pick = r.bodies.filter((b) => b.visible && (!req.ids || req.ids.includes(b.id)));
      return exportStep(pick.map((b) => ({ name: b.name, color: b.appearance.color, solid: b.solid, matrix: b.matrix })));
    }
    case 'importStep': {
      const shape = importStepText(req.text);
      if (!shape) throw new Error('That STEP file could not be read.');
      // centre it on the ground, like STL imports
      const [[x0, y0, z0], [x1, , z1]] = shape.boundingBox.bounds;
      const placed = shape.translate(-(x0 + x1) / 2, -y0, -(z0 + z1) / 2);
      const m = placed.mesh({ tolerance: 0.05, angularTolerance: 12 });
      const tri = new Float32Array(m.triangles.length * 3);
      m.triangles.forEach((v, i) => { tri[i * 3] = m.vertices[v * 3]; tri[i * 3 + 1] = m.vertices[v * 3 + 1]; tri[i * 3 + 2] = m.vertices[v * 3 + 2]; });
      const faces = placed.faces.length;
      // store the STEP back in Z-up so the kernel's import rotation lands it the same way (rotate() frees `placed`)
      const zUp = placed.rotate(90, [0, 0, 0], [1, 0, 0]);
      const step = await zUp.blobSTEP().text();
      zUp.delete();
      return { mesh: encodePositions(tri), step, faces };
    }
    case 'props': {
      const r = evaluateDoc(req.doc);
      const out: PropsPayload[] = [];
      for (const b of r.bodies) {
        if (!req.ids.includes(b.id) || b.solid.kind !== 'brep') continue;
        const s = b.solid.shape;
        const scale = Math.cbrt(Math.abs(b.matrix.determinant()));
        const c = (R.measureShapeVolumeProperties(s) as any).centerOfMass as [number, number, number];
        const center = c ? [c[0], c[1], c[2]] as [number, number, number] : [0, 0, 0] as [number, number, number];
        out.push({ id: b.id, volume: R.measureVolume(s) * scale ** 3, area: R.measureArea(s) * scale ** 2, center });
      }
      return out;
    }
  }
}

self.onmessage = async (e: MessageEvent<{ id: number; req: Request }>) => {
  const { id, req } = e.data;
  try {
    const data = await handle(req);
    (self as unknown as Worker).postMessage({ id, ok: true, data });
  } catch (err: any) {
    const error = typeof err === 'number' ? 'The geometry engine hit an internal error.' : err?.message ?? String(err);
    (self as unknown as Worker).postMessage({ id, ok: false, error });
  }
};
