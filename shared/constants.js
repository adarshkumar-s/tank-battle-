// TANKFALL — shared constants used by both the authoritative server and the client.
// Keeping the numbers here means client-side prediction uses identical physics.

export const SIM_HZ = 30;
export const DT = 1 / SIM_HZ;

export const WORLD = { w: 2400, h: 1800 };

export const TANK = {
  radius: 19,
  speed: 172,          // world units / second
  accel: 11,           // exponential approach rate
  hullTurn: 7.5,       // rad / s
  turretTurn: 8.5,     // rad / s
  maxHp: 100,
  reload: 0.95,        // seconds
  megaReload: 1.35,
  bulletSpeed: 660,
  bulletRadius: 5,
  bulletLife: 1.45,    // seconds
  damage: 22,
  megaDamage: 55,
  muzzleOffset: 30,
  boostMult: 1.62,      // ⚡ powerup multiplier
  boostHoldMult: 1.32,  // hold-BOOST ability multiplier
  boostDrain: 42,       // energy / second while boosting
  boostRegen: 17,       // energy / second while recovering
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
  cloak:  { icon: '👻', label: 'CLOAK',       color: '#c48bff' },
};

export const FLAGS = {
  SHIELD: 1,
  BOOST: 2,
  CLOAK: 4,
  MEGA: 8,
};

export const TANK_COLORS = [
  '#f2545b', // 0 red
  '#3fa9f5', // 1 blue
  '#ffd23f', // 2 yellow
  '#57cc99', // 3 green
  '#c77dff', // 4 purple
  '#ff9f45', // 5 orange
  '#2ec4b6', // 6 teal
  '#ff7bd5', // 7 pink
];

export const ROOM_STATE = {
  WAITING: 'WAITING',
  COUNTDOWN: 'COUNTDOWN',
  PLAYING: 'PLAYING',
  FINISHED: 'FINISHED',
};

export const ZONE = {
  // Phase list: wait -> shrink to `radius` over `shrinkMs`, dealing `dps` outside.
  startRadius: 1200,
  phases: [
    { waitMs: 22000, shrinkMs: 20000, radius: 880, dps: 5 },
    { waitMs: 15000, shrinkMs: 18000, radius: 620, dps: 7 },
    { waitMs: 13000, shrinkMs: 15000, radius: 420, dps: 10 },
    { waitMs: 11000, shrinkMs: 12000, radius: 260, dps: 14 },
    { waitMs: 9000,  shrinkMs: 10000, radius: 140, dps: 18 },
    { waitMs: 7000,  shrinkMs: 8000,  radius: 70,  dps: 26 },
  ],
};

export const NET = {
  maxPlayers: 8,
  minPlayers: 2,
  countdownMs: 4200,          // includes the "3 2 1 FIRE!" beat
  countdownStepMs: 1000,
  reconnectGraceMs: 45000,    // player slot is kept this long after a drop
  tankGhostMs: 15000,         // disconnected tank self-destructs after this
  hostGraceMs: 22000,
  emptyRoomTtlMs: 90000,
  roomTtlMs: 6 * 60 * 60 * 1000,
  maxNameLen: 16,
  maxInputsPerSec: 90,
  maxMessagesPerSec: 140,
  matchHardCapMs: 6 * 60 * 1000,
  interpMs: 110,
  snapshotHz: SIM_HZ,
};

export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I,O,0,1
export const ROOM_CODE_LEN = 6;

export const CAUSES = {
  SHOT: 'shot',
  BARREL: 'barrel',
  ZONE: 'zone',
  VANISH: 'vanish',
  SELF: 'self',
};

// ---------------------------------------------------------------------------
// Small shared math helpers
// ---------------------------------------------------------------------------
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

// Deterministic small PRNG (mulberry32) so a match seed produces one map.
export function makeRng(seed) {
  let a = seed >>> 0;
  return function rng() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
