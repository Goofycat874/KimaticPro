import * as THREE from 'three';
import { Brush, Evaluator, ADDITION, SUBTRACTION, INTERSECTION } from 'three-bvh-csg';
import type {
  Appearance, BodyOp, DesignDoc, ExtrudeFeature, Feature, PlaneDef, RevolveFeature, SketchEntity, TRS,
} from './types';
import { buildShape } from './primitives';
import { planeMatrix, profileToShape, sketchProfiles } from './sketch';
import { revolveProfiles } from './revolve';
import { decodePositions, normalizeGeometry } from './geometry';

export interface EvalBody {
  id: string;
  name: string;
  appearance: Appearance;
  /** Geometry in the body's local frame. Shared/cached — never mutate. */
  geometry: THREE.BufferGeometry;
  /** Local → world. */
  matrix: THREE.Matrix4;
  /** Cache key identifying `geometry`. */
  key: string;
  /** Feature whose transform currently places this body directly, if any. */
  editableFeatureId: string | null;
  sourceFeatureId: string;
  lastFeatureId: string;
  visible: boolean;
}

/** A tool body that was consumed by a join / cut / intersect. */
export interface EvalGhost {
  featureId: string;
  bodyId: string;
  op: BodyOp | 'join' | 'cut' | 'intersect';
  geometry: THREE.BufferGeometry;
  matrix: THREE.Matrix4;
}

export interface EvalSketch {
  featureId: string;
  name: string;
  plane: PlaneDef;
  matrix: THREE.Matrix4;
  entities: SketchEntity[];
  visible: boolean;
}

export interface EvalResult {
  bodies: EvalBody[];
  ghosts: EvalGhost[];
  sketches: EvalSketch[];
  errors: Record<string, string>;
  /** Parent frame for each feature that has an editable transform (for gizmos). */
  frames: Record<string, THREE.Matrix4>;
  /** Bodies created by each feature. */
  outputs: Record<string, string[]>;
}

// ---------------------------------------------------------------------------
// caching

interface CacheEntry { geo: THREE.BufferGeometry; gen: number }
const cache = new Map<string, CacheEntry>();
let generation = 0;

function cached(key: string, make: () => THREE.BufferGeometry) {
  const hit = cache.get(key);
  if (hit) { hit.gen = generation; return hit.geo; }
  const geo = make();
  cache.set(key, { geo, gen: generation });
  return geo;
}

function sweepCache(live: Set<THREE.BufferGeometry>) {
  for (const [k, v] of cache) {
    if (v.gen < generation - 4 && !live.has(v.geo)) {
      v.geo.dispose();
      cache.delete(k);
    }
  }
}

/** Small, fast string hash (cyrb53) so cache keys stay short as features nest. */
export function hash(str: string) {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

const matKey = (m: THREE.Matrix4) => m.elements.map((e) => Math.round(e * 1e5) / 1e5).join(',');

// ---------------------------------------------------------------------------
// helpers

const DEG = Math.PI / 180;

export function trsMatrix(t: TRS) {
  const m = new THREE.Matrix4();
  m.compose(
    new THREE.Vector3(...t.position),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(t.rotation[0] * DEG, t.rotation[1] * DEG, t.rotation[2] * DEG)),
    new THREE.Vector3(...t.scale),
  );
  return m;
}

const csg = new Evaluator();
csg.attributes = ['position', 'normal'];
csg.useGroups = false;

function brushOf(b: { geometry: THREE.BufferGeometry; matrix: THREE.Matrix4 }) {
  const br = new Brush(b.geometry);
  br.matrixAutoUpdate = false;
  br.matrix.copy(b.matrix);
  br.updateMatrixWorld(true);
  return br;
}

const OPS = { join: ADDITION, cut: SUBTRACTION, intersect: INTERSECTION } as const;

/** Run a boolean and return a body-local geometry centred on its bounds + the frame. */
function boolean(a: EvalBody, b: { key: string; geometry: THREE.BufferGeometry; matrix: THREE.Matrix4 }, op: 'join' | 'cut' | 'intersect') {
  const key = hash(`${op}|${a.key}@${matKey(a.matrix)}|${b.key}@${matKey(b.matrix)}`);
  const geo = cached(key, () => {
    const result = csg.evaluate(brushOf(a), brushOf(b), OPS[op]);
    const g = result.geometry;
    g.computeBoundingBox();
    const c = new THREE.Vector3();
    if (!g.boundingBox!.isEmpty()) g.boundingBox!.getCenter(c);
    g.translate(-c.x, -c.y, -c.z);
    g.userData.center = c.toArray();
    g.computeBoundingBox();
    g.computeBoundingSphere();
    return g;
  });
  const c = new THREE.Vector3().fromArray(geo.userData.center ?? [0, 0, 0]);
  return { geo, key, matrix: new THREE.Matrix4().makeTranslation(c.x, c.y, c.z) };
}

function mirrorMatrix(plane: 'yz' | 'xy' | 'xz', offset: number) {
  const s = plane === 'yz' ? [-1, 1, 1] : plane === 'xz' ? [1, -1, 1] : [1, 1, -1];
  const m = new THREE.Matrix4().makeScale(s[0], s[1], s[2]);
  const off = new THREE.Vector3(plane === 'yz' ? offset : 0, plane === 'xz' ? offset : 0, plane === 'xy' ? offset : 0);
  return new THREE.Matrix4().makeTranslation(off.x, off.y, off.z).multiply(m).multiply(new THREE.Matrix4().makeTranslation(-off.x, -off.y, -off.z));
}

/** Bake a body into world space with a reflection; flips winding so it stays outward-facing. */
function mirroredGeometry(body: EvalBody, refl: THREE.Matrix4, key: string) {
  return cached(key, () => {
    const g = body.geometry.clone();
    g.applyMatrix4(new THREE.Matrix4().multiplyMatrices(refl, body.matrix));
    if (g.index) {
      const idx = g.index.array as Uint32Array;
      for (let i = 0; i < idx.length; i += 3) { const t = idx[i + 1]; idx[i + 1] = idx[i + 2]; idx[i + 2] = t; }
      g.index.needsUpdate = true;
    }
    delete (g as any).boundsTree;
    delete (g as any).halfEdges;
    g.computeBoundingBox();
    g.computeBoundingSphere();
    return g;
  });
}

function axisVec(a: 'x' | 'y' | 'z') {
  return new THREE.Vector3(a === 'x' ? 1 : 0, a === 'y' ? 1 : 0, a === 'z' ? 1 : 0);
}

function extrudeGeometry(f: ExtrudeFeature, entities: SketchEntity[]) {
  const shapes = sketchProfiles(entities).map(profileToShape);
  if (!shapes.length) throw new Error('This sketch has no closed shapes to extrude. Close a loop first.');
  const dist = Math.abs(f.distance) || 0.01;
  const r = Math.max(0, Math.min(f.roundEdges, dist / 2 - 0.01));
  const geo = new THREE.ExtrudeGeometry(shapes, {
    depth: Math.max(0.01, dist - 2 * r),
    bevelEnabled: r > 0,
    bevelThickness: r,
    bevelSize: r,
    bevelOffset: -r,
    bevelSegments: 4,
    curveSegments: 48,
  });
  if (r > 0) geo.translate(0, 0, r);
  if (f.symmetric) geo.translate(0, 0, -dist / 2);
  else if (f.distance < 0) geo.translate(0, 0, -dist);
  return normalizeGeometry(geo);
}

function revolveGeometry(f: RevolveFeature, entities: SketchEntity[]) {
  const profiles = sketchProfiles(entities);
  if (!profiles.length) throw new Error('This sketch has no closed shapes to revolve.');
  return normalizeGeometry(revolveProfiles(profiles, f.axis, f.angle));
}

// ---------------------------------------------------------------------------

export function evaluate(doc: DesignDoc): EvalResult {
  generation++;
  const bodies = new Map<string, EvalBody>();
  const ghosts: EvalGhost[] = [];
  const sketches = new Map<string, EvalSketch>();
  const errors: Record<string, string> = {};
  const frames: Record<string, THREE.Matrix4> = {};
  const outputs: Record<string, string[]> = {};
  const active = doc.features.slice(0, doc.marker);

  const applyOp = (fid: string, tool: EvalBody, op: BodyOp, targets: string[]) => {
    if (op === 'new') {
      bodies.set(tool.id, tool);
      outputs[fid] = [tool.id];
      return;
    }
    const live = targets.filter((t) => bodies.has(t));
    if (!live.length) {
      // nothing to combine with — keep it as a regular body so work is never lost
      bodies.set(tool.id, tool);
      outputs[fid] = [tool.id];
      errors[fid] = `No target body to ${op}. Created as a new body instead.`;
      return;
    }
    ghosts.push({ featureId: fid, bodyId: tool.id, op, geometry: tool.geometry, matrix: tool.matrix });
    const list = op === 'cut' ? live : [live[0]];
    for (const tid of list) {
      const target = bodies.get(tid)!;
      const r = boolean(target, tool, op);
      bodies.set(tid, { ...target, geometry: r.geo, key: r.key, matrix: r.matrix, editableFeatureId: null, lastFeatureId: fid });
    }
    outputs[fid] = [];
  };

  const visibleOf = (id: string) => doc.bodyState[id]?.visible !== false;

  for (const f of active) {
    if (f.suppressed) continue;
    try {
      switch (f.type) {
        case 'primitive': {
          const key = hash(`prim|${f.shape}|${JSON.stringify(f.params)}`);
          const geometry = cached(key, () => buildShape(f.shape, f.params));
          frames[f.id] = new THREE.Matrix4();
          const body: EvalBody = {
            id: f.id, name: doc.bodyState[f.id]?.name ?? f.name, appearance: f.appearance, geometry, key,
            matrix: trsMatrix(f.transform), editableFeatureId: f.id, sourceFeatureId: f.id, lastFeatureId: f.id,
            visible: visibleOf(f.id),
          };
          applyOp(f.id, body, f.op, f.targets);
          break;
        }
        case 'import': {
          const key = hash(`import|${f.id}|${f.data.length}`);
          const geometry = cached(key, () => {
            const g = new THREE.BufferGeometry();
            g.setAttribute('position', new THREE.BufferAttribute(decodePositions(f.data), 3));
            return normalizeGeometry(g);
          });
          frames[f.id] = new THREE.Matrix4();
          bodies.set(f.id, {
            id: f.id, name: doc.bodyState[f.id]?.name ?? f.name, appearance: f.appearance, geometry, key,
            matrix: trsMatrix(f.transform), editableFeatureId: f.id, sourceFeatureId: f.id, lastFeatureId: f.id,
            visible: visibleOf(f.id),
          });
          outputs[f.id] = [f.id];
          break;
        }
        case 'sketch': {
          sketches.set(f.id, {
            featureId: f.id, name: f.name, plane: f.plane, matrix: planeMatrix(f.plane),
            entities: f.entities, visible: f.visible,
          });
          break;
        }
        case 'extrude':
        case 'revolve': {
          const sk = sketches.get(f.sketchId);
          if (!sk) throw new Error('The sketch for this feature is missing.');
          const key = hash(`${f.type}|${JSON.stringify(sk.entities)}|${f.type === 'extrude'
            ? `${f.distance}|${f.symmetric}|${f.roundEdges}` : `${f.axis}|${f.angle}`}`);
          const geometry = cached(key, () => (f.type === 'extrude' ? extrudeGeometry(f, sk.entities) : revolveGeometry(f, sk.entities)));
          frames[f.id] = sk.matrix.clone();
          const body: EvalBody = {
            id: f.id, name: doc.bodyState[f.id]?.name ?? f.name, appearance: f.appearance, geometry, key,
            matrix: sk.matrix.clone().multiply(trsMatrix(f.transform)), editableFeatureId: f.id,
            sourceFeatureId: f.id, lastFeatureId: f.id, visible: visibleOf(f.id),
          };
          applyOp(f.id, body, f.op, f.targets);
          break;
        }
        case 'combine': {
          const target = bodies.get(f.targetId);
          if (!target) throw new Error('The target body no longer exists.');
          let cur = target;
          for (const tid of f.toolIds) {
            const tool = bodies.get(tid);
            if (!tool || tid === f.targetId) continue;
            const r = boolean(cur, tool, f.op);
            cur = { ...cur, geometry: r.geo, key: r.key, matrix: r.matrix, editableFeatureId: null, lastFeatureId: f.id };
            if (!f.keepTools) {
              bodies.delete(tid);
              ghosts.push({ featureId: tool.editableFeatureId ?? f.id, bodyId: tid, op: f.op, geometry: tool.geometry, matrix: tool.matrix });
            }
          }
          bodies.set(f.targetId, cur);
          outputs[f.id] = [];
          break;
        }
        case 'move': {
          const pivot = new THREE.Vector3(...f.pivot);
          const base = new THREE.Matrix4().makeTranslation(pivot.x, pivot.y, pivot.z);
          frames[f.id] = base;
          const delta = base.clone().multiply(trsMatrix(f.transform)).multiply(new THREE.Matrix4().makeTranslation(-pivot.x, -pivot.y, -pivot.z));
          outputs[f.id] = [];
          for (const bid of f.bodyIds) {
            const b = bodies.get(bid);
            if (!b) continue;
            const matrix = delta.clone().multiply(b.matrix);
            if (f.copy) {
              const id = `${f.id}:${bid}`;
              bodies.set(id, {
                ...b, id, name: doc.bodyState[id]?.name ?? `${b.name} copy`, matrix,
                editableFeatureId: null, sourceFeatureId: f.id, lastFeatureId: f.id, visible: visibleOf(id),
              });
              outputs[f.id].push(id);
            } else {
              const single = f.bodyIds.length === 1;
              bodies.set(bid, { ...b, matrix, editableFeatureId: single ? f.id : null, lastFeatureId: f.id });
            }
          }
          break;
        }
        case 'pattern': {
          outputs[f.id] = [];
          const count = Math.max(1, Math.round(f.count));
          for (const bid of f.bodyIds) {
            const b = bodies.get(bid);
            if (!b) continue;
            for (let i = 1; i < count; i++) {
              let m: THREE.Matrix4;
              if (f.kind === 'linear') {
                const d = axisVec(f.direction).multiplyScalar(f.spacing * i);
                m = new THREE.Matrix4().makeTranslation(d.x, d.y, d.z);
              } else {
                const full = Math.abs(f.angle) >= 359.999;
                const step = (f.angle * DEG) / (full ? count : Math.max(1, count - 1));
                const c = new THREE.Vector3(...f.center);
                m = new THREE.Matrix4().makeTranslation(c.x, c.y, c.z)
                  .multiply(new THREE.Matrix4().makeRotationAxis(axisVec(f.axis), step * i))
                  .multiply(new THREE.Matrix4().makeTranslation(-c.x, -c.y, -c.z));
              }
              const id = `${f.id}:${bid}:${i}`;
              bodies.set(id, {
                ...b, id, name: doc.bodyState[id]?.name ?? `${b.name} ${i + 1}`, matrix: m.multiply(b.matrix),
                editableFeatureId: null, sourceFeatureId: f.id, lastFeatureId: f.id, visible: visibleOf(id),
              });
              outputs[f.id].push(id);
            }
          }
          break;
        }
        case 'mirror': {
          outputs[f.id] = [];
          const refl = mirrorMatrix(f.plane, f.offset);
          for (const bid of f.bodyIds) {
            const b = bodies.get(bid);
            if (!b) continue;
            const key = hash(`mirror|${f.plane}|${f.offset}|${b.key}@${matKey(b.matrix)}`);
            const geometry = mirroredGeometry(b, refl, key);
            const id = `${f.id}:${bid}`;
            bodies.set(id, {
              ...b, id, name: doc.bodyState[id]?.name ?? `${b.name} mirror`, geometry, key, matrix: new THREE.Matrix4(),
              editableFeatureId: null, sourceFeatureId: f.id, lastFeatureId: f.id, visible: visibleOf(id),
            });
            outputs[f.id].push(id);
          }
          break;
        }
      }
    } catch (err: any) {
      errors[f.id] = err?.message ?? String(err);
      console.warn(`[KimaticPro] feature ${f.name} failed`, err);
    }
  }

  const finalBodies = [...bodies.values()]
    .filter((b) => !doc.bodyState[b.id]?.removed)
    .map((b) => {
      const st = doc.bodyState[b.id];
      return st?.appearance || st?.name ? { ...b, appearance: st.appearance ?? b.appearance, name: st.name ?? b.name } : b;
    });
  const result: EvalResult = {
    bodies: finalBodies,
    ghosts,
    sketches: [...sketches.values()],
    errors,
    frames,
    outputs,
  };
  sweepCache(new Set([...result.bodies.map((b) => b.geometry), ...ghosts.map((g) => g.geometry)]));
  return result;
}

/** World-space bounding box of a body. */
export function bodyBounds(b: { geometry: THREE.BufferGeometry; matrix: THREE.Matrix4 }) {
  if (!b.geometry.boundingBox) b.geometry.computeBoundingBox();
  return b.geometry.boundingBox!.clone().applyMatrix4(b.matrix);
}

export function featureOf(doc: DesignDoc, id: string | null | undefined): Feature | undefined {
  return id ? doc.features.find((f) => f.id === id) : undefined;
}
