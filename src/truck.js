import * as THREE from 'three';
import { CONFIG } from './config.js';

// Phase 6 art pass: the convoy semi from the Age of Origins ad — a RED cab
// tractor hauling a long BLUE shipping-container trailer. Forward = -Z: the cab
// LEADS (escaping) and the container TRAILS toward the pursuing horde (+Z), so
// the gunner fires back over the container. Auto-drives; nobody steers it. Only
// the geometry changed — the drive/bob and display-only HP lifecycle are as before.

export class Truck {
  constructor(scene) {
    this.group = new THREE.Group();

    const red      = new THREE.MeshLambertMaterial({ color: 0xc23b2e }); // cab
    const redDark  = new THREE.MeshLambertMaterial({ color: 0x7f281f }); // bumper / lower band
    const glass    = new THREE.MeshLambertMaterial({ color: 0x18262f }); // windshield
    const blue     = new THREE.MeshLambertMaterial({ color: 0x2f6ea8 }); // container
    const blueDark = new THREE.MeshLambertMaterial({ color: 0x22507d }); // container ribs / frames
    const chassis  = new THREE.MeshLambertMaterial({ color: 0x2c2f33 }); // frame / coupling
    const rubber   = new THREE.MeshLambertMaterial({ color: 0x191a1c }); // tyres
    const chrome   = new THREE.MeshLambertMaterial({ color: 0x9aa0a6 }); // exhaust stacks

    const box = (mat, w, h, d, x, y, z) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
      m.position.set(x, y, z);
      this.group.add(m);
      return m;
    };

    const wheelGeo = new THREE.CylinderGeometry(0.55, 0.55, 0.42, 14);
    wheelGeo.rotateZ(Math.PI / 2);
    const axle = (z) => {
      for (const x of [-1.12, 1.12]) {
        const w = new THREE.Mesh(wheelGeo, rubber);
        w.position.set(x, 0.55, z);
        this.group.add(w);
      }
    };

    // ---- Trailer: long blue container on a low flatbed (trails toward +Z) -----
    box(chassis, 2.1, 0.22, 6.0, 0, 0.88, -1.2);   // flatbed chassis rail
    box(blue, 2.3, 2.25, 5.5, 0, 2.15, -1.35);     // blue container body
    box(blueDark, 2.36, 2.31, 0.12, 0, 2.15, 1.35);   // rear door frame (faces the horde)
    box(blueDark, 2.36, 2.31, 0.12, 0, 2.15, -4.05);  // front frame
    for (const rz of [0.5, -0.8, -2.1, -3.2]) {
      box(blueDark, 2.34, 2.28, 0.06, 0, 2.15, rz);   // corrugation ribs
    }
    axle(0.7); axle(-0.6);                          // trailer bogie (rear)

    // ---- Cab: red tractor unit up front (-Z, leading) ------------------------
    box(red, 2.2, 2.5, 2.3, 0, 1.9, -5.7);         // cab body
    box(glass, 2.06, 0.95, 0.14, 0, 2.55, -6.88);  // windshield on the front face
    box(redDark, 2.24, 0.5, 2.34, 0, 0.78, -5.7);  // lower cab band
    box(redDark, 2.3, 0.34, 0.5, 0, 0.72, -7.0);   // front bumper
    box(chrome, 0.17, 0.55, 0.17, -0.72, 3.0, -5.02); // exhaust stack L
    box(chrome, 0.17, 0.55, 0.17,  0.72, 3.0, -5.02); // exhaust stack R
    box(chassis, 1.0, 0.4, 0.9, 0, 1.05, -4.45);   // fifth-wheel coupling
    axle(-5.0); axle(-6.7);                         // cab axles

    // Cosmetic mounted-gun stub at the container rear (the real gun is the overlay)
    box(chassis, 0.5, 0.3, 0.5, 0, 3.4, 0.9);
    box(new THREE.MeshLambertMaterial({ color: 0x333638 }), 0.16, 0.16, 1.0, 0, 3.55, 1.4);

    this.group.position.set(0, 0, 0);
    scene.add(this.group);

    this.time = 0;
    this.hp = CONFIG.combat.truckMaxHp; // display-only life bar; no game-over in sandbox
  }

  get position() {
    return this.group.position;
  }

  takeDamage(n) {
    if (n > 0) this.hp = Math.max(0, this.hp - n);
  }

  resetHp() {
    this.hp = CONFIG.combat.truckMaxHp;
  }

  update(dt) {
    this.time += dt;
    this.group.position.z -= CONFIG.truck.speed * dt;
    // Suspension bob + roll — sells the drive
    this.group.position.y = Math.sin(this.time * 6.5) * 0.035;
    this.group.rotation.z = Math.sin(this.time * 3.1) * 0.012;
    this.group.rotation.x = Math.sin(this.time * 5.2) * 0.008;
  }
}
