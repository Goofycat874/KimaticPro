import { useEffect, useRef } from 'preact/hooks';
import { useStore } from './hooks';
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
  const s = useStore((s) => ({ theme: s.theme, beginner: s.beginner }));
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => { host.current?.prepend(viewport.el); }, []);
  useEffect(() => {
    document.documentElement.dataset.theme = s.theme;
    viewport.applyTheme();
  }, [s.theme]);
  return (
    <div class={`app ${s.beginner ? 'beginner' : 'pro'}`}>
      <TopBar />
      <Ribbon />
      <div class="main">
        <Browser />
        <div class="vp-wrap" ref={host}>
          <ViewportOverlay />
        </div>
        <Inspector />
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
