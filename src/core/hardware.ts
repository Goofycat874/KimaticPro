import * as THREE from 'three';
import { Brush, Evaluator, ADDITION, SUBTRACTION, INTERSECTION } from 'three-bvh-csg';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { normalizeGeometry } from './geometry';

// Printable hardware: threads, bolts, nuts, screw holes and containers.
// Everything is built Y-up, resting on y = 0 and centred on X/Z.

const csg = new Evaluator();
csg.attributes = ['position', 'normal'];
csg.useGroups = false;

function op(a: THREE.BufferGeometry, b: THREE.BufferGeometry, kind: 'add' | 'sub' | 'and') {
  const A = new Brush(normalizeGeometry(a));
  const B = new Brush(normalizeGeometry(b));
  A.updateMatrixWorld(); B.updateMatrixWorld();
  return csg.evaluate(A, B, kind === 'add' ? ADDITION : kind === 'sub' ? SUBTRACTION : INTERSECTION).geometry;
}

/**
 * ISO-style trapezoidal thread profile. `t` is the phase along one pitch (0..1),
 * returns 0 at the root and 1 at the crest.
 */
function threadProfile(t: number) {
  t = t - Math.floor(t);
  // crest 1/8, root 1/4, flanks 5/16 each
  if (t < 0.0625 || t >= 0.9375) return 1;
  if (t < 0.375) return 1 - (t - 0.0625) / 0.3125;
  if (t < 0.625) return 0;
  return (t - 0.625) / 0.3125;
}

/**
 * A watertight threaded rod built directly as a radius field r(θ, y).
 * Ends are chamfered down to the minor diameter so prints start cleanly.
 */
export function threadedRod(opts: {
  diameter: number; pitch: number; length: number; segments?: number; chamfer?: boolean; leftHand?: boolean;
  /** Internal-thread cutters: flare both ends into 45° countersinks `flare` mm wide, `inset` mm from the ends. */
  flare?: number; inset?: number; rows?: number;
}) {
  const { diameter, pitch, length } = opts;
  const S = opts.segments ?? 48;
  const rMaj = diameter / 2;
  const depth = Math.min(0.6134 * pitch, rMaj * 0.4); // ISO external thread depth
  const rMin = rMaj - depth;
  const rows = opts.rows ?? Math.max(2, Math.ceil(length / (pitch / 12)));
  const dir = opts.leftHand ? -1 : 1;
  const chamfer = opts.chamfer !== false ? depth * 1.2 : 0;

  const pos: number[] = [];
  const radius = (theta: number, y: number) => {
    let r = rMin + depth * threadProfile(y / pitch - (dir * theta) / (Math.PI * 2));
    if (chamfer > 0) {
      const edge = Math.min(y, length - y);
      r = Math.min(r, rMin + Math.max(0, edge) * (depth / chamfer));
    }
    if (opts.flare) {
      const inset = opts.inset ?? 0;
      const edge = Math.min(y - inset, length - inset - y);
      r = Math.max(r, rMaj + opts.flare - edge);
    }
    return r;
  };
  for (let j = 0; j <= rows; j++) {
    const y = (length * j) / rows;
    for (let i = 0; i < S; i++) {
      const th = (i / S) * Math.PI * 2;
      const r = radius(th, y);
      pos.push(Math.cos(th) * r, y, -Math.sin(th) * r);
    }
  }
  const bottom = pos.length / 3;
  pos.push(0, 0, 0);
  const top = bottom + 1;
  pos.push(0, length, 0);

  const idx: number[] = [];
  const v = (i: number, j: number) => j * S + (i % S);
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < S; i++) {
      const a = v(i, j), b = v(i + 1, j), c = v(i + 1, j + 1), d = v(i, j + 1);
      idx.push(a, b, c, a, c, d);
    }
  }
  for (let i = 0; i < S; i++) {
    idx.push(bottom, v(i + 1, 0), v(i, 0));
    idx.push(top, v(i, rows), v(i + 1, rows));
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  // split normals at the caps for crisp shading
  const flat = g.toNonIndexed();
  flat.computeVertexNormals();
  return flat;
}

/** Lathe a (radius, height) profile around Y. */
function lathe(points: [number, number][], segments = 64) {
  return new THREE.LatheGeometry(points.map(([x, y]) => new THREE.Vector2(Math.max(0, x), y)), segments);
}

/** Hexagon prism with 30° chamfered corners, like a real nut or bolt head. */
function hexChamfered(acrossFlats: number, height: number, chamferTop = true, chamferBottom = true) {
  const R = acrossFlats / Math.sqrt(3); // circumradius
  const hex = new THREE.CylinderGeometry(R, R, height, 6);
  hex.rotateY(Math.PI / 6);
  hex.translate(0, height / 2, 0);
  // a double frustum whose 30° cone just touches the flats trims only the corners
  const inner = acrossFlats / 2 * 0.97;
  const big = R * 1.25;
  const rise = Math.min(height / 2 - 0.01, (big - inner) * Math.tan(Math.PI / 6));
  // the cutter overshoots both caps (extending the cone lines) so no faces are coplanar
  const e = 0.5;
  const slope = (big - inner) / rise;
  const ext = Math.max(0, inner - e * slope);
  const pts: [number, number][] = [[0, -e]];
  if (chamferBottom) pts.push([ext, -e], [big, rise]); else pts.push([big, -e]);
  if (chamferTop) pts.push([big, height - rise], [ext, height + e]); else pts.push([big, height + e]);
  pts.push([0, height + e]);
  return op(hex, lathe(pts, 48), 'and');
}

export function bolt(p: { diameter: number; pitch: number; length: number; headHeight: number; headWidth: number; head: string }) {
  // printed head-down: flat head on the bed, thread pointing up
  const shank = threadedRod({ diameter: p.diameter, pitch: p.pitch, length: p.length + 0.4 });
  shank.translate(0, p.headHeight - 0.4, 0);
  let head: THREE.BufferGeometry;
  if (p.head === 'socket') {
    const cyl = new THREE.CylinderGeometry(p.headWidth / 2, p.headWidth / 2, p.headHeight, 48);
    cyl.translate(0, p.headHeight / 2, 0);
    // hex key socket opens on the bottom face (the visible end once screwed in)
    const key = p.headWidth * 0.45;
    const socket = new THREE.CylinderGeometry(key / Math.sqrt(3), key / Math.sqrt(3), p.headHeight * 0.6 + 0.01, 6);
    socket.translate(0, p.headHeight * 0.3 - 0.005, 0);
    head = op(cyl, socket, 'sub');
  } else {
    head = hexChamfered(p.headWidth, p.headHeight, false, true);
  }
  return op(head, shank, 'add');
}

export function nut(p: { diameter: number; pitch: number; height: number; width: number; tolerance: number }) {
  const body = hexChamfered(p.width, p.height);
  // one watertight cutter: the internal thread plus countersinks at both faces
  // place the cutter's vertex rings exactly halfway between rows at both nut faces,
  // so no ring is (nearly) coplanar with a face — that's what makes booleans crack
  const n = Math.max(2, Math.ceil(p.height / (p.pitch / 12)));
  const step = p.height / n;
  const k = Math.ceil(1 / step);
  const over = (k + 0.5) * step;
  const tap = threadedRod({
    diameter: p.diameter + p.tolerance, pitch: p.pitch, length: p.height + over * 2, rows: n + 2 * k + 1,
    chamfer: false, flare: Math.min(0.5, p.pitch * 0.5), inset: over,
  });
  tap.translate(0, -over, 0);
  return op(body, tap, 'sub');
}

/** A clearance hole with optional counterbore or countersink, meant to be used as a Hole. */
export function screwHole(p: { diameter: number; depth: number; head: string; headDiameter: number; headDepth: number }) {
  const r = p.diameter / 2, R = Math.max(p.headDiameter / 2, r + 0.1);
  const extra = 1; // pokes out of the top so the cut is clean
  const top = p.depth + extra;
  let pts: [number, number][];
  if (p.head === 'counterbore') {
    pts = [[0, 0], [r, 0], [r, p.depth - p.headDepth], [R, p.depth - p.headDepth], [R, top], [0, top]];
  } else if (p.head === 'countersink') {
    const h = R - r; // 90° countersink
    pts = [[0, 0], [r, 0], [r, p.depth - h], [R, p.depth], [R, top], [0, top]];
  } else {
    pts = [[0, 0], [r, 0], [r, top], [0, top]];
  }
  return lathe(pts, 48);
}

/** An open-top box (or tray) with a floor and walls — perfect for organisers. */
export function container(p: { width: number; height: number; depth: number; wall: number; floor: number; round: number }) {
  const w = Math.max(p.wall * 2 + 0.5, p.width), d = Math.max(p.wall * 2 + 0.5, p.depth);
  const r = Math.min(p.round, Math.min(w, d) / 2 - 0.01, p.height / 2 - 0.01);
  const outer = r > 0.05 ? new RoundedBoxGeometry(w, p.height, d, 4, r) : new THREE.BoxGeometry(w, p.height, d);
  outer.translate(0, p.height / 2, 0);
  const ir = Math.max(0, r - p.wall);
  const iw = w - p.wall * 2, id = d - p.wall * 2, ih = p.height * 2;
  const inner = ir > 0.05 ? new RoundedBoxGeometry(iw, ih, id, 4, Math.min(ir, iw / 2 - 0.01, id / 2 - 0.01)) : new THREE.BoxGeometry(iw, ih, id);
  inner.translate(0, p.floor + ih / 2, 0);
  return op(outer, inner, 'sub');
}

export { metricPitch } from './expr';
