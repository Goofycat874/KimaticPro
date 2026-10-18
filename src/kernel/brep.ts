import * as THREE from 'three';
import * as R from 'replicad';
import type { Kernel, Placed } from '../core/kernel';
import type { SketchEntity, Vec2, Vec3 } from '../core/types';
import { buildShape, defaultParams, shapeById, textShapes } from '../core/primitives';
import { entityOutline, sketchProfileEntities, type EntityProfile } from '../core/sketch';
import { meshBoolean, meshKernel } from '../core/meshKernel';
import { hash, matKey } from '../core/evalCore';

// The precise kernel: real B-rep solids from OpenCascade. Bodies that can only
// exist as meshes (threads, imported STL) ride along as mesh solids and fall back
// to mesh booleans when combined.

export type BSolid =
  | { kind: 'brep'; shape: R.Shape3D }
  | { kind: 'mesh'; geo: THREE.BufferGeometry };

type P = Placed<BSolid>;

const brep = (shape: R.Shape3D): BSolid => ({ kind: 'brep', shape });

// ---------------------------------------------------------------------------
// cache (shapes live in WASM memory, so evicted ones are freed explicitly)

interface Entry { solid: BSolid; gen: number }
const cache = new Map<string, Entry>();
let gen = 0;

function cached(key: string, make: () => BSolid): BSolid {
  const hit = cache.get(key);
  if (hit) { hit.gen = gen; return hit.solid; }
  const solid = make();
  cache.set(key, { solid, gen });
  return solid;
}

function free(s: BSolid) {
  try { if (s.kind === 'brep') s.shape.delete(); else s.geo.dispose(); } catch { /* already freed */ }
}

// ---------------------------------------------------------------------------
// placement

const uniformScale = (m: THREE.Matrix4) => {
  const s = new THREE.Vector3();
  m.decompose(new THREE.Vector3(), new THREE.Quaternion(), s);
  const a = Math.abs(s.x), b = Math.abs(s.y), c = Math.abs(s.z);
  return Math.abs(a - b) < 1e-6 && Math.abs(b - c) < 1e-6;
};

const isIdentity = (m: THREE.Matrix4) => m.elements.every((v, i) => Math.abs(v - (i % 5 === 0 ? 1 : 0)) < 1e-12);

/** A new shape with `m` applied (the input is left untouched). */
function transformed(shape: R.Shape3D, m: THREE.Matrix4): R.Shape3D {
  if (isIdentity(m)) return shape.clone();
  const oc = R.getOC();
  const e = m.elements; // column-major
  const t = new oc.gp_Trsf();
  t.SetValues(e[0], e[4], e[8], e[12], e[1], e[5], e[9], e[13], e[2], e[6], e[10], e[14]);
  const api = new oc.BRepBuilderAPI_Transform(shape.wrapped, t, true, false);
  const out = R.cast(api.Shape()) as R.Shape3D;
  api.delete();
  t.delete();
  return out;
}

/** World-space shape of a placed brep body (caller frees it). */
function world(p: P): R.Shape3D {
  if (p.solid.kind !== 'brep') throw new Error('mesh');
  return transformed(p.solid.shape, p.matrix);
}

const meshCache = new Map<string, THREE.BufferGeometry>();

/** Triangulate a brep solid (local frame) for display or mesh booleans. */
export function solidGeometry(solid: BSolid, key: string): THREE.BufferGeometry {
  if (solid.kind === 'mesh') return solid.geo;
  let g = meshCache.get(key);
  if (g) return g;
  const bb = solid.shape.boundingBox;
  const diag = Math.hypot(bb.width, bb.height, bb.depth) || 1;
  const m = solid.shape.mesh({ tolerance: Math.min(0.05, Math.max(0.005, diag * 0.0005)), angularTolerance: 12 });
  g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(m.vertices, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(m.normals, 3));
  g.setIndex(m.triangles);
  g.computeBoundingBox();
  g.computeBoundingSphere();
  meshCache.set(key, g);
  if (meshCache.size > 400) meshCache.delete(meshCache.keys().next().value!);
  return g;
}

const asMesh = (p: P): Placed<THREE.BufferGeometry> => ({ solid: solidGeometry(p.solid, p.key), key: p.key, matrix: p.matrix });
const fromMesh = (p: Placed<THREE.BufferGeometry>): P => ({ solid: { kind: 'mesh', geo: p.solid }, key: p.key, matrix: p.matrix });

// ---------------------------------------------------------------------------
// 2D: sketch entities → exact drawings

function polyDrawing(pts: Vec2[]): R.Drawing {
  let pen = R.draw(pts[0]);
  for (let i = 1; i < pts.length; i++) {
    const [x, y] = pts[i];
    const [px, py] = pts[i - 1];
    if (Math.hypot(x - px, y - py) > 1e-7) pen = pen.lineTo([x, y]);
  }
  return pen.close();
}

/** An exact drawing for one closed sketch entity: real circles and arcs, not polygons. */
function entityDrawing(e: SketchEntity): R.Drawing {
  switch (e.kind) {
    case 'circle':
      return R.drawCircle(e.r).translate(e.cx, e.cy);
    case 'rect': {
      const r = Math.max(0, Math.min(e.radius ?? 0, e.w / 2 - 1e-4, e.h / 2 - 1e-4));
      return (r > 1e-4 ? R.drawRoundedRectangle(e.w, e.h, r) : R.drawRectangle(e.w, e.h)).translate(e.x + e.w / 2, e.y + e.h / 2);
    }
    case 'slot': {
      const dx = e.x2 - e.x1, dy = e.y2 - e.y1;
      const len = Math.hypot(dx, dy) || 1;
      const ux = dx / len, uy = dy / len, nx = -uy * e.r, ny = ux * e.r;
      return R.draw([e.x1 + nx, e.y1 + ny])
        .lineTo([e.x2 + nx, e.y2 + ny])
        .threePointsArcTo([e.x2 - nx, e.y2 - ny], [e.x2 + ux * e.r, e.y2 + uy * e.r])
        .lineTo([e.x1 - nx, e.y1 - ny])
        .threePointsArcTo([e.x1 + nx, e.y1 + ny], [e.x1 - ux * e.r, e.y1 - uy * e.r])
        .close();
    }
    default:
      return polyDrawing(entityOutline(e, 96).points);
  }
}

function profileDrawing(p: EntityProfile): R.Drawing {
  let d = entityDrawing(p.outerEntity);
  for (const h of p.holeEntities) d = d.cut(entityDrawing(h));
  return d;
}

function profilesOf(entities: SketchEntity[], what: string) {
  const ps = sketchProfileEntities(entities);
  if (!ps.length) throw new Error(`This sketch has no closed shapes to ${what}. Close a loop first.`);
  return ps;
}

function fuseAll(shapes: R.Shape3D[]): R.Shape3D {
  let out = shapes[0];
  for (let i = 1; i < shapes.length; i++) {
    const next = out.fuse(shapes[i]);
    out.delete(); shapes[i].delete();
    out = next;
  }
  return out;
}

/** Sketch plane for a world matrix (origin, x direction, normal). */
function planeOf(m: THREE.Matrix4, origin?: THREE.Vector3) {
  const x = new THREE.Vector3(), y = new THREE.Vector3(), z = new THREE.Vector3();
  m.extractBasis(x, y, z);
  const o = origin ?? new THREE.Vector3().setFromMatrixPosition(m);
  return new R.Plane(o.toArray() as Vec3, x.normalize().toArray() as Vec3, z.normalize().toArray() as Vec3);
}

// ---------------------------------------------------------------------------
// shapes

const GROUND = () => new R.Plane([0, 0, 0], [1, 0, 0], [0, 1, 0]); // u = +x, v = -z, extrude up +y
const FRONT = () => new R.Plane([0, 0, 0], [1, 0, 0], [0, 0, 1]); // u = +x, v = +y, extrude towards +z

/** Revolve a (radius, height) outline around the Y axis. */
function lathe(pts: Vec2[], angle = 360): R.Shape3D {
  const sk = polyDrawing(pts).sketchOnPlane(FRONT()) as R.Sketch;
  return sk.revolve([0, 1, 0], { origin: [0, 0, 0], angle }) as R.Shape3D;
}

function groundCentre(s: R.Shape3D): R.Shape3D {
  const [[x0, y0, z0], [x1, , z1]] = s.boundingBox.bounds;
  return s.translate(-(x0 + x1) / 2, -y0, -(z0 + z1) / 2);
}

function safeFillet(s: R.Shape3D, r: number, pick?: (e: R.Edge) => boolean): R.Shape3D {
  if (r <= 0.01) return s;
  try {
    const out = s.fillet((e) => (!pick || pick(e) ? r : null));
    s.delete();
    return out;
  } catch {
    return s; // too big for this geometry: keep the sharp version
  }
}

const atY = (e: R.Edge, y: number) => [e.startPoint, e.endPoint, e.pointAt(0.5)].every((p) => Math.abs(p.y - y) < 1e-4);

const flatShape = (d: R.Drawing, height: number, round: number) => {
  const s = (d.sketchOnPlane(GROUND()) as R.Sketch).extrude(height) as R.Shape3D;
  return groundCentre(safeFillet(s, Math.min(round, height / 2 - 0.01), (e) => atY(e, 0) || atY(e, height)));
};

function starDrawing(points: number, outer: number, inner: number) {
  const pts: Vec2[] = [];
  for (let i = 0; i < points * 2; i++) {
    const r = i % 2 === 0 ? outer : inner;
    const a = (i / (points * 2)) * Math.PI * 2 + Math.PI / 2;
    pts.push([Math.cos(a) * r, Math.sin(a) * r]);
  }
  return polyDrawing(pts);
}

function heartDrawing(size: number) {
  const k = size / 30;
  const p = (x: number, y: number): Vec2 => [x * k, y * k];
  return R.draw(p(0, -12))
    .cubicBezierCurveTo(p(-15, 6), p(-4, -8), p(-15, -2))
    .cubicBezierCurveTo(p(-7, 15), p(-15, 12), p(-10, 15))
    .cubicBezierCurveTo(p(0, 10), p(-3, 15), p(-1, 13))
    .cubicBezierCurveTo(p(7, 15), p(1, 13), p(3, 15))
    .cubicBezierCurveTo(p(15, 6), p(10, 15), p(15, 12))
    .cubicBezierCurveTo(p(0, -12), p(15, -2), p(4, -8))
    .close();
}

/** Primitives as exact solids. Returns null for shapes that stay mesh-based (threads…). */
function brepPrimitive(id: string, params: Record<string, any>): R.Shape3D | null {
  const def = shapeById(id);
  if (!def) throw new Error(`Unknown shape "${id}"`);
  const p = { ...defaultParams(def), ...params };
  switch (id) {
    case 'box': {
      const s = R.makeBox([-p.width / 2, 0, -p.depth / 2], [p.width / 2, p.height, p.depth / 2]) as R.Shape3D;
      return safeFillet(s, Math.min(p.round, Math.min(p.width, p.height, p.depth) / 2 - 0.01));
    }
    case 'cylinder': {
      const s = p.sides >= 24
        ? R.makeCylinder(p.radius, p.height, [0, 0, 0], [0, 1, 0]) as R.Shape3D
        : (R.drawPolysides(p.radius, p.sides).sketchOnPlane(GROUND()) as R.Sketch).extrude(p.height) as R.Shape3D;
      return safeFillet(s, Math.min(p.round, p.radius - 0.01, p.height / 2 - 0.01), (e) => atY(e, 0) || atY(e, p.height));
    }
    case 'sphere':
      return R.makeSphere(p.radius).translate(0, p.radius, 0) as R.Shape3D;
    case 'cone':
      return lathe(p.topRadius > 0 ? [[0, 0], [p.radius, 0], [p.topRadius, p.height], [0, p.height]] : [[0, 0], [p.radius, 0], [0, p.height]]);
    case 'pyramid': {
      const h = p.width / 2;
      const base: [number, number, number][] = [[-h, 0, -h], [h, 0, -h], [h, 0, h], [-h, 0, h]];
      const apex: [number, number, number] = [0, p.height, 0];
      const faces = [R.makePolygon([...base].reverse()), ...base.map((b, i) => R.makePolygon([b, base[(i + 1) % 4], apex]))];
      return R.makeSolid(faces) as R.Shape3D;
    }
    case 'torus': {
      const tube = Math.min(p.tube, p.radius - 0.01);
      const sk = R.drawCircle(tube).translate(p.radius, tube).sketchOnPlane(FRONT()) as R.Sketch;
      return sk.revolve([0, 1, 0], { origin: [0, 0, 0] }) as R.Shape3D;
    }
    case 'tube': {
      const inner = Math.max(0.01, p.radius - p.wall);
      return lathe([[inner, 0], [p.radius, 0], [p.radius, p.height], [inner, p.height]]);
    }
    case 'wedge': {
      const sk = polyDrawing([[-p.depth / 2, 0], [p.depth / 2, 0], [-p.depth / 2, p.height]]).sketchOnPlane(FRONT()) as R.Sketch;
      return (sk.extrude(p.width) as R.Shape3D).translate(0, 0, -p.width / 2).rotate(90, [0, 0, 0], [0, 1, 0]);
    }
    case 'hemisphere': {
      const r = p.radius;
      const sk = R.draw([0, 0]).lineTo([r, 0]).threePointsArcTo([0, r], [r * Math.SQRT1_2, r * Math.SQRT1_2]).close().sketchOnPlane(FRONT()) as R.Sketch;
      return sk.revolve([0, 1, 0], { origin: [0, 0, 0] }) as R.Shape3D;
    }
    case 'capsule': {
      const r = p.radius, h = Math.max(p.height, 2 * r + 0.01);
      const sk = R.draw([0, 0])
        .threePointsArcTo([r, r], [r * Math.SQRT1_2, r - r * Math.SQRT1_2])
        .lineTo([r, h - r])
        .threePointsArcTo([0, h], [r * Math.SQRT1_2, h - r + r * Math.SQRT1_2])
        .close().sketchOnPlane(FRONT()) as R.Sketch;
      return sk.revolve([0, 1, 0], { origin: [0, 0, 0] }) as R.Shape3D;
    }
    case 'prism':
      return (R.drawPolysides(p.radius, p.sides).sketchOnPlane(GROUND()) as R.Sketch).extrude(p.height) as R.Shape3D;
    case 'star':
      return flatShape(starDrawing(p.points, p.radius, Math.min(p.inner, p.radius - 0.1)), p.height, p.round);
    case 'heart':
      return flatShape(heartDrawing(p.size), p.height, p.round);
    case 'text': {
      const letters = textShapes(String(p.text || ' '), p.size);
      if (!letters.length) return null;
      const solids = letters.map((sh) => {
        let d = polyDrawing(sh.getPoints(6).map((v) => [v.x, v.y] as Vec2));
        for (const hole of sh.holes) d = d.cut(polyDrawing(hole.getPoints(6).map((v) => [v.x, v.y] as Vec2)));
        return (d.sketchOnPlane(FRONT()) as R.Sketch).extrude(p.depth) as R.Shape3D;
      });
      return groundCentre(fuseAll(solids));
    }
    case 'container': {
      const w = Math.max(p.wall * 2 + 0.5, p.width), d = Math.max(p.wall * 2 + 0.5, p.depth);
      let s = R.makeBox([-w / 2, 0, -d / 2], [w / 2, p.height, d / 2]) as R.Shape3D;
      const r = Math.min(p.round, Math.min(w, d) / 2 - 0.01);
      // round the vertical corners, then hollow it out through the top face
      s = safeFillet(s, r, (e) => Math.abs(e.endPoint.y - e.startPoint.y) > 1e-6);
      const top = p.height;
      const out = s.shell(p.wall, (f) => f.when(({ element }) => Math.abs((element as R.Face).center.y - top) < 1e-5));
      s.delete();
      return out;
    }
    case 'screwhole': {
      const r = p.diameter / 2, Rr = Math.max(p.headDiameter / 2, r + 0.1), top = p.depth + 1;
      const pts: Vec2[] = p.head === 'counterbore'
        ? [[0, 0], [r, 0], [r, p.depth - p.headDepth], [Rr, p.depth - p.headDepth], [Rr, top], [0, top]]
        : p.head === 'countersink'
          ? [[0, 0], [r, 0], [r, p.depth - (Rr - r)], [Rr, p.depth], [Rr, top], [0, top]]
          : [[0, 0], [r, 0], [r, top], [0, top]];
      return lathe(pts).translate(0, -p.depth, 0);
    }
    default:
      return null; // gear, spring, threads, bolts and nuts stay as meshes
  }
}

function gearBrep(p: Record<string, any>): R.Shape3D {
  // reuse the mesh outline (same tooth profile) as an exact polygon + true circular bore
  const teeth = p.teeth, outer = p.radius, root = Math.max(outer - p.toothDepth, outer * 0.3), pitch = (Math.PI * 2) / teeth;
  const pts: Vec2[] = [];
  const polar = (r: number, a: number): Vec2 => [Math.cos(a) * r, Math.sin(a) * r];
  for (let i = 0; i < teeth; i++) {
    const a = i * pitch;
    for (let j = 0; j <= 3; j++) pts.push(polar(root, a + (0.25 * pitch * j) / 3));
    pts.push(polar(outer * 0.985, a + 0.36 * pitch), polar(outer, a + 0.42 * pitch), polar(outer, a + 0.58 * pitch), polar(outer * 0.985, a + 0.64 * pitch), polar(root, a + 0.75 * pitch));
  }
  let d = polyDrawing(pts);
  if (p.bore > 0 && p.bore < root) d = d.cut(R.drawCircle(p.bore));
  return flatShape(d, p.height, 0);
}

// ---------------------------------------------------------------------------
// reference matching: edges and faces are remembered by a point on them

function nearestEdges(shape: R.Shape3D, points: Vec3[]) {
  const edges = shape.edges;
  const samples = edges.map((e) => {
    const out: THREE.Vector3[] = [];
    for (let i = 0; i <= 16; i++) { const p = e.pointAt(i / 16); out.push(new THREE.Vector3(p.x, p.y, p.z)); }
    return out;
  });
  const chosen = new Set<number>();
  const segDist = (p: THREE.Vector3, pts: THREE.Vector3[]) => {
    let best = Infinity;
    const line = new THREE.Line3();
    const c = new THREE.Vector3();
    for (let i = 0; i < pts.length - 1; i++) {
      line.set(pts[i], pts[i + 1]);
      best = Math.min(best, line.closestPointToPoint(p, true, c).distanceTo(p));
    }
    return best;
  };
  for (const raw of points) {
    const p = new THREE.Vector3(...raw);
    let best = -1, bestD = Infinity;
    samples.forEach((s, i) => { const d = segDist(p, s); if (d < bestD) { bestD = d; best = i; } });
    if (best >= 0 && bestD < 2) chosen.add(best);
  }
  const hashes = new Set([...chosen].map((i) => edges[i].hashCode));
  return (e: R.Edge) => hashes.has(e.hashCode) && [...chosen].some((i) => edges[i].isSame(e));
}

function nearestFaces(shape: R.Shape3D, points: Vec3[]): R.Face[] {
  const faces = shape.faces;
  const out: R.Face[] = [];
  for (const raw of points) {
    const v = R.makeVertex(raw);
    let best: R.Face | null = null, bestD = Infinity;
    for (const f of faces) {
      const d = R.measureDistanceBetween(v, f);
      if (d < bestD) { bestD = d; best = f; }
    }
    v.delete();
    if (best && bestD < 2 && !out.includes(best)) out.push(best);
  }
  return out;
}

// ---------------------------------------------------------------------------

export const brepKernel: Kernel<BSolid> = {
  precise: true,

  begin() { gen++; },

  end(live) {
    const keep = new Set(live);
    for (const [k, v] of cache) {
      if (v.gen < gen - 3 && !keep.has(v.solid)) { free(v.solid); cache.delete(k); }
    }
  },

  primitive(shape, params, key) {
    return cached(key, () => {
      const p = { ...defaultParams(shapeById(shape)!), ...params };
      const s = shape === 'gear' ? gearBrep(p) : brepPrimitive(shape, p);
      return s ? brep(s) : { kind: 'mesh', geo: buildShape(shape, params) };
    });
  },

  importMesh(data, step, key) {
    return cached(key, () => {
      if (step) {
        const s = importStepText(step);
        if (s) return brep(s);
      }
      return { kind: 'mesh', geo: meshKernel.importMesh(data, undefined, key) };
    });
  },

  extrude(f, entities, key) {
    return cached(key, () => {
      const dist = Math.abs(f.distance) || 0.01;
      const solids = profilesOf(entities, 'extrude').map((p) => (profileDrawing(p).sketchOnPlane('XY') as R.Sketch).extrude(dist) as R.Shape3D);
      let s = fuseAll(solids);
      const r = Math.max(0, Math.min(f.roundEdges, dist / 2 - 0.01));
      if (r > 0) {
        s = safeFillet(s, r, (e) => [e.startPoint, e.endPoint, e.pointAt(0.5)].every((p) => Math.abs(p.z) < 1e-4)
          || [e.startPoint, e.endPoint, e.pointAt(0.5)].every((p) => Math.abs(p.z - dist) < 1e-4));
      }
      if (f.symmetric) s = s.translate(0, 0, -dist / 2);
      else if (f.distance < 0) s = s.translate(0, 0, -dist);
      return brep(s);
    });
  },

  revolve(f, entities, key) {
    return cached(key, () => {
      const axis: Vec3 = f.axis === 'y' ? [0, 1, 0] : [1, 0, 0];
      const solids = profilesOf(entities, 'revolve').map((p) =>
        (profileDrawing(p).sketchOnPlane('XY') as R.Sketch).revolve(axis, { origin: [0, 0, 0], angle: Math.max(1, Math.min(360, f.angle)) }) as R.Shape3D);
      return brep(fuseAll(solids));
    });
  },

  loft(sections, smooth, key) {
    return cached(key, () => {
      const sketches = sections.map((sec) => {
        const ps = sketchProfileEntities(sec.entities);
        if (!ps.length) throw new Error('Every loft sketch needs a closed shape.');
        const biggest = ps.reduce((a, b) => (Math.abs(area(b.outer)) > Math.abs(area(a.outer)) ? b : a));
        return entityDrawing(biggest.outerEntity).sketchOnPlane(planeOf(sec.matrix)) as R.Sketch;
      });
      return brep(sketches[0].loftWith(sketches.slice(1), { ruled: !smooth }) as R.Shape3D);
    });
  },

  sweep(profile, path, twist, key) {
    return cached(key, () => {
      const prof = sketchProfileEntities(profile)[0];
      if (!prof) throw new Error('The profile sketch needs a closed shape.');
      if (twist) return { kind: 'mesh', geo: meshKernel.sweep(profile, path, twist, key) }; // twisted sweeps stay meshes
      const pathEnt = path.entities.find((e) => (e.kind === 'polyline' || e.kind === 'spline') && !e.closed) ?? path.entities[0];
      if (!pathEnt) throw new Error('The path sketch is empty. Draw a line or spline for the path.');
      // build the spine from the sketch's own points: a simple spline (few knots) or straight lines,
      // which keeps later booleans fast and robust
      const toWorld = ([x, y]: Vec2) => new THREE.Vector3(x, y, 0).applyMatrix4(path.matrix).toArray() as Vec3;
      let spine: R.Wire;
      if (pathEnt.kind === 'spline' && pathEnt.points.length > 2) {
        const pts = pathEnt.points.map(toWorld);
        spine = R.assembleWire([R.makeBSplineApproximation(pathEnt.closed ? [...pts, pts[0]] : pts, { tolerance: 1e-3, degMax: 3 })]);
      } else {
        const pts = entityOutline(pathEnt, 96).points.map(toWorld);
        if (pathEnt.kind !== 'polyline' && pathEnt.kind !== 'spline') pts.push(pts[0]);
        else if (pathEnt.closed) pts.push(pts[0]);
        spine = R.assembleWire(pts.slice(1).map((p, i) => R.makeLine(pts[i], p)));
      }
      // centre the profile on its bounds and stand it at the path start, locked to the path's
      // plane: profile u along the plane normal, v along the in-plane normal (same as the preview)
      const box = new THREE.Box2();
      prof.outer.forEach(([x, y]) => box.expandByPoint(new THREE.Vector2(x, y)));
      const c = box.getCenter(new THREE.Vector2());
      const np = new THREE.Vector3();
      path.matrix.extractBasis(new THREE.Vector3(), new THREE.Vector3(), np);
      np.normalize();
      const start = spine.startPoint, tan = spine.tangentAt(0);
      const tangent = new THREE.Vector3(tan.x, tan.y, tan.z).normalize();
      const plane = new R.Plane([start.x, start.y, start.z], np.toArray() as Vec3, tangent.toArray() as Vec3);
      const sweepOne = (e: SketchEntity) => {
        const sk = entityDrawing(e).translate(-c.x, -c.y).sketchOnPlane(plane.clone()) as R.Sketch;
        return R.genericSweep(sk.wire, spine.clone(), { frenet: true }, false) as R.Shape3D;
      };
      let out = sweepOne(prof.outerEntity);
      for (const h of prof.holeEntities) { const hole = sweepOne(h); const cut = out.cut(hole); out.delete(); hole.delete(); out = cut; }
      return brep(out);
    });
  },

  boolean(a, b, op) {
    const key = hash(`${op}|${a.key}@${matKey(a.matrix)}|${b.key}@${matKey(b.matrix)}`);
    const hit = cache.get(key);
    if (hit) { hit.gen = gen; return { solid: hit.solid, key, matrix: new THREE.Matrix4() }; }
    if (a.solid.kind === 'brep' && b.solid.kind === 'brep' && uniformScale(a.matrix) && uniformScale(b.matrix)) {
      const A = world(a), B = world(b);
      try {
        const out = op === 'join' ? A.fuse(B) : op === 'cut' ? A.cut(B) : A.intersect(B);
        // merge coplanar faces left by the boolean (cleaner edges to fillet later)
        const simple = out instanceof R.Solid ? (() => { try { const s = out.simplify(); out.delete(); return s as R.Shape3D; } catch { return out; } })() : out;
        const solid = brep(simple);
        cache.set(key, { solid, gen });
        return { solid, key, matrix: new THREE.Matrix4() };
      } finally { A.delete(); B.delete(); }
    }
    const r = fromMesh(meshBoolean(asMesh(a), asMesh(b), op));
    cache.set(key, { solid: r.solid, gen });
    return { ...r, key };
  },

  mirror(b, refl, key) {
    const solid = cached(key, () => {
      if (b.solid.kind !== 'brep') return { kind: 'mesh', geo: meshKernel.mirror(asMesh(b), refl, key).solid };
      const w = world(b);
      const out = transformed(w, refl);
      w.delete();
      return brep(out);
    });
    return { solid, key, matrix: new THREE.Matrix4() };
  },

  split(b, axis, offset) {
    if (b.solid.kind !== 'brep') {
      const [lo, hi] = meshKernel.split(asMesh(b), axis, offset);
      return [fromMesh(lo), fromMesh(hi)];
    }
    const k = (side: string) => hash(`split|${side}|${axis}|${offset}|${b.key}@${matKey(b.matrix)}`);
    const make = (keep: 'low' | 'high') => cached(k(keep), () => {
      const w = world(b);
      const bb = w.boundingBox;
      const size = Math.hypot(bb.width, bb.height, bb.depth) * 2 + 10;
      const [cx, cy, cz] = bb.center;
      const c = [cx - size / 2, cy - size / 2, cz - size / 2];
      const lo = [...c], hi = [c[0] + size, c[1] + size, c[2] + size];
      const i = axis === 'x' ? 0 : axis === 'y' ? 1 : 2;
      lo[i] = offset;
      const half = R.makeBox(lo as Vec3, hi as Vec3) as R.Shape3D;
      const out = keep === 'low' ? w.cut(half) : w.intersect(half);
      w.delete(); half.delete();
      return brep(out);
    });
    return [
      { solid: make('low'), key: k('low'), matrix: new THREE.Matrix4() },
      { solid: make('high'), key: k('high'), matrix: new THREE.Matrix4() },
    ];
  },

  modify(b, f) {
    const key = hash(`${f.type}|${JSON.stringify({ ...f, id: '', name: '', exprs: undefined })}|${b.key}@${matKey(b.matrix)}`);
    const solid = cached(key, () => {
      if (b.solid.kind !== 'brep') throw new Error('This body is a mesh (threads or an imported STL), so it can’t be rounded or shelled. Use shapes, sketches or STEP files for precise edits.');
      const w = world(b);
      try {
        if (f.type === 'fillet') {
          const pick = f.edges.length ? nearestEdges(w, f.edges) : () => true;
          const out = f.mode === 'fillet'
            ? w.fillet((e) => (pick(e) ? f.radius : null))
            : w.chamfer((e) => (pick(e) ? f.radius : null));
          return brep(out);
        }
        if (f.type === 'shell') {
          let faces = f.faces.length ? nearestFaces(w, f.faces) : [];
          if (!faces.length) {
            // default: open the top so beginners get a cup, not a sealed void
            const top = w.faces.reduce((a, c) => (c.center.y > a.center.y ? c : a));
            faces = [top];
          }
          return brep(w.shell(f.thickness, (ff) => ff.inList(faces)));
        }
        const faces = nearestFaces(w, f.faces);
        if (!faces.length) throw new Error('Pick the faces to taper.');
        const minY = w.boundingBox.bounds[0][1];
        return brep((w as any).draft(f.angle, (ff: R.FaceFinder) => ff.inList(faces), new R.Plane([0, minY, 0], [1, 0, 0], [0, 1, 0])));
      } finally { w.delete(); }
    });
    return { solid, key, matrix: new THREE.Matrix4() };
  },

  bounds(b) {
    if (b.solid.kind === 'mesh') return meshKernel.bounds({ solid: b.solid.geo, key: b.key, matrix: b.matrix });
    const [[x0, y0, z0], [x1, y1, z1]] = b.solid.shape.boundingBox.bounds;
    return new THREE.Box3(new THREE.Vector3(x0, y0, z0), new THREE.Vector3(x1, y1, z1)).applyMatrix4(b.matrix);
  },
};

const area = (pts: Vec2[]) => {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[(i + 1) % pts.length];
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
};

// ---------------------------------------------------------------------------
// STEP

/** Parse STEP text into one shape (synchronously, via OpenCascade's reader). */
export function importStepText(text: string): R.Shape3D | null {
  const oc = R.getOC();
  const name = `/import-${hash(text.slice(0, 2000) + text.length)}.step`;
  oc.FS.writeFile(name, text);
  const reader = new oc.STEPControl_Reader();
  try {
    if (reader.ReadFile(name) !== oc.IFSelect_ReturnStatus.IFSelect_RetDone) return null;
    reader.TransferRoots(new oc.Message_ProgressRange());
    const shape = R.cast(reader.OneShape()) as R.Shape3D;
    // STEP is Z-up: rotate into KimaticPro's Y-up world
    return shape.rotate(-90, [0, 0, 0], [1, 0, 0]);
  } finally {
    reader.delete();
    try { oc.FS.unlink(name); } catch { /* ignore */ }
  }
}

/** STEP file of placed bodies, converted back to Z-up for other CAD tools. */
export function exportStep(bodies: { name: string; color: string; solid: BSolid; matrix: THREE.Matrix4 }[]): { blob: Blob | null; skipped: string[] } {
  const shapes: { shape: R.Shape3D; name: string; color: string }[] = [];
  const skipped: string[] = [];
  for (const b of bodies) {
    if (b.solid.kind !== 'brep') { skipped.push(b.name); continue; }
    const w = transformed(b.solid.shape, b.matrix);
    shapes.push({ shape: w.rotate(90, [0, 0, 0], [1, 0, 0]), name: b.name, color: b.color });
  }
  if (!shapes.length) return { blob: null, skipped };
  const blob = R.exportSTEP(shapes.map((s) => ({ shape: s.shape, name: s.name, color: s.color })), { unit: 'MM' } as any);
  shapes.forEach((s) => s.shape.delete());
  return { blob, skipped };
}
