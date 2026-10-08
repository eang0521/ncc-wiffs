// DOM rendering helpers: scorebug, line score, box score, zone inset, matchup & familiarity.
import { FIELD } from '../config.js';
import { PITCH_TYPES, familiarityFrac, fatigueLevel, ARM_SLOTS } from '../sim/pitching.js';
import { recognition } from '../sim/batting.js';
import { accentFor } from '../data/teams.js';
import { TIERS, pitchingOverall, overall } from '../data/players.js';

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export const chip = (team) => `<span class="chip" style="--c:${team.color};--a:${accentFor(team.color)}">${esc(team.abbr)}</span>`;
const short = (p) => { const s = p.name.split(' '); return s.length > 1 ? `${s[0][0]}. ${s.slice(1).join(' ')}` : p.name; };
export const ipStr = (outs) => `${Math.floor(outs / 3)}.${outs % 3}`;
export const fmt3 = (x) => (x >= 1 ? x.toFixed(3) : x.toFixed(3).replace(/^0/, ''));

export function scorebug(game, snap) {
  const s = snap || game.snapshot();
  const [a, h] = game.teams;
  const bases = [1, 2, 3].map((b) => (s.bases[b] ? 'on' : '')).join(' ');
  const [b1, b2, b3] = [1, 2, 3].map((b) => (s.bases[b] ? 'on' : ''));
  void bases;
  const half = s.over ? 'FINAL' : `${s.half === 0 ? '▲' : '▼'} ${s.inning}`;
  const outs = [0, 1, 2].map((i) => `<i class="${i < s.outs ? 'on' : ''}"></i>`).join('');
  return `
  <div class="sb-teams">
    <div class="sb-row ${s.half === 0 && !s.over ? 'bat' : ''}">${chip(a.def)}<b>${s.score[0]}</b></div>
    <div class="sb-row ${s.half === 1 && !s.over ? 'bat' : ''}">${chip(h.def)}<b>${s.score[1]}</b></div>
  </div>
  <div class="sb-mid">
    <div class="sb-inning">${half}</div>
    <div class="diamond"><span class="b2 ${b2}"></span><span class="b3 ${b3}"></span><span class="b1 ${b1}"></span></div>
  </div>
  <div class="sb-count">
    <div><span class="lbl">B</span>${[0, 1, 2].map((i) => `<i class="ball ${i < s.balls ? 'on' : ''}"></i>`).join('')}</div>
    <div><span class="lbl">S</span>${[0, 1].map((i) => `<i class="strike ${i < s.strikes ? 'on' : ''}"></i>`).join('')}</div>
    <div><span class="lbl">O</span><span class="outs">${outs}</span></div>
  </div>`;
}

export function lineScore(game, snap) {
  const s = snap || game.snapshot();
  const n = Math.max(game.innings, s.inning);
  const cols = Array.from({ length: n }, (_, i) => i + 1);
  const row = (ti) => {
    const t = game.teams[ti].def;
    return `<tr><th>${chip(t)} <span class="tname">${esc(t.name)}</span></th>${cols.map((c) => {
      const v = s.line[ti][c - 1];
      const future = c > s.inning || (c === s.inning && ti > s.half && !s.over);
      return `<td>${v === undefined || (future && !v) ? (future ? '' : '0') : v}</td>`;
    }).join('')}<td class="tot">${s.score[ti]}</td><td>${s.hits[ti]}</td><td>${s.errors[ti]}</td></tr>`;
  };
  return `<table class="linescore"><thead><tr><th></th>${cols.map((c) => `<th>${c}</th>`).join('')}<th>R</th><th>H</th><th>E</th></tr></thead><tbody>${row(0)}${row(1)}</tbody></table>`;
}

export function boxScore(game) {
  const box = game.boxScore();
  return box.map((side, ti) => {
    const t = side.team;
    const roleOf = (id) => Object.keys(game.teams[ti].roles).find((r) => game.teams[ti].roles[r] === id);
    const bat = side.batting.map((b) => `<tr><td>${esc(b.player.name)} <small>${roleOf(b.player.id)}</small></td><td>${b.PA}</td><td>${b.AB}</td><td>${b.R}</td><td>${b.H}</td><td>${b['2B']}</td><td>${b['3B']}</td><td>${b.HR}</td><td>${b.RBI}</td><td>${b.BB}</td><td>${b.K}</td></tr>`).join('');
    const pit = side.pitching.map((p) => `<tr><td>${esc(p.player.name)}${p.W ? ' <b class="dec">W</b>' : ''}${p.L ? ' <b class="dec l">L</b>' : ''}</td><td>${ipStr(p.outs)}</td><td>${p.H}</td><td>${p.R}</td><td>${p.BB}</td><td>${p.K}</td><td>${p.HR}</td><td>${p.P}</td><td>${p.maxVelo}</td><td>${p.warn}/${p.auto}</td></tr>`).join('');
    const fld = side.fielding.filter((f) => f.PO || f.E || f.PEG).map((f) => `${esc(short(f.player))}: ${f.PO} PO${f.PEG ? `, ${f.PEG} peg` : ''}${f.E ? `, ${f.E} E` : ''}`).join(' · ');
    return `<div class="box"><h4>${chip(t)} ${esc(t.name)}</h4>
      <table class="stat"><thead><tr><th>Batting</th><th>PA</th><th>AB</th><th>R</th><th>H</th><th>2B</th><th>3B</th><th>HR</th><th>RBI</th><th>BB</th><th>K</th></tr></thead><tbody>${bat}</tbody></table>
      <table class="stat"><thead><tr><th>Pitching</th><th>IP</th><th>H</th><th>R</th><th>BB</th><th>K</th><th>HR</th><th>P</th><th>Max</th><th title="Speed warnings / auto balls">W/A</th></tr></thead><tbody>${pit}</tbody></table>
      <div class="fld">${fld || 'No fielding plays.'}</div></div>`;
  }).join('');
}

export function logHTML(game, upto) {
  const L = game.log.slice(0, upto ?? game.log.length);
  return L.slice(-250).reverse().map((l) => `<div class="log ${l.kind}">${esc(l.text)}</div>`).join('');
}

const CALL_COLORS = { strike: '#e5484d', swinging: '#f76b15', foul: '#ffc53d', foultip: '#ffc53d', foultipK: '#e5484d', ball: '#3fb950', inplay: '#3e9bff' };

/** Strike-zone inset, catcher's view (1st-base side on the right). */
export function drawZone(canvas, pitches) {
  const g = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  g.clearRect(0, 0, W, H);
  const xr = 0.62, y0 = 0.05, y1 = 1.55;
  const px = (x) => W / 2 + (x / xr) * (W / 2);
  const py = (y) => H - ((y - y0) / (y1 - y0)) * H;
  g.fillStyle = 'rgba(10,16,22,0.55)'; g.fillRect(0, 0, W, H);
  const zw = FIELD.zoneWidth / 2;
  g.strokeStyle = 'rgba(255,255,255,0.9)'; g.lineWidth = 3;
  g.strokeRect(px(-zw), py(FIELD.zoneTop), px(zw) - px(-zw), py(FIELD.zoneBottom) - py(FIELD.zoneTop));
  g.strokeStyle = 'rgba(255,255,255,0.15)'; g.lineWidth = 1;
  for (let i = 1; i < 3; i++) {
    const x = -zw + (2 * zw * i) / 3; g.beginPath(); g.moveTo(px(x), py(FIELD.zoneTop)); g.lineTo(px(x), py(FIELD.zoneBottom)); g.stroke();
    const y = FIELD.zoneBottom + (FIELD.zoneHeight * i) / 3; g.beginPath(); g.moveTo(px(-zw), py(y)); g.lineTo(px(zw), py(y)); g.stroke();
  }
  pitches.forEach((p, i) => {
    const x = px(p.x), y = py(p.y);
    g.fillStyle = CALL_COLORS[p.call] || '#ccc';
    g.beginPath(); g.arc(x, y, 9, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#0b0f14'; g.font = 'bold 11px system-ui'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(String(i + 1), x, y + 0.5);
  });
}

export function ratingBar(v, label) {
  const hue = Math.round(Math.max(0, Math.min(100, v)) * 1.2);
  return `<div class="rb"><span>${label}</span><div class="bar"><i style="width:${v}%;background:hsl(${hue} 70% 48%)"></i></div><b>${v}</b></div>`;
}

export function matchupHTML(game) {
  if (game.over) return '<div class="muted">Game over.</div>';
  const b = game.currentBatter(), p = game.currentPitcher();
  const bt = game.battingTeam.def, ft = game.fieldingTeam.def;
  const pc = game.pitchCount[p.id] || 0;
  const fat = fatigueLevel(p, pc);
  const table = game.famTable(b.id, p.id);
  const bs = game.battingTeam.stats[b.id].bat;
  const fam = p.pitch.arsenal.map((a) => {
    const n = table[a.type] || 0;
    const boost = 36 * familiarityFrac(n);
    return `<tr><td>${esc(PITCH_TYPES[a.type].name)}</td><td>Lv ${a.level}</td><td>${n}</td><td><div class="bar sm"><i style="width:${Math.min(100, boost / 36 * 100)}%"></i></div></td><td>+${boost.toFixed(0)}%</td></tr>`;
  }).join('');
  const recog = recognition(b, 0) * 100;
  return `<div class="matchup">
    <div class="card">
      <div class="card-h">${chip(bt)} <b>#${b.number} ${esc(b.name)}</b> <small>${TIERS[b.tier].name} · Bats ${b.bats}</small></div>
      <div class="muted small">Today: ${bs.H}-${bs.AB}${bs.HR ? `, ${bs.HR} HR` : ''}${bs.BB ? `, ${bs.BB} BB` : ''}${bs.K ? `, ${bs.K} K` : ''} · OVR ${overall(b)}</div>
      ${ratingBar(b.bat.contact, 'Contact')}${ratingBar(b.bat.power, 'Power')}${ratingBar(b.bat.eye, 'Eye')}${ratingBar(b.field.speed, 'Speed')}
    </div>
    <div class="card">
      <div class="card-h">${chip(ft)} <b>#${p.number} ${esc(p.name)}</b> <small>${p.throws}HP · ${ARM_SLOTS[p.pitch.armSlot].name}</small></div>
      <div class="muted small">Top velo ${p.pitch.velocity} mph · ${pc} pitches · PIT ${pitchingOverall(p)}</div>
      ${ratingBar(p.pitch.control, 'Control')}${ratingBar(p.pitch.movement, 'Movement')}${ratingBar(Math.round(Math.max(0, 100 - fat * 100)), 'Energy')}
    </div>
    <div class="card wide">
      <div class="card-h"><b>Familiarity</b> <small>${esc(short(b))} vs ${esc(short(p))} · base recognition ${recog.toFixed(0)}%</small></div>
      <table class="stat fam"><thead><tr><th>Pitch</th><th>Level</th><th>Seen</th><th colspan="2">Eye boost</th></tr></thead><tbody>${fam}</tbody></table>
    </div>
  </div>`;
}

/** Manager panel: per team pitching options with fatigue & how much the opponent has seen them. */
export function managerHTML(game) {
  return game.teams.map((t, ti) => {
    const opp = game.teams[1 - ti];
    const rows = t.players.map((p) => {
      const role = Object.keys(t.roles).find((r) => t.roles[r] === p.id);
      const pc = game.pitchCount[p.id] || 0;
      const fat = fatigueLevel(p, pc);
      let famSum = 0;
      for (const bid of opp.order) {
        const tb = game.famTable(bid, p.id);
        const tot = p.pitch.arsenal.reduce((a, x) => a + x.level, 0) || 1;
        famSum += p.pitch.arsenal.reduce((a, x) => a + familiarityFrac(tb[x.type] || 0) * x.level, 0) / tot;
      }
      const fam = (famSum / opp.order.length) * 100;
      const ars = p.pitch.arsenal.map((a) => `${PITCH_TYPES[a.type].abbr}${a.level}`).join(' ');
      return `<tr class="${role === 'P' ? 'cur' : ''}"><td><b>${role}</b></td><td>${esc(short(p))}</td><td>${pitchingOverall(p)}</td><td>${p.pitch.velocity}</td><td title="${esc(ars)}">${esc(ars)}</td><td>${pc}</td><td><div class="bar sm"><i style="width:${Math.max(0, 100 - fat * 100)}%"></i></div></td><td>${fam.toFixed(0)}%</td>
        <td>${role === 'P' ? '<span class="muted">pitching</span>' : `<button class="mini" data-pitch="${ti}:${p.id}">Pitch</button>`}</td></tr>`;
    }).join('');
    return `<div class="mgr"><div class="card-h">${chip(t.def)} <b>${esc(t.def.name)}</b>
      <label class="tog">Manager <select data-mgr="${ti}"><option value="ai" ${game.manager[ti] === 'ai' ? 'selected' : ''}>AI</option><option value="manual" ${game.manager[ti] === 'manual' ? 'selected' : ''}>You</option></select></label></div>
      <table class="stat"><thead><tr><th>Pos</th><th>Player</th><th>PIT</th><th>Velo</th><th>Arsenal</th><th>P#</th><th>Energy</th><th title="How familiar the opposing lineup is with his pitches">Seen</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`;
  }).join('');
}
