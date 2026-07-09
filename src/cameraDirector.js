import { CONFIG } from './config.js';

// v1.1 — mid-fight camera shifts. At unpredictable intervals (never faster
// than CONFIG.camShift.minInterval) the follow rig swings to a different
// preset: a new angle, height, and framing of the same rear chase. Because
// the hitscan raycasts from the MAIN camera through the crosshair, a shift
// genuinely changes the field of fire — leading targets feels different from
// each side — without touching the aiming code at all.
//
// Mechanically this just TWEENS the CONFIG.camera fields the follow rig
// already reads every frame (eased here, then the rig's own damping smooths
// the tail), so followCamera.js needed zero changes. Every preset keeps the
// camera beside/above the truck LOOKING BACK at the pursuit — you can always
// see what's chasing you.

const PRESETS = [
  // The approved default rig (right three-quarter) — index 0 matches config.js.
  { name: 'right ¾',    fov: 55, offsetX: 16,  offsetY: 12,   offsetZ: -9,  lookX: 0, lookZ: 18 },
  { name: 'left ¾',     fov: 55, offsetX: -16, offsetY: 12,   offsetZ: -9,  lookX: 0, lookZ: 18 },
  { name: 'high rear',  fov: 58, offsetX: 4,   offsetY: 17,   offsetZ: -13, lookX: 0, lookZ: 26 },
  { name: 'low right',  fov: 52, offsetX: 13,  offsetY: 6.5,  offsetZ: -7,  lookX: 0, lookZ: 14 },
  { name: 'wide left',  fov: 60, offsetX: -19, offsetY: 10,   offsetZ: -5,  lookX: 0, lookZ: 20 },
];

const FIELDS = ['fov', 'offsetX', 'offsetY', 'offsetZ', 'lookX', 'lookZ'];

export class CameraDirector {
  constructor(cameraDefaults) {
    this.defaults = cameraDefaults; // pristine CONFIG.camera snapshot (main owns it)
    this.enabled = false;
    this._preset = 0;               // current preset index (0 = the default rig)
    this._timer = this._roll();
    this._tween = null;             // { from, to, t, dur } while a swing is in flight
  }

  _roll() {
    const c = CONFIG.camShift;
    return Math.max(30, c.minInterval) + Math.random() * c.maxExtra;
  }

  setEnabled(on) {
    this.enabled = !!on;
    if (on) this._timer = this._roll(); // full interval before the first shift
  }

  // Cancel any in-flight swing and put the rig back on the default preset.
  // Used on level start/stop and by the GUI's "Reset camera".
  reset() {
    this._tween = null;
    this._preset = 0;
    this._timer = this._roll();
    Object.assign(CONFIG.camera, this.defaults);
  }

  // Swing to a random preset that isn't the current one.
  shiftNow() {
    let next = this._preset;
    while (next === this._preset) next = Math.floor(Math.random() * PRESETS.length);
    this._preset = next;
    const from = {}, to = PRESETS[next];
    for (const f of FIELDS) from[f] = CONFIG.camera[f];
    this._tween = { from, to, t: 0, dur: Math.max(0.2, CONFIG.camShift.tweenTime) };
    this._timer = this._roll();
    return to.name;
  }

  update(dt) {
    if (this._tween) {
      const tw = this._tween;
      tw.t += dt;
      const u = Math.min(1, tw.t / tw.dur);
      const e = u * u * (3 - 2 * u); // smoothstep — eases both ends of the swing
      for (const f of FIELDS) CONFIG.camera[f] = tw.from[f] + (tw.to[f] - tw.from[f]) * e;
      if (u >= 1) this._tween = null;
      return;
    }
    if (!this.enabled) return;
    this._timer -= dt;
    if (this._timer <= 0) this.shiftNow();
  }
}
