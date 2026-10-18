// Core document model for KimaticPro.
// A design is an ordered list of features (the timeline). Evaluating the
// features in order produces the bodies you see in the viewport, which is
// what makes every design fully parametric and editable after the fact.

export type Vec3 = [number, number, number];
export type Vec2 = [number, number];

export interface TRS {
  position: Vec3;
  /** Euler rotation in degrees (XYZ order). */
  rotation: Vec3;
  scale: Vec3;
}

export const identityTRS = (): TRS => ({
  position: [0, 0, 0],
  rotation: [0, 0, 0],
  scale: [1, 1, 1],
});

/** How a newly created shape interacts with existing bodies. */
export type BodyOp = 'new' | 'join' | 'cut' | 'intersect';

export interface Appearance {
  color: string;
  material: string; // id from MATERIALS
}

interface FeatureBase {
  id: string;
  name: string;
  suppressed?: boolean;
  /** Dimension expressions using user parameters, keyed by field path (e.g. `params.width`). */
  exprs?: Record<string, string>;
}

export interface PrimitiveFeature extends FeatureBase {
  type: 'primitive';
  shape: string;
  params: Record<string, number | string | boolean>;
  transform: TRS;
  op: BodyOp;
  targets: string[];
  appearance: Appearance;
}

export interface PlaneDef {
  origin: Vec3;
  normal: Vec3;
  xDir: Vec3;
  label: string;
}

interface EntityBase {
  id: string;
  /** Construction geometry guides other shapes but never becomes solid. */
  construction?: boolean;
}

export type SketchEntity = EntityBase & (
  | { kind: 'polyline'; points: Vec2[]; closed: boolean }
  | { kind: 'rect'; x: number; y: number; w: number; h: number; radius?: number }
  | { kind: 'circle'; cx: number; cy: number; r: number }
  | { kind: 'polygon'; cx: number; cy: number; r: number; sides: number; rotation: number }
  | { kind: 'spline'; points: Vec2[]; closed: boolean }
  | { kind: 'slot'; x1: number; y1: number; x2: number; y2: number; r: number }
  /** Counter-clockwise arc around (cx, cy) from (x1, y1) to (x2, y2); the radius comes from the start point. */
  | { kind: 'arc'; cx: number; cy: number; x1: number; y1: number; x2: number; y2: number });

/**
 * A reference to part of a sketch: a key point (`p`), a straight segment (`s`), or the
 * whole entity (circles and arcs). Entity `$o` is the sketch origin (point 0) and its
 * axes (segment 0 = horizontal, 1 = vertical).
 */
export interface SkRef { e: string; p?: number; s?: number }

export type ConstraintType =
  | 'coincident' | 'horizontal' | 'vertical' | 'parallel' | 'perpendicular' | 'equal' | 'tangent'
  | 'concentric' | 'midpoint' | 'onCurve' | 'symmetric' | 'fix'
  | 'distance' | 'hdistance' | 'vdistance' | 'radius' | 'diameter' | 'angle';

export interface SketchConstraint {
  id: string;
  type: ConstraintType;
  refs: SkRef[];
  /** Driving value for dimensions (mm or degrees), or the locked position for `fix`. */
  value?: number;
  at?: Vec2;
  /** Expression that drives `value`, e.g. `width / 2`. */
  expr?: string;
  /** Tangent circles: touching from the inside. */
  inner?: boolean;
  /** Where the dimension label sits, as an offset from its natural spot (sketch units). */
  offset?: Vec2;
}

export interface SketchFeature extends FeatureBase {
  type: 'sketch';
  plane: PlaneDef;
  entities: SketchEntity[];
  constraints?: SketchConstraint[];
  visible: boolean;
}

export interface ExtrudeFeature extends FeatureBase {
  type: 'extrude';
  sketchId: string;
  distance: number;
  symmetric: boolean;
  roundEdges: number;
  op: BodyOp;
  targets: string[];
  transform: TRS;
  appearance: Appearance;
}

export interface RevolveFeature extends FeatureBase {
  type: 'revolve';
  sketchId: string;
  axis: 'x' | 'y';
  angle: number;
  op: BodyOp;
  targets: string[];
  transform: TRS;
  appearance: Appearance;
}

export interface CombineFeature extends FeatureBase {
  type: 'combine';
  targetId: string;
  toolIds: string[];
  op: 'join' | 'cut' | 'intersect';
  keepTools: boolean;
}

export interface MoveFeature extends FeatureBase {
  type: 'move';
  bodyIds: string[];
  pivot: Vec3;
  transform: TRS;
  copy: boolean;
}

export interface PatternFeature extends FeatureBase {
  type: 'pattern';
  bodyIds: string[];
  kind: 'linear' | 'circular';
  count: number;
  /** Linear: spacing in mm along the direction. */
  spacing: number;
  direction: 'x' | 'y' | 'z';
  /** Circular: total sweep in degrees, around an axis through `center`. */
  angle: number;
  axis: 'x' | 'y' | 'z';
  center: Vec3;
}

export interface MirrorFeature extends FeatureBase {
  type: 'mirror';
  bodyIds: string[];
  plane: 'yz' | 'xy' | 'xz';
  offset: number;
}

export interface LoftFeature extends FeatureBase {
  type: 'loft';
  /** Sketches to blend through, in order. Each contributes its largest closed shape. */
  sketchIds: string[];
  smooth: boolean;
  op: BodyOp;
  targets: string[];
  transform: TRS;
  appearance: Appearance;
}

export interface SweepFeature extends FeatureBase {
  type: 'sweep';
  /** Sketch with the closed cross-section (centred on the path). */
  profileId: string;
  /** Sketch whose first open curve (or loop) is the path. */
  pathId: string;
  twist: number;
  op: BodyOp;
  targets: string[];
  transform: TRS;
  appearance: Appearance;
}

/**
 * Precise-kernel edits. Edges and faces are referenced by a point on them (world
 * space, captured when they were clicked); the nearest matching edge/face is used
 * on every rebuild so the reference survives most upstream edits.
 */
export interface FilletFeature extends FeatureBase {
  type: 'fillet';
  bodyId: string;
  mode: 'fillet' | 'chamfer';
  /** Points on the edges to round. Empty = every edge of the body. */
  edges: Vec3[];
  radius: number;
}

export interface ShellFeature extends FeatureBase {
  type: 'shell';
  bodyId: string;
  /** Points on faces to remove (open). Empty = closed hollow body. */
  faces: Vec3[];
  thickness: number;
}

export interface DraftFeature extends FeatureBase {
  type: 'draft';
  bodyId: string;
  /** Points on the faces to taper. */
  faces: Vec3[];
  angle: number;
}

export interface SplitFeature extends FeatureBase {
  type: 'split';
  bodyId: string;
  axis: 'x' | 'y' | 'z';
  offset: number;
}

export interface ImportFeature extends FeatureBase {
  type: 'import';
  /** Base64-encoded Float32Array of triangle positions (non-indexed). */
  data: string;
  /** Original STEP text, so the precise kernel keeps exact geometry. */
  step?: string;
  transform: TRS;
  appearance: Appearance;
}

export type Feature =
  | PrimitiveFeature
  | SketchFeature
  | ExtrudeFeature
  | RevolveFeature
  | CombineFeature
  | MoveFeature
  | PatternFeature
  | MirrorFeature
  | ImportFeature
  | LoftFeature
  | SweepFeature
  | SplitFeature
  | FilletFeature
  | ShellFeature
  | DraftFeature;

export type FeatureType = Feature['type'];

/** Features whose transform directly positions the body they create. */
export type CreatingFeature = PrimitiveFeature | ExtrudeFeature | RevolveFeature | ImportFeature | LoftFeature | SweepFeature;

export interface BodyState {
  visible?: boolean;
  name?: string;
  /** Appearance override for bodies that are not owned by a creating feature (copies, mirrors). */
  appearance?: Appearance;
  removed?: boolean;
}

export interface DesignDoc {
  format: 'kimatic';
  version: 1;
  name: string;
  units: 'mm';
  features: Feature[];
  bodyState: Record<string, BodyState>;
  /** Index into features: everything at or after this is rolled back. */
  marker: number;
  /** Named user parameters (Fusion-style), usable in any dimension. */
  params?: { name: string; expr: string; comment?: string }[];
}

export const isCreating = (f: Feature): f is CreatingFeature =>
  f.type === 'primitive' || f.type === 'extrude' || f.type === 'revolve' || f.type === 'import' || f.type === 'loft' || f.type === 'sweep';

let idCounter = 0;
export const uid = (prefix = 'f') =>
  `${prefix}${Date.now().toString(36)}${(idCounter++).toString(36)}${Math.random().toString(36).slice(2, 5)}`;
