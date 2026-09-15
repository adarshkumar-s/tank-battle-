// TANKFALL — wire protocol. Client → server messages are *intents* only.
// The server is authoritative for every value that affects the match.

export const C2S = {
  CREATE: 'create', JOIN: 'join', REJOIN: 'rejoin',
  INPUT: 'input', RENAME: 'rename', READY: 'ready', START: 'start',
  KICK: 'kick', MOVE_PLAYER: 'movePlayer', REMATCH: 'rematch', SPECTATE: 'spectate',
  PING: 'ping', CHAT: 'chat', SELECT_TANK: 'selectTank', SELECT_MAP: 'selectMap',
};

export const S2C = {
  HELLO: 'hello', JOINED: 'joined', LOBBY: 'lobby', MATCH: 'match', SNAP: 'snap',
  EVENTS: 'events', PONG: 'pong', ERROR: 'error', CHAT: 'chat',
};

export const ERRORS = {
  NOT_FOUND: 'Battle room not found.', ROOM_FULL: 'That battle room is full (8 tanks max).',
  STARTED: 'That battle has already started.', BAD_CODE: 'Enter a 6-character room code.',
  BAD_NAME: 'Please enter a name (max 16 characters).', NOT_HOST: 'Only the host can do that.',
  WRONG_STATE: 'That action is not allowed right now.', KICKED: 'You were removed from the battle room.',
  RATE: 'Slow down a little!', SERVER: 'Server error. Please try again.',
  NEED_PLAYERS: 'At least 2 tanks are needed to start a battle.', CLOSED: 'That battle room has closed.',
};
export const ERROR_CODES = Object.fromEntries(Object.entries(ERRORS).map(([k, v]) => [v, k]));

export function sanitizeName(input, maxLen = 16) {
  if (typeof input !== 'string') return null;
  let s = input.normalize('NFKC').replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
    .replace(/[<>{}\\$`"'|/\[\]*_]/g, '').replace(/[\u200b-\u200f\u2028\u2029\ufeff]/g, '')
    .replace(/\s+/g, ' ').trim();
  if (!s) return null; if (s.length > maxLen) s = s.slice(0, maxLen).trim(); return s || null;
}
export function sanitizeRoomCode(input) { if (typeof input !== 'string') return null; const s = input.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6); return s.length === 6 ? s : null; }
export function sanitizeChat(input, maxLen = 140) { if (typeof input !== 'string') return null; const s = input.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maxLen); return s.length ? s : null; }