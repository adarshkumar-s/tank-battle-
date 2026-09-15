// Lightweight battle controls plus presentation tuning.
import { ClientGame } from './game.js';
import { Renderer } from './render.js';

const menu = document.getElementById('battleMenu');
const open = document.getElementById('btnBattleMenu');
const resume = document.getElementById('btnMenuResume');
const restart = document.getElementById('btnMenuRestart');
const leave = document.getElementById('btnMenuLeave');
const fullscreen = document.getElementById('btnFullscreen');

function setOpen(value) {
  if (!menu) return;
  menu.classList.toggle('hidden', !value);
  menu.setAttribute('aria-hidden', String(!value));
}

open?.addEventListener('click', () => setOpen(true));
resume?.addEventListener('click', () => setOpen(false));

restart?.addEventListener('click', () => {
  if (!confirm('Restart this battle? You will return to the room lobby.')) return;
  location.reload();
});

leave?.addEventListener('click', () => {
  if (!confirm('Leave this battle?')) return;
  location.href = '/';
});

fullscreen?.addEventListener('click', async () => {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await document.documentElement.requestFullscreen();
  } catch { /* browser does not allow fullscreen */ }
});

document.addEventListener('fullscreenchange', () => {
  if (!fullscreen) return;
  fullscreen.title = document.fullscreenElement ? 'Exit fullscreen' : 'Fullscreen';
});

// The arena is bounded by permanent map walls now; remove the legacy circle
// overlay and its minimap layer without changing authoritative simulation.
Renderer.prototype.drawZone = function drawZoneDisabled() {};
const drawMinimap = Renderer.prototype.drawMinimap;
Renderer.prototype.drawMinimap = function drawMinimapWithoutZone(view) {
  return drawMinimap.call(this, { ...view, zone: null });
};

// On touch devices keep the player's tank prominent, while retaining a wider
// tactical view on desktop. This adapts automatically as the viewport changes.
const updateCameraScale = ClientGame.prototype.updateCameraScale;
ClientGame.prototype.updateCameraScale = function updateCameraScaleMobile() {
  updateCameraScale.call(this);
  const coarse = matchMedia('(pointer: coarse)').matches;
  if (!coarse) return;
  const w = this.renderer.width || window.innerWidth;
  const h = this.renderer.height || window.innerHeight;
  const portrait = h > w;
  const boost = portrait ? 1.18 : 1.28;
  this.cam.scale = Math.min(1.75, this.cam.scale * boost);
};
