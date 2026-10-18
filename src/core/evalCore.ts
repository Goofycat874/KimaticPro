import * as THREE from 'three';
import type { Appearance, BodyOp, DesignDoc, Feature, PlaneDef, SketchEntity, TRS } from './types';
import type { Kernel, Placed } from './kernel';
import { planeMatrix } from './sketch';
import { evalExpr, resolveParams, setPath } from './expr';

// The timeline engine: replays features in order and keeps track of which body is
// which. It is shared by every kernel, so previews and precise results always agree
// on body ids, editability, ghosts and outputs.

export interface CoreBody<S> extends Placed<S> {
  id: string;
  name: string;
  appearance: Appearance;
  /** Feature whose transform currently places this body directly, if any. */
  editableFeatureId: string | null;
  sourceFeatureId: string;
  lastFeatureId: string;
  visible: boolean;
}

/** A tool body that was consumed by a join / cut / intersect. */
export interface CoreGhost<S> extends Placed<S> {
  featureId: string;
  bodyId: string;
  op: BodyOp;
}

export interface EvalSketch {
  featureId: string;
  name: string;
  plane: PlaneDef;
  matrix: THREE.Matrix4;
  entities: SketchEntity[];
  visible: boolean;
}

export interface CoreResult<S> {
  bodies: CoreBody<S>[];
  ghosts: CoreGhost<S>[];
  sketches: EvalSketch[];
  errors: Record<string, string>;
  /** Parent frame for each feature that has an editable transform (for gizmos). */
  frames: Record<string, THREE.Matrix4>;
  /** Bodies created by each feature. */
  outputs: Record<string, string[]>;
  /** Current values of the user parameters. */
  vars: Record<string, number>;
  paramErrors: Record<string, string>;
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

export const matKey = (m: THREE.Matrix4) => m.elements.map((e) => Math.round(e * 1e5) / 1e5).join(',');

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

/** Substitute parameter expressions into feature fields, without touching the document. */
export function applyExpressions(features: Feature[], vars: Record<string, number>, errors: Record<string, string>): Feature[] {
  return features.map((f) => {
    if (!f.exprs || !Object.keys(f.exprs).length) return f;
    const copy = JSON.parse(JSON.stringify(f));
    for (const [path, expr] of Object.entries(f.exprs)) {
      try { setPath(copy, path, evalExpr(expr, vars)); } catch (e: any) { errors[f.id] = `${path.split('.').pop()}: ${e.message}`; }
    }
    return copy;
  });
}

export function mirrorMatrix(plane: 'yz' | 'xy' | 'xz', offset: number) {
  const s = plane === 'yz' ? [-1, 1, 1] : plane === 'xz' ? [1, -1, 1] : [1, 1, -1];
  const m = new THREE.Matrix4().makeScale(s[0], s[1], s[2]);
  const off = new THREE.Vector3(plane === 'yz' ? offset : 0, plane === 'xz' ? offset : 0, plane === 'xy' ? offset : 0);
  return new THREE.Matrix4().makeTranslation(off.x, off.y, off.z).multiply(m).multiply(new THREE.Matrix4().makeTranslation(-off.x, -off.y, -off.z));
}

const axisVec = (a: 'x' | 'y' | 'z') => new THREE.Vector3(a === 'x' ? 1 : 0, a === 'y' ? 1 : 0, a === 'z' ? 1 : 0);

export function runFeatures<S>(kernel: Kernel<S>, doc: DesignDoc): CoreResult<S> {
  kernel.begin();
  const bodies = new Map<string, CoreBody<S>>();
  const ghosts: CoreGhost<S>[] = [];
  const sketches = new Map<string, EvalSketch>();
  const errors: Record<string, string> = {};
  const frames: Record<string, THREE.Matrix4> = {};
  const outputs: Record<string, string[]> = {};
  const { vars, errors: paramErrors } = resolveParams(doc.params ?? []);
  const active = applyExpressions(doc.features.slice(0, doc.marker), vars, errors);
  const visibleOf = (id: string) => doc.bodyState[id]?.visible !== false;
  const nameOf = (id: string, fallback: string) => doc.bodyState[id]?.name ?? fallback;

  const applyOp = (fid: string, tool: CoreBody<S>, op: BodyOp, targets: string[]) => {
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
    ghosts.push({ featureId: fid, bodyId: tool.id, op, solid: tool.solid, key: tool.key, matrix: tool.matrix });
    const list = op === 'cut' ? live : [live[0]];
    for (const tid of list) {
      const target = bodies.get(tid)!;
      const r = kernel.boolean(target, tool, op);
      bodies.set(tid, { ...target, ...r, editableFeatureId: null, lastFeatureId: fid });
    }
    outputs[fid] = [];
  };

  const created = (f: Feature & { appearance: Appearance }, solid: S, key: string, matrix: THREE.Matrix4): CoreBody<S> => ({
    id: f.id, name: nameOf(f.id, f.name), appearance: f.appearance, solid, key, matrix,
    editableFeatureId: f.id, sourceFeatureId: f.id, lastFeatureId: f.id, visible: visibleOf(f.id),
  });

  for (const f of active) {
    if (f.suppressed) continue;
    try {
      switch (f.type) {
        case 'primitive': {
          const key = hash(`prim|${f.shape}|${JSON.stringify(f.params)}`);
          frames[f.id] = new THREE.Matrix4();
          applyOp(f.id, created(f, kernel.primitive(f.shape, f.params, key), key, trsMatrix(f.transform)), f.op, f.targets);
          break;
        }
        case 'import': {
          const key = hash(`import|${f.id}|${f.data.length}|${f.step?.length ?? 0}`);
          frames[f.id] = new THREE.Matrix4();
          bodies.set(f.id, created(f, kernel.importMesh(f.data, f.step, key), key, trsMatrix(f.transform)));
          outputs[f.id] = [f.id];
          break;
        }
        case 'sketch': {
          sketches.set(f.id, {
            featureId: f.id, name: f.name, plane: f.plane, matrix: planeMatrix(f.plane), entities: f.entities, visible: f.visible,
          });
          break;
        }
        case 'extrude':
        case 'revolve': {
          const sk = sketches.get(f.sketchId);
          if (!sk) throw new Error('The sketch for this feature is missing.');
          const key = hash(`${f.type}|${JSON.stringify(sk.entities)}|${f.type === 'extrude'
            ? `${f.distance}|${f.symmetric}|${f.roundEdges}` : `${f.axis}|${f.angle}`}`);
          const solid = f.type === 'extrude' ? kernel.extrude(f, sk.entities, key) : kernel.revolve(f, sk.entities, key);
          frames[f.id] = sk.matrix.clone();
          applyOp(f.id, created(f, solid, key, sk.matrix.clone().multiply(trsMatrix(f.transform))), f.op, f.targets);
          break;
        }
        case 'loft':
        case 'sweep': {
          let key: string;
          let solid: S;
          if (f.type === 'loft') {
            const secs = f.sketchIds.map((id) => sketches.get(id)).filter(Boolean) as EvalSketch[];
            if (secs.length < 2) throw new Error('Loft needs at least two sketches with closed shapes.');
            key = hash(`loft|${f.smooth}|${secs.map((sk) => JSON.stringify(sk.entities) + matKey(sk.matrix)).join('|')}`);
            solid = kernel.loft(secs.map((s) => ({ entities: s.entities, matrix: s.matrix })), f.smooth, key);
          } else {
            const prof = sketches.get(f.profileId), path = sketches.get(f.pathId);
            if (!prof || !path) throw new Error('Pick a profile sketch and a path sketch.');
            if (prof === path) throw new Error('The profile and the path must be different sketches.');
            key = hash(`sweep|${f.twist}|${JSON.stringify(prof.entities)}|${JSON.stringify(path.entities)}|${matKey(path.matrix)}`);
            solid = kernel.sweep(prof.entities, { entities: path.entities, matrix: path.matrix }, f.twist, key);
          }
          frames[f.id] = new THREE.Matrix4();
          applyOp(f.id, created(f, solid, key, trsMatrix(f.transform)), f.op, f.targets);
          break;
        }
        case 'fillet':
        case 'shell':
        case 'draft': {
          const b = bodies.get(f.bodyId);
          if (!b) throw new Error('The body for this step no longer exists.');
          const r = kernel.modify(b, f);
          bodies.set(f.bodyId, { ...b, ...r, editableFeatureId: null, lastFeatureId: f.id });
          outputs[f.id] = [];
          break;
        }
        case 'split': {
          const b = bodies.get(f.bodyId);
          if (!b) throw new Error('The body to split no longer exists.');
          const [low, high] = kernel.split(b, f.axis, f.offset);
          const id2 = `${f.id}:${f.bodyId}`;
          bodies.set(f.bodyId, { ...b, ...low, editableFeatureId: null, lastFeatureId: f.id });
          bodies.set(id2, {
            ...b, ...high, id: id2, name: nameOf(id2, `${b.name} (part 2)`),
            editableFeatureId: null, sourceFeatureId: f.id, lastFeatureId: f.id, visible: visibleOf(id2),
          });
          outputs[f.id] = [id2];
          break;
        }
        case 'combine': {
          const target = bodies.get(f.targetId);
          if (!target) throw new Error('The target body no longer exists.');
          let cur = target;
          for (const tid of f.toolIds) {
            const tool = bodies.get(tid);
            if (!tool || tid === f.targetId) continue;
            cur = { ...cur, ...kernel.boolean(cur, tool, f.op), editableFeatureId: null, lastFeatureId: f.id };
            if (!f.keepTools) {
              bodies.delete(tid);
              ghosts.push({ featureId: tool.editableFeatureId ?? f.id, bodyId: tid, op: f.op, solid: tool.solid, key: tool.key, matrix: tool.matrix });
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
                ...b, id, name: nameOf(id, `${b.name} copy`), matrix,
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
                ...b, id, name: nameOf(id, `${b.name} ${i + 1}`), matrix: m.multiply(b.matrix),
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
            const r = kernel.mirror(b, refl, hash(`mirror|${f.plane}|${f.offset}|${b.key}@${matKey(b.matrix)}`));
            const id = `${f.id}:${bid}`;
            bodies.set(id, {
              ...b, ...r, id, name: nameOf(id, `${b.name} mirror`),
              editableFeatureId: null, sourceFeatureId: f.id, lastFeatureId: f.id, visible: visibleOf(id),
            });
            outputs[f.id].push(id);
          }
          break;
        }
      }
    } catch (err: any) {
      errors[f.id] = friendlyError(err);
      if (typeof console !== 'undefined') console.warn(`[KimaticPro] ${kernel.precise ? 'precise' : 'preview'} feature ${f.name} failed`, err);
    }
  }

  const finalBodies = [...bodies.values()]
    .filter((b) => !doc.bodyState[b.id]?.removed)
    .map((b) => {
      const st = doc.bodyState[b.id];
      return st?.appearance || st?.name ? { ...b, appearance: st.appearance ?? b.appearance, name: st.name ?? b.name } : b;
    });
  kernel.end([...finalBodies.map((b) => b.solid), ...ghosts.map((g) => g.solid)]);
  return { bodies: finalBodies, ghosts, sketches: [...sketches.values()], errors, frames, outputs, vars, paramErrors };
}

/** OpenCascade throws numeric pointers or terse messages; turn them into something useful. */
function friendlyError(err: any): string {
  const msg = typeof err === 'number' ? '' : err?.message ?? String(err);
  if (!msg || /^\d+$/.test(msg)) return 'The geometry engine could not build this step. Try a smaller radius or thickness, or check the input shapes.';
  if (/fillet/i.test(msg)) return 'Could not round these edges — try a smaller radius.';
  if (/shell/i.test(msg)) return 'Could not hollow this body — try a thinner wall or a different face.';
  return msg;
}
