import * as THREE from 'three';
import type { PlaneDef, SketchEntity, Vec2, Vec3 } from './types';

/** Points tracing an entity's outline in sketch space. */
export function entityOutline(e: SketchEntity, segments = 64): { points: Vec2[]; closed: boolean } {
  switch (e.kind) {
    case 'polyline':
      return { points: e.points, closed: e.closed };
    case 'rect': {
      const r = Math.max(0, Math.min(e.radius ?? 0, e.w / 2 - 1e-4, e.h / 2 - 1e-4));
      if (r <= 1e-4) {
        return { points: [[e.x, e.y], [e.x + e.w, e.y], [e.x + e.w, e.y + e.h], [e.x, e.y + e.h]], closed: true };
      }
      // rounded corners, counter-clockwise from the bottom-right
      const pts: Vec2[] = [];
      const n = 10;
      const corners: [number, number, number][] = [
        [e.x + e.w - r, e.y + r, -Math.PI / 2], [e.x + e.w - r, e.y + e.h - r, 0],
        [e.x + r, e.y + e.h - r, Math.PI / 2], [e.x + r, e.y + r, Math.PI],
      ];
      for (const [cx, cy, a0] of corners) {
        for (let i = 0; i <= n; i++) {
          const a = a0 + (i / n) * (Math.PI / 2);
          pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
        }
      }
      return { points: pts, closed: true };
    }
    case 'circle': {
      const pts: Vec2[] = [];
      for (let i = 0; i < segments; i++) {
        const a = (i / segments) * Math.PI * 2;
        pts.push([e.cx + Math.cos(a) * e.r, e.cy + Math.sin(a) * e.r]);
      }
      return { points: pts, closed: true };
    }
    case 'polygon': {
      const pts: Vec2[] = [];
      const rot = (e.rotation * Math.PI) / 180 + Math.PI / 2;
      for (let i = 0; i < e.sides; i++) {
        const a = rot + (i / e.sides) * Math.PI * 2;
        pts.push([e.cx + Math.cos(a) * e.r, e.cy + Math.sin(a) * e.r]);
      }
      return { points: pts, closed: true };
    }
    case 'spline': {
      if (e.points.length < 2) return { points: e.points, closed: false };
      const curve = new THREE.CatmullRomCurve3(
        e.points.map(([x, y]) => new THREE.Vector3(x, y, 0)),
        e.closed,
        'centripetal',
      );
      const n = Math.max(24, e.points.length * 16);
      const pts = curve.getSpacedPoints(n).map((v) => [v.x, v.y] as Vec2);
      if (e.closed) pts.pop();
      return { points: pts, closed: e.closed };
    }
    case 'slot': {
      const dx = e.x2 - e.x1, dy = e.y2 - e.y1;
      const ang = Math.atan2(dy, dx);
      const pts: Vec2[] = [];
      const half = 24;
      for (let i = 0; i <= half; i++) {
        const a = ang + Math.PI / 2 + (i / half) * Math.PI;
        pts.push([e.x1 + Math.cos(a) * e.r, e.y1 + Math.sin(a) * e.r]);
      }
      for (let i = 0; i <= half; i++) {
        const a = ang - Math.PI / 2 + (i / half) * Math.PI;
        pts.push([e.x2 + Math.cos(a) * e.r, e.y2 + Math.sin(a) * e.r]);
      }
      return { points: pts, closed: true };
    }
  }
}

/** Key points users can snap to: corners, centres and end points. */
export function entitySnapPoints(e: SketchEntity): Vec2[] {
  switch (e.kind) {
    case 'polyline':
    case 'spline':
      return e.points;
    case 'rect':
      return [...entityOutline(e).points, [e.x + e.w / 2, e.y + e.h / 2]];
    case 'circle':
      return [[e.cx, e.cy], [e.cx + e.r, e.cy], [e.cx - e.r, e.cy], [e.cx, e.cy + e.r], [e.cx, e.cy - e.r]];
    case 'polygon':
      return [[e.cx, e.cy], ...entityOutline(e).points];
    case 'slot':
      return [[e.x1, e.y1], [e.x2, e.y2]];
  }
}

function signedArea(pts: Vec2[]) {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[(i + 1) % pts.length];
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
}

export function pointInPolygon([x, y]: Vec2, poly: Vec2[]) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export interface Profile {
  outer: Vec2[];
  holes: Vec2[][];
}

/**
 * Turn the closed loops of a sketch into fillable profiles.
 * Loops nested inside other loops become holes (odd depth) or islands (even depth),
 * so drawing a circle inside a circle gives you a washer automatically.
 */
export function sketchProfiles(entities: SketchEntity[]): Profile[] {
  return sketchProfileEntities(entities).map((p) => ({ outer: p.outer, holes: p.holes }));
}

export interface EntityProfile extends Profile {
  outerEntity: SketchEntity;
  holeEntities: SketchEntity[];
}

/** Same as sketchProfiles, but remembers which entity each loop came from (for exact curves). */
export function sketchProfileEntities(entities: SketchEntity[]): EntityProfile[] {
  const loops = entities
    .map((e) => ({ e, o: entityOutline(e) }))
    .filter(({ o }) => o.closed && o.points.length >= 3)
    .map(({ e, o }) => ({ e, pts: o.points, area: Math.abs(signedArea(o.points)) }))
    .filter((l) => l.area > 1e-6)
    .sort((a, b) => b.area - a.area);

  const depth: number[] = [];
  const parent: number[] = [];
  loops.forEach((l, i) => {
    let p = -1;
    for (let j = i - 1; j >= 0; j--) {
      if (pointInPolygon(l.pts[0], loops[j].pts) && pointInPolygon(centroid(l.pts), loops[j].pts)) {
        if (p === -1 || loops[j].area < loops[p].area) p = j;
      }
    }
    parent[i] = p;
    depth[i] = p === -1 ? 0 : depth[p] + 1;
  });

  const profiles: EntityProfile[] = [];
  const indexOf = new Map<number, number>();
  loops.forEach((l, i) => {
    if (depth[i] % 2 === 0) {
      indexOf.set(i, profiles.length);
      profiles.push({ outer: l.pts, holes: [], outerEntity: l.e, holeEntities: [] });
    } else {
      const pi = indexOf.get(parent[i]);
      if (pi !== undefined) { profiles[pi].holes.push(l.pts); profiles[pi].holeEntities.push(l.e); }
    }
  });
  return profiles;
}

function centroid(pts: Vec2[]): Vec2 {
  let x = 0, y = 0;
  for (const p of pts) { x += p[0]; y += p[1]; }
  return [x / pts.length, y / pts.length];
}

export function profileToShape(p: Profile): THREE.Shape {
  const ccw = (pts: Vec2[]) => (signedArea(pts) < 0 ? [...pts].reverse() : pts);
  const cw = (pts: Vec2[]) => (signedArea(pts) > 0 ? [...pts].reverse() : pts);
  const shape = new THREE.Shape(ccw(p.outer).map(([x, y]) => new THREE.Vector2(x, y)));
  for (const h of p.holes) shape.holes.push(new THREE.Path(cw(h).map(([x, y]) => new THREE.Vector2(x, y))));
  return shape;
}

/** Matrix taking sketch space (u, v, w=normal) to world space. */
export function planeMatrix(plane: PlaneDef): THREE.Matrix4 {
  const n = new THREE.Vector3(...plane.normal).normalize();
  const x = new THREE.Vector3(...plane.xDir).normalize();
  const y = new THREE.Vector3().crossVectors(n, x).normalize();
  const m = new THREE.Matrix4().makeBasis(x, y, n);
  m.setPosition(new THREE.Vector3(...plane.origin));
  return m;
}

export const STANDARD_PLANES: Record<'top' | 'front' | 'right', PlaneDef> = {
  // Y is up in KimaticPro, so the "Top" plane is the ground (XZ).
  top: { origin: [0, 0, 0], normal: [0, 1, 0], xDir: [1, 0, 0], label: 'Top (ground)' },
  front: { origin: [0, 0, 0], normal: [0, 0, 1], xDir: [1, 0, 0], label: 'Front' },
  right: { origin: [0, 0, 0], normal: [1, 0, 0], xDir: [0, 0, -1], label: 'Right' },
};

/** Build a sketch plane on a picked face. */
export function planeFromFace(point: Vec3, normal: Vec3): PlaneDef {
  const n = new THREE.Vector3(...normal).normalize();
  const ref = Math.abs(n.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
  const x = new THREE.Vector3().crossVectors(ref, n).normalize();
  if (Math.abs(n.y) > 0.9) x.set(1, 0, 0).projectOnPlane(n).normalize();
  return {
    origin: point.map((v) => Math.round(v * 1000) / 1000) as Vec3,
    normal: n.toArray() as Vec3,
    xDir: x.toArray() as Vec3,
    label: 'Face',
  };
}
