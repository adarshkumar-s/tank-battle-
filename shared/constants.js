// TANKFALL — shared constants used by both the authoritative server and the client.
// Keeping the numbers here means client-side prediction uses identical physics.

export const SIM_HZ = 30;
export const DT = 1 / SIM_HZ;

export const WORLD = { w: 2400, h: 1800 };

export const TANK = {
  radius: 19,
  speed: 172,
  accel: 11,
  hullTurn: 7.5,
  turretTurn: 8.5,
  maxHp: 100,
  reload: 0.95,
  megaReload: 1.35,
  bulletSpeed: 660,
  bulletRadius: 5,
  bulletLife: 1.45,
  damage: 22,
  megaDamage: 55,
  muzzleOffset: 30,
  boostMult: 1.62,
  boostHoldMult: 1.32,
  boostDrain: 42,
  boostRegen: 17,
};

export const POWERUP = {
  radius: 18,
  pickupRadius: 34,
  spawnIntervalMs: [7000, 13000],
  maxActive: 9,
  shieldAbsorb: 60,
  shieldMs: 12000,
  repairAmount: 45,
  boostMs: 8000,
  cloakMs: 9000,
};

export const POWERUP_KINDS = ['mega', 'shield', 'repair', 'boost', 'cloak'];

export const POWERUP_INFO = {
  mega:   { icon: '💥', label: 'MEGA SHELL',  color: '#ff7a29' },
  shield: { icon: '🛡', label: 'SHIELD',      color: '#4ea8ff' },
  repair: { icon: '🔧', label: 'REPAIR',      color: '#5ddc7a' },
  boost:  { icon: '⚡', label: 'BOOST',       color: '#ffd23f' },
  cloak:  { icon: '👻', label: 'CLOAK',      color: '#c48bff' },
};

export const FLAGS = { SHIELD: 1, BOOST: 2, CLOAK: 4, MEGA: 8 };

export const TANK_COLORS = [
  '#f2545b', '#3fa9f5', '#ffd23f', '#57cc99',
  '#c77dff', '#ff9f45', '#2ec4b6', '#ff7bd5',
];

export const ROOM_STATE = {
  WAITING: 'WAITING',
  COUNTDOWN: 'COUNTDOWN',
  PLAYING: 'PLAYING',
  FINISHED: 'FINISHED',
};

// The arena is bounded by permanent map walls. The old shrinking-zone
// mechanic is intentionally disabled: the enormous radius keeps the zone
// outside the playable map for the entire match.
export const ZONE = {
  startRadius: 100000,
  phases: [
    { waitMs: 1e12, shrinkMs: 1e12, radius: 100000, dps: 0 },
  ],
};

export const NET = {
  maxPlayers: 8,
  minPlayers: 2,
  countdownMs: 4200,
  countdownStepMs: 1000,
  reconnectGraceMs: 45000,
  tankGhostMs: 15000,
  hostGraceMs: 22000,
  emptyRoomTtlMs: 90000,
  roomTtlMs: 6 * 60 * 60 * 1000,
  maxNameLen: 16,
  maxInputsPerSec: 90,
  maxMessagesPerSec: 140,
  // No artificial six-minute arena timeout.
  matchHardCapMs: 7 * 24 * 60 * 60 * 1000,
  interpMs: 110,
  snapshotHz: SIM_HZ,
};

export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const ROOM_CODE_LEN = 6;

export const CAUSES = {
  SHOT: 'shot',
  BARREL: 'barrel',
  ZONE: 'zone',
  VANISH: 'vanish',
  SELF: 'self',
};

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;

export function angleDiff(from, to) {
  let d = (to - from) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

export function turnToward(from, to, maxDelta) {
  const d = angleDiff(from, to);
  if (Math.abs(d) <= maxDelta) return to;
  return from + Math.sign(d) * maxDelta;
}

export function dist2(ax, ay, bx, by) {
  const dx = ax - bx, dy = ay - by;
  return dx * dx + dy * dy;
}

export function dist(ax, ay, bx, by) {
  return Math.sqrt(dist2(ax, ay, bx, by));
}

export function makeRng(seed) {
  let a = seed >>> 0;
  return function rng() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}