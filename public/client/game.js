// TANKFALL — client-side world: entity interpolation, local prediction,
// camera, particles, and the render loop. The client never invents outcomes:
// it predicts its own movement, draws everything else from server snapshots,
// and reacts to server events for hits, kills and destruction.

import {
  NET, TANK, FLAGS, POWERUP_INFO, ROOM_STATE,
  clamp, angleDiff, dist,
} from '/shared/constants.js';
import { CollisionWorld, createTankState, stepTank, raycastObstacles } from '/shared/physics.js';
import { generateMap } from '/shared/mapgen.js';
import { Renderer, screenToWorld } from './render.js';

const MAX_PARTICLES = 620;
const MAX_SNAPSHOTS = 26;
const AIM_ASSIST_RANGE = 720;

export class ClientGame {
  constructor({ canvas, minimap, input, net, audio, hud, renderer }) {
    this.canvas = canvas;
    this.minimapCanvas = minimap;
    this.renderer = renderer || new Renderer(canvas);
    this.input = input;
    this.net = net;
    this.audio = audio;
    this.hud = hud;

    this.phase = 'IDLE';
    this.stateCode = 0;
    this.map = null;
    this.world = null;
    this.me = null;
    this.players = new Map();   // playerId -> { id, name, color }
    this.tankNames = new Map(); // tankId -> { name, color }
    this.snaps = [];
    this.pred = null;
    this.correction = { x: 0, y: 0 };
    this.particles = [];
    this.scorch = [];
    this.damageNumbers = [];
    this.localFireCd = 0;
    this.spectateIndex = 0;
    this.spectateTarget = 0;
    this.freeCam = { x: 1200, y: 900 };
    this.cam = { x: 1200, y: 900, scale: 1, shake: 0 };
    this.time = 0;
    this.inputAcc = 0;
    this.flushAcc = 0;
    this.aimWorld = { x: 0, y: 0 };
    this.autoAimId = 0;
    this.lastSnapshotAt = 0;
    this.snapInterval = 1000 / 30;
    this.hitFlash = 0;
    this.myFlags = 0;
    this.myHp = 100;
    this.myEnergy = 100;
    this.shotsFired = 0;
    this.kills = 0;
    this.streak = 0;
    this._raf = null;
    this._lastFrame = 0;
    this._fpsAcc = 0;
    this._fpsFrames = 0;
    this.fps = 60;
    this.paused = false;
  }

  /* ------------------------------------------------------------------ *
   * Match lifecycle
   * ------------------------------------------------------------------ */
  startMatch({ seed, you, players }) {
    this.seed = seed;
    this.me = you;
    this.map = generateMap(seed);
    this.world = new CollisionWorld(this.map);
    this.renderer.setMap(this.map);
    this.renderer.initMinimapBase();
    this.players = new Map();
    this.tankNames = new Map();
    for (const p of players) {
      this.players.set(p.playerId, p);
      this.tankNames.set(p.tankId, p);
    }
    if (this.me) {
      const meta = this.tankNames.get(this.me.tankId);
      if (meta) this.me.name = meta.name;
    }
    const spawnTank = this.map.spawns.find((s) => s.name === you?.spawn);
    const start = spawnTank || { x: this.map.w / 2, y: this.map.h / 2 };
    this.pred = createTankState(start.x, start.y, 0);
    this.pred.turret = 0;
    this.correction.x = 0;
    this.correction.y = 0;
    this.snaps = [];
    this.particles = [];
    this.scorch = [];
    this.damageNumbers = [];
    this.cam.x = start.x;
    this.cam.y = start.y;
    this.freeCam = { x: start.x, y: start.y };
    this.time = 0;
    this.kills = 0;
    this.shotsFired = 0;
    this.streak = 0;
    this.phase = 'PLAYING';
    this.updateCameraScale();
  }

  applySync(msg) {
    if (!this.map) {
      this.seed = msg.seed;
      this.map = generateMap(msg.seed);
      this.world = new CollisionWorld(this.map);
      this.renderer.setMap(this.map);
      this.renderer.initMinimapBase();
      if (this.me) {
        const spawnTank = this.map.spawns.find((s) => s.name === this.me.spawn);
        if (spawnTank) this.pred = createTankState(spawnTank.x, spawnTank.y, 0);
      }
    }
    for (const id of msg.destroyed || []) {
      const o = this.renderer.byId.get(id);
      if (o) { o.destroyed = true; this.renderer.markDestroyed(id); }
    }
    this.snaps = [];
    this.phase = msg.state === ROOM_STATE.FINISHED ? 'FINISHED' : 'PLAYING';
  }

  endMatch(event) {
    this.phase = 'FINISHED';
    this.input.setEnabled(false);
    this.audio.updateEngine(0, 1);
    this.audio.stopAmbience();
    const winnerId = event.winnerId;
    if (winnerId && this.me && winnerId === this.me.playerId) this.audio.victory();
    else this.audio.defeat();
    if (event.results && event.results.length && this.me) {
      const mine = event.results.find((r) => r.playerId === this.me.playerId);
      if (mine) { this.kills = mine.kills; this.shotsFired = mine.shots; }
    }
  }

  resetToLobby() {
    this.audio.updateEngine(0, 1);
    this.phase = 'IDLE';
    this.snaps = [];
    this.map = null;
    this.world = null;
    this.pred = null;
    this.particles = [];
    this.fireList = [];
    this.audio.stopAmbience();
    this.input.setEnabled(false);
  }

  /* ------------------------------------------------------------------ *
   * Snapshots
   * ------------------------------------------------------------------ */
  onSnapshot(snap) {
    const now = performance.now();
    if (this.lastSnapshotAt) {
      const dt = now - this.lastSnapshotAt;
      if (dt > 0 && dt < 400) this.snapInterval = this.snapInterval * 0.85 + dt * 0.15;
    }
    this.lastSnapshotAt = now;
    this.stateCode = snap.stateCode;
    this.snaps.push({
      t: now,
      tanks: snap.tanks.map((t) => ({ ...t })),
      bullets: snap.bullets.map((b) => ({ ...b })),
      pickups: snap.pickups.map((p) => ({ ...p })),
      zone: { ...snap.zone },
      winnerId: snap.winnerId,
    });
    if (this.snaps.length > MAX_SNAPSHOTS) this.snaps.shift();

    // Reconcile own position against authority.
    if (this.me && this.pred) {
      const auth = snap.tanks.find((t) => t.id === this.me.tankId);
      if (auth) {
        const errX = auth.x - (this.pred.x + this.correction.x);
        const errY = auth.y - (this.pred.y + this.correction.y);
        const err = Math.hypot(errX, errY);
        if (err > 140) {
          // Too far off (lag spike / teleport): hard snap.
          this.pred.x = auth.x; this.pred.y = auth.y;
          this.pred.vx = auth.vx; this.pred.vy = auth.vy;
          this.correction.x = 0; this.correction.y = 0;
        } else {
          const k = clamp(0.14 + err / 400, 0.14, 0.5);
          this.correction.x += errX * k;
          this.correction.y += errY * k;
        }
      }
    }
  }

  /** Interpolated view of the world at (now - interpolation delay). */
  sample(renderTime) {
    const snaps = this.snaps;
    if (!snaps.length) return null;
    if (this.phase === 'FINISHED') {
      // Freeze on the final authoritative frame — nothing to predict any more.
      const last = snaps[snaps.length - 1];
      return { tanks: last.tanks.map((t) => ({ ...t })), bullets: [], pickups: last.pickups.map((p) => ({ ...p })), zone: { ...last.zone }, winnerId: last.winnerId };
    }
    if (snaps.length === 1) {
      const s = snaps[0];
      return { tanks: s.tanks, bullets: s.bullets, pickups: s.pickups, zone: s.zone, winnerId: s.winnerId };
    }
    let i = snaps.length - 1;
    while (i > 0 && snaps[i].t > renderTime) i--;
    const a = snaps[i];
    const b = snaps[Math.min(i + 1, snaps.length - 1)];
    // alpha = how far renderTime sits between snapshot a and snapshot b.
    let alpha = b.t > a.t ? (renderTime - a.t) / (b.t - a.t) : 0;
    alpha = clamp(alpha, 0, 1);
    // When renderTime is already past the newest snapshot (packet jitter) we
    // extend a little beyond b, capped at one snapshot interval.
    const ahead = renderTime > b.t ? clamp((renderTime - b.t) / Math.max(1, b.t - a.t), 0, 1) : 0;
    // Interpolate with alpha and extrapolate with ahead. (Using only `ahead`
    // here — as this did before — snapped every remote entity to the newest
    // snapshot, freezing them for two frames and then teleporting them.)
    const k = alpha + ahead;

    const lerpList = (listA, listB) => {
      const res = [];
      const mapA = new Map(listA.map((e) => [e.id, e]));
      for (const eb of listB) {
        const ea = mapA.get(eb.id);
        if (!ea) { res.push({ ...eb }); continue; }
        const o = { ...eb };
        const k = alpha + ahead;
        o.x = ea.x + (eb.x - ea.x) * k;
        o.y = ea.y + (eb.y - ea.y) * k;
        o.angle = ea.angle + angleDiff(ea.angle, eb.angle) * k;
        o.turret = ea.turret + angleDiff(ea.turret, eb.turret) * k;
        res.push(o);
      }
      return res;
    };

    return {
      tanks: lerpList(a.tanks, b.tanks),
      bullets: lerpList(a.bullets, b.bullets),
      pickups: b.pickups.map((p) => ({ ...p })),
      zone: { ...b.zone },
      winnerId: b.winnerId,
    };
  }

  /* ------------------------------------------------------------------ *
   * Server events → local feedback
   * ------------------------------------------------------------------ */
  onEvents(events) {
    for (const e of events) {
      switch (e.k) {
        case 'shoot': {
          this.spawnMuzzle(e.x, e.y, e.a, e.mega);
          if (e.id === this.me?.tankId) {
            this.shotsFired++;
            this.audio.cannon(!!e.mega);
            this.cam.shake = Math.max(this.cam.shake, e.mega ? 7 : 4);
            this.localFireCd = e.mega ? TANK.megaReload : TANK.reload;
          } else if (this.nearMe(e.x, e.y, 1400)) {
            this.audio.cannon(!!e.mega);
          }
          break;
        }
        case 'impact': {
          this.spawnImpact(e.x, e.y, e.mega);
          if (this.nearMe(e.x, e.y, 900)) this.audio.hitArmor();
          break;
        }
        case 'hit': {
          this.spawnHit(e.x, e.y, e.amount);
          if (e.id === this.me?.tankId) {
            this.hitFlash = 1;
            this.cam.shake = Math.max(this.cam.shake, 6);
            this.hud.damageFlash(clamp(e.amount / 45, 0.25, 1));
            this.pushDamageNumber(e.x, e.y - 14, `-${e.amount}`, '#ff6b5e');
          } else if (this.nearMe(e.x, e.y, 700)) {
            this.pushDamageNumber(e.x, e.y - 14, `-${e.amount}`, '#ffd23f');
          }
          if (this.nearMe(e.x, e.y, 1100)) this.audio.hitPlayer();
          break;
        }
        case 'shield': {
          this.pushDamageNumber(e.x, e.y - 26, 'BLOCKED', '#6ec6ff');
          break;
        }
        case 'boom': {
          this.spawnExplosion(e.x, e.y, e.kind === 'tank' ? 1.25 : e.kind === 'barrel' ? 1 : 0.55, e.color);
          this.scorch.push({ x: e.x, y: e.y, r: (e.r || 90) * 0.9, age: 0 });
          if (this.scorch.length > 70) this.scorch.shift();
          const d = this.me ? dist(this.meTankX(), this.meTankY(), e.x, e.y) : 9999;
          this.cam.shake = Math.max(this.cam.shake, clamp(26 - d / 60, 0, 26));
          if (d < 2200) this.audio.explosion(e.kind === 'tank' ? 1.15 : 0.85);
          break;
        }
        case 'destroy': {
          const o = this.renderer.byId.get(e.id);
          if (o) { o.destroyed = true; this.renderer.markDestroyed(e.id); }
          if (e.s === 'circle') this.spawnDust(e.x, e.y, e.r, o?.material);
          else this.spawnDust(e.x, e.y, Math.max(e.w, e.h) * 0.5, o?.material);
          const cx = e.s === 'circle' ? e.x : e.x + 0;
          this.scorch.push({ x: cx, y: e.y, r: 46, age: 0 });
          if (this.scorch.length > 70) this.scorch.shift();
          if (this.nearMe(e.x, e.y, 900)) this.audio.debris();
          break;
        }
        case 'pickup': {
          if (!this.map) break;
          this.spawnPickupBurst(e.x, e.y, e.kind);
          this.audio.pickup(e.kind);
          if (e.id === this.me?.tankId) {
            const info = POWERUP_INFO[e.kind];
            this.hud.banner(`${info?.icon || ''} ${info?.label || e.kind}`, '#ffd23f', 1200);
          }
          break;
        }
        case 'spawnPU': break;
        case 'kill': {
          this.hud.killFeed(e);
          this.pushDamageNumber(e.x, e.y - 40, '💥', '#fff');
          if (e.killerId && this.me && e.killerId === this.me.playerId) {
            this.streak++;
            this.audio.victory();
            this.hud.banner('ELIMINATED!', '#ffd23f', 900);
          } else if (e.victimId === this.me?.playerId) {
            this.hud.banner('TANK DESTROYED', '#ff5252', 2200);
            this.audio.explosion(1.2);
            this.input.setEnabled(false);
            this.spectateIndex = 0;
            this.spectateTarget = 0;
            this.diedAt = performance.now();
            this.audio.updateEngine(0, 1);
            // Only enter spectator mode while the battle is still running.
            if (this.phase === 'PLAYING') {
              this.spectating = true;
              this.hud.banner('SPECTATING — TAP NEXT TO CYCLE', '#8fa3c8', 2000);
            }
          }
          break;
        }
        case 'zone': this.hud.banner('⚠ BATTLE ZONE SHRINKING', '#ff8a5c', 2200); this.audio.zoneWarn(); break;
        case 'zoneShrink': this.audio.zoneWarn(); break;
        case 'zoneTick': if (e.id === this.me?.tankId) this.hud.damageFlash(0.5); break;
        case 'count':
          this.audio.countdown(e.n);
          this.hud.showCountdown(String(e.n));
          break;
        case 'countdownStart':
          this.audio.countdown(3);
          break;
        case 'countdownCancel':
          this.hud.toast(e.reason, 'warn');
          break;
        case 'start':
          // Everyone (host and guests) gets the "FIRE!" beat.
          this.hud.showCountdown('FIRE');
          break;
        case 'end': this.endMatch(e); break;
        case 'rename': {
          if (e.byHost) this.hud.toast(`✏️ ${e.from} → ${e.to}`, 'fun');
          if (this.me && e.id === this.me.playerId) this.me.name = e.to;
          const t = this.tankNames.get(e.id);
          if (t) t.name = e.to;
          this.hud.setSelfName?.(e.id === this.me?.playerId ? e.to : null);
          break;
        }
        case 'notice': this.hud.notice(e.text); break;
        case 'join': this.hud.notice(`🎉 ${e.name} joined the battle`); break;
        case 'leave': this.hud.notice(`🚪 ${e.name} left the battle`); break;
        case 'ready': this.hud.notice(e.value ? `✅ ${e.name} is ready` : `⏳ ${e.name} is not ready`); break;
        default: break;
      }
    }
  }

  nearMe(x, y, range) {
    if (!this.pred) return false;
    return dist(this.pred.x, this.pred.y, x, y) < range;
  }

  meTankX() { return this.pred ? this.pred.x : this.cam.x; }
  meTankY() { return this.pred ? this.pred.y : this.cam.y; }

  /* ------------------------------------------------------------------ *
   * Particles
   * ------------------------------------------------------------------ */
  pushParticle(p) {
    if (this.particles.length >= MAX_PARTICLES) this.particles.shift();
    this.particles.push(p);
  }

  spawnMuzzle(x, y, angle, mega) {
    this.pushParticle({ type: 'flash', x, y, radius: mega ? 54 : 34, life: 0.12, maxLife: 0.12, color: 'rgba(255,190,80,0.9)', additive: true, size: 1 });
    for (let i = 0; i < (mega ? 10 : 6); i++) {
      const a = angle + (Math.random() - 0.5) * 0.7;
      const sp = 60 + Math.random() * 170;
      this.pushParticle({
        type: 'spark', x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
        life: 0.22 + Math.random() * 0.22, maxLife: 0.34, size: 2 + Math.random() * 2.4,
        color: Math.random() < 0.5 ? '#ffd98a' : '#ff9a3c', additive: true, drag: 3,
      });
    }
    for (let i = 0; i < 3; i++) {
      this.pushParticle({
        type: 'smoke', x: x - Math.cos(angle) * 6, y: y - Math.sin(angle) * 6,
        vx: Math.cos(angle) * 26 + (Math.random() - 0.5) * 30, vy: Math.sin(angle) * 26 + (Math.random() - 0.5) * 30,
        life: 0.5, maxLife: 0.5, size: 7, color: 'rgba(190,185,175,0.5)', drag: 2,
      });
    }
  }

  spawnImpact(x, y, mega) {
    const n = mega ? 14 : 8;
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 40 + Math.random() * 200;
      this.pushParticle({
        type: 'spark', x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
        life: 0.18 + Math.random() * 0.2, maxLife: 0.32, size: 1.6 + Math.random() * 2.2,
        color: '#ffe08a', additive: true, drag: 4,
      });
    }
    this.pushParticle({ type: 'flash', x, y, radius: mega ? 40 : 24, life: 0.1, maxLife: 0.1, color: 'rgba(255,200,120,0.8)', additive: true, size: 1 });
    if (mega) this.spawnExplosion(x, y, 0.55);
  }

  spawnHit(x, y, amount) {
    for (let i = 0; i < 7; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 50 + Math.random() * 150;
      this.pushParticle({
        type: 'spark', x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
        life: 0.2 + Math.random() * 0.2, maxLife: 0.36, size: 1.5 + Math.random() * 2,
        color: '#ffb066', additive: true, drag: 3.4,
      });
    }
  }

  spawnExplosion(x, y, scale = 1, color) {
    this.pushParticle({ type: 'flash', x, y, radius: 92 * scale, life: 0.22, maxLife: 0.22, color: 'rgba(255,150,60,0.95)', additive: true, size: 1 });
    this.pushParticle({ type: 'ring', x, y, radius: 120 * scale, life: 0.5, maxLife: 0.5, size: 12 * scale, color: 'rgba(255,200,120,0.75)', additive: true });
    this.pushParticle({ type: 'ring', x, y, radius: 78 * scale, life: 0.36, maxLife: 0.36, size: 8 * scale, color: 'rgba(255,255,220,0.85)', additive: true });
    for (let i = 0; i < Math.round(22 * scale); i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 70 + Math.random() * 300 * scale;
      this.pushParticle({
        type: 'spark', x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
        life: 0.25 + Math.random() * 0.4, maxLife: 0.6, size: 2 + Math.random() * 3,
        color: Math.random() < 0.5 ? '#ffd166' : '#ff7a29', additive: true, drag: 2.4,
      });
    }
    for (let i = 0; i < Math.round(13 * scale); i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 30 + Math.random() * 110;
      this.pushParticle({
        type: 'smoke', x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
        life: 0.9 + Math.random() * 0.7, maxLife: 1.5, size: 12 + Math.random() * 16,
        color: i % 3 === 0 ? 'rgba(60,60,60,0.5)' : 'rgba(140,135,125,0.42)', drag: 1.1,
      });
    }
    for (let i = 0; i < Math.round(8 * scale); i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 80 + Math.random() * 260;
      this.pushParticle({
        type: 'debris', x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
        life: 0.6 + Math.random() * 0.5, maxLife: 1.1, size: 4 + Math.random() * 6,
        color: color || '#4a4a4a', rot: Math.random() * 6, spin: (Math.random() - 0.5) * 14, drag: 1.6,
      });
    }
  }

  spawnDust(x, y, r, material) {
    const n = clamp(Math.round(r / 6), 4, 16);
    const col = material === 'woodCrate' ? 'rgba(150,110,70,0.55)'
      : material === 'tree' ? 'rgba(70,110,60,0.55)'
        : material === 'barrel' ? 'rgba(90,60,50,0.5)' : 'rgba(160,158,150,0.5)';
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 25 + Math.random() * 130;
      this.pushParticle({
        type: 'smoke', x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
        life: 0.5 + Math.random() * 0.5, maxLife: 1, size: 7 + Math.random() * 11,
        color: col, drag: 1.5,
      });
    }
  }

  spawnPickupBurst(x, y, kind) {
    const info = POWERUP_INFO[kind] || POWERUP_INFO.repair;
    for (let i = 0; i < 14; i++) {
      const a = (i / 14) * Math.PI * 2;
      const sp = 70 + Math.random() * 90;
      this.pushParticle({
        type: 'spark', x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 40,
        life: 0.4 + Math.random() * 0.3, maxLife: 0.7, size: 2.6,
        color: info.color, additive: true, drag: 2.2,
      });
    }
    this.pushParticle({ type: 'ring', x, y, radius: 70, life: 0.4, maxLife: 0.4, size: 6, color: info.color, additive: true });
  }

  pushDamageNumber(x, y, text, color) {
    this.damageNumbers.push({ x, y, text, color, life: 0.95, maxLife: 0.95 });
    if (this.damageNumbers.length > 26) this.damageNumbers.shift();
  }

  /* ------------------------------------------------------------------ *
   * Frame
   * ------------------------------------------------------------------ */
  start() {
    if (this._raf) return;
    this._lastFrame = performance.now();
    const loop = (now) => {
      this._raf = requestAnimationFrame(loop);
      let dt = (now - this._lastFrame) / 1000;
      this._lastFrame = now;
      if (dt > 0.1) dt = 0.1;
      if (dt <= 0) return;
      this._fpsAcc += dt; this._fpsFrames++;
      if (this._fpsAcc > 0.5) { this.fps = Math.round(this._fpsFrames / this._fpsAcc); this._fpsAcc = 0; this._fpsFrames = 0; }
      if (!this.paused) this.frame(dt);
    };
    this._raf = requestAnimationFrame(loop);
  }

  stop() {
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = null;
  }

  frame(dt) {
    this.time += dt * 1000;
    if (this.phase === 'IDLE' || !this.map) return;
    const playing = this.phase === 'PLAYING';
    const view = this.sample(performance.now() - NET.interpMs) || { tanks: [], bullets: [], pickups: [], zone: null };

    if (playing) this.stepInput(dt, view);
    const tanks = this.buildTanks(view);
    const frame = { tanks, bullets: view.bullets, pickups: view.pickups, zone: view.zone, winnerId: view.winnerId };
    this.updateEffects(dt);
    this.updateCamera(dt, frame);
    this.draw(frame);
    this.updateHud(frame, dt);
  }

  /* ------------------------------------------------------------------ *
   * Input + prediction
   * ------------------------------------------------------------------ */
  stepInput(dt, view) {
    const meId = this.me ? this.me.tankId : 0;
    const alive = this.aliveIds(view);
    // No tank of our own (late join / destroyed) → spectate. Before the first
    // snapshot arrives we simply do not know the world yet.
    const hasTank = !!this.pred && !!meId;
    const spectating = !hasTank || (view.tanks.length > 0 && !alive.includes(meId));
    this.spectating = spectating;
    if (spectating) return;

    const move = this.input.movement();
    let aimAngle = this.pred.turret;

    if (this.input.mouse.active && !this.input.usingTouch) {
      this.aimWorld = screenToWorld(this.input.mouse.x, this.input.mouse.y, this.cam, this.renderer.width, this.renderer.height);
      aimAngle = Math.atan2(this.aimWorld.y - this.pred.y, this.aimWorld.x - this.pred.x);
      this.autoAimId = 0;
    } else {
      const target = this.pickAutoAim(view, meId);
      if (target) {
        // Small lead so shells meet moving tanks.
        const flight = dist(this.pred.x, this.pred.y, target.x, target.y) / TANK.bulletSpeed;
        const tx = target.x + (target.vx || 0) * flight;
        const ty = target.y + (target.vy || 0) * flight;
        aimAngle = Math.atan2(ty - this.pred.y, tx - this.pred.x);
        this.autoAimId = target.id;
        this.aimWorld = { x: tx, y: ty };
      } else {
        this.autoAimId = 0;
        this.aimWorld = {
          x: this.pred.x + Math.cos(this.pred.turret) * 240,
          y: this.pred.y + Math.sin(this.pred.turret) * 240,
        };
        if (move.x || move.y) aimAngle = Math.atan2(move.y, move.x);
      }
    }

    const boost = this.input.wantsBoost();
    const wantsBoost = boost && (this.myEnergy === undefined || this.myEnergy > 1);
    const speedMult = (wantsBoost ? TANK.boostHoldMult : 1) * ((this.myFlags & FLAGS.BOOST) ? TANK.boostMult : 1);
    const fire = this.input.wantsFire();

    stepTank(this.pred, { mx: move.x, my: move.y, turret: aimAngle, boost: wantsBoost }, dt, this.world, speedMult);

    this.localFireCd = Math.max(0, this.localFireCd - dt);
    this.audio.updateEngine(Math.hypot(this.pred.vx, this.pred.vy), TANK.speed * TANK.boostMult);

    // 30 Hz input stream — the server applies exactly one sample per tick.
    this.inputAcc += dt;
    if (this.inputAcc >= 1 / 30) {
      this.inputAcc = 0;
      this.net.queueInput(move.x, move.y, this.pred.turret, fire, boost);
    }
    this.flushAcc += dt;
    if (this.flushAcc >= 1 / 30) {
      this.flushAcc = 0;
      this.net.flushInputs();
    }
  }

  aliveIds(view) {
    const ids = [];
    for (const t of view.tanks) ids.push(t.id);
    return ids;
  }

  pickAutoAim(view, meId) {
    let best = null;
    let bestScore = Infinity;
    for (const t of view.tanks) {
      if (t.id === meId) continue;
      const d = dist(this.pred.x, this.pred.y, t.x, t.y);
      if (d > AIM_ASSIST_RANGE) continue;
      if ((t.flags & FLAGS.CLOAK) && d > 260) continue;
      const a = Math.atan2(t.y - this.pred.y, t.x - this.pred.x);
      const off = Math.abs(angleDiff(this.pred.turret, a));
      const score = d * 0.55 + off * 330;
      if (score < bestScore) { bestScore = score; best = t; }
    }
    return best;
  }

  /* ------------------------------------------------------------------ *
   * Spectating
   * ------------------------------------------------------------------ */
  spectateNext(dir = 1) {
    const view = this.sample(performance.now() - NET.interpMs) || { tanks: [] };
    if (!view.tanks.length) return;
    this.spectateIndex = (this.spectateIndex + dir + view.tanks.length * 4) % view.tanks.length;
    this.spectateTarget = view.tanks[this.spectateIndex].id;
  }

  spectateKeepAlive(view) {
    if (!view.tanks.length) return null;
    if (!this.spectateTarget || !view.tanks.some((t) => t.id === this.spectateTarget)) {
      this.spectateIndex = clamp(this.spectateIndex, 0, view.tanks.length - 1);
      this.spectateTarget = view.tanks[this.spectateIndex].id;
    }
    return view.tanks.find((t) => t.id === this.spectateTarget);
  }

  /* ------------------------------------------------------------------ *
   * Effects + camera
   * ------------------------------------------------------------------ */
  updateEffects(dt) {
    const list = this.particles;
    for (let i = list.length - 1; i >= 0; i--) {
      const p = list[i];
      p.life -= dt;
      if (p.life <= 0) { list.splice(i, 1); continue; }
      if (p.vx !== undefined) {
        const drag = p.drag ? Math.exp(-p.drag * dt) : 1;
        p.vx *= drag; p.vy *= drag;
        p.x += p.vx * dt; p.y += p.vy * dt;
      }
      if (p.spin !== undefined) p.rot = (p.rot || 0) + p.spin * dt;
    }
    for (let i = this.damageNumbers.length - 1; i >= 0; i--) {
      const d = this.damageNumbers[i];
      d.life -= dt;
      if (d.life <= 0) this.damageNumbers.splice(i, 1);
    }
    for (const s of this.scorch) s.age = Math.min(6, s.age + dt);
    this.hitFlash = Math.max(0, this.hitFlash - dt * 2.4);
    this.cam.shake = Math.max(0, this.cam.shake - dt * 26);
  }

  updateCamera(dt, view) {
    if (!this.map || !this.cam) return;
    const cam = this.cam;
    if (this.spectating || !this.pred) {
      const target = this.spectateKeepAlive(view);
      const tx = target ? target.x : (view.zone ? view.zone.cx : this.freeCam.x);
      const ty = target ? target.y : (view.zone ? view.zone.cy : this.freeCam.y);
      const k = 1 - Math.exp(-6 * dt);
      cam.x += (tx - cam.x) * k;
      cam.y += (ty - cam.y) * k;
    } else if (this.pred) {
      const lead = 90;
      const dx = Math.cos(this.pred.turret) * lead;
      const dy = Math.sin(this.pred.turret) * lead;
      const tx = this.pred.x + this.correction.x + dx;
      const ty = this.pred.y + this.correction.y + dy;
      const k = 1 - Math.exp(-10 * dt);
      cam.x += (tx - cam.x) * k;
      cam.y += (ty - cam.y) * k;
    }
    this.updateCameraScale();
    const halfW = this.renderer.width / cam.scale / 2;
    const halfH = this.renderer.height / cam.scale / 2;
    cam.x = clamp(cam.x, Math.min(halfW, this.map.w / 2), Math.max(this.map.w - halfW, this.map.w / 2));
    cam.y = clamp(cam.y, Math.min(halfH, this.map.h / 2), Math.max(this.map.h - halfH, this.map.h / 2));
  }

  updateCameraScale() {
    const w = this.renderer.width || window.innerWidth;
    const h = this.renderer.height || window.innerHeight;
    let scale = Math.min(w / 1020, h / 660);
    if (w < h) scale = Math.max(scale, w / 900);
    this.cam.scale = clamp(scale, 0.42, 1.75);
  }

  /* ------------------------------------------------------------------ *
   * Draw
   * ------------------------------------------------------------------ */
  /** Snapshot tanks + display names/colors + local prediction for our own tank. */
  buildTanks(view) {
    const meId = this.me ? this.me.tankId : 0;
    const tanks = [];
    for (const t of view.tanks) {
      const meta = this.tankNames.get(t.id);
      const entry = {
        ...t,
        name: meta ? meta.name : (t.id === meId ? (this.me?.name || 'YOU') : 'TANK'),
        color: meta ? meta.color : '#cccccc',
      };
      if (t.id === meId && this.pred && !this.spectating) {
        entry.x = this.pred.x + this.correction.x;
        entry.y = this.pred.y + this.correction.y;
        entry.angle = this.pred.angle;
        entry.turret = this.pred.turret;
        entry.hp = this.myHp !== undefined ? this.myHp : t.hp;
        entry.flags = this.myFlags !== undefined ? this.myFlags : t.flags;
      }
      tanks.push(entry);
    }
    return tanks;
  }

  draw(view) {
    const meId = this.me ? this.me.tankId : 0;
    const canHit = this.canHitSomething(view.tanks, meId);
    const player = this.renderer;

    player.render({
      cam: this.cam,
      time: this.time,
      phase: this.phase,
      meId,
      spectating: !!this.spectating,
      tanks: view.tanks,
      bullets: view.bullets,
      pickups: view.pickups,
      particles: this.particles,
      scorch: this.scorch,
      damageNumbers: this.damageNumbers,
      zone: view.zone,
      aimPoint: this.spectating ? null : this.aimWorld,
      canHit,
    });
    player.drawMinimap({
      zone: view.zone,
      tanks: view.tanks,
      pickups: view.pickups,
      cam: this.cam,
    });
  }

  canHitSomething(tanks, meId) {
    if (!this.pred) return false;
    // Cheap line-of-sight test so the crosshair warns when cover is in the way.
    const aim = this.aimWorld;
    if (!aim) return true;
    const a = Math.atan2(aim.y - this.pred.y, aim.x - this.pred.x);
    const len = 900;
    const x0 = this.pred.x + Math.cos(a) * TANK.muzzleOffset;
    const y0 = this.pred.y + Math.sin(a) * TANK.muzzleOffset;
    const x1 = x0 + Math.cos(a) * len;
    const y1 = y0 + Math.sin(a) * len;
    return !this.rayBlocked(x0, y0, x1, y1);
  }

  rayBlocked(x0, y0, x1, y1) {
    if (!this.world) return false;
    return !!raycastObstacles(this.world, x0, y0, x1, y1, 3);
  }

  /* ------------------------------------------------------------------ *
   * HUD
   * ------------------------------------------------------------------ */
  updateHud(view, dt) {
    const me = view.tanks.find((t) => t.id === (this.me ? this.me.tankId : 0));
    if (me) {
      this.myHp = me.hp;
      this.myFlags = me.flags;
      this.myEnergy = me.energy;
    }
    this.hud.update({
      phase: this.phase,
      hp: this.myHp ?? 100,
      energy: this.myEnergy ?? 100,
      tanks: view.tanks,
      zone: view.zone,
      spectating: !!this.spectating,
      spectateId: this.spectateTarget,
      meId: this.me ? this.me.tankId : 0,
      fps: this.fps,
      latency: this.net.latencyMs,
      reload: this.localFireCd,
      streak: this.streak,
      time: this.time,
    });
  }
}

export { Renderer, screenToWorld };
