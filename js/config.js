// Global constants: units are SI internally (meters, seconds, kg).
// Coordinate system (engine): origin = home plate, +z toward center field,
// +x toward the 1st-base side, +y up.

export const FT = 0.3048;
export const IN = 0.0254;
export const MPH = 0.44704;
export const G = 9.81;

export const toFt = (m) => m / FT;
export const toMph = (ms) => ms / MPH;

// ---------------- Field geometry ----------------
export const FIELD = {
  homeToFirst: 45 * FT,
  firstToSecond: 40 * FT,
  secondToThird: 40 * FT,
  thirdToHome: 45 * FT,
  foulAngleDeg: 90,             // angle between the two foul lines (assumed 90°)
  moundToZone: 35 * FT,         // pitcher's mound to the PVC strike zone
  zoneBehindHome: 4 * FT,       // strike zone sits 4 ft behind home plate
  zoneWidth: 23 * IN,
  zoneHeight: 28 * IN,
  zoneBottom: 17 * IN,
  pvcRadius: 0.5 * IN,          // ~1" PVC pipe
  backstopBehindZone: 4 * FT,
  backstopSize: 7 * FT,         // 7x7 ft
  fencePanels: [60, 65, 70, 65, 60].map((d) => d * FT), // left -> right
  fenceHeight: 4 * FT,
  buntLine: 10 * FT,            // straight left/right, 10 ft out from home
};

FIELD.zoneZ = -FIELD.zoneBehindHome;
FIELD.backstopZ = FIELD.zoneZ - FIELD.backstopBehindZone;
FIELD.moundZ = FIELD.moundToZone + FIELD.zoneZ; // 31 ft in front of home
FIELD.zoneTop = FIELD.zoneBottom + FIELD.zoneHeight;
FIELD.zoneCenterY = FIELD.zoneBottom + FIELD.zoneHeight / 2;

const half = (FIELD.foulAngleDeg / 2) * Math.PI / 180;
FIELD.foulHalfAngle = half;
// Bases: [home, first, second, third] as [x, z]
const first = [Math.sin(half) * FIELD.homeToFirst, Math.cos(half) * FIELD.homeToFirst];
const third = [-Math.sin(half) * FIELD.thirdToHome, Math.cos(half) * FIELD.thirdToHome];
const secondZ = first[1] + Math.sqrt(Math.max(0, FIELD.firstToSecond ** 2 - first[0] ** 2));
FIELD.bases = [[0, 0], first, [0, secondZ], third];
FIELD.baseDist = [FIELD.homeToFirst, FIELD.firstToSecond, FIELD.secondToThird, FIELD.thirdToHome];

// Fence: 5 discrete straight panels. The fair arc is split into equal sectors; each panel is a
// chord across its sector whose midpoint sits at the listed distance. Where neighbouring panels
// sit at different depths, a short connecting return closes the gap (stepped fence).
function buildFence() {
  const n = FIELD.fencePanels.length;
  const sector = (2 * half) / n;
  const dirAt = (a) => [Math.sin(a), Math.cos(a)];
  const segs = [];
  const panels = [];
  for (let i = 0; i < n; i++) {
    const a0 = -half + sector * i, a1 = a0 + sector, am = (a0 + a1) / 2;
    const r = FIELD.fencePanels[i] / Math.cos(sector / 2);
    const p0 = dirAt(a0).map((c) => c * r), p1 = dirAt(a1).map((c) => c * r);
    const u = dirAt(am);
    panels.push({ d: FIELD.fencePanels[i], r, a0, a1, p0, p1, u });
    segs.push({ a: p0, b: p1, n: u, panel: i });
  }
  for (let i = 0; i < n - 1; i++) {
    const A = panels[i], B = panels[i + 1];
    if (Math.abs(A.r - B.r) < 1e-6) continue;
    const a = A.a1;
    const d = dirAt(a);
    const tangent = [Math.cos(a), -Math.sin(a)]; // direction of increasing angle -> toward panel i+1
    // outward normal of the return points toward the shallower panel's sector
    const nrm = A.r < B.r ? [-tangent[0], -tangent[1]] : tangent;
    segs.push({ a: d.map((c) => c * A.r), b: d.map((c) => c * B.r), n: nrm, panel: A.r < B.r ? i : i + 1, connector: true });
  }
  return { segs, panels };
}
const fence = buildFence();
FIELD.fenceSegs = fence.segs;
FIELD.fencePanelInfo = fence.panels;

// ---------------- Ball / physics ----------------
export const BALL = {
  mass: 0.0215,           // ~0.75 oz baseball-size perforated plastic ball
  radius: 0.0365,         // ~9" circumference
  cd: 0.40,               // perforated hollow ball: high drag
  airDensity: 1.2,
};
BALL.area = Math.PI * BALL.radius ** 2;
BALL.k = (0.5 * BALL.airDensity * BALL.cd * BALL.area) / BALL.mass; // drag accel = k * v^2

export const GROUND = {
  restitution: 0.42,       // vertical COR on grass
  bounceFriction: 0.72,    // horizontal speed kept per bounce
  rollDecel: 2.6,          // m/s^2 rolling resistance on grass
  restSpeed: 0.12,
};

export const BAT = {
  radius: 0.65 * IN,       // thin plastic wiffle bat
  length: 32 * IN,
  handleOffset: 0.24,      // pivot (body) to hands, meters
  sweet: 0.84,             // pivot to sweet spot
  inertia: 0.16,           // kg*m^2 effective (bat + arms) about pivot
  cor: 0.2,
};

// ---------------- Rules ----------------
export const RULES = {
  innings: 3,
  balls: 4,
  strikes: 3,
  outs: 3,
  speedWarnMin: 63,        // 63-64 => warning (once per half inning)
  speedAutoBall: 65,       // 65+ => automatic ball
  playersPerSide: 4,
};

export const POSITIONS = ['P', '1B', 'SS', 'OF'];
