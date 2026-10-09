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
  homeToFirst: 40 * FT,
  firstToSecond: 40 * FT,
  secondToThird: 40 * FT,
  thirdToHome: 40 * FT,
  foulAngleDeg: 90,             // angle between the two foul lines (assumed 90°)
  moundToZone: 35 * FT,         // pitcher's mound to the PVC strike zone
  zoneBehindHome: 4 * FT,       // strike zone sits 4 ft behind home plate
  zoneWidth: 23 * IN,
  zoneHeight: 28 * IN,
  zoneBottom: 17 * IN,
  pvcRadius: 0.5 * IN,          // ~1" PVC pipe
  plateGap: 2 * IN,             // tin plate hangs inside the frame, zip-tied with this gap to the pipes
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
FIELD.plateW = FIELD.zoneWidth - 2 * FIELD.plateGap;
FIELD.plateH = FIELD.zoneHeight - 2 * FIELD.plateGap;

const half = (FIELD.foulAngleDeg / 2) * Math.PI / 180;
FIELD.foulHalfAngle = half;
// Bases: [home, first, second, third] as [x, z]
const first = [Math.sin(half) * FIELD.homeToFirst, Math.cos(half) * FIELD.homeToFirst];
const third = [-Math.sin(half) * FIELD.thirdToHome, Math.cos(half) * FIELD.thirdToHome];
const secondZ = first[1] + Math.sqrt(Math.max(0, FIELD.firstToSecond ** 2 - first[0] ** 2));
FIELD.bases = [[0, 0], first, [0, secondZ], third];
FIELD.baseDist = [FIELD.homeToFirst, FIELD.firstToSecond, FIELD.secondToThird, FIELD.thirdToHome];

// Fence: connected straight panels of equal length, forming one smooth polyline from foul line to
// foul line. Each panel's midpoint sits at its listed distance from home (60/65/70/65/60 ft).
// Solved numerically from the center panel outward (expects an odd, symmetric list of distances).
function buildFence() {
  const D = FIELD.fencePanels;
  const n = D.length, c = (n - 1) / 2;
  const bisect = (f, lo, hi, it = 60) => {
    const flo = f(lo);
    for (let i = 0; i < it; i++) { const m = (lo + hi) / 2; if ((f(m) > 0) === (flo > 0)) lo = m; else hi = m; }
    return (lo + hi) / 2;
  };
  // Heading for the next panel whose midpoint hits the target distance, closest to going straight.
  const root = (f, prev) => {
    const s0 = f(prev) > 0, step = Math.PI / 180;
    for (let k = 1; k <= 120; k++) {
      if ((f(prev + k * step) > 0) !== s0) return bisect(f, prev + (k - 1) * step, prev + k * step);
      if ((f(prev - k * step) > 0) !== s0) return bisect(f, prev - k * step, prev - (k - 1) * step);
    }
    return prev;
  };
  // Given panel length L, walk left from the center panel; return the left-end vertex chain.
  const chain = (L) => {
    const left = [[-L / 2, D[c]]];               // left end of the center panel (z = its distance)
    let prevAng = Math.PI;                        // heading of the previous panel (walking leftward)
    for (let k = c - 1; k >= 0; k--) {
      const v = left[left.length - 1];
      const mid = (ang) => Math.hypot(v[0] + Math.cos(ang) * L / 2, v[1] + Math.sin(ang) * L / 2) - D[k];
      const ang = root(mid, prevAng);
      left.push([v[0] + Math.cos(ang) * L, v[1] + Math.sin(ang) * L]);
      prevAng = ang;
    }
    return left;
  };
  // Choose L so the outermost vertex lands on the foul line.
  const endAngle = (L) => { const ch = chain(L); const e = ch[ch.length - 1]; return Math.atan2(-e[0], e[1]) - half; };
  const L = bisect(endAngle, 12 * FT, 26 * FT);
  const left = chain(L).reverse();                // V0 (left foul line) ... left end of center panel
  const verts = [...left, ...left.slice().reverse().map(([x, z]) => [-x, z])];
  const segs = [], panels = [];
  for (let i = 0; i < n; i++) {
    const a = verts[i], b = verts[i + 1];
    const dx = b[0] - a[0], dz = b[1] - a[1], len = Math.hypot(dx, dz);
    let nrm = [dz / len, -dx / len];               // perpendicular; make it point away from home
    const m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    if (nrm[0] * m[0] + nrm[1] * m[1] < 0) nrm = [-nrm[0], -nrm[1]];
    segs.push({ a, b, n: nrm, panel: i });
    panels.push({ d: D[i], p0: a, p1: b, u: nrm, len });
  }
  return { segs, panels, verts, length: L };
}
const fence = buildFence();
FIELD.fenceSegs = fence.segs;
FIELD.fencePanelInfo = fence.panels;
FIELD.fenceVerts = fence.verts;
FIELD.fencePanelLength = fence.length;

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
