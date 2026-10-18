import { useEffect, useMemo, useState } from 'preact/hooks';
import { kernel } from '../kernel/client';
import type { MassPayload } from '../kernel/protocol';
import * as THREE from 'three';
import {
  Box, PenLine, Copy, ArrowDownToLine, EyeOff, Trash2, Lightbulb, TriangleAlert, Pencil, ArrowUpFromLine, RotateCw,
  SquaresUnite, SquaresSubtract, SquaresIntersect, Repeat, FlipHorizontal2, Move, Upload, Ruler, Sparkles, Orbit, CircleOff,
  Blend, Spline, SquareSplitVertical, ArrowUp, ArrowDown, SquareRoundCorner, PackageOpen, Triangle,
  X,
} from 'lucide-preact';
import { store } from '../core/store';
import * as A from '../core/actions';
import { bodyBounds, featureOf, type EvalBody } from '../core/evaluator';
import { shapeById, SHAPES } from '../core/primitives';
import { metricPitch } from '../core/hardware';
import { evalExpr } from '../core/expr';
import { MATERIALS, SWATCHES, materialById } from '../core/materials';
import { computeArea, computeVolume, triangleCount } from '../core/geometry';
import type { BodyOp, Feature, SketchConstraint, SketchEntity, TRS, Vec3 } from '../core/types';
import { analyzeSketch, isDimension } from '../core/constraints';
import { useStore } from './hooks';
import { Field, NumberField, Segmented, Toggle, Vec3Field } from './controls';
import { shapeThumbnail } from '../viewport/thumbnails';

const fmt = (v: number, d = 2) => (Math.abs(v) >= 1000 ? Math.round(v).toLocaleString() : v.toFixed(d).replace(/\.?0+$/, ''));

const TYPE_META: Record<Feature['type'], { label: string; color: string; icon: any }> = {
  primitive: { label: 'Shape', color: '#2f7bff', icon: Box },
  sketch: { label: 'Sketch', color: '#22c55e', icon: PenLine },
  extrude: { label: 'Extrude', color: '#f97316', icon: ArrowUpFromLine },
  revolve: { label: 'Revolve', color: '#f59e0b', icon: RotateCw },
  combine: { label: 'Combine', color: '#a855f7', icon: SquaresUnite },
  move: { label: 'Move', color: '#64748b', icon: Move },
  pattern: { label: 'Pattern', color: '#06b6d4', icon: Repeat },
  mirror: { label: 'Mirror', color: '#ec4899', icon: FlipHorizontal2 },
  import: { label: 'Imported mesh', color: '#94a3b8', icon: Upload },
  loft: { label: 'Loft', color: '#10b981', icon: Blend },
  sweep: { label: 'Sweep', color: '#0ea5e9', icon: Spline },
  split: { label: 'Split', color: '#f43f5e', icon: SquareSplitVertical },
  fillet: { label: 'Fillet', color: '#eab308', icon: SquareRoundCorner },
  shell: { label: 'Shell', color: '#0d9488', icon: PackageOpen },
  draft: { label: 'Draft', color: '#7c3aed', icon: Triangle },
};
export { TYPE_META };

/** Edit a feature field: live while scrubbing, one undo step when done. */
function edit(fid: string, label: string, fn: (f: any) => void, live = false) {
  A.updateFeature(fid, fn, label, live);
}
const commit = (label: string) => () => store.endTransient(label);

const getPath = (o: any, path: string) => path.split('.').reduce((a, k) => (a == null ? a : a[k]), o);

/**
 * A number field bound to a feature property. Accepts plain numbers, maths, or
 * formulas using the design's parameters (`width / 2`), which stay linked.
 */
function PNum(props: {
  f: Feature; path: string; title: string; label?: string; unit?: string; min?: number; max?: number; step?: number;
  integer?: boolean; nonZero?: boolean; after?: (x: any, v: number) => void;
}) {
  const vars = useStore((s) => s.result.vars);
  const { f, path, title } = props;
  const expr = f.exprs?.[path];
  let value = Number(getPath(f, path));
  if (expr) { try { value = evalExpr(expr, vars); } catch { /* shown as error on the step */ } }
  return (
    <NumberField value={value} unit={props.unit} min={props.min} max={props.max} step={props.step} integer={props.integer} label={props.label ?? '↔'}
      expr={expr}
      onExpr={(e) => A.setExpr(f.id, path, e)}
      onChange={(v, live) => edit(f.id, title, (x) => {
        const val = props.nonZero ? v || 0.1 : v;
        const keys = path.split('.');
        const parent = keys.slice(0, -1).reduce((a: any, k) => a[k], x);
        parent[keys[keys.length - 1]] = val;
        if (x.exprs?.[path]) { x.exprs = { ...x.exprs }; delete x.exprs[path]; }
        props.after?.(x, val);
      }, live)}
      onCommit={commit(title)} />
  );
}

function Section(props: { title: string; children: any; right?: any }) {
  return (
    <div class="insp-section">
      <div class="insp-title"><span class="grow">{props.title}</span>{props.right}</div>
      {props.children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// feature editors

function ShapeParams({ f }: { f: Extract<Feature, { type: 'primitive' }> }) {
  const def = shapeById(f.shape);
  if (!def) return null;
  return (
    <Section title={`${def.label} size`}>
      {def.params.map((p) => {
        const v = f.params[p.key] ?? p.default;
        if (p.type === 'text') {
          return (
            <Field key={p.key} label={p.label}>
              <input class="text-input" value={String(v)} maxLength={40}
                onInput={(e) => edit(f.id, 'Edit text', (x) => { x.params[p.key] = (e.currentTarget as HTMLInputElement).value; }, true)}
                onBlur={commit('Edit text')}
                onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur(); }} />
            </Field>
          );
        }
        if (p.type === 'select') {
          return (
            <Field key={p.key} label={p.label} tip={p.hint}>
              <select class="select" value={String(v)} onChange={(e) => edit(f.id, `Change ${p.label.toLowerCase()}`, (x) => { x.params[p.key] = (e.currentTarget as HTMLSelectElement).value; })}>
                {p.options!.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </Field>
          );
        }
        if (p.type === 'bool') {
          return <Field key={p.key} label={p.label}><Toggle value={!!v} onChange={(nv) => edit(f.id, p.label, (x) => { x.params[p.key] = nv; })} /></Field>;
        }
        return (
          <Field key={p.key} label={p.label} tip={p.hint}>
            <PNum f={f} path={`params.${p.key}`} title={`Change ${p.label.toLowerCase()}`} unit={p.unit} min={p.min} max={p.max}
              step={p.type === 'int' ? 1 : p.step ?? 1} integer={p.type === 'int'} label="↔"
              // threads follow the metric coarse pitch for the chosen diameter
              after={p.key === 'diameter' && def.params.some((q) => q.key === 'pitch') ? (x, nv) => { x.params.pitch = metricPitch(nv); } : undefined} />
          </Field>
        );
      })}
    </Section>
  );
}

function OperationEditor({ f }: { f: Extract<Feature, { type: 'primitive' | 'extrude' | 'revolve' | 'loft' | 'sweep' }> }) {
  const bodies = useStore((s) => s.result.bodies);
  const others = bodies.filter((b) => b.id !== f.id);
  return (
    <Section title="What it does">
      <Segmented<BodyOp> value={f.op} onChange={(op) => A.setBodyOp(f.id, op)} options={[
        { value: 'new', label: 'Solid', tip: 'A normal, separate body.' },
        { value: 'join', label: <><SquaresUnite size={13} /> Join</>, cls: 'join', tip: 'Merge into the target body.' },
        { value: 'cut', label: <><SquaresSubtract size={13} /> Hole</>, cls: 'cut', tip: 'Cut this shape out of the target body.' },
        { value: 'intersect', label: <><SquaresIntersect size={13} /></>, cls: 'inter', tip: 'Keep only the overlap with the target.' },
      ]} />
      {f.op !== 'new' && (
        <div style={{ marginTop: 10 }}>
          <div style={{ fontSize: 11.5, color: 'var(--text-3)', marginBottom: 6 }}>{f.op === 'cut' ? 'Cuts into' : f.op === 'join' ? 'Joins into' : 'Intersects with'} (click to toggle):</div>
          <div class="chips">
            {others.length === 0 && <span style={{ color: 'var(--text-3)', fontSize: 12 }}>No other bodies yet.</span>}
            {others.map((b) => {
              const on = f.targets.includes(b.id);
              return (
                <button key={b.id} class={`chip ${on ? 'on' : ''}`} onClick={() => edit(f.id, 'Change targets', (x) => {
                  x.targets = on ? x.targets.filter((t: string) => t !== b.id) : [...x.targets, b.id];
                })}>
                  <span class="dot" style={{ background: b.appearance.color, width: 9, height: 9 }} />{b.name}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </Section>
  );
}

function TransformEditor({ fid, t, offsetLabel }: { fid: string; t: TRS; offsetLabel?: boolean }) {
  const set = (k: keyof TRS, label: string) => (v: Vec3, live: boolean) => edit(fid, label, (x) => { x.transform = { ...x.transform, [k]: v }; }, live);
  return (
    <Section title="Position & rotation">
      <Field stack label={offsetLabel ? 'Offset (mm)' : 'Position (mm)'}><Vec3Field value={t.position} onChange={set('position', 'Move')} onCommit={commit('Move')} /></Field>
      <Field stack label="Rotation (°)"><Vec3Field value={t.rotation} step={5} onChange={set('rotation', 'Rotate')} onCommit={commit('Rotate')} /></Field>
      <Field stack label="Scale"><Vec3Field value={t.scale} step={0.05} onChange={set('scale', 'Scale')} onCommit={commit('Scale')} /></Field>
    </Section>
  );
}

function SketchLink({ sketchId }: { sketchId: string }) {
  const sk = featureOf(store.doc, sketchId);
  return (
    <div class="row-actions" style={{ marginTop: 4 }}>
      <button class="btn small" onClick={() => A.editSketch(sketchId)}><Pencil size={13} /> Edit sketch{sk ? ` (${sk.name})` : ''}</button>
    </div>
  );
}

function bodyName(id: string) {
  return A.bodyById(id)?.name ?? featureOf(store.doc, id)?.name ?? 'missing body';
}

const planeOffset = (p: { origin: number[]; normal: number[] }) => {
  const n = Math.hypot(p.normal[0], p.normal[1], p.normal[2]) || 1;
  return Math.round(((p.origin[0] * p.normal[0] + p.origin[1] * p.normal[1] + p.origin[2] * p.normal[2]) / n) * 1000) / 1000;
};
function withOffset<P extends { origin: [number, number, number]; normal: [number, number, number] }>(p: P, v: number): P {
  const n = Math.hypot(...p.normal) || 1;
  const d = v - planeOffset(p);
  return { ...p, origin: p.origin.map((o, i) => Math.round((o + (p.normal[i] / n) * d) * 1000) / 1000) as [number, number, number] };
}

function sketchesBefore(fid: string) {
  const idx = store.doc.features.findIndex((x) => x.id === fid);
  return store.doc.features.slice(0, idx < 0 ? undefined : idx).filter((x) => x.type === 'sketch');
}

function SketchSelect(props: { value: string; before: string; onChange: (id: string) => void }) {
  useStore((s) => s.doc);
  return (
    <select class="select" value={props.value} onChange={(e) => props.onChange((e.currentTarget as HTMLSelectElement).value)}>
      {sketchesBefore(props.before).map((k) => <option key={k.id} value={k.id}>{k.name}</option>)}
    </select>
  );
}

function LoftSections({ f }: { f: Extract<Feature, { type: 'loft' }> }) {
  useStore((s) => s.doc);
  const all = sketchesBefore(f.id);
  const name = (id: string) => all.find((k) => k.id === id)?.name ?? 'missing sketch';
  const move = (i: number, d: number) => edit(f.id, 'Reorder loft', (x) => {
    const ids = [...x.sketchIds];
    const j = i + d;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    x.sketchIds = ids;
  });
  return (
    <Section title="Loft through">
      {f.sketchIds.map((id, i) => (
        <div key={id} class="loft-row">
          <span class="loft-n">{i + 1}</span>
          <span class="grow">{name(id)}</span>
          <button class="mini-btn" disabled={i === 0} onClick={() => move(i, -1)} data-tip-title="Move up"><ArrowUp size={13} /></button>
          <button class="mini-btn" disabled={i === f.sketchIds.length - 1} onClick={() => move(i, 1)} data-tip-title="Move down"><ArrowDown size={13} /></button>
          <button class="mini-btn" disabled={f.sketchIds.length <= 2} onClick={() => edit(f.id, 'Remove loft section', (x) => { x.sketchIds = x.sketchIds.filter((s: string) => s !== id); })} data-tip-title="Remove"><Trash2 size={13} /></button>
        </div>
      ))}
      <div class="chips" style={{ marginTop: 8 }}>
        {all.filter((k) => !f.sketchIds.includes(k.id)).map((k) => (
          <button key={k.id} class="chip" onClick={() => edit(f.id, 'Add loft section', (x) => { x.sketchIds = [...x.sketchIds, k.id]; })}>+ {k.name}</button>
        ))}
      </div>
      <Field label="Smooth" tip="Curve smoothly through 3+ sections instead of straight between them.">
        <Toggle value={f.smooth} onChange={(v) => edit(f.id, 'Smooth loft', (x) => { x.smooth = v; })} />
      </Field>
    </Section>
  );
}

function FeatureEditor({ f, withTransform = true }: { f: Feature; withTransform?: boolean }) {
  switch (f.type) {
    case 'primitive':
      return <>
        <ShapeParams f={f} />
        <OperationEditor f={f} />
        {withTransform && <TransformEditor fid={f.id} t={f.transform} />}
      </>;
    case 'extrude':
      return <>
        <Section title="Extrude">
          <Field label="Distance">
            <PNum f={f} path="distance" title="Change distance" unit="mm" label="↕" min={-5000} max={5000} nonZero />
          </Field>
          <Field label="Both sides" tip="Extrude equally up and down from the sketch.">
            <Toggle value={f.symmetric} onChange={(v) => edit(f.id, 'Symmetric', (x) => { x.symmetric = v; })} />
          </Field>
          <Field label="Round edges" tip="Rounds the top and bottom edges (a fillet).">
            <PNum f={f} path="roundEdges" title="Round edges" unit="mm" label="◠" min={0} max={500} step={0.5} />
          </Field>
          <SketchLink sketchId={f.sketchId} />
        </Section>
        <OperationEditor f={f} />
        {withTransform && <TransformEditor fid={f.id} t={f.transform} />}
      </>;
    case 'revolve':
      return <>
        <Section title="Revolve">
          <Field label="Axis" tip="Spin around the sketch's vertical (Y) or horizontal (X) axis.">
            <Segmented value={f.axis} onChange={(v) => edit(f.id, 'Change axis', (x) => { x.axis = v; })} options={[
              { value: 'y', label: 'Vertical' }, { value: 'x', label: 'Horizontal' },
            ]} />
          </Field>
          <Field label="Angle">
            <PNum f={f} path="angle" title="Change angle" unit="°" label="∠" min={1} max={360} step={5} />
          </Field>
          <SketchLink sketchId={f.sketchId} />
        </Section>
        <OperationEditor f={f} />
        {withTransform && <TransformEditor fid={f.id} t={f.transform} />}
      </>;
    case 'combine':
      return <Section title="Combine">
        <Field label="Operation">
          <Segmented value={f.op} onChange={(v) => edit(f.id, 'Change operation', (x) => { x.op = v; })} options={[
            { value: 'join', label: 'Join', cls: 'join' }, { value: 'cut', label: 'Cut', cls: 'cut' }, { value: 'intersect', label: 'Intersect', cls: 'inter' },
          ]} />
        </Field>
        <Field label="Target"><span>{bodyName(f.targetId)}</span></Field>
        <Field label="Tools"><div class="chips">{f.toolIds.map((t) => <span key={t} class="chip">{bodyName(t)}</span>)}</div></Field>
        <Field label="Keep tools" tip="Keep the tool bodies after combining instead of hiding them.">
          <Toggle value={f.keepTools} onChange={(v) => edit(f.id, 'Keep tools', (x) => { x.keepTools = v; })} />
        </Field>
      </Section>;
    case 'move':
      return <>
        <Section title="Move">
          <Field label="Bodies"><div class="chips">{f.bodyIds.map((t) => <span key={t} class="chip">{bodyName(t)}</span>)}</div></Field>
          <Field label="Make a copy"><Toggle value={f.copy} onChange={(v) => edit(f.id, 'Copy', (x) => { x.copy = v; })} /></Field>
        </Section>
        <TransformEditor fid={f.id} t={f.transform} offsetLabel />
      </>;
    case 'pattern':
      return <Section title={f.kind === 'linear' ? 'Pattern' : 'Circular pattern'}>
        <Field label="Type">
          <Segmented value={f.kind} onChange={(v) => edit(f.id, 'Pattern type', (x) => { x.kind = v; })} options={[
            { value: 'linear', label: <><Repeat size={13} /> Row</> }, { value: 'circular', label: <><Orbit size={13} /> Circle</> },
          ]} />
        </Field>
        <Field label="Count">
          <PNum f={f} path="count" title="Pattern count" integer min={1} max={200} label="#" />
        </Field>
        {f.kind === 'linear' ? <>
          <Field label="Spacing">
            <PNum f={f} path="spacing" title="Pattern spacing" unit="mm" label="↔" min={-10000} max={10000} />
          </Field>
          <Field label="Direction">
            <Segmented value={f.direction} onChange={(v) => edit(f.id, 'Pattern direction', (x) => { x.direction = v; })} options={[
              { value: 'x', label: 'X' }, { value: 'y', label: 'Y' }, { value: 'z', label: 'Z' },
            ]} />
          </Field>
        </> : <>
          <Field label="Angle">
            <PNum f={f} path="angle" title="Pattern angle" unit="°" label="∠" min={-360} max={360} step={15} />
          </Field>
          <Field label="Axis">
            <Segmented value={f.axis} onChange={(v) => edit(f.id, 'Pattern axis', (x) => { x.axis = v; })} options={[
              { value: 'x', label: 'X' }, { value: 'y', label: 'Y (up)' }, { value: 'z', label: 'Z' },
            ]} />
          </Field>
          <Field stack label="Centre"><Vec3Field value={f.center} onChange={(v, live) => edit(f.id, 'Pattern centre', (x) => { x.center = v; }, live)} onCommit={commit('Pattern centre')} /></Field>
        </>}
        <Field label="Bodies"><div class="chips">{f.bodyIds.map((t) => <span key={t} class="chip">{bodyName(t)}</span>)}</div></Field>
      </Section>;
    case 'mirror':
      return <Section title="Mirror">
        <Field label="Across">
          <Segmented value={f.plane} onChange={(v) => edit(f.id, 'Mirror plane', (x) => { x.plane = v; })} options={[
            { value: 'yz', label: 'Left↔Right' }, { value: 'xy', label: 'Front↔Back' }, { value: 'xz', label: 'Up↔Down' },
          ]} />
        </Field>
        <Field label="Plane offset">
          <PNum f={f} path="offset" title="Mirror offset" unit="mm" label="↔" />
        </Field>
        <Field label="Bodies"><div class="chips">{f.bodyIds.map((t) => <span key={t} class="chip">{bodyName(t)}</span>)}</div></Field>
      </Section>;
    case 'sketch':
      return <Section title="Sketch">
        <Field label="Plane"><span>{f.plane.label}</span></Field>
        <Field label="Plane offset" tip="Slide the whole sketch along its plane's normal — e.g. raise it for a loft.">
          <NumberField value={planeOffset(f.plane)} unit="mm" label="↕"
            onChange={(v, live) => edit(f.id, 'Move sketch plane', (x) => { x.plane = withOffset(x.plane, v); }, live)} onCommit={commit('Move sketch plane')} />
        </Field>
        <Field label="Shapes"><span>{f.entities.length}</span></Field>
        <div class="row-actions">
          <button class="btn small" onClick={() => A.editSketch(f.id)}><Pencil size={13} /> Edit</button>
          <button class="btn small primary" onClick={() => { A.selectFeature(f.id); A.extrude(); }}><ArrowUpFromLine size={13} /> Extrude</button>
          <button class="btn small" onClick={() => { A.selectFeature(f.id); A.revolve(); }}><RotateCw size={13} /> Revolve</button>
        </div>
      </Section>;
    case 'import':
      return withTransform ? <TransformEditor fid={f.id} t={f.transform} /> : null;
    case 'loft':
      return <>
        <LoftSections f={f} />
        <OperationEditor f={f} />
        {withTransform && <TransformEditor fid={f.id} t={f.transform} />}
      </>;
    case 'sweep':
      return <>
        <Section title="Sweep">
          <Field label="Profile" tip="The closed shape that travels along the path.">
            <SketchSelect value={f.profileId} before={f.id} onChange={(id) => edit(f.id, 'Sweep profile', (x) => { x.profileId = id; })} />
          </Field>
          <Field label="Path" tip="An open line or spline (or a loop) that the profile follows.">
            <SketchSelect value={f.pathId} before={f.id} onChange={(id) => edit(f.id, 'Sweep path', (x) => { x.pathId = id; })} />
          </Field>
          <Field label="Twist" tip="Rotate the profile along the path — springs, drills, ropes.">
            <PNum f={f} path="twist" title="Twist" unit="°" label="↻" step={15} min={-7200} max={7200} />
          </Field>
          <div class="row-actions"><button class="btn small" onClick={() => A.editSketch(f.pathId)}><Pencil size={13} /> Edit path</button><button class="btn small" onClick={() => A.editSketch(f.profileId)}><Pencil size={13} /> Edit profile</button></div>
        </Section>
        <OperationEditor f={f} />
        {withTransform && <TransformEditor fid={f.id} t={f.transform} />}
      </>;
    case 'fillet':
    case 'shell':
    case 'draft': {
      const isEdges = f.type === 'fillet';
      const refs = f.type === 'fillet' ? f.edges : f.faces;
      return <Section title={f.type === 'fillet' ? (f.mode === 'fillet' ? 'Fillet' : 'Chamfer') : f.type === 'shell' ? 'Shell' : 'Draft'}>
        <Field label="Body"><span>{bodyName(f.bodyId)}</span></Field>
        {f.type === 'fillet' && (
          <Field label="Style">
            <Segmented value={f.mode} onChange={(v) => edit(f.id, 'Fillet style', (x) => { x.mode = v; })} options={[
              { value: 'fillet', label: 'Round' }, { value: 'chamfer', label: 'Bevel' },
            ]} />
          </Field>
        )}
        {f.type === 'fillet' && <Field label={f.mode === 'fillet' ? 'Radius' : 'Distance'}><PNum f={f} path="radius" title="Fillet size" unit="mm" label="◠" min={0.01} max={1000} step={0.5} /></Field>}
        {f.type === 'shell' && <Field label="Wall"><PNum f={f} path="thickness" title="Wall thickness" unit="mm" label="▭" min={0.05} max={1000} step={0.5} /></Field>}
        {f.type === 'draft' && <Field label="Angle"><PNum f={f} path="angle" title="Draft angle" unit="°" label="∠" min={-45} max={45} step={1} /></Field>}
        <Field label={isEdges ? 'Edges' : 'Faces'}>
          <span>{refs.length ? `${refs.length} picked` : isEdges ? 'all edges' : f.type === 'shell' ? 'top face (auto)' : 'none'}</span>
        </Field>
        <div class="row-actions"><button class="btn small" onClick={() => A.editPick(f.id)}><Pencil size={13} /> Re-pick {isEdges ? 'edges' : 'faces'}</button></div>
        <div style={{ fontSize: 11.5, color: 'var(--text-3)', lineHeight: 1.5, marginTop: 8 }}>Needs the precise engine — the quick preview shows the body without it while you drag.</div>
      </Section>;
    }
    case 'split':
      return <Section title="Split body">
        <Field label="Body"><span>{bodyName(f.bodyId)}</span></Field>
        <Field label="Cut across" tip="The direction the cutting plane faces.">
          <Segmented value={f.axis} onChange={(v) => edit(f.id, 'Split axis', (x) => { x.axis = v; })} options={[
            { value: 'y', label: 'Height (Y)' }, { value: 'x', label: 'X' }, { value: 'z', label: 'Z' },
          ]} />
        </Field>
        <Field label="Position"><PNum f={f} path="offset" title="Split position" unit="mm" label="↕" /></Field>
        <div style={{ fontSize: 11.5, color: 'var(--text-3)', lineHeight: 1.5 }}>Splits the body into two parts at this plane — handy when a model is too big for your printer, or to print each half flat.</div>
      </Section>;
  }
}

function FeatureFooter({ f }: { f: Feature }) {
  const err = useStore((s) => s.result.errors[f.id]);
  return <>
    {err && <div class="insp-section"><div class="hint-box error"><TriangleAlert size={16} /><span>{err}</span></div></div>}
    <Section title="Timeline">
      <Field label="Suppress" tip="Temporarily switch this step off without deleting it.">
        <Toggle value={!!f.suppressed} onChange={() => A.toggleSuppress(f.id)} />
      </Field>
      <div class="row-actions"><button class="btn small danger" onClick={() => A.deleteFeature(f.id)}><Trash2 size={13} /> Delete step</button></div>
    </Section>
  </>;
}

// ---------------------------------------------------------------------------
// body inspector

function Appearance({ ids }: { ids: string[] }) {
  const bodies = ids.map(A.bodyById).filter(Boolean) as EvalBody[];
  if (!bodies.length) return null;
  const ap = bodies[0].appearance;
  return (
    <Section title="Look">
      <Field label="Material">
        <select class="select" value={ap.material} onChange={(e) => {
          const m = materialById((e.currentTarget as HTMLSelectElement).value);
          A.setAppearance(ids, { material: m.id, color: m.metalness > 0.5 || m.transparent ? m.defaultColor : ap.color });
        }}>
          {MATERIALS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
        </select>
      </Field>
      <div class="swatches" style={{ marginBottom: 8 }}>
        {SWATCHES.map((c) => (
          <button key={c} class={`swatch ${ap.color.toLowerCase() === c ? 'on' : ''}`} style={{ background: c }} onClick={() => A.setAppearance(ids, { color: c })} aria-label={c} />
        ))}
      </div>
      <Field label="Custom colour">
        <input type="color" value={ap.color} style={{ width: '100%', height: 28, border: 0, background: 'transparent', padding: 0 }}
          onChange={(e) => A.setAppearance(ids, { color: (e.currentTarget as HTMLInputElement).value })} />
      </Field>
    </Section>
  );
}

function Physical({ bodies }: { bodies: EvalBody[] }) {
  const key = bodies.map((b) => b.key + b.matrix.elements.join()).join('|') + bodies.map((b) => b.appearance.material).join();
  const stats = useMemo(() => {
    let vol = 0, area = 0, mass = 0, tris = 0;
    const box = new THREE.Box3();
    for (const b of bodies) {
      const v = computeVolume(b.geometry, b.matrix);
      vol += v;
      area += computeArea(b.geometry, b.matrix);
      mass += (v / 1000) * materialById(b.appearance.material).density;
      tris += triangleCount(b.geometry);
      box.union(bodyBounds(b));
    }
    return { vol, area, mass, tris, size: box.getSize(new THREE.Vector3()) };
  }, [key]);
  // exact numbers from the precise engine replace the mesh estimates when they arrive
  const [exact, setExact] = useState<{ key: string; p: MassPayload } | null>(null);
  useEffect(() => {
    let live = true;
    const t = setTimeout(() => {
      kernel.props(store.doc, bodies.map((b) => b.id)).then((p) => { if (live && p && p.mass > 0) setExact({ key, p }); }).catch(() => {});
    }, 250);
    return () => { live = false; clearTimeout(t); };
  }, [key]);
  const x = exact?.key === key && !exact.p.skipped.length ? exact.p : null;
  const vol = x ? x.volume : stats.vol, area = x ? x.area : stats.area, mass = x ? x.mass : stats.mass;
  // inertia: g·mm² → kg·mm²
  const kgmm2 = (v: number) => (v / 1000).toPrecision(4);
  return (
    <Section title="Measurements" right={x ? <span class="dof-chip ok" data-tip-title="Exact" data-tip-desc="Measured on the exact B-rep solid, not the display mesh.">Exact</span> : undefined}>
      <div class="stats">
        <div class="stat" style={{ gridColumn: '1 / -1' }}><div class="k">Size (W × H × D)</div><div class="v">{fmt(stats.size.x)} × {fmt(stats.size.y)} × {fmt(stats.size.z)} mm</div></div>
        <div class="stat"><div class="k">Volume</div><div class="v">{fmt(vol / 1000)} cm³</div></div>
        <div class="stat"><div class="k">Mass</div><div class="v">{fmt(mass)} g</div></div>
        <div class="stat"><div class="k">Surface</div><div class="v">{fmt(area / 100)} cm²</div></div>
        <div class="stat"><div class="k">Triangles</div><div class="v">{stats.tris.toLocaleString()}</div></div>
        {x && <>
          <div class="stat" style={{ gridColumn: '1 / -1' }}><div class="k">Centre of mass (X, Y, Z)</div><div class="v">{x.center.map(fmt).join(', ')} mm</div></div>
          <div class="stat" style={{ gridColumn: '1 / -1' }} data-tip-title="Principal moments of inertia" data-tip-desc="About the centre of mass, using each body’s material density.">
            <div class="k">Principal inertia (kg·mm²)</div><div class="v">{x.principal.map(kgmm2).join(' · ')}</div>
          </div>
          <div class="stat" style={{ gridColumn: '1 / -1' }}><div class="k">Ixx · Iyy · Izz (kg·mm²)</div><div class="v">{[0, 1, 2].map((i) => kgmm2(x.inertia[i][i])).join(' · ')}</div></div>
        </>}
      </div>
    </Section>
  );
}

function Head({ color, icon: Icon, title, sub, onRename }: { color: string; icon: any; title: string; sub: string; onRename?: (v: string) => void }) {
  return (
    <div class="insp-head">
      <div class="badge-icon" style={{ background: color }}><Icon size={18} /></div>
      <div class="titles">
        {onRename
          ? <input class="title-input" value={title} key={title}
            onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur(); }}
            onBlur={(e) => { const v = (e.currentTarget as HTMLInputElement).value.trim(); if (v && v !== title) onRename(v); }} />
          : <div style={{ fontWeight: 700, fontSize: 14.5 }}>{title}</div>}
        <div class="sub">{sub}</div>
      </div>
    </div>
  );
}

function BodyInspector({ body }: { body: EvalBody }) {
  useStore((s) => s.doc);
  const editable = featureOf(store.doc, body.editableFeatureId);
  const source = featureOf(store.doc, body.sourceFeatureId);
  const meta = TYPE_META[source?.type ?? 'primitive'];
  const shapeLabel = source?.type === 'primitive' ? shapeById(source.shape)?.label : meta.label;
  const combined = !body.editableFeatureId && source && body.lastFeatureId !== body.sourceFeatureId;
  const beginner = useStore((s) => s.beginner);
  return <>
    <Head color={body.appearance.color} icon={meta.icon} title={body.name} onRename={(v) => A.renameBody(body.id, v)}
      sub={`${shapeLabel ?? 'Body'}${combined ? ' · combined' : ''}`} />
    {editable && editable.id === source?.id && <FeatureEditor f={editable} />}
    {editable?.type === 'move' && <>{source && source.type !== 'move' && source.type !== 'pattern' && source.type !== 'mirror' && <FeatureEditor f={source} withTransform={false} />}<FeatureEditor f={editable} /></>}
    {!editable && source && (source.type === 'primitive' || source.type === 'extrude' || source.type === 'revolve' || source.type === 'loft' || source.type === 'sweep') && <FeatureEditor f={source} withTransform={false} />}
    {combined && beginner && (
      <div class="insp-section"><div class="hint-box"><Lightbulb size={16} /><span>This body has been combined. Dragging it adds a <b>Move</b> step to the timeline — earlier steps stay editable.</span></div></div>
    )}
    <Appearance ids={[body.id]} />
    <Physical bodies={[body]} />
    <Section title="Actions">
      <div class="row-actions">
        <button class="btn small" onClick={() => A.duplicate([body.id])}><Copy size={13} /> Duplicate</button>
        <button class="btn small" onClick={() => A.dropToGround([body.id])}><ArrowDownToLine size={13} /> To ground</button>
        <button class="btn small" onClick={() => A.toggleVisibility(body.id)}><EyeOff size={13} /> Hide</button>
        <button class="btn small danger" onClick={() => { A.select([body.id]); A.deleteSelection(); }}><Trash2 size={13} /> Delete</button>
      </div>
    </Section>
  </>;
}

function MultiInspector({ ids }: { ids: string[] }) {
  const bodies = ids.map(A.bodyById).filter(Boolean) as EvalBody[];
  return <>
    <Head color="var(--accent)" icon={Box} title={`${bodies.length} bodies selected`} sub={`First picked: ${bodies[0]?.name ?? ''}`} />
    <Section title="Combine">
      <div class="row-actions">
        <button class="btn small" onClick={() => A.combine('join')}><SquaresUnite size={13} style={{ color: 'var(--good)' }} /> Join</button>
        <button class="btn small" onClick={() => A.combine('cut')}><SquaresSubtract size={13} style={{ color: 'var(--hole)' }} /> Cut</button>
        <button class="btn small" onClick={() => A.combine('intersect')}><SquaresIntersect size={13} /> Intersect</button>
      </div>
      <div style={{ fontSize: 11.5, color: 'var(--text-3)', marginTop: 8, lineHeight: 1.5 }}>Cut removes the other bodies from <b>{bodies[0]?.name}</b> (the first one you picked).</div>
    </Section>
    <Section title="Align">
      {(['x', 'y', 'z'] as const).map((ax) => (
        <Field key={ax} label={`${ax.toUpperCase()} axis`}>
          <Segmented value={'' as any} onChange={(m: any) => A.align(ax, m)} options={[
            { value: 'min', label: 'Min' }, { value: 'center', label: 'Centre' }, { value: 'max', label: 'Max' },
          ]} />
        </Field>
      ))}
    </Section>
    <Appearance ids={ids} />
    <Physical bodies={bodies} />
    <Section title="Actions">
      <div class="row-actions">
        <button class="btn small" onClick={() => A.duplicate()}><Copy size={13} /> Duplicate</button>
        <button class="btn small" onClick={() => A.addPattern('linear')}><Repeat size={13} /> Pattern</button>
        <button class="btn small" onClick={() => A.addMirror()}><FlipHorizontal2 size={13} /> Mirror</button>
        <button class="btn small danger" onClick={() => A.deleteSelection()}><Trash2 size={13} /> Delete</button>
      </div>
    </Section>
  </>;
}

// ---------------------------------------------------------------------------
// sketch + measure + empty

function EntityEditor({ e }: { e: SketchEntity }) {
  const set = (patch: Partial<SketchEntity>, live: boolean) => A.updateSketchEntity(e.id, patch, live);
  const c = commit('Edit sketch');
  const n = (label: string, value: number, key: string, opts: { min?: number; unit?: string; scale?: number; integer?: boolean } = {}) => (
    <Field label={label}>
      <NumberField value={value} unit={opts.unit ?? 'mm'} min={opts.min} integer={opts.integer} label="↔" onCommit={c}
        onChange={(v, live) => set({ [key]: opts.scale ? v / opts.scale : v } as any, live)} />
    </Field>
  );
  const construction = (
    <Field label="Construction" tip="Dashed guide geometry: helps you place things but never becomes solid. Shortcut: X">
      <Toggle value={!!e.construction} onChange={() => A.toggleConstruction([e.id])} />
    </Field>
  );
  switch (e.kind) {
    case 'rect': return <>{n('X', e.x, 'x')}{n('Y', e.y, 'y')}{n('Width', e.w, 'w', { min: 0.01 })}{n('Height', e.h, 'h', { min: 0.01 })}{n('Corner radius', e.radius ?? 0, 'radius', { min: 0 })}{construction}</>;
    case 'circle': return <>{n('Centre X', e.cx, 'cx')}{n('Centre Y', e.cy, 'cy')}{n('Diameter', e.r * 2, 'r', { min: 0.01, scale: 2 })}{construction}</>;
    case 'polygon': return <>{n('Centre X', e.cx, 'cx')}{n('Centre Y', e.cy, 'cy')}{n('Radius', e.r, 'r', { min: 0.01 })}{n('Sides', e.sides, 'sides', { min: 3, unit: '', integer: true })}{n('Rotation', e.rotation, 'rotation', { unit: '°' })}{construction}</>;
    case 'slot': return <>{n('Width', e.r * 2, 'r', { min: 0.01, scale: 2 })}{construction}</>;
    case 'arc': {
      const r = Math.hypot(e.x1 - e.cx, e.y1 - e.cy);
      const scale = (v: number, live: boolean) => {
        const k = v / (r || 1);
        set({ x1: e.cx + (e.x1 - e.cx) * k, y1: e.cy + (e.y1 - e.cy) * k, x2: e.cx + (e.x2 - e.cx) * k, y2: e.cy + (e.y2 - e.cy) * k } as any, live);
      };
      return <>
        {n('Centre X', e.cx, 'cx')}{n('Centre Y', e.cy, 'cy')}
        <Field label="Radius"><NumberField value={r} unit="mm" min={0.01} label="↔" onCommit={c} onChange={scale} /></Field>
        {construction}
      </>;
    }
    case 'polyline':
    case 'spline':
      return <>
        <Field label="Points"><span>{e.points.length}</span></Field>
        <Field label="Closed"><Toggle value={e.closed} onChange={(v) => set({ closed: v } as any, false)} /></Field>
        {construction}
      </>;
  }
}

const TOOL_HELP: Record<string, string> = {
  select: 'Click a point, line or shape to select it; drag to move it — constraints keep everything connected. Drag empty space to box-select.',
  line: 'Click to place points. Click the first point again to close the shape. Double-click or Enter to stop. Snapping onto points joins them; level lines become Horizontal automatically.',
  rect: 'Click one corner, then the opposite corner. Type 40,20 then Enter for an exact size — it becomes dimensions you can change later.',
  crect: 'Click the centre, then a corner. Type 40,20 for an exact size.',
  circle: 'Click the centre, then the edge. Type a diameter then Enter.',
  polygon: 'Click the centre, then a corner. Change the number of sides in the ribbon.',
  slot: 'Click the first centre, the second centre, then move out to set the width.',
  spline: 'Click to add smooth curve points. Click the first point to close it.',
  arc: 'Click where the arc starts, then where it ends, then move to bend it and click. Lines and arcs that meet end to end make closed shapes.',
  dimension: 'Click a line (length), circle (diameter), arc (radius), or two items (distance or angle). Click where the label goes, then type the size — numbers or parameters like width / 2.',
  constrain: 'Click the items to constrain. Press Esc when you’re done.',
};

const C_NAME: Record<string, string> = {
  coincident: 'Coincident', horizontal: 'Horizontal', vertical: 'Vertical', parallel: 'Parallel', perpendicular: 'Perpendicular', equal: 'Equal',
  tangent: 'Tangent', concentric: 'Concentric', midpoint: 'Midpoint', onCurve: 'Point on curve', symmetric: 'Symmetric', fix: 'Lock',
  distance: 'Distance', hdistance: 'Horizontal distance', vdistance: 'Vertical distance', radius: 'Radius', diameter: 'Diameter', angle: 'Angle',
};

function DimensionField({ c }: { c: SketchConstraint }) {
  return (
    <NumberField value={c.value ?? 0} unit={c.type === 'angle' ? '°' : 'mm'} min={c.type === 'angle' ? -360 : 0} label="↔" expr={c.expr}
      onChange={(v, live) => A.setDimensionValue(c.id, v, live)} onCommit={commit('Change dimension')}
      onExpr={(x) => (x === null ? undefined : A.setDimension(c.id, x))} />
  );
}

function SketchInspector() {
  const s = useStore((s) => ({ tool: s.sketchTool, sel: s.sketchSelection, sketchId: s.sketchId, doc: s.doc }));
  const sk = featureOf(s.doc, s.sketchId);
  if (sk?.type !== 'sketch') return null;
  const cs = sk.constraints ?? [];
  const refs = s.sel.map(A.parseRefKey).filter((r): r is NonNullable<typeof r> => !!r);
  const selectedIds = [...new Set(refs.map((r) => r.e))];
  const selected = sk.entities.filter((e) => selectedIds.includes(e.id));
  const selCons = cs.filter((c) => s.sel.includes(`#${c.id}`));
  const dims = cs.filter((c) => isDimension(c.type));
  const info = cs.length ? analyzeSketch(sk.entities, cs) : null;
  return <>
    <Head color="var(--good)" icon={PenLine} title={sk.name} sub={`Sketching on ${sk.plane.label}`} onRename={(v) => A.renameFeature(sk.id, v)} />
    <div class="insp-section"><div class="hint-box"><Lightbulb size={16} /><span>{TOOL_HELP[s.tool]}</span></div></div>
    {selCons.length > 0 && <Section title={selCons.length === 1 ? C_NAME[selCons[0].type] : `${selCons.length} constraints`}>
      {selCons.length === 1 && isDimension(selCons[0].type) && <Field label="Value" tip="Type a number or a formula using parameters, like width / 2.">
        <DimensionField c={selCons[0]} />
      </Field>}
      <div class="row-actions"><button class="btn small" onClick={() => A.deleteSketchEntities()}><Trash2 size={13} /> Delete</button></div>
    </Section>}
    {selected.length === 1 && <Section title={`Selected ${selected[0].kind}`}><EntityEditor e={selected[0]} /></Section>}
    {selected.length > 1 && <Section title="Selection">
      <span>{selected.length} shapes selected</span>
      <div class="row-actions"><button class="btn small" onClick={() => A.toggleConstruction()}>Toggle construction</button></div>
    </Section>}
    {dims.length > 0 && <Section title={`Dimensions (${dims.length})`} right={info && <span class={`dof-chip ${!info.ok ? 'bad' : info.dof ? 'free' : 'ok'}`}>{!info.ok ? 'Conflict' : info.dof ? `${info.dof} free` : 'Fully constrained'}</span>}>
      {dims.map((c) => (
        <Field key={c.id} label={C_NAME[c.type]}>
          <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
            <DimensionField c={c} />
          </div>
        </Field>
      ))}
    </Section>}
    {cs.length > dims.length && <Section title={`Constraints (${cs.length - dims.length})`}>
      <div class="chips">
        {cs.filter((c) => !isDimension(c.type)).map((c) => (
          <button key={c.id} class={`chip ${s.sel.includes(`#${c.id}`) ? 'on' : ''} ${info?.failing.includes(c.id) ? 'bad' : ''}`}
            onClick={() => store.set({ sketchSelection: [`#${c.id}`], sketchTool: 'select' })}>{C_NAME[c.type]}</button>
        ))}
      </div>
    </Section>}
    <Section title="Turn it into 3D">
      <div class="row-actions">
        <button class="btn small primary" onClick={() => A.extrude()}><ArrowUpFromLine size={13} /> Extrude</button>
        <button class="btn small" onClick={() => A.revolve()}><RotateCw size={13} /> Revolve</button>
      </div>
      <div style={{ fontSize: 11.5, color: 'var(--text-3)', marginTop: 8, lineHeight: 1.5 }}>Closed shapes fill in blue — those become solid. Shapes inside other shapes become holes. Dashed construction lines never do.</div>
    </Section>
    <Section title={`Shapes in sketch (${sk.entities.length})`}>
      {sk.entities.length === 0 && <span style={{ color: 'var(--text-3)' }}>Nothing drawn yet.</span>}
      <div class="chips">
        {sk.entities.map((e, i) => (
          <button key={e.id} class={`chip ${selectedIds.includes(e.id) ? 'on' : ''}`} onClick={() => store.set({ sketchSelection: [e.id], sketchTool: 'select' })}>{e.construction ? '┄ ' : ''}{e.kind} {i + 1}</button>
        ))}
      </div>
    </Section>
  </>;
}

function MeasureInspector() {
  const m = useStore((s) => s.measure);
  const d = m.a && m.b ? [m.b[0] - m.a[0], m.b[1] - m.a[1], m.b[2] - m.a[2]] : null;
  return <>
    <Head color="#f59e0b" icon={Ruler} title="Measure" sub="Click two points on your model" />
    <Section title="Result">
      {!d && <div class="hint-box"><Lightbulb size={16} /><span>{m.a ? 'Now click the second point.' : 'Click the first point. Corners snap automatically.'}</span></div>}
      {d && <div class="stats">
        <div class="stat" style={{ gridColumn: '1 / -1' }}><div class="k">Distance</div><div class="v" style={{ fontSize: 18 }}>{fmt(Math.hypot(d[0], d[1], d[2]))} mm</div></div>
        <div class="stat"><div class="k" style={{ color: '#f87171' }}>ΔX</div><div class="v">{fmt(d[0])} mm</div></div>
        <div class="stat"><div class="k" style={{ color: '#4ade80' }}>ΔY</div><div class="v">{fmt(d[1])} mm</div></div>
        <div class="stat"><div class="k" style={{ color: '#60a5fa' }}>ΔZ</div><div class="v">{fmt(d[2])} mm</div></div>
      </div>}
    </Section>
  </>;
}

function DesignInspector() {
  const s = useStore((s) => ({ bodies: s.result.bodies.length, features: s.doc.features.length, beginner: s.beginner, name: s.doc.name, section: s.section }));
  const quick = ['box', 'cylinder', 'sphere', 'star', 'heart', 'text'];
  return <>
    <Head color="var(--panel-3)" icon={Sparkles} title={s.name} sub={`${s.bodies} bodies · ${s.features} steps`} />
    <Section title="Quick add">
      <div class="quick-grid">
        {quick.map((id) => {
          const d = SHAPES.find((x) => x.id === id)!;
          return (
            <button key={id} class="quick-shape" draggable onClick={() => A.addShape(id)}
              onDragStart={(e) => e.dataTransfer!.setData('text/kimatic-shape', id)}>
              <img src={shapeThumbnail(id)} alt="" />{d.label}
            </button>
          );
        })}
      </div>
    </Section>
    {s.section.enabled && <SectionSettings />}
    {s.beginner && (
      <Section title="How to">
        <ul class="tips">
          <li><b>Add</b> a shape, then drag the arrows to move it.</li>
          <li><b>Orbit</b>: drag empty space. <b>Pan</b>: right-drag. <b>Zoom</b>: scroll.</li>
          <li>Make a shape a <b>Hole</b> to cut it out of whatever it touches.</li>
          <li>Every step lands in the <b>timeline</b> — click any step to change it later.</li>
          <li><b>Sketch</b> (S) → draw → <b>Extrude</b> (E) for custom parts.</li>
          <li>Press <b>Ctrl+P</b> to search every tool.</li>
        </ul>
      </Section>
    )}
  </>;
}

function SectionSettings() {
  const sec = useStore((s) => s.section);
  const set = (p: Partial<typeof sec>) => store.set({ section: { ...sec, ...p } });
  return (
    <Section title="Section view" right={<button class="mini-btn" onClick={() => set({ enabled: false })} data-tip-title="Turn off"><CircleOff size={14} /></button>}>
      <Field label="Cut along"><Segmented value={sec.axis} onChange={(axis) => set({ axis })} options={[{ value: 'x', label: 'X' }, { value: 'y', label: 'Y' }, { value: 'z', label: 'Z' }]} /></Field>
      <Field label="Position">
        <div class="slider-row">
          <input type="range" min={-150} max={150} step={0.5} value={sec.offset} onInput={(e) => set({ offset: Number((e.currentTarget as HTMLInputElement).value) })} />
          <span style={{ width: 44, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{sec.offset}</span>
        </div>
      </Field>
      <Field label="Flip side"><Toggle value={sec.flip} onChange={(flip) => set({ flip })} /></Field>
    </Section>
  );
}

export function Inspector() {
  const s = useStore((s) => ({ mode: s.mode, selection: s.selection, selectedFeature: s.selectedFeature, result: s.result, doc: s.doc, section: s.section.enabled }));
  let content;
  if (s.mode === 'sketch') content = <SketchInspector />;
  else if (s.mode === 'measure') content = <MeasureInspector />;
  else if (s.selection.length > 1) content = <MultiInspector ids={s.selection} />;
  else if (s.selection.length === 1 && A.bodyById(s.selection[0])) content = <>{s.section && <SectionSettings />}<BodyInspector body={A.bodyById(s.selection[0])!} /></>;
  else if (s.selectedFeature && featureOf(s.doc, s.selectedFeature)) {
    const f = featureOf(s.doc, s.selectedFeature)!;
    const meta = TYPE_META[f.type];
    content = <>
      <Head color={meta.color} icon={meta.icon} title={f.name} sub={`${meta.label} step${f.type === 'primitive' && f.op === 'cut' ? ' · hole' : ''}`} onRename={(v) => A.renameFeature(f.id, v)} />
      <FeatureEditor f={f} />
      <FeatureFooter f={f} />
    </>;
  } else content = <DesignInspector />;
  return (
    <aside class="panel right" data-tour="inspector">
      <div class="panel-head">Properties<span class="spacer" /><button class="mini-btn mobile-only" onClick={() => store.set({ sheet: null })} aria-label="Close"><X size={16} /></button></div>
      <div class="panel-body">{content}</div>
    </aside>
  );
}
