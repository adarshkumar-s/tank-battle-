// TANKFALL — WebSocket client with reconnect, input batching and snapshot decode.

import { NET } from '/shared/constants.js';
import { decodeSnapshot } from '/shared/snapshot.js';

const STORAGE_KEY = 'tankfall.session.v1';

export class Net {
  constructor(handlers = {}) {
    this.handlers = handlers;
    this.ws = null;
    this.connected = false;
    this.session = loadSession();
    this.outQueue = [];
    this.inputQueue = [];
    this.seq = 0;
    this.recvQueue = [];
    this.lastRecvAt = 0;
    this.reconnectAttempts = 0;
    this.reconnectTimer = null;
    this.closedByUser = false;
    this.latencyMs = 0;
    this._pingTimer = null;
    this._decoded = {};
    this.bytesIn = 0;
  }

  get url() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${location.host}/ws`;
  }

  open() {
    this.closedByUser = false;
    if (this.ws && (this.ws.readyState === 0 || this.ws.readyState === 1)) return;
    let ws;
    try {
      ws = new WebSocket(this.url);
    } catch (err) {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.binaryType = 'arraybuffer';

    ws.onopen = () => {
      this.connected = true;
      this.reconnectAttempts = 0;
      this.lastRecvAt = performance.now();
      for (const msg of this.outQueue) this.sendRaw(msg);
      this.outQueue = [];
      this.handlers.onOpen?.();
      this._pingTimer = setInterval(() => this.send({ t: 'ping', t: Date.now() }), 2000);
    };

    ws.onmessage = (ev) => {
      this.lastRecvAt = performance.now();
      if (typeof ev.data === 'string') {
        let msg;
        try { msg = JSON.parse(ev.data); } catch { return; }
        if (msg.t === 'pong') {
          this.latencyMs = Math.max(0, Date.now() - msg.t);
          this.handlers.onLatency?.(this.latencyMs);
          return;
        }
        this.handlers.onMessage?.(msg);
      } else {
        const buf = ev.data instanceof ArrayBuffer ? ev.data : ev.data.buffer;
        this.bytesIn += buf.byteLength;
        const snap = decodeSnapshot(buf, this._decoded);
        if (snap) this.handlers.onSnapshot?.(snap);
      }
    };

    ws.onclose = (ev) => {
      this.connected = false;
      clearInterval(this._pingTimer);
      if (this.closedByUser) return;
      this.handlers.onClose?.(ev);
      if (ev && (ev.code === 4001 || ev.code === 4002)) return; // kicked / removed
      this.scheduleReconnect();
    };

    ws.onerror = () => { /* onclose handles recovery */ };
  }

  scheduleReconnect() {
    if (this.reconnectTimer) return;
    this.reconnectAttempts++;
    const delay = Math.min(8000, 500 * 2 ** Math.min(4, this.reconnectAttempts));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.open();
      // Re-attach to our seat in the room if we have one.
      const s = this.session;
      if (s && s.code && s.playerId && s.token) {
        this.send({ t: 'rejoin', code: s.code, playerId: s.playerId, token: s.token, name: s.name }, true);
      }
    }, delay);
    this.handlers.onReconnecting?.(this.reconnectAttempts, delay);
  }

  send(msg, queueIfOffline = true) {
    if (this.connected && this.ws && this.ws.readyState === 1) {
      this.sendRaw(msg);
    } else if (queueIfOffline) {
      if (this.outQueue.length < 20) this.outQueue.push(msg);
    }
  }

  sendRaw(msg) {
    try { this.ws.send(JSON.stringify(msg)); } catch { /* ignore */ }
  }

  /* ------------------------------------------------------------ input */
  queueInput(mx, my, turret, fire, boost) {
    this.seq++;
    this.inputQueue.push([
      this.seq,
      round3(mx), round3(my), round3(turret), fire ? 1 : 0, boost ? 1 : 0,
    ]);
  }

  flushInputs() {
    if (!this.inputQueue.length) return;
    const batch = this.inputQueue.splice(0, 12);
    this.send({ t: 'input', i: batch }, false);
  }

  saveSession(data) {
    this.session = data;
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(data)); } catch { /* private mode */ }
  }

  clearSession() {
    this.session = null;
    try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
  }

  close() {
    this.closedByUser = true;
    clearInterval(this._pingTimer);
    clearTimeout(this.reconnectTimer);
    if (this.ws) { try { this.ws.close(1000, 'bye'); } catch { /* ignore */ } }
  }
}

function round3(v) {
  return Math.round((Number(v) || 0) * 1000) / 1000;
}

function loadSession() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object') return null;
    if (Date.now() - (data.at || 0) > 12 * 60 * 60 * 1000) return null;
    return data;
  } catch {
    return null;
  }
}

export { NET };
