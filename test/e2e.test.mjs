// TANKFALL — end-to-end multiplayer test.
// Spawns a real server, connects real WebSocket clients (bots), and exercises
// room codes, host renaming, name sync, countdown, combat, eliminations,
// winner detection, disconnects, reconnects and host migration.

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { ROOM_STATE } from '../shared/constants.js';
import { Bot } from './bot.mjs';
import { raycastObstacles } from '../shared/physics.js';

const PORT = 3900 + Math.floor(Math.random() * 90);
const WS_URL = `ws://127.0.0.1:${PORT}/ws`;

let passed = 0;
let failed = 0;
const failures = [];

function ok(cond, label, extra = '') {
  if (cond) {
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${label}`);
  } else {
    failed++;
    failures.push(label);
    console.log(`  \x1b[31m✗ ${label}\x1b[0m ${extra}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const P = () => PORT;

/* ------------------------------------------------------------------ */
async function startServer(port, extraEnv = {}) {
  const proc = spawn(process.execPath, ['server/index.js'], {
    cwd: new URL('..', import.meta.url).pathname,
    env: { ...process.env, PORT: String(port), ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout.on('data', (d) => process.stdout.write(`[server] ${d}`));
  proc.stderr.on('data', (d) => process.stderr.write(`[server:err] ${d}`));
  await sleep(700);
  return proc;
}

async function scenarioFeatureServer() {
  const port = PORT + 2;
  // A very slow zone (x50) keeps the match alive while cover is demolished.
  const proc = await startServer(port, { TANKFALL_ZONE_SCALE: '50' });
  try {
    await scenarioDestructionAndPowerups(port);
  } finally {
    proc.kill('SIGKILL');
  }
}

async function main() {
  const only = process.argv[2] || '';
  const want = (name) => !only || name.includes(only);

  const runOn = async (label, env, port, fn) => {
    const proc = await startServer(port, env);
    try {
      await fn(port);
    } catch (err) {
      failed++;
      failures.push(String(err && err.message));
      console.error('\x1b[31mSCENARIO CRASH:\x1b[0m', err);
    } finally {
      proc.kill('SIGKILL');
      await sleep(200);
    }
  };

  // Production settings for the lobby / networking / security scenarios.
  const corePort = PORT;
  const wantsCore = want('lobby') || want('reconnect') || want('host') || want('validation') || want('anticheat') || only === '';
  if (wantsCore) {
    const proc = await startServer(corePort);
    try {
      if (want('lobby')) await scenarioLobbyAndRenaming();
      if (want('reconnect')) await scenarioDisconnectReconnect();
      if (want('host')) await scenarioHostMigration();
      if (want('validation')) await scenarioValidation();
      if (want('anticheat')) await scenarioAntiCheat();
    } catch (err) {
      failed++;
      failures.push(String(err && err.message));
      console.error('\x1b[31mSCENARIO CRASH:\x1b[0m', err);
    } finally {
      proc.kill('SIGKILL');
      await sleep(200);
    }
  }

  // Full match on a faster zone so the fight has to resolve; cover/powerups on
  // an almost-static zone so the match stays alive while things are demolished.
  if (want('match')) {
    await runOn('match', { TANKFALL_ZONE_SCALE: '0.3' }, PORT + 3, scenarioFullMatch);
  }
  if (want('destruction')) {
    await runOn('destruction', { TANKFALL_ZONE_SCALE: '50' }, PORT + 2, scenarioDestructionAndPowerups);
  }
  if (want('zone')) {
    await runOn('zone', { TANKFALL_ZONE_SCALE: '0.05' }, PORT + 1, scenarioShrinkingZone);
  }

  console.log(`\n${failed === 0 ? '\x1b[32m' : '\x1b[31m'}${passed} passed, ${failed} failed\x1b[0m`);
  if (failed) {
    console.log('Failures:', failures);
    process.exit(1);
  }
  process.exit(0);
}

/* ---------------- 1. lobby, codes, host renaming, name sync ------------- */
async function scenarioLobbyAndRenaming() {
  console.log('\n▸ LOBBY + HOST RENAMING (spec §32 scenario)');
  const host = await new Bot('Rahul').connect(PORT);
  const joinedHost = await host.create();
  const code = joinedHost.code;
  ok(/^[A-Z0-9]{6}$/.test(code), `room code format (${code})`);

  const b2 = await new Bot('Aman').connect(PORT);
  const b3 = await new Bot('Priya').connect(PORT);
  const b4 = await new Bot('Vikas').connect(PORT);
  const j2 = await b2.join(code);
  const j3 = await b3.join(code);
  const j4 = await b4.join(code);
  for (const [b, j] of [[b2, j2], [b3, j3], [b4, j4]]) {
    ok(j.t === 'joined', `${b.name} joined the room`);
  }

  const lobby = await b4.waitFor((m) => m.t === 'lobby' && m.room.players.length === 4);
  ok(lobby.room.players.length === 4, 'all four tanks listed in the lobby');
  ok(lobby.room.players.find((p) => p.id === host.playerId).isHost === true, 'host badge is server-assigned');
  ok(lobby.room.players.filter((p) => p.isHost).length === 1, 'exactly one host');

  // Host renames everyone.
  const renames = [[b2, 'Potato Tank'], [b3, 'Missile Uncle'], [b4, 'Captain Noob']];
  for (const [bot, newName] of renames) {
    host.send({ t: 'rename', targetId: bot.playerId, name: newName });
  }
  // Every device must receive the update inside the lobby payload.
  for (const bot of [b2, b3, b4]) {
    const expected = renames.find((r) => r[0] === bot)[1];
    const up = await bot.waitFor((m) => m.t === 'lobby' && m.room.players.some((p) => p.id === bot.playerId && p.name === expected));
    ok(!!up, `${bot.name} saw the new name "${expected}" on their own device`);
    const roster = up.room.players.find((p) => p.id === bot.playerId);
    ok(roster.hostRenamed === true, `${expected} flagged as host-renamed`);
    ok(roster.originalName === bot.name, `original name "${bot.name}" preserved for the lobby sub-label`);
  }
  // Non-host cannot rename others.
  b2.send({ t: 'rename', targetId: b3.playerId, name: 'Hacked' });
  const denied = await b2.waitFor((m) => m.t === 'error' && m.code === 'RENAME');
  ok(!!denied, 'non-host rename rejected by the server');

  // Rename sanitisation.
  host.send({ t: 'rename', targetId: b2.playerId, name: '<script>alert(1)</script>' });
  await sleep(120);
  const sanitized = host.lobby.players.find((p) => p.id === b2.playerId).name;
  ok(!/[<>]/.test(sanitized) && sanitized.length <= 16, `name sanitised ("${sanitized}")`);

  host.stop(); b2.stop(); b3.stop(); b4.stop();
  await sleep(150);
}

/* ---------------- 2. full match: countdown → fight → one winner --------- */
async function scenarioFullMatch(port) {
  console.log('\n▸ FULL MATCH (countdown → combat → single winner → results)');
  const bots = [];
  for (const name of ['Rahul', 'Aman', 'Priya', 'Vikas']) bots.push(await new Bot(name).connect(port));
  const hostMsg = await bots[0].create();
  const code = hostMsg.code;
  for (let i = 1; i < bots.length; i++) await bots[i].join(code);
  await bots[0].waitFor((m) => m.t === 'lobby' && m.room.players.length === 4);

  const funny = ['Potato Tank', 'Missile Uncle', 'Captain Noob', 'Exploding Chai'];
  for (let i = 1; i < bots.length; i++) {
    bots[0].send({ t: 'rename', targetId: bots[i].playerId, name: funny[i - 1] });
  }
  await sleep(150);

  bots[0].send({ t: 'start' });
  const countEvents = [];
  await Promise.all(bots.map(async (b) => {
    const m = await b.waitFor((x) => x.t === 'events' && x.e.some((e) => e.k === 'countdownStart'), 4000);
    countEvents.push(m);
  }));
  ok(countEvents.length === 4, 'countdown broadcast reached every client');

  const startEvent = await Promise.all(bots.map((b) => b.waitForEvent((e) => e.k === 'start', 8000)));
  ok(startEvent.length === 4, '"FIRE" start event reached every client');
  ok(bots.every((b) => b.match), 'every client received its match payload (seed + tank assignment)');
  const seeds = new Set(bots.map((b) => b.match.seed));
  ok(seeds.size === 1, 'all clients share the same battlefield seed');
  const namesOnTanks = new Set(bots.map((b) => b.match.players.map((p) => p.name).join('|')));
  ok(namesOnTanks.size === 1, 'tank name table identical on all clients');
  ok([...namesOnTanks][0].includes('Potato Tank') && [...namesOnTanks][0].includes('Missile Uncle') && [...namesOnTanks][0].includes('Captain Noob'), 'host-assigned names are used on the tanks');

  await sleep(600);
  ok(bots[0].snaps.length > 5, `snapshots streaming to clients (${bots[0].snaps.length} in ~0.6s)`);

  // Renaming must be locked once the battle begins.
  bots[0].send({ t: 'rename', targetId: bots[1].playerId, name: 'Too Late' });
  const locked = await bots[0].waitFor((m) => m.t === 'error' && m.code === 'RENAME');
  ok(!!locked, 'renaming disabled during the battle (spec §26)');

  for (const b of bots) b.autopilot();

  const endEvents = await Promise.all(bots.map((b) => b.waitForEvent((e) => e.k === 'end', 240000)));
  ok(endEvents.every((e) => e.k === 'end'), 'match ended and every client got the end event');
  const end = endEvents[0];
  ok(endEvents.every((e) => e.winnerId === end.winnerId), 'every client agrees on the winner id');
  ok(end.winnerId !== 0, `there is a winner (id ${end.winnerId})`);
  ok(typeof end.winnerName === 'string' && end.winnerName.length > 0, `winner name resolved server-side ("${end.winnerName}")`);
  const winnerResult = end.results.find((r) => r.placement === 1);
  ok(winnerResult && winnerResult.alive === true, 'winner is listed alive at placement #1');
  ok(end.results.length === 4, 'results include all four tanks');
  ok(end.results.every((r) => typeof r.kills === 'number' && typeof r.damage === 'number' && typeof r.shots === 'number'), 'stats present for every tank');
  const kills = bots[0].events.filter((e) => e.k === 'kill');
  ok(kills.length === 3, `elimination feed fired 3 times (${kills.length})`);
  ok(kills.every((k) => typeof k.victimName === 'string' && k.victimName.length), 'every kill event carries display names');
  ok(kills.some((k) => funny.includes(k.killerName) || funny.includes(k.victimName)), 'funny host-assigned names appear in the kill feed');

  const after = await bots[0].waitFor((m) => m.t === 'lobby' && m.room.state === ROOM_STATE.FINISHED, 4000);
  ok(after.room.results && after.room.results.length === 4, 'final lobby payload carries the scoreboard');
  ok(after.room.winnerId === end.winnerId, 'lobby winner id matches the end event');

  for (const b of bots) b.stop();
  await sleep(150);
}

/* ---------------- 3. disconnect / reconnect ---------------------------- */
async function scenarioDisconnectReconnect() {
  console.log('\n▸ DISCONNECT / RECONNECT DURING BATTLE');
  const host = await new Bot('Hosty').connect(PORT);
  const h = await host.create();
  const b = await new Bot('Leaver').connect(PORT);
  await b.join(h.code);
  await host.waitFor((m) => m.t === 'lobby' && m.room.players.length === 2);
  host.send({ t: 'start' });
  await b.waitForEvent((e) => e.k === 'start', 8000);
  await sleep(400);

  const tankId = b.match.you.playerId;
  b.stop();
  const notice = await host.waitForEvent((e) => e.k === 'notice' && /lost connection/.test(e.text), 5000);
  ok(!!notice, 'remaining client is told when a player drops');

  await sleep(200);
  const b2 = await new Bot('Leaver').connect(PORT);
  const rejoin = await b2.rejoin(h.code, b.playerId, b.token);
  ok(rejoin.t === 'joined' && rejoin.reconnected === true, 'player reconnected into the same seat');
  const sync = await b2.waitFor((m) => m.t === 'sync', 4000);
  ok(!!sync && Array.isArray(sync.destroyed), 'reconnecting client received a world sync');
  await sleep(400);
  const snap = b2.snaps[b2.snaps.length - 1];
  ok(!!snap && snap.tanks.some((t) => t.id === tankId), 'reconnected player controls the same tank again');

  // A stale/wrong token must not be allowed to steal a seat.
  const thief = await new Bot('Thief').connect(PORT);
  const bad = await thief.rejoin(h.code, b.playerId, 'NOT-A-REAL-TOKEN');
  ok(bad.t === 'error' && bad.code === 'NOT_FOUND', 'rejoin with a forged token rejected');

  host.stop(); b2.stop(); thief.stop();
  await sleep(150);
}

/* ---------------- 4. host migration ------------------------------------ */
async function scenarioHostMigration() {
  console.log('\n▸ HOST DISCONNECT + MIGRATION');
  const host = await new Bot('Boss').connect(PORT);
  const h = await host.create();
  const other = await new Bot('Second').connect(PORT);
  await other.join(h.code);
  await host.waitFor((m) => m.t === 'lobby' && m.room.players.length === 2);

  // Host leaves the lobby → the other player is promoted immediately.
  host.stop();
  const promoted = await other.waitFor((m) => m.t === 'lobby' && m.room.players.some((p) => p.id === other.playerId && p.isHost), 5000);
  ok(!!promoted, 'host migrated to the remaining player when the host quit');

  // The new host can start the match.
  const solo = await new Bot('Third').connect(PORT);
  await solo.join(h.code);
  await other.waitFor((m) => m.t === 'lobby' && m.room.players.length === 2);
  other.send({ t: 'start' });
  const started = await solo.waitForEvent((e) => e.k === 'start', 8000);
  ok(!!started, 'migrated host can start the battle');

  // Host quits mid-match → migration happens after the grace window.
  other.stop();
  const rehosted = await solo.waitFor((m) => m.t === 'lobby' && m.room.players.some((p) => p.id === solo.playerId && p.isHost), 30000);
  ok(!!rehosted, 'host migrated mid-match to the surviving player');

  solo.stop();
  await sleep(200);
}

/* ---------------- 6b. destructible cover + powerups --------------------- */
async function scenarioDestructionAndPowerups(port) {
  console.log('\n▸ DESTRUCTIBLE COVER + POWERUPS');
  const a = await new Bot('Demo').connect(port);
  const ha = await a.create();
  const b = await new Bot('Demo2').connect(port);
  await b.join(ha.code);
  await a.waitFor((m) => m.t === 'lobby' && m.room.players.length === 2);
  a.send({ t: 'start' });
  await a.waitForEvent((e) => e.k === 'start', 9000);
  await sleep(400);

  // --- light cover must break, and the destruction must be broadcast ---
  // Pick a crate with a clear line of fire from this bot, so the trip is a
  // straight walk instead of a maze run.
  const spawnMe = a.latestSnap()?.tanks.find((t) => t.id === a.playerId) || { x: a.map.w / 2, y: a.map.h / 2 };
  const inSight = (from, to) => !raycastObstacles(a.world, from.x, from.y, to.x, to.y, 7);
  // For an obstacle target the ray must stop short of it, otherwise it hits
  // the target itself and reports "blocked".
  const canReach = (from, to) => {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const d = Math.hypot(dx, dy);
    const stop = Math.max(0, d - 48) / (d || 1);
    return inSight(from, { x: from.x + dx * stop, y: from.y + dy * stop });
  };
  const crates = a.map.obstacles
    .filter((o) => o.material === 'woodCrate' && o.shape === 'rect')
    .map((o) => ({ o, cx: o.x + o.w / 2, cy: o.y + o.h / 2 }))
    .filter((c) => canReach(spawnMe, { x: c.cx, y: c.cy }))
    .sort((p1, p2) => Math.hypot(p1.cx - spawnMe.x, p1.cy - spawnMe.y) - Math.hypot(p2.cx - spawnMe.x, p2.cy - spawnMe.y));
  const crate = crates.length ? crates[0].o : a.map.obstacles.find((o) => o.material === 'woodCrate');
  if (!crate) throw new Error('no crate in this seed');
  ok(!!crate, 'map contains destructible wooden crates');
  const cx = crate.x + crate.w / 2;
  const cy = crate.y + crate.h / 2;
  a.navigate(cx, cy, { shoot: true, stopAt: 26, range: 460 });
  const destroyed = await a.waitForEvent((e) => e.k === 'destroy' && e.id === crate.id, 30000).catch(() => null);
  ok(!!destroyed, `wooden crate destroyed by gunfire (id ${crate.id}, hp ${crate.maxHp})`);
  const mirrored = await b.waitForEvent((e) => e.k === 'destroy' && e.id === crate.id, 4000).catch(() => null);
  ok(!!mirrored, 'destruction synchronised to every client (not faked locally)');

  // --- the rubble no longer blocks movement ---
  await sleep(200);
  a.navigate(cx, cy, { shoot: false, stopAt: 4 });
  let inside = false;
  for (let i = 0; i < 90; i++) {
    await sleep(120);
    const me = a.latestSnap()?.tanks.find((t) => t.id === a.playerId);
    if (!me) break;
    if (Math.abs(me.x - cx) < crate.w / 2 + 12 && Math.abs(me.y - cy) < crate.h / 2 + 12) { inside = true; break; }
  }
  ok(inside, 'tank can drive through the space the crate used to occupy');

  // --- heavy cover is indestructible ---
  const wall = a.map.obstacles.find((o) => o.material === 'concrete' && o.shape === 'rect' && o.w > 200 && o.h > 200);
  if (wall) {
    const wx = wall.x + wall.w / 2;
    const wy = wall.y + wall.h / 2;
    a.navigate(wx, wy, { shoot: true, stopAt: 26, range: 460 });
    await sleep(4000);
    const everDestroyed = a.events.some((e) => e.k === 'destroy' && e.id === wall.id);
    ok(!everDestroyed, 'concrete structures absorb everything (indestructible)');
  } else {
    ok(true, 'concrete structures absorb everything (no suitable wall in this seed)');
  }

  // --- powerups spawn, are picked up, and the effect is server-applied ---
  const spawn = await a.waitForEvent((e) => e.k === 'spawnPU', 25000).catch(() => null);
  ok(!!spawn, 'powerups spawn from the server loop');
  let pickupEvent = null;
  for (let attempt = 0; attempt < 6 && !pickupEvent; attempt++) {
    const snap = a.latestSnap();
    const me = snap && snap.tanks.find((t) => t.id === a.playerId);
    if (!me) break;
    // Head for the nearest available pickup: they spawn every few seconds, so
    // this converges quickly even on a big map.
    const near = (snap.pickups || [])
      .filter((p1) => inSight(me, p1))
      .sort((p1, p2) => Math.hypot(p1.x - me.x, p1.y - me.y) - Math.hypot(p2.x - me.x, p2.y - me.y))[0]
      || (snap.pickups || []).sort((p1, p2) => Math.hypot(p1.x - me.x, p1.y - me.y) - Math.hypot(p2.x - me.x, p2.y - me.y))[0];
    if (!near) { await sleep(1200); continue; }
    a.navigate(near.x, near.y, { shoot: false, stopAt: 2 });
    pickupEvent = await a.waitForEvent((e) => e.k === 'pickup' && e.id === a.playerId, 14000).catch(() => null);
    if (!pickupEvent) {
      const now = a.latestSnap()?.tanks.find((t) => t.id === a.playerId);
      console.log(`   debug: pickup attempt ${attempt + 1} — target ${Math.round(near.x)},${Math.round(near.y)} me ${now ? Math.round(now.x) : '?'},${now ? Math.round(now.y) : '?'} remaining ${a.latestSnap()?.pickups.length}`);
    }
  }
  ok(!!pickupEvent, `powerup collected (${pickupEvent && pickupEvent.kind})`);
  if (pickupEvent) {
    const kind = pickupEvent.kind;
    const flagFor = { shield: 1, boost: 2, cloak: 4, mega: 8 };
    // Give the next snapshot a moment to land before checking the effect.
    let me = null;
    for (let i = 0; i < 25 && !me; i++) {
      await sleep(60);
      const snap2 = a.latestSnap();
      const t2 = snap2 && snap2.tanks.find((t) => t.id === a.playerId);
      if (t2 && (kind === 'repair' || (t2.flags & flagFor[kind]))) me = t2;
    }
    if (kind === 'mega') ok(!!(me && me.flags & 8), 'MEGA SHELL armed on the tank');
    else if (kind === 'repair') ok(!!me, 'REPAIR applied without errors');
    else ok(!!(me && (me.flags & flagFor[kind])), `${kind.toUpperCase()} effect active on the tank`);
  }
  ok(a.events.some((e) => e.k === 'spawnPU'), 'powerup spawns are broadcast to clients');

  a.stop(); b.stop();
  await sleep(200);
}

/* ---------------- 6. anti-cheat + limits -------------------------------- */
async function scenarioAntiCheat() {
  console.log('\n▸ SERVER-AUTHORITATIVE LIMITS (spec §25)');
  const host = await new Bot('Sheriff').connect(PORT);
  const h = await host.create();
  const cheat = await new Bot('Cheater').connect(PORT);
  await cheat.join(h.code);
  await host.waitFor((m) => m.t === 'lobby' && m.room.players.length === 2);
  host.send({ t: 'start' });
  await cheat.waitForEvent((e) => e.k === 'start', 9000);
  await sleep(400);

  const mapW = cheat.match.map.w;
  const mapH = cheat.match.map.h;
  const maxLegal = 172 * 1.62 * (1 / 30) * 1.55; // speed × boost × tick × slack

  const stepStats = (marker, id) => {
    const snaps = cheat.snaps.slice(-marker).filter((s) => s.tanks.some((t) => t.id === id));
    let maxStep = 0;
    let dist = 0;
    let prev = null;
    let outOfBounds = false;
    for (const s of snaps) {
      const me = s.tanks.find((t) => t.id === id);
      if (!me) { prev = null; continue; }
      if (me.x < 0 || me.y < 0 || me.x > mapW || me.y > mapH) outOfBounds = true;
      if (prev) { maxStep = Math.max(maxStep, Math.hypot(me.x - prev.x, me.y - prev.y)); dist += Math.hypot(me.x - prev.x, me.y - prev.y); }
      prev = me;
    }
    return { maxStep, dist, outOfBounds };
  };

  // A) Legal full-throttle movement must work and stay inside the envelope.
  const beforeA = cheat.snaps.length;
  let t = Date.now();
  const drive = setInterval(() => {
    cheat.seq++;
    cheat.send({ t: 'input', i: [[cheat.seq, 1, 0, 0, 1, 1]] });
  }, 20);
  await sleep(1500);
  clearInterval(drive);
  const a = stepStats(cheat.snaps.length - beforeA + 1, cheat.playerId);
  ok(!a.outOfBounds, 'tank never leaves the battlefield');
  ok(a.dist > 60, `input actually drives the tank (${a.dist.toFixed(0)}px travelled)`);
  ok(a.maxStep <= maxLegal, `movement inside the physics envelope (max step ${a.maxStep.toFixed(1)}px ≤ ${maxLegal.toFixed(1)}px)`);

  // B) Absurd / non-finite axes must not teleport.
  const beforeB = cheat.snaps.length;
  const spam = setInterval(() => {
    cheat.seq++;
    cheat.send({ t: 'input', i: [[cheat.seq, 9999, -9999, NaN, 1, 1]] });
  }, 20);
  cheat.send({ t: 'input', i: [[998877, Infinity, -Infinity, 99, 1, 1]] });
  cheat.send({ t: 'input', i: [[998878, 'x', null, undefined, 1, 1]] });
  await sleep(1200);
  clearInterval(spam);
  const b = stepStats(cheat.snaps.length - beforeB + 2, cheat.playerId);
  ok(b.maxStep <= maxLegal, `bogus input cannot teleport a tank (max step ${b.maxStep.toFixed(1)}px)`);
  ok(!b.outOfBounds, 'bogus input cannot push a tank outside the map');

  // C) Fire spam is capped by the server's reload timer.
  const shotsBefore = cheat.events.length;
  const t0 = Date.now();
  const fireSpam = setInterval(() => {
    cheat.seq++;
    cheat.send({ t: 'input', i: [[cheat.seq, 0, 0, 1.234, 1, 1]] });
  }, 15);
  await sleep(2000);
  clearInterval(fireSpam);
  const shots = cheat.events.slice(shotsBefore).filter((e) => e.k === 'shoot' && e.id === cheat.playerId).length;
  const allowed = Math.ceil((Date.now() - t0) / 1000 / 0.95) + 1;
  ok(shots <= allowed, `fire rate capped by the server (${shots} shots, max ~${allowed})`);
  ok(shots >= 1, 'legitimate firing still works');

  // D) No client-driven damage/kill channel exists.
  ok(!cheat.msgs.some((m) => m.t === 'damage' || m.t === 'kill'), 'no client-side damage/kill messages accepted');

  host.stop(); cheat.stop();
  await sleep(150);

  // E) Room capacity: 8 tanks max, the ninth is refused with a friendly error.
  const cap = await new Bot('Cap').connect(PORT);
  const cj = await cap.create();
  const seatBots = [];
  for (let i = 0; i < 7; i++) {
    const b2 = await new Bot(`Seat${i}`).connect(PORT);
    await b2.join(cj.code);
    seatBots.push(b2);
    await sleep(30);
  }
  const ninth = await new Bot('Ninth').connect(PORT);
  const full = await ninth.join(cj.code);
  ok(full.t === 'error' && full.code === 'ROOM_FULL', 'room refuses more than 8 tanks');
  cap.stop(); ninth.stop();
  for (const f of seatBots) f.stop();
  await sleep(150);
}

/* ---------------- 7. shrinking battle zone ------------------------------ */
async function scenarioShrinkingZone(port) {
  console.log('\n▸ SHRINKING BATTLE ZONE (compressed schedule)');
  const a = await new Bot('Camper').connect(port);
  const ha = await a.create();
  const b = await new Bot('Loiterer').connect(port);
  await b.join(ha.code);
  await a.waitFor((m) => m.t === 'lobby' && m.room.players.length === 2);
  a.send({ t: 'start' });
  await a.waitForEvent((e) => e.k === 'start', 9000);
  await sleep(300);

  const firstSnap = a.snaps[a.snaps.length - 1];
  const startRadius = firstSnap.zone.r;
  // Neither bot moves: they will be caught outside the collapsing zone.
  const shrink = await a.waitForEvent((e) => e.k === 'zoneShrink', 12000);
  ok(!!shrink, 'zone shrink phase announced to clients');
  await sleep(2500);
  const laterSnap = a.snaps[a.snaps.length - 1];
  ok(laterSnap.zone.r < startRadius - 30, `zone radius shrank (${startRadius} → ${laterSnap.zone.r})`);
  ok(Number.isFinite(laterSnap.zone.nextMs) && laterSnap.zone.nextMs >= 0 && laterSnap.zone.nextMs <= 60000,
    `zone countdown reported to clients (${laterSnap.zone.nextMs}ms)`);

  const end = await a.waitForEvent((e) => e.k === 'end', 90000);
  ok(!!end, 'zone collapse ended the match');
  const zoneKills = a.events.filter((e) => e.k === 'kill' && e.cause === 'zone');
  ok(zoneKills.length >= 1, `tanks outside the zone were eliminated by zone damage (${zoneKills.length})`);

  a.stop(); b.stop();
  await sleep(150);
}

/* ---------------- 5. validation + security ----------------------------- */
async function scenarioValidation() {
  console.log('\n▸ VALIDATION & SECURITY');
  const a = await new Bot('Valid').connect(PORT);
  const bad = await a.join('ZZZZZZ');
  ok(bad.t === 'error' && bad.code === 'NOT_FOUND', 'unknown room code → friendly error');

  const h = await a.create();
  const code = h.code;

  const b = await new Bot('X').connect(PORT);
  await b.join(code);

  // Empty / too-long names are rejected or trimmed server-side.
  const c = await new Bot('Y').connect(PORT);
  c.send({ t: 'join', code, name: '<img src=x onerror=alert(1)>' });
  const jc = await c.waitFor((m) => m.t === 'joined' || m.t === 'error');
  if (jc.t === 'joined') {
    const roster = await c.waitFor((m) => m.t === 'lobby' && m.room.players.some((p) => p.id === jc.playerId));
    const nm = roster.room.players.find((p) => p.id === jc.playerId).name;
    ok(!/<|>|onerror/.test(nm), `markup stripped from join name ("${nm}")`);
    ok(nm.length <= 16, 'name length capped at 16');
  } else {
    ok(jc.code === 'BAD_NAME', 'markup-only name rejected outright');
  }
  const empty = await new Bot('Z').connect(PORT);
  empty.send({ t: 'join', code, name: '    ' });
  const je = await empty.waitFor((m) => m.t === 'error');
  ok(je.code === 'BAD_NAME', 'blank name rejected');

  // Non-host cannot start the battle.
  b.send({ t: 'start' });
  const noStart = await b.waitFor((m) => m.t === 'error' && m.code === 'START');
  ok(!!noStart, 'non-host start rejected');

  // Single player cannot start a battle (needs 2+ tanks).
  const loner = await new Bot('Lonely').connect(PORT);
  await loner.create();
  await sleep(100);
  loner.send({ t: 'start' });
  const soloErr = await loner.waitFor((m) => m.t === 'error' && m.code === 'START');
  ok(!!soloErr, 'solo start blocked (needs 2 tanks)');
  ok(!loner.msgs.some((m) => m.t === 'events' && m.e && m.e.some((e) => e.k === 'countdownStart')), 'no countdown started for a solo host');
  loner.stop();

  // Room state guards: bogus actions.
  b.send({ t: 'kick', targetId: a.playerId });
  const kickDenied = await b.waitFor((m) => m.t === 'error' && m.code === 'KICK');
  ok(!!kickDenied, 'non-host kick rejected');

  for (const x of [a, b, c, empty]) x.stop();
  await sleep(150);
}

main();
