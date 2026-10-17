import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { buildShape, SHAPES } from '../core/primitives';
import { evaluate } from '../core/evaluator';
import { materialById } from '../core/materials';
import type { DesignDoc } from '../core/types';

let renderer: THREE.WebGLRenderer | null = null;
let env: THREE.Texture | null = null;
const cache = new Map<string, string>();

function setup(size: number) {
  if (!renderer) {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    const pm = new THREE.PMREMGenerator(renderer);
    env = pm.fromScene(new RoomEnvironment(), 0.04).texture;
  }
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
  renderer.setSize(size, size, false);
  return renderer;
}

function renderObjects(meshes: THREE.Mesh[], size: number, dir = new THREE.Vector3(1, 0.85, 1.25)) {
  const r = setup(size);
  const scene = new THREE.Scene();
  scene.environment = env;
  scene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 0.6));
  const sun = new THREE.DirectionalLight(0xffffff, 1.4);
  sun.position.set(3, 5, 4);
  scene.add(sun);
  const box = new THREE.Box3();
  for (const m of meshes) { scene.add(m); m.updateMatrixWorld(true); box.expandByObject(m); }
  const sphere = box.getBoundingSphere(new THREE.Sphere());
  const cam = new THREE.PerspectiveCamera(30, 1, 0.1, 10000);
  const dist = sphere.radius / Math.sin((cam.fov * Math.PI) / 360) * 1.05;
  cam.position.copy(sphere.center).addScaledVector(dir.normalize(), dist);
  cam.lookAt(sphere.center);
  cam.near = dist / 100; cam.far = dist * 10; cam.updateProjectionMatrix();
  r.render(scene, cam);
  return r.domElement.toDataURL('image/png');
}

/** Rendered preview of a shape for the shape gallery. */
export function shapeThumbnail(id: string, size = 96) {
  const key = `shape:${id}:${size}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const def = SHAPES.find((s) => s.id === id)!;
  const geo = buildShape(id, id === 'text' ? { text: 'Aa' } : {});
  const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: def.color, roughness: 0.42, metalness: id === 'gear' || id === 'spring' ? 0.6 : 0 }));
  const url = renderObjects([mesh], size, id === 'text' ? new THREE.Vector3(0.4, 0.5, 1.4) : undefined);
  cache.set(key, url);
  return url;
}

export function docThumbnail(key: string, doc: DesignDoc, size = 220) {
  const k = `doc:${key}:${size}`;
  const hit = cache.get(k);
  if (hit) return hit;
  const result = evaluate(doc);
  const meshes = result.bodies.filter((b) => b.visible).map((b) => {
    const mp = materialById(b.appearance.material);
    const m = new THREE.Mesh(b.geometry, new THREE.MeshStandardMaterial({
      color: b.appearance.color, roughness: mp.roughness, metalness: mp.metalness,
      transparent: !!mp.transparent, opacity: mp.opacity ?? 1,
    }));
    m.matrixAutoUpdate = false;
    m.matrix.copy(b.matrix);
    return m;
  });
  const url = meshes.length ? renderObjects(meshes, size) : '';
  cache.set(k, url);
  return url;
}
