// TANKFALL — battle rooms: lobby state machine, host authority, authoritative
// name storage, reconnection, and the broadcast loop.

import {
  NET, ROOM_STATE, TANK_COLORS, SIM_HZ, ROOM_CODE_ALPHABET, ROOM_CODE_LEN, clamp,
} from '../shared/constants.js';
import { Game } from './game.js';
import { sanitizeName, ERRORS } from '../shared/protocol.js';
import { encodeSnapshot, createSnapshotBuffer } from '../shared/snapshot.js';

const EVENTS_HZ = 15;
const LOBBY_HZ_PLAYING = 2;

const STATE_CODE = {
  [ROOM_STATE.WAITING]: 1,
  [ROOM_STATE.COUNTDOWN]: 2,
  [ROOM_STATE.PLAYING]: 3,
  [ROOM_STATE.FINISHED]: 4,
};

let nextPlayerId = 1;
let nextRoomId = 1;

export class Player {
  constructor({ id, token, name, originalName, color }) {
    this.id = id;
    this.token = token;
    this.name = name;
    this.originalName = originalName;
    this.hostAssigned = false;
    this.color = color;
    this.ready = false;
    this.connected = false;
    this.ws = null;
    this.joinedAt = Date.now();
    this.disconnectedAt = 0;
    this.leftPermanently = false;
    this.input = { mx: 0, my: 0, turret: 0, fire: false, boost: false };
    this.lastInputSeq = 0;
    this.pending = [];
    this.lastChatAt = 0;
  }
}

export class Room {
  constructor(code, now = Date.now()) {
    this.id = nextRoomId++;
    this.code = code;
    this.players = new Map();  // id -> Player (includes temporarily disconnected slots)
    this.order = [];           // player ids in host-controlled display order
    this.hostId = 0;
    this.state = ROOM_STATE.WAITING;
    this.createdAt = now;
    this.emptySince = 0;
    this.game = null;
    this.seed = 0;
    this.countdownEndsAt = 0;
    this.countdownStep = -1;
    this.hostMigrationAt = 0;
    this.removed = false;
    this._acc = 0;
    this._eventsAcc = 0;
    this._lobbyAcc = 0;
    this._snapTick = 0;
    this._snapBuf = createSnapshotBuffer();
    this._snapView = new DataView(this._snapBuf);
  }

  now() { return Date.now(); }

  /* ------------------------------------------------------------------ *
   * Membership
   * ------------------------------------------------------------------ */
  nextColor() {
    const used = new Set([...this.players.values()].map((p) => p.color));
    for (const c of TANK_COLORS) if (!used.has(c)) return c;
    return TANK_COLORS[this.players.size % TANK_COLORS.length];
  }

  activeCount() {
    let n = 0;
    for (const p of this.players.values()) if (p.connected) n++;
    return n;
  }

  addPlayer({ name, originalName }) {
    const player = new Player({
      id: nextPlayerId++,
      token: makeToken(),
      name,
      originalName: originalName ?? name,
      color: this.nextColor(),
    });
    player.roomCode = this.code;
    this.players.set(player.id, player);
    this.order.push(player.id);
    if (!this.hostId) this.hostId = player.id;
    return player;
  }

  isHost(player) { return !!player && player.id === this.hostId && !player.leftPermanently; }

  /* ------------------------------------------------------------------ *
   * Broadcast helpers
   * ------------------------------------------------------------------ */
  send(player, msg) {
    if (!player || !player.connected || !player.ws || player.ws.readyState !== 1) return;
    try { player.ws.send(JSON.stringify(msg)); } catch { /* socket died */ }
  }

  broadcast(msg) {
    const data = JSON.stringify(msg);
    for (const p of this.players.values()) {
      if (!p.connected || !p.ws || p.ws.readyState !== 1) continue;
      try { p.ws.send(data); } catch { /* socket died */ }
    }
  }

  pushEvent(ev) {
    for (const p of this.players.values()) if (p.connected) p.pending.push(ev);
  }

  /* ------------------------------------------------------------------ *
   * Lobby roster (JSON) — always server-authoritative
   * ------------------------------------------------------------------ */
  roster() {
    const players = this.order
      .map((id) => this.players.get(id))
      .filter((p) => p && !p.leftPermanently)
      .map((p) => {
        const tank = this.game ? this.game.tanks.get(p.id) : null;
        const res = this.game && this.game.results
          ? this.game.results.find((r) => r.playerId === p.id) : null;
        return {
          id: p.id,
          name: p.name,
          originalName: p.originalName,
          color: p.color,
          ready: !!p.ready,
          connected: !!p.connected,
          isHost: p.id === this.hostId,
          hostRenamed: !!p.hostAssigned,
          alive: tank ? !!tank.alive : false,
          hp: tank ? Math.max(0, Math.round(tank.hp)) : 0,
          kills: tank ? tank.stats.kills : (res ? res.kills : 0),
          damage: tank ? Math.round(tank.stats.damage) : (res ? res.damage : 0),
          spectating: !!this.game && (!tank || !tank.alive),
        };
      });

    return {
      code: this.code,
      state: this.state,
      hostId: this.hostId,
      maxPlayers: NET.maxPlayers,
      minPlayers: NET.minPlayers,
      countdownMs: this.state === ROOM_STATE.COUNTDOWN
        ? Math.max(0, this.countdownEndsAt - this.now()) : 0,
      players,
      results: this.state === ROOM_STATE.FINISHED && this.game ? this.game.results : null,
      winnerId: this.state === ROOM_STATE.FINISHED && this.game ? this.game.winnerId : 0,
    };
  }

  broadcastLobby() {
    this.broadcast({ t: 'lobby', room: this.roster() });
  }

  /* ------------------------------------------------------------------ *
   * Match lifecycle
   * ------------------------------------------------------------------ */
  beginCountdown() {
    const active = [...this.players.values()].filter((p) => p.connected && !p.leftPermanently);
    if (this.state !== ROOM_STATE.WAITING || active.length < NET.minPlayers) return false;
    this.state = ROOM_STATE.COUNTDOWN;
    this.countdownEndsAt = this.now() + NET.countdownMs;
    this.countdownStep = -1;
    this.pushEvent({ k: 'countdownStart', ms: NET.countdownMs });
    this.broadcastLobby();
    return true;
  }

  startMatch() {
    const participants = this.order
      .map((id) => this.players.get(id))
      .filter((p) => p && p.connected && !p.leftPermanently)
      .map((p) => ({ playerId: p.id, name: p.name, color: p.color }));

    if (participants.length < NET.minPlayers) {
      this.state = ROOM_STATE.WAITING;
      this.broadcastLobby();
      return false;
    }

    this.seed = (Math.floor(Math.random() * 0x7fffffff) ^ (this.id * 2654435761)) >>> 0;
    this.game = new Game({ seed: this.seed, participants });
    this.state = ROOM_STATE.PLAYING;

    for (const p of this.players.values()) {
      p.ready = false;
      p.input = { mx: 0, my: 0, turret: 0, fire: false, boost: false, };
      const tank = this.game.tanks.get(p.id);
      this.send(p, {
        t: 'match',
        seed: this.seed,
        map: { w: this.game.map.w, h: this.game.map.h },
        you: tank ? { playerId: p.id, tankId: p.id, color: p.color, spawn: tank.spawnName } : null,
        players: [...this.game.tanks.values()].map((tk) => ({
          playerId: tk.playerId, tankId: tk.id, name: tk.name, color: tk.color, spawn: tk.spawnName,
        })),
      });
    }
    this.pushEvent({ k: 'start' });
    this.broadcastLobby();
    return true;
  }

  /** Late joiners / reconnectors need the parts of the world the snapshot omits. */
  sendWorldSync(player) {
    if (!this.game) return;
    const destroyed = [];
    for (const o of this.game.map.obstacles) if (o.destroyed) destroyed.push(o.id);
    const pickups = [...this.game.pickups.values()].map((p) => ({ id: p.id, kind: p.kind, x: p.x, y: p.y }));
    this.send(player, {
      t: 'sync',
      seed: this.seed,
      state: this.state,
      destroyed,
      pickups,
      zone: {
        cx: this.game.zone.cx, cy: this.game.zone.cy, r: this.game.zone.r,
        phase: this.game.zone.phaseIndex,
      },
      results: this.game.results,
      winnerId: this.game.winnerId,
      timeMs: Math.round(this.game.time * 1000),
    });
  }

  finishMatch() {
    if (this.state === ROOM_STATE.FINISHED) return;
    if (this.game && !this.game.over) this.game.finish(0, []);
    this.state = ROOM_STATE.FINISHED;
    this.broadcastLobby();
  }

  resetToLobby() {
    this.game = null;
    this.state = ROOM_STATE.WAITING;
    this.countdownEndsAt = 0;
    this.countdownStep = -1;
    for (const p of this.players.values()) {
      p.ready = false;
      p.input = { mx: 0, my: 0, turret: 0, fire: false, boost: false };
    }
    this.pushEvent({ k: 'lobby' });
    this.broadcastLobby();
  }

  /* ------------------------------------------------------------------ *
   * Actions (server-validated; the host is the only authority for these)
   * ------------------------------------------------------------------ */
  doRename(actor, targetId, rawName) {
    if (!actor || actor.leftPermanently) return { error: ERRORS.WRONG_STATE };
    if (this.state !== ROOM_STATE.WAITING && this.state !== ROOM_STATE.FINISHED) {
      return { error: 'Names are locked once the battle begins.' };
    }
    const target = this.players.get(targetId);
    if (!target || target.leftPermanently) return { error: 'That tank has left the battlefield.' };
    const isSelf = actor.id === targetId;
    if (!isSelf && !this.isHost(actor)) return { error: ERRORS.NOT_HOST };

    const clean = sanitizeName(rawName, NET.maxNameLen);
    if (!clean) return { error: 'That name is not allowed (1–16 characters).' };
    if (clean === target.name) return { ok: true };

    const from = target.name;
    target.name = clean;
    target.hostAssigned = !isSelf;
    if (isSelf) target.originalName = clean;
    const tank = this.game && this.game.tanks.get(target.id);
    if (tank) tank.name = clean;

    this.pushEvent({ k: 'rename', id: target.id, from, to: clean, byHost: target.hostAssigned });
    this.pushEvent({
      k: 'notice',
      text: target.hostAssigned
        ? `😹 ${actor.name} renamed ${from} → ${clean}`
        : `✏️ ${from} → ${clean}`,
    });
    this.broadcastLobby();
    return { ok: true };
  }

  doKick(actor, targetId) {
    if (!this.isHost(actor)) return { error: ERRORS.NOT_HOST };
    if (this.state !== ROOM_STATE.WAITING) return { error: ERRORS.WRONG_STATE };
    const target = this.players.get(targetId);
    if (!target || target.id === this.hostId) return { error: 'That tank cannot be removed.' };
    this.removePlayer(target, 'kicked');
    return { ok: true };
  }

  doMove(actor, targetId, up) {
    if (!this.isHost(actor)) return { error: ERRORS.NOT_HOST };
    if (this.state !== ROOM_STATE.WAITING) return { error: ERRORS.WRONG_STATE };
    const i = this.order.indexOf(targetId);
    if (i < 0) return { error: 'That tank is no longer here.' };
    const j = clamp(i + (up ? -1 : 1), 0, this.order.length - 1);
    if (i === j) return { ok: true };
    this.order.splice(i, 1);
    this.order.splice(j, 0, targetId);
    this.broadcastLobby();
    return { ok: true };
  }

  doReady(actor, value) {
    if (!actor) return { error: ERRORS.WRONG_STATE };
    if (this.state !== ROOM_STATE.WAITING) return { error: ERRORS.WRONG_STATE };
    actor.ready = !!value;
    this.pushEvent({ k: 'ready', id: actor.id, name: actor.name, value: actor.ready });
    this.broadcastLobby();
    return { ok: true };
  }

  /* ------------------------------------------------------------------ *
   * Removal / disconnect / reconnect
   * ------------------------------------------------------------------ */
  removePlayer(player, reason = 'left') {
    if (!player || player.leftPermanently) return;
    player.leftPermanently = true;
    player.ready = false;
    const name = player.name;
    const wasHost = player.id === this.hostId;

    if (this.game) {
      const events = [];
      this.game.handlePlayerLeft(player.id, events);
      for (const ev of events) this.pushEvent(ev);
    }

    if (reason === 'kicked') {
      this.send(player, { t: 'error', code: 'KICKED', message: ERRORS.KICKED });
    }
    try {
      if (player.ws && player.ws.readyState === 1) player.ws.close(4002, reason);
    } catch { /* noop */ }
    if (player.ws) player.ws.playerRef = null;
    player.ws = null;
    player.connected = false;
    this.players.delete(player.id);
    this.order = this.order.filter((id) => id !== player.id);

    this.pushEvent({ k: 'leave', id: player.id, name, reason });
    this.pushEvent({
      k: 'notice',
      text: reason === 'kicked' ? `🚪 ${name} was removed from the room` : `🚪 ${name} left the battle`,
    });

    if (wasHost) this.promoteHost(true);
    else this.broadcastLobby();
  }

  handleDisconnect(player) {
    if (!player || player.leftPermanently || !player.connected) return;
    player.connected = false;
    if (player.ws) player.ws.playerRef = null;
    player.ws = null;
    player.disconnectedAt = this.now();
    this.pushEvent({ k: 'notice', text: `📡 ${player.name} lost connection…` });
    if (player.id === this.hostId) {
      if (this.state === ROOM_STATE.PLAYING || this.state === ROOM_STATE.COUNTDOWN) {
        this.hostMigrationAt = this.now() + NET.hostGraceMs;
      } else {
        this.promoteHost(true);
      }
    }
    const inMatch = this.state === ROOM_STATE.PLAYING || this.state === ROOM_STATE.FINISHED;
    if (!inMatch) {
      // Before the match every slot must be filled by a live connection.
      this.removePlayer(player, 'timeout');
    } else {
      this.broadcastLobby();
    }
  }

  /** Host handover: instant in the lobby, after a grace window mid-match. */
  promoteHost(force = false) {
    if (!force && (this.state === ROOM_STATE.PLAYING || this.state === ROOM_STATE.COUNTDOWN)) {
      this.hostMigrationAt = this.now() + NET.hostGraceMs;
      return;
    }
    const candidates = this.order
      .map((id) => this.players.get(id))
      .filter((p) => p && p.connected && !p.leftPermanently);
    if (!candidates.length) return;
    const next = candidates[0];
    if (next.id === this.hostId) {
      this.hostMigrationAt = 0;
      return;
    }
    this.hostId = next.id;
    this.hostMigrationAt = 0;
    this.pushEvent({ k: 'notice', text: `👑 ${next.name} is now the host` });
    this.broadcastLobby();
  }

  rejoin(player, ws) {
    // Take over the seat: any zombie socket for this player is dropped.
    if (player.ws && player.ws !== ws && player.ws.readyState === 1) {
      try { player.ws.playerRef = null; player.ws.close(4003, 'replaced'); } catch { /* noop */ }
    }
    player.ws = ws;
    player.connected = true;
    player.disconnectedAt = 0;
    if (player.id === this.hostId) this.hostMigrationAt = 0;
    this.pushEvent({ k: 'notice', text: `🔌 ${player.name} reconnected` });
    this.broadcastLobby();
  }

  /* ------------------------------------------------------------------ *
   * Simulation tick
   * ------------------------------------------------------------------ */
  tick(dt) {
    const now = this.now();
    this._eventsAcc += dt;
    this._acc += dt;

    // ---- state machine -------------------------------------------------
    if (this.state === ROOM_STATE.COUNTDOWN) {
      const leftMs = this.countdownEndsAt - now;
      const step = Math.max(0, Math.ceil(leftMs / NET.countdownStepMs));
      if (step !== this.countdownStep && step <= 3) {
        this.countdownStep = step;
        if (step > 0) this.pushEvent({ k: 'count', n: step });
        this.broadcastLobby();
      }
      const active = [...this.players.values()].filter((p) => p.connected && !p.leftPermanently);
      if (active.length < NET.minPlayers) {
        this.state = ROOM_STATE.WAITING;
        this.countdownEndsAt = 0;
        this.pushEvent({ k: 'countdownCancel', reason: 'Not enough tanks — still waiting.' });
        this.broadcastLobby();
      } else if (leftMs <= 0) {
        this.countdownStep = -1;
        if (!this.startMatch()) this.state = ROOM_STATE.WAITING;
      }
    }

    // ---- host migration grace -------------------------------------------
    if (this.hostMigrationAt && now >= this.hostMigrationAt) {
      const host = this.players.get(this.hostId);
      if (!host || !host.connected) this.promoteHost(true);
      else this.hostMigrationAt = 0;
    }

    // ---- match simulation (fixed 30 Hz) ---------------------------------
    if (this.state === ROOM_STATE.PLAYING && this.game) {
      const fixed = 1 / SIM_HZ;
      let steps = 0;
      while (this._acc >= fixed && steps < 4) {
        this._acc -= fixed;
        steps++;
        const events = this.game.update(fixed, this);
        for (const ev of events) this.pushEvent(ev);
        if (this.game.over) { this.finishMatch(); break; }
      }
      if (this._acc > fixed * 6) this._acc = fixed * 6; // never spiral after a stall

      // Exactly one snapshot per simulated step (30 Hz) — the room tick runs
      // faster than the sim, so never send more than that.
      if (steps > 0 && this.state === ROOM_STATE.PLAYING && this.game) {
        const snap = this.game.buildSnapshot(STATE_CODE[ROOM_STATE.PLAYING], this.createdAt, now);
        const len = encodeSnapshot(this._snapView, snap);
        const frame = Buffer.from(this._snapBuf.slice(0, len));
        for (const p of this.players.values()) {
          if (!p.connected || !p.ws || p.ws.readyState !== 1) continue;
          try { p.ws.send(frame, { binary: true }); } catch { /* socket died */ }
        }
      }
    }

    // ---- event flush ----------------------------------------------------
    if (this._eventsAcc >= 1 / EVENTS_HZ) {
      this._eventsAcc = 0;
      for (const p of this.players.values()) {
        if (!p.connected || !p.pending.length) continue;
        const batch = p.pending;
        p.pending = [];
        this.send(p, { t: 'events', e: batch });
      }
    }

    // ---- periodic lobby sync while fighting (keeps stats + alive list fresh)
    if (this.state === ROOM_STATE.PLAYING) {
      this._lobbyAcc += dt;
      if (this._lobbyAcc >= 1 / LOBBY_HZ_PLAYING) {
        this._lobbyAcc = 0;
        this.broadcastLobby();
      }
    }

    // ---- housekeeping ----------------------------------------------------
    const active = this.activeCount();
    if (active === 0) {
      if (!this.emptySince) this.emptySince = now;
    } else {
      this.emptySince = 0;
    }
    if (this.emptySince && now - this.emptySince > NET.emptyRoomTtlMs) this.removed = true;
    if (now - this.createdAt > NET.roomTtlMs) this.removed = true;
  }
}

function makeToken() {
  let s = '';
  for (let i = 0; i < 24; i++) s += ROOM_CODE_ALPHABET[Math.floor(Math.random() * ROOM_CODE_ALPHABET.length)];
  return s;
}

/* -------------------------------------------------------------------- *
 * Room manager
 * -------------------------------------------------------------------- */
export class RoomManager {
  constructor() {
    this.rooms = new Map(); // code -> Room
  }

  generateCode() {
    for (let attempt = 0; attempt < 500; attempt++) {
      let code = '';
      for (let i = 0; i < ROOM_CODE_LEN; i++) {
        code += ROOM_CODE_ALPHABET[Math.floor(Math.random() * ROOM_CODE_ALPHABET.length)];
      }
      if (!this.rooms.has(code)) return code;
    }
    let n = 0;
    while (this.rooms.has(`R${n}`.padStart(6, 'X'))) n++;
    return `R${n}`.padStart(6, 'X');
  }

  createRoom() {
    const code = this.generateCode();
    const room = new Room(code);
    this.rooms.set(code, room);
    return room;
  }

  get(code) { return this.rooms.get(code); }

  list() {
    const out = [];
    for (const room of this.rooms.values()) {
      if (room.state !== ROOM_STATE.WAITING) continue;
      const count = room.activeCount();
      if (count === 0 || count >= NET.maxPlayers) continue;
      out.push({ code: room.code, players: count, max: NET.maxPlayers, age: Date.now() - room.createdAt });
    }
    return out.sort((a, b) => a.age - b.age).slice(0, 24);
  }

  /** Runs every simulated room tick. */
  tickAll(dt) {
    for (const room of this.rooms.values()) room.tick(dt);
  }

  cleanup() {
    for (const [code, room] of this.rooms) if (room.removed) this.rooms.delete(code);
  }

  get size() { return this.rooms.size; }
}
