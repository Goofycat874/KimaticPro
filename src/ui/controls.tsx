import { useEffect, useRef, useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';

const round = (v: number, step: number) => {
  const p = Math.max(0, -Math.floor(Math.log10(step || 1)));
  return Number((Math.round(v / step) * step).toFixed(Math.min(6, p + 2)));
};

/**
 * Number input with drag-to-scrub label, arrow-key stepping and maths
 * (type `20*2` or `=50/3`). onChange(value, live) — live=true while scrubbing.
 */
export function NumberField(props: {
  value: number;
  onChange: (v: number, live: boolean) => void;
  onCommit?: () => void;
  label?: string;
  labelClass?: string;
  unit?: string;
  step?: number;
  min?: number;
  max?: number;
  integer?: boolean;
}) {
  const { value, onChange, unit, label, labelClass, min = -1e9, max = 1e9, integer } = props;
  const step = props.step ?? (integer ? 1 : 1);
  const [text, setText] = useState(String(value));
  const [focus, setFocus] = useState(false);
  const dragRef = useRef<{ x: number; v: number; moved: boolean } | null>(null);

  useEffect(() => { if (!focus) setText(String(round(value, integer ? 1 : 0.001))); }, [value, focus]);

  const clamp = (v: number) => {
    let x = Math.min(max, Math.max(min, v));
    if (integer) x = Math.round(x);
    return x;
  };

  const commitText = () => {
    const src = text.trim().replace(/^=/, '');
    let v = Number(src);
    if (Number.isNaN(v) && /^[\d+\-*/().\s]+$/.test(src)) {
      try { v = Function(`"use strict";return (${src})`)(); } catch { v = NaN; }
    }
    if (!Number.isNaN(v) && Number.isFinite(v)) onChange(clamp(v), false);
    else setText(String(value));
  };

  const onPointerDown = (e: PointerEvent) => {
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    dragRef.current = { x: e.clientX, v: value, moved: false };
  };
  const onPointerMove = (e: PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const dx = e.clientX - d.x;
    if (Math.abs(dx) > 2) d.moved = true;
    if (!d.moved) return;
    const mult = e.shiftKey ? 10 : e.altKey ? 0.1 : 1;
    onChange(clamp(round(d.v + Math.round(dx / 3) * step * mult, integer ? 1 : step * (e.altKey ? 0.1 : 1))), true);
  };
  const onPointerUp = () => {
    const d = dragRef.current;
    dragRef.current = null;
    if (d?.moved) props.onCommit?.();
  };

  return (
    <div class="num">
      {label !== undefined && (
        <span class={`scrub ${labelClass ?? ''}`} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp}
          data-tip-title="Drag to change" data-tip-desc="Drag left/right. Hold Shift for big steps, Alt for fine steps.">
          {label}
        </span>
      )}
      <input
        value={text}
        onFocus={(e) => { setFocus(true); (e.currentTarget as HTMLInputElement).select(); }}
        onBlur={() => { setFocus(false); commitText(); }}
        onInput={(e) => setText((e.currentTarget as HTMLInputElement).value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter') { commitText(); (e.currentTarget as HTMLInputElement).blur(); }
          if (e.key === 'Escape') { setText(String(value)); (e.currentTarget as HTMLInputElement).blur(); }
          if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            e.preventDefault();
            const m = e.shiftKey ? 10 : e.altKey ? 0.1 : 1;
            onChange(clamp(round(value + (e.key === 'ArrowUp' ? 1 : -1) * step * m, integer ? 1 : 0.001)), false);
          }
        }}
      />
      {unit && <span class="unit">{unit}</span>}
    </div>
  );
}

export function Vec3Field(props: {
  value: [number, number, number];
  onChange: (v: [number, number, number], live: boolean) => void;
  onCommit?: () => void;
  step?: number;
  unit?: string;
}) {
  const axes = ['x', 'y', 'z'] as const;
  return (
    <div class="vec3">
      {axes.map((a, i) => (
        <NumberField
          key={a}
          label={a.toUpperCase()}
          labelClass={a}
          step={props.step}
          value={props.value[i]}
          onCommit={props.onCommit}
          onChange={(v, live) => {
            const next = [...props.value] as [number, number, number];
            next[i] = v;
            props.onChange(next, live);
          }}
        />
      ))}
    </div>
  );
}

export function Field(props: { label: string; children: ComponentChildren; tip?: string; stack?: boolean }) {
  return (
    <div class={`field ${props.stack ? 'stack' : ''}`}>
      <label data-tip-title={props.tip ? props.label : undefined} data-tip-desc={props.tip}>{props.label}</label>
      <div>{props.children}</div>
    </div>
  );
}

export function Segmented<T extends string>(props: {
  value: T;
  options: { value: T; label: ComponentChildren; cls?: string; tip?: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div class="seg">
      {props.options.map((o) => (
        <button key={o.value} class={`${props.value === o.value ? 'on' : ''} ${o.cls ?? ''}`} onClick={() => props.onChange(o.value)}
          data-tip-title={o.tip ? String(typeof o.label === 'string' ? o.label : o.value) : undefined} data-tip-desc={o.tip}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Toggle(props: { value: boolean; onChange: (v: boolean) => void; label?: string }) {
  return (
    <button class={`toggle ${props.value ? 'on' : ''}`} role="switch" aria-checked={props.value} aria-label={props.label}
      onClick={() => props.onChange(!props.value)} />
  );
}

export function Kbd({ k }: { k: string }) {
  return <span class="keys">{k.split('+').map((p) => <span class="kbd" key={p}>{p}</span>)}</span>;
}

/**
 * One global tooltip driven by data-tip-* attributes, so every button in the app
 * can explain itself to beginners without extra wiring.
 */
export function TooltipLayer() {
  const [tip, setTip] = useState<{ x: number; y: number; above: boolean; title: string; desc?: string; key?: string } | null>(null);
  useEffect(() => {
    let timer: any;
    let current: HTMLElement | null = null;
    const over = (e: MouseEvent) => {
      const el = (e.target as HTMLElement).closest?.('[data-tip-title]') as HTMLElement | null;
      if (el === current) return;
      current = el;
      clearTimeout(timer);
      setTip(null);
      if (!el) return;
      timer = setTimeout(() => {
        const r = el.getBoundingClientRect();
        const below = r.bottom + 120 < window.innerHeight;
        setTip({
          x: Math.min(window.innerWidth - 270, Math.max(8, r.left + r.width / 2 - 120)),
          y: below ? r.bottom + 8 : r.top - 8,
          above: !below,
          title: el.dataset.tipTitle!,
          desc: el.dataset.tipDesc,
          key: el.dataset.tipKey,
        });
      }, 420);
    };
    const hide = () => { clearTimeout(timer); current = null; setTip(null); };
    document.addEventListener('mouseover', over);
    document.addEventListener('pointerdown', hide);
    document.addEventListener('wheel', hide, { passive: true });
    return () => { document.removeEventListener('mouseover', over); document.removeEventListener('pointerdown', hide); };
  }, []);
  if (!tip) return null;
  return (
    <div class="tip" style={{ left: tip.x, top: tip.y, transform: tip.above ? 'translateY(-100%)' : undefined }}>
      <b>{tip.title}{tip.key && <Kbd k={tip.key} />}</b>
      {tip.desc && <p>{tip.desc}</p>}
    </div>
  );
}
