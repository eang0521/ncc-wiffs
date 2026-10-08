import { generateLeague } from '../js/data/players.js';
import { createSeason, simNext, standings, leaders, nextGame } from '../js/league/season.js';
const s = createSeason(generateLeague(3), { seed: 5 });
const t0 = Date.now(); let n = 0;
while (nextGame(s)) { simNext(s); n++; }
console.log(n, 'games', Date.now() - t0, 'ms; champion', s.playoffs.champion, s.phase);
console.log(standings(s).slice(0, 5).map(r => `${r.team.abbr} ${r.W}-${r.L} ${r.RS}/${r.RA}`).join(' | '));
const L = leaders(s);
console.log('AVG', L.avg.slice(0, 3).map(r => r.player.name + ' ' + r.avg.toFixed(3) + ' ' + r.team.abbr).join(', '));
console.log('HR', L.hr.slice(0, 3).map(r => r.player.name + ' ' + r.hr).join(', '), '| K', L.k.slice(0,3).map(r=>r.player.name+' '+r.k).join(', '), '| velo', L.velo.slice(0,3).map(r=>r.velo).join(','));
console.log('JSON size', JSON.stringify(s).length);
