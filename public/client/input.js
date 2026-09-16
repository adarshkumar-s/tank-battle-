// TANKFALL — input: thumb joystick + fire/boost on touch, WASD + mouse on desktop.
// Everything is captured with pointer events so multi-touch works reliably, and
// page scrolling / pinch-zoom never interferes with the controls.

export class Input {
  constructor({ joyZone, joyBase, joyKnob, btnFire, btnBoost, canvas, onFireTap }) {
    this.joyZone = joyZone;
    this.joyBase = joyBase;
    this.joyKnob = joyKnob;
    this.btnFire = btnFire;
    this.btnBoost = btnBoost;
    this.canvas = canvas;
    this.onFireTap = onFireTap;

    this.mx = 0;
    this.my = 0;
    this.fire = false;
    this.boost = false;
    this.joyActive = false;
    this.joyId = null;
    this.joyRect = null;
    this.joyOrigin = { x: 0, y: 0 };
    this.firePointerId = null;
    this.boostPointerId = null;
    this.maxRadius = 64;
    this.keys = new Set();
    this.mouse = { x: 0, y: 0, active: false, down: false };
    this.usingTouch = matchMedia('(pointer: coarse)').matches;
    this.enabled = false;
    this.lastAimLog = 0;

    this.bind();
  }

  setEnabled(on) {
    this.enabled = on;
    if (!on) {
      this.mx = 0; this.my = 0; this.fire = false; this.boost = false;
      this.keys.clear();
      this.mouse.down = false;
      this.resetJoystick();
      this.disarmFire();
      this.disarmBoost();
    }
  }

  bind() {
    const HAS_POINTER = typeof window !== 'undefined' && 'PointerEvent' in window;
    // Pointer capture is a nicety, never a requirement: on several mobile
    // engines setPointerCapture() throws (pointer already released / not the
    // effective target). Swallowing it keeps the controls alive.
    const capture = (el, id) => { try { el.setPointerCapture?.(id); } catch { /* optional */ } };
    const rectOf = (el) => (el ? el.getBoundingClientRect() : null);
    const inside = (el, x, y) => {
      const r = rectOf(el);
      return !!r && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
    };

    /* ------------------------------------------------------------------ *
     * Shared control state. Every input path (pointer, touch, fallback)
     * drives these three helpers with its own id space, so a press, its drag
     * and its release always match — whatever event the device delivers.
     * ------------------------------------------------------------------ */
    const press = (id, x, y, type) => {
      if (!this.enabled || type === 'mouse') return false;
      if (inside(this.joyZone, x, y)) {
        if (!this.joyStart(id, x, y)) return false;
        this.joyDrag(x, y);
        return true;
      }
      if (inside(this.btnFire, x, y)) { this.armFire(id, true); return true; }
      if (inside(this.btnBoost, x, y)) { this.armBoost(id, true); return true; }
      return false;
    };
    const drag = (id, x, y) => { if (this.joyId === id) this.joyDrag(x, y); };
    const release = (id) => {
      let used = false;
      if (this.joyId === id) { this.resetJoystick(); used = true; }
      if (this.firePointerId === id) { this.disarmFire(); used = true; }
      if (this.boostPointerId === id) { this.disarmBoost(); used = true; }
      return used;
    };

    /* ---------------- virtual joystick (left thumb) ---------------- */
    const zone = this.joyZone;
    if (zone) {
      zone.addEventListener('pointerdown', (e) => {
        if (e.pointerType === 'mouse') return;
        if (!this.enabled) return;
        e.preventDefault();
        // State first: a capture failure must never eat the press.
        this.joyStart(e.pointerId, e.clientX, e.clientY);
        this.joyDrag(e.clientX, e.clientY);
        capture(zone, e.pointerId);
      }, { passive: false });

      zone.addEventListener('pointermove', (e) => {
        if (e.pointerId !== this.joyId) return;
        e.preventDefault();
        this.joyDrag(e.clientX, e.clientY);
      }, { passive: false });

      const end = (e) => { if (e.pointerId === this.joyId) this.resetJoystick(); };
      zone.addEventListener('pointerup', end);
      zone.addEventListener('pointercancel', end);
      zone.addEventListener('lostpointercapture', end);
    }

    /* ---------------- fire + boost buttons ---------------- */
    const holdButton = (el, arm, disarm, slot) => {
      if (!el) return;
      el.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const fromTouch = e.pointerType !== 'mouse';
        if (fromTouch) this.mouse.active = false; else this.usingTouch = false;
        arm.call(this, e.pointerId, fromTouch);          // state first…
        capture(el, e.pointerId);                       // …capture is optional
        if (e.pointerType !== 'mouse') haptic(el === this.btnFire ? 8 : 12);
        if (el === this.btnFire) this.onFireTap?.();
      }, { passive: false });
      const up = () => disarm.call(this);
      el.addEventListener('pointerup', up);
      el.addEventListener('pointercancel', up);
      el.addEventListener('lostpointercapture', up);
      el.addEventListener('pointerleave', (e) => { if (e.buttons === 0) up(); });
      el.addEventListener('contextmenu', (e) => e.preventDefault());
    };
    holdButton(this.btnFire, this.armFire, this.disarmFire, 'firePointerId');
    holdButton(this.btnBoost, this.armBoost, this.disarmBoost, 'boostPointerId');

    /* ------------------------------------------------------------------ *
     * Fallback paths (belt and braces).
     *
     * On a real phone the on-screen controls can look dead when either
     *   a) the engine has no PointerEvent (older Android WebView), or
     *   b) the touch never reaches the control element (CSS pointer-events or
     *      capture quirks) and lands on the canvas instead.
     * So raw touches are also hit-tested against the control rectangles and
     * fed through the same helpers. Anything a control already handled is
     * skipped (its element listener ran), so nothing is processed twice.
     * ------------------------------------------------------------------ */
    const touchedControl = (target) => {
      const t = target;
      if (!t || !t.closest) return false;
      return !!(t.closest('#touch') || t.closest('#joyZone') || t.closest('#btnFire') || t.closest('#btnBoost'));
    };
    const TOUCH_ID_BASE = 100000;      // keeps touch ids out of the pointer id space

    if (!HAS_POINTER) {
      const each = (e, fn) => { for (const t of e.changedTouches || []) fn(t); };
      window.addEventListener('touchstart', (e) => {
        let used = false;
        each(e, (t) => { if (press(t.identifier + TOUCH_ID_BASE, t.clientX, t.clientY, 'touch')) used = true; });
        if (used && e.cancelable) e.preventDefault();
      }, { passive: false });
      window.addEventListener('touchmove', (e) => {
        let used = false;
        each(e, (t) => { if (this.joyId === t.identifier + TOUCH_ID_BASE) { this.joyDrag(t.clientX, t.clientY); used = true; } });
        if (used && e.cancelable) e.preventDefault();
      }, { passive: false });
      const endTouch = (e) => { each(e, (t) => release(t.identifier + TOUCH_ID_BASE)); };
      window.addEventListener('touchend', endTouch);
      window.addEventListener('touchcancel', endTouch);
    } else {
      window.addEventListener('pointerdown', (e) => {
        if (e.pointerType === 'mouse' || !this.enabled) return;
        if (touchedControl(e.target)) return;            // the control handled it
        if (press(e.pointerId, e.clientX, e.clientY, e.pointerType) && e.cancelable) e.preventDefault();
      }, { passive: false });
      window.addEventListener('pointermove', (e) => {
        if (e.pointerType === 'mouse') return;
        if (this.joyId === e.pointerId) { this.joyDrag(e.clientX, e.clientY); if (e.cancelable) e.preventDefault(); }
      }, { passive: false });
      const endPointer = (e) => { if (e.pointerType !== 'mouse') release(e.pointerId); };
      window.addEventListener('pointerup', endPointer);
      window.addEventListener('pointercancel', endPointer);
    }

    /* ---------------- keyboard ---------------- */
    window.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      const k = e.key.toLowerCase();
      if (['arrowup', 'arrowdown', 'arrowleft', 'arrowright', ' '].includes(k)) e.preventDefault();
      this.keys.add(k);
      if (k === ' ') this.fire = true;
      if (k === 'shift') this.boost = true;
      if (k === 'm' && this.enabled) this.onFireTap?.();
    }, { passive: false });

    window.addEventListener('keyup', (e) => {
      const k = e.key.toLowerCase();
      this.keys.delete(k);
      if (k === ' ') this.fire = false;
      if (k === 'shift') this.boost = false;
    });

    window.addEventListener('blur', () => {
      this.keys.clear();
      this.fire = false;
      this.boost = false;
      this.mouse.down = false;
      this.resetJoystick();
    });

    /* ---------------- mouse aim ---------------- */
    const onMove = (e) => {
      if (e.pointerType === 'touch') return;
      this.usingTouch = false;
      this.mouse.active = true;
      const rect = this.canvas.getBoundingClientRect();
      this.mouse.x = e.clientX - rect.left;
      this.mouse.y = e.clientY - rect.top;
    };
    window.addEventListener('pointermove', onMove, { passive: true });
    window.addEventListener('mousemove', onMove, { passive: true });

    this.canvas.addEventListener('pointerdown', (e) => {
      if (!this.enabled) return;
      if (e.pointerType === 'touch') return;
      e.preventDefault();
      this.mouse.down = true;
      this.fire = true;
      const rect = this.canvas.getBoundingClientRect();
      this.mouse.x = e.clientX - rect.left;
      this.mouse.y = e.clientY - rect.top;
      this.mouse.active = true;
    }, { passive: false });

    window.addEventListener('pointerup', (e) => {
      if (e.pointerType === 'touch') return;
      this.mouse.down = false;
      if (!this.keys.has(' ')) this.fire = false;
    });

    window.addEventListener('contextmenu', (e) => {
      if (e.target && e.target.closest && (e.target.closest('#touch') || e.target.closest('#game'))) e.preventDefault();
    });

    // Stop browser gestures (pinch zoom, pull-to-refresh, double-tap zoom).
    document.addEventListener('gesturestart', (e) => e.preventDefault());
    document.addEventListener('dblclick', (e) => e.preventDefault(), { passive: false });
    // Allow native scrolling inside menus/lists, block it everywhere else
    // (the battlefield must never scroll or rubber-band under a thumb).
    const SCROLLABLE = '.scrollable, .screen-inner, .score-scroll, .player-list, .room-list, .activity, .modal-card, input';
    window.addEventListener('touchmove', (e) => {
      if (e.target && e.target.closest && e.target.closest(SCROLLABLE)) return;
      e.preventDefault();
    }, { passive: false });
  }

  /* ---- low-level control state (shared by every input path) ---- */
  joyStart(id, clientX, clientY) {
    if (id === null || id === undefined) return false;
    if (this.joyId !== null && this.joyId !== id) return false;   // one thumb per pad
    const zone = this.joyZone;
    if (!zone) return false;
    const rect = zone.getBoundingClientRect();
    const bx = clamp(clientX - rect.left, 40, Math.max(40, rect.width - 40));
    const by = clamp(clientY - rect.top, 40, Math.max(40, rect.height - 40));
    this.joyId = id;
    this.joyActive = true;
    this.usingTouch = true;
    this.mouse.active = false;
    this.joyOrigin = { x: bx, y: by };
    this.joyRect = rect;
    if (this.joyBase) {
      this.joyBase.style.left = `${bx}px`;
      this.joyBase.style.top = `${by}px`;
      this.joyBase.classList.add('visible');
    }
    return true;
  }

  joyDrag(clientX, clientY) {
    const rect = this.joyRect || (this.joyZone && this.joyZone.getBoundingClientRect());
    if (!rect) return;
    const dx = clientX - rect.left - this.joyOrigin.x;
    const dy = clientY - rect.top - this.joyOrigin.y;
    const d = Math.hypot(dx, dy);
    const r = Math.min(this.maxRadius, d);
    const nx = d > 0.0001 ? dx / d : 0;
    const ny = d > 0.0001 ? dy / d : 0;
    if (this.joyKnob) this.joyKnob.style.transform = `translate(${nx * r}px, ${ny * r}px)`;
    const mag = Math.min(1, d / this.maxRadius);
    this.mx = nx * mag;
    this.my = ny * mag;
  }

  armFire(id, fromTouch = true) {
    if (fromTouch) this.usingTouch = true;
    this.fire = true;
    this.firePointerId = id;
    this.btnFire?.classList.add('active');
  }

  disarmFire() {
    this.fire = false;
    this.firePointerId = null;
    this.btnFire?.classList.remove('active');
  }

  armBoost(id, fromTouch = true) {
    if (fromTouch) this.usingTouch = true;
    this.boost = true;
    this.boostPointerId = id;
    this.btnBoost?.classList.add('active');
  }

  disarmBoost() {
    this.boost = false;
    this.boostPointerId = null;
    this.btnBoost?.classList.remove('active');
  }

  updateJoystick(e) {
    const rect = this.joyRect || this.joyZone.getBoundingClientRect();
    const dx = e.clientX - rect.left - this.joyOrigin.x;
    const dy = e.clientY - rect.top - this.joyOrigin.y;
    const d = Math.hypot(dx, dy);
    const r = Math.min(this.maxRadius, d);
    const nx = d > 0.0001 ? dx / d : 0;
    const ny = d > 0.0001 ? dy / d : 0;
    if (this.joyKnob) {
      this.joyKnob.style.transform = `translate(${nx * r}px, ${ny * r}px)`;
    }
    const mag = Math.min(1, d / this.maxRadius);
    this.mx = nx * mag;
    this.my = ny * mag;
  }

  resetJoystick() {
    this.joyActive = false;
    this.joyId = null;
    this.joyRect = null;
    this.mx = 0;
    this.my = 0;
    if (this.joyKnob) this.joyKnob.style.transform = 'translate(0px, 0px)';
    if (this.joyBase) this.joyBase.classList.remove('visible');
  }

  /** Movement as a normalized vector (keyboard or joystick, whichever is active). */
  movement() {
    let mx = this.mx, my = this.my;
    const k = this.keys;
    let kx = 0, ky = 0;
    if (k.has('a') || k.has('arrowleft')) kx -= 1;
    if (k.has('d') || k.has('arrowright')) kx += 1;
    if (k.has('w') || k.has('arrowup')) ky -= 1;
    if (k.has('s') || k.has('arrowdown')) ky += 1;
    if (kx || ky) {
      const len = Math.hypot(kx, ky) || 1;
      return { x: kx / len, y: ky / len };
    }
    return { x: mx, y: my };
  }

  wantsFire() { return this.fire; }
  wantsBoost() { return this.boost; }
}

function haptic(pattern) {
  if (!('vibrate' in navigator)) return;
  try { navigator.vibrate(pattern); } catch { /* unsupported/blocked */ }
}

function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
