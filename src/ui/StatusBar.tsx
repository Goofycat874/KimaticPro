import { Lightbulb, Magnet, MousePointer2 } from 'lucide-preact';
import { store } from '../core/store';
import { useEffect, useState } from 'preact/hooks';
import { useStore } from './hooks';
import { kernel } from '../kernel/client';

function hintFor(s: ReturnType<typeof pick>): string {
  if (s.mode === 'pick-plane') return 'Click a coloured plane or any flat face of a body to start sketching on it. Esc to cancel.';
  if (s.mode === 'pick') return 'Click edges or faces to pick them (click again to unpick) · set the size in the banner · Enter to apply · Esc to cancel';
  if (s.mode === 'lay-flat') return 'Click a face — the body turns so that face rests on the bed. Esc when done.';
  if (s.mode === 'measure') return 'Click two points to measure. Corners snap. Esc to stop measuring.';
  if (s.mode === 'sketch') {
    const map: Record<string, string> = {
      select: 'Click shapes to select, drag to move. Delete removes them.',
      line: 'Click to add points · click the start point to close · double-click / Enter to finish · type a length for exact size',
      rect: 'Click two opposite corners · type width,height then Enter',
      crect: 'Click the centre then a corner · type width,height then Enter',
      circle: 'Click the centre then the edge · type a diameter then Enter',
      polygon: 'Click the centre then a corner',
      slot: 'Click two centres, then the width',
      spline: 'Click to add curve points · click the start to close · Enter to finish',
    };
    return `${map[s.tool]} · Right-drag to orbit`;
  }
  if (s.sel > 1) return 'Shift+click to add/remove · Join, Cut or Align them from the ribbon · Ctrl+D duplicates';
  if (s.sel === 1) return 'Drag the arrows to move · R rotate · arrow keys nudge · H turns it into a hole · Delete removes';
  if (s.bodies === 0) return 'Pick a shape from the Shapes menu (or press B for a box) to start building!';
  return 'Click a body to select · drag empty space to orbit · right-drag to pan · scroll to zoom · F to fit';
}

const pick = (s: typeof store.state) => ({
  mode: s.mode, tool: s.sketchTool, sel: s.selection.length, bodies: s.result.bodies.length, snap: s.snap, features: s.doc.features.length,
});

/** Shows whether the exact (OpenCascade) engine is loaded and how fast the last rebuild was. */
export function EngineChip() {
  const [st, setSt] = useState({ s: kernel.status, ms: kernel.lastMs, err: kernel.lastError });
  const quality = useStore((s) => s.result.quality);
  useEffect(() => kernel.onStatus(() => setSt({ s: kernel.status, ms: kernel.lastMs, err: kernel.lastError })), []);
  const label = st.s === 'loading' ? 'Loading exact engine…'
    : st.s === 'busy' ? 'Computing exact geometry…'
      : st.s === 'error' ? 'Preview geometry only'
        : st.s === 'ready' ? (quality === 'precise' ? `Exact B-rep · ${Math.round(st.ms)} ms` : 'Exact engine ready') : 'Preview geometry';
  const desc = st.s === 'error'
    ? `The OpenCascade engine could not start (${st.err || 'unknown reason'}). Modelling still works with the fast mesh engine, but fillets, shells and STEP need it.`
    : 'KimaticPro shows an instant preview while you work, then rebuilds every body as an exact B-rep solid with OpenCascade — the same kind of kernel professional CAD uses. Fillets, shells, drafts and STEP export use it.';
  return <span class={`engine ${st.s}`} data-tip-title="Geometry engine" data-tip-desc={desc}><i />{label}</span>;
}

export function StatusBar() {
  const s = useStore(pick);
  return (
    <footer class="statusbar">
      <span class="hint"><Lightbulb size={13} />{hintFor(s)}</span>
      {s.sel > 0 && <span class="sb-item"><MousePointer2 size={12} />{s.sel} selected</span>}
      <span class="sb-sep" />
      <span class="sb-item" data-tip-title="Snap" data-tip-desc="Moves and sketch points jump to this step size.">
        <Magnet size={12} /> Snap
        <select value={String(s.snap)} onChange={(e) => store.set({ snap: Number((e.currentTarget as HTMLSelectElement).value) })}>
          {[0, 0.1, 0.5, 1, 2, 5, 10].map((v) => <option key={v} value={v}>{v === 0 ? 'Off' : `${v} mm`}</option>)}
        </select>
      </span>
      <span class="sb-sep" />
      <EngineChip />
      <span class="sb-sep" />
      <span class="sb-item">Units: mm</span>
      <span class="sb-sep" />
      <span class="sb-item">{s.bodies} bodies · {s.features} steps</span>
    </footer>
  );
}
