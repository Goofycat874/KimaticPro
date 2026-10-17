// jsdom-free shims for modules that touch browser globals at import time
const mem = new Map<string, string>();
(globalThis as any).localStorage ??= {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k),
};
(globalThis as any).requestAnimationFrame ??= (fn: () => void) => setTimeout(fn, 0);
