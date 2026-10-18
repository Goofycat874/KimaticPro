import * as THREE from 'three';
import { store } from './store';
import type { SketchTool } from './store';
import { bodyBounds, featureOf, trsMatrix, type EvalBody } from './evaluator';
import { defaultParams, shapeById } from './primitives';
import { nextColor } from './materials';
import { STANDARD_PLANES } from './sketch';
import { arrangeOnBed, layFlatQuaternion } from './printing';
import {
  identityTRS, isCreating, uid,
  type Appearance, type BodyOp, type DesignDoc, type ExtrudeFeature, type Feature, type MoveFeature,
  type PatternFeature, type MirrorFeature, type PlaneDef, type RevolveFeature, type SketchEntity, type SketchFeature, type TRS, type Vec3,
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

export function importMesh(name: string, data: string) {
  const id = uid('i');
  store.commit(`Import ${name}`, (doc) => {
    insertFeature(doc, {
      id, type: 'import', name, data, transform: identityTRS(),
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

export function createSketchOnStandard(name: keyof typeof STANDARD_PLANES) {
  createSketch(STANDARD_PLANES[name]);
}

export function editSketch(id: string) {
  const f = featureOf(store.doc, id);
  if (!f || f.type !== 'sketch') return;
  store.set({ mode: 'sketch', sketchId: id, sketchTool: 'select', sketchSelection: [], selectedFeature: id, selection: [] });
  viewApi.lookAtPlane?.(f.plane);
}

export function setSketchTool(tool: SketchTool) {
  store.set({ sketchTool: tool, sketchSelection: [] });
}

const sketchRecipe = (fn: (s: SketchFeature) => void) => (doc: DesignDoc) => {
  const s = doc.features.find((f) => f.id === store.state.sketchId);
  if (s?.type === 'sketch') fn(s);
};

export function addSketchEntity(e: SketchEntity) {
  store.commit('Draw', sketchRecipe((s) => { s.entities.push(e); }));
}

export function updateSketchEntity(id: string, patch: Partial<SketchEntity>, live = false) {
  const r = sketchRecipe((s) => {
    const e = s.entities.find((x) => x.id === id);
    if (e) Object.assign(e, patch);
  });
  if (live) store.transient(r);
  else store.commit('Edit sketch', r);
}

export function deleteSketchEntities(ids = store.state.sketchSelection) {
  if (!ids.length) return;
  store.commit('Delete sketch lines', sketchRecipe((s) => { s.entities = s.entities.filter((e) => !ids.includes(e.id)); }), { sketchSelection: [] });
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
