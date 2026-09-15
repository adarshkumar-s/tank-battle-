import { TANK_CLASSES, MAPS } from '/shared/constants.js';

const style = document.createElement('style');
style.textContent = `
.selection-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:14px}
.selection-panel{border:1px solid rgba(255,255,255,.09);border-radius:14px;padding:12px;background:rgba(0,0,0,.18)}
.selection-title{font-size:11px;letter-spacing:.16em;font-weight:800;margin-bottom:9px;opacity:.7}
.selection-options{display:grid;gap:7px}
.selection-btn{appearance:none;border:1px solid rgba(255,255,255,.1);border-radius:10px;background:rgba(255,255,255,.035);color:inherit;padding:9px;text-align:left;cursor:pointer}
.selection-btn:hover{background:rgba(255,255,255,.08)}
.selection-btn.selected{border-color:#ffd23f;box-shadow:0 0 0 1px rgba(255,210,63,.25);background:rgba(255,210,63,.08)}
.selection-btn b{display:block;font-size:12px}.selection-btn small{display:block;margin-top:3px;opacity:.55;font-size:10px}
@media(max-width:700px){.selection-grid{grid-template-columns:1fr}}
`;
document.head.appendChild(style);

const tankKey = 'tankfall.tankType';
let selectedTank = localStorage.getItem(tankKey) || 'assault';
let selectedMap = 'gully';
let root;

function makeButton(key, data, kind) {
  const b = document.createElement('button');
  b.type = 'button'; b.className = 'selection-btn';
  b.dataset.key = key;
  b.innerHTML = `<b>${data.icon || ''} ${data.label}</b><small>${data.description}</small>`;
  b.addEventListener('click', () => {
    if (kind === 'tank') {
      selectedTank = key; localStorage.setItem(tankKey, key);
      root.querySelectorAll('[data-kind="tank"] .selection-btn').forEach(x => x.classList.toggle('selected', x.dataset.key === key));
      document.dispatchEvent(new CustomEvent('tankfall:tank-selected', { detail: { tankType:key } }));
    } else {
      selectedMap = key;
      root.querySelectorAll('[data-kind="map"] .selection-btn').forEach(x => x.classList.toggle('selected', x.dataset.key === key));
      document.dispatchEvent(new CustomEvent('tankfall:map-selected', { detail: { mapId:key } }));
    }
  });
  return b;
}

function build() {
  if (root || !document.getElementById('screen-lobby')) return;
  root = document.createElement('div');
  root.className = 'selection-grid';
  const tanks = document.createElement('div'); tanks.className = 'selection-panel'; tanks.dataset.kind = 'tank';
  const maps = document.createElement('div'); maps.className = 'selection-panel'; maps.dataset.kind = 'map';
  tanks.innerHTML = '<div class="selection-title">CHOOSE YOUR TANK</div><div class="selection-options"></div>';
  maps.innerHTML = '<div class="selection-title">CHOOSE BATTLE MAP</div><div class="selection-options"></div>';
  for (const [key, data] of Object.entries(TANK_CLASSES)) tanks.querySelector('.selection-options').appendChild(makeButton(key, data, 'tank'));
  for (const [key, data] of Object.entries(MAPS)) maps.querySelector('.selection-options').appendChild(makeButton(key, data, 'map'));
  root.querySelectorAll('.selection-btn').forEach(() => {});
  tanks.querySelectorAll('.selection-btn').forEach(b => b.classList.toggle('selected', b.dataset.key === selectedTank));
  maps.querySelectorAll('.selection-btn').forEach(b => b.classList.toggle('selected', b.dataset.key === selectedMap));
  document.querySelector('#screen-lobby .lobby-grid')?.before(root);
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', build); else build();
window.TankfallSelection = { get tankType(){ return selectedTank; }, get mapId(){ return selectedMap; } };
