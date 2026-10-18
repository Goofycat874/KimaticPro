import { useEffect, useMemo, useState } from 'preact/hooks';
import { X, FileText, Download, Printer, LoaderCircle, TriangleAlert } from 'lucide-preact';
import { store } from '../core/store';
import { kernel } from '../kernel/client';
import type { DrawingPayload } from '../kernel/protocol';
import { SHEETS, layoutSheet, scaleLabel, sheetToDXF, sheetToPDF, sheetToSVG, type SheetOptions, type SheetSize } from '../core/drawingSheet';
import { materialById } from '../core/materials';
import { download } from '../core/io';
import { useStore } from './hooks';
import { Field, Segmented, Toggle } from './controls';

const SCALES: [string, number | 'auto'][] = [
  ['Auto', 'auto'], ['10:1', 10], ['5:1', 5], ['2:1', 2], ['1:1', 1], ['1:2', 0.5], ['1:5', 0.2], ['1:10', 0.1], ['1:20', 0.05], ['1:50', 0.02], ['1:100', 0.01],
];

const remembered = (): string => { try { return localStorage.getItem('kimatic.drawnBy') ?? ''; } catch { return ''; } };
const remember = (v: string) => { try { localStorage.setItem('kimatic.drawnBy', v); } catch { /* private mode */ } };
const fileBase = () => (store.doc.name || 'drawing').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-') || 'drawing';

export function DrawingDialog() {
  const open = useStore((s) => s.dialog === 'drawing');
  return open ? <DrawingInner /> : null;
}

function DrawingInner() {
  const close = () => store.set({ dialog: null });
  const selection = store.state.selection;
  const [proj, setProj] = useState<DrawingPayload | null>(null);
  const [error, setError] = useState('');
  const [o, setO] = useState<SheetOptions>(() => ({
    size: 'A4', angle: 'third', views: { front: true, top: true, right: true, iso: true }, hidden: true, dims: true, centerMarks: true,
    scale: 'auto', title: store.doc.name || 'Untitled', author: remembered(), material: '', date: new Date().toISOString().slice(0, 10),
  }));
  const set = (patch: Partial<SheetOptions>) => setO((x) => ({ ...x, ...patch }));

  useEffect(() => {
    kernel.drawing(store.doc, selection.length ? selection : null, ['front', 'top', 'right', 'iso'])
      .then((p) => {
        setProj(p);
        if (p.materials.length === 1) set({ material: materialById(p.materials[0]).label });
      })
      .catch((e) => setError(e.message));
  }, []);

  const sheet = useMemo(() => (proj && Object.keys(proj.views).length ? layoutSheet(proj.views, o) : null), [proj, o]);
  const svg = useMemo(() => (sheet ? sheetToSVG(sheet) : ''), [sheet]);

  const exportPDF = () => sheet && download(new Blob([sheetToPDF(sheet) as BlobPart], { type: 'application/pdf' }), `${fileBase()}.pdf`);
  const exportSVG = () => svg && download(new Blob([svg], { type: 'image/svg+xml' }), `${fileBase()}.svg`);
  const exportDXF = () => {
    if (!proj) return;
    // DXF goes out at true 1:1 size without the border, ready for CAD, laser cutters and CNC
    const flat = layoutSheet(proj.views, { ...o, scale: 1, frame: false });
    download(new Blob([sheetToDXF(flat)], { type: 'application/dxf' }), `${fileBase()}.dxf`);
  };
  const print = () => {
    if (!sheet) return;
    const frame = document.createElement('iframe');
    frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0';
    document.body.appendChild(frame);
    const d = frame.contentDocument!;
    d.open();
    d.write(`<!doctype html><html><head><title>${o.title}</title><style>@page{size:${sheet.w}mm ${sheet.h}mm;margin:0}html,body{margin:0}svg{display:block;width:${sheet.w}mm;height:${sheet.h}mm}</style></head><body>${svg}</body></html>`);
    d.close();
    setTimeout(() => { frame.contentWindow?.print(); setTimeout(() => frame.remove(), 1000); }, 150);
  };

  const view = (k: 'top' | 'right' | 'iso', label: string) => (
    <label class="view-check"><Toggle value={o.views[k]} onChange={(v) => set({ views: { ...o.views, [k]: v } })} label={label} /> {label}</label>
  );

  return (
    <div class="modal-back" onClick={(e) => e.target === e.currentTarget && close()}>
      <div class="modal drawing-dialog">
        <div class="modal-head">
          <FileText size={20} style={{ color: 'var(--accent)' }} />
          <h2>Technical drawing</h2>
          <span class="drawing-sub">{selection.length ? `${selection.length} selected bod${selection.length > 1 ? 'ies' : 'y'}` : 'Whole design'}</span>
          <button class="icon-btn" onClick={close}><X size={18} /></button>
        </div>
        <div class="modal-body drawing-grid">
          <div class="sheet-preview" style={{ aspectRatio: `${SHEETS[o.size][0]} / ${SHEETS[o.size][1]}` }}>
            {!proj && !error && <div class="sheet-wait"><LoaderCircle size={22} class="spin" /> Projecting exact views…</div>}
            {error && <div class="sheet-wait"><TriangleAlert size={20} /> {error}</div>}
            {proj && !sheet && <div class="sheet-wait"><TriangleAlert size={20} /> Nothing to draw — threads, bolts and STL meshes can’t be projected precisely.</div>}
            {svg && <div class="sheet-svg" dangerouslySetInnerHTML={{ __html: svg }} />}
          </div>
          <div class="drawing-opts">
            <Field label="Title"><input class="text-input" value={o.title} onInput={(e) => set({ title: e.currentTarget.value })} /></Field>
            <Field label="Drawn by"><input class="text-input" value={o.author} placeholder="Your name" onInput={(e) => { set({ author: e.currentTarget.value }); remember(e.currentTarget.value); }} /></Field>
            <Field label="Material"><input class="text-input" value={o.material} onInput={(e) => set({ material: e.currentTarget.value })} /></Field>
            <Field label="Sheet">
              <select class="select" value={o.size} onChange={(e) => set({ size: e.currentTarget.value as SheetSize })}>
                {Object.keys(SHEETS).map((k) => <option key={k} value={k}>{k} landscape</option>)}
              </select>
            </Field>
            <Field label="Scale" tip="Auto picks the largest standard scale that fits the sheet.">
              <select class="select" value={String(o.scale)} onChange={(e) => { const v = e.currentTarget.value; set({ scale: v === 'auto' ? 'auto' : Number(v) }); }}>
                {SCALES.map(([l, v]) => <option key={l} value={String(v)}>{v === 'auto' && sheet ? `Auto (${scaleLabel(sheet.scale)})` : l}</option>)}
              </select>
            </Field>
            <Field label="Projection" tip="Third angle (US, UK) puts the top view above the front. First angle (Europe, ISO) puts it below.">
              <Segmented value={o.angle} onChange={(v) => set({ angle: v })} options={[{ value: 'third', label: 'Third angle' }, { value: 'first', label: 'First angle' }]} />
            </Field>
            <Field label="Views" stack>
              <div class="view-checks">{view('top', 'Top')}{view('right', 'Right')}{view('iso', 'Isometric')}</div>
            </Field>
            <Field label="Hidden lines"><Toggle value={o.hidden} onChange={(v) => set({ hidden: v })} /></Field>
            <Field label="Dimensions"><Toggle value={o.dims} onChange={(v) => set({ dims: v })} /></Field>
            <Field label="Centre marks"><Toggle value={o.centerMarks} onChange={(v) => set({ centerMarks: v })} /></Field>
            {sheet && !sheet.fits && <div class="hint-box warn"><TriangleAlert size={15} /><span>The views don’t fit this sheet at {scaleLabel(sheet.scale)}. Pick a bigger sheet or a smaller scale.</span></div>}
            {proj && proj.skipped.length > 0 && <div class="hint-box warn"><TriangleAlert size={15} /><span>Left out (mesh only): {proj.skipped.join(', ')}.</span></div>}
            <div class="drawing-actions">
              <button class="btn primary" disabled={!sheet} onClick={exportPDF}><Download size={15} /> PDF</button>
              <button class="btn" disabled={!sheet} onClick={exportSVG}>SVG</button>
              <button class="btn" disabled={!sheet} onClick={exportDXF} data-tip-title="DXF at 1:1" data-tip-desc="True-size views for CAD, laser cutters and CNC — no border.">DXF</button>
              <button class="btn" disabled={!sheet} onClick={print}><Printer size={15} /> Print</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
