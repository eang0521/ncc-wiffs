// Calibration: pitch/swing outcome distributions per tier (no fielding).
import { RNG } from '../js/util/rng.js';
import { generatePlayer } from '../js/data/players.js';
import { buildPitch, choosePitch, fatigueLevel } from '../js/sim/pitching.js';
import { batterAction } from '../js/sim/batting.js';
import { makeBall, stepBall } from '../js/sim/physics.js';
import { FT, MPH, FIELD } from '../js/config.js';
const rng = new RNG(7);
for (const tier of ['JH','HS','COL','PRO']) {
  let n=0, inZ=0, sw=0, con=0, foulBack=0, hr=0, fair=0; const exits=[], launches=[], dists=[], mphs=[], brks=[];
  for (let k=0;k<3000;k++){
    const pit = generatePlayer(rng,{tier,ace:true}), bat = generatePlayer(rng,{tier});
    const count = {balls:rng.int(0,3), strikes:rng.int(0,2)};
    const plan = choosePitch({pitcher:pit,batter:bat,count,famFor:()=>0,rng,fatigue:0,warningUsed:false});
    const pitch = buildPitch({pitcher:pit, ...plan, fatigue:0, rng});
    mphs.push(pitch.radar); brks.push(pitch.breakMag/FT);
    const res = batterAction({pitch,batter:bat,count,famCount:0,fbMph:pit.pitch.velocity,rng});
    n++; if (res.cross.inZone && !res.cross.grounded) inZ++;
    if (res.swing) sw++;
    if (res.contact){ con++; const c=res.contact; exits.push(c.exit/MPH); launches.push(c.launch);
      if (c.v[2] < 0 || Math.abs(c.spray)>45) { foulBack++; continue; }
      fair++;
      const b = makeBall(c.p,c.v); let over=false;
      while(!b.grounded && b.t<6 && !over){ const ev=stepBall(b,1/240); if(ev.some(e=>e.type==='overFence')) over=true; }
      dists.push(Math.hypot(b.p[0],b.p[2])/FT); if(over) hr++;
    }
  }
  const pct=(a)=> (100*a/n).toFixed(1)+'%';
  const q=(arr,p)=>{const s=[...arr].sort((a,b)=>a-b);return s[Math.floor(p*(s.length-1))]?.toFixed(0)};
  console.log(`${tier}: zone ${pct(inZ)} swing ${pct(sw)} contact/swing ${(100*con/sw).toFixed(0)}% foulish ${(100*foulBack/Math.max(1,con)).toFixed(0)}% HR/fairBIP ${(100*hr/Math.max(1,fair)).toFixed(1)}%`);
  console.log(`   mph p10/50/90 ${q(mphs,.1)}/${q(mphs,.5)}/${q(mphs,.9)} brk ft ${q(brks,.5)}/${q(brks,.9)} exit ${q(exits,.1)}/${q(exits,.5)}/${q(exits,.9)} launch ${q(launches,.1)}/${q(launches,.5)}/${q(launches,.9)} carry ${q(dists,.1)}/${q(dists,.5)}/${q(dists,.9)}`);
}
