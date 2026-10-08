# NCC Wiffs — 4v4 Wiffle Ball Simulator

A physics-driven 4-v-4 wiffle ball simulator that runs entirely in the browser. Games play automatically in a 3D field (three.js). Every pitch, swing, bounce, throw and baserunning decision is simulated.

Live site (after Pages is enabled): **https://eang0521.github.io/ncc-wiffs/**

## Features

- **Exhibition mode** (featured): pick any two of the 16 league teams and watch in 3D, with
  - 8 playback speeds, pause, and single-pitch stepping
  - instant sims: pitch, at-bat, half inning, full inning, to the last inning, to the final
  - 10 camera angles: auto broadcast, center-field pitcher cam, behind the zone, high home, overhead, 1B/3B side, follow-ball, free orbit
  - live scorebug, radar readout with speed-limit warnings, strike-zone pitch chart, play-by-play, line score and box score
  - **Matchup** panel: batter vs pitcher ratings plus a familiarity table showing how often this batter has seen each of the pitcher's pitches today and the resulting eye boost
  - **Manager** panel: AI or manual control per team. Swap pitchers at any time; the panel shows each pitcher's energy and how familiar the opposing lineup is with his stuff
- **Season mode**: single or double round-robin (15 or 30 games), standings, league leaders, results, a 4-team playoff, and the option to watch any scheduled game in 3D. Saved in your browser.
- **Teams & Players editor**: edit every rating, the pitch arsenal and pitch levels, the batting order, team names and colors. Import and export the league as **JSON** or players as **CSV**.

## League rules implemented

- Field: 45 ft home→1st, 40 ft 1st→2nd, 40 ft 2nd→3rd, 45 ft 3rd→home (foul lines assumed 90° apart).
- Strike zone: a 23"×28" PVC zone, 17" off the ground, set 4 ft behind home and 35 ft from the mound. A pitch through the frame or clipping the pipe is a strike.
- Backstop: 7×7 ft, 4 ft behind the zone. A throw home that hits the zone or the backstop retires the runner heading home.
- Fence: five 4-ft panels at 60/65/70/65/60 ft. On the fly = HR, bounced over = ground-rule double, off the fence = live ball.
- Bunt line 10 ft from home: anything fielded short of it is foul.
- Count is 4 balls / 3 strikes. Fouls are strikes, but with two strikes you can only strike out on a foul tip through the zone.
- No leading off. Tag-ups, pegging and force outs apply.
- Speed limit: radar 63–64 mph is a warning (one per half inning); the next one, or any 65+, is an automatic ball. If such a pitch is put in play, the play stands.
- Games are 3 innings with no mercy rule; extra innings are played as normal.

## Ratings

| Group | Fields |
|---|---|
| Bio | name, number, tier (`JH`, `HS`, `COL`, `PRO` = early career), age, bats, throws |
| Batting | contact, power, eye |
| Fielding | speed, fielding, arm, accuracy |
| Pitching | velocity (top mph), control, movement, stamina, arm slot (`over`, `three`, `side`, `under`) |
| Arsenal | any of `fastball, riser, drop, curve, slider, sweeper, screwball, knuckleball, changeup, cutter, sinker` (screw-drop), `riseslider`, each with a level of 1–10 |

Ratings run 1–99. Pitch level scales that pitch's break, velocity and command.

### CSV format

```
team,name,number,tier,age,bats,throws,contact,power,eye,speed,fielding,arm,accuracy,velocity,control,movement,stamina,armSlot,pitches
Rocky Rangers,Jane Doe,12,COL,20,R,R,62,55,70,60,58,64,61,52,66,71,60,side,riser:8;slider:6;fastball:5
```

Rows are matched to teams by team name (or abbreviation). Each imported team's roster is replaced, and every team needs at least 4 players. The first 4 players are the active lineup.

## Physics summary

- **Ball:** a ~0.75 oz perforated ball with quadratic drag (Cd ≈ 0.40), integrated with RK2. Wiffle balls slow down a lot: a 50 mph pitch reaches the zone at about 30 mph.
- **Pitch break:** modeled as an aerodynamic side force in the pitcher's frame that ramps in late. Pitch type, level, movement, arm slot and fatigue all feed into it. Pitchers aim using the break they expect, and the actual break varies.
- **Swing:**
  - The batter perceives location and timing with errors driven by contact, eye, break, off-speed deception and familiarity.
  - The bat is a thin cylinder swept around the body.
  - Contact uses an impulse model with effective bat mass, a COR that drops off the sweet spot, and friction.
- **Batted balls:** flutter in the air, bounce irregularly, roll, and carom off fence panels and the backstop.
- **Fielders:** predict the ball's path and pick the best interceptor. They react, run and catch according to their ratings. Throws are physically simulated with accuracy error. The fielder chooses between a force, a throw home at the zone, a peg, a tag or a relay.
- **Runners:** estimate the defense's timing to decide on extra bases, retreats and tag-ups.

## Running locally

The site is static (no build step) and uses ES modules, so it must be served over HTTP:

```bash
python tools/serve.py 8124
```

Then open http://localhost:8124. Any static server works, for example `npx serve`.

Headless dev scripts (Node 18+):

```bash
node tools/smoke.mjs 40     # simulate 40 games, print league rate stats
node tools/tune.mjs         # pitch/swing/exit-velocity calibration by tier
node tools/season.mjs       # simulate a full season + playoffs
```

## Deploying to GitHub Pages

```bash
gh repo create eang0521/ncc-wiffs --public --source . --remote origin --push
gh api -X POST repos/eang0521/ncc-wiffs/pages -f "source[branch]=main" -f "source[path]=/"
```

You can also enable Pages in **Settings → Pages → Deploy from branch → `main` / root**.

## Project structure

```
index.html            app shell
css/style.css         styles
js/config.js          field geometry, ball/bat constants, rules
js/sim/physics.js     ball flight, bounces, fence, backstop, zone
js/sim/pitching.js    pitch types, pitch selection AI, physical pitch builder
js/sim/batting.js     perception, swing decision, bat-ball collision
js/sim/play.js        live ball: fielders, throws, pegs, runners, fair/foul
js/sim/game.js        game state, rules, familiarity, fatigue, manager AI, stats
js/league/season.js   schedule, standings, leaders, playoffs
js/render/            three.js field + player figures
js/ui/                live game controller, HUD, season & roster pages
js/data/              teams, name lists, player generator, CSV/JSON
tools/                dev server and headless calibration scripts
```
