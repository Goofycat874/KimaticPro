import * as THREE from 'three';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/**
 * Bring any geometry into the canonical form used across the app:
 * non-indexed-agnostic, only `position` + `normal`, no groups.
 * Keeping every geometry identical in layout lets CSG combine anything with anything.
 */
export function normalizeGeometry(g: THREE.BufferGeometry): THREE.BufferGeometry {
  let geo = g;
  for (const key of Object.keys(geo.attributes)) {
    if (key !== 'position' && key !== 'normal') geo.deleteAttribute(key);
  }
  if (!geo.getAttribute('normal')) geo.computeVertexNormals();
  geo.clearGroups();
  if (geo.index === null) {
    // index so the CSG half-edge map can find shared edges
    geo = mergeVertices(geo, 1e-5);
  }
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  return geo;
}

/** Signed volume (mm³) of a closed triangle mesh in its own frame, after `matrix`. */
export function computeVolume(geo: THREE.BufferGeometry, matrix?: THREE.Matrix4): number {
  const pos = geo.getAttribute('position');
  const idx = geo.index;
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  let vol = 0;
  const count = idx ? idx.count : pos.count;
  for (let i = 0; i < count; i += 3) {
    const i0 = idx ? idx.getX(i) : i;
    const i1 = idx ? idx.getX(i + 1) : i + 1;
    const i2 = idx ? idx.getX(i + 2) : i + 2;
    a.fromBufferAttribute(pos, i0);
    b.fromBufferAttribute(pos, i1);
    c.fromBufferAttribute(pos, i2);
    if (matrix) { a.applyMatrix4(matrix); b.applyMatrix4(matrix); c.applyMatrix4(matrix); }
    vol += a.dot(b.clone().cross(c)) / 6;
  }
  return Math.abs(vol);
}

export function computeArea(geo: THREE.BufferGeometry, matrix?: THREE.Matrix4): number {
  const pos = geo.getAttribute('position');
  const idx = geo.index;
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const tri = new THREE.Triangle();
  let area = 0;
  const count = idx ? idx.count : pos.count;
  for (let i = 0; i < count; i += 3) {
    const i0 = idx ? idx.getX(i) : i;
    const i1 = idx ? idx.getX(i + 1) : i + 1;
    const i2 = idx ? idx.getX(i + 2) : i + 2;
    a.fromBufferAttribute(pos, i0);
    b.fromBufferAttribute(pos, i1);
    c.fromBufferAttribute(pos, i2);
    if (matrix) { a.applyMatrix4(matrix); b.applyMatrix4(matrix); c.applyMatrix4(matrix); }
    tri.set(a, b, c);
    area += tri.getArea();
  }
  return area;
}

export function triangleCount(geo: THREE.BufferGeometry) {
  return (geo.index ? geo.index.count : geo.getAttribute('position').count) / 3;
}

/** Encode raw triangle positions so imported meshes can live inside the project file. */
export function encodePositions(arr: Float32Array): string {
  const bytes = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

export function decodePositions(data: string): Float32Array {
  const bin = atob(data);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Float32Array(bytes.buffer);
}
