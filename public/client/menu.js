// Lightweight battle-only controls that do not touch authoritative game state.
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
  } catch {
    // Fullscreen is optional on browsers that do not expose the API.
  }
});

document.addEventListener('fullscreenchange', () => {
  if (!fullscreen) return;
  fullscreen.textContent = document.fullscreenElement ? '⛶' : '⛶';
  fullscreen.title = document.fullscreenElement ? 'Exit fullscreen' : 'Fullscreen';
});
