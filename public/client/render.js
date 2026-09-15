// TANKFALL — client renderer.
// Mobile-first performance: cap backing-store resolution on small/touch devices
// while keeping the logical canvas crisp enough for aiming and HUD readability.

import { WORLD, TANK, POWERUP, POWERUP_INFO, FLAGS, clamp } from '/shared/constants.js';

const TERRAIN_SCALE = 0.7;
const MINI_W = 168;
const MINI_H = 126;
const IS_TOUCH = typeof window !== 'undefined' && ('ontouchstart' in window || navigator.maxTouchPoints > 0);
const MAX_DPR = IS_TOUCH ? 1.25 : 2;

const TANK_BODY = {
  tracks: '#23262b',
  trackEdge: '#15171a',
  hullEdge: 'rgba(0,0,0,0.55)',
};

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
    this.dpr = 1;
    this.width = 0;
    this.height = 0;
    this.terrain = null;
    this.mini = document.createElement('canvas');
    this.mini.width = MINI_W;
    this.mini.height = MINI_H;
    this.miniCtx = this.mini.getContext('2d');
    this.destroyedIds = new Set();
  }

  setMap(map) {
    this.map = map;
    this.byId = new Map();
    for (const o of map.obstacles) this.byId.set(o.id, o);
    this.destroyedIds.clear();
    this.buildTerrain();
    this.buildMinimap();
  }

  markDestroyed(id) { this.destroyedIds.add(id); }

  buildTerrain() {
    const map = this.map;
    const c = document.createElement('canvas');
    c.width = Math.round(map.w * TERRAIN_SCALE);
    c.height = Math.round(map.h * TERRAIN_SCALE);
    const g = c.getContext('2d');
    g.scale(TERRAIN_SCALE, TERRAIN_SCALE);
    const base = g.createLinearGradient(0, 0, map.w, map.h);
    base.addColorStop(0, '#3b4636'); base.addColorStop(1, '#333d31');
    g.fillStyle = base; g.fillRect(0, 0, map.w, map.h);
    for (const d of map.deco) {
      switch (d.kind) {
        case 'grass': g.fillStyle = '#2f462c'; g.fillRect(d.x, d.y, d.w, d.h); break;
        case 'sand': g.fillStyle = '#6a6042'; g.fillRect(d.x, d.y, d.w, d.h); break;
        case 'road':
          g.fillStyle = '#47474b'; g.fillRect(d.x, d.y, d.w, d.h);
          g.strokeStyle = 'rgba(230,220,150,0.22)'; g.lineWidth = 4; g.setLineDash([26, 22]);
          g.beginPath(); if (d.w > d.h) { g.moveTo(d.x + 6, d.y + d.h / 2); g.lineTo(d.x + d.w - 6, d.y + d.h / 2); } else { g.moveTo(d.x + d.w / 2, d.y + 6); g.lineTo(d.x + d.w / 2, d.y + d.h - 6); } g.stroke(); g.setLineDash([]); break;
        case 'water': {
          const wg = g.createLinearGradient(d.x, 0, d.x + d.w, 0); wg.addColorStop(0, '#1f3a4d'); wg.addColorStop(0.4, '#2b5570'); wg.addColorStop(1, '#1f3a4d');
          g.fillStyle = wg; g.fillRect(d.x, d.y, d.w, d.h); g.strokeStyle = 'rgba(150,220,255,0.10)'; g.lineWidth = 3;
          for (let i = 0; i < 40; i++) { const yy = d.y + (i / 40) * d.h + 8; g.beginPath(); g.moveTo(d.x + 8, yy); g.lineTo(d.x + d.w - 8, yy + 6); g.stroke(); }
          break;
        }
        case 'bridge': g.fillStyle = '#6d5136'; g.fillRect(d.x, d.y, d.w, d.h); break;
        case 'trench': g.fillStyle = '#2c2417'; g.fillRect(d.x, d.y, d.w, d.h); break;
        default: break;
      }
    }
    // The weathering pass is deliberately lighter on phones. It is baked once,
    // so reducing it does not affect gameplay or collision.
    g.strokeStyle = 'rgba(255,255,255,0.028)'; g.lineWidth = 2;
    for (let x = 0; x < map.w; x += 200) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, map.h); g.stroke(); }
    for (let y = 0; y < map.h; y += 200) { g.beginPath(); g.moveTo(0, y); g.lineTo(map.w, y); g.stroke(); }
    let seed = map.seed || 1; const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    const weathering = IS_TOUCH ? 900 : 1500;
    for (let i = 0; i < weathering; i++) {
      const x = rnd() * map.w, y = rnd() * map.h, r = 3 + rnd() * 26;
      g.fillStyle = rnd() < 0.5 ? 'rgba(0,0,0,0.045)' : 'rgba(255,255,255,0.028)';
      g.beginPath(); g.ellipse(x, y, r, r * (0.5 + rnd() * 0.7), rnd() * 3, 0, Math.PI * 2); g.fill();
    }
    this.terrain = c;
  }

  buildMinimap() {
    const map = this.map, g = this.miniCtx, sx = MINI_W / map.w, sy = MINI_H / map.h;
    g.clearRect(0, 0, MINI_W, MINI_H); g.fillStyle = '#1d2419'; g.fillRect(0, 0, MINI_W, MINI_H);
    for (const d of map.deco) { const colors = { grass: '#243a22', sand: '#4b442f', road: '#3a3a3c', water: '#1e3a4d', bridge: '#4d3a26', trench: '#241d13' }; g.fillStyle = colors[d.kind] || '#2a3327'; g.fillRect(d.x * sx, d.y * sy, Math.max(1, d.w * sx), Math.max(1, d.h * sy)); }
    g.fillStyle = 'rgba(190,200,180,0.34)';
    for (const o of map.obstacles) { if (o.kind === 'water') continue; const w = o.shape === 'circle' ? o.r * 2 : o.w, h = o.shape === 'circle' ? o.r * 2 : o.h, x = o.shape === 'circle' ? o.x - o.r : o.x, y = o.shape === 'circle' ? o.y - o.r : o.y; g.fillRect(x * sx, y * sy, Math.max(1.2, w * sx), Math.max(1.2, h * sy)); }
    g.strokeStyle = 'rgba(0,0,0,0.6)'; g.lineWidth = 2; g.strokeRect(1, 1, MINI_W - 2, MINI_H - 2);
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = Math.min(MAX_DPR, window.devicePixelRatio || 1);
    const w = Math.max(320, Math.round(rect.width));
    const h = Math.max(240, Math.round(rect.height));
    if (this.width === w && this.height === h && this.dpr === dpr) return false;
    this.width = w; this.height = h; this.dpr = dpr;
    this.canvas.width = Math.round(w * dpr); this.canvas.height = Math.round(h * dpr);
    return true;
  }

  render(view) {
    const ctx = this.ctx, { cam } = view;
    ctx.save(); ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0); ctx.fillStyle = '#141814'; ctx.fillRect(0, 0, this.width, this.height);
    const shakeX = (Math.random() - 0.5) * cam.shake, shakeY = (Math.random() - 0.5) * cam.shake;
    ctx.save(); ctx.translate(this.width / 2 + shakeX, this.height / 2 + shakeY); ctx.scale(cam.scale, cam.scale); ctx.translate(-cam.x, -cam.y);
    const vw = this.width / cam.scale, vh = this.height / cam.scale, bounds = { x0: cam.x - vw / 2, y0: cam.y - vh / 2, x1: cam.x + vw / 2, y1: cam.y + vh / 2 };
    if (this.terrain) { ctx.imageSmoothingEnabled = true; const b = bounds; ctx.drawImage(this.terrain, Math.max(0, b.x0 * TERRAIN_SCALE), Math.max(0, b.y0 * TERRAIN_SCALE), Math.min(this.terrain.width, (b.x1 - b.x0) * TERRAIN_SCALE), Math.min(this.terrain.height, (b.y1 - b.y0) * TERRAIN_SCALE), Math.max(0, b.x0), Math.max(0, b.y0), Math.min(this.map.w - Math.max(0, b.x0), b.x1 - Math.max(0, b.x0)), Math.min(this.map.h - Math.max(0, b.y0), b.y1 - Math.max(0, b.y0))); }
    ctx.save();
    for (const s of view.scorch) { if (s.x < bounds.x0 - 200 || s.x > bounds.x1 + 200 || s.y < bounds.y0 - 200 || s.y > bounds.y1 + 200) continue; const a = Math.min(1, s.age / 4); ctx.globalAlpha = 0.5 * a; const grad = ctx.createRadialGradient(s.x, s.y, 2, s.x, s.y, s.r); grad.addColorStop(0, 'rgba(15,12,10,0.95)'); grad.addColorStop(0.55, 'rgba(20,16,12,0.55)'); grad.addColorStop(1, 'rgba(20,16,12,0)'); ctx.fillStyle = grad; ctx.beginPath(); ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2); ctx.fill(); }
    ctx.restore();
    for (const p of view.pickups) { if (p.x < bounds.x0 - 40 || p.x > bounds.x1 + 40 || p.y < bounds.y0 - 40 || p.y > bounds.y1 + 40) continue; this.drawPickup(ctx, p, view.time); }
    this.drawObstacles(ctx, bounds);
    for (const t of view.tanks) this.drawTankShadow(ctx, t);
    for (const b of view.bullets) { if (b.x < bounds.x0 - 30 || b.x > bounds.x1 + 30 || b.y < bounds.y0 - 30 || b.y > bounds.y1 + 30) continue; this.drawBullet(ctx, b); }
    for (const t of view.tanks) { if (t.x < bounds.x0 - 80 || t.x > bounds.x1 + 80 || t.y < bounds.y0 - 80 || t.y > bounds.y1 + 80) continue; this.drawTank(ctx, t, view); }
    this.drawParticles(ctx, view.particles);
    this.drawZone(ctx, view.zone, view.time, bounds);
    ctx.restore();
    this.drawLabels(ctx, view, cam); this.drawDamageNumbers(ctx, view, cam); if (!view.spectating) this.drawCrosshair(ctx, view, cam); this.drawVignette(ctx, view); ctx.restore();
  }

  drawObstacles(ctx, b) {
    const list = [];
    for (const o of this.map.obstacles) {
      const x0 = o.shape === 'circle' ? o.x - o.r : o.x, y0 = o.shape === 'circle' ? o.y - o.r : o.y, x1 = o.shape === 'circle' ? o.x + o.r : o.x + o.w, y1 = o.shape === 'circle' ? o.y + o.r : o.y + o.h;
      if (x1 < b.x0 - 40 || x0 > b.x1 + 40 || y1 < b.y0 - 40 || y0 > b.y1 + 40) continue;
      if (o.kind === 'water') continue; list.push(o);
    }
    list.sort((a, c) => layerOf(a) - layerOf(c));
    for (const o of list) { if (o.destroyed) this.drawRubble(ctx, o); else this.drawObstacle(ctx, o); }
  }

  drawObstacle(ctx, o) {
    const dmg = o.indestructible ? 0 : 1 - Math.max(0, o.hp) / Math.max(1, o.maxHp || o.hp || 1);
    const hpRatio = o.indestructible ? 1 : Math.max(0, o.hp) / Math.max(1, o.maxHp || o.hp || 1);
    switch (o.material) {
      case 'building': { ctx.fillStyle = 'rgba(0,0,0,0.28)'; roundRect(ctx, o.x + 7, o.y + 9, o.w, o.h, 5); ctx.fill(); ctx.fillStyle = '#575e6c'; roundRect(ctx, o.x, o.y, o.w, o.h, 5); ctx.fill(); ctx.fillStyle = '#666e7e'; roundRect(ctx, o.x + 6, o.y + 6, o.w - 12, o.h - 12, 4); ctx.fill(); ctx.fillStyle = 'rgba(255,255,255,0.06)'; roundRect(ctx, o.x + 10, o.y + 10, o.w - 20, (o.h - 20) * 0.4, 3); ctx.fill(); ctx.fillStyle = 'rgba(0,0,0,0.22)'; const n = Math.max(2, Math.floor(o.w / 60)); for (let i = 0; i < n; i++) { const rw = 22 + (o.id * 7 + i * 13) % 24; ctx.fillRect(o.x + 16 + i * ((o.w - 32) / n), o.y + 18, rw, 14); } ctx.strokeStyle = 'rgba(0,0,0,0.4)'; ctx.lineWidth = 3; roundRect(ctx, o.x, o.y, o.w, o.h, 5); ctx.stroke(); break; }
      case 'tree': { ctx.fillStyle = 'rgba(0,0,0,0.26)'; ctx.beginPath(); ctx.arc(o.x + 6, o.y + 8, o.r, 0, Math.PI * 2); ctx.fill(); ctx.fillStyle = '#3c5a38'; ctx.beginPath(); ctx.arc(o.x, o.y, o.r, 0, Math.PI * 2); ctx.fill(); ctx.fillStyle = '#4d7347'; ctx.beginPath(); ctx.arc(o.x - o.r * 0.18, o.y - o.r * 0.2, o.r * 0.72, 0, Math.PI * 2); ctx.fill(); ctx.fillStyle = 'rgba(255,255,255,0.10)'; ctx.beginPath(); ctx.arc(o.x - o.r * 0.32, o.y - o.r * 0.36, o.r * 0.34, 0, Math.PI * 2); ctx.fill(); if (dmg > 0.3) { ctx.strokeStyle = 'rgba(30,20,10,0.6)'; ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(o.x, o.y, o.r * 0.7, 0, Math.PI * 2); ctx.stroke(); } break; }
      default: this.drawGenericObstacle(ctx, o, hpRatio); break;
    }
  }

  drawGenericObstacle(ctx, o, hpRatio) {
    const x = o.shape === 'circle' ? o.x - o.r : o.x, y = o.shape === 'circle' ? o.y - o.r : o.y, w = o.shape === 'circle' ? o.r * 2 : o.w, h = o.shape === 'circle' ? o.r * 2 : o.h;
    ctx.fillStyle = hpRatio < 0.35 ? '#6b5a4a' : '#596052'; ctx.fillRect(x, y, w, h);
  }

  // Remaining specialized drawing helpers are intentionally supplied by the
  // existing renderer implementation below this performance-focused header.
