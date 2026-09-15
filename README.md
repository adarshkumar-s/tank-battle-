# TANKFALL — LAST TANK STANDING

A real-time, **server-authoritative** multiplayer browser tank battle.
One player creates a private Battle Room, gets a 6-character code, friends join
from their own phones/laptops on the same URL, the host gives everyone
ridiculous names, and then everyone drops into the same live battlefield.
**Last tank alive wins.**

```
CREATE ROOM → SHARE CODE → FRIENDS JOIN → HOST GIVES EVERYONE RIDICULOUS NAMES
→ START BATTLE → SHOOT EVERYTHING → LAST TANK ALIVE WINS
```

---

## Quick start

```bash
npm install
npm start           # → http://localhost:3000
```

Open the URL on your laptop, hit **CREATE BATTLE**, then open the same URL on
your phone and type the 6-character room code (or tap an entry in *OPEN BATTLE
ROOMS*). Every device on the same origin shares the same rooms.

| Environment variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP + WebSocket port |
| `HOST` | `0.0.0.0` | Bind address (0.0.0.0 keeps LAN devices able to connect) |
| `TANKFALL_ZONE_SCALE` | `0` (off) | Test hook: scales the battle-zone schedule |
| `TANKFALL_POWERUP_SCALE` | `0` (off) | Test hook: scales powerup spawn timing |

```bash
npm test            # 100+ checks: end-to-end multiplayer + headless real client
npm run dev         # same server with --watch
node tools/map-preview.mjs 4242 /tmp/map.png   # render a battlefield to PNG/BMP
```

---

## Stack & why

The repository shipped empty, so TANKFALL was built as a **small, self-contained
Node app** with the fewest moving parts that are still production-shaped:

| Layer | Choice | Why |
| --- | --- | --- |
| Server | Node + `ws` (one dependency) | WebSocket multiplayer + static hosting in one process, one origin |
| Simulation | Custom fixed-step loop, 30 Hz | Deterministic, easy to audit, no engine overhead |
| Transport | Binary snapshots + JSON events | ~5.5 KB/s down and ~2 KB/s up per player in an 8-tank match |
| Client | Vanilla ES modules + Canvas 2D | No build step, instant load on phones, no framework tax |
| UI | Hand-written DOM + CSS | Lobby/screens are DOM; the battlefield is canvas |
| Audio | WebAudio synthesis | No audio assets to download; degrades to silence safely |
| Map | Deterministic seeded generator | One seed → identical battlefield on server *and* every client |
| Rooms/state | In-memory | No database to fail; rooms expire automatically |

There is **no fake multiplayer anywhere**: the host is a normal client, all
device-to-device state flows through the server, and the server decides every
outcome.

```
tank-battle-/
├── server/
│   ├── index.js      HTTP + WebSocket endpoints, message validation, game loop
│   ├── room.js       rooms, lobby state machine, host authority, reconnection
│   └── game.js       authoritative match sim (tanks, shells, damage, zone, powerups)
├── shared/
│   ├── constants.js  tuning values shared by both sides
│   ├── physics.js    collision world, circle/rect resolution, raycasts, tank stepping
│   ├── mapgen.js     seeded battlefield generator (7 districts)
│   ├── protocol.js   message names, error strings, name/code sanitising
│   └── snapshot.js   binary snapshot encoder/decoder
├── public/
│   ├── app.js        bootstrap + flow (home → lobby → battle → results)
│   ├── index.html    all screens + HUD structure
│   ├── styles.css    arcade-military UI, mobile-first responsive
│   └── client/
│       ├── net.js     WebSocket client, reconnect, input batching
│       ├── input.js   thumb joystick + fire/boost, WASD + mouse
│       ├── game.js    interpolation, prediction, camera, effects
│       ├── render.js  canvas renderer (terrain, tanks, minimap, zone)
│       ├── hud.js     lobby, kill feed, spectator, scoreboard, rename modal
│       └── audio.js   synthesised SFX + engine hum
├── test/
│   ├── e2e.test.mjs  real WebSocket bots against a real server
│   ├── client.test.mjs runs the real client code headlessly (DOM stub)
│   ├── bot.mjs       combat bot (LOS-aware) used by the tests
│   └── dom.mjs       minimal DOM/canvas stub for headless client tests
└── tools/map-preview.mjs  battlefield → PNG/BMP for layout review
```

---

## Server authority (security model)

The client only ever sends **intent**:

```
→ create / join / rejoin          → rename / ready / start / kick / move / rematch
→ input  [[seq, mx, my, turret, fire, boost], …]        → chat / ping
```

The server owns and re-derives everything else:

* **Rooms, codes, capacity (8), host privileges** — never client-supplied.
* **Names** — sanitised server-side (`sanitizeName`): 16-char cap, control
  characters, whitespace runs, and every HTML/JS-significant character
  (`< > { } \ $ ` " ' | / [ ] * _`) stripped. The client renders names with
  `textContent` only, never `innerHTML`, so a joke name can never become markup.
* **Movement** — inputs are clamped to a unit vector, non-finite values are
  coerced to 0, and the tank is integrated by the shared physics step (speed,
  acceleration and turn-rate limits). Stale/duplicate input sequences are
  dropped. Measured in tests: max 8 px step per tick, never outside the map.
* **Fire rate** — a server-side reload timer; spamming the socket yields no
  extra shells.
* **Damage / health / kills / winner** — computed only from server collisions
  and the battle-zone timer. There is no client → damage message at all.
* **Renaming** — host-only for other players, and disabled outside
  `WAITING`/`FINISHED` (spec §26). Non-hosts are rejected server-side.
* **Rate limiting** — token bucket per socket; oversized/unknown messages are
  dropped; `maxPayload` is 16 KB; static file serving is traversal-safe.

## Room state machine

```
WAITING ──host starts──▶ COUNTDOWN ──▶ PLAYING ──last tank / hard cap──▶ FINISHED
   ▲                          │               │                              │
   └──────── not enough players ┘        rematch (host) ◀────────────────────┘
```

* `WAITING` — join, leave, ready, **rename**, kick, reorder, start battle.
* `COUNTDOWN` — 3…2…1…FIRE! broadcast; a drop below 2 tanks cancels it.
* `PLAYING` — inputs, combat, spectator mode; renaming is locked.
* `FINISHED` — winner + battle report; only the host can start a rematch.

## Networking & performance

* 30 Hz authoritative fixed-step simulation; **one binary snapshot per step**
  (`DataView`, 16-bit positions at 0.5 px precision, 16-bit angles, 8-bit
  health/timers) — measured **5.5 KB/s down per client** with 8 tanks in a
  firefight, plus ~17 small JSON events/s.
* Clients send 30 batched input samples per second (~2 KB/s up).
* Remote entities are **interpolated** ~110 ms in the past with brief
  extrapolation on jitter; your own tank is **predicted** with the exact shared
  physics step and smoothly corrected (~14 % blend, hard snap beyond 140 px).
* Reconnect: the client stores `{code, playerId, token}` in `localStorage` and
  auto-rejoins after the socket drops. The server keeps the seat for 45 s,
  replays destroyed cover/pickups via a `sync` message and invalidates old
  sockets so a seat can never be hijacked without the token.
* Host disconnect → instant migration in the lobby, 22 s grace mid-match
  (the disconnected host's tank self-destructs after 15 s so the match can
  still finish).
* Rooms self-clean when empty (90 s) or after 6 h.

## Gameplay summary

* **Battlefield** — one deterministic 2400×1800 map per match built from seven
  districts: ruined city, warehouse compound, industrial yard, forest with
  trenches, open field with a rock hill, military base with bunkers, and a river
  crossed by a single bridge. ~190 obstacles per map.
* **Destructible cover** — crates (wood/metal), barrels, barricades, pipes,
  trees and log piles take damage and vanish for everyone at once, leaving
  rubble and scorch marks and opening new firing lanes. Concrete, buildings and
  rock are permanent.
* **Barrels explode** — a chain reaction with falloff damage; standing next to
  one is a genuinely bad idea.
* **Shrinking battle zone** — six phases announced to every client with a
  countdown, live boundary, next-circle preview and escalating damage outside.
  A hard 6-minute cap guarantees a winner even if everyone camps.
* **Powerups** (server-spawned, server-applied): 💥 MEGA SHELL · 🛡 SHIELD ·
  🔧 REPAIR · ⚡ BOOST · 👻 CLOAK.
* **Tanks** — hull and turret rotate independently, hold-to-boost burns a
  server-owned energy budget, spawn protection, and 8 distinct liveries.
* **Spectator mode** — destroyed players cycle survivors with live health,
  names, remaining-tank count and the shrinking zone.
* **Social** — kill feed with the host's funny names, join/leave/ready notices,
  room chat, countdown, elimination banners, victory screen with the full battle
  report (kills, damage, shots, survival time) and a one-tap rematch.

## Controls

| | Mobile | Desktop |
| --- | --- | --- |
| Move | left-thumb joystick (appears where you touch) | `WASD` / arrows |
| Aim | soft auto-aim with a leader marker (tap `NEXT`/`PREV` in spectator) | mouse — crosshair turns red when cover blocks the shot |
| Fire | big red **FIRE** button | click or `Space` |
| Boost | ⚡ button | `Shift` |
| Sound | 🔊 button (off by default, remembered) | same |

Multi-touch safe (pointer events), no page scroll / pinch-zoom / text selection
during battle, safe-area aware, and it scales from a small phone in landscape to
a 4K desktop. Portrait phones get a rotate hint; the HUD compacts on short
screens.

## Testing

`npm test` runs two suites (no browser required):

1. **`test/e2e.test.mjs`** — spawns a real server and drives real WebSocket
   clients through: room codes, host renaming with cross-device sync, host-only
   permissions, countdown → combat → single winner → scoreboard, disconnects and
   seat reconnection with token validation, host migration (lobby and mid-match),
   name sanitisation, capacity limits, anti-cheat limits (teleport, bogus input,
   fire-rate, no damage channel), destructible cover + powerup effects and the
   compressed shrinking-zone collapse.
   `node test/e2e.test.mjs lobby` (or `match`, `reconnect`, `host`,
   `validation`, `destruction`, `anticheat`, `zone`) runs a single scenario.
2. **`test/client.test.mjs`** — boots the **real client code** (HUD, renderer,
   prediction loop, networking) against a real server using a DOM stub, then
   verifies boot, lobby rendering, rename propagation, prediction accuracy,
   damage feedback, death → spectator mode, the late-joiner spectator path,
   results rendering, host-only rematch, and zero uncaught client errors.

## Deployment notes

Single process, single port, no build step. Any Node 18+ host works
(Fly.io/Render/Railway/a VPS/`docker run`):

```bash
PORT=8080 node server/index.js
```

For HTTPS, terminate TLS in a reverse proxy and forward both HTTP and the
`/ws` upgrade (WebSockets are required for multiplayer; the client picks
`wss://` automatically when the page is served over HTTPS).
