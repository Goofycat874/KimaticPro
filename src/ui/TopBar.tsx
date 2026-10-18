import { useRef, useState } from 'preact/hooks';
import { ChevronDown, CircleQuestionMark, Moon, Search, Sun, Undo2, Redo2, Save, Menu, Download, PanelLeft, PanelRight } from 'lucide-preact';
import { store } from '../core/store';
import { useClickOutside, useStore } from './hooks';
import { cmd, runCmd } from './commands';
import { Kbd } from './controls';

function MenuButton(props: { label: any; items: (string | '-')[]; align?: 'right'; tipTitle?: string; tipDesc?: string; cls?: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useClickOutside(ref, () => setOpen(false), open);
  return (
    <div class="menu-wrap" ref={ref}>
      <button class={`icon-btn labelled ${props.cls ?? ''} ${open ? 'active' : ''}`} onClick={() => setOpen(!open)} data-tip-title={props.tipTitle} data-tip-desc={props.tipDesc}>
        {props.label}
      </button>
      {open && (
        <div class={`dropdown ${props.align === 'right' ? 'right' : ''}`}>
          {props.items.map((id, i) => {
            if (id === '-') return <div class="menu-sep" key={i} />;
            const c = cmd(id);
            const Icon = c.icon;
            const enabled = !c.enabled || c.enabled();
            return (
              <button key={id} class="menu-item" disabled={!enabled} onClick={() => { setOpen(false); c.run(); }}>
                <Icon size={15} />
                <span class="grow">{c.label}</span>
                {c.key && <Kbd k={c.key} />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function TopBar() {
  const s = useStore((s) => ({ name: s.doc.name, dirty: s.dirty, canUndo: s.canUndo, canRedo: s.canRedo, theme: s.theme, beginner: s.beginner }));
  const [panels, setPanels] = useState({ left: true, right: true });
  const togglePanel = (side: 'left' | 'right') => {
    const next = { ...panels, [side]: !panels[side] };
    setPanels(next);
    document.querySelector('.app')?.classList.toggle(`${side}-collapsed`, !next[side]);
  };
  return (
    <header class="topbar">
      <div class="brand">
        <div class="brand-mark">K</div>
        <div class="brand-name">Kimatic<span>Pro</span></div>
      </div>
      <MenuButton label={<><Menu size={16} /> File <ChevronDown size={13} /></>}
        items={['file.new', 'file.open', 'file.save', '-', 'file.import', '-', 'print.check', 'export.3mf', 'export.stl', 'export.obj', 'export.glb', 'export.png']} />
      <MenuButton label={<>Edit <ChevronDown size={13} /></>}
        items={['edit.undo', 'edit.redo', '-', 'edit.copy', 'edit.paste', 'edit.duplicate', 'edit.delete', '-', 'edit.selectAll']} />
      <MenuButton label={<>View <ChevronDown size={13} /></>}
        items={['view.home', 'view.fit', '-', 'view.top', 'view.front', 'view.right', 'view.ortho', '-', 'view.grid', 'inspect.ghosts', 'view.isolate', 'view.showAll', '-', 'view.theme']} />
      <MenuButton label={<>Help <ChevronDown size={13} /></>}
        items={['help.tour', 'help.shortcuts', 'help.palette', '-', 'help.beginner']} />
      <div class="sep" style={{ width: 1, height: 22, background: 'var(--line)', margin: '0 4px' }} />
      <button class="icon-btn" disabled={!s.canUndo} onClick={() => store.undo()} data-tip-title={s.canUndo ? `Undo ${s.canUndo}` : 'Undo'} data-tip-key="Ctrl+Z"><Undo2 size={17} /></button>
      <button class="icon-btn" disabled={!s.canRedo} onClick={() => store.redo()} data-tip-title={s.canRedo ? `Redo ${s.canRedo}` : 'Redo'} data-tip-key="Ctrl+Y"><Redo2 size={17} /></button>

      <div class="spacer" />
      <input class="doc-name" value={s.name} size={Math.max(10, s.name.length)}
        onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur(); }}
        onBlur={(e) => {
          const v = (e.currentTarget as HTMLInputElement).value.trim() || 'Untitled design';
          if (v !== store.doc.name) store.commit('Rename design', (d) => { d.name = v; });
        }}
        data-tip-title="Design name" data-tip-desc="Click to rename your design." />
      {s.dirty && <span class="dirty-dot" data-tip-title="Unsaved changes" data-tip-desc="Your work is auto-saved in this browser. Use Save to download a file." />}
      <div class="spacer" />

      <button class="icon-btn labelled" onClick={() => store.set({ palette: true })} data-tip-title="Search commands" data-tip-desc="Find any tool by name." data-tip-key="Ctrl+P">
        <Search size={15} /> <span style={{ color: 'var(--text-3)' }}>Search tools…</span> <Kbd k="Ctrl+P" />
      </button>
      <button class={`icon-btn labelled ${s.beginner ? 'active' : ''}`} onClick={() => runCmd('help.beginner')}
        data-tip-title={s.beginner ? 'Beginner mode is on' : 'Pro mode is on'} data-tip-desc={cmd('help.beginner').desc}>
        {s.beginner ? 'Beginner' : 'Pro'}
      </button>
      <button class="icon-btn" onClick={() => togglePanel('left')} data-tip-title="Toggle browser panel"><PanelLeft size={17} /></button>
      <button class="icon-btn" onClick={() => togglePanel('right')} data-tip-title="Toggle properties panel"><PanelRight size={17} /></button>
      <button class="icon-btn" onClick={() => runCmd('view.theme')} data-tip-title="Dark / light theme">{s.theme === 'dark' ? <Moon size={17} /> : <Sun size={17} />}</button>
      <button class="icon-btn" onClick={() => store.set({ dialog: 'about' })} data-tip-title="About KimaticPro"><CircleQuestionMark size={17} /></button>
      <button class="btn primary small" onClick={() => runCmd('print.check')} data-tip-title="Print it" data-tip-desc="Check your design is printable, then export a 3MF or STL for your slicer." data-tip-key="P">
        <Download size={14} /> Print / Export
      </button>
      <button class="btn small" onClick={() => runCmd('file.save')} data-tip-title="Save design" data-tip-key="Ctrl+S"><Save size={14} /> Save</button>
    </header>
  );
}
