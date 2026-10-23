import * as THREE from 'three';
import { store } from '../core/store';
import type { EvalBody, EvalResult } from '../core/evaluator';
import { matKey } from '../core/evalCore';
import type { DesignDoc } from '../core/types';
import type { DrawingPayload, EvalPayload, MassPayload, MeshPayload, Request, Response } from './protocol';
import type { ViewName } from '../core/drawingSheet';

export type KernelStatus = 'off' | 'loading' | 'ready' | 'busy' | 'error';

type Listener = (s: KernelStatus, info: { ms?: number; error?: string }) => void;

/**
 * Talks to the OpenCascade worker. The app keeps working on the instant mesh
 * preview; precise results replace it as they arrive (newest request wins).
 */
class KernelClient {
  status: KernelStatus = 'off';
  lastMs = 0;
  lastError = '';
  private worker: Worker | null = null;
  private seq = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private listeners = new Set<Listener>();
  private booting: Promise<void> | null = null;
  /** Failures since the engine last did real work, and when automatic retries may try again. */
  private failures = 0;
  private retryAt = 0;

  onStatus(fn: Listener) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  private setStatus(s: KernelStatus, info: { ms?: number; error?: string } = {}) {
    this.status = s;
    if (info.ms !== undefined) this.lastMs = info.ms;
    if (info.error !== undefined) this.lastError = info.error;
    for (const l of this.listeners) l(s, info);
  }

  /**
   * Start the worker if it isn't running. After a failure the next call starts a fresh one;
   * automatic callers (`force` off) wait a little longer after each repeated failure so a
   * browser that can't run the engine isn't asked to reload it on every edit.
   */
  start(force = false) {
    if (this.booting) return this.booting;
    if (!force && Date.now() < this.retryAt) return Promise.resolve();
    if (typeof Worker === 'undefined') { this.setStatus('error', { error: 'Web Workers are not available here.' }); return Promise.resolve(); }
    this.setStatus('loading');
    let worker: Worker;
    try {
      worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    } catch (e: any) {
      this.noteFailure();
      this.setStatus('error', { error: e?.message ?? 'Could not start the geometry engine.' });
      return Promise.resolve();
    }
    this.worker = worker;
    worker.onmessage = (e: MessageEvent<Response>) => {
      const p = this.pending.get(e.data.id);
      if (!p) return;
      this.pending.delete(e.data.id);
      if (e.data.ok) p.resolve(e.data.data);
      else p.reject(new Error(e.data.error));
    };
    worker.onerror = (e) => {
      e.preventDefault?.();
      this.fail(worker, e.message || 'The geometry engine stopped unexpectedly.');
    };
    this.booting = this.call({ type: 'init' })
      .then(() => { if (this.worker === worker) this.setStatus('ready'); })
      .catch((e) => this.fail(worker, e.message));
    return this.booting;
  }

  private noteFailure() {
    this.failures++;
    // the first retry is immediate; after that wait 2 s, 4 s, 8 s … up to 30 s
    this.retryAt = this.failures > 1 ? Date.now() + Math.min(30_000, 1000 * 2 ** (this.failures - 1)) : 0;
  }

  /** Throw away a broken worker so the next call can start a fresh one. */
  private fail(worker: Worker, error: string) {
    if (this.worker !== worker) return; // already replaced
    worker.onmessage = null;
    worker.onerror = null;
    worker.terminate();
    this.worker = null;
    this.booting = null;
    this.noteFailure();
    this.setStatus('error', { error });
    const waiting = [...this.pending.values()];
    this.pending.clear();
    for (const p of waiting) p.reject(new Error('The geometry engine stopped. It restarts on your next change.'));
  }

  private call<T>(req: Request): Promise<T> {
    if (!this.worker) return Promise.reject(new Error('The precise geometry engine is not running.'));
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker!.postMessage({ id, req });
    });
  }

  get available() { return this.status === 'ready' || this.status === 'busy'; }

  async evaluate(doc: DesignDoc): Promise<EvalPayload | null> {
    await this.start();
    if (!this.available) return null;
    this.setStatus('busy');
    try {
      const r = await this.call<EvalPayload>({ type: 'eval', doc });
      this.failures = 0;
      this.retryAt = 0;
      this.setStatus('ready', { ms: r.ms });
      return r;
    } catch (e: any) {
      // a modelling error leaves the engine fine; a crash has already set the status to error
      if (this.worker) this.setStatus('ready', { error: e.message });
      throw e;
    }
  }

  async exportStep(doc: DesignDoc, ids: string[] | null) {
    await this.start(true);
    if (!this.available) throw new Error('STEP export needs the precise geometry engine, which could not load in this browser.');
    return this.call<{ blob: Blob | null; skipped: string[] }>({ type: 'step', doc, ids });
  }

  async importStep(text: string) {
    await this.start(true);
    if (!this.available) throw new Error('STEP import needs the precise geometry engine, which could not load in this browser.');
    return this.call<{ mesh: string; step: string; faces: number }>({ type: 'importStep', text });
  }

  async drawing(doc: DesignDoc, ids: string[] | null, views: ViewName[]) {
    await this.start(true);
    if (!this.available) throw new Error('Drawings need the precise geometry engine, which could not load in this browser.');
    return this.call<DrawingPayload>({ type: 'drawing', doc, ids, views });
  }

  /** Exact mass properties, or null while the precise engine isn't running. */
  async props(doc: DesignDoc, ids: string[]): Promise<MassPayload | null> {
    if (!this.available) return null;
    return this.call<MassPayload>({ type: 'props', doc, ids });
  }
}

export const kernel = new KernelClient();

// ---------------------------------------------------------------------------
// merging precise results into the app state

const geoCache = new Map<string, THREE.BufferGeometry>();

/** One BufferGeometry per precise solid, reused while the solid is unchanged (keeps edge caches warm). */
function geometryOf(m: MeshPayload): THREE.BufferGeometry {
  const hit = geoCache.get(m.key);
  if (hit) return hit;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(m.positions, 3));
  if (m.normals) g.setAttribute('normal', new THREE.BufferAttribute(m.normals, 3));
  else g.computeVertexNormals();
  if (m.index) g.setIndex(new THREE.BufferAttribute(m.index, 1));
  g.computeBoundingBox();
  g.computeBoundingSphere();
  if (m.edges) {
    const e = new THREE.BufferGeometry();
    e.setAttribute('position', new THREE.BufferAttribute(m.edges, 3));
    g.userData.edges = e;
    g.userData.edgeIds = m.edgeIds;
  }
  g.userData.triFace = m.triFace;
  g.userData.precise = m.precise;
  geoCache.set(m.key, g);
  if (geoCache.size > 400) {
    const [k, old] = geoCache.entries().next().value!;
    geoCache.delete(k);
    old.dispose();
  }
  return g;
}

// what each body looked like in the preview when its precise version was computed
const carried = new Map<string, { sig: string; body: EvalBody }>();
const sig = (b: { key: string; matrix: THREE.Matrix4 }) => `${b.key}@${matKey(b.matrix)}`;

/** Reuse precise bodies whose preview hasn't changed since they were computed (no flicker on edits). */
export function carryOver(preview: EvalResult): EvalResult {
  if (!carried.size) return preview;
  let any = false;
  const bodies = preview.bodies.map((b) => {
    const c = carried.get(b.id);
    if (!c || c.sig !== sig(b)) return b;
    any = true;
    return { ...b, geometry: c.body.geometry, matrix: c.body.matrix, precise: c.body.precise };
  });
  return any ? { ...preview, bodies } : preview;
}

export function mergePrecise(preview: EvalResult, p: EvalPayload): EvalResult {
  const byId = new Map(p.bodies.map((b) => [b.id, b]));
  const ghostKey = (g: { featureId: string; bodyId: string }) => `${g.featureId}|${g.bodyId}`;
  const ghosts = new Map(p.ghosts.map((g) => [ghostKey(g), g]));
  carried.clear();
  return {
    ...preview,
    bodies: preview.bodies.map((b) => {
      const pb = byId.get(b.id);
      if (!pb) return b;
      const out = { ...b, geometry: geometryOf(pb), matrix: new THREE.Matrix4().fromArray(pb.matrix), precise: pb.precise };
      carried.set(b.id, { sig: (b as any).previewSig ?? sig(b), body: out });
      return out;
    }),
    ghosts: preview.ghosts.map((g) => {
      const pg = ghosts.get(ghostKey(g));
      return pg ? { ...g, geometry: geometryOf(pg), matrix: new THREE.Matrix4().fromArray(pg.matrix) } : g;
    }),
    errors: { ...preview.errors, ...p.errors },
    quality: 'precise',
  };
}

/**
 * Keep the precise result in step with the document: after each committed change
 * (not during drags), evaluate in the worker and swap the result in if the
 * document hasn't moved on meanwhile.
 */
export function startPreciseSync() {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let requested: DesignDoc | null = null;
  const kick = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(async () => {
      const doc = store.state.doc;
      if (store.inTransient || requested === doc) return;
      requested = doc;
      try {
        const payload = await kernel.evaluate(doc);
        if (!payload || store.state.doc !== doc || store.inTransient) return;
        store.set({ result: mergePrecise(store.state.result, payload) });
      } catch {
        // keep showing the preview; the status chip reports the problem
      }
    }, 120);
  };
  store.postProcess = (r) => {
    // remember each body's preview signature before carry-over replaces its geometry
    for (const b of r.bodies) (b as any).previewSig = sig(b);
    return carryOver(r);
  };
  store.subscribe((s, prev) => {
    if (s.result !== prev.result && s.result.quality === 'preview') kick();
  });
  // when the engine comes back after a failure, bring the open design up to date
  let wasDown = false;
  kernel.onStatus((s) => {
    if (s === 'error') wasDown = true;
    else if (s === 'ready' && wasDown) { wasDown = false; requested = null; kick(); }
  });
  kernel.start().then(kick);
}
