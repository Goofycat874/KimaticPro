# KimaticPro

**Free, open-source 3D CAD for everyone.** KimaticPro runs in your browser and is simple enough for a kid's first 3D print, yet built like the professional tools: a parametric feature timeline, fully constrained sketches, an exact B-rep geometry kernel (OpenCascade), STEP in and out, and real engineering drawings.

### For professionals

- 🎯 **Exact solids** — every shape, sketch, boolean and fillet is computed as a true B-rep by [OpenCascade](https://dev.opencascade.org) (via [replicad](https://replicad.xyz)) in a background worker. You get an instant preview while dragging, then the exact result. The status bar shows which you're looking at.
- 📏 **Constrained sketches** — coincident, horizontal, vertical, parallel, perpendicular, equal, tangent, concentric, midpoint, point-on-curve, symmetric and lock, plus driving dimensions (length, distance, horizontal/vertical, radius, diameter, angle). A least-squares solver keeps everything satisfied while you drag; geometry turns white when fully constrained and the sketch reports its remaining degrees of freedom or conflicts. Dimensions accept parameters (`width / 2`) and re-solve when parameters change.
- ✂️ **Sketch editing** — 3-point arcs, construction lines, trim, round corner, offset and mirror. Lines and arcs that meet end to end form closed profiles.
- 🟠 **Fillet, chamfer, shell, draft** — click the exact edges or faces you want. Each is an editable timeline step.
- 🔩 **Hole tool** — click a face to drill plain, counterbored or countersunk holes, through or blind with a drill point. ISO metric presets: clearance, tap drill, socket-head counterbore, 90° countersink, heat-set inserts.
- 📄 **Technical drawings** — front/top/right/isometric views from exact hidden-line projection, third or first angle, standard scales, overall dimensions, hole callouts (`2× Ø10`), centre marks and a title block. Save as vector **PDF**, **SVG**, or **DXF** at 1:1.
- 🔁 **Interchange** — **STEP** import/export (exact solids for SolidWorks, Fusion, Onshape, FreeCAD, machine shops), **DXF** import into sketches (lines, polylines with bulges, arcs, circles, NURBS splines, ellipses, blocks) and 1:1 sketch DXF export for laser cutters and CNC.
- ⚖️ **Mass properties** — exact volume, surface area, mass, centre of mass and inertia tensor with principal moments, per-body material densities.
- 📐 **Units** — work in millimetres and type any unit into a size field: `2in`, `3/8"`, `1.5cm`, `0.1m`, `2ft`.

### For everyone

- 🧱 **Snap shapes together** — boxes, cylinders, spheres, cones, pyramids, tori, tubes, wedges, domes, capsules, prisms, stars, hearts, 3D text, gears and springs. Click to add or drag right where you want them.
- 🕳️ **Holes in one click** — set any shape to *Hole* and it cuts whatever it touches. You can still move and resize the hole afterwards.
- ✏️ **Sketch like a pro** — draw lines, rectangles, circles, polygons, slots and splines on any plane or flat face. Type exact sizes while drawing (`40,20` ⏎). Shapes inside shapes become holes automatically.
- ⬆️ **Extrude, revolve, loft & sweep** — turn sketches into solids: rounded edges, symmetric extrudes, partial revolves, smooth lofts through several sketches (vases, bottles) and sweeps along a path with optional twist (pipes, hooks, handles).
- 🔩 **Printable hardware** — real metric threaded rods, bolts (hex/socket) and nuts with print tolerance, screw holes with counterbore/countersink (drop one on a face to drill it), and storage boxes.
- 🧮 **Parameters** — name your key sizes (`wall = 2`) and type formulas like `wall * 2` into any size field. Change one number and the whole design follows.
- ➕ **Join / Cut / Intersect** any bodies, **pattern** them in rows or circles, **mirror** them, align and drop them to the ground.
- ⏳ **Parametric timeline** — every step is recorded. Click any step to change it and everything after it rebuilds. Drag the marker to rewind history, suppress steps, reorder your thinking.
- 🖨️ **Print workspace** — pick your printer (Bambu, Prusa, Creality, Voron…) to see its build volume, highlight overhangs that need supports, *lay flat* any face onto the bed, auto-arrange parts, split big parts in two, and run a print check (fits the bed? floating parts? watertight? filament and time estimate). Export **3MF** (exact millimetres, separate parts, colours) or STL.
- 📐 **Inspect** — measure point-to-point, slice the model with a section view, see size, volume, surface area and estimated mass for 12 real materials.
- 🎨 **Looks great** — physically based materials (plastics, metals, wood, glass…), soft shadows, CAD-style edges, dark and light themes.
- 💾 **Export** 3MF and STL (3D printing), OBJ, GLB (games/AR) and PNG; save/open `.kimatic` project files; import STL/OBJ meshes. Your work auto-saves in the browser.
- 🎓 **Beginner friendly** — welcome templates, a guided tour, helpful tooltips on every button, contextual hints in the status bar, and a *Pro* mode with a compact ribbon when you outgrow them. `Ctrl+P` searches every command.

## Getting started

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # production build in dist/
npm test           # geometry & feature engine tests
```

The production build is a static site — host `dist/` anywhere (GitHub Pages, Netlify, a USB stick).

## Using it

| Do this | How |
| --- | --- |
| Orbit / pan / zoom | Left-drag empty space / right-drag / scroll |
| Select, multi-select | Click, Shift+click |
| Move, rotate, scale | Drag the gizmo — or `G`, `R`, `X` to switch. Arrow keys nudge (Shift ×10, PgUp/PgDn for height) |
| Add a box / cylinder / text | `B` / `Y` / `T` |
| Turn a shape into a hole | `H` |
| Sketch, extrude | `S`, then `E` |
| Join / cut selected bodies | `Ctrl+J` / `Ctrl+K` |
| Duplicate, copy, paste | `Ctrl+D`, `Ctrl+C`, `Ctrl+V` |
| Measure | `I` |
| Print check / overhangs / lay flat | `P` / `O` / `L` |
| Fit view, home view | `F`, `Home` |
| Search every tool | `Ctrl+P` |
| All shortcuts | `?` |

In sketches: `L` line, `R` rectangle, `C` circle, `A` arc, `P` polygon, `D` dimension, `T` trim, `X` construction, `V` select, `Enter` finish, `Esc` steps back (tool → selection → leave sketch). Type numbers while drawing for exact sizes — they become dimensions you can edit later. Snapping onto points joins them and level lines get Horizontal/Vertical constraints automatically.

## How it works

```
src/
  core/            UI-independent CAD engine
    types.ts         design document: an ordered list of features (the timeline)
    evaluator.ts     replays features → solid bodies (cached, incremental)
    primitives.ts    parametric shape library
    sketch.ts        sketch entities → closed profiles (holes, joined lines + arcs)
    constraints.ts   sketch constraint solver and degrees-of-freedom analysis
    sketchEdit.ts    trim, round corner, offset, mirror
    evalCore.ts      the timeline engine, shared by both geometry kernels
    meshKernel.ts    fast mesh kernel for instant previews
    holes.ts         hole presets and cutter profiles
    drawingSheet.ts  drawing layout + SVG / PDF / DXF writers
    dxf.ts           DXF import and sketch export
    revolve.ts       capped revolve builder
    loft.ts          loft and sweep builders
    hardware.ts      threads, bolts, nuts, screw holes, containers
    expr.ts          safe formula parser for user parameters
    printing.ts      printer presets, print analysis, arrange, 3MF writer
    meshcheck.ts     watertight check tolerant of boolean T-junctions
    actions.ts       every user operation as an undoable document edit
    store.ts         app state, undo/redo, autosave
    io.ts            STL / OBJ / GLB / PNG export, project files, mesh import
    templates.ts     starter designs
  kernel/          exact geometry (OpenCascade) in a Web Worker
    brep.ts          B-rep kernel: sketches, booleans, fillets, STEP
    projection.ts    hidden-line views for drawings
    massProps.ts     exact mass properties
    worker.ts, client.ts, protocol.ts
  viewport/        Three.js rendering & interaction
    Viewport.ts      scene, camera, picking, gizmo, section, measure
    SketchController.ts  2D drawing tools with snapping and typed dimensions
    edges.ts         CAD feature-edge extraction that hides boolean seams
    ViewCube.ts, grid.ts, thumbnails.ts
  ui/              Preact interface (ribbon, browser, inspector, timeline, dialogs)
```

A design is a list of features. Evaluating them in order produces the bodies you see, so every earlier decision stays editable. The same timeline engine runs on two kernels: a fast mesh kernel ([three-bvh-csg](https://github.com/gkjohnson/three-bvh-csg)) for instant feedback, and an exact OpenCascade B-rep kernel in a Web Worker whose results replace the preview as soon as they're ready. Edges and faces are referenced by position on the model, so fillets and shells survive upstream edits. Both kernels are tested against each other for every shape and template.

### Phones & tablets

The layout adapts below 820 px wide: the ribbon becomes a swipeable strip, the Browser slides in from the left and Properties is a bottom sheet. One finger orbits (or draws, inside a sketch), two fingers pinch-zoom and pan, and press-and-hold opens the quick menu. KimaticPro is also a PWA: open it in Safari/Chrome and choose **Add to Home Screen** to install it with its own icon and offline support. For app-store builds the same `dist/` can be wrapped with [Capacitor](https://capacitorjs.com).

### Windows desktop

The app is a dependency-free static bundle with no server, so it can be wrapped as a native Windows app (e.g. with [Tauri](https://tauri.app) or Electron) without changes to the engine. File access currently uses browser downloads/uploads, which is the one layer to swap for native dialogs.

## Contributing

Issues and pull requests are welcome! Please run `npm run typecheck` and `npm test` before opening a PR.

## License

[MIT](LICENSE) — free for personal, educational and commercial use.
