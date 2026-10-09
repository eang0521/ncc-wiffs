// Ball physics: gravity, quadratic drag, pitch break forces, batted-ball flutter,
// ground bounces/rolling, fence panels, backstop.
import { BALL, GROUND, FIELD, G } from '../config.js';

export function makeBall(p, v) {
  return {
    p: [...p], v: [...v],
    accel: null,        // optional fn(ball, t) -> [ax,ay,az] extra acceleration (pitch break)
    flutter: null,      // {dir:[x,y,z], c, rate} batted ball wobble
    t: 0,
    grounded: false,
    rolling: false,
    bounces: 0,
    dead: false,
    overFence: false,
    atRest: false,
  };
}

const _a = [0, 0, 0];
function accelAt(ball, px, py, pz, vx, vy, vz, t) {
  const sp = Math.sqrt(vx * vx + vy * vy + vz * vz);
  const kd = BALL.k * sp;
  let ax = -kd * vx, ay = -G - kd * vy, az = -kd * vz;
  if (ball.accel) {
    _p[0] = px; _p[1] = py; _p[2] = pz;
    const e = ball.accel(ball, _p, null, t);
    ax += e[0]; ay += e[1]; az += e[2];
  }
  if (ball.flutter && !ball.rolling) {
    const f = ball.flutter;
    const m = f.c * sp * sp;
    ax += f.dir[0] * m; ay += f.dir[1] * m; az += f.dir[2] * m;
  }
  _a[0] = ax; _a[1] = ay; _a[2] = az;
  return _a;
}
const _p = [0, 0, 0];

// RK2 (midpoint) air integration, allocation-free
function integrateAir(ball, dt) {
  const p = ball.p, v = ball.v;
  const a1 = accelAt(ball, p[0], p[1], p[2], v[0], v[1], v[2], ball.t);
  const h = dt / 2;
  const vmx = v[0] + a1[0] * h, vmy = v[1] + a1[1] * h, vmz = v[2] + a1[2] * h;
  const a2 = accelAt(ball, p[0] + v[0] * h, p[1] + v[1] * h, p[2] + v[2] * h, vmx, vmy, vmz, ball.t + h);
  p[0] += vmx * dt; p[1] += vmy * dt; p[2] += vmz * dt;
  v[0] += a2[0] * dt; v[1] += a2[1] * dt; v[2] += a2[2] * dt;
}

const FENCE_NEAR2 = (FIELD.fencePanels.reduce((a, b) => Math.min(a, b), Infinity) * 0.9) ** 2;

function segIntersect(a0, a1, b0, b1) {
  // 2D segments a0->a1, b0->b1; returns [ta, tb] or null
  const r = [a1[0] - a0[0], a1[1] - a0[1]];
  const s = [b1[0] - b0[0], b1[1] - b0[1]];
  const den = r[0] * s[1] - r[1] * s[0];
  if (Math.abs(den) < 1e-12) return null;
  const q = [b0[0] - a0[0], b0[1] - a0[1]];
  const ta = (q[0] * s[1] - q[1] * s[0]) / den;
  const tb = (q[0] * r[1] - q[1] * r[0]) / den;
  if (ta < 0 || ta > 1 || tb < 0 || tb > 1) return null;
  return [ta, tb];
}

/**
 * Advance the ball by dt, handling collisions. Returns an array of events.
 * rng optional: adds irregular bounces typical of a light plastic ball on grass.
 */
export function stepBall(ball, dt, rng = null) {
  const events = [];
  if (ball.dead || ball.atRest) { ball.t += dt; return events; }
  const prev = [...ball.p];
  const R = BALL.radius;

  if (ball.rolling) {
    const sp = Math.hypot(ball.v[0], ball.v[2]);
    if (sp < GROUND.restSpeed) {
      ball.v = [0, 0, 0]; ball.atRest = true;
      events.push({ type: 'rest', p: [...ball.p] });
    } else {
      const dec = GROUND.rollDecel + BALL.k * sp * sp;
      const ns = Math.max(0, sp - dec * dt);
      ball.v[0] *= ns / sp; ball.v[2] *= ns / sp; ball.v[1] = 0;
      ball.p[0] += ball.v[0] * dt; ball.p[2] += ball.v[2] * dt; ball.p[1] = R;
    }
  } else {
    integrateAir(ball, dt);
    if (ball.flutter && rng) {
      // slow random walk of flutter direction
      const f = ball.flutter;
      f.dir[0] += rng.normal(0, f.rate * dt); f.dir[1] += rng.normal(0, f.rate * dt); f.dir[2] += rng.normal(0, f.rate * dt * 0.3);
      const l = Math.hypot(...f.dir) || 1; f.dir = f.dir.map((x) => x / l);
    }
    if (ball.p[1] < R && ball.v[1] < 0) {
      // ground contact
      const frac = (prev[1] - R) / Math.max(1e-9, prev[1] - ball.p[1]);
      for (let i = 0; i < 3; i += 2) ball.p[i] = prev[i] + (ball.p[i] - prev[i]) * frac;
      ball.p[1] = R;
      const vy = -ball.v[1];
      events.push({ type: 'bounce', p: [...ball.p], first: !ball.grounded, vy });
      ball.grounded = true;
      ball.bounces++;
      if (vy < 0.9) {
        ball.v[1] = 0; ball.rolling = true; ball.flutter = null;
      } else {
        ball.v[1] = vy * GROUND.restitution;
        let kf = GROUND.bounceFriction;
        if (rng) kf *= rng.range(0.9, 1.05);
        ball.v[0] *= kf; ball.v[2] *= kf;
        if (rng) {
          const ang = rng.normal(0, 0.09);
          const c = Math.cos(ang), s = Math.sin(ang);
          const vx = ball.v[0], vz = ball.v[2];
          ball.v[0] = vx * c - vz * s; ball.v[2] = vx * s + vz * c;
        }
      }
    }
  }

  // Fence panels (fair territory only)
  if (!ball.overFence && (ball.p[0] * ball.p[0] + ball.p[2] * ball.p[2] > FENCE_NEAR2 || prev[0] * prev[0] + prev[2] * prev[2] > FENCE_NEAR2)) {
    const a0 = [prev[0], prev[2]], a1 = [ball.p[0], ball.p[2]];
    const S = FIELD.fenceSegs;
    for (let i = 0; i < S.length; i++) {
      const hit = segIntersect(a0, a1, S[i].a, S[i].b);
      if (!hit) continue;
      const y = prev[1] + (ball.p[1] - prev[1]) * hit[0];
      const nrm = S[i].n; // outward normal
      const vn = ball.v[0] * nrm[0] + ball.v[2] * nrm[1];
      if (vn <= 0) continue;
      if (y < FIELD.fenceHeight + R * 0.5) {
        // bounce off the fence panel
        ball.p[0] = a0[0] + (a1[0] - a0[0]) * hit[0] - nrm[0] * 0.05;
        ball.p[2] = a0[1] + (a1[1] - a0[1]) * hit[0] - nrm[1] * 0.05;
        const e = 0.3;
        ball.v[0] -= (1 + e) * vn * nrm[0];
        ball.v[2] -= (1 + e) * vn * nrm[1];
        ball.v[0] *= 0.8; ball.v[2] *= 0.8; ball.v[1] *= 0.7;
        events.push({ type: 'fence', p: [...ball.p], y, panel: S[i].panel });
      } else {
        ball.overFence = true;
        events.push({ type: 'overFence', p: [...ball.p], y, panel: S[i].panel, grounded: ball.grounded });
      }
      break;
    }
  }

  // Backstop: a 7x7 ft net 4 ft behind the PVC zone (soaks up most of the ball's speed)
  const bz = FIELD.backstopZ;
  if (prev[2] > bz && ball.p[2] <= bz && ball.v[2] < 0) {
    const t = (prev[2] - bz) / (prev[2] - ball.p[2]);
    const x = prev[0] + (ball.p[0] - prev[0]) * t;
    const y = prev[1] + (ball.p[1] - prev[1]) * t;
    if (Math.abs(x) <= FIELD.backstopSize / 2 + R && y <= FIELD.backstopSize + R) {
      ball.p[2] = bz + 0.02;
      ball.v[2] = -ball.v[2] * 0.12; ball.v[0] *= 0.35; ball.v[1] *= 0.35;
      ball.flutter = null;
      if (ball.rolling) ball.v[1] = 0;
      events.push({ type: 'backstop', p: [ball.p[0], y, bz], x, y });
    }
  }

  // Strike zone plane crossing (for pitches and throws home)
  const zz = FIELD.zoneZ;
  if (prev[2] > zz && ball.p[2] <= zz) {
    const t = (prev[2] - zz) / (prev[2] - ball.p[2]);
    const x = prev[0] + (ball.p[0] - prev[0]) * t;
    const y = prev[1] + (ball.p[1] - prev[1]) * t;
    events.push({ type: 'zoneCross', x, y, inZone: inStrikeZone(x, y), grounded: ball.grounded, t: ball.t + dt * t });
    // Tin plate zip-tied inside the frame: the ball clanks off it back toward the field
    if (Math.abs(x) <= FIELD.plateW / 2 + R && Math.abs(y - FIELD.zoneCenterY) <= FIELD.plateH / 2 + R && ball.v[2] < 0) {
      ball.p = [x, y, zz + R + 0.005];
      ball.v[2] = -ball.v[2] * 0.3; ball.v[0] *= 0.7; ball.v[1] *= 0.7;
      ball.flutter = null; ball.accel = null; ball.rolling = false;
      events.push({ type: 'plate', x, y, p: [...ball.p] });
    }
  }

  ball.t += dt;
  return events;
}

// Ball passing through the frame or clipping the PVC counts.
export function inStrikeZone(x, y) {
  const m = BALL.radius + FIELD.pvcRadius;
  return Math.abs(x) <= FIELD.zoneWidth / 2 + m && y >= FIELD.zoneBottom - m && y <= FIELD.zoneTop + m;
}

export function cloneBall(b) {
  return {
    ...b, p: [...b.p], v: [...b.v],
    flutter: null, // prediction ignores random flutter
  };
}

/** Predict trajectory samples (no randomness). Returns [{t, p:[x,y,z], ground}] */
export function predictPath(ball, maxT = 8, dt = 1 / 60, sampleEvery = 2) {
  const b = cloneBall(ball);
  b.t = 0;
  const out = [{ t: 0, p: [...b.p], ground: b.rolling }];
  let i = 0;
  while (b.t < maxT && !b.atRest && !b.overFence) {
    stepBall(b, dt, null);
    if (++i % sampleEvery === 0) out.push({ t: b.t, p: [...b.p], ground: b.rolling || b.p[1] <= BALL.radius + 0.02 });
  }
  out.push({ t: b.t, p: [...b.p], ground: true, rest: b.atRest, over: b.overFence });
  return out;
}

/** Integrate in the air only (no collisions) until z <= zPlane. Returns {x, y, t, v} at the plane. */
export function flyToPlane(p, v, accel, zPlane, dt = 1 / 1000, maxT = 3) {
  const b = makeBall(p, v);
  b.accel = accel;
  let prev = [...b.p];
  while (b.p[2] > zPlane && b.t < maxT) {
    prev = [...b.p];
    integrateAir(b, dt);
    b.t += dt;
  }
  const den = prev[2] - b.p[2];
  const f = den > 1e-9 ? (prev[2] - zPlane) / den : 0;
  return {
    x: prev[0] + (b.p[0] - prev[0]) * f,
    y: prev[1] + (b.p[1] - prev[1]) * f,
    t: b.t - dt * (1 - f),
    v: [...b.v],
  };
}

export function isFairXZ(x, z) {
  // Fair if within the foul lines (lines are fair)
  if (z <= 0) return false;
  const ang = Math.atan2(Math.abs(x), z);
  return ang <= FIELD.foulHalfAngle + 0.004;
}

// Distance along the nearest foul line (used for "past the base" checks)
export function foulLineProjection(x, z) {
  const h = FIELD.foulHalfAngle;
  const fx = Math.sign(x || 1) * Math.sin(h), fz = Math.cos(h);
  return x * fx + z * fz;
}
