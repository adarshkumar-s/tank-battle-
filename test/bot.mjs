// TANKFALL — test bot: a real WebSocket client that plays the game.
// It reads the same server snapshots a browser would, walks around cover using
// line-of-sight raycasts, and fires when it can actually see a target. Used by
// the end-to-end and headless-client tests to drive real matches.

import { WebSocket } from 'ws';
import { decodeSnapshot } from '../shared/snapshot.js';
import { generateMap } from '../shared/mapgen.js';
import { CollisionWorld, raycastObstacles } from '../shared/physics.js';
import { TANK } from '../shared/constants.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class Bot {
  constructor(name) {
    this.name = name;
    this.msgs = [];
    this.events = [];
    this.snaps = [];
    this.errors = [];
    this.lobbies = [];
    this.seq = 0;
    this.playerId = 0;
    this.token = '';
    this.died = false;
    this.kills = 0;
    this.state = null;
    this.sideSign = 1;
    this.wobble = 0;
    // Cursors ensure a wait only matches messages that arrive for *this* step,
    // never a stale reply from an earlier action.
    this.msgCursor = 0;
    this.eventCursor = 0;
  }

  async connect(port) {
    this.port = port;
    this.ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    this.ws.binaryType = 'arraybuffer';
    await new Promise((resolve, reject) => {
      this.ws.once('open', resolve);
      this.ws.once('error', reject);
    });
    this.ws.on('message', (data, isBinary) => {
      if (isBinary) {
        const buf = data instanceof ArrayBuffer
          ? data
          : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
        const snap = decodeSnapshot(buf);
        if (snap) {
          this.snaps.push(snap);
          if (this.snaps.length > 300) this.snaps.shift();
        }
        return;
      }
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      this.msgs.push(msg);
      switch (msg.t) {
        case 'joined':
          this.playerId = msg.playerId;
          this.token = msg.token;
          this.code = msg.code;
          this.state = msg.state;
          break;
        case 'lobby':
          this.lobby = msg.room;
          this.lobbies.push(msg.room);
          this.state = msg.room.state;
          if (this.lobbies.length > 60) this.lobbies.shift();
          break;
        case 'match':
          this.match = msg;
          this.map = generateMap(msg.seed);
          this.world = new CollisionWorld(this.map);
          break;
        case 'sync':
          this.sync = msg;
          break;
        case 'error':
          this.errors.push(msg);
          break;
        case 'events':
          this.events.push(...msg.e);
          for (const e of msg.e) {
            if (e.k === 'end') this.result = e;
            if (e.k === 'kill') {
              if (e.victimId === this.playerId) this.died = true;
              if (e.killerId === this.playerId) this.kills++;
            }
          }
          if (this.events.length > 900) {
            const dropped = this.events.splice(0, 400).length;
            this.eventCursor = Math.max(0, this.eventCursor - dropped);
          }
          break;
        default:
          break;
      }
    });
    return this;
  }

  send(msg) {
    if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(msg));
  }

  create() { this.send({ t: 'create', name: this.name }); return this.waitFor((m) => m.t === 'joined' || m.t === 'error'); }
  join(code) { this.send({ t: 'join', code, name: this.name }); return this.waitFor((m) => m.t === 'joined' || m.t === 'error'); }
  rejoin(code, playerId, token, name) {
    this.send({ t: 'rejoin', code, playerId, token, name });
    return this.waitFor((m) => m.t === 'joined' || m.t === 'error');
  }

  waitFor(pred, timeout = 7000) {
    const scan = () => {
      for (let i = this.msgCursor; i < this.msgs.length; i++) {
        if (pred(this.msgs[i])) { this.msgCursor = i + 1; return this.msgs[i]; }
      }
      return null;
    };
    const found = scan();
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const iv = setInterval(() => {
        const m = scan();
        if (m) { clearInterval(iv); clearTimeout(timer); resolve(m); }
      }, 25);
      const timer = setTimeout(() => {
        clearInterval(iv);
        reject(new Error(`timeout waiting for a message in "${this.name}"`));
      }, timeout);
    });
  }

  waitForEvent(pred, timeout = 15000) {
    const scan = () => {
      for (let i = this.eventCursor; i < this.events.length; i++) {
        if (pred(this.events[i])) { this.eventCursor = i + 1; return this.events[i]; }
      }
      return null;
    };
    const found = scan();
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const iv = setInterval(() => {
        const m = scan();
        if (m) { clearInterval(iv); clearTimeout(timer); resolve(m); }
      }, 35);
      const timer = setTimeout(() => {
        clearInterval(iv);
        reject(new Error(`timeout waiting for an event in "${this.name}"`));
      }, timeout);
    });
  }

  /* ------------------------------------------------------------------ *
   * Combat autopilot
   * ------------------------------------------------------------------ */
  /** start(targetId?) — fights the given tank, or the nearest live enemy. */
  autopilot(targetId = 0) {
    this.targetId = targetId;
    this.stuckAt = null;
    this.stuckSince = 0;
    this.timer = setInterval(() => this.think(), 33);
  }

  think() {
    const snap = this.snaps[this.snaps.length - 1];
    if (!snap || !this.map) return;
    const me = snap.tanks.find((t) => t.id === this.playerId);
    if (!me) return;
    const now = Date.now();

    // Detect being pinned against cover and pick the other way around.
    if (!this.stuckAt || Math.hypot(me.x - this.stuckAt.x, me.y - this.stuckAt.y) > 26) {
      this.stuckAt = { x: me.x, y: me.y };
      this.stuckSince = now;
    } else if (now - this.stuckSince > 900) {
      this.sideSign *= -1;
      this.stuckSince = now;
    }

    let target = this.targetId ? snap.tanks.find((t) => t.id === this.targetId) : null;
    if (!target) {
      let bestD = Infinity;
      for (const t of snap.tanks) {
        if (t.id === this.playerId) continue;
        const d = Math.hypot(t.x - me.x, t.y - me.y);
        if (d < bestD) { bestD = d; target = t; }
      }
    }

    let mx = 0, my = 0, turret = me.turret;

    // Survival first: never sit outside the collapsing zone.
    if (snap.zone) {
      const dz = Math.hypot(snap.zone.cx - me.x, snap.zone.cy - me.y);
      if (dz > snap.zone.r - 40) {
        const a = Math.atan2(snap.zone.cy - me.y, snap.zone.cx - me.x);
        this.seq++;
        this.send({ t: 'input', i: [[this.seq, Math.cos(a), Math.sin(a), target ? Math.atan2(target.y - me.y, target.x - me.x) : a, 0, 1]] });
        return;
      }
    }

    let los = false;
    let aimAt = null;
    if (target) {
      const d = Math.hypot(target.x - me.x, target.y - me.y);
      los = !raycastObstacles(this.world, me.x, me.y, target.x, target.y, 5);
      const flight = d / TANK.bulletSpeed;
      aimAt = {
        x: target.x + (target.vx || 0) * flight,
        y: target.y + (target.vy || 0) * flight,
      };
      turret = Math.atan2(aimAt.y - me.y, aimAt.x - me.x);

      const straight = Math.atan2(target.y - me.y, target.x - me.x);
      if (los) {
        // Approach to knife range, then circle-strafe so shells keep coming.
        if (d > 240) { mx = Math.cos(straight); my = Math.sin(straight); }
        else {
          const strafe = straight + Math.PI / 2 * this.sideSign;
          mx = Math.cos(straight) * 0.45 + Math.cos(strafe) * 0.9;
          my = Math.sin(straight) * 0.45 + Math.sin(strafe) * 0.9;
        }
      } else {
        // Walk around the cover at an offset angle until we can see them.
        const around = straight + 0.95 * this.sideSign;
        mx = Math.cos(around);
        my = Math.sin(around);
      }
    } else if (snap.zone) {
      const a = Math.atan2(snap.zone.cy - me.y, snap.zone.cx - me.x);
      turret = a;
      if (Math.hypot(snap.zone.cx - me.x, snap.zone.cy - me.y) > snap.zone.r * 0.4) { mx = Math.cos(a); my = Math.sin(a); }
    }

    const len = Math.hypot(mx, my);
    if (len > 1) { mx /= len; my /= len; }
    const aligned = Math.abs(angleDelta(me.turret, turret)) < 0.28;
    const fire = los && target && aligned;

    this.seq++;
    this.send({ t: 'input', i: [[this.seq, mx, my, turret, fire ? 1 : 0, len > 0 ? 1 : 0]] });
  }

  /** Drive toward a world point (optionally shooting it) — used to demo cover.
   *  Includes crude stuck-detection so the bot can round a wall instead of
   *  grinding against it forever. */
  navigate(x, y, { shoot = true, stopAt = 40, range = 520 } = {}) {
    this.navTarget = { x, y, shoot, stopAt, range };
    this.navStuckAt = null;
    this.navStuckSince = Date.now();
    this.navSide = 1;
    this.navStuckCount = 0;
    this.navDetourUntil = 0;
    clearInterval(this.timer);
    this.timer = setInterval(() => {
      const snap = this.snaps[this.snaps.length - 1];
      if (!snap || !this.map) return;
      const me = snap.tanks.find((t) => t.id === this.playerId);
      if (!me) return;
      const now = Date.now();
      const t = this.navTarget;

      if (!this.navStuckAt || Math.hypot(me.x - this.navStuckAt.x, me.y - this.navStuckAt.y) > 24) {
        this.navStuckAt = { x: me.x, y: me.y };
        this.navStuckSince = now;
      } else if (now - this.navStuckSince > 600) {
        // Keep circling the same way, widening the detour each time; only flip
        // sides if this side is clearly a dead end.
        this.navStuckCount++;
        if (this.navStuckCount > 5) { this.navSide *= -1; this.navStuckCount = 0; }
        this.navDetourUntil = now + 700 + this.navStuckCount * 250;
        this.navStuckSince = now;
        this.navStuckAt = { x: me.x, y: me.y };
      }

      const d = Math.hypot(t.x - me.x, t.y - me.y);
      let a = Math.atan2(t.y - me.y, t.x - me.x);
      const detourAngle = Math.min(2.2, 0.85 + this.navStuckCount * 0.32);
      const steer = now < this.navDetourUntil ? a + this.navSide * detourAngle : a;
      const mx = d > t.stopAt ? Math.cos(steer) : 0;
      const my = d > t.stopAt ? Math.sin(steer) : 0;
      this.seq++;
      // Aim at the real target (not the detour heading) and fire when in range.
      this.send({ t: 'input', i: [[this.seq, mx, my, a, t.shoot && d < t.range ? 1 : 0, mx || my ? 1 : 0]] });
    }, 33);
  }

  stop() {
    clearInterval(this.timer);
    try { this.ws.close(); } catch { /* ignore */ }
  }

  latestSnap() { return this.snaps[this.snaps.length - 1] || null; }
}

function angleDelta(a, b) {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

export { sleep };
