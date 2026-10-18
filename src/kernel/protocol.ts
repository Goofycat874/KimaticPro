import type { DesignDoc } from '../core/types';
import type { ProjView, ViewName } from '../core/drawingSheet';

export interface DrawingPayload { views: Record<string, ProjView>; skipped: string[]; names: string[]; materials: string[] }

/** Display mesh for one body, produced by the precise kernel in the worker. */
export interface MeshPayload {
  /** Cache key of the solid (stable while the body's shape doesn't change). */
  key: string;
  precise: boolean;
  positions: Float32Array;
  normals: Float32Array | null;
  index: Uint32Array | null;
  /** Feature-edge segments (pairs of points) and the B-rep edge each segment belongs to. */
  edges: Float32Array | null;
  edgeIds: Int32Array | null;
  /** B-rep face id of every triangle. */
  triFace: Int32Array | null;
}

export interface BodyPayload extends MeshPayload {
  id: string;
  matrix: number[];
}

export interface GhostPayload extends MeshPayload {
  featureId: string;
  bodyId: string;
  matrix: number[];
}

export interface EvalPayload {
  bodies: BodyPayload[];
  ghosts: GhostPayload[];
  errors: Record<string, string>;
  ms: number;
}

/** Exact mass properties: mm³, mm², grams, mm, and inertia in g·mm² about the centre of mass. */
export interface MassPayload {
  volume: number;
  area: number;
  mass: number;
  center: [number, number, number];
  inertia: number[][];
  principal: [number, number, number];
  skipped: string[];
}

export type Request =
  | { type: 'init' }
  | { type: 'eval'; doc: DesignDoc }
  | { type: 'step'; doc: DesignDoc; ids: string[] | null }
  | { type: 'importStep'; text: string }
  | { type: 'props'; doc: DesignDoc; ids: string[] }
  | { type: 'drawing'; doc: DesignDoc; ids: string[] | null; views: ViewName[] };

export type Response =
  | { id: number; ok: true; data: any }
  | { id: number; ok: false; error: string };
