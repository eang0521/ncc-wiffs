// Pitch definitions, pitch selection AI, and physical pitch construction.
// Wiffle ball movement comes from the perforated side of the ball, not spin. We model it as an
// aerodynamic side force in a fixed direction (in the pitcher's frame) that ramps in over the
// flight ("late break"). Pitchers aim with their expected break; actual break varies.
import { FIELD, MPH, FT, RULES } from '../config.js';
import { flyToPlane } from './physics.js';
import { clamp, smoothstep } from '../util/rng.js';

// dir: [glove-side, up] in the pitcher's frame. brk: feet of break at level 10 / movement 100.
// speed: fraction of the pitcher's top velocity. ctrl: how easy it is to locate (1 = easiest).
export const PITCH_TYPES = {
  fastball:    { name: 'Fastball',    abbr: 'FB', speed: 1.00, dir: [0.1, 0.3],   brk: 0.45, ctrl: 1.00 },
  riser:       { name: 'Riser',       abbr: 'RI', speed: 0.93, dir: [0.05, 1],    brk: 2.6,  ctrl: 0.82 },
  drop:        { name: 'Drop',        abbr: 'DR', speed: 0.90, dir: [0, -1],      brk: 2.8,  ctrl: 0.84 },
  curve:       { name: 'Curveball',   abbr: 'CU', speed: 0.80, dir: [0.72, -0.7], brk: 3.3,  ctrl: 0.78 },
  slider:      { name: 'Slider',      abbr: 'SL', speed: 0.88, dir: [1, -0.15],   brk: 2.7,  ctrl: 0.84 },
  sweeper:     { name: 'Sweeper',     abbr: 'SW', speed: 0.82, dir: [1, 0.05],    brk: 3.6,  ctrl: 0.74 },
  screwball:   { name: 'Screwball',   abbr: 'SC', speed: 0.85, dir: [-1, -0.2],   brk: 2.5,  ctrl: 0.78 },
  knuckleball: { name: 'Knuckleball', abbr: 'KN', speed: 0.70, dir: [0, 0],       brk: 1.7,  ctrl: 0.62, knuckle: true },
  changeup:    { name: 'Changeup',    abbr: 'CH', speed: 0.72, dir: [-0.35, -1],  brk: 1.0,  ctrl: 0.92 },
  cutter:      { name: 'Cutter',      abbr: 'CT', speed: 0.95, dir: [1, 0],       brk: 1.1,  ctrl: 0.92 },
  sinker:      { name: 'Screw-Drop',  abbr: 'SD', speed: 0.87, dir: [-0.7, -0.75],brk: 2.3,  ctrl: 0.82 },
  riseslider:  { name: 'Rise-Slider', abbr: 'RS', speed: 0.88, dir: [0.75, 0.7],  brk: 2.6,  ctrl: 0.78 },
};
export const PITCH_KEYS = Object.keys(PITCH_TYPES);

export const ARM_SLOTS = {
  over:  { name: 'Overhand',      x: 0.32, y: 1.85, mult: { up: 0.7, down: 1.15, side: 0.9 } },
  three: { name: 'Three-Quarter', x: 0.50, y: 1.60, mult: { up: 0.9, down: 1.0, side: 1.0 } },
  side:  { name: 'Sidearm',       x: 0.80, y: 1.12, mult: { up: 1.05, down: 0.9, side: 1.15 } },
  under: { name: 'Submarine',     x: 0.55, y: 0.55, mult: { up: 1.3, down: 0.75, side: 1.0 } },
};

const RELEASE_Z = FIELD.moundZ - 0.9;
const HALF_W = FIELD.zoneWidth / 2;
const HALF_H = FIELD.zoneHeight / 2;

export function releasePoint(pitcher) {
  const slot = ARM_SLOTS[pitcher.pitch.armSlot] || ARM_SLOTS.three;
  const s = pitcher.throws === 'L' ? 1 : -1; // RHP arm side is the 3B side (-x)
  return [s * slot.x, slot.y, RELEASE_Z];
}

export function gloveSign(pitcher) { return pitcher.throws === 'L' ? -1 : 1; }

/** Fatigue in [0, ~1.5]: 1.0 means the pitcher has reached his stamina budget. */
export function fatigueLevel(pitcher, pitchCount) {
  const budget = 35 + pitcher.pitch.stamina * 0.9;
  return pitchCount / budget;
}
export function fatigueEffects(f) {
  const x = Math.max(0, f - 0.35);
  return { velo: 1 - 0.07 * x * x, ctrl: 1 + 0.6 * x * x, move: 1 - 0.14 * x * x };
}

function breakVector(pitcher, typeKey, level, fx) {
  const T = PITCH_TYPES[typeKey];
  const slot = ARM_SLOTS[pitcher.pitch.armSlot] || ARM_SLOTS.three;
  const lv = clamp(level, 1, 10) / 10;
  const mv = pitcher.pitch.movement / 100;
  let mag = T.brk * FT * (0.3 + 0.7 * lv) * (0.55 + 0.55 * mv) * fx.move;
  let [gx, gy] = T.dir;
  const sm = gy >= 0 ? slot.mult.up : slot.mult.down;
  gx *= slot.mult.side; gy *= sm;
  const l = Math.hypot(gx, gy);
  if (l > 1e-6) { mag *= l; gx /= l; gy /= l; }
  return { mag, gx, gy };
}

function makeAccel(dirWorld, A, knuckle) {
  const span = RELEASE_Z - FIELD.zoneZ;
  if (knuckle) {
    const { ph1, ph2, f1, f2, amp } = knuckle;
    const out = [0, 0, 0];
    return (ball, p) => {
      const f = clamp((RELEASE_Z - p[2]) / span, 0, 1.4);
      const ramp = smoothstep(0.05, 0.55, f);
      const ang = ph1 + Math.sin(f * f1 + ph2) * 2.2 + f * f2;
      out[0] = Math.cos(ang) * A * amp * ramp; out[1] = Math.sin(ang) * A * amp * ramp;
      return out;
    };
  }
  const out = [0, 0, 0];
  return (ball, p) => {
    const f = clamp((RELEASE_Z - p[2]) / span, 0, 1.4);
    const ramp = smoothstep(0.12, 0.72, f);
    out[0] = dirWorld[0] * A * ramp; out[1] = dirWorld[1] * A * ramp;
    return out;
  };
}

// Aim solver: find the release velocity direction that lands at (tx, ty) on the zone plane.
function solveAim(p0, speed, accel, tx, ty) {
  let ax = tx, ay = ty + 0.2;
  let v = null, hit = null;
  for (let i = 0; i < 7; i++) {
    const d = [ax - p0[0], ay - p0[1], FIELD.zoneZ - p0[2]];
    const l = Math.hypot(...d);
    v = [d[0] / l * speed, d[1] / l * speed, d[2] / l * speed];
    hit = flyToPlane(p0, v, accel, FIELD.zoneZ, 1 / 600);
    const ex = tx - hit.x, ey = ty - hit.y;
    if (Math.abs(ex) < 0.003 && Math.abs(ey) < 0.003) break;
    ax += ex; ay += ey;
  }
  return { v, hit };
}

/**
 * Build a physical pitch.
 * ctx: { pitcher, typeKey, level, target:[x,y], intendedMph, fatigue, rng }
 */
export function buildPitch(ctx) {
  const { pitcher, typeKey, level, target, intendedMph, fatigue, rng } = ctx;
  const T = PITCH_TYPES[typeKey];
  const fx = fatigueEffects(fatigue);
  const p0 = releasePoint(pitcher);

  const actualMph = Math.max(18, intendedMph * fx.velo + rng.normal(0, 0.9));
  const speed = actualMph * MPH;
  const radar = Math.round(actualMph);

  // Break: expected (what the pitcher aims with) vs actual (with variance)
  const bv = breakVector(pitcher, typeKey, level, fx);
  const gs = gloveSign(pitcher);
  const dirExp = [bv.gx * gs, bv.gy];

  // Calibrate acceleration magnitude so total displacement ~= bv.mag at this speed
  const straightDir = [0, FIELD.zoneZ - p0[2]];
  const v0 = [0, 0.2, -speed];
  const zeroHit = flyToPlane(p0, v0, null, FIELD.zoneZ, 1 / 600);
  const unitAccel = makeAccel([1, 0], 1, null);
  const unitHit = flyToPlane(p0, v0, unitAccel, FIELD.zoneZ, 1 / 600);
  const perUnit = Math.max(0.02, unitHit.x - zeroHit.x);
  void straightDir;
  const Aexp = bv.mag / perUnit;

  let knuckle = null;
  if (T.knuckle) {
    knuckle = { ph1: rng.range(0, Math.PI * 2), ph2: rng.range(0, Math.PI * 2), f1: rng.range(4, 9), f2: rng.range(-3, 3), amp: rng.range(0.5, 1.2) };
  }
  // Pitcher aims expecting the average break (knuckleball: aims straight)
  const accelExp = T.knuckle ? null : makeAccel(dirExp, Aexp, null);

  // Execution error (command)
  const ctrl = pitcher.pitch.control / 100;
  const lv = clamp(level, 1, 10) / 10;
  const sigma = (0.06 + 0.28 * (1 - ctrl)) / T.ctrl * (1.3 - 0.3 * lv) * fx.ctrl;
  const aimX = target[0] + rng.normal(0, sigma);
  const aimY = target[1] + rng.normal(0, sigma * 0.95);

  const sol = solveAim(p0, speed, accelExp, aimX, aimY);

  // Actual break differs from expected
  const consistency = 0.06 + 0.16 * (1 - pitcher.pitch.movement / 100) + 0.05 * (1 - lv);
  const magAct = Math.max(0, rng.normal(1, consistency));
  const angJit = rng.normal(0, 0.1);
  const c = Math.cos(angJit), s = Math.sin(angJit);
  const dirAct = [dirExp[0] * c - dirExp[1] * s, dirExp[0] * s + dirExp[1] * c];
  const accel = makeAccel(dirAct, Aexp * magAct, knuckle);

  const final = flyToPlane(p0, sol.v, accel, FIELD.zoneZ, 1 / 1000);
  return {
    typeKey, type: T.name, abbr: T.abbr, level,
    p0, v0: sol.v, accel,
    mph: actualMph, radar,
    target, aim: [aimX, aimY],
    expected: [sol.hit.x, sol.hit.y],
    cross: [final.x, final.y], flightTime: final.t,
    breakMag: bv.mag * magAct * (T.knuckle ? 1.4 : 1),
    knuckle: !!T.knuckle,
  };
}

// ---------------- Pitch selection AI ----------------

/** Familiarity fraction (0..1) a batter has with a pitch from a pitcher. */
export function familiarityFrac(n) { return 1 - Math.exp(-n / 7); }

export function choosePitch({ pitcher, batter, count, famFor, rng, fatigue, warningUsed }) {
  const ars = pitcher.pitch.arsenal.length ? pitcher.pitch.arsenal : [{ type: 'fastball', level: 5 }];
  const { balls, strikes } = count;
  const behind = balls >= 3 || (balls === 2 && strikes === 0);
  const putaway = strikes === 2 && balls < 3;

  const pick = rng.weighted(ars, (a) => {
    const T = PITCH_TYPES[a.type] || PITCH_TYPES.fastball;
    let w = Math.pow(a.level, 1.6);
    const fam = familiarityFrac(famFor(a.type));
    w *= 1 - 0.5 * fam;                    // mix it up: avoid what he's seen a lot
    if (behind) w *= 0.5 + T.ctrl * T.ctrl;  // throw something you can locate
    if (putaway) w *= 0.6 + T.brk / 3;       // go to the nasty stuff
    return Math.max(0.05, w);
  });
  const T = PITCH_TYPES[pick.type] || PITCH_TYPES.fastball;

  // Velocity: respect the 65 mph limit (63-64 earns a warning, one per half inning)
  let top = pitcher.pitch.velocity;
  const fbIntent = Math.min(top * rng.normal(0.975, 0.012), top);
  let mph = fbIntent * T.speed * (0.96 + 0.04 * pick.level / 10);
  const cap = warningUsed ? 61.6 : 62.5;
  const fxv = fatigueEffects(fatigue).velo;
  if (mph * fxv > cap) mph = cap / fxv;

  // Location
  const gs = gloveSign(pitcher);
  const awayFromBatter = batter.bats === 'R' ? 1 : -1; // RHB stands on -x side; away = +x
  let tx, ty;
  const vy = T.dir[1], vx = T.dir[0] * gs;
  const edge = rng.range(0.7, 1.25);
  // horizontal: breaking balls start toward their break side's opposite; fastballs pick an edge
  if (Math.abs(vx) > 0.4) tx = Math.sign(vx) * edge * HALF_W * (rng.chance(0.75) ? 1 : -0.4);
  else tx = (rng.chance(0.55) ? awayFromBatter : -awayFromBatter) * edge * HALF_W;
  if (vy > 0.4) ty = FIELD.zoneCenterY + rng.range(0.25, 0.95) * HALF_H;
  else if (vy < -0.4) ty = FIELD.zoneCenterY - rng.range(0.25, 0.95) * HALF_H;
  else ty = FIELD.zoneCenterY + rng.range(-0.85, 0.85) * HALF_H;

  if (behind) {
    tx *= 0.45; ty = FIELD.zoneCenterY + (ty - FIELD.zoneCenterY) * 0.45;
  } else if (putaway && rng.chance(0.65)) {
    // chase pitch: expand just off the zone in the pitch's break direction
    const ex = rng.range(0.03, 0.14);
    if (Math.abs(vy) >= Math.abs(vx)) ty += Math.sign(vy || -1) * (HALF_H * 0.4 + ex);
    else tx += Math.sign(tx || vx) * (HALF_W * 0.3 + ex);
  }
  return { typeKey: pick.type, level: pick.level, target: [tx, ty], intendedMph: mph };
}

export function speedRuling(radar, warningUsed) {
  if (radar >= RULES.speedAutoBall) return 'auto';
  if (radar >= RULES.speedWarnMin) return warningUsed ? 'auto' : 'warn';
  return null;
}
