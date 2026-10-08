// Season mode: round-robin schedule, standings, cumulative stats, leaders and a 4-team playoff.
import { Game, emptyBatting, emptyPitching, emptyFielding } from '../sim/game.js';
import { RNG } from '../util/rng.js';

function roundRobin(ids) {
  const list = [...ids];
  if (list.length % 2) list.push(null);
  const n = list.length, rounds = [];
  for (let r = 0; r < n - 1; r++) {
    const games = [];
    for (let i = 0; i < n / 2; i++) {
      const a = list[i], b = list[n - 1 - i];
      if (a && b) games.push(r % 2 === 0 ? [a, b] : [b, a]);
    }
    rounds.push(games);
    list.splice(1, 0, list.pop());
  }
  return rounds;
}

export function createSeason(teams, { cycles = 1, seed = Math.floor(Math.random() * 1e9), innings = 3 } = {}) {
  const rng = new RNG(seed);
  const ids = teams.map((t) => t.id);
  const base = roundRobin(ids);
  const schedule = [];
  for (let c = 0; c < cycles; c++) {
    const order = base.map((g, i) => i);
    for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(rng.next() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
    for (const ri of order) {
      schedule.push({ round: schedule.length + 1, games: base[ri].map(([a, h]) => (c % 2 ? { away: h, home: a } : { away: a, home: h })) });
    }
  }
  let gid = 0;
  for (const r of schedule) for (const g of r.games) { g.id = `g${++gid}`; g.seed = Math.floor(rng.next() * 1e9); g.result = null; }
  return {
    version: 1, created: Date.now(), seed, innings, cycles,
    teams: JSON.parse(JSON.stringify(teams)),
    schedule, stats: {}, phase: 'regular', playoffs: null,
  };
}

export const teamById = (season, id) => season.teams.find((t) => t.id === id);

export function nextGame(season) {
  if (season.phase === 'regular') {
    for (const r of season.schedule) for (const g of r.games) if (!g.result) return { game: g, round: r.round };
    return null;
  }
  if (season.phase === 'playoffs') {
    for (const g of season.playoffs.games) if (!g.result && g.away && g.home) return { game: g, round: g.label };
  }
  return null;
}

export function makeGame(season, g, opts = {}) {
  return new Game({ away: teamById(season, g.away), home: teamById(season, g.home), seed: g.seed, innings: season.innings, ...opts });
}

function addStats(dst, src) { for (const k in src) if (typeof src[k] === 'number') dst[k] = (dst[k] || 0) + src[k]; }

export function recordResult(season, g, game) {
  const box = game.boxScore();
  g.result = {
    score: [...game.score], line: game.line.map((l) => [...l]), hits: [...game.hits], errors: [...game.errors],
    innings: game.inning, W: game.decisions.W, L: game.decisions.L,
    winner: game.winner === 1 ? g.home : g.away,
  };
  for (const side of box) {
    for (const b of side.batting) {
      const s = (season.stats[b.player.id] ||= { team: side.team.id, bat: emptyBatting(), pit: emptyPitching(), fld: emptyFielding() });
      const { player, ...nums } = b; void player;
      addStats(s.bat, nums);
    }
    for (const p of side.pitching) {
      const s = season.stats[p.player.id];
      const { player, maxVelo, ...nums } = p; void player;
      addStats(s.pit, nums);
      s.pit.maxVelo = Math.max(s.pit.maxVelo || 0, maxVelo);
    }
    for (const f of side.fielding) {
      const s = season.stats[f.player.id];
      const { player, ...nums } = f; void player;
      addStats(s.fld, nums);
    }
  }
  if (season.phase === 'regular' && !nextGame(season)) startPlayoffs(season);
  else if (season.phase === 'playoffs') advancePlayoffs(season);
}

export function simNext(season) {
  const n = nextGame(season);
  if (!n) return null;
  const game = makeGame(season, n.game);
  game.simToEnd();
  recordResult(season, n.game, game);
  return { ...n, game };
}

export function standings(season) {
  const rows = new Map(season.teams.map((t) => [t.id, { team: t, W: 0, L: 0, RS: 0, RA: 0, streak: '', results: [] }]));
  for (const r of season.schedule) for (const g of r.games) {
    if (!g.result) continue;
    const a = rows.get(g.away), h = rows.get(g.home);
    const [as, hs] = g.result.score;
    a.RS += as; a.RA += hs; h.RS += hs; h.RA += as;
    const aw = as > hs;
    (aw ? a : h).W++; (aw ? h : a).L++;
    a.results.push(aw ? 'W' : 'L'); h.results.push(aw ? 'L' : 'W');
  }
  const list = [...rows.values()];
  for (const r of list) {
    r.PCT = r.W + r.L ? r.W / (r.W + r.L) : 0;
    r.DIFF = r.RS - r.RA;
    const last = r.results[r.results.length - 1];
    let n = 0;
    for (let i = r.results.length - 1; i >= 0 && r.results[i] === last; i--) n++;
    r.streak = last ? `${last}${n}` : '-';
    r.L5 = r.results.slice(-5).join('');
  }
  list.sort((a, b) => b.PCT - a.PCT || b.DIFF - a.DIFF || b.RS - a.RS);
  const lead = list[0];
  for (const r of list) r.GB = lead ? ((lead.W - r.W) + (r.L - lead.L)) / 2 : 0;
  return list;
}

export function startPlayoffs(season) {
  const top = standings(season).slice(0, 4).map((r) => r.team.id);
  season.phase = 'playoffs';
  season.playoffs = {
    seeds: top,
    games: [
      { id: 'sf1', label: 'Semifinal 1 (1 vs 4)', away: top[3], home: top[0], seed: season.seed + 11, result: null },
      { id: 'sf2', label: 'Semifinal 2 (2 vs 3)', away: top[2], home: top[1], seed: season.seed + 22, result: null },
      { id: 'final', label: 'Championship', away: null, home: null, seed: season.seed + 33, result: null },
    ],
    champion: null,
  };
}

function advancePlayoffs(season) {
  const [s1, s2, fin] = season.playoffs.games;
  const seeds = season.playoffs.seeds;
  if (s1.result && s2.result && !fin.away) {
    const w1 = s1.result.winner, w2 = s2.result.winner;
    const [hi, lo] = seeds.indexOf(w1) < seeds.indexOf(w2) ? [w1, w2] : [w2, w1];
    fin.home = hi; fin.away = lo;
  }
  if (fin.result) { season.playoffs.champion = fin.result.winner; season.phase = 'done'; }
}

export function progress(season) {
  let done = 0, total = 0;
  for (const r of season.schedule) for (const g of r.games) { total++; if (g.result) done++; }
  return { done, total };
}

export function leaders(season) {
  const rows = Object.entries(season.stats).map(([id, s]) => {
    const team = teamById(season, s.team);
    const player = team?.players.find((p) => p.id === id);
    return player ? { id, ...s, player, team } : null;
  }).filter(Boolean);
  const games = Math.max(1, ...standings(season).map((r) => r.W + r.L));
  const minPA = Math.max(3, games * 2.2), minOuts = Math.max(3, games * 2);
  const bat = rows.map((r) => {
    const b = r.bat;
    const avg = b.AB ? b.H / b.AB : 0;
    const obp = (b.AB + b.BB + b.SF) ? (b.H + b.BB) / (b.AB + b.BB + b.SF) : 0;
    const tb = b['1B'] + 2 * b['2B'] + 3 * b['3B'] + 4 * b.HR;
    const slg = b.AB ? tb / b.AB : 0;
    return { ...r, avg, obp, slg, ops: obp + slg };
  });
  const pit = rows.filter((r) => r.pit.outs > 0).map((r) => {
    const p = r.pit;
    return { ...r, ra3: p.outs ? (p.R * 9) / p.outs : 0, whip: p.outs ? (p.H + p.BB) / (p.outs / 3) : 0, k3: p.outs ? (p.K * 9) / p.outs : 0 };
  });
  const top = (arr, key, n = 8, filt = () => true, asc = false) => arr.filter(filt).sort((a, b) => (asc ? a[key] - b[key] : b[key] - a[key])).slice(0, n);
  return {
    avg: top(bat, 'avg', 8, (r) => r.bat.PA >= minPA),
    ops: top(bat, 'ops', 8, (r) => r.bat.PA >= minPA),
    hr: top(bat.map((r) => ({ ...r, hr: r.bat.HR })), 'hr'),
    rbi: top(bat.map((r) => ({ ...r, rbi: r.bat.RBI })), 'rbi'),
    ra3: top(pit, 'ra3', 8, (r) => r.pit.outs >= minOuts, true),
    k: top(pit.map((r) => ({ ...r, k: r.pit.K })), 'k'),
    w: top(pit.map((r) => ({ ...r, w: r.pit.W })), 'w'),
    peg: top(rows.map((r) => ({ ...r, peg: r.fld.PEG })), 'peg'),
    velo: top(pit.map((r) => ({ ...r, velo: r.pit.maxVelo })), 'velo'),
  };
}
