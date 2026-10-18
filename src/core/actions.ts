import * as THREE from 'three';
import { store } from './store';
import type { PickState, SketchTool } from './store';
import { bodyBounds, featureOf, trsMatrix, type EvalBody } from './evaluator';
import { defaultParams, shapeById } from './primitives';
import { nextColor } from './materials';
import { STANDARD_PLANES, entityOutline, entityPoints } from './sketch';
import { ORIGIN, liveConstraints, measure, paramCount, refCircle, refLine, refPoint, solveSketch, withValues } from './constraints';
import { evalExpr, usesNames } from './expr';
import { arrangeOnBed, layFlatQuaternion } from './printing';
import {
  identityTRS, isCreating, uid,
  type Appearance, type BodyOp, type DesignDoc, type ExtrudeFeature, type Feature, type MoveFeature,
  type PatternFeature, type MirrorFeature, type PlaneDef, type RevolveFeature, type SketchEntity, type SketchFeature, type TRS, type Vec3,
  type ConstraintType, type SketchConstraint, type SkRef,
} from './types';

/** Hooks the viewport registers so actions can drive the camera. */
export const viewApi: {
  groundTarget?: () => Vec3;
  fit?: (ids?: string[]) => void;
  lookAtPlane?: (plane: PlaneDef) => void;
  setView?: (name: string) => void;
  screenshot?: () => string;
} = {};

// ---------------------------------------------------------------------------
// helpers

const round = (v: number, step = 0.001) => Math.round(v / step) * step;

export function insertFeature(doc: DesignDoc, f: Feature) {
  doc.features.splice(doc.marker, 0, f);
  doc.marker++;
}

function nextName(doc: DesignDoc, base: string) {
  let n = 1;
  const names = new Set(doc.features.map((f) => f.name));
  while (names.has(`${base} ${n}`)) n++;
  return `${base} ${n}`;
}

export const bodyById = (id: string) => store.state.result.bodies.find((b) => b.id === id);

export function selectionBodies(): EvalBody[] {
  return store.state.selection.map(bodyById).filter(Boolean) as EvalBody[];
}

export function selectionBounds(ids = store.state.selection) {
  const box = new THREE.Box3();
  for (const id of ids) {
    const b = bodyById(id);
    if (b) box.union(bodyBounds(b));
  }
  return box;
}

// ---------------------------------------------------------------------------
// selection

export function select(ids: string[], additive = false) {
  const { selection } = store.state;
  let next = ids;
  if (additive) {
    const set = new Set(selection);
    for (const id of ids) set.has(id) ? set.delete(id) : set.add(id);
    next = [...set];
  }
  const first = next.length ? bodyById(next[next.length - 1]) : undefined;
  store.set({ selection: next, selectedFeature: next.length === 1 ? first?.editableFeatureId ?? first?.sourceFeatureId ?? null : null });
}

export function selectFeature(id: string | null) {
  const out = id ? store.state.result.outputs[id] : undefined;
  store.set({ selectedFeature: id, selection: out?.length === 1 ? out : [] });
}

export function selectAll() {
  store.set({ selection: store.state.result.bodies.filter((b) => b.visible).map((b) => b.id), selectedFeature: null });
}

// ---------------------------------------------------------------------------
// creation

export function addShape(shapeId: string, opts: { position?: Vec3; op?: BodyOp; targets?: string[] } = {}) {
  const def = shapeById(shapeId);
  if (!def) return;
  const id = uid('p');
  const pos = opts.position ?? viewApi.groundTarget?.() ?? [0, 0, 0];
  const snap = store.state.snap || 1;
  const position: Vec3 = [round(pos[0], snap), round(pos[1], 0.001), round(pos[2], snap)];
  const params = defaultParams(def);
  if (shapeId === 'text') params.text = 'Hello';
  // holes dropped onto a body drill straight into it
  let op = opts.op ?? 'new';
  let targets = opts.targets ?? [];
  if (!opts.op && def.defaultOp && targets.length) op = def.defaultOp;
  if (op === 'new') targets = [];
  store.commit(`Add ${def.label}`, (doc) => {
    insertFeature(doc, {
      id, type: 'primitive', name: nextName(doc, def.label), shape: shapeId, params,
      transform: { ...identityTRS(), position }, op, targets,
      appearance: { color: def.color ?? nextColor(), material: 'pla' },
    });
  }, { selection: [id], selectedFeature: id, mode: 'model' });
}

export function importMesh(name: string, data: string, step?: string) {
  const id = uid('i');
  store.commit(`Import ${name}`, (doc) => {
    insertFeature(doc, {
      id, type: 'import', name, data, ...(step ? { step } : {}), transform: identityTRS(),
      appearance: { color: '#94a3b8', material: 'pla' },
    });
  }, { selection: [id], selectedFeature: id });
  setTimeout(() => viewApi.fit?.([id]), 30);
}

// ---------------------------------------------------------------------------
// feature editing

export function updateFeature(id: string, patch: Partial<Feature> | ((f: any) => void), label = 'Edit feature', live = false) {
  const recipe = (doc: DesignDoc) => {
    const f = doc.features.find((x) => x.id === id);
    if (!f) return;
    if (typeof patch === 'function') patch(f);
    else Object.assign(f, patch);
  };
  if (live) store.transient(recipe);
  else store.commit(label, recipe);
}

export function setTransform(id: string, transform: TRS, live = false) {
  updateFeature(id, (f) => { f.transform = transform; }, 'Move', live);
}

export function deleteFeature(id: string) {
  const f = featureOf(store.doc, id);
  if (!f) return;
  store.commit(`Delete ${f.name}`, (doc) => {
    const dead = new Set([id]);
    if (f.type === 'sketch') {
      for (const g of doc.features) if ((g.type === 'extrude' || g.type === 'revolve') && g.sketchId === id) dead.add(g.id);
    }
    const removedBeforeMarker = doc.features.slice(0, doc.marker).filter((x) => dead.has(x.id)).length;
    doc.features = doc.features.filter((x) => !dead.has(x.id));
    doc.marker = Math.max(0, Math.min(doc.features.length, doc.marker - removedBeforeMarker));
  }, { selectedFeature: null });
}

export function deleteSelection() {
  const { selection, selectedFeature, mode } = store.state;
  if (mode === 'sketch') return deleteSketchEntities();
  if (!selection.length && selectedFeature) return deleteFeature(selectedFeature);
  if (!selection.length) return;
  const bodies = selectionBodies();
  store.commit(bodies.length > 1 ? `Delete ${bodies.length} bodies` : `Delete ${bodies[0]?.name ?? 'body'}`, (doc) => {
    for (const b of bodies) {
      const src = doc.features.find((f) => f.id === b.id);
      if (src && isCreating(src)) {
        const idx = doc.features.indexOf(src);
        doc.features.splice(idx, 1);
        if (idx < doc.marker) doc.marker--;
      } else {
        doc.bodyState[b.id] = { ...doc.bodyState[b.id], removed: true };
      }
    }
  }, { selection: [], selectedFeature: null });
}

export function renameBody(id: string, name: string) {
  const f = featureOf(store.doc, id);
  store.commit('Rename', (doc) => {
    const g = doc.features.find((x) => x.id === id);
    if (g && f && isCreating(f)) g.name = name;
    else doc.bodyState[id] = { ...doc.bodyState[id], name };
  });
}

export function renameFeature(id: string, name: string) {
  updateFeature(id, { name } as any, 'Rename');
}

export function setAppearance(ids: string[], patch: Partial<Appearance>) {
  store.commit('Change appearance', (doc) => {
    for (const id of ids) {
      const body = bodyById(id);
      if (!body) continue;
      const f = doc.features.find((x) => x.id === id);
      if (f && isCreating(f)) f.appearance = { ...f.appearance, ...patch };
      else doc.bodyState[id] = { ...doc.bodyState[id], appearance: { ...body.appearance, ...patch } };
    }
  });
}

export function toggleVisibility(id: string) {
  store.commit('Toggle visibility', (doc) => {
    const cur = doc.bodyState[id]?.visible !== false;
    doc.bodyState[id] = { ...doc.bodyState[id], visible: !cur };
  });
}

export function showAll() {
  store.commit('Show all', (doc) => {
    for (const k of Object.keys(doc.bodyState)) doc.bodyState[k] = { ...doc.bodyState[k], visible: true };
  });
}

export function isolate(ids = store.state.selection) {
  if (!ids.length) return;
  const keep = new Set(ids);
  store.commit('Isolate', (doc) => {
    for (const b of store.state.result.bodies) doc.bodyState[b.id] = { ...doc.bodyState[b.id], visible: keep.has(b.id) };
  });
}

export function toggleSuppress(id: string) {
  updateFeature(id, (f) => { f.suppressed = !f.suppressed; }, 'Suppress feature');
}

export function setMarker(index: number, live = false) {
  const recipe = (doc: DesignDoc) => { doc.marker = Math.max(0, Math.min(doc.features.length, index)); };
  if (live) store.transient(recipe);
  else store.commit('Roll timeline', recipe);
}

export function moveFeature(id: string, toIndex: number) {
  store.commit('Reorder timeline', (doc) => {
    const from = doc.features.findIndex((f) => f.id === id);
    if (from < 0) return;
    const [f] = doc.features.splice(from, 1);
    doc.features.splice(Math.max(0, Math.min(doc.features.length, toIndex)), 0, f);
  });
}

// ---------------------------------------------------------------------------
// transforms

/**
 * Returns the feature whose transform the gizmo should edit for these bodies.
 * When a body was already combined/patterned, a Move feature is appended to the timeline.
 */
export function ensureEditable(ids: string[], live = true): string | null {
  if (!ids.length) return null;
  if (ids.length === 1) {
    const b = bodyById(ids[0]);
    if (b?.editableFeatureId) return b.editableFeatureId;
  }
  // reuse the last move if it targets exactly these bodies
  const last = store.doc.features[store.doc.marker - 1];
  if (last?.type === 'move' && !last.copy && last.bodyIds.length === ids.length && last.bodyIds.every((x) => ids.includes(x))) {
    return last.id;
  }
  const c = selectionBounds(ids).getCenter(new THREE.Vector3());
  const id = uid('m');
  const recipe = (doc: DesignDoc) => insertFeature(doc, {
    id, type: 'move', name: nextName(doc, 'Move'), bodyIds: [...ids], pivot: [round(c.x), round(c.y), round(c.z)],
    transform: identityTRS(), copy: false,
  });
  // live: becomes part of the drag's single undo step
  if (live) store.transient(recipe);
  else store.commit('Move', recipe);
  return id;
}

/** Nudge bodies by a world-space offset (arrow keys, drop to ground, align). */
/** Move several bodies by their own world offsets in a single undo step. */
export function moveEach(moves: [string, THREE.Vector3][], label = 'Move', extra: Partial<typeof store.state> = {}) {
  const live = moves.filter(([id, d]) => bodyById(id) && d.lengthSq() > 1e-12);
  if (!live.length) return;
  store.commit(label, (doc) => {
    for (const [id, delta] of live) {
      const b = bodyById(id)!;
      const f = b.editableFeatureId ? doc.features.find((x) => x.id === b.editableFeatureId) as any : null;
      // edit the feature that places the body directly, unless it's a move shared with other bodies
      if (f?.transform && (f.type !== 'move' || f.bodyIds.length === 1)) {
        const frame = store.state.result.frames[f.id] ?? new THREE.Matrix4();
        const local = delta.clone().applyMatrix4(new THREE.Matrix4().extractRotation(frame).invert());
        const p = f.transform.position;
        f.transform.position = [round(p[0] + local.x), round(p[1] + local.y), round(p[2] + local.z)];
      } else {
        const c = bodyBounds(b).getCenter(new THREE.Vector3());
        insertFeature(doc, {
          id: uid('m'), type: 'move', name: nextName(doc, 'Move'), bodyIds: [id], pivot: [round(c.x), round(c.y), round(c.z)],
          transform: { ...identityTRS(), position: [round(delta.x), round(delta.y), round(delta.z)] }, copy: false,
        });
      }
    }
  }, extra);
}

/** Nudge bodies together by one world-space offset (arrow keys, drop to ground, centre). */
export function moveBodiesBy(ids: string[], delta: THREE.Vector3, label = 'Move') {
  moveEach(ids.map((id) => [id, delta.clone()]), label);
}

export function nudge(dx: number, dy: number, dz: number) {
  const s = store.state.snap || 1;
  moveBodiesBy(store.state.selection, new THREE.Vector3(dx * s, dy * s, dz * s), 'Nudge');
}

export function dropToGround(ids = store.state.selection) {
  if (!ids.length) return;
  const box = selectionBounds(ids);
  moveBodiesBy(ids, new THREE.Vector3(0, -box.min.y, 0), 'Drop to ground');
}

export function centerOnOrigin(ids = store.state.selection) {
  if (!ids.length) return;
  const box = selectionBounds(ids);
  const c = box.getCenter(new THREE.Vector3());
  moveBodiesBy(ids, new THREE.Vector3(-c.x, -box.min.y, -c.z), 'Center on origin');
}

export function align(axis: 'x' | 'y' | 'z', mode: 'min' | 'center' | 'max') {
  const ids = store.state.selection;
  if (ids.length < 2) { store.toast('Select two or more bodies to align them.'); return; }
  const all = selectionBounds(ids);
  const target = mode === 'min' ? all.min[axis] : mode === 'max' ? all.max[axis] : (all.min[axis] + all.max[axis]) / 2;
  const moves: [string, THREE.Vector3][] = [];
  for (const id of ids) {
    const b = bodyById(id)!;
    const bb = bodyBounds(b);
    const v = mode === 'min' ? bb.min[axis] : mode === 'max' ? bb.max[axis] : (bb.min[axis] + bb.max[axis]) / 2;
    const d = new THREE.Vector3();
    d[axis] = target - v;
    moves.push([id, d]);
  }
  moveEach(moves, `Align ${axis.toUpperCase()}`);
}

// ---------------------------------------------------------------------------
// 3D printing helpers

const visibleBodies = () => store.state.result.bodies.filter((b) => b.visible);

/** Sit every body (or the selection) on the bed individually. */
export function dropAllToBed() {
  const ids = store.state.selection.length ? store.state.selection : visibleBodies().map((b) => b.id);
  moveEach(ids.map((id) => [id, new THREE.Vector3(0, -bodyBounds(bodyById(id)!).min.y, 0)]), 'Drop to bed');
}

/** Pack all visible bodies onto the printer bed without overlaps. */
export function arrangeAll(bedWidth: number) {
  const bodies = visibleBodies();
  if (!bodies.length) return;
  const offsets = arrangeOnBed(bodies.map((b) => ({ id: b.id, box: bodyBounds(b) })), bedWidth);
  moveEach([...offsets.entries()], 'Arrange on bed');
  setTimeout(() => viewApi.fit?.(), 30);
}

/** Rotate a body so the clicked face lies on the bed, then drop it. */
export function layFlat(bodyId: string, worldNormal: THREE.Vector3) {
  const b = bodyById(bodyId);
  if (!b) return;
  const q = layFlatQuaternion(worldNormal);
  if (Math.abs(q.w) > 0.99999) { dropToGround([bodyId]); return; }
  const c = bodyBounds(b).getCenter(new THREE.Vector3());
  // lowest point after rotating about the centre
  const rot = new THREE.Matrix4().makeTranslation(c.x, c.y, c.z)
    .multiply(new THREE.Matrix4().makeRotationFromQuaternion(q))
    .multiply(new THREE.Matrix4().makeTranslation(-c.x, -c.y, -c.z))
    .multiply(b.matrix);
  const box = b.geometry.boundingBox ?? (b.geometry.computeBoundingBox(), b.geometry.boundingBox!);
  const pos = b.geometry.getAttribute('position');
  let minY = Infinity;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) minY = Math.min(minY, v.fromBufferAttribute(pos, i).applyMatrix4(rot).y);
  if (!Number.isFinite(minY)) minY = box.min.y;
  const e = new THREE.Euler().setFromQuaternion(q);
  const deg = (r: number) => Math.round((r * 180) / Math.PI * 1000) / 1000;
  const id = uid('m');
  store.commit('Lay flat', (doc) => {
    insertFeature(doc, {
      id, type: 'move', name: nextName(doc, 'Lay flat'), bodyIds: [bodyId], pivot: [round(c.x), round(c.y), round(c.z)],
      transform: { position: [0, round(-minY), 0], rotation: [deg(e.x), deg(e.y), deg(e.z)], scale: [1, 1, 1] }, copy: false,
    });
  }, { mode: 'model', selection: [bodyId] });
  store.toast('Laid flat — that face is now on the bed', 'success');
}

let clipboard: string[] = [];
export function copySelection() {
  clipboard = [...store.state.selection];
  if (clipboard.length) store.toast(`Copied ${clipboard.length} bod${clipboard.length > 1 ? 'ies' : 'y'}`);
}
export function paste() {
  const ids = clipboard.filter((id) => bodyById(id));
  if (ids.length) duplicate(ids);
}

export function duplicate(ids = store.state.selection) {
  if (!ids.length) return;
  const bodies = ids.map(bodyById).filter(Boolean) as EvalBody[];
  const box = selectionBounds(ids);
  const offset = Math.ceil((box.max.x - box.min.x + 5) / (store.state.snap || 1)) * (store.state.snap || 1);
  const newIds: string[] = [];
  store.commit('Duplicate', (doc) => {
    const viaMove: string[] = [];
    for (const b of bodies) {
      const src = doc.features.find((f) => f.id === b.id);
      if (src && src.type === 'primitive' && src.op === 'new' && b.editableFeatureId === b.id) {
        const copy = JSON.parse(JSON.stringify(src));
        copy.id = uid('p');
        copy.name = nextName(doc, shapeById(src.shape)?.label ?? 'Shape');
        copy.transform.position[0] = round(copy.transform.position[0] + offset);
        insertFeature(doc, copy);
        newIds.push(copy.id);
      } else viaMove.push(b.id);
    }
    if (viaMove.length) {
      const c = selectionBounds(viaMove).getCenter(new THREE.Vector3());
      const id = uid('m');
      insertFeature(doc, {
        id, type: 'move', name: nextName(doc, 'Copy'), bodyIds: viaMove, pivot: [round(c.x), round(c.y), round(c.z)],
        transform: { ...identityTRS(), position: [offset, 0, 0] }, copy: true,
      });
      newIds.push(...viaMove.map((b) => `${id}:${b}`));
    }
  }, { selection: newIds });
}

// ---------------------------------------------------------------------------
// modify

export function combine(op: 'join' | 'cut' | 'intersect') {
  const ids = store.state.selection;
  if (ids.length < 2) {
    store.toast(op === 'cut'
      ? 'Select the body to keep first, then Shift+click the shapes to cut away.'
      : 'Select two or more bodies (Shift+click) to combine them.');
    return;
  }
  const [targetId, ...toolIds] = ids;
  const id = uid('c');
  const labels = { join: 'Join', cut: 'Cut', intersect: 'Intersect' };
  store.commit(labels[op], (doc) => {
    insertFeature(doc, { id, type: 'combine', name: nextName(doc, labels[op]), targetId, toolIds, op, keepTools: false });
  }, { selection: [targetId], selectedFeature: id });
  store.toast(`${labels[op]} done — tweak it any time from the timeline.`, 'success');
}

export function setBodyOp(featureId: string, op: BodyOp) {
  const f = featureOf(store.doc, featureId);
  if (!f || !isCreating(f) || f.type === 'import') return;
  let targets = f.targets;
  if (op !== 'new' && !targets.length) {
    // auto-pick bodies that overlap the tool so beginners don't need to choose
    const tool = bodyById(featureId);
    const tb = tool ? bodyBounds(tool) : null;
    targets = store.state.result.bodies
      .filter((b) => b.id !== featureId && b.visible && tb && bodyBounds(b).intersectsBox(tb))
      .map((b) => b.id);
    if (!targets.length) {
      const others = store.state.result.bodies.filter((b) => b.id !== featureId);
      if (others.length) targets = [others[others.length - 1].id];
    }
  }
  updateFeature(featureId, { op, targets } as any, op === 'cut' ? 'Make hole' : op === 'join' ? 'Join' : 'Change operation');
  store.set({ selectedFeature: featureId });
}

export function addPattern(kind: 'linear' | 'circular') {
  const ids = store.state.selection;
  if (!ids.length) { store.toast('Select a body to repeat first.'); return; }
  const id = uid('pt');
  const box = selectionBounds(ids);
  const size = box.getSize(new THREE.Vector3());
  store.commit(kind === 'linear' ? 'Linear pattern' : 'Circular pattern', (doc) => {
    insertFeature(doc, {
      id, type: 'pattern', name: nextName(doc, kind === 'linear' ? 'Pattern' : 'Circular pattern'), bodyIds: [...ids], kind,
      count: kind === 'linear' ? 3 : 6, spacing: Math.ceil(size.x + 5), direction: 'x', angle: 360, axis: 'y', center: [0, 0, 0],
    } satisfies PatternFeature);
  }, { selectedFeature: id, selection: [] });
}

export function addMirror() {
  const ids = store.state.selection;
  if (!ids.length) { store.toast('Select a body to mirror first.'); return; }
  const id = uid('mr');
  store.commit('Mirror', (doc) => {
    insertFeature(doc, { id, type: 'mirror', name: nextName(doc, 'Mirror'), bodyIds: [...ids], plane: 'yz', offset: 0 } satisfies MirrorFeature);
  }, { selectedFeature: id, selection: [] });
}

// ---------------------------------------------------------------------------
// sketching

export function beginSketch() {
  store.set({ mode: 'pick-plane', selection: [], selectedFeature: null });
}

export function createSketch(plane: PlaneDef) {
  const id = uid('s');
  store.commit('New sketch', (doc) => {
    insertFeature(doc, { id, type: 'sketch', name: nextName(doc, 'Sketch'), plane, entities: [], visible: true } satisfies SketchFeature);
  }, { mode: 'sketch', sketchId: id, sketchTool: 'rect', sketchSelection: [], selectedFeature: id, selection: [] });
  viewApi.lookAtPlane?.(plane);
}

export function createSketchOnStandard(name: keyof typeof STANDARD_PLANES, offset = 0) {
  const p = STANDARD_PLANES[name];
  createSketch(offset ? { ...p, origin: p.normal.map((n) => n * offset) as Vec3, label: `${p.label} +${offset} mm` } : p);
}

export function editSketch(id: string) {
  const f = featureOf(store.doc, id);
  if (!f || f.type !== 'sketch') return;
  store.set({ mode: 'sketch', sketchId: id, sketchTool: 'select', sketchSelection: [], selectedFeature: id, selection: [] });
  viewApi.lookAtPlane?.(f.plane);
}

export function setSketchTool(tool: SketchTool) {
  store.set({ sketchTool: tool, sketchSelection: [], sketchConstraint: null });
}

const CONSTRAINT_LABEL: Partial<Record<ConstraintType, string>> = {
  coincident: 'Coincident', horizontal: 'Horizontal', vertical: 'Vertical', parallel: 'Parallel', perpendicular: 'Perpendicular',
  equal: 'Equal', tangent: 'Tangent', concentric: 'Concentric', midpoint: 'Midpoint', fix: 'Lock', symmetric: 'Symmetric',
};

/** Constraint button: applies straight away to a fitting selection, otherwise waits for picks. */
export function constraintTool(type: ConstraintType) {
  const s = activeSketch();
  if (!s) return;
  const refs = store.state.sketchSelection.map(parseRefKey).filter((r): r is SkRef => !!r);
  if (refs.length) {
    const cs = constraintsFor(type, refs, s);
    if (Array.isArray(cs)) { if (addConstraints(cs, CONSTRAINT_LABEL[type])) store.set({ sketchSelection: [] }); return; }
  }
  store.set({ sketchTool: 'constrain', sketchConstraint: type, sketchSelection: [] });
}

/** A pick while the Constrain tool is active. */
export function pickForConstraint(ref: SkRef) {
  const s = activeSketch();
  const type = store.state.sketchConstraint;
  if (!s || !type) return;
  const key = refKey(ref);
  const cur = store.state.sketchSelection;
  if (cur.includes(key)) { store.set({ sketchSelection: cur.filter((k) => k !== key) }); return; }
  const keys = [...cur, key];
  const refs = keys.map(parseRefKey).filter((r): r is SkRef => !!r);
  const cs = constraintsFor(type, refs, s);
  if (cs === 'bad') {
    store.toast(`${CONSTRAINT_LABEL[type]} needs ${constraintNeeds(type)}.`);
    store.set({ sketchSelection: [] });
  } else if (cs === null) {
    store.set({ sketchSelection: keys });
  } else {
    addConstraints(cs, CONSTRAINT_LABEL[type]);
    store.set({ sketchSelection: [] });
  }
}

const sketchRecipe = (fn: (s: SketchFeature) => void) => (doc: DesignDoc) => {
  const s = doc.features.find((f) => f.id === store.state.sketchId);
  if (s?.type === 'sketch') fn(s);
};

export const activeSketch = (): SketchFeature | undefined => {
  const f = featureOf(store.doc, store.state.sketchId);
  return f?.type === 'sketch' ? f : undefined;
};

/** Re-solve a sketch after an edit, preferring to keep `keep` (entity id → parameter indices) as they are. */
function resolve(s: SketchFeature, keep?: Record<string, number[] | 'all'>) {
  if (!s.constraints?.length && !s.entities.some((e) => e.kind === 'arc')) return true;
  const keys = new Set<string>();
  for (const [id, ks] of Object.entries(keep ?? {})) {
    const e = s.entities.find((x) => x.id === id);
    if (!e) continue;
    for (const k of ks === 'all' ? Array.from({ length: paramCount(e) }, (_, i) => i) : ks) keys.add(`${id}:${k}`);
  }
  const r = solveSketch(s.entities, withValues(s.constraints ?? [], store.state.result.vars ?? {}), { keep: keys });
  if (r.ok) s.entities = r.entities;
  return r.ok;
}

export function addSketchEntity(e: SketchEntity, constraints: SketchConstraint[] = []) {
  store.commit('Draw', sketchRecipe((s) => {
    s.entities.push(e);
    if (constraints.length) {
      s.constraints = [...(s.constraints ?? []), ...constraints];
      resolve(s, { [e.id]: 'all' });
    }
  }));
}

export function updateSketchEntity(id: string, patch: Partial<SketchEntity>, live = false) {
  const r = sketchRecipe((s) => {
    const e = s.entities.find((x) => x.id === id);
    if (!e) return;
    Object.assign(e, patch);
    resolve(s, { [id]: 'all' });
  });
  if (live) store.transient(r);
  else store.commit('Edit sketch', r);
}

/** Replace a sketch's entities wholesale (live while dragging). */
export function setSketchEntities(entities: SketchEntity[]) {
  store.transient(sketchRecipe((s) => { s.entities = entities; }));
}

/** Selected sketch items are stored as keys: `id` (whole shape), `id.p2` (a point), `id.s0` (a segment), `#cid` (a constraint). */
export const refKey = (r: SkRef) => (r.p !== undefined ? `${r.e}.p${r.p}` : r.s !== undefined ? `${r.e}.s${r.s}` : r.e);
export function parseRefKey(k: string): SkRef | null {
  if (k.startsWith('#')) return null;
  const m = /^(.+?)\.([ps])(\d+)$/.exec(k);
  if (!m) return { e: k };
  return m[2] === 'p' ? { e: m[1], p: Number(m[3]) } : { e: m[1], s: Number(m[3]) };
}

export function deleteSketchEntities(keys = store.state.sketchSelection) {
  if (!keys.length) return;
  const cids = keys.filter((k) => k.startsWith('#')).map((k) => k.slice(1));
  const ids = new Set(keys.map(parseRefKey).filter((r): r is SkRef => !!r && r.e !== ORIGIN).map((r) => r.e));
  store.commit(ids.size ? 'Delete sketch lines' : 'Delete constraint', sketchRecipe((s) => {
    s.entities = s.entities.filter((e) => !ids.has(e.id));
    s.constraints = liveConstraints(s.entities, (s.constraints ?? []).filter((c) => !cids.includes(c.id)));
  }), { sketchSelection: [] });
}

/** Turn the selected shapes into construction geometry (or back). */
export function toggleConstruction(keys = store.state.sketchSelection) {
  const ids = new Set(keys.map(parseRefKey).filter((r): r is SkRef => !!r).map((r) => r.e));
  const s = activeSketch();
  if (!s || !ids.size) { store.toast('Select sketch shapes first, then press X to make them construction lines.'); return; }
  const on = !s.entities.filter((e) => ids.has(e.id)).every((e) => e.construction);
  store.commit(on ? 'Make construction' : 'Make normal', sketchRecipe((sk) => {
    for (const e of sk.entities) if (ids.has(e.id)) e.construction = on || undefined;
  }));
}

const NEEDS: Record<string, string> = {
  coincident: 'two points (or a point and a line or circle)',
  horizontal: 'a line, or two points',
  vertical: 'a line, or two points',
  parallel: 'two lines',
  perpendicular: 'two lines',
  equal: 'two lines or two circles',
  tangent: 'a line and a circle, or two circles',
  concentric: 'two circles or arcs',
  midpoint: 'a point and a line',
  fix: 'points or shapes to lock',
  symmetric: 'two points and a line to mirror across',
};
export const constraintNeeds = (t: ConstraintType) => NEEDS[t] ?? '';

/** Points that make up a referenced segment or shape (for locking). */
function pointsOf(e: SketchEntity, r: SkRef): number[] {
  if (r.p !== undefined) return [r.p];
  const n = entityPoints(e).length;
  if (r.s !== undefined) {
    if (e.kind === 'polyline') return [r.s, (r.s + 1) % e.points.length];
    if (e.kind === 'rect') return [r.s, (r.s + 1) % 4];
    if (e.kind === 'polygon') return [1 + r.s, 1 + ((r.s + 1) % e.sides)];
    return [0, 1];
  }
  if (e.kind === 'rect') return [0, 2];
  if (e.kind === 'polygon') return [0, 1];
  return Array.from({ length: n }, (_, i) => i);
}

/**
 * Build constraints of `type` from picked references. Returns null when the picks don't
 * fit yet (more picks may still make it work) and 'bad' when they never will.
 */
export function constraintsFor(type: ConstraintType, refs: SkRef[], s: SketchFeature): SketchConstraint[] | null | 'bad' {
  const ents = new Map(s.entities.map((e) => [e.id, e]));
  const kind = (r: SkRef): string => (refPoint(ents, r) ? 'point' : refLine(ents, r) ? 'line' : refCircle(ents, r) ? 'circle' : 'other');
  const ks = refs.map(kind);
  const mk = (t: ConstraintType, rs: SkRef[], extra: Partial<SketchConstraint> = {}): SketchConstraint => ({ id: uid('c'), type: t, refs: rs, ...extra });
  const has = (k: string) => ks.indexOf(k);
  if (ks.includes('other')) return 'bad';
  switch (type) {
    case 'coincident': {
      if (refs.length < 2) return ks[0] === 'point' || ks[0] === 'line' || ks[0] === 'circle' ? null : 'bad';
      const pi = has('point');
      if (pi < 0) return 'bad';
      const other = refs[1 - pi], ok = ks[1 - pi];
      return ok === 'point' ? [mk('coincident', refs)] : [mk('onCurve', [refs[pi], other])];
    }
    case 'horizontal':
    case 'vertical':
      if (ks[0] === 'line') return refs.map((r) => mk(type, [r]));
      if (ks[0] !== 'point') return 'bad';
      if (refs.length < 2) return null;
      return ks[1] === 'point' ? [mk(type, refs)] : 'bad';
    case 'parallel':
    case 'perpendicular':
      if (ks[0] !== 'line') return 'bad';
      if (refs.length < 2) return null;
      return ks[1] === 'line' ? [mk(type, refs)] : 'bad';
    case 'equal':
      if (ks[0] !== 'line' && ks[0] !== 'circle') return 'bad';
      if (refs.length < 2) return null;
      return ks[1] === ks[0] ? [mk('equal', refs)] : 'bad';
    case 'concentric':
      if (ks[0] !== 'circle') return 'bad';
      if (refs.length < 2) return null;
      return ks[1] === 'circle' ? [mk('concentric', refs)] : 'bad';
    case 'tangent': {
      if (ks[0] !== 'line' && ks[0] !== 'circle') return 'bad';
      if (refs.length < 2) return null;
      if (ks[0] === 'line' && ks[1] === 'line') return 'bad';
      if (ks[0] === 'circle' && ks[1] === 'circle') {
        const a = refCircle(ents, refs[0])!, b = refCircle(ents, refs[1])!;
        const d = Math.hypot(a.c[0] - b.c[0], a.c[1] - b.c[1]);
        return [mk('tangent', refs, { inner: d < Math.max(a.r, b.r) })];
      }
      return [mk('tangent', refs)];
    }
    case 'midpoint': {
      if (refs.length < 2) return ks[0] === 'point' || ks[0] === 'line' ? null : 'bad';
      const pi = has('point'), li = has('line');
      return pi >= 0 && li >= 0 ? [mk('midpoint', [refs[pi], refs[li]])] : 'bad';
    }
    case 'fix': {
      const out: SketchConstraint[] = [];
      for (const r of refs) {
        if (r.e === ORIGIN) continue;
        const e = ents.get(r.e)!;
        for (const p of pointsOf(e, r)) out.push(mk('fix', [{ e: r.e, p }], { at: [...entityPoints(e)[p]] as [number, number] }));
      }
      return out.length ? out : 'bad';
    }
    case 'symmetric': {
      if (refs.length < 3) return ks.every((k) => k === 'point' || k === 'line') ? null : 'bad';
      const pts = refs.filter((_, i) => ks[i] === 'point'), lines = refs.filter((_, i) => ks[i] === 'line');
      return pts.length === 2 && lines.length === 1 ? [mk('symmetric', [pts[0], pts[1], lines[0]])] : 'bad';
    }
  }
  return 'bad';
}

/** Add constraints to the active sketch. Refuses (with a message) if they'd fight existing ones. */
export function addConstraints(cs: SketchConstraint[], label = 'Constrain') {
  const s = activeSketch();
  if (!s || !cs.length) return false;
  const all = [...(s.constraints ?? []), ...cs];
  const r = solveSketch(s.entities, withValues(all, store.state.result.vars ?? {}));
  if (!r.ok) {
    store.toast('That would fight the sketch’s other constraints, so it wasn’t added. Remove a constraint or dimension first.', 'error');
    return false;
  }
  store.commit(label, sketchRecipe((sk) => { sk.constraints = all; sk.entities = r.entities; }));
  return true;
}

/** Add a driving dimension at its current measurement; returns its id. */
export function addDimension(type: ConstraintType, refs: SkRef[], offset?: [number, number]): string | null {
  const s = activeSketch();
  if (!s) return null;
  const ents = new Map(s.entities.map((e) => [e.id, e]));
  const c: SketchConstraint = { id: uid('d'), type, refs, offset };
  const v = measure(ents, c);
  if (v === null || !Number.isFinite(v)) return null;
  c.value = Math.round(v * 1000) / 1000;
  return addConstraints([c], 'Dimension') ? c.id : null;
}

/** Set a dimension to a number or an expression like `width / 2`. */
export function setDimension(id: string, text: string) {
  const s = activeSketch();
  const c = s?.constraints?.find((x) => x.id === id);
  if (!s || !c) return false;
  const vars = store.state.result.vars ?? {};
  let value: number;
  try { value = evalExpr(text, vars); } catch (e: any) { store.toast(`Can’t use “${text}”: ${e.message}`, 'error'); return false; }
  if (c.type !== 'angle' && value < 0) { store.toast('Sizes can’t be negative.', 'error'); return false; }
  const expr = usesNames(text) ? text.replace(/^=/, '').trim() : undefined;
  const next = s.constraints!.map((x) => (x.id === id ? { ...x, value, expr } : x));
  const r = solveSketch(s.entities, withValues(next, vars));
  if (!r.ok) { store.toast('The sketch can’t reach that size with its other constraints.', 'error'); return false; }
  store.commit('Change dimension', sketchRecipe((sk) => { sk.constraints = next; sk.entities = r.entities; }));
  return true;
}

/** Set a dimension to a plain number (live while scrubbing). */
export function setDimensionValue(id: string, value: number, live = false) {
  const s = activeSketch();
  if (!s?.constraints?.some((x) => x.id === id)) return false;
  const next = s.constraints.map((x) => (x.id === id ? { ...x, value, expr: undefined } : x));
  const r = solveSketch(s.entities, withValues(next, store.state.result.vars ?? {}));
  if (!r.ok) { if (!live) store.toast('The sketch can’t reach that size with its other constraints.', 'error'); return false; }
  const recipe = sketchRecipe((sk) => { sk.constraints = next; sk.entities = r.entities; });
  if (live) store.transient(recipe);
  else store.commit('Change dimension', recipe);
  return true;
}

/** Move a dimension's label (live while dragging). */
export function setDimensionOffset(id: string, offset: [number, number], live: boolean) {
  const r = sketchRecipe((sk) => { const c = sk.constraints?.find((x) => x.id === id); if (c) c.offset = offset; });
  if (live) store.transient(r);
  else store.commit('Move dimension', r);
}

/** Bring imported 2D geometry (e.g. from DXF) into the open sketch, or a new sketch on the ground. */
export function importSketchEntities(name: string, entities: SketchEntity[]) {
  if (!entities.length) { store.toast('No 2D shapes found in that file.', 'error'); return; }
  const open = activeSketch();
  if (open && store.state.mode === 'sketch') {
    store.commit(`Import ${name}`, sketchRecipe((s) => { s.entities.push(...entities); }));
  } else {
    const id = uid('s');
    const plane = STANDARD_PLANES.top;
    store.commit(`Import ${name}`, (doc) => {
      insertFeature(doc, { id, type: 'sketch', name, plane, entities, visible: true } satisfies SketchFeature);
    }, { mode: 'sketch', sketchId: id, sketchTool: 'select', sketchSelection: [], selectedFeature: id, selection: [] });
    viewApi.lookAtPlane?.(plane);
  }
  setTimeout(() => viewApi.fit?.(), 60);
}

export function finishSketch() {
  const id = store.state.sketchId;
  const f = featureOf(store.doc, id);
  store.set({ mode: 'model', sketchId: null, sketchSelection: [] });
  if (f?.type === 'sketch' && f.entities.length === 0) {
    deleteFeature(f.id);
    return;
  }
  if (f) store.set({ selectedFeature: f.id });
}

function sketchForProfile(): SketchFeature | undefined {
  const { sketchId, selectedFeature } = store.state;
  const cand = featureOf(store.doc, sketchId ?? selectedFeature);
  if (cand?.type === 'sketch') return cand;
  // fall back to the most recent visible sketch
  return [...store.doc.features.slice(0, store.doc.marker)].reverse().find((f) => f.type === 'sketch' && f.visible) as SketchFeature | undefined;
}

export function extrude() {
  const s = sketchForProfile();
  if (!s) { store.toast('Draw a sketch first, then Extrude it into 3D.'); beginSketch(); return; }
  if (store.state.mode === 'sketch') store.set({ mode: 'model', sketchId: null });
  const id = uid('e');
  store.commit('Extrude', (doc) => {
    insertFeature(doc, {
      id, type: 'extrude', name: nextName(doc, 'Extrude'), sketchId: s.id, distance: 10, symmetric: false, roundEdges: 0,
      op: 'new', targets: [], transform: identityTRS(), appearance: { color: nextColor(), material: 'pla' },
    } satisfies ExtrudeFeature);
    const sk = doc.features.find((f) => f.id === s.id) as SketchFeature;
    sk.visible = false;
  }, { selectedFeature: id, selection: [id] });
}

export function revolve() {
  const s = sketchForProfile();
  if (!s) { store.toast('Draw a sketch first, then Revolve it around an axis.'); beginSketch(); return; }
  if (store.state.mode === 'sketch') store.set({ mode: 'model', sketchId: null });
  const id = uid('r');
  store.commit('Revolve', (doc) => {
    insertFeature(doc, {
      id, type: 'revolve', name: nextName(doc, 'Revolve'), sketchId: s.id, axis: 'y', angle: 360,
      op: 'new', targets: [], transform: identityTRS(), appearance: { color: nextColor(), material: 'pla' },
    } satisfies RevolveFeature);
    const sk = doc.features.find((f) => f.id === s.id) as SketchFeature;
    sk.visible = false;
  }, { selectedFeature: id, selection: [id] });
}

// ---------------------------------------------------------------------------
// misc

export function worldMatrixOfFeature(id: string): THREE.Matrix4 | null {
  const f = featureOf(store.doc, id) as any;
  const frame = store.state.result.frames[id];
  if (!f?.transform || !frame) return null;
  return frame.clone().multiply(trsMatrix(f.transform));
}

export type { MoveFeature };

// ---------------------------------------------------------------------------
// advanced modelling

/** Sketches before the history marker, newest first. */
function recentSketches(): SketchFeature[] {
  return store.doc.features.slice(0, store.doc.marker).filter((f) => f.type === 'sketch').reverse() as SketchFeature[];
}
const hasClosed = (s: SketchFeature) => s.entities.some((e) => entityOutline(e).closed);
const hasOpen = (s: SketchFeature) => s.entities.some((e) => (e.kind === 'polyline' || e.kind === 'spline') && !e.closed);

export function addLoft() {
  const secs = recentSketches().filter(hasClosed).slice(0, 2).reverse();
  if (secs.length < 2) {
    store.toast('Loft blends between shapes: draw two closed sketches on different planes or heights first.');
    return;
  }
  const id = uid('lf');
  store.commit('Loft', (doc) => {
    insertFeature(doc, {
      id, type: 'loft', name: nextName(doc, 'Loft'), sketchIds: secs.map((s) => s.id), smooth: true,
      op: 'new', targets: [], transform: identityTRS(), appearance: { color: nextColor(), material: 'pla' },
    });
    for (const s of secs) (doc.features.find((f) => f.id === s.id) as SketchFeature).visible = false;
  }, { selectedFeature: id, selection: [id], mode: 'model', sketchId: null });
}

export function addSweep() {
  const sk = recentSketches();
  const path = sk.find(hasOpen);
  const profile = sk.find((s) => s !== path && hasClosed(s));
  if (!path || !profile) {
    store.toast('Sweep needs two sketches: a closed shape (the profile) and an open line or spline (the path).');
    return;
  }
  const id = uid('sw');
  store.commit('Sweep', (doc) => {
    insertFeature(doc, {
      id, type: 'sweep', name: nextName(doc, 'Sweep'), profileId: profile.id, pathId: path.id, twist: 0,
      op: 'new', targets: [], transform: identityTRS(), appearance: { color: nextColor(), material: 'pla' },
    });
    for (const s of [path, profile]) (doc.features.find((f) => f.id === s.id) as SketchFeature).visible = false;
  }, { selectedFeature: id, selection: [id], mode: 'model', sketchId: null });
}

export function addSplit() {
  const ids = store.state.selection;
  if (ids.length !== 1) { store.toast('Select one body to split — great for printing big parts in pieces.'); return; }
  const b = bodyById(ids[0])!;
  const c = bodyBounds(b).getCenter(new THREE.Vector3());
  const id = uid('sp');
  store.commit('Split', (doc) => {
    insertFeature(doc, { id, type: 'split', name: nextName(doc, 'Split'), bodyId: b.id, axis: 'y', offset: round(c.y, 0.5) });
  }, { selectedFeature: id, selection: [] });
}

/** Bind (or unbind with null) a parameter expression to a feature field. */
export function setExpr(fid: string, path: string, expr: string | null): boolean {
  if (expr) {
    try { evalExpr(expr, store.state.result.vars); } catch (e: any) { store.toast(e.message, 'error'); return false; }
  }
  store.commit(expr ? 'Use parameter' : 'Remove formula', (doc) => {
    const f = doc.features.find((x) => x.id === fid);
    if (!f) return;
    const exprs = { ...(f.exprs ?? {}) };
    if (expr) exprs[path] = expr; else delete exprs[path];
    f.exprs = exprs;
  });
  return true;
}

export function setParams(params: NonNullable<DesignDoc['params']>) {
  store.commit('Change parameters', (doc) => { doc.params = params; });
}

// ---------------------------------------------------------------------------
// precise tools: fillet / chamfer / shell / draft by picking edges and faces

const PICK_DEFAULTS = { fillet: 2, chamfer: 1, shell: 2, draft: 3 } as const;

export function beginPick(op: PickState['op']) {
  const kind = op === 'fillet' || op === 'chamfer' ? 'edges' : 'faces';
  store.set({ mode: 'pick', pick: { op, kind, refs: [], value: PICK_DEFAULTS[op] }, contextMenu: null });
}

export function editPick(featureId: string) {
  const f = featureOf(store.doc, featureId);
  if (!f || (f.type !== 'fillet' && f.type !== 'shell' && f.type !== 'draft')) return;
  const op = f.type === 'fillet' ? f.mode : f.type;
  const pts = f.type === 'fillet' ? f.edges : f.faces;
  store.set({
    mode: 'pick',
    pick: {
      op, kind: f.type === 'fillet' ? 'edges' : 'faces', featureId,
      refs: pts.map((point, i) => ({ bodyId: f.bodyId, point, sid: -1 - i })),
      value: f.type === 'fillet' ? f.radius : f.type === 'shell' ? f.thickness : f.angle,
    },
  });
}

export function togglePickRef(bodyId: string, point: Vec3, sid: number) {
  const p = store.state.pick;
  if (!p) return;
  const i = p.refs.findIndex((r) => r.bodyId === bodyId && (r.sid === sid || (r.sid < 0 && new THREE.Vector3(...r.point).distanceTo(new THREE.Vector3(...point)) < 0.5)));
  const refs = i >= 0 ? p.refs.filter((_, j) => j !== i) : [...p.refs, { bodyId, point, sid }];
  store.set({ pick: { ...p, refs } });
}

export function setPickValue(value: number) {
  const p = store.state.pick;
  if (p) store.set({ pick: { ...p, value } });
}

export function setPickOp(op: PickState['op']) {
  const p = store.state.pick;
  if (p) store.set({ pick: { ...p, op } });
}

export function cancelPick() {
  store.set({ mode: 'model', pick: null });
}

/** Turn the picked edges/faces into timeline steps (one per body). */
export function applyPick() {
  const p = store.state.pick;
  if (!p) return;
  let groups = new Map<string, Vec3[]>();
  for (const r of p.refs) groups.set(r.bodyId, [...(groups.get(r.bodyId) ?? []), r.point]);
  if (!groups.size) {
    // nothing picked: apply to the whole selected body (all edges / open top face)
    const b = store.state.selection[0];
    if (!b || p.op === 'draft') { store.toast(p.kind === 'edges' ? 'Click the edges to round first.' : 'Click the faces first.'); return; }
    groups = new Map([[b, []]]);
  }
  const label = { fillet: 'Fillet', chamfer: 'Chamfer', shell: 'Shell', draft: 'Draft' }[p.op];
  let lastId = p.featureId ?? '';
  store.commit(label, (doc) => {
    for (const [bodyId, pts] of groups) {
      const existing = p.featureId ? doc.features.find((f) => f.id === p.featureId) : undefined;
      if (existing && (existing.type === 'fillet' || existing.type === 'shell' || existing.type === 'draft') && existing.bodyId === bodyId) {
        if (existing.type === 'fillet') Object.assign(existing, { edges: pts, radius: p.value, mode: p.op === 'chamfer' ? 'chamfer' : 'fillet' });
        else if (existing.type === 'shell') Object.assign(existing, { faces: pts, thickness: p.value });
        else Object.assign(existing, { faces: pts, angle: p.value });
        continue;
      }
      const id = uid('fx');
      lastId = id;
      const base = { id, name: nextName(doc, label), bodyId };
      insertFeature(doc, p.op === 'fillet' || p.op === 'chamfer'
        ? { ...base, type: 'fillet', mode: p.op, edges: pts, radius: p.value }
        : p.op === 'shell' ? { ...base, type: 'shell', faces: pts, thickness: p.value }
          : { ...base, type: 'draft', faces: pts, angle: p.value });
    }
  }, { mode: 'model', pick: null, selectedFeature: lastId || null, selection: [...groups.keys()].slice(0, 1) });
}
