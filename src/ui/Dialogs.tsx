import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import * as THREE from 'three';
import { FilePlus2, FolderOpen, GraduationCap, X, Search, RotateCcw, CircleCheck, CircleAlert, Info, ArrowRight, Sparkles, Printer, Download, Variable } from 'lucide-preact';
import { isValidName, resolveParams } from '../core/expr';
import { analyzePrint, PRINTERS, printerById } from '../core/printing';
import { store, emptyDoc, Store } from '../core/store';
import { TEMPLATES } from '../core/templates';
import { pickFile } from '../core/io';
import { setParams, viewApi } from '../core/actions';
import { docThumbnail } from '../viewport/thumbnails';
import { COMMANDS, runCmd } from './commands';
import { Kbd } from './controls';
import { useStore } from './hooks';

function openDoc(doc: ReturnType<typeof emptyDoc>) {
  store.load(doc);
  setTimeout(() => viewApi.setView?.('home'), 60);
}

export function Welcome() {
  const open = useStore((s) => s.welcome);
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const autosave = useMemo(() => (open ? Store.loadAutosave() : null), [open]);
  useEffect(() => {
    if (!open) return;
    let i = 0;
    const next = () => {
      if (i >= TEMPLATES.length) return;
      const t = TEMPLATES[i++];
      try { setThumbs((m) => ({ ...m, [t.id]: docThumbnail(t.id, t.build()) })); } catch { /* skip */ }
      setTimeout(next, 16);
    };
    next();
  }, [open]);
  if (!open) return null;
  const hasWork = store.doc.features.length > 0;
  return (
    <div class="modal-back" onClick={(e) => { if (e.target === e.currentTarget && hasWork) store.set({ welcome: false }); }}>
      <div class="modal welcome">
        <div class="welcome-side">
          <div class="brand-mark">K</div>
          <h1>Design anything.<br />Print everything.</h1>
          <p>KimaticPro is a free, open-source 3D CAD studio. Snap shapes together like building blocks — or sketch and extrude like a pro.</p>
          <div class="w-actions">
            <button class="w-btn main" onClick={() => openDoc(emptyDoc())}><FilePlus2 size={17} /> New blank design</button>
            <button class="w-btn" onClick={() => { store.set({ welcome: false }); pickFile(); }}><FolderOpen size={17} /> Open a file…</button>
            <button class="w-btn" onClick={() => { openDoc(emptyDoc()); store.set({ dialog: 'tour', tourStep: 0 }); }}><GraduationCap size={17} /> Take the 60-second tour</button>
          </div>
          <div class="w-foot">Free forever · MIT licensed · Works offline in your browser</div>
        </div>
        <div class="welcome-main">
          {hasWork && <button class="icon-btn" style={{ float: 'right' }} onClick={() => store.set({ welcome: false })}><X size={18} /></button>}
          {autosave && !hasWork && (
            <div class="resume">
              <RotateCcw size={18} style={{ color: 'var(--accent)' }} />
              <div class="grow"><b>Pick up where you left off</b><div style={{ color: 'var(--text-3)', fontSize: 12 }}>{autosave.name} · {autosave.features.length} steps</div></div>
              <button class="btn small primary" onClick={() => openDoc(autosave)}>Resume <ArrowRight size={13} /></button>
            </div>
          )}
          <h3>Start from a template</h3>
          <p class="sub">Every template is fully editable — open one and click any step in the timeline to see how it's made.</p>
          <div class="templates">
            {TEMPLATES.map((t) => (
              <button key={t.id} class="tpl" onClick={() => openDoc(t.build())}>
                <div class="tpl-img">{thumbs[t.id] ? <img src={thumbs[t.id]} alt="" /> : <Sparkles size={22} style={{ opacity: 0.3 }} />}</div>
                <div class="tpl-meta">
                  <b>{t.name} <span class={`level ${t.level}`}>{t.level}</span></b>
                  <p>{t.description}</p>
                </div>
              </button>
            ))}
            <button class="tpl" onClick={() => openDoc(emptyDoc())}>
              <div class="tpl-img"><FilePlus2 size={34} style={{ opacity: 0.45 }} /></div>
              <div class="tpl-meta"><b>Blank</b><p>An empty canvas. Your imagination is the limit.</p></div>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export function CommandPalette() {
  const open = useStore((s) => s.palette);
  const [q, setQ] = useState('');
  const [i, setI] = useState(0);
  const mode = useStore((s) => s.mode);
  const list = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    return COMMANDS
      .filter((c) => (mode === 'sketch' ? true : c.group !== 'Sketch'))
      .filter((c) => words.every((w) => `${c.label} ${c.group} ${c.keywords ?? ''} ${c.desc}`.toLowerCase().includes(w)))
      .filter((c) => !c.enabled || c.enabled())
      .slice(0, 40);
  }, [q, mode, open]);
  useEffect(() => { if (open) { setQ(''); setI(0); } }, [open]);
  if (!open) return null;
  const run = (idx: number) => {
    const c = list[idx];
    if (!c) return;
    store.set({ palette: false });
    setTimeout(() => c.run(), 0);
  };
  return (
    <div class="modal-back" onClick={(e) => e.target === e.currentTarget && store.set({ palette: false })}>
      <div class="modal palette">
        <div class="palette-input">
          <Search size={18} style={{ color: 'var(--text-3)' }} />
          <input autoFocus placeholder="What do you want to do? Try “hole”, “gear” or “export”" value={q}
            onInput={(e) => { setQ((e.currentTarget as HTMLInputElement).value); setI(0); }}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'ArrowDown') { e.preventDefault(); setI(Math.min(list.length - 1, i + 1)); }
              if (e.key === 'ArrowUp') { e.preventDefault(); setI(Math.max(0, i - 1)); }
              if (e.key === 'Enter') run(i);
              if (e.key === 'Escape') store.set({ palette: false });
            }} />
          <Kbd k="Esc" />
        </div>
        <div class="palette-list">
          {list.length === 0 && <div style={{ padding: 16, color: 'var(--text-3)' }}>Nothing matches “{q}”.</div>}
          {list.map((c, idx) => {
            const Icon = c.icon;
            return (
              <div key={c.id} class={`palette-item ${idx === i ? 'on' : ''}`} onMouseEnter={() => setI(idx)} onClick={() => run(idx)}>
                <Icon size={16} />
                <span class="grow">{c.label}</span>
                <span class="pi-group">{c.group}</span>
                {c.key && <Kbd k={c.key} />}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

const MOUSE = [
  ['Orbit (spin the view)', 'Left-drag empty space'],
  ['Pan', 'Right-drag or Middle-drag'],
  ['Zoom', 'Scroll wheel'],
  ['Select / add to selection', 'Click / Shift+Click'],
  ['Zoom to a body', 'Double-click'],
  ['Quick menu', 'Right-click'],
];

export function Shortcuts() {
  const open = useStore((s) => s.dialog === 'shortcuts');
  if (!open) return null;
  const groups = ['File', 'Edit', 'Create', 'Modify', 'Arrange', 'Inspect', 'View', 'Sketch', 'Help'];
  return (
    <div class="modal-back" onClick={(e) => e.target === e.currentTarget && store.set({ dialog: null })}>
      <div class="modal shortcuts">
        <div class="modal-head"><h2>Keyboard & mouse</h2><button class="icon-btn" onClick={() => store.set({ dialog: null })}><X size={18} /></button></div>
        <div class="modal-body">
          <div class="sc-grid">
            <div class="sc-group">Mouse</div>
            {MOUSE.map(([a, b]) => <div class="sc-row" key={a}><span>{a}</span><span style={{ color: 'var(--text-2)' }}>{b}</span></div>)}
            <div class="sc-group">Nudge</div>
            <div class="sc-row"><span>Move selection</span><Kbd k="Arrows" /></div>
            <div class="sc-row"><span>Move ×10</span><Kbd k="Shift+Arrows" /></div>
            <div class="sc-row"><span>Move up / down</span><Kbd k="PgUp+PgDn" /></div>
            <div class="sc-row"><span>Cancel / deselect</span><Kbd k="Esc" /></div>
            {groups.map((g) => {
              const cs = COMMANDS.filter((c) => c.group === g && c.key);
              if (!cs.length) return null;
              return [
                <div class="sc-group" key={g}>{g}</div>,
                ...cs.map((c) => <div class="sc-row" key={c.id}><span>{c.label}</span><Kbd k={c.key!} /></div>),
              ];
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

export function About() {
  const open = useStore((s) => s.dialog === 'about');
  if (!open) return null;
  return (
    <div class="modal-back" onClick={(e) => e.target === e.currentTarget && store.set({ dialog: null })}>
      <div class="modal about">
        <div class="modal-head"><div class="brand-mark">K</div><h2>KimaticPro</h2><button class="icon-btn" onClick={() => store.set({ dialog: null })}><X size={18} /></button></div>
        <div class="modal-body">
          <p><b>KimaticPro</b> is a free and open-source parametric 3D CAD app that runs in your browser. It mixes the simplicity of building with blocks with the power of professional history-based modelling: every step is kept in the timeline and can be edited at any time.</p>
          <p>Built with Three.js and three-bvh-csg. Licensed under the MIT license — use it, share it, remix it.</p>
          <div class="row-actions">
            <button class="btn small" onClick={() => store.set({ dialog: 'shortcuts' })}>Shortcuts</button>
            <button class="btn small" onClick={() => store.set({ dialog: 'tour', tourStep: 0 })}>Take the tour</button>
          </div>
        </div>
      </div>
    </div>
  );
}

const TOUR = [
  { sel: '[data-tour="shapes"]', title: 'Grab a shape', body: 'Open Shapes and click one — or drag it straight into the scene. Boxes, gears, hearts, text… it\'s all here.' },
  { sel: '.viewport', title: 'Move it around', body: 'Drag the coloured arrows to move. Drag empty space to orbit, right-drag to pan, scroll to zoom.' },
  { sel: '[data-tour="inspector"]', title: 'Change anything', body: 'Every size, colour and material lives here. Drag a label left/right to scrub a value. Set a shape to Hole to cut it out of others.' },
  { sel: '[data-tour="sketch"]', title: 'Sketch like a pro', body: 'Draw a 2D shape on any plane or face, then Extrude it into 3D. Type numbers while drawing for exact sizes.' },
  { sel: '[data-tour="timeline"]', title: 'Time travel', body: 'Every step is saved in the timeline. Click a step to edit it and everything after updates. Drag the orange marker to rewind.' },
  { sel: '.topbar .btn.primary', title: 'Make it real', body: 'Export an STL for your 3D printer, a GLB for games, or save the .kimatic file to keep editing later. Have fun!' },
];

export function Tour() {
  const s = useStore((s) => ({ open: s.dialog === 'tour', step: s.tourStep }));
  const [rect, setRect] = useState<DOMRect | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!s.open) return;
    const el = document.querySelector(TOUR[s.step].sel);
    setRect(el ? el.getBoundingClientRect() : null);
  }, [s.open, s.step]);
  if (!s.open) return null;
  const t = TOUR[s.step];
  const last = s.step === TOUR.length - 1;
  const close = () => store.set({ dialog: null });
  let left = 20, top = 80;
  if (rect) {
    left = Math.min(window.innerWidth - 340, Math.max(16, rect.left + rect.width / 2 - 160));
    top = rect.bottom + 14 + 200 < window.innerHeight ? rect.bottom + 14 : Math.max(16, rect.top - 200);
    if (rect.height > window.innerHeight * 0.5) {
      // tall targets (panels, viewport): sit beside them, or centred inside if there's no room
      top = rect.top + 60;
      if (rect.left > 360) left = rect.left - 340;
      else if (window.innerWidth - rect.right > 360) left = rect.right + 20;
      else left = rect.left + rect.width / 2 - 160;
    }
  }
  return <>
    {rect && <div class="tour-ring" style={{ left: rect.left - 4, top: rect.top - 4, width: rect.width + 8, height: rect.height + 8 }} />}
    <div class="tour" ref={ref} style={{ left, top }}>
      <h4><GraduationCap size={17} style={{ color: 'var(--accent)' }} /> {t.title}</h4>
      <p>{t.body}</p>
      <div class="t-foot">
        <div class="t-dots">{TOUR.map((_, i) => <i key={i} class={i === s.step ? 'on' : ''} />)}</div>
        <button class="btn small ghost" onClick={close}>Skip</button>
        {s.step > 0 && <button class="btn small" onClick={() => store.set({ tourStep: s.step - 1 })}>Back</button>}
        <button class="btn small primary" onClick={() => (last ? close() : store.set({ tourStep: s.step + 1 }))}>{last ? 'Let\'s go!' : 'Next'}</button>
      </div>
    </div>
  </>;
}

export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  return (
    <div class="toasts">
      {toasts.map((t) => (
        <div key={t.id} class={`toast ${t.kind}`}>
          {t.kind === 'success' ? <CircleCheck size={16} /> : t.kind === 'error' ? <CircleAlert size={16} /> : <Info size={16} />}
          {t.text}
        </div>
      ))}
    </div>
  );
}

export function PrintDialog() {
  const s = useStore((s) => ({ open: s.dialog === 'print', printerId: s.printerId, print: s.print, result: s.result }));
  const report = useMemo(
    () => (s.open ? analyzePrint(s.result.bodies, printerById(s.printerId), s.print) : null),
    [s.open, s.result, s.printerId, s.print],
  );
  if (!s.open || !report) return null;
  const close = () => store.set({ dialog: null });
  const size = report.extent.isEmpty() ? null : report.extent.getSize(new THREE.Vector3());
  const setPrint = (p: Partial<typeof s.print>) => store.set({ print: { ...s.print, ...p } });
  const icon = (l: string) => (l === 'ok' ? <CircleCheck size={16} style={{ color: 'var(--good)' }} /> : l === 'warn' ? <CircleAlert size={16} style={{ color: 'var(--warn)' }} /> : <CircleAlert size={16} style={{ color: 'var(--bad)' }} />);
  const h = Math.floor(report.hours), m = Math.round((report.hours - h) * 60);
  return (
    <div class="modal-back" onClick={(e) => e.target === e.currentTarget && close()}>
      <div class="modal print-dialog">
        <div class="modal-head"><Printer size={20} style={{ color: 'var(--accent)' }} /><h2>Ready to print?</h2><button class="icon-btn" onClick={close}><X size={18} /></button></div>
        <div class="modal-body">
          <div class="print-grid">
            <div>
              <div class="insp-title">Printer & settings</div>
              <div class="field"><label>Printer</label>
                <select class="select" value={s.printerId} onChange={(e) => store.set({ printerId: (e.currentTarget as HTMLSelectElement).value, showBed: true })}>
                  {PRINTERS.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </div>
              <div class="field"><label>Infill</label>
                <div class="slider-row"><input type="range" min={0} max={100} step={5} value={Math.round(s.print.infill * 100)} onInput={(e) => setPrint({ infill: Number((e.currentTarget as HTMLInputElement).value) / 100 })} /><span style={{ width: 38, textAlign: 'right' }}>{Math.round(s.print.infill * 100)}%</span></div>
              </div>
              <div class="field"><label>Layer height</label>
                <select class="select" value={String(s.print.layer)} onChange={(e) => setPrint({ layer: Number((e.currentTarget as HTMLSelectElement).value) })}>
                  {[0.08, 0.12, 0.16, 0.2, 0.24, 0.28].map((v) => <option key={v} value={v}>{v} mm{v === 0.2 ? ' (standard)' : v < 0.15 ? ' (fine)' : v > 0.22 ? ' (draft)' : ''}</option>)}
                </select>
              </div>
              <div class="stats" style={{ marginTop: 12 }}>
                <div class="stat" style={{ gridColumn: '1 / -1' }}><div class="k">Overall size</div><div class="v">{size ? `${size.x.toFixed(1)} × ${size.z.toFixed(1)} × ${size.y.toFixed(1)} mm` : '—'}</div></div>
                <div class="stat"><div class="k">Filament</div><div class="v">{report.grams.toFixed(1)} g · {report.meters.toFixed(2)} m</div></div>
                <div class="stat"><div class="k">Print time ≈</div><div class="v">{h ? `${h} h ` : ''}{m} min</div></div>
              </div>
              <p style={{ fontSize: 11, color: 'var(--text-3)', margin: '8px 0 0', lineHeight: 1.5 }}>Rough estimates for 1.75 mm filament with {s.print.walls} mm walls. Your slicer will give exact numbers.</p>
            </div>
            <div>
              <div class="insp-title">Checks</div>
              <div class="checks">
                {report.issues.map((i, k) => <div key={k} class={`check ${i.level}`}>{icon(i.level)}<span>{i.text}</span></div>)}
              </div>
              <div class="row-actions" style={{ marginTop: 12 }}>
                <button class="btn small" onClick={() => { runCmd('print.drop'); }}>Drop to bed</button>
                <button class="btn small" onClick={() => { runCmd('print.arrange'); }}>Arrange on bed</button>
                <button class="btn small" onClick={() => { close(); store.set({ mode: 'lay-flat' }); }}>Lay flat…</button>
                <button class={`btn small ${store.state.showOverhangs ? 'primary' : ''}`} onClick={() => runCmd('print.overhangs')}>Show overhangs</button>
              </div>
            </div>
          </div>
          <div class="print-foot">
            <span style={{ flex: 1, color: 'var(--text-3)', fontSize: 12 }}>3MF keeps exact millimetres, separate parts and colours. STL works everywhere.</span>
            <button class="btn" onClick={() => runCmd('export.stl')}><Download size={14} /> STL</button>
            <button class="btn primary" onClick={() => runCmd('export.3mf')}><Download size={14} /> Export 3MF</button>
          </div>
        </div>
      </div>
    </div>
  );
}

export function ParamsDialog() {
  const s = useStore((s) => ({ open: s.dialog === 'params', params: s.doc.params, vars: s.result.vars, errors: s.result.paramErrors, features: s.doc.features }));
  const [rows, setRows] = useState<{ name: string; expr: string; comment?: string }[]>([]);
  useEffect(() => { if (s.open) setRows(s.params?.length ? s.params.map((p) => ({ ...p })) : [{ name: 'wall', expr: '2', comment: 'Wall thickness' }]); }, [s.open]);
  if (!s.open) return null;
  const close = () => store.set({ dialog: null });
  const live = resolveParams(rows);
  const names = rows.map((r) => r.name);
  const dupes = new Set(names.filter((n, i) => names.indexOf(n) !== i));
  const invalid = rows.some((r) => !isValidName(r.name) || dupes.has(r.name) || live.errors[r.name]);
  const usage = (name: string) => s.features.filter((f) => Object.values(f.exprs ?? {}).some((e) => new RegExp(`\\b${name}\\b`).test(e))).length;
  const set = (i: number, patch: Partial<(typeof rows)[number]>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <div class="modal-back" onClick={(e) => e.target === e.currentTarget && close()}>
      <div class="modal params-dialog">
        <div class="modal-head"><Variable size={20} style={{ color: '#a855f7' }} /><h2>Parameters</h2><button class="icon-btn" onClick={close}><X size={18} /></button></div>
        <div class="modal-body">
          <p class="sub" style={{ margin: '0 0 12px', color: 'var(--text-2)', lineHeight: 1.5 }}>
            Give important sizes a name, then type that name (or a formula like <code>wall * 2</code>) into any size field. Change it here and every linked part updates — that's how pros make designs that adapt.
          </p>
          <div class="params-table">
            <div class="ph">Name</div><div class="ph">Value or formula</div><div class="ph">Result</div><div class="ph">Note</div><div />
            {rows.map((r, i) => {
              const bad = !isValidName(r.name) || dupes.has(r.name);
              const err = live.errors[r.name];
              return [
                <input key={`n${i}`} class={`text-input ${bad ? 'bad' : ''}`} value={r.name} onInput={(e) => set(i, { name: (e.currentTarget as HTMLInputElement).value.trim() })} onKeyDown={(e) => e.stopPropagation()} placeholder="name" />,
                <input key={`e${i}`} class={`text-input mono ${err ? 'bad' : ''}`} value={r.expr} onInput={(e) => set(i, { expr: (e.currentTarget as HTMLInputElement).value })} onKeyDown={(e) => e.stopPropagation()} placeholder="e.g. 40 or width / 2" />,
                <div key={`v${i}`} class="pv" title={err}>{err ? '⚠ ' + err : Number.isFinite(live.vars[r.name]) ? `${+live.vars[r.name].toFixed(4)}` : '—'}</div>,
                <input key={`c${i}`} class="text-input" value={r.comment ?? ''} onInput={(e) => set(i, { comment: (e.currentTarget as HTMLInputElement).value })} onKeyDown={(e) => e.stopPropagation()} placeholder={usage(r.name) ? `used ${usage(r.name)}×` : 'optional'} />,
                <button key={`d${i}`} class="mini-btn" onClick={() => setRows(rows.filter((_, j) => j !== i))} data-tip-title="Delete parameter"><X size={14} /></button>,
              ];
            })}
          </div>
          <div class="row-actions" style={{ marginTop: 10 }}>
            <button class="btn small" onClick={() => setRows([...rows, { name: `p${rows.length + 1}`, expr: '10' }])}>+ Add parameter</button>
          </div>
          <div class="print-foot">
            <span style={{ flex: 1, color: invalid ? 'var(--bad)' : 'var(--text-3)', fontSize: 12 }}>
              {invalid ? 'Fix the highlighted names or formulas first (letters, numbers and _ only; no duplicates).' : 'Formulas can use + − × ÷ ^, brackets, sqrt(), sin() (degrees), min(), max() and earlier parameters.'}
            </span>
            <button class="btn" onClick={close}>Cancel</button>
            <button class="btn primary" disabled={invalid} onClick={() => { setParams(rows.filter((r) => r.name)); close(); }}>Apply</button>
          </div>
        </div>
      </div>
    </div>
  );
}
