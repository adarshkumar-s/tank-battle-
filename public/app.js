// TANKFALL — application bootstrap.
// Wires the UI, the WebSocket client and the render/game loop together and
// owns the high-level flow: home → lobby → countdown → battle → results.

import { Net } from './client/net.js';
import { Input } from './client/input.js';
import { Hud } from './client/hud.js';
import { Audio } from './client/audio.js';
import { Renderer } from './client/render.js';
import { ClientGame } from './client/game.js';
import { ROOM_STATE, POWERUP_INFO } from '/shared/constants.js';

const SOUND_KEY = 'tankfall.sound.v1';

const audio = new Audio();
let hud;
let net;
let game;
let me = null;
let lastRoom = null;
let lastEndEvent = null;
let resultsTimer = null;
let roomsTimer = null;

/* ------------------------------------------------------------------ *
 * Boot
 * ------------------------------------------------------------------ */
const canvas = document.getElementById('game');
const minimap = document.getElementById('minimap');
const renderer = new Renderer(canvas);

const input = new Input({
  joyZone: document.getElementById('joyZone'),
  joyBase: document.getElementById('joyBase'),
  joyKnob: document.getElementById('joyKnob'),
  btnFire: document.getElementById('btnFire'),
  btnBoost: document.getElementById('btnBoost'),
  canvas,
});

net = new Net({
  onOpen() {
    hud.setReconnecting(false);
    if (net.session && net.session.code && !me) {
      net.send({ t: 'rejoin', code: net.session.code, playerId: net.session.playerId, token: net.session.token, name: hud.$.nameInput.value.trim() || net.session.name }, false);
    }
  },
  onClose() {
    hud.setReconnecting(true);
  },
  onReconnecting(attempt) {
    hud.setReconnecting(true);
  },
  onMessage: handleMessage,
  onSnapshot: (snap) => game?.onSnapshot(snap),
});

hud = new Hud({
  ui: () => audio.ui(),
  create: (name) => createRoom(name),
  join: (code) => joinRoom(code),
  refreshRooms: () => fetchRooms(),
  toggleSound: () => toggleSound(),
  copy: () => copyCode(),
  share: () => shareRoom(),
  start: () => net.send({ t: 'start' }),
  toggleReady: () => net.send({ t: 'ready', value: !(lastRoom?.players.find((p) => p.id === me?.id)?.ready) }),
  leave: () => leaveRoom(),
  rename: (targetId, name) => {
    if (!targetId) return;
    net.send({ t: 'rename', targetId, name });
  },
  kick: (targetId) => net.send({ t: 'kick', targetId }),
  chat: (text) => net.send({ t: 'chat', text }),
  playAgain: () => net.send({ t: 'rematch', start: true }),
  backToLobby: () => {
    if (lastRoom && lastRoom.state === ROOM_STATE.FINISHED && me && lastRoom.hostId === me.id) {
      net.send({ t: 'rematch' });
    }
  },
  spectate: (dir) => game?.spectateNext(dir),
});

game = new ClientGame({ canvas, minimap, input, net, audio, hud, renderer });
game.start();

/* ------------------------------------------------------------------ *
 * Message handling
 * ------------------------------------------------------------------ */
function handleMessage(msg) {
  switch (msg.t) {
    case 'joined': {
      me = { id: msg.playerId, name: msg.name, color: msg.color };
      net.saveSession({
        code: msg.code, playerId: msg.playerId, token: msg.token, name: msg.name, at: Date.now(),
      });
      hud.setName(msg.name);
      hud.clearActivity();
      hud.setCode(msg.code);
      hud.showScreen('lobby');
      if (msg.reconnected) hud.toast('🔌 Reconnected to the battle', 'warn');
      if (msg.state === ROOM_STATE.FINISHED || msg.state === ROOM_STATE.PLAYING) {
        // World sync follows; keep the battle view alive.
      }
      break;
    }
    case 'lobby': {
      lastRoom = msg.room;
      if (me) {
        const mine = msg.room.players.find((p) => p.id === me.id);
        if (mine) { me.name = mine.name; me.color = mine.color; }
      }
      if (msg.room.state === ROOM_STATE.WAITING) {
        if (game.phase !== 'IDLE') game.resetToLobby();
        if (hud.screen !== 'lobby') hud.showScreen('lobby');
        hud.renderLobby(msg.room, me);
        startRoomsWatch(false);
      } else if (msg.room.state === ROOM_STATE.COUNTDOWN) {
        hud.renderLobby(msg.room, me);
      } else if (msg.room.state === ROOM_STATE.FINISHED) {
        hud.renderLobby(msg.room, me);
        if (msg.room.results && hud.screen === 'results') {
          hud.renderResults(msg.room, me, lastEndEvent?.durationMs);
        } else if (msg.room.results && hud.screen === 'battle') {
          // Reconnected (or missed the end event) after the match ended — still
          // bring the player to the scoreboard instead of leaving them stuck.
          watchForResults();
        }
      }
      break;
    }
    case 'match': {
      const mine = msg.you ? msg.players.find((p) => p.playerId === msg.you.playerId) : null;
      me = {
        id: msg.you.playerId,
        tankId: msg.you.tankId,
        name: mine ? mine.name : (me?.name || 'TANK'),
        color: msg.you.color,
      };
      game.startMatch(msg);
      hud.showScreen('battle');
      input.setEnabled(true);
      if (audio.enabled) audio.startAmbience();
      hud.showCountdown('FIRE');
      break;
    }
    case 'sync': {
      game.applySync(msg);
      if (msg.state === ROOM_STATE.PLAYING || msg.state === 'PLAYING') {
        hud.showScreen('battle');
        input.setEnabled(true);
      }
      break;
    }
    case 'events': game.onEvents(msg.e); break;
    case 'chat': {
      const p = lastRoom?.players.find((x) => x.id === msg.from);
      hud.chat(msg.name, msg.text, p?.color);
      if (hud.screen === 'battle') hud.toast(`💬 ${msg.name}: ${msg.text}`);
      break;
    }
    case 'rooms': hud.renderRooms(msg.rooms); break;
    case 'error': handleError(msg); break;
    default: break;
  }
}

function handleError(msg) {
  const text = msg.message || 'Something went wrong.';
  hud.toast(text, 'warn');
  hud.activity(`⚠️ ${text}`);
  if (msg.code === 'NOT_FOUND' || msg.code === 'CLOSED' || msg.code === 'KICKED' || msg.code === 'STARTED') {
    if (msg.code !== 'STARTED') {
      net.clearSession();
      me = null;
      lastRoom = null;
      game.resetToLobby();
      hud.showScreen('home');
      fetchRooms();
      startRoomsWatch(true);
    }
  }
}

/* ------------------------------------------------------------------ *
 * Flows
 * ------------------------------------------------------------------ */
function createRoom(name) {
  const clean = name || hud.$.nameInput.value.trim();
  if (!clean) {
    hud.toast('Pick a callsign first (max 16 characters).', 'warn');
    hud.$.nameInput.focus();
    return;
  }
  if (!net.connected) {
    hud.toast('Connecting to the battlefield…', 'warn');
    net.open();
  }
  net.send({ t: 'create', name: clean });
}

function joinRoom(code) {
  const name = hud.$.nameInput.value.trim();
  if (!name) {
    hud.toast('Pick a callsign first.', 'warn');
    hud.$.nameInput.focus();
    return;
  }
  const cleanCode = (code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (cleanCode.length !== 6) {
    hud.toast('Enter the 6-character room code.', 'warn');
    hud.$.codeInput.focus();
    return;
  }
  net.clearSession();
  net.send({ t: 'join', code: cleanCode, name });
}

function leaveRoom() {
  const code = net.session?.code;
  net.clearSession();
  me = null;
  lastRoom = null;
  if (net.ws && net.ws.readyState === 1) net.ws.close(1000, 'left');
  net.closedByUser = false;
  setTimeout(() => net.open(), 120);
  game.resetToLobby();
  hud.showScreen('home');
  fetchRooms();
  startRoomsWatch(true);
}

function toggleSound() {
  const on = !audio.enabled;
  audio.setEnabled(on);
  try { localStorage.setItem(SOUND_KEY, on ? '1' : '0'); } catch { /* ignore */ }
  hud.setSound(on);
  if (on) {
    audio.ui();
    if (game.phase === 'PLAYING') audio.startAmbience();
  }
}

async function copyCode() {
  const code = lastRoom?.code || net.session?.code || '';
  if (!code) return;
  const ok = await copyText(code);
  hud.toast(ok ? `📋 Copied room code ${code}` : `Room code: ${code}`, ok ? '' : 'warn');
  if (ok) {
    const btn = hud.$.btnCopy;
    const old = btn.textContent;
    btn.textContent = 'COPIED!';
    setTimeout(() => { btn.textContent = old; }, 1400);
  }
}

async function shareRoom() {
  const code = lastRoom?.code || net.session?.code || '';
  const url = `${location.origin}/r/${code}`;
  const text = `Join my TANKFALL battle! Room code: ${code}`;
  if (navigator.share) {
    try {
      await navigator.share({ title: 'TANKFALL', text, url });
      return;
    } catch { /* user cancelled → fall through to copy */ }
  }
  const ok = await copyText(`${text} — ${url}`);
  hud.toast(ok ? '📋 Invite copied — paste it to your friends' : url, ok ? '' : 'warn');
}

async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* fall through */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ *
 * Open room browser
 * ------------------------------------------------------------------ */
async function fetchRooms() {
  try {
    const res = await fetch('/api/rooms', { cache: 'no-store' });
    if (!res.ok) throw new Error('bad status');
    const data = await res.json();
    hud.renderRooms(data.rooms || []);
  } catch {
    hud.renderRooms([]);
  }
}

function startRoomsWatch(on) {
  clearInterval(roomsTimer);
  roomsTimer = null;
  if (on) {
    roomsTimer = setInterval(fetchRooms, 5000);
  }
}

/* ------------------------------------------------------------------ *
 * Results screen timing
 * ------------------------------------------------------------------ */
function watchForResults() {
  clearTimeout(resultsTimer);
  resultsTimer = setTimeout(() => {
    if (lastRoom && lastRoom.results && lastRoom.results.length) {
      hud.renderResults(lastRoom, me, lastEndEvent?.durationMs);
    } else {
      // Results not here yet (slow socket) — try again shortly.
      watchForResults();
    }
  }, 2400);
}

/* Hook the end-of-match moment in the game event stream. */
const origOnEvents = game.onEvents.bind(game);
game.onEvents = (events) => {
  origOnEvents(events);
  for (const e of events) if (e.k === 'end') {
    lastEndEvent = e;
    watchForResults();
  }
};

/* ------------------------------------------------------------------ *
 * Viewport / DPR handling
 * ------------------------------------------------------------------ */
function onResize() {
  renderer.resize();
  game.updateCameraScale();
}
window.addEventListener('resize', onResize);
window.addEventListener('orientationchange', () => setTimeout(onResize, 250));
window.visualViewport?.addEventListener('resize', onResize);
document.addEventListener('visibilitychange', () => {
  game.paused = document.hidden;
  if (!document.hidden) { game._lastFrame = performance.now(); onResize(); }
});

/* ------------------------------------------------------------------ *
 * First interaction unlocks audio (browsers require a gesture)
 * ------------------------------------------------------------------ */
let audioUnlocked = false;
const unlock = () => {
  if (audioUnlocked) return;
  audioUnlocked = true;
  let wantSound = false;
  try { wantSound = localStorage.getItem(SOUND_KEY) === '1'; } catch { /* ignore */ }
  if (wantSound) {
    audio.setEnabled(true);
    hud.setSound(true);
    if (game.phase === 'PLAYING') audio.startAmbience();
  } else {
    hud.setSound(false);
  }
  rememberName();
  window.removeEventListener('pointerdown', unlock);
  window.removeEventListener('keydown', unlock);
};
window.addEventListener('pointerdown', unlock);
window.addEventListener('keydown', unlock);

function rememberName() {
  try {
    const saved = localStorage.getItem('tankfall.name');
    if (saved && !hud.$.nameInput.value) hud.$.nameInput.value = saved;
  } catch { /* ignore */ }
}
hud.$.nameInput.addEventListener('change', () => {
  try { localStorage.setItem('tankfall.name', hud.$.nameInput.value.trim()); } catch { /* ignore */ }
});

/* ------------------------------------------------------------------ *
 * Entry
 * ------------------------------------------------------------------ */
function boot() {
  renderer.resize();
  // Deep link: /r/CODE prefills the room code.
  const m = location.pathname.match(/\/r\/([A-Za-z0-9]{4,8})/);
  if (m) hud.setCode(m[1].toUpperCase().slice(0, 6));
  const sessionName = net.session?.name;
  if (sessionName) hud.setName(sessionName);
  else rememberName();
  hud.setSound(audio.enabled);
  hud.showScreen('home');
  net.open();
  fetchRooms();
  startRoomsWatch(true);
  // Resume the room we were in after a refresh (rejoin is sent on open).
  if (net.session?.code) {
    setTimeout(() => {
      if (!me && net.connected) {
        net.send({ t: 'rejoin', code: net.session.code, playerId: net.session.playerId, token: net.session.token, name: hud.$.nameInput.value.trim() || net.session.name });
      }
    }, 300);
  }
}

boot();

window.addEventListener('beforeunload', () => {
  net.close();
});

export { game, net, hud, audio, input, renderer };
