// TANKFALL — DOM layer: home, lobby, battle HUD, results, rename modal.
// All player-supplied strings go through textContent (never innerHTML), so a
// joke name can never turn into markup.

import { clamp } from '/shared/constants.js';

const FUN_NAMES = [
  'Potato Tank', 'Missile Uncle', 'Captain Noob', 'Exploding Chai', 'Tank Obama',
  'Boom Boi', 'Chai Commander', 'Sir Dies-A-Lot', 'Noob Destroyer', 'Turret Goblin',
  'Shell Donor', 'Big Boom', 'Tread Pirate', 'Crater Maker', 'Bullet Magnet',
  'Tiny Panzer', 'Doom Sandwich', 'Rocket Aunty', 'Angry Kettle', 'Waffle Cannon',
  'Spicy Cucumber', 'General Oops', 'Bunker Buddy', 'Lord Clanky',
];

const el = (id) => document.getElementById(id);

export class Hud {
  constructor(actions) {
    this.actions = actions;
    this.$ = {
      // screens
      home: el('screen-home'),
      lobby: el('screen-lobby'),
      results: el('screen-results'),
      hud: el('hud'),
      modal: el('modal'),
      // home
      nameInput: el('nameInput'),
      codeInput: el('codeInput'),
      btnCreate: el('btnCreate'),
      btnJoin: el('btnJoin'),
      btnRandomName: el('btnRandomName'),
      roomList: el('roomList'),
      btnRefreshRooms: el('btnRefreshRooms'),
      btnSoundHome: el('btnSoundHome'),
      // lobby
      roomCode: el('roomCode'),
      btnCopy: el('btnCopy'),
      btnShare: el('btnShare'),
      codeHint: el('codeHint'),
      playerList: el('playerList'),
      playersCount: el('playersCount'),
      btnStart: el('btnStart'),
      hostWait: el('hostWait'),
      btnReady: el('btnReady'),
      lobbyStatus: el('lobbyStatus'),
      activity: el('activity'),
      chatInput: el('chatInput'),
      btnSendChat: el('btnSendChat'),
      hostTools: el('hostTools'),
      btnLeave: el('btnLeave'),
      btnSoundLobby: el('btnSoundLobby'),
      // battle
      aliveCount: el('aliveCount'),
      zoneTimer: el('zoneTimer'),
      zoneLabel: el('zoneLabel'),
      zoneOutChip: el('zoneOutChip'),
      netText: el('netText'),
      btnSound: el('btnSound'),
      killfeed: el('killfeed'),
      pcName: el('pcName'),
      hpFill: el('hpFill'),
      hpBar: el('hpBar'),
      hpText: el('hpText'),
      enFill: el('enFill'),
      enBar: el('enBar'),
      pcEffects: el('pcEffects'),
      dmgFlash: el('dmgFlash'),
      zoneWarn: el('zoneWarn'),
      banner: el('banner'),
      countdown: el('countdown'),
      toasts: el('toasts'),
      spectator: el('spectator'),
      specName: el('specName'),
      specSub: el('specSub'),
      btnSpecPrev: el('btnSpecPrev'),
      btnSpecNext: el('btnSpecNext'),
      reconnect: el('reconnect'),
      rotateHint: el('rotateHint'),
      minimap: el('minimap'),
      // results
      winnerBadge: el('winnerBadge'),
      winnerName: el('winnerName'),
      winnerMeta: el('winnerMeta'),
      scoreTable: el('scoreTable'),
      scoreDuration: el('scoreDuration'),
      btnPlayAgain: el('btnPlayAgain'),
      btnBackToLobby: el('btnBackToLobby'),
      btnHoldOn: el('btnHoldOn'),
      // modal
      modalTitle: el('modalTitle'),
      modalInput: el('modalInput'),
      modalNames: el('modalNames'),
      modalCancel: el('modalCancel'),
      modalSave: el('modalSave'),
    };

    this.screen = 'home';
    this.me = null;
    this.room = null;
    this.renameTarget = 0;
    this.countdownTimer = null;
    this.bannerTimer = null;
    this._uiAcc = 0;
    this._lastChrome = '';
    this.activityLog = [];
    this.soundOn = false;
    this.rotateTimer = null;

    this.wireStatic();
    this.buildFunNames();
  }

  /* ------------------------------------------------------------------ *
   * Wiring
   * ------------------------------------------------------------------ */
  wireStatic() {
    const a = this.actions;
    const $ = this.$;

    $.btnRandomName?.addEventListener('click', () => {
      a.ui();
      $.nameInput.value = FUN_NAMES[Math.floor(Math.random() * FUN_NAMES.length)];
      $.nameInput.focus();
    });
    $.btnCreate?.addEventListener('click', () => {
      a.ui();
      a.create($.nameInput.value.trim());
    });
    $.btnJoin?.addEventListener('click', () => {
      a.ui();
      a.join($.codeInput.value.trim());
    });
    $.codeInput?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { a.ui(); a.join($.codeInput.value.trim()); }
    });
    $.codeInput?.addEventListener('input', () => {
      $.codeInput.value = $.codeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
    });
    $.nameInput?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { a.ui(); a.create($.nameInput.value.trim()); }
    });
    $.btnRefreshRooms?.addEventListener('click', () => { a.ui(); a.refreshRooms(); });
    $.btnSoundHome?.addEventListener('click', () => a.toggleSound());
    $.btnSoundLobby?.addEventListener('click', () => a.toggleSound());
    $.btnSound?.addEventListener('click', () => a.toggleSound());

    $.btnCopy?.addEventListener('click', () => a.copy());
    $.btnShare?.addEventListener('click', () => a.share());
    $.btnStart?.addEventListener('click', () => { a.ui(); a.start(); });
    $.btnReady?.addEventListener('click', () => { a.ui(); a.toggleReady(); });
    $.btnLeave?.addEventListener('click', () => a.leave());
    $.btnSendChat?.addEventListener('click', () => this.sendChat());
    $.chatInput?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.sendChat();
    });
    $.btnSpecNext?.addEventListener('click', () => a.spectate?.(1));
    $.btnSpecPrev?.addEventListener('click', () => a.spectate?.(-1));
    $.btnPlayAgain?.addEventListener('click', () => { a.ui(); a.playAgain(); });
    $.btnBackToLobby?.addEventListener('click', () => { a.ui(); a.backToLobby?.(); this.showScreen('lobby'); });
    $.modalCancel?.addEventListener('click', () => this.closeModal());
    $.modalSave?.addEventListener('click', () => this.saveModal());
    $.modalInput?.addEventListener('keydown', (e) => { if (e.key === 'Enter') this.saveModal(); });
    $.modal?.addEventListener('click', (e) => { if (e.target === $.modal) this.closeModal(); });
    $.rotateHint?.addEventListener('click', () => $.rotateHint.classList.remove('show'));

    window.addEventListener('resize', () => this.maybeShowRotateHint());
    window.addEventListener('orientationchange', () => setTimeout(() => this.maybeShowRotateHint(), 250));
  }

  buildFunNames() {
    const $ = this.$;
    const make = (host, target) => (label) => {
      const b = document.createElement('button');
      b.className = 'chip';
      b.type = 'button';
      b.textContent = label;
      b.addEventListener('click', () => { this.actions.rename(target, label); });
      host.appendChild(b);
      return b;
    };
    for (const n of FUN_NAMES.slice(0, 10)) make($.modalNames, () => this.renameTarget);
    for (const n of FUN_NAMES.slice(0, 8)) make($.hostTools.querySelector('.fun-names'), () => this.renameTarget || this.me?.id);
  }

  sendChat() {
    const $ = this.$;
    const text = $.chatInput.value.trim();
    if (!text) return;
    this.actions.chat(text);
    $.chatInput.value = '';
  }

  /* ------------------------------------------------------------------ *
   * Screens
   * ------------------------------------------------------------------ */
  showScreen(name) {
    this.screen = name;
    const $ = this.$;
    $.home.classList.toggle('hidden', name !== 'home');
    $.lobby.classList.toggle('hidden', name !== 'lobby');
    $.results.classList.toggle('hidden', name !== 'results');
    $.hud.classList.toggle('hidden', name !== 'battle');
    if (name === 'battle') this.maybeShowRotateHint();
    else $.rotateHint.classList.remove('show');
  }

  maybeShowRotateHint() {
    const $ = this.$;
    if (this.screen !== 'battle') return;
    const portrait = window.innerHeight > window.innerWidth;
    const touch = matchMedia('(pointer: coarse)').matches;
    $.rotateHint.classList.toggle('show', portrait && touch);
    clearTimeout(this.rotateTimer);
    if (portrait && touch) this.rotateTimer = setTimeout(() => $.rotateHint.classList.remove('show'), 7000);
  }

  setSound(on) {
    this.soundOn = on;
    const label = on ? '🔊' : '🔇';
    for (const key of ['btnSound', 'btnSoundLobby']) {
      const b = this.$[key];
      if (b) { b.textContent = label; b.title = on ? 'Sound on' : 'Sound off'; }
    }
    const home = this.$;
    if (home.btnSoundHome) home.btnSoundHome.textContent = `🔊 SOUND: ${on ? 'ON' : 'OFF'}`;
  }

  /* ------------------------------------------------------------------ *
   * Home
   * ------------------------------------------------------------------ */
  renderRooms(rooms) {
    const list = this.$.roomList;
    list.textContent = '';
    if (!rooms || !rooms.length) {
      const d = document.createElement('div');
      d.className = 'empty';
      d.textContent = 'No open rooms right now — create one and share the code.';
      list.appendChild(d);
      return;
    }
    for (const r of rooms) {
      const row = document.createElement('div');
      row.className = 'room-item';
      const code = document.createElement('div');
      code.className = 'rc';
      code.textContent = r.code;
      const players = document.createElement('div');
      players.className = 'rp';
      players.textContent = `${r.players}/${r.max} tanks`;
      const btn = document.createElement('button');
      btn.className = 'btn small';
      btn.textContent = 'JOIN';
      btn.addEventListener('click', () => {
        this.actions.ui();
        this.actions.join(r.code);
      });
      row.append(code, players, btn);
      list.appendChild(row);
    }
  }

  setName(name) {
    if (this.$.nameInput && !this.$.nameInput.value) this.$.nameInput.value = name || '';
  }

  setCode(code) {
    this.$.codeInput.value = code || '';
  }

  /* ------------------------------------------------------------------ *
   * Lobby
   * ------------------------------------------------------------------ */
  renderLobby(room, me) {
    const $ = this.$;
    this.room = room;
    this.me = me;
    if (!room) return;

    $.roomCode.textContent = room.code;
    $.playersCount.textContent = `${room.players.length} / ${room.maxPlayers}`;
    const isHost = me && room.hostId === me.id;

    // --- player rows ---
    const list = $.playerList;
    list.textContent = '';
    const sorted = room.players.slice();
    for (const p of sorted) {
      const row = document.createElement('div');
      row.className = 'prow' + (p.connected ? '' : ' offline') + (p.hostRenamed ? ' renamed' : '');
      row.style.setProperty('--pc', p.color);
      const dot = document.createElement('span');
      dot.className = 'dot';
      const nameWrap = document.createElement('div');
      nameWrap.className = 'pname';
      const nameRow = document.createElement('div');
      nameRow.className = 'pn';
      const nameText = document.createElement('span');
      nameText.textContent = p.name;
      nameRow.appendChild(nameText);
      if (p.isHost) nameRow.appendChild(badge('👑 HOST', 'host'));
      if (me && p.id === me.id) nameRow.appendChild(badge('YOU', 'you'));
      if (p.hostRenamed) nameRow.appendChild(badge('HOST NAMED', 'renamed'));
      if (p.ready && room.state === 'WAITING') nameRow.appendChild(badge('READY', 'ready'));
      if (!p.connected) nameRow.appendChild(badge('OFFLINE', 'you'));
      const sub = document.createElement('div');
      sub.className = 'psub';
      sub.textContent = buildSub(p, room);
      nameWrap.append(nameRow, sub);

      const act = document.createElement('div');
      act.className = 'pact';
      const canEdit = room.state === 'WAITING' || room.state === 'FINISHED';
      if (canEdit && (isHost || (me && me.id === p.id))) {
        const rb = document.createElement('button');
        rb.className = 'mini-btn';
        rb.textContent = '✏';
        rb.title = isHost && me.id !== p.id ? 'Rename this tank' : 'Change your name';
        rb.addEventListener('click', () => this.openModal(p.id, p.name));
        act.appendChild(rb);
      }
      if (isHost && room.state === 'WAITING' && me && p.id !== me.id) {
        const kb = document.createElement('button');
        kb.className = 'mini-btn';
        kb.textContent = '✕';
        kb.title = 'Remove from room';
        kb.addEventListener('click', () => this.actions.kick(p.id));
        act.appendChild(kb);
      }
      row.append(dot, nameWrap, act);
      list.appendChild(row);
    }

    // --- host controls ---
    const playing = room.state !== 'WAITING';
    $.btnStart.classList.toggle('hidden', !isHost);
    $.btnStart.disabled = playing || room.players.filter((p) => p.connected).length < room.minPlayers;
    $.hostWait.classList.toggle('hidden', isHost || playing);
    $.btnReady.classList.toggle('hidden', playing);
    const meRow = room.players.find((p) => me && p.id === me.id);
    if (meRow) $.btnReady.textContent = meRow.ready ? '✓ READY' : "I'M READY";

    let status = '';
    let warn = false;
    if (room.state === 'COUNTDOWN') {
      const secs = Math.ceil((room.countdownMs || 0) / 1000);
      status = secs > 3 ? 'GET READY…' : secs > 0 ? `${secs}…` : 'FIRE!';
      warn = true;
    } else if (room.state === 'FINISHED') {
      status = 'Battle finished — waiting for the host.';
    } else if (isHost) {
      const active = room.players.filter((p) => p.connected).length;
      status = active < room.minPlayers
        ? `Need at least ${room.minPlayers} tanks to start (${active} in room).`
        : 'Everyone in? Hit START BATTLE.';
    } else {
      status = 'Waiting for the host to start the battle…';
    }
    $.lobbyStatus.textContent = status;
    $.lobbyStatus.classList.toggle('warn', warn);

    $.codeHint.textContent = isHost
      ? 'Send this code to your friends — they join from any phone or laptop.'
      : 'You are in. Give the code to anyone else who wants to join.';
    $.hostTools.classList.toggle('hidden', !isHost);
  }

  activity(text, cls = '') {
    const $ = this.$;
    const line = document.createElement('div');
    line.className = `act ${cls}`;
    line.textContent = text;
    $.activity.appendChild(line);
    this.activityLog.push(line);
    while (this.activityLog.length > 120) {
      const old = this.activityLog.shift();
      old.remove();
    }
    $.activity.scrollTop = $.activity.scrollHeight;
  }

  chat(name, text, color) {
    const $ = this.$;
    const line = document.createElement('div');
    line.className = 'act chat';
    const b = document.createElement('b');
    b.textContent = `${name}: `;
    if (color) b.style.color = color;
    b.style.color = color || '';
    line.appendChild(b);
    line.appendChild(document.createTextNode(text));
    $.activity.appendChild(line);
    this.activityLog.push(line);
    while (this.activityLog.length > 120) {
      const old = this.activityLog.shift();
      old.remove();
    }
    $.activity.scrollTop = $.activity.scrollHeight;
  }

  clearActivity() {
    this.$.activity.textContent = '';
    this.activityLog = [];
  }

  /* ------------------------------------------------------------------ *
   * Modal (host rename)
   * ------------------------------------------------------------------ */
  openModal(targetId, current) {
    const $ = this.$;
    this.renameTarget = targetId;
    this.actions.ui();
    $.modalTitle.textContent = (this.me && targetId === this.me.id) ? 'CHANGE YOUR NAME' : 'GIVE THIS TANK A NAME';
    $.modalInput.value = current || '';
    $.modal.classList.remove('hidden');
    setTimeout(() => $.modalInput.focus(), 30);
  }

  closeModal() {
    this.$.modal.classList.add('hidden');
    this.renameTarget = 0;
  }

  saveModal() {
    const name = this.$.modalInput.value.trim();
    if (!name) return;
    this.actions.rename(this.renameTarget, name);
    this.closeModal();
  }

  /* ------------------------------------------------------------------ *
   * Battle HUD
   * ------------------------------------------------------------------ */
  update(state) {
    const $ = this.$;
    if (state.phase !== 'PLAYING' && state.phase !== 'FINISHED') return;
    this._uiAcc += 1;
    const chrome = `${state.tanks.length}|${state.spectating}|${state.zone ? Math.round(state.zone.nextMs / 500) : -1}`;
    const tick = this._uiAcc % 6 === 0 || chrome !== this._lastChrome;
    if (!tick) return;
    this._lastChrome = chrome;

    const hp = clamp(Math.round(state.hp), 0, 100);
    $.hpFill.style.transform = `scaleX(${hp / 100})`;
    $.hpText.textContent = `${hp}`;
    $.hpBar.classList.toggle('low', hp <= 55 && hp > 25);
    $.hpBar.classList.toggle('crit', hp <= 25);
    const en = clamp(Math.round(state.energy ?? 100), 0, 100);
    $.enFill.style.transform = `scaleX(${en / 100})`;
    $.enBar.classList.toggle('low', en < 20);

    const meMeta = state.tanks.find((t) => t.id === state.meId);
    $.pcName.textContent = (meMeta && meMeta.name) || this.me?.name || 'TANK';

    // effects badges
    const fx = [];
    if (meMeta) {
      if (meMeta.flags & 1) fx.push(`🛡 ${Math.ceil(meMeta.shieldS)}s`);
      if (meMeta.flags & 2) fx.push(`⚡ ${Math.ceil(meMeta.boostS)}s`);
      if (meMeta.flags & 4) fx.push(`👻 ${Math.ceil(meMeta.cloakS)}s`);
      if (meMeta.flags & 8) fx.push('💥 MEGA');
    }
    const fxText = fx.join('|');
    if (this._fxText !== fxText) {
      this._fxText = fxText;
      $.pcEffects.textContent = '';
      for (const f of fx) {
        const s = document.createElement('span');
        s.textContent = f;
        $.pcEffects.appendChild(s);
      }
    }

    $.aliveCount.textContent = String(state.tanks.length);
    if (state.zone) {
      const ms = Math.max(0, state.zone.nextMs);
      const secs = Math.ceil(ms / 1000);
      $.zoneTimer.textContent = `${String(Math.floor(secs / 60)).padStart(2, '0')}:${String(secs % 60).padStart(2, '0')}`;
      $.zoneLabel.textContent = state.zone.targetR < state.zone.r - 4 ? 'SHRINKING' : `ZONE ${state.zone.phase + 1}`;
      const meIn = meMeta ? Math.hypot(meMeta.x - state.zone.cx, meMeta.y - state.zone.cy) <= state.zone.r : true;
      $.zoneOutChip.classList.toggle('hidden', meIn || !meMeta);
      $.zoneWarn.classList.toggle('hidden', !(state.zone.targetR < state.zone.r - 4));
    }
    $.netText.textContent = `${state.latency}ms ${state.fps}fps`;

    // spectator panel
    $.spectator.classList.toggle('hidden', !state.spectating);
    if (state.spectating) {
      const target = state.tanks.find((t) => t.id === state.spectateId) || state.tanks[0];
      $.specName.textContent = target ? target.name : 'NO TANKS LEFT';
      $.specSub.textContent = state.tanks.length
        ? `${state.tanks.length} tank${state.tanks.length === 1 ? '' : 's'} still fighting · tap NEXT to cycle`
        : 'Battle over';
    }
  }

  killFeed(e) {
    const $ = this.$;
    const node = document.createElement('div');
    node.className = 'kf';
    const victimColor = this.colorOf(e.victimId);
    const killerColor = e.killerId ? this.colorOf(e.killerId) : '#aaa';
    node.style.setProperty('--kc', e.killerId ? killerColor : victimColor);

    const parts = [];
    switch (e.cause) {
      case 'shot':
        parts.push(['💥 ', null], [e.killerName || '???', killerColor], [' destroyed ', null], [e.victimName, victimColor]);
        break;
      case 'barrel':
        if (e.killerName) parts.push(['🔥 ', null], [e.killerName, killerColor], [' blew up ', null], [e.victimName, victimColor], [' with a barrel', null]);
        else parts.push(['🔥 ', null], [e.victimName, victimColor], [' got blown up by a barrel', null]);
        break;
      case 'zone':
        parts.push(['☠ ', null], [e.victimName, victimColor], [' melted in the battle zone', null]);
        break;
      case 'vanish':
        parts.push(['📡 ', null], [e.victimName, victimColor], [' disconnected', null]);
        break;
      default:
        parts.push(['☠ ', null], [e.victimName, victimColor], [' exploded', null]);
        break;
    }
    const mine = this.me && (e.killerId === this.me.id || e.victimId === this.me.id);
    for (const [text, color] of parts) {
      const s = document.createElement('span');
      s.textContent = text;
      if (color) { s.style.color = color; s.className = 'n' + (mine ? ' me' : ''); }
      node.appendChild(s);
    }
    $.killfeed.appendChild(node);
    while ($.killfeed.childElementCount > 5) $.killfeed.firstElementChild.remove();
    setTimeout(() => node.remove(), 6500);
  }

  colorOf(playerId) {
    if (!this.room) return '#ddd';
    const p = this.room.players.find((x) => x.id === playerId);
    return p ? p.color : '#ddd';
  }

  notice(text) {
    this.activity(text);
    if (this.screen === 'battle') this.toast(text);
  }

  toast(text, cls = '') {
    const $ = this.$;
    const node = document.createElement('div');
    node.className = `toast ${cls}`;
    node.textContent = text;
    $.toasts.appendChild(node);
    while ($.toasts.childElementCount > 4) $.toasts.firstElementChild.remove();
    setTimeout(() => {
      node.style.opacity = '0';
      node.style.transition = 'opacity 0.3s';
      setTimeout(() => node.remove(), 320);
    }, 3000);
  }

  banner(text, color = '#ffd23f', ms = 1400) {
    const $ = this.$;
    $.banner.textContent = text;
    $.banner.style.color = color;
    $.banner.classList.remove('hidden');
    clearTimeout(this.bannerTimer);
    this.bannerTimer = setTimeout(() => $.banner.classList.add('hidden'), ms);
  }

  showCountdown(text) {
    const $ = this.$;
    $.countdown.textContent = text === 'FIRE' ? 'FIRE!' : text;
    $.countdown.classList.remove('hidden');
    $.countdown.style.animation = 'none';
    void $.countdown.offsetWidth;
    $.countdown.style.animation = 'cd 0.9s ease-out';
    clearTimeout(this.countdownTimer);
    this.countdownTimer = setTimeout(() => $.countdown.classList.add('hidden'), 900);
  }

  damageFlash(intensity) {
    const $ = this.$;
    $.dmgFlash.style.opacity = String(clamp(intensity, 0, 1) * 0.85);
    clearTimeout(this._dmgTimer);
    this._dmgTimer = setTimeout(() => { $.dmgFlash.style.opacity = '0'; }, 90);
  }

  setReconnecting(on) {
    this.$.reconnect.classList.toggle('hidden', !on);
  }

  setSelfName() { /* names come from server events; nothing to do here */ }

  /* ------------------------------------------------------------------ *
   * Results
   * ------------------------------------------------------------------ */
  renderResults(room, me, durationMs) {
    const $ = this.$;
    const results = room.results || [];
    const winner = results.find((r) => r.placement === 1);
    const iWon = winner && me && winner.playerId === me.id;
    const noSurvivors = !winner || !room.winnerId;

    $.winnerBadge.textContent = noSurvivors ? '☠ NO SURVIVORS' : iWon ? '🏆 VICTORY!' : '🏆 WINNER';
    $.winnerName.textContent = noSurvivors ? 'NOBODY' : winner.name;
    $.winnerName.style.color = noSurvivors ? '#f2545b' : winner.color;
    const mine = results.find((r) => me && r.playerId === me.id);
    $.winnerMeta.textContent = mine && mine.placement === 1
      ? `You are the LAST TANK STANDING · ${mine.kills} kills · ${mine.damage} damage`
      : mine
        ? `You placed #${mine.placement} · ${mine.kills} kills · ${mine.damage} damage`
        : '';
    $.scoreDuration.textContent = durationMs ? `MATCH ${fmtTime(durationMs)}` : '';

    // score table
    const table = $.scoreTable;
    table.textContent = '';
    const head = document.createElement('tr');
    for (const label of ['#', 'TANK', 'KILLS', 'DMG', 'SHOTS', 'SURVIVED']) {
      const th = document.createElement('th');
      th.textContent = label;
      head.appendChild(th);
    }
    table.appendChild(head);
    for (const r of results) {
      const tr = document.createElement('tr');
      if (me && r.playerId === me.id) tr.className = 'me';
      const cells = [
        `${r.placement}`,
        r.name,
        `${r.kills}`,
        `${r.damage}`,
        `${r.shots}`,
        fmtTime(r.survivalMs),
      ];
      cells.forEach((text, i) => {
        const td = document.createElement('td');
        td.textContent = text;
        if (i === 0) td.className = 'place';
        if (i === 1) { td.className = 'pname'; td.style.color = r.color; }
        if (!r.alive && i === 5) td.className = 'dead';
        tr.appendChild(td);
      });
      table.appendChild(tr);
    }

    const isHost = me && room.hostId === me.id;
    $.btnPlayAgain.classList.toggle('hidden', !isHost);
    $.btnHoldOn.classList.toggle('hidden', !!isHost);
    this.showScreen('results');
  }
}

function badge(text, cls) {
  const s = document.createElement('span');
  s.className = `badge ${cls}`;
  s.textContent = text;
  return s;
}

function buildSub(p, room) {
  const bits = [];
  if (p.originalName && p.hostRenamed && p.originalName !== p.name) bits.push(`joined as ${p.originalName}`);
  if (!p.connected) bits.push('reconnecting…');
  else if (room.state === 'PLAYING' || room.state === 'FINISHED') bits.push(`${p.kills} kills · ${p.damage} dmg`);
  else bits.push(p.ready ? 'ready to roll' : 'in the lobby');
  return bits.join(' · ');
}

function fmtTime(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export { FUN_NAMES, fmtTime };
