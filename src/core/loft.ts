import * as THREE from 'three';
import { entityOutline, profileToShape, sketchProfiles, type Profile } from './sketch';
import type { SketchEntity, Vec2 } from './types';

const area = (pts: Vec2[]) => {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[(i + 1) % pts.length];
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
};

/** Evenly resample a closed loop to `n` points by arc length. */
export function resampleLoop(pts: Vec2[], n: number): Vec2[] {
  const segs: number[] = [];
  let total = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
    segs.push(l);
    total += l;
  }
  const out: Vec2[] = [];
  let seg = 0, acc = 0;
  for (let k = 0; k < n; k++) {
    const target = (k / n) * total;
    while (seg < segs.length - 1 && acc + segs[seg] < target) { acc += segs[seg]; seg++; }
    const a = pts[seg], b = pts[(seg + 1) % pts.length];
    const t = segs[seg] ? (target - acc) / segs[seg] : 0;
    out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
  }
  return out;
}

/** The biggest closed loop in a sketch — the shape a loft section uses. */
export function mainLoop(entities: SketchEntity[]): Vec2[] | null {
  const profs = sketchProfiles(entities);
  if (!profs.length) return null;
  let best = profs[0];
  for (const p of profs) if (Math.abs(area(p.outer)) > Math.abs(area(best.outer))) best = p;
  return area(best.outer) < 0 ? [...best.outer].reverse() : best.outer;
}

function signedVolume(pos: number[]) {
  let v = 0;
  for (let i = 0; i < pos.length; i += 9) {
    const [ax, ay, az, bx, by, bz, cx, cy, cz] = pos.slice(i, i + 9);
    v += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
  }
  return v;
}

/**
 * Blend smoothly between closed sections on any planes. Sections are resampled to
 * the same point count, aligned to minimise twist, then joined with a ruled or
 * Catmull-Rom (smooth) skin and capped at both ends.
 */
export function loftGeometry(sections: { loop: Vec2[]; matrix: THREE.Matrix4 }[], smooth: boolean): THREE.BufferGeometry {
  if (sections.length < 2) throw new Error('Loft needs at least two sketches with closed shapes.');
  const N = 96;
  const rings: THREE.Vector3[][] = [];
  const flat: Vec2[][] = [];
  let axis = new THREE.Vector3();
  const centroids = sections.map((s) => {
    const c = s.loop.reduce((a, p) => [a[0] + p[0], a[1] + p[1]], [0, 0]).map((v) => v / s.loop.length);
    return new THREE.Vector3(c[0], c[1], 0).applyMatrix4(s.matrix);
  });
  axis.subVectors(centroids[centroids.length - 1], centroids[0]);
  if (axis.lengthSq() < 1e-9) axis = new THREE.Vector3(0, 0, 1).transformDirection(sections[0].matrix);
  axis.normalize();

  sections.forEach((s, si) => {
    let loop2 = resampleLoop(s.loop, N);
    // consistent winding around the loft axis
    const n = new THREE.Vector3(0, 0, 1).transformDirection(s.matrix);
    if (n.dot(axis) < 0) loop2 = [...loop2].reverse();
    let ring = loop2.map(([x, y]) => new THREE.Vector3(x, y, 0).applyMatrix4(s.matrix));
    if (si > 0) {
      // rotate the start point to line up with the previous ring (least twist)
      const prev = rings[si - 1];
      const prevC = centroids[si - 1], c = centroids[si];
      let best = 0, bestD = Infinity;
      for (let k = 0; k < N; k++) {
        let d = 0;
        for (let j = 0; j < N; j += 4) d += ring[(j + k) % N].clone().sub(c).distanceToSquared(prev[j].clone().sub(prevC));
        if (d < bestD) { bestD = d; best = k; }
      }
      ring = ring.map((_, j) => ring[(j + best) % N]);
      loop2 = loop2.map((_, j) => loop2[(j + best) % N]);
    }
    rings.push(ring);
    flat.push(loop2);
  });

  // optional smooth interpolation between sections
  let skin = rings;
  if (smooth && rings.length > 2) {
    const sub = 10;
    skin = [];
    for (let s = 0; s < rings.length - 1; s++) {
      for (let k = 0; k < sub; k++) {
        const t = k / sub;
        skin.push(rings[0].map((_, j) => {
          const p0 = rings[Math.max(0, s - 1)][j], p1 = rings[s][j], p2 = rings[s + 1][j], p3 = rings[Math.min(rings.length - 1, s + 2)][j];
          const t2 = t * t, t3 = t2 * t;
          return new THREE.Vector3()
            .addScaledVector(p0, -0.5 * t3 + t2 - 0.5 * t)
            .addScaledVector(p1, 1.5 * t3 - 2.5 * t2 + 1)
            .addScaledVector(p2, -1.5 * t3 + 2 * t2 + 0.5 * t)
            .addScaledVector(p3, 0.5 * t3 - 0.5 * t2);
        }));
      }
    }
    skin.push(rings[rings.length - 1]);
  }

  const pos: number[] = [];
  const tri = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3) => pos.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
  for (let s = 0; s < skin.length - 1; s++) {
    for (let j = 0; j < N; j++) {
      const a = skin[s][j], b = skin[s][(j + 1) % N], c = skin[s + 1][(j + 1) % N], d = skin[s + 1][j];
      tri(a, b, c);
      tri(a, c, d);
    }
  }
  // caps, triangulated in each end's own sketch plane; first faces back along the loft, last faces forward
  const cap = (si: number, outward: THREE.Vector3) => {
    const ring = rings[si];
    const faces = THREE.ShapeUtils.triangulateShape(flat[si].map(([x, y]) => new THREE.Vector2(x, y)), []);
    const n = new THREE.Vector3();
    for (const [a, b, c] of faces) {
      n.subVectors(ring[b], ring[a]).cross(new THREE.Vector3().subVectors(ring[c], ring[a]));
      if (n.dot(outward) >= 0) tri(ring[a], ring[b], ring[c]);
      else tri(ring[a], ring[c], ring[b]);
    }
  };
  cap(0, axis.clone().negate());
  cap(rings.length - 1, axis);
  if (signedVolume(pos) < 0) {
    for (let i = 0; i < pos.length; i += 9) for (let k = 0; k < 3; k++) { const t = pos[i + 3 + k]; pos[i + 3 + k] = pos[i + 6 + k]; pos[i + 6 + k] = t; }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}

/** The path curve of a sweep: the first open curve in the sketch, else its first loop. */
export function sweepPath(entities: SketchEntity[], matrix: THREE.Matrix4) {
  const open = entities.find((e) => (e.kind === 'polyline' || e.kind === 'spline') && !e.closed) ?? entities[0];
  if (!open) throw new Error('The path sketch is empty. Draw a line or spline for the path.');
  const o = entityOutline(open, 96);
  const pts = o.points.map(([x, y]) => new THREE.Vector3(x, y, 0).applyMatrix4(matrix));
  if (pts.length < 2) throw new Error('The path needs at least two points.');
  const normal = new THREE.Vector3();
  matrix.extractBasis(new THREE.Vector3(), new THREE.Vector3(), normal);
  return { points: pts, closed: o.closed, normal: normal.normalize() };
}

/**
 * Sweep a closed cross-section along a path. The section is centred on the path and
 * held perpendicular to it with rotation-minimising frames (no sudden flips).
 */
export function sweepGeometry(profile: Profile, path: { points: THREE.Vector3[]; closed: boolean; normal?: THREE.Vector3 }, twistDeg = 0): THREE.BufferGeometry {
  const shape = profileToShape(profile);
  // centre the section on its own bounding box so it rides on the path
  const box = new THREE.Box2();
  for (const p of shape.getPoints()) box.expandByPoint(p);
  const c = box.getCenter(new THREE.Vector2());
  const centred = profileToShape({
    outer: profile.outer.map(([x, y]) => [x - c.x, y - c.y] as Vec2),
    holes: profile.holes.map((h) => h.map(([x, y]) => [x - c.x, y - c.y] as Vec2)),
  });
  const curve = new THREE.CatmullRomCurve3(path.points, path.closed, 'centripetal', 0.5);
  if (path.normal) {
    // Lock the section to the path's sketch plane (the same convention as the precise kernel):
    // profile u runs along the plane normal, v along the in-plane normal.
    const np = path.normal.clone();
    curve.computeFrenetFrames = (segments: number, closed: boolean) => {
      const tangents: THREE.Vector3[] = [], normals: THREE.Vector3[] = [], binormals: THREE.Vector3[] = [];
      for (let i = 0; i <= segments; i++) {
        const t = curve.getTangentAt(closed ? (i % segments) / segments : i / segments).normalize();
        tangents.push(t);
        normals.push(np.clone());
        binormals.push(new THREE.Vector3().crossVectors(t, np).normalize());
      }
      return { tangents, normals, binormals };
    };
  }
  // gently round sharp polyline corners while keeping straight runs straight
  const length = curve.getLength();
  const steps = Math.min(600, Math.max(16, Math.round(length / 1.5)));
  const geo = new THREE.ExtrudeGeometry(centred, { steps, extrudePath: curve, bevelEnabled: false, curveSegments: 24 });
  if (twistDeg) {
    // twist each ring around the path tangent
    const pos = geo.getAttribute('position');
    const frames = curve.computeFrenetFrames(steps, path.closed);
    const v = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i);
      // nearest step by projecting onto the curve parameter
      let best = 0, bestD = Infinity;
      for (let s = 0; s <= steps; s += Math.max(1, Math.floor(steps / 200))) {
        const d = curve.getPointAt(s / steps).distanceToSquared(v);
        if (d < bestD) { bestD = d; best = s; }
      }
      const center = curve.getPointAt(best / steps);
      const ang = (twistDeg * Math.PI / 180) * (best / steps);
      v.sub(center).applyAxisAngle(frames.tangents[Math.min(best, frames.tangents.length - 1)], ang).add(center);
      pos.setXYZ(i, v.x, v.y, v.z);
    }
    geo.computeVertexNormals();
  }
  return geo;
}
