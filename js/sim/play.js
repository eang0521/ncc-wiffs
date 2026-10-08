// Live-ball simulation: batted ball flight, fielders, throws (to bases, at the PVC zone/backstop,
// and pegging runners), baserunning and the league's fair/foul/bunt-line rules.
import { FIELD, BALL } from '../config.js';
import { makeBall, stepBall, predictPath, isFairXZ, foulLineProjection, inStrikeZone } from './physics.js';
import { clamp } from '../util/rng.js';
import { dist2, norm2 } from '../util/vec.js';

const DT = 1 / 120;
const REC_EVERY = 2;            // record frames at 60 Hz
const REACH = 0.85;             // horizontal glove reach (m)
const CATCH_H = 2.35;           // max catchable height (m) incl. a jump
const BODY_R = 0.26;            // runner body radius for pegging
const ZONE_TARGET = [0, FIELD.zoneCenterY, FIELD.zoneZ];
const BEHIND = FIELD.zoneZ - 0.25;   // a batted ball this far back is foul and dead

export const basePos = (i) => FIELD.bases[((i % 4) + 4) % 4];
export const segLen = (i) => FIELD.baseDist[((i % 4) + 4) % 4];

function runnerXZ(r) {
  if (r.d <= 0) return [...basePos(r.seg)];
  const a = basePos(r.seg), b = basePos(r.seg + 1);
  const f = clamp(r.d / segLen(r.seg), 0, 1);
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
}

function travelTime(d, vmax, acc) {
  if (d <= 0) return 0;
  const dAcc = (vmax * vmax) / (2 * acc);
  return d < dAcc ? Math.sqrt((2 * d) / acc) : vmax / acc + (d - dAcc) / vmax;
}

/** Estimated flight time of a thrown wiffle ball (heavy drag) */
export function throwFlight(d, v0) {
  const k = BALL.k * 0.92;
  return (1.06 * (Math.exp(k * d) - 1)) / (k * v0) + 0.02;
}

function sigmoid(x) { return 1 / (1 + Math.exp(-x)); }

/** Solve throw velocity to pass through `to` from `from` at speed v (with drag). */
function solveThrow(from, to, v) {
  const dx = to[0] - from[0], dz = to[2] - from[2];
  const D = Math.hypot(dx, dz) || 0.01;
  const ux = dx / D, uz = dz / D;
  const heightAt = (theta) => {
    const b = makeBall(from, [ux * v * Math.cos(theta), v * Math.sin(theta), uz * v * Math.cos(theta)]);
    let prevH = 0, prevY = from[1];
    for (let i = 0; i < 600; i++) {
      stepBall(b, 1 / 150);
      const h = (b.p[0] - from[0]) * ux + (b.p[2] - from[2]) * uz;
      if (h >= D) { const f = (D - prevH) / Math.max(1e-6, h - prevH); return prevY + (b.p[1] - prevY) * f; }
      if (b.grounded || b.p[1] < 0.05) return -10 + h - D; // fell short
      prevH = h; prevY = b.p[1];
    }
    return -10;
  };
  let lo = -0.35, hi = 0.75;
  if (heightAt(hi) < to[1]) {
    // can't reach in the air: throw at a good distance angle and let it bounce/roll
    const th = 0.6;
    return { v: [ux * v * Math.cos(th), v * Math.sin(th), uz * v * Math.cos(th)], short: true };
  }
  for (let i = 0; i < 10; i++) {
    const mid = (lo + hi) / 2;
    if (heightAt(mid) > to[1]) hi = mid; else lo = mid;
  }
  const th = (lo + hi) / 2;
  return { v: [ux * v * Math.cos(th), v * Math.sin(th), uz * v * Math.cos(th)], short: false };
}

/**
 * ctx = {
 *   contact: {p, v}, defense: [{player, role, pos:[x,z]}], runners: [{player, base}],
 *   batter, outs, rng, record, pitcherId
 * }
 */
export function simulatePlay(ctx) {
  const { rng, record } = ctx;
  const outsAtStart = ctx.outs;
  const ball = makeBall(ctx.contact.p, ctx.contact.v);
  ball.flutter = { dir: [rng.normal(0, 1), rng.normal(0, 0.6), 0], c: 0.0011 * rng.range(0.4, 1.4), rate: 3 };
  { const l = Math.hypot(...ball.flutter.dir) || 1; ball.flutter.dir = ball.flutter.dir.map((x) => x / l); }

  const launch = Math.atan2(ctx.contact.v[1], Math.hypot(ctx.contact.v[0], ctx.contact.v[2])) * 180 / Math.PI;
  const res = {
    outs: [], runs: [], events: [], frames: record ? [] : null,
    foul: false, foulTipZone: false, hr: false, grd: false, deadBall: false,
    caughtFly: false, error: false, firstTouch: null, fieldedAt: null, landing: null,
    ballType: launch < 8 ? 'GB' : launch < 24 ? 'LD' : launch < 50 ? 'FB' : 'PU',
    launch, exit: Math.hypot(...ctx.contact.v),
    batterReached: 0, endBases: [null, null, null, null], throws: 0, pegs: 0,
  };

  // ---- Fielders ----
  const F = ctx.defense.map((d) => ({
    id: d.player.id, player: d.player, role: d.role,
    pos: [...d.pos], vel: [0, 0], home: [...d.pos],
    vmax: 5.4 + 2.6 * d.player.field.speed / 100, acc: 5.2,
    react: 0.1 + 0.28 * (1 - d.player.field.fielding / 100) + rng.range(0, 0.06),
    fld: d.player.field.fielding / 100, arm: d.player.field.arm / 100, accu: d.player.field.accuracy / 100,
    target: null, task: 'idle', busy: 0, cooldown: 0, anim: 0, animT: 0,
  }));
  const pitcherF = F.find((f) => f.role === 'P');

  // ---- Runners ----
  const R = [];
  const mkRunner = (player, base, isBatter) => ({
    id: player.id, player, isBatter, seg: base, d: 0, goal: base, v: 0,
    vmax: 5.7 + 2.5 * player.field.speed / 100, acc: 4.6,
    state: 'base', forceTo: null, waitFly: false, startDelay: 0, scoredAt: null, holdT: 0,
  });
  const batterR = mkRunner(ctx.batter, 0, true);
  batterR.startDelay = 0.32 - 0.12 * ctx.batter.field.speed / 100;
  batterR.goal = 1; batterR.state = 'run';
  R.push(batterR);
  for (const r of ctx.runners) R.push(mkRunner(r.player, r.base, false));
  // forced chain
  const occ = [true, false, false, false];
  for (const r of R) if (!r.isBatter) occ[r.seg] = true;
  batterR.forceTo = 1;
  for (let b = 1; b <= 3; b++) {
    const r = R.find((x) => !x.isBatter && x.seg === b);
    if (!r) break;
    let forced = true;
    for (let k = 0; k < b; k++) if (!occ[k]) forced = false;
    if (forced) r.forceTo = b + 1;
  }

  let outs = outsAtStart;
  let holder = null;            // fielder holding the ball
  let throwInfo = null;         // {from, kind, target, receiver, runner, t0}
  let fairState = 'pending';    // 'pending' | 'fair' | 'foul'
  let batted = true;            // ball still the original batted ball (no fielder touch yet)
  let groundedEver = false;
  let t = 0;
  let intercepts = null, nextIntercept = 0;
  let endTimer = 0;
  let finished = false;
  let lastFrame = -1;
  const twoOuts = outsAtStart === 2;

  const ev = (type, data = {}) => res.events.push({ t, type, ...data });

  const liveRunners = () => R.filter((r) => r.state !== 'out' && r.state !== 'scored');

  function recordOut(r, how, by, base) {
    if (r.state === 'out' || r.state === 'scored') return;
    r.state = 'out';
    outs++;
    res.outs.push({ id: r.id, how, by, base, t, seg: r.seg, isBatter: r.isBatter, forced: how === 'force' });
    ev('out', { id: r.id, how, by, base });
    // force removed for runners ahead of a retired trailing runner
    for (const o of R) if (o !== r && o.forceTo !== null && o.seg >= r.seg && !r.isBatter) o.forceTo = null;
    if (r.isBatter) for (const o of R) o.forceTo = null;
    if (outs >= 3) finished = true;
  }

  function resolveFair(x, z, fielded) {
    if (fairState !== 'pending') return;
    if ((fielded || ball.atRest) && z < FIELD.buntLine) { fairState = 'foul'; ev('buntline'); return; }
    fairState = isFairXZ(x, z) ? 'fair' : 'foul';
    ev(fairState);
  }

  function deadFoul() {
    res.foul = true; res.deadBall = true; finished = true;
  }

  // Predicted ball path / intercepts for every fielder
  function computeIntercepts() {
    const path = predictPath(ball, 7, 1 / 60, 3);
    const out = new Map();
    for (const f of F) {
      if (f === holder) continue;
      let best = null;
      for (const s of path) {
        if (s.p[1] > CATCH_H) continue;
        const d = dist2(f.pos, [s.p[0], s.p[2]]) - REACH * 0.8;
        const need = Math.max(0, f.react - t) + travelTime(d, f.vmax, f.acc);
        if (need <= s.t) { best = { t: s.t, pt: [s.p[0], s.p[2]], air: s.p[1] > 0.3 && !s.ground && !ball.grounded }; break; }
      }
      if (!best) {
        const last = path[path.length - 1];
        const d = dist2(f.pos, [last.p[0], last.p[2]]) - REACH * 0.8;
        best = { t: Math.max(last.t, Math.max(0, f.react - t) + travelTime(d, f.vmax, f.acc)), pt: [last.p[0], last.p[2]], air: false };
      }
      out.set(f.id, best);
    }
    return { path, map: out };
  }

  function chaser() {
    if (!intercepts) return null;
    if (throwInfo && throwInfo.receiver && t < throwInfo.eta + 0.35 && !ball.atRest) return throwInfo.receiver;
    let best = null, bt = Infinity;
    for (const f of F) {
      const ic = intercepts.map.get(f.id);
      if (!ic) continue;
      if (ic.t < bt) { bt = ic.t; best = f; }
    }
    return best;
  }

  // Defense's estimated time to put the ball on base b (for runner decisions)
  function defenseTimeTo(b) {
    const tgt = b === 4 ? [0, FIELD.zoneZ] : basePos(b);
    if (holder) {
      return Math.max(0, holder.busy) + 0.12 + throwFlight(dist2(holder.pos, tgt), 17 + 13 * holder.arm);
    }
    if (throwInfo && throwInfo.receiver) {
      const rc = throwInfo.receiver;
      const tArr = Math.max(0, throwInfo.eta - t);
      return tArr + 0.35 + throwFlight(dist2(rc.pos, tgt), 17 + 13 * rc.arm);
    }
    if (intercepts) {
      const c = chaser();
      if (c) {
        const ic = intercepts.map.get(c.id);
        return Math.max(0, ic.t - (t - intercepts.t0)) + 0.4 + throwFlight(dist2(ic.pt, tgt), 17 + 13 * c.arm);
      }
    }
    return 3;
  }

  function runnerTimeTo(r, dist) {
    return travelTime(dist, r.vmax, r.acc) - Math.min(r.v, r.vmax) / r.acc * 0.5;
  }

  function baseOccupiedAhead(r, b) {
    return R.some((o) => o !== r && o.state !== 'out' && o.state !== 'scored' && o.seg === b && o.d === 0 && o.goal === b);
  }

  function shouldAdvance(r) {
    const nb = r.seg + 1;
    if (nb > 4) return false;
    if (r.forceTo !== null && r.forceTo > r.seg) return true;
    if (nb <= 3 && baseOccupiedAhead(r, nb)) return false;
    const tMe = runnerTimeTo(r, segLen(r.seg) - r.d);
    const tDef = defenseTimeTo(nb);
    const sp = r.player.field.speed / 100;
    let margin = 0.6 - 0.25 * sp;
    if (nb === 3) margin += 0.3;
    if (nb === 4) margin += 0.2;
    if (outs === 2) margin -= 0.12;
    if (fairState === 'pending' && !res.landing && ball.p[1] > 0.3 && !twoOuts) return false;
    return tMe + margin < tDef;
  }

  // -------- Throws --------
  function doThrow(f, kind, target3, opts = {}) {
    const hurry = opts.hurry || 0;
    const v = (17 + 13 * f.arm) * rng.normal(1, 0.03) * (opts.soft ? 0.75 : 1);
    const from = [f.pos[0], 1.7, f.pos[1]];
    const sol = solveThrow(from, target3, v);
    const errDeg = (0.6 + 4.2 * (1 - f.accu)) * (1 + 0.6 * hurry);
    const yaw = rng.normal(0, errDeg) * Math.PI / 180;
    const pit = rng.normal(0, errDeg * 0.7) * Math.PI / 180;
    let [vx, vy, vz] = sol.v;
    const c = Math.cos(yaw), s = Math.sin(yaw);
    [vx, vz] = [vx * c - vz * s, vx * s + vz * c];
    const h = Math.hypot(vx, vz);
    const el = Math.atan2(vy, h) + pit;
    const sp = Math.hypot(vx, vy, vz);
    const hd = [vx / h, vz / h];
    ball.p = [...from];
    ball.v = [hd[0] * sp * Math.cos(el), sp * Math.sin(el), hd[1] * sp * Math.cos(el)];
    ball.rolling = false; ball.atRest = false; ball.flutter = null; ball.grounded = false; ball.accel = null;
    holder.anim = 2; holder.animT = 0.3;
    f.cooldown = 0.45;
    holder = null;
    batted = false;
    const D = Math.hypot(target3[0] - from[0], target3[2] - from[2]);
    throwInfo = { from: f, kind, target: target3, receiver: opts.receiver || null, runner: opts.runner || null, t0: t, eta: t + throwFlight(D, v) };
    res.throws++;
    ev('throw', { by: f.id, kind, to: opts.receiver ? opts.receiver.id : null, runner: opts.runner ? opts.runner.id : null });
    intercepts = null; nextIntercept = t;
  }

  function holderDecide(f) {
    const live = liveRunners();
    const throwV = 17 + 13 * f.arm;
    let best = null;
    const consider = (p, value, act) => { if (p * value > (best ? best.score : 0)) best = { score: p * value, p, act }; };
    for (const r of live) {
      const moving = !(r.d === 0 && r.goal === r.seg) || (r.isBatter && r.seg === 0);
      if (!moving && r.forceTo === null) continue;
      if (r.state === 'base' && r.d === 0 && r.goal === r.seg && r.startDelay <= 0) continue;
      const goal = Math.max(r.goal, r.seg);
      const remaining = r.goal > r.seg ? segLen(r.seg) - r.d : r.d;
      const tr = runnerTimeTo(r, remaining) + Math.max(0, r.startDelay);
      const lead = goal === 4 ? 1.5 : 1;
      const rp = runnerXZ(r);
      // Force out at the base
      if (r.forceTo !== null && r.goal > r.seg && goal === r.forceTo && goal <= 3) {
        const bp = basePos(goal);
        const tRun = travelTime(dist2(f.pos, bp) - 0.4, f.vmax, f.acc);
        consider(sigmoid((tr - tRun - 0.1) / 0.18) * 0.97, lead, { type: 'runBase', base: goal, runner: r });
        for (const c of F) {
          if (c === f) continue;
          const tc = travelTime(dist2(c.pos, bp) - 0.3, c.vmax, c.acc);
          const tt = Math.max(throwFlight(dist2(f.pos, bp), throwV), tc) + 0.15;
          const pAcc = clamp(1.02 - dist2(f.pos, bp) / (40 + 45 * f.accu), 0.4, 0.97) * (0.9 + 0.08 * c.fld);
          consider(sigmoid((tr - tt) / 0.22) * pAcc, lead, { type: 'throwBase', base: goal, runner: r, receiver: c });
        }
      }
      // Throw home at the zone/backstop
      if (goal === 4 && r.goal === 4) {
        const dHome = dist2(f.pos, [0, FIELD.zoneZ]);
        const tt = throwFlight(dHome, throwV);
        const pAcc = clamp(1.05 - dHome / (55 + 40 * f.accu), 0.35, 0.97);
        consider(sigmoid((tr - tt) / 0.22) * pAcc, 1.6, { type: 'home', runner: r });
      }
      // Peg the runner
      if (r.d > 0.6 || (r.isBatter && r.seg === 0)) {
        const dR = dist2(f.pos, rp);
        const tt = throwFlight(dR, throwV);
        if (dR < 26) {
          const pHit = clamp(1.0 - dR / (14 + 16 * f.accu), 0.05, 0.9) * (1 - 0.15 * r.player.field.speed / 100);
          consider(sigmoid((tr - tt - 0.05) / 0.18) * pHit, lead, { type: 'peg', runner: r });
        }
        // Tag by running at him
        if (dR < 5) {
          const tTag = travelTime(dR - 0.5, f.vmax, f.acc);
          consider(sigmoid((tr - tTag) / 0.15) * 0.92, lead, { type: 'tag', runner: r });
        }
      }
    }
    if (best && best.p > 0.28) return best.act;
    // No good play: get the ball back toward the infield to freeze runners
    const anyMoving = live.some((r) => r.goal !== r.seg || r.d > 0);
    if (anyMoving && pitcherF && f !== pitcherF && dist2(f.pos, pitcherF.pos) > 9) return { type: 'relay', receiver: pitcherF };
    return { type: 'hold' };
  }

  function executeHolder(f) {
    const act = holderDecide(f);
    f.plan = act;
    switch (act.type) {
      case 'runBase': f.target = basePos(act.base); f.task = 'runBase'; break;
      case 'tag': f.target = runnerXZ(act.runner); f.task = 'tag'; f.tagRunner = act.runner; break;
      case 'throwBase': {
        const bp = basePos(act.base);
        act.receiver.task = 'receive'; act.receiver.target = bp;
        doThrow(f, 'base', [bp[0], 1.2, bp[1]], { receiver: act.receiver, runner: act.runner, hurry: 0.4 });
        break;
      }
      case 'home':
        doThrow(f, 'home', ZONE_TARGET, { runner: act.runner, hurry: 0.4 });
        break;
      case 'peg': {
        const r = act.runner;
        const rp = runnerXZ(r);
        const dR = dist2(f.pos, rp);
        const tt = throwFlight(dR, 17 + 13 * f.arm);
        // lead the runner along his path
        const dir = r.goal > r.seg ? 1 : -1;
        const futureD = clamp(r.d + dir * Math.min(r.vmax, r.v + 2) * tt, 0, segLen(r.seg));
        const tmp = { ...r, d: futureD };
        const fp = runnerXZ(tmp);
        doThrow(f, 'peg', [fp[0], 1.05, fp[1]], { runner: r, hurry: 0.6 });
        res.pegs++;
        break;
      }
      case 'relay':
        act.receiver.task = 'receive'; act.receiver.target = [...act.receiver.pos];
        doThrow(f, 'relay', [act.receiver.pos[0], 1.3, act.receiver.pos[1]], { receiver: act.receiver, soft: true });
        break;
      default:
        f.task = 'hold';
        f.target = dist2(f.pos, [0, FIELD.moundZ]) > 8 ? [f.pos[0] * 0.8, f.pos[1] * 0.85] : null;
    }
  }

  function catchProb(f, inAir) {
    const bsp = Math.hypot(...ball.v);
    const hd = dist2(f.pos, [ball.p[0], ball.p[2]]);
    const reachFrac = hd / REACH;
    const runFrac = Math.hypot(...f.vel) / f.vmax;
    let p = 0.84 + 0.14 * f.fld - 0.22 * reachFrac * reachFrac - 0.012 * Math.max(0, bsp - 11) - 0.07 * runFrac;
    if (!inAir && !ball.rolling) p -= 0.06; // short hop / bouncing
    if (ball.p[1] > 2.0) p -= 0.15;         // leaping
    if (throwInfo) p += 0.06;
    return clamp(p, 0.2, 0.995);
  }

  function attemptCatch(f) {
    const inAir = !ball.grounded && !ball.rolling;
    const p = catchProb(f, inAir);
    if (rng.chance(p)) {
      holder = f;
      f.anim = 3; f.animT = 0.25;
      f.task = 'hold'; f.plan = null; f.nextDecide = undefined; f.target = null;
      const wasBatted = batted;
      const wasAir = !groundedEver && batted;
      if (!res.firstTouch) { res.firstTouch = f.id; res.fieldedAt = [ball.p[0], ball.p[2]]; }
      if (wasBatted && fairState === 'pending') resolveFair(ball.p[0], ball.p[2], true);
      ball.v = [0, 0, 0];
      if (throwInfo && throwInfo.receiver !== f && throwInfo.kind !== 'relay') ev('cutoff', { by: f.id });
      throwInfo = null;
      f.busy = 0.38 - 0.18 * f.fld + (wasAir ? 0.05 : 0);
      if (wasBatted && wasAir) {
        // caught on the fly: batter out even if foul
        res.caughtFly = true;
        recordOut(batterR, 'fly', [f.id], null);
        if (fairState === 'foul') { res.foul = false; }
        // runners must return (tag up)
        for (const r of liveRunners()) {
          r.forceTo = null; r.waitFly = false;
          if (r.d > 0 || r.goal !== r.seg) { r.goal = r.seg; r.v = 0; }
        }
        ev('catch', { by: f.id, fly: true });
      } else {
        ev('catch', { by: f.id });
      }
      if (fairState === 'foul' && !res.caughtFly) { deadFoul(); return; }
      batted = false;
      if (outs >= 3) finished = true;
    } else {
      // bobble / deflection
      f.cooldown = 0.55;
      f.anim = 3; f.animT = 0.3;
      const sp = Math.hypot(...ball.v) * rng.range(0.15, 0.4);
      const ang = rng.range(0, Math.PI * 2);
      ball.v = [Math.cos(ang) * sp, Math.abs(ball.v[1]) * 0.2 + 0.5, Math.sin(ang) * sp];
      ball.rolling = false; ball.grounded = true; ball.flutter = null;
      groundedEver = true;
      if (!res.firstTouch) { res.firstTouch = f.id; res.fieldedAt = [ball.p[0], ball.p[2]]; }
      if (batted && fairState === 'pending') resolveFair(ball.p[0], ball.p[2], true);
      if (fairState === 'foul') { deadFoul(); return; }
      const easy = p > 0.85;
      if (easy) { res.error = true; ev('error', { by: f.id }); }
      else ev('bobble', { by: f.id });
      batted = false;
      throwInfo = null;
      intercepts = null; nextIntercept = t;
    }
  }

  function assignCover(ch) {
    // Which bases need covering? Bases a live runner is heading to (forced first)
    const needs = [];
    for (const r of liveRunners()) {
      const g = r.goal > r.seg ? r.seg + 1 : (r.isBatter && r.seg === 0 ? 1 : null);
      if (g && g <= 3 && !needs.includes(g)) needs.push(g);
    }
    if (!needs.includes(1) && batterR.state !== 'out' && batterR.seg === 0) needs.unshift(1);
    const free = F.filter((f) => f !== ch && f !== holder && f.task !== 'receive');
    for (const b of needs.sort((a, b2) => a - b2)) {
      if (!free.length) break;
      const bp = basePos(b);
      free.sort((a, c) => dist2(a.pos, bp) - dist2(c.pos, bp));
      const f = free.shift();
      f.task = 'cover'; f.target = [bp[0] - Math.sign(bp[0]) * 0.4, bp[1] - 0.3]; f.coverBase = b;
    }
    for (const f of free) { f.task = 'idle'; f.target = f.home; }
  }

  function moveFielder(f, dt) {
    let tgt = f.target;
    if (f.task === 'tag' && f.tagRunner) tgt = runnerXZ(f.tagRunner);
    if (f.busy > 0 && holder === f) tgt = null;
    if (t < f.react && !throwInfo) tgt = null;
    let desired = [0, 0];
    if (tgt) {
      const dx = tgt[0] - f.pos[0], dz = tgt[1] - f.pos[1];
      const d = Math.hypot(dx, dz);
      if (d > 0.05) {
        const sp = Math.min(f.vmax, Math.sqrt(2 * f.acc * d) + 0.2);
        desired = [dx / d * sp, dz / d * sp];
      }
    }
    const ax = desired[0] - f.vel[0], az = desired[1] - f.vel[1];
    const al = Math.hypot(ax, az);
    const maxDv = f.acc * dt;
    if (al > maxDv) { f.vel[0] += ax / al * maxDv; f.vel[1] += az / al * maxDv; }
    else { f.vel[0] = desired[0]; f.vel[1] = desired[1]; }
    f.pos[0] += f.vel[0] * dt; f.pos[1] += f.vel[1] * dt;
    if (f.animT > 0) { f.animT -= dt; if (f.animT <= 0) f.anim = 0; }
    if (f.anim === 0 || f.anim === 1) f.anim = Math.hypot(...f.vel) > 0.6 ? 1 : 0;
    if (holder === f && f.anim < 2) f.anim = Math.hypot(...f.vel) > 0.6 ? 1 : 4;
  }

  function moveRunner(r, dt) {
    if (r.state === 'out' || r.state === 'scored') return;
    if (r.startDelay > 0) { r.startDelay -= dt; return; }
    if (r.waitFly) {
      // hold on base until the ball lands or is caught
      if (groundedEver || !batted) { r.waitFly = false; if (r.forceTo !== null || shouldAdvance(r)) r.goal = r.seg + 1; }
      else return;
    }
    if (r.goal === r.seg && r.d === 0) { r.v = 0; return; }
    const forward = r.goal > r.seg;
    const L = segLen(r.seg);
    r.v = Math.min(r.vmax, r.v + r.acc * dt);
    if (forward) {
      r.d += r.v * dt;
      if (r.d >= L) {
        r.seg++; r.d = 0;
        if (r.forceTo !== null && r.seg >= r.forceTo) r.forceTo = null;
        if (r.seg === 4) {
          r.state = 'scored'; r.scoredAt = t; res.runs.push({ id: r.id, t });
          ev('score', { id: r.id });
          return;
        }
        ev('touch', { id: r.id, base: r.seg });
        if (shouldAdvance(r)) { r.goal = r.seg + 1; r.v *= 0.72; }
        else { r.goal = r.seg; r.v = 0; }
      }
    } else {
      r.d -= r.v * dt;
      if (r.d <= 0) { r.d = 0; r.v = 0; r.goal = r.seg; }
    }
  }

  function runnerDecide(r) {
    if (r.state === 'out' || r.state === 'scored' || r.startDelay > 0 || r.waitFly) return;
    const standing = r.d === 0 && r.goal === r.seg;
    if (standing) {
      if (r.seg < 4 && (holder || throwInfo || intercepts) && shouldAdvance(r)) { r.goal = r.seg + 1; }
      return;
    }
    // mid-path: commit or retreat?
    const forward = r.goal > r.seg;
    const L = segLen(r.seg);
    const nb = r.seg + 1;
    const tF = runnerTimeTo(r, L - r.d);
    const tB = travelTime(r.d, r.vmax, r.acc) + 0.15;
    const dF = defenseTimeTo(nb), dB = defenseTimeTo(r.seg);
    const forced = r.forceTo !== null;
    const occAhead = nb <= 3 && baseOccupiedAhead(r, nb);
    if (forward) {
      if (!forced && (occAhead || (tF + 0.05 > dF && tB < dB - 0.05 && tB < tF))) { r.goal = r.seg; r.v = 0; }
    } else if (!occAhead && tF + 0.25 < dF && (tB > dB || tF < tB * 0.6)) { r.goal = nb; r.v = 0; }
    else if (forced) { r.goal = nb; r.v = 0; }
  }

  function checkThrowHits() {
    if (!throwInfo) return;
    // Pegging: any thrown ball hitting a runner who is off base
    for (const r of liveRunners()) {
      if (r.d < 0.3 && !(r.isBatter && r.seg === 0 && r.startDelay <= 0)) continue;
      if (r.d === 0) continue;
      const rp = runnerXZ(r);
      const hd = Math.hypot(ball.p[0] - rp[0], ball.p[2] - rp[1]);
      if (hd < BODY_R + BALL.radius && ball.p[1] > 0.1 && ball.p[1] < 1.85) {
        const by = throwInfo.from.id;
        recordOut(r, 'peg', [by], null);
        ev('peg', { id: r.id, by });
        // ball deflects off the runner and stays live
        ball.v = [ball.v[0] * -0.2 + rng.normal(0, 1.2), Math.abs(ball.v[1]) * 0.2 + 1, ball.v[2] * -0.2 + rng.normal(0, 1.2)];
        throwInfo = null; intercepts = null; nextIntercept = t;
        return;
      }
    }
  }

  function checkHomeThrow(events) {
    if (!throwInfo) return;
    for (const e of events) {
      if ((e.type === 'zoneCross' && e.inZone) || e.type === 'backstop') {
        const runnerHome = liveRunners().filter((r) => r.goal === 4 && r.seg === 3 && r.d > 0).sort((a, b) => b.d - a.d)[0];
        const by = throwInfo.from.id;
        if (runnerHome) { recordOut(runnerHome, 'home', [by], 4); ev('homeOut', { id: runnerHome.id, by, via: e.type }); }
        throwInfo = null; intercepts = null; nextIntercept = t;
        return;
      }
    }
  }

  function checkForceAndTags() {
    if (!holder || holder.busy > 0.2) return;
    const f = holder;
    for (const r of liveRunners()) {
      // force: holder touching base
      if (r.forceTo !== null && r.forceTo <= 3 && !(r.seg >= r.forceTo)) {
        const bp = basePos(r.forceTo);
        if (dist2(f.pos, bp) < 0.55) { recordOut(r, 'force', [f.id], r.forceTo); continue; }
      }
      if (r.d > 0.25 && r.d < segLen(r.seg) - 0.15) {
        const rp = runnerXZ(r);
        if (dist2(f.pos, rp) < 0.6) recordOut(r, 'tag', [f.id], null);
      }
    }
  }

  // Initial runner behavior
  for (const r of R) {
    if (r.isBatter) continue;
    const airball = res.ballType !== 'GB';
    if (airball && !twoOuts) { r.waitFly = true; }
    else if (r.forceTo !== null || twoOuts) { r.goal = r.seg + 1; r.startDelay = 0.05; }
  }

  function snapshot() {
    if (!record) return;
    res.frames.push({
      t,
      b: [ball.p[0], ball.p[1], ball.p[2]],
      h: holder ? holder.id : null,
      f: F.map((f) => [f.id, f.pos[0], f.pos[1], f.anim]),
      r: R.filter((r) => r.state !== 'out' || (res.outs.find((o) => o.id === r.id)?.t ?? 0) > t - 0.6).map((r) => {
        const p = runnerXZ(r);
        return [r.id, p[0], p[1], r.state === 'scored' ? 5 : r.state === 'out' ? 6 : (r.goal === r.seg && r.d === 0 ? 0 : 1)];
      }),
    });
  }

  // =================== main loop ===================
  let step = 0;
  while (!finished && t < 30) {
    // ball
    if (holder) {
      ball.p = [holder.pos[0], 1.25, holder.pos[1]];
      ball.v = [0, 0, 0];
    } else {
      const evs = stepBall(ball, DT, rng);
      for (const e of evs) {
        if (e.type === 'bounce') {
          if (!groundedEver && batted) { res.landing = [e.p[0], e.p[2]]; }
          groundedEver = true;
          intercepts = null; nextIntercept = t;
          if (batted && fairState === 'pending') {
            const proj = foulLineProjection(e.p[0], e.p[2]);
            if (e.p[2] < -0.3) { fairState = 'foul'; }
            else if (proj >= segLen(0) && e.first) resolveFair(e.p[0], e.p[2], false);
          }
        } else if (e.type === 'fence') {
          intercepts = null; nextIntercept = t;
          if (batted && fairState === 'pending') resolveFair(e.p[0], e.p[2], false);
          ev('fence');
        } else if (e.type === 'overFence') {
          if (batted || fairState === 'fair' || fairState === 'pending') {
            if (!groundedEver && batted) { res.hr = true; ev('hr'); }
            else { res.grd = true; ev('grd'); }
            res.deadBall = true; finished = true;
          } else { res.grd = true; res.deadBall = true; finished = true; } // overthrow out of play
        } else if (e.type === 'backstop') {
          if (batted) { fairState = 'foul'; }
        } else if (e.type === 'zoneCross') {
          if (batted && !groundedEver && e.inZone && ctx.contact.v[2] < 0) res.foulTipZone = true;
        } else if (e.type === 'rest') {
          intercepts = null; nextIntercept = t;
        }
      }
      if (throwInfo) { checkHomeThrow(evs); checkThrowHits(); }
      if (finished) break;
      // fair/foul resolution by passing a base or settling
      if (batted && fairState === 'pending') {
        const proj = foulLineProjection(ball.p[0], ball.p[2]);
        if (ball.p[2] < BEHIND) fairState = 'foul';
        else if (groundedEver && proj >= segLen(0)) resolveFair(ball.p[0], ball.p[2], false);
        else if (ball.atRest) resolveFair(ball.p[0], ball.p[2], false);
      }
      if (fairState === 'foul' && batted && (groundedEver || ball.p[2] < BEHIND)) {
        // foul: dead unless it can still be caught in the air (not possible once grounded)
        deadFoul();
        break;
      }
      if (batted && fairState === 'foul' && ball.p[2] < FIELD.backstopZ) { deadFoul(); break; }
      // a foul pop that is uncatchable becomes dead on landing (handled above)
    }

    // a throw that got past its target becomes a loose ball
    if (throwInfo && !holder && (ball.atRest || t > throwInfo.eta + 0.6)) { throwInfo = null; intercepts = null; }
    // intercepts
    if (!holder && (intercepts === null || t >= nextIntercept)) {
      if (!throwInfo) for (const f of F) if (f.task === 'receive') { f.task = 'idle'; f.target = f.home; }
      intercepts = computeIntercepts(); intercepts.t0 = t; nextIntercept = t + 0.25;
      const ch = chaser();
      if (ch) {
        if (!(throwInfo && throwInfo.receiver === ch)) { ch.task = 'chase'; ch.target = intercepts.map.get(ch.id).pt; }
        assignCover(ch);
      }
      // runners waiting on a fly: if nobody can catch it in the air, it's a hit — go
      if (batted && !groundedEver && ch) {
        const ic = intercepts.map.get(ch.id);
        if (!ic.air) for (const r of R) if (r.waitFly && (r.forceTo !== null)) { r.waitFly = false; r.goal = r.seg + 1; }
      }
    }

    // catches
    if (!holder && !ball.dead) {
      for (const f of F) {
        if (f.cooldown > 0 || t < f.react * 0.6) continue;
        const hd = dist2(f.pos, [ball.p[0], ball.p[2]]);
        if (hd <= REACH && ball.p[1] <= CATCH_H && (ball.p[1] <= 1.2 || hd < REACH * 0.9)) {
          attemptCatch(f);
          if (holder || finished) break;
        }
      }
      if (finished) break;
    }

    // holder actions
    if (holder) {
      holder.busy -= DT;
      checkForceAndTags();
      if (finished) break;
      if (holder && holder.busy <= 0 && (!holder.plan || holder.nextDecide === undefined || t >= holder.nextDecide)) {
        holder.nextDecide = t + 0.15;
        const prevPlan = holder.plan;
        if (!prevPlan || prevPlan.type === 'hold' || prevPlan.type === 'runBase' || prevPlan.type === 'tag') executeHolder(holder);
      }
      if (holder) for (const f of F) if (f !== holder && f.task === 'chase') { f.task = 'idle'; f.target = f.home; }
    }

    for (const f of F) { if (f.cooldown > 0) f.cooldown -= DT; moveFielder(f, DT); }
    if (step % 6 === 0) for (const r of R) runnerDecide(r);
    for (const r of R) moveRunner(r, DT);

    if (holder) {
      const allSafe = liveRunners().every((r) => r.d === 0 && r.goal === r.seg && r.startDelay <= 0 && !(r.isBatter && r.seg === 0));
      if (allSafe) { endTimer += DT; if (endTimer > 0.5) finished = true; }
      else endTimer = 0;
    }
    if (step % REC_EVERY === 0) snapshot();
    t += DT; step++;
  }
  snapshot();

  // Stalemate safety: runners still between bases go to the nearer base
  for (const r of liveRunners()) {
    if (r.d > 0) { if (r.d > segLen(r.seg) / 2 && r.forceTo === null) { r.seg++; } r.d = 0; }
    if (r.seg === 4 && r.state !== 'scored') { r.state = 'scored'; res.runs.push({ id: r.id, t }); }
    if (r.isBatter && r.seg === 0 && r.state !== 'out' && !res.deadBall) { r.seg = 1; }
  }

  if (res.hr || res.grd) {
    // award bases from time-of-pitch positions
    const adv = res.hr ? 4 : 2;
    res.runs = res.runs.filter(() => false);
    const all = R.map((r) => ({ r, start: r.isBatter ? 0 : ctx.runners.find((x) => x.player.id === r.id).base }));
    res.endBases = [null, null, null, null];
    for (const { r, start } of all) {
      if (r.state === 'out' && !r.isBatter) continue;
      const nb = start + adv;
      if (r.isBatter && r.state === 'out') continue;
      if (nb >= 4) res.runs.push({ id: r.id, t });
      else res.endBases[nb] = r.id;
    }
    res.batterReached = res.hr ? 4 : 2;
    res.outs = res.outs.filter((o) => !o.isBatter);
    return finalize();
  }

  if (res.foul) {
    // dead ball: nothing counts except a caught foul (handled as out)
    res.runs = []; res.outs = res.outs.filter((o) => o.how === 'fly');
    return finalize();
  }

  res.endBases = [null, null, null, null];
  for (const r of R) if (r.state !== 'out' && r.state !== 'scored' && r.seg >= 1 && r.seg <= 3) res.endBases[r.seg] = r.id;
  res.batterReached = batterR.state === 'scored' ? 4 : batterR.state === 'out' ? 0 : batterR.seg;
  return finalize();

  function finalize() {
    res.duration = t;
    res.fairState = fairState;
    return res;
  }
}

export { DT as PLAY_DT, inStrikeZone };
