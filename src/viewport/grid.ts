import * as THREE from 'three';

/**
 * An infinite-feeling, anti-aliased CAD grid drawn in a shader.
 * Line spacing adapts to zoom so it always reads well, from 1 mm to 1 m.
 */
export function createGrid(opts: { axes?: boolean; size?: number } = {}) {
  const size = opts.size ?? 6000;
  const uniforms = {
    uMinor: { value: 10 },
    uColor: { value: new THREE.Color('#ffffff') },
    uOpacity: { value: 1 },
    uFade: { value: 1500 },
    uAxes: { value: opts.axes ? 1 : 0 },
    uCam: { value: new THREE.Vector3() },
  };
  const mat = new THREE.ShaderMaterial({
    uniforms,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    extensions: { derivatives: true } as any,
    vertexShader: /* glsl */ `
      varying vec2 vLocal;
      varying vec3 vWorld;
      void main() {
        vLocal = position.xy;
        vec4 w = modelMatrix * vec4(position, 1.0);
        vWorld = w.xyz;
        gl_Position = projectionMatrix * viewMatrix * w;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uMinor;
      uniform vec3 uColor;
      uniform float uOpacity;
      uniform float uFade;
      uniform float uAxes;
      uniform vec3 uCam;
      varying vec2 vLocal;
      varying vec3 vWorld;
      float line(vec2 p, float s, float w) {
        vec2 r = p / s;
        vec2 g = abs(fract(r - 0.5) - 0.5) / (fwidth(r) * w);
        return 1.0 - min(min(g.x, g.y), 1.0);
      }
      void main() {
        float minor = line(vLocal, uMinor, 1.0) * 0.18;
        float major = line(vLocal, uMinor * 10.0, 1.4) * 0.42;
        float a = max(minor, major);
        vec3 col = uColor;
        if (uAxes > 0.5) {
          vec2 fw = fwidth(vLocal) * 1.6;
          float ax = 1.0 - min(abs(vLocal.y) / fw.y, 1.0); // X axis (local y = 0)
          float az = 1.0 - min(abs(vLocal.x) / fw.x, 1.0); // Z axis
          if (ax > 0.0) { col = mix(col, vec3(0.94, 0.27, 0.27), ax); a = max(a, ax * 0.9); }
          if (az > 0.0) { col = mix(col, vec3(0.23, 0.51, 0.96), az); a = max(a, az * 0.9); }
        }
        float d = distance(uCam, vWorld);
        float fade = 1.0 - smoothstep(uFade * 0.25, uFade, d);
        gl_FragColor = vec4(col, a * fade * uOpacity);
        if (gl_FragColor.a < 0.002) discard;
      }
    `,
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(size, size), mat);
  mesh.renderOrder = -1;
  mesh.frustumCulled = false;

  return {
    mesh,
    material: mat,
    update(camera: THREE.Camera, distance: number) {
      uniforms.uCam.value.copy((camera as any).position);
      const target = Math.max(1, distance / 12);
      uniforms.uMinor.value = Math.pow(10, Math.floor(Math.log10(target)));
      uniforms.uFade.value = Math.max(300, distance * 6);
    },
    setColor(c: string, opacity: number) {
      uniforms.uColor.value.set(c);
      uniforms.uOpacity.value = opacity;
    },
    get minor() { return uniforms.uMinor.value; },
  };
}
