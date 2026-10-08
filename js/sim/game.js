// Game state machine: counts, outs, innings, the speed-limit rule, familiarity, fatigue,
// manager AI (pitching changes), stats and play-by-play.
import { FIELD, FT, RULES, toFt } from '../config.js';
import { RNG, clamp } from '../util/rng.js';
import { choosePitch, buildPitch, fatigueLevel, speedRuling, familiarityFrac, PITCH_TYPES } from './pitching.js';
import { batterAction } from './batting.js';
import { simulatePlay } from './play.js';
import { pitchingOverall } from '../data/players.js';

const ROLE_NAMES = { P: 'P', '1B': '1B', SS: 'SS', OF: 'OF' };
const BASE_NAMES = ['home', '1st', '2nd', '3rd', 'home'];

export function emptyBatting() { return { G: 0, PA: 0, AB: 0, H: 0, '1B': 0, '2B': 0, '3B': 0, HR: 0, R: 0, RBI: 0, BB: 0, K: 0, SF: 0, ROE: 0, FC: 0 }; }
export function emptyPitching() { return { G: 0, outs: 0, BF: 0, H: 0, R: 0, BB: 0, K: 0, HR: 0, P: 0, maxVelo: 0, warn: 0, auto: 0, W: 0, L: 0 }; }
export function emptyFielding() { return { PO: 0, A: 0, E: 0, PEG: 0 }; }

function dirName(x, z) {
  const a = Math.atan2(x, z) * 180 / Math.PI;
  if (a < -27) return 'left'; if (a < -9) return 'left-center'; if (a <= 9) return 'center'; if (a <= 27) return 'right-center'; return 'right';
}

const short = (p) => { const parts = p.name.split(' '); return parts.length > 1 ? `${parts[0][0]}. ${parts.slice(1).join(' ')}` : p.name; };

export class Game {
  /**
   * opts: { away, home, seed, innings, record }
   * away/home: { id, name, abbr, color, players[4] }
   */
  constructor(opts) {
    this.rng = new RNG(opts.seed ?? Math.floor(Math.random() * 1e9));
    this.seed = this.rng.seed;
    this.innings = opts.innings || RULES.innings;
    this.teams = [opts.away, opts.home].map((t, i) => this._initTeam(t, i));
    this.inning = 1; this.half = 0; // 0 = top (away bats)
    this.outs = 0; this.balls = 0; this.strikes = 0;
    this.bases = [null, null, null, null];
    this.score = [0, 0];
    this.line = [[], []];
    this.hits = [0, 0]; this.errors = [0, 0];
    this.warningUsed = false;
    this.pitchCount = {};
    this.fam = {};               // fam[batterId][pitcherId][type] = pitches seen
    this.over = false;
    this.log = [];
    this.paStart = true;
    this.changedThisHalf = [false, false];
    this.decisions = { W: null, L: null };
    this.leadChange = { team: null, pitcher: [null, null] };
    this.pitchLog = [];          // current at-bat pitch locations for the zone inset
    this.manager = opts.manager || ['ai', 'ai'];
    this._startHalf();
  }

  _initTeam(t, idx) {
    const players = t.players.slice(0, RULES.playersPerSide);
    // Default defensive roles: best pitcher pitches, best glove at SS, best arm/speed in OF
    const byPitch = [...players].sort((a, b) => pitchingOverall(b) - pitchingOverall(a));
    const roles = {};
    const used = new Set();
    const take = (role, p) => { roles[role] = p.id; used.add(p.id); };
    take('P', byPitch[0]);
    const rest = () => players.filter((p) => !used.has(p.id));
    take('SS', rest().sort((a, b) => (b.field.fielding + b.field.arm) - (a.field.fielding + a.field.arm))[0]);
    take('OF', rest().sort((a, b) => (b.field.speed + b.field.arm) - (a.field.speed + a.field.arm))[0]);
    take('1B', rest()[0]);
    const stats = {};
    for (const p of players) stats[p.id] = { bat: emptyBatting(), pit: emptyPitching(), fld: emptyFielding() };
    for (const p of players) stats[p.id].bat.G = 1;
    stats[roles.P].pit.G = 1;
    return { def: t, idx, players, byId: Object.fromEntries(players.map((p) => [p.id, p])), roles, order: players.map((p) => p.id), next: 0, stats, pitchersUsed: [roles.P] };
  }

  get battingTeam() { return this.teams[this.half]; }
  get fieldingTeam() { return this.teams[1 - this.half]; }
  player(id) { return this.teams[0].byId[id] || this.teams[1].byId[id]; }
  teamOf(id) { return this.teams[0].byId[id] ? this.teams[0] : this.teams[1]; }
  currentBatter() { const t = this.battingTeam; return t.byId[t.order[t.next % t.order.length]]; }
  currentPitcher() { const t = this.fieldingTeam; return t.byId[t.roles.P]; }
  famCount(bId, pId, type) { return this.fam[bId]?.[pId]?.[type] || 0; }
  famTable(bId, pId) { return this.fam[bId]?.[pId] || {}; }

  _startHalf() {
    this.outs = 0; this.balls = 0; this.strikes = 0;
    this.bases = [null, null, null, null];
    this.warningUsed = false;
    this.changedThisHalf = [false, false];
    this.line[this.half][this.inning - 1] = this.line[this.half][this.inning - 1] || 0;
    this.paStart = true;
    this._log(`— ${this.half === 0 ? 'Top' : 'Bottom'} of inning ${this.inning}: ${this.battingTeam.def.name} batting —`, 'inning');
  }

  _log(text, kind = 'play') { this.log.push({ inning: this.inning, half: this.half, text, kind }); }

  snapshot() {
    return {
      inning: this.inning, half: this.half, outs: this.outs, balls: this.balls, strikes: this.strikes,
      bases: [...this.bases], score: [...this.score], line: this.line.map((l) => [...l]), hits: [...this.hits], errors: [...this.errors],
      batterId: this.over ? null : this.currentBatter().id, pitcherId: this.over ? null : this.currentPitcher().id,
      warningUsed: this.warningUsed, over: this.over,
      roles: [{ ...this.teams[0].roles }, { ...this.teams[1].roles }],
      pitchCount: { ...this.pitchCount },
    };
  }

  /** Defensive alignment for this batter (meters, [x,z]). */
  alignment(batter) {
    const t = this.fieldingTeam;
    const pw = batter.bat.power / 100;
    const pull = batter.bats === 'R' ? -1 : 1; // RHB pulls to the left (-x)
    const ft = (x, z) => [x * FT, z * FT];
    const pos = {
      P: ft(0, toFt(FIELD.moundZ)),
      '1B': ft(25 + (pull > 0 ? 2 : -1), 37),
      SS: ft(-15 + pull * 3, 44 + pw * 3),
      OF: ft(5 + pull * 6 * pw, 52 + 10 * pw),
    };
    return Object.entries(t.roles).map(([role, id]) => ({ role, player: t.byId[id], pos: pos[role] }));
  }

  // ---------------- Manager ----------------
  /** Swap the pitcher with another player on the same team. Returns true if changed. */
  changePitcher(teamIdx, newId, reason = '') {
    const t = this.teams[teamIdx];
    if (t.roles.P === newId || !t.byId[newId]) return false;
    const oldId = t.roles.P;
    const newRole = Object.keys(t.roles).find((r) => t.roles[r] === newId);
    t.roles.P = newId; t.roles[newRole] = oldId;
    if (!t.pitchersUsed.includes(newId)) { t.pitchersUsed.push(newId); t.stats[newId].pit.G = 1; }
    this.changedThisHalf[teamIdx] = true;
    this._log(`Pitching change (${t.def.abbr}): ${short(t.byId[newId])} takes the mound, ${short(t.byId[oldId])} moves to ${newRole}.${reason ? ' ' + reason : ''}`, 'sub');
    return true;
  }

  pitcherScore(team, p) {
    const f = fatigueLevel(p, this.pitchCount[p.id] || 0);
    const opp = this.teams[1 - team.idx];
    let famSum = 0, n = 0;
    for (const bid of opp.order) {
      const table = this.famTable(bid, p.id);
      const tot = p.pitch.arsenal.reduce((a, x) => a + x.level, 0) || 1;
      famSum += p.pitch.arsenal.reduce((a, x) => a + familiarityFrac(table[x.type] || 0) * x.level, 0) / tot; n++;
    }
    const famAvg = famSum / Math.max(1, n);
    return pitchingOverall(p) * (1 - 0.45 * Math.max(0, f - 0.55)) - 22 * famAvg;
  }

  _managerAI() {
    const ti = 1 - this.half;
    if (this.manager[ti] !== 'ai' || this.changedThisHalf[ti]) return;
    const t = this.teams[ti];
    const cur = t.byId[t.roles.P];
    const curScore = this.pitcherScore(t, cur);
    let best = cur, bestScore = curScore;
    for (const p of t.players) {
      if (p === cur) continue;
      const s = this.pitcherScore(t, p);
      if (s > bestScore) { best = p; bestScore = s; }
    }
    if (best !== cur && bestScore - curScore > 7) {
      const f = fatigueLevel(cur, this.pitchCount[cur.id] || 0);
      const reason = f > 0.8 ? `(${short(cur)} is tiring at ${this.pitchCount[cur.id]} pitches)` : '(the lineup has seen a lot of his stuff)';
      this.changePitcher(ti, best.id, reason);
    }
  }

  // ---------------- Core ----------------
  simPitch({ record = false } = {}) {
    if (this.over) return null;
    if (this.paStart) {
      this._managerAI();
      this.paStart = false;
      this.pitchLog = [];
    }
    const before = this.snapshot();
    const bt = this.battingTeam, ft = this.fieldingTeam;
    const batter = this.currentBatter();
    const pitcher = this.currentPitcher();
    const pc = this.pitchCount[pitcher.id] || 0;
    const fatigue = fatigueLevel(pitcher, pc);
    const rng = this.rng;
    const count = { balls: this.balls, strikes: this.strikes };

    const plan = choosePitch({ pitcher, batter, count, famFor: (type) => this.famCount(batter.id, pitcher.id, type), rng, fatigue, warningUsed: this.warningUsed });
    const pitch = buildPitch({ pitcher, ...plan, fatigue, rng });
    let ruling = speedRuling(pitch.radar, this.warningUsed);
    const famN = this.famCount(batter.id, pitcher.id, pitch.typeKey);
    const fbMph = pitcher.pitch.velocity;
    const act = batterAction({ pitch, batter, count, famCount: famN, fbMph, rng });

    // bookkeeping: familiarity, pitch count, velo
    this.fam[batter.id] = this.fam[batter.id] || {};
    this.fam[batter.id][pitcher.id] = this.fam[batter.id][pitcher.id] || {};
    this.fam[batter.id][pitcher.id][pitch.typeKey] = famN + 1;
    this.pitchCount[pitcher.id] = pc + 1;
    const ps = ft.stats[pitcher.id].pit;
    ps.P++; ps.maxVelo = Math.max(ps.maxVelo, pitch.radar);

    const rec = {
      kind: 'pitch', before, batterId: batter.id, pitcherId: pitcher.id,
      battingTeam: this.half, defense: this.alignment(batter).map((d) => ({ id: d.player.id, role: d.role, pos: d.pos })),
      runnersBefore: [1, 2, 3].filter((b) => this.bases[b]).map((b) => ({ id: this.bases[b], base: b })),
      pitch: {
        type: pitch.type, typeKey: pitch.typeKey, abbr: pitch.abbr, radar: pitch.radar, level: pitch.level, ruling,
        cross: act.cross, famBefore: famN, recog: act.recog, breakFt: toFt(pitch.breakMag),
        throws: pitcher.throws, armSlot: pitcher.pitch.armSlot,
      },
      swing: act.swing ? act.swingInfo : null,
      contact: act.contact ? { t: act.contact.t, exit: act.contact.exit, launch: act.contact.launch, spray: act.contact.spray } : null,
      frames: null, play: null, call: null, text: '', logIndex: this.log.length,
    };
    if (record) {
      const fr = [];
      let nextT = 0;
      for (const s of act.path) if (s.t >= nextT) { fr.push({ t: s.t, b: s.p }); nextT += 1 / 120; }
      rec.frames = fr;
    }

    if (ruling === 'warn') { this.warningUsed = true; ps.warn++; this._log(`⚠ Speed warning: ${short(pitcher)} hit ${pitch.radar} mph (one warning per half inning).`, 'warn'); }
    if (ruling === 'auto') { ps.auto++; this._log(`⛔ ${pitch.radar} mph — over the limit, automatic ball.`, 'warn'); }
    const auto = ruling === 'auto';
    const zoneInfo = { x: act.cross.x, y: act.cross.y, inZone: act.cross.inZone && !act.cross.grounded, type: pitch.abbr };

    let call;
    if (!act.swing) {
      call = auto ? 'ball' : zoneInfo.inZone ? 'strike' : 'ball';
      if (call === 'strike') this.strikes++; else this.balls++;
    } else if (!act.contact) {
      call = auto ? 'ball' : 'swinging';
      if (auto) this.balls++; else this.strikes++;
    } else {
      // ball in play (or foul)
      const play = simulatePlay({
        contact: act.contact, defense: this.alignment(batter).map((d) => ({ ...d, pos: d.role === 'P' ? [pitch.p0[0] * 0.5, FIELD.moundZ - 1.0] : d.pos })),
        runners: [1, 2, 3].filter((b) => this.bases[b]).map((b) => ({ player: this.player(this.bases[b]), base: b })),
        batter, outs: this.outs, rng, record, pitcherId: pitcher.id,
      });
      rec.play = { frames: play.frames, events: play.events, duration: play.duration };
      if (play.foul && !play.caughtFly) {
        if (auto) { call = 'ball'; this.balls++; }
        else if (play.foulTipZone && this.strikes === 2) { call = 'foultipK'; this.strikes = 3; }
        else { call = play.foulTipZone ? 'foultip' : 'foul'; if (this.strikes < 2) this.strikes++; }
      } else {
        call = 'inplay';
        this._applyPlay(play, batter, pitcher, rec);
      }
    }
    this.pitchLog.push({ ...zoneInfo, call });
    rec.call = call;

    if (call !== 'inplay') {
      if (this.balls >= RULES.balls) this._walk(batter, pitcher, rec);
      else if (this.strikes >= RULES.strikes) this._strikeout(batter, pitcher, rec, call);
      else rec.text = this._pitchText(call, pitch);
    }
    rec.zone = zoneInfo;
    rec.after = this.snapshot();
    rec.logEnd = this.log.length;
    return rec;
  }

  _pitchText(call, pitch) {
    const m = { ball: 'Ball', strike: 'Called strike', swinging: 'Swinging strike', foul: 'Foul ball', foultip: 'Foul tip' };
    return `${m[call] || call} — ${pitch.radar} mph ${pitch.type} (${this.balls}-${this.strikes})`;
  }

  _endPA() {
    const t = this.battingTeam;
    t.next = (t.next + 1) % t.order.length;
    this.balls = 0; this.strikes = 0;
    this.paStart = true;
  }

  _walk(batter, pitcher, rec) {
    const bs = this.battingTeam.stats[batter.id].bat, ps = this.fieldingTeam.stats[pitcher.id].pit;
    bs.PA++; bs.BB++; ps.BB++; ps.BF++;
    // forced advances
    const scored = [];
    if (this.bases[1]) {
      if (this.bases[2]) {
        if (this.bases[3]) scored.push(this.bases[3]);
        this.bases[3] = this.bases[2];
      }
      this.bases[2] = this.bases[1];
    }
    this.bases[1] = batter.id;
    let text = `${short(batter)} walks.`;
    for (const id of scored) { this._scoreRun(id, pitcher, batter, true); text += ` ${short(this.player(id))} scores.`; }
    this._log(text);
    rec.text = text;
    this._endPA();
    this._checkWalkoff();
  }

  _strikeout(batter, pitcher, rec, call) {
    const bs = this.battingTeam.stats[batter.id].bat, ps = this.fieldingTeam.stats[pitcher.id].pit;
    bs.PA++; bs.AB++; bs.K++; ps.K++; ps.BF++; ps.outs++;
    const how = call === 'strike' ? 'looking' : call === 'foultipK' ? 'on a foul tip into the zone' : 'swinging';
    const text = `${short(batter)} strikes out ${how}.`;
    this._log(text);
    rec.text = text;
    this.outs++;
    this._endPA();
    this._checkHalfOver();
  }

  _scoreRun(id, pitcher, batter, rbi) {
    const team = this.battingTeam;
    this.score[this.half]++;
    this.line[this.half][this.inning - 1] = (this.line[this.half][this.inning - 1] || 0) + 1;
    team.stats[id].bat.R++;
    if (rbi && batter) team.stats[batter.id].bat.RBI++;
    this.fieldingTeam.stats[pitcher.id].pit.R++;
    this._trackLead(pitcher);
  }

  _trackLead(pitcher) {
    // Track pitchers of record: whoever was pitching when a team took a lead it never gave back.
    const [a, h] = this.score;
    const leader = a > h ? 0 : h > a ? 1 : null;
    if (leader !== null && leader !== this.leadChange.team) {
      this.leadChange.team = leader;
      const winTeam = this.teams[leader], loseTeam = this.teams[1 - leader];
      this.leadChange.pitcher = [winTeam.roles.P, pitcher.id];
      void loseTeam;
    } else if (leader === null) this.leadChange.team = null;
  }

  _applyPlay(play, batter, pitcher, rec) {
    const bt = this.battingTeam, ftm = this.fieldingTeam;
    const bs = bt.stats[batter.id].bat, ps = ftm.stats[pitcher.id].pit;
    bs.PA++; ps.BF++;

    // Which runs count? If the 3rd out is a force or the batter-runner before reaching 1st, none do.
    const outsSorted = [...play.outs].sort((a, b) => a.t - b.t);
    let runsCount = play.runs;
    const need = 3 - this.outs;
    if (outsSorted.length >= need) {
      const third = outsSorted[need - 1];
      const noRuns = third.forced || (third.isBatter && third.seg === 0);
      runsCount = noRuns ? [] : play.runs.filter((r) => r.t < third.t);
      outsSorted.length = need;
    }

    // Outs & fielding credit
    for (const o of outsSorted) {
      this.outs++; ps.outs++;
      for (const fid of o.by || []) {
        const fs = ftm.stats[fid]?.fld; if (!fs) continue;
        if (o.how === 'peg') fs.PEG++;
        fs.PO++;
      }
    }
    if (play.error) { this.errors[1 - this.half]++; const fs = ftm.stats[play.firstTouch]?.fld; if (fs) fs.E++; }

    // Base state
    const newBases = [null, null, null, null];
    if (this.outs < 3) for (let b = 1; b <= 3; b++) if (play.endBases[b]) newBases[b] = play.endBases[b];
    this.bases = newBases;

    // Batter result
    const batterOut = play.outs.some((o) => o.isBatter);
    const runnerOuts = outsSorted.filter((o) => !o.isBatter).length;
    const where = play.landing || play.fieldedAt || [0, 10];
    const dir = dirName(where[0], where[1]);
    const fielder = play.firstTouch ? ftm.byId[play.firstTouch] : null;
    const fRole = fielder ? Object.keys(ftm.roles).find((r) => ftm.roles[r] === fielder.id) : null;
    let text = '';
    const bType = { GB: 'grounds', LD: 'lines', FB: 'flies', PU: 'pops' }[play.ballType];
    const dist = play.landing ? `${Math.round(toFt(Math.hypot(...play.landing)))} ft` : '';
    let isHit = false, bases = 0;
    const sacFly = play.caughtFly && runsCount.length > 0;

    if (play.hr) {
      isHit = true; bases = 4;
      text = `${short(batter)} HOMERS to ${dir}!`;
    } else if (play.grd) {
      isHit = true; bases = 2;
      text = `${short(batter)} hits a ground-rule double to ${dir}.`;
    } else if (play.caughtFly) {
      text = `${short(batter)} ${bType} out to ${fRole || 'the field'}${play.foul ? ' in foul territory' : ''}.`;
    } else if (batterOut) {
      const o = play.outs.find((x) => x.isBatter);
      const by = o.by?.[0] ? Object.keys(ftm.roles).find((r) => ftm.roles[r] === o.by[0]) : fRole;
      if (o.how === 'peg') text = `${short(batter)} ${bType === 'grounds' ? 'grounds to ' + (fRole || 'the field') : 'hits it to ' + dir} and is pegged by the ${by}.`;
      else if (o.how === 'force') text = `${short(batter)} ${bType} out to ${fRole || 'the field'}, ${by} beats him to 1st.`;
      else text = `${short(batter)} is tagged out by the ${by}.`;
    } else if (play.batterReached > 0) {
      bases = play.batterReached;
      if (play.error) { bs.ROE++; text = `${short(batter)} reaches on an error by the ${fRole}.`; }
      else if (runnerOuts > 0 && bases === 1) { bs.FC++; text = `${short(batter)} reaches on a fielder's choice.`; }
      else {
        isHit = true;
        const name = ['', 'singles', 'doubles', 'triples', 'circles the bases'][Math.min(bases, 4)];
        text = `${short(batter)} ${name} to ${dir}${play.ballType === 'GB' ? ' on the ground' : ''}${bases === 4 ? ' — inside-the-park home run!' : '.'}`;
      }
    } else {
      text = `${short(batter)} puts it in play.`;
    }
    if (dist && (play.hr || play.ballType === 'FB' || play.ballType === 'LD') && !play.caughtFly) text += ` (${play.hr ? 'est. ' : ''}${dist})`;

    // runner outs text
    for (const o of outsSorted) {
      if (o.isBatter) continue;
      const p = this.player(o.id);
      const by = o.by?.[0] ? Object.keys(ftm.roles).find((r) => ftm.roles[r] === o.by[0]) : '';
      const how = { force: `forced out at ${BASE_NAMES[o.base]}`, peg: `pegged by the ${by}`, tag: `tagged out by the ${by}`, home: 'out at home — the throw hit the zone/backstop', fly: 'doubled off' }[o.how] || 'out';
      text += ` ${short(p)} ${how}.`;
    }

    if (sacFly) { bs.SF++; } else if (!play.error || true) { bs.AB++; }
    if (isHit) {
      bs.H++; ps.H++; this.hits[this.half]++;
      if (bases >= 4) { bs.HR++; ps.HR++; } else if (bases === 3) bs['3B']++; else if (bases === 2) bs['2B']++; else bs['1B']++;
    }
    for (const r of runsCount) {
      this._scoreRun(r.id, pitcher, batter, !play.error);
      if (r.id !== batter.id) text += ` ${short(this.player(r.id))} scores.`;
    }
    if (outsSorted.length === 2 && !play.caughtFly) text += ' Double play!';
    if (outsSorted.length === 3) text += ' Triple play!!';
    if (play.pegs > 0 && !text.includes('pegged')) text += '';
    this._log(text, play.hr ? 'hr' : 'play');
    rec.text = text;
    this._endPA();
    if (this.outs >= 3) this._checkHalfOver(); else this._checkWalkoff();
  }

  _checkWalkoff() {
    if (this.half === 1 && this.inning >= this.innings && this.score[1] > this.score[0]) this._endGame(true);
  }

  _checkHalfOver() {
    this._checkWalkoff();
    if (this.over || this.outs < 3) return;
    // end of half inning
    if (this.half === 0) {
      if (this.inning >= this.innings && this.score[1] > this.score[0]) { this._endGame(false); return; }
      this.half = 1;
    } else {
      if (this.inning >= this.innings && this.score[0] !== this.score[1]) { this._endGame(false); return; }
      this.half = 0; this.inning++;
    }
    this._startHalf();
  }

  _endGame(walkoff) {
    this.over = true;
    const w = this.score[1] > this.score[0] ? 1 : 0;
    this.winner = w;
    const [wp, lp] = this.leadChange.pitcher;
    if (wp && this.teams[w].stats[wp]) this.teams[w].stats[wp].pit.W = 1;
    if (lp && this.teams[1 - w].stats[lp]) this.teams[1 - w].stats[lp].pit.L = 1;
    this.decisions = { W: wp, L: lp };
    const t = this.teams[w].def;
    this._log(`${walkoff ? 'WALK-OFF! ' : ''}Final: ${this.teams[0].def.abbr} ${this.score[0]}, ${this.teams[1].def.abbr} ${this.score[1]} — ${t.name} win.`, 'final');
  }

  // ---------------- Sim helpers ----------------
  simAtBat(opts = {}) {
    const team = this.half, next = this.battingTeam.next;
    let last = null;
    do { last = this.simPitch(opts); } while (!this.over && !this.paStart);
    void team; void next;
    return last;
  }
  simHalf() { const h = this.half, i = this.inning; while (!this.over && this.half === h && this.inning === i) this.simPitch(); }
  simInning() { const i = this.inning; while (!this.over && this.inning === i) this.simPitch(); }
  simToLastInning() { while (!this.over && this.inning < this.innings) this.simPitch(); }
  simToEnd() { let guard = 0; while (!this.over && guard++ < 5000) this.simPitch(); }

  boxScore() {
    return this.teams.map((t) => ({
      team: t.def,
      batting: t.order.map((id) => ({ player: t.byId[id], ...t.stats[id].bat })),
      pitching: t.pitchersUsed.map((id) => ({ player: t.byId[id], ...t.stats[id].pit })),
      fielding: t.order.map((id) => ({ player: t.byId[id], ...t.stats[id].fld })),
    }));
  }
}

export { short as shortName, PITCH_TYPES, clamp };
