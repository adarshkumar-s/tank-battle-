// TANKFALL — server entry point.
// Serves the client (static files) and runs the authoritative game loop over
// a single WebSocket endpoint at /ws. One process, one origin: whatever host
// the player loads the page from is the host they connect back to, so multiple
// phones/laptops on the same URL share the same battle rooms.

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

import { NET, ROOM_STATE, SIM_HZ, ZONE } from '../shared/constants.js';
import { sanitizeName, sanitizeRoomCode, sanitizeChat, ERRORS } from '../shared/protocol.js';
import { sanitizeInput } from '../shared/physics.js';
import { RoomManager } from './room.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const SHARED_DIR = path.join(ROOT, 'shared');
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';

// Test hook: compress the zone schedule so the shrinking-zone behaviour can be
// exercised without waiting minutes. Never set in production.
const ZONE_SCALE = Number(process.env.TANKFALL_ZONE_SCALE || 0);
if (ZONE_SCALE > 0) {
  for (const phase of ZONE.phases) {
    phase.waitMs = Math.max(1200, Math.round(phase.waitMs * ZONE_SCALE));
    phase.shrinkMs = Math.max(1200, Math.round(phase.shrinkMs * ZONE_SCALE));
    phase.radius = Math.max(140, Math.round(phase.radius * 0.55));
  }
  ZONE.startRadius = Math.max(620, Math.round(ZONE.startRadius * 0.55));
  console.log(`[tankfall] zone test scale x${ZONE_SCALE} enabled`);
}

const rooms = new RoomManager();

/* ------------------------------------------------------------------ *
 * Static file serving
 * ------------------------------------------------------------------ */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webmanifest': 'application/manifest+json',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

function safeJoin(root, urlPath) {
  let clean;
  try {
    clean = decodeURIComponent(urlPath.split('?')[0].split('#')[0]);
  } catch {
    return null;
  }
  // Normalize, then strip any leading traversal before resolving inside root.
  const rel = path.posix.normalize('/' + clean).replace(/^\/+/, '').replace(/^(\.\.\/)+/, '');
  const resolved = path.resolve(root, rel);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) return null;
  return resolved;
}

async function serveFile(res, filePath, { spa = false } = {}) {
  try {
    const stat = await fsp.stat(filePath).catch(() => null);
    let target = filePath;
    if (!stat || stat.isDirectory()) {
      if (!spa) { return sendText(res, 404, 'Not found'); }
      target = path.join(PUBLIC_DIR, 'index.html');
    }
    const data = await fsp.readFile(target);
    const ext = path.extname(target).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': data.length,
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=0, must-revalidate',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    });
    res.end(data);
  } catch {
    sendText(res, 500, 'Server error');
  }
}

function sendText(res, code, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(code, {
    'Content-Type': type,
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const url = req.url || '/';
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return sendText(res, 405, 'Method not allowed');
  }

  if (url === '/healthz') return sendJson(res, 200, { ok: true, rooms: rooms.size, uptime: process.uptime() });
  if (url.startsWith('/api/rooms')) return sendJson(res, 200, { rooms: rooms.list() });

  // Shared ES modules are served from the same origin the client loads.
  if (url.startsWith('/shared/')) {
    const file = safeJoin(SHARED_DIR, url.slice('/shared/'.length));
    if (!file) return sendText(res, 400, 'Bad request');
    return serveFile(res, file);
  }
  // Player-facing routes with a room code in the path.
  if (url.startsWith('/r/') || url === '/' || url.startsWith('/index.html')) {
    return serveFile(res, path.join(PUBLIC_DIR, 'index.html'));
  }
  const file = safeJoin(PUBLIC_DIR, url);
  if (!file) return sendText(res, 400, 'Bad request');
  return serveFile(res, file, { spa: true });
});

/* ------------------------------------------------------------------ *
 * WebSocket endpoint
 * ------------------------------------------------------------------ */
const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });

server.on('upgrade', (req, socket, head) => {
  const url = req.url || '';
  if (!url.startsWith('/ws')) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

function send(ws, msg) {
  if (!ws || ws.readyState !== 1) return;
  try { ws.send(JSON.stringify(msg)); } catch { /* ignore */ }
}

function sendError(ws, code, message) {
  send(ws, { t: 'error', code, message });
}

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.playerRef = null;
  ws.tokens = 120;              // simple token bucket (messages per second)
  ws.lastRefill = Date.now();
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (data, isBinary) => {
    if (isBinary) return;
    const now = Date.now();
    const elapsed = (now - ws.lastRefill) / 1000;
    ws.lastRefill = now;
    ws.tokens = Math.min(NET.maxMessagesPerSec, ws.tokens + elapsed * NET.maxMessagesPerSec);
    ws.tokens -= 1;
    if (ws.tokens <= 0) {
      sendError(ws, 'RATE', ERRORS.RATE);
      return;
    }

    let msg;
    try {
      msg = JSON.parse(data.toString('utf8'));
    } catch {
      return;
    }
    if (!msg || typeof msg.t !== 'string') return;
    try {
      handleMessage(ws, msg);
    } catch (err) {
      console.error('[tankfall] message error', err);
      sendError(ws, 'SERVER', ERRORS.SERVER);
    }
  });

  ws.on('close', () => {
    const player = ws.playerRef;
    if (!player) return;
    if (player.ws !== ws) return; // a newer socket already took over this seat
    const room = rooms.get(player.roomCode);
    if (!room) return;
    room.handleDisconnect(player);
  });

  ws.on('error', () => { /* close handler does the cleanup */ });
});

function handleMessage(ws, msg) {
  switch (msg.t) {
    case 'create': return onJoin(ws, msg, true);
    case 'join': return onJoin(ws, msg, false);
    case 'rejoin': return onRejoin(ws, msg);
    case 'input': return onInput(ws, msg);
    case 'rename': return onRename(ws, msg);
    case 'ready': return onReady(ws, msg);
    case 'start': return onStart(ws, msg);
    case 'kick': return onKick(ws, msg);
    case 'move': return onMove(ws, msg);
    case 'rematch': return onRematch(ws, msg);
    case 'list': {
      const list = rooms.list();
      return send(ws, { t: 'rooms', rooms: list });
    }
    case 'chat': return onChat(ws, msg);
    case 'ping':
      return send(ws, { t: 'pong', t: msg.t });
    default:
      return;
  }
}

function onJoin(ws, msg, isCreate) {
  if (ws.playerRef) {
    sendError(ws, 'DUPLICATE', 'This connection already joined a battle room.');
    return;
  }
  const name = sanitizeName(msg.name, NET.maxNameLen);
  if (!name) {
    sendError(ws, 'BAD_NAME', ERRORS.BAD_NAME);
    return;
  }

  let room;
  if (isCreate) {
    room = rooms.createRoom();
  } else {
    const code = sanitizeRoomCode(msg.code);
    if (!code) {
      sendError(ws, 'BAD_CODE', ERRORS.BAD_CODE);
      return;
    }
    room = rooms.get(code);
    if (!room) {
      sendError(ws, 'NOT_FOUND', ERRORS.NOT_FOUND);
      return;
    }
    if (room.removed) {
      sendError(ws, 'CLOSED', ERRORS.CLOSED);
      return;
    }
    if (room.state !== ROOM_STATE.WAITING && room.state !== ROOM_STATE.FINISHED) {
      sendError(ws, 'STARTED', ERRORS.STARTED);
      return;
    }
    if (room.players.size >= NET.maxPlayers) {
      sendError(ws, 'ROOM_FULL', ERRORS.ROOM_FULL);
      return;
    }
  }

  const player = room.addPlayer({ name, originalName: name });
  player.ws = ws;
  player.connected = true;
  ws.playerRef = player;

  send(ws, {
    t: 'joined',
    code: room.code,
    playerId: player.id,
    token: player.token,
    color: player.color,
    name: player.name,
    state: room.state,
  });

  if (room.state === ROOM_STATE.PLAYING || room.state === ROOM_STATE.FINISHED) {
    room.sendWorldSync(player);
  } else {
    room.pushEvent({ k: 'join', id: player.id, name: player.name });
    room.pushEvent({ k: 'notice', text: `🎉 ${player.name} joined the battle` });
  }
  room.broadcastLobby();
  console.log(`[tankfall] ${player.name} joined ${room.code} (${room.activeCount()}/${NET.maxPlayers})`);
}

function onRejoin(ws, msg) {
  if (ws.playerRef) return;
  const code = sanitizeRoomCode(msg.code);
  const playerId = Number(msg.playerId);
  const token = typeof msg.token === 'string' ? msg.token : '';
  if (!code || !Number.isInteger(playerId) || !token) {
    sendError(ws, 'BAD_CODE', ERRORS.BAD_CODE);
    return;
  }
  const room = rooms.get(code);
  if (!room) {
    sendError(ws, 'NOT_FOUND', ERRORS.NOT_FOUND);
    return;
  }
  const player = room.players.get(playerId);
  if (!player || player.leftPermanently || player.token !== token) {
    sendError(ws, 'NOT_FOUND', 'Your seat in that battle room is gone. Join again with the room code.');
    return;
  }
  const name = sanitizeName(msg.name, NET.maxNameLen);
  if (name && !player.hostAssigned) {
    player.name = name;
    if (!player.originalName) player.originalName = name;
  }
  room.rejoin(player, ws);
  ws.playerRef = player;

  send(ws, {
    t: 'joined',
    code: room.code,
    playerId: player.id,
    token: player.token,
    color: player.color,
    name: player.name,
    state: room.state,
    reconnected: true,
  });
  if (room.state === ROOM_STATE.PLAYING || room.state === ROOM_STATE.FINISHED) {
    room.sendWorldSync(player);
  }
  room.broadcastLobby();
  console.log(`[tankfall] ${player.name} reconnected to ${room.code}`);
}

function playerRoom(ws) {
  const player = ws.playerRef;
  if (!player) return { player: null, room: null };
  const room = rooms.get(player.roomCode);
  return { player, room };
}

function onInput(ws, msg) {
  const { player, room } = playerRoom(ws);
  if (!player || !room) return;
  const arr = msg.i;
  if (!Array.isArray(arr)) return;
  const limit = Math.min(arr.length, 40);
  for (let n = 0; n < limit; n++) {
    const it = arr[n];
    if (!Array.isArray(it) || it.length < 5) continue;
    const seq = Number(it[0]);
    if (!Number.isFinite(seq) || seq <= player.lastInputSeq) continue; // ignore stale/duplicates
    player.lastInputSeq = seq;
    player.input = sanitizeInput({
      mx: it[1], my: it[2], turret: it[3], fire: it[4] === 1 || it[4] === true, boost: it[5] === 1 || it[5] === true,
    });
    player.lastInputAt = Date.now();
  }
}

function onRename(ws, msg) {
  const { player, room } = playerRoom(ws);
  if (!player || !room) return;
  const targetId = Number(msg.targetId);
  const res = room.doRename(player, Number.isInteger(targetId) ? targetId : player.id, msg.name);
  if (res.error) sendError(ws, 'RENAME', res.error);
}

function onReady(ws, msg) {
  const { player, room } = playerRoom(ws);
  if (!player || !room) return;
  const res = room.doReady(player, msg.value);
  if (res.error) sendError(ws, 'READY', res.error);
}

function onStart(ws) {
  const { player, room } = playerRoom(ws);
  if (!player || !room) return;
  if (!room.isHost(player)) return sendError(ws, 'START', ERRORS.NOT_HOST);
  if (room.state !== ROOM_STATE.WAITING) return sendError(ws, 'START', ERRORS.WRONG_STATE);
  if (!room.beginCountdown()) return sendError(ws, 'START', ERRORS.NEED_PLAYERS);
}

function onKick(ws, msg) {
  const { player, room } = playerRoom(ws);
  if (!player || !room) return;
  const res = room.doKick(player, Number(msg.targetId));
  if (res.error) sendError(ws, 'KICK', res.error);
}

function onMove(ws, msg) {
  const { player, room } = playerRoom(ws);
  if (!player || !room) return;
  const res = room.doMove(player, Number(msg.targetId), !!msg.up);
  if (res.error) sendError(ws, 'MOVE', res.error);
}

function onRematch(ws, msg) {
  const { player, room } = playerRoom(ws);
  if (!player || !room) return;
  if (!room.isHost(player)) return sendError(ws, 'REMATCH', ERRORS.NOT_HOST);
  if (room.state !== ROOM_STATE.FINISHED) return sendError(ws, 'REMATCH', ERRORS.WRONG_STATE);
  room.resetToLobby();
  if (msg.start) room.beginCountdown();
}

function onChat(ws, msg) {
  const { player, room } = playerRoom(ws);
  if (!player || !room) return;
  const now = Date.now();
  if (now - player.lastChatAt < 700) return;
  const text = sanitizeChat(msg.text);
  if (!text) return;
  player.lastChatAt = now;
  room.broadcast({ t: 'chat', from: player.id, name: player.name, text, at: now });
}

/* ------------------------------------------------------------------ *
 * Authoritative loop
 * ------------------------------------------------------------------ */
let last = process.hrtime.bigint();
let acc = 0;
const LOOP_HZ = 60;

setInterval(() => {
  const now = process.hrtime.bigint();
  let dt = Number(now - last) / 1e9;
  last = now;
  if (dt > 0.25) dt = 0.25;
  acc += dt;
  const step = 1 / LOOP_HZ;
  let guard = 0;
  while (acc >= step && guard < 6) {
    rooms.tickAll(step);
    acc -= step;
    guard++;
  }
  if (acc > step * 8) acc = 0;
}, 1000 / LOOP_HZ);

setInterval(() => {
  rooms.cleanup();
  for (const client of wss.clients) {
    if (client.isAlive === false) { client.terminate(); continue; }
    client.isAlive = false;
    try { client.ping(); } catch { /* ignore */ }
  }
}, 30000);

server.listen(PORT, HOST, () => {
  console.log(`[tankfall] LAST TANK STANDING — listening on http://${HOST}:${PORT}`);
  console.log(`[tankfall] sim ${SIM_HZ}Hz · rooms in memory · max ${NET.maxPlayers} tanks per room`);
});

function shutdown() {
  console.log('[tankfall] shutting down…');
  for (const client of wss.clients) {
    send(client, { t: 'error', code: 'SERVER', message: 'Server is restarting — reconnect in a moment.' });
    try { client.close(1001, 'server shutdown'); } catch { /* noop */ }
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('uncaughtException', (err) => console.error('[tankfall] uncaught', err));
process.on('unhandledRejection', (err) => console.error('[tankfall] unhandled', err));

export { server, rooms, wss };
