import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { store, type AppState } from '../core/store';
import {
  addShape, createSketch, ensureEditable, layFlat, select, selectFeature, setTransform, viewApi, bodyById,
} from '../core/actions';
import { bodyBounds, featureOf, type EvalBody, type EvalGhost } from '../core/evaluator';
import { materialById } from '../core/materials';
import { planeFromFace, planeMatrix, STANDARD_PLANES } from '../core/sketch';
import type { PlaneDef, TRS, Vec3 } from '../core/types';
import { createGrid } from './grid';
import { printerById } from '../core/printing';
import { ViewCube } from './ViewCube';
import { SketchController } from './SketchController';
import { featureEdges } from './edges';

const DEG = 180 / Math.PI;
const ACCENT = '#2f7bff';

interface BodyView {
  mesh: THREE.Mesh;
  edges: THREE.LineSegments;
  cap: THREE.Mesh;
  material: THREE.MeshStandardMaterial;
  body: EvalBody;
}

const edgeCache = new WeakMap<THREE.BufferGeometry, THREE.BufferGeometry>();
const NO_EDGES = new THREE.BufferGeometry();
function edgesOf(g: THREE.BufferGeometry) {
  let e = edgeCache.get(g);
  if (!e) { e = featureEdges(g, g.userData.edgeAngle ?? 28); edgeCache.set(g, e); }
  return e;
}

/** Shared switch for the red "needs support" overhang tint on every body. */
const overhangUniform = { value: 0 };

function addOverhangShading(m: THREE.MeshStandardMaterial) {
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uOverhang = overhangUniform;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWorldN;\nvarying float vWorldY;')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvWorldN = normalize(mat3(modelMatrix) * objectNormal);\nvWorldY = (modelMatrix * vec4(transformed, 1.0)).y;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uOverhang;\nvarying vec3 vWorldN;\nvarying float vWorldY;')
      .replace('#include <color_fragment>', `#include <color_fragment>
        if (uOverhang > 0.5 && vWorldY > 0.3 && normalize(vWorldN).y < -0.7072) {
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(1.0, 0.12, 0.18), 0.8);
        }`);
  };
  m.customProgramCacheKey = () => 'kimatic-overhang';
}

export class Viewport {
  readonly el: HTMLDivElement;
  private canvas: HTMLCanvasElement;
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private persp = new THREE.PerspectiveCamera(40, 1, 0.5, 50000);
  private ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, -50000, 50000);
  private camera: THREE.PerspectiveCamera | THREE.OrthographicCamera = this.persp;
  private controls: OrbitControls;
  private gizmo: TransformControls;
  private gizmoHelper: THREE.Object3D;
  private holder = new THREE.Group();
  private proxy = new THREE.Object3D();
  private gizmoTarget: { fid: string | null; bodies: string[]; kind: 'frame' | 'move' | 'pending'; pivot: THREE.Vector3 } | null = null;
  private dragging = false;

  private bodiesGroup = new THREE.Group();
  private ghostGroup = new THREE.Group();
  private overlay = new THREE.Group();
  private planePicker = new THREE.Group();
  private views = new Map<string, BodyView>();
  private grid = createGrid({ axes: true });
  private shadowPlane: THREE.Mesh;
  private sun: THREE.DirectionalLight;
  private viewCube: ViewCube;
  private sketch: SketchController;
  private ray = new THREE.Raycaster();
  private down: { x: number; y: number; button: number; t: number } | null = null;
  private hoverId: string | null = null;
  private hoverPlane: THREE.Mesh | null = null;
  private needsRender = true;
  private anim: { from: THREE.Vector3; to: THREE.Vector3; tFrom: THREE.Vector3; tTo: THREE.Vector3; start: number; dur: number } | null = null;
  private section = new THREE.Plane(new THREE.Vector3(-1, 0, 0), 0);
  private labels: HTMLDivElement;
  private measureLabel: HTMLDivElement;
  private hud: HTMLDivElement;
  private size = { w: 1, h: 1 };
  private bed = new THREE.Group();
  private flatMarker = new THREE.Mesh(
    new THREE.RingGeometry(0.55, 1, 40),
    new THREE.MeshBasicMaterial({ color: ACCENT, transparent: true, opacity: 0.9, side: THREE.DoubleSide, depthTest: false }),
  );
  private dark = true;

  constructor() {
    this.el = document.createElement('div');
    this.el.className = 'viewport';
    this.canvas = document.createElement('canvas');
    this.el.appendChild(this.canvas);

    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.localClippingEnabled = true;

    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

    // lights
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x404a5a, 0.55));
    this.sun = new THREE.DirectionalLight(0xffffff, 1.6);
    this.sun.position.set(120, 260, 160);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.6;
    const sc = this.sun.shadow.camera;
    sc.left = sc.bottom = -300; sc.right = sc.top = 300; sc.near = 1; sc.far = 1200;
    this.scene.add(this.sun, this.sun.target);

    this.shadowPlane = new THREE.Mesh(new THREE.PlaneGeometry(4000, 4000), new THREE.ShadowMaterial({ opacity: 0.18 }));
    this.shadowPlane.rotation.x = -Math.PI / 2;
    this.shadowPlane.position.y = -0.05;
    this.shadowPlane.receiveShadow = true;
    this.scene.add(this.shadowPlane);

    this.grid.mesh.rotation.x = -Math.PI / 2;
    this.scene.add(this.grid.mesh);
    this.scene.add(this.bodiesGroup, this.ghostGroup, this.overlay, this.planePicker);

    // camera + navigation
    this.persp.position.set(140, 110, 170);
    this.controls = new OrbitControls(this.persp, this.canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.14;
    this.controls.zoomToCursor = true;
    this.controls.screenSpacePanning = true;
    this.controls.target.set(0, 10, 0);
    this.setMouseMode('model');
    this.controls.addEventListener('change', () => this.invalidate());
    this.controls.addEventListener('start', () => { this.anim = null; });

    // gizmo
    this.gizmo = new TransformControls(this.persp, this.canvas);
    this.gizmo.setSize(matchMedia('(pointer: coarse)').matches ? 1.35 : 0.9);
    this.gizmoHelper = this.gizmo.getHelper();
    this.scene.add(this.holder, this.gizmoHelper);
    this.holder.matrixAutoUpdate = false;
    this.holder.add(this.proxy);
    this.gizmo.addEventListener('change', () => this.invalidate());
    this.gizmo.addEventListener('dragging-changed', (e: any) => { this.controls.enabled = !e.value; });
    this.gizmo.addEventListener('mouseDown', () => this.onGizmoStart());
    this.gizmo.addEventListener('objectChange', () => this.onGizmoChange());
    this.gizmo.addEventListener('mouseUp', () => this.onGizmoEnd());
    this.applySnap();

    // overlays
    this.labels = document.createElement('div');
    this.labels.className = 'vp-labels';
    this.measureLabel = document.createElement('div');
    this.measureLabel.className = 'vp-measure';
    this.hud = document.createElement('div');
    this.hud.className = 'vp-hud';
    this.labels.append(this.measureLabel, this.hud);
    this.el.appendChild(this.labels);

    this.viewCube = new ViewCube((dir) => this.viewFrom(dir));
    this.el.appendChild(this.viewCube.el);

    this.sketch = new SketchController({
      camera: () => this.camera,
      dom: this.canvas,
      size: () => this.size,
      invalidate: () => this.invalidate(),
      hud: this.hud,
      accent: () => ACCENT,
    });
    this.scene.add(this.sketch.group);
    this.buildPlanePicker();
    this.scene.add(this.bed, this.flatMarker);
    this.flatMarker.visible = false;
    this.syncBed();

    this.bindEvents();
    new ResizeObserver(() => this.resize()).observe(this.el);
    store.subscribe((s, p) => this.onState(s, p));
    this.syncBodies();
    this.registerApi();
    this.loop();
  }

  // -------------------------------------------------------------------------
  // lifecycle

  private registerApi() {
    viewApi.groundTarget = () => this.groundTarget();
    viewApi.fit = (ids) => this.fit(ids);
    viewApi.lookAtPlane = (p) => this.lookAtPlane(p);
    viewApi.setView = (name) => this.setNamedView(name);
    viewApi.screenshot = () => this.screenshot();
  }

  invalidate() { this.needsRender = true; }

  private resize() {
    const w = Math.max(1, this.el.clientWidth), h = Math.max(1, this.el.clientHeight);
    this.size = { w, h };
    this.renderer.setSize(w, h, false);
    this.persp.aspect = w / h;
    this.persp.updateProjectionMatrix();
    this.updateOrtho();
    this.sketch.setResolution(w, h);
    this.invalidate();
  }

  private updateOrtho() {
    const dist = this.persp.position.distanceTo(this.controls.target);
    const hh = dist * Math.tan((this.persp.fov * Math.PI) / 360);
    const aspect = this.size.w / this.size.h;
    this.ortho.left = -hh * aspect; this.ortho.right = hh * aspect; this.ortho.top = hh; this.ortho.bottom = -hh;
    this.ortho.updateProjectionMatrix();
  }

  private loop = () => {
    requestAnimationFrame(this.loop);
    if (this.anim) {
      const t = Math.min(1, (performance.now() - this.anim.start) / this.anim.dur);
      const k = 1 - Math.pow(1 - t, 3);
      this.camera.position.lerpVectors(this.anim.from, this.anim.to, k);
      this.controls.target.lerpVectors(this.anim.tFrom, this.anim.tTo, k);
      if (this.camera === this.ortho) this.persp.position.copy(this.ortho.position);
      if (t >= 1) this.anim = null;
      this.needsRender = true;
    }
    this.controls.update();
    if (!this.needsRender) return;
    this.needsRender = false;
    this.render();
  };

  private render() {
    const dist = this.camera.position.distanceTo(this.controls.target) / (this.camera === this.ortho ? this.ortho.zoom : 1);
    this.grid.update(this.camera, dist);
    this.sketch.updateGrid(this.camera, dist, this.dark);
    this.sun.position.copy(this.controls.target).add(new THREE.Vector3(120, 260, 160));
    this.sun.target.position.copy(this.controls.target);
    this.renderer.render(this.scene, this.camera);
    this.viewCube.render(this.camera, this.controls.target);
    this.updateLabels();
  }

  // -------------------------------------------------------------------------
  // state sync

  private onState(s: AppState, p: AppState) {
    if (s.result !== p.result || s.displayMode !== p.displayMode || s.section !== p.section) this.syncBodies();
    if (s.result !== p.result || s.selection !== p.selection || s.selectedFeature !== p.selectedFeature
      || s.hovered !== p.hovered || s.showGhosts !== p.showGhosts || s.mode !== p.mode) {
      this.syncGhosts();
      this.syncHighlight();
      if (!this.dragging) this.syncGizmo();
    }
    if (s.result !== p.result || s.mode !== p.mode || s.sketchId !== p.sketchId || s.sketchSelection !== p.sketchSelection || s.selectedFeature !== p.selectedFeature) {
      this.sketch.rebuild();
    }
    if (s.mode !== p.mode) this.onModeChange(s.mode, p.mode);
    if (s.gizmo !== p.gizmo) { this.gizmo.setMode(s.gizmo); this.invalidate(); }
    if (s.snap !== p.snap) this.applySnap();
    if (s.theme !== p.theme) this.applyTheme();
    if (s.showGrid !== p.showGrid) { this.grid.mesh.visible = s.showGrid; this.invalidate(); }
    if (s.projection !== p.projection) this.setProjection(s.projection);
    if (s.measure !== p.measure) this.syncMeasure();
    if (s.showBed !== p.showBed || s.printerId !== p.printerId || s.result !== p.result || s.theme !== p.theme) this.syncBed();
    if (s.showOverhangs !== p.showOverhangs) { overhangUniform.value = s.showOverhangs ? 1 : 0; this.invalidate(); }
  }

  applyTheme() {
    this.dark = store.state.theme === 'dark';
    this.grid.setColor(this.dark ? '#c7d0e0' : '#5b6474', this.dark ? 0.75 : 0.85);
    (this.shadowPlane.material as THREE.ShadowMaterial).opacity = this.dark ? 0.32 : 0.16;
    this.viewCube.setTheme(this.dark);
    for (const v of this.views.values()) (v.edges.material as THREE.LineBasicMaterial).color.set(this.dark ? '#0b0d12' : '#1f2937');
    this.syncHighlight();
    this.invalidate();
  }

  private applySnap() {
    const s = store.state.snap || null;
    this.gizmo.setTranslationSnap(s);
    this.gizmo.setRotationSnap(s ? THREE.MathUtils.degToRad(15) : null);
    this.gizmo.setScaleSnap(s ? 0.05 : null);
  }

  private syncBodies() {
    const { result, displayMode, section } = store.state;
    const seen = new Set<string>();
    const clip = section.enabled ? [this.sectionPlane()] : [];
    for (const b of result.bodies) {
      seen.add(b.id);
      let v = this.views.get(b.id);
      const mp = materialById(b.appearance.material);
      if (!v) {
        const material = new THREE.MeshStandardMaterial({ polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
        addOverhangShading(material);
        const mesh = new THREE.Mesh(b.geometry, material);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.matrixAutoUpdate = false;
        mesh.userData.bodyId = b.id;
        const edges = new THREE.LineSegments(edgesOf(b.geometry), new THREE.LineBasicMaterial({ color: this.dark ? '#0b0d12' : '#1f2937', transparent: true, opacity: 0.55 }));
        edges.matrixAutoUpdate = false;
        edges.raycast = () => {};
        const cap = new THREE.Mesh(b.geometry, new THREE.MeshBasicMaterial({ color: '#ff5a5f', side: THREE.BackSide }));
        cap.matrixAutoUpdate = false;
        cap.raycast = () => {};
        this.bodiesGroup.add(mesh, edges, cap);
        v = { mesh, edges, cap, material, body: b };
        this.views.set(b.id, v);
      }
      v.body = b;
      if (v.mesh.geometry !== b.geometry) {
        v.mesh.geometry = b.geometry;
        v.cap.geometry = b.geometry;
        // edge extraction is the slowest part of a live drag: wait until the drag pauses
        const cached = edgeCache.get(b.geometry);
        if (cached) v.edges.geometry = cached;
        else { v.edges.geometry = NO_EDGES; this.queueEdges(); }
      }
      v.mesh.matrix.copy(b.matrix);
      v.edges.matrix.copy(b.matrix);
      v.cap.matrix.copy(b.matrix);
      v.mesh.matrixWorldNeedsUpdate = v.edges.matrixWorldNeedsUpdate = v.cap.matrixWorldNeedsUpdate = true;
      const m = v.material;
      m.color.set(b.appearance.color);
      m.metalness = mp.metalness;
      m.roughness = mp.roughness;
      const xray = displayMode === 'xray';
      const wire = displayMode === 'wire';
      m.transparent = xray || wire || !!mp.transparent;
      m.opacity = wire ? 0.06 : xray ? 0.32 : mp.opacity ?? 1;
      m.depthWrite = !(xray || wire || mp.transparent);
      m.clippingPlanes = clip;
      m.needsUpdate = true;
      (v.edges.material as THREE.LineBasicMaterial).clippingPlanes = clip;
      (v.edges.material as THREE.LineBasicMaterial).opacity = wire ? 0.95 : xray ? 0.7 : 0.55;
      (v.cap.material as THREE.MeshBasicMaterial).clippingPlanes = clip;
      v.edges.visible = b.visible && displayMode !== 'shaded';
      v.mesh.visible = b.visible;
      v.cap.visible = b.visible && section.enabled;
      v.mesh.castShadow = displayMode === 'shaded' || displayMode === 'edges';
    }
    for (const [id, v] of this.views) {
      if (seen.has(id)) continue;
      this.bodiesGroup.remove(v.mesh, v.edges, v.cap);
      v.material.dispose();
      (v.edges.material as THREE.Material).dispose();
      (v.cap.material as THREE.Material).dispose();
      this.views.delete(id);
    }
    this.syncHighlight();
    this.invalidate();
  }

  private edgeTimer: ReturnType<typeof setTimeout> | null = null;
  private queueEdges() {
    if (this.edgeTimer) clearTimeout(this.edgeTimer);
    this.edgeTimer = setTimeout(() => {
      this.edgeTimer = null;
      for (const v of this.views.values()) if (v.edges.geometry === NO_EDGES) v.edges.geometry = edgesOf(v.mesh.geometry);
      this.invalidate();
    }, 140);
  }

  private sectionPlane() {
    const { axis, offset, flip } = store.state.section;
    const n = new THREE.Vector3(axis === 'x' ? 1 : 0, axis === 'y' ? 1 : 0, axis === 'z' ? 1 : 0);
    if (!flip) n.negate();
    this.section.set(n, flip ? -offset : offset);
    return this.section;
  }

  private syncHighlight() {
    const { selection, hovered } = store.state;
    const sel = new Set(selection);
    for (const [id, v] of this.views) {
      const s = sel.has(id);
      const h = id === this.hoverId || id === hovered;
      v.material.emissive.set(s ? ACCENT : h ? '#ffffff' : '#000000');
      v.material.emissiveIntensity = s ? 0.22 : h ? 0.08 : 0;
      const em = v.edges.material as THREE.LineBasicMaterial;
      em.color.set(s ? ACCENT : this.dark ? '#0b0d12' : '#1f2937');
      em.opacity = s ? 1 : store.state.displayMode === 'wire' ? 0.95 : 0.55;
      if (s) v.edges.visible = v.body.visible;
      else v.edges.visible = v.body.visible && store.state.displayMode !== 'shaded';
    }
    this.invalidate();
  }

  private syncGhosts() {
    this.ghostGroup.traverse((o: any) => { if (o.material) o.material.dispose(); });
    this.ghostGroup.clear();
    const { result, selectedFeature, showGhosts, mode } = store.state;
    if (mode === 'sketch') return;
    const show = (g: EvalGhost) => showGhosts || g.featureId === selectedFeature;
    for (const g of result.ghosts) {
      if (!show(g)) continue;
      const active = g.featureId === selectedFeature;
      const color = g.op === 'cut' ? '#ff5a5f' : g.op === 'intersect' ? '#a855f7' : '#22c55e';
      const mesh = new THREE.Mesh(g.geometry, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: active ? 0.22 : 0.1, depthWrite: false }));
      mesh.matrixAutoUpdate = false;
      mesh.matrix.copy(g.matrix);
      mesh.userData.ghostFeature = g.featureId;
      mesh.renderOrder = 3;
      const edges = new THREE.LineSegments(edgesOf(g.geometry), new THREE.LineBasicMaterial({ color, transparent: true, opacity: active ? 0.95 : 0.4, depthTest: false }));
      edges.matrixAutoUpdate = false;
      edges.matrix.copy(g.matrix);
      edges.renderOrder = 4;
      edges.raycast = () => {};
      this.ghostGroup.add(mesh, edges);
    }
    this.invalidate();
  }

  // -------------------------------------------------------------------------
  // gizmo

  private syncGizmo() {
    const { mode, selection, selectedFeature, result } = store.state;
    this.gizmoTarget = null;
    if (mode !== 'model') { this.gizmo.detach(); this.invalidate(); return; }
    const editable = (fid: string | null | undefined) => {
      const f = featureOf(store.doc, fid);
      return f && 'transform' in f && result.frames[f.id] && !f.suppressed ? f : undefined;
    };
    let f = editable(selectedFeature);
    if (f && selection.length > 0 && !(selection.length === 1 && bodyById(selection[0])?.editableFeatureId === f.id)) f = undefined;
    if (!f && selection.length === 1) f = editable(bodyById(selection[0])?.editableFeatureId);
    if (f) {
      const t = (f as any).transform as TRS;
      if (f.type === 'move') {
        const pivot = new THREE.Vector3(...f.pivot);
        this.holder.matrix.identity();
        this.gizmoTarget = { fid: f.id, bodies: f.bodyIds, kind: 'move', pivot };
        this.applyProxy({ ...t, position: [t.position[0] + pivot.x, t.position[1] + pivot.y, t.position[2] + pivot.z] });
      } else {
        this.holder.matrix.copy(result.frames[f.id]);
        this.gizmoTarget = { fid: f.id, bodies: result.outputs[f.id] ?? [], kind: 'frame', pivot: new THREE.Vector3() };
        this.applyProxy(t);
      }
    } else if (selection.length) {
      const box = new THREE.Box3();
      for (const id of selection) { const b = bodyById(id); if (b) box.union(bodyBounds(b)); }
      if (box.isEmpty()) { this.gizmo.detach(); return; }
      const c = box.getCenter(new THREE.Vector3());
      this.holder.matrix.identity();
      this.gizmoTarget = { fid: null, bodies: [...selection], kind: 'pending', pivot: c };
      this.applyProxy({ position: c.toArray() as Vec3, rotation: [0, 0, 0], scale: [1, 1, 1] });
    }
    this.holder.matrixWorldNeedsUpdate = true;
    this.holder.updateMatrixWorld(true);
    if (this.gizmoTarget) {
      this.gizmo.attach(this.proxy);
      this.gizmo.setSpace(this.gizmoTarget.kind === 'frame' && store.state.gizmo !== 'translate' ? 'local' : 'world');
    } else this.gizmo.detach();
    this.invalidate();
  }

  private applyProxy(t: TRS) {
    this.proxy.position.set(...t.position);
    this.proxy.rotation.set(t.rotation[0] / DEG, t.rotation[1] / DEG, t.rotation[2] / DEG);
    this.proxy.scale.set(...t.scale);
    this.proxy.updateMatrixWorld(true);
  }

  private onGizmoStart() {
    this.dragging = true;
    const g = this.gizmoTarget;
    if (g && g.kind === 'pending') {
      const fid = ensureEditable(g.bodies);
      const f = featureOf(store.doc, fid);
      if (f?.type === 'move') {
        g.fid = f.id;
        g.kind = 'move';
        g.pivot = new THREE.Vector3(...f.pivot);
      }
    }
  }

  private onGizmoChange() {
    const g = this.gizmoTarget;
    if (!g?.fid) return;
    const r = (v: number, s = 1e-3) => Math.round(v / s) * s;
    const p = this.proxy.position.clone();
    if (g.kind === 'move') p.sub(g.pivot);
    const t: TRS = {
      position: [r(p.x), r(p.y), r(p.z)],
      rotation: [r(this.proxy.rotation.x * DEG, 0.01), r(this.proxy.rotation.y * DEG, 0.01), r(this.proxy.rotation.z * DEG, 0.01)],
      scale: [r(this.proxy.scale.x), r(this.proxy.scale.y), r(this.proxy.scale.z)],
    };
    setTransform(g.fid, t, true);
  }

  private onGizmoEnd() {
    this.dragging = false;
    store.endTransient(store.state.gizmo === 'rotate' ? 'Rotate' : store.state.gizmo === 'scale' ? 'Scale' : 'Move');
    this.syncGizmo();
  }

  // -------------------------------------------------------------------------
  // modes

  private setMouseMode(mode: AppState['mode']) {
    const M = THREE.MOUSE;
    this.controls.mouseButtons = mode === 'sketch'
      ? { LEFT: null as any, MIDDLE: M.PAN, RIGHT: M.ROTATE }
      : { LEFT: M.ROTATE, MIDDLE: M.PAN, RIGHT: M.PAN };
    // touch: one finger orbits (or draws, in a sketch); two fingers pinch-zoom and pan
    this.controls.touches = mode === 'sketch'
      ? { ONE: null as any, TWO: THREE.TOUCH.DOLLY_PAN }
      : { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };
  }

  private onModeChange(mode: AppState['mode'], prev: AppState['mode']) {
    this.setMouseMode(mode);
    this.planePicker.visible = mode === 'pick-plane';
    this.canvas.style.cursor = mode === 'measure' || mode === 'pick-plane' || mode === 'lay-flat' ? 'crosshair' : mode === 'sketch' ? 'crosshair' : '';
    if (mode !== 'lay-flat') this.flatMarker.visible = false;
    if (prev === 'sketch') this.sketch.cancel();
    if (prev === 'measure') store.set({ measure: { a: null, b: null } });
    if (mode === 'pick-plane') this.scalePlanePicker();
    this.syncGizmo();
    this.invalidate();
  }

  /** The printer's build volume: a bed plate plus an outline that turns red when parts don't fit. */
  private syncBed() {
    const { showBed, printerId, result, theme } = store.state;
    this.bed.traverse((o: any) => { o.geometry?.dispose(); o.material?.dispose(); });
    this.bed.clear();
    this.bed.visible = showBed;
    if (!showBed) { this.invalidate(); return; }
    const pr = printerById(printerId);
    const ext = new THREE.Box3();
    for (const b of result.bodies) if (b.visible) ext.union(bodyBounds(b));
    const fits = ext.isEmpty() || (ext.min.x >= -pr.x / 2 - 0.01 && ext.max.x <= pr.x / 2 + 0.01 && ext.min.z >= -pr.z / 2 - 0.01 && ext.max.z <= pr.z / 2 + 0.01 && ext.max.y <= pr.y + 0.01);
    const dark = theme === 'dark';
    const plate = new THREE.Mesh(
      new THREE.PlaneGeometry(pr.x, pr.z),
      new THREE.MeshBasicMaterial({ color: fits ? (dark ? '#3b82f6' : '#2563eb') : '#ef4444', transparent: true, opacity: dark ? 0.1 : 0.08, depthWrite: false }),
    );
    plate.rotation.x = -Math.PI / 2;
    plate.position.y = 0.02;
    plate.renderOrder = -0.5;
    const box = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(pr.x, pr.y, pr.z)),
      new THREE.LineBasicMaterial({ color: fits ? (dark ? '#60a5fa' : '#2563eb') : '#ef4444', transparent: true, opacity: 0.55 }),
    );
    box.position.y = pr.y / 2;
    plate.raycast = () => {};
    box.raycast = () => {};
    this.bed.add(plate, box);
    this.invalidate();
  }

  private showFlatMarker(hit: THREE.Intersection | undefined) {
    const m = this.flatMarker;
    if (!hit?.face || !hit.object.userData.bodyId) { if (m.visible) { m.visible = false; this.invalidate(); } return; }
    const n = hit.face.normal.clone().transformDirection(hit.object.matrixWorld);
    m.position.copy(hit.point).addScaledVector(n, 0.05);
    m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), n);
    m.scale.setScalar(Math.max(2, this.camera.position.distanceTo(hit.point) * 0.03));
    m.renderOrder = 30;
    m.visible = true;
    this.invalidate();
  }

  private buildPlanePicker() {
    const mk = (name: keyof typeof STANDARD_PLANES, color: string) => {
      const p = STANDARD_PLANES[name];
      const mesh = new THREE.Mesh(
        new THREE.PlaneGeometry(1, 1).translate(0.5, 0.5, 0),
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.16, side: THREE.DoubleSide, depthWrite: false }),
      );
      mesh.matrixAutoUpdate = false;
      mesh.userData.basis = planeMatrix(p);
      mesh.userData.plane = name;
      mesh.renderOrder = 6;
      const edge = new THREE.LineSegments(new THREE.EdgesGeometry(mesh.geometry), new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.9 }));
      edge.raycast = () => {};
      mesh.add(edge);
      this.planePicker.add(mesh);
    };
    mk('top', '#22c55e');
    mk('front', '#3b82f6');
    mk('right', '#ef4444');
    this.planePicker.visible = false;
  }

  private scalePlanePicker() {
    const dist = this.camera.position.distanceTo(this.controls.target);
    const s = Math.max(20, dist * 0.35);
    for (const m of this.planePicker.children as THREE.Mesh[]) {
      m.matrix.copy(m.userData.basis).multiply(new THREE.Matrix4().makeScale(s, s, 1));
      m.matrixWorldNeedsUpdate = true;
    }
  }

  // -------------------------------------------------------------------------
  // input

  private ndc(e: { clientX: number; clientY: number }) {
    const r = this.canvas.getBoundingClientRect();
    return new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  }

  private pickBody(e: { clientX: number; clientY: number }) {
    this.ray.setFromCamera(this.ndc(e), this.camera);
    const targets: THREE.Object3D[] = [];
    for (const v of this.views.values()) if (v.mesh.visible) targets.push(v.mesh);
    if (store.state.showGhosts || store.state.selectedFeature) targets.push(...this.ghostGroup.children.filter((c) => (c as any).isMesh));
    const hits = this.ray.intersectObjects(targets, false);
    if (store.state.section.enabled) {
      const pl = this.sectionPlane();
      return hits.find((h) => pl.distanceToPoint(h.point) >= 0);
    }
    return hits[0];
  }

  private groundPoint(e: { clientX: number; clientY: number }) {
    this.ray.setFromCamera(this.ndc(e), this.camera);
    return this.ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), new THREE.Vector3());
  }

  private bindEvents() {
    const c = this.canvas;
    let longPress: ReturnType<typeof setTimeout> | null = null;
    const cancelLongPress = () => { if (longPress) { clearTimeout(longPress); longPress = null; } };
    c.addEventListener('pointerdown', (e) => {
      this.down = { x: e.clientX, y: e.clientY, button: e.button, t: performance.now() };
      // touch: press and hold opens the quick menu (the right-click of phones)
      cancelLongPress();
      if (e.pointerType === 'touch' && e.isPrimary && store.state.mode === 'model') {
        longPress = setTimeout(() => {
          longPress = null;
          if (!this.down || this.gizmo.dragging) return;
          this.down = null;
          this.openContextMenu(e);
        }, 550);
      }
      store.state.contextMenu && store.set({ contextMenu: null });
      if (store.state.mode === 'sketch' && e.button === 0) {
        this.sketch.pointerDown(e);
        if (this.sketch.busy) this.controls.enabled = false;
      }
    });
    c.addEventListener('pointermove', (e) => {
      const mode = store.state.mode;
      if (longPress && this.down && Math.hypot(e.clientX - this.down.x, e.clientY - this.down.y) > 10) cancelLongPress();
      if (mode === 'sketch') { this.sketch.pointerMove(e); return; }
      if (e.buttons) return;
      if (mode === 'pick-plane') { this.hoverPlanes(e); return; }
      const hit = this.pickBody(e);
      if (mode === 'lay-flat') this.showFlatMarker(hit);
      const id = (hit?.object.userData.bodyId as string) ?? null;
      if (id !== this.hoverId) {
        this.hoverId = id;
        c.style.cursor = id || hit?.object.userData.ghostFeature ? (mode === 'measure' ? 'crosshair' : 'pointer') : mode === 'measure' ? 'crosshair' : '';
        this.syncHighlight();
      }
    });
    c.addEventListener('pointerup', (e) => {
      cancelLongPress();
      const d = this.down;
      this.down = null;
      const slop = e.pointerType === 'mouse' ? 5 : 12;
      const click = !!d && Math.hypot(e.clientX - d.x, e.clientY - d.y) < slop && performance.now() - d.t < 600;
      if (store.state.mode === 'sketch') {
        this.sketch.pointerUp(e, click);
        this.controls.enabled = true;
        return;
      }
      if (!click || !d) return;
      if (d.button === 2) { this.openContextMenu(e); return; }
      if (d.button !== 0 || this.gizmo.dragging || (this.gizmo as any).axis) return;
      this.onClick(e);
    });
    c.addEventListener('pointercancel', () => { cancelLongPress(); this.down = null; });
    c.addEventListener('pointerleave', () => {
      if (this.hoverId) { this.hoverId = null; this.syncHighlight(); }
    });
    c.addEventListener('dblclick', (e) => {
      if (store.state.mode !== 'model') return;
      const hit = this.pickBody(e);
      if (hit?.object.userData.bodyId) this.fit([hit.object.userData.bodyId]);
    });
    c.addEventListener('contextmenu', (e) => e.preventDefault());

    // drag shapes in from the gallery
    this.el.addEventListener('dragover', (e) => {
      if (e.dataTransfer?.types.includes('text/kimatic-shape') || e.dataTransfer?.types.includes('Files')) {
        e.preventDefault();
        e.dataTransfer!.dropEffect = 'copy';
      }
    });
    this.el.addEventListener('drop', (e) => {
      const shape = e.dataTransfer?.getData('text/kimatic-shape');
      if (!shape) return;
      e.preventDefault();
      const hit = this.pickBody(e);
      const onBody = hit?.object.userData.bodyId as string | undefined;
      addShape(shape, { position: this.dropPoint(e), targets: onBody ? [onBody] : undefined });
    });
  }

  /** Where a dropped shape should land: on top of a face, or on the ground. */
  private dropPoint(e: { clientX: number; clientY: number }): Vec3 {
    const hit = this.pickBody(e);
    if (hit?.face && hit.object.userData.bodyId) {
      const n = hit.face.normal.clone().transformDirection(hit.object.matrixWorld);
      if (n.y > 0.7) return [hit.point.x, hit.point.y, hit.point.z];
    }
    const g = this.groundPoint(e);
    return g ? [g.x, 0, g.z] : [0, 0, 0];
  }

  private onClick(e: PointerEvent) {
    const mode = store.state.mode;
    if (mode === 'pick-plane') {
      this.ray.setFromCamera(this.ndc(e), this.camera);
      const bodyHit = this.pickBody(e);
      const planeHit = this.ray.intersectObjects(this.planePicker.children, false)[0];
      if (bodyHit?.face && bodyHit.object.userData.bodyId && (!planeHit || bodyHit.distance < planeHit.distance)) {
        const n = bodyHit.face.normal.clone().transformDirection(bodyHit.object.matrixWorld);
        createSketch(planeFromFace(bodyHit.point.toArray() as Vec3, n.toArray() as Vec3));
      } else if (planeHit) {
        createSketch(STANDARD_PLANES[planeHit.object.userData.plane as keyof typeof STANDARD_PLANES]);
      }
      return;
    }
    if (mode === 'lay-flat') {
      const hit = this.pickBody(e);
      const id = hit?.object.userData.bodyId as string | undefined;
      if (hit?.face && id) layFlat(id, hit.face.normal.clone().transformDirection(hit.object.matrixWorld));
      return;
    }
    if (mode === 'measure') {
      const hit = this.pickBody(e);
      const p = hit ? this.snapToVertex(hit, e) : this.groundPoint(e);
      if (!p) return;
      const { a, b } = store.state.measure;
      const pt = p.toArray().map((v) => Math.round(v * 1000) / 1000) as Vec3;
      store.set({ measure: !a || b ? { a: pt, b: null } : { a, b: pt } });
      return;
    }
    const hit = this.pickBody(e);
    if (hit?.object.userData.ghostFeature) { selectFeature(hit.object.userData.ghostFeature); return; }
    const id = hit?.object.userData.bodyId as string | undefined;
    if (id) select([id], e.shiftKey || e.ctrlKey || e.metaKey);
    else if (!e.shiftKey) select([]);
  }

  private snapToVertex(hit: THREE.Intersection, e: PointerEvent) {
    const mesh = hit.object as THREE.Mesh;
    if (!hit.face) return hit.point.clone();
    const pos = mesh.geometry.getAttribute('position');
    const r = this.canvas.getBoundingClientRect();
    let best = hit.point.clone();
    let bestD = 12;
    for (const i of [hit.face.a, hit.face.b, hit.face.c]) {
      const v = new THREE.Vector3().fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
      const s = v.clone().project(this.camera);
      const d = Math.hypot(((s.x + 1) / 2) * r.width - (e.clientX - r.left), ((1 - s.y) / 2) * r.height - (e.clientY - r.top));
      if (d < bestD) { bestD = d; best = v; }
    }
    return best;
  }

  private hoverPlanes(e: PointerEvent) {
    this.ray.setFromCamera(this.ndc(e), this.camera);
    const hit = this.ray.intersectObjects(this.planePicker.children, false)[0];
    const m = (hit?.object as THREE.Mesh) ?? null;
    if (m !== this.hoverPlane) {
      if (this.hoverPlane) (this.hoverPlane.material as THREE.MeshBasicMaterial).opacity = 0.16;
      this.hoverPlane = m;
      if (m) (m.material as THREE.MeshBasicMaterial).opacity = 0.42;
      this.invalidate();
    }
    const body = this.pickBody(e);
    if (body?.object.userData.bodyId !== this.hoverId) {
      this.hoverId = body?.object.userData.bodyId ?? null;
      this.syncHighlight();
    }
  }

  private openContextMenu(e: PointerEvent) {
    if (store.state.mode !== 'model') return;
    const hit = this.pickBody(e);
    const id = (hit?.object.userData.bodyId as string) ?? null;
    if (id && !store.state.selection.includes(id)) select([id]);
    const r = this.el.getBoundingClientRect();
    store.set({ contextMenu: { x: e.clientX - r.left, y: e.clientY - r.top, bodyId: id } });
  }

  handleKey(e: KeyboardEvent): boolean {
    if (store.state.mode === 'sketch') return this.sketch.key(e);
    return false;
  }

  get sketchBusy() { return this.sketch.busy; }

  // -------------------------------------------------------------------------
  // measure

  private measureGroup = new THREE.Group();
  private syncMeasure() {
    if (!this.measureGroup.parent) this.overlay.add(this.measureGroup);
    this.measureGroup.traverse((o: any) => { o.geometry?.dispose(); o.material?.dispose(); });
    this.measureGroup.clear();
    const { a, b } = store.state.measure;
    const dot = (p: Vec3) => {
      const m = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 12), new THREE.MeshBasicMaterial({ color: '#fbbf24', depthTest: false }));
      m.position.set(...p);
      const d = this.camera.position.distanceTo(m.position) * 0.006;
      m.scale.setScalar(Math.max(0.3, d));
      m.renderOrder = 20;
      this.measureGroup.add(m);
    };
    if (a) dot(a);
    if (b) dot(b);
    if (a && b) {
      const g = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(...a), new THREE.Vector3(...b)]);
      const l = new THREE.Line(g, new THREE.LineBasicMaterial({ color: '#fbbf24', depthTest: false }));
      l.renderOrder = 20;
      this.measureGroup.add(l);
    }
    this.invalidate();
  }

  private updateLabels() {
    const { a, b } = store.state.measure;
    if (store.state.mode === 'measure' && a && b) {
      const mid = new THREE.Vector3(...a).add(new THREE.Vector3(...b)).multiplyScalar(0.5).project(this.camera);
      const d = new THREE.Vector3(...a).distanceTo(new THREE.Vector3(...b));
      this.measureLabel.style.display = 'block';
      this.measureLabel.style.left = `${((mid.x + 1) / 2) * this.size.w}px`;
      this.measureLabel.style.top = `${((1 - mid.y) / 2) * this.size.h}px`;
      this.measureLabel.textContent = `${(Math.round(d * 100) / 100).toFixed(2)} mm`;
    } else this.measureLabel.style.display = 'none';
  }

  // -------------------------------------------------------------------------
  // camera

  private animateTo(pos: THREE.Vector3, target: THREE.Vector3, dur = 450) {
    this.anim = { from: this.camera.position.clone(), to: pos, tFrom: this.controls.target.clone(), tTo: target, start: performance.now(), dur };
    this.invalidate();
  }

  private viewFrom(dir: THREE.Vector3) {
    const t = this.controls.target.clone();
    const dist = this.camera.position.distanceTo(t);
    const d = dir.clone().normalize();
    if (Math.abs(d.y) > 0.999) d.z += 0.0015;
    this.animateTo(t.clone().addScaledVector(d.normalize(), dist), t);
  }

  setNamedView(name: string) {
    const dirs: Record<string, [number, number, number]> = {
      home: [0.62, 0.5, 0.78], top: [0, 1, 0], bottom: [0, -1, 0], front: [0, 0, 1], back: [0, 0, -1], left: [-1, 0, 0], right: [1, 0, 0],
    };
    if (name === 'home') { this.fit(undefined, new THREE.Vector3(...dirs.home)); return; }
    if (dirs[name]) this.viewFrom(new THREE.Vector3(...dirs[name]));
  }

  fit(ids?: string[], dir?: THREE.Vector3) {
    const box = new THREE.Box3();
    for (const b of store.state.result.bodies) {
      if (!b.visible || (ids && !ids.includes(b.id))) continue;
      box.union(bodyBounds(b));
    }
    if (box.isEmpty()) box.set(new THREE.Vector3(-40, 0, -40), new THREE.Vector3(40, 30, 40));
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    const r = Math.max(sphere.radius, 8);
    const fov = (this.persp.fov * Math.PI) / 180;
    const dist = (r / Math.sin(fov / 2)) * 1.15 / Math.min(1, this.persp.aspect * 0.9);
    const d = (dir ?? this.camera.position.clone().sub(this.controls.target)).normalize();
    if (this.camera === this.ortho) this.ortho.zoom = 1;
    this.animateTo(sphere.center.clone().addScaledVector(d, dist), sphere.center.clone());
    setTimeout(() => this.updateOrtho(), 500);
  }

  private lookAtPlane(plane: PlaneDef) {
    const n = new THREE.Vector3(...plane.normal).normalize();
    const o = new THREE.Vector3(...plane.origin);
    const dist = Math.max(120, this.camera.position.distanceTo(this.controls.target));
    const dir = n.clone();
    if (Math.abs(dir.y) > 0.999) dir.z += 0.0015;
    this.animateTo(o.clone().addScaledVector(dir.normalize(), dist), o);
  }

  private setProjection(p: 'perspective' | 'orthographic') {
    const from = this.camera;
    if (p === 'orthographic') {
      this.persp.position.copy(from.position);
      this.updateOrtho();
      this.ortho.position.copy(from.position);
      this.ortho.zoom = 1;
      this.ortho.updateProjectionMatrix();
      this.camera = this.ortho;
    } else {
      const dist = from.position.distanceTo(this.controls.target) / (from === this.ortho ? this.ortho.zoom : 1);
      const dir = from.position.clone().sub(this.controls.target).normalize();
      this.persp.position.copy(this.controls.target).addScaledVector(dir, dist);
      this.camera = this.persp;
    }
    this.controls.object = this.camera;
    this.gizmo.camera = this.camera;
    this.controls.update();
    this.invalidate();
  }

  private groundTarget(): Vec3 {
    const bodies = store.state.result.bodies.filter((b) => b.visible);
    if (!bodies.length) return [0, 0, 0];
    const box = new THREE.Box3();
    for (const b of bodies) box.union(bodyBounds(b));
    const s = store.state.snap || 1;
    const x = Math.ceil((box.max.x + 18) / s) * s;
    const z = Math.round(((box.min.z + box.max.z) / 2) / s) * s;
    // make sure the new shape will be in view
    const p = new THREE.Vector3(x, 0, z).project(this.camera);
    if (Math.abs(p.x) > 0.85 || Math.abs(p.y) > 0.85) setTimeout(() => this.fit(), 30);
    return [x, 0, z];
  }

  screenshot() {
    const helper = this.gizmoHelper.visible;
    this.gizmoHelper.visible = false;
    this.renderer.render(this.scene, this.camera);
    // composite onto an opaque background so PNGs look good everywhere
    const c = document.createElement('canvas');
    c.width = this.canvas.width; c.height = this.canvas.height;
    const g = c.getContext('2d')!;
    const grad = g.createLinearGradient(0, 0, 0, c.height);
    grad.addColorStop(0, this.dark ? '#2a2d35' : '#f4f6fa');
    grad.addColorStop(1, this.dark ? '#16181d' : '#dfe3ea');
    g.fillStyle = grad;
    g.fillRect(0, 0, c.width, c.height);
    g.drawImage(this.canvas, 0, 0);
    this.gizmoHelper.visible = helper;
    this.invalidate();
    return c.toDataURL('image/png');
  }
}
