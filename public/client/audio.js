// TANKFALL — audio engine (WebAudio, no assets, generated on the fly).
// Audio is never required for gameplay: everything here is fire-and-forget and
// degrades to silence if the browser blocks or lacks WebAudio.

export class Audio {
  constructor() {
    this.enabled = false;
    this.ctx = null;
    this.master = null;
    this.sfxGain = null;
    this.noiseBuf = null;
    this.engine = null;
    this.ambience = null;
    this.lastPlay = new Map();
  }

  init() {
    if (this.ctx) return this.ctx;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    try {
      this.ctx = new Ctx();
    } catch {
      return null;
    }
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.9;
    this.master.connect(this.ctx.destination);
    this.sfxGain = this.ctx.createGain();
    this.sfxGain.gain.value = 0.85;
    this.sfxGain.connect(this.master);
    this.noiseBuf = this.makeNoise(1.2);
    this.buildEngine();
    return this.ctx;
  }

  makeNoise(seconds) {
    const ctx = this.ctx;
    const len = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }

  setEnabled(on) {
    this.enabled = !!on;
    if (on) {
      this.init();
      if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
    }
    if (this.master) {
      this.master.gain.setTargetAtTime(this.enabled ? 0.9 : 0, this.ctx.currentTime, 0.05);
    }
    if (this.engine && this.engine.gain) {
      this.engine.gain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.05);
    }
  }

  /* -------------------------------------------------- helpers */
  now() { return this.ctx ? this.ctx.currentTime : 0; }

  throttle(key, ms) {
    const t = performance.now();
    const last = this.lastPlay.get(key) || 0;
    if (t - last < ms) return false;
    this.lastPlay.set(key, t);
    return true;
  }

  tone({ freq = 440, freq2 = null, type = 'sine', dur = 0.2, gain = 0.3, delay = 0, curve = 'exp' }) {
    if (!this.enabled || !this.ctx) return;
    const t0 = this.now() + delay;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (freq2) osc.frequency.exponentialRampToValueAtTime(Math.max(20, freq2), t0 + dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + Math.min(0.02, dur * 0.3));
    if (curve === 'exp') g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    else g.gain.linearRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g).connect(this.sfxGain);
    osc.start(t0);
    osc.stop(t0 + dur + 0.03);
  }

  noise({ dur = 0.3, gain = 0.3, type = 'lowpass', freq = 1200, freq2 = 120, q = 1, delay = 0 }) {
    if (!this.enabled || !this.ctx) return;
    const t0 = this.now() + delay;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const f = this.ctx.createBiquadFilter();
    f.type = type;
    f.frequency.setValueAtTime(freq, t0);
    f.frequency.exponentialRampToValueAtTime(Math.max(40, freq2), t0 + dur);
    f.Q.value = q;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(gain, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(f).connect(g).connect(this.sfxGain);
    src.start(t0, Math.random() * 0.4, dur + 0.05);
  }

  /* -------------------------------------------------- engine hum */
  buildEngine() {
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.value = 48;
    const osc2 = ctx.createOscillator();
    osc2.type = 'square';
    osc2.frequency.value = 96;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 320;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    osc.connect(f); osc2.connect(f);
    f.connect(gain).connect(this.master);
    osc.start(); osc2.start();
    this.engine = { osc, osc2, filter: f, gain };
  }

  updateEngine(speed, maxSpeed) {
    if (!this.engine || !this.ctx) return;
    const k = Math.min(1, speed / Math.max(1, maxSpeed));
    const target = this.enabled ? 0.02 + k * 0.055 : 0;
    this.engine.gain.gain.setTargetAtTime(target, this.now(), 0.08);
    this.engine.filter.frequency.setTargetAtTime(240 + k * 420, this.now(), 0.1);
    this.engine.osc.frequency.setTargetAtTime(40 + k * 34, this.now(), 0.12);
  }

  /* -------------------------------------------------- one-shots */
  startAmbience() {
    if (!this.ctx || this.ambience) return;
    // Very low war-drum pulse to sell "battle in the distance".
    const id = setInterval(() => {
      if (!this.enabled || !this.ctx) return;
      this.tone({ freq: 62, freq2: 30, type: 'sine', dur: 0.28, gain: 0.09 });
      this.noise({ dur: 0.16, gain: 0.05, freq: 220, freq2: 90 });
    }, 1500);
    this.ambience = { id };
  }

  stopAmbience() {
    if (this.ambience) { clearInterval(this.ambience.id); this.ambience = null; }
  }

  cannon(mega = false) {
    if (!this.enabled) return;
    this.noise({ dur: mega ? 0.34 : 0.22, gain: mega ? 0.5 : 0.34, freq: mega ? 900 : 1400, freq2: 90, q: 0.7 });
    this.tone({ freq: mega ? 150 : 220, freq2: 45, type: 'square', dur: 0.16, gain: mega ? 0.3 : 0.18 });
  }

  explosion(scale = 1) {
    if (!this.enabled) return;
    this.noise({ dur: 0.55 * scale, gain: 0.42 * scale, freq: 700, freq2: 50, q: 0.6 });
    this.tone({ freq: 120, freq2: 28, type: 'triangle', dur: 0.45 * scale, gain: 0.25 });
  }

  hitArmor() {
    if (!this.enabled) return;
    if (!this.throttle('armor', 40)) return;
    this.noise({ dur: 0.1, gain: 0.24, type: 'bandpass', freq: 2600, freq2: 900, q: 3 });
    this.tone({ freq: 720, freq2: 300, type: 'square', dur: 0.07, gain: 0.09 });
  }

  hitPlayer() {
    if (!this.enabled) return;
    if (!this.throttle('hitp', 50)) return;
    this.noise({ dur: 0.18, gain: 0.3, freq: 500, freq2: 80 });
    this.tone({ freq: 90, freq2: 40, type: 'sawtooth', dur: 0.18, gain: 0.16 });
  }

  debris() {
    if (!this.enabled) return;
    if (!this.throttle('debris', 60)) return;
    this.noise({ dur: 0.3, gain: 0.22, freq: 1800, freq2: 200, q: 0.9 });
  }

  pickup(kind) {
    if (!this.enabled) return;
    const notes = { mega: [330, 660], shield: [440, 660], repair: [523, 784], boost: [392, 880], cloak: [587, 392] };
    const [a, b] = notes[kind] || [440, 660];
    this.tone({ freq: a, type: 'triangle', dur: 0.1, gain: 0.16 });
    this.tone({ freq: b, type: 'triangle', dur: 0.14, gain: 0.14, delay: 0.08 });
  }

  countdown(n) {
    if (!this.enabled) return;
    this.tone({ freq: n > 0 ? 420 : 880, type: 'square', dur: n > 0 ? 0.14 : 0.4, gain: 0.18 });
    if (n === 0) this.tone({ freq: 1320, type: 'sawtooth', dur: 0.5, gain: 0.12, delay: 0.05 });
  }

  victory() {
    if (!this.enabled) return;
    const seq = [523, 659, 784, 1046];
    seq.forEach((f, i) => this.tone({ freq: f, type: 'triangle', dur: 0.34, gain: 0.2, delay: i * 0.14 }));
  }

  defeat() {
    if (!this.enabled) return;
    const seq = [392, 330, 247];
    seq.forEach((f, i) => this.tone({ freq: f, type: 'sawtooth', dur: 0.34, gain: 0.15, delay: i * 0.16 }));
  }

  ui(up = true) {
    if (!this.enabled) return;
    this.tone({ freq: up ? 520 : 380, type: 'square', dur: 0.06, gain: 0.08 });
  }

  zoneWarn() {
    if (!this.enabled) return;
    if (!this.throttle('zone', 3000)) return;
    this.tone({ freq: 300, freq2: 200, type: 'sawtooth', dur: 0.5, gain: 0.12 });
    this.tone({ freq: 260, freq2: 180, type: 'sawtooth', dur: 0.5, gain: 0.1, delay: 0.5 });
  }
}
