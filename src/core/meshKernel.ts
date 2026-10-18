import * as THREE from 'three';
import { Brush, Evaluator, ADDITION, SUBTRACTION, INTERSECTION } from 'three-bvh-csg';
import type { Kernel, Placed } from './kernel';
import { buildShape } from './primitives';
import { profileToShape, sketchProfiles } from './sketch';
import { revolveProfiles } from './revolve';
import { decodePositions, normalizeGeometry } from './geometry';
import { loftGeometry, mainLoop, sweepGeometry, sweepPath } from './loft';
import { hash, matKey } from './evalCore';

// The fast triangle-mesh kernel: instant previews while dragging, and the
// fallback when the precise kernel isn't available.

type Geo = THREE.BufferGeometry;

interface CacheEntry { geo: Geo; gen: number }
const cache = new Map<string, CacheEntry>();
let generation = 0;

export function cachedGeometry(key: string, make: () => Geo) {
  const hit = cache.get(key);
  if (hit) { hit.gen = generation; return hit.geo; }
  const geo = make();
  cache.set(key, { geo, gen: generation });
  return geo;
}

const csg = new Evaluator();
csg.attributes = ['position', 'normal'];
csg.useGroups = false;

function brushOf(b: { solid: Geo; matrix: THREE.Matrix4 }) {
  const br = new Brush(b.solid);
  br.matrixAutoUpdate = false;
  br.matrix.copy(b.matrix);
  br.updateMatrixWorld(true);
  return br;
}

const OPS = { join: ADDITION, cut: SUBTRACTION, intersect: INTERSECTION } as const;

/** Boolean of two placed meshes; result is centred on its bounds with that offset as its frame. */
export function meshBoolean(a: Placed<Geo>, b: Placed<Geo>, op: 'join' | 'cut' | 'intersect'): Placed<Geo> {
  const key = hash(`${op}|${a.key}@${matKey(a.matrix)}|${b.key}@${matKey(b.matrix)}`);
  const geo = cachedGeometry(key, () => {
    const g = csg.evaluate(brushOf(a), brushOf(b), OPS[op]).geometry;
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
  return { solid: geo, key, matrix: new THREE.Matrix4().makeTranslation(c.x, c.y, c.z) };
}

export const meshBounds = (b: { solid: Geo; matrix: THREE.Matrix4 }) => {
  if (!b.solid.boundingBox) b.solid.computeBoundingBox();
  return b.solid.boundingBox!.clone().applyMatrix4(b.matrix);
};

export const meshKernel: Kernel<Geo> = {
  precise: false,

  begin() { generation++; },

  end(live) {
    const keep = new Set(live);
    for (const [k, v] of cache) {
      if (v.gen < generation - 4 && !keep.has(v.geo)) {
        v.geo.dispose();
        cache.delete(k);
      }
    }
  },

  primitive(shape, params, key) {
    return cachedGeometry(key, () => buildShape(shape, params));
  },

  importMesh(data, _step, key) {
    return cachedGeometry(key, () => {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(decodePositions(data), 3));
      return normalizeGeometry(g);
    });
  },

  extrude(f, entities, key) {
    return cachedGeometry(key, () => {
      const shapes = sketchProfiles(entities).map(profileToShape);
      if (!shapes.length) throw new Error('This sketch has no closed shapes to extrude. Close a loop first.');
      const dist = Math.abs(f.distance) || 0.01;
      const r = Math.max(0, Math.min(f.roundEdges, dist / 2 - 0.01));
      const geo = new THREE.ExtrudeGeometry(shapes, {
        depth: Math.max(0.01, dist - 2 * r), bevelEnabled: r > 0, bevelThickness: r, bevelSize: r, bevelOffset: -r,
        bevelSegments: 4, curveSegments: 48,
      });
      if (r > 0) geo.translate(0, 0, r);
      if (f.symmetric) geo.translate(0, 0, -dist / 2);
      else if (f.distance < 0) geo.translate(0, 0, -dist);
      return normalizeGeometry(geo);
    });
  },

  revolve(f, entities, key) {
    return cachedGeometry(key, () => {
      const profiles = sketchProfiles(entities);
      if (!profiles.length) throw new Error('This sketch has no closed shapes to revolve.');
      return normalizeGeometry(revolveProfiles(profiles, f.axis, f.angle));
    });
  },

  loft(sections, smooth, key) {
    return cachedGeometry(key, () => {
      const loops = sections.map((s) => ({ loop: mainLoop(s.entities), matrix: s.matrix }));
      if (loops.some((l) => !l.loop)) throw new Error('Every loft sketch needs a closed shape.');
      const g = normalizeGeometry(loftGeometry(loops as any, smooth));
      // lofts are smooth surfaces: only draw edges at real creases
      g.userData.edgeAngle = 60;
      return g;
    });
  },

  sweep(profile, path, twist, key) {
    return cachedGeometry(key, () => {
      const profiles = sketchProfiles(profile);
      if (!profiles.length) throw new Error('The profile sketch needs a closed shape.');
      const g = normalizeGeometry(sweepGeometry(profiles[0], sweepPath(path.entities, path.matrix), twist));
      g.userData.edgeAngle = 50;
      return g;
    });
  },

  boolean: meshBoolean,

  mirror(b, refl, key) {
    const geo = cachedGeometry(key, () => {
      const g = b.solid.clone();
      g.applyMatrix4(new THREE.Matrix4().multiplyMatrices(refl, b.matrix));
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
    return { solid: geo, key, matrix: new THREE.Matrix4() };
  },

  split(b, axis, offset) {
    const bb = meshBounds(b);
    const size = bb.getSize(new THREE.Vector3()).length() * 2 + 10;
    const centre = bb.getCenter(new THREE.Vector3());
    centre[axis] = offset + size / 2;
    // a huge box covering everything on the "high" side of the plane
    const tool: Placed<Geo> = {
      key: `half|${axis}|${offset}|${size.toFixed(3)}`,
      solid: cachedGeometry(hash(`halfbox|${size.toFixed(3)}`), () => normalizeGeometry(new THREE.BoxGeometry(size, size, size))),
      matrix: new THREE.Matrix4().makeTranslation(centre.x, centre.y, centre.z),
    };
    return [meshBoolean(b, tool, 'cut'), meshBoolean(b, tool, 'intersect')];
  },

  // fillets, shells and drafts need exact geometry: the preview shows the body as-is
  modify(b) { return b; },

  bounds: meshBounds,
};
