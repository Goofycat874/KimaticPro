import { useRef, useState } from 'preact/hooks';
import { SkipBack, StepBack, StepForward, SkipForward, Lightbulb, Pencil, Trash2, EyeOff, Flag } from 'lucide-preact';
import { store } from '../core/store';
import * as A from '../core/actions';
import { shapeById } from '../core/primitives';
import type { Feature } from '../core/types';
import { useClickOutside, useStore } from './hooks';
import { TYPE_META } from './Inspector';

function featureDesc(f: Feature) {
  if (f.type === 'primitive') {
    const op = f.op === 'cut' ? ' (hole)' : f.op === 'join' ? ' (join)' : f.op === 'intersect' ? ' (intersect)' : '';
    return `${shapeById(f.shape)?.label ?? 'Shape'}${op}`;
  }
  return TYPE_META[f.type].label;
}

export function Timeline() {
  const s = useStore((s) => ({ features: s.doc.features, marker: s.doc.marker, selected: s.selectedFeature, errors: s.result.errors }));
  const track = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<{ x: number; id: string } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  useClickOutside(menuRef, () => setMenu(null), !!menu);

  const onMarkerDown = (e: PointerEvent) => {
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      const items = [...(track.current?.querySelectorAll('.tl-item') ?? [])] as HTMLElement[];
      let idx = 0;
      for (const it of items) {
        const r = it.getBoundingClientRect();
        if (ev.clientX > r.left + r.width / 2) idx++;
      }
      if (idx !== store.doc.marker) A.setMarker(idx, true);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      store.endTransient('Roll timeline');
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const items: any[] = [];
  s.features.forEach((f, i) => {
    if (i === s.marker) items.push(<div key="marker" class="tl-marker" onPointerDown={onMarkerDown} data-tip-title="History marker" data-tip-desc="Drag left to rewind your design and see how it was built. New steps are added here." />);
    const meta = TYPE_META[f.type];
    const Icon = meta.icon;
    items.push(
      <div key={f.id}
        class={`tl-item ${s.selected === f.id ? 'selected' : ''} ${i >= s.marker ? 'rolled' : ''} ${f.suppressed ? 'suppressed' : ''} ${s.errors[f.id] ? 'err' : ''}`}
        onClick={() => (f.type === 'sketch' && s.selected === f.id ? A.editSketch(f.id) : A.selectFeature(f.id))}
        onDblClick={() => f.type === 'sketch' && A.editSketch(f.id)}
        onContextMenu={(e) => { e.preventDefault(); setMenu({ x: (e.currentTarget as HTMLElement).getBoundingClientRect().left, id: f.id }); }}
        data-tip-title={f.name} data-tip-desc={`${featureDesc(f)} · step ${i + 1}${s.errors[f.id] ? ` — ⚠ ${s.errors[f.id]}` : ''}. Click to edit, right-click for more.`}>
        <Icon size={17} />
        <span class="tl-type" style={{ background: meta.color }} />
      </div>,
    );
  });
  if (s.marker >= s.features.length) items.push(<div key="marker" class="tl-marker" onPointerDown={onMarkerDown} data-tip-title="History marker" data-tip-desc="Drag left to rewind your design." />);

  const mf = menu ? s.features.find((f) => f.id === menu.id) : null;
  const go = (m: number) => A.setMarker(m);
  return (
    <div class="timeline" data-tour="timeline">
      <span class="tl-label">Timeline</span>
      <div class="tl-controls">
        <button class="icon-btn" onClick={() => go(0)} disabled={s.marker === 0} data-tip-title="Rewind to start"><SkipBack size={15} /></button>
        <button class="icon-btn" onClick={() => go(s.marker - 1)} disabled={s.marker === 0} data-tip-title="Step back"><StepBack size={15} /></button>
        <button class="icon-btn" onClick={() => go(s.marker + 1)} disabled={s.marker >= s.features.length} data-tip-title="Step forward"><StepForward size={15} /></button>
        <button class="icon-btn" onClick={() => go(s.features.length)} disabled={s.marker >= s.features.length} data-tip-title="Jump to end"><SkipForward size={15} /></button>
      </div>
      <div class="tl-track" ref={track}>
        {s.features.length === 0
          ? <span class="tl-empty"><Lightbulb size={13} style={{ verticalAlign: -2, marginRight: 6 }} />Every step you take shows up here. Click any step to change it — the rest of your design updates automatically.</span>
          : items}
      </div>
      {menu && mf && (
        <div ref={menuRef} class="dropdown" style={{ position: 'fixed', left: menu.x, top: 'auto', bottom: 92 }}>
          <div class="menu-label">{mf.name}</div>
          <button class="menu-item" onClick={() => { setMenu(null); mf.type === 'sketch' ? A.editSketch(mf.id) : A.selectFeature(mf.id); }}><Pencil size={14} /> Edit</button>
          <button class="menu-item" onClick={() => { setMenu(null); A.setMarker(s.features.indexOf(mf) + 1); }}><Flag size={14} /> Roll to here</button>
          <button class="menu-item" onClick={() => { setMenu(null); A.toggleSuppress(mf.id); }}><EyeOff size={14} /> {mf.suppressed ? 'Unsuppress' : 'Suppress'}</button>
          <div class="menu-sep" />
          <button class="menu-item" onClick={() => { setMenu(null); A.deleteFeature(mf.id); }}><Trash2 size={14} /> Delete</button>
        </div>
      )}
    </div>
  );
}
