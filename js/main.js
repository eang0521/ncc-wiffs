// App shell: navigation, exhibition setup, and wiring between views.
import { loadLeague, loadPrefs, savePrefs } from './store.js';
import { Game } from './sim/game.js';
import { esc, chip, lineScore, boxScore } from './ui/hud.js';
import { overall, pitchingOverall, TIERS } from './data/players.js';
import { TeamsView, toast } from './ui/teams.js';
import { SeasonView } from './ui/seasonView.js';

const $ = (s) => document.querySelector(s);

const app = {
  league: loadLeague(),
  view: null,          // FieldView (lazy, needs WebGL)
  live: null,          // LiveGame
  currentView: 'exhibition',
  gameActive: false,
  prefs: loadPrefs(),
  lastExhibition: null,

  onLeagueChanged() { fillTeamSelects(); },

  async ensureLive() {
    if (this.live) return this.live;
    const [{ FieldView }, { LiveGame }] = await Promise.all([import('./render/scene.js'), import('./ui/live.js')]);
    this.view = new FieldView($('#stage'));
    this.live = new LiveGame(this.view, $('#game-screen'));
    if (this.prefs.speedIdx !== undefined) this.live.setSpeed(this.prefs.speedIdx);
    $('#speed').value = this.live.speedIdx;
    $('#speed').addEventListener('change', () => { this.prefs.speedIdx = this.live.speedIdx; savePrefs(this.prefs); });
    return this.live;
  },

  async playGame(game, opts = {}) {
    let live;
    try { live = await this.ensureLive(); } catch (err) {
      console.error(err);
      toast('3D view failed to load (WebGL or network). Try "Quick sim" instead.');
      return;
    }
    this.gameActive = true;
    this.returnTo = opts.returnTo || this.currentView;
    document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
    $('#game-screen').classList.remove('hidden');
    requestAnimationFrame(() => this.view.resize());
    live.start(game, opts);
    window.scrollTo({ top: 0 });
  },

  exitGame(to) {
    this.live?.stop();
    this.gameActive = false;
    $('#game-screen').classList.add('hidden');
    showView(to || this.returnTo || 'exhibition', true);
  },
};
window.nccApp = app;

function showView(name, force) {
  if (app.gameActive && !force && name === app.returnTo) {
    document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
    $('#game-screen').classList.remove('hidden');
  } else {
    $('#game-screen').classList.add('hidden');
    document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${name}`));
    if (app.live && app.gameActive) { app.live.playing = false; app.live._updatePlayBtn(); }
  }
  app.currentView = name;
  document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
  if (name === 'teams') teamsView.render();
  if (name === 'season') seasonView.render();
}

document.querySelectorAll('.tabs button').forEach((b) => (b.onclick = () => showView(b.dataset.view)));
$('#btn-exit').onclick = () => app.exitGame();

// ---------------- Exhibition setup ----------------
function rosterPreview(team) {
  return team.players.slice(0, 4).map((p) => `<div class="pr"><span>#${p.number} ${esc(p.name)} <small>${TIERS[p.tier].name}</small></span><small>OVR ${overall(p)} · PIT ${pitchingOverall(p)} · ${p.pitch.velocity} mph</small></div>`).join('');
}

function fillTeamSelects() {
  const opts = app.league.map((t, i) => `<option value="${i}">${esc(t.name)}</option>`).join('');
  for (const id of ['#ex-away', '#ex-home']) {
    const s = $(id); const v = s.value;
    s.innerHTML = opts;
    if (v && app.league[v]) s.value = v;
  }
  if (!$('#ex-away').value || $('#ex-away').value === $('#ex-home').value) { $('#ex-away').value = '0'; $('#ex-home').value = '1'; }
  updatePreviews();
}
function updatePreviews() {
  $('#ex-away-roster').innerHTML = rosterPreview(app.league[$('#ex-away').value]);
  $('#ex-home-roster').innerHTML = rosterPreview(app.league[$('#ex-home').value]);
}
$('#ex-away').onchange = updatePreviews;
$('#ex-home').onchange = updatePreviews;
$('#ex-random').onclick = () => {
  const a = Math.floor(Math.random() * app.league.length);
  let h = Math.floor(Math.random() * (app.league.length - 1));
  if (h >= a) h++;
  $('#ex-away').value = a; $('#ex-home').value = h;
  updatePreviews();
};

function buildExhibition() {
  const a = app.league[$('#ex-away').value], h = app.league[$('#ex-home').value];
  if (a === h) { toast('Pick two different teams.'); return null; }
  if (a.players.length < 4 || h.players.length < 4) { toast('Each team needs at least 4 players.'); return null; }
  const sv = $('#ex-seed').value.trim();
  const seed = sv ? (Number(sv) || [...sv].reduce((x, c) => (x * 31 + c.charCodeAt(0)) >>> 0, 7)) : Math.floor(Math.random() * 1e9);
  const innings = Math.max(1, Math.min(9, Number($('#ex-innings').value) || 3));
  const manager = [$('#ex-mgr-away').value, $('#ex-mgr-home').value];
  return { away: a, home: h, seed, innings, manager };
}

function startExhibition(cfg) {
  app.lastExhibition = cfg;
  const game = new Game(structuredClone({ ...cfg, manager: undefined }));
  game.manager = [...cfg.manager];
  app.playGame(game, {
    label: `Exhibition · seed ${cfg.seed}`,
    onRematch: () => startExhibition({ ...cfg, seed: Math.floor(Math.random() * 1e9) }),
    onNew: () => app.exitGame('exhibition'),
  });
}

$('#ex-start').onclick = () => { const cfg = buildExhibition(); if (cfg) startExhibition(cfg); };
$('#ex-quick').onclick = () => {
  const cfg = buildExhibition();
  if (!cfg) return;
  const game = new Game(structuredClone({ ...cfg, manager: undefined }));
  game.manager = [...cfg.manager];
  game.simToEnd();
  const w = game.teams[game.winner].def;
  $('#ex-quick-result').innerHTML = `<div class="panel"><h3>Final: ${chip(game.teams[0].def)} ${game.score[0]} – ${game.score[1]} ${chip(game.teams[1].def)} · ${esc(w.name)} win</h3>${lineScore(game)}<details><summary class="muted">Box score &amp; play-by-play</summary>${boxScore(game)}<div class="panel-body">${game.log.map((l) => `<div class="log ${l.kind}">${esc(l.text)}</div>`).join('')}</div></details></div>`;
};

// ---------------- Other views ----------------
const teamsView = new TeamsView($('#teams-root'), app);
const seasonView = new SeasonView($('#season-root'), app);

fillTeamSelects();
showView('exhibition');
