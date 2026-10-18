import { store } from '../core/store';
import { applyPick, cancelPick, nudge, select } from '../core/actions';
import { COMMANDS, runCmd } from './commands';

/** Keys that only apply in sketch mode override model-mode shortcuts with the same letter. */
const SKETCH_KEYS: Record<string, string> = {
  v: 'sketch.select', l: 'sketch.line', r: 'sketch.rect', c: 'sketch.circle', p: 'sketch.polygon',
};

function combo(e: KeyboardEvent) {
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey && e.key.length > 1) parts.push('Shift');
  let k = e.key;
  if (k === ' ') k = 'Space';
  if (k.length === 1) k = k.toUpperCase();
  if (k === 'Del') k = 'Delete';
  parts.push(k);
  return parts.join('+');
}

export function installKeyboard(viewportKey: (e: KeyboardEvent) => boolean) {
  window.addEventListener('keydown', (e) => {
    const t = e.target as HTMLElement;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
    const s = store.state;
    if (s.palette || s.welcome || (s.dialog && s.dialog !== 'tour')) {
      if (e.key === 'Escape') store.set({ palette: false, dialog: null, welcome: s.doc.features.length ? false : s.welcome });
      return;
    }
    if (viewportKey(e)) { e.preventDefault(); return; }

    const key = combo(e);
    if (key === 'Ctrl+Shift+Z' || key === 'Ctrl+Z' && e.shiftKey) { e.preventDefault(); store.redo(); return; }

    if (e.key === 'Escape') {
      if (s.contextMenu) store.set({ contextMenu: null });
      else if (s.mode === 'sketch') runCmd('sketch.finish');
      else if (s.mode === 'pick') cancelPick();
      else if (s.mode !== 'model') store.set({ mode: 'model' });
      else select([]);
      return;
    }

    if (s.mode === 'pick' && e.key === 'Enter') { applyPick(); return; }
    if (s.mode === 'sketch') {
      const id = SKETCH_KEYS[e.key.toLowerCase()];
      if (id && !e.ctrlKey && !e.metaKey) { runCmd(id); e.preventDefault(); return; }
      if (e.key === 'Enter') { runCmd('sketch.finish'); return; }
    } else if (s.selection.length && e.key.startsWith('Arrow') && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      const m = e.shiftKey ? 10 : 1;
      if (e.altKey) {
        if (e.key === 'ArrowUp') nudge(0, m, 0);
        if (e.key === 'ArrowDown') nudge(0, -m, 0);
        return;
      }
      if (e.key === 'ArrowLeft') nudge(-m, 0, 0);
      if (e.key === 'ArrowRight') nudge(m, 0, 0);
      if (e.key === 'ArrowUp') nudge(0, 0, -m);
      if (e.key === 'ArrowDown') nudge(0, 0, m);
      return;
    } else if (s.selection.length && (e.key === 'PageUp' || e.key === 'PageDown')) {
      e.preventDefault();
      nudge(0, e.key === 'PageUp' ? 1 : -1, 0);
      return;
    }

    if (key === '?' || key === 'Shift+?') { store.set({ dialog: 'shortcuts' }); return; }
    const c = COMMANDS.find((x) => x.key === key && (s.mode === 'sketch' ? true : x.group !== 'Sketch'));
    if (c) {
      e.preventDefault();
      if (!c.enabled || c.enabled()) c.run();
      return;
    }
    if (key === 'Backspace') { e.preventDefault(); runCmd('edit.delete'); }
    if (key === 'Ctrl+Shift+P' || key === 'Ctrl+Shift+K' || key === 'Ctrl+Space') { e.preventDefault(); store.set({ palette: true }); }
  });
}
