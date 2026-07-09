import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { buildBlendShell } from './blendShell.js';

// Screen-space gun overlay — a first-person viewmodel pinned bottom-center,
// deliberately decoupled from the aerial chase camera (per the ad: the camera
// floats high over the canyon while the gun stays first-person at screen-bottom).
//
// Rendered as a SECOND pass with a cleared depth buffer so it always draws on
// top of the world and never clips into zombies. Grey-box placeholder; Phase 3
// owns real weapon feel (muzzle flash, shell casings).
//
// Structure: an outer `group` carries sway / suspension-bob / recoil; an inner
// `pivot` (a trunnion near the gun's base) swivels the barrel toward the
// crosshair. The swivel is COSMETIC only — hitscan is still the camera-ray.

const PIVOT = new THREE.Vector3(0, -0.5, -0.95); // trunnion: barrel swings about here
const AIM_DAMP = 12;   // how snappy the barrel tracks the crosshair
const AIM_CLAMP = 0.6; // max yaw/pitch (rad) so extreme crosshair positions don't over-pose

export class Gun {
  constructor() {
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.01, 50);
    this.camera.position.set(0, 0, 0);

    // Own lighting — the overlay scene is separate from the world scene
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x555555, 1.15));
    const key = new THREE.DirectionalLight(0xffffff, 0.9);
    key.position.set(0.4, 1, 0.8);
    this.scene.add(key);

    this.group = new THREE.Group();   // sway + bob + recoil
    this.pivot = new THREE.Group();   // aim swivel about the trunnion
    this.pivot.position.copy(PIVOT);
    this.group.add(this.pivot);
    this.scene.add(this.group);

    // ---- Phase 6b: blend-shell viewmodel (same technique as the Cerberus) ----
    // The ad's mounted M2-style MG: bronze receiver, shrouded barrel, tall rear
    // sight, a GREEN ammo belt draping off the left, one hand on the grip. Soft
    // fused masses are blend-shells; sights/belt are crisp merged accessories.
    // The rig (pivot swivel, recoil, flash, mg/cannon swap) is unchanged.
    // Toon bands multiply albedo DOWN (the Cerberus reads because its hide is
    // near-white) — so these run brighter than the real-world colors they imply.
    const BRONZE = 0x8a6f52, GUNBLACK = 0x41434c, GUNSTEEL = 0x9298a0;
    const BELT = 0x7f9251, BRASS = 0xc9a24e, SKIN = 0xd8a67c, SLEEVE = 0x6d7457;
    const sub = (p) => [p[0] - PIVOT.x, p[1] - PIVOT.y, p[2] - PIVOT.z];
    const shell = (parent, shapes, k, outline) => {
      const sh = buildBlendShell(
        shapes.map((s) => ({ ...s, a: sub(s.a), b: sub(s.b) })), { k, outline });
      parent.add(new THREE.Mesh(sh.geometry, sh.bodyMaterial),
                 new THREE.Mesh(sh.geometry, sh.outlineMaterial));
      return sh;
    };

    // receiver + grip + stock + under-drum + hand/sleeve — one fused body
    shell(this.pivot, [
      { a: [0, -0.49, -0.60], b: [0, -0.45, -1.35], ra: 0.14, rb: 0.125, color: BRONZE },  // receiver
      { a: [0, -0.385, -0.80], b: [0, -0.385, -1.20], ra: 0.06, rb: 0.06, color: BRONZE }, // top hump
      { a: [0.04, -0.58, -0.50], b: [0.07, -0.74, -0.38], ra: 0.05, rb: 0.045, color: GUNBLACK }, // grip
      { a: [0, -0.63, -0.95], b: [0, -0.60, -1.15], ra: 0.09, rb: 0.085, color: BRONZE },  // under-drum
      { a: [0.07, -0.72, -0.46], b: [0.15, -0.66, -0.40], ra: 0.065, rb: 0.06, color: SKIN },     // right mitt
      { a: [0.10, -0.66, -0.50], b: [0.13, -0.63, -0.47], ra: 0.030, rb: 0.025, color: SKIN },    // thumb
      { a: [0.16, -0.66, -0.38], b: [0.34, -0.58, -0.22], ra: 0.075, rb: 0.09, color: SLEEVE },   // sleeve
    ], 0.035, 0.016);

    // Machine-gun barrel assembly — grouped so the Phase 4 tank transform can
    // hide it and reveal the cannon in its place.
    this.mgGroup = new THREE.Group();
    this.pivot.add(this.mgGroup);
    shell(this.mgGroup, [
      { a: [0, -0.44, -1.30], b: [0, -0.44, -1.95], ra: 0.075, rb: 0.065, color: BRONZE },  // shroud
      { a: [0, -0.44, -1.90], b: [0, -0.44, -2.52], ra: 0.050, rb: 0.046, color: GUNBLACK },// barrel
      { a: [0, -0.44, -2.52], b: [0, -0.44, -2.68], ra: 0.080, rb: 0.075, color: GUNBLACK },// muzzle can
    ], 0.03, 0.014);

    // Tank cannon — fat barrel + muzzle brake, hidden until a tank-gun powerup.
    this.cannonGroup = new THREE.Group();
    this.cannonGroup.visible = false;
    this.pivot.add(this.cannonGroup);
    shell(this.cannonGroup, [
      { a: [0, -0.45, -0.95], b: [0, -0.44, -1.42], ra: 0.20, rb: 0.18, color: BRONZE },    // breech
      { a: [0, -0.43, -1.40], b: [0, -0.42, -2.96], ra: 0.15, rb: 0.135, color: GUNBLACK }, // fat barrel
      { a: [0, -0.42, -2.96], b: [0, -0.42, -3.18], ra: 0.19, rb: 0.175, color: GUNSTEEL }, // brake
    ], 0.035, 0.018);
    this._mgMuzzleZ = -2.72;      // flash sits at the MG muzzle tip …
    this._cannonMuzzleZ = -3.24;  // … and further out for the cannon
    this._tankMode = false;

    // crisp accessories: rear sight + front sight + green belt draping left
    const accGeos = [];
    const _q = new THREE.Quaternion(), _vA = new THREE.Vector3(0, 1, 0), _vB = new THREE.Vector3();
    const acc = (geo, color, p, dir) => {
      if (dir) {
        _q.setFromUnitVectors(_vA, _vB.set(dir[0], dir[1], dir[2]).normalize());
        geo.applyQuaternion(_q);
      }
      const q = sub(p);
      geo.translate(q[0], q[1], q[2]);
      const n = geo.attributes.position.count;
      const c = new THREE.Color(color);
      const col = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) { col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b; }
      geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
      if (geo.attributes.uv) geo.deleteAttribute('uv');
      accGeos.push(geo);
    };
    acc(new THREE.BoxGeometry(0.10, 0.13, 0.025), GUNBLACK, [0, -0.335, -0.78]);       // rear sight plate
    acc(new THREE.BoxGeometry(0.025, 0.08, 0.02), GUNBLACK, [0, -0.36, -2.30]);        // front sight post
    for (let i = 0; i < 8; i++) {                                                      // ammo belt: exits the feed tray top-left, then droops off-screen
      const t = i / 7;
      const p = [-0.20 - 0.25 * t, -0.34 - 0.04 * t - 0.14 * t * t, -0.78 + 0.05 * Math.sin(t * 2.6)];
      acc(new THREE.CylinderGeometry(0.022, 0.022, 0.11, 6), BELT, p, [0, 0.25 * t, -1]);
      acc(new THREE.SphereGeometry(0.018, 5, 4), BRASS, [p[0], p[1] + 0.01, p[2] - 0.07]);
    }
    const accGeo = mergeGeometries(accGeos, false);
    accGeos.forEach((g) => g.dispose());
    this.pivot.add(new THREE.Mesh(accGeo, new THREE.MeshLambertMaterial({ vertexColors: true })));

    // ---- Phase 3: muzzle flash — two crossed additive quads + a light flick,
    // parented to the pivot at the muzzle tip so it aims with the barrel.
    const flashTex = Gun._flashTexture();
    const flashMat = new THREE.MeshBasicMaterial({
      map: flashTex,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: false,
    });
    this.flash = new THREE.Group();
    const fq1 = new THREE.Mesh(new THREE.PlaneGeometry(0.62, 0.62), flashMat);
    const fq2 = new THREE.Mesh(new THREE.PlaneGeometry(0.62, 0.62), flashMat);
    fq2.rotation.y = Math.PI / 2;
    this.flash.add(fq1, fq2);
    this.flash.position.set(0 - PIVOT.x, -0.44 - PIVOT.y, this._mgMuzzleZ - PIVOT.z);
    this.flash.visible = false;
    this.pivot.add(this.flash);

    this.flashLight = new THREE.PointLight(0xffb35c, 0, 6);
    this.flashLight.position.copy(this.flash.position);
    this.pivot.add(this.flashLight);
    this._flashLife = 0;

    this._recoil = 0;
    this._kickRoll = 0; // random per-shot roll jolt
    this._t = 0;
    this._yaw = 0;   // current swivel (damped toward the crosshair)
    this._pitch = 0;
  }

  // Radial white-hot core → orange falloff, drawn once to a small canvas
  static _flashTexture() {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const ctx = c.getContext('2d');
    const g = ctx.createRadialGradient(32, 32, 1, 32, 32, 32);
    g.addColorStop(0, 'rgba(255,255,235,1)');
    g.addColorStop(0.3, 'rgba(255,190,80,0.9)');
    g.addColorStop(0.7, 'rgba(255,110,20,0.35)');
    g.addColorStop(1, 'rgba(255,80,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 64, 64);
    return new THREE.CanvasTexture(c);
  }

  // Phase 4: swap the MG barrel for the tank cannon (or back). The flash rides
  // out to the cannon muzzle and blooms bigger while the cannon is up.
  setTankMode(on) {
    this._tankMode = !!on;
    this.mgGroup.visible = !on;
    this.cannonGroup.visible = on;
    const z = (on ? this._cannonMuzzleZ : this._mgMuzzleZ) - PIVOT.z;
    this.flash.position.z = z;
    this.flashLight.position.z = z;
  }

  // Called on each shot — kicks the viewmodel back toward the camera.
  // Crits (and the tank cannon) kick harder — subliminal "that one mattered".
  kick(heavy = false) {
    const tank = this._tankMode;
    this._recoil = Math.min(this._recoil + (tank ? 0.95 : heavy ? 0.55 : 0.42), tank ? 1.8 : 1.4);
    this._kickRoll += (Math.random() - 0.5) * (tank ? 0.09 : 0.05);
    this._flashLife = tank ? 0.07 : 0.05;
    this.flash.visible = true;
    this.flash.rotation.z = Math.random() * Math.PI * 2;
    const s = 0.8 + Math.random() * 0.55;
    this.flash.scale.setScalar((heavy ? s * 1.3 : s) * (tank ? 2.0 : 1));
    this.flashLight.intensity = tank ? 30 : 16;
  }

  // crosshairNDC: Vector2 in [-1,1]; barrel swivels to point at that screen spot
  update(dt, truckBobY = 0, crosshairNDC = null) {
    this._t += dt;
    this._recoil *= Math.exp(-dt * 15); // fast decay back to rest
    this._kickRoll *= Math.exp(-dt * 10);

    // Muzzle flash lives ~one frame pair, then vanishes until the next shot
    if (this._flashLife > 0) {
      this._flashLife -= dt;
      if (this._flashLife <= 0) {
        this.flash.visible = false;
        this.flashLight.intensity = 0;
      } else {
        this.flashLight.intensity *= 0.55; // decay the flick within its window
      }
    }

    // Aim swivel: map the crosshair NDC to a true view-angle (yaw/pitch) so the
    // barrel points at the reticle's screen location, then damp toward it.
    if (crosshairNDC) {
      const tanY = Math.tan(THREE.MathUtils.degToRad(this.camera.fov) * 0.5);
      const tanX = tanY * this.camera.aspect;
      const targetYaw = THREE.MathUtils.clamp(Math.atan(crosshairNDC.x * tanX), -AIM_CLAMP, AIM_CLAMP);
      const targetPitch = THREE.MathUtils.clamp(Math.atan(crosshairNDC.y * tanY), -AIM_CLAMP, AIM_CLAMP);
      const a = 1 - Math.exp(-AIM_DAMP * dt);
      this._yaw += (targetYaw - this._yaw) * a;
      this._pitch += (targetPitch - this._pitch) * a;
    }
    // local forward is -Z: rotation.y = -yaw points barrel right for +NDC.x;
    // rotation.x = +pitch points it up for +NDC.y.
    this.pivot.rotation.y = -this._yaw;
    this.pivot.rotation.x = this._pitch;

    const sway = Math.sin(this._t * 2.1) * 0.006;
    this.group.position.set(sway, truckBobY * 0.5, this._recoil * 0.16);
    this.group.rotation.x = -this._recoil * 0.14 + Math.sin(this._t * 1.7) * 0.004;
    this.group.rotation.z = Math.sin(this._t * 1.3) * 0.004 + this._kickRoll;
  }

  resize() {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
  }
}
