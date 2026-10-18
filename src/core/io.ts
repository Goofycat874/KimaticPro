import * as THREE from 'three';
import { STLExporter } from 'three/examples/jsm/exporters/STLExporter.js';
import { OBJExporter } from 'three/examples/jsm/exporters/OBJExporter.js';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { store, emptyDoc } from './store';
import { importMesh, viewApi } from './actions';
import { encodePositions } from './geometry';
import { materialById } from './materials';
import { build3MF } from './printing';
import type { DesignDoc } from './types';

export function download(blob: Blob, filename: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

const safeName = () => (store.doc.name || 'design').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-') || 'design';

/** Builds a scene of the visible bodies in world space (Y-up, millimetres). */
function exportScene(onlySelection: boolean) {
  const scene = new THREE.Scene();
  const ids = new Set(store.state.selection);
  for (const b of store.state.result.bodies) {
    if (!b.visible) continue;
    if (onlySelection && ids.size && !ids.has(b.id)) continue;
    const mat = materialById(b.appearance.material);
    const mesh = new THREE.Mesh(
      b.geometry,
      new THREE.MeshStandardMaterial({ color: b.appearance.color, metalness: mat.metalness, roughness: mat.roughness }),
    );
    mesh.name = b.name;
    mesh.matrixAutoUpdate = false;
    mesh.matrix.copy(b.matrix);
    scene.add(mesh);
  }
  scene.updateMatrixWorld(true);
  return scene;
}

export type ExportFormat = 'step' | 'stl' | '3mf' | 'obj' | 'glb' | 'png' | 'kimatic';

export async function exportAs(format: ExportFormat, onlySelection = false) {
  const name = safeName();
  if (format === 'kimatic') return saveProject();
  if (format === 'png') {
    const url = viewApi.screenshot?.();
    if (!url) return;
    const blob = await (await fetch(url)).blob();
    download(blob, `${name}.png`);
    return;
  }
  if (format === 'step') {
    try {
      store.toast('Building exact STEP solids…');
      const { kernel } = await import('../kernel/client');
      const ids = onlySelection && store.state.selection.length ? store.state.selection : null;
      const { blob, skipped } = await kernel.exportStep(store.doc, ids);
      if (!blob) { store.toast('Nothing exact to export — threads and imported meshes have no STEP form.', 'error'); return; }
      download(blob, `${name}.step`);
      store.toast(skipped.length ? `Exported ${name}.step (skipped mesh bodies: ${skipped.join(', ')})` : `Exported ${name}.step`, 'success');
    } catch (e: any) {
      store.toast(e?.message ?? 'STEP export failed', 'error');
    }
    return;
  }
  if (format === '3mf') {
    const ids = new Set(store.state.selection);
    const bodies = store.state.result.bodies.filter((b) => b.visible && (!onlySelection || !ids.size || ids.has(b.id)));
    if (!bodies.length) { store.toast('Nothing to export yet — add a shape first!', 'error'); return; }
    const data = build3MF(bodies.map((b) => ({ name: b.name, geometry: b.geometry, matrix: b.matrix, color: b.appearance.color })));
    download(new Blob([data as BlobPart], { type: 'model/3mf' }), `${name}.3mf`);
    store.toast(`Exported ${name}.3mf`, 'success');
    return;
  }
  const scene = exportScene(onlySelection);
  if (!scene.children.length) { store.toast('Nothing to export yet — add a shape first!', 'error'); return; }
  if (format === 'stl') {
    // STL is conventionally Z-up for 3D printers
    const zUp = new THREE.Group();
    zUp.rotation.x = Math.PI / 2;
    zUp.add(...scene.children);
    scene.add(zUp);
    scene.updateMatrixWorld(true);
    const data = new STLExporter().parse(scene, { binary: true }) as DataView;
    download(new Blob([data.buffer as ArrayBuffer], { type: 'model/stl' }), `${name}.stl`);
  } else if (format === 'obj') {
    download(new Blob([new OBJExporter().parse(scene)], { type: 'text/plain' }), `${name}.obj`);
  } else if (format === 'glb') {
    // glTF is metres
    const root = new THREE.Group();
    root.scale.setScalar(0.001);
    root.add(...scene.children);
    scene.add(root);
    const glb = (await new GLTFExporter().parseAsync(scene, { binary: true })) as ArrayBuffer;
    download(new Blob([glb], { type: 'model/gltf-binary' }), `${name}.glb`);
  }
  store.toast(`Exported ${name}.${format}`, 'success');
}

export function serialize(doc: DesignDoc = store.doc) {
  return JSON.stringify(doc);
}

export function saveProject() {
  download(new Blob([serialize()], { type: 'application/json' }), `${safeName()}.kimatic`);
  store.set({ dirty: false });
  store.toast('Design saved to your computer', 'success');
}

export function parseProject(text: string): DesignDoc {
  const doc = JSON.parse(text);
  if (doc?.format !== 'kimatic' || !Array.isArray(doc.features)) throw new Error('Not a KimaticPro design file.');
  return { ...emptyDoc(), ...doc, marker: Math.min(doc.marker ?? doc.features.length, doc.features.length) };
}

function meshPositions(object: THREE.Object3D): Float32Array {
  const geos: THREE.BufferGeometry[] = [];
  object.updateMatrixWorld(true);
  object.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh && m.geometry) {
      const g = (m.geometry.index ? m.geometry.toNonIndexed() : m.geometry.clone());
      for (const k of Object.keys(g.attributes)) if (k !== 'position') g.deleteAttribute(k);
      g.applyMatrix4(m.matrixWorld);
      geos.push(g);
    }
  });
  if (!geos.length) throw new Error('No mesh found in that file.');
  const merged = geos.length === 1 ? geos[0] : mergeGeometries(geos, false)!;
  return merged.getAttribute('position').array as Float32Array;
}

export async function openFile(file: File) {
  const ext = file.name.split('.').pop()?.toLowerCase();
  const base = file.name.replace(/\.[^.]+$/, '');
  try {
    if (ext === 'kimatic' || ext === 'json') {
      const doc = parseProject(await file.text());
      store.load(doc);
      setTimeout(() => viewApi.fit?.(), 50);
      store.toast(`Opened ${doc.name}`, 'success');
    } else if (ext === 'step' || ext === 'stp') {
      store.toast(`Reading ${file.name}…`);
      const { kernel } = await import('../kernel/client');
      const r = await kernel.importStep(await file.text());
      importMesh(base, r.mesh, r.step);
      store.toast(`Imported ${base} (${r.faces} faces, exact)`, 'success');
    } else if (ext === 'stl') {
      const geo = new STLLoader().parse(await file.arrayBuffer());
      // STL is Z-up: rotate into KimaticPro's Y-up world
      geo.rotateX(-Math.PI / 2);
      const pos = new Float32Array(geo.getAttribute('position').array);
      importMesh(base, encodePositions(groundPositions(pos)));
    } else if (ext === 'obj') {
      const obj = new OBJLoader().parse(await file.text());
      importMesh(base, encodePositions(groundPositions(new Float32Array(meshPositions(obj)))));
    } else {
      store.toast(`Can't open .${ext} files yet. Try .kimatic, .step, .stl or .obj`, 'error');
    }
  } catch (err: any) {
    store.toast(err?.message ?? 'Could not open that file', 'error');
  }
}

/** Centre the imported mesh on X/Z and rest it on the ground. */
function groundPositions(pos: Float32Array) {
  const box = new THREE.Box3();
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.length; i += 3) box.expandByPoint(v.set(pos[i], pos[i + 1], pos[i + 2]));
  const cx = (box.min.x + box.max.x) / 2, cz = (box.min.z + box.max.z) / 2;
  for (let i = 0; i < pos.length; i += 3) { pos[i] -= cx; pos[i + 1] -= box.min.y; pos[i + 2] -= cz; }
  return pos;
}

export function pickFile(accept = '.kimatic,.json,.step,.stp,.stl,.obj') {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = accept;
  input.onchange = () => { if (input.files?.[0]) openFile(input.files[0]); };
  input.click();
}
