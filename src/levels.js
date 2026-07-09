import * as THREE from 'three';
import { CONFIG } from './config.js';

// v1.1 — the level system. A level is a scripted ~2-minute RUN: the win is
// getting the truck to a safe-zone gate alive. No new mechanics — a level
// definition just drives the knobs the sandbox already has (spawn-rate curve,
// horde cap/speeds, crate rate, contact damage, boss cue, camera shifts) over
// time. Lose conditions are the existing two (overrun / boss smash).
//
// The gate spawns ahead of the truck `CONFIG.levels.gateLead` seconds before
// the duration is up — but ONLY once no boss is alive. On a boss level that
// means the win REQUIRES the kill: Cerberus closes faster than the truck, so
// either it dies (gate appears, you drive through) or it smashes you first.

// Level schema: a scripted run driven entirely by existing knobs.
//   surges:  [{ at, len, rate, speedMult }]  — window raises spawn rate AND swells
//            the whole-horde speed (speedMult, default 1) so the wall rushes in.
//   boss:    { hp, speed, spawns: [t, ...] }  — one or more staggered spawns that
//            share hp/speed; the gate holds while ANY of them lives.
// Adding a level = one entry here; the menu, GUI dropdown, and win-card chaining
// all read LEVELS, so no other file needs touching to grow the ladder.
export const LEVELS = [
  {
    id: 1, name: 'FIRST LIGHT',
    duration: 120,
    cap: 220, minSpeed: 4.5, maxSpeed: 6.6,
    rate: [[0, 6], [0.4, 10], [1, 14]],   // [fraction-of-run, spawner rate] keyframes
    surges: [],
    crateRate: 0.22, contactDamage: 2,
    boss: null,
    camShift: { min: 45, extra: 20 },     // gentle intro — ~2 shifts per run
  },
  {
    id: 2, name: 'THE NARROWS',
    duration: 120,
    cap: 420, minSpeed: 4.8, maxSpeed: 7.0,
    rate: [[0, 10], [0.3, 16], [0.7, 22], [1, 26]],
    // the wall collapses — spawn-rate spike AND a speed swell so you feel it
    surges: [{ at: 50, len: 8, rate: 55, speedMult: 1.4 }, { at: 95, len: 8, rate: 60, speedMult: 1.45 }],
    crateRate: 0.18, contactDamage: 3,
    boss: null,
    camShift: { min: 30, extra: 22 },
  },
  {
    id: 3, name: 'CERBERUS',
    duration: 120,
    cap: 380, minSpeed: 4.6, maxSpeed: 6.8,
    rate: [[0, 10], [1, 20]],
    surges: [{ at: 70, len: 8, rate: 45, speedMult: 1.35 }],
    crateRate: 0.22, contactDamage: 3,    // generous crates — you need the firepower
    // Rises at t=38 with 92u to close at +1.3 u/s → catches the truck ~t=104
    // if ignored. Kill it and the gate appears on schedule.
    boss: { hp: 4200, speed: 7.3, spawns: [38] },
    camShift: { min: 35, extra: 20 },
  },
  {
    id: 4, name: 'THE GRINDER',
    duration: 130,
    cap: 500, minSpeed: 5.0, maxSpeed: 7.4,
    rate: [[0, 14], [0.3, 22], [0.7, 28], [1, 32]],
    // No boss — the horde IS the boss. Three escalating surges, each faster than
    // the last, and lean crates so you can't just clear-cut your way through.
    surges: [
      { at: 35, len: 6, rate: 55, speedMult: 1.15 },
      { at: 65, len: 6, rate: 60, speedMult: 1.18 },
      { at: 95, len: 7, rate: 66, speedMult: 1.22 },
    ],
    crateRate: 0.22, contactDamage: 4,
    boss: null,
    camShift: { min: 30, extra: 18 },
  },
  {
    id: 5, name: 'TWIN FANGS',
    duration: 130,
    cap: 440, minSpeed: 4.8, maxSpeed: 7.2,
    rate: [[0, 12], [0.5, 20], [1, 26]],
    surges: [{ at: 80, len: 8, rate: 55, speedMult: 1.4 }],
    crateRate: 0.24, contactDamage: 3,    // generous — TWO beasts to feed the guns
    // Two Cerberus, staggered — the gate holds until BOTH are down.
    boss: { hp: 3600, speed: 7.2, spawns: [25, 60] },
    camShift: { min: 28, extra: 18 },     // shifts come more often
  },
  {
    id: 6, name: 'LAST LIGHT',
    duration: 140,
    cap: 480, minSpeed: 5.2, maxSpeed: 7.8,
    rate: [[0, 16], [0.3, 24], [0.7, 30], [1, 36]],
    surges: [
      { at: 40, len: 7, rate: 60, speedMult: 1.10 },
      { at: 85, len: 7, rate: 66, speedMult: 1.13 },
      { at: 115, len: 8, rate: 70, speedMult: 1.16 },
    ],
    crateRate: 0.22, contactDamage: 4,
    // A staggered PACK of three (engine cap is 3 concurrent). The last rises at
    // t=105 — ~27s to clear the pack before the gate window would open.
    boss: { hp: 4000, speed: 7.4, spawns: [30, 70, 105] },
    camShift: { min: 26, extra: 16 },
  },
];

export class LevelDirector {
  constructor(scene, deps) {
    this.scene = scene;
    this.deps = deps;           // { horde, boss, powerups, truck, camDir }
    this.active = false;
    this.index = -1;
    this.lvl = null;
    this.t = 0;
    this.gate = null;
    this.gateZ = 0;
    this.gateUp = false;
    this._bossFired = 0;     // how many of this level's staggered boss spawns have fired
    this.noteDanger = false; // main reads this to colour the level-bar note red
    // Pristine sandbox knob values — restored by stop() so a level run doesn't
    // permanently rewrite the sandbox's tuning.
    this._snap = {
      rate: CONFIG.spawner.rate,
      minSpeed: CONFIG.horde.minSpeed, maxSpeed: CONFIG.horde.maxSpeed,
      speedMul: CONFIG.horde.speedMul,
      contact: CONFIG.combat.contactDamage,
      crate: CONFIG.powerups.spawnRate,
      bossHp: CONFIG.boss.hp, bossSpeed: CONFIG.boss.speed,
      // camera-shift cadence: levels overwrite these in start(), so restore them
      // too or the last-played level's cadence leaks into the sandbox.
      camMin: CONFIG.camShift.minInterval, camExtra: CONFIG.camShift.maxExtra,
    };
  }

  start(i) {
    const L = LEVELS[i];
    if (!L) return;
    this.index = i;
    this.lvl = L;
    this.active = true;
    this.t = 0;
    this.gateUp = false;
    this._bossFired = 0;
    this._removeGate();

    // Dev guardrail (levels-4/6 bug, 2026-07-08): a surge whose speed swell
    // pushes even the SLOWEST zombie well past the truck removes the escape
    // valve — the whole horde converges and the run turns unwinnable. Flag it at
    // level start so a new level can't silently reintroduce it. A hairline
    // overspeed on the climactic surge is fine (only the tail gains); the 1.05
    // margin fires only when the swell is genuinely catastrophic.
    for (const s of L.surges) {
      const slowest = L.minSpeed * (s.speedMult || 1);
      if (slowest >= CONFIG.truck.speed * 1.05) {
        console.warn(
          `[levels] L${L.id} "${L.name}" surge @${s.at}s: slowest zombie ${slowest.toFixed(2)} u/s ≥ truck ${CONFIG.truck.speed} u/s +5% — whole horde outruns the truck (no escape valve).`
        );
      }
    }

    // Drive the sandbox knobs from the level definition
    CONFIG.horde.minSpeed = L.minSpeed;
    CONFIG.horde.maxSpeed = L.maxSpeed;
    CONFIG.horde.speedMul = 1;   // clear any leftover surge swell
    CONFIG.combat.contactDamage = L.contactDamage;
    CONFIG.powerups.spawnRate = L.crateRate;
    if (L.boss) { CONFIG.boss.hp = L.boss.hp; CONFIG.boss.speed = L.boss.speed; }

    // Clean slate: fresh horde (re-rolls speeds/positions), no bosses, no
    // crates, MG in hand, full truck HP. Kills reset in main's startLevel().
    const { horde, boss, powerups, truck, camDir } = this.deps;
    boss.clear();
    powerups.clearCrates();
    powerups._endTankGun();
    truck.resetHp();
    horde.setCount(0);
    horde.setCount(L.cap);

    // Camera shifts: level cadence into the shared knobs, rig back to default
    if (L.camShift) {
      CONFIG.camShift.minInterval = L.camShift.min;
      CONFIG.camShift.maxExtra = L.camShift.extra;
    }
    camDir.reset();
    camDir.setEnabled(!!L.camShift);
  }

  // Leave level mode (back to menu/sandbox): restore sandbox knobs + camera.
  stop() {
    if (!this.active && !this.gate) return;
    this.active = false;
    this.lvl = null;
    this._removeGate();
    const s = this._snap;
    CONFIG.spawner.rate = s.rate;
    CONFIG.horde.minSpeed = s.minSpeed;
    CONFIG.horde.maxSpeed = s.maxSpeed;
    CONFIG.horde.speedMul = s.speedMul;
    CONFIG.combat.contactDamage = s.contact;
    CONFIG.powerups.spawnRate = s.crate;
    CONFIG.boss.hp = s.bossHp;
    CONFIG.boss.speed = s.bossSpeed;
    CONFIG.camShift.minInterval = s.camMin;
    CONFIG.camShift.maxExtra = s.camExtra;
    const { camDir } = this.deps;
    camDir.setEnabled(CONFIG.camShift.sandbox);
    camDir.reset();
  }

  _rateAt(frac) {
    const keys = this.lvl.rate;
    if (frac <= keys[0][0]) return keys[0][1];
    for (let k = 1; k < keys.length; k++) {
      if (frac <= keys[k][0]) {
        const [f0, r0] = keys[k - 1], [f1, r1] = keys[k];
        return r0 + (r1 - r0) * ((frac - f0) / (f1 - f0));
      }
    }
    return keys[keys.length - 1][1];
  }

  // Advance the script. Returns 'win' the frame the truck passes the gate.
  update(dt, truckPos) {
    if (!this.active) return null;
    const L = this.lvl;
    this.t += dt;
    const frac = Math.min(1, this.t / L.duration);

    // Spawner pressure: keyframed base, surge windows override upward AND swell
    // the whole-horde speed so the wall visibly rushes the truck.
    let rate = this._rateAt(frac);
    let speedMul = 1;
    for (const s of L.surges) {
      if (this.t >= s.at && this.t < s.at + s.len) {
        rate = Math.max(rate, s.rate);
        speedMul = Math.max(speedMul, s.speedMult || 1);
      }
    }
    CONFIG.spawner.rate = rate;
    CONFIG.horde.speedMul = speedMul;

    // Boss cues — one or more staggered spawns (ascending times; all share the
    // level's hp/speed set in start()). The gate holds while ANY of them lives.
    const { boss } = this.deps;
    if (L.boss) {
      while (this._bossFired < L.boss.spawns.length && this.t >= L.boss.spawns[this._bossFired]) {
        boss.spawn(truckPos);
        this._bossFired++;
      }
    }

    // The gate: appears gateLead seconds out, held back while a boss lives.
    // (If the boss outlives the timer the run simply continues until the kill.)
    const lead = CONFIG.levels.gateLead;
    if (!this.gateUp && this.t >= L.duration - lead && !boss.aliveCount) {
      this.gateUp = true;
      this.gateZ = truckPos.z - CONFIG.truck.speed * lead;
      this._buildGate(this.gateZ);
    }
    if (this.gateUp && truckPos.z <= this.gateZ) return 'win';
    return null;
  }

  progress() {
    return this.active ? Math.min(1, this.t / this.lvl.duration) : 0;
  }

  // Status line for the level bar: urgency reads at a glance. Sets noteDanger so
  // main can colour a surge/threat warning red (the safe-zone note stays green).
  note() {
    if (!this.active) { this.noteDanger = false; return ''; }
    if (this.gateUp) { this.noteDanger = false; return 'SAFE ZONE AHEAD — GO!'; }
    if (this._bossFired > 0 && this.deps.boss.aliveCount && this.t >= this.lvl.duration - CONFIG.levels.gateLead) {
      this.noteDanger = false;
      return this.deps.boss.aliveCount > 1
        ? 'THE GATE HOLDS WHILE THE PACK LIVES'
        : 'THE GATE HOLDS WHILE THE BEAST LIVES';
    }
    // Surge cue: a live warning while the horde swells, and a short heads-up first.
    for (const s of this.lvl.surges) {
      if (this.t >= s.at && this.t < s.at + s.len) { this.noteDanger = true; return '⚠  HORDE SURGE  ⚠'; }
      if (this.t >= s.at - CONFIG.levels.surgeWarn && this.t < s.at) { this.noteDanger = true; return 'SURGE INCOMING'; }
    }
    this.noteDanger = false;
    return '';
  }

  // ---- Safe-zone gate mesh ---------------------------------------------------
  // A fortified checkpoint spanning the road: concrete pylons, steel crossbeam,
  // green all-clear panel. Same flat-Lambert language as the world props.
  _buildGate(z) {
    const g = new THREE.Group();
    const mat = (hex) => new THREE.MeshLambertMaterial({ color: hex });
    const box = (w, h, d, x, y, zz, m) => {
      const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
      b.position.set(x, y, zz);
      g.add(b);
      return b;
    };
    const concrete = mat(0x9a9384);
    const steel = mat(0x5a6670);
    const green = new THREE.MeshLambertMaterial({ color: 0x35c04a, emissive: 0x0d4014 });

    // Pylons on the shoulders, crossbeam over the road, panel hung beneath it
    box(1.8, 7.5, 1.8, -6, 3.75, 0, concrete);
    box(1.8, 7.5, 1.8, 6, 3.75, 0, concrete);
    box(14.4, 0.9, 1.2, 0, 7.2, 0, steel);
    box(9.5, 1.6, 0.3, 0, 5.9, 0, green);
    // Angled barricade wings funneling traffic into the gate
    const wingL = box(5, 1.4, 0.8, -8.6, 0.7, 1.6, concrete);
    wingL.rotation.y = 0.5;
    const wingR = box(5, 1.4, 0.8, 8.6, 0.7, 1.6, concrete);
    wingR.rotation.y = -0.5;
    // Beacon lights on the pylon tops
    box(0.5, 0.5, 0.5, -6, 7.9, 0, green);
    box(0.5, 0.5, 0.5, 6, 7.9, 0, green);

    g.position.set(0, 0, z);
    this.scene.add(g);
    this.gate = g;
  }

  _removeGate() {
    if (!this.gate) return;
    this.scene.remove(this.gate);
    this.gate.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) o.material.dispose();
    });
    this.gate = null;
    this.gateUp = false;
  }
}
