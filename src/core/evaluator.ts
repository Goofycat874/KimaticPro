import * as THREE from 'three';
import type { DesignDoc, Feature } from './types';
import { runFeatures, type CoreBody, type CoreGhost, type EvalSketch } from './evalCore';
import { meshKernel } from './meshKernel';

export { hash, trsMatrix, applyExpressions } from './evalCore';
export type { EvalSketch } from './evalCore';

export interface EvalBody extends Omit<CoreBody<THREE.BufferGeometry>, 'solid'> {
  /** Geometry in the body's local frame. Shared/cached — never mutate. */
  geometry: THREE.BufferGeometry;
  /** True once the exact (B-rep) kernel has produced this body. */
  precise?: boolean;
}

export interface EvalGhost extends Omit<CoreGhost<THREE.BufferGeometry>, 'solid'> {
  geometry: THREE.BufferGeometry;
}

export interface EvalResult {
  bodies: EvalBody[];
  ghosts: EvalGhost[];
  sketches: EvalSketch[];
  errors: Record<string, string>;
  /** Parent frame for each feature that has an editable transform (for gizmos). */
  frames: Record<string, THREE.Matrix4>;
  /** Bodies created by each feature. */
  outputs: Record<string, string[]>;
  /** Current values of the user parameters. */
  vars: Record<string, number>;
  paramErrors: Record<string, string>;
  /** 'preview' while only the mesh kernel has run; 'precise' once the B-rep result is in. */
  quality: 'preview' | 'precise';
}

/** Fast synchronous evaluation with the mesh kernel (previews, tests, fallback). */
export function evaluate(doc: DesignDoc): EvalResult {
  const r = runFeatures(meshKernel, doc);
  return {
    ...r,
    bodies: r.bodies.map(({ solid, ...b }) => ({ ...b, geometry: solid })),
    ghosts: r.ghosts.map(({ solid, ...g }) => ({ ...g, geometry: solid })),
    quality: 'preview',
  };
}

/** World-space bounding box of a body. */
export function bodyBounds(b: { geometry: THREE.BufferGeometry; matrix: THREE.Matrix4 }) {
  if (!b.geometry.boundingBox) b.geometry.computeBoundingBox();
  return b.geometry.boundingBox!.clone().applyMatrix4(b.matrix);
}

export function featureOf(doc: DesignDoc, id: string | null | undefined): Feature | undefined {
  return id ? doc.features.find((f) => f.id === id) : undefined;
}
