// Hole presets and the cross-section a hole cutter is spun from.

import type { HoleFeature, HoleKind, Vec2 } from './types';

export interface HolePreset {
  id: string;
  label: string;
  group: string;
  kind: HoleKind;
  diameter: number;
  depth: number;
  cbDiameter?: number;
  cbDepth?: number;
  csDiameter?: number;
}

const SIZES = ['M2', 'M2.5', 'M3', 'M4', 'M5', 'M6', 'M8', 'M10', 'M12'] as const;
// ISO 273 normal clearance, tap drills, ISO 4762 socket-head counterbores, ISO 10642 90° countersinks
const CLEAR: Record<string, number> = { M2: 2.4, 'M2.5': 2.9, M3: 3.4, M4: 4.5, M5: 5.5, M6: 6.6, M8: 9, M10: 11, M12: 13.5 };
const TAP: Record<string, number> = { M2: 1.6, 'M2.5': 2.05, M3: 2.5, M4: 3.3, M5: 4.2, M6: 5, M8: 6.8, M10: 8.5, M12: 10.2 };
const CBORE: Record<string, [number, number]> = { M2: [4.4, 2.3], 'M2.5': [5.5, 2.8], M3: [6.5, 3.4], M4: [8, 4.4], M5: [10, 5.4], M6: [11, 6.4], M8: [15, 8.6], M10: [18, 10.8], M12: [20, 13] };
const CSINK: Record<string, number> = { M2: 4.4, 'M2.5': 5.5, M3: 6.7, M4: 9, M5: 11.2, M6: 13.4, M8: 17.9, M10: 22.4, M12: 26.9 };
// common brass heat-set inserts for 3D prints: [hole diameter, depth]
const INSERT: Record<string, [number, number]> = { M2: [3.2, 4], 'M2.5': [3.6, 5], M3: [4.2, 5.7], M4: [5.6, 8.1], M5: [6.4, 9.5] };

export const HOLE_PRESETS: HolePreset[] = [
  ...SIZES.map((s): HolePreset => ({ id: `${s}-clear`, label: `${s} clearance`, group: 'Clearance (bolt passes through)', kind: 'simple', diameter: CLEAR[s], depth: 0 })),
  ...SIZES.map((s): HolePreset => ({ id: `${s}-tap`, label: `${s} tapped (tap drill Ø${TAP[s]})`, group: 'Tapped (cut a thread into it)', kind: 'simple', diameter: TAP[s], depth: 0 })),
  ...SIZES.map((s): HolePreset => ({ id: `${s}-cbore`, label: `${s} socket head counterbore`, group: 'Counterbore (cap screws sit flush)', kind: 'counterbore', diameter: CLEAR[s], depth: 0, cbDiameter: CBORE[s][0], cbDepth: CBORE[s][1] })),
  ...SIZES.map((s): HolePreset => ({ id: `${s}-csink`, label: `${s} countersunk`, group: 'Countersink (flat-head screws)', kind: 'countersink', diameter: CLEAR[s], depth: 0, csDiameter: CSINK[s] })),
  ...Object.keys(INSERT).map((s): HolePreset => ({ id: `${s}-insert`, label: `${s} heat-set insert`, group: '3D printing', kind: 'simple', diameter: INSERT[s][0], depth: INSERT[s][1] })),
];

export const presetById = (id: string) => HOLE_PRESETS.find((p) => p.id === id);

/** Apply a preset's sizes to a hole. */
export function withPreset(h: HoleFeature, p: HolePreset): HoleFeature {
  return {
    ...h, kind: p.kind, diameter: p.diameter, depth: p.depth, label: p.label,
    cbDiameter: p.cbDiameter ?? h.cbDiameter, cbDepth: p.cbDepth ?? h.cbDepth, csDiameter: p.csDiameter ?? h.csDiameter, csAngle: 90,
  };
}

/**
 * Half cross-section of the cutter, as (radius, height) with height measured along the
 * outward normal: it starts just above the face and goes down to `-depth`.
 */
export function holeProfile(h: HoleFeature, throughDepth: number): Vec2[] {
  const r = Math.max(0.05, h.diameter / 2);
  const depth = h.depth > 0 ? h.depth : throughDepth;
  const top = 0.5;
  const pts: Vec2[] = [[0, top]];
  if (h.kind === 'counterbore') {
    const cr = Math.max(r + 0.05, h.cbDiameter / 2);
    const cd = Math.min(Math.max(0.05, h.cbDepth), depth - 0.05);
    pts.push([cr, top], [cr, -cd], [r, -cd]);
  } else if (h.kind === 'countersink') {
    const sr = Math.max(r + 0.05, h.csDiameter / 2);
    const t = Math.tan(((Math.min(170, Math.max(30, h.csAngle)) / 2) * Math.PI) / 180);
    const sd = (sr - r) / t;
    pts.push([sr + top * t, top], [sr, 0], [r, -Math.min(sd, depth - 0.05)]);
  } else {
    pts.push([r, top]);
  }
  pts.push([r, -depth]);
  // a drill leaves a 118° cone at the bottom of a blind hole
  if (h.depth > 0 && h.drillPoint) pts.push([0, -depth - r * Math.tan((31 * Math.PI) / 180)]);
  else pts.push([0, -depth]);
  return pts;
}

export function defaultHole(id: string, bodyId: string, at: [number, number, number], normal: [number, number, number]): HoleFeature {
  const base: HoleFeature = {
    id, type: 'hole', name: 'Hole', bodyId, at, normal, kind: 'simple', diameter: 3.4, depth: 0,
    cbDiameter: 6.5, cbDepth: 3.4, csDiameter: 6.7, csAngle: 90, drillPoint: true,
  };
  return withPreset(base, presetById('M3-clear')!);
}
