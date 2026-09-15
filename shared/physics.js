// TANKFALL — shared collision + movement physics.
// The server simulates with these functions; the client uses the exact same
// code for local prediction, so predicted motion matches authority closely.

import { TANK, WORLD, clamp, turnToward } from './constants.js';

/* ------------------------------------------------------------------ *
 * Uniform-grid broadphase over the static obstacle set.
 * ------------------------------------------------------------------ */
export class CollisionWorld {
  constructor(map) {
    this.w = map.w || WORLD.w;
    this.h = map.h || WORLD.h;
    this.obstacles = map.obstacles || [];
    this.cell = 120;
    this.cols = Math.max(1, Math.ceil(this.w / this.cell));
    this.rows = Math.max(1, Math.ceil(this.h / this.cell));
    this.buckets = new Array(this.cols * this.rows);
    for (const o of this.obstacles) this._insert(o);
    this._stamp = 0;
    this._scratch = [];
  }

  _insert(o) {
    const bb = obstacleBounds(o);
    const c0 = clamp(Math.floor(bb.x0 / this.cell), 0, this.cols - 1);
    const c1 = clamp(Math.floor(bb.x1 / this.cell), 0, this.cols - 1);
    const r0 = clamp(Math.floor(bb.y0 / this.cell), 0, this.rows - 1);
    const r1 = clamp(Math.floor(bb.y1 / this.cell), 0, this.rows - 1);
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const i = r * this.cols + c;
        (this.buckets[i] || (this.buckets[i] = [])).push(o);
      }
    }
  }

  /** Returns obstacles whose bounds overlap the AABB. Result array is reused. */
  query(x0, y0, x1, y1) {
    const out = this._scratch;
    out.length = 0;
    const stamp = ++this._stamp;
    const c0 = clamp(Math.floor(Math.min(x0, x1) / this.cell), 0, this.cols - 1);
    const c1 = clamp(Math.floor(Math.max(x0, x1) / this.cell), 0, this.cols - 1);
    const r0 = clamp(Math.floor(Math.min(y0, y1) / this.cell), 0, this.rows - 1);
    const r1 = clamp(Math.floor(Math.max(y0, y1) / this.cell), 0, this.rows - 1);
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const b = this.buckets[r * this.cols + c];
        if (!b) continue;
        for (let i = 0; i < b.length; i++) {
          const o = b[i];
          if (o._stamp === stamp) continue;
          o._stamp = stamp;
          if (o.destroyed) continue;
          const bb = obstacleBounds(o);
          if (bb.x1 < x0 || bb.x0 > x1 || bb.y1 < y0 || bb.y0 > y1) continue;
          out.push(o);
        }
      }
    }
    return out;
  }
}

export function obstacleBounds(o) {
  if (o.shape === 'circle') {
    return { x0: o.x - o.r, y0: o.y - o.r, x1: o.x + o.r, y1: o.y + o.r };
  }
  return { x0: o.x, y0: o.y, x1: o.x + o.w, y1: o.y + o.h };
}

/* ------------------------------------------------------------------ *
 * Circle vs obstacle resolution
 * ------------------------------------------------------------------ */
function resolveCircleObstacle(px, py, radius, o) {
  if (o.shape === 'circle') {
    let dx = px - o.x, dy = py - o.y;
    const rr = radius + o.r;
    const d2 = dx * dx + dy * dy;
    if (d2 >= rr * rr) return null;
    let d = Math.sqrt(d2);
    if (d < 1e-4) { dx = 1; dy = 0; d = 1; }
    const push = rr - d;
    return { x: px + (dx / d) * push, y: py + (dy / d) * push };
  }
  const cx = clamp(px, o.x, o.x + o.w);
  const cy = clamp(py, o.y, o.y + o.h);
  let dx = px - cx, dy = py - cy;
  const d2 = dx * dx + dy * dy;
  if (d2 > 1e-6) {
    if (d2 >= radius * radius) return null;
    const d = Math.sqrt(d2);
    const push = radius - d;
    return { x: px + (dx / d) * push, y: py + (dy / d) * push };
  }
  // Center is inside the rect: push out along the shallowest axis.
  const left = px - o.x, right = o.x + o.w - px;
  const top = py - o.y, bottom = o.y + o.h - py;
  const m = Math.min(left, right, top, bottom);
  if (m === left) return { x: o.x - radius, y: py };
  if (m === right) return { x: o.x + o.w + radius, y: py };
  if (m === top) return { x: px, y: o.y - radius };
  return { x: px, y: o.y + o.h + radius };
}

/** Push a circle out of every obstacle it overlaps. Mutates and returns `pos`. */
export function resolveCircle(world, pos, radius, filter) {
  for (let pass = 0; pass < 3; pass++) {
    const near = world.query(pos.x - radius, pos.y - radius, pos.x + radius, pos.y + radius).slice();
    let moved = false;
    for (const o of near) {
      if (filter && !filter(o)) continue;
      const res = resolveCircleObstacle(pos.x, pos.y, radius, o);
      if (res) { pos.x = res.x; pos.y = res.y; moved = true; }
    }
    if (!moved) break;
  }
  pos.x = clamp(pos.x, radius, world.w - radius);
  pos.y = clamp(pos.y, radius, world.h - radius);
  return pos;
}

/* ------------------------------------------------------------------ *
 * Ray (segment) vs inflated obstacles — used by bullets, so a fast shell
 * can never tunnel through a wall.
 * ------------------------------------------------------------------ */
function rayRectT(x0, y0, x1, y1, minX, minY, maxX, maxY) {
  const dx = x1 - x0, dy = y1 - y0;
  let tmin = 0, tmax = 1;
  // X slab
  if (Math.abs(dx) < 1e-9) {
    if (x0 < minX || x0 > maxX) return null;
  } else {
    let t1 = (minX - x0) / dx, t2 = (maxX - x0) / dx;
    if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
    tmin = Math.max(tmin, t1); tmax = Math.min(tmax, t2);
    if (tmin > tmax) return null;
  }
  if (Math.abs(dy) < 1e-9) {
    if (y0 < minY || y0 > maxY) return null;
  } else {
    let t1 = (minY - y0) / dy, t2 = (maxY - y0) / dy;
    if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
    tmin = Math.max(tmin, t1); tmax = Math.min(tmax, t2);
    if (tmin > tmax) return null;
  }
  return tmin;
}

function rayCircleT(x0, y0, x1, y1, cx, cy, r) {
  const dx = x1 - x0, dy = y1 - y0;
  const fx = x0 - cx, fy = y0 - cy;
  const a = dx * dx + dy * dy;
  if (a < 1e-9) return fx * fx + fy * fy <= r * r ? 0 : null;
  const b = 2 * (fx * dx + fy * dy);
  const c = fx * fx + fy * fy - r * r;
  const disc = b * b - 4 * a * c;
  if (disc < 0) return null;
  const sq = Math.sqrt(disc);
  const t1 = (-b - sq) / (2 * a);
  const t2 = (-b + sq) / (2 * a);
  if (t1 >= 0 && t1 <= 1) return t1;
  if (t2 >= 0 && t2 <= 1) return t2;
  return null;
}

/** Returns {t, obstacle, x, y} for the closest obstacle hit along the segment. */
export function raycastObstacles(world, x0, y0, x1, y1, radius) {
  const pad = radius + 1;
  const near = world.query(
    Math.min(x0, x1) - pad, Math.min(y0, y1) - pad,
    Math.max(x0, x1) + pad, Math.max(y0, y1) + pad
  ).slice();
  let best = null;
  for (const o of near) {
    let t;
    if (o.shape === 'circle') t = rayCircleT(x0, y0, x1, y1, o.x, o.y, o.r + radius);
    else t = rayRectT(x0, y0, x1, y1, o.x - radius, o.y - radius, o.x + o.w + radius, o.y + o.h + radius);
    if (t === null) continue;
    if (!best || t < best.t) best = { t, obstacle: o };
  }
  if (!best) return null;
  return {
    t: best.t,
    obstacle: best.obstacle,
    x: x0 + (x1 - x0) * best.t,
    y: y0 + (y1 - y0) * best.t,
  };
}

/* ------------------------------------------------------------------ *
 * Tank integration — identical on server (authority) and client (prediction)
 * ------------------------------------------------------------------ */
export function createTankState(x, y, angle = 0) {
  return { x, y, vx: 0, vy: 0, angle, turret: angle };
}

/**
 * Advance one tank by dt using a validated input.
 * input: { mx, my (analog dir, |v| <= 1), turret (absolute radians), boost (bool) }
 * speedMult: extra multiplier from powerups.
 */
export function stepTank(state, input, dt, world, speedMult = 1) {
  let mx = input.mx || 0, my = input.my || 0;
  const mag = Math.hypot(mx, my);
  if (mag > 1) { mx /= mag; my /= mag; }

  const maxSpeed = TANK.speed * speedMult;
  const targetVx = mx * maxSpeed;
  const targetVy = my * maxSpeed;
  const k = 1 - Math.exp(-TANK.accel * dt);
  state.vx += (targetVx - state.vx) * k;
  state.vy += (targetVy - state.vy) * k;
  if (Math.abs(state.vx) < 1.5) state.vx = 0;
  if (Math.abs(state.vy) < 1.5) state.vy = 0;

  // Axis-separated movement keeps the tank sliding along walls instead of sticking.
  state.x += state.vx * dt;
  resolveCircle(world, state, TANK.radius);
  state.y += state.vy * dt;
  resolveCircle(world, state, TANK.radius);

  const speed = Math.hypot(state.vx, state.vy);
  if (speed > 8) {
    state.angle = turnToward(state.angle, Math.atan2(state.vy, state.vx), TANK.hullTurn * dt);
  }
  if (typeof input.turret === 'number' && Number.isFinite(input.turret)) {
    state.turret = turnToward(state.turret, input.turret, TANK.turretTurn * dt);
  }
  return state;
}

/** Normalizes an untrusted client input payload into a safe input object. */
export function sanitizeInput(raw) {
  const out = { mx: 0, my: 0, turret: 0, fire: false, boost: false };
  if (!raw || typeof raw !== 'object') return out;
  let mx = Number(raw.mx), my = Number(raw.my);
  if (!Number.isFinite(mx)) mx = 0;
  if (!Number.isFinite(my)) my = 0;
  const mag = Math.hypot(mx, my);
  if (mag > 1) { mx /= mag; my /= mag; }
  out.mx = clamp(mx, -1, 1);
  out.my = clamp(my, -1, 1);
  let t = Number(raw.turret);
  out.turret = Number.isFinite(t) ? t : 0;
  out.fire = raw.fire === true;
  out.boost = raw.boost === true;
  return out;
}
