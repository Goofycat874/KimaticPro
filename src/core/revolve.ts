import * as THREE from 'three';
import type { Profile } from './sketch';
import type { Vec2 } from './types';

const area = (pts: Vec2[]) => {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[(i + 1) % pts.length];
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
};

/**
 * Revolve sketch profiles around the sketch's X or Y axis.
 * Built in a canonical frame (x = radius, y = axial) then mapped back to sketch
 * space so that the result is a closed, outward-facing solid — with caps when the
 * sweep is less than a full turn.
 */
export function revolveProfiles(profiles: Profile[], axis: 'x' | 'y', angleDeg: number): THREE.BufferGeometry {
  const sweep = (Math.max(1, Math.min(360, angleDeg)) * Math.PI) / 180;
  const full = angleDeg >= 359.999;
  const steps = Math.max(8, Math.round((64 * sweep) / (Math.PI * 2)));
  const positions: number[] = [];

  const toCanon = (p: Vec2): Vec2 => (axis === 'y' ? [Math.abs(p[0]), p[1]] : [Math.abs(p[1]), p[0]]);
  const orient = (pts: Vec2[], ccw: boolean) => ((area(pts) > 0) === ccw ? pts : [...pts].reverse());
  const at = ([r, a]: Vec2, t: number) => new THREE.Vector3(r * Math.cos(t), a, -r * Math.sin(t));
  const tri = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3) => positions.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);

  for (const prof of profiles) {
    const outer = orient(prof.outer.map(toCanon), true);
    const holes = prof.holes.map((h) => orient(h.map(toCanon), false));
    for (const loop of [outer, ...holes]) {
      for (let i = 0; i < loop.length; i++) {
        const p0 = loop[i], p1 = loop[(i + 1) % loop.length];
        for (let j = 0; j < steps; j++) {
          const t0 = (sweep * j) / steps, t1 = (sweep * (j + 1)) / steps;
          const A = at(p0, t0), B = at(p1, t0), C = at(p1, t1), D = at(p0, t1);
          tri(A, C, B);
          tri(A, D, C);
        }
      }
    }
    if (!full) {
      const contour = outer.map(([x, y]) => new THREE.Vector2(x, y));
      const holeVecs = holes.map((h) => h.map(([x, y]) => new THREE.Vector2(x, y)));
      const all = [...contour, ...holeVecs.flat()];
      const faces = THREE.ShapeUtils.triangulateShape(contour, holeVecs);
      const flat = all.map((v) => [v.x, v.y] as Vec2);
      for (const [a, b, c] of faces) {
        tri(at(flat[a], 0), at(flat[b], 0), at(flat[c], 0));
        tri(at(flat[a], sweep), at(flat[c], sweep), at(flat[b], sweep));
      }
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  if (axis === 'x') {
    // canonical (x=r, y=axial, z) -> sketch (u = axial, v = r, w = -z): a proper rotation
    geo.applyMatrix4(new THREE.Matrix4().set(0, 1, 0, 0, 1, 0, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1));
  } else {
    // canonical -> sketch (u = r cos, v = axial, w = z)
  }
  geo.computeVertexNormals();
  return geo;
}
