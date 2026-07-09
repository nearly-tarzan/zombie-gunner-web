import * as THREE from 'three';
import { CONFIG } from './config.js';

// Ejecting shell casings — pooled InstancedMesh living in the GUN OVERLAY scene
// (they spring from the receiver's eject port, tumble right, and fall out of
// frame). Overlay units, overlay lighting.

const EJECT = new THREE.Vector3(0.19, -0.42, -0.95); // right side of the receiver

export class Casings {
  constructor(overlayScene) {
    const n = CONFIG.casings.max;
    const geo = new THREE.CylinderGeometry(0.013, 0.013, 0.05, 6);
    const mat = new THREE.MeshLambertMaterial({ color: 0xc9a13e }); // brass
    this.mesh = new THREE.InstancedMesh(geo, mat, n);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    overlayScene.add(this.mesh);

    this.n = n;
    this.px = new Float32Array(n); this.py = new Float32Array(n); this.pz = new Float32Array(n);
    this.vx = new Float32Array(n); this.vy = new Float32Array(n); this.vz = new Float32Array(n);
    this.rx = new Float32Array(n); this.rz = new Float32Array(n);
    this.wx = new Float32Array(n); this.wz = new Float32Array(n);
    this.life = new Float32Array(n);
    this.active = new Uint8Array(n);

    this._dummy = new THREE.Object3D();
    this._hidden = new THREE.Object3D();
    this._hidden.scale.setScalar(0);
    this._hidden.updateMatrix();
    for (let i = 0; i < n; i++) this.mesh.setMatrixAt(i, this._hidden.matrix);
    this.mesh.instanceMatrix.needsUpdate = true;
    this._cursor = 0;
  }

  eject() {
    const i = this._cursor;
    this._cursor = (this._cursor + 1) % this.n;
    this.active[i] = 1;
    this.px[i] = EJECT.x; this.py[i] = EJECT.y; this.pz[i] = EJECT.z;
    this.vx[i] = 1.1 + Math.random() * 0.9;   // flick right
    this.vy[i] = 0.8 + Math.random() * 0.5;   // short arc up
    this.vz[i] = (Math.random() - 0.5) * 0.15; // stay at gun depth — drifting toward
                                               // the camera made shells read huge
    this.rx[i] = Math.random() * Math.PI;
    this.rz[i] = Math.random() * Math.PI;
    this.wx[i] = (Math.random() - 0.5) * 30;
    this.wz[i] = (Math.random() - 0.5) * 30;
    this.life[i] = 0;
  }

  update(dt) {
    const d = this._dummy;
    let dirty = false;
    for (let i = 0; i < this.n; i++) {
      if (!this.active[i]) continue;
      dirty = true;
      this.life[i] += dt;
      if (this.life[i] > CONFIG.casings.life || this.py[i] < -1.4) {
        this.active[i] = 0;
        this.mesh.setMatrixAt(i, this._hidden.matrix);
        continue;
      }
      this.vy[i] -= 7.5 * dt; // overlay-scale gravity
      this.px[i] += this.vx[i] * dt;
      this.py[i] += this.vy[i] * dt;
      this.pz[i] += this.vz[i] * dt;
      this.rx[i] += this.wx[i] * dt;
      this.rz[i] += this.wz[i] * dt;
      d.position.set(this.px[i], this.py[i], this.pz[i]);
      d.rotation.set(this.rx[i], 0, this.rz[i]);
      d.scale.setScalar(1);
      d.updateMatrix();
      this.mesh.setMatrixAt(i, d.matrix);
    }
    if (dirty) this.mesh.instanceMatrix.needsUpdate = true;
  }
}
