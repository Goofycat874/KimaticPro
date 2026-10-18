import { emptyDoc } from './store';
import type { BodyOp, DesignDoc, Feature, PrimitiveFeature, Vec2, Vec3 } from './types';
import { STANDARD_PLANES } from './sketch';
import type { PlaneDef } from './types';

let n = 0;
const id = (p: string) => `${p}_${(n++).toString(36)}`;

function prim(
  shape: string, name: string, params: Record<string, any>, position: Vec3, color: string,
  o: { rotation?: Vec3; op?: BodyOp; targets?: string[]; material?: string; id?: string } = {},
): PrimitiveFeature {
  return {
    id: o.id ?? id('p'), type: 'primitive', name, shape, params,
    transform: { position, rotation: o.rotation ?? [0, 0, 0], scale: [1, 1, 1] },
    op: o.op ?? 'new', targets: o.targets ?? [], appearance: { color, material: o.material ?? 'pla' },
  };
}

const make = (name: string, features: Feature[]): DesignDoc => ({ ...emptyDoc(name), features, marker: features.length });

export interface Template {
  id: string;
  name: string;
  description: string;
  level: 'Easy' | 'Medium' | 'Pro';
  build: () => DesignDoc;
}

export const TEMPLATES: Template[] = [
  {
    id: 'keychain', name: 'Name Keychain', level: 'Easy',
    description: 'A rounded tag with raised letters and a ring hole.',
    build: () => {
      const tag = prim('box', 'Tag', { width: 56, height: 4, depth: 22, round: 1.5 }, [0, 0, 0], '#8b5cf6', { id: 'tag' });
      return make('Name Keychain', [
        tag,
        prim('text', 'Letters', { text: 'KIMA', size: 10, depth: 3 }, [4, 5.3, 5], '#facc15', { rotation: [-90, 0, 0], op: 'join', targets: ['tag'] }),
        prim('cylinder', 'Ring hole', { radius: 3.2, height: 10, sides: 64 }, [-21, -2, 0], '#ef4444', { op: 'cut', targets: ['tag'] }),
      ]);
    },
  },
  {
    id: 'snowman', name: 'Snowman', level: 'Easy',
    description: 'Stack spheres, add a carrot nose and a top hat.',
    build: () => make('Snowman', [
      prim('sphere', 'Bottom', { radius: 15, detail: 48 }, [0, 0, 0], '#f8fafc'),
      prim('sphere', 'Middle', { radius: 11, detail: 48 }, [0, 25, 0], '#f8fafc'),
      prim('sphere', 'Head', { radius: 8, detail: 48 }, [0, 44, 0], '#f8fafc'),
      prim('cone', 'Nose', { radius: 1.8, topRadius: 0, height: 9, sides: 32 }, [0, 52, 6], '#f97316', { rotation: [90, 0, 0] }),
      prim('sphere', 'Left eye', { radius: 1.2, detail: 16 }, [-3, 53.5, 6.4], '#18181b'),
      prim('sphere', 'Right eye', { radius: 1.2, detail: 16 }, [3, 53.5, 6.4], '#18181b'),
      prim('cylinder', 'Hat brim', { radius: 10, height: 1.5, sides: 64 }, [0, 58.5, 0], '#18181b'),
      prim('cylinder', 'Hat', { radius: 6.5, height: 9, sides: 64 }, [0, 59.5, 0], '#18181b'),
      prim('torus', 'Scarf', { radius: 9.5, tube: 2.2, detail: 64 }, [0, 35, 0], '#ef4444'),
    ]),
  },
  {
    id: 'rocket', name: 'Space Rocket', level: 'Medium',
    description: 'Joins, a window and fins repeated with a circular pattern.',
    build: () => {
      const fin = prim('wedge', 'Fin', { width: 2.5, height: 20, depth: 14 }, [16, 0, 0], '#ef4444', { rotation: [0, -90, 0], id: 'fin' });
      return make('Space Rocket', [
        prim('cylinder', 'Body', { radius: 10, height: 50, sides: 64 }, [0, 4, 0], '#e2e8f0', { id: 'body' }),
        prim('cone', 'Nose cone', { radius: 10, topRadius: 0, height: 22, sides: 64 }, [0, 54, 0], '#ef4444'),
        prim('cylinder', 'Window', { radius: 4, height: 3, sides: 48 }, [0, 38, 8.5], '#38bdf8', { rotation: [90, 0, 0], material: 'glass' }),
        prim('cone', 'Engine', { radius: 6, topRadius: 8, height: 4, sides: 48 }, [0, 0, 0], '#475569', { material: 'steel' }),
        fin,
        { id: id('pt'), type: 'pattern', name: 'Fin pattern', bodyIds: ['fin'], kind: 'circular', count: 3, spacing: 10, direction: 'x', angle: 360, axis: 'y', center: [0, 0, 0] },
      ]);
    },
  },
  {
    id: 'mug', name: 'Coffee Mug', level: 'Medium',
    description: 'A revolved sketch profile with a joined torus handle.',
    build: () => {
      // solid profile with a chamfered foot; the inside is cut afterwards so the handle never pokes in
      const profile: Vec2[] = [[0, 0], [37, 0], [40, 3], [40, 90], [0, 90]];
      return make('Coffee Mug', [
        { id: 'mugsk', type: 'sketch', name: 'Mug profile', plane: STANDARD_PLANES.front, visible: false, entities: [{ id: 'l1', kind: 'polyline', points: profile, closed: true }] },
        { id: 'mug', type: 'revolve', name: 'Mug body', sketchId: 'mugsk', axis: 'y', angle: 360, op: 'new', targets: [], transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }, appearance: { color: '#0ea5e9', material: 'resin' } },
        prim('torus', 'Handle', { radius: 22, tube: 5, detail: 64 }, [40, 45, -5], '#0ea5e9', { rotation: [90, 0, 0], op: 'join', targets: ['mug'] }),
        prim('cylinder', 'Inside', { radius: 36, height: 90, sides: 96 }, [0, 6, 0], '#ef4444', { op: 'cut', targets: ['mug'] }),
      ]);
    },
  },
  {
    id: 'stand', name: 'Phone Stand', level: 'Medium',
    description: 'Sketch a side profile and extrude it — real CAD workflow.',
    build: () => {
      const pts: Vec2[] = [[0, 0], [90, 0], [90, 5], [56, 5], [84, 72], [78, 74], [48, 5], [16, 5], [16, 16], [10, 16], [10, 5], [0, 5]];
      return make('Phone Stand', [
        { id: 'standsk', type: 'sketch', name: 'Side profile', plane: { ...STANDARD_PLANES.right, origin: [0, 0, 45] }, visible: false, entities: [{ id: 'l1', kind: 'polyline', points: pts, closed: true }] },
        { id: 'stand', type: 'extrude', name: 'Stand', sketchId: 'standsk', distance: 70, symmetric: true, roundEdges: 1, op: 'new', targets: [], transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }, appearance: { color: '#f97316', material: 'pla' } },
        prim('cylinder', 'Cable hole', { radius: 6, height: 20, sides: 64 }, [0, -5, 13], '#ef4444', { op: 'cut', targets: ['stand'] }),
      ]);
    },
  },
  {
    id: 'gears', name: 'Gear Train', level: 'Pro',
    description: 'Two meshing spur gears on shafts with a base plate.',
    build: () => make('Gear Train', [
      prim('box', 'Base plate', { width: 90, height: 4, depth: 50, round: 2 }, [12, 0, 0], '#334155', { material: 'aluminum' }),
      prim('cylinder', 'Shaft A', { radius: 3.8, height: 18, sides: 48 }, [0, 4, 0], '#cbd5e1', { material: 'steel' }),
      prim('cylinder', 'Shaft B', { radius: 3.8, height: 18, sides: 48 }, [31.5, 4, 0], '#cbd5e1', { material: 'steel' }),
      prim('gear', 'Big gear', { teeth: 24, radius: 21, toothDepth: 3, height: 6, bore: 4 }, [0, 8, 0], '#f59e0b', { material: 'brass' }),
      prim('gear', 'Small gear', { teeth: 12, radius: 12, toothDepth: 3, height: 6, bore: 4 }, [31.5, 8, 0], '#22c55e', { rotation: [0, 15, 0] }),
    ]),
  },
  {
    id: 'brick', name: 'Building Brick', level: 'Pro',
    description: 'Patterns of studs combined into one hollow brick.',
    build: () => {
      const stud = prim('cylinder', 'Stud', { radius: 2.4, height: 1.8, sides: 48 }, [-12, 9.6, -4], '#ef4444', { id: 'stud' });
      const pa = 'patx', pb = 'patz';
      const rowIds = ['stud', `${pa}:stud:1`, `${pa}:stud:2`, `${pa}:stud:3`];
      const studs = [...rowIds, ...rowIds.map((r) => `${pb}:${r}:1`)];
      return make('Building Brick', [
        prim('box', 'Brick', { width: 32, height: 9.6, depth: 16, round: 0 }, [0, 0, 0], '#ef4444', { id: 'brick' }),
        stud,
        { id: pa, type: 'pattern', name: 'Stud row', bodyIds: ['stud'], kind: 'linear', count: 4, spacing: 8, direction: 'x', angle: 360, axis: 'y', center: [0, 0, 0] },
        { id: pb, type: 'pattern', name: 'Stud grid', bodyIds: rowIds, kind: 'linear', count: 2, spacing: 8, direction: 'z', angle: 360, axis: 'y', center: [0, 0, 0] },
        { id: id('c'), type: 'combine', name: 'Join studs', targetId: 'brick', toolIds: studs.filter((s) => s !== 'brick'), op: 'join', keepTools: false },
        prim('box', 'Hollow', { width: 29.6, height: 8.4, depth: 13.6, round: 0 }, [0, -0.01, 0], '#ef4444', { op: 'cut', targets: ['brick'] }),
      ]);
    },
  },
  {
    id: 'vase', name: 'Twisty Vase', level: 'Medium',
    description: 'A smooth loft through three sketches, hollowed by a second loft.',
    build: () => {
      const at = (y: number): PlaneDef => ({ ...STANDARD_PLANES.top, origin: [0, y, 0], label: `Ground +${y} mm` });
      const sk = (id: string, y: number, entities: any[]): Feature => ({ id, type: 'sketch', name: `Section ${id.slice(-1)}`, plane: at(y), visible: false, entities });
      return make('Twisty Vase', [
        sk('va1', 0, [{ id: 'a', kind: 'polygon', cx: 0, cy: 0, r: 28, sides: 6, rotation: 0 }]),
        sk('va2', 45, [{ id: 'a', kind: 'circle', cx: 0, cy: 0, r: 36 }]),
        sk('va3', 100, [{ id: 'a', kind: 'polygon', cx: 0, cy: 0, r: 20, sides: 6, rotation: 30 }]),
        { id: 'vase', type: 'loft', name: 'Vase', sketchIds: ['va1', 'va2', 'va3'], smooth: true, op: 'new', targets: [], transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }, appearance: { color: '#14b8a6', material: 'resin' } },
        sk('vb1', 3, [{ id: 'a', kind: 'polygon', cx: 0, cy: 0, r: 25.5, sides: 6, rotation: 0 }]),
        sk('vb2', 45, [{ id: 'a', kind: 'circle', cx: 0, cy: 0, r: 33.5 }]),
        sk('vb3', 101, [{ id: 'a', kind: 'polygon', cx: 0, cy: 0, r: 17.5, sides: 6, rotation: 30 }]),
        { id: 'inner', type: 'loft', name: 'Hollow', sketchIds: ['vb1', 'vb2', 'vb3'], smooth: true, op: 'cut', targets: ['vase'], transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }, appearance: { color: '#ef4444', material: 'pla' } },
      ]);
    },
  },
  {
    id: 'boltnut', name: 'Bolt & Nut', level: 'Pro',
    description: 'Printable metric threads. Change the “size” parameter and both update.',
    build: () => {
      const doc = make('Bolt & Nut', [
        { ...prim('bolt', 'Bolt', { diameter: 8, pitch: 1.25, length: 25, head: 'hex', headHeight: 5.5, headWidth: 13 }, [-14, 0, 0], '#64748b', { material: 'pla' }),
          exprs: { 'params.diameter': 'size', 'params.pitch': 'metric_pitch(size)', 'params.headWidth': 'size * 1.6', 'params.headHeight': 'size * 0.7' } },
        { ...prim('nut', 'Nut', { diameter: 8, pitch: 1.25, height: 6.5, width: 13, tolerance: 0.3 }, [14, 0, 0], '#f59e0b', { material: 'pla' }),
          exprs: { 'params.diameter': 'size', 'params.pitch': 'metric_pitch(size)', 'params.width': 'size * 1.6', 'params.height': 'size * 0.8', 'params.tolerance': 'clearance' } },
      ]);
      doc.params = [
        { name: 'size', expr: '8', comment: 'Thread diameter (M-size)' },
        { name: 'clearance', expr: '0.3', comment: 'Extra room for printing' },
      ];
      return doc;
    },
  },
  {
    id: 'hook', name: 'Wall Hook', level: 'Pro',
    description: 'A rounded profile swept along a curved path, with screw holes.',
    build: () => {
      // the right plane's u axis points to -Z, so negative u comes out of the wall (+Z)
      const path: Vec2[] = [[0, 6], [0, 52], [-6, 64], [-20, 66], [-30, 57], [-30, 46]];
      return make('Wall Hook', [
        { id: 'hookpath', type: 'sketch', name: 'Hook path', plane: STANDARD_PLANES.right, visible: false, entities: [{ id: 'p', kind: 'spline', points: path, closed: false }] },
        { id: 'hookprof', type: 'sketch', name: 'Hook profile', plane: STANDARD_PLANES.top, visible: false, entities: [{ id: 'r', kind: 'rect', x: -6, y: -3, w: 12, h: 6, radius: 2.5 }] },
        { id: 'hook', type: 'sweep', name: 'Hook', profileId: 'hookprof', pathId: 'hookpath', twist: 0, op: 'new', targets: [], transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }, appearance: { color: '#8b5cf6', material: 'pla' } },
        prim('box', 'Wall plate', { width: 30, height: 64, depth: 4, round: 1.5 }, [0, 0, -2], '#8b5cf6', { op: 'join', targets: ['hook'], id: 'plate' }),
        prim('screwhole', 'Screw hole', { diameter: 3.4, depth: 10, head: 'countersink', headDiameter: 7, headDepth: 3 }, [-10, 30, 0], '#ef4444', { op: 'cut', targets: ['hook'], rotation: [90, 0, 0] }),
        prim('screwhole', 'Screw hole 2', { diameter: 3.4, depth: 10, head: 'countersink', headDiameter: 7, headDepth: 3 }, [10, 30, 0], '#ef4444', { op: 'cut', targets: ['hook'], rotation: [90, 0, 0] }),
      ]);
    },
  },
];
