import type { ComponentType } from 'preact';
import {
  Box, Cylinder, Globe, Cone, Torus, Type, PenLine, ArrowUpFromLine, RotateCw, Move, Rotate3d, Scale3d,
  SquaresUnite, SquaresSubtract, SquaresIntersect, Repeat, Orbit, FlipHorizontal2, Copy, Trash2, ArrowDownToLine,
  Ruler, Scissors, Eye, Download, Save, FolderOpen, Image, FilePlus2, Undo2, Redo2, Focus, House, Search,
  Keyboard, Sun, Moon, GraduationCap, Grid3x3, Layers2, Spline, RectangleHorizontal, Circle, Hexagon, MousePointer2,
  Check, Upload, ScanEye, Crosshair, Diamond, SquareDashed, Pill, Ghost, Printer, BedDouble, PanelBottom, LayoutGrid,
  TriangleAlert, ClipboardCheck, Blend, SquareSplitVertical, Variable, SquareRoundCorner, PackageOpen, Triangle, FileBox,
} from 'lucide-preact';
import { store } from '../core/store';
import * as A from '../core/actions';
import { exportAs, pickFile, saveProject } from '../core/io';
import { printerById } from '../core/printing';

export interface Command {
  id: string;
  label: string;
  group: string;
  icon: ComponentType<any>;
  desc: string;
  key?: string;
  run: () => void;
  enabled?: () => boolean;
  active?: () => boolean;
  keywords?: string;
}

const hasSel = () => store.state.selection.length > 0;
const multi = () => store.state.selection.length > 1;
const inModel = () => store.state.mode !== 'sketch';
const shape = (id: string) => () => A.addShape(id);

export const COMMANDS: Command[] = [
  // file
  { id: 'file.new', label: 'New design', group: 'File', icon: FilePlus2, desc: 'Start a fresh, empty design.', key: 'Alt+N', run: () => store.set({ welcome: true }) },
  { id: 'file.open', label: 'Open…', group: 'File', icon: FolderOpen, desc: 'Open a .kimatic design, or import an STL / OBJ mesh.', key: 'Ctrl+O', run: () => pickFile() },
  { id: 'file.save', label: 'Save', group: 'File', icon: Save, desc: 'Download your design as a .kimatic file you can reopen and keep editing.', key: 'Ctrl+S', run: saveProject },
  { id: 'file.import', label: 'Import model', group: 'File', icon: Upload, desc: 'Bring in a STEP (exact CAD), STL or OBJ model from another app.', run: () => pickFile('.step,.stp,.stl,.obj'), keywords: 'step stp stl obj' },
  { id: 'export.stl', label: 'Export STL (3D print)', group: 'Export', icon: Download, desc: 'The standard file for 3D printers and slicers.', key: 'Ctrl+E', run: () => exportAs('stl'), keywords: 'print slicer cura prusa' },
  { id: 'export.3mf', label: 'Export 3MF (3D print)', group: 'Export', icon: Download, desc: 'The modern slicer format: exact millimetres, separate parts and colours. Best for Bambu, Prusa and Cura.', run: () => exportAs('3mf'), keywords: 'print slicer bambu orca prusa' },
  { id: 'export.step', label: 'Export STEP (CAD)', group: 'Export', icon: FileBox, desc: 'Exact solids for SolidWorks, Fusion, Onshape, FreeCAD and machine shops.', run: () => exportAs('step'), keywords: 'stp iso 10303 solidworks fusion onshape freecad cnc' },
  { id: 'export.obj', label: 'Export OBJ', group: 'Export', icon: Download, desc: 'Widely supported mesh format.', run: () => exportAs('obj') },
  { id: 'export.glb', label: 'Export GLB', group: 'Export', icon: Download, desc: 'glTF binary with colours — for games, AR and the web.', run: () => exportAs('glb'), keywords: 'gltf blender unity' },
  { id: 'export.png', label: 'Save image', group: 'Export', icon: Image, desc: 'Save a picture of the current view.', run: () => exportAs('png'), keywords: 'screenshot render picture' },

  // edit
  { id: 'edit.undo', label: 'Undo', group: 'Edit', icon: Undo2, desc: 'Take back the last change.', key: 'Ctrl+Z', run: () => store.undo(), enabled: () => !!store.state.canUndo },
  { id: 'edit.redo', label: 'Redo', group: 'Edit', icon: Redo2, desc: 'Bring back what you undid.', key: 'Ctrl+Y', run: () => store.redo(), enabled: () => !!store.state.canRedo },
  { id: 'edit.copy', label: 'Copy', group: 'Edit', icon: Copy, desc: 'Copy the selected bodies.', key: 'Ctrl+C', run: () => A.copySelection(), enabled: hasSel },
  { id: 'edit.paste', label: 'Paste', group: 'Edit', icon: Copy, desc: 'Paste copies of what you copied.', key: 'Ctrl+V', run: () => A.paste() },
  { id: 'edit.duplicate', label: 'Duplicate', group: 'Edit', icon: Copy, desc: 'Make a copy of the selected bodies.', key: 'Ctrl+D', run: () => A.duplicate(), enabled: hasSel },
  { id: 'edit.delete', label: 'Delete', group: 'Edit', icon: Trash2, desc: 'Remove the selection.', key: 'Delete', run: () => A.deleteSelection(), enabled: () => hasSel() || !!store.state.selectedFeature || store.state.sketchSelection.length > 0 },
  { id: 'edit.selectAll', label: 'Select all', group: 'Edit', icon: MousePointer2, desc: 'Select every visible body.', key: 'Ctrl+A', run: () => A.selectAll() },

  // create
  { id: 'create.box', label: 'Box', group: 'Create', icon: Box, desc: 'Add a box. Drag it from the Shapes gallery to drop it exactly where you want.', key: 'B', run: shape('box'), keywords: 'cube block' },
  { id: 'create.cylinder', label: 'Cylinder', group: 'Create', icon: Cylinder, desc: 'Add a cylinder — great for wheels, pegs and holes.', key: 'Y', run: shape('cylinder'), keywords: 'tube rod' },
  { id: 'create.sphere', label: 'Sphere', group: 'Create', icon: Globe, desc: 'Add a ball.', run: shape('sphere'), keywords: 'ball' },
  { id: 'create.cone', label: 'Cone', group: 'Create', icon: Cone, desc: 'Add a cone.', run: shape('cone') },
  { id: 'create.torus', label: 'Torus', group: 'Create', icon: Torus, desc: 'Add a donut-shaped ring.', run: shape('torus'), keywords: 'ring donut' },
  { id: 'create.capsule', label: 'Capsule', group: 'Create', icon: Pill, desc: 'Add a pill shape.', run: shape('capsule') },
  { id: 'create.text', label: '3D Text', group: 'Create', icon: Type, desc: 'Add 3D letters — type your name!', key: 'T', run: shape('text'), keywords: 'letters name font' },
  { id: 'create.sketch', label: 'Sketch', group: 'Create', icon: PenLine, desc: 'Draw a 2D shape on a plane or face, then Extrude or Revolve it into 3D. This is how pros make custom parts.', key: 'S', run: () => A.beginSketch(), keywords: 'draw 2d profile' },
  { id: 'create.extrude', label: 'Extrude', group: 'Create', icon: ArrowUpFromLine, desc: 'Pull a closed sketch shape up into a solid.', key: 'E', run: () => A.extrude(), keywords: 'push pull' },
  { id: 'create.revolve', label: 'Revolve', group: 'Create', icon: RotateCw, desc: 'Spin a sketch profile around an axis — vases, cups, wheels.', run: () => A.revolve(), keywords: 'lathe spin' },

  { id: 'create.loft', label: 'Loft', group: 'Create', icon: Blend, desc: 'Blend smoothly between two or more closed sketches on different planes or heights — vases, bottles, transitions.', run: () => A.addLoft(), keywords: 'blend transition morph' },
  { id: 'create.sweep', label: 'Sweep', group: 'Create', icon: Spline, desc: 'Move a closed shape along a path — pipes, handles, rails, springs (with twist).', run: () => A.addSweep(), keywords: 'pipe path tube follow' },

  // modify
  { id: 'gizmo.translate', label: 'Move', group: 'Modify', icon: Move, desc: 'Drag the arrows to move the selection. Arrow keys nudge it.', key: 'G', run: () => store.set({ gizmo: 'translate' }), active: () => store.state.gizmo === 'translate' },
  { id: 'gizmo.rotate', label: 'Rotate', group: 'Modify', icon: Rotate3d, desc: 'Drag the rings to spin the selection (snaps to 15°).', key: 'R', run: () => store.set({ gizmo: 'rotate' }), active: () => store.state.gizmo === 'rotate' },
  { id: 'gizmo.scale', label: 'Scale', group: 'Modify', icon: Scale3d, desc: 'Drag the handles to stretch or shrink the selection.', key: 'X', run: () => store.set({ gizmo: 'scale' }), active: () => store.state.gizmo === 'scale' },
  { id: 'modify.join', label: 'Join', group: 'Modify', icon: SquaresUnite, desc: 'Merge selected bodies into one. The first one you picked keeps its colour.', key: 'Ctrl+J', run: () => A.combine('join'), enabled: multi, keywords: 'union merge group combine' },
  { id: 'modify.cut', label: 'Cut', group: 'Modify', icon: SquaresSubtract, desc: 'Carve the other selected bodies out of the first one. Perfect for holes.', key: 'Ctrl+K', run: () => A.combine('cut'), enabled: multi, keywords: 'subtract hole difference' },
  { id: 'modify.intersect', label: 'Intersect', group: 'Modify', icon: SquaresIntersect, desc: 'Keep only where the selected bodies overlap.', run: () => A.combine('intersect'), enabled: multi, keywords: 'common overlap' },
  { id: 'modify.hole', label: 'Make hole', group: 'Modify', icon: Ghost, desc: 'Turn the selected shape into a hole that cuts whatever it touches.', key: 'H', run: () => { const b = A.selectionBodies()[0]; if (b?.editableFeatureId) A.setBodyOp(b.editableFeatureId, 'cut'); }, enabled: () => store.state.selection.length === 1 && !!A.bodyById(store.state.selection[0])?.editableFeatureId, keywords: 'cut subtract' },
  { id: 'modify.pattern', label: 'Pattern', group: 'Modify', icon: Repeat, desc: 'Repeat the selection in a row.', run: () => A.addPattern('linear'), enabled: hasSel, keywords: 'array repeat copy row' },
  { id: 'modify.circular', label: 'Circular pattern', group: 'Modify', icon: Orbit, desc: 'Repeat the selection around a circle.', run: () => A.addPattern('circular'), enabled: hasSel, keywords: 'array radial' },
  { id: 'modify.mirror', label: 'Mirror', group: 'Modify', icon: FlipHorizontal2, desc: 'Make a mirror-image copy across a plane.', key: 'M', run: () => A.addMirror(), enabled: hasSel, keywords: 'flip symmetry' },
  { id: 'modify.fillet', label: 'Fillet', group: 'Modify', icon: SquareRoundCorner, desc: 'Round off edges. Click the edges you want, set the radius, then Apply. With a body selected and no edges picked, every edge is rounded.', run: () => A.beginPick('fillet'), keywords: 'round radius blend edge' },
  { id: 'modify.chamfer', label: 'Chamfer', group: 'Modify', icon: Diamond, desc: 'Bevel edges with a flat 45° cut. Click the edges, set the distance, then Apply.', run: () => A.beginPick('chamfer'), keywords: 'bevel edge' },
  { id: 'modify.shell', label: 'Shell', group: 'Modify', icon: PackageOpen, desc: 'Hollow a body out with an even wall. Click the faces to remove (open), or just Apply to open the top.', run: () => A.beginPick('shell'), keywords: 'hollow wall thickness cup' },
  { id: 'modify.draft', label: 'Draft', group: 'Modify', icon: Triangle, desc: 'Taper faces by an angle (from the bottom) so moulded or cast parts release easily.', run: () => A.beginPick('draft'), keywords: 'taper angle mould cast' },
  { id: 'modify.split', label: 'Split body', group: 'Modify', icon: SquareSplitVertical, desc: 'Cut a body into two parts with a plane — print big things in pieces.', run: () => A.addSplit(), enabled: () => store.state.selection.length === 1, keywords: 'cut half divide plane' },
  { id: 'modify.params', label: 'Parameters', group: 'Modify', icon: Variable, desc: 'Name your key sizes (like wall = 2) and use them in any field: type “wall * 2”. Change one number, the whole design updates.', run: () => store.set({ dialog: 'params' }), keywords: 'variables formula expression dimension' },
  { id: 'arrange.drop', label: 'Drop to ground', group: 'Arrange', icon: ArrowDownToLine, desc: 'Sit the selection flat on the ground.', key: 'D', run: () => A.dropToGround(), enabled: hasSel, keywords: 'floor' },
  { id: 'arrange.center', label: 'Center', group: 'Arrange', icon: Crosshair, desc: 'Move the selection to the middle of the grid.', run: () => A.centerOnOrigin(), enabled: hasSel, keywords: 'origin' },

  // 3D printing
  { id: 'print.check', label: 'Print check', group: 'Print', icon: ClipboardCheck, desc: 'Is it ready to print? Checks bed size, floating parts, gaps and overhangs, and estimates filament and time.', key: 'P', run: () => store.set({ dialog: 'print' }), keywords: 'printable slicer filament estimate' },
  { id: 'print.bed', label: 'Show bed', group: 'Print', icon: BedDouble, desc: "Show your printer's build volume. It turns red if your design doesn't fit.", run: () => store.set({ showBed: !store.state.showBed }), active: () => store.state.showBed, keywords: 'build volume plate' },
  { id: 'print.overhangs', label: 'Overhangs', group: 'Print', icon: TriangleAlert, desc: 'Paint faces red that hang over more than 45° — they need supports, or a better orientation.', key: 'O', run: () => store.set({ showOverhangs: !store.state.showOverhangs }), active: () => store.state.showOverhangs, keywords: 'support angle' },
  { id: 'print.layflat', label: 'Lay flat', group: 'Print', icon: PanelBottom, desc: 'Click any face and the body rotates so that face sits on the bed.', key: 'L', run: () => store.set({ mode: store.state.mode === 'lay-flat' ? 'model' : 'lay-flat' }), active: () => store.state.mode === 'lay-flat', enabled: () => store.state.mode !== 'sketch', keywords: 'orient rotate face bed' },
  { id: 'print.drop', label: 'Drop to bed', group: 'Print', icon: ArrowDownToLine, desc: 'Put every part (or the selection) flat on the bed.', run: () => A.dropAllToBed() },
  { id: 'print.arrange', label: 'Arrange on bed', group: 'Print', icon: LayoutGrid, desc: 'Spread all parts out on the bed so none overlap — ready for one print job.', run: () => A.arrangeAll(printerById(store.state.printerId).x - 10), keywords: 'pack layout plate' },
  { id: 'print.printer', label: 'Choose printer', group: 'Print', icon: Printer, desc: 'Pick your printer so the bed size is right.', run: () => store.set({ dialog: 'print' }) },

  // inspect + view
  { id: 'inspect.measure', label: 'Measure', group: 'Inspect', icon: Ruler, desc: 'Click two points to measure the distance between them.', key: 'I', run: () => store.set({ mode: store.state.mode === 'measure' ? 'model' : 'measure', measure: { a: null, b: null } }), active: () => store.state.mode === 'measure', enabled: inModel },
  { id: 'inspect.section', label: 'Section', group: 'Inspect', icon: Scissors, desc: 'Slice the model open to look inside.', run: () => store.set({ section: { ...store.state.section, enabled: !store.state.section.enabled } }), active: () => store.state.section.enabled, keywords: 'clip cross' },
  { id: 'inspect.ghosts', label: 'Show tools', group: 'Inspect', icon: Eye, desc: 'Show the see-through tool shapes used by cuts and joins so you can click and move them.', run: () => store.set({ showGhosts: !store.state.showGhosts }), active: () => store.state.showGhosts, keywords: 'holes ghosts' },
  { id: 'view.home', label: 'Home view', group: 'View', icon: House, desc: 'Jump back to the default 3D view.', key: 'Home', run: () => A.viewApi.setView?.('home') },
  { id: 'view.fit', label: 'Zoom to fit', group: 'View', icon: Focus, desc: 'Zoom so everything (or the selection) fits on screen.', key: 'F', run: () => A.viewApi.fit?.(hasSel() ? store.state.selection : undefined) },
  { id: 'view.top', label: 'Top view', group: 'View', icon: SquareDashed, desc: 'Look straight down.', key: '7', run: () => A.viewApi.setView?.('top') },
  { id: 'view.front', label: 'Front view', group: 'View', icon: SquareDashed, desc: 'Look from the front.', key: '1', run: () => A.viewApi.setView?.('front') },
  { id: 'view.right', label: 'Right view', group: 'View', icon: SquareDashed, desc: 'Look from the right.', key: '3', run: () => A.viewApi.setView?.('right') },
  { id: 'view.ortho', label: 'Orthographic', group: 'View', icon: Diamond, desc: 'Switch between perspective and flat (orthographic) camera.', key: '5', run: () => store.set({ projection: store.state.projection === 'perspective' ? 'orthographic' : 'perspective' }), active: () => store.state.projection === 'orthographic' },
  { id: 'view.grid', label: 'Grid', group: 'View', icon: Grid3x3, desc: 'Show or hide the ground grid.', run: () => store.set({ showGrid: !store.state.showGrid }), active: () => store.state.showGrid },
  { id: 'view.isolate', label: 'Isolate', group: 'View', icon: ScanEye, desc: 'Hide everything except the selection.', run: () => A.isolate(), enabled: hasSel },
  { id: 'view.showAll', label: 'Show all', group: 'View', icon: Layers2, desc: 'Unhide every body.', run: () => A.showAll() },
  { id: 'view.theme', label: 'Toggle dark / light', group: 'View', icon: Sun, desc: 'Switch the app colour theme.', run: () => store.set({ theme: store.state.theme === 'dark' ? 'light' : 'dark' }), keywords: 'theme dark light mode' },
  { id: 'help.palette', label: 'Search commands', group: 'Help', icon: Search, desc: 'Find any tool by typing its name.', key: 'Ctrl+P', run: () => store.set({ palette: true }) },
  { id: 'help.shortcuts', label: 'Keyboard shortcuts', group: 'Help', icon: Keyboard, desc: 'See every shortcut.', key: '?', run: () => store.set({ dialog: 'shortcuts' }) },
  { id: 'help.tour', label: 'Take the tour', group: 'Help', icon: GraduationCap, desc: 'A 60-second guided tour of KimaticPro.', run: () => store.set({ dialog: 'tour', tourStep: 0, welcome: false }) },
  { id: 'help.beginner', label: 'Beginner mode', group: 'Help', icon: GraduationCap, desc: 'Big labelled buttons and helpful hints. Turn off for a compact pro layout.', run: () => store.set({ beginner: !store.state.beginner }), active: () => store.state.beginner },

  // sketch
  { id: 'sketch.select', label: 'Select', group: 'Sketch', icon: MousePointer2, desc: 'Pick and drag sketch shapes. Edit their sizes on the right.', key: 'V', run: () => A.setSketchTool('select'), active: () => store.state.sketchTool === 'select' },
  { id: 'sketch.line', label: 'Line', group: 'Sketch', icon: PenLine, desc: 'Click point to point. Click the first point again to close the shape. Double-click to stop.', key: 'L', run: () => A.setSketchTool('line'), active: () => store.state.sketchTool === 'line' },
  { id: 'sketch.rect', label: 'Rectangle', group: 'Sketch', icon: RectangleHorizontal, desc: 'Click two corners. Type "40,20" for an exact size.', key: 'R', run: () => A.setSketchTool('rect'), active: () => store.state.sketchTool === 'rect' },
  { id: 'sketch.crect', label: 'Center rect', group: 'Sketch', icon: RectangleHorizontal, desc: 'Click the centre, then a corner.', run: () => A.setSketchTool('crect'), active: () => store.state.sketchTool === 'crect' },
  { id: 'sketch.circle', label: 'Circle', group: 'Sketch', icon: Circle, desc: 'Click the centre, then the edge. Type a diameter for an exact size.', key: 'C', run: () => A.setSketchTool('circle'), active: () => store.state.sketchTool === 'circle' },
  { id: 'sketch.polygon', label: 'Polygon', group: 'Sketch', icon: Hexagon, desc: 'A regular polygon — set the number of sides on the right.', key: 'P', run: () => A.setSketchTool('polygon'), active: () => store.state.sketchTool === 'polygon' },
  { id: 'sketch.slot', label: 'Slot', group: 'Sketch', icon: Pill, desc: 'Click two centres, then set the width.', run: () => A.setSketchTool('slot'), active: () => store.state.sketchTool === 'slot' },
  { id: 'sketch.spline', label: 'Spline', group: 'Sketch', icon: Spline, desc: 'Smooth curve through your clicks. Click the first point to close it.', run: () => A.setSketchTool('spline'), active: () => store.state.sketchTool === 'spline' },
  { id: 'sketch.finish', label: 'Finish sketch', group: 'Sketch', icon: Check, desc: 'Leave the sketch. Then Extrude or Revolve it.', key: 'Enter', run: () => A.finishSketch() },
];

export const cmd = (id: string) => COMMANDS.find((c) => c.id === id)!;
export const runCmd = (id: string) => {
  const c = cmd(id);
  if (c && (!c.enabled || c.enabled())) c.run();
};

export const ThemeIcon = () => (store.state.theme === 'dark' ? <Moon size={17} /> : <Sun size={17} />);
