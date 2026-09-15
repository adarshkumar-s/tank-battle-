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
    this.joyOrigin = { x: 0, y: 0 };
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
      if (this.btnFire) this.btnFire.classList.remove('active');
      if (this.btnBoost) this.btnBoost.classList.remove('active');
    }
  }

  bind() {
    /* ---------------- virtual joystick (left thumb) ---------------- */
    const zone = this.joyZone;
    if (zone) {
      zone.addEventListener('pointerdown', (e) => {
        if (!this.enabled || e.pointerType === 'mouse') return;
        e.preventDefault();
        this.joyId = e.pointerId;
        this.joyActive = true;
        this.usingTouch = true;
        this.mouse.active = false;
        const rect = zone.getBoundingClientRect();
        const bx = clamp(e.clientX - rect.left, 40, rect.width - 40);
        const by = clamp(e.clientY - rect.top, 40, rect.height - 40);
        this.joyOrigin = { x: bx, y: by };
        this.joyBase.style.left = `${bx}px`;
        this.joyBase.style.top = `${by}px`;
        this.joyBase.classList.add('visible');
        zone.setPointerCapture?.(e.pointerId);
        this.updateJoystick(e);
      }, { passive: false });

      zone.addEventListener('pointermove', (e) => {
        if (e.pointerId !== this.joyId) return;
        e.preventDefault();
        this.updateJoystick(e);
      }, { passive: false });

      const end = (e) => {
        if (e.pointerId !== this.joyId) return;
        this.resetJoystick();
      };
      zone.addEventListener('pointerup', end);
      zone.addEventListener('pointercancel', end);
      zone.addEventListener('lostpointercapture', end);
    }

    /* ---------------- fire + boost buttons ---------------- */
    const holdButton = (el, set) => {
      if (!el) return;
      el.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.usingTouch = e.pointerType !== 'mouse';
        this.mouse.active = false;
        el.setPointerCapture?.(e.pointerId);
        el.classList.add('active');
        set(true);
        if (e.pointerType !== 'mouse') {
          haptic(el === this.btnFire ? 8 : 12);
        }
        if (el === this.btnFire) this.onFireTap?.();
      }, { passive: false });
      const up = (e) => {
        el.classList.remove('active');
        set(false);
      };
      el.addEventListener('pointerup', up);
      el.addEventListener('pointercancel', up);
      el.addEventListener('pointerout', (e) => { if (e.buttons === 0) up(e); });
      el.addEventListener('contextmenu', (e) => e.preventDefault());
    };

    holdButton(this.btnFire, (v) => { this.fire = v; });
    holdButton(this.btnBoost, (v) => { this.boost = v; });

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

  updateJoystick(e) {
    const dx = e.clientX - this.joyZone.getBoundingClientRect().left - this.joyOrigin.x;
    const dy = e.clientY - this.joyZone.getBoundingClientRect().top - this.joyOrigin.y;
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
