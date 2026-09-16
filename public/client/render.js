// TANKFALL — canvas renderer. Arcade-military look: chunky silhouettes, flat
// readable colors, big satisfying explosions. The static terrain is baked once
// into an offscreen bitmap; obstacles are drawn culled and per-frame so
// destructible cover can disappear the instant the server says so.

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
          g.beginPath();
          if (d.w > d.h) { g.moveTo(d.x + 6, d.y + d.h / 2); g.lineTo(d.x + d.w - 6, d.y + d.h / 2); } else { g.moveTo(d.x + d.w / 2, d.y + 6); g.lineTo(d.x + d.w / 2, d.y + d.h - 6); }
          g.stroke(); g.setLineDash([]); break;
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
    g.strokeStyle = 'rgba(255,255,255,0.028)'; g.lineWidth = 2;
    for (let x = 0; x < map.w; x += 200) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, map.h); g.stroke(); }
    for (let y = 0; y < map.h; y += 200) { g.beginPath(); g.moveTo(0, y); g.lineTo(map.w, y); g.stroke(); }
    let seed = map.seed || 1; const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    const weathering = IS_TOUCH ? 900 : 2600;
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
    const w = Math.max(320, Math.round(rect.width)), h = Math.max(240, Math.round(rect.height));
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
    this.drawParticles(ctx, view.particles); this.drawZone(ctx, view.zone, view.time, bounds); ctx.restore();
    this.drawLabels(ctx, view, cam); this.drawDamageNumbers(ctx, view, cam); if (!view.spectating) this.drawCrosshair(ctx, view, cam); this.drawVignette(ctx, view); ctx.restore();
  }

  drawObstacles(ctx, b) {
    const list = [];
    for (const o of this.map.obstacles) { const x0 = o.shape === 'circle' ? o.x - o.r : o.x, y0 = o.shape === 'circle' ? o.y - o.r : o.y, x1 = o.shape === 'circle' ? o.x + o.r : o.x + o.w, y1 = o.shape === 'circle' ? o.y + o.r : o.y + o.h; if (x1 < b.x0 - 40 || x0 > b.x1 + 40 || y1 < b.y0 - 40 || y0 > b.y1 + 40) continue; if (o.kind === 'water') continue; list.push(o); }
    list.sort((a, c) => layerOf(a) - layerOf(c));
    for (const o of list) { if (o.destroyed) this.drawRubble(ctx, o); else this.drawObstacle(ctx, o); }
  }

  drawObstacle(ctx, o) {
    const dmg = o.indestructible ? 0 : 1 - Math.max(0, o.hp) / Math.max(1, o.maxHp || o.hp || 1);
    const hpRatio = o.indestructible ? 1 : Math.max(0, o.hp) / Math.max(1, o.maxHp || o.hp || 1);
    switch (o.material) {
      case 'building': { ctx.fillStyle = 'rgba(0,0,0,0.28)'; roundRect(ctx, o.x + 7, o.y + 9, o.w, o.h, 5); ctx.fill(); ctx.fillStyle = '#575e6c'; roundRect(ctx, o.x, o.y, o.w, o.h, 5); ctx.fill(); ctx.fillStyle = '#666e7e'; roundRect(ctx, o.x + 6, o.y + 6, o.w - 12, o.h - 12, 4); ctx.fill(); ctx.fillStyle = 'rgba(255,255,255,0.06)'; roundRect(ctx, o.x + 10, o.y + 10, o.w - 20, (o.h - 20) * 0.4, 3); ctx.fill(); ctx.fillStyle = 'rgba(0,0,0,0.22)'; const n = Math.max(2, Math.floor(o.w / 60)); for (let i = 0; i < n; i++) { const rw = 22 + (o.id * 7 + i * 13) % 24; ctx.fillRect(o.x + 16 + i * ((o.w - 32) / n), o.y + 18, rw, 14); } ctx.strokeStyle = 'rgba(0,0,0,0.4)'; ctx.lineWidth = 3; roundRect(ctx, o.x, o.y, o.w, o.h, 5); ctx.stroke(); break; }
      case 'tree': { ctx.fillStyle = 'rgba(0,0,0,0.26)'; ctx.beginPath(); ctx.arc(o.x + 6, o.y + 8, o.r, 0, Math.PI * 2); ctx.fill(); ctx.fillStyle = '#3c5a38'; ctx.beginPath(); ctx.arc(o.x, o.y, o.r, 0, Math.PI * 2); ctx.fill(); ctx.fillStyle = '#4d7347'; ctx.beginPath(); ctx.arc(o.x - o.r * 0.18, o.y - o.r * 0.2, o.r * 0.72, 0, Math.PI * 2); ctx.fill(); ctx.fillStyle = 'rgba(255,255,255,0.10)'; ctx.beginPath(); ctx.arc(o.x - o.r * 0.32, o.y - o.r * 0.36, o.r * 0.34, 0, Math.PI * 2); ctx.fill(); if (dmg > 0.3) { ctx.strokeStyle = 'rgba(30,20,10,0.6)'; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(o.x - o.r * 0.5, o.y - o.r * 0.4); ctx.lineTo(o.x + o.r * 0.2, o.y + o.r * 0.3); ctx.stroke(); } break; }
      case 'rock': { ctx.fillStyle = 'rgba(0,0,0,0.3)'; ctx.beginPath(); ctx.arc(o.x + 5, o.y + 7, o.r, 0, Math.PI * 2); ctx.fill(); ctx.fillStyle = '#6c6f6b'; ctx.beginPath(); const pts = 8; for (let i = 0; i <= pts; i++) { const a = (i / pts) * Math.PI * 2, rr = o.r * (0.86 + (((o.id * 31 + i * 17) % 10) / 10) * 0.24), px = o.x + Math.cos(a) * rr, py = o.y + Math.sin(a) * rr; if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py); } ctx.closePath(); ctx.fill(); ctx.fillStyle = 'rgba(255,255,255,0.12)'; ctx.beginPath(); ctx.arc(o.x - o.r * 0.25, o.y - o.r * 0.3, o.r * 0.42, 0, Math.PI * 2); ctx.fill(); break; }
      case 'barrel': { ctx.fillStyle = 'rgba(0,0,0,0.3)'; ctx.beginPath(); ctx.arc(o.x + 4, o.y + 6, o.r, 0, Math.PI * 2); ctx.fill(); const hue = o.theme === 'military' ? '#6f7a4a' : '#a3452f'; const hue2 = o.theme === 'military' ? '#8b9a5d' : '#c65b3c'; ctx.fillStyle = hue; ctx.beginPath(); ctx.arc(o.x, o.y, o.r, 0, Math.PI * 2); ctx.fill(); ctx.fillStyle = hue2; ctx.beginPath(); ctx.arc(o.x, o.y, o.r * 0.66, 0, Math.PI * 2); ctx.fill(); ctx.strokeStyle = 'rgba(0,0,0,0.45)'; ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(o.x, o.y, o.r, 0, Math.PI * 2); ctx.stroke(); if (dmg > 0.35) { ctx.strokeStyle = 'rgba(0,0,0,0.5)'; ctx.lineWidth = 4; ctx.beginPath(); ctx.moveTo(o.x - o.r * 0.7, o.y - o.r * 0.2); ctx.lineTo(o.x + o.r * 0.6, o.y + o.r * 0.5); ctx.stroke(); } break; }
      case 'woodCrate': { ctx.fillStyle = 'rgba(0,0,0,0.26)'; ctx.fillRect(o.x + 5, o.y + 6, o.w, o.h); ctx.fillStyle = '#9a6b3d'; ctx.fillRect(o.x, o.y, o.w, o.h); ctx.fillStyle = 'rgba(255,255,255,0.09)'; ctx.fillRect(o.x + 3, o.y + 3, o.w - 6, Math.max(3, o.h * 0.28)); ctx.strokeStyle = 'rgba(60,35,15,0.7)'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(o.x + 3, o.y + o.h * 0.45); ctx.lineTo(o.x + o.w - 3, o.y + o.h * 0.45); ctx.moveTo(o.x + 3, o.y + o.h * 0.75); ctx.lineTo(o.x + o.w - 3, o.y + o.h * 0.75); ctx.stroke(); ctx.strokeStyle = 'rgba(50,30,12,0.85)'; ctx.lineWidth = 3; ctx.strokeRect(o.x + 1, o.y + 1, o.w - 2, o.h - 2); if (hpRatio < 0.65) this.cracks(ctx, o, hpRatio); break; }
      case 'metalCrate': { ctx.fillStyle = 'rgba(0,0,0,0.26)'; ctx.fillRect(o.x + 5, o.y + 6, o.w, o.h); ctx.fillStyle = '#7f8b99'; ctx.fillRect(o.x, o.y, o.w, o.h); ctx.fillStyle = 'rgba(255,255,255,0.10)'; ctx.fillRect(o.x + 3, o.y + 3, o.w - 6, 4); ctx.strokeStyle = 'rgba(35,42,50,0.85)'; ctx.lineWidth = 3; ctx.strokeRect(o.x + 1.5, o.y + 1.5, o.w - 3, o.h - 3); ctx.strokeStyle = 'rgba(40,48,58,0.7)'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(o.x + 4, o.y + 4); ctx.lineTo(o.x + o.w - 4, o.y + o.h - 4); ctx.moveTo(o.x + o.w - 4, o.y + 4); ctx.lineTo(o.x + 4, o.y + o.h - 4); ctx.stroke(); if (hpRatio < 0.65) this.cracks(ctx, o, hpRatio); break; }
      case 'sandbag': { ctx.fillStyle = 'rgba(0,0,0,0.24)'; ctx.fillRect(o.x + 4, o.y + 5, o.w, o.h); ctx.fillStyle = '#a8935f'; ctx.fillRect(o.x, o.y, o.w, o.h); ctx.fillStyle = 'rgba(255,255,255,0.10)'; ctx.fillRect(o.x, o.y, o.w, Math.max(2, o.h * 0.3)); ctx.strokeStyle = 'rgba(90,75,45,0.75)'; ctx.lineWidth = 2; for (let x = o.x; x < o.x + o.w; x += 18) { ctx.beginPath(); ctx.moveTo(x, o.y); ctx.lineTo(x - 6, o.y + o.h); ctx.stroke(); } break; }
      case 'metal': { ctx.fillStyle = 'rgba(0,0,0,0.3)'; ctx.fillRect(o.x + 4, o.y + 6, o.w, o.h); ctx.fillStyle = '#5f6a72'; ctx.fillRect(o.x, o.y, o.w, o.h); ctx.fillStyle = 'rgba(255,255,255,0.12)'; ctx.fillRect(o.x + 2, o.y + 2, o.w - 4, Math.max(2, o.h * 0.25)); ctx.fillStyle = 'rgba(20,26,30,0.6)'; for (let x = o.x + 8; x < o.x + o.w - 4; x += 20) ctx.fillRect(x, o.y + o.h / 2 - 2, 5, 5); ctx.strokeStyle = 'rgba(20,26,30,0.8)'; ctx.lineWidth = 2; ctx.strokeRect(o.x + 1, o.y + 1, o.w - 2, o.h - 2); if (hpRatio < 0.6) this.cracks(ctx, o, hpRatio); break; }
      case 'barrier': { ctx.fillStyle = 'rgba(0,0,0,0.28)'; ctx.fillRect(o.x + 4, o.y + 5, o.w, o.h); ctx.fillStyle = '#c9a227'; ctx.fillRect(o.x, o.y, o.w, o.h); ctx.fillStyle = '#2b2b2b'; for (let x = o.x - o.h; x < o.x + o.w; x += 32) { ctx.save(); ctx.beginPath(); ctx.rect(o.x, o.y, o.w, o.h); ctx.clip(); ctx.beginPath(); ctx.moveTo(x, o.y); ctx.lineTo(x + 16, o.y); ctx.lineTo(x + 16 - o.h, o.y + o.h); ctx.lineTo(x - o.h, o.y + o.h); ctx.closePath(); ctx.fill(); ctx.restore(); } ctx.strokeStyle = 'rgba(0,0,0,0.6)'; ctx.lineWidth = 2; ctx.strokeRect(o.x + 1, o.y + 1, o.w - 2, o.h - 2); if (hpRatio < 0.6) this.cracks(ctx, o, hpRatio); break; }
      case 'concrete': default: { if (o.kind === 'water') break; ctx.fillStyle = 'rgba(0,0,0,0.3)'; ctx.fillRect(o.x + 5, o.y + 6, o.w, o.h); ctx.fillStyle = '#8d9199'; ctx.fillRect(o.x, o.y, o.w, o.h); ctx.fillStyle = 'rgba(255,255,255,0.14)'; ctx.fillRect(o.x, o.y, o.w, Math.max(3, o.h * 0.22)); ctx.fillStyle = 'rgba(0,0,0,0.18)'; ctx.fillRect(o.x, o.y + o.h - Math.max(3, o.h * 0.18), o.w, Math.max(3, o.h * 0.18)); ctx.strokeStyle = 'rgba(40,44,50,0.8)'; ctx.lineWidth = 2; ctx.strokeRect(o.x + 1, o.y + 1, o.w - 2, o.h - 2); if (o.maxHp && o.hp < o.maxHp) this.cracks(ctx, o, hpRatio); break; }
    }
  }

  cracks(ctx, o, ratio) { const x0 = o.shape === 'circle' ? o.x - o.r : o.x, y0 = o.shape === 'circle' ? o.y - o.r : o.y, w = o.shape === 'circle' ? o.r * 2 : o.w, h = o.shape === 'circle' ? o.r * 2 : o.h; ctx.save(); ctx.strokeStyle = `rgba(20,14,10,${0.35 + ratio * 0.4})`; ctx.lineWidth = 2.5; let s = o.id * 9301 + 49297; const rnd = () => { s = (s * 9301 + 49297) % 233280; return s / 233280; }; const lines = 2 + Math.floor((1 - ratio) * 3); for (let i = 0; i < lines; i++) { ctx.beginPath(); let x = x0 + rnd() * w, y = y0 + rnd() * h; ctx.moveTo(x, y); for (let k = 0; k < 3; k++) { x += (rnd() - 0.5) * w * 0.5; y += (rnd() - 0.5) * h * 0.5; ctx.lineTo(x, y); } ctx.stroke(); } ctx.restore(); }

  drawRubble(ctx, o) { ctx.save(); const x = o.shape === 'circle' ? o.x : o.x + o.w / 2, y = o.shape === 'circle' ? o.y : o.y + o.h / 2, r = o.shape === 'circle' ? o.r : Math.max(o.w, o.h) * 0.55; ctx.globalAlpha = 0.85; ctx.fillStyle = 'rgba(28,24,20,0.55)'; ctx.beginPath(); ctx.ellipse(x, y, r * 1.05, r * 0.85, 0, 0, Math.PI * 2); ctx.fill(); let s = o.id * 1337 + 77; const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647; }; const colors = o.material === 'woodCrate' ? ['#8a5f36', '#6f4a28'] : o.material === 'barrel' ? ['#7c3a28', '#4a4a4a'] : o.material === 'tree' ? ['#3c5a38', '#5a3f22'] : ['#6f7580', '#565b64']; for (let i = 0; i < 7; i++) { const a = rnd() * Math.PI * 2, d = rnd() * r * 0.95, px = x + Math.cos(a) * d, py = y + Math.sin(a) * d * 0.8, sz = 3 + rnd() * 7; ctx.fillStyle = colors[i % colors.length]; ctx.save(); ctx.translate(px, py); ctx.rotate(rnd() * Math.PI); ctx.fillRect(-sz / 2, -sz / 2, sz, sz * 0.7); ctx.restore(); } ctx.restore(); }

  drawPickup(ctx, p, time) { const info = POWERUP_INFO[p.kind] || POWERUP_INFO.repair; const bob = Math.sin(time / 360 + p.id) * 3; ctx.save(); ctx.translate(p.x, p.y + bob); const pulse = 1 + Math.sin(time / 240 + p.id) * 0.08; const grad = ctx.createRadialGradient(0, 0, 2, 0, 0, POWERUP.radius * 2.4 * pulse); grad.addColorStop(0, hexA(info.color, 0.55)); grad.addColorStop(0.5, hexA(info.color, 0.16)); grad.addColorStop(1, hexA(info.color, 0)); ctx.fillStyle = grad; ctx.beginPath(); ctx.arc(0, 0, POWERUP.radius * 2.4 * pulse, 0, Math.PI * 2); ctx.fill(); ctx.fillStyle = 'rgba(12,16,12,0.75)'; ctx.beginPath(); ctx.arc(0, 0, POWERUP.radius, 0, Math.PI * 2); ctx.fill(); ctx.strokeStyle = info.color; ctx.lineWidth = 3; ctx.stroke(); ctx.font = '18px system-ui, -apple-system, "Segoe UI Emoji", sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(info.icon, 0, 1); ctx.restore(); }
  drawTankShadow(ctx, t) { ctx.save(); ctx.globalAlpha = 0.3; ctx.fillStyle = '#000'; ctx.beginPath(); ctx.ellipse(t.x + 5, t.y + 7, TANK.radius * 1.15, TANK.radius * 0.95, 0, 0, Math.PI * 2); ctx.fill(); ctx.restore(); }
  drawTank(ctx, t, view) { const cloaked = !!(t.flags & FLAGS.CLOAK) && t.id !== view.meId; ctx.save(); ctx.globalAlpha = cloaked ? 0.3 : 1; if (!cloaked) { ctx.save(); ctx.globalAlpha = 0.22; ctx.strokeStyle = t.color; ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(t.x, t.y, TANK.radius + 7, 0, Math.PI * 2); ctx.stroke(); ctx.restore(); } ctx.translate(t.x, t.y); if (t.flags & FLAGS.BOOST) { ctx.save(); ctx.globalAlpha = 0.4; ctx.fillStyle = '#ffd23f'; for (let i = 1; i <= 3; i++) { ctx.beginPath(); ctx.arc(-Math.cos(t.angle) * i * 11, -Math.sin(t.angle) * i * 11, 6 - i, 0, Math.PI * 2); ctx.fill(); } ctx.restore(); } ctx.save(); ctx.rotate(t.angle); ctx.fillStyle = TANK_BODY.tracks; roundRect(ctx, -TANK.radius * 0.95, -TANK.radius * 1.02, TANK.radius * 1.9, TANK.radius * 0.42, 3); ctx.fill(); roundRect(ctx, -TANK.radius * 0.95, TANK.radius * 0.6, TANK.radius * 1.9, TANK.radius * 0.42, 3); ctx.fill(); ctx.strokeStyle = 'rgba(0,0,0,0.5)'; ctx.lineWidth = 1.5; for (let i = -2; i <= 2; i++) { const px = (i / 2.5) * TANK.radius * 0.8; ctx.beginPath(); ctx.moveTo(px, -TANK.radius * 1.02); ctx.lineTo(px, -TANK.radius * 0.6); ctx.stroke(); ctx.beginPath(); ctx.moveTo(px, TANK.radius * 0.6); ctx.lineTo(px, TANK.radius * 1.02); ctx.stroke(); } ctx.fillStyle = t.color; roundRect(ctx, -TANK.radius * 0.92, -TANK.radius * 0.66, TANK.radius * 1.84, TANK.radius * 1.32, 5); ctx.fill(); ctx.fillStyle = 'rgba(255,255,255,0.16)'; roundRect(ctx, -TANK.radius * 0.8, -TANK.radius * 0.58, TANK.radius * 1.6, TANK.radius * 0.34, 3); ctx.fill(); ctx.fillStyle = 'rgba(0,0,0,0.22)'; roundRect(ctx, -TANK.radius * 0.8, TANK.radius * 0.28, TANK.radius * 1.6, TANK.radius * 0.3, 3); ctx.fill(); ctx.strokeStyle = 'rgba(0,0,0,0.55)'; ctx.lineWidth = 2; roundRect(ctx, -TANK.radius * 0.92, -TANK.radius * 0.66, TANK.radius * 1.84, TANK.radius * 1.32, 5); ctx.stroke(); ctx.restore(); ctx.save(); ctx.rotate(t.turret); ctx.fillStyle = 'rgba(20,22,26,0.9)'; roundRect(ctx, TANK.radius * 0.3, -4.5, TANK.radius * 1.25, 9, 3); ctx.fill(); ctx.fillStyle = '#2b3038'; roundRect(ctx, TANK.radius * 1.45, -5.5, 8, 11, 3); ctx.fill(); if (t.flags & FLAGS.MEGA) { ctx.fillStyle = '#ff7a29'; roundRect(ctx, TANK.radius * 0.55, -6.5, TANK.radius * 0.9, 13, 4); ctx.fill(); } ctx.fillStyle = shade(t.color, -0.18); ctx.beginPath(); ctx.arc(0, 0, TANK.radius * 0.72, 0, Math.PI * 2); ctx.fill(); ctx.fillStyle = t.color; ctx.beginPath(); ctx.arc(-1, -1, TANK.radius * 0.58, 0, Math.PI * 2); ctx.fill(); ctx.strokeStyle = 'rgba(0,0,0,0.5)'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(0, 0, TANK.radius * 0.72, 0, Math.PI * 2); ctx.stroke(); ctx.restore(); if (t.flags & FLAGS.SHIELD) { ctx.save(); const pulse = 1 + Math.sin(view.time / 160) * 0.05; ctx.strokeStyle = 'rgba(90,190,255,0.85)'; ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(0, 0, TANK.radius * 1.5 * pulse, 0, Math.PI * 2); ctx.stroke(); ctx.fillStyle = 'rgba(90,190,255,0.14)'; ctx.fill(); ctx.restore(); } if (t.id === view.meId && view.phase === 'PLAYING') { ctx.save(); ctx.globalAlpha = 0.9; ctx.fillStyle = '#fff'; ctx.beginPath(); const bob = Math.sin(view.time / 200) * 2; ctx.moveTo(0, -TANK.radius - 14 + bob); ctx.lineTo(-7, -TANK.radius - 24 + bob); ctx.lineTo(7, -TANK.radius - 24 + bob); ctx.closePath(); ctx.fill(); ctx.restore(); } ctx.restore(); }
  drawBullet(ctx, b) { ctx.save(); ctx.translate(b.x, b.y); ctx.rotate(b.angle); const mega = b.kind === 1; ctx.globalAlpha = 0.5; ctx.fillStyle = mega ? '#ff8c3a' : '#ffd980'; ctx.beginPath(); ctx.moveTo(-10, -3); ctx.lineTo(2, -5); ctx.lineTo(2, 5); ctx.lineTo(-10, 3); ctx.closePath(); ctx.fill(); ctx.globalAlpha = 1; ctx.fillStyle = mega ? '#ffd9a0' : '#fff6d8'; roundRect(ctx, -5, -3.5, 11, 7, 3); ctx.fill(); ctx.fillStyle = mega ? '#ff6a1f' : '#ffb545'; ctx.beginPath(); ctx.arc(7, 0, mega ? 5 : 3.5, 0, Math.PI * 2); ctx.fill(); ctx.restore(); }
  drawParticles(ctx, list) { for (const p of list) { const t = p.life / p.maxLife; ctx.save(); ctx.globalAlpha = clamp(t, 0, 1) * (p.alpha ?? 1); ctx.globalCompositeOperation = p.additive ? 'lighter' : 'source-over'; if (p.type === 'ring') { ctx.strokeStyle = p.color; ctx.lineWidth = p.size * t * 1.6; ctx.beginPath(); ctx.arc(p.x, p.y, (1 - t) * (p.radius || 60), 0, Math.PI * 2); ctx.stroke(); } else if (p.type === 'flash') { const r = (1 - t) * (p.radius || 40); const grad = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, Math.max(1, r)); grad.addColorStop(0, 'rgba(255,255,235,0.95)'); grad.addColorStop(0.4, p.color); grad.addColorStop(1, 'rgba(255,120,20,0)'); ctx.fillStyle = grad; ctx.beginPath(); ctx.arc(p.x, p.y, Math.max(1, r), 0, Math.PI * 2); ctx.fill(); } else if (p.type === 'debris') { ctx.translate(p.x, p.y); ctx.rotate(p.rot || 0); ctx.fillStyle = p.color; ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.7); } else { ctx.fillStyle = p.color; ctx.beginPath(); ctx.arc(p.x, p.y, Math.max(0.4, p.size * (p.type === 'smoke' ? (0.6 + (1 - t) * 0.9) : t)), 0, Math.PI * 2); ctx.fill(); } ctx.restore(); } }
  drawZone(ctx, zone, time, b) { if (!zone) return; const { cx, cy, r } = zone; ctx.save(); ctx.beginPath(); ctx.rect(b.x0 - 100, b.y0 - 100, (b.x1 - b.x0) + 200, (b.y1 - b.y0) + 200); ctx.arc(cx, cy, r, 0, Math.PI * 2, true); ctx.fillStyle = 'rgba(180,30,30,0.20)'; ctx.fill('evenodd'); const pulse = 0.7 + Math.sin(time / 300) * 0.3; ctx.strokeStyle = `rgba(255,70,60,${0.55 + pulse * 0.3})`; ctx.lineWidth = 8; ctx.setLineDash([34, 22]); ctx.lineDashOffset = -time / 40; ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]); ctx.strokeStyle = 'rgba(255,190,120,0.5)'; ctx.lineWidth = 2.5; ctx.beginPath(); ctx.arc(cx, cy, r - 8, 0, Math.PI * 2); ctx.stroke(); if (zone.targetR && Math.abs(zone.targetR - r) > 4) { ctx.strokeStyle = 'rgba(255,255,255,0.35)'; ctx.lineWidth = 3; ctx.setLineDash([14, 12]); ctx.beginPath(); ctx.arc(cx, cy, zone.targetR, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]); } ctx.restore(); }
  drawLabels(ctx, view, cam) { const fs = clamp(Math.round(this.width / 62), 11, 17); ctx.save(); ctx.textAlign = 'center'; ctx.textBaseline = 'bottom'; for (const t of view.tanks) { const cloaked = !!(t.flags & FLAGS.CLOAK) && t.id !== view.meId, hidden = cloaked && view.phase === 'PLAYING', p = worldToScreen(t.x, t.y, cam, this.width, this.height); if (p.x < -120 || p.x > this.width + 120 || p.y < -80 || p.y > this.height + 80) continue; const top = p.y - (TANK.radius + 30) * cam.scale, barW = clamp(58 * cam.scale, 40, 86), barH = 6; ctx.globalAlpha = hidden ? 0.3 : 1; ctx.fillStyle = 'rgba(0,0,0,0.55)'; roundRect(ctx, p.x - barW / 2 - 1, top - 1, barW + 2, barH + 2, 3); ctx.fill(); const hpRatio = clamp(t.hp / 100, 0, 1); ctx.fillStyle = hpRatio > 0.55 ? '#57cc99' : hpRatio > 0.28 ? '#ffd23f' : '#f2545b'; roundRect(ctx, p.x - barW / 2, top, barW * hpRatio, barH, 2); ctx.fill(); ctx.font = `700 ${fs}px "Rajdhani", system-ui, sans-serif`; ctx.lineWidth = 3.5; ctx.strokeStyle = 'rgba(0,0,0,0.8)'; ctx.fillStyle = t.id === view.meId ? '#ffffff' : t.color; if (hidden) ctx.fillStyle = 'rgba(220,220,220,0.55)'; ctx.strokeText(t.name, p.x, top - 4); ctx.fillText(t.name, p.x, top - 4); ctx.globalAlpha = 1; } ctx.restore(); }
  drawDamageNumbers(ctx, view, cam) { if (!view.damageNumbers) return; ctx.save(); ctx.textAlign = 'center'; ctx.font = '800 16px "Rajdhani", system-ui, sans-serif'; for (const d of view.damageNumbers) { const p = worldToScreen(d.x, d.y - (1 - d.life / d.maxLife) * 34, cam, this.width, this.height); ctx.globalAlpha = clamp(d.life / d.maxLife, 0, 1); ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0,0,0,0.75)'; ctx.fillStyle = d.color || '#ffd23f'; ctx.strokeText(d.text, p.x, p.y); ctx.fillText(d.text, p.x, p.y); } ctx.restore(); }
  drawCrosshair(ctx, view, cam) { if (!view.aimPoint) return; const p = worldToScreen(view.aimPoint.x, view.aimPoint.y, cam, this.width, this.height); ctx.save(); ctx.translate(p.x, p.y); ctx.strokeStyle = view.canHit ? 'rgba(255,255,255,0.9)' : 'rgba(255,120,110,0.75)'; ctx.lineWidth = 2; const g = 8, l = 7; ctx.beginPath(); ctx.moveTo(-g - l, 0); ctx.lineTo(-g, 0); ctx.moveTo(g, 0); ctx.lineTo(g + l, 0); ctx.moveTo(0, -g - l); ctx.lineTo(0, -g); ctx.moveTo(0, g); ctx.lineTo(0, g + l); ctx.stroke(); ctx.beginPath(); ctx.arc(0, 0, 2, 0, Math.PI * 2); ctx.fillStyle = 'rgba(255,255,255,0.9)'; ctx.fill(); ctx.restore(); }
  drawVignette(ctx) { if (!this._vignette || this._vignetteW !== this.width || this._vignetteH !== this.height) { const g = ctx.createRadialGradient(this.width / 2, this.height / 2, Math.min(this.width, this.height) * 0.32, this.width / 2, this.height / 2, Math.max(this.width, this.height) * 0.78); g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(0,0,0,0.45)'); this._vignette = g; this._vignetteW = this.width; this._vignetteH = this.height; } ctx.save(); ctx.fillStyle = this._vignette; ctx.fillRect(0, 0, this.width, this.height); ctx.restore(); }
  drawMinimap(view) { const g = this.miniCtx, map = this.map, sx = MINI_W / map.w, sy = MINI_H / map.h; g.clearRect(0, 0, MINI_W, MINI_H); g.drawImage(this.miniBase || this.mini, 0, 0); const z = view.zone; if (z) { g.save(); g.beginPath(); g.rect(0, 0, MINI_W, MINI_H); g.arc(z.cx * sx, z.cy * sy, z.r * sx, 0, Math.PI * 2, true); g.fillStyle = 'rgba(190,40,40,0.28)'; g.fill('evenodd'); g.strokeStyle = 'rgba(255,90,80,0.95)'; g.lineWidth = 1.5; g.beginPath(); g.arc(z.cx * sx, z.cy * sy, Math.max(1, z.r * sx), 0, Math.PI * 2); g.stroke(); g.restore(); } g.fillStyle = '#ffd23f'; for (const p of view.pickups) { g.beginPath(); g.arc(p.x * sx, p.y * sy, 2, 0, Math.PI * 2); g.fill(); } for (const t of view.tanks) { const cloaked = !!(t.flags & FLAGS.CLOAK) && t.id !== view.meId; g.globalAlpha = cloaked ? 0.25 : 1; g.fillStyle = t.id === view.meId ? '#ffffff' : t.color; g.beginPath(); g.arc(t.x * sx, t.y * sy, t.id === view.meId ? 3.6 : 3, 0, Math.PI * 2); g.fill(); g.globalAlpha = 1; } if (view.cam) { const vw = (this.width / view.cam.scale) * sx, vh = (this.height / view.cam.scale) * sy; g.strokeStyle = 'rgba(255,255,255,0.35)'; g.lineWidth = 1; g.strokeRect(view.cam.x * sx - vw / 2, view.cam.y * sy - vh / 2, vw, vh); } }
  initMinimapBase() { const copy = document.createElement('canvas'); copy.width = MINI_W; copy.height = MINI_H; copy.getContext('2d').drawImage(this.mini, 0, 0); this.miniBase = copy; }
}

export function worldToScreen(x, y, cam, w, h) { return { x: (x - cam.x) * cam.scale + w / 2, y: (y - cam.y) * cam.scale + h / 2 }; }
export function screenToWorld(x, y, cam, w, h) { return { x: (x - w / 2) / cam.scale + cam.x, y: (y - h / 2) / cam.scale + cam.y }; }
function roundRect(ctx, x, y, w, h, r) { const rr = Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2); ctx.beginPath(); ctx.moveTo(x + rr, y); ctx.lineTo(x + w - rr, y); ctx.quadraticCurveTo(x + w, y, x + w, y + rr); ctx.lineTo(x + w, y + h - rr); ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h); ctx.lineTo(x + rr, y + h); ctx.quadraticCurveTo(x, y + h, x, y + h - rr); ctx.lineTo(x, y + rr); ctx.quadraticCurveTo(x, y, x + rr, y); ctx.closePath(); }
function layerOf(o) { switch (o.material) { case 'barrel': return 1; case 'rock': return 2; case 'sandbag': return 3; case 'woodCrate': return 4; case 'metalCrate': return 5; case 'barrier': return 6; case 'metal': return 7; case 'tree': return 8; case 'concrete': return 9; case 'building': return 10; default: return 5; } }
function hexA(hex, a) { const h = hex.replace('#', ''); const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16); const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255; return `rgba(${r},${g},${b},${a})`; }
function shade(hex, amount) { const h = hex.replace('#', ''); const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16); let r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255; r = clamp(Math.round(r + 255 * amount), 0, 255); g = clamp(Math.round(g + 255 * amount), 0, 255); b = clamp(Math.round(b + 255 * amount), 0, 255); return `rgb(${r},${g},${b})`; }
export { clamp, WORLD };
