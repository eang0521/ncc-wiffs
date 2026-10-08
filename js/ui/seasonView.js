// Season mode page.
import { esc, chip, fmt3 } from './hud.js';
import { createSeason, nextGame, simNext, standings, leaders, progress, teamById, makeGame, recordResult } from '../league/season.js';
import { loadSeason, saveSeason, clearSeason } from '../store.js';
import { toast } from './teams.js';

const tick = () => new Promise((r) => setTimeout(r, 0));

export class SeasonView {
  constructor(root, app) {
    this.root = root; this.app = app;
    this.season = loadSeason();
    this.busy = false;
    root.addEventListener('click', (e) => this.onClick(e));
  }

  save() { if (this.season && !saveSeason(this.season)) toast('Could not save the season (browser storage full or blocked).'); }

  render() {
    const s = this.season;
    if (!s) {
      this.root.innerHTML = `
        <h1>Season</h1>
        <p class="muted">Play a full league season with all 16 teams: standings, stat leaders, and a four-team playoff. Rosters are copied from <b>Teams &amp; Players</b> when the season starts.</p>
        <div class="panel" style="max-width:560px">
          <div class="team-meta">
            <label>Schedule <select id="ss-cycles"><option value="1">Single round-robin (15 games)</option><option value="2">Double round-robin (30 games)</option></select></label>
            <label>Innings <input id="ss-innings" type="number" min="1" max="9" value="3" /></label>
            <label>Seed <input id="ss-seed" placeholder="random" style="width:110px" /></label>
          </div>
          <button class="primary big" data-act="create">Start season</button>
        </div>`;
      return;
    }
    const pr = progress(s);
    const st = standings(s);
    const L = leaders(s);
    const nxt = nextGame(s);
    const lastRound = [...s.schedule].reverse().find((r) => r.games.some((g) => g.result));
    const nextRound = s.schedule.find((r) => r.games.some((g) => !g.result));
    const resRow = (g) => {
      const a = teamById(s, g.away), h = teamById(s, g.home);
      if (!g.result) return `<div class="res"><span>${chip(a)} ${esc(a.name)}</span><span class="muted">at</span><span>${chip(h)} ${esc(h.name)}</span><span><button class="mini" data-act="watch" data-g="${g.id}">Watch</button></span></div>`;
      const [as, hs] = g.result.score;
      return `<div class="res"><span class="${as > hs ? 'w' : ''}">${chip(a)} ${esc(a.name)}</span><span class="sc">${as}–${hs}</span><span class="${hs > as ? 'w' : ''}">${chip(h)} ${esc(h.name)}</span><span class="muted small">${g.result.innings > s.innings ? `F/${g.result.innings}` : 'F'}</span></div>`;
    };
    const ld = (title, rows, val, fmt = (v) => v) => `<div class="card"><div class="card-h"><b>${title}</b></div><table>${rows.map((r, i) => `<tr><td>${i + 1}. ${chip(r.team)} ${esc(r.player.name)}</td><td>${fmt(val(r))}</td></tr>`).join('') || '<tr><td class="muted">—</td></tr>'}</table></div>`;
    let po = '';
    if (s.playoffs) {
      const P = s.playoffs;
      po = `<div class="panel"><h3>Playoffs ${P.champion ? `— 🏆 ${esc(teamById(s, P.champion).name)} are champions!` : ''}</h3>
        <div class="bracket">${P.games.map((g) => `<div class="card"><div class="card-h"><b>${esc(g.label)}</b></div>${g.away ? resRow(g) : '<div class="muted small">Waiting on semifinals</div>'}</div>`).join('')}</div></div>`;
    }
    this.root.innerHTML = `
      <h1>Season</h1>
      <div class="muted">${pr.done} of ${pr.total} regular-season games played · ${s.innings} innings · seed ${s.seed}${s.phase === 'done' ? ' · <b>Season complete</b>' : ''}</div>
      <div class="progress"><i style="width:${(pr.done / pr.total) * 100}%"></i></div>
      <div class="toolbar">
        <button class="primary" data-act="watchnext" ${nxt ? '' : 'disabled'}>▶ Watch next game</button>
        <button data-act="sim1" ${nxt ? '' : 'disabled'}>Sim next game</button>
        <button data-act="simround" ${nxt ? '' : 'disabled'}>Sim round</button>
        <button data-act="sim5" ${nxt ? '' : 'disabled'}>Sim 5 rounds</button>
        <button data-act="simreg" ${s.phase === 'regular' ? '' : 'disabled'}>Sim regular season</button>
        <button data-act="simall" ${nxt ? '' : 'disabled'}>Sim everything</button>
        <span class="sp"></span>
        <span id="ss-status" class="muted small"></span>
        <button data-act="newseason" class="ghost">New season</button>
      </div>
      ${po}
      <div class="grid-2">
        <div class="panel"><h3>Standings</h3>
          <table class="stat"><thead><tr><th>Team</th><th>W</th><th>L</th><th>PCT</th><th>GB</th><th>RS</th><th>RA</th><th>DIFF</th><th>STRK</th><th>L5</th></tr></thead><tbody>
          ${st.map((r, i) => `<tr class="${i < 4 ? 'cur' : ''}"><td>${chip(r.team)} ${esc(r.team.name)}</td><td>${r.W}</td><td>${r.L}</td><td>${fmt3(r.PCT)}</td><td>${r.GB ? r.GB.toFixed(1) : '–'}</td><td>${r.RS}</td><td>${r.RA}</td><td>${r.DIFF > 0 ? '+' : ''}${r.DIFF}</td><td>${r.streak}</td><td>${r.L5}</td></tr>`).join('')}
          </tbody></table><div class="muted small">Top 4 make the playoffs.</div></div>
        <div>
          <div class="panel"><h3>${nextRound ? `Up next — Round ${nextRound.round}` : 'Schedule complete'}</h3><div class="results">${nextRound ? nextRound.games.map(resRow).join('') : ''}</div></div>
          ${lastRound ? `<div class="panel"><h3>Results — Round ${lastRound.round}</h3><div class="results">${lastRound.games.filter((g) => g.result).map(resRow).join('')}</div></div>` : ''}
        </div>
      </div>
      <div class="panel"><h3>League leaders</h3>
        <div class="leaders">
          ${ld('Batting average', L.avg, (r) => r.avg, fmt3)}
          ${ld('OPS', L.ops, (r) => r.ops, fmt3)}
          ${ld('Home runs', L.hr, (r) => r.hr)}
          ${ld('RBI', L.rbi, (r) => r.rbi)}
          ${ld('Runs allowed per 3 inn (min IP)', L.ra3, (r) => r.ra3, (v) => v.toFixed(2))}
          ${ld('Strikeouts', L.k, (r) => r.k)}
          ${ld('Wins', L.w, (r) => r.w)}
          ${ld('Pegs (runners hit)', L.peg, (r) => r.peg)}
          ${ld('Top radar reading', L.velo, (r) => r.velo, (v) => `${v} mph`)}
        </div>
      </div>`;
  }

  async runSims(cond) {
    if (this.busy) return;
    this.busy = true;
    const status = this.root.querySelector('#ss-status');
    let n = 0;
    try {
      while (cond(n) && nextGame(this.season)) {
        simNext(this.season);
        n++;
        if (n % 4 === 0) { if (status) status.textContent = `Simulated ${n} games…`; await tick(); }
      }
    } finally {
      this.busy = false;
      this.save();
      this.render();
      if (n) toast(`Simulated ${n} game${n > 1 ? 's' : ''}.`);
    }
  }

  onClick(e) {
    const b = e.target.closest('[data-act]');
    if (!b || this.busy) return;
    const s = this.season;
    switch (b.dataset.act) {
      case 'create': {
        const cycles = Number(this.root.querySelector('#ss-cycles').value);
        const innings = Math.max(1, Math.min(9, Number(this.root.querySelector('#ss-innings').value) || 3));
        const sv = this.root.querySelector('#ss-seed').value.trim();
        const seed = sv ? (Number(sv) || [...sv].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7)) : undefined;
        if (this.app.league.some((t) => t.players.length < 4)) { toast('Every team needs at least 4 players.'); return; }
        this.season = createSeason(this.app.league, { cycles, innings, seed });
        this.save(); this.render();
        break;
      }
      case 'newseason':
        if (!confirm('Start over? The current season will be deleted.')) return;
        clearSeason(); this.season = null; this.render();
        break;
      case 'sim1': this.runSims((n) => n < 1); break;
      case 'simround': {
        const r = nextGame(s)?.round;
        this.runSims(() => nextGame(this.season)?.round === r);
        break;
      }
      case 'sim5': {
        const r = nextGame(s)?.round;
        this.runSims(() => { const x = nextGame(this.season)?.round; return typeof x === 'number' && x < r + 5; });
        break;
      }
      case 'simreg': this.runSims(() => this.season.phase === 'regular'); break;
      case 'simall': this.runSims(() => true); break;
      case 'watchnext': { const n = nextGame(s); if (n) this.watch(n.game, typeof n.round === 'number' ? `Season · Round ${n.round}` : n.round); break; }
      case 'watch': {
        const n = nextGame(s);
        if (n && n.game.id === b.dataset.g) this.watch(n.game, typeof n.round === 'number' ? `Season · Round ${n.round}` : n.round);
        else toast('Games are played in schedule order — this one isn\'t next yet.');
        break;
      }
      default:
    }
  }

  watch(g, label) {
    const game = makeGame(this.season, g);
    this.app.playGame(game, {
      label,
      onFinish: (done) => { if (!g.result) { recordResult(this.season, g, done); this.save(); } },
      onBack: () => { this.app.exitGame('season'); this.render(); },
    });
  }
}
