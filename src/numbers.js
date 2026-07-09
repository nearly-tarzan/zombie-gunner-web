import * as THREE from 'three';
import { CONFIG } from './config.js';

// Floating damage numbers — pooled point sprites over a 0-9 digit atlas, one
// draw call, always camera-facing. Each number is spawned as its digits laid
// out along the camera-right axis; they pop in (overshoot), drift up, fade out.
// Crits are bigger and gold. NOT DOM: full-auto at 11 rds/s would thrash layout.

const POOL = 128;            // digit slots (a number uses 2-4)
const WHITE = new THREE.Color(0xffffff);
const CRIT = new THREE.Color(0xffc93d);

function digitAtlas() {
  const cell = 64;
  const c = document.createElement('canvas');
  c.width = cell * 10;
  c.height = cell;
  const ctx = c.getContext('2d');
  ctx.font = '900 52px Arial, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (let d = 0; d < 10; d++) {
    const cx = d * cell + cell / 2;
    // Dark outline so numbers read over both sand and bodies
    ctx.lineWidth = 8;
    ctx.strokeStyle = 'rgba(0,0,0,0.9)';
    ctx.strokeText(String(d), cx, cell / 2 + 2);
    ctx.fillStyle = '#ffffff';
    ctx.fillText(String(d), cx, cell / 2 + 2);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.minFilter = THREE.LinearFilter;
  return tex;
}

export class Numbers {
  constructor(scene) {
    const geo = new THREE.BufferGeometry();
    this.pos = new Float32Array(POOL * 3);
    this.col = new Float32Array(POOL * 3);
    this.size = new Float32Array(POOL);
    this.alpha = new Float32Array(POOL);
    this.digit = new Float32Array(POOL);
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aColor', new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aAlpha', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aDigit', new THREE.BufferAttribute(this.digit, 1).setUsage(THREE.DynamicDrawUsage));

    this.material = new THREE.ShaderMaterial({
      uniforms: { uMap: { value: digitAtlas() }, uPxPerUnit: { value: 800 } },
      vertexShader: /* glsl */ `
        attribute vec3 aColor;
        attribute float aSize;
        attribute float aAlpha;
        attribute float aDigit;
        varying vec3 vColor;
        varying float vAlpha;
        varying float vDigit;
        uniform float uPxPerUnit;
        void main() {
          vColor = aColor;
          vAlpha = aAlpha;
          vDigit = aDigit;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = min(aSize * uPxPerUnit / max(-mv.z, 0.1), 220.0);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */ `
        uniform sampler2D uMap;
        varying vec3 vColor;
        varying float vAlpha;
        varying float vDigit;
        void main() {
          vec2 uv = vec2((gl_PointCoord.x + vDigit) / 10.0, 1.0 - gl_PointCoord.y);
          vec4 t = texture2D(uMap, uv);
          float a = t.a * vAlpha;
          if (a < 0.02) discard;
          gl_FragColor = vec4(t.rgb * vColor, a);
        }`,
      transparent: true,
      depthWrite: false,
      depthTest: false, // always readable, never clipped by bodies
    });

    this.points = new THREE.Points(geo, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 20;
    scene.add(this.points);

    // CPU state per digit slot
    this.vx = new Float32Array(POOL);
    this.vz = new Float32Array(POOL);
    this.life = new Float32Array(POOL);
    this.baseSize = new Float32Array(POOL);
    this.active = new Uint8Array(POOL);
    this._cursor = 0;
    this._right = new THREE.Vector3();
  }

  // Spawn `value` at world point p. Digits offset along the camera-right axis.
  spawn(p, value, crit, camera) {
    const n = CONFIG.numbers;
    const str = String(Math.max(1, Math.round(value)));
    const sizeMul = crit ? n.critScale : 1;
    const digitW = n.scale * 0.62 * sizeMul; // world-space advance per digit
    this._right.setFromMatrixColumn(camera.matrixWorld, 0); // camera right
    const color = crit ? CRIT : WHITE;
    // shared per-number drift so the digits travel together
    const vx = (Math.random() - 0.5) * 0.6;
    const vz = (Math.random() - 0.5) * 0.6;
    for (let k = 0; k < str.length; k++) {
      const i = this._cursor;
      this._cursor = (this._cursor + 1) % POOL;
      this.active[i] = 1;
      const off = (k - (str.length - 1) / 2) * digitW;
      this.pos[i * 3] = p.x + this._right.x * off;
      this.pos[i * 3 + 1] = p.y + 0.35;
      this.pos[i * 3 + 2] = p.z + this._right.z * off;
      this.col[i * 3] = color.r; this.col[i * 3 + 1] = color.g; this.col[i * 3 + 2] = color.b;
      this.digit[i] = +str[k];
      this.baseSize[i] = n.scale * sizeMul;
      this.size[i] = 0.01;
      this.alpha[i] = 1;
      this.vx[i] = vx;
      this.vz[i] = vz;
      this.life[i] = 0;
    }
  }

  update(dt, pxPerUnit) {
    this.material.uniforms.uPxPerUnit.value = pxPerUnit;
    const n = CONFIG.numbers;
    let dirty = false;
    for (let i = 0; i < POOL; i++) {
      if (!this.active[i]) continue;
      dirty = true;
      this.life[i] += dt;
      const t = this.life[i] / n.life;
      if (t >= 1) {
        this.active[i] = 0;
        this.alpha[i] = 0;
        continue;
      }
      // Pop: overshoot to 1.28x in the first 15%, settle to 1
      const pop = t < 0.15 ? (t / 0.15) * 1.28 : 1 + 0.28 * (1 - Math.min((t - 0.15) / 0.2, 1));
      this.size[i] = this.baseSize[i] * pop;
      this.pos[i * 3] += this.vx[i] * dt;
      this.pos[i * 3 + 1] += n.rise * dt;
      this.pos[i * 3 + 2] += this.vz[i] * dt;
      this.alpha[i] = t > 0.6 ? 1 - (t - 0.6) / 0.4 : 1;
    }
    if (dirty) {
      const g = this.points.geometry;
      g.attributes.position.needsUpdate = true;
      g.attributes.aSize.needsUpdate = true;
      g.attributes.aAlpha.needsUpdate = true;
      g.attributes.aColor.needsUpdate = true;
      g.attributes.aDigit.needsUpdate = true;
    }
  }
}
