// TANKFALL — shared collision + movement physics.
// The server simulates with these functions; the client uses the exact same
// code for local prediction, so predicted motion matches authority closely.

import { TANK, WORLD, clamp, turnToward } from './constants.js';

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
    const c0 = clamp(Math.floor(bb.x0 / this.cell), 0, this.cols - 1), c1 = clamp(Math.floor(bb.x1 / this.cell), 0, this.cols - 1);
    const r0 = clamp(Math.floor(bb.y0 / this.cell), 0, this.rows - 1), r1 = clamp(Math.floor(bb.y1 / this.cell), 0, this.rows - 1);
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) (this.buckets[r * this.cols + c] || (this.buckets[r * this.cols + c] = [])).push(o);
  }
  query(x0, y0, x1, y1) {
    const out = this._scratch; out.length = 0; const stamp = ++this._stamp;
    const c0 = clamp(Math.floor(Math.min(x0, x1) / this.cell), 0, this.cols - 1), c1 = clamp(Math.floor(Math.max(x0, x1) / this.cell), 0, this.cols - 1);
    const r0 = clamp(Math.floor(Math.min(y0, y1) / this.cell), 0, this.rows - 1), r1 = clamp(Math.floor(Math.max(y0, y1) / this.cell), 0, this.rows - 1);
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
      const b = this.buckets[r * this.cols + c]; if (!b) continue;
      for (const o of b) {
        // Water and small cover are visual/gameplay dressing, not movement walls.
        // Only major structures and rocks participate in physical blocking.
        if (o.kind === 'water' || ['barrel', 'tree', 'woodCrate', 'metalCrate', 'barrier', 'sandbag', 'metal'].includes(o.material)) continue;
        if (o._stamp === stamp) continue; o._stamp = stamp; if (o.destroyed) continue;
        const bb = obstacleBounds(o); if (bb.x1 < x0 || bb.x0 > x1 || bb.y1 < y0 || bb.y0 > y1) continue; out.push(o);
      }
    }
    return out;
  }
}
export function obstacleBounds(o) { return o.shape === 'circle' ? { x0: o.x - o.r, y0: o.y - o.r, x1: o.x + o.r, y1: o.y + o.r } : { x0: o.x, y0: o.y, x1: o.x + o.w, y1: o.y + o.h }; }

function resolveCircleObstacle(px, py, radius, o) {
  if (o.shape === 'circle') {
    let dx = px - o.x, dy = py - o.y, rr = radius + o.r, d2 = dx * dx + dy * dy;
    if (d2 >= rr * rr) return null; let d = Math.sqrt(d2); if (d < 1e-4) { dx = 1; dy = 0; d = 1; }
    const push = rr - d; return { x: px + dx / d * push, y: py + dy / d * push };
  }
  const cx = clamp(px, o.x, o.x + o.w), cy = clamp(py, o.y, o.y + o.h), dx = px - cx, dy = py - cy, d2 = dx * dx + dy * dy;
  if (d2 > 1e-6) { if (d2 >= radius * radius) return null; const d = Math.sqrt(d2), push = radius - d; return { x: px + dx / d * push, y: py + dy / d * push }; }
  const left = px - o.x, right = o.x + o.w - px, top = py - o.y, bottom = o.y + o.h - py, m = Math.min(left, right, top, bottom);
  if (m === left) return { x: o.x - radius, y: py }; if (m === right) return { x: o.x + o.w + radius, y: py }; if (m === top) return { x: px, y: o.y - radius }; return { x: px, y: o.y + o.h + radius };
}
export function resolveCircle(world, pos, radius, filter) {
  for (let pass = 0; pass < 2; pass++) {
    const near = world.query(pos.x - radius, pos.y - radius, pos.x + radius, pos.y + radius).slice(); let moved = false;
    for (const o of near) { if (filter && !filter(o)) continue; const res = resolveCircleObstacle(pos.x, pos.y, radius, o); if (res) { pos.x = res.x; pos.y = res.y; moved = true; } }
    if (!moved) break;
  }
  pos.x = clamp(pos.x, radius, world.w - radius); pos.y = clamp(pos.y, radius, world.h - radius); return pos;
}

function rayRectT(x0, y0, x1, y1, minX, minY, maxX, maxY) {
  const dx = x1 - x0, dy = y1 - y0; let tmin = 0, tmax = 1;
  if (Math.abs(dx) < 1e-9) { if (x0 < minX || x0 > maxX) return null; } else { let t1 = (minX - x0) / dx, t2 = (maxX - x0) / dx; if (t1 > t2) [t1, t2] = [t2, t1]; tmin = Math.max(tmin, t1); tmax = Math.min(tmax, t2); if (tmin > tmax) return null; }
  if (Math.abs(dy) < 1e-9) { if (y0 < minY || y0 > maxY) return null; } else { let t1 = (minY - y0) / dy, t2 = (maxY - y0) / dy; if (t1 > t2) [t1, t2] = [t2, t1]; tmin = Math.max(tmin, t1); tmax = Math.min(tmax, t2); if (tmin > tmax) return null; }
  return tmin;
}
function rayCircleT(x0, y0, x1, y1, cx, cy, r) {
  const dx = x1 - x0, dy = y1 - y0, fx = x0 - cx, fy = y0 - cy, a = dx * dx + dy * dy;
  if (a < 1e-9) return fx * fx + fy * fy <= r * r ? 0 : null;
  const b = 2 * (fx * dx + fy * dy), c = fx * fx + fy * fy - r * r, disc = b * b - 4 * a * c; if (disc < 0) return null;
  const sq = Math.sqrt(disc), t1 = (-b - sq) / (2 * a), t2 = (-b + sq) / (2 * a); if (t1 >= 0 && t1 <= 1) return t1; if (t2 >= 0 && t2 <= 1) return t2; return null;
}
export function raycastObstacles(world, x0, y0, x1, y1, radius) {
  const pad = radius + 1, near = world.query(Math.min(x0, x1) - pad, Math.min(y0, y1) - pad, Math.max(x0, x1) + pad, Math.max(y0, y1) + pad).slice(); let best = null;
  for (const o of near) { const t = o.shape === 'circle' ? rayCircleT(x0, y0, x1, y1, o.x, o.y, o.r + radius) : rayRectT(x0, y0, x1, y1, o.x - radius, o.y - radius, o.x + o.w + radius, o.y + o.h + radius); if (t !== null && (!best || t < best.t)) best = { t, obstacle: o }; }
  return best ? { t: best.t, obstacle: best.obstacle, x: x0 + (x1 - x0) * best.t, y: y0 + (y1 - y0) * best.t } : null;
}

export function createTankState(x, y, angle = 0) { return { x, y, vx: 0, vy: 0, angle, turret: angle }; }
export function stepTank(state, input, dt, world, speedMult = 1) {
  let mx = input.mx || 0, my = input.my || 0;
  const mag = Math.hypot(mx, my);
  if (mag > 1) { mx /= mag; my /= mag; }

  const maxSpeed = TANK.speed * speedMult;
  const targetVx = mx * maxSpeed;
  const targetVy = my * maxSpeed;
  // Responsive easing: fast enough for combat, but without the jerky instant
  // velocity changes that made prediction/correction feel like rubber-banding.
  const k = 1 - Math.exp(-18 * dt);
  state.vx += (targetVx - state.vx) * k;
  state.vy += (targetVy - state.vy) * k;

  if (Math.abs(mx) < 0.001 && Math.abs(my) < 0.001) {
    const brake = Math.exp(-13 * dt);
    state.vx *= brake;
    state.vy *= brake;
    if (Math.abs(state.vx) < 1.2) state.vx = 0;
    if (Math.abs(state.vy) < 1.2) state.vy = 0;
  }

  // Resolve the complete movement together so diagonal motion slides cleanly
  // around corners instead of getting caught by X/Y axis corrections.
  state.x += state.vx * dt;
  state.y += state.vy * dt;
  resolveCircle(world, state, TANK.radius);

  const speed = Math.hypot(state.vx, state.vy);
  if (speed > 8) state.angle = turnToward(state.angle, Math.atan2(state.vy, state.vx), TANK.hullTurn * dt);
  if (typeof input.turret === 'number' && Number.isFinite(input.turret)) state.turret = turnToward(state.turret, input.turret, TANK.turretTurn * dt);
  return state;
}
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
  const t = Number(raw.turret);
  out.turret = Number.isFinite(t) ? t : 0;
  out.fire = raw.fire === true;
  out.boost = raw.boost === true;
  return out;
}