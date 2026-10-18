import * as THREE from 'three';

export interface MeshReport {
  triangles: number;
  /** Total length (mm) of edges with nothing on the other side — real holes in the surface. */
  openLength: number;
  /** Edges shared by more than two triangles. */
  nonManifold: number;
}

/**
 * Welds points that are within `tol` of each other (neighbour-cell aware, so points
 * straddling a grid boundary still merge). Returns an id per input point.
 */
export function weld(points: THREE.Vector3[], tol = 1e-3) {
  const cells = new Map<string, number[]>();
  const reps: THREE.Vector3[] = [];
  const ids = new Int32Array(points.length);
  const inv = 1 / tol;
  points.forEach((p, i) => {
    const cx = Math.floor(p.x * inv), cy = Math.floor(p.y * inv), cz = Math.floor(p.z * inv);
    let found = -1;
    for (let dx = -1; dx <= 1 && found < 0; dx++) for (let dy = -1; dy <= 1 && found < 0; dy++) for (let dz = -1; dz <= 1 && found < 0; dz++) {
      const list = cells.get(`${cx + dx},${cy + dy},${cz + dz}`);
      if (list) for (const r of list) if (reps[r].distanceToSquared(p) <= tol * tol) { found = r; break; }
    }
    if (found < 0) {
      found = reps.length;
      reps.push(p);
      const k = `${cx},${cy},${cz}`;
      const list = cells.get(k);
      if (list) list.push(found); else cells.set(k, [found]);
    }
    ids[i] = found;
  });
  return { ids, reps };
}

/** Spatial index of line segments for "is anything else lying here?" queries. */
export class SegmentGrid {
  private cells = new Map<string, number[]>();
  segs: { a: THREE.Vector3; b: THREE.Vector3; d: THREE.Vector3; len: number }[] = [];
  constructor(private h = 1) {}
  private key(p: THREE.Vector3) { return `${Math.floor(p.x / this.h)},${Math.floor(p.y / this.h)},${Math.floor(p.z / this.h)}`; }
  add(a: THREE.Vector3, b: THREE.Vector3) {
    const d = new THREE.Vector3().subVectors(b, a);
    const len = d.length();
    if (len < 1e-9) return -1;
    d.divideScalar(len);
    const id = this.segs.length;
    this.segs.push({ a, b, d, len });
    const steps = Math.ceil(len / (this.h * 0.5)) + 1;
    const seen = new Set<string>();
    const p = new THREE.Vector3();
    for (let i = 0; i <= steps; i++) {
      p.copy(a).addScaledVector(d, (len * i) / steps);
      const k = this.key(p);
      if (seen.has(k)) continue;
      seen.add(k);
      const list = this.cells.get(k);
      if (list) list.push(id); else this.cells.set(k, [id]);
    }
    return id;
  }
  /** Segments (other than `skip`) parallel to `dir` passing within `tol` of `p`. */
  near(p: THREE.Vector3, dir: THREE.Vector3, tol: number, skip: number) {
    const out: number[] = [];
    const c = this.key(p).split(',').map(Number);
    const seen = new Set<number>();
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      const list = this.cells.get(`${c[0] + dx},${c[1] + dy},${c[2] + dz}`);
      if (!list) continue;
      for (const id of list) {
        if (id === skip || seen.has(id)) continue;
        seen.add(id);
        const s = this.segs[id];
        if (Math.abs(s.d.dot(dir)) < 0.999) continue;
        const t = Math.max(0, Math.min(s.len, p.clone().sub(s.a).dot(s.d)));
        if (s.a.clone().addScaledVector(s.d, t).distanceToSquared(p) <= tol * tol) out.push(id);
      }
    }
    return out;
  }
}

/**
 * Checks whether a mesh is closed ("watertight"), which slicers need.
 * Boolean results contain T-junctions (one long edge meeting several short ones) and
 * vertices that differ by float noise; neither is a hole, so unmatched edges are
 * sampled along their length and only stretches with nothing alongside count as open.
 */
export function checkMesh(geo: THREE.BufferGeometry, matrix?: THREE.Matrix4, tol = 2e-3): MeshReport {
  const pos = geo.getAttribute('position');
  const index = geo.index;
  const triCount = (index ? index.count : pos.count) / 3;
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i < pos.count; i++) {
    const v = new THREE.Vector3().fromBufferAttribute(pos, i);
    if (matrix) v.applyMatrix4(matrix);
    pts.push(v);
  }
  const { ids, reps } = weld(pts, tol);
  const edges = new Map<string, number>();
  for (let t = 0; t < triCount; t++) {
    const v = [0, 1, 2].map((k) => ids[index ? index.getX(t * 3 + k) : t * 3 + k]);
    if (v[0] === v[1] || v[1] === v[2] || v[0] === v[2]) continue;
    for (let k = 0; k < 3; k++) {
      const a = v[k], b = v[(k + 1) % 3];
      const key = a < b ? `${a}_${b}` : `${b}_${a}`;
      edges.set(key, (edges.get(key) ?? 0) + 1);
    }
  }
  let nonManifold = 0;
  const grid = new SegmentGrid(1);
  const single: number[] = [];
  for (const [key, n] of edges) {
    if (n > 2) nonManifold++;
    if (n !== 1) continue;
    const [a, b] = key.split('_').map(Number);
    const id = grid.add(reps[a], reps[b]);
    if (id >= 0) single.push(id);
  }
  let open = 0;
  const p = new THREE.Vector3();
  for (const id of single) {
    const s = grid.segs[id];
    const n = Math.max(2, Math.ceil(s.len / 0.25));
    for (let i = 0; i < n; i++) {
      p.copy(s.a).addScaledVector(s.d, ((i + 0.5) / n) * s.len);
      if (!grid.near(p, s.d, tol * 2, id).length) open += s.len / n;
    }
  }
  // each open stretch is counted from one side only
  return { triangles: triCount, openLength: open, nonManifold };
}
