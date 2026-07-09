import * as THREE from 'three';

// Pooled point-sprite particles for blood mist and ground dust — one THREE.Points,
// one draw call, soft radial-blob texture tinted per particle. Points always face
// the camera for free, so no billboard matrices. NormalBlending on purpose: dark
// red reads as gore on bright sand, where additive would wash to orange.

const POOL = 384;
const BLOOD = new THREE.Color(0x8f1210);
const BLOOD_DARK = new THREE.Color(0x520a08);
const DUST = new THREE.Color(0xcdb88c);

function blobTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(32, 32, 2, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.55, 'rgba(255,255,255,0.55)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

export class Mist {
  constructor(scene) {
    const geo = new THREE.BufferGeometry();
    this.pos = new Float32Array(POOL * 3);
    this.col = new Float32Array(POOL * 3);
    this.size = new Float32Array(POOL);
    this.alpha = new Float32Array(POOL);
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aColor', new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aAlpha', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));

    this.material = new THREE.ShaderMaterial({
      uniforms: { uMap: { value: blobTexture() }, uPxPerUnit: { value: 800 } },
      vertexShader: /* glsl */ `
        attribute vec3 aColor;
        attribute float aSize;
        attribute float aAlpha;
        varying vec3 vColor;
        varying float vAlpha;
        uniform float uPxPerUnit;
        void main() {
          vColor = aColor;
          vAlpha = aAlpha;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = min(aSize * uPxPerUnit / max(-mv.z, 0.1), 256.0);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */ `
        uniform sampler2D uMap;
        varying vec3 vColor;
        varying float vAlpha;
        void main() {
          vec4 t = texture2D(uMap, gl_PointCoord);
          float a = t.a * vAlpha;
          if (a < 0.01) discard;
          gl_FragColor = vec4(vColor, a);
        }`,
      transparent: true,
      depthWrite: false,
    });

    this.points = new THREE.Points(geo, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 5;
    scene.add(this.points);

    // CPU state
    this.vel = new Float32Array(POOL * 3);
    this.life = new Float32Array(POOL);
    this.maxLife = new Float32Array(POOL);
    this.size0 = new Float32Array(POOL);
    this.size1 = new Float32Array(POOL);
    this.grav = new Float32Array(POOL);
    this.active = new Uint8Array(POOL);
    this._cursor = 0;
    this._col = new THREE.Color();
  }

  _emit(x, y, z, vx, vy, vz, color, s0, s1, life, grav) {
    const i = this._cursor;
    this._cursor = (this._cursor + 1) % POOL; // pool full → overwrite oldest
    this.active[i] = 1;
    this.pos[i * 3] = x; this.pos[i * 3 + 1] = y; this.pos[i * 3 + 2] = z;
    this.vel[i * 3] = vx; this.vel[i * 3 + 1] = vy; this.vel[i * 3 + 2] = vz;
    this.col[i * 3] = color.r; this.col[i * 3 + 1] = color.g; this.col[i * 3 + 2] = color.b;
    this.size[i] = s0;
    this.size0[i] = s0; this.size1[i] = s1;
    this.alpha[i] = 0.9;
    this.life[i] = 0; this.maxLife[i] = life;
    this.grav[i] = grav;
  }

  // Blood burst at a hit point, biased along the bullet direction
  blood(p, dir, count) {
    for (let k = 0; k < count; k++) {
      this._col.copy(BLOOD).lerp(BLOOD_DARK, Math.random());
      const spread = 2.6;
      this._emit(
        p.x, p.y, p.z,
        dir.x * (1.5 + Math.random() * 3) + (Math.random() - 0.5) * spread,
        1 + Math.random() * 2.5,
        dir.z * (1.5 + Math.random() * 3) + (Math.random() - 0.5) * spread,
        this._col,
        0.14 + Math.random() * 0.12, 0.55 + Math.random() * 0.45,
        0.35 + Math.random() * 0.25,
        -5
      );
    }
  }

  // Sand puff where a missed shot lands
  dust(p) {
    for (let k = 0; k < 4; k++) {
      this._emit(
        p.x, p.y + 0.05, p.z,
        (Math.random() - 0.5) * 1.6, 0.8 + Math.random() * 1.2, (Math.random() - 0.5) * 1.6,
        DUST,
        0.18 + Math.random() * 0.1, 0.7 + Math.random() * 0.3,
        0.4 + Math.random() * 0.2,
        -2.5
      );
    }
  }

  update(dt, pxPerUnit) {
    this.material.uniforms.uPxPerUnit.value = pxPerUnit;
    let dirty = false;
    for (let i = 0; i < POOL; i++) {
      if (!this.active[i]) continue;
      dirty = true;
      this.life[i] += dt;
      const t = this.life[i] / this.maxLife[i];
      if (t >= 1) {
        this.active[i] = 0;
        this.alpha[i] = 0;
        continue;
      }
      this.vel[i * 3 + 1] += this.grav[i] * dt;
      this.pos[i * 3] += this.vel[i * 3] * dt;
      this.pos[i * 3 + 1] = Math.max(0.03, this.pos[i * 3 + 1] + this.vel[i * 3 + 1] * dt);
      this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
      this.size[i] = this.size0[i] + (this.size1[i] - this.size0[i]) * t; // expand
      this.alpha[i] = 0.9 * (1 - t * t); // ease-out fade
    }
    if (dirty) {
      const g = this.points.geometry;
      g.attributes.position.needsUpdate = true;
      g.attributes.aSize.needsUpdate = true;
      g.attributes.aAlpha.needsUpdate = true;
      g.attributes.aColor.needsUpdate = true;
    }
  }
}
