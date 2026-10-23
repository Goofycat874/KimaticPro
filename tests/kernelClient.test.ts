import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** Stands in for the OpenCascade worker: answers requests, and can crash or refuse to start. */
class FakeWorker {
  static all: FakeWorker[] = [];
  static failInit = false;
  onmessage: ((e: any) => void) | null = null;
  onerror: ((e: any) => void) | null = null;
  terminated = false;
  hang = false;
  constructor() { FakeWorker.all.push(this); }
  postMessage({ id, req }: { id: number; req: any }) {
    queueMicrotask(() => {
      if (this.terminated || (this.hang && req.type !== 'init')) return;
      if (req.type === 'init' && FakeWorker.failInit) { this.onmessage?.({ data: { id, ok: false, error: 'wasm failed to load' } }); return; }
      const data = req.type === 'eval' ? { bodies: [], ghosts: [], errors: {}, ms: 1 } : req.type === 'step' ? { blob: null, skipped: [] } : true;
      this.onmessage?.({ data: { id, ok: true, data } });
    });
  }
  crash(message = 'worker died') { this.onerror?.({ message, preventDefault() {} }); }
  terminate() { this.terminated = true; }
}

const doc: any = { format: 'kimatic', version: 1, name: 't', units: 'mm', features: [], bodyState: {}, marker: 0 };

async function freshKernel() {
  vi.resetModules();
  return (await import('../src/kernel/client')).kernel;
}

describe('geometry engine recovery', () => {
  beforeEach(() => {
    FakeWorker.all = [];
    FakeWorker.failInit = false;
    vi.stubGlobal('Worker', FakeWorker);
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

  it('starts a fresh worker on the next call after the worker crashes', async () => {
    const kernel = await freshKernel();
    await kernel.start();
    expect(kernel.status).toBe('ready');
    FakeWorker.all[0].crash();
    expect(kernel.status).toBe('error');
    const r = await kernel.evaluate(doc);
    expect(r).not.toBeNull();
    expect(FakeWorker.all.length).toBe(2);
    expect(FakeWorker.all[0].terminated).toBe(true);
    expect(kernel.status).toBe('ready');
  });

  it('a crash in the middle of an evaluation reports an error, not ready', async () => {
    const kernel = await freshKernel();
    await kernel.start();
    FakeWorker.all[0].hang = true;
    const p = kernel.evaluate(doc);
    await Promise.resolve();
    FakeWorker.all[0].crash();
    await expect(p).rejects.toThrow();
    expect(kernel.status).toBe('error');
    // and it comes back on the next change
    expect(await kernel.evaluate(doc)).not.toBeNull();
  });

  it('retries after a failed start-up instead of staying broken', async () => {
    const kernel = await freshKernel();
    FakeWorker.failInit = true;
    await kernel.start();
    expect(kernel.status).toBe('error');
    FakeWorker.failInit = false;
    await expect(kernel.exportStep(doc, null)).resolves.toEqual({ blob: null, skipped: [] });
    expect(kernel.status).toBe('ready');
  });

  it('backs off after repeated failures, then retries once the wait is over', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const kernel = await freshKernel();
    FakeWorker.failInit = true;
    await kernel.start();
    await kernel.start(); // second failure in a row: automatic retries now wait 2 s
    const workers = FakeWorker.all.length;
    FakeWorker.failInit = false;
    expect(await kernel.evaluate(doc)).toBeNull();
    expect(FakeWorker.all.length).toBe(workers);
    vi.setSystemTime(Date.now() + 3000);
    expect(await kernel.evaluate(doc)).not.toBeNull();
    expect(FakeWorker.all.length).toBe(workers + 1);
  });

  it('a button press (STEP, drawings) retries straight away even while backing off', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const kernel = await freshKernel();
    FakeWorker.failInit = true;
    await kernel.start();
    await kernel.start();
    FakeWorker.failInit = false;
    await expect(kernel.exportStep(doc, null)).resolves.toEqual({ blob: null, skipped: [] });
  });
});
