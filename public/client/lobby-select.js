const tankKey = 'tankfall.tankType';
let selectedTank = localStorage.getItem(tankKey) || 'assault';
let selectedMap = 'gully';

const wire = () => {
  const tankRoot = document.querySelector('[data-kind="tank"]');
  const mapRoot = document.querySelector('[data-kind="map"]');
  if (!tankRoot || !mapRoot) return;
  const set = (root, key) => root.querySelectorAll('.selection-btn').forEach(b => b.classList.toggle('selected', b.dataset.key === key));
  set(tankRoot, selectedTank); set(mapRoot, selectedMap);
  tankRoot.addEventListener('click', e => {
    const b = e.target.closest('.selection-btn'); if (!b) return;
    selectedTank = b.dataset.key; localStorage.setItem(tankKey, selectedTank); set(tankRoot, selectedTank);
    document.dispatchEvent(new CustomEvent('tankfall:tank-selected', { detail: { tankType: selectedTank } }));
  });
  mapRoot.addEventListener('click', e => {
    const b = e.target.closest('.selection-btn'); if (!b) return;
    selectedMap = b.dataset.key; set(mapRoot, selectedMap);
    document.dispatchEvent(new CustomEvent('tankfall:map-selected', { detail: { mapId: selectedMap } }));
  });
};
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire); else wire();
window.TankfallSelection = { get tankType(){ return selectedTank; }, get mapId(){ return selectedMap; } };
