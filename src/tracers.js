import * as THREE from 'three';
import { CONFIG } from './config.js';

// Pooled tracer streaks — one InstancedMesh, additive so they glow over the
// world. Each active tracer is a short bright segment whose leading edge travels
// from the muzzle (screen-bottom, in world space) to the hitscan endpoint (the
// crosshair's raycast hit point). Because the endpoint lies on the camera ray
// through the crosshair, the streak visually terminates on the crosshair at any
// depth — the Phase 2 acceptance, made structural.

export class Tracers {
  constructor(scene) {
    const g = CONFIG.gun;
    const geo = new THREE.BoxGeometry(1, 1, 1);
    const mat = new THREE.MeshBasicMaterial({
      color: 0xfff1a6,
      transparent: true,
      opacity: 0.95,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this.mesh = new THREE.InstancedMesh(geo, mat, g.tracerMax);
    this.mesh.frustumCulled = false;
    this.mesh.count = g.tracerMax;
    scene.add(this.mesh);

    this.n = g.tracerMax;
    this.active = new Uint8Array(this.n);
    // Muzzle origin + unit direction + total distance + progress, per slot
    this.mx = new Float32Array(this.n);
    this.my = new Float32Array(this.n);
    this.mz = new Float32Array(this.n);
    this.dx = new Float32Array(this.n);
    this.dy = new Float32Array(this.n);
    this.dz = new Float32Array(this.n);
    this.dist = new Float32Array(this.n);
    this.t = new Float32Array(this.n);

    this._dummy = new THREE.Object3D();
    this._hidden = new THREE.Object3D();
    this._hidden.scale.set(0, 0, 0);
    this._hidden.updateMatrix();
    for (let i = 0; i < this.n; i++) this.mesh.setMatrixAt(i, this._hidden.matrix);
    this.mesh.instanceMatrix.needsUpdate = true;

    this._cursor = 0;
  }

  _nextFree() {
    for (let k = 0; k < this.n; k++) {
      const i = (this._cursor + k) % this.n;
      if (!this.active[i]) {
        this._cursor = (i + 1) % this.n;
        return i;
      }
    }
    // Pool saturated — overwrite the oldest-ish slot
    const i = this._cursor;
    this._cursor = (i + 1) % this.n;
    return i;
  }

  // muzzle/end are Vector3-likes (only .x/.y/.z read — copied into arrays)
  spawn(muzzle, end) {
    const i = this._nextFree();
    const dx = end.x - muzzle.x;
    const dy = end.y - muzzle.y;
    const dz = end.z - muzzle.z;
    const dist = Math.max(Math.hypot(dx, dy, dz), 0.001);
    this.mx[i] = muzzle.x; this.my[i] = muzzle.y; this.mz[i] = muzzle.z;
    this.dx[i] = dx / dist; this.dy[i] = dy / dist; this.dz[i] = dz / dist;
    this.dist[i] = dist;
    this.t[i] = 0;
    this.active[i] = 1;
  }

  update(dt) {
    const g = CONFIG.gun;
    const d = this._dummy;
    let dirty = false;

    for (let i = 0; i < this.n; i++) {
      if (!this.active[i]) continue;
      dirty = true;

      this.t[i] += (g.tracerSpeed * dt) / this.dist[i];
      if (this.t[i] >= 1) {
        this.active[i] = 0;
        this.mesh.setMatrixAt(i, this._hidden.matrix);
        continue;
      }

      const travelled = this.t[i] * this.dist[i];
      const len = Math.min(g.tracerLength, travelled, this.dist[i]);
      // Leading edge, then step back half the streak length for the box center
      const cx = this.mx[i] + this.dx[i] * (travelled - len * 0.5);
      const cy = this.my[i] + this.dy[i] * (travelled - len * 0.5);
      const cz = this.mz[i] + this.dz[i] * (travelled - len * 0.5);
      d.position.set(cx, cy, cz);
      d.lookAt(cx + this.dx[i], cy + this.dy[i], cz + this.dz[i]); // align long axis to travel dir
      d.scale.set(g.tracerThick, g.tracerThick, len);
      d.updateMatrix();
      this.mesh.setMatrixAt(i, d.matrix);
    }

    if (dirty) this.mesh.instanceMatrix.needsUpdate = true;
  }
}
