// Live game controller: drives the engine pitch-by-pitch, plays records in 3D, and offers
// instant sims (pitch / at-bat / half / inning / to last inning / to the end).
import { scorebug, lineScore, boxScore, logHTML, drawZone, matchupHTML, managerHTML, esc, chip } from './hud.js';
import { toFt } from '../config.js';

const SPEEDS = [0.25, 0.5, 0.75, 1, 1.5, 2, 4, 8];
const $ = (sel, root = document) => root.querySelector(sel);

export class LiveGame {
  constructor(view, root) {
    this.view = view;
    this.root = root;
    this.game = null;
    this.playing = true;
    this.busy = false;
    this.speedIdx = 3;
    this.autoAdvance = true;
    this.stepOnce = false;
    this.abPitches = [];
    this.panel = 'pbp';
    this.timer = null;
    this.pending = [];
    this._bind();
  }

  _bind() {
    const r = this.root;
    $('#btn-play', r).onclick = () => this.togglePlay();
    $('#btn-step', r).onclick = () => { this.stepOnce = true; this.playing = true; this._updatePlayBtn(); if (!this.busy) this.next(); };
    const sp = $('#speed', r);
    sp.value = this.speedIdx;
    sp.oninput = () => this.setSpeed(Number(sp.value));
    $('#autoplay', r).onchange = (e) => { this.autoAdvance = e.target.checked; };
    r.querySelectorAll('[data-sim]').forEach((b) => (b.onclick = () => this.sim(b.dataset.sim)));
    r.querySelectorAll('[data-cam]').forEach((b) => (b.onclick = () => {
      this.view.setCamera(b.dataset.cam);
      r.querySelectorAll('[data-cam]').forEach((x) => x.classList.toggle('active', x === b));
    }));
    $('#opt-labels', r).onchange = (e) => this.view.setLabels(e.target.checked);
    $('#opt-trail', r).onchange = (e) => { this.view.showTrail = e.target.checked; };
    r.querySelectorAll('[data-panel]').forEach((b) => (b.onclick = () => this.showPanel(b.dataset.panel)));
    $('#panel-body', r).addEventListener('click', (e) => {
      const b = e.target.closest('[data-pitch]');
      if (!b) return;
      const [ti, id] = b.dataset.pitch.split(':');
      this.requestPitchingChange(Number(ti), id);
    });
    $('#panel-body', r).addEventListener('change', (e) => {
      const s = e.target.closest('[data-mgr]');
      if (s && this.game) { this.game.manager[Number(s.dataset.mgr)] = s.value; }
    });
    document.addEventListener('keydown', (e) => {
      if (!this.game || this.root.classList.contains('hidden') || e.target.closest('input,select,textarea')) return;
      if (e.code === 'Space') { e.preventDefault(); this.togglePlay(); }
      if (e.key === 'n') $('#btn-step', r).click();
    });
  }

  get speed() { return SPEEDS[this.speedIdx]; }
  setSpeed(i) {
    this.speedIdx = i;
    this.view.speed = this.speed;
    $('#speedv', this.root).textContent = `${this.speed}×`;
  }

  start(game, opts = {}) {
    this.stop();
    this.game = game;
    this.opts = opts;
    this.abPitches = [];
    this.snap = game.snapshot();
    this.visibleLog = game.log.length;
    this.view.setTeams(game.teams.map((t) => ({ def: t.def, players: t.players })));
    this.view.setCamera('auto');
    this.root.querySelectorAll('[data-cam]').forEach((x) => x.classList.toggle('active', x.dataset.cam === 'auto'));
    this.setSpeed(this.speedIdx);
    $('#final', this.root).classList.add('hidden');
    $('#game-title', this.root).innerHTML = `${chip(game.teams[0].def)} ${esc(game.teams[0].def.name)} <span class="at">at</span> ${chip(game.teams[1].def)} ${esc(game.teams[1].def.name)}${opts.label ? ` <small>· ${esc(opts.label)}</small>` : ''}`;
    this.playing = true;
    this._updatePlayBtn();
    this.refresh();
    this.view.showIdle(this.idleState(), true);
    this.schedule(1200);
  }

  stop() {
    clearTimeout(this.timer);
    if (this.busy) { this.view.rec = null; this.busy = false; }
    this.game = null;
  }

  togglePlay() {
    this.playing = !this.playing;
    this.view.paused = !this.playing;
    this._updatePlayBtn();
    if (this.playing && !this.busy) this.schedule(200);
  }
  _updatePlayBtn() { $('#btn-play', this.root).textContent = this.playing ? '⏸ Pause' : '▶ Play'; this.view.paused = !this.playing; }

  schedule(ms) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.next(), Math.max(60, ms / this.speed));
  }

  idleState() {
    const g = this.game;
    if (!g || g.over) return { defense: [], runners: [], batterId: null };
    const b = g.currentBatter();
    return {
      defense: g.alignment(b).map((d) => ({ id: d.player.id, role: d.role, pos: d.pos })),
      runners: [1, 2, 3].filter((x) => g.bases[x]).map((x) => ({ id: g.bases[x], base: x })),
      batterId: b.id, batterSide: b.bats === 'L' ? -1 : 1, pitcherId: g.currentPitcher().id, battingTeam: g.half,
    };
  }

  next() {
    const g = this.game;
    if (!g || this.busy || !this.playing) return;
    if (g.over) { this.finish(); return; }
    const rec = g.simPitch({ record: true });
    if (!rec) return;
    this.busy = true;
    this.rec = rec;
    if (rec.before.balls === 0 && rec.before.strikes === 0) this.abPitches = [];
    this.snap = rec.before;
    this.visibleLog = rec.logIndex;
    this.refresh();
    $('#pitchinfo', this.root).classList.remove('show');
    this.view.paused = false;
    this.view.playRecord(rec, {}, (e) => this.onEvent(e, rec), (r) => this.onDone(r));
  }

  onEvent(e, rec) {
    const pi = $('#pitchinfo', this.root);
    switch (e.type) {
      case 'release': {
        const p = rec.pitch;
        const rule = p.ruling === 'warn' ? '<div class="flag warn">⚠ SPEED WARNING</div>' : p.ruling === 'auto' ? '<div class="flag auto">AUTO BALL · 65+</div>' : '';
        pi.innerHTML = `<div class="mph">${p.radar}<small>MPH</small></div><div class="ptype">${esc(p.type)} <small>Lv ${p.level}</small></div>${rule}<div class="seen">Seen ${p.famBefore}× today</div>`;
        pi.classList.add('show');
        break;
      }
      case 'pitchResult': {
        if (rec.call !== 'inplay') {
          this.abPitches.push(rec.zone ? { ...rec.zone, call: rec.call } : null);
          this.snap = rec.after;
          this.refreshScore();
          const ended = rec.after.balls === 0 && rec.after.strikes === 0;
          const txt = ended ? (rec.text.includes('walks') ? 'WALK' : rec.text.includes('strikes out') ? 'STRIKEOUT' : '') :
            { ball: 'BALL', strike: 'STRIKE', swinging: 'SWING & MISS', foul: 'FOUL', foultip: 'FOUL TIP' }[rec.call];
          if (txt) this.callout(txt, ended ? 'big' : '');
        } else {
          this.abPitches.push({ ...rec.zone, call: 'inplay' });
          const c = rec.contact;
          if (c) pi.innerHTML += `<div class="ev">EV ${Math.round(c.exit / 0.44704)} mph · LA ${Math.round(c.launch)}°</div>`;
        }
        drawZone($('#zone', this.root), this.abPitches.filter(Boolean));
        break;
      }
      case 'hr': this.callout('HOME RUN!', 'huge'); break;
      case 'grd': this.callout('GROUND-RULE DOUBLE', 'big'); break;
      case 'peg': this.callout('PEGGED!', 'big'); break;
      case 'homeOut': this.callout(e.via === 'backstop' ? 'OUT AT HOME — OFF THE BACKSTOP' : 'OUT AT HOME — THROUGH THE ZONE', 'big'); break;
      case 'out': if (e.how === 'force') this.callout('FORCE OUT', ''); else if (e.how === 'fly') this.callout('CAUGHT!', ''); else if (e.how === 'tag') this.callout('TAGGED OUT', ''); break;
      case 'score': this.callout('RUN SCORES', 'run'); break;
      case 'error': this.callout('ERROR!', ''); break;
      case 'buntline': this.callout('FOUL — SHORT OF THE BUNT LINE', ''); break;
      case 'fence': this.callout('OFF THE FENCE!', ''); break;
      default: break;
    }
  }

  callout(text, cls = '') {
    const el = $('#callout', this.root);
    el.className = `callout show ${cls}`;
    el.textContent = text;
    clearTimeout(this._co);
    this._co = setTimeout(() => el.classList.remove('show'), Math.max(500, 1500 / Math.sqrt(this.speed)));
  }

  onDone(rec) {
    this.busy = false;
    this.snap = rec.after;
    this.visibleLog = rec.logEnd;
    for (const fn of this.pending.splice(0)) fn();
    this.refresh();
    this.view.showIdle(this.idleState());
    if (this.game.over) { this.finish(); return; }
    if (this.stepOnce) { this.stepOnce = false; this.playing = false; this._updatePlayBtn(); return; }
    if (this.playing && this.autoAdvance) this.schedule(rec.call === 'inplay' ? 1100 : 750);
    else if (!this.autoAdvance) { this.playing = false; this._updatePlayBtn(); }
  }

  requestPitchingChange(ti, id) {
    const apply = () => { this.game.changePitcher(ti, id, '(manager decision)'); this.visibleLog = this.game.log.length; this.refresh(); this.view.showIdle(this.idleState()); };
    if (this.busy) { this.pending.push(apply); this.callout('Pitching change after this pitch', ''); }
    else apply();
  }

  sim(kind) {
    const g = this.game;
    if (!g || g.over) return;
    clearTimeout(this.timer);
    if (this.busy) { this.view.rec = null; this.busy = false; for (const fn of this.pending.splice(0)) fn(); }
    const t0 = performance.now();
    switch (kind) {
      case 'pitch': g.simPitch(); break;
      case 'ab': g.simAtBat(); break;
      case 'half': g.simHalf(); break;
      case 'inning': g.simInning(); break;
      case 'last': g.simToLastInning(); break;
      case 'end': g.simToEnd(); break;
      default: break;
    }
    void t0;
    if (g.paStart) this.abPitches = [];
    else this.abPitches = g.pitchLog.map((p) => ({ ...p }));
    this.snap = g.snapshot();
    this.visibleLog = g.log.length;
    this.refresh();
    drawZone($('#zone', this.root), this.abPitches);
    this.view.showIdle(this.idleState(), true);
    $('#pitchinfo', this.root).classList.remove('show');
    if (g.over) { this.finish(); return; }
    if (this.playing) this.schedule(900);
  }

  finish() {
    clearTimeout(this.timer);
    const g = this.game;
    this.snap = g.snapshot();
    this.visibleLog = g.log.length;
    this.refresh();
    const w = g.teams[g.winner].def;
    const dec = g.decisions;
    const nm = (id) => (id ? esc(g.player(id).name) : '—');
    const el = $('#final', this.root);
    el.innerHTML = `<div class="final-card">
      <div class="final-h">FINAL${g.inning > g.innings ? ` / ${g.inning}` : ''}</div>
      <div class="final-score">${chip(g.teams[0].def)} <b>${g.score[0]}</b> <span>–</span> <b>${g.score[1]}</b> ${chip(g.teams[1].def)}</div>
      <div class="final-w">${esc(w.name)} win</div>
      <div class="muted small">W: ${nm(dec.W)} · L: ${nm(dec.L)}</div>
      <div class="final-btns"><button data-act="box">Box score</button>${this.opts?.onBack ? '<button class="primary" data-act="back">Back to season</button>' : '<button data-act="rematch">Rematch</button><button class="primary" data-act="new">New game</button>'}</div>
    </div>`;
    el.classList.remove('hidden');
    el.onclick = (e) => {
      const a = e.target.closest('[data-act]')?.dataset.act;
      if (a === 'box') { this.showPanel('box'); el.classList.add('hidden'); }
      if (a === 'back') this.opts.onBack?.();
      if (a === 'rematch') this.opts.onRematch?.();
      if (a === 'new') this.opts.onNew?.();
    };
    if (this.opts?.onFinish && !this.opts.saved) { this.opts.saved = true; this.opts.onFinish(g); }
  }

  showPanel(p) {
    this.panel = p;
    this.root.querySelectorAll('[data-panel]').forEach((b) => b.classList.toggle('active', b.dataset.panel === p));
    this.refreshPanel();
  }

  refreshScore() {
    const g = this.game;
    $('#scorebug', this.root).innerHTML = scorebug(g, this.snap);
    $('#linescore', this.root).innerHTML = lineScore(g, this.snap);
  }

  /** What the HUD should show: during playback, stats as they were before the pitch. */
  get shown() {
    const g = this.game;
    if (g && this.busy && this.rec?.view) return (this._frozenFor === this.rec ? this._frozen : (this._frozenFor = this.rec, this._frozen = g.frozen(this.rec.view)));
    return g;
  }

  refreshPanel() {
    const g = this.shown;
    if (!g) return;
    const body = $('#panel-body', this.root);
    if (this.panel === 'pbp') body.innerHTML = logHTML(g, this.visibleLog);
    else if (this.panel === 'box') body.innerHTML = boxScore(g);
    else if (this.panel === 'matchup') body.innerHTML = matchupHTML(g);
    else if (this.panel === 'manager') body.innerHTML = managerHTML(g);
  }

  refresh() {
    const g = this.shown;
    if (!g) return;
    this.refreshScore();
    this.refreshPanel();
    const s = this.snap;
    const ab = $('#atbat', this.root);
    if (s.over || !s.batterId) ab.innerHTML = '';
    else {
      const b = g.player(s.batterId), p = g.player(s.pitcherId);
      const bs = g.teamOf(b.id).stats[b.id].bat;
      ab.innerHTML = `<div><span class="lbl">AB</span> #${b.number} <b>${esc(b.name)}</b> <small>${b.bats} · ${bs.H}-${bs.AB}</small></div>
        <div><span class="lbl">P</span> #${p.number} <b>${esc(p.name)}</b> <small>${s.pitchCount[p.id] || 0} P</small></div>`;
    }
    const last = g.log.slice(0, this.visibleLog).filter((l) => l.kind !== 'inning').slice(-1)[0];
    $('#ticker', this.root).textContent = last ? last.text : '';
    drawZone($('#zone', this.root), this.abPitches.filter(Boolean));
  }
}

export { toFt };
