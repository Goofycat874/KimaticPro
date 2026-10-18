import type * as THREE from 'three';
import type {
  DraftFeature, ExtrudeFeature, FilletFeature, RevolveFeature, ShellFeature, SketchEntity,
} from './types';

/** A solid with a cache key, placed in the world by `matrix`. */
export interface Placed<S> {
  solid: S;
  key: string;
  matrix: THREE.Matrix4;
}

/**
 * The geometry engine behind the feature timeline. The timeline logic (which body
 * is which, what's editable, ghosts, patterns…) is shared; only the maths differs:
 * a fast triangle-mesh kernel for instant previews and an exact B-rep kernel
 * (OpenCascade) for the final, manufacturable result.
 */
export interface Kernel<S> {
  readonly precise: boolean;
  /** Called at the start/end of every evaluation for cache housekeeping. */
  begin(): void;
  end(live: S[]): void;

  /** Shapes are built resting on y = 0 in their own frame. */
  primitive(shape: string, params: Record<string, any>, key: string): S;
  importMesh(data: string, step: string | undefined, key: string): S;
  /** Sketch features build in the sketch-plane frame (u, v, normal). */
  extrude(f: ExtrudeFeature, entities: SketchEntity[], key: string): S;
  revolve(f: RevolveFeature, entities: SketchEntity[], key: string): S;
  /** Lofts and sweeps build in world space. */
  loft(sections: { entities: SketchEntity[]; matrix: THREE.Matrix4 }[], smooth: boolean, key: string): S;
  sweep(profile: SketchEntity[], path: { entities: SketchEntity[]; matrix: THREE.Matrix4 }, twist: number, key: string): S;

  boolean(a: Placed<S>, b: Placed<S>, op: 'join' | 'cut' | 'intersect'): Placed<S>;
  /** Reflected copy; the result is in world space. */
  mirror(b: Placed<S>, refl: THREE.Matrix4, key: string): Placed<S>;
  /** Keep the part below (`low`) or above the plane `axis = offset`. */
  split(b: Placed<S>, axis: 'x' | 'y' | 'z', offset: number): [Placed<S>, Placed<S>];
  /** Fillet / chamfer / shell / draft. A kernel that can't do it returns the body unchanged. */
  modify(b: Placed<S>, f: FilletFeature | ShellFeature | DraftFeature): Placed<S>;

  bounds(b: Placed<S>): THREE.Box3;
}
