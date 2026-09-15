// TANKFALL — deterministic battlefield generator.
// One seed → one map, identical on the server and on every client.
// The battlefield is split into themed districts so it never feels like a
// flat empty arena: ruined city, industrial yard, forest, open field,
// military base, a bridge over the river, and a warehouse compound.

import { WORLD, makeRng } from './constants.js';

export const OB = {
  MATERIAL_HP: {
    concrete: Infinity,
    rock: Infinity,
    building: Infinity,
    metal: 150,
    metalCrate: 95,
    woodCrate: 40,
    barrel: 22,
    sandbag: 900,
    tree: 60,
    barrier: 70,
  },
  DESTRUCTIBLE: {
    metal: true,
    metalCrate: true,
    woodCrate: true,
    barrel: true,
    tree: true,
    barrier: true,
    sandbag: false,
    concrete: false,
    rock: false,
    building: false,
  },
};

const THEMES = {
  city: { body: '#6d7383', edge: '#4a4f5c', roof: '#585e6c', accent: '#8b93a6' },
  industry: { body: '#7a6a55', edge: '#544839', roof: '#645743', accent: '#b08d57' },
  military: { body: '#5c6b4f', edge: '#3e4a35', roof: '#4c5942', accent: '#8fa06f' },
  forest: { body: '#4a6b4f', edge: '#33492f', roof: '#3d5a41', accent: '#7fa87f' },
  field: { body: '#7d8a56', edge: '#5b6640', roof: '#6b7749', accent: '#c7cf8d' },
  warehouse: { body: '#66707f', edge: '#454c58', roof: '#525a67', accent: '#93a0b3' },
};

function rect(rng, x, y, w, h, material, theme) {
  const hp = OB.MATERIAL_HP[material] ?? 50;
  return {
    shape: 'rect', x: Math.round(x), y: Math.round(y),
    w: Math.round(w), h: Math.round(h),
    material, theme, maxHp: hp === Infinity ? 0 : hp,
    hp: hp === Infinity ? 0 : hp,
    indestructible: hp === Infinity,
    destroyed: false,
    id: 0,
  };
}

function circle(rng, x, y, r, material, theme) {
  const hp = OB.MATERIAL_HP[material] ?? 50;
  return {
    shape: 'circle', x: Math.round(x), y: Math.round(y), r: Math.round(r),
    material, theme, maxHp: hp === Infinity ? 0 : hp,
    hp: hp === Infinity ? 0 : hp,
    indestructible: hp === Infinity,
    destroyed: false,
    id: 0,
  };
}

function building(rng, x, y, w, h, theme, opts = {}) {
  const o = rect(rng, x, y, w, h, 'building', theme);
  o.kind = 'building';
  o.height = opts.height ?? 1;
  return o;
}

/** Non-colliding decorative ground marking (streets, sand, cracks). */
function deco(kind, x, y, w, h, extra = {}) {
  return { kind, x, y, w, h, ...extra };
}

export function generateMap(seed) {
  const rng = makeRng(seed);
  const W = WORLD.w, H = WORLD.h;
  const obstacles = [];
  const decoList = [];
  const spawns = [];

  // ---------------------------------------------------------------- river + bridge
  const riverX = Math.round(W * 0.60);
  const riverW = 150;
  const bridgeY = Math.round(H * 0.42);
  const bridgeH = 150;
  const riverTop = 0;
  const riverBottom = H;

  const push = (o) => { obstacles.push(o); return o; };

  // Water is a hard obstacle split around the bridge opening.
  push(rect(rng, riverX, riverTop, riverW, bridgeY, 'concrete', 'industry'));
  push(rect(rng, riverX, bridgeY + bridgeH, riverW, riverBottom - (bridgeY + bridgeH), 'concrete', 'industry'));

  decoList.push(deco('water', riverX, 0, riverW, H));
  decoList.push(deco('bridge', riverX, bridgeY, riverW, bridgeH));

  // Bridge railings (destructible barricades) leave a ~90px lane to fight in.
  push(rect(rng, riverX - 8, bridgeY - 14, riverW + 16, 14, 'barrier', 'industry'));
  push(rect(rng, riverX - 8, bridgeY + bridgeH, riverW + 16, 14, 'barrier', 'industry'));

  // ---------------------------------------------------------------- districts
  // 0: ruined city (NW)  1: industrial (NE)  2: forest (SW)
  // 3: open field (S center)  4: military base (SE)  5: warehouse (west of bridge)

  // ---------- 0. RUINED CITY (x 60..760, y 60..680)
  decoList.push(deco('road', 60, 300, 700, 46));
  decoList.push(deco('road', 380, 60, 46, 620));
  const cityBlocks = [
    [90, 90, 210, 160], [340, 90, 180, 130], [560, 110, 150, 150],
    [100, 400, 170, 150], [330, 430, 200, 140], [580, 400, 140, 170],
  ];
  for (const [bx, by, bw, bh] of cityBlocks) {
    push(building(rng, bx, by, bw, bh, 'city', { height: 1.2 }));
  }
  // Rubble: broken light walls & crates around the blocks
  for (let i = 0; i < 30; i++) {
    const x = 70 + rng() * 700, y = 70 + rng() * 600;
    if (insideAny(x, y, obstacles, 26)) continue;
    const roll = rng();
    if (roll < 0.34) push(rect(rng, x, y, 26 + rng() * 46, 26 + rng() * 30, 'barrier', 'city'));
    else if (roll < 0.6) push(rect(rng, x, y, 34 + rng() * 26, 34 + rng() * 22, 'woodCrate', 'city'));
    else if (roll < 0.82) push(circle(rng, x, y, 18 + rng() * 9, 'barrel', 'city'));
    else push(rect(rng, x, y, 120 + rng() * 90, 20, 'metal', 'city'));
  }

  // ---------- 1. INDUSTRIAL YARD (x 1000..2340, y 60..620)
  decoList.push(deco('sand', 1000, 60, 1340, 560));
  push(building(rng, 1660, 90, 300, 210, 'industry', { height: 1.4 }));
  push(building(rng, 2060, 330, 210, 170, 'industry', { height: 1.1 }));
  push(rect(rng, 1180, 110, 120, 90, 'metalCrate', 'industry'));
  push(rect(rng, 1180, 260, 90, 170, 'metalCrate', 'industry'));
  // Pipe rows
  for (let i = 0; i < 3; i++) {
    push(rect(rng, 1420, 120 + i * 120, 190, 26, 'metal', 'industry'));
  }
  for (let i = 0; i < 40; i++) {
    const x = 1000 + rng() * 1330, y = 80 + rng() * 530;
    if (insideAny(x, y, obstacles, 28)) continue;
    const roll = rng();
    if (roll < 0.45) push(circle(rng, x, y, 20 + rng() * 8, 'barrel', 'industry'));
    else if (roll < 0.8) push(rect(rng, x, y, 40 + rng() * 40, 40 + rng() * 34, 'metalCrate', 'industry'));
    else push(rect(rng, x, y, 120 + rng() * 90, 22, 'metal', 'industry'));
  }

  // ---------- 2. FOREST (x 60..1080, y 900..1740)
  decoList.push(deco('grass', 60, 880, 1080, 880));
  for (let i = 0; i < 150; i++) {
    const x = 100 + rng() * 1020, y = 940 + rng() * 780;
    if (insideAny(x, y, obstacles, 12)) continue;
    push(circle(rng, x, y, 22 + rng() * 13, 'tree', 'forest'));
  }
  for (let i = 0; i < 22; i++) {
    const x = 120 + rng() * 980, y = 960 + rng() * 760;
    if (insideAny(x, y, obstacles, 26)) continue;
    push(circle(rng, x, y, 32 + rng() * 16, 'rock', 'forest'));
  }
  push(rect(rng, 300, 1160, 190, 120, 'woodCrate', 'forest'));  // log pile
  push(rect(rng, 640, 1480, 210, 110, 'woodCrate', 'forest'));
  decoList.push(deco('trench', 200, 1050, 240, 60));
  decoList.push(deco('trench', 700, 1580, 300, 60));
  push(rect(rng, 200, 1040, 240, 16, 'sandbag', 'forest'));
  push(rect(rng, 200, 1104, 240, 16, 'sandbag', 'forest'));
  push(rect(rng, 700, 1570, 300, 16, 'sandbag', 'forest'));
  push(rect(rng, 700, 1634, 300, 16, 'sandbag', 'forest'));

  // ---------- 3. OPEN FIELD + central hill (x 900..1750, y 850..1560)
  decoList.push(deco('grass', 860, 820, 900, 780));
  push(circle(rng, 1300, 1210, 88, 'rock', 'field'));
  push(circle(rng, 1440, 1330, 58, 'rock', 'field'));
  push(circle(rng, 1160, 1100, 46, 'rock', 'field'));
  for (let i = 0; i < 34; i++) {
    const x = 900 + rng() * 840, y = 860 + rng() * 720;
    if (insideAny(x, y, obstacles, 30)) continue;
    const roll = rng();
    if (roll < 0.5) push(rect(rng, x, y, 40 + rng() * 34, 40 + rng() * 34, 'woodCrate', 'field'));
    else if (roll < 0.75) push(circle(rng, x, y, 22 + rng() * 10, 'barrel', 'field'));
    else push(rect(rng, x, y, 150, 22, 'sandbag', 'field'));
  }

  // ---------- 4. MILITARY BASE (x 1760..2340, y 780..1740)
  decoList.push(deco('sand', 1740, 760, 620, 1000));
  push(building(rng, 1860, 860, 260, 180, 'military', { height: 1 }));   // barracks
  push(building(rng, 2000, 1180, 320, 200, 'military', { height: 1.3 })); // hangar
  push(building(rng, 1880, 1520, 180, 150, 'military', { height: 1 }));
  // Bunker walls forming a firing line
  push(rect(rng, 1800, 700, 40, 240, 'concrete', 'military'));
  push(rect(rng, 1800, 700, 240, 40, 'concrete', 'military'));
  for (let i = 0; i < 34; i++) {
    const x = 1800 + rng() * 500, y = 820 + rng() * 880;
    if (insideAny(x, y, obstacles, 28)) continue;
    const roll = rng();
    if (roll < 0.5) push(circle(rng, x, y, 22, 'barrel', 'military'));
    else if (roll < 0.8) push(rect(rng, x, y, 46, 44, 'metalCrate', 'military'));
    else push(rect(rng, x, y, 130, 24, 'sandbag', 'military'));
  }

  // ---------- 5. WAREHOUSE COMPOUND (x 850..1140, y 90..660)
  decoList.push(deco('road', 840, 60, 320, 640));
  push(building(rng, 880, 110, 130, 300, 'warehouse', { height: 1.1 }));
  push(building(rng, 880, 460, 130, 190, 'warehouse', { height: 1 }));
  for (let i = 0; i < 18; i++) {
    const x = 1010 + rng() * 130, y = 200 + rng() * 380;
    if (insideAny(x, y, obstacles, 20)) continue;
    push(rect(rng, x, y, 42 + rng() * 22, 40 + rng() * 20, 'woodCrate', 'warehouse'));
  }

  // ---------------------------------------------------------------- mid-map cover belt
  // A loose line of cover between the districts keeps rotations interesting.
  for (let i = 0; i < 10; i++) {
    const x = 200 + rng() * 2000;
    const y = 700 + rng() * 120;
    if (insideAny(x, y, obstacles, 30)) continue;
    const roll = rng();
    if (roll < 0.4) push(rect(rng, x, y, 130 + rng() * 90, 22, 'sandbag', 'field'));
    else if (roll < 0.7) push(rect(rng, x, y, 46, 44, 'metalCrate', 'industry'));
    else push(circle(rng, x, y, 20, 'barrel', 'industry'));
  }

  // ---------------------------------------------------------------- perimeter walls
  const t = 40;
  push(rect(rng, -t, -t, W + t * 2, t, 'concrete', 'city'));
  push(rect(rng, -t, H, W + t * 2, t, 'concrete', 'city'));
  push(rect(rng, -t, 0, t, H, 'concrete', 'city'));
  push(rect(rng, W, 0, t, H, 'concrete', 'city'));

  // ---------------------------------------------------------------- ids
  let id = 1;
  for (const o of obstacles) {
    o.id = id++;
    // Water is visually distinct; keep it out of the destroyable lists.
    if (o.material === 'concrete' && o.x === riverX && (o.w === riverW)) o.kind = 'water';
  }

  // ---------------------------------------------------------------- spawn hexes
  spawns.push(
    { name: 'Warehouse', x: 1040, y: 620 },
    { name: 'Industrial', x: 1560, y: 500 },
    { name: 'Ruined City', x: 300, y: 210 },
    { name: 'City Ruins', x: 620, y: 620 },
    { name: 'Industrial Dock', x: 2180, y: 620 },
    { name: 'Military Base', x: 1820, y: 1460 },
    { name: 'Deep Forest', x: 300, y: 1560 },
    { name: 'Forest Ridge', x: 760, y: 980 },
    { name: 'Open Field', x: 1520, y: 1520 },
    { name: 'Central Hill', x: 1180, y: 1360 },
    { name: 'Bridge North', x: 1520, y: 520 },
    { name: 'Bridge South', x: 1520, y: 1100 },
    { name: 'Military Yard', x: 2260, y: 960 },
    { name: 'North Forest', x: 620, y: 860 },
  );

  // Every spawn must be clear of cover — nudge blocked ones to a free spot.
  const clean = [];
  for (const s of spawns) {
    const spot = findFreeSpot(s.x, s.y, obstacles, W, H);
    clean.push({ name: s.name, x: spot.x, y: spot.y });
  }
  if (clean.length < 4) {
    for (let i = clean.length; i < 4; i++) clean.push({ name: 'Fallback', x: 300 + i * 400, y: 900 });
  }

  return {
    seed,
    w: W,
    h: H,
    theme: THEMES,
    obstacles,
    deco: decoList,
    spawns: clean,
    center: { x: W / 2, y: H / 2 },
  };
}

/** Finds a nearby point that is not inside (or right next to) any cover. */
function findFreeSpot(x, y, obstacles, W, H) {
  const free = (px, py) => {
    if (px < 60 || py < 60 || px > W - 60 || py > H - 60) return false;
    for (const o of obstacles) {
      const bx0 = o.shape === 'circle' ? o.x - o.r : o.x;
      const by0 = o.shape === 'circle' ? o.y - o.r : o.y;
      const bx1 = o.shape === 'circle' ? o.x + o.r : o.x + o.w;
      const by1 = o.shape === 'circle' ? o.y + o.r : o.y + o.h;
      if (px > bx0 - 44 && px < bx1 + 44 && py > by0 - 44 && py < by1 + 44) return false;
    }
    return true;
  };
  if (free(x, y)) return { x, y };
  for (let ring = 1; ring <= 6; ring++) {
    const r = ring * 60;
    for (let k = 0; k < 12; k++) {
      const a = (k / 12) * Math.PI * 2 + ring * 0.4;
      const px = Math.round(x + Math.cos(a) * r);
      const py = Math.round(y + Math.sin(a) * r);
      if (free(px, py)) return { x: px, y: py };
    }
  }
  return { x, y };
}

function insideAny(x, y, obstacles, pad) {
  for (let i = obstacles.length - 1; i >= 0; i--) {
    const o = obstacles[i];
    const bx0 = o.shape === 'circle' ? o.x - o.r : o.x;
    const by0 = o.shape === 'circle' ? o.y - o.r : o.y;
    const bx1 = o.shape === 'circle' ? o.x + o.r : o.x + o.w;
    const by1 = o.shape === 'circle' ? o.y + o.r : o.y + o.h;
    if (x > bx0 - pad && x < bx1 + pad && y > by0 - pad && y < by1 + pad) return true;
  }
  return false;
}

export { THEMES };
