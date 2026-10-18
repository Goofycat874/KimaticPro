import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import {
  Drill,
  House, Focus, Diamond, Grid3x3, Scissors, Eye, Move, Rotate3d, Scale3d, X, Check, PenLine, Ruler, Box as BoxIcon,
  Copy, Trash2, ArrowDownToLine, EyeOff, Ghost, SquaresUnite, ScanEye, Palette, ArrowUpFromLine, Shapes, PanelBottom, Layers2, SlidersHorizontal, SquareRoundCorner,
} from 'lucide-preact';
import { store } from '../core/store';
import * as A from '../core/actions';
import { SHAPES } from '../core/primitives';
import { SWATCHES } from '../core/materials';
import { featureOf } from '../core/evaluator';
import { analyzeSketch } from '../core/constraints';
import { shapeThumbnail } from '../viewport/thumbnails';
import { useClickOutside, useStore } from './hooks';
import { cmd } from './commands';
import { NumberField } from './controls';

function NavBtn({ id, icon: Icon, label }: { id: string; icon: any; label?: string }) {
  useStore((s) => [s.projection, s.showGrid, s.section, s.showGhosts, s.displayMode]);
  const c = cmd(id);
  return (
    <button class={`icon-btn ${c.active?.() ? 'active' : ''}`} onClick={c.run} data-tip-title={label ?? c.label} data-tip-desc={c.desc} data-tip-key={c.key}>
      <Icon size={17} />
    </button>
  );
}

function NavBar() {
  const dm = useStore((s) => s.displayMode);
  const modes: [typeof dm, string, string][] = [['shaded', 'Shaded', 'Smooth solid look'], ['edges', 'Shaded + edges', 'Solid with crisp outlines (default)'], ['wire', 'Wireframe', 'Just the edges'], ['xray', 'X-ray', 'See-through, to look inside']];
  return (
    <div class="navbar" data-tour="navbar">
      <NavBtn id="view.home" icon={House} />
      <NavBtn id="view.fit" icon={Focus} />
      <NavBtn id="view.ortho" icon={Diamond} />
      <div class="sep" />
      {modes.map(([m, label, desc]) => (
        <button key={m} class={`icon-btn dm ${dm === m ? 'active' : ''}`} onClick={() => store.set({ displayMode: m })} data-tip-title={label} data-tip-desc={desc}>
          <DisplayIcon mode={m} />
        </button>
      ))}
      <div class="sep" />
      <NavBtn id="view.grid" icon={Grid3x3} />
      <NavBtn id="inspect.section" icon={Scissors} />
      <NavBtn id="inspect.ghosts" icon={Eye} />
    </div>
  );
}

function DisplayIcon({ mode }: { mode: string }) {
  const common = { width: 17, height: 17, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.7, 'stroke-linejoin': 'round' as const };
  if (mode === 'shaded') return <svg {...common}><path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z" fill="currentColor" fill-opacity=".55" stroke="none" /><path d="M12 12l8-4.5M12 12v9M12 12L4 7.5" stroke-opacity=".0" /></svg>;
  if (mode === 'edges') return <svg {...common}><path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z" fill="currentColor" fill-opacity=".3" /><path d="M12 12l8-4.5M12 12v9M12 12L4 7.5" /></svg>;
  if (mode === 'wire') return <svg {...common}><path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z" /><path d="M12 12l8-4.5M12 12v9M12 12L4 7.5" /><path d="M12 3v9M4 16.5l8-4.5 8 4.5" stroke-dasharray="2 2" /></svg>;
  return <svg {...common}><path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z" fill="currentColor" fill-opacity=".15" /><path d="M12 12l8-4.5M12 12v9M12 12L4 7.5" /><circle cx="12" cy="12" r="2.5" fill="currentColor" /></svg>;
}

function GizmoBar() {
  const s = useStore((s) => ({ sel: s.selection.length, fid: s.selectedFeature, gizmo: s.gizmo, mode: s.mode }));
  const f = featureOf(store.doc, s.fid);
  if (s.mode !== 'model' || (!s.sel && !(f && 'transform' in f))) return null;
  const items: [string, any][] = [['gizmo.translate', Move], ['gizmo.rotate', Rotate3d], ['gizmo.scale', Scale3d]];
  return (
    <div class="gizmo-bar">
      {items.map(([id, Icon]) => {
        const c = cmd(id);
        return <button key={id} class={`icon-btn ${c.active?.() ? 'active' : ''}`} onClick={c.run} data-tip-title={c.label} data-tip-desc={c.desc} data-tip-key={c.key}><Icon size={17} /></button>;
      })}
    </div>
  );
}

function Banner() {
  const s = useStore((s) => ({ mode: s.mode, sketchId: s.sketchId, doc: s.doc, measure: s.measure, tool: s.sketchTool, constraint: s.sketchConstraint, picks: s.sketchSelection.length }));
  const [offset, setOffset] = useState(0);
  if (s.mode === 'pick-plane') {
    return (
      <div class="banner">
        <PenLine size={17} style={{ color: 'var(--good)' }} />
        <div><div class="b-title">Where do you want to draw?</div><div class="b-sub">Click a plane, or any flat face of a body.</div></div>
        <button class="btn small" onClick={() => A.createSketchOnStandard('top', offset)} style={{ borderColor: '#22c55e' }}>Ground</button>
        <button class="btn small" onClick={() => A.createSketchOnStandard('front', offset)} style={{ borderColor: '#3b82f6' }}>Front</button>
        <button class="btn small" onClick={() => A.createSketchOnStandard('right', offset)} style={{ borderColor: '#ef4444' }}>Right</button>
        <label class="offset-in" data-tip-title="Plane offset" data-tip-desc="Lift the sketch plane off the origin — stack sketches at different heights for a loft.">
          offset <input type="number" value={offset} step={5} onInput={(e) => setOffset(Number((e.currentTarget as HTMLInputElement).value) || 0)} onKeyDown={(e) => e.stopPropagation()} /> mm
        </label>
        <button class="icon-btn" onClick={() => store.set({ mode: 'model' })} data-tip-title="Cancel" data-tip-key="Escape"><X size={16} /></button>
      </div>
    );
  }
  if (s.mode === 'sketch') {
    const sk = featureOf(s.doc, s.sketchId);
    const n = sk?.type === 'sketch' ? sk.entities.length : 0;
    const cs = sk?.type === 'sketch' ? sk.constraints ?? [] : [];
    const info = sk?.type === 'sketch' && cs.length ? analyzeSketch(sk.entities, cs) : null;
    const sub = s.tool === 'constrain' && s.constraint
      ? `${cmd(`constrain.${s.constraint}`).label}: pick ${A.constraintNeeds(s.constraint)}${s.picks ? ` (${s.picks} picked)` : ''} · Esc to stop`
      : s.tool === 'dimension' ? 'Click a line or circle (or two items), then click where the size goes'
        : n ? `${n} shape${n > 1 ? 's' : ''} · draw closed shapes to make solids` : 'Pick a tool and start drawing';
    return (
      <div class="banner sketch">
        <span class="pill"><PenLine size={12} /> SKETCH</span>
        <div><div class="b-title">{sk?.name}{info && <DofChip info={info} />}</div><div class="b-sub">{sub}</div></div>
        {n > 0 && <button class="btn small primary" onClick={() => A.extrude()}><ArrowUpFromLine size={14} /> Extrude</button>}
        <button class="btn small good" onClick={() => A.finishSketch()}><Check size={14} /> Finish</button>
      </div>
    );
  }
  if (s.mode === 'pick') return <PickBanner />;
  if (s.mode === 'lay-flat') {
    return (
      <div class="banner">
        <PanelBottom size={17} style={{ color: 'var(--accent)' }} />
        <div><div class="b-title">Lay flat</div><div class="b-sub">Click the face that should sit on the print bed</div></div>
        <button class="btn small" onClick={() => store.set({ mode: 'model' })}>Done</button>
      </div>
    );
  }
  if (s.mode === 'place-hole') {
    return (
      <div class="banner">
        <Drill size={17} style={{ color: '#ef4444' }} />
        <div><div class="b-title">Drill holes</div><div class="b-sub">Click a face to drill — set size and type on the right · Esc when done</div></div>
        <button class="btn small" onClick={() => store.set({ mode: 'model' })}>Done</button>
      </div>
    );
  }
  if (s.mode === 'measure') {
    return (
      <div class="banner">
        <Ruler size={17} style={{ color: '#f59e0b' }} />
        <div><div class="b-title">Measure</div><div class="b-sub">{!s.measure.a ? 'Click the first point' : !s.measure.b ? 'Click the second point' : 'Click again to start a new measurement'}</div></div>
        <button class="btn small" onClick={() => store.set({ mode: 'model' })}>Done</button>
      </div>
    );
  }
  return null;
}

const PICK_TEXT = {
  fillet: { title: 'Fillet', what: 'edges', unit: 'mm', label: 'Radius' },
  chamfer: { title: 'Chamfer', what: 'edges', unit: 'mm', label: 'Distance' },
  shell: { title: 'Shell', what: 'faces to remove', unit: 'mm', label: 'Wall' },
  draft: { title: 'Draft', what: 'faces to taper', unit: '°', label: 'Angle' },
} as const;

function PickBanner() {
  const p = useStore((s) => s.pick);
  const sel = useStore((s) => s.selection.length);
  if (!p) return null;
  const t = PICK_TEXT[p.op];
  const n = p.refs.length;
  const noun = p.kind === 'edges' ? (n === 1 ? 'edge' : 'edges') : n === 1 ? 'face' : 'faces';
  const hint = n ? `${n} ${noun} picked` : p.op === 'draft' ? `Click the ${t.what}` : sel ? `Click ${t.what} — or Apply for the whole body` : `Click the ${t.what}`;
  return (
    <div class="banner pick-banner">
      <SquareRoundCorner size={17} style={{ color: 'var(--accent)' }} />
      <div><div class="b-title">{t.title}</div><div class="b-sub">{hint}</div></div>
      {(p.op === 'fillet' || p.op === 'chamfer') && (
        <div class="seg" style={{ width: 150 }}>
          <button class={p.op === 'fillet' ? 'on' : ''} onClick={() => A.setPickOp('fillet')}>Round</button>
          <button class={p.op === 'chamfer' ? 'on' : ''} onClick={() => A.setPickOp('chamfer')}>Bevel</button>
        </div>
      )}
      <div style={{ width: 120 }}>
        <NumberField value={p.value} unit={t.unit} label={t.label[0]} min={p.op === 'draft' ? -45 : 0.05} max={p.op === 'draft' ? 45 : 500} step={p.op === 'draft' ? 1 : 0.5}
          onChange={(v) => A.setPickValue(v)} />
      </div>
      <button class="btn small primary" onClick={() => A.applyPick()} data-tip-key="Enter" data-tip-title="Apply">Apply</button>
      <button class="icon-btn" onClick={() => A.cancelPick()} data-tip-title="Cancel" data-tip-key="Escape"><X size={16} /></button>
    </div>
  );
}

function EmptyState() {
  const s = useStore((s) => ({ n: s.result.bodies.length + s.result.sketches.length, mode: s.mode, welcome: s.welcome }));
  if (s.n || s.mode !== 'model' || s.welcome) return null;
  const quick = ['box', 'cylinder', 'sphere', 'star', 'heart', 'text'];
  return (
    <div class="empty-state">
      <div style={{ fontSize: 30 }}>✨</div>
      <h2>Let's build something!</h2>
      <p>Click a shape to add it, or drag it right where you want it.</p>
      <div class="quick-grid">
        {quick.map((id) => (
          <button key={id} class="quick-shape" draggable onClick={() => A.addShape(id)} onDragStart={(e) => e.dataTransfer!.setData('text/kimatic-shape', id)}>
            <img src={shapeThumbnail(id)} alt="" />{SHAPES.find((x) => x.id === id)!.label}
          </button>
        ))}
      </div>
      <div class="actions">
        <button class="btn" onClick={() => A.beginSketch()}><PenLine size={14} /> Draw a sketch</button>
        <button class="btn" onClick={() => store.set({ welcome: true })}><Shapes size={14} /> Start from a template</button>
      </div>
    </div>
  );
}

function ContextMenu() {
  const cm = useStore((s) => s.contextMenu);
  const ref = useRef<HTMLDivElement>(null);
  const [shift, setShift] = useState({ x: 0, y: 0 });
  useClickOutside(ref, () => store.set({ contextMenu: null }), !!cm);
  useLayoutEffect(() => {
    // keep the whole menu inside the viewport
    const el = ref.current;
    if (!el || !cm) return;
    const host = el.parentElement!.getBoundingClientRect();
    setShift({
      x: Math.min(0, host.width - (cm.x + el.offsetWidth) - 8),
      y: Math.min(0, host.height - (cm.y + el.offsetHeight) - 8),
    });
  }, [cm]);
  if (!cm) return null;
  const close = (fn: () => void) => () => { store.set({ contextMenu: null }); fn(); };
  const body = cm.bodyId ? A.bodyById(cm.bodyId) : null;
  const multi = store.state.selection.length > 1;
  return (
    <div class="ctx-menu" ref={ref} style={{ left: Math.max(8, cm.x + shift.x), top: Math.max(8, cm.y + shift.y) }}>
      {body ? <>
        <div class="menu-label">{multi ? `${store.state.selection.length} bodies` : body.name}</div>
        <button class="menu-item" onClick={close(() => A.duplicate())}><Copy size={14} /><span class="grow">Duplicate</span><span class="kbd">Ctrl+D</span></button>
        {multi && <button class="menu-item" onClick={close(() => A.combine('join'))}><SquaresUnite size={14} /><span class="grow">Join</span></button>}
        {!multi && body.editableFeatureId && featureOf(store.doc, body.editableFeatureId)?.type !== 'move' &&
          <button class="menu-item" onClick={close(() => A.setBodyOp(body.editableFeatureId!, 'cut'))}><Ghost size={14} /><span class="grow">Make it a hole</span><span class="kbd">H</span></button>}
        <button class="menu-item" onClick={close(() => A.dropToGround())}><ArrowDownToLine size={14} /><span class="grow">Drop to ground</span><span class="kbd">D</span></button>
        <button class="menu-item" onClick={close(() => A.viewApi.fit?.(store.state.selection))}><Focus size={14} /><span class="grow">Zoom to</span><span class="kbd">F</span></button>
        <div class="menu-sep" />
        <div class="menu-label"><Palette size={11} /> Colour</div>
        <div class="swatches" style={{ padding: '2px 8px 6px' }}>
          {SWATCHES.slice(0, 18).map((c) => <button key={c} class="swatch" style={{ background: c }} onClick={close(() => A.setAppearance(store.state.selection, { color: c }))} />)}
        </div>
        <div class="menu-sep" />
        <button class="menu-item" onClick={close(() => A.isolate())}><ScanEye size={14} /><span class="grow">Isolate</span></button>
        <button class="menu-item" onClick={close(() => store.state.selection.forEach((id) => A.toggleVisibility(id)))}><EyeOff size={14} /><span class="grow">Hide</span></button>
        <button class="menu-item" onClick={close(() => A.deleteSelection())}><Trash2 size={14} /><span class="grow">Delete</span><span class="kbd">Del</span></button>
      </> : <>
        <div class="menu-label">Add</div>
        {['box', 'cylinder', 'sphere', 'text'].map((id) => (
          <button key={id} class="menu-item" onClick={close(() => A.addShape(id))}><BoxIcon size={14} /><span class="grow">{SHAPES.find((s) => s.id === id)!.label}</span></button>
        ))}
        <button class="menu-item" onClick={close(() => A.beginSketch())}><PenLine size={14} /><span class="grow">New sketch</span><span class="kbd">S</span></button>
        <div class="menu-sep" />
        <button class="menu-item" onClick={close(() => A.viewApi.setView?.('home'))}><House size={14} /><span class="grow">Home view</span></button>
        <button class="menu-item" onClick={close(() => A.viewApi.fit?.())}><Focus size={14} /><span class="grow">Zoom to fit</span><span class="kbd">F</span></button>
        <button class="menu-item" onClick={close(() => A.showAll())}><Eye size={14} /><span class="grow">Show all</span></button>
      </>}
    </div>
  );
}

/** Phones: buttons that slide the Browser drawer and the Properties sheet in. */
function MobileButtons() {
  const s = useStore((s) => ({ sel: s.selection.length, feat: s.selectedFeature, mode: s.mode, bodies: s.result.bodies.length }));
  return <>
    <button class="fab fab-layers mobile-only" onClick={() => store.set({ sheet: 'browser' })} aria-label="Browser">
      <Layers2 size={19} /><span class="fab-count">{s.bodies}</span>
    </button>
    <button class={`fab fab-props mobile-only ${s.sel || s.feat || s.mode === 'sketch' ? 'hot' : ''}`} onClick={() => store.set({ sheet: 'inspector' })} aria-label="Properties">
      <SlidersHorizontal size={19} /><span>{s.mode === 'sketch' ? 'Sketch' : s.sel || s.feat ? 'Edit' : 'Design'}</span>
    </button>
  </>;
}

function DofChip({ info }: { info: { ok: boolean; dof: number; failing: string[] } }) {
  if (!info.ok || info.failing.length) {
    return <span class="dof-chip bad" data-tip-title="Conflicting constraints" data-tip-desc="Some constraints or dimensions fight each other. Select the red ones and delete or change them.">Conflict</span>;
  }
  return info.dof === 0
    ? <span class="dof-chip ok" data-tip-title="Fully constrained" data-tip-desc="Every point and size is pinned down by constraints and dimensions.">Fully constrained</span>
    : <span class="dof-chip free" data-tip-title="Degrees of freedom" data-tip-desc="How many ways the sketch can still move or stretch. Add dimensions and constraints (and tie it to the origin) to bring it to zero.">{info.dof} free</span>;
}

export function ViewportOverlay() {
  return (
    <div class="vp-overlay">
      <MobileButtons />
      <GizmoBar />
      <Banner />
      <EmptyState />
      <NavBar />
      <ContextMenu />
    </div>
  );
}
