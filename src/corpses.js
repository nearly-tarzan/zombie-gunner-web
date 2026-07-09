import * as THREE from 'three';
import { CONFIG } from './config.js';

// Pooled corpses — the same capsule silhouette as the horde, toppling where the
// zombie died, persisting briefly (CONFIG.gore.corpseLife), then sinking into
// the sand. Instances are world-static, so the chase naturally leaves the dead
// behind — exactly the read we want. Recycled early once far behind the truck.

const POOL = 128;
const TOPPLE_TIME = 0.28;
const SINK_TIME = 0.6;

export class Corpses {
  constructor(scene) {
    const geo = new THREE.CapsuleGeometry(0.32, 0.85, 3, 8);
    geo.translate(0, 0.75, 0); // same feet-at-origin capsule as the horde
    const mat = new THREE.MeshLambertMaterial();
    this.mesh = new THREE.InstancedMesh(geo, mat, POOL);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);

    this.x = new Float32Array(POOL);
    this.z = new Float32Array(POOL);
    this.yaw = new Float32Array(POOL);
    this.scl = new Float32Array(POOL);
    this.age = new Float32Array(POOL);
    this.active = new Uint8Array(POOL);

    this._dummy = new THREE.Object3D();
    this._hidden = new THREE.Object3D();
    this._hidden.scale.setScalar(0);
    this._hidden.updateMatrix();
    for (let i = 0; i < POOL; i++) this.mesh.setMatrixAt(i, this._hidden.matrix);
    this.mesh.instanceMatrix.needsUpdate = true;

    this._cursor = 0;
    this._col = new THREE.Color();
  }

  // Drop a corpse where the zombie died. yaw = the way it was facing.
  spawn(x, z, scale, tintHex, yaw) {
    const i = this._cursor;
    this._cursor = (this._cursor + 1) % POOL; // pool full → oldest corpse vanishes
    this.active[i] = 1;
    this.x[i] = x;
    this.z[i] = z;
    this.yaw[i] = yaw + (Math.random() - 0.5) * 0.8;
    this.scl[i] = scale;
    this.age[i] = 0;
    this._col.setHex(tintHex).multiplyScalar(0.55); // death pallor — darker than the walkers
    this.mesh.setColorAt(i, this._col);
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  update(dt, truckZ) {
    const d = this._dummy;
    const lifeTotal = TOPPLE_TIME + CONFIG.gore.corpseLife + SINK_TIME;
    let dirty = false;
    for (let i = 0; i < POOL; i++) {
      if (!this.active[i]) continue;
      dirty = true;
      this.age[i] += dt;
      const age = this.age[i];
      if (age >= lifeTotal || this.z[i] > truckZ + CONFIG.horde.despawnFar) {
        this.active[i] = 0;
        this.mesh.setMatrixAt(i, this._hidden.matrix);
        continue;
      }
      // Topple: fall like a plank about the feet (capsule origin is at the feet)
      const k = Math.min(age / TOPPLE_TIME, 1);
      const tip = 0.12 + (Math.PI / 2 - 0.08 - 0.12) * k * k; // ease-in fall
      // Sink during the final SINK_TIME seconds
      const sinkT = Math.max(0, (age - TOPPLE_TIME - CONFIG.gore.corpseLife) / SINK_TIME);
      d.position.set(this.x[i], -1.1 * sinkT * sinkT, this.z[i]);
      d.rotation.set(0, this.yaw[i], 0);
      d.rotateX(tip);
      d.scale.setScalar(this.scl[i]);
      d.updateMatrix();
      this.mesh.setMatrixAt(i, d.matrix);
    }
    if (dirty) this.mesh.instanceMatrix.needsUpdate = true;
  }
}
