import * as THREE from 'three';
import { CONFIG } from './config.js';

// Phase 4 — shoot-the-number powerups.
//
// Crates spawn roadside just behind the truck, fully in view, and RECEDE toward
// the horde as the truck escapes (they're static in the world; the truck drives
// away). Each carries a countdown; every bullet that hits the crate decrements
// it, and at 0 the crate's effect fires. The shrinking window before the wave
// swallows the crate IS the mechanic — crack it in time or lose it.
//
// Crates are plain Meshes, so `raycaster.intersectObjects` uses each crate's own
// world matrix — the bounds track the crate for free. (The stale-bounding-sphere
// trap that bit Phase 2/3 is specific to InstancedMesh; a per-Mesh raycast is
// immune, which is exactly why the spec says "raycast targets → plain Meshes".)
//
// EFFECT REGISTRY: `_effects[name]` dispatches on trigger. All five ship:
//   tank   — MG → cannon (splash AoE, slower, timed)
//   rocket — one big AoE from above on the densest visible cluster
//   mines  — scatter on the road behind; detonate on zombie contact
//   wall   — a cargo barrier that BLOCKS a zombie channel (Horde.barriers)
//   spikes — a spiked drum rolls back into the horde, crushing + shoving
// Every explosive path funnels through fx.explode / fx.burstKills so the
// force-gib rule (every AoE kill bursts, no crit roll) holds everywhere.

const EFFECT_KEYS = ['tank', 'rocket', 'mines', 'wall', 'spikes'];
// Crate colors read the effect at a glance, before you shoot it.
const EFFECT_COLOR = {
  tank: 0xff7a1a,   // orange
  rocket: 0xd23b2a, // red
  mines: 0xf2c218,  // yellow
  wall: 0x8794a3,   // steel
  spikes: 0x9a4bd6, // purple
};
const CRATE_TRIM = 0x241a10;
const DRUM_R = 1.4;
const CARGO_COLORS = [0x9a6b3a, 0x6f8a5a, 0x8a5a5a, 0x5a6f8a];

export class Powerups {
  // fx: { explode(x,y,z,r,dmg,opts), burstKills(list,cx,cz,dmg), sfx, gun, mist }
  constructor(scene, horde, fx) {
    this.scene = scene;
    this.horde = horde;
    this.fx = fx;

    this.crates = [];
    this.crateMeshes = [];   // raycast list (kept in lockstep with this.crates)
    this.rockets = [];
    this.mines = [];
    this.walls = [];
    this.drums = [];
    this._truckZ = 0;
    this._spawnCredit = 0;

    // Current weapon mode — main reads this to pick fire params & fire logic.
    this.weapon = { mode: 'mg', timeLeft: 0 };

    // Shared geometry (each crate still owns its material for the hit flash)
    this._boxGeo = new THREE.BoxGeometry(1, 1, 1);
    this._trimMat = new THREE.MeshLambertMaterial({ color: CRATE_TRIM });
    this._rocketGeo = new THREE.ConeGeometry(0.3, 1.4, 10);
    this._rocketMat = new THREE.MeshLambertMaterial({ color: 0x2c2c30 });
    this._mineDiscGeo = new THREE.CylinderGeometry(0.42, 0.48, 0.16, 14);
    this._mineDiscMat = new THREE.MeshLambertMaterial({ color: 0x1b1b1e });
    this._mineNubGeo = new THREE.CylinderGeometry(0.1, 0.1, 0.12, 8);
    this._mineNubMat = new THREE.MeshBasicMaterial({ color: 0xff3322 });
    this._drumMat = new THREE.MeshLambertMaterial({ color: 0x565b62 });
    this._spikeMat = new THREE.MeshLambertMaterial({ color: 0x2a2d31 });

    this._effects = {
      tank: () => this._giveTankGun(),
      rocket: () => this._rocketStrike(),
      mines: () => this._scatterMines(),
      wall: () => this._dropWall(),
      spikes: () => this._dropSpikes(),
    };
  }

  // ---- crate spawning -------------------------------------------------------
  spawnCrate(effect) {
    if (this.crates.length >= CONFIG.powerups.maxActive) return null;
    if (!effect || effect === 'random') {
      effect = EFFECT_KEYS[(Math.random() * EFFECT_KEYS.length) | 0];
    }
    const size = CONFIG.powerups.crateSize;
    const side = Math.random() < 0.5 ? -1 : 1;
    const x = side * (CONFIG.world.roadWidth / 2 + 1.5 + Math.random() * 3); // roadside flats
    const z = this._truckZ + CONFIG.powerups.spawnBehind;

    const group = new THREE.Group();
    group.position.set(x, 0, z);

    const mat = new THREE.MeshLambertMaterial({ color: EFFECT_COLOR[effect] || 0xff7a1a });
    const box = new THREE.Mesh(this._boxGeo, mat);
    box.scale.setScalar(size);
    box.position.y = size / 2;
    group.add(box);

    const band = new THREE.Mesh(this._boxGeo, this._trimMat);
    band.scale.set(size * 1.04, size * 0.16, size * 1.04);
    band.position.y = size * 0.5;
    group.add(band);

    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 128;
    const tex = new THREE.CanvasTexture(canvas);
    tex.minFilter = THREE.LinearFilter;
    const spriteMat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false });
    const sprite = new THREE.Sprite(spriteMat);
    sprite.scale.set(2.6, 2.6, 1);
    sprite.position.y = size + 1.7;
    sprite.renderOrder = 25;
    group.add(sprite);

    this.scene.add(group);

    const crate = {
      group, box, mat, canvas, tex, sprite, spriteMat,
      count: CONFIG.powerups.startCount, effect,
      hitFlash: 0, spin: (Math.random() - 0.5) * 0.4, bobPhase: Math.random() * 6.28,
      alive: true,
    };
    box.userData.crate = crate;
    this._drawNumber(crate);
    group.updateMatrixWorld(true); // so a same-frame raycast sees it in place

    this.crates.push(crate);
    this.crateMeshes.push(box);
    return crate;
  }

  _drawNumber(crate) {
    const ctx = crate.canvas.getContext('2d');
    ctx.clearRect(0, 0, 128, 128);
    ctx.font = '900 92px Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 13;
    ctx.strokeStyle = 'rgba(0,0,0,0.85)';
    ctx.strokeText(String(crate.count), 64, 70);
    ctx.fillStyle = '#ffffff';
    ctx.fillText(String(crate.count), 64, 70);
    crate.tex.needsUpdate = true;
  }

  // ---- raycast + hit --------------------------------------------------------
  raycast(raycaster) {
    if (!this.crateMeshes.length) return null;
    const hits = raycaster.intersectObjects(this.crateMeshes, false);
    if (!hits.length) return null;
    const it = hits[0];
    return { crate: it.object.userData.crate, distance: it.distance, point: it.point };
  }

  hitCrate(crate) {
    if (!crate || !crate.alive) return;
    crate.count -= 1;
    crate.hitFlash = 1;
    if (this.fx.sfx) this.fx.sfx.crateHit();
    if (crate.count <= 0) this._trigger(crate);
    else this._drawNumber(crate);
  }

  _trigger(crate) {
    crate.alive = false;
    const p = crate.group.position;
    if (this.fx.mist) this.fx.mist.dust(p);
    if (this.fx.sfx) this.fx.sfx.pickup();
    const effect = crate.effect;
    this._removeCrate(crate);
    (this._effects[effect] || this._effects.tank)();
  }

  _removeCrate(crate) {
    const gi = this.crates.indexOf(crate);
    if (gi !== -1) this.crates.splice(gi, 1);
    const mi = this.crateMeshes.indexOf(crate.box);
    if (mi !== -1) this.crateMeshes.splice(mi, 1);
    this.scene.remove(crate.group);
    crate.mat.dispose();
    crate.spriteMat.dispose();
    crate.tex.dispose();
  }

  // v1.1 level starts wipe the field: every active crate goes (in-flight
  // effects — mines, walls, drums — self-drain on their own timers).
  clearCrates() {
    while (this.crates.length) this._removeCrate(this.crates[0]);
  }

  _banner(text, life = 1.3) { this.banner = text; this._bannerLife = life; }

  // ---- effect: tank gun -----------------------------------------------------
  _giveTankGun() {
    this.weapon.mode = 'tank';
    this.weapon.timeLeft = CONFIG.powerups.tank.duration;
    if (this.fx.gun) this.fx.gun.setTankMode(true);
    this._banner('TANK GUN!');
  }

  _endTankGun() {
    this.weapon.mode = 'mg';
    this.weapon.timeLeft = 0;
    if (this.fx.gun) this.fx.gun.setTankMode(false);
  }

  // ---- effect: rocket strike ------------------------------------------------
  _rocketStrike() {
    const r = CONFIG.powerups.rocket;
    const c = this._densestCluster();
    const sx = c.x + (Math.random() - 0.5) * 4;
    const mesh = new THREE.Mesh(this._rocketGeo, this._rocketMat);
    mesh.rotation.x = Math.PI * 0.72; // nose down-and-forward, streaking in
    mesh.position.set(sx, r.fallHeight, c.z + 12);
    this.scene.add(mesh);
    this.rockets.push({
      mesh, sx, sy: r.fallHeight, sz: c.z + 12,
      tx: c.x, ty: 0.6, tz: c.z, t: 0, dur: r.travel,
    });
    if (this.fx.sfx) this.fx.sfx.whoosh();
    this._banner('ROCKET STRIKE');
  }

  // Coarse-grid the living horde in the NEAR band (relZ up to rocket.targetNear)
  // and return the fullest cell's centroid — so the strike lands on the zombies
  // about to reach the truck, not the harmless back rows deep in the canyon.
  _densestCluster() {
    const h = this.horde, tz = this._truckZ, cell = 6;
    const near = CONFIG.powerups.rocket.targetNear;
    const buckets = new Map();
    let bestN = 0, best = null;
    for (let i = 0; i < h.activeCount; i++) {
      if (h.dead[i]) continue;
      const rel = h.z[i] - tz;
      if (rel < 5 || rel > near) continue;
      const key = Math.round(h.x[i] / cell) + ',' + Math.round(h.z[i] / cell);
      let e = buckets.get(key);
      if (!e) { e = { n: 0, sx: 0, sz: 0 }; buckets.set(key, e); }
      e.n++; e.sx += h.x[i]; e.sz += h.z[i];
      if (e.n > bestN) { bestN = e.n; best = e; }
    }
    if (!best) return { x: 0, z: tz + 16 }; // fallback: just behind the truck
    return { x: best.sx / best.n, z: best.sz / best.n };
  }

  // ---- effect: landmines ----------------------------------------------------
  _scatterMines() {
    const m = CONFIG.powerups.mines;
    for (let k = 0; k < m.count; k++) {
      const x = (Math.random() - 0.5) * m.spreadX;                 // road + both shoulders
      const z = this._truckZ + m.nearZ + Math.random() * (m.farZ - m.nearZ);
      const group = new THREE.Group();
      const disc = new THREE.Mesh(this._mineDiscGeo, this._mineDiscMat);
      disc.position.y = 0.08;
      const nub = new THREE.Mesh(this._mineNubGeo, this._mineNubMat);
      nub.position.y = 0.2;
      group.add(disc, nub);
      group.position.set(x, 0, z);
      this.scene.add(group);
      this.mines.push({ group, nub, x, z, life: 0, blinkT: Math.random() });
    }
    this._banner('MINES ARMED');
  }

  // ---- effect: cargo-box wall ----------------------------------------------
  _dropWall() {
    const w = CONFIG.powerups.wall;
    const side = Math.random() < 0.5 ? -1 : 1;
    const cx = side * (CONFIG.world.roadWidth * 0.2 + Math.random() * 3); // block a channel
    const x0 = cx - w.width / 2, x1 = cx + w.width / 2;
    const z = this._truckZ + 14;

    const group = new THREE.Group();
    const unit = w.width / 3;
    for (let row = 0; row < 2; row++) {
      for (let c = 0; c < 3; c++) {
        const box = new THREE.Mesh(this._boxGeo, new THREE.MeshLambertMaterial({
          color: CARGO_COLORS[(row * 3 + c) % CARGO_COLORS.length],
        }));
        box.scale.set(unit * 0.96, 1.5, 2.2);
        box.position.set(x0 + unit * (c + 0.5), 0.75 + row * 1.5, 0);
        group.add(box);
      }
    }
    group.position.z = z;
    this.scene.add(group);

    const barrier = { x0, x1, z };
    this.horde.barriers.push(barrier);
    this.walls.push({ group, barrier, z, life: 0, sfxCd: 0 });
    this._banner('CARGO WALL');
  }

  // ---- effect: rolling spikes ----------------------------------------------
  _dropSpikes() {
    const width = CONFIG.powerups.spikes.width;   // live knob — build geo to match
    const cylGeo = new THREE.CylinderGeometry(DRUM_R, DRUM_R, width, 16);
    const spikeGeo = new THREE.BoxGeometry(width * 0.98, 0.16, DRUM_R * 2.5);
    const roller = new THREE.Group();
    const cyl = new THREE.Mesh(cylGeo, this._drumMat);
    cyl.rotation.z = Math.PI / 2; // lay the drum axis across the road (world X)
    roller.add(cyl);
    for (let k = 0; k < 3; k++) {
      const spike = new THREE.Mesh(spikeGeo, this._spikeMat);
      spike.rotation.x = (k / 3) * Math.PI; // crossed planks → spiked silhouette
      roller.add(spike);
    }
    const grp = new THREE.Group();
    grp.add(roller);
    const x = (Math.random() - 0.5) * 3;          // ~centered — it's wide, cover the road
    const z = this._truckZ + 6;
    grp.position.set(x, DRUM_R, z);
    this.scene.add(grp);
    this.drums.push({ grp, roller, cylGeo, spikeGeo, x, z, life: 0, sfxCd: 0 });
    this._banner('ROLLING SPIKES');
  }

  // ---- per-frame ------------------------------------------------------------
  update(dt, truckPos) {
    this._truckZ = truckPos.z;

    if (this.weapon.mode === 'tank') {
      this.weapon.timeLeft -= dt;
      if (this.weapon.timeLeft <= 0) this._endTankGun();
    }
    if (this._bannerLife > 0) {
      this._bannerLife -= dt;
      if (this._bannerLife <= 0) this.banner = null;
    }

    if (CONFIG.powerups.enabled) {
      this._spawnCredit += CONFIG.powerups.spawnRate * dt;
      while (this._spawnCredit >= 1) {
        this._spawnCredit -= 1;
        this.spawnCrate('random');
      }
      if (this._spawnCredit > 1) this._spawnCredit = 1;
    }

    this._updateCrates(dt, truckPos);
    this._updateRockets(dt);
    this._updateMines(dt, truckPos);
    this._updateWalls(dt, truckPos);
    this._updateDrums(dt);
  }

  _updateCrates(dt, truckPos) {
    const lose = CONFIG.powerups.loseDist;
    for (let i = this.crates.length - 1; i >= 0; i--) {
      const c = this.crates[i];
      const relZ = c.group.position.z - truckPos.z;
      if (relZ > lose) { // swallowed by the horde — lost
        if (this.fx.mist) this.fx.mist.dust(c.group.position);
        this._removeCrate(c);
        continue;
      }
      c.group.rotation.y += c.spin * dt;
      c.box.position.y = CONFIG.powerups.crateSize / 2 + Math.sin(this.horde.time + c.bobPhase) * 0.12;
      if (c.hitFlash > 0) {
        c.hitFlash = Math.max(0, c.hitFlash - dt * 6);
        c.mat.emissive.setRGB(c.hitFlash, c.hitFlash, c.hitFlash);
      }
      const u = THREE.MathUtils.clamp(relZ / lose, 0, 1); // white → red as it recedes
      c.spriteMat.color.setRGB(1, 1 - u * 0.75, 1 - u * 0.95);
    }
  }

  _updateRockets(dt) {
    const r = CONFIG.powerups.rocket;
    for (let i = this.rockets.length - 1; i >= 0; i--) {
      const rk = this.rockets[i];
      rk.t += dt / rk.dur;
      if (rk.t >= 1) {
        this.fx.explode(rk.tx, rk.ty, rk.tz, r.radius, r.damage, { trauma: 1.0, big: true });
        this.scene.remove(rk.mesh);
        this.rockets.splice(i, 1);
        continue;
      }
      const e = rk.t;
      rk.mesh.position.set(
        rk.sx + (rk.tx - rk.sx) * e,
        rk.sy + (rk.ty - rk.sy) * e,
        rk.sz + (rk.tz - rk.sz) * e,
      );
      if (this.fx.mist) this.fx.mist.dust(rk.mesh.position); // smoke trail
    }
  }

  _updateMines(dt, truckPos) {
    const m = CONFIG.powerups.mines;
    const h = this.horde;
    const tr2 = m.triggerRadius * m.triggerRadius;
    for (let i = this.mines.length - 1; i >= 0; i--) {
      const mn = this.mines[i];
      mn.life += dt;
      mn.blinkT += dt;
      mn.nub.visible = (mn.blinkT % 0.5) < 0.28; // telegraph
      const relZ = mn.z - truckPos.z;
      if (mn.life > m.life || relZ > CONFIG.powerups.loseDist) {
        this.scene.remove(mn.group);
        this.mines.splice(i, 1);
        continue;
      }
      let tripped = false;
      for (let j = 0; j < h.activeCount; j++) {
        if (h.dead[j]) continue;
        const dx = h.x[j] - mn.x, dz = h.z[j] - mn.z;
        if (dx * dx + dz * dz < tr2) { tripped = true; break; }
      }
      if (tripped) {
        this.fx.explode(mn.x, 0.3, mn.z, m.blastRadius, m.damage, { trauma: 0.5 });
        this.scene.remove(mn.group);
        this.mines.splice(i, 1);
      }
    }
  }

  _updateWalls(dt, truckPos) {
    const w = CONFIG.powerups.wall;
    for (let i = this.walls.length - 1; i >= 0; i--) {
      const wl = this.walls[i];
      wl.life += dt;

      // Grind the dam: zombies pinned against the rear face take crush damage
      // (always gibs) — the wall actively thins the channel instead of just
      // standing there.
      const bar = wl.barrier;
      const cx = (bar.x0 + bar.x1) * 0.5, halfX = (bar.x1 - bar.x0) * 0.5;
      wl.sfxCd -= dt;
      const kl = this.horde.boxDamage(cx, bar.z + 0.6, halfX, 1.4, w.crushDps * dt);
      if (kl.length) {
        this.fx.burstKills(kl, cx, bar.z, Math.round(w.crushDps * dt));
        if (this.fx.sfx && wl.sfxCd <= 0) { this.fx.sfx.gib(); wl.sfxCd = 0.15; }
      }

      const relZ = wl.z - truckPos.z;
      if (wl.life > w.life || relZ > CONFIG.powerups.loseDist + 25) {
        const bi = this.horde.barriers.indexOf(wl.barrier);
        if (bi !== -1) this.horde.barriers.splice(bi, 1);
        this.scene.remove(wl.group);
        this.walls.splice(i, 1);
      }
    }
  }

  _updateDrums(dt) {
    const s = CONFIG.powerups.spikes;
    const h = this.horde;
    for (let i = this.drums.length - 1; i >= 0; i--) {
      const d = this.drums[i];
      d.life += dt;
      d.z += s.speed * dt;              // roll backward, into the horde
      d.grp.position.z = d.z;
      d.roller.rotation.x -= (s.speed / DRUM_R) * dt; // spin to match travel
      d.sfxCd -= dt;

      // Crush swath — a box the full width of the drum, always gibs
      const halfX = s.width / 2;
      const kl = h.boxDamage(d.x, d.z, halfX, s.crushRadius, s.dps * dt);
      if (kl.length) {
        this.fx.burstKills(kl, d.x, d.z, Math.round(s.dps * dt));
        if (this.fx.sfx && d.sfxCd <= 0) { this.fx.sfx.gib(); d.sfxCd = 0.12; }
      }
      // Shove survivors just ahead of the drum back (+z) and outward in x
      for (let j = 0; j < h.activeCount; j++) {
        if (h.dead[j]) continue;
        const dx = h.x[j] - d.x, dz = h.z[j] - d.z;
        if (Math.abs(dx) > halfX + 1 || dz > s.shoveRadius || dz < -1) continue;
        h.z[j] += s.back * dt;                        // push away from the truck
        h.x[j] += Math.sign(dx || 1) * s.back * 0.4 * dt;
      }

      if (d.life > s.duration) {
        this.scene.remove(d.grp);
        d.cylGeo.dispose();
        d.spikeGeo.dispose();
        this.drums.splice(i, 1);
      }
    }
  }

  hudLine() {
    if (this.weapon.mode === 'tank') return `TANK GUN ${this.weapon.timeLeft.toFixed(1)}s`;
    if (this.banner) return this.banner;
    const parts = [`Crates ${this.crates.length}`];
    if (this.mines.length) parts.push(`Mines ${this.mines.length}`);
    if (this.drums.length) parts.push('SPIKES');
    if (this.walls.length) parts.push('WALL');
    if (this.rockets.length) parts.push('ROCKET');
    return parts.join('   ');
  }
}
