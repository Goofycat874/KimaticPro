import { useState } from 'preact/hooks';
import { ChevronDown, ChevronRight, Eye, EyeOff, PenLine, Pencil, Ghost, Boxes, Grid3x3, Trash2 } from 'lucide-preact';
import { store } from '../core/store';
import * as A from '../core/actions';
import { featureOf } from '../core/evaluator';
import { useStore } from './hooks';

function Section(props: { title: string; icon: any; count?: number; children: any; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(props.defaultOpen ?? true);
  const Icon = props.icon;
  return (
    <div class="tree-section">
      <div class="tree-title" onClick={() => setOpen(!open)}>
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        <Icon size={14} />
        {props.title}
        {props.count !== undefined && <span class="count">{props.count}</span>}
      </div>
      {open && props.children}
    </div>
  );
}

function Rename(props: { value: string; onDone: (v: string | null) => void }) {
  return (
    <input autoFocus value={props.value}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') props.onDone((e.currentTarget as HTMLInputElement).value.trim() || null);
        if (e.key === 'Escape') props.onDone(null);
      }}
      onBlur={(e) => props.onDone((e.currentTarget as HTMLInputElement).value.trim() || null)} />
  );
}

export function Browser() {
  const s = useStore((s) => ({
    bodies: s.result.bodies, sketches: s.result.sketches, ghosts: s.result.ghosts,
    selection: s.selection, selectedFeature: s.selectedFeature, sketchId: s.sketchId, mode: s.mode, showGrid: s.showGrid, name: s.doc.name,
  }));
  const [editing, setEditing] = useState<string | null>(null);
  const sel = new Set(s.selection);

  return (
    <aside class="panel left" data-tour="browser">
      <div class="panel-head">Browser</div>
      <div class="panel-body">
        <Section title="Bodies" icon={Boxes} count={s.bodies.length}>
          {s.bodies.length === 0 && <div class="tree-empty">No bodies yet. Add a shape from the <b>Shapes</b> menu or draw a sketch.</div>}
          {s.bodies.map((b) => (
            <div key={b.id} class={`tree-row ${sel.has(b.id) ? 'selected' : ''} ${b.visible ? '' : 'dim'}`}
              onClick={(e) => A.select([b.id], e.shiftKey || e.ctrlKey || e.metaKey)}
              onDblClick={() => setEditing(b.id)}
              onMouseEnter={() => store.set({ hovered: b.id })}
              onMouseLeave={() => store.set({ hovered: null })}>
              <span class="dot" style={{ background: b.appearance.color }} />
              {editing === b.id
                ? <Rename value={b.name} onDone={(v) => { setEditing(null); if (v && v !== b.name) A.renameBody(b.id, v); }} />
                : <span class="name">{b.name}</span>}
              <span class="row-act">
                <button class="mini-btn" data-tip-title="Rename" onClick={(e) => { e.stopPropagation(); setEditing(b.id); }}><Pencil size={13} /></button>
              </span>
              <span class={`row-act ${b.visible ? '' : 'on'}`}>
                <button class="mini-btn" data-tip-title={b.visible ? 'Hide' : 'Show'} onClick={(e) => { e.stopPropagation(); A.toggleVisibility(b.id); }}>
                  {b.visible ? <Eye size={14} /> : <EyeOff size={14} />}
                </button>
              </span>
            </div>
          ))}
        </Section>

        <Section title="Sketches" icon={PenLine} count={s.sketches.length}>
          {s.sketches.length === 0 && <div class="tree-empty">Sketches are 2D drawings you turn into 3D. Press <b>S</b> to start one.</div>}
          {s.sketches.map((k) => (
            <div key={k.featureId} class={`tree-row ${s.selectedFeature === k.featureId ? 'selected' : ''} ${k.visible ? '' : 'dim'}`}
              onClick={() => A.selectFeature(k.featureId)} onDblClick={() => A.editSketch(k.featureId)}>
              <PenLine size={13} style={{ color: 'var(--good)', flex: 'none' }} />
              {editing === k.featureId
                ? <Rename value={k.name} onDone={(v) => { setEditing(null); if (v) A.renameFeature(k.featureId, v); }} />
                : <span class="name">{k.name}</span>}
              <span class="row-act">
                <button class="mini-btn" data-tip-title="Edit sketch" onClick={(e) => { e.stopPropagation(); A.editSketch(k.featureId); }}><Pencil size={13} /></button>
              </span>
              <span class={`row-act ${k.visible ? '' : 'on'}`}>
                <button class="mini-btn" data-tip-title={k.visible ? 'Hide' : 'Show'}
                  onClick={(e) => { e.stopPropagation(); A.updateFeature(k.featureId, { visible: !k.visible } as any, 'Toggle sketch'); }}>
                  {k.visible ? <Eye size={14} /> : <EyeOff size={14} />}
                </button>
              </span>
            </div>
          ))}
        </Section>

        <Section title="Tools & holes" icon={Ghost} count={s.ghosts.length} defaultOpen={s.ghosts.length > 0}>
          {s.ghosts.length === 0 && <div class="tree-empty">Shapes used to cut or join show up here so you can still move and resize them.</div>}
          {s.ghosts.map((g) => {
            const f = featureOf(store.doc, g.featureId);
            return (
              <div key={`${g.featureId}-${g.bodyId}`} class={`tree-row ${s.selectedFeature === g.featureId ? 'selected' : ''}`} onClick={() => A.selectFeature(g.featureId)}>
                <span class="dot" style={{ background: g.op === 'cut' ? 'var(--hole)' : g.op === 'intersect' ? '#a855f7' : 'var(--good)', opacity: 0.7 }} />
                <span class="name">{f?.name ?? g.bodyId}</span>
                <span style={{ fontSize: 10.5, color: 'var(--text-3)' }}>{g.op === 'cut' ? 'hole' : g.op}</span>
                <span class="row-act">
                  <button class="mini-btn" data-tip-title="Delete tool" onClick={(e) => { e.stopPropagation(); A.deleteFeature(g.featureId); }}><Trash2 size={13} /></button>
                </span>
              </div>
            );
          })}
        </Section>

        <Section title="Origin" icon={Grid3x3} defaultOpen={false}>
          <div class="tree-row" onClick={() => store.set({ showGrid: !s.showGrid })}>
            <Grid3x3 size={13} />
            <span class="name">Ground grid</span>
            <span class="row-act on">{s.showGrid ? <Eye size={14} /> : <EyeOff size={14} />}</span>
          </div>
          {(['top', 'front', 'right'] as const).map((p) => (
            <div key={p} class="tree-row" onClick={() => A.createSketchOnStandard(p)} data-tip-title={`Sketch on ${p} plane`}>
              <span class="dot" style={{ background: p === 'top' ? '#22c55e' : p === 'front' ? '#3b82f6' : '#ef4444', borderRadius: 2 }} />
              <span class="name">{p === 'top' ? 'Top plane (ground)' : p === 'front' ? 'Front plane' : 'Right plane'}</span>
              <span class="row-act"><PenLine size={13} /></span>
            </div>
          ))}
        </Section>
      </div>
    </aside>
  );
}
