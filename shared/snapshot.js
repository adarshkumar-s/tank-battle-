// TANKFALL — binary snapshot codec.
// Snapshots are the hot path (30/s per client), so they go over the wire as a
// compact binary frame instead of JSON.

import { POWERUP_KINDS } from './constants.js';

export const MSG = { SNAPSHOT: 1 };

const ANG16 = 65536 / (Math.PI * 2);
const TWO_PI = Math.PI * 2;

export function createSnapshotBuffer() {
  // 8 tanks * 20B + 64 bullets * 5B + 12 pickups * 7B + header ≈ 600B. Give headroom.
  return new ArrayBuffer(2048);
}

export function encodeSnapshot(view, s) {
  let o = 0;
  view.setUint8(o++, MSG.SNAPSHOT);
  view.setUint8(o++, s.stateCode);
  view.setUint16(o, s.t & 0xffff, true); o += 2;

  view.setUint16(o, s.zone.cx, true); o += 2;
  view.setUint16(o, s.zone.cy, true); o += 2;
  view.setUint16(o, s.zone.r, true); o += 2;
  view.setUint16(o, s.zone.targetR, true); o += 2;
  view.setUint8(o++, s.zone.phase);
  view.setUint16(o, Math.min(65535, s.zone.nextMs / 10) | 0, true); o += 2;

  view.setUint8(o++, s.tanks.length);
  for (const t of s.tanks) {
    view.setUint16(o, t.id, true); o += 2;
    view.setUint16(o, Math.min(65535, Math.round(t.x * 2)), true); o += 2;
    view.setUint16(o, Math.min(65535, Math.round(t.y * 2)), true); o += 2;
    view.setUint16(o, (Math.round(t.angle * ANG16) & 0xffff), true); o += 2;
    view.setUint16(o, (Math.round(t.turret * ANG16) & 0xffff), true); o += 2;
    view.setInt8(o++, clampI8(t.vx / 8));
    view.setInt8(o++, clampI8(t.vy / 8));
    view.setUint8(o++, Math.max(0, Math.min(255, Math.round(t.hp))));
    view.setUint8(o++, t.flags | 0);
    view.setUint8(o++, Math.min(255, Math.round(t.shieldS || 0)));
    view.setUint8(o++, Math.min(255, Math.round(t.boostS || 0)));
    view.setUint8(o++, Math.min(255, Math.round(t.cloakS || 0)));
    view.setUint8(o++, Math.max(0, Math.min(255, Math.round(t.energy ?? 100))));
  }

  view.setUint8(o++, s.bullets.length);
  for (const b of s.bullets) {
    view.setUint16(o, b.id, true); o += 2;
    view.setUint16(o, Math.min(65535, Math.round(b.x * 2)), true); o += 2;
    view.setUint16(o, Math.min(65535, Math.round(b.y * 2)), true); o += 2;
    view.setUint8(o++, (Math.round(b.angle * 256 / TWO_PI) & 0xff));
    view.setUint8(o++, b.kind | 0);
  }

  view.setUint8(o++, s.pickups.length);
  for (const p of s.pickups) {
    view.setUint16(o, p.id, true); o += 2;
    view.setUint8(o++, POWERUP_KINDS.indexOf(p.kind));
    view.setUint16(o, Math.min(65535, Math.round(p.x * 2)), true); o += 2;
    view.setUint16(o, Math.min(65535, Math.round(p.y * 2)), true); o += 2;
  }

  view.setUint16(o, s.winnerId || 0, true); o += 2;
  return o;
}

export function decodeSnapshot(buf, out) {
  const view = new DataView(buf);
  let o = 0;
  const type = view.getUint8(o++);
  if (type !== MSG.SNAPSHOT) return null;
  const snap = out || {};
  snap.stateCode = view.getUint8(o++);
  snap.t = view.getUint16(o, true); o += 2;
  snap.zone = snap.zone || {};
  snap.zone.cx = view.getUint16(o, true); o += 2;
  snap.zone.cy = view.getUint16(o, true); o += 2;
  snap.zone.r = view.getUint16(o, true); o += 2;
  snap.zone.targetR = view.getUint16(o, true); o += 2;
  snap.zone.phase = view.getUint8(o++);
  snap.zone.nextMs = view.getUint16(o, true) * 10; o += 2;

  const nTanks = view.getUint8(o++);
  snap.tanks = snap.tanks && snap.tanks.length === nTanks ? snap.tanks : new Array(nTanks);
  for (let i = 0; i < nTanks; i++) {
    const t = snap.tanks[i] || (snap.tanks[i] = {});
    t.id = view.getUint16(o, true); o += 2;
    t.x = view.getUint16(o, true) / 2; o += 2;
    t.y = view.getUint16(o, true) / 2; o += 2;
    t.angle = (view.getUint16(o, true) / 65536) * TWO_PI; o += 2;
    t.turret = (view.getUint16(o, true) / 65536) * TWO_PI; o += 2;
    t.vx = view.getInt8(o++) * 8;
    t.vy = view.getInt8(o++) * 8;
    t.hp = view.getUint8(o++);
    t.flags = view.getUint8(o++);
    t.shieldS = view.getUint8(o++);
    t.boostS = view.getUint8(o++);
    t.cloakS = view.getUint8(o++);
    t.energy = view.getUint8(o++);
  }

  const nBullets = view.getUint8(o++);
  snap.bullets = snap.bullets && snap.bullets.length === nBullets ? snap.bullets : new Array(nBullets);
  for (let i = 0; i < nBullets; i++) {
    const b = snap.bullets[i] || (snap.bullets[i] = {});
    b.id = view.getUint16(o, true); o += 2;
    b.x = view.getUint16(o, true) / 2; o += 2;
    b.y = view.getUint16(o, true) / 2; o += 2;
    b.angle = (view.getUint8(o++) / 256) * TWO_PI;
    b.kind = view.getUint8(o++);
  }

  const nPickups = view.getUint8(o++);
  snap.pickups = snap.pickups && snap.pickups.length === nPickups ? snap.pickups : new Array(nPickups);
  for (let i = 0; i < nPickups; i++) {
    const p = snap.pickups[i] || (snap.pickups[i] = {});
    p.id = view.getUint16(o, true); o += 2;
    p.kind = POWERUP_KINDS[view.getUint8(o++)] || 'repair';
    p.x = view.getUint16(o, true) / 2; o += 2;
    p.y = view.getUint16(o, true) / 2; o += 2;
  }

  snap.winnerId = view.getUint16(o, true); o += 2;
  return snap;
}

function clampI8(v) {
  const n = Math.round(v);
  return n > 127 ? 127 : n < -127 ? -127 : n;
}
