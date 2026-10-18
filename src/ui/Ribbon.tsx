import { useEffect, useRef, useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import { ChevronDown, Shapes, Check, ArrowUpFromLine, RotateCw, Trash2, AlignCenterHorizontal, Magnet } from 'lucide-preact';
import { store } from '../core/store';
import { align, addShape } from '../core/actions';
import { SHAPES, type ShapeCategory } from '../core/primitives';
import { shapeThumbnail } from '../viewport/thumbnails';
import { PRINTERS, printerById } from '../core/printing';
import { useClickOutside, useStore } from './hooks';
import { cmd } from './commands';

function Tool(props: { id: string; hero?: boolean; cls?: string; label?: string }) {
  useStore((s) => [s.selection, s.mode, s.sketchTool, s.gizmo, s.section, s.showGhosts, s.canUndo, s.selectedFeature, s.projection, s.showGrid, s.sketchSelection]);
  const c = cmd(props.id);
  const Icon = c.icon;
  const enabled = !c.enabled || c.enabled();
  return (
    <button class={`tool ${props.hero ? 'hero' : ''} ${c.active?.() ? 'active' : ''} ${props.cls ?? ''}`} disabled={!enabled} onClick={c.run}
      data-tip-title={c.label} data-tip-desc={c.desc} data-tip-key={c.key}>
      <span class="tool-icon"><Icon size={props.hero ? 19 : 21} /></span>
      <span class="tool-label">{props.label ?? c.label}</span>
    </button>
  );
}

function Group(props: { label: string; children: ComponentChildren }) {
  return (
    <div class="rgroup">
      <div class="rgroup-items">{props.children}</div>
      <div class="rgroup-label">{props.label}</div>
    </div>
  );
}

export function ShapeGallery(props: { onPick?: () => void; onDrag?: (dragging: boolean) => void }) {
  const cats: ShapeCategory[] = ['Basic', 'Fun', 'Mechanical', 'Hardware'];
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  useEffect(() => {
    // render thumbnails lazily so the menu opens instantly
    let i = 0;
    const next = () => {
      if (i >= SHAPES.length) return;
      const s = SHAPES[i++];
      setThumbs((t) => ({ ...t, [s.id]: shapeThumbnail(s.id) }));
      requestAnimationFrame(next);
    };
    next();
  }, []);
  return (
    <div class="gallery">
      {cats.map((cat) => (
        <div key={cat}>
          <div class="gallery-cat">{cat === 'Basic' ? 'Basic shapes' : cat === 'Fun' ? 'Fun shapes' : cat === 'Hardware' ? 'Hardware & printing' : 'Mechanical'}</div>
          <div class="gallery-grid">
            {SHAPES.filter((s) => s.category === cat).map((s) => (
              <div key={s.id} class="shape-card" draggable
                onDragStart={(e) => { e.dataTransfer!.setData('text/kimatic-shape', s.id); e.dataTransfer!.effectAllowed = 'copy'; props.onDrag?.(true); }}
                onDragEnd={() => { props.onDrag?.(false); props.onPick?.(); }}
                onClick={() => { addShape(s.id); props.onPick?.(); }}
                data-tip-title={s.label} data-tip-desc={`${s.description} Click to add, or drag into the scene.`}>
                {thumbs[s.id] ? <img src={thumbs[s.id]} alt="" /> : <div style={{ width: 58, height: 58 }} />}
                <span>{s.label}</span>
              </div>
            ))}
          </div>
        </div>
      ))}
      <div class="gallery-foot">Tip: drag a shape onto another shape's top face to stack it.</div>
    </div>
  );
}

/** Ribbon menus open in fixed position so the scrolling ribbon never clips them. */
function useAnchor(ref: { current: HTMLElement | null }, width: number) {
  const [pos, setPos] = useState({ left: 0, top: 0 });
  const place = () => {
    const r = ref.current!.getBoundingClientRect();
    setPos({ left: Math.max(8, Math.min(r.left, window.innerWidth - width - 8)), top: r.bottom + 6 });
  };
  return { pos, place };
}

function ShapesButton() {
  const [open, setOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useClickOutside(ref, () => setOpen(false), open);
  const { pos, place } = useAnchor(ref, 550);
  return (
    <div class="menu-wrap" ref={ref} data-tour="shapes">
      <button class={`tool hero ${open ? 'active' : ''}`} onClick={() => { place(); setOpen(!open); }}
        data-tip-title="Shapes" data-tip-desc="Every ready-made shape: boxes, gears, stars, hearts, text and more.">
        <span class="tool-icon"><Shapes size={19} /></span>
        <span class="tool-label">Shapes <ChevronDown size={10} /></span>
      </button>
      {open && (
        // fade out (but keep mounted) while dragging so the drag isn't cancelled and the drop lands in the scene
        <div class="dropdown" style={{ position: 'fixed', ...pos, opacity: dragging ? 0 : 1, pointerEvents: dragging ? 'none' : undefined }}>
          <ShapeGallery onPick={() => setOpen(false)} onDrag={setDragging} />
        </div>
      )}
    </div>
  );
}

function DropTool(props: { icon: any; label: string; desc: string; items: { label: string; run: () => void }[] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useClickOutside(ref, () => setOpen(false), open);
  const { pos, place } = useAnchor(ref, 240);
  const Icon = props.icon;
  return (
    <div class="menu-wrap" ref={ref}>
      <button class={`tool ${open ? 'active' : ''}`} onClick={() => { place(); setOpen(!open); }} data-tip-title={props.label} data-tip-desc={props.desc}>
        <span class="tool-icon"><Icon size={21} /></span>
        <span class="tool-label">{props.label}</span>
        <ChevronDown size={10} class="caret" />
      </button>
      {open && (
        <div class="dropdown" style={{ position: 'fixed', ...pos }}>
          {props.items.map((it) => it.label === '-'
            ? <div class="menu-sep" />
            : <button key={it.label} class="menu-item" onClick={() => { setOpen(false); it.run(); }}>{it.label}</button>)}
        </div>
      )}
    </div>
  );
}

function SketchRibbon() {
  const s = useStore((s) => ({ sides: s.polygonSides, tool: s.sketchTool, snap: s.snap, sel: s.sketchSelection.length }));
  return (
    <div class="ribbon-body">
      <Group label="Draw">
        <Tool id="sketch.select" />
        <Tool id="sketch.line" />
        <Tool id="sketch.rect" />
        <Tool id="sketch.crect" />
        <Tool id="sketch.circle" />
        <Tool id="sketch.polygon" />
        <Tool id="sketch.slot" />
        <Tool id="sketch.spline" />
      </Group>
      {s.tool === 'polygon' && (
        <Group label="Polygon">
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '0 6px' }}>
            <span class="tool-label">Sides</span>
            <input type="range" min={3} max={16} value={s.sides} style={{ width: 90 }}
              onInput={(e) => store.set({ polygonSides: Number((e.currentTarget as HTMLInputElement).value) })} />
            <b style={{ width: 18 }}>{s.sides}</b>
          </div>
        </Group>
      )}
      <Group label="Edit">
        <button class="tool" disabled={!s.sel} onClick={() => cmd('edit.delete').run()} data-tip-title="Delete" data-tip-desc="Delete the selected sketch shapes." data-tip-key="Delete">
          <span class="tool-icon"><Trash2 size={21} /></span><span class="tool-label">Delete</span>
        </button>
        <button class={`tool ${s.snap ? 'active' : ''}`} onClick={() => store.set({ snap: s.snap ? 0 : 1 })} data-tip-title="Snap to grid" data-tip-desc="Points jump to the grid so sizes come out neat.">
          <span class="tool-icon"><Magnet size={21} /></span><span class="tool-label">Snap</span>
        </button>
      </Group>
      <Group label="Make 3D">
        <button class="tool good-tool" onClick={() => cmd('create.extrude').run()} data-tip-title="Extrude" data-tip-desc="Finish the sketch and pull it up into a solid.">
          <span class="tool-icon"><ArrowUpFromLine size={21} /></span><span class="tool-label">Extrude</span>
        </button>
        <button class="tool good-tool" onClick={() => cmd('create.revolve').run()} data-tip-title="Revolve" data-tip-desc="Finish the sketch and spin it around its vertical axis.">
          <span class="tool-icon"><RotateCw size={21} /></span><span class="tool-label">Revolve</span>
        </button>
      </Group>
      <Group label="Exit">
        <button class="tool good-tool" onClick={() => cmd('sketch.finish').run()} data-tip-title="Finish sketch" data-tip-key="Enter" data-tip-desc="Leave sketch mode.">
          <span class="tool-icon"><Check size={22} /></span><span class="tool-label">Finish</span>
        </button>
      </Group>
    </div>
  );
}

function PrinterPicker() {
  const id = useStore((s) => s.printerId);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: '0 6px', justifyContent: 'center' }}
      data-tip-title="Your printer" data-tip-desc="Sets the bed size used for the bed outline and the print check.">
      <select class="select" style={{ width: 190 }} value={id} onChange={(e) => store.set({ printerId: (e.currentTarget as HTMLSelectElement).value, showBed: true })}>
        {PRINTERS.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
      </select>
      <span class="tool-label" style={{ textAlign: 'center' }}>{(() => { const p = printerById(id); return `${p.x} × ${p.z} × ${p.y} mm`; })()}</span>
    </div>
  );
}

type Tab = 'create' | 'modify' | 'inspect' | 'print' | 'output';

export function Ribbon() {
  const mode = useStore((s) => s.mode);
  const [tab, setTab] = useState<Tab>('create');
  const sketching = mode === 'sketch';
  const tabs: [Tab, string][] = [['create', 'Create'], ['modify', 'Modify'], ['inspect', 'Inspect'], ['print', 'Print'], ['output', 'Output']];
  return (
    <div class="ribbon" data-tour="ribbon">
      <div class="ribbon-tabs">
        {sketching
          ? <button class="ribbon-tab sketch-tab active">SKETCH</button>
          : tabs.map(([id, label]) => (
            <button key={id} class={`ribbon-tab ${tab === id ? 'active' : ''}`} onClick={() => setTab(id)}>{label.toUpperCase()}</button>
          ))}
      </div>
      {sketching ? <SketchRibbon /> : (
        <div class="ribbon-body">
          {tab === 'create' && <>
            <Group label="Shapes">
              <ShapesButton />
              <Tool id="create.box" />
              <Tool id="create.cylinder" />
              <Tool id="create.sphere" />
              <Tool id="create.cone" />
              <Tool id="create.torus" />
              <Tool id="create.text" label="Text" />
            </Group>
            <Group label="Sketch & build">
              <div data-tour="sketch" style={{ display: 'flex' }}><Tool id="create.sketch" /></div>
              <Tool id="create.extrude" />
              <Tool id="create.revolve" />
            </Group>
            <Group label="Combine">
              <Tool id="modify.join" cls="good-tool" />
              <Tool id="modify.cut" cls="hole-tool" />
              <Tool id="modify.hole" cls="hole-tool" />
            </Group>
            <Group label="Copy">
              <Tool id="edit.duplicate" />
              <Tool id="modify.pattern" />
              <Tool id="modify.mirror" />
            </Group>
          </>}
          {tab === 'modify' && <>
            <Group label="Transform">
              <Tool id="gizmo.translate" />
              <Tool id="gizmo.rotate" />
              <Tool id="gizmo.scale" />
            </Group>
            <Group label="Combine">
              <Tool id="modify.join" cls="good-tool" />
              <Tool id="modify.cut" cls="hole-tool" />
              <Tool id="modify.intersect" />
              <Tool id="modify.hole" cls="hole-tool" />
            </Group>
            <Group label="Repeat">
              <Tool id="modify.pattern" />
              <Tool id="modify.circular" label="Circular" />
              <Tool id="modify.mirror" />
              <Tool id="edit.duplicate" />
            </Group>
            <Group label="Arrange">
              <Tool id="arrange.drop" label="To ground" />
              <Tool id="arrange.center" />
              <DropTool icon={AlignCenterHorizontal} label="Align" desc="Line up two or more selected bodies."
                items={[
                  { label: 'Align left (X min)', run: () => align('x', 'min') },
                  { label: 'Align centre X', run: () => align('x', 'center') },
                  { label: 'Align right (X max)', run: () => align('x', 'max') },
                  { label: '-', run: () => {} },
                  { label: 'Align bottom (Y min)', run: () => align('y', 'min') },
                  { label: 'Align middle Y', run: () => align('y', 'center') },
                  { label: 'Align top (Y max)', run: () => align('y', 'max') },
                  { label: '-', run: () => {} },
                  { label: 'Align back (Z min)', run: () => align('z', 'min') },
                  { label: 'Align centre Z', run: () => align('z', 'center') },
                  { label: 'Align front (Z max)', run: () => align('z', 'max') },
                ]} />
            </Group>
            <Group label="Edit">
              <Tool id="edit.delete" />
            </Group>
          </>}
          {tab === 'inspect' && <>
            <Group label="Inspect">
              <Tool id="inspect.measure" />
              <Tool id="inspect.section" />
              <Tool id="inspect.ghosts" />
            </Group>
            <Group label="View">
              <Tool id="view.home" label="Home" />
              <Tool id="view.fit" label="Fit" />
              <Tool id="view.top" label="Top" />
              <Tool id="view.front" label="Front" />
              <Tool id="view.right" label="Right" />
              <Tool id="view.ortho" label="Ortho" />
              <Tool id="view.grid" />
            </Group>
            <Group label="Visibility">
              <Tool id="view.isolate" />
              <Tool id="view.showAll" />
            </Group>
          </>}
          {tab === 'print' && <>
            <Group label="Printer">
              <PrinterPicker />
              <Tool id="print.bed" label="Bed" />
            </Group>
            <Group label="Prepare">
              <Tool id="print.layflat" />
              <Tool id="print.drop" label="To bed" />
              <Tool id="print.arrange" label="Arrange" />
            </Group>
            <Group label="Check">
              <Tool id="print.overhangs" />
              <Tool id="print.check" label="Print check" />
            </Group>
            <Group label="Export">
              <Tool id="export.3mf" label="3MF" />
              <Tool id="export.stl" label="STL" />
            </Group>
          </>}
          {tab === 'output' && <>
            <Group label="Design file">
              <Tool id="file.new" label="New" />
              <Tool id="file.open" label="Open" />
              <Tool id="file.save" />
              <Tool id="file.import" label="Import" />
            </Group>
            <Group label="Export">
              <Tool id="export.3mf" label="3MF" />
              <Tool id="export.stl" label="STL" />
              <Tool id="export.obj" label="OBJ" />
              <Tool id="export.glb" label="GLB" />
              <Tool id="export.png" label="Image" />
            </Group>
          </>}
        </div>
      )}
    </div>
  );
}
