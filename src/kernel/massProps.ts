import * as R from 'replicad';
import * as THREE from 'three';
import { transformedShape, type BSolid } from './brep';
import { materialById } from '../core/materials';
import type { MassPayload } from './protocol';

type M3 = number[][];

/** Exact mass properties of bodies (world space), each with its own material density. */
export function massProperties(bodies: { name: string; solid: BSolid; matrix: THREE.Matrix4; material: string }[]): MassPayload {
  const oc = R.getOC();
  const parts: { m: number; c: number[]; I: M3 }[] = [];
  let volume = 0, area = 0;
  const skipped: string[] = [];
  for (const b of bodies) {
    if (b.solid.kind !== 'brep') { skipped.push(b.name); continue; }
    const s = transformedShape(b.solid.shape, b.matrix);
    const g = new oc.GProp_GProps();
    oc.BRepGProp.VolumeProperties(s.wrapped, g, false, false, false);
    const v = g.Mass();
    const cp = g.CentreOfMass();
    const c = [cp.X(), cp.Y(), cp.Z()];
    // moments about axes through the centre of mass give the whole tensor: I_uu = uᵀ I u
    const about = (d: [number, number, number]) => {
      const ax = R.makeAx1(c as [number, number, number], d);
      const val = g.MomentOfInertia(ax);
      ax.delete();
      return val;
    };
    const s2 = Math.SQRT1_2;
    const xx = about([1, 0, 0]), yy = about([0, 1, 0]), zz = about([0, 0, 1]);
    const xy = about([s2, s2, 0]) - (xx + yy) / 2, yz = about([0, s2, s2]) - (yy + zz) / 2, xz = about([s2, 0, s2]) - (xx + zz) / 2;
    // OCCT gives unit-density values in mm⁵; scale by density in g/mm³
    const rho = materialById(b.material).density / 1000;
    const I: M3 = [[xx, xy, xz], [xy, yy, yz], [xz, yz, zz]].map((r) => r.map((x) => x * rho));
    parts.push({ m: v * rho, c, I });
    volume += v;
    area += R.measureArea(s);
    cp.delete(); g.delete(); s.delete();
  }
  const mass = parts.reduce((t, p) => t + p.m, 0);
  const center = [0, 1, 2].map((k) => (mass ? parts.reduce((t, p) => t + p.m * p.c[k], 0) / mass : 0)) as [number, number, number];
  // move each part's inertia to the common centre (parallel axis theorem)
  const I: M3 = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (const p of parts) {
    const d = [p.c[0] - center[0], p.c[1] - center[1], p.c[2] - center[2]];
    const dd = d[0] * d[0] + d[1] * d[1] + d[2] * d[2];
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) I[i][j] += p.I[i][j] + p.m * ((i === j ? dd : 0) - d[i] * d[j]);
  }
  return { volume, area, mass, center, inertia: I, principal: eigenSym(I), skipped };
}

/** Eigenvalues of a symmetric 3×3 matrix (Jacobi rotations), ascending. */
export function eigenSym(A: M3): [number, number, number] {
  const a = A.map((r) => [...r]);
  for (let sweep = 0; sweep < 50; sweep++) {
    let off = 0;
    for (let i = 0; i < 3; i++) for (let j = i + 1; j < 3; j++) off += a[i][j] * a[i][j];
    if (off < 1e-20 * (a[0][0] ** 2 + a[1][1] ** 2 + a[2][2] ** 2 + 1e-30)) break;
    for (let p = 0; p < 3; p++) for (let q = p + 1; q < 3; q++) {
      if (Math.abs(a[p][q]) < 1e-300) continue;
      const th = (a[q][q] - a[p][p]) / (2 * a[p][q]);
      const t = Math.sign(th || 1) / (Math.abs(th) + Math.sqrt(th * th + 1));
      const c = 1 / Math.sqrt(t * t + 1), s = t * c;
      for (let k = 0; k < 3; k++) { const kp = a[k][p], kq = a[k][q]; a[k][p] = c * kp - s * kq; a[k][q] = s * kp + c * kq; }
      for (let k = 0; k < 3; k++) { const pk = a[p][k], qk = a[q][k]; a[p][k] = c * pk - s * qk; a[q][k] = s * pk + c * qk; }
    }
  }
  return [a[0][0], a[1][1], a[2][2]].sort((x, y) => x - y) as [number, number, number];
}
