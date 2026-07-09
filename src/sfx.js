import { CONFIG } from './config.js';

// Layered gunshot audio. Primary path: CC0 samples from /sfx/ (shot0..shot3,
// any of .ogg/.wav/.mp3 — whichever files exist load; 404s are ignored). Every
// shot picks a random sample with pitch/gain jitter plus a synthesized
// mechanical tick so full-auto never sounds like a looped recording.
// Fallback: if NO samples load, the whole shot is synthesized (crack + thump
// + tick) — the game is never silent just because assets are missing.
//
// The AudioContext is created on the first user gesture (browser autoplay
// policy) — main.js calls init() on the first mousedown.

const SAMPLE_TRIES = ['shot0', 'shot1', 'shot2', 'shot3'];
const EXTS = ['ogg', 'wav', 'mp3'];

export class Sfx {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.shots = [];      // decoded AudioBuffers
    this._noise = null;   // cached noise buffer for synth layers
  }

  init() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return;
    }
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    this.master = this.ctx.createGain();
    this.master.gain.value = CONFIG.audio.volume;
    this.master.connect(this.ctx.destination);

    // Shared noise buffer (1s) for synth crack/tick layers
    const len = this.ctx.sampleRate;
    this._noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const data = this._noise.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;

    this._loadSamples();
  }

  setVolume(v) {
    if (this.master) this.master.gain.value = v;
  }

  async _loadSamples() {
    for (const name of SAMPLE_TRIES) {
      for (const ext of EXTS) {
        try {
          const res = await fetch(`sfx/${name}.${ext}`);
          if (!res.ok) continue;
          const buf = await this.ctx.decodeAudioData(await res.arrayBuffer());
          this.shots.push(buf);
          break; // got this slot — next name
        } catch { /* missing/undecodable — try next ext */ }
      }
    }
    console.log(`[sfx] gunshot samples loaded: ${this.shots.length}` +
      (this.shots.length ? '' : ' — using synth fallback'));
  }

  _env(gainNode, t0, peak, decay) {
    const g = gainNode.gain;
    g.setValueAtTime(0.0001, t0);
    g.exponentialRampToValueAtTime(peak, t0 + 0.004);
    g.exponentialRampToValueAtTime(0.0001, t0 + decay);
  }

  // Short filtered-noise burst — used for the synth crack and the mech tick
  _noiseBurst(t0, { peak, decay, type, freq, q = 1 }) {
    const src = this.ctx.createBufferSource();
    src.buffer = this._noise;
    src.playbackRate.value = 0.9 + Math.random() * 0.2;
    const filt = this.ctx.createBiquadFilter();
    filt.type = type;
    filt.frequency.value = freq;
    filt.Q.value = q;
    const g = this.ctx.createGain();
    this._env(g, t0, peak, decay);
    src.connect(filt).connect(g).connect(this.master);
    src.start(t0, Math.random() * 0.5); // random offset into the noise buffer
    src.stop(t0 + decay + 0.05);
  }

  _thump(t0) {
    const osc = this.ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(105 + Math.random() * 15, t0);
    osc.frequency.exponentialRampToValueAtTime(48, t0 + 0.09);
    const g = this.ctx.createGain();
    this._env(g, t0, 0.5, 0.11);
    osc.connect(g).connect(this.master);
    osc.start(t0);
    osc.stop(t0 + 0.15);
  }

  shoot() {
    if (!this.ctx || !CONFIG.audio.enabled) return;
    const t0 = this.ctx.currentTime;
    if (this.shots.length) {
      const src = this.ctx.createBufferSource();
      src.buffer = this.shots[(Math.random() * this.shots.length) | 0];
      src.playbackRate.value = 0.92 + Math.random() * 0.16;
      const g = this.ctx.createGain();
      g.gain.value = 0.55 + Math.random() * 0.2;
      src.connect(g).connect(this.master);
      src.start(t0);
      // mech tick layered over the sample keeps full-auto alive
      this._noiseBurst(t0, { peak: 0.12, decay: 0.02, type: 'highpass', freq: 5200 });
    } else {
      // Full synth shot: crack + body + thump + tick
      this._noiseBurst(t0, { peak: 0.65, decay: 0.05, type: 'bandpass', freq: 2400, q: 0.9 });
      this._noiseBurst(t0, { peak: 0.4, decay: 0.12, type: 'lowpass', freq: 420 });
      this._thump(t0);
      this._noiseBurst(t0, { peak: 0.15, decay: 0.018, type: 'highpass', freq: 5500 });
    }
  }

  // Wet burst for a gibbed body
  gib() {
    if (!this.ctx || !CONFIG.audio.enabled) return;
    const t0 = this.ctx.currentTime;
    this._noiseBurst(t0, { peak: 0.5, decay: 0.16, type: 'lowpass', freq: 300 });
    this._noiseBurst(t0 + 0.02, { peak: 0.25, decay: 0.1, type: 'bandpass', freq: 900, q: 2 });
  }

  // ---- Phase 4 -------------------------------------------------------------
  // Explosion — a deep sub thump + a wide noise body. `big` widens/deepens it
  // (rocket vs. cannon splash).
  boom(big = false) {
    if (!this.ctx || !CONFIG.audio.enabled) return;
    const t0 = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(big ? 150 : 120, t0);
    osc.frequency.exponentialRampToValueAtTime(big ? 32 : 45, t0 + (big ? 0.4 : 0.28));
    const g = this.ctx.createGain();
    this._env(g, t0, big ? 0.85 : 0.6, big ? 0.5 : 0.34);
    osc.connect(g).connect(this.master);
    osc.start(t0);
    osc.stop(t0 + (big ? 0.6 : 0.42));
    this._noiseBurst(t0, { peak: big ? 0.6 : 0.42, decay: big ? 0.34 : 0.22, type: 'lowpass', freq: big ? 700 : 900 });
    this._noiseBurst(t0 + 0.01, { peak: 0.3, decay: 0.14, type: 'bandpass', freq: 1600, q: 0.7 });
  }

  // Metallic ping when a bullet chips a powerup crate
  crateHit() {
    if (!this.ctx || !CONFIG.audio.enabled) return;
    const t0 = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    osc.type = 'square';
    osc.frequency.setValueAtTime(1400 + Math.random() * 400, t0);
    osc.frequency.exponentialRampToValueAtTime(700, t0 + 0.05);
    const g = this.ctx.createGain();
    this._env(g, t0, 0.16, 0.06);
    osc.connect(g).connect(this.master);
    osc.start(t0);
    osc.stop(t0 + 0.08);
    this._noiseBurst(t0, { peak: 0.1, decay: 0.03, type: 'highpass', freq: 6000 });
  }

  // Rising chime when a crate cracks and its effect fires — the "jackpot" cue
  pickup() {
    if (!this.ctx || !CONFIG.audio.enabled) return;
    const t0 = this.ctx.currentTime;
    for (let k = 0; k < 3; k++) {
      const osc = this.ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.value = 440 * Math.pow(1.5, k); // stacked fifths, rising
      const g = this.ctx.createGain();
      this._env(g, t0 + k * 0.05, 0.24, 0.22);
      osc.connect(g).connect(this.master);
      osc.start(t0 + k * 0.05);
      osc.stop(t0 + k * 0.05 + 0.3);
    }
  }

  // Descending airy hiss for an incoming rocket
  whoosh() {
    if (!this.ctx || !CONFIG.audio.enabled) return;
    const t0 = this.ctx.currentTime;
    const src = this.ctx.createBufferSource();
    src.buffer = this._noise;
    const filt = this.ctx.createBiquadFilter();
    filt.type = 'bandpass';
    filt.frequency.setValueAtTime(2600, t0);
    filt.frequency.exponentialRampToValueAtTime(600, t0 + 0.55); // pitch-falls in
    filt.Q.value = 1.3;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(0.32, t0 + 0.25);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.6);
    src.connect(filt).connect(g).connect(this.master);
    src.start(t0, Math.random() * 0.5);
    src.stop(t0 + 0.65);
  }
}
