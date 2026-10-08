// Player schema, random generator, and JSON/CSV import-export.
import { RNG, clamp } from '../util/rng.js';
import { FIRST_NAMES, LAST_NAMES } from './names.js';
import { TEAM_DEFS } from './teams.js';
import { PITCH_TYPES, PITCH_KEYS, ARM_SLOTS } from '../sim/pitching.js';

export const TIERS = {
  JH:  { name: 'Junior High',   age: [12, 14], mean: 36, sd: 10, velo: 38, veloSd: 4, lvl: 3.5 },
  HS:  { name: 'High School',   age: [15, 18], mean: 48, sd: 11, velo: 45, veloSd: 4.5, lvl: 4.8 },
  COL: { name: 'College',       age: [19, 22], mean: 59, sd: 11, velo: 51, veloSd: 4.5, lvl: 6.0 },
  PRO: { name: 'Early Career',  age: [23, 29], mean: 66, sd: 10, velo: 56, veloSd: 4.5, lvl: 6.8 },
};

export const RATING_FIELDS = [
  ['bat', 'contact', 'Contact'], ['bat', 'power', 'Power'], ['bat', 'eye', 'Eye'],
  ['field', 'speed', 'Speed'], ['field', 'fielding', 'Fielding'], ['field', 'arm', 'Arm'], ['field', 'accuracy', 'Accuracy'],
  ['pitch', 'control', 'Control'], ['pitch', 'movement', 'Movement'], ['pitch', 'stamina', 'Stamina'],
];

let idCounter = 0;
export const newId = () => 'p' + Date.now().toString(36) + (idCounter++).toString(36) + Math.floor(Math.random() * 1e4).toString(36);

const r100 = (rng, mean, sd) => Math.round(clamp(rng.normal(mean, sd), 5, 99));

export function generatePlayer(rng, opts = {}) {
  const tierKey = opts.tier || rng.weighted(Object.keys(TIERS), (k) => ({ JH: 0.15, HS: 0.35, COL: 0.3, PRO: 0.2 })[k]);
  const T = TIERS[tierKey];
  const ace = !!opts.ace;
  const throws = rng.chance(0.82) ? 'R' : 'L';
  const bats = rng.chance(0.12) ? (throws === 'R' ? 'L' : 'R') : (rng.chance(0.9) ? throws : (throws === 'R' ? 'L' : 'R'));
  const m = T.mean, s = T.sd;
  const armSlot = rng.weighted(Object.keys(ARM_SLOTS), (k) => ({ over: 0.25, three: 0.35, side: 0.3, under: 0.1 })[k]);
  const pBoost = ace ? 9 : -6;
  const p = {
    id: newId(),
    name: `${rng.pick(FIRST_NAMES)} ${rng.pick(LAST_NAMES)}`,
    number: rng.int(0, 99),
    tier: tierKey,
    age: rng.int(T.age[0], T.age[1]),
    bats, throws,
    bat: { contact: r100(rng, m, s), power: r100(rng, m - 2, s + 2), eye: r100(rng, m, s) },
    field: { speed: r100(rng, m + 2, s), fielding: r100(rng, m, s), arm: r100(rng, m, s), accuracy: r100(rng, m, s) },
    pitch: {
      velocity: Math.round(clamp(rng.normal(T.velo + (ace ? 3 : -2), T.veloSd), 28, 64)),
      control: r100(rng, m + pBoost, s), movement: r100(rng, m + pBoost, s), stamina: r100(rng, m + pBoost / 2, s),
      armSlot, arsenal: [],
    },
  };
  p.pitch.arsenal = generateArsenal(rng, armSlot, T.lvl + (ace ? 1.4 : -0.8), ace ? rng.int(3, 4) : rng.int(1, 3));
  return p;
}

function generateArsenal(rng, slot, lvlMean, n) {
  const pref = {
    over: { drop: 3, curve: 3, changeup: 2, fastball: 3, slider: 1, screwball: 1, knuckleball: 0.5, cutter: 1 },
    three: { curve: 2, slider: 3, drop: 2, fastball: 3, changeup: 2, screwball: 1.5, cutter: 1.5, sinker: 1, knuckleball: 0.5 },
    side: { riser: 3, slider: 3, sweeper: 2.5, screwball: 2, fastball: 2, riseslider: 1.5, sinker: 1.5, knuckleball: 0.7 },
    under: { riser: 4, riseslider: 2.5, screwball: 1.5, fastball: 1.5, changeup: 1.5, knuckleball: 1 },
  }[slot] || {};
  const out = [];
  const pool = PITCH_KEYS.slice();
  while (out.length < n && pool.length) {
    const k = rng.weighted(pool, (x) => pref[x] || 0.2);
    pool.splice(pool.indexOf(k), 1);
    out.push({ type: k, level: Math.round(clamp(rng.normal(lvlMean, 1.6), 1, 10)) });
  }
  out.sort((a, b) => b.level - a.level);
  return out;
}

export function generateRoster(rng, size = 4) {
  const players = [];
  for (let i = 0; i < size; i++) players.push(generatePlayer(rng, { ace: i === 0 || (i === 1 && rng.chance(0.4)) }));
  return players;
}

export function generateLeague(seed = 20261008) {
  const rng = new RNG(seed);
  return TEAM_DEFS.map((t) => ({ ...t, players: generateRoster(rng, 4) }));
}

/** Coerce arbitrary imported data into a valid player. */
export function normalizePlayer(raw) {
  const num = (v, d, lo = 1, hi = 99) => { const n = Number(v); return Number.isFinite(n) ? clamp(Math.round(n), lo, hi) : d; };
  const p = raw || {};
  const out = {
    id: p.id || newId(),
    name: String(p.name || 'Player').slice(0, 40),
    number: num(p.number, 0, 0, 99),
    tier: TIERS[p.tier] ? p.tier : 'HS',
    age: num(p.age, 16, 8, 60),
    bats: p.bats === 'L' ? 'L' : 'R',
    throws: p.throws === 'L' ? 'L' : 'R',
    bat: { contact: num(p.bat?.contact, 50), power: num(p.bat?.power, 50), eye: num(p.bat?.eye, 50) },
    field: { speed: num(p.field?.speed, 50), fielding: num(p.field?.fielding, 50), arm: num(p.field?.arm, 50), accuracy: num(p.field?.accuracy, 50) },
    pitch: {
      velocity: num(p.pitch?.velocity, 45, 20, 75),
      control: num(p.pitch?.control, 50), movement: num(p.pitch?.movement, 50), stamina: num(p.pitch?.stamina, 50),
      armSlot: ARM_SLOTS[p.pitch?.armSlot] ? p.pitch.armSlot : 'three',
      arsenal: Array.isArray(p.pitch?.arsenal) ? p.pitch.arsenal.filter((a) => PITCH_TYPES[a.type]).map((a) => ({ type: a.type, level: num(a.level, 5, 1, 10) })) : [],
    },
  };
  if (!out.pitch.arsenal.length) out.pitch.arsenal = [{ type: 'fastball', level: 5 }];
  return out;
}

// ---------------- CSV ----------------
export const CSV_COLUMNS = ['team', 'name', 'number', 'tier', 'age', 'bats', 'throws', 'contact', 'power', 'eye', 'speed', 'fielding', 'arm', 'accuracy', 'velocity', 'control', 'movement', 'stamina', 'armSlot', 'pitches'];

export function playersToCSV(teams) {
  const esc = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const rows = [CSV_COLUMNS.join(',')];
  for (const t of teams) for (const p of t.players) {
    rows.push([t.name, p.name, p.number, p.tier, p.age, p.bats, p.throws, p.bat.contact, p.bat.power, p.bat.eye,
      p.field.speed, p.field.fielding, p.field.arm, p.field.accuracy, p.pitch.velocity, p.pitch.control, p.pitch.movement,
      p.pitch.stamina, p.pitch.armSlot, p.pitch.arsenal.map((a) => `${a.type}:${a.level}`).join(';')].map(esc).join(','));
  }
  return rows.join('\n');
}

function parseCSV(text) {
  const rows = []; let row = []; let cur = ''; let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cur); rows.push(row); row = []; cur = '';
    } else cur += c;
  }
  if (cur.length || row.length) { row.push(cur); rows.push(row); }
  return rows.filter((r) => r.some((x) => x.trim() !== ''));
}

/** Returns { byTeam: Map(teamName -> players[]) , errors[] } */
export function playersFromCSV(text) {
  const rows = parseCSV(text.trim());
  const header = rows.shift().map((h) => h.trim());
  const idx = (k) => header.findIndex((h) => h.toLowerCase() === k.toLowerCase());
  const byTeam = new Map();
  const errors = [];
  rows.forEach((r, i) => {
    const g = (k) => { const j = idx(k); return j >= 0 ? r[j]?.trim() : undefined; };
    const team = g('team');
    if (!team) { errors.push(`Row ${i + 2}: missing team`); return; }
    const arsenal = (g('pitches') || '').split(/[;|]/).map((s) => s.trim()).filter(Boolean).map((s) => {
      const [type, level] = s.split(':');
      return { type: type.trim().toLowerCase(), level: Number(level || 5) };
    });
    const p = normalizePlayer({
      name: g('name'), number: g('number'), tier: (g('tier') || '').toUpperCase(), age: g('age'), bats: (g('bats') || 'R').toUpperCase(), throws: (g('throws') || 'R').toUpperCase(),
      bat: { contact: g('contact'), power: g('power'), eye: g('eye') },
      field: { speed: g('speed'), fielding: g('fielding'), arm: g('arm'), accuracy: g('accuracy') },
      pitch: { velocity: g('velocity'), control: g('control'), movement: g('movement'), stamina: g('stamina'), armSlot: (g('armSlot') || 'three').toLowerCase(), arsenal },
    });
    if (!byTeam.has(team)) byTeam.set(team, []);
    byTeam.get(team).push(p);
  });
  return { byTeam, errors };
}

export function overall(p) {
  const b = (p.bat.contact * 1.2 + p.bat.power + p.bat.eye) / 3.2;
  const f = (p.field.fielding + p.field.arm + p.field.accuracy + p.field.speed) / 4;
  return Math.round(b * 0.6 + f * 0.4);
}
export function pitchingOverall(p) {
  const v = clamp((p.pitch.velocity - 28) / 34 * 100, 0, 100);
  const lv = p.pitch.arsenal.reduce((a, x) => a + x.level, 0) / Math.max(1, p.pitch.arsenal.length) * 10;
  return Math.round(v * 0.3 + p.pitch.control * 0.3 + p.pitch.movement * 0.25 + lv * 0.15);
}
