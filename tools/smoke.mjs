// Headless smoke test: simulate many games and print league-wide rate stats.
import { generateLeague } from '../js/data/players.js';
import { Game } from '../js/sim/game.js';
const N = Number(process.argv[2] || 40);
const league = generateLeague(1);
const agg = { R:0, H:0, HR:0, BB:0, K:0, PA:0, AB:0, '2B':0,'3B':0, E:0, PEG:0, pitches:0, games:0, extra:0, changes:0, warn:0, auto:0, SF:0, FC:0, ROE:0 };
const outsHow = {};
const t0 = Date.now();
let sample = null;
for (let g = 0; g < N; g++) {
  const a = league[g % 16], h = league[(g * 7 + 3) % 16 === g % 16 ? (g + 1) % 16 : (g * 7 + 3) % 16];
  const game = new Game({ away: a, home: h, seed: 1000 + g });
  const recs = [];
  let guard = 0;
  while (!game.over && guard++ < 3000) { const r = game.simPitch({ record: g === 0 }); if (r?.play) for (const o of (r.play.events||[]).filter(e=>e.type==='out')) outsHow[o.how]=(outsHow[o.how]||0)+1; }
  if (guard >= 3000) console.log('GUARD HIT game', g);
  agg.games++; if (game.inning > game.innings) agg.extra++;
  for (const t of game.teams) for (const id of t.order) {
    const s = t.stats[id];
    for (const k of ['R','H','HR','BB','K','PA','AB','2B','3B','SF','FC','ROE']) agg[k] += s.bat[k];
    agg.E += s.fld.E; agg.PEG += s.fld.PEG; agg.pitches += s.pit.P; agg.warn += s.pit.warn; agg.auto += s.pit.auto;
  }
  agg.changes += game.log.filter(l=>l.text.startsWith('Pitching change')).length;
  if (g === 0) sample = game;
}
const per = (k) => (agg[k] / agg.games / 2).toFixed(2);
console.log(`${N} games in ${Date.now()-t0}ms. Per team per game: R ${per('R')} H ${per('H')} HR ${per('HR')} 2B ${per('2B')} 3B ${per('3B')} BB ${per('BB')} K ${per('K')} PA ${per('PA')} E ${per('E')} PEG ${per('PEG')} FC ${per('FC')} ROE ${per('ROE')}`);
console.log(`AVG ${(agg.H/agg.AB).toFixed(3)} K% ${(100*agg.K/agg.PA).toFixed(1)} BB% ${(100*agg.BB/agg.PA).toFixed(1)} pitches/game ${(agg.pitches/agg.games).toFixed(0)} extra-inning games ${agg.extra} pitching changes/game ${(agg.changes/agg.games).toFixed(2)} warnings ${agg.warn} autoballs ${agg.auto}`);
console.log('outs by type (in play):', outsHow);
console.log(sample.log.slice(0, 40).map(l => l.text).join('\n'));
