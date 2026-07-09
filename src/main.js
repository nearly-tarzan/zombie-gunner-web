import * as THREE from 'three';
import GUI from 'lil-gui';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CONFIG } from './config.js';
import { World } from './world.js';
import { Truck } from './truck.js';
import { FollowCamera } from './followCamera.js';
import { Horde } from './horde.js';
import { Gun } from './gun.js';
import { Tracers } from './tracers.js';
import { Mist } from './mist.js';
import { Gibs } from './gibs.js';
import { Corpses } from './corpses.js';
import { Numbers } from './numbers.js';
import { Casings } from './casings.js';
import { Sfx } from './sfx.js';
import { Explosions } from './explosions.js';
import { Powerups } from './powerups.js';
import { Boss } from './boss.js';
import { CameraDirector } from './cameraDirector.js';
import { LevelDirector, LEVELS } from './levels.js';

// Phase 3 — Visceral layer. This IS the product: weapon feel (flash, recoil,
// shake, casings, audio), hit feedback (damage numbers, hit flash, crits),
// gore (mist, gibs, corpses), and the density push. Acceptance is subjective —
// Josh plays and doesn't want to stop — so EVERY feel value is a live knob.

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5)); // integrated-GPU headroom
renderer.autoClear = false; // manual clear for the two-pass overlay render
document.getElementById('app').appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xcfe0ea); // pale desert sky
scene.fog = new THREE.Fog(CONFIG.fog.color, CONFIG.fog.near, CONFIG.fog.far);

// Lighting — flat and cheap, no shadows
const hemi = new THREE.HemisphereLight(0xfff4e0, 0x8a7355, 1.1);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xffeecc, 1.4);
sun.position.set(30, 60, -20);
scene.add(sun);

const world = new World(scene);
const truck = new Truck(scene);
const horde = new Horde(scene);
const followCam = new FollowCamera();
const tracers = new Tracers(scene);   // world-space streaks
const gun = new Gun();                // screen-space overlay (own scene + camera)
const mist = new Mist(scene);         // blood + dust point sprites
const gibs = new Gibs(scene);         // burst-body chunks
const corpses = new Corpses(scene);   // fallen capsules, persist then sink
const numbers = new Numbers(scene);   // floating damage digits
const casings = new Casings(gun.scene); // shells eject in the overlay scene
const sfx = new Sfx();                // layered gunshot audio (samples or synth)
const explosions = new Explosions(scene); // Phase 4: fireballs + shock rings
// Phase 4 powerups. Explosions are routed through explode() (below) so the
// force-gib path and camera shake live in one place — the tank cannon's splash,
// the rocket, and mines all call it.
const powerups = new Powerups(scene, horde, { explode, burstKills, sfx, gun, mist });
// Phase 5 — the colossal boss. A plain-Mesh raycast target (like crates) so its
// bounds ride its own world matrix; main owns its combat FX + the death blast.
const boss = new Boss(scene);

// Snapshot the pristine camera config before the GUI can mutate it, so the
// "Reset camera" button can restore the defaults after live tinkering.
const CAMERA_DEFAULTS = { ...CONFIG.camera };
// v1.1 — mid-fight camera shifts (unpredictable, never faster than 30s apart)
// and the level director (scripted 2-minute runs; win = reach the gate alive).
const camDir = new CameraDirector(CAMERA_DEFAULTS);
const levels = new LevelDirector(scene, { horde, boss, powerups, truck, camDir });

// ---- Input: mouse crosshair + hold-to-fire --------------------------------
const crosshairEl = document.getElementById('crosshair');
const crosshairNDC = new THREE.Vector2(0, 0); // starts screen-center
let firing = false;
let gameOver = false; // set when a boss reaches the truck and smashes it (one hit)
let levelWon = false; // v1.1: truck passed the safe-zone gate — freeze under the win card

// ---- Photo mode (Phase 6 art verification) ---------------------------------
// Freezes the fight (no contact damage, no game-overs, no firing), parks the
// boss at CONFIG.photo.bossDist, and hands the main camera to OrbitControls so
// screenshots stop fighting the live sim. Toggled from the GUI or __game.
let orbit = null;
function setPhotoMode(on) {
  on = !!on;
  if (CONFIG.photo.enabled === on) return;
  CONFIG.photo.enabled = on;
  firing = false;
  if (on) {
    orbit = new OrbitControls(followCam.camera, renderer.domElement);
    const b = boss.bosses.find((b) => !b.dying);
    if (b) orbit.target.set(b.x, b.H * 0.5, b.z);
    else orbit.target.set(truck.position.x, 2, truck.position.z + 25);
    crosshairEl.style.display = 'none';
  } else {
    if (orbit) { orbit.dispose(); orbit = null; }
    // hand the (possibly flown-away) camera back to the follow rig smoothly
    followCam.currentPos.copy(followCam.camera.position);
    crosshairEl.style.display = '';
  }
}

window.addEventListener('mousemove', (e) => {
  crosshairNDC.x = (e.clientX / window.innerWidth) * 2 - 1;
  crosshairNDC.y = -(e.clientY / window.innerHeight) * 2 + 1;
  crosshairEl.style.transform = `translate(${e.clientX}px, ${e.clientY}px) translate(-50%, -50%)`;
});
// Fire only from the canvas (so clicking the debug panel doesn't shoot).
// First click also unlocks the AudioContext (browser autoplay policy).
renderer.domElement.addEventListener('mousedown', (e) => {
  if (e.button === 0 && !gameOver && !levelWon && !CONFIG.photo.enabled) { firing = true; sfx.init(); }
});
window.addEventListener('mouseup', (e) => { if (e.button === 0) firing = false; });
window.addEventListener('blur', () => { firing = false; });
renderer.domElement.addEventListener('contextmenu', (e) => e.preventDefault());

// ---- Game over -------------------------------------------------------------
// Two lose conditions: a boss reaching the truck (one-hit smash), OR the truck's
// HP draining to zero under sustained zombie contact. Either way the sim freezes
// on the last frame, a red overlay drops, and R / click restarts.
const gameoverEl = document.getElementById('gameover');
const gameoverSub = gameoverEl.querySelector('.go-sub');
const GAMEOVER_MSG = {
  smash: 'The boss smashed the convoy.',
  overrun: 'The horde overran the convoy.',
};
function triggerGameOver(reason = 'smash') {
  if (gameOver) return;
  gameOver = true;
  firing = false;
  truck.hp = 0;                 // the convoy is wrecked
  gameoverSub.textContent = GAMEOVER_MSG[reason] || GAMEOVER_MSG.smash;
  sfx.init(); sfx.boom(true);   // final crunch
  gameoverEl.classList.add('show');
}
function restart() {
  gameOver = false;
  gameoverEl.classList.remove('show');
  if (levels.active) { startLevel(levels.index); return; } // retry the level from the top
  boss.clear();                 // clear the giant that smashed you
  truck.resetHp();
  kills = 0;                    // fresh run
}
gameoverEl.addEventListener('click', restart);
window.addEventListener('keydown', (e) => { if ((e.key === 'r' || e.key === 'R') && gameOver) restart(); });

// ---- v1.1: menu / levels / win flow -----------------------------------------
// Boot lands on the menu (level select + sandbox). A level is a scripted run —
// the LevelDirector drives the sandbox knobs; winning (passing the gate) drops
// the RUN COMPLETE card with next/replay/menu. Losing uses the existing game
// over, and R retries the level. M returns to the menu from anywhere.
const menuEl = document.getElementById('menu');
const winEl = document.getElementById('wincard');
const winSub = winEl.querySelector('.w-sub');
const winNextBtn = document.getElementById('win-next');
const levelbarEl = document.getElementById('levelbar');
const lbName = levelbarEl.querySelector('.lb-name');
const lbFill = levelbarEl.querySelector('.lb-fill');
const lbNote = levelbarEl.querySelector('.lb-note');

function clearOverlays() {
  menuEl.classList.remove('show');
  winEl.classList.remove('show');
  gameoverEl.classList.remove('show');
  gameOver = false;
  levelWon = false;
  firing = false;
  crosshairEl.style.display = '';
}

function startLevel(i) {
  clearOverlays();
  kills = 0;
  levels.start(i);
  lbName.textContent = `LEVEL ${LEVELS[i].id} — ${LEVELS[i].name}`;
  levelbarEl.style.display = 'block';
  sfx.init();
}

function toSandbox() {
  setPhotoMode(false); // leaving for menu/sandbox always hands the camera back
  clearOverlays();
  levels.stop();
  levelbarEl.style.display = 'none';
  boss.clear();
  truck.resetHp();
  kills = 0;
}

function toMenu() {
  toSandbox(); // sandbox state idles behind the menu as the attract screen
  menuEl.classList.add('show');
  crosshairEl.style.display = 'none';
}

function triggerWin() {
  if (levelWon || gameOver) return;
  levelWon = true;
  firing = false;
  winSub.textContent = `${levels.lvl.name} cleared — the convoy made it.`;
  winNextBtn.style.display = levels.index + 1 < LEVELS.length ? '' : 'none';
  winEl.classList.add('show');
  crosshairEl.style.display = 'none';
  sfx.init(); sfx.pickup();
}

// Build the level buttons from LEVELS so adding a level needs no HTML edit —
// the menu, the GUI dropdown, and win-card chaining all read the same array.
const menuLevelsEl = document.getElementById('menu-levels');
LEVELS.forEach((L, i) => {
  const btn = document.createElement('button');
  btn.className = 'm-btn';
  btn.textContent = `LEVEL ${L.id} — ${L.name}`;
  btn.addEventListener('click', () => startLevel(i));
  menuLevelsEl.appendChild(btn);
});
document.getElementById('menu-sandbox').addEventListener('click', toSandbox);
winNextBtn.addEventListener('click', () => startLevel(levels.index + 1));
document.getElementById('win-replay').addEventListener('click', () => startLevel(levels.index));
document.getElementById('win-menu').addEventListener('click', toMenu);
window.addEventListener('keydown', (e) => {
  if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return; // GUI typing
  if (e.key === 'm' || e.key === 'M') toMenu();
});
crosshairEl.style.display = 'none'; // boot shows the menu; crosshair returns on start

// ---- Hitscan ---------------------------------------------------------------
const _rayC = new THREE.Raycaster();   // crosshair -> world, for hits
const _rayM = new THREE.Raycaster();   // screen-bottom -> world, for the muzzle
const _muzzleNDC = new THREE.Vector2(CONFIG.gun.muzzleNDCx, CONFIG.gun.muzzleNDCy);
const _muzzleWorld = new THREE.Vector3();
const _endTmp = new THREE.Vector3();
const _groundTmp = new THREE.Vector3();

let kills = 0;
let fireCooldown = 0;

// The tracer's world origin: bottom-center NDC unprojected a fixed distance in
// front of the main camera — so streaks appear to leave the overlay gun's barrel.
function computeMuzzle() {
  _rayM.setFromCamera(_muzzleNDC, followCam.camera);
  return _rayM.ray.at(CONFIG.gun.muzzleDist, _muzzleWorld);
}

// Where the crosshair ray meets the ground plane (y = 0), or null
function groundPoint(ray, out) {
  if (Math.abs(ray.direction.y) < 1e-6) return null;
  const t = -ray.origin.y / ray.direction.y;
  if (t <= 0 || t > CONFIG.gun.range) return null;
  return ray.at(t, out);
}

// Resolve the hitscan endpoint for a given NDC: nearest of {live zombie, powerup
// crate, boss} under the crosshair, else the ground under it, else the max-range
// point. Nearest wins, checked zombie→crate→boss so a zombie in front of a crate
// (or the boss) eats the bullet on a tie.
function resolveEndpoint(ndc, out) {
  _rayC.setFromCamera(ndc, followCam.camera);
  const zHit = horde.hit(_rayC);
  const cHit = CONFIG.powerups.enabled ? powerups.raycast(_rayC) : null;
  const bHit = boss.activeCount ? boss.raycast(_rayC) : null;

  let kind = null, dist = Infinity, pt = null, data = null;
  if (zHit && zHit.distance < dist) { kind = 'zombie'; dist = zHit.distance; pt = zHit.point; data = zHit.instanceId; }
  if (cHit && cHit.distance < dist) { kind = 'crate'; dist = cHit.distance; pt = cHit.point; data = cHit.crate; }
  if (bHit && bHit.distance < dist) { kind = 'boss'; dist = bHit.distance; pt = bHit.point; data = bHit.boss; }

  if (kind === 'zombie') { out.copy(pt); return { end: out, instanceId: data, kind }; }
  if (kind === 'crate') { out.copy(pt); return { end: out, instanceId: null, kind, crate: data }; }
  if (kind === 'boss') { out.copy(pt); return { end: out, instanceId: null, kind, boss: data }; }

  const g = groundPoint(_rayC.ray, _groundTmp);
  if (g) { out.copy(g); return { end: out, instanceId: null, kind: 'ground' }; }
  _rayC.ray.at(CONFIG.gun.range, out);
  return { end: out, instanceId: null, kind: 'range' };
}

// Radial blast at a world point: damage the horde in-radius, then burst FX.
// Explosions ALWAYS gib (force-gib path — no crit roll), per the Phase 4 spec.
// Everything explosive (tank splash, rocket, mines) funnels through here so the
// gib/shake/audio behaviour is identical wherever a blast comes from.
const _expP = new THREE.Vector3();
const _expDir = new THREE.Vector3();
// Force-gib a kill list from any AoE source (blast or the spike drum), bursting
// gibs/mist/numbers away from (cx,cz). Kept separate from explode() so the
// rolling drum can crush continuously WITHOUT a fireball every frame.
function burstKills(killList, cx, cz, dmg) {
  for (const k of killList) {
    kills++;
    const ky = 0.8 * k.scale;
    if (CONFIG.gore.enabled) {
      gibs.spawn(k.x, ky, k.z, k.tint); // force gib — every AoE kill bursts, no roll
      _expDir.set(k.x - cx, 0.4, k.z - cz).normalize();
      _expP.set(k.x, ky, k.z);
      mist.blood(_expP, _expDir, CONFIG.gore.mistGib);
    }
    if (CONFIG.numbers.enabled) {
      _expP.set(k.x, ky, k.z);
      numbers.spawn(_expP, dmg, true, followCam.camera); // gold, reads as a big hit
    }
  }
  return killList.length;
}
function explode(x, y, z, radius, dmg, opts = {}) {
  const killList = horde.areaDamage(x, z, radius, dmg);
  burstKills(killList, x, z, dmg);
  explosions.spawn(x, Math.max(y, 1), z, radius);
  if (CONFIG.gore.enabled) { _expP.set(x, 0.1, z); mist.dust(_expP); }
  if (CONFIG.shake.enabled) followCam.addTrauma(opts.trauma ?? CONFIG.powerups.explosion.trauma);
  sfx.boom(opts.big);
  return killList.length;
}

// Boss (Phase 5): a bullet/splash hit rains a damage number, mists blood, and
// hit-flashes the giant; the killing blow detonates a huge force-gib blast that
// clears the surrounding horde and topples the body — routed through the same
// explode() so the death is identical wherever the final hit came from.
function hitBoss(b, dmg, point, crit) {
  const res = boss.damage(b, dmg);
  if (!res) return;
  if (CONFIG.numbers.enabled) numbers.spawn(point, dmg, crit, followCam.camera);
  if (CONFIG.gore.enabled) mist.blood(point, _rayC.ray.direction, crit ? CONFIG.gore.mistPerHit + 3 : CONFIG.gore.mistPerHit);
  if (res.killed) killBoss(b);
}
function killBoss(b) {
  const cx = b.x, cz = b.z;
  // explode() clears the nearby horde + fireball + shake + boom (force-gib path)
  explode(cx, b.H * 0.4, cz, CONFIG.boss.deathRadius, CONFIG.boss.deathDamage, { trauma: 1.0, big: true });
  if (CONFIG.gore.enabled) {
    for (let k = 0; k < 24; k++) { // a shower of pale gibs off the toppling giant
      const gx = cx + (Math.random() - 0.5) * b.H * 0.5;
      const gz = cz + (Math.random() - 0.5) * b.H * 0.5;
      const gy = 0.5 + Math.random() * b.H * 0.9;
      gibs.spawn(gx, gy, gz, boss.gibTint);
    }
  }
}

function fireOne() {
  const tank = CONFIG.powerups.enabled && powerups.weapon.mode === 'tank';
  const r = resolveEndpoint(crosshairNDC, _endTmp);
  const dir = _rayC.ray.direction; // still valid from resolveEndpoint

  // Powerup crate: any weapon decrements its countdown (the "shoot the number").
  if (r.kind === 'crate') {
    powerups.hitCrate(r.crate);
    tracers.spawn(computeMuzzle(), r.end);
    gun.kick(tank);
    casings.eject();
    if (CONFIG.shake.enabled) followCam.addTrauma(CONFIG.shake.perShot);
    if (tank) sfx.boom(false); else sfx.shoot();
    return;
  }

  // Tank cannon: the shell detonates at its impact point — splash + force-gib.
  if (tank) {
    explode(_endTmp.x, _endTmp.y, _endTmp.z,
      CONFIG.powerups.tank.splashRadius, CONFIG.powerups.tank.splashDamage,
      { trauma: 0.9, big: true });
    // A cannon shell that lands on the boss also drives its splash into the giant.
    if (r.kind === 'boss') hitBoss(r.boss, CONFIG.powerups.tank.splashDamage, _endTmp, true);
    tracers.spawn(computeMuzzle(), r.end);
    gun.kick(true);
    casings.eject();
    return; // explode() already boomed + shook
  }

  const crit = Math.random() < CONFIG.crit.chance;
  const dmg = CONFIG.gun.damage * (crit ? CONFIG.crit.multiplier : 1);

  if (r.kind === 'boss') {
    hitBoss(r.boss, dmg, _endTmp, crit);
  } else if (r.instanceId != null) {
    const res = horde.damage(r.instanceId, dmg);
    if (res) {
      if (CONFIG.numbers.enabled) numbers.spawn(_endTmp, dmg, crit, followCam.camera);
      if (CONFIG.gore.enabled) mist.blood(_endTmp, dir, crit ? CONFIG.gore.mistPerHit + 3 : CONFIG.gore.mistPerHit);
      if (res.killed) {
        kills++;
        // Death spot survives in the arrays until the spawner reuses the slot
        const zx = horde.x[r.instanceId], zz = horde.z[r.instanceId];
        const zs = horde.scale[r.instanceId];
        const tint = horde.tintHexOf(r.instanceId);
        const gib = crit || res.overkill >= CONFIG.zombie.hp * CONFIG.gore.gibOverkillFrac;
        if (CONFIG.gore.enabled && gib) {
          gibs.spawn(zx, 0.8 * zs, zz, tint);
          mist.blood(_endTmp, dir, CONFIG.gore.mistGib);
          sfx.gib();
        } else if (CONFIG.gore.enabled) {
          const yaw = Math.atan2(truck.position.x - zx, truck.position.z - zz);
          corpses.spawn(zx, zz, zs, tint, yaw);
          mist.blood(_endTmp, dir, CONFIG.gore.mistKill);
        }
      }
    }
  } else if (r.kind === 'ground' && CONFIG.gore.enabled) {
    mist.dust(_endTmp); // missed shots still land somewhere — sells the aim
  }

  tracers.spawn(computeMuzzle(), r.end);
  gun.kick(crit);
  casings.eject();
  if (CONFIG.shake.enabled) followCam.addTrauma(CONFIG.shake.perShot);
  sfx.shoot();
}

// ---- Debug panel -----------------------------------------------------------
const gui = new GUI({ title: 'Phase 5 Debug' });
const hordeCtl = { count: CONFIG.horde.count };
gui.add(hordeCtl, 'count', 0, CONFIG.horde.maxCount, 10).name('Zombie cap').onChange((v) => horde.setCount(v));
gui.add(CONFIG.spawner, 'rate', CONFIG.spawner.min, CONFIG.spawner.max, 1).name('Spawn rate/s');
gui.add(CONFIG.truck, 'speed', 0, 20, 0.5).name('Truck speed');
gui.add(CONFIG.horde, 'convergeFar', 8, 60, 1).name('Converge dist'); // wall → beeline handoff
gui.add(CONFIG.horde, 'obstacleSteer').name('Clutter steering'); // horde splits around boulders/wrecks

const combat = gui.addFolder('Combat');
combat.add(CONFIG.gun, 'fireRate', 1, 30, 1).name('Fire rate/s');
combat.add(CONFIG.gun, 'damage', 5, 200, 1).name('Damage');
combat.add(CONFIG.zombie, 'hp', 10, 500, 10).name('Zombie HP');
combat.add(CONFIG.combat, 'contactDamage', 0, 40, 1).name('Contact dmg');
combat.add({ reset: () => truck.resetHp() }, 'reset').name('Reset truck HP');
combat.close();

// Phase 3 — the feel knobs. Tuned live with Josh playing.
const feel = gui.addFolder('Feel (Phase 3)');
feel.add(CONFIG.crit, 'chance', 0, 1, 0.01).name('Crit chance');
feel.add(CONFIG.crit, 'multiplier', 1, 5, 0.1).name('Crit damage ×');
feel.add(CONFIG.shake, 'enabled').name('Screen shake');
feel.add(CONFIG.shake, 'perShot', 0, 0.5, 0.01).name('Shake / shot');
feel.add(CONFIG.shake, 'amplitude', 0, 1, 0.01).name('Shake amp');
feel.add(CONFIG.numbers, 'enabled').name('Damage numbers');
feel.add(CONFIG.numbers, 'scale', 0.3, 2.5, 0.05).name('Number size');
feel.add(CONFIG.gore, 'enabled').name('Gore');
feel.add(CONFIG.gore, 'mistPerHit', 0, 16, 1).name('Mist / hit');
feel.add(CONFIG.gore, 'gibOverkillFrac', 0, 2, 0.05).name('Gib overkill ≥');
feel.add(CONFIG.gore, 'corpseLife', 0, 15, 0.5).name('Corpse life (s)');
feel.add(CONFIG.audio, 'enabled').name('Audio');
feel.add(CONFIG.audio, 'volume', 0, 1, 0.05).name('Volume').onChange((v) => sfx.setVolume(v));

// Phase 4 — powerups. All five effects live; the auto-spawner rolls a random
// one. The dropdown + button spawns a crate carrying a chosen effect on demand.
const pw = gui.addFolder('Powerups (Phase 4)');
const pwDbg = { effect: 'random' };
pw.add(CONFIG.powerups, 'enabled').name('Spawn crates');
pw.add(CONFIG.powerups, 'spawnRate', 0, 1, 0.01).name('Crate rate/s');
pw.add(CONFIG.powerups, 'startCount', 1, 20, 1).name('Hits to crack');
pw.add(CONFIG.powerups, 'loseDist', 20, 100, 1).name('Lose distance');
pw.add(pwDbg, 'effect', ['random', 'tank', 'rocket', 'mines', 'wall', 'spikes']).name('Spawn effect');
pw.add({ spawn: () => powerups.spawnCrate(pwDbg.effect) }, 'spawn').name('Spawn crate now');
pw.add({ give: () => powerups._giveTankGun() }, 'give').name('Give tank gun');
// Weapon switcher (Phase 5 sandbox control): hold the tank gun on indefinitely,
// or drop back to the MG. Distinct from the timed crate pickup.
const weap = { mode: 'mg' };
pw.add(weap, 'mode', ['mg', 'tank']).name('Weapon').onChange((v) => {
  if (v === 'tank') { powerups._giveTankGun(); powerups.weapon.timeLeft = Infinity; }
  else powerups._endTankGun();
});
const tk = pw.addFolder('Tank gun');
tk.add(CONFIG.powerups.tank, 'duration', 2, 20, 1).name('Duration (s)');
tk.add(CONFIG.powerups.tank, 'fireRate', 1, 8, 0.5).name('Fire rate/s');
tk.add(CONFIG.powerups.tank, 'splashRadius', 1, 12, 0.5).name('Splash radius');
tk.add(CONFIG.powerups.tank, 'splashDamage', 20, 300, 10).name('Splash damage');
tk.close();
const ef = pw.addFolder('Effect knobs');
ef.add(CONFIG.powerups.rocket, 'radius', 3, 18, 0.5).name('Rocket radius');
ef.add(CONFIG.powerups.rocket, 'damage', 50, 500, 10).name('Rocket damage');
ef.add(CONFIG.powerups.rocket, 'targetNear', 12, 70, 1).name('Rocket target ≤relZ');
ef.add(CONFIG.powerups.mines, 'count', 1, 24, 1).name('Mine count');
ef.add(CONFIG.powerups.mines, 'spreadX', 8, 40, 1).name('Mine spread X');
ef.add(CONFIG.powerups.mines, 'blastRadius', 1, 8, 0.5).name('Mine radius');
ef.add(CONFIG.powerups.wall, 'width', 6, 34, 1).name('Wall width');
ef.add(CONFIG.powerups.wall, 'crushDps', 0, 400, 10).name('Wall crush dps');
ef.add(CONFIG.powerups.wall, 'life', 3, 20, 1).name('Wall life (s)');
ef.add(CONFIG.powerups.spikes, 'width', 6, 34, 1).name('Spikes width');
ef.add(CONFIG.powerups.spikes, 'duration', 0.5, 5, 0.5).name('Spikes time (s)');
ef.add(CONFIG.powerups.spikes, 'dps', 100, 900, 25).name('Spikes crush dps');
ef.close();
pw.close();

// Phase 5 — the colossal boss. Spawn on command; it rises deep in the horde,
// towers over it, and advances slowly on the truck (the ad's money shot).
const bossF = gui.addFolder('Boss (Phase 5)');
bossF.add({ spawn: () => boss.spawn(truck.position) }, 'spawn').name('Spawn boss');
bossF.add({ clear: () => boss.clear() }, 'clear').name('Clear bosses');
bossF.add(CONFIG.boss, 'hp', 500, 20000, 100).name('Boss HP');
bossF.add(CONFIG.boss, 'height', 8, 40, 1).name('Boss height');
bossF.add(CONFIG.boss, 'speed', 0, 12, 0.5).name('Boss speed');
bossF.add(CONFIG.boss, 'smashDist', 2, 20, 0.5).name('Smash range');
// Warp a boss right onto the truck to feel the game-over smash without waiting.
bossF.add({ smash: () => { const b = boss.spawn(truck.position); if (b) { b.rising = 0; b.z = truck.position.z + 1; b.x = truck.position.x; } } }, 'smash').name('Boss smash now');
bossF.add({ restart: () => restart() }, 'restart').name('Restart run');
bossF.close();

// Phase 6 — photo mode: art shots without fighting the live sim.
const ph = gui.addFolder('Photo mode');
const phCtl = { on: false };
ph.add(phCtl, 'on').name('Photo mode').onChange(setPhotoMode);
ph.add(CONFIG.photo, 'bossDist', 10, 120, 1).name('Boss distance');
ph.add(CONFIG.photo, 'freezeHorde').name('Freeze horde');
ph.add({ spawn: () => boss.spawn(truck.position) }, 'spawn').name('Spawn boss');
ph.close();

// v1.1 — levels + camera shifts. Start/abort runs from the panel, tune the
// shift cadence (min interval floor 30s per design), and force a shift to
// preview a preset swing without waiting out the timer.
const lv = gui.addFolder('Levels (v1.1)');
const lvCtl = { level: 0 };
lv.add(lvCtl, 'level', Object.fromEntries(LEVELS.map((l, i) => [`Level ${l.id} — ${l.name}`, i]))).name('Level');
lv.add({ start: () => startLevel(lvCtl.level) }, 'start').name('Start level');
lv.add({ win: () => { if (levels.active) triggerWin(); } }, 'win').name('Win now (test)');
lv.add({ menu: () => toMenu() }, 'menu').name('Back to menu');
const cs = lv.addFolder('Camera shifts');
cs.add(CONFIG.camShift, 'sandbox').name('Shifts in sandbox').onChange((v) => { if (!levels.active) camDir.setEnabled(v); });
cs.add(CONFIG.camShift, 'minInterval', 30, 120, 1).name('Min interval (s)');
cs.add(CONFIG.camShift, 'maxExtra', 0, 60, 1).name('+ random (s)');
cs.add(CONFIG.camShift, 'tweenTime', 0.5, 4, 0.1).name('Swing time (s)');
cs.add({ shift: () => camDir.shiftNow() }, 'shift').name('Shift now');
cs.close();
lv.close();

const cam = gui.addFolder('Camera');
cam.add(CONFIG.camera, 'fov', 40, 90, 1);
cam.add(CONFIG.camera, 'offsetX', -20, 20, 0.25).name('Side');
cam.add(CONFIG.camera, 'offsetY', 3, 20, 0.25).name('Height');
cam.add(CONFIG.camera, 'offsetZ', -20, 20, 0.25).name('Ahead/behind');
cam.add(CONFIG.camera, 'lookX', -15, 15, 0.5).name('Look side');
cam.add(CONFIG.camera, 'lookZ', -30, 40, 1).name('Look back');
cam.add(CONFIG.camera, 'damping', 1, 10, 0.25);
// Restore the default camera rig after live tinkering, and refresh the sliders.
// Goes through camDir so an in-flight shift tween is cancelled too.
cam.add({ reset: () => {
  camDir.reset();
  cam.controllers.forEach((c) => c.updateDisplay());
} }, 'reset').name('Reset camera');
cam.close();

// ---- HUD -------------------------------------------------------------------
const hud = document.getElementById('hud');
let fpsAccum = 0, fpsFrames = 0, fps = 0;

// Console/automation handle
window.__game = {
  horde, truck, tracers, gun, CONFIG, world,
  mist, gibs, corpses, numbers, casings, sfx, followCam,
  explosions, powerups, boss,
  spawnCrate: (eff) => powerups.spawnCrate(eff),
  giveTank: () => powerups._giveTankGun(),
  fireEffect: (name) => (powerups._effects[name] || powerups._effects.tank)(),
  spawnBoss: () => boss.spawn(truck.position),
  clearBosses: () => boss.clear(),
  smashNow: () => { const b = boss.spawn(truck.position); if (b) { b.rising = 0; b.z = truck.position.z + 1; b.x = truck.position.x; } },
  restart: () => restart(),
  isGameOver: () => gameOver,
  // Photo mode (Phase 6): toggle, then aim the free camera from automation.
  setPhotoMode,
  photoCam: (px, py, pz, tx, ty, tz) => {
    if (!CONFIG.photo.enabled || !orbit) return false;
    followCam.camera.position.set(px, py, pz);
    orbit.target.set(tx, ty, tz);
    orbit.update();
    return true;
  },
  explode, burstKills,
  // v1.1 — levels + camera shifts
  levels, camDir, LEVELS,
  startLevel, toMenu, toSandbox,
  winNow: () => { if (levels.active) triggerWin(); },
  shiftCam: () => camDir.shiftNow(),
  isLevelWon: () => levelWon,
  getFps: () => fps,
  getKills: () => kills,
  setFiring: (b) => { firing = !!b; },
  setCrosshair: (nx, ny) => { crosshairNDC.set(nx, ny); },
  // Acceptance probe: resolve the endpoint for an NDC and re-project it. If the
  // returned ndc matches the input (within FP epsilon) at every depth, tracers
  // land where the crosshair points. Returns hit type + depth for inspection.
  aimTest(nx, ny) {
    const ndc = new THREE.Vector2(nx, ny);
    const out = new THREE.Vector3();
    const r = resolveEndpoint(ndc, out);
    const proj = out.clone().project(followCam.camera);
    return {
      hit: r.instanceId != null ? 'zombie' : 'world',
      instanceId: r.instanceId,
      end: { x: +out.x.toFixed(3), y: +out.y.toFixed(3), z: +out.z.toFixed(3) },
      cameraDist: +followCam.camera.position.distanceTo(out).toFixed(2),
      reprojNDC: { x: +proj.x.toFixed(5), y: +proj.y.toFixed(5) },
      ndcError: +Math.hypot(proj.x - nx, proj.y - ny).toExponential(2),
    };
  },
};

const clock = new THREE.Clock();

function loop() {
  requestAnimationFrame(loop);
  const dt = Math.min(clock.getDelta(), 0.05); // clamp tab-switch spikes

  // Frozen on game over or a level win — the last frame holds under the
  // overlay; we keep rendering (below) but stop advancing the world.
  if (!gameOver && !levelWon) {
    const photo = CONFIG.photo.enabled; // art-shot mode: truck parked, fight frozen
    if (!photo) truck.update(dt);
    world.update(truck.position.z);
    if (!photo || !CONFIG.photo.freezeHorde) horde.update(dt, truck.position, world.obstacles);
    if (!photo) {
      truck.takeDamage(horde.contactCount * CONFIG.combat.contactDamage); // zombie contact drains truck HP
      if (truck.hp <= 0) triggerGameOver('overrun'); // horde drained the HP bar — run over
      // v1.1 — level script (spawn curve, surges, boss cue, gate) + camera
      // shifts. Both run before the camera update so the frame is consistent.
      const ev = levels.update(dt, truck.position);
      if (ev === 'win') triggerWin();
      camDir.update(dt);
    }

    // Camera before firing so the crosshair->world ray matches the rendered frame
    if (photo) { if (orbit) orbit.update(); }
    else followCam.update(dt, truck.position);
    if (!photo) powerups.update(dt, truck.position); // spawn/recede crates, run the tank timer
    boss.update(dt, truck.position);     // advance/topple the giant; refresh its bounds
    if (!photo && boss.smashThisFrame) triggerGameOver('smash'); // a boss reached the truck — one hit ends the run

    // Hold-to-fire cadence (guarded so a long frame can't spiral). The tank
    // cannon fires slower than the MG, so the cadence knob depends on the mode.
    const tankNow = CONFIG.powerups.enabled && powerups.weapon.mode === 'tank';
    fireCooldown -= dt;
    if (firing) {
      let guard = 0;
      const step = 1 / (tankNow ? CONFIG.powerups.tank.fireRate : CONFIG.gun.fireRate);
      while (fireCooldown <= 0 && guard < 12) { fireOne(); fireCooldown += step; guard++; }
    } else if (fireCooldown < 0) {
      fireCooldown = 0;
    }

    tracers.update(dt);
    gun.update(dt, truck.position.y, crosshairNDC);

    // Phase 3 FX pools. Point-sprite systems need pixels-per-world-unit so
    // gl_PointSize tracks the drawing buffer and the live fov knob.
    const pxPerUnit = renderer.domElement.height * 0.5 /
      Math.tan(THREE.MathUtils.degToRad(followCam.camera.fov) * 0.5);
    mist.update(dt, pxPerUnit);
    numbers.update(dt, pxPerUnit);
    gibs.update(dt);
    corpses.update(dt, truck.position.z);
    casings.update(dt);
    explosions.update(dt);
  }

  // v1.1 — level progress bar (fill + urgency note track the run every frame)
  if (levels.active) {
    lbFill.style.width = `${(levels.progress() * 100).toFixed(1)}%`;
    lbNote.textContent = levels.note();
    lbNote.classList.toggle('danger', levels.noteDanger); // red pulse on surge warnings
  }

  // Two-pass render: world, then the gun overlay on a cleared depth buffer
  // (overlay skipped in photo mode — art shots want the world only)
  renderer.clear();
  renderer.render(scene, followCam.camera);
  if (!CONFIG.photo.enabled) {
    renderer.clearDepth();
    renderer.render(gun.scene, gun.camera);
  }

  fpsAccum += dt; fpsFrames++;
  if (fpsAccum >= 0.5) {
    fps = Math.round(fpsFrames / fpsAccum);
    fpsAccum = 0; fpsFrames = 0;
    hud.textContent =
      `FPS ${fps}\n` +
      `Zombies ${horde.aliveCount}/${horde.activeCount}\n` +
      `Truck HP ${Math.round(truck.hp)}\n` +
      `Kills ${kills}\n` +
      `${powerups.hudLine()}\n` +
      (boss.aliveCount ? `BOSS ×${boss.aliveCount}  HP ${boss.totalHp()}\n` : '') +
      (gameOver ? `GAME OVER — R / click to retry`
        : levelWon ? `RUN COMPLETE`
        : levels.active ? `Level ${levels.lvl.id} — ${levels.lvl.name}`
        : `Sandbox — M for menu`);
  }
}

window.addEventListener('resize', () => {
  renderer.setSize(window.innerWidth, window.innerHeight);
  followCam.resize();
  gun.resize();
});

loop();
