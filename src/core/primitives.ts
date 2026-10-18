import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { TextGeometry } from 'three/examples/jsm/geometries/TextGeometry.js';
import { Font } from 'three/examples/jsm/loaders/FontLoader.js';
import fontJson from 'three/examples/fonts/helvetiker_bold.typeface.json';
import { normalizeGeometry } from './geometry';
import { bolt, container, nut, screwHole, threadedRod } from './hardware';

export interface ParamDef {
  key: string;
  label: string;
  type: 'number' | 'int' | 'text' | 'bool' | 'select';
  options?: { value: string; label: string }[];
  default: number | string | boolean;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  hint?: string;
}

export type ShapeCategory = 'Basic' | 'Fun' | 'Mechanical' | 'Hardware';

export interface ShapeDef {
  id: string;
  label: string;
  category: ShapeCategory;
  description: string;
  color: string;
  params: ParamDef[];
  /** Builds the shape resting on the ground (y = 0), centred on X/Z. */
  build: (p: Record<string, any>) => THREE.BufferGeometry;
  /** Shapes like screw holes are meant to cut whatever they're dropped onto. */
  defaultOp?: 'cut';
  /** Holes hang below y = 0 so they sink into the face they're dropped on. */
  hangs?: boolean;
}

const font = new Font(fontJson as any);

/** Letter outlines (with holes) for a string, in font units = mm at `size`. */
export const textShapes = (text: string, size: number) => font.generateShapes(text, size);

const mm = (key: string, label: string, def: number, min = 0.1, max = 2000, hint?: string): ParamDef => ({
  key, label, type: 'number', default: def, min, max, step: 1, unit: 'mm', hint,
});
const int = (key: string, label: string, def: number, min: number, max: number, hint?: string): ParamDef => ({
  key, label, type: 'int', default: def, min, max, step: 1, hint,
});

const seg = 64;

/** Revolve a 2D profile (x = radius, y = height) around the Y axis. */
function lathe(points: [number, number][], segments = seg) {
  return new THREE.LatheGeometry(points.map(([x, y]) => new THREE.Vector2(Math.max(0, x), y)), segments);
}

function arc(cx: number, cy: number, r: number, a0: number, a1: number, n = 8): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i <= n; i++) {
    const a = a0 + ((a1 - a0) * i) / n;
    out.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
  }
  return out;
}

/** Shapes drawn on XY, extruded, then laid flat so the extrusion points up (+Y). */
function flatExtrude(shapes: THREE.Shape | THREE.Shape[], height: number, round = 0) {
  const r = Math.min(round, height / 2 - 0.01);
  const geo = new THREE.ExtrudeGeometry(shapes, {
    depth: Math.max(0.01, height - (r > 0 ? 2 * r : 0)),
    bevelEnabled: r > 0,
    bevelThickness: r,
    bevelSize: r,
    bevelOffset: -r,
    bevelSegments: 4,
    curveSegments: 32,
  });
  if (r > 0) geo.translate(0, 0, r);
  geo.rotateX(-Math.PI / 2);
  return groundAndCenter(geo);
}

function groundAndCenter(geo: THREE.BufferGeometry) {
  geo.computeBoundingBox();
  const bb = geo.boundingBox!;
  geo.translate(-(bb.min.x + bb.max.x) / 2, -bb.min.y, -(bb.min.z + bb.max.z) / 2);
  return geo;
}

function starShape(points: number, outer: number, inner: number) {
  const s = new THREE.Shape();
  for (let i = 0; i < points * 2; i++) {
    const r = i % 2 === 0 ? outer : inner;
    const a = (i / (points * 2)) * Math.PI * 2 + Math.PI / 2;
    const x = Math.cos(a) * r, y = Math.sin(a) * r;
    if (i === 0) s.moveTo(x, y); else s.lineTo(x, y);
  }
  s.closePath();
  return s;
}

function heartShape(size: number) {
  const k = size / 30;
  const s = new THREE.Shape();
  s.moveTo(0, -12 * k);
  s.bezierCurveTo(-4 * k, -8 * k, -15 * k, -2 * k, -15 * k, 6 * k);
  s.bezierCurveTo(-15 * k, 12 * k, -10 * k, 15 * k, -7 * k, 15 * k);
  s.bezierCurveTo(-3 * k, 15 * k, -1 * k, 13 * k, 0, 10 * k);
  s.bezierCurveTo(1 * k, 13 * k, 3 * k, 15 * k, 7 * k, 15 * k);
  s.bezierCurveTo(10 * k, 15 * k, 15 * k, 12 * k, 15 * k, 6 * k);
  s.bezierCurveTo(15 * k, -2 * k, 4 * k, -8 * k, 0, -12 * k);
  return s;
}

function gearShape(teeth: number, outer: number, toothDepth: number, bore: number) {
  const s = new THREE.Shape();
  const root = Math.max(outer - toothDepth, outer * 0.3);
  const p = (Math.PI * 2) / teeth;
  const pts: [number, number][] = [];
  const polar = (r: number, a: number): [number, number] => [Math.cos(a) * r, Math.sin(a) * r];
  for (let i = 0; i < teeth; i++) {
    const a = i * p;
    for (let j = 0; j <= 3; j++) pts.push(polar(root, a + (0.25 * p * j) / 3));
    pts.push(polar(outer * 0.985, a + 0.36 * p));
    pts.push(polar(outer, a + 0.42 * p));
    pts.push(polar(outer, a + 0.58 * p));
    pts.push(polar(outer * 0.985, a + 0.64 * p));
    pts.push(polar(root, a + 0.75 * p));
  }
  pts.forEach(([x, y], i) => (i === 0 ? s.moveTo(x, y) : s.lineTo(x, y)));
  s.closePath();
  if (bore > 0 && bore < root) {
    const h = new THREE.Path();
    h.absarc(0, 0, bore, 0, Math.PI * 2, true);
    s.holes.push(h);
  }
  return s;
}

class HelixCurve extends THREE.Curve<THREE.Vector3> {
  constructor(private radius: number, private height: number, private turns: number) { super(); }
  getPoint(t: number, target = new THREE.Vector3()) {
    const a = t * this.turns * Math.PI * 2;
    return target.set(Math.cos(a) * this.radius, t * this.height, Math.sin(a) * this.radius);
  }
}

export const SHAPES: ShapeDef[] = [
  {
    id: 'box', label: 'Box', category: 'Basic', color: '#3b82f6',
    description: 'A rectangular block. The building brick of almost everything.',
    params: [mm('width', 'Width', 20), mm('height', 'Height', 20), mm('depth', 'Depth', 20), mm('round', 'Round edges', 0, 0, 500, 'Softens every edge')],
    build: (p) => {
      const r = Math.min(p.round, Math.min(p.width, p.height, p.depth) / 2 - 0.01);
      const geo = r > 0.05
        ? new RoundedBoxGeometry(p.width, p.height, p.depth, 4, r)
        : new THREE.BoxGeometry(p.width, p.height, p.depth);
      geo.translate(0, p.height / 2, 0);
      return geo;
    },
  },
  {
    id: 'cylinder', label: 'Cylinder', category: 'Basic', color: '#f97316',
    description: 'A round column. Great for wheels, posts and holes.',
    params: [mm('radius', 'Radius', 10), mm('height', 'Height', 20), int('sides', 'Smoothness', 64, 3, 256, 'Number of sides'), mm('round', 'Round edges', 0, 0, 500)],
    build: (p) => {
      const r = Math.min(p.round, p.radius - 0.01, p.height / 2 - 0.01);
      if (r <= 0.05) {
        const g = new THREE.CylinderGeometry(p.radius, p.radius, p.height, p.sides);
        g.translate(0, p.height / 2, 0);
        return g;
      }
      return lathe([
        [0, 0],
        ...arc(p.radius - r, r, r, -Math.PI / 2, 0),
        ...arc(p.radius - r, p.height - r, r, 0, Math.PI / 2),
        [0, p.height],
      ], p.sides);
    },
  },
  {
    id: 'sphere', label: 'Sphere', category: 'Basic', color: '#22c55e',
    description: 'A perfect ball.',
    params: [mm('radius', 'Radius', 10), int('detail', 'Smoothness', 48, 8, 128)],
    build: (p) => {
      const g = new THREE.SphereGeometry(p.radius, p.detail, Math.max(6, Math.round(p.detail * 0.66)));
      g.translate(0, p.radius, 0);
      return g;
    },
  },
  {
    id: 'cone', label: 'Cone', category: 'Basic', color: '#eab308',
    description: 'Pointy on top. Set a top radius for a frustum.',
    params: [mm('radius', 'Bottom radius', 10), mm('topRadius', 'Top radius', 0, 0), mm('height', 'Height', 20), int('sides', 'Smoothness', 64, 3, 256)],
    build: (p) => {
      const pts: [number, number][] = [[0, 0], [p.radius, 0], [p.topRadius, p.height]];
      if (p.topRadius > 0) pts.push([0, p.height]);
      return lathe(pts, p.sides);
    },
  },
  {
    id: 'pyramid', label: 'Pyramid', category: 'Basic', color: '#f59e0b',
    description: 'A square-based pyramid, like in Egypt.',
    params: [mm('width', 'Base width', 20), mm('height', 'Height', 20)],
    build: (p) => {
      const g = new THREE.ConeGeometry(p.width / Math.SQRT2, p.height, 4, 1);
      g.rotateY(Math.PI / 4);
      g.translate(0, p.height / 2, 0);
      return g;
    },
  },
  {
    id: 'torus', label: 'Torus', category: 'Basic', color: '#ec4899',
    description: 'A donut! Perfect for rings and handles.',
    params: [mm('radius', 'Ring radius', 12), mm('tube', 'Tube radius', 4), int('detail', 'Smoothness', 64, 8, 200)],
    build: (p) => {
      const g = new THREE.TorusGeometry(p.radius, Math.min(p.tube, p.radius - 0.01), Math.max(8, p.detail / 2), p.detail);
      g.rotateX(-Math.PI / 2);
      g.translate(0, p.tube, 0);
      return g;
    },
  },
  {
    id: 'tube', label: 'Tube', category: 'Basic', color: '#14b8a6',
    description: 'A hollow pipe. Change the wall to make cups and rings.',
    params: [mm('radius', 'Outer radius', 12), mm('wall', 'Wall thickness', 2), mm('height', 'Height', 20), int('sides', 'Smoothness', 64, 3, 256)],
    build: (p) => {
      const inner = Math.max(0.01, p.radius - p.wall);
      return lathe([[inner, 0], [p.radius, 0], [p.radius, p.height], [inner, p.height], [inner, 0]], p.sides);
    },
  },
  {
    id: 'wedge', label: 'Wedge', category: 'Basic', color: '#8b5cf6',
    description: 'A ramp or roof shape.',
    params: [mm('width', 'Width', 20), mm('height', 'Height', 20), mm('depth', 'Depth', 20)],
    build: (p) => {
      const s = new THREE.Shape();
      s.moveTo(-p.depth / 2, 0); s.lineTo(p.depth / 2, 0); s.lineTo(-p.depth / 2, p.height); s.closePath();
      const g = new THREE.ExtrudeGeometry(s, { depth: p.width, bevelEnabled: false });
      g.translate(0, 0, -p.width / 2);
      g.rotateY(Math.PI / 2);
      return g;
    },
  },
  {
    id: 'hemisphere', label: 'Dome', category: 'Basic', color: '#06b6d4',
    description: 'Half a sphere — domes, buttons and igloos.',
    params: [mm('radius', 'Radius', 12), int('detail', 'Smoothness', 64, 8, 200)],
    build: (p) => lathe([[0, 0], ...arc(0, 0, p.radius, 0, Math.PI / 2, Math.max(6, Math.round(p.detail / 4)))], p.detail),
  },
  {
    id: 'capsule', label: 'Capsule', category: 'Basic', color: '#6366f1',
    description: 'A pill shape with round ends.',
    params: [mm('radius', 'Radius', 6), mm('height', 'Total height', 30)],
    build: (p) => {
      const len = Math.max(0.01, p.height - p.radius * 2);
      const g = new THREE.CapsuleGeometry(p.radius, len, 12, 48);
      g.translate(0, p.height / 2, 0);
      return g;
    },
  },
  {
    id: 'prism', label: 'Prism', category: 'Basic', color: '#84cc16',
    description: 'A straight polygon column — hexagons, triangles and more.',
    params: [mm('radius', 'Radius', 10), int('sides', 'Sides', 6, 3, 64), mm('height', 'Height', 20)],
    build: (p) => {
      const g = new THREE.CylinderGeometry(p.radius, p.radius, p.height, p.sides);
      g.translate(0, p.height / 2, 0);
      return g;
    },
  },
  {
    id: 'star', label: 'Star', category: 'Fun', color: '#facc15',
    description: 'Shine bright. Choose how many points it has.',
    params: [int('points', 'Points', 5, 3, 24), mm('radius', 'Outer radius', 15), mm('inner', 'Inner radius', 7), mm('height', 'Thickness', 5), mm('round', 'Round edges', 0, 0, 50)],
    build: (p) => flatExtrude(starShape(p.points, p.radius, Math.min(p.inner, p.radius - 0.1)), p.height, p.round),
  },
  {
    id: 'heart', label: 'Heart', category: 'Fun', color: '#ef4444',
    description: 'Show some love.',
    params: [mm('size', 'Size', 30), mm('height', 'Thickness', 6), mm('round', 'Round edges', 1, 0, 50)],
    build: (p) => flatExtrude(heartShape(p.size), p.height, p.round),
  },
  {
    id: 'text', label: 'Text', category: 'Fun', color: '#0ea5e9',
    description: 'Write your name in 3D!',
    params: [
      { key: 'text', label: 'Text', type: 'text', default: 'Hello' },
      mm('size', 'Letter size', 12), mm('depth', 'Thickness', 4),
    ],
    build: (p) => {
      const g = new TextGeometry(String(p.text || ' '), { font, size: p.size, depth: p.depth, curveSegments: 8 });
      return groundAndCenter(g);
    },
  },
  {
    id: 'gear', label: 'Gear', category: 'Mechanical', color: '#64748b',
    description: 'A spur gear with a centre bore. Pick the tooth count.',
    params: [int('teeth', 'Teeth', 16, 6, 120), mm('radius', 'Outer radius', 20), mm('toothDepth', 'Tooth depth', 3), mm('height', 'Thickness', 6), mm('bore', 'Bore radius', 4, 0)],
    build: (p) => flatExtrude(gearShape(p.teeth, p.radius, p.toothDepth, p.bore), p.height),
  },
  {
    id: 'spring', label: 'Spring', category: 'Mechanical', color: '#a1a1aa',
    description: 'A coil spring / helix.',
    params: [mm('radius', 'Coil radius', 10), mm('wire', 'Wire radius', 1.5), mm('height', 'Height', 30), { key: 'turns', label: 'Turns', type: 'number', default: 5, min: 0.5, max: 100, step: 0.5 }],
    build: (p) => {
      const curve = new HelixCurve(p.radius, p.height - p.wire * 2, p.turns);
      return groundAndCenter(new THREE.TubeGeometry(curve, Math.round(48 * p.turns), p.wire, 12, false));
    },
  },
  {
    id: 'container', label: 'Storage box', category: 'Hardware', color: '#0ea5e9',
    description: 'An open box with walls and a floor — organisers, trays, planters.',
    params: [mm('width', 'Width', 60), mm('height', 'Height', 30), mm('depth', 'Depth', 40), mm('wall', 'Wall', 2, 0.4, 50), mm('floor', 'Floor', 2, 0.2, 50), mm('round', 'Round corners', 4, 0, 200)],
    build: (p) => container(p as any),
  },
  {
    id: 'screwhole', label: 'Screw hole', category: 'Hardware', color: '#ef4444', defaultOp: 'cut', hangs: true,
    description: 'A clearance hole with counterbore or countersink. Drop it on a face to drill it.',
    params: [
      mm('diameter', 'Hole Ø', 3.4, 0.5, 100, 'M3 screws need ~3.4 mm'), mm('depth', 'Depth', 10),
      { key: 'head', label: 'Head', type: 'select', default: 'counterbore', options: [{ value: 'none', label: 'Plain' }, { value: 'counterbore', label: 'Counterbore' }, { value: 'countersink', label: 'Countersink' }] },
      mm('headDiameter', 'Head Ø', 6.5, 0.5, 200), mm('headDepth', 'Head depth', 3, 0, 200),
    ],
    build: (p) => {
      const g = screwHole(p as any);
      g.translate(0, -p.depth, 0);
      return g;
    },
  },
  {
    id: 'thread', label: 'Threaded rod', category: 'Hardware', color: '#94a3b8',
    description: 'A real printable screw thread (metric profile).',
    params: [mm('diameter', 'Diameter', 8, 1, 200), { key: 'pitch', label: 'Pitch', type: 'number', default: 1.25, min: 0.2, max: 20, step: 0.05, unit: 'mm', hint: 'Distance between threads. M8 = 1.25' }, mm('length', 'Length', 30), { key: 'leftHand', label: 'Left-handed', type: 'bool', default: false }],
    build: (p) => threadedRod({ diameter: p.diameter, pitch: p.pitch, length: p.length, leftHand: !!p.leftHand }),
  },
  {
    id: 'bolt', label: 'Bolt', category: 'Hardware', color: '#64748b',
    description: 'A printable bolt with hex or socket head. Prints head-down.',
    params: [
      mm('diameter', 'Diameter', 8, 1, 100), { key: 'pitch', label: 'Pitch', type: 'number', default: 1.25, min: 0.2, max: 20, step: 0.05, unit: 'mm' }, mm('length', 'Thread length', 20),
      { key: 'head', label: 'Head', type: 'select', default: 'hex', options: [{ value: 'hex', label: 'Hex' }, { value: 'socket', label: 'Socket' }] },
      mm('headHeight', 'Head height', 5.5), mm('headWidth', 'Head width', 13, 1, 200, 'Across the flats for hex heads'),
    ],
    build: (p) => bolt(p as any),
  },
  {
    id: 'nut', label: 'Nut', category: 'Hardware', color: '#78716c',
    description: 'A hex nut that fits the matching bolt. Tolerance adds print clearance.',
    params: [
      mm('diameter', 'Thread Ø', 8, 1, 100), { key: 'pitch', label: 'Pitch', type: 'number', default: 1.25, min: 0.2, max: 20, step: 0.05, unit: 'mm' },
      mm('height', 'Height', 6.5), mm('width', 'Width', 13, 1, 200, 'Across the flats'),
      { key: 'tolerance', label: 'Tolerance', type: 'number', default: 0.3, min: 0, max: 2, step: 0.05, unit: 'mm', hint: 'Extra room so a printed nut spins freely' },
    ],
    build: (p) => nut(p as any),
  },
];

export const shapeById = (id: string) => SHAPES.find((s) => s.id === id);

export function defaultParams(shape: ShapeDef) {
  const out: Record<string, number | string | boolean> = {};
  for (const p of shape.params) out[p.key] = p.default;
  return out;
}

export function buildShape(shapeId: string, params: Record<string, any>): THREE.BufferGeometry {
  const def = shapeById(shapeId);
  if (!def) throw new Error(`Unknown shape "${shapeId}"`);
  const merged = { ...defaultParams(def), ...params };
  return normalizeGeometry(def.build(merged));
}
