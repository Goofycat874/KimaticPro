import * as THREE from 'three';

const FACES: { name: string; dir: [number, number, number]; label: string }[] = [
  { name: 'right', dir: [1, 0, 0], label: 'RIGHT' },
  { name: 'left', dir: [-1, 0, 0], label: 'LEFT' },
  { name: 'top', dir: [0, 1, 0], label: 'TOP' },
  { name: 'bottom', dir: [0, -1, 0], label: 'BOTTOM' },
  { name: 'front', dir: [0, 0, 1], label: 'FRONT' },
  { name: 'back', dir: [0, 0, -1], label: 'BACK' },
];

function faceTexture(label: string, dark: boolean) {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  const grad = g.createLinearGradient(0, 0, 0, 128);
  grad.addColorStop(0, dark ? '#3a3d45' : '#ffffff');
  grad.addColorStop(1, dark ? '#2b2d33' : '#e9ebef');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  g.strokeStyle = dark ? '#5b606b' : '#c3c7cf';
  g.lineWidth = 4;
  g.strokeRect(2, 2, 124, 124);
  g.fillStyle = dark ? '#e6e8ec' : '#3b3f47';
  g.font = '600 22px Inter, system-ui, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(label, 64, 66);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

/** The little orientation cube in the corner — click a face to snap the view. */
export class ViewCube {
  readonly el: HTMLCanvasElement;
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.OrthographicCamera(-1.6, 1.6, 1.6, -1.6, 0.1, 10);
  private cube: THREE.Mesh;
  private materials: THREE.MeshBasicMaterial[] = [];
  private ray = new THREE.Raycaster();
  private hover = -1;
  private dark = true;

  constructor(private onPick: (dir: THREE.Vector3) => void) {
    this.el = document.createElement('canvas');
    this.el.className = 'viewcube';
    this.renderer = new THREE.WebGLRenderer({ canvas: this.el, alpha: true, antialias: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    this.renderer.setSize(110, 110, false);
    // BoxGeometry face order: +x, -x, +y, -y, +z, -z
    this.materials = FACES.map((f) => new THREE.MeshBasicMaterial({ map: faceTexture(f.label, true) }));
    this.cube = new THREE.Mesh(new THREE.BoxGeometry(1.7, 1.7, 1.7), this.materials);
    this.scene.add(this.cube);
    const edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(this.cube.geometry),
      new THREE.LineBasicMaterial({ color: 0x8a8f99, transparent: true, opacity: 0.6 }),
    );
    this.cube.add(edges);
    this.addAxes();

    this.el.addEventListener('pointermove', (e) => this.onMove(e));
    this.el.addEventListener('pointerleave', () => this.setHover(-1));
    this.el.addEventListener('click', (e) => {
      const i = this.pick(e);
      if (i >= 0) this.onPick(new THREE.Vector3(...FACES[i].dir));
    });
  }

  private addAxes() {
    const mk = (dir: THREE.Vector3, color: number) => {
      const g = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(-0.85, -0.85, -0.85), new THREE.Vector3(-0.85, -0.85, -0.85).addScaledVector(dir, 2.1)]);
      this.cube.add(new THREE.Line(g, new THREE.LineBasicMaterial({ color })));
    };
    mk(new THREE.Vector3(1, 0, 0), 0xef4444);
    mk(new THREE.Vector3(0, 1, 0), 0x22c55e);
    mk(new THREE.Vector3(0, 0, 1), 0x3b82f6);
  }

  setTheme(dark: boolean) {
    if (dark === this.dark) return;
    this.dark = dark;
    this.materials.forEach((m, i) => { m.map?.dispose(); m.map = faceTexture(FACES[i].label, dark); m.needsUpdate = true; });
  }

  private pick(e: PointerEvent | MouseEvent) {
    const r = this.el.getBoundingClientRect();
    const p = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    this.ray.setFromCamera(p, this.camera);
    const hit = this.ray.intersectObject(this.cube, false)[0];
    return hit?.face ? hit.face.materialIndex : -1;
  }

  private onMove(e: PointerEvent) { this.setHover(this.pick(e)); }

  private setHover(i: number) {
    if (i === this.hover) return;
    if (this.hover >= 0) this.materials[this.hover].color.set(0xffffff);
    this.hover = i;
    if (i >= 0) this.materials[i].color.set(0x9cc4ff);
    this.el.style.cursor = i >= 0 ? 'pointer' : 'default';
  }

  render(mainCamera: THREE.Camera, target: THREE.Vector3) {
    const dir = new THREE.Vector3().subVectors(mainCamera.position, target).normalize();
    this.camera.position.copy(dir.multiplyScalar(5));
    this.camera.up.copy(mainCamera.up);
    this.camera.lookAt(0, 0, 0);
    this.renderer.render(this.scene, this.camera);
  }
}
