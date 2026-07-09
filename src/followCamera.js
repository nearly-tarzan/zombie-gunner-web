import * as THREE from 'three';
import { CONFIG } from './config.js';

// Damped side/three-quarter follow camera: rides beside-and-ahead of the
// truck, looking back at the pursuing horde. The perspective camera IS the
// point of this restart — all depth comes from it, zero scale constants.

export class FollowCamera {
  constructor() {
    const c = CONFIG.camera;
    this.camera = new THREE.PerspectiveCamera(c.fov, window.innerWidth / window.innerHeight, 0.1, 400);
    this.currentPos = new THREE.Vector3(c.offsetX, c.offsetY, c.offsetZ);
    this.currentTarget = new THREE.Vector3(c.lookX, c.lookY, c.lookZ);
    this.camera.position.copy(this.currentPos);
    this.camera.lookAt(this.currentTarget);
    this._desiredPos = new THREE.Vector3();
    this._desiredTarget = new THREE.Vector3();
    this.trauma = 0;      // 0..1; shake amplitude follows trauma² (Phase 3)
    this._shakeT = 0;
  }

  // Phase 3: each shot feeds a little trauma; sustained fire stacks it, so
  // shake naturally scales with fire rate. Decays in update().
  addTrauma(amount) {
    this.trauma = Math.min(1, this.trauma + amount);
  }

  update(dt, truckPos) {
    const c = CONFIG.camera;
    this._desiredPos.set(truckPos.x + c.offsetX, c.offsetY, truckPos.z + c.offsetZ);
    this._desiredTarget.set(truckPos.x + c.lookX, c.lookY, truckPos.z + c.lookZ);

    // Frame-rate-independent damping; slight lag so the motion is felt
    const t = 1 - Math.exp(-c.damping * dt);
    this.currentPos.lerp(this._desiredPos, t);
    this.currentTarget.lerp(this._desiredTarget, t);

    this.camera.fov = c.fov;
    this.camera.updateProjectionMatrix();
    this.camera.position.copy(this.currentPos);
    this.camera.lookAt(this.currentTarget);

    // Screen shake: layered incommensurate sines, amplitude = trauma² so light
    // fire barely registers and full-auto rumbles. Applied AFTER lookAt so the
    // damped follow stays clean; kept small so it can't wreck aim.
    const s = CONFIG.shake;
    if (s.enabled && this.trauma > 0.001) {
      this._shakeT += dt;
      const T = this._shakeT;
      const k = this.trauma * this.trauma;
      this.camera.position.x += Math.sin(T * 39.7) * k * s.amplitude;
      this.camera.position.y += Math.sin(T * 45.3 + 1.7) * k * s.amplitude * 0.7;
      this.camera.rotation.z += Math.sin(T * 33.1 + 0.6) * k * s.rollAmp;
      this.trauma = Math.max(0, this.trauma - s.decay * dt);
    }
  }

  resize() {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
  }
}
