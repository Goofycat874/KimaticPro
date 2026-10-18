import { evaluate, type EvalResult } from './evaluator';
import type { ConstraintType, DesignDoc } from './types';

export type Mode = 'model' | 'pick-plane' | 'sketch' | 'measure' | 'lay-flat' | 'pick';

/** Edge/face picking for precise tools (fillet, chamfer, shell, draft). */
export interface PickState {
  op: 'fillet' | 'chamfer' | 'shell' | 'draft';
  kind: 'edges' | 'faces';
  /** Picked items: the body, a point on the edge/face (world), and the B-rep id it had when picked. */
  refs: { bodyId: string; point: [number, number, number]; sid: number }[];
  value: number;
  /** Editing an existing step instead of creating one. */
  featureId?: string;
}
export type SketchTool = 'select' | 'line' | 'rect' | 'crect' | 'circle' | 'polygon' | 'spline' | 'slot' | 'arc' | 'dimension' | 'constrain';
export type DisplayMode = 'shaded' | 'edges' | 'wire' | 'xray';
export type GizmoMode = 'translate' | 'rotate' | 'scale';

export interface Toast { id: number; text: string; kind: 'info' | 'success' | 'error' }

export interface AppState {
  doc: DesignDoc;
  result: EvalResult;
  selection: string[];
  selectedFeature: string | null;
  hovered: string | null;
  mode: Mode;
  sketchId: string | null;
  sketchTool: SketchTool;
  sketchSelection: string[];
  /** The constraint the Constrain tool is applying. */
  sketchConstraint: ConstraintType | null;
  showConstraints: boolean;
  polygonSides: number;
  gizmo: GizmoMode;
  theme: 'dark' | 'light';
  beginner: boolean;
  displayMode: DisplayMode;
  snap: number;
  showGrid: boolean;
  showGhosts: boolean;
  projection: 'perspective' | 'orthographic';
  section: { enabled: boolean; axis: 'x' | 'y' | 'z'; offset: number; flip: boolean };
  welcome: boolean;
  palette: boolean;
  dialog: null | 'shortcuts' | 'about' | 'export' | 'tour' | 'print' | 'params';
  printerId: string;
  showBed: boolean;
  showOverhangs: boolean;
  print: { infill: number; walls: number; layer: number };
  tourStep: number;
  toasts: Toast[];
  measure: { a: [number, number, number] | null; b: [number, number, number] | null };
  contextMenu: { x: number; y: number; bodyId: string | null } | null;
  pick: PickState | null;
  /** Phones: which side panel is slid in over the viewport. */
  sheet: null | 'browser' | 'inspector';
  dirty: boolean;
  canUndo: string | null;
  canRedo: string | null;
}

export const emptyDoc = (name = 'Untitled design'): DesignDoc => ({
  format: 'kimatic', version: 1, name, units: 'mm', features: [], bodyState: {}, marker: 0,
});

const PREFS_KEY = 'kimatic.prefs';
const AUTOSAVE_KEY = 'kimatic.autosave';

function loadPrefs(): Partial<AppState> {
  try {
    return JSON.parse(localStorage.getItem(PREFS_KEY) || '{}');
  } catch { return {}; }
}

type Listener = (s: AppState, prev: AppState) => void;

interface HistoryEntry { doc: string; label: string }

export class Store {
  state: AppState;
  private listeners = new Set<Listener>();
  private past: HistoryEntry[] = [];
  private future: HistoryEntry[] = [];
  private transientBase: string | null = null;
  private evalScheduled = false;
  private toastId = 0;
  private saveTimer: any = null;

  constructor() {
    const prefs = loadPrefs();
    const doc = emptyDoc();
    this.state = {
      doc,
      result: evaluate(doc),
      selection: [],
      selectedFeature: null,
      hovered: null,
      mode: 'model',
      sketchId: null,
      sketchTool: 'line',
      sketchSelection: [],
      sketchConstraint: null,
      showConstraints: true,
      polygonSides: 6,
      gizmo: 'translate',
      theme: (prefs.theme as any) ?? 'dark',
      beginner: prefs.beginner ?? true,
      displayMode: (prefs.displayMode as any) ?? 'edges',
      snap: prefs.snap ?? 1,
      showGrid: prefs.showGrid ?? true,
      showGhosts: false,
      projection: 'perspective',
      section: { enabled: false, axis: 'x', offset: 0, flip: false },
      welcome: true,
      palette: false,
      dialog: null,
      printerId: (prefs as any).printerId ?? 'bambu-x1',
      showBed: (prefs as any).showBed ?? false,
      showOverhangs: false,
      print: (prefs as any).print ?? { infill: 0.15, walls: 1.2, layer: 0.2 },
      tourStep: 0,
      toasts: [],
      measure: { a: null, b: null },
      contextMenu: null,
      pick: null,
      sheet: null,
      dirty: false,
      canUndo: null,
      canRedo: null,
    };
  }

  get doc() { return this.state.doc; }

  /** True while a drag is in progress (changes are live but not yet an undo step). */
  get inTransient() { return this.transientBase !== null; }

  /** Lets the precise kernel carry its results over to new previews where nothing changed. */
  postProcess: ((r: EvalResult) => EvalResult) | null = null;

  private evalDoc(doc: DesignDoc) {
    const r = evaluate(doc);
    return this.postProcess ? this.postProcess(r) : r;
  }

  subscribe(fn: Listener) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  set(patch: Partial<AppState>) {
    const prev = this.state;
    this.state = { ...prev, ...patch };
    const PREF_KEYS = ['theme', 'beginner', 'displayMode', 'snap', 'showGrid', 'printerId', 'showBed', 'print'] as const;
    if (PREF_KEYS.some((k) => k in patch)) {
      const prefs = Object.fromEntries(PREF_KEYS.map((k) => [k, this.state[k]]));
      try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch { /* ignore */ }
    }
    for (const l of this.listeners) l(this.state, prev);
  }

  /** Replace the document, recording an undo step labelled `label`. */
  commit(label: string, recipe: (doc: DesignDoc) => void, extra: Partial<AppState> = {}) {
    const before = this.transientBase ?? JSON.stringify(this.state.doc);
    this.transientBase = null;
    const doc: DesignDoc = JSON.parse(JSON.stringify(this.state.doc));
    recipe(doc);
    this.past.push({ doc: before, label });
    if (this.past.length > 200) this.past.shift();
    this.future = [];
    this.applyDoc(doc, extra);
  }

  /** Live edits while dragging: re-evaluates every frame but records undo once on `endTransient`. */
  transient(recipe: (doc: DesignDoc) => void) {
    if (this.transientBase === null) this.transientBase = JSON.stringify(this.state.doc);
    const doc: DesignDoc = JSON.parse(JSON.stringify(this.state.doc));
    recipe(doc);
    this.state = { ...this.state, doc };
    this.scheduleEval();
  }

  endTransient(label: string) {
    if (this.transientBase === null) return;
    const before = this.transientBase;
    this.transientBase = null;
    if (before === JSON.stringify(this.state.doc)) return;
    this.past.push({ doc: before, label });
    this.future = [];
    this.applyDoc(this.state.doc);
  }

  private scheduleEval() {
    if (this.evalScheduled) return;
    this.evalScheduled = true;
    requestAnimationFrame(() => {
      this.evalScheduled = false;
      this.set({ result: this.evalDoc(this.state.doc) });
    });
  }

  private applyDoc(doc: DesignDoc, extra: Partial<AppState> = {}) {
    const result = this.evalDoc(doc);
    const ids = new Set(result.bodies.map((b) => b.id));
    const selection = (extra.selection ?? this.state.selection).filter((id) => ids.has(id));
    const fids = new Set(doc.features.map((f) => f.id));
    const selectedFeature = extra.selectedFeature !== undefined ? extra.selectedFeature : this.state.selectedFeature;
    this.set({
      ...extra,
      doc,
      result,
      selection,
      selectedFeature: selectedFeature && fids.has(selectedFeature) ? selectedFeature : null,
      dirty: true,
      canUndo: this.past.at(-1)?.label ?? null,
      canRedo: this.future.at(-1)?.label ?? null,
    });
    this.autosave();
  }

  undo() {
    const entry = this.past.pop();
    if (!entry) return;
    this.future.push({ doc: JSON.stringify(this.state.doc), label: entry.label });
    this.applyDoc(JSON.parse(entry.doc));
    this.toast(`Undid: ${entry.label}`);
  }

  redo() {
    const entry = this.future.pop();
    if (!entry) return;
    this.past.push({ doc: JSON.stringify(this.state.doc), label: entry.label });
    this.applyDoc(JSON.parse(entry.doc));
    this.toast(`Redid: ${entry.label}`);
  }

  /** Load a whole new document, clearing history. */
  load(doc: DesignDoc) {
    this.past = [];
    this.future = [];
    this.transientBase = null;
    this.applyDoc(doc, { selection: [], selectedFeature: null, mode: 'model', sketchId: null, welcome: false });
    this.set({ dirty: false });
  }

  toast(text: string, kind: Toast['kind'] = 'info') {
    const t = { id: ++this.toastId, text, kind };
    this.set({ toasts: [...this.state.toasts.slice(-3), t] });
    setTimeout(() => this.set({ toasts: this.state.toasts.filter((x) => x.id !== t.id) }), 2600);
  }

  private autosave() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      try { localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(this.state.doc)); } catch { /* quota */ }
    }, 600);
  }

  static loadAutosave(): DesignDoc | null {
    try {
      const raw = localStorage.getItem(AUTOSAVE_KEY);
      if (!raw) return null;
      const doc = JSON.parse(raw);
      return doc?.format === 'kimatic' && doc.features?.length ? doc : null;
    } catch { return null; }
  }
}

export const store = new Store();
