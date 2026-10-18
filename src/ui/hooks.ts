import { useEffect, useReducer, useRef, useState } from 'preact/hooks';
import { store, type AppState } from '../core/store';

function shallowEqual(a: any, b: any) {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || !a || !b) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) if (!Object.is(a[k], b[k])) return false;
  return true;
}

/** Subscribe a component to a slice of app state. Re-renders only when the slice changes. */
export function useStore<T>(selector: (s: AppState) => T): T {
  const [, force] = useReducer((x: number) => x + 1, 0);
  const sel = useRef(selector);
  sel.current = selector;
  const last = useRef<T>(selector(store.state));
  last.current = selector(store.state);
  useEffect(() => store.subscribe((s) => {
    const next = sel.current(s);
    if (!shallowEqual(next, last.current)) { last.current = next; force(0); }
  }), []);
  return last.current;
}

export function useClickOutside(ref: { current: HTMLElement | null }, onOutside: () => void, active = true) {
  useEffect(() => {
    if (!active) return;
    const h = (e: PointerEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onOutside(); };
    const t = setTimeout(() => document.addEventListener('pointerdown', h), 0);
    return () => { clearTimeout(t); document.removeEventListener('pointerdown', h); };
  }, [active]);
}

/** True on phone-sized screens (the layout switches to drawers and a bottom sheet). */
export function useIsMobile(query = '(max-width: 820px)') {
  const get = () => typeof matchMedia !== 'undefined' && matchMedia(query).matches;
  const [m, setM] = useState(get);
  useEffect(() => {
    const mq = matchMedia(query);
    const h = () => setM(mq.matches);
    mq.addEventListener('change', h);
    return () => mq.removeEventListener('change', h);
  }, []);
  return m;
}
