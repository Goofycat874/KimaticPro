import { useEffect, useRef } from 'preact/hooks';
import { useIsMobile, useStore } from './hooks';
import { store } from '../core/store';
import { TopBar } from './TopBar';
import { Ribbon } from './Ribbon';
import { Browser } from './Browser';
import { Inspector } from './Inspector';
import { Timeline } from './Timeline';
import { StatusBar } from './StatusBar';
import { ViewportOverlay } from './ViewportOverlay';
import { About, CommandPalette, ParamsDialog, PrintDialog, Shortcuts, Toasts, Tour, Welcome } from './Dialogs';
import { TooltipLayer } from './controls';
import type { Viewport } from '../viewport/Viewport';

export function App({ viewport }: { viewport: Viewport }) {
  const s = useStore((s) => ({ theme: s.theme, beginner: s.beginner, sheet: s.sheet }));
  const mobile = useIsMobile();
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => { host.current?.prepend(viewport.el); }, []);
  useEffect(() => {
    document.documentElement.dataset.theme = s.theme;
    viewport.applyTheme();
  }, [s.theme]);
  return (
    <div class={`app ${s.beginner && !mobile ? 'beginner' : 'pro'} ${mobile ? 'mobile' : ''} ${mobile && s.sheet ? `show-${s.sheet}` : ''}`}>
      <TopBar />
      <Ribbon />
      <div class="main">
        <Browser />
        <div class="vp-wrap" ref={host}>
          <ViewportOverlay />
        </div>
        <Inspector />
        {mobile && s.sheet && <div class="sheet-backdrop" onClick={() => store.set({ sheet: null })} />}
      </div>
      <Timeline />
      <StatusBar />
      <Welcome />
      <CommandPalette />
      <Shortcuts />
      <About />
      <PrintDialog />
      <ParamsDialog />
      <Tour />
      <Toasts />
      <TooltipLayer />
    </div>
  );
}
