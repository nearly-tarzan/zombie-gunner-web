import * as THREE from 'three';
import { CONFIG } from './config.js';

// Pooled gib chunks — one InstancedMesh of lit boxes that tumble out of a burst
// body, bounce once on the sand, then scale away. Colors mix the zombie's tint
// with blood so the pile reads as "that zombie", not confetti.

const POOL = 160;
const GRAVITY = -22;
const BLOOD = new THREE.Color(0x6e100d);

export class Gibs {
  constructor(scene) {
    const geo = new THREE.BoxGeometry(0.24, 0.19, 0.27);
    const mat = new THREE.MeshLambertMaterial();
    this.mesh = new THREE.InstancedMesh(geo, mat, POOL);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);

    this.px = new Float32Array(POOL); this.py = new Float32Array(POOL); this.pz = new Float32Array(POOL);
    this.vx = new Float32Array(POOL); this.vy = new Float32Array(POOL); this.vz = new Float32Array(POOL);
    this.rx = new Float32Array(POOL); this.ry = new Float32Array(POOL); this.rz = new Float32Array(POOL);
    this.wx = new Float32Array(POOL); this.wy = new Float32Array(POOL); this.wz = new Float32Array(POOL);
    this.life = new Float32Array(POOL);
    this.maxLife = new Float32Array(POOL);
    this.scl = new Float32Array(POOL);
    this.rest = new Uint8Array(POOL);   // settled on the ground
    this.active = new Uint8Array(POOL);

    this._dummy = new THREE.Object3D();
    this._hidden = new THREE.Object3D();
    this._hidden.scale.setScalar(0);
    this._hidden.updateMatrix();
    for (let i = 0; i < POOL; i++) this.mesh.setMatrixAt(i, this._hidden.matrix);
    this.mesh.instanceMatrix.needsUpdate = true;

    this._cursor = 0;
    this._col = new THREE.Color();
    this._tint = new THREE.Color();
  }

  // Burst a body at (x, y, z). tintHex = the zombie's color.
  spawn(x, y, z, tintHex) {
    this._tint.setHex(tintHex);
    const count = CONFIG.gore.gibCount;
    for (let k = 0; k < count; k++) {
      const i = this._cursor;
      this._cursor = (this._cursor + 1) % POOL;
      this.active[i] = 1;
      this.rest[i] = 0;
      this.px[i] = x + (Math.random() - 0.5) * 0.3;
      this.py[i] = y + Math.random() * 0.6;
      this.pz[i] = z + (Math.random() - 0.5) * 0.3;
      const ang = Math.random() * Math.PI * 2;
      const sp = 2.5 + Math.random() * 4.5;
      this.vx[i] = Math.cos(ang) * sp;
      this.vy[i] = 3 + Math.random() * 4.5;
      this.vz[i] = Math.sin(ang) * sp;
      this.rx[i] = Math.random() * Math.PI; this.ry[i] = Math.random() * Math.PI; this.rz[i] = Math.random() * Math.PI;
      this.wx[i] = (Math.random() - 0.5) * 22;
      this.wy[i] = (Math.random() - 0.5) * 22;
      this.wz[i] = (Math.random() - 0.5) * 22;
      this.life[i] = 0;
      this.maxLife[i] = 1.1 + Math.random() * 0.5;
      this.scl[i] = 0.7 + Math.random() * 0.7;
      this._col.copy(this._tint).lerp(BLOOD, 0.35 + Math.random() * 0.5);
      this.mesh.setColorAt(i, this._col);
    }
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  update(dt) {
    const d = this._dummy;
    let dirty = false;
    for (let i = 0; i < POOL; i++) {
      if (!this.active[i]) continue;
      dirty = true;
      this.life[i] += dt;
      const t = this.life[i] / this.maxLife[i];
      if (t >= 1) {
        this.active[i] = 0;
        this.mesh.setMatrixAt(i, this._hidden.matrix);
        continue;
      }
      if (!this.rest[i]) {
        this.vy[i] += GRAVITY * dt;
        this.px[i] += this.vx[i] * dt;
        this.py[i] += this.vy[i] * dt;
        this.pz[i] += this.vz[i] * dt;
        this.rx[i] += this.wx[i] * dt; this.ry[i] += this.wy[i] * dt; this.rz[i] += this.wz[i] * dt;
        if (this.py[i] < 0.1 && this.vy[i] < 0) {
          if (Math.abs(this.vy[i]) > 3) {
            this.vy[i] *= -0.35; // one meaty bounce
            this.vx[i] *= 0.55; this.vz[i] *= 0.55;
            this.wx[i] *= 0.5; this.wy[i] *= 0.5; this.wz[i] *= 0.5;
          } else {
            this.rest[i] = 1;
            this.py[i] = 0.1;
          }
        }
      }
      const fade = t > 0.75 ? 1 - (t - 0.75) / 0.25 : 1; // scale-out at the end
      d.position.set(this.px[i], this.py[i], this.pz[i]);
      d.rotation.set(this.rx[i], this.ry[i], this.rz[i]);
      d.scale.setScalar(this.scl[i] * fade);
      d.updateMatrix();
      this.mesh.setMatrixAt(i, d.matrix);
    }
    if (dirty) this.mesh.instanceMatrix.needsUpdate = true;
  }
}
