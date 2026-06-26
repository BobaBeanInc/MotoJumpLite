'use strict';

/* =====================================================
   MotoJumpLite - Penelope's Ramp Run
   Side-scrolling 16-bit arcade motorcycle stunt game
   ===================================================== */

// =====================================================
// CONFIG / CONSTANTS
// =====================================================
const C = {
  LOGICAL_HEIGHT: 360,
  GROUND_BASE_Y:  280,
  PLAYER_X_FRAC:  0.28,

  GRAVITY:          1500,
  JUMP_VY:          -580,
  DOUBLE_JUMP_VY:   -480,
  RAMP_BOOST:       2.2,

  BASE_SPEED:       230,
  THROTTLE_MULT:    1.55,
  THROTTLE_ACCEL:   320,
  THROTTLE_DECEL:   400,
  MAX_SPEED:        540,

  BUMP_SLOW:        85,
  DIP_SLOW:         120,
  CONE_SLOW_MULT:   0.82,

  QP_SPEED_PER_MIN: 22,

  TILT_TORQUE:      12,
  ANG_DAMP:         1.6,
  MAX_ANG_VEL:      5.2,

  CLEAN_LAND_RAD:   0.5,    // ~28°
  PERFECT_LAND_RAD: 0.18,   // ~10°

  TRICK_DURATION:   0.85,

  BLINK_DURATION:   1.5,
  BLINK_INTERVAL:   0.10,

  CAM_LERP:         9,
  HS_KEY:           'motojumplite.qp.hs.v1',
};

// =====================================================
// UTILITIES
// =====================================================
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const lerp  = (a, b, t)   => a + (b - a) * t;
const rand  = (a, b)      => a + Math.random() * (b - a);
const randInt = (a, b)    => Math.floor(rand(a, b + 1));
const choice  = arr       => arr[Math.floor(Math.random() * arr.length)];

function normalizeAngle(a) {
  while (a >  Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

// =====================================================
// AUDIO - Web Audio API only, no external files
// =====================================================
const Audio = {
  ctx: null,
  muted: false,
  master: null,

  init() {
    if (this.ctx) return;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.5;
      this.master.connect(this.ctx.destination);
    } catch (e) {
      this.ctx = null;
    }
  },

  resume() {
    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }
  },

  beep(freq, dur, type = 'square', vol = 0.10, slide = 0) {
    if (this.muted || !this.ctx) return;
    try {
      const t = this.ctx.currentTime;
      const o = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      o.type = type;
      o.frequency.setValueAtTime(freq, t);
      if (slide) {
        const endFreq = Math.max(20, freq + slide);
        o.frequency.exponentialRampToValueAtTime(endFreq, t + dur);
      }
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(vol, t + 0.005);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g); g.connect(this.master);
      o.start(t); o.stop(t + dur + 0.02);
    } catch (e) {}
  },

  noise(dur, vol = 0.15, bp = 700) {
    if (this.muted || !this.ctx) return;
    try {
      const t = this.ctx.currentTime;
      const sz = Math.floor(this.ctx.sampleRate * dur);
      const buf = this.ctx.createBuffer(1, sz, this.ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < sz; i++) d[i] = Math.random() * 2 - 1;
      const src = this.ctx.createBufferSource(); src.buffer = buf;
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(vol, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      const f = this.ctx.createBiquadFilter();
      f.type = 'bandpass'; f.frequency.value = bp; f.Q.value = 1;
      src.connect(f); f.connect(g); g.connect(this.master);
      src.start(t); src.stop(t + dur + 0.05);
    } catch (e) {}
  },

  jump()       { this.beep(440, 0.10, 'square', 0.10, 280); },
  doubleJump() { this.beep(560, 0.10, 'square', 0.10, 280); },
  trick()      { this.beep(660, 0.07, 'triangle', 0.10, 280); setTimeout(() => this.beep(990, 0.06, 'triangle', 0.08, 200), 60); },
  land()       { this.beep(220, 0.06, 'sine', 0.10, -60); },
  perfect()    { this.beep(880, 0.06, 'square', 0.08); setTimeout(() => this.beep(1320, 0.10, 'square', 0.08), 60); },
  crash()      { this.noise(0.30, 0.18, 400); this.beep(70, 0.25, 'sawtooth', 0.10, -30); },
  bump()       { this.beep(140, 0.05, 'square', 0.08, -40); },
  pickup()     { this.beep(880, 0.05, 'square', 0.06, 200); },
  finish()     {
    const notes = [523, 659, 784, 1047, 1318];
    notes.forEach((f, i) => setTimeout(() => this.beep(f, 0.18, 'square', 0.10), i * 100));
  },
  menu()       { this.beep(660, 0.04, 'square', 0.08); },
  combo()      { this.beep(880, 0.05, 'square', 0.06); },

  toggleMute() {
    this.muted = !this.muted;
    return this.muted;
  }
};

// =====================================================
// INPUT - Keyboard and Touch
// =====================================================
const Input = {
  keys: {},
  touch: { jump: false, throttle: false, tiltBack: false, tiltForward: false, trick: false },
  pressed: {}, // edge-triggered (clear each frame)

  init() {
    window.addEventListener('keydown', e => this._onKeyDown(e));
    window.addEventListener('keyup',   e => this._onKeyUp(e));
    window.addEventListener('blur',    () => this._reset());
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this._reset();
    });

    this._bindBtn('btn-jump',         'jump');
    this._bindBtn('btn-throttle',     'throttle');
    this._bindBtn('btn-tilt-back',    'tiltBack');
    this._bindBtn('btn-tilt-forward', 'tiltForward');
    this._bindBtn('btn-trick',        'trick');
  },

  _reset() {
    this.keys = {};
    this.touch = { jump: false, throttle: false, tiltBack: false, tiltForward: false, trick: false };
    document.querySelectorAll('.ctrl').forEach(el => el.classList.remove('pressed'));
  },

  _onKeyDown(e) {
    if (e.repeat) return;
    const k = e.key.toLowerCase();
    this.keys[k] = true;
    this.pressed[k] = true;
    const gameKeys = [' ', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright',
                      'w', 'a', 's', 'd', 'shift', 't', 'e', 'p', 'escape', 'r', 'enter'];
    if (gameKeys.includes(k)) e.preventDefault();
  },

  _onKeyUp(e) {
    const k = e.key.toLowerCase();
    this.keys[k] = false;
  },

  _bindBtn(id, key) {
    const el = document.getElementById(id);
    if (!el) return;
    const down = (e) => {
      e.preventDefault();
      this.touch[key] = true;
      this.pressed['touch_' + key] = true;
      el.classList.add('pressed');
      Audio.init(); Audio.resume();
    };
    const up = (e) => {
      if (e) e.preventDefault();
      this.touch[key] = false;
      el.classList.remove('pressed');
    };
    el.addEventListener('touchstart',  down, { passive: false });
    el.addEventListener('touchend',    up,   { passive: false });
    el.addEventListener('touchcancel', up,   { passive: false });
    el.addEventListener('mousedown',   down);
    el.addEventListener('mouseup',     up);
    el.addEventListener('mouseleave',  up);
    // prevent context menu on long press
    el.addEventListener('contextmenu', e => e.preventDefault());
  },

  // Aggregated getters
  jumpPressed()      { return !!(this.pressed[' '] || this.pressed['w'] || this.pressed['arrowup'] || this.pressed['touch_jump']); },
  throttleHeld()     { return !!(this.keys['shift'] || this.keys['arrowright'] || this.touch.throttle); },
  tiltBackHeld()     { return !!(this.keys['a'] || this.keys['arrowleft'] || this.touch.tiltBack); },
  tiltForwardHeld()  { return !!(this.keys['d'] || this.keys['arrowdown'] || this.touch.tiltForward); },
  trickPressed()     { return !!(this.pressed['t'] || this.pressed['e'] || this.pressed['touch_trick']); },
  pausePressed()     { return !!(this.pressed['p'] || this.pressed['escape']); },
  restartPressed()   { return !!this.pressed['r']; },
  enterPressed()     { return !!this.pressed['enter']; },

  clearPressed() { this.pressed = {}; },
};

// =====================================================
// LEVEL CONFIGURATION (Campaign - 15 levels)
// =====================================================
const LEVELS = [
  // 1 - tutorial
  { length: 2600, baseSpeed: 220, rampDensity: 0.30, bigRampChance: 0.00, coneChance: 0.00, bumpChance: 0.00, dipChance: 0.00, name: 'FIRST RIDE' },
  // 2 - cones
  { length: 3000, baseSpeed: 230, rampDensity: 0.35, bigRampChance: 0.05, coneChance: 0.25, bumpChance: 0.00, dipChance: 0.00, name: 'CONE ALLEY' },
  // 3 - bumps
  { length: 3300, baseSpeed: 240, rampDensity: 0.35, bigRampChance: 0.10, coneChance: 0.20, bumpChance: 0.30, dipChance: 0.00, name: 'BUMPY ROAD' },
  // 4 - dips
  { length: 3600, baseSpeed: 250, rampDensity: 0.40, bigRampChance: 0.10, coneChance: 0.20, bumpChance: 0.25, dipChance: 0.25, name: 'POTHOLES' },
  // 5 - mix
  { length: 4000, baseSpeed: 260, rampDensity: 0.40, bigRampChance: 0.15, coneChance: 0.25, bumpChance: 0.25, dipChance: 0.20, name: 'ALL TOGETHER' },
  // 6
  { length: 4400, baseSpeed: 270, rampDensity: 0.45, bigRampChance: 0.20, coneChance: 0.30, bumpChance: 0.30, dipChance: 0.25, name: 'STUNT TRACK' },
  // 7
  { length: 4800, baseSpeed: 285, rampDensity: 0.45, bigRampChance: 0.25, coneChance: 0.30, bumpChance: 0.30, dipChance: 0.25, name: 'AIRTIME' },
  // 8
  { length: 5200, baseSpeed: 295, rampDensity: 0.45, bigRampChance: 0.30, coneChance: 0.35, bumpChance: 0.30, dipChance: 0.30, name: 'HIGHWAY' },
  // 9
  { length: 5600, baseSpeed: 305, rampDensity: 0.50, bigRampChance: 0.30, coneChance: 0.35, bumpChance: 0.35, dipChance: 0.30, name: 'SKYLINE' },
  // 10
  { length: 6000, baseSpeed: 320, rampDensity: 0.50, bigRampChance: 0.35, coneChance: 0.35, bumpChance: 0.35, dipChance: 0.30, name: 'SUNSET RUN' },
  // 11
  { length: 6400, baseSpeed: 335, rampDensity: 0.55, bigRampChance: 0.40, coneChance: 0.40, bumpChance: 0.35, dipChance: 0.35, name: 'NIGHT RIDE' },
  // 12
  { length: 6800, baseSpeed: 345, rampDensity: 0.55, bigRampChance: 0.45, coneChance: 0.40, bumpChance: 0.40, dipChance: 0.35, name: 'HOT LAP' },
  // 13
  { length: 7200, baseSpeed: 360, rampDensity: 0.55, bigRampChance: 0.50, coneChance: 0.45, bumpChance: 0.40, dipChance: 0.35, name: 'PRO SERIES' },
  // 14
  { length: 7600, baseSpeed: 375, rampDensity: 0.60, bigRampChance: 0.55, coneChance: 0.45, bumpChance: 0.40, dipChance: 0.40, name: 'PENULTIMATE' },
  // 15
  { length: 8200, baseSpeed: 390, rampDensity: 0.60, bigRampChance: 0.60, coneChance: 0.50, bumpChance: 0.45, dipChance: 0.40, name: 'FINAL STUNT' },
];

// =====================================================
// TERRAIN - Heightmap-based terrain with features
// =====================================================
class Terrain {
  constructor() {
    this.points    = [];   // sorted by x
    this.features  = [];   // ramps, bumps, dips
    this.cones     = [];   // standalone cones
    this.finish    = null; // {x} for campaign only
    this.endless   = false;
    this.endX      = 0;
    this.lastGenX  = 0;
    this.minGap    = 180;
  }

  reset() {
    this.points.length = 0;
    this.features.length = 0;
    this.cones.length = 0;
    this.finish = null;
    this.endX = 0;
    this.lastGenX = 0;
  }

  // -------- Campaign: full procedural level --------
  generateCampaign(cfg) {
    this.reset();
    this.endless = false;
    this.endX = cfg.length;

    // Intro flat
    this.points.push({ x: -300, y: C.GROUND_BASE_Y });
    this.points.push({ x: 240,  y: C.GROUND_BASE_Y });

    let x = 280;
    let safety = 0;
    while (x < cfg.length - 280 && safety++ < 8000) {
      x += rand(this.minGap, this.minGap + 80);
      x = this._placeFeature(x, cfg);
    }

    // Run-out + finish
    this.points.push({ x: cfg.length,        y: C.GROUND_BASE_Y });
    this.points.push({ x: cfg.length + 1200, y: C.GROUND_BASE_Y });
    this.finish = { x: cfg.length };

    this._sortPoints();
  }

  // -------- Quick Play: endless generation --------
  initEndless() {
    this.reset();
    this.endless = true;
    this.points.push({ x: -300, y: C.GROUND_BASE_Y });
    this.points.push({ x: 500,  y: C.GROUND_BASE_Y });
    this.lastGenX = 500;
  }

  extendEndless(targetX, distance) {
    while (this.lastGenX < targetX) {
      let x = this.lastGenX + rand(this.minGap - 30, this.minGap + 80);

      const diff = clamp(distance / 1000, 0, 4);
      const cfg = {
        rampDensity:   clamp(0.30 + diff * 0.06, 0, 0.60),
        bigRampChance: clamp(diff * 0.10,        0, 0.55),
        coneChance:    clamp(diff * 0.08,        0, 0.40),
        bumpChance:    clamp(diff * 0.08,        0, 0.40),
        dipChance:     clamp(diff * 0.07,        0, 0.35),
      };
      x = this._placeFeature(x, cfg);
      this.lastGenX = x;
    }
    this._sortPoints();
  }

  cleanupBehind(playerX) {
    if (!this.endless) return;
    const cutoff = playerX - 800;
    this.points   = this.points.filter(p => p.x > cutoff);
    this.cones    = this.cones.filter(c => c.x > cutoff);
    this.features = this.features.filter(f => f.x_end > cutoff);
    if (this.points.length === 0 || this.points[0].x > cutoff - 100) {
      this.points.unshift({ x: cutoff - 200, y: C.GROUND_BASE_Y });
    }
  }

  // -------- Feature placement --------
  _placeFeature(x, cfg) {
    const r = Math.random();
    let nextX = x;
    if (r < cfg.rampDensity) {
      const big = Math.random() < cfg.bigRampChance;
      nextX = this._addRamp(x, big);
    } else if (r < cfg.rampDensity + cfg.bumpChance) {
      nextX = this._addBump(x);
    } else if (r < cfg.rampDensity + cfg.bumpChance + cfg.dipChance) {
      nextX = this._addDip(x);
    } else {
      // empty flat span
      nextX = x + 50;
    }
    // Sometimes spawn cone(s)
    if (Math.random() < cfg.coneChance) {
      const count = Math.random() < 0.25 ? 2 : 1;
      for (let i = 0; i < count; i++) {
        this.cones.push({ x: nextX + 20 + i * 22, hit: false, cleared: false });
      }
      nextX += count * 22 + 20;
    }
    return nextX;
  }

  _addRamp(x, big) {
    const width  = big ? 130 : 95;
    const height = big ? 78 : 52;
    const peakX  = x + width;
    const peakY  = C.GROUND_BASE_Y - height;
    this.points.push({ x: x,        y: C.GROUND_BASE_Y });
    this.points.push({ x: peakX,    y: peakY });
    this.points.push({ x: peakX+3,  y: C.GROUND_BASE_Y });
    this.features.push({
      type: 'ramp', x_start: x, x_end: peakX, big,
      peakY,
    });
    return peakX + 20;
  }

  _addBump(x) {
    const width = 48;
    const height = 16;
    this.points.push({ x: x,             y: C.GROUND_BASE_Y });
    this.points.push({ x: x + width*0.5, y: C.GROUND_BASE_Y - height });
    this.points.push({ x: x + width,     y: C.GROUND_BASE_Y });
    this.features.push({
      type: 'bump', x_start: x, x_end: x + width, hit: false, cleared: false,
    });
    return x + width + 10;
  }

  _addDip(x) {
    const depth     = 22;
    const transW    = 22;     // ramp-down/up portion
    const flatLen   = 36;     // bottom flat
    const x0 = x;
    const x1 = x + transW;
    const x2 = x + transW + flatLen;
    const x3 = x + transW + flatLen + transW;
    this.points.push({ x: x0, y: C.GROUND_BASE_Y });
    this.points.push({ x: x1, y: C.GROUND_BASE_Y + depth });
    this.points.push({ x: x2, y: C.GROUND_BASE_Y + depth });
    this.points.push({ x: x3, y: C.GROUND_BASE_Y });
    this.features.push({
      type: 'dip', x_start: x0, x_end: x3, hit: false, cleared: false,
    });
    return x3 + 10;
  }

  _sortPoints() {
    this.points.sort((a, b) => a.x - b.x);
    // Remove near-duplicates (same x) keeping the last
    const out = [];
    for (let i = 0; i < this.points.length; i++) {
      const p = this.points[i];
      if (out.length && Math.abs(out[out.length-1].x - p.x) < 0.5) {
        out[out.length - 1] = p;
      } else {
        out.push(p);
      }
    }
    this.points = out;
  }

  // -------- Queries --------
  groundY(x) {
    const pts = this.points;
    if (pts.length === 0) return C.GROUND_BASE_Y;
    if (x <= pts[0].x) return pts[0].y;
    const last = pts[pts.length - 1];
    if (x >= last.x) return last.y;

    let lo = 0, hi = pts.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (pts[mid].x <= x) lo = mid; else hi = mid;
    }
    const p1 = pts[lo], p2 = pts[hi];
    if (p2.x - p1.x < 0.001) return p1.y;
    const t = (x - p1.x) / (p2.x - p1.x);
    return p1.y + (p2.y - p1.y) * t;
  }

  groundSlope(x) {
    const d = 2;
    const y1 = this.groundY(x - d);
    const y2 = this.groundY(x + d);
    return Math.atan2(y2 - y1, 2 * d);
  }
}

// =====================================================
// PLAYER - Penelope on the bike
// =====================================================
class Player {
  constructor(game) {
    this.game = game;
    this._initState();
  }

  _initState() {
    this.x = 120;
    this.y = C.GROUND_BASE_Y;
    this.vx = 0;
    this.vy = 0;
    this.angle = 0;
    this.angVel = 0;
    this.grounded = true;
    this.crashed = false;
    this.invulnerable = false;
    this.invulnTimer = 0;
    this.blinkTimer = 0;
    this.doubleJumpAvailable = true;
    this.trickUsedThisJump = false;
    this.pendingTrickBonus = false;
    this.trickName = null;
    this.trickTimer = 0;
    this.airTime = 0;
    this.airApexY = this.y;
    this.airStartY = this.y;
    this.baseSpeed = C.BASE_SPEED;
    this.targetSpeed = C.BASE_SPEED;
    this.wheelSpin = 0;
    this.exhaustTimer = 0;
  }

  reset(x, y, speed) {
    this._initState();
    this.x = x;
    this.y = y;
    this.baseSpeed = speed;
    this.targetSpeed = speed;
    this.vx = speed;
  }

  respawn(terrain) {
    // Find a safe (flat) ground spot behind current position
    let safeX = Math.max(60, this.x - 240);
    for (let i = 0; i < 30; i++) {
      const s = Math.abs(terrain.groundSlope(safeX));
      if (s < 0.15) break;
      safeX -= 18;
      if (safeX < 60) { safeX = 60; break; }
    }
    this.x = safeX;
    this.y = terrain.groundY(safeX);
    this.vx = this.baseSpeed * 0.65;
    this.vy = 0;
    this.angle = 0;
    this.angVel = 0;
    this.grounded = true;
    this.crashed = false;
    this.invulnerable = true;
    this.invulnTimer = 1.2;
    this.blinkTimer = 0;
    this.doubleJumpAvailable = true;
    this.trickUsedThisJump = false;
    this.pendingTrickBonus = false;
    this.trickName = null;
    this.trickTimer = 0;
    this.airTime = 0;
  }

  crash() {
    if (this.crashed || this.invulnerable) return;
    this.crashed = true;
    this.blinkTimer = C.BLINK_DURATION;
    this.vx *= 0.4;
    this.vy = -240;
    this.angVel = rand(3, 5) * (Math.random() < 0.5 ? -1 : 1);
    this.trickName = null;
    this.trickTimer = 0;
    this.pendingTrickBonus = false;
    Audio.crash();
    this.game.onCrash();
  }

  update(dt, terrain) {
    // ---------- Crash sequence ----------
    if (this.crashed) {
      this.blinkTimer -= dt;
      this.vy += C.GRAVITY * dt;
      this.vx = Math.max(0, this.vx - 200 * dt);
      this.x += this.vx * dt;
      this.y += this.vy * dt;
      this.angle += this.angVel * dt;
      const gy = terrain.groundY(this.x);
      if (this.y > gy) {
        this.y = gy;
        this.vy = -this.vy * 0.25;
        if (Math.abs(this.vy) < 60) this.vy = 0;
      }
      this.wheelSpin += (this.vx / 18) * dt;
      if (this.blinkTimer <= 0) {
        this.crashed = false;
        this.game.onCrashEnd();
      }
      return;
    }

    // ---------- Normal update ----------
    this._applyInput(dt);

    // Move and resolve collisions
    const prevX = this.x;
    if (this.grounded) {
      this._updateGrounded(dt, terrain);
    } else {
      this._updateAirborne(dt, terrain);
    }

    // Wheel spin
    this.wheelSpin += (this.vx / 18) * dt;

    // Check feature crossings
    this._checkFeatures(terrain, prevX);

    // Invulnerability decay
    if (this.invulnerable) {
      this.invulnTimer -= dt;
      if (this.invulnTimer <= 0) this.invulnerable = false;
    }

    // Update trick text timer
    if (this.trickTimer > 0) {
      this.trickTimer -= dt;
      if (this.trickTimer <= 0) this.trickName = null;
    }

    // Exhaust emit (visual)
    this.exhaustTimer -= dt;
    if (this.exhaustTimer <= 0 && this.grounded && this.vx > 50) {
      this.exhaustTimer = 0.06;
      this.game.effects.exhaust(this.x - 16, this.y - 8);
    }
  }

  _applyInput(dt) {
    // Throttle / base speed
    this.targetSpeed = Input.throttleHeld()
      ? Math.min(this.baseSpeed * C.THROTTLE_MULT, C.MAX_SPEED)
      : this.baseSpeed;
    if (this.vx < this.targetSpeed) {
      this.vx = Math.min(this.targetSpeed, this.vx + C.THROTTLE_ACCEL * dt);
    } else if (this.vx > this.targetSpeed) {
      this.vx = Math.max(this.targetSpeed, this.vx - C.THROTTLE_DECEL * dt);
    }

    // Jump (edge-triggered)
    if (Input.jumpPressed()) {
      if (this.grounded) {
        this.vy = C.JUMP_VY;
        this.grounded = false;
        this.angVel = -0.4;
        this.doubleJumpAvailable = true;
        this.trickUsedThisJump = false;
        this.pendingTrickBonus = false;
        this.airTime = 0;
        this.airStartY = this.y;
        this.airApexY  = this.y;
        Audio.jump();
      } else if (this.doubleJumpAvailable) {
        this.vy = C.DOUBLE_JUMP_VY;
        this.doubleJumpAvailable = false;
        this.angVel -= 0.5;
        Audio.doubleJump();
      }
    }

    // Trick
    if (Input.trickPressed() && !this.grounded && !this.trickUsedThisJump) {
      const tricks = ['NO HANDER', 'SUPERMAN', 'HEEL CLICKER',
                      'CAN-CAN', 'TAILWHIP', 'BAR SPIN'];
      this.trickName = choice(tricks);
      this.trickTimer = C.TRICK_DURATION;
      this.trickUsedThisJump = true;
      this.pendingTrickBonus = true;
      this.game.onTrickStart(this.trickName);
      Audio.trick();
    }

    // Tilt (airborne only)
    if (!this.grounded) {
      let tilt = 0;
      if (Input.tiltBackHeld())    tilt -= 1;
      if (Input.tiltForwardHeld()) tilt += 1;
      this.angVel += tilt * C.TILT_TORQUE * dt;
      this.angVel -= this.angVel * C.ANG_DAMP * dt;
      this.angVel = clamp(this.angVel, -C.MAX_ANG_VEL, C.MAX_ANG_VEL);
      this.angle += this.angVel * dt;
    }
  }

  _updateGrounded(dt, terrain) {
    const newX = this.x + this.vx * dt;
    const newGY = terrain.groundY(newX);
    const newSlope = terrain.groundSlope(newX);
    const prevSlope = this.angle;

    // Detect ramp launch: previous slope upward, slope now drops sharply
    const isRampLaunch =
      prevSlope < -0.25 &&
      (newSlope > prevSlope + 0.35 || newGY > this.y + Math.abs(this.vx) * dt * 0.5);

    if (isRampLaunch) {
      // Launch!
      const launchVy = this.vx * Math.tan(prevSlope) * C.RAMP_BOOST;
      this.grounded = false;
      this.x = newX;
      this.vy = launchVy;
      this.y = this.y + this.vy * dt;
      this.angVel = -0.6; // slight backflip impulse
      this.airTime = 0;
      this.airStartY = this.y;
      this.airApexY  = this.y;
      this.trickUsedThisJump = false;
      this.pendingTrickBonus = false;
      this.doubleJumpAvailable = true;
      return;
    }

    // Stay grounded
    this.x = newX;
    this.y = newGY;
    // Limit absurd slope velocities (don't allow vy to balloon)
    const safeSlope = clamp(newSlope, -1.2, 1.2);
    this.vy = this.vx * Math.tan(safeSlope);
    this.angle = lerp(this.angle, newSlope, Math.min(1, 12 * dt));
    this.angVel = 0;
    this.doubleJumpAvailable = true;
    this.trickUsedThisJump = false;
    this.airTime = 0;
  }

  _updateAirborne(dt, terrain) {
    this.vy += C.GRAVITY * dt;
    this.x += this.vx * dt;
    this.y += this.vy * dt;
    this.airTime += dt;
    if (this.y < this.airApexY) this.airApexY = this.y;

    const newGY = terrain.groundY(this.x);
    if (this.y >= newGY) {
      // Landing detected
      const slope = terrain.groundSlope(this.x);
      const angDiff = Math.abs(normalizeAngle(this.angle - slope));
      const isClean = angDiff < C.CLEAN_LAND_RAD;
      const isPerfect = angDiff < C.PERFECT_LAND_RAD;

      if (isClean) {
        this.y = newGY;
        this.grounded = true;
        this.vy = this.vx * Math.tan(clamp(slope, -1.2, 1.2));
        this.angle = slope;
        this.angVel = 0;
        const airHeight = Math.max(0, this.airStartY - this.airApexY);
        const airT = this.airTime;
        const hadTrick = this.pendingTrickBonus;
        const trick = this.trickName;
        this.pendingTrickBonus = false;
        this.trickUsedThisJump = false;
        this.doubleJumpAvailable = true;
        this.trickName = null;
        this.trickTimer = 0;
        this.airTime = 0;
        this.game.onCleanLanding(isPerfect, airT, airHeight, hadTrick, trick);
        Audio.land();
        if (isPerfect) Audio.perfect();
      } else {
        this.y = newGY;
        this.crash();
      }
    }
  }

  _checkFeatures(terrain, prevX) {
    // Cones
    for (const cone of terrain.cones) {
      if (cone.cleared || cone.hit) continue;
      if (prevX < cone.x && this.x >= cone.x) {
        const gy = terrain.groundY(cone.x);
        const coneTopY = gy - 28; // cone is ~28 px tall
        if (this.y < coneTopY - 2) {
          cone.cleared = true;
          this.game.onConeCleared();
        } else {
          cone.hit = true;
          this.game.onConeHit();
        }
      }
    }

    // Bumps & dips
    for (const f of terrain.features) {
      if (f.type !== 'bump' && f.type !== 'dip') continue;
      if (f.hit || f.cleared) continue;
      const midX = (f.x_start + f.x_end) / 2;
      if (prevX < midX && this.x >= midX) {
        if (!this.grounded) {
          f.cleared = true;
          if (f.type === 'bump') this.game.onBumpJumped();
          else                   this.game.onDipCleared();
        } else {
          f.hit = true;
          if (f.type === 'bump') this.game.onBumpHit();
          else                   this.game.onDipHit();
        }
      }
    }

    // Finish flag (campaign only)
    if (terrain.finish && prevX < terrain.finish.x && this.x >= terrain.finish.x) {
      this.game.onFinish();
    }
  }

  // Visible blink helper (returns true if currently visible)
  isVisible() {
    if (this.crashed) {
      return Math.floor(this.blinkTimer / C.BLINK_INTERVAL) % 2 === 0;
    }
    if (this.invulnerable) {
      return Math.floor(this.invulnTimer / C.BLINK_INTERVAL) % 2 === 0;
    }
    return true;
  }
}

// =====================================================
// EFFECTS - Particles, screen shake, flash
// =====================================================
class Effects {
  constructor() {
    this.particles = [];
    this.shakeT = 0;
    this.shakeMag = 0;
    this.flashT = 0;
    this.flashColor = '#fff';
  }

  update(dt) {
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.life -= dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vy += (p.gravity || 200) * dt;
      if (p.life <= 0) this.particles.splice(i, 1);
    }
    if (this.shakeT > 0) this.shakeT -= dt;
    if (this.flashT > 0) this.flashT -= dt;
  }

  dust(x, y, count = 6) {
    for (let i = 0; i < count; i++) {
      this.particles.push({
        x, y,
        vx: rand(-90, 90) - 30,
        vy: rand(-100, -30),
        life: rand(0.4, 0.7),
        size: rand(2, 4),
        color: '#d4b591',
        gravity: 280,
      });
    }
  }

  exhaust(x, y) {
    this.particles.push({
      x, y,
      vx: rand(-50, -20),
      vy: rand(-30, -10),
      life: rand(0.3, 0.5),
      size: rand(2, 3.5),
      color: 'rgba(180,180,190,0.7)',
      gravity: -50,
    });
  }

  sparks(x, y, count = 10) {
    for (let i = 0; i < count; i++) {
      this.particles.push({
        x, y,
        vx: rand(-180, 180),
        vy: rand(-200, -60),
        life: rand(0.5, 0.9),
        size: rand(2, 3),
        color: choice(['#f8e060', '#ff5cae', '#5cffe0', '#fff']),
        gravity: 350,
      });
    }
  }

  shake(t, mag) { this.shakeT = t; this.shakeMag = mag; }
  flash(t, color) { this.flashT = t; this.flashColor = color; this.flashDur = t; }

  shakeOffset() {
    if (this.shakeT <= 0) return { x: 0, y: 0 };
    const m = this.shakeMag * (this.shakeT / (this.shakeT + 0.15));
    return { x: rand(-m, m), y: rand(-m, m) };
  }
}

// =====================================================
// RENDERER - Drawing routines (all on canvas)
// =====================================================
const Renderer = {
  drawSky(ctx, w, h, t) {
    // Soft gradient sky
    const grad = ctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0.00, '#4ca8e0');
    grad.addColorStop(0.55, '#9ad0ee');
    grad.addColorStop(0.95, '#ffd0a0');
    grad.addColorStop(1.00, '#f8a890');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);

    // Sun
    const sunX = w * 0.82, sunY = 64;
    ctx.fillStyle = 'rgba(255,250,200,0.5)';
    ctx.beginPath(); ctx.arc(sunX, sunY, 34, 0, Math.PI*2); ctx.fill();
    ctx.fillStyle = '#fff0a0';
    ctx.beginPath(); ctx.arc(sunX, sunY, 22, 0, Math.PI*2); ctx.fill();
  },

  drawParallax(ctx, w, h, cameraX) {
    // Clouds (slowest, ~0.15)
    for (let i = 0; i < 7; i++) {
      const base = i * 230;
      const period = w + 240;
      let cx = ((base - cameraX * 0.15) % period + period * 10) % period - 120;
      const cy = 30 + ((i * 31) % 80);
      const sz = 22 + ((i * 13) % 18);
      this._cloud(ctx, cx, cy, sz);
    }

    // Far hills (~0.22) - rolling silhouette
    ctx.fillStyle = '#5a6890';
    for (let i = 0; i < 16; i++) {
      const base = i * 180;
      const period = w + 360;
      let hx = ((base - cameraX * 0.22) % period + period * 10) % period - 180;
      const peakH = 50 + ((i * 17) % 28);
      this._hill(ctx, hx, 240, 100, peakH);
    }

    // Mid hills/buildings (~0.42)
    for (let i = 0; i < 14; i++) {
      const base = i * 150;
      const period = w + 300;
      let bx = ((base - cameraX * 0.42) % period + period * 10) % period - 150;
      if (i % 3 === 0) {
        this._building(ctx, bx, 245, 38 + ((i * 11) % 24), 55 + ((i * 23) % 50), '#3a3354');
      } else {
        ctx.fillStyle = '#4a4870';
        this._hill(ctx, bx, 245, 70, 30 + ((i * 7) % 18));
      }
    }

    // Near foreground (~0.7) - bushes/trees/poles
    for (let i = 0; i < 16; i++) {
      const base = i * 100;
      const period = w + 200;
      let fx = ((base - cameraX * 0.7) % period + period * 10) % period - 100;
      const kind = (i * 7 + 3) % 4;
      if (kind === 0) this._tree(ctx, fx, 268);
      else if (kind === 1) this._bush(ctx, fx, 274);
      else if (kind === 2) this._pole(ctx, fx, 268);
      else this._bush(ctx, fx, 274);
    }
  },

  _cloud(ctx, x, y, s) {
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.beginPath();
    ctx.arc(x,         y,        s * 0.55, 0, Math.PI*2);
    ctx.arc(x + s*0.4, y - s*0.2, s * 0.45, 0, Math.PI*2);
    ctx.arc(x + s*0.8, y,        s * 0.5,  0, Math.PI*2);
    ctx.arc(x + s*0.4, y + s*0.1, s * 0.4,  0, Math.PI*2);
    ctx.fill();
  },

  _hill(ctx, x, baseY, w, h) {
    ctx.beginPath();
    ctx.moveTo(x - w*0.5, baseY);
    ctx.quadraticCurveTo(x, baseY - h, x + w*0.5, baseY);
    ctx.closePath();
    ctx.fill();
  },

  _building(ctx, x, baseY, w, h, color) {
    ctx.fillStyle = color;
    ctx.fillRect(x, baseY - h, w, h);
    // Roof
    ctx.fillStyle = '#251f3a';
    ctx.fillRect(x - 1, baseY - h - 2, w + 2, 2);
    // Windows (deterministic)
    ctx.fillStyle = '#f8e060';
    const cols = Math.max(2, Math.floor(w / 8));
    const rows = Math.max(2, Math.floor(h / 9));
    for (let r = 0; r < rows; r++) {
      for (let cc = 0; cc < cols; cc++) {
        if (((cc * 13 + r * 7 + Math.floor(x)) % 5) < 3) {
          const wx = x + 2 + cc * (w - 4) / cols;
          const wy = baseY - h + 3 + r * (h - 6) / rows;
          ctx.fillRect(Math.round(wx), Math.round(wy), 2, 3);
        }
      }
    }
  },

  _tree(ctx, x, baseY) {
    ctx.fillStyle = '#3a2a18';
    ctx.fillRect(x - 1, baseY - 12, 3, 12);
    ctx.fillStyle = '#284028';
    ctx.beginPath(); ctx.arc(x, baseY - 16, 10, 0, Math.PI*2); ctx.fill();
    ctx.fillStyle = '#345038';
    ctx.beginPath(); ctx.arc(x - 3, baseY - 18, 6, 0, Math.PI*2); ctx.fill();
  },

  _bush(ctx, x, baseY) {
    ctx.fillStyle = '#345038';
    ctx.beginPath();
    ctx.arc(x,     baseY, 7, 0, Math.PI*2);
    ctx.arc(x - 5, baseY + 1, 5, 0, Math.PI*2);
    ctx.arc(x + 5, baseY + 1, 5, 0, Math.PI*2);
    ctx.fill();
  },

  _pole(ctx, x, baseY) {
    ctx.fillStyle = '#252028';
    ctx.fillRect(x - 1, baseY - 22, 2, 22);
    ctx.fillStyle = '#f8e060';
    ctx.fillRect(x - 4, baseY - 22, 9, 2);
  },

  drawTerrain(ctx, terrain, cameraX, viewW) {
    const canvasH = ctx.canvas.height;
    if (terrain.points.length === 0) {
      // Fallback flat ground
      ctx.fillStyle = '#5a3520';
      ctx.fillRect(cameraX - 50, C.GROUND_BASE_Y, viewW + 100, canvasH - C.GROUND_BASE_Y + 50);
      ctx.fillStyle = '#252028';
      ctx.fillRect(cameraX - 50, C.GROUND_BASE_Y, viewW + 100, 6);
      return;
    }

    const startX = cameraX - 50;
    const endX   = cameraX + viewW + 50;

    // Collect visible heightmap points
    const pts = terrain.points;
    const vis = [];
    vis.push({ x: startX, y: terrain.groundY(startX) });
    for (const p of pts) {
      if (p.x >= startX - 100 && p.x <= endX + 100) vis.push(p);
    }
    vis.push({ x: endX, y: terrain.groundY(endX) });

    // Earth fill (dark dirt) - extends down to actual canvas bottom
    ctx.fillStyle = '#5a3520';
    ctx.beginPath();
    ctx.moveTo(vis[0].x, vis[0].y);
    for (let i = 1; i < vis.length; i++) ctx.lineTo(vis[i].x, vis[i].y);
    ctx.lineTo(endX, canvasH + 20);
    ctx.lineTo(startX, canvasH + 20);
    ctx.closePath();
    ctx.fill();

    // Dirt texture stripes (subtle)
    ctx.fillStyle = '#4a2a18';
    for (let y = C.GROUND_BASE_Y + 18; y < canvasH; y += 12) {
      ctx.fillRect(startX, y, endX - startX, 2);
    }

    // Top strip (road surface): dark asphalt band along the heightmap top
    ctx.strokeStyle = '#252028';
    ctx.lineWidth = 6;
    ctx.lineCap = 'butt';
    ctx.lineJoin = 'miter';
    ctx.beginPath();
    ctx.moveTo(vis[0].x, vis[0].y + 3);
    for (let i = 1; i < vis.length; i++) ctx.lineTo(vis[i].x, vis[i].y + 3);
    ctx.stroke();

    // Top edge highlight
    ctx.strokeStyle = '#454050';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(vis[0].x, vis[0].y);
    for (let i = 1; i < vis.length; i++) ctx.lineTo(vis[i].x, vis[i].y);
    ctx.stroke();

    // Road markings (yellow dashes on flat parts)
    ctx.fillStyle = '#f8c040';
    const dashLen = 14, dashGap = 14;
    const period = dashLen + dashGap;
    const dStart = Math.floor(startX / period) * period;
    for (let dx = dStart; dx < endX; dx += period) {
      const slope = terrain.groundSlope(dx + dashLen * 0.5);
      if (Math.abs(slope) > 0.22) continue;
      const y = terrain.groundY(dx) - 0.5;
      ctx.fillRect(dx, y, dashLen, 2);
    }

    // Ramp highlight surfaces
    for (const f of terrain.features) {
      if (f.type !== 'ramp') continue;
      if (f.x_end < startX || f.x_start > endX) continue;
      const y1 = terrain.groundY(f.x_start);
      const y2 = terrain.groundY(f.x_end);
      // Surface (sand color)
      ctx.strokeStyle = '#d8a850';
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.moveTo(f.x_start, y1);
      ctx.lineTo(f.x_end,   y2);
      ctx.stroke();
      // Stripes
      ctx.strokeStyle = '#a87830';
      ctx.lineWidth = 1.5;
      const dx = f.x_end - f.x_start;
      const dy = y2 - y1;
      const len = Math.hypot(dx, dy);
      const steps = Math.max(3, Math.floor(len / 14));
      for (let i = 1; i < steps; i++) {
        const t = i / steps;
        const sx = f.x_start + dx * t;
        const sy = y1 + dy * t;
        const nx = -dy / len, ny = dx / len;
        ctx.beginPath();
        ctx.moveTo(sx - nx * 3, sy - ny * 3);
        ctx.lineTo(sx + nx * 1, sy + ny * 1);
        ctx.stroke();
      }
      // Ramp side wall (back of ramp)
      ctx.fillStyle = '#7a4a20';
      ctx.beginPath();
      ctx.moveTo(f.x_end,      y2);
      ctx.lineTo(f.x_end + 4,  y2);
      ctx.lineTo(f.x_end + 4,  C.GROUND_BASE_Y);
      ctx.lineTo(f.x_end,      C.GROUND_BASE_Y);
      ctx.closePath();
      ctx.fill();
    }
  },

  drawFeatures(ctx, terrain, cameraX, viewW) {
    const startX = cameraX - 50, endX = cameraX + viewW + 50;

    // Cones
    for (const cone of terrain.cones) {
      if (cone.x < startX || cone.x > endX) continue;
      const gy = terrain.groundY(cone.x);
      this._cone(ctx, cone.x, gy, cone.hit);
    }

    // Finish flag
    if (terrain.finish) {
      const fx = terrain.finish.x;
      if (fx >= startX - 60 && fx <= endX + 60) {
        const gy = terrain.groundY(fx);
        this._finishFlag(ctx, fx, gy);
      }
    }
  },

  _cone(ctx, x, gy, hit) {
    // Pixel-art traffic cone
    const baseW = 14;
    const h = 28;
    // Base
    ctx.fillStyle = hit ? '#553530' : '#252028';
    ctx.fillRect(Math.round(x - baseW/2), Math.round(gy - 3), baseW, 3);
    // Body (orange triangle, stacked rects for pixel feel)
    const color = hit ? '#a04030' : '#ff8030';
    const stripe = hit ? '#704030' : '#ffd0a0';
    for (let i = 0; i < 5; i++) {
      const yy = gy - 5 - i * 5;
      const ww = baseW - i * 2;
      ctx.fillStyle = (i === 2 || i === 3) ? stripe : color;
      ctx.fillRect(Math.round(x - ww/2), Math.round(yy - 5), ww, 5);
    }
    // Tip
    ctx.fillStyle = color;
    ctx.fillRect(Math.round(x - 1), Math.round(gy - h - 1), 2, 3);
  },

  _finishFlag(ctx, x, gy) {
    const poleH = 60;
    // Pole
    ctx.fillStyle = '#f8f5ee';
    ctx.fillRect(Math.round(x - 1), Math.round(gy - poleH), 2, poleH);
    // Flag (checkered)
    const fw = 28, fh = 18;
    const cellSize = 5;
    for (let r = 0; r < fh / cellSize; r++) {
      for (let cc = 0; cc < fw / cellSize; cc++) {
        ctx.fillStyle = ((r + cc) % 2 === 0) ? '#150a1f' : '#f8f5ee';
        ctx.fillRect(
          Math.round(x + 2 + cc * cellSize),
          Math.round(gy - poleH + r * cellSize),
          cellSize, cellSize
        );
      }
    }
    // "FINISH" text on a sign above
    ctx.fillStyle = '#f8e060';
    ctx.fillRect(Math.round(x - 18), Math.round(gy - poleH - 12), 50, 10);
    ctx.fillStyle = '#150a1f';
    ctx.font = 'bold 8px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('FINISH', x + 7, gy - poleH - 7);
  },

  drawPlayer(ctx, player) {
    if (!player.isVisible()) return;

    ctx.save();
    ctx.translate(player.x, player.y);
    ctx.rotate(player.angle);

    // ----- BIKE -----
    const W = 36;       // bike length
    const wR = 6;       // wheel radius

    // Wheels (dark with rim)
    const wheelPositions = [{x: -W/2 + wR, y: -wR}, {x: W/2 - wR, y: -wR}];
    for (const wp of wheelPositions) {
      // Outer tire
      ctx.fillStyle = '#1a1320';
      ctx.beginPath(); ctx.arc(wp.x, wp.y, wR, 0, Math.PI*2); ctx.fill();
      // Rim
      ctx.fillStyle = '#e8c060';
      ctx.beginPath(); ctx.arc(wp.x, wp.y, wR - 1.5, 0, Math.PI*2); ctx.fill();
      // Hub
      ctx.fillStyle = '#252028';
      ctx.beginPath(); ctx.arc(wp.x, wp.y, 1.6, 0, Math.PI*2); ctx.fill();
      // Spokes (spinning)
      ctx.save();
      ctx.translate(wp.x, wp.y);
      ctx.rotate(player.wheelSpin);
      ctx.strokeStyle = '#252028';
      ctx.lineWidth = 0.8;
      ctx.beginPath();
      ctx.moveTo(-wR+1, 0); ctx.lineTo(wR-1, 0);
      ctx.moveTo(0, -wR+1); ctx.lineTo(0, wR-1);
      ctx.stroke();
      ctx.restore();
    }

    // Bike frame (red)
    ctx.fillStyle = '#d83040';
    // Lower body (between wheels)
    ctx.fillRect(-W/2 + wR + 1, -wR - 5, W - wR * 2 - 2, 3);
    // Tank
    ctx.fillStyle = '#a02030';
    ctx.fillRect(-3, -wR - 9, 12, 5);
    // Engine
    ctx.fillStyle = '#3a3540';
    ctx.fillRect(-W/2 + wR + 2, -wR - 3, 8, 2);
    // Forks
    ctx.strokeStyle = '#3a3540';
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(W/2 - wR, -wR);
    ctx.lineTo(W/2 - wR - 1, -wR - 8);
    ctx.stroke();
    // Handlebar post
    ctx.fillStyle = '#252028';
    ctx.fillRect(W/2 - wR - 2, -wR - 12, 2, 8);
    // Handlebar
    ctx.fillRect(W/2 - wR - 5, -wR - 14, 8, 2);
    // Seat
    ctx.fillStyle = '#1a1320';
    ctx.fillRect(-W/2 + wR + 3, -wR - 10, 9, 3);

    // Headlight
    ctx.fillStyle = '#fff8a0';
    ctx.fillRect(W/2 - wR + 1, -wR - 9, 2, 3);

    // ----- RIDER (PENELOPE) -----
    this._drawRider(ctx, player);

    ctx.restore();

    // ----- TRICK TEXT -----
    if (player.trickName && player.trickTimer > 0) {
      const a = clamp(player.trickTimer / C.TRICK_DURATION, 0, 1);
      ctx.save();
      ctx.translate(player.x, player.y - 60);
      ctx.font = 'bold 11px monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.lineWidth = 3;
      ctx.strokeStyle = '#150a1f';
      ctx.strokeText(player.trickName, 0, 0);
      ctx.fillStyle = '#f8e060';
      ctx.fillText(player.trickName, 0, 0);
      ctx.restore();
      // Tiny dim for fade
      void a;
    }
  },

  _drawRider(ctx, player) {
    // Rider sits on seat (origin at wheel/ground center)
    // Pose adjustments by trick
    let armAngle = -0.2;        // default arms forward
    let legAngle = 0.0;
    let bodyOffsetX = 0;
    let bodyOffsetY = 0;
    let armB = 0.4;             // back arm

    switch (player.trickName) {
      case 'NO HANDER':
        armAngle = -2.0; armB = -2.2; break;
      case 'SUPERMAN':
        bodyOffsetX = 4; bodyOffsetY = 3; armAngle = -0.1; armB = -0.1; break;
      case 'HEEL CLICKER':
        legAngle = -0.9; break;
      case 'CAN-CAN':
        legAngle = 0.8; break;
      case 'TAILWHIP':
        bodyOffsetY = -1; armAngle = -0.5; break;
      case 'BAR SPIN':
        armAngle = -0.5; armB = 0.5; break;
    }

    ctx.save();
    ctx.translate(-2 + bodyOffsetX, -16 + bodyOffsetY);

    // Legs
    ctx.fillStyle = '#252028'; // dark pants
    ctx.save();
    ctx.translate(2, 3);
    ctx.rotate(legAngle);
    ctx.fillRect(-1, 0, 5, 6);
    ctx.fillStyle = '#1a1320';
    ctx.fillRect(-1, 5, 5, 2); // boot
    ctx.restore();

    // Torso (jacket)
    ctx.fillStyle = '#3a5cd8'; // blue jacket
    ctx.fillRect(-2, -6, 7, 8);
    // Jacket detail
    ctx.fillStyle = '#5c7cf0';
    ctx.fillRect(1, -6, 1, 8); // zipper highlight

    // Back arm
    ctx.save();
    ctx.translate(-1, -4);
    ctx.rotate(armB);
    ctx.fillStyle = '#3a5cd8';
    ctx.fillRect(0, 0, 5, 2);
    ctx.fillStyle = '#e8b890'; // glove (tan)
    ctx.fillRect(4, 0, 2, 2);
    ctx.restore();

    // Front arm
    ctx.save();
    ctx.translate(3, -4);
    ctx.rotate(armAngle);
    ctx.fillStyle = '#3a5cd8';
    ctx.fillRect(0, 0, 6, 2);
    ctx.fillStyle = '#e8b890';
    ctx.fillRect(5, 0, 2, 2);
    ctx.restore();

    // Neck
    ctx.fillStyle = '#e8b890';
    ctx.fillRect(0, -8, 4, 2);

    // Hair ponytail (back of head, sticking out)
    ctx.fillStyle = '#6a3a18';
    ctx.fillRect(-3, -9, 2, 5);
    ctx.fillRect(-4, -7, 2, 3);

    // Head (skin)
    ctx.fillStyle = '#e8b890';
    ctx.fillRect(-1, -13, 5, 5);

    // Hair under helmet (forehead)
    ctx.fillStyle = '#6a3a18';
    ctx.fillRect(-1, -13, 5, 1);

    // Helmet
    ctx.fillStyle = '#ff5cae'; // pink helmet
    ctx.fillRect(-2, -16, 7, 4);
    ctx.fillRect(-1, -12, 6, 1); // helmet rim
    // Helmet stripe
    ctx.fillStyle = '#f8e060';
    ctx.fillRect(-2, -14, 7, 1);
    // Visor
    ctx.fillStyle = '#1a1320';
    ctx.fillRect(0, -12, 4, 2);
    ctx.fillStyle = '#5cffe0';
    ctx.fillRect(1, -12, 1, 1); // visor shine

    ctx.restore();
  },

  drawParticles(ctx, effects) {
    for (const p of effects.particles) {
      ctx.fillStyle = p.color;
      ctx.fillRect(Math.round(p.x - p.size/2), Math.round(p.y - p.size/2),
                   Math.round(p.size), Math.round(p.size));
    }
  },

  drawFlash(ctx, w, h, effects) {
    if (effects.flashT <= 0) return;
    const a = clamp(effects.flashT / (effects.flashDur || 0.3), 0, 1);
    ctx.fillStyle = effects.flashColor;
    ctx.globalAlpha = a * 0.5;
    ctx.fillRect(0, 0, w, h);
    ctx.globalAlpha = 1;
  },

  drawGroundOverlay(ctx, w, h) {
    // Subtle ground horizon line / fog at sky-ground meeting
    const grad = ctx.createLinearGradient(0, C.GROUND_BASE_Y - 20, 0, C.GROUND_BASE_Y + 4);
    grad.addColorStop(0, 'rgba(255, 200, 160, 0.0)');
    grad.addColorStop(1, 'rgba(120, 60, 40, 0.25)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, C.GROUND_BASE_Y - 20, w, 24);
  },
};

// =====================================================
// UI - DOM-based menus and HUD
// =====================================================
const UI = {
  screens: {},
  hud: null,
  controls: null,
  messageOverlay: null,
  pauseBtn: null,

  init() {
    this.screens = {
      main:              document.getElementById('screen-main'),
      howto:             document.getElementById('screen-how'),
      pause:             document.getElementById('screen-pause'),
      gameover:          document.getElementById('screen-gameover'),
      levelComplete:     document.getElementById('screen-level-complete'),
      campaignComplete:  document.getElementById('screen-campaign-complete'),
    };
    this.hud = document.getElementById('hud');
    this.controls = document.getElementById('controls');
    this.messageOverlay = document.getElementById('message-overlay');
    this.pauseBtn = document.getElementById('btn-pause');

    // Wire data-action buttons
    document.querySelectorAll('[data-action]').forEach(btn => {
      btn.addEventListener('click', () => {
        Audio.init(); Audio.resume(); Audio.menu();
        this.handleAction(btn.dataset.action);
      });
    });

    // Pause button
    this.pauseBtn.addEventListener('click', () => {
      Audio.menu();
      if (game.state === 'playing') game.pause();
      else if (game.state === 'paused') game.resume();
    });

    // Mute toggle
    const muteBtn = document.getElementById('btn-mute');
    muteBtn.addEventListener('click', () => {
      Audio.init();
      const m = Audio.toggleMute();
      muteBtn.classList.toggle('muted', m);
      muteBtn.textContent = m ? '✕' : '♪';
    });

    // Show main menu initially
    this.showScreen('main');
  },

  handleAction(action) {
    switch (action) {
      case 'quickplay':
        this.hideScreens(); game.startQuickPlay(); break;
      case 'campaign':
        this.hideScreens(); game.resetCampaignProgress(); game.startCampaign(0); break;
      case 'how-to-play':
        this.showScreen('howto'); break;
      case 'back-main':
        this.showScreen('main'); break;
      case 'resume':
        game.resume(); break;
      case 'restart':
        this.hideScreens();
        if (game.mode === 'quickplay') game.startQuickPlay();
        else if (game.mode === 'campaign') game.startCampaign(game.currentLevel);
        break;
      case 'main-menu':
        game.toMainMenu(); break;
      case 'next-level':
        this.hideScreens(); game.nextLevel(); break;
      case 'restart-campaign':
        this.hideScreens(); game.resetCampaignProgress(); game.startCampaign(0); break;
    }
  },

  showScreen(name) {
    this.hideScreens();
    if (this.screens[name]) this.screens[name].classList.remove('hidden');
  },
  hideScreens() {
    for (const s of Object.values(this.screens)) s.classList.add('hidden');
  },

  showHUD()      { this.hud.classList.remove('hidden'); },
  hideHUD()      { this.hud.classList.add('hidden'); },
  showControls() { this.controls.classList.remove('hidden'); this.pauseBtn.classList.remove('hidden'); },
  hideControls() { this.controls.classList.add('hidden');    this.pauseBtn.classList.add('hidden'); },

  updateHUD(game) {
    if (this.hud.classList.contains('hidden')) return;

    const modeEl = document.getElementById('hud-mode');
    const distEl = document.getElementById('hud-distance');
    const scoreEl = document.getElementById('hud-score');
    const speedEl = document.getElementById('hud-speed');
    const extraEl = document.getElementById('hud-extra');
    const comboEl = document.getElementById('hud-combo');

    const mph = Math.max(0, Math.floor(game.player.vx / 4.2));
    const scoreInt = Math.floor(game.score);

    if (game.mode === 'quickplay') {
      modeEl.textContent  = 'QUICK PLAY';
      distEl.textContent  = `DIST ${Math.floor(game.distance)}M`;
      scoreEl.textContent = `SCORE ${scoreInt}`;
      speedEl.textContent = `MPH ${mph}`;
      extraEl.textContent = `BEST ${game.highScore}`;
    } else if (game.mode === 'campaign') {
      const cfg = LEVELS[game.currentLevel];
      const totalLen = cfg.length || 1;
      const progress = clamp(Math.floor(((game.player.x - 120) / totalLen) * 100), 0, 100);
      modeEl.textContent  = `LV ${game.currentLevel + 1}/15`;
      distEl.textContent  = `${cfg.name}`;
      scoreEl.textContent = `SCORE ${scoreInt}`;
      speedEl.textContent = `MPH ${mph}`;
      extraEl.textContent = `${progress}% · CRASH ${game.crashes}`;
    } else {
      modeEl.textContent = '';
      distEl.textContent = '';
      scoreEl.textContent = '';
      speedEl.textContent = '';
      extraEl.textContent = '';
    }

    if (game.combo > 1) {
      comboEl.textContent = `COMBO x${game.combo}`;
      comboEl.classList.remove('hidden');
    } else {
      comboEl.classList.add('hidden');
    }
  },

  showPopup(text, variant = 'gold') {
    const el = document.createElement('div');
    el.className = 'msg-popup ' + variant;
    el.textContent = text;
    this.messageOverlay.appendChild(el);
    setTimeout(() => { if (el.parentNode) el.parentNode.removeChild(el); }, 1400);
  },

  showGameOver(stats) {
    const grid = document.getElementById('gameover-stats');
    const flavor = document.getElementById('gameover-flavor');
    flavor.textContent = stats.score >= stats.highScore && stats.score > 0
      ? '★ NEW HIGH SCORE ★'
      : '★ TRY AGAIN ★';
    grid.innerHTML = `
      <div class="label">Distance</div><div class="value">${Math.floor(stats.distance)} M</div>
      <div class="label">Score</div><div class="value">${stats.score}</div>
      <div class="label">High Score</div><div class="value">${stats.highScore}</div>
      <div class="label">Clean Landings</div><div class="value">${stats.cleanLandings}</div>
      <div class="label">Tricks Landed</div><div class="value">${stats.tricks}</div>
      <div class="label">Top Combo</div><div class="value">x${stats.maxCombo}</div>
    `;
    this.showScreen('gameover');
  },

  showLevelComplete(stats) {
    const grid = document.getElementById('level-stats');
    const flavor = document.getElementById('level-flavor');
    flavor.textContent = stats.crashes === 0 ? '★ NO CRASHES! ★' : `★ STAGE ${stats.level} CLEARED ★`;
    grid.innerHTML = `
      <div class="label">Level</div><div class="value">${stats.level} · ${stats.name}</div>
      <div class="label">Score</div><div class="value">${stats.score}</div>
      <div class="label">Clean Landings</div><div class="value">${stats.cleanLandings}</div>
      <div class="label">Tricks Landed</div><div class="value">${stats.tricks}</div>
      <div class="label">Crashes</div><div class="value">${stats.crashes}</div>
      <div class="label">Top Combo</div><div class="value">x${stats.maxCombo}</div>
    `;
    const btn = document.querySelector('#screen-level-complete [data-action="next-level"]');
    btn.textContent = stats.isFinal ? 'FINISH CAMPAIGN' : 'NEXT LEVEL';
    this.showScreen('levelComplete');
  },

  showCampaignComplete(stats) {
    const grid = document.getElementById('campaign-stats');
    grid.innerHTML = `
      <div class="label">Total Score</div><div class="value">${stats.totalScore}</div>
      <div class="label">Total Crashes</div><div class="value">${stats.totalCrashes}</div>
      <div class="label">Levels Cleared</div><div class="value">15 / 15</div>
    `;
    this.showScreen('campaignComplete');
  },
};

// =====================================================
// GAME - State manager, ties it all together
// =====================================================
class Game {
  constructor() {
    this.canvas = document.getElementById('game-canvas');
    this.ctx = this.canvas.getContext('2d', { alpha: false });
    this.mode = null;
    this.state = 'menu';
    this.player = new Player(this);
    this.terrain = new Terrain();
    this.effects = new Effects();
    this.cameraX = 0;
    this.viewportW = 0;
    this.viewportH = 0;
    this.logicalW = 640;
    this.scale = 1;

    this.score = 0;
    this.distance = 0;
    this.startX = 0;
    this.combo = 0;
    this.maxCombo = 0;
    this.cleanLandings = 0;
    this.tricksLanded = 0;
    this.crashes = 0;
    this.timeElapsed = 0;

    this.currentLevel = 0;
    this.campaignTotalScore = 0;
    this.campaignTotalCrashes = 0;

    this.qpEndDelay = 0;

    // Load high score
    try {
      const v = localStorage.getItem(C.HS_KEY);
      this.highScore = v ? parseInt(v, 10) : 0;
      if (!Number.isFinite(this.highScore)) this.highScore = 0;
    } catch (e) {
      this.highScore = 0;
    }

    // Initial menu backdrop terrain (flat ground behind main menu)
    this._initMenuBackdrop();
  }

  _initMenuBackdrop() {
    this.terrain.reset();
    this.terrain.points.push({ x: -500, y: C.GROUND_BASE_Y });
    this.terrain.points.push({ x: 3000, y: C.GROUND_BASE_Y });
  }

  toMainMenu() {
    this.state = 'menu';
    this.mode = null;
    this._initMenuBackdrop();
    this.player.reset(120, C.GROUND_BASE_Y, 0);
    this.cameraX = 0;
    UI.hideHUD();
    UI.hideControls();
    UI.showScreen('main');
  }

  startQuickPlay() {
    this.mode = 'quickplay';
    this.state = 'playing';
    this.terrain.initEndless();
    this.terrain.extendEndless(2000, 0);
    this.player.reset(120, this.terrain.groundY(120), C.BASE_SPEED);
    this.cameraX = this.player.x - this.logicalW * C.PLAYER_X_FRAC;
    this._resetRunStats();
    UI.showHUD();
    UI.showControls();
  }

  startCampaign(idx) {
    if (idx < 0) idx = 0;
    if (idx >= LEVELS.length) idx = LEVELS.length - 1;
    this.mode = 'campaign';
    this.state = 'playing';
    this.currentLevel = idx;
    const cfg = LEVELS[idx];
    this.terrain.generateCampaign(cfg);
    this.player.reset(120, this.terrain.groundY(120), cfg.baseSpeed);
    this.cameraX = this.player.x - this.logicalW * C.PLAYER_X_FRAC;
    this._resetRunStats();
    UI.showHUD();
    UI.showControls();
  }

  resetCampaignProgress() {
    this.currentLevel = 0;
    this.campaignTotalScore = 0;
    this.campaignTotalCrashes = 0;
  }

  _resetRunStats() {
    this.score = 0;
    this.distance = 0;
    this.startX = this.player.x;
    this.combo = 0;
    this.maxCombo = 0;
    this.cleanLandings = 0;
    this.tricksLanded = 0;
    this.crashes = 0;
    this.timeElapsed = 0;
    this.qpEndDelay = 0;
    this.effects.particles.length = 0;
    this.effects.shakeT = 0;
    this.effects.flashT = 0;
  }

  pause() {
    if (this.state !== 'playing') return;
    this.state = 'paused';
    UI.showScreen('pause');
  }

  resume() {
    if (this.state !== 'paused') return;
    this.state = 'playing';
    UI.hideScreens();
  }

  nextLevel() {
    if (this.currentLevel + 1 >= LEVELS.length) {
      this.state = 'campaignComplete';
      UI.hideControls();
      UI.hideHUD();
      UI.showCampaignComplete({
        totalScore: this.campaignTotalScore,
        totalCrashes: this.campaignTotalCrashes,
      });
    } else {
      this.startCampaign(this.currentLevel + 1);
    }
  }

  // ---------- Update / Render ----------
  update(dt) {
    // Global key shortcuts (regardless of state)
    if (Input.pausePressed()) {
      if (this.state === 'playing') this.pause();
      else if (this.state === 'paused') this.resume();
    }
    if (Input.restartPressed()) {
      if (this.state === 'gameover' || this.state === 'paused') {
        if (this.mode === 'quickplay') this.startQuickPlay();
        else if (this.mode === 'campaign') this.startCampaign(this.currentLevel);
      }
    }
    if (Input.enterPressed()) {
      if (this.state === 'levelComplete') this.nextLevel();
      else if (this.state === 'gameover') this.startQuickPlay();
    }

    if (this.state !== 'playing') {
      // Still update effects so popups continue when paused-overlay? no — keep frozen
      return;
    }

    this.timeElapsed += dt;

    // Quick play speed scaling (every 60s adds QP_SPEED_PER_MIN)
    if (this.mode === 'quickplay') {
      const newBase = C.BASE_SPEED + (this.timeElapsed / 60) * C.QP_SPEED_PER_MIN;
      this.player.baseSpeed = Math.min(newBase, C.MAX_SPEED - 80);
    }

    // Player update
    this.player.update(dt, this.terrain);

    // Distance & distance-based score (only adds on new ground covered)
    const currentDist = Math.max(0, this.player.x - this.startX);
    if (currentDist > this.distance) {
      const dx = currentDist - this.distance;
      const rate = this.mode === 'quickplay' ? 0.6 : 0.2;
      this.score += dx * rate;
      this.distance = currentDist;
    }

    // Extend / cleanup endless terrain
    if (this.mode === 'quickplay') {
      this.terrain.extendEndless(this.player.x + 1800, this.distance);
      this.terrain.cleanupBehind(this.player.x);
    }

    // Camera follow
    const targetCamX = this.player.x - this.logicalW * C.PLAYER_X_FRAC;
    this.cameraX += (targetCamX - this.cameraX) * Math.min(1, C.CAM_LERP * dt);

    // Effects
    this.effects.update(dt);

    // Quick play end delay
    if (this.qpEndDelay > 0) {
      this.qpEndDelay -= dt;
      if (this.qpEndDelay <= 0) this._endQuickPlayRun();
    }
  }

  render() {
    const ctx = this.ctx;
    const w = this.canvas.width;
    const h = this.canvas.height;

    // Sky
    Renderer.drawSky(ctx, w, h, this.timeElapsed);

    // Parallax background (does NOT use camera transform - uses cameraX directly)
    Renderer.drawParallax(ctx, w, h, this.cameraX);

    // Ground horizon fog
    Renderer.drawGroundOverlay(ctx, w, h);

    // World transform: shake + camera
    const shake = this.effects.shakeOffset();
    ctx.save();
    ctx.translate(-this.cameraX + shake.x, shake.y);

    // Terrain
    Renderer.drawTerrain(ctx, this.terrain, this.cameraX - shake.x, w);

    // Features (cones, finish flag)
    Renderer.drawFeatures(ctx, this.terrain, this.cameraX - shake.x, w);

    // Particles behind player? Mix is fine.
    Renderer.drawParticles(ctx, this.effects);

    // Player
    Renderer.drawPlayer(ctx, this.player);

    ctx.restore();

    // Flash overlay
    Renderer.drawFlash(ctx, w, h, this.effects);

    // Update HUD (DOM)
    UI.updateHUD(this);
  }

  resize(vw, vh) {
    this.viewportW = vw;
    this.viewportH = vh;

    // Try to keep LOGICAL_HEIGHT = 360. If viewport is too narrow (portrait),
    // bump up the logical width minimum and let the logical height grow instead,
    // so the canvas internal aspect always matches the viewport (no stretch).
    const MIN_LOGICAL_W = 320;
    let scale = vh / C.LOGICAL_HEIGHT;
    let logicalW = Math.round(vw / scale);
    let logicalH = C.LOGICAL_HEIGHT;

    if (logicalW < MIN_LOGICAL_W) {
      scale = vw / MIN_LOGICAL_W;
      logicalW = MIN_LOGICAL_W;
      logicalH = Math.round(vh / scale);
    }

    this.scale = scale;
    this.logicalW = logicalW;
    this.logicalH = logicalH;

    this.canvas.width  = logicalW;
    this.canvas.height = logicalH;
    this.canvas.style.width  = vw + 'px';
    this.canvas.style.height = vh + 'px';
  }

  // =========== Player callbacks ===========
  onCrash() {
    this.crashes++;
    this.combo = 0;
    this.effects.shake(0.4, 8);
    this.effects.flash(0.3, '#ff4060');
    this.effects.sparks(this.player.x, this.player.y - 10, 14);
    UI.showPopup('CRASH!', 'red');
  }

  onCrashEnd() {
    if (this.mode === 'quickplay') {
      // Brief delay then game over
      this.qpEndDelay = 0.4;
    } else {
      // Respawn for campaign
      this.player.respawn(this.terrain);
      this.player.baseSpeed = LEVELS[this.currentLevel].baseSpeed;
      this.score = Math.max(0, this.score - 200);
      // Snap camera to respawn position so it doesn't scroll back oddly
      this.cameraX = this.player.x - this.logicalW * C.PLAYER_X_FRAC;
      UI.showPopup('-200 PENALTY', 'red');
    }
  }

  _endQuickPlayRun() {
    this.state = 'gameover';
    const intScore = Math.floor(this.score);
    if (intScore > this.highScore) {
      this.highScore = intScore;
      try { localStorage.setItem(C.HS_KEY, String(this.highScore)); } catch (e) {}
    }
    UI.hideControls();
    UI.showGameOver({
      distance: this.distance,
      score: Math.floor(this.score),
      highScore: this.highScore,
      cleanLandings: this.cleanLandings,
      tricks: this.tricksLanded,
      crashes: this.crashes,
      maxCombo: this.maxCombo,
    });
  }

  onCleanLanding(isPerfect, airTime, airHeight, hadTrick, trickName) {
    let bonus = isPerfect ? 120 : 50;

    // Airtime bonus
    if (airTime > 0.4) {
      bonus += Math.floor(airTime * 70);
    }
    // Height bonus
    if (airHeight > 30) {
      bonus += Math.floor(airHeight * 0.7);
    }

    this.cleanLandings++;

    // Trick bonus
    if (hadTrick && trickName) {
      bonus += 180;
      this.tricksLanded++;
      UI.showPopup(`${trickName} +180`, 'pink');
    }

    // Combo
    this.combo++;
    this.maxCombo = Math.max(this.maxCombo, this.combo);
    if (this.combo > 1) {
      bonus = Math.floor(bonus * (1 + this.combo * 0.12));
      if (this.combo % 3 === 0) Audio.combo();
    }

    this.score += bonus;

    const label = isPerfect
      ? 'PERFECT!'
      : choice(['CLEAN!', 'SMOOTH!', 'NICE!', 'STUCK IT!', 'SOLID!']);
    UI.showPopup(`${label} +${bonus}`, isPerfect ? 'gold' : 'cyan');

    this.effects.dust(this.player.x, this.player.y, 8);
  }

  onTrickStart(name) {
    UI.showPopup(name + '!', 'pink');
  }

  onConeCleared() {
    this.score += 30;
    UI.showPopup('CONE +30', 'cyan');
  }
  onConeHit() {
    this.combo = 0;
    this.player.vx *= C.CONE_SLOW_MULT;
    Audio.bump();
    this.effects.shake(0.15, 3);
    UI.showPopup('CONE HIT', 'red');
  }
  onBumpJumped() {
    this.score += 25;
    UI.showPopup('BUMP +25', 'cyan');
  }
  onBumpHit() {
    this.player.vx = Math.max(this.player.baseSpeed * 0.7, this.player.vx - C.BUMP_SLOW);
    this.combo = 0;
    Audio.bump();
  }
  onDipCleared() {
    this.score += 40;
    UI.showPopup('DIP +40', 'cyan');
  }
  onDipHit() {
    this.player.vx = Math.max(this.player.baseSpeed * 0.6, this.player.vx - C.DIP_SLOW);
    this.combo = 0;
    Audio.bump();
  }
  onFinish() {
    if (this.mode !== 'campaign' || this.state !== 'playing') return;
    this.state = 'levelComplete';
    Audio.finish();
    UI.showPopup('FINISH!', 'gold');
    const intScore = Math.floor(this.score);
    this.campaignTotalScore += intScore;
    this.campaignTotalCrashes += this.crashes;
    UI.hideControls();
    UI.showLevelComplete({
      level: this.currentLevel + 1,
      name: LEVELS[this.currentLevel].name,
      score: intScore,
      cleanLandings: this.cleanLandings,
      tricks: this.tricksLanded,
      crashes: this.crashes,
      maxCombo: this.maxCombo,
      isFinal: this.currentLevel >= LEVELS.length - 1,
    });
  }
}

// =====================================================
// MAIN LOOP
// =====================================================
let game;
let lastTime = 0;

function loop(t) {
  const now = t / 1000;
  let dt = lastTime ? now - lastTime : 0;
  if (dt > 0.05) dt = 0.05; // clamp big gaps (tab switch, lag)
  lastTime = now;

  game.update(dt);
  game.render();
  Input.clearPressed();

  requestAnimationFrame(loop);
}

function onResize() {
  game.resize(
    window.innerWidth  || document.documentElement.clientWidth,
    window.innerHeight || document.documentElement.clientHeight
  );
}

function boot() {
  Input.init();
  game = new Game();
  window.game = game; // expose for debugging
  UI.init();
  onResize();
  window.addEventListener('resize', onResize);
  window.addEventListener('orientationchange', () => setTimeout(onResize, 100));
  requestAnimationFrame(loop);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
