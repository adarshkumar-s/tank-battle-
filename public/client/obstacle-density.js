// TANKFALL — keep the battlefield readable and light on phones.
// Major structures stay intact; decorative cover is reduced to roughly 1/4.
import { Renderer } from './render.js';

const KEEP_MOD = 4;

function keepObstacle(o) {
  if (!o) return false;
  // Keep map-defining structures and perimeter/water geometry.
  if (o.kind === 'water') return true;
  if (o.material === 'building' || o.material === 'concrete') return true;
  // Deterministic: every device sees the same reduced obstacle layout.
  return ((Math.abs((o.id || 0) * 1103515245 + 12345) >>> 0) % KEEP_MOD) === 0;
}

const originalDrawObstacles = Renderer.prototype.drawObstacles;
Renderer.prototype.drawObstacles = function drawObstaclesReduced(ctx, bounds) {
  const obstacles = this.map?.obstacles;
  if (!obstacles) return originalDrawObstacles.call(this, ctx, bounds);
  const reduced = obstacles.filter(keepObstacle);
  this.map.obstacles = reduced;
  try {
    return originalDrawObstacles.call(this, ctx, bounds);
  } finally {
    this.map.obstacles = obstacles;
  }
};

const originalBuildMinimap = Renderer.prototype.buildMinimap;
Renderer.prototype.buildMinimap = function buildMinimapReduced() {
  const obstacles = this.map?.obstacles;
  if (!obstacles) return originalBuildMinimap.call(this);
  const reduced = obstacles.filter(keepObstacle);
  this.map.obstacles = reduced;
  try {
    return originalBuildMinimap.call(this);
  } finally {
    this.map.obstacles = obstacles;
  }
};
