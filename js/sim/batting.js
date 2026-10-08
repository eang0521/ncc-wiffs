// Batter perception, swing decision and a physical bat-ball collision.
// The bat is a thin cylinder swept around a pivot (the batter's body). The batter plans a swing
// height, plane position and timing from what he perceives; errors in those produce whiffs,
// foul tips, jams, pop-ups, grounders and squared-up line drives naturally.
import { FIELD, BALL, BAT } from '../config.js';
import { makeBall, stepBall, inStrikeZone } from './physics.js';
import { familiarityFrac } from './pitching.js';
import { clamp } from '../util/rng.js';

const CONTACT_Z = 0.22;           // planned contact point, slightly in front of home plate
const HALF_W = FIELD.zoneWidth / 2;

export function recognition(batter, famCount) {
  return clamp(0.08 + 0.62 * batter.bat.eye / 100 + 0.36 * familiarityFrac(famCount), 0.02, 0.97);
}

function zoneDistance(x, y) {
  const m = BALL.radius + FIELD.pvcRadius;
  const dx = Math.max(0, Math.abs(x) - (HALF_W + m));
  const dy = Math.max(0, FIELD.zoneBottom - m - y, y - (FIELD.zoneTop + m));
  return Math.hypot(dx, dy);
}

/** Pre-simulate the pitch path (no bat) at fine resolution. */
function pitchPath(pitch, dt) {
  const b = makeBall(pitch.p0, pitch.v0);
  b.accel = pitch.accel;
  const path = [];
  let cross = null;
  while (b.t < 2.5) {
    path.push({ t: b.t, p: [...b.p], v: [...b.v], grounded: b.grounded });
    const ev = stepBall(b, dt);
    for (const e of ev) if (e.type === 'zoneCross' && !cross) cross = { ...e };
    if (b.p[2] < FIELD.backstopZ - 0.5 || b.atRest) break;
    if (cross && b.t > cross.t + 0.35) break;
  }
  return { path, cross };
}

function interpAtZ(path, z) {
  for (let i = 1; i < path.length; i++) {
    if (path[i].p[2] <= z) {
      const a = path[i - 1], b = path[i];
      const f = (a.p[2] - z) / (a.p[2] - b.p[2]);
      return { t: a.t + (b.t - a.t) * f, x: a.p[0] + (b.p[0] - a.p[0]) * f, y: a.p[1] + (b.p[1] - a.p[1]) * f };
    }
  }
  return null;
}

/**
 * Decide and execute the swing.
 * ctx: { pitch, batter, count, famCount, fbMph, rng, autoBallKnown:false }
 */
export function batterAction(ctx) {
  const { pitch, batter, count, famCount, fbMph, rng } = ctx;
  const DT = 1 / 1000;
  const { path, cross } = pitchPath(pitch, DT);
  const recog = recognition(batter, famCount);
  const contactR = batter.bat.contact / 100;
  const powerR = batter.bat.power / 100;
  const brk = pitch.breakMag;

  // --- Decision ---
  const cx = cross ? cross.x : pitch.cross[0];
  const cy = cross ? cross.y : pitch.cross[1];
  const sDec = 0.025 + 0.07 * (1 - recog) + 0.14 * brk * (1 - recog) + (pitch.knuckle ? 0.05 : 0);
  const px = cx + rng.normal(0, sDec), py = cy + rng.normal(0, sDec);
  const d = (cross && cross.grounded) ? 0.4 : zoneDistance(px, py);
  const twoK = count.strikes === 2;
  let pSwing;
  if (count.balls === 3 && count.strikes === 0) pSwing = d <= 0 ? 0.35 : 0.02;
  else if (d <= 0) pSwing = 0.8 + (twoK ? 0.12 : 0) + 0.05 * powerR;
  else pSwing = (0.42 + (twoK ? 0.3 : 0)) * Math.exp(-d / 0.085) * (1 - 0.55 * recog);
  const swing = rng.chance(pSwing);

  const result = { swing, recog, perceived: [px, py], cross: cross || { x: cx, y: cy, inZone: inStrikeZone(cx, cy), grounded: false }, path, contact: null, swingInfo: null };
  if (!swing) return result;

  // --- Swing planning ---
  const at = interpAtZ(path, CONTACT_Z);
  if (!at) return result;
  const protect = twoK;
  const sr = pitch.mph / Math.max(20, fbMph);
  const tFb = at.t * sr; // when a fastball out of the same hand would have arrived
  const bias = (tFb - at.t) * (1 - recog) * 0.75 - (powerR - 0.5) * 0.006;
  const sT = (0.007 + 0.022 * (1 - contactR) + 0.012 * (1 - recog)) * (protect ? 0.85 : 1);
  const tPlan = at.t + bias + rng.normal(0, sT);
  const sY = (0.01 + 0.03 * (1 - contactR) + 0.09 * brk * (1 - recog) + (pitch.knuckle ? 0.03 : 0)) * (protect ? 0.85 : 1);
  const yPlan = at.y + rng.normal(0, sY);
  const xPlan = at.x + rng.normal(0, sY * 1.3);

  const side = batter.bats === 'L' ? -1 : 1;          // +1: RHB (pivot on -x side)
  const stanceX = -side * (BAT.sweet + 0.04);
  const wantPivot = xPlan - side * BAT.sweet;
  const pivotX = stanceX + 0.75 * (wantPivot - stanceX);
  const batSpeed = (15 + 8.5 * powerR) * (protect ? 0.9 : 1) * rng.normal(1, 0.03); // m/s at sweet spot
  const omega = batSpeed / BAT.sweet;
  const alpha = (6 + 6 * powerR + rng.normal(0, 3)) * Math.PI / 180;
  const tanA = Math.tan(alpha);
  const swingInfo = { tPlan, omega, pivot: [pivotX, yPlan, CONTACT_Z], alpha, side, batSpeed };
  result.swingInfo = swingInfo;

  // --- Collision search ---
  const PSI_MIN = -1.7, PSI_MAX = 2.0;
  const rSum = BALL.radius + BAT.radius;
  const h0 = BAT.handleOffset, h1 = BAT.handleOffset + BAT.length;
  const SUB = 3;
  for (let i = 0; i < path.length * SUB; i++) {
    const i0 = Math.floor(i / SUB), fr = (i % SUB) / SUB;
    const A = path[i0], Bp = path[Math.min(path.length - 1, i0 + 1)];
    const t = A.t + (Bp.t - A.t) * fr;
    const p = [A.p[0] + (Bp.p[0] - A.p[0]) * fr, A.p[1] + (Bp.p[1] - A.p[1]) * fr, A.p[2] + (Bp.p[2] - A.p[2]) * fr];
    const v = A.v;
    const psi = omega * (t - tPlan);
    if (psi < PSI_MIN) continue;
    if (psi > PSI_MAX) break;
    const ux = side * Math.cos(psi), uz = Math.sin(psi);
    const yb = yPlan + psi * BAT.sweet * tanA;
    // closest point on bat axis (horizontal) to ball
    const rx = p[0] - pivotX, rz = p[2] - CONTACT_Z;
    const s = clamp(rx * ux + rz * uz, h0, h1);
    const cxp = pivotX + ux * s, czp = CONTACT_Z + uz * s;
    const dx = p[0] - cxp, dy = p[1] - yb, dz = p[2] - czp;
    const dist = Math.hypot(dx, dy, dz);
    if (dist > rSum) continue;
    const n = [dx / dist, dy / dist, dz / dist];
    const tx = -side * Math.sin(psi), tz = Math.cos(psi); // bat travel direction
    const vb = [omega * s * tx, omega * s * tanA, omega * s * tz];
    const rel = [v[0] - vb[0], v[1] - vb[1], v[2] - vb[2]];
    const vn = rel[0] * n[0] + rel[1] * n[1] + rel[2] * n[2];
    if (vn >= 0) continue;
    const mEff = BAT.inertia / (s * s);
    const r = BALL.mass / mEff;
    const off = s - BAT.sweet;
    const e = clamp(BAT.cor * (1 - 2.4 * off * off) * rng.normal(1, 0.03), 0.06, 0.4);
    const relT = [rel[0] - vn * n[0], rel[1] - vn * n[1], rel[2] - vn * n[2]];
    const k = -(1 + e) * vn / (1 + r);
    const vOut = [
      v[0] + k * n[0] - 0.15 * relT[0] / (1 + r),
      v[1] + k * n[1] - 0.15 * relT[1] / (1 + r),
      v[2] + k * n[2] - 0.15 * relT[2] / (1 + r),
    ];
    const pOut = [p[0] + n[0] * 0.01, p[1] + n[1] * 0.01, p[2] + n[2] * 0.01];
    const exit = Math.hypot(...vOut);
    const launch = Math.atan2(vOut[1], Math.hypot(vOut[0], vOut[2])) * 180 / Math.PI;
    const spray = Math.atan2(vOut[0], vOut[2]) * 180 / Math.PI;
    result.contact = { t, p: pOut, v: vOut, s, offset: dy, exit, launch, spray, psi, sweetness: 1 - Math.abs(off) / 0.35 };
    // trim pitch path at contact
    result.path = path.slice(0, i0 + 1);
    return result;
  }
  return result;
}
