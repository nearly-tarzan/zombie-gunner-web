import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { CONFIG } from './config.js';
import { buildBlendShell } from './blendShell.js';

// Phase 5 — the colossal boss. A several-stories-tall PALE humanoid that spawns
// on command deep in the horde, TOWERS over it (the ad's money shot), and
// advances slowly on the fleeing truck. Built from plain Meshes in a Group so
// its raycast bounds ride its own world matrix each frame — immune to the
// InstancedMesh stale-bounding-sphere trap that bit the horde (crates dodge it
// the same way). Pouring fire into it rains damage numbers; the kill (handled in
// main via the shared explode/force-gib path) detonates a huge blast that clears
// the surrounding horde, then the giant topples and sinks.
//
// State is orchestrated the same way as the horde: the boss owns its lifecycle
// (spawn / advance / topple / remove) and returns hit results; main.js owns the
// FX (damage numbers, mist, the death explosion) so every explosive path still
// funnels through the one explode() and the force-gib rule holds everywhere.

// Cerberus palette (ad ref: aoo2_sideview_cerberus_24s.jpg — a bright WHITE
// three-headed hellhound with dark iron spiked collars and glowing orange eyes)
const HIDE = 0xe9e5db;      // near-white hide — must POP against the dark horde
const HIDE_DK = 0xd3ccbd;   // shaded hide (legs, jaws, brisket) — soft SDF gradient
const IVORY = 0xf2ead6;     // teeth
const BONE = 0xd8cbae;      // back spikes
const IRON = 0x33323a;      // collars
const STEEL = 0x8f8d94;     // collar spikes
const NOSE = 0x2b2624;      // nose tips
const MAW = 0x6b1a12;       // red open-mouth interior (bright enough to read in Lambert)
const GIB_TINT = 0xe3ded2;  // pale gib shower off the dying giant
// faceted-head palette — near-whites stepped subtly darker toward the shaded parts
const SKULL = 0xeae6dc;
const OCCIPUT = 0xd8d1c2;   // jowls / back of skull
const BROW = 0xdfd8ca;
const MUZZLE = 0xd9d2c3;
const MUZZLE_TOP = 0xbfb7a8; // wrinkled snarl shading on the snout bridge
const JAWC = 0xe0dacb;
const EAR = 0xd2cabb;
const SOCKET = 0x453c33;    // dark eye wells — make the glowing eyes READ

// Inverted-hull outline for ordinary (non-shell) geometry: displace every
// vertex along its position-averaged normal so box corners stay watertight
// (raw face normals would split the hull open at every hard edge).
function inflate(geo, off) {
  const g = geo.clone();
  const pos = g.attributes.position, nrm = g.attributes.normal;
  const acc = new Map();
  const keyOf = (i) => `${pos.getX(i).toFixed(3)},${pos.getY(i).toFixed(3)},${pos.getZ(i).toFixed(3)}`;
  for (let i = 0; i < pos.count; i++) {
    const k = keyOf(i);
    let e = acc.get(k);
    if (!e) { e = [0, 0, 0]; acc.set(k, e); }
    e[0] += nrm.getX(i); e[1] += nrm.getY(i); e[2] += nrm.getZ(i);
  }
  for (let i = 0; i < pos.count; i++) {
    const e = acc.get(keyOf(i));
    const l = Math.hypot(e[0], e[1], e[2]) || 1;
    pos.setXYZ(i, pos.getX(i) + (e[0] / l) * off, pos.getY(i) + (e[1] / l) * off, pos.getZ(i) + (e[2] / l) * off);
  }
  return g;
}

export class Boss {
  constructor(scene) {
    this.scene = scene;
    this.bosses = [];          // active bosses (debug can stack a few)
    this._raycastMeshes = [];  // flat list of all LIVE boss body meshes (raycast targets)
    this.smashThisFrame = false; // a boss reached the truck this frame → main ends the game
    this.gibTint = GIB_TINT;   // main reads this for the death gib shower
  }

  get activeCount() { return this.bosses.length; }
  get aliveCount() { let n = 0; for (const b of this.bosses) if (!b.dying) n++; return n; }
  // total remaining HP across living bosses — HUD readout
  totalHp() { let h = 0; for (const b of this.bosses) if (!b.dying) h += Math.max(0, b.hp); return Math.round(h); }

  // Spawn a colossal boss deep behind the truck, rising out of the ground.
  spawn(truckPos) {
    if (this.bosses.length >= CONFIG.boss.maxActive) return null;
    const H = CONFIG.boss.height;

    const group = new THREE.Group();
    const tilt = new THREE.Group(); // topple pivot at the feet (death anim)
    group.add(tilt);

    // --- Cerberus as an SDF blend-shell (seamless organic hound) --------------
    // Round-cone primitives (front = +Z, toward the truck) fused into one smooth
    // body by the vertex-snapping shader in blendShell.js. The SOFT anatomy
    // (body, legs, necks, skulls with brow + blunt muzzle + OPEN lower jaw)
    // lives in the shell; everything that must stay CRISP (ears, teeth, noses,
    // spiked collars, back spikes) is merged into ONE vertex-colored accessory
    // mesh, and the glowing eyes into one basic-material mesh — 4 draw calls.
    const shapes = [];
    const accGeos = [];    // crisp accessory geometries (merged below)
    const eyeGeos = [];    // glowing eye spheres (merged below)
    const legAnim = [];    // gait bookkeeping: shape indices + rest endpoints

    const S = (a, b, ra, rb, color, pad) => {
      shapes.push(pad ? { a, b, ra, rb, color, pad } : { a, b, ra, rb, color });
      return shapes.length - 1;
    };
    const at = (o, d, t) => [o[0] + d[0] * t, o[1] + d[1] * t, o[2] + d[2] * t];
    const dirYP = (yaw, pitch) => [Math.cos(pitch) * Math.sin(yaw), Math.sin(pitch), Math.cos(pitch) * Math.cos(yaw)];
    const norm = (v) => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
    const UP = [0, 1, 0];
    const _q = new THREE.Quaternion(), _vA = new THREE.Vector3(), _vB = new THREE.Vector3();
    // orient a +Y-pointing geometry along dir, place at p, tint, and queue it
    const acc = (geo, color, p, dir, axis = UP) => {
      _q.setFromUnitVectors(_vA.set(axis[0], axis[1], axis[2]), _vB.set(dir[0], dir[1], dir[2]).normalize());
      geo.applyQuaternion(_q);
      geo.translate(p[0], p[1], p[2]);
      const n = geo.attributes.position.count;
      const c = new THREE.Color(color);
      const col = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) { col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b; }
      geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
      if (geo.attributes.uv) geo.deleteAttribute('uv'); // merge wants uniform attrs
      accGeos.push(geo);
    };

    // ---- body: mass up FRONT (huge chest/shoulders), leaner haunches ---------
    S([0, 0.50 * H, -0.30 * H], [0, 0.53 * H, -0.14 * H], 0.180 * H, 0.190 * H, HIDE);    // haunches
    S([0, 0.52 * H, -0.18 * H], [0, 0.56 * H, 0.08 * H], 0.185 * H, 0.205 * H, HIDE);     // barrel
    S([0, 0.56 * H, 0.04 * H], [0, 0.58 * H, 0.185 * H], 0.205 * H, 0.20 * H, HIDE);      // chest + shoulder mass
    S([0, 0.47 * H, 0.10 * H], [0, 0.53 * H, 0.22 * H], 0.13 * H, 0.15 * H, HIDE_DK);     // low brisket / dewlap
    S([0, 0.54 * H, -0.30 * H], [0, 0.63 * H, -0.50 * H], 0.045 * H, 0.016 * H, HIDE_DK); // tail

    // ---- legs + paws (columnar, thick in front) — ANIMATED via uniforms ------
    // pad inflates the base capsule by the gait excursion so snapped vertices
    // always start OUTSIDE the moving isosurface (see blendShell pad support).
    const GAIT_PAD = 0.10 * H;
    const leg = (sx, hipZ, footZ, rHip, rAnk, rPaw, phase) => {
      const a = [sx, 0.52 * H, hipZ];
      const b = [sx * 1.08, 0.055 * H, footZ];
      const li = S(a, b, rHip, rAnk, HIDE_DK, GAIT_PAD);
      const p0 = [sx * 1.08, 0.055 * H, footZ + 0.015 * H];
      const p1 = [sx * 1.08, 0.050 * H, footZ + 0.055 * H];
      const pi = S(p0, p1, rPaw, rPaw * 0.85, HIDE_DK, GAIT_PAD);              // paw lump
      legAnim.push({ li, pi, phase, la: a, lb: b, pa: p0, pb: p1, lra: rHip, lrb: rAnk, pra: rPaw, prb: rPaw * 0.85 });
    };
    leg(-0.185 * H, 0.19 * H, 0.245 * H, 0.088 * H, 0.058 * H, 0.072 * H, 0);        // FL — wide-set, elbows out
    leg( 0.185 * H, 0.19 * H, 0.245 * H, 0.088 * H, 0.058 * H, 0.072 * H, Math.PI);  // FR
    leg(-0.17 * H, -0.26 * H, -0.30 * H, 0.090 * H, 0.054 * H, 0.064 * H, Math.PI);  // RL
    leg( 0.17 * H, -0.26 * H, -0.30 * H, 0.090 * H, 0.054 * H, 0.064 * H, 0);        // RR

    // ---- three heads: crisp FACETED low-poly skulls (NOT blend-shell) --------
    // The smooth-min shell physically can't hold a snarling dog skull — the
    // brow step, the open-jaw gap, and the eye sockets are all concavities that
    // smin fuses away, which is why the SDF heads read as blobby prongs. The
    // heads are hand-built faceted geometry instead (the same language as the
    // approved zombie + truck), merged into ONE vertex-colored Lambert mesh with
    // an inverted-hull outline. Only the NECKS stay in the shell, where the
    // seamless fuse into the shoulders is exactly what smin is FOR.
    const headGeos = [];     // painted head parts (merged below)
    const headOutGeos = [];  // unpainted clones of the BIG forms → outline hull
    const paintGeo = (g, color) => {
      const n = g.attributes.position.count;
      const c = new THREE.Color(color);
      const col = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) { col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b; }
      g.setAttribute('color', new THREE.BufferAttribute(col, 3));
      if (g.attributes.uv) g.deleteAttribute('uv');
      return g;
    };
    // box with the +Z (snout-ward) face scaled in — skulls and muzzles taper
    const taperBox = (w, h, dp, sx, sy) => {
      const g = new THREE.BoxGeometry(w, h, dp);
      const pos = g.attributes.position;
      for (let i = 0; i < pos.count; i++) {
        if (pos.getZ(i) > 0) pos.setXYZ(i, pos.getX(i) * sx, pos.getY(i) * sy, pos.getZ(i));
      }
      g.computeVertexNormals();
      return g;
    };
    const _m1 = new THREE.Matrix4(), _m2 = new THREE.Matrix4();
    // one hellhound head, local frame: origin at skull center, +Z toward prey
    const polyHead = (yaw, pitch, hs) => {
      const headM = new THREE.Matrix4().makeTranslation(hs[0], hs[1], hs[2])
        .multiply(_m1.makeRotationY(yaw))
        .multiply(_m2.makeRotationX(-pitch));
      // sub-frame helper: rotate about X (down-pitch), then place in head space
      const sub = (rx, ty, tz) =>
        new THREE.Matrix4().makeTranslation(0, ty, tz).multiply(_m1.makeRotationX(rx));
      const MUZ = sub(0.20, 0.010 * H, 0.070 * H);  // snout: raked down, off the skull front
      const JAW = sub(1.00, -0.048 * H, 0.018 * H); // lower jaw: hinged WIDE open (~57°)
      const put = (g, hex, frame = null, outline = false) => {
        if (frame) g.applyMatrix4(frame);
        g.applyMatrix4(headM);
        if (outline) headOutGeos.push(g.clone());
        headGeos.push(paintGeo(g, hex));
      };

      // skull mass: cranium + heavy jowled occiput + brow shelf over the eyes
      put(taperBox(0.175 * H, 0.150 * H, 0.175 * H, 0.82, 0.80).translate(0, 0.005 * H, 0.010 * H), SKULL, null, true);
      put(new THREE.BoxGeometry(0.195 * H, 0.115 * H, 0.095 * H).translate(0, -0.012 * H, -0.045 * H), OCCIPUT, null, true);
      put(new THREE.BoxGeometry(0.178 * H, 0.046 * H, 0.062 * H).rotateX(0.10)
        .translate(0, 0.070 * H, 0.072 * H), BROW, null, true);

      // eye wells: dark inset boxes under the brow — the glow needs a dark bed.
      // Kept INBOARD (a clear white gap between them) so the front-on face reads
      // as two eyes, not one dark visor band.
      for (const s of [-1, 1]) {
        put(new THREE.BoxGeometry(0.042 * H, 0.034 * H, 0.026 * H)
          .rotateY(s * 0.12).translate(s * 0.046 * H, 0.036 * H, 0.084 * H), SOCKET);
        eyeGeos.push({ p: new THREE.Vector3(s * 0.046 * H, 0.036 * H, 0.104 * H).applyMatrix4(headM) });
      }

      // muzzle: blunt tapered snout with a subtle snarl-wrinkle bridge + nose
      put(taperBox(0.115 * H, 0.080 * H, 0.150 * H, 0.72, 0.62).translate(0, 0, 0.075 * H), MUZZLE, MUZ, true);
      put(new THREE.BoxGeometry(0.062 * H, 0.014 * H, 0.110 * H).translate(0, 0.038 * H, 0.062 * H), MUZZLE_TOP, MUZ);
      put(new THREE.BoxGeometry(0.046 * H, 0.026 * H, 0.040 * H).translate(0, 0.016 * H, 0.146 * H), NOSE, MUZ);
      // red roof of the mouth under the muzzle — fills the top of the gape
      put(new THREE.BoxGeometry(0.086 * H, 0.014 * H, 0.135 * H).translate(0, -0.032 * H, 0.068 * H), MAW, MUZ);

      // lower jaw: swung wide open, red tongue/floor lining its top face
      put(taperBox(0.100 * H, 0.038 * H, 0.170 * H, 0.65, 0.80).translate(0, -0.019 * H, 0.085 * H), JAWC, JAW, true);
      put(new THREE.BoxGeometry(0.072 * H, 0.013 * H, 0.140 * H).translate(0, 0.002 * H, 0.078 * H), MAW, JAW);

      // teeth: upper canine pair + shrinking rows, lower canines at the jaw tip
      for (const s of [-1, 1]) {
        put(new THREE.ConeGeometry(0.015 * H, 0.062 * H, 5).rotateX(Math.PI)
          .translate(s * 0.038 * H, -0.058 * H, 0.118 * H), IVORY, MUZ);
        put(new THREE.ConeGeometry(0.009 * H, 0.032 * H, 5).rotateX(Math.PI)
          .translate(s * 0.041 * H, -0.048 * H, 0.078 * H), IVORY, MUZ);
        put(new THREE.ConeGeometry(0.008 * H, 0.026 * H, 5).rotateX(Math.PI)
          .translate(s * 0.043 * H, -0.046 * H, 0.048 * H), IVORY, MUZ);
        put(new THREE.ConeGeometry(0.012 * H, 0.048 * H, 5)
          .translate(s * 0.028 * H, 0.026 * H, 0.148 * H), IVORY, JAW);
        put(new THREE.ConeGeometry(0.008 * H, 0.028 * H, 5)
          .translate(s * 0.032 * H, 0.020 * H, 0.108 * H), IVORY, JAW);
        // ears: 4-sided pyramids swept back and out
        put(new THREE.ConeGeometry(0.036 * H, 0.115 * H, 4).scale(1, 1, 0.55)
          .rotateX(-0.55).rotateZ(-s * 0.30)
          .translate(s * 0.064 * H, 0.102 * H, -0.032 * H), EAR, null, true);
      }
    };

    const headDefs = [
      [0,           0,    0.18, 0.37 * H], // center head — highest
      [-0.12 * H, -0.62,  0.06, 0.31 * H], // left head — splayed, lower
      [ 0.12 * H,  0.62,  0.06, 0.31 * H], // right head
    ];
    for (const [bx, yaw, pitch, nl] of headDefs) {
      const d = dirYP(yaw, pitch);
      const sl = Math.hypot(d[0], d[2]) || 1;
      const side = [d[2] / sl, 0, -d[0] / sl]; // head's right, in XZ
      const base = [bx, 0.65 * H, 0.26 * H];
      const hc = at(base, d, nl);
      S(base, hc, 0.095 * H, 0.080 * H, HIDE);          // neck — stays in the shell
      polyHead(yaw, pitch, at(hc, d, 0.05 * H));        // faceted skull just past the neck end

      // spiked iron collar around the neck — high, right behind the skull, so it
      // READS instead of drowning in the shoulder mass (ad signature)
      const cm = at(base, d, nl * 0.82);
      acc(new THREE.TorusGeometry(0.100 * H, 0.024 * H, 6, 14), IRON, cm, d, [0, 0, 1]);
      const u2 = norm([d[1] * side[2] - d[2] * side[1], d[2] * side[0] - d[0] * side[2], d[0] * side[1] - d[1] * side[0]]);
      for (let k = 0; k < 6; k++) {
        const ang = (k / 6) * Math.PI * 2 + 0.3;
        const rad = norm([side[0] * Math.cos(ang) + u2[0] * Math.sin(ang),
                          side[1] * Math.cos(ang) + u2[1] * Math.sin(ang),
                          side[2] * Math.cos(ang) + u2[2] * Math.sin(ang)]);
        acc(new THREE.ConeGeometry(0.019 * H, 0.07 * H, 5), STEEL, at(cm, rad, 0.10 * H), rad);
      }
    }

    // ---- bone spikes down the spine (shrinking, raked back) ------------------
    const SPINE = [
      [0.09 * H, 0.755 * H, 0.034 * H, 0.15 * H],
      [0.00 * H, 0.750 * H, 0.031 * H, 0.14 * H],
      [-0.09 * H, 0.730 * H, 0.027 * H, 0.12 * H],
      [-0.18 * H, 0.705 * H, 0.023 * H, 0.10 * H],
      [-0.26 * H, 0.675 * H, 0.018 * H, 0.08 * H],
    ];
    for (const [z, y, r, h] of SPINE) {
      acc(new THREE.ConeGeometry(r, h, 6), BONE, [0, y, z], norm([0, 1, -0.5]));
    }

    // ---- iron chain draped over the shoulders (ad signature) -----------------
    const LINKS = 11;
    for (let i = 0; i < LINKS; i++) {
      const t = i / (LINKS - 1);
      const ang = Math.PI * t;
      const px = Math.cos(ang) * 0.235 * H;
      const py = 0.60 * H + Math.sin(ang) * 0.185 * H;
      const pz = 0.12 * H - Math.sin(ang) * 0.03 * H;
      const tan = norm([-Math.sin(ang), Math.cos(ang) * 0.75, 0]); // arc tangent
      acc(new THREE.TorusGeometry(0.020 * H, 0.008 * H, 5, 10), IRON, [px, py, pz], tan, [0, 0, 1]);
    }

    const shell = buildBlendShell(shapes, { k: 0.034 * H, outline: 0.022 * H });
    const shellMesh = new THREE.Mesh(shell.geometry, shell.bodyMaterial);
    const outlineMesh = new THREE.Mesh(shell.geometry, shell.outlineMaterial);
    tilt.add(shellMesh, outlineMesh);

    // faceted heads: one merged vertex-colored mesh + one inverted-hull outline
    // (big forms only — an outline around every tooth would swallow them black)
    const headGeo = mergeGeometries(headGeos, false);
    headGeos.forEach((g) => g.dispose());
    const headMat = new THREE.MeshLambertMaterial({ vertexColors: true });
    const headMesh = new THREE.Mesh(headGeo, headMat);
    const headHull = mergeGeometries(headOutGeos, false);
    headOutGeos.forEach((g) => g.dispose());
    const headOutGeo = inflate(headHull, 0.011 * H);
    headHull.dispose();
    const headOutMat = new THREE.MeshBasicMaterial({ color: 0x14100c, side: THREE.BackSide });
    tilt.add(headMesh, new THREE.Mesh(headOutGeo, headOutMat));

    // one merged crisp-accessory mesh + one merged glowing-eye mesh
    const accGeo = mergeGeometries(accGeos, false);
    accGeos.forEach((g) => g.dispose());
    const accMat = new THREE.MeshLambertMaterial({ vertexColors: true });
    tilt.add(new THREE.Mesh(accGeo, accMat));
    const eyeBits = eyeGeos.map(({ p }) => {
      const g = new THREE.SphereGeometry(0.016 * H, 6, 5);
      g.translate(p.x ?? p[0], p.y ?? p[1], p.z ?? p[2]);
      return g;
    });
    const eyeGeo = mergeGeometries(eyeBits, false);
    eyeBits.forEach((g) => g.dispose());
    const eyeMat = new THREE.MeshBasicMaterial({ color: 0xff7a1a });
    tilt.add(new THREE.Mesh(eyeGeo, eyeMat));

    // raycast volumes: the shell's inflated base mesh + the heads themselves
    const parts = [shellMesh, headMesh];

    group.position.set(truckPos.x, -H, truckPos.z + CONFIG.boss.spawnBehind); // starts underground
    this.scene.add(group);

    const boss = {
      group, tilt, parts,
      shell,                          // { uniforms, bodyMaterial, outlineMaterial } — flash/fade via uniforms
      bodyMats: [],                   // (legacy Lambert-emissive path — unused for the shell)
      legAnim,                        // gait: leg/paw shape indices + rest endpoints
      headMat,                        // faceted heads flash via emissive (no shell uniform)
      fadeMats: [accMat, eyeMat, headMat, headOutMat], // everything fades with the shell on death
      mats: [shell.bodyMaterial, shell.outlineMaterial, eyeMat, accMat, headMat, headOutMat],
      geos: [shell.geometry, eyeGeo, accGeo, headGeo, headOutGeo],
      hp: CONFIG.boss.hp, maxHp: CONFIG.boss.hp,
      x: group.position.x, z: group.position.z,
      flash: 0, walk: Math.random() * 6.28,
      rising: 1,                     // 1 → 0 as it rises out of the ground (0.8s)
      dying: false, deathT: 0,
      H,
    };
    for (const m of parts) { m.userData.boss = boss; this._raycastMeshes.push(m); }

    this.bosses.push(boss);
    group.updateMatrixWorld(true); // a same-frame raycast sees it in place
    return boss;
  }

  // Nearest LIVE boss under a camera ray, or null. Dying bosses are pulled from
  // the raycast list so a toppling corpse can't eat bullets.
  raycast(raycaster) {
    if (!this._raycastMeshes.length) return null;
    const hits = raycaster.intersectObjects(this._raycastMeshes, false);
    for (const it of hits) {
      const boss = it.object.userData.boss;
      if (boss && !boss.dying) return { boss, point: it.point, distance: it.distance };
    }
    return null;
  }

  // Apply bullet/splash damage. Returns { killed } or null if already dying.
  // main.js owns the FX (numbers/mist) and, on kill, the death explosion.
  damage(boss, dmg) {
    if (!boss || boss.dying) return null;
    boss.hp -= dmg;
    boss.flash = 1;
    if (boss.hp <= 0) { this._startDeath(boss); return { killed: true }; }
    return { killed: false };
  }

  _startDeath(boss) {
    boss.dying = true;
    boss.deathT = 0;
    // pull its parts out of the raycast list — a corpse can't be re-hit
    this._raycastMeshes = this._raycastMeshes.filter((m) => m.userData.boss !== boss);
    for (const m of boss.bodyMats) m.transparent = true; // enable the fade
    if (boss.shell) { // SDF shell: fade both body + outline passes
      boss.shell.bodyMaterial.transparent = true;
      boss.shell.outlineMaterial.transparent = true;
    }
    if (boss.fadeMats) for (const m of boss.fadeMats) m.transparent = true; // accessories + eyes too
  }

  _remove(boss) {
    this.scene.remove(boss.group);
    for (const g of boss.geos) g.dispose();
    for (const m of boss.mats) m.dispose();
    const i = this.bosses.indexOf(boss);
    if (i !== -1) this.bosses.splice(i, 1);
  }

  // Debug: wipe all bosses instantly (panel "Clear bosses")
  clear() {
    for (let i = this.bosses.length - 1; i >= 0; i--) this._remove(this.bosses[i]);
    this._raycastMeshes.length = 0;
    this.smashThisFrame = false;
  }

  update(dt, truckPos) {
    const cfg = CONFIG.boss;
    this.smashThisFrame = false;

    for (let i = this.bosses.length - 1; i >= 0; i--) {
      const b = this.bosses[i];

      // ---- death: topple onto its face, then sink + fade, then remove --------
      if (b.dying) {
        b.deathT += dt;
        const t = b.deathT;
        b.tilt.rotation.x = Math.min(t / 0.9, 1) * 1.45; // fall forward, toward the truck
        if (t > 0.9) {
          const s = (t - 0.9) / 1.7;
          b.group.position.y = -s * b.H * 0.6;             // sink into the sand
          const op = Math.max(0, 1 - s);
          if (b.shell) b.shell.uniforms.uOpacity.value = op;   // SDF shell fade
          else for (const m of b.bodyMats) m.opacity = op;     // fade out
          if (b.fadeMats) for (const m of b.fadeMats) m.opacity = op; // accessories + eyes
        }
        if (t > 2.6) this._remove(b);
        else b.group.updateMatrixWorld(true);
        continue;
      }

      // ---- rise-from-ground entrance ----------------------------------------
      if (b.rising > 0) {
        b.rising = Math.max(0, b.rising - dt / 0.8);
        b.group.position.y = -b.H * b.rising;
      }

      // ---- advance on the truck; on reaching it, SMASH = instant game over ---
      // Photo mode parks it at CONFIG.photo.bossDist instead — no advance, no smash.
      if (CONFIG.photo.enabled) {
        b.x = truckPos.x;
        b.z = truckPos.z + CONFIG.photo.bossDist;
      } else {
        const ax = truckPos.x - b.x;
        const az = truckPos.z - b.z;
        const dist = Math.hypot(ax, az);
        if (dist > cfg.smashDist) {
          const inv = 1 / Math.max(dist, 0.001);
          b.x += ax * inv * cfg.speed * dt;
          b.z += az * inv * cfg.speed * dt;
        } else {
          this.smashThisFrame = true; // reached the truck — one hit ends the run (main handles it)
        }
      }
      const dx = truckPos.x - b.x;
      const dz = truckPos.z - b.z;
      b.group.position.x = b.x;
      b.group.position.z = b.z;
      b.group.rotation.y = Math.atan2(dx, dz); // face the truck (horde convention)

      // ---- lumbering walk: big slow bob/sway + diagonal-gait legs ------------
      b.walk += dt * (0.9 + cfg.speed * 0.12);
      const sw = Math.sin(b.walk);
      if (b.rising <= 0) b.group.position.y = Math.abs(sw) * 0.18;
      b.tilt.rotation.z = sw * 0.04;
      // Procedural gait: swing each leg's shape endpoints in the SHARED shader
      // uniforms — the blend-shell re-snaps every frame, so the hide flows over
      // the moving legs. Diagonal pairs (FL+RR vs FR+RL); the foot lifts only
      // while it swings forward, then drags back planted.
      if (b.legAnim && b.shell) {
        const uA = b.shell.uniforms.uShapeA.value;
        const uB = b.shell.uniforms.uShapeB.value;
        const stride = 0.075 * b.H, lift = 0.05 * b.H;
        const gait = b.walk * 1.6;
        for (const L of b.legAnim) {
          const ph = gait + L.phase;
          const zOff = Math.sin(ph) * stride;
          const yOff = Math.max(0, Math.cos(ph)) * lift;
          uA[L.li].set(L.la[0], L.la[1], L.la[2] + zOff * 0.2, L.lra);
          uB[L.li].set(L.lb[0], L.lb[1] + yOff, L.lb[2] + zOff, L.lrb);
          uA[L.pi].set(L.pa[0], L.pa[1] + yOff, L.pa[2] + zOff, L.pra);
          uB[L.pi].set(L.pb[0], L.pb[1] + yOff, L.pb[2] + zOff, L.prb);
        }
      }

      // ---- hit flash → white, decays ----------------------------------------
      if (b.flash > 0) {
        b.flash = Math.max(0, b.flash - dt * 6);
        const e = b.flash;
        if (b.shell) b.shell.uniforms.uFlash.value = e;              // SDF shell: shader uniform
        else for (const m of b.bodyMats) m.emissive.setRGB(e, e * 0.85, e * 0.7);
        if (b.headMat) b.headMat.emissive.setRGB(e, e * 0.85, e * 0.7); // faceted heads flash too
      }

      b.group.updateMatrixWorld(true); // exact bounds for this frame's hitscan
    }
  }
}
