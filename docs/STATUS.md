# TANKFALL — build status / handoff

Last updated: session on branch `arena/01a0a5d9-tank-battle`.

## What is built (complete and playable)

Everything from the brief is implemented and wired end to end:

| Area | State |
| --- | --- |
| Room create + 6-char codes + join by code | ✅ server (`server/room.js`, `server/index.js`) |
| Lobby (roster, ready, host badge, activity feed, chat, open-room browser) | ✅ `public/client/hud.js` |
| **Host renames any player, synced to every device** | ✅ server-authoritative (`Room.doRename`), rename locked outside WAITING/FINISHED |
| Name safety (16 chars, markup/control/payload stripping, never `innerHTML`) | ✅ `shared/protocol.js` + `textContent` only in the HUD |
| Real-time multiplayer (WebSocket, 30 Hz authoritative sim) | ✅ snapshot ~5.5 KB/s down, ~2 KB/s up per player at 8 tanks |
| Battlefield (city / industrial / forest / field / military base / river + bridge / warehouse) | ✅ seeded generator `shared/mapgen.js`, ~190 obstacles |
| Destructible cover + exploding barrels (chain reaction) | ✅ server damage → `destroy`/`boom` events → all clients |
| Tank movement, independent turret, shooting, muzzle/impact/explosion FX | ✅ shared physics + `public/client/render.js` |
| Health, damage feedback, elimination, kill feed | ✅ |
| Spectator mode with NEXT/PREV cycling | ✅ |
| Shrinking battle zone (6 phases, countdown, escalating damage, hard 6-min cap) | ✅ |
| Powerups: mega / shield / repair / boost / cloak | ✅ server-spawned and applied |
| Mobile controls (thumb joystick, FIRE, ⚡) + desktop (WASD/mouse) | ✅ `public/client/input.js` |
| Winner screen, battle report (kills/damage/shots/survival), PLAY AGAIN, BACK TO LOBBY | ✅ |
| Audio (synthesised, on/off, remembered) | ✅ `public/client/audio.js` |
| Error handling, reconnect with token, host migration, room TTL, rate limits | ✅ |

## Verified by automated tests

`npm test` runs two suites (no browser needed):

* `test/e2e.test.mjs` — real WebSocket clients against a real server: room codes,
  host renaming + cross-device sync (spec §32), host-only permissions, countdown
  → combat → single winner → scoreboard, disconnect/reconnect with token
  validation, host migration (lobby + mid-match), name sanitisation, 8-tank
  capacity, anti-cheat limits (teleport/bogus input/fire-rate/no damage channel),
  destructible cover + powerups, compressed shrinking-zone collapse.
  Single scenario: `node test/e2e.test.mjs lobby|match|reconnect|host|validation|destruction|anticheat|zone`
* `test/client.test.mjs` — the **real client code** run headlessly against a real
  server via a DOM stub: boot, lobby rendering, rename propagation, prediction
  accuracy vs authority, damage feedback, death → spectator, late-joiner
  spectator path, results rendering, host-only rematch, zero uncaught errors.

Load check (8 tanks in a firefight, 15–60 s): 5.5 KB/s down, 31 snapshots/s per
client; server stays idle.

## Known limitations / deliberate scope

* **Secret Mission mode** (spec §21, optional) is not implemented — the brief
  marks it as a future optional mode; Free For All is the shipped mode.
* Mid-match **joiners become spectators** (documented decision: no mid-match
  spawning), and mid-match reconnects keep their own tank.
* Team War (optional future mode) is not implemented.
* Rendered canvas output has been verified structurally (real renderer code
  executes thousands of draw calls per frame with no errors) and the map layout
  has been reviewed as a PNG (`node tools/map-preview.mjs`), but no real-browser
  screenshot pass was possible in this sandbox (no headless Chrome available).

## If you pick this up again

1. `npm install && npm start` → preview at port 3000.
2. `npm test` to see the full green suite (takes a few minutes: bots actually
   fight full matches).
3. Verify in a real browser: two tabs, create room, join with the code, rename
   each other, start the battle, check mobile touch controls on a phone.
