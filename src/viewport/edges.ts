import * as THREE from 'three';

/**
 * CAD-style feature edges.
 *
 * THREE.EdgesGeometry draws every edge used by only one triangle, which after a
 * boolean operation includes all the T-junction seams across flat faces. Here,
 * unmatched edges are grouped by the infinite line they lie on; overlapping
 * collinear pieces from coplanar triangles are treated as interior seams and skipped.
 */
export function featureEdges(geo: THREE.BufferGeometry, thresholdDeg = 28): THREE.BufferGeometry {
  const pos = geo.getAttribute('position');
  const index = geo.index;
  const triCount = (index ? index.count : pos.count) / 3;
  const cosT = Math.cos((thresholdDeg * Math.PI) / 180);
  const Q = 1e4;

  const vid = new Map<string, number>();
  const verts: THREE.Vector3[] = [];
  const idOf = (i: number) => {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const k = `${Math.round(x * Q)},${Math.round(y * Q)},${Math.round(z * Q)}`;
    let id = vid.get(k);
    if (id === undefined) { id = verts.length; vid.set(k, id); verts.push(new THREE.Vector3(x, y, z)); }
    return id;
  };

  const normals: THREE.Vector3[] = [];
  const edges = new Map<string, { a: number; b: number; faces: number[] }>();
  const ab = new THREE.Vector3(), ac = new THREE.Vector3();
  for (let t = 0; t < triCount; t++) {
    const ids = [0, 1, 2].map((k) => idOf(index ? index.getX(t * 3 + k) : t * 3 + k));
    if (ids[0] === ids[1] || ids[1] === ids[2] || ids[0] === ids[2]) { normals.push(new THREE.Vector3()); continue; }
    ab.subVectors(verts[ids[1]], verts[ids[0]]);
    ac.subVectors(verts[ids[2]], verts[ids[0]]);
    const n = new THREE.Vector3().crossVectors(ab, ac);
    // slivers (common in boolean output) have unreliable orientation: leave them out
    const longest = Math.max(ab.lengthSq(), ac.lengthSq(), verts[ids[2]].distanceToSquared(verts[ids[1]]));
    if (n.length() < 1e-4 * longest) { normals.push(new THREE.Vector3()); continue; }
    normals.push(n.normalize());
    for (let k = 0; k < 3; k++) {
      const a = ids[k], b = ids[(k + 1) % 3];
      const key = a < b ? `${a}_${b}` : `${b}_${a}`;
      let e = edges.get(key);
      if (!e) { e = { a: Math.min(a, b), b: Math.max(a, b), faces: [] }; edges.set(key, e); }
      e.faces.push(t);
    }
  }

  const out: number[] = [];
  const push = (a: THREE.Vector3, b: THREE.Vector3) => { if (a.distanceToSquared(b) > 1e-6) out.push(a.x, a.y, a.z, b.x, b.y, b.z); };
  const unmatched: { a: THREE.Vector3; b: THREE.Vector3; n: THREE.Vector3 }[] = [];

  for (const e of edges.values()) {
    if (e.faces.length === 2) {
      if (normals[e.faces[0]].dot(normals[e.faces[1]]) < cosT) push(verts[e.a], verts[e.b]);
    } else if (e.faces.length === 1) {
      unmatched.push({ a: verts[e.a], b: verts[e.b], n: normals[e.faces[0]] });
    } else {
      // non-manifold fan: keep it if the faces disagree
      const n0 = normals[e.faces[0]];
      if (e.faces.some((f) => n0.dot(normals[f]) < cosT)) push(verts[e.a], verts[e.b]);
    }
  }

  // bucket single edges by their supporting line
  type Item = { t0: number; t1: number; n: THREE.Vector3; a: THREE.Vector3; ta: number; d: THREE.Vector3 };
  const buckets = new Map<string, Item[]>();
  const LQ = 200;
  for (const u of unmatched) {
    const d = new THREE.Vector3().subVectors(u.b, u.a);
    const len = d.length();
    if (len < 1e-9) continue;
    d.divideScalar(len);
    // canonical direction sign
    if (d.x < -1e-9 || (Math.abs(d.x) < 1e-9 && (d.y < -1e-9 || (Math.abs(d.y) < 1e-9 && d.z < 0)))) d.negate();
    const p0 = u.a.clone().addScaledVector(d, -u.a.dot(d));
    const key = `${Math.round(d.x * 1000)},${Math.round(d.y * 1000)},${Math.round(d.z * 1000)}|${Math.round(p0.x * LQ)},${Math.round(p0.y * LQ)},${Math.round(p0.z * LQ)}`;
    const ta = u.a.dot(d), tb = u.b.dot(d);
    const item = { t0: Math.min(ta, tb), t1: Math.max(ta, tb), n: u.n, a: u.a, ta, d };
    const list = buckets.get(key);
    if (list) list.push(item); else buckets.set(key, [item]);
  }
  const at = (e: Item, t: number) => e.a.clone().addScaledVector(e.d, t - e.ta);
  for (const list of buckets.values()) {
    for (const e of list) {
      // split the edge where overlapping partners start/stop, then classify each piece:
      // touching a differently-facing partner = crease (draw), only coplanar partners = seam (skip),
      // no partner at all = open boundary (draw)
      const parts = list.filter((o) => o !== e && Math.min(e.t1, o.t1) - Math.max(e.t0, o.t0) > 1e-6);
      if (!parts.length) { push(at(e, e.t0), at(e, e.t1)); continue; }
      const cuts = [e.t0, e.t1];
      for (const o of parts) { if (o.t0 > e.t0 && o.t0 < e.t1) cuts.push(o.t0); if (o.t1 > e.t0 && o.t1 < e.t1) cuts.push(o.t1); }
      cuts.sort((x, y) => x - y);
      let runStart: number | null = null;
      for (let i = 0; i < cuts.length - 1; i++) {
        const s0 = cuts[i], s1 = cuts[i + 1];
        if (s1 - s0 < 1e-7) continue;
        const m = (s0 + s1) / 2;
        const cover = parts.filter((o) => o.t0 <= m && o.t1 >= m);
        const draw = !cover.length || cover.some((o) => e.n.dot(o.n) < cosT);
        if (draw && runStart === null) runStart = s0;
        if (!draw && runStart !== null) { push(at(e, runStart), at(e, s0)); runStart = null; }
      }
      if (runStart !== null) push(at(e, runStart), at(e, e.t1));
    }
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(out, 3));
  return g;
}
