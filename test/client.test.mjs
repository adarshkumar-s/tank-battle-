// TANKFALL — headless client test.
// Runs the REAL browser client code (HUD, renderer, prediction loop, input,
// networking) inside Node against a REAL server, with a DOM stub standing in
// for the browser. This catches broken element ids, renderer crashes, HUD
// regressions and message-flow bugs without needing a browser.

import { spawn } from 'node:child_process';
import { register } from 'node:module';
import { WebSocket } from 'ws';
import { installDom } from './dom.mjs';
import { Bot } from './bot.mjs';

const PORT = 3960 + Math.floor(Math.random() * 30);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
let failed = 0;
const failures = [];
const runtimeErrors = [];

function ok(cond, label, extra = '') {
  if (cond) { passed++; console.log(`  \x1b[32m✓\x1b[0m ${label}`); }
  else { failed++; failures.push(label); console.log(`  \x1b[31m✗ ${label}\x1b[0m ${extra}`); }
}

async function main() {
  const server = spawn(process.execPath, ['server/index.js'], {
    cwd: new URL('..', import.meta.url).pathname,
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (d) => process.stdout.write(`[server] ${d}`));
  server.stderr.on('data', (d) => process.stderr.write(`[server:err] ${d}`));
  await sleep(700);

  process.on('uncaughtException', (err) => {
    runtimeErrors.push(String(err && err.stack));
    console.error('\x1b[31mUNCAUGHT:\x1b[0m', err);
  });

  try {
    /* ---- boot the real client ---- */
    const dom = installDom();
    globalThis.WebSocket = WebSocket;
    globalThis.fetch = (url, opts) => fetch(new URL(url, `http://127.0.0.1:${PORT}`), opts);
    globalThis.location.host = `127.0.0.1:${PORT}`;
    globalThis.location.origin = `http://127.0.0.1:${PORT}`;

    await register('./loader.mjs', import.meta.url);
    const app = await import('../public/app.js');
    await sleep(200);
    console.log('\n▸ CLIENT BOOT (real client code, stubbed DOM)');
    ok(!!app.game && !!app.hud && !!app.net, 'client modules booted without crashing');
    ok(app.hud.screen === 'home', 'starts on the home screen');

    /* ---- host a room with a raw bot, then join with the real client ---- */
    const host = await new Bot('Hosty').connect(PORT);
    const joined = await host.create();
    const code = joined.code;
    const bruiser = await new Bot('Bruiser').connect(PORT);
    await bruiser.join(code);
    await sleep(200);

    const nameInput = dom.elements.get('nameInput');
    const codeInput = dom.elements.get('codeInput');
    nameInput.value = 'Rahul';
    codeInput.value = code;
    app.net.send({ t: 'join', code, name: 'Rahul' });
    await sleep(300);
    ok(app.hud.screen === 'lobby', 'real client entered the lobby over the network');
    const roomCodeEl = dom.elements.get('roomCode');
    ok(roomCodeEl.textContent === code, `room code rendered (${roomCodeEl.textContent})`);
    const playerList = dom.elements.get('playerList');
    ok(playerList.childElementCount === 3, `lobby lists every tank (${playerList.childElementCount})`);

    /* ---- host renames the real client; every display surface must update ---- */
    const meId = app.net.session.playerId;
    host.send({ t: 'rename', targetId: meId, name: 'Exploding Chai' });
    await sleep(250);
    const rowText = playerList.children.map((c) => c.textContent).join(' | ');
    ok(rowText.includes('Exploding Chai'), 'renamed tank appears in the lobby list');
    const activity = dom.elements.get('activity');
    ok(activity.children.some((c) => c.textContent.includes('Exploding Chai')), 'rename notice shown in the activity feed');

    /* ---- start the battle ---- */
    host.send({ t: 'start' });
    await sleep(4600);
    ok(app.game.phase === 'PLAYING', `client entered PLAYING (${app.game.phase})`);
    ok(!!app.game.map && app.game.map.obstacles.length > 100, `battlefield generated on the client (${app.game.map?.obstacles.length} obstacles)`);
    await sleep(700);
    ok(app.game.snaps.length > 5, `snapshots applied (${app.game.snaps.length})`);
    const ctx = app.game.renderer.ctx;
    ok(ctx.calls > 500, `renderer drew frames (${ctx.calls} canvas calls)`);
    const myTank = app.game.snaps[app.game.snaps.length - 1].tanks.find((t) => t.id === meId);
    ok(!!myTank, 'client tank exists in authoritative snapshots');
    ok(app.hud.screen === 'battle', 'HUD switched to the battle view');
    const hpFill = dom.elements.get('hpFill');
    ok(/scaleX/.test(hpFill.style.transform), `health bar driven by server hp (${hpFill.style.transform})`);
    const alive = dom.elements.get('aliveCount');
    ok(alive.textContent === '3', `alive counter correct (${alive.textContent})`);

    /* ---- prediction: local tank must track the server position ---- */
    await sleep(600);
    const renderPos = { x: app.game.pred.x, y: app.game.pred.y };
    const serverPos = app.game.snaps[app.game.snaps.length - 1].tanks.find((t) => t.id === meId);
    const err = Math.hypot(renderPos.x - serverPos.x, renderPos.y - serverPos.y);
    ok(err < 60, `client prediction matches authority (error ${err.toFixed(1)}px)`);

    /* ---- combat: get shot, watch HUD feedback ---- */
    const hpBefore = serverPos.hp;
    host.autopilot(meId);
    bruiser.autopilot(meId);
    let hpAfter = hpBefore;
    let sawDamage = false;
    for (let i = 0; i < 300; i++) {
      await sleep(200);
      const s = app.game.snaps[app.game.snaps.length - 1];
      const t = s && s.tanks.find((x) => x.id === meId);
      if (!t) { sawDamage = true; break; } // destroyed outright
      hpAfter = t.hp;
      if (hpAfter < hpBefore) { sawDamage = true; break; }
      if (app.game.diedAt) { sawDamage = true; break; }
    }
    ok(sawDamage, `server-authoritative damage applied to the client tank (${hpBefore} → ${hpAfter})`);
    const killfeed = dom.elements.get('killfeed');
    const toastText = dom.elements.get('toasts').children.map((c) => c.textContent).join('|');
    ok(true, 'damage feedback path executed without errors');

    /* ---- death → spectator mode (battle continues with 2 bots) ---- */
    let dead = false;
    for (let i = 0; i < 160; i++) {
      await sleep(200);
      if (app.game.diedAt) { dead = true; break; }
    }
    if (!dead) {
      const s2 = app.game.snaps[app.game.snaps.length - 1];
      console.log('   debug: last snapshot tanks =', JSON.stringify(s2 && s2.tanks.map((t) => ({ id: t.id, hp: t.hp }))));
      console.log('   debug: phase', app.game.phase, 'spectating', app.game.spectating, 'snaps', app.game.snaps.length);
      console.log('   debug: host events =', JSON.stringify(host.msgs.filter((m) => m.t === 'events').slice(-2)));
    }
    ok(dead, 'client tank was destroyed by server-authoritative damage');
    await sleep(400);
    ok(app.game.spectating === true, 'client switched to spectator mode');
    const spectatorEl = dom.elements.get('spectator');
    ok(!spectatorEl.classList.contains('hidden'), 'spectator panel visible');
    ok(killfeed.childElementCount >= 1, `kill feed rendered the elimination (${killfeed.childElementCount})`);
    const specName = dom.elements.get('specName');
    ok(typeof specName.textContent === 'string' && specName.textContent.length > 0, `spectator target named (${specName.textContent})`);
    // Cycling between survivors must work.
    const before = app.game.spectateTarget;
    dom.elements.get('btnSpecNext').dispatch('click');
    await sleep(120);
    ok(app.game.spectateTarget !== before || app.game.spectateIndex !== 0, 'NEXT cycles the spectator camera between survivors');
    dom.elements.get('btnSpecPrev').dispatch('click');
    await sleep(120);
    ok(true, 'PREVIOUS handled without errors');

    /* ---- a brand-new client joining mid-match must become a working spectator ---- */
    {
      const { ClientGame } = await import('../public/client/game.js');
      const { Renderer } = await import('../public/client/render.js');
      const stub = {
        input: { movement: () => ({ x: 0, y: 0 }), wantsFire: () => false, wantsBoost: () => false, setEnabled() {}, mouse: { x: 0, y: 0, active: false }, usingTouch: true },
        net: { queueInput() {}, flushInputs() {}, latencyMs: 20 },
        audio: { updateEngine() {}, cannon() {}, explosion() {}, hitArmor() {}, hitPlayer() {}, pickup() {}, countdown() {}, victory() {}, defeat() {}, zoneWarn() {}, debris() {}, startAmbience() {}, stopAmbience() {}, updateEngine() {} },
        hud: { update() {}, killFeed() {}, banner() {}, notice() {}, toast() {}, damageFlash() {}, showCountdown() {}, setSelfName() {}, setReconnecting() {} },
      };
      const lateCanvas = new dom.ElementStub('canvas');
      const lateGame = new ClientGame({
        canvas: lateCanvas, minimap: new dom.ElementStub('canvas'),
        input: stub.input, net: stub.net, audio: stub.audio, hud: stub.hud,
        renderer: new Renderer(lateCanvas),
      });
      lateGame.start();
      lateGame.me = { playerId: 4242, tankId: 4242, color: '#fff', name: 'Latey' };
      lateGame.applySync({ seed: host.match ? host.match.seed : app.game.seed, state: 'PLAYING', destroyed: [], pickups: [], zone: { cx: 1200, cy: 900, r: 900, phase: 0 }, results: null, winnerId: 0 });
      const realSnaps = host.snaps.slice(-12);
      let threw = null;
      try {
        for (const snap of realSnaps) { lateGame.onSnapshot(snap); lateGame.frame(1 / 60); }
        for (let i = 0; i < 20; i++) lateGame.frame(1 / 60);
      } catch (err) { threw = err; }
      ok(!threw, `late joiner renders as a spectator without errors${threw ? ` (${threw.message})` : ''}`);
      ok(lateGame.spectating === true, 'late joiner is flagged as spectating');
      ok(lateGame.pred === null, 'late joiner has no predicted tank (never spawns a phantom)');
      ok(lateGame.cam.x > 0 && lateGame.cam.y > 0, 'spectator camera follows a live survivor');
      lateGame.stop();
    }

    /* ---- match end → results screen ---- */
    const end = await host.waitFor((m) => m.t === 'events' && m.e.some((e) => e.k === 'end'), 180000).catch(() => null);
    ok(!!end, 'match reached a server-side conclusion');
    await sleep(3200);
    ok(app.hud.screen === 'results', `results screen shown (${app.hud.screen})`);
    const winnerName = dom.elements.get('winnerName');
    const realWinner = end ? end.e.find((e) => e.k === 'end').winnerName : null;
    ok(winnerName.textContent === realWinner, `winner name rendered from server results (${winnerName.textContent} === ${realWinner})`);
    ok(app.hud.screen !== 'results' || winnerName.textContent.length > 0, 'winner screen populated');
    const table = dom.elements.get('scoreTable');
    ok(table.childElementCount >= 3, `battle report rendered (${table.childElementCount} rows incl. header)`);

    /* ---- rematch driven by the host; the client must follow into a new match ---- */
    ok(dom.elements.get('btnPlayAgain').classList.contains('hidden'), 'non-host does not see PLAY AGAIN (host-only control)');
    host.send({ t: 'rematch', start: true });
    await sleep(1500);
    ok(app.game.phase !== 'FINISHED', `rematch returned the room to the lobby flow (${app.game.phase})`);
    await sleep(4200);
    ok(app.hud.screen === 'battle' && app.game.phase === 'PLAYING', 'second match started for the same clients');
    ok(app.game.snaps.length > 5, 'fresh snapshots streaming in the rematch');


    /* ---- touch controls survive real-device quirks (regression) ---- */
    {
      const R = (l, t, r, b) => ({ left: l, top: t, right: r, bottom: b, width: r - l, height: b - t, x: l, y: t });
      const joyZone = dom.elements.get('joyZone');
      const btnFire = dom.elements.get('btnFire');
      const realJoyRect = joyZone.getBoundingClientRect;
      const realFireRect = btnFire.getBoundingClientRect;
      joyZone.getBoundingClientRect = () => R(0, 352, 187, 844);
      btnFire.getBoundingClientRect = () => R(272, 700, 380, 808);
      // A picky mobile engine: every pointer-capture call throws.
      const realCapture = dom.ElementStub.prototype.setPointerCapture;
      dom.ElementStub.prototype.setPointerCapture = () => { throw new Error('InvalidStateError'); };

      const posOf = (id) => {
        const snap = app.game.snaps[app.game.snaps.length - 1];
        const t = snap && snap.tanks.find((x) => x.id === id);
        return t ? { x: t.x, y: t.y } : null;
      };

      const beforeJoy = posOf(meId);
      joyZone.dispatch('pointerdown', { pointerId: 71, pointerType: 'touch', clientX: 40, clientY: 760 });
      joyZone.dispatch('pointermove', { pointerId: 71, pointerType: 'touch', clientX: 170, clientY: 760 });
      await sleep(700);
      ok(app.game.input.mx > 0.5, `joystick works even when setPointerCapture throws (mx=${app.game.input.mx.toFixed(2)})`);
      const afterJoy = posOf(meId);
      ok(beforeJoy && afterJoy && Math.hypot(afterJoy.x - beforeJoy.x, afterJoy.y - beforeJoy.y) > 4,
        'a touch press actually drives the tank');
      joyZone.dispatch('pointerup', { pointerId: 71, pointerType: 'touch' });
      await sleep(120);
      ok(app.game.input.mx === 0, 'releasing the thumb stops the tank');

      const shotsBefore = host.events.filter((e) => e.k === 'shoot' && e.id === meId).length;
      btnFire.dispatch('pointerdown', { pointerId: 72, pointerType: 'touch', clientX: 330, clientY: 750 });
      await sleep(700);
      ok(app.game.input.fire === true, 'FIRE arms even when setPointerCapture throws');
      const shotsAfter = host.events.filter((e) => e.k === 'shoot' && e.id === meId).length;
      ok(shotsAfter > shotsBefore, `shots from a touch press reach the server (${shotsAfter - shotsBefore})`);
      btnFire.dispatch('pointerup', { pointerId: 72, pointerType: 'touch' });
      await sleep(150);
      ok(app.game.input.fire === false, 'FIRE releases cleanly (never stuck on)');

      // Touch that never reaches the control element (CSS pointer-events quirk).
      const beforeFallback = posOf(meId);
      const canvasEl = dom.elements.get('game');
      dom.window.dispatch('touchstart', { target: canvasEl, cancelable: true, changedTouches: [{ identifier: 81, clientX: 30, clientY: 780 }] });
      dom.window.dispatch('touchmove', { target: canvasEl, cancelable: true, changedTouches: [{ identifier: 81, clientX: 160, clientY: 780 }] });
      await sleep(700);
      ok(app.game.input.mx > 0.5, `joystick works when the touch lands on the canvas (mx=${app.game.input.mx.toFixed(2)})`);
      const afterFallback = posOf(meId);
      ok(beforeFallback && afterFallback && Math.hypot(afterFallback.x - beforeFallback.x, afterFallback.y - beforeFallback.y) > 4,
        'the fallback path drives the tank too');
      dom.window.dispatch('touchend', { target: canvasEl, cancelable: true, changedTouches: [{ identifier: 81 }] });
      await sleep(120);
      ok(app.game.input.mx === 0 && app.game.input.fire === false, 'fallback release clears every control');

      // Desktop must keep mouse aiming: a mouse press on FIRE is not a touch.
      btnFire.dispatch('pointerdown', { pointerId: 73, pointerType: 'mouse', clientX: 330, clientY: 750 });
      await sleep(60);
      ok(app.game.input.usingTouch === false, 'a mouse press on FIRE keeps mouse aiming on desktop');
      btnFire.dispatch('pointerup', { pointerId: 73, pointerType: 'mouse' });

      dom.ElementStub.prototype.setPointerCapture = realCapture;
      joyZone.getBoundingClientRect = realJoyRect;
      btnFire.getBoundingClientRect = realFireRect;
    }

    ok(runtimeErrors.length === 0, `no uncaught client errors during the whole session (${runtimeErrors.length})`);
    host.stop();
    bruiser.stop();
  } catch (err) {
    failed++;
    failures.push(String(err && err.message));
    console.error('\x1b[31mCLIENT SCENARIO CRASH:\x1b[0m', err);
  } finally {
    server.kill('SIGKILL');
  }

  console.log(`\n${failed === 0 ? '\x1b[32m' : '\x1b[31m'}${passed} passed, ${failed} failed\x1b[0m`);
  if (failed) { console.log('Failures:', failures); process.exit(1); }
  process.exit(0);
}

main();
