// TANKFALL — wire protocol. Client → server messages are *intents* only.
// The server is authoritative for every value that affects the match.

export const C2S = {
  CREATE: 'create',      // { name, sessionId? }
  JOIN: 'join',          // { code, name, sessionId? }
  REJOIN: 'rejoin',      // { code, playerId, token }
  INPUT: 'input',        // { inputs: [[seq, mx, my, turret, fire, boost], ...] }
  RENAME: 'rename',      // { targetId, name }        host only, WAITING only
  READY: 'ready',        // { value }
  START: 'start',        // {}
  KICK: 'kick',          // { targetId }              host only, WAITING only
  MOVE_PLAYER: 'movePlayer', // { targetId, up }      host only, WAITING only
  REMATCH: 'rematch',    // host only, FINISHED only
  SPECTATE: 'spectate',  // { type: 'player'|'free', id? }
  PING: 'ping',          // { t }
  CHAT: 'chat',          // { text }
};

export const S2C = {
  HELLO: 'hello',        // { playerId, token, ... }
  JOINED: 'joined',      // { room, you, map, config }
  LOBBY: 'lobby',        // { room }  (WAITING / COUNTDOWN / FINISHED)
  MATCH: 'match',        // { phase, map/seed, you, players, countdown }
  SNAP: 'snap',          // binary
  EVENTS: 'events',      // { e: [...] }
  PONG: 'pong',          // { t }
  ERROR: 'error',        // { code, message }
  CHAT: 'chat',          // { from, name, text, t }
};

export const ERRORS = {
  NOT_FOUND: 'Battle room not found.',
  ROOM_FULL: 'That battle room is full (8 tanks max).',
  STARTED: 'That battle has already started.',
  BAD_CODE: 'Enter a 6-character room code.',
  BAD_NAME: 'Please enter a name (max 16 characters).',
  NOT_HOST: 'Only the host can do that.',
  WRONG_STATE: 'That action is not allowed right now.',
  KICKED: 'You were removed from the battle room.',
  RATE: 'Slow down a little!',
  SERVER: 'Server error. Please try again.',
  NEED_PLAYERS: 'At least 2 tanks are needed to start a battle.',
  CLOSED: 'That battle room has closed.',
};

export const ERROR_CODES = Object.fromEntries(
  Object.entries(ERRORS).map(([k, v]) => [v, k])
);

/** Friendly, injection-free name sanitation. Server is the authority. */
export function sanitizeName(input, maxLen = 16) {
  if (typeof input !== 'string') return null;
  // Strip anything that is not a printable, safe character and collapse spaces.
  let s = input
    .normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
    .replace(/[<>{}\\$`"'|/\[\]*_]/g, '')
    .replace(/[\u200b-\u200f\u2028\u2029\ufeff]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (s.length === 0) return null;
  if (s.length > maxLen) s = s.slice(0, maxLen).trim();
  if (s.length === 0) return null;
  return s;
}

export function sanitizeRoomCode(input) {
  if (typeof input !== 'string') return null;
  const s = input.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
  return s.length === 6 ? s : null;
}

export function sanitizeChat(input, maxLen = 140) {
  if (typeof input !== 'string') return null;
  const s = input.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maxLen);
  return s.length ? s : null;
}
