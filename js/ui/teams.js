// Teams & Players editor with JSON/CSV import-export.
import { esc, chip } from './hud.js';
import { TIERS, generatePlayer, generateRoster, normalizePlayer, playersToCSV, playersFromCSV, overall, pitchingOverall, CSV_COLUMNS } from '../data/players.js';
import { PITCH_TYPES, PITCH_KEYS, ARM_SLOTS } from '../sim/pitching.js';
import { saveLeague, exportLeagueJSON, importLeagueJSON, resetLeague } from '../store.js';
import { RNG } from '../util/rng.js';
import { teamAbbr } from '../data/teams.js';

function download(name, text, type = 'application/json') {
  const blob = new Blob([text], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

export function toast(msg) {
  const t = document.createElement('div');
  t.className = 'toast'; t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2600);
}

export class TeamsView {
  constructor(root, app) {
    this.root = root; this.app = app;
    this.sel = 0;
    this._saveT = null;
    root.addEventListener('input', (e) => this.onInput(e));
    root.addEventListener('change', (e) => this.onInput(e, true));
    root.addEventListener('click', (e) => this.onClick(e));
  }
  get teams() { return this.app.league; }

  save() {
    clearTimeout(this._saveT);
    this._saveT = setTimeout(() => { saveLeague(this.teams); this.app.onLeagueChanged(); }, 300);
  }

  render() {
    const T = this.teams;
    const t = T[this.sel];
    const pitchOpts = (cur) => PITCH_KEYS.map((k) => `<option value="${k}" ${k === cur ? 'selected' : ''}>${PITCH_TYPES[k].name}</option>`).join('');
    const num = (i, path, v, min = 1, max = 99) => `<input type="number" data-i="${i}" data-f="${path}" value="${v}" min="${min}" max="${max}" />`;
    const rows = t.players.map((p, i) => `
      <tr class="${i >= 4 ? 'bench' : ''}">
        <td><b>${i < 4 ? i + 1 : 'B'}</b></td>
        <td><input class="name" data-i="${i}" data-f="name" value="${esc(p.name)}" /></td>
        <td>${num(i, 'number', p.number, 0, 99)}</td>
        <td><select data-i="${i}" data-f="tier">${Object.entries(TIERS).map(([k, v]) => `<option value="${k}" ${k === p.tier ? 'selected' : ''}>${v.name}</option>`).join('')}</select></td>
        <td>${num(i, 'age', p.age, 8, 60)}</td>
        <td><select data-i="${i}" data-f="bats"><option ${p.bats === 'R' ? 'selected' : ''}>R</option><option ${p.bats === 'L' ? 'selected' : ''}>L</option></select></td>
        <td><select data-i="${i}" data-f="throws"><option ${p.throws === 'R' ? 'selected' : ''}>R</option><option ${p.throws === 'L' ? 'selected' : ''}>L</option></select></td>
        <td>${num(i, 'bat.contact', p.bat.contact)}</td><td>${num(i, 'bat.power', p.bat.power)}</td><td>${num(i, 'bat.eye', p.bat.eye)}</td>
        <td>${num(i, 'field.speed', p.field.speed)}</td><td>${num(i, 'field.fielding', p.field.fielding)}</td><td>${num(i, 'field.arm', p.field.arm)}</td><td>${num(i, 'field.accuracy', p.field.accuracy)}</td>
        <td>${num(i, 'pitch.velocity', p.pitch.velocity, 20, 75)}</td><td>${num(i, 'pitch.control', p.pitch.control)}</td><td>${num(i, 'pitch.movement', p.pitch.movement)}</td><td>${num(i, 'pitch.stamina', p.pitch.stamina)}</td>
        <td><select data-i="${i}" data-f="pitch.armSlot">${Object.entries(ARM_SLOTS).map(([k, v]) => `<option value="${k}" ${k === p.pitch.armSlot ? 'selected' : ''}>${v.name}</option>`).join('')}</select></td>
        <td><div class="ars">${p.pitch.arsenal.map((a, j) => `<span class="pt"><select data-i="${i}" data-ars="${j}" data-af="type">${pitchOpts(a.type)}</select><input type="number" min="1" max="10" data-i="${i}" data-ars="${j}" data-af="level" value="${a.level}" title="Pitch level 1-10" /><button data-act="rmpitch" data-i="${i}" data-j="${j}" title="Remove pitch">×</button></span>`).join('')}<button class="mini" data-act="addpitch" data-i="${i}">+ pitch</button></div></td>
        <td class="muted">${overall(p)} / ${pitchingOverall(p)}</td>
        <td style="white-space:nowrap"><button class="mini" data-act="up" data-i="${i}" title="Move up">↑</button><button class="mini" data-act="down" data-i="${i}" title="Move down">↓</button><button class="mini" data-act="reroll" data-i="${i}" title="Randomize player">🎲</button><button class="mini" data-act="del" data-i="${i}" title="Remove">✕</button></td>
      </tr>`).join('');
    this.root.innerHTML = `
      <h1>Teams &amp; Players</h1>
      <p class="muted">All ratings are editable (1–99; velocity in mph; pitch levels 1–10). Changes save automatically in this browser. The first four players on a roster are the active lineup and batting order; extra players are bench.</p>
      <div class="team-list">${T.map((x, i) => `<button class="team-btn ${i === this.sel ? 'active' : ''}" data-act="sel" data-i="${i}">${chip(x)} <span>${esc(x.name)}</span></button>`).join('')}</div>
      <div class="panel">
        <div class="team-meta">
          <label>Team name <input data-team="name" value="${esc(t.name)}" /></label>
          <label title="Always the first 3 letters of the team name">Abbr <input id="team-abbr" value="${esc(t.abbr)}" readonly tabindex="-1" style="width:70px;opacity:.75" /></label>
          <label>Color <input type="color" data-team="color" value="${t.color}" /></label>
          <span class="sp" style="flex:1"></span>
          <button data-act="addplayer">+ Add player</button>
          <button data-act="regen">🎲 Regenerate team</button>
        </div>
        <div style="overflow-x:auto">
        <table class="roster-table">
          <thead><tr><th>#</th><th>Name</th><th>No.</th><th>Tier</th><th>Age</th><th>B</th><th>T</th>
          <th title="Contact">CON</th><th title="Power">POW</th><th title="Eye">EYE</th><th title="Speed">SPD</th><th title="Fielding">FLD</th><th title="Arm strength">ARM</th><th title="Throwing accuracy">ACC</th>
          <th title="Top velocity (mph)">VELO</th><th title="Control">CTRL</th><th title="Movement">MOV</th><th title="Stamina">STA</th><th>Slot</th><th>Pitches (type · level)</th><th title="Overall / Pitching overall">OVR</th><th></th></tr></thead>
          <tbody>${rows}</tbody>
        </table></div>
      </div>
      <div class="panel">
        <h3>Import / export</h3>
        <div class="toolbar">
          <button data-act="exjson">⬇ Export league JSON</button>
          <label class="tog"><button data-act="imjson">⬆ Import league JSON</button></label>
          <button data-act="excsv">⬇ Export players CSV</button>
          <button data-act="imcsv">⬆ Import players CSV</button>
          <span class="sp"></span>
          <button data-act="reset">Reset to new random league</button>
        </div>
        <input type="file" id="file-json" accept=".json,application/json" class="hidden" />
        <input type="file" id="file-csv" accept=".csv,text/csv" class="hidden" />
        <div class="note">CSV columns: <code>${CSV_COLUMNS.join(', ')}</code>. <code>pitches</code> looks like <code>riser:7;drop:5</code>. Tier is one of JH, HS, COL, PRO. Arm slot: over, three, side, under. Rows are matched to teams by <b>team name</b>; an imported team's roster is replaced.</div>
        <div class="muted small">Pitch types: ${PITCH_KEYS.map((k) => `<code>${k}</code>`).join(' ')}</div>
      </div>`;
    this.root.querySelector('#file-json').onchange = (e) => this.importFile(e, 'json');
    this.root.querySelector('#file-csv').onchange = (e) => this.importFile(e, 'csv');
  }

  onInput(e, isChange) {
    const el = e.target;
    const t = this.teams[this.sel];
    if (el.dataset.team) {
      t[el.dataset.team] = el.value;
      if (el.dataset.team === 'name') {
        t.abbr = teamAbbr(el.value);
        const ab = this.root.querySelector('#team-abbr');
        if (ab) ab.value = t.abbr;
      }
      this.save();
      if (isChange) this.render();
      return;
    }
    const i = el.dataset.i;
    if (i === undefined) return;
    const p = t.players[Number(i)];
    if (el.dataset.ars !== undefined) {
      const a = p.pitch.arsenal[Number(el.dataset.ars)];
      a[el.dataset.af] = el.dataset.af === 'level' ? Math.max(1, Math.min(10, Number(el.value) || 1)) : el.value;
    } else if (el.dataset.f) {
      const path = el.dataset.f.split('.');
      let o = p;
      for (let k = 0; k < path.length - 1; k++) o = o[path[k]];
      const key = path[path.length - 1];
      o[key] = el.type === 'number' ? Number(el.value) : el.value;
    }
    t.players[Number(i)] = normalizePlayer(p);
    t.players[Number(i)].id = p.id;
    this.save();
    if (isChange && el.tagName === 'SELECT') this.render();
  }

  onClick(e) {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const act = b.dataset.act;
    const t = this.teams[this.sel];
    const i = Number(b.dataset.i);
    const rng = new RNG();
    switch (act) {
      case 'sel': this.sel = i; break;
      case 'addplayer': t.players.push(generatePlayer(rng)); break;
      case 'del': if (t.players.length <= 4) { toast('A team needs at least 4 players.'); return; } t.players.splice(i, 1); break;
      case 'up': if (i > 0) [t.players[i - 1], t.players[i]] = [t.players[i], t.players[i - 1]]; break;
      case 'down': if (i < t.players.length - 1) [t.players[i + 1], t.players[i]] = [t.players[i], t.players[i + 1]]; break;
      case 'reroll': t.players[i] = generatePlayer(rng, { ace: i === 0 }); break;
      case 'regen': if (!confirm(`Replace the ${t.name} roster with random players?`)) return; t.players = generateRoster(rng, 4); break;
      case 'addpitch': {
        const have = new Set(t.players[i].pitch.arsenal.map((a) => a.type));
        const k = PITCH_KEYS.find((x) => !have.has(x));
        if (k) t.players[i].pitch.arsenal.push({ type: k, level: 5 });
        break;
      }
      case 'rmpitch': {
        const ars = t.players[i].pitch.arsenal;
        if (ars.length <= 1) { toast('A pitcher needs at least one pitch.'); return; }
        ars.splice(Number(b.dataset.j), 1);
        break;
      }
      case 'exjson': download('ncc-wiffs-league.json', exportLeagueJSON(this.teams)); return;
      case 'imjson': this.root.querySelector('#file-json').click(); return;
      case 'excsv': download('ncc-wiffs-players.csv', playersToCSV(this.teams), 'text/csv'); return;
      case 'imcsv': this.root.querySelector('#file-csv').click(); return;
      case 'reset':
        if (!confirm('Replace every team with a new random league? (Export first if you want to keep it.)')) return;
        this.app.league = resetLeague();
        this.app.onLeagueChanged();
        break;
      default: return;
    }
    this.save();
    this.render();
  }

  async importFile(e, kind) {
    const f = e.target.files?.[0];
    if (!f) return;
    const text = await f.text();
    e.target.value = '';
    try {
      if (kind === 'json') {
        const teams = importLeagueJSON(text);
        if (teams.some((t) => t.players.length < 4)) throw new Error('Every team needs at least 4 players.');
        this.app.league = teams;
        toast(`Imported ${teams.length} teams.`);
      } else {
        const { byTeam, errors } = playersFromCSV(text);
        let n = 0;
        const unknown = [];
        for (const [name, players] of byTeam) {
          const t = this.teams.find((x) => x.name.toLowerCase() === name.toLowerCase() || x.abbr.toLowerCase() === name.toLowerCase());
          if (!t) { unknown.push(name); continue; }
          if (players.length < 4) { errors.push(`${name}: only ${players.length} players (need 4)`); continue; }
          t.players = players; n++;
        }
        toast(`Imported rosters for ${n} team(s).${unknown.length ? ` Unknown teams: ${unknown.join(', ')}.` : ''}${errors.length ? ` ${errors.length} issue(s).` : ''}`);
        if (errors.length) console.warn(errors);
      }
      saveLeague(this.app.league);
      this.app.onLeagueChanged();
      this.render();
    } catch (err) {
      toast(`Import failed: ${err.message}`);
    }
  }
}
