export interface MaterialPreset {
  id: string;
  label: string;
  /** Density in g/cm³, used for mass estimates. */
  density: number;
  metalness: number;
  roughness: number;
  defaultColor: string;
  transparent?: boolean;
  opacity?: number;
}

export const MATERIALS: MaterialPreset[] = [
  { id: 'pla', label: 'Plastic (PLA)', density: 1.24, metalness: 0, roughness: 0.45, defaultColor: '#3b82f6' },
  { id: 'abs', label: 'Plastic (ABS)', density: 1.04, metalness: 0, roughness: 0.6, defaultColor: '#f97316' },
  { id: 'resin', label: 'Resin', density: 1.18, metalness: 0, roughness: 0.2, defaultColor: '#a855f7' },
  { id: 'rubber', label: 'Rubber', density: 1.1, metalness: 0, roughness: 0.95, defaultColor: '#27272a' },
  { id: 'wood', label: 'Wood (Oak)', density: 0.75, metalness: 0, roughness: 0.8, defaultColor: '#b07a46' },
  { id: 'aluminum', label: 'Aluminum', density: 2.7, metalness: 1, roughness: 0.35, defaultColor: '#c9ced6' },
  { id: 'steel', label: 'Steel', density: 7.85, metalness: 1, roughness: 0.28, defaultColor: '#8d939c' },
  { id: 'brass', label: 'Brass', density: 8.5, metalness: 1, roughness: 0.25, defaultColor: '#d4a64a' },
  { id: 'gold', label: 'Gold', density: 19.3, metalness: 1, roughness: 0.18, defaultColor: '#f5c542' },
  { id: 'copper', label: 'Copper', density: 8.96, metalness: 1, roughness: 0.3, defaultColor: '#c8734a' },
  { id: 'glass', label: 'Glass', density: 2.5, metalness: 0, roughness: 0.05, defaultColor: '#a5d8ff', transparent: true, opacity: 0.45 },
  { id: 'concrete', label: 'Concrete', density: 2.4, metalness: 0, roughness: 1, defaultColor: '#9ca3af' },
];

export const materialById = (id: string): MaterialPreset =>
  MATERIALS.find((m) => m.id === id) ?? MATERIALS[0];

/** Friendly colour swatches — bright enough for kids, tasteful enough for pros. */
export const SWATCHES = [
  '#ef4444', '#f97316', '#f59e0b', '#eab308', '#84cc16', '#22c55e',
  '#14b8a6', '#06b6d4', '#3b82f6', '#6366f1', '#8b5cf6', '#d946ef',
  '#ec4899', '#f5f5f4', '#a8a29e', '#57534e', '#27272a', '#0a0a0a',
];

let swatchCursor = 8;
export const nextColor = () => {
  const palette = ['#3b82f6', '#f97316', '#22c55e', '#a855f7', '#ef4444', '#14b8a6', '#eab308', '#ec4899'];
  swatchCursor = (swatchCursor + 1) % palette.length;
  return palette[swatchCursor];
};
