// League persistence (browser localStorage). Everything degrades gracefully if storage is blocked.
import { generateLeague, normalizePlayer } from './data/players.js';
import { TEAM_DEFS, teamAbbr } from './data/teams.js';

const LEAGUE_KEY = 'ncc-wiffs.league.v1';
const SEASON_KEY = 'ncc-wiffs.season.v1';
const PREFS_KEY = 'ncc-wiffs.prefs.v1';

function read(key) { try { const s = localStorage.getItem(key); return s ? JSON.parse(s) : null; } catch { return null; } }
function write(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); return true; } catch { return false; } }
function remove(key) { try { localStorage.removeItem(key); } catch { /* ignore */ } }

export function loadLeague() {
  const saved = read(LEAGUE_KEY);
  if (saved && Array.isArray(saved.teams) && saved.teams.length) {
    saved.teams.forEach((t) => { t.players = (t.players || []).map(normalizePlayer); t.abbr = teamAbbr(t.name); });
    return saved.teams;
  }
  return generateLeague();
}
export function saveLeague(teams) { return write(LEAGUE_KEY, { version: 1, teams }); }
export function resetLeague(seed) { const teams = generateLeague(seed ?? Math.floor(Math.random() * 1e9)); saveLeague(teams); return teams; }

export function exportLeagueJSON(teams) { return JSON.stringify({ app: 'ncc-wiffs', version: 1, teams }, null, 2); }
export function importLeagueJSON(text) {
  const data = JSON.parse(text);
  const teams = Array.isArray(data) ? data : data.teams;
  if (!Array.isArray(teams)) throw new Error('No "teams" array found');
  return teams.map((t, i) => ({
    id: t.id || TEAM_DEFS[i]?.id || `T${i}`,
    name: String(t.name || TEAM_DEFS[i]?.name || `Team ${i + 1}`),
    abbr: teamAbbr(t.name || TEAM_DEFS[i]?.name),
    color: /^#[0-9a-f]{6}$/i.test(t.color || '') ? t.color : (TEAM_DEFS[i]?.color || '#888888'),
    players: (t.players || []).map(normalizePlayer),
  }));
}

export const loadSeason = () => {
  const s = read(SEASON_KEY);
  if (s?.teams) s.teams.forEach((t) => { t.abbr = teamAbbr(t.name); });
  return s;
};
export const saveSeason = (s) => write(SEASON_KEY, s);
export const clearSeason = () => remove(SEASON_KEY);
export const loadPrefs = () => read(PREFS_KEY) || {};
export const savePrefs = (p) => write(PREFS_KEY, p);
