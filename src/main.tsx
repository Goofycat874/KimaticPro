import { render } from 'preact';
import './styles/app.css';
import { store } from './core/store';
import { openFile } from './core/io';
import { Viewport } from './viewport/Viewport';
import { App } from './ui/App';
import { installKeyboard } from './ui/keyboard';
import { runCmd } from './ui/commands';

const viewport = new Viewport();
installKeyboard((e) => viewport.handleKey(e));

// drop design files / meshes anywhere on the window to open them
window.addEventListener('dragover', (e) => { if (e.dataTransfer?.types.includes('Files')) e.preventDefault(); });
window.addEventListener('drop', (e) => {
  const f = e.dataTransfer?.files?.[0];
  if (f) { e.preventDefault(); openFile(f); }
});
window.addEventListener('beforeunload', (e) => {
  if (store.state.dirty && store.doc.features.length) e.preventDefault();
});

render(<App viewport={viewport} />, document.getElementById('app')!);

// handy for debugging and for automation
(window as any).kimatic = { store, viewport, run: runCmd };
