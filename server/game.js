// TANKFALL — authoritative match simulation.
// The server owns tanks, bullets, damage, health, eliminations, powerups, the
// shrinking battle zone, the winner and every stat. Clients only send inputs.

import {
  TANK, POWERUP, POWERUP_KINDS, FLAGS, ZONE, CAUSES, DT, NET,
  clamp, makeRng, dist,
} from '../shared/constants.js';
import { CollisionWorld, createTankState, stepTank, raycastObstacles } from '../shared/physics.js';
import { generateMap } from '../shared/mapgen.js';

let nextBulletId = 1;
let nextPickupId = 1;

export class Game {
  constructor({ seed, participants }) {
    this.seed = seed;
    this.rng = makeRng((seed ^ 0x9e3779b9) >>> 0);
    this.map = generateMap(seed);
    this.world = new CollisionWorld(this.map);
    this.tanks = new Map();
    this.bullets = new Map();
    this.pickups = new Map();
    this.time = 0;
    this.over = false;
    this.winnerId = 0;
    this.results = null;
    this.hardCapFired = false;
    this.zoneHits = new Map();

    // ---- battle zone -------------------------------------------------------
    this.zoneAnchor = {
      x: this.map.w * (0.30 + this.rng() * 0.40),
      y: this.map.h * (0.30 + this.rng() * 0.40),
    };
    this.zone = {
      cx: this.map.w / 2, cy: this.map.h / 2,
      r: ZONE.startRadius, targetR: ZONE.startRadius,
      phaseIndex: 0, timerMs: ZONE.phases[0].waitMs, shrinking: false,
    };

    // ---- spawns ------------------------------------------------------------
    const spawns = this.map.spawns.slice();
    for (let i = spawns.length - 1; i > 0; i--) {
      const j = Math.floor(this.rng() * (i + 1));
      const tmp = spawns[i]; spawns[i] = spawns[j]; spawns[j] = tmp;
    }

    participants.forEach((p, i) => {
      const spawn = spawns[i % spawns.length];
      // Nudge spawn points apart if two players share a hex.
      const ring = Math.floor(i / spawns.length);
      const jitter = ring * 46;
      const x = clamp(spawn.x + jitter * Math.cos(i * 2.4), 40, this.map.w - 40);
      const y = clamp(spawn.y + jitter * Math.sin(i * 2.4), 40, this.map.h - 40);
      const st = createTankState(x, y, this.rng() * Math.PI * 2);
      const tank = {
        id: p.playerId,
        playerId: p.playerId,
        name: p.name,
        color: p.color,
        x: st.x, y: st.y, vx: 0, vy: 0, angle: st.angle, turret: st.turret,
        hp: TANK.maxHp,
        alive: true,
        eliminatedAt: 0,
        lastHitBy: 0,
        spawnProtect: 1.6,
        spawnName: spawn.name,
        reload: 0,
        megaArmed: false,
        boostEnergy: 100,
        timers: { shield: 0, boost: 0, cloak: 0 },
        flags: 0,
        stats: { kills: 0, damage: 0, shots: 0, hits: 0 },
        survivalMs: 0,
      };
      this.tanks.set(tank.id, tank);
    });

    this.lastPickupSpawn = 0;
    this.nextPickupAt = 2500;
  }

  /* ------------------------------------------------------------------ *
   * Tick
   * ------------------------------------------------------------------ */
  update(dt, room) {
    this.time += dt;
    if (this.over) return [];

    const events = [];

    // --- tanks (inputs are applied once per authoritative tick) -----------
    for (const tank of this.tanks.values()) {
      const p = room.players.get(tank.playerId);
      const connected = !!(p && p.connected);
      const input = connected ? p.input : null;
      tank.reload = Math.max(0, tank.reload - dt);
      for (const k of Object.keys(tank.timers)) tank.timers[k] = Math.max(0, tank.timers[k] - dt);

      if (!tank.alive) continue;

      // Hold-to-boost burns a server-owned energy budget; the ⚡ powerup is a
      // separate, bigger multiplier on top of it.
      const wantsBoost = !!(input && input.boost && tank.boostEnergy > 0.5);
      if (wantsBoost) tank.boostEnergy = Math.max(0, tank.boostEnergy - TANK.boostDrain * dt);
      else tank.boostEnergy = Math.min(100, tank.boostEnergy + TANK.boostRegen * dt);
      const speedMult = (wantsBoost ? TANK.boostHoldMult : 1) * (tank.timers.boost > 0 ? TANK.boostMult : 1);
      stepTank(tank, input || { mx: 0, my: 0, turret: tank.turret }, dt, this.world, speedMult);

      if (tank.spawnProtect > 0) tank.spawnProtect = Math.max(0, tank.spawnProtect - dt);
      tank.survivalMs += dt * 1000;

      // Disconnected tanks self-destruct so the match can never stall.
      if (!connected && p && !p.leftPermanently) {
        const gap = room.now() - p.disconnectedAt;
        const limit = p.isHost ? NET.hostGraceMs : NET.tankGhostMs;
        if (gap > limit) this.destroyTank(tank, CAUSES.VANISH, null, events);
      }

      if (input && input.fire && tank.reload <= 0) this.fire(tank, events);
    }

    // --- bullets ----------------------------------------------------------
    this.updateBullets(dt, events);

    // --- powerups ---------------------------------------------------------
    this.updatePickups(dt, events);

    // --- battle zone ------------------------------------------------------
    this.updateZone(dt, room, events);

    // --- winner -----------------------------------------------------------
    const alive = [...this.tanks.values()].filter((t) => t.alive);
    if (alive.length <= 1) {
      this.finish(alive.length === 1 ? alive[0].id : 0, events);
    }
    return events;
  }

  /* ------------------------------------------------------------------ *
   * Firing
   * ------------------------------------------------------------------ */
  fire(tank, events) {
    const mega = tank.megaArmed;
    tank.reload = mega ? TANK.megaReload : TANK.reload;
    tank.spawnProtect = 0;
    tank.stats.shots++;
    const muzzleA = tank.turret;
    const bx = tank.x + Math.cos(muzzleA) * TANK.muzzleOffset;
    const by = tank.y + Math.sin(muzzleA) * TANK.muzzleOffset;
    const id = nextBulletId++;
    if (nextBulletId > 60000) nextBulletId = 1;
    this.bullets.set(id, {
      id,
      ownerId: tank.id,
      x: bx, y: by,
      px: bx, py: by,
      angle: muzzleA,
      vx: Math.cos(muzzleA) * TANK.bulletSpeed,
      vy: Math.sin(muzzleA) * TANK.bulletSpeed,
      life: TANK.bulletLife,
      mega,
      damage: mega ? TANK.megaDamage : TANK.damage,
    });
    if (mega) tank.megaArmed = false;
    events.push({ k: 'shoot', id: tank.id, x: bx, y: by, a: +muzzleA.toFixed(3), mega: mega ? 1 : 0 });
  }

  updateBullets(dt, events) {
    for (const b of [...this.bullets.values()]) {
      b.px = b.x; b.py = b.y;
      const nx = b.x + b.vx * dt;
      const ny = b.y + b.vy * dt;
      b.life -= dt;

      // Tanks first (shortest hit wins).
      let hitTank = null, hitT = Infinity;
      for (const t of this.tanks.values()) {
        if (!t.alive || t.id === b.ownerId) continue;
        if (t.spawnProtect > 0) continue;
        const tr = TANK.radius + TANK.bulletRadius;
        const t0 = segCircle(b.x, b.y, nx, ny, t.x, t.y, tr);
        if (t0 !== null && t0 < hitT) { hitT = t0; hitTank = t; }
      }
      const obsHit = raycastObstacles(this.world, b.x, b.y, nx, ny, TANK.bulletRadius);
      const obsT = obsHit ? obsHit.t : Infinity;

      if (hitTank && hitT <= obsT) {
        const hx = b.x + (nx - b.x) * hitT;
        const hy = b.y + (ny - b.y) * hitT;
        this.applyDamage(hitTank, b.damage, CAUSES.SHOT, b.ownerId, hx, hy, events);
        events.push({ k: 'impact', x: hx, y: hy, mega: b.mega ? 1 : 0 });
        this.bullets.delete(b.id);
        continue;
      }

      if (obsHit && obsT <= 1) {
        const o = obsHit.obstacle;
        this.applyObstacleDamage(o, b.damage, b.ownerId, events);
        events.push({ k: 'impact', x: obsHit.x, y: obsHit.y, mega: b.mega ? 1 : 0 });
        this.bullets.delete(b.id);
        continue;
      }

      b.x = nx; b.y = ny;
      if (b.life <= 0 || b.x < 0 || b.y < 0 || b.x > this.map.w || b.y > this.map.h) {
        this.bullets.delete(b.id);
      }
    }
  }

  /* ------------------------------------------------------------------ *
   * Obstacles & barrels
   * ------------------------------------------------------------------ */
  applyObstacleDamage(o, amount, attackerId, events, depth = 0) {
    if (!o || o.destroyed || o.indestructible) return;
    o.hp -= amount;
    if (o.hp <= 0) this.destroyObstacle(o, attackerId, events, depth);
  }

  destroyObstacle(o, attackerId, events, depth = 0) {
    if (o.destroyed) return;
    o.destroyed = true;
    events.push({ k: 'destroy', id: o.id, x: o.x + (o.w ? o.w / 2 : 0), y: o.y + (o.h ? o.h / 2 : 0), m: o.material, s: o.shape, r: o.r || 0, w: o.w || 0, h: o.h || 0 });

    if (o.material === 'barrel' && depth < 4) {
      const R = 118, DMG = 42;
      events.push({ k: 'boom', x: o.x, y: o.y, r: R, kind: 'barrel' });
      // Chain-react other barrels first (capped depth so it always terminates).
      for (const other of this.map.obstacles) {
        if (other === o || other.destroyed || other.material !== 'barrel') continue;
        if (dist(o.x, o.y, other.x, other.y) <= R) {
          this.destroyObstacle(other, attackerId, events, depth + 1);
        }
      }
      for (const t of this.tanks.values()) {
        if (!t.alive) continue;
        const d = dist(o.x, o.y, t.x, t.y);
        if (d <= R + TANK.radius) {
          const falloff = 1 - Math.max(0, (d - TANK.radius)) / R;
          this.applyDamage(t, DMG * clamp(falloff, 0.35, 1), CAUSES.BARREL, attackerId, t.x, t.y, events);
        }
      }
    }
  }

  /* ------------------------------------------------------------------ *
   * Damage / elimination
   * ------------------------------------------------------------------ */
  applyDamage(tank, amount, cause, sourceId, x, y, events) {
    if (!tank.alive || this.over) return;
    if (tank.spawnProtect > 0) return;
    let dmg = amount;

    const src = sourceId && this.tanks.get(sourceId);
    if (src && src !== tank) src.stats.damage += Math.round(dmg);

    if (tank.timers.shield > 0) {
      const absorbed = Math.min(POWERUP.shieldAbsorb, dmg);
      tank.timers.shield -= absorbed * (POWERUP.shieldMs / POWERUP.shieldAbsorb) / 1000;
      dmg -= absorbed;
      events.push({ k: 'shield', id: tank.id, x: tank.x, y: tank.y });
      if (tank.timers.shield < 0) tank.timers.shield = 0;
    }
    if (dmg <= 0) return;

    tank.hp -= dmg;
    tank.lastHitBy = sourceId || 0;
    if (src && src !== tank) src.stats.hits++;
    events.push({ k: 'hit', id: tank.id, x, y, amount: Math.round(dmg), by: sourceId || 0, cause });

    if (tank.hp <= 0) {
      tank.hp = 0;
      this.destroyTank(tank, cause, sourceId, events);
    }
  }

  destroyTank(tank, cause, sourceId, events) {
    if (!tank.alive) return;
    tank.alive = false;
    tank.hp = 0;
    tank.eliminatedAt = this.time;
    tank.survivalMs = this.time * 1000;

    const killer = sourceId ? this.tanks.get(sourceId) : null;
    if (killer && killer !== tank) killer.stats.kills++;

    events.push({
      k: 'kill',
      killerId: killer ? killer.id : 0,
      killerName: killer ? killer.name : null,
      victimId: tank.id,
      victimName: tank.name,
      cause,
      x: tank.x, y: tank.y,
    });
    events.push({ k: 'boom', x: tank.x, y: tank.y, r: 96, kind: 'tank', color: tank.color });

    const remaining = [...this.tanks.values()].filter((t) => t.alive);
    if (remaining.length <= 1 && !this.over) {
      this.finish(remaining.length === 1 ? remaining[0].id : 0, events);
    }
  }

  /* ------------------------------------------------------------------ *
   * Powerups
   * ------------------------------------------------------------------ */
  updatePickups(dt, events) {
    if (this.time * 1000 >= this.nextPickupAt && this.pickups.size < POWERUP.maxActive) {
      this.spawnPickup(events);
      const [lo, hi] = POWERUP.spawnIntervalMs;
      this.nextPickupAt = this.time * 1000 + lo + this.rng() * (hi - lo);
    }

    for (const t of this.tanks.values()) {
      if (!t.alive) continue;
      for (const pu of [...this.pickups.values()]) {
        if (dist(t.x, t.y, pu.x, pu.y) <= POWERUP.pickupRadius) {
          this.pickups.delete(pu.id);
          this.applyPickup(t, pu, events);
        }
      }
    }
  }

  spawnPickup(events) {
    for (let attempt = 0; attempt < 24; attempt++) {
      // Bias spawns toward the current safe zone so late-game pickups stay useful.
      const ang = this.rng() * Math.PI * 2;
      const rad = Math.sqrt(this.rng()) * this.zone.r * 0.85;
      const x = clamp(this.zone.cx + Math.cos(ang) * rad, 60, this.map.w - 60);
      const y = clamp(this.zone.cy + Math.sin(ang) * rad, 60, this.map.h - 60);
      let blocked = false;
      for (const o of this.world.query(x - 34, y - 34, x + 34, y + 34)) {
        if (dist(x, y, o.shape === 'circle' ? o.x : o.x + o.w / 2, o.shape === 'circle' ? o.y : o.y + o.h / 2) < 46) {
          blocked = true; break;
        }
      }
      if (blocked) continue;
      const kind = POWERUP_KINDS[Math.floor(this.rng() * POWERUP_KINDS.length)];
      const id = nextPickupId++;
      this.pickups.set(id, { id, kind, x, y });
      events.push({ k: 'spawnPU', id, kind, x, y });
      return;
    }
  }

  applyPickup(tank, pu, events) {
    switch (pu.kind) {
      case 'repair':
        tank.hp = Math.min(TANK.maxHp, tank.hp + POWERUP.repairAmount);
        break;
      case 'shield': tank.timers.shield = POWERUP.shieldMs / 1000; break;
      case 'boost':
        tank.timers.boost = POWERUP.boostMs / 1000;
        tank.boostEnergy = 100;
        break;
      case 'cloak': tank.timers.cloak = POWERUP.cloakMs / 1000; break;
      case 'mega': tank.megaArmed = true; break;
      default: break;
    }
    events.push({ k: 'pickup', id: tank.id, kind: pu.kind, x: pu.x, y: pu.y });
  }

  /* ------------------------------------------------------------------ *
   * Shrinking battle zone
   * ------------------------------------------------------------------ */
  updateZone(dt, room, events) {
    const z = this.zone;
    const ms = dt * 1000;
    z.timerMs -= ms;

    if (this.hardCapFired || this.time * 1000 > NET.matchHardCapMs) {
      this.hardCapFired = true;
      z.targetR = 60;
      z.r += (z.targetR - z.r) * Math.min(1, dt * 0.25);
    } else if (z.shrinking) {
      const phase = ZONE.phases[z.phaseIndex];
      const k = Math.min(1, dt * 1000 / Math.max(1, phase.shrinkMs));
      z.r += (z.targetR - z.r) * k;
      const drift = 0.06; // fraction per second toward the anchor point
      z.cx += (this.zoneAnchor.x - z.cx) * drift * dt;
      z.cy += (this.zoneAnchor.y - z.cy) * drift * dt;
      if (z.timerMs <= 0) {
        z.r = z.targetR;
        z.shrinking = false;
        z.phaseIndex++;
        const next = ZONE.phases[Math.min(z.phaseIndex, ZONE.phases.length - 1)];
        if (z.phaseIndex < ZONE.phases.length) {
          z.timerMs = next.waitMs;
        } else {
          z.timerMs = 1e9; // final zone holds
        }
        events.push({ k: 'zone', phase: z.phaseIndex });
      }
    } else {
      const cur = ZONE.phases[Math.min(z.phaseIndex, ZONE.phases.length - 1)];
      if (z.timerMs <= 0 && z.phaseIndex < ZONE.phases.length) {
        z.shrinking = true;
        z.targetR = cur.radius;
        z.timerMs = cur.shrinkMs;
        events.push({ k: 'zoneShrink', phase: z.phaseIndex, radius: cur.radius, ms: cur.shrinkMs });
      }
    }

    const dps = ZONE.phases[Math.min(z.phaseIndex, ZONE.phases.length - 1)].dps;
    for (const t of this.tanks.values()) {
      if (!t.alive) continue;
      const d = dist(t.x, t.y, z.cx, z.cy);
      if (d > z.r) {
        const ramp = clamp((d - z.r) / 160, 0.4, 2);
        this.applyDamage(t, dps * ramp * dt, CAUSES.ZONE, 0, t.x, t.y, events);
        const last = this.zoneHits.get(t.id) || 0;
        if (this.time - last > 0.6) {
          this.zoneHits.set(t.id, this.time);
          events.push({ k: 'zoneTick', id: t.id });
        }
      }
    }
  }

  /* ------------------------------------------------------------------ *
   * Match end
   * ------------------------------------------------------------------ */
  finish(winnerId, events) {
    if (this.over) return;
    this.over = true;
    this.winnerId = winnerId;
    const list = [...this.tanks.values()];
    const ranked = list.slice().sort((a, b) => {
      if (a.alive !== b.alive) return a.alive ? -1 : 1;
      return (b.eliminatedAt || 1e9) - (a.eliminatedAt || 1e9);
    });
    this.results = ranked.map((t, i) => ({
      playerId: t.playerId,
      name: t.name,
      color: t.color,
      alive: t.alive,
      placement: i + 1,
      kills: t.stats.kills,
      damage: Math.round(t.stats.damage),
      shots: t.stats.shots,
      hits: t.stats.hits,
      survivalMs: Math.round(t.alive ? this.time * 1000 : t.survivalMs),
      hp: Math.round(t.hp),
    }));
    events.push({
      k: 'end',
      winnerId: this.winnerId,
      winnerName: this.winnerId ? (this.tanks.get(this.winnerId) || {}).name : null,
      results: this.results,
      durationMs: Math.round(this.time * 1000),
    });
  }

  /** Called by the room when a player slot is released (quit / grace expired). */
  handlePlayerLeft(playerId, events) {
    const tank = this.tanks.get(playerId);
    if (!tank) return;
    if (tank.alive) this.destroyTank(tank, CAUSES.VANISH, null, events);
    this.tanks.delete(playerId);
  }

  /** Flat snapshot payload for the binary encoder. */
  buildSnapshot(stateCode, startedAtMs, nowMs) {
    const tanks = [];
    for (const t of this.tanks.values()) {
      if (!t.alive) continue;
      let flags = 0;
      if (t.timers.shield > 0) flags |= FLAGS.SHIELD;
      if (t.timers.boost > 0) flags |= FLAGS.BOOST;
      if (t.timers.cloak > 0) flags |= FLAGS.CLOAK;
      if (t.megaArmed) flags |= FLAGS.MEGA;
      tanks.push({
        id: t.id, x: t.x, y: t.y, vx: t.vx, vy: t.vy,
        angle: t.angle, turret: t.turret, hp: Math.max(0, Math.round(t.hp)),
        flags,
        shieldS: t.timers.shield, boostS: t.timers.boost, cloakS: t.timers.cloak,
        energy: Math.round(t.boostEnergy),
      });
    }
    const bullets = [];
    for (const b of this.bullets.values()) {
      bullets.push({ id: b.id, x: b.x, y: b.y, angle: b.angle, kind: b.mega ? 1 : 0 });
    }
    const pickups = [];
    for (const p of this.pickups.values()) pickups.push({ id: p.id, kind: p.kind, x: p.x, y: p.y });

    return {
      stateCode,
      t: nowMs & 0xffff,
      zone: {
        cx: Math.round(this.zone.cx), cy: Math.round(this.zone.cy),
        r: Math.round(this.zone.r), targetR: Math.round(this.zone.targetR),
        phase: this.zone.phaseIndex,
        nextMs: clamp(Math.round(this.zone.timerMs), 0, 655350),
      },
      tanks, bullets, pickups,
      winnerId: this.winnerId,
    };
  }
}

/* -------------------------------------------------------------------- *
 * Segment (px,py)->(qx,qy) against circle (cx,cy,r): earliest t in [0,1]
 * -------------------------------------------------------------------- */
function segCircle(px, py, qx, qy, cx, cy, r) {
  const dx = qx - px, dy = qy - py;
  const fx = px - cx, fy = py - cy;
  const a = dx * dx + dy * dy;
  if (a < 1e-9) return (fx * fx + fy * fy <= r * r) ? 0 : null;
  const b = 2 * (fx * dx + fy * dy);
  const c = fx * fx + fy * fy - r * r;
  const disc = b * b - 4 * a * c;
  if (disc < 0) return null;
  const sq = Math.sqrt(disc);
  const t1 = (-b - sq) / (2 * a);
  if (t1 >= 0 && t1 <= 1) return t1;
  const t2 = (-b + sq) / (2 * a);
  if (t2 >= 0 && t2 <= 1) return t2;
  return null;
}

export { DT };
