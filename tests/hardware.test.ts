import { describe, expect, it } from 'vitest';
import { threadedRod, metricPitch } from '../src/core/hardware';
import { buildShape } from '../src/core/primitives';
import { computeVolume } from '../src/core/geometry';

const signedVolume = (g: any) => {
  const p = g.getAttribute('position');
  let v = 0;
  for (let i = 0; i < p.count; i += 3) {
    const [ax, ay, az, bx, by, bz, cx, cy, cz] = [0, 1, 2].flatMap((k) => [p.getX(i + k), p.getY(i + k), p.getZ(i + k)]);
    v += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
  }
  return v;
};

describe('hardware', () => {
  it('threaded rod is outward facing with a volume between minor and major cylinders', () => {
    const g = threadedRod({ diameter: 8, pitch: 1.25, length: 20 });
    const v = signedVolume(g);
    expect(v).toBeGreaterThan(0);
    const minor = Math.PI * (4 - 0.6134 * 1.25) ** 2 * 20;
    const major = Math.PI * 16 * 20;
    expect(v).toBeGreaterThan(minor);
    expect(v).toBeLessThan(major);
  });
  it('builds bolts, nuts, holes and boxes', () => {
    for (const id of ['bolt', 'nut', 'screwhole', 'container']) {
      expect(computeVolume(buildShape(id, {})), id).toBeGreaterThan(10);
    }
    // nut is hollow: much less than a solid hex
    const nutVol = computeVolume(buildShape('nut', {}));
    const hexVol = (3 * Math.sqrt(3) / 2) * (13 / Math.sqrt(3)) ** 2 * 6.5;
    expect(nutVol).toBeLessThan(hexVol * 0.8);
  });
  it('knows metric coarse pitches', () => {
    expect(metricPitch(3)).toBe(0.5);
    expect(metricPitch(8)).toBe(1.25);
  });
});
