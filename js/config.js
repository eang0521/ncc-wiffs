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

// Fence: one smooth arc from foul line to foul line. The fair arc is split into equal sectors (one per
// panel); the fence distance passes exactly through each panel's listed distance at the panel's
// center angle (60/65/70/65/60 ft) and is interpolated smoothly (Catmull-Rom) in between. The curve
// is sampled into short straight pieces for physics and rendering.
function buildFence() {
  const D = FIELD.fencePanels;
  const n = D.length;
  const sector = (2 * half) / n;
  const centers = D.map((d, i) => ({ ang: -half + sector * (i + 0.5), d }));
  // control points, extrapolated one sector past each end
  const P = [2 * D[0] - D[1], ...D, 2 * D[n - 1] - D[n - 2]];
  const radiusAt = (ang) => {
    const u = (ang + half) / sector - 0.5 + 1;      // position in control-point index space
    const i = Math.max(1, Math.min(n, Math.floor(u)));
    const t = u - i;
    const p0 = P[i - 1], p1 = P[i], p2 = P[Math.min(P.length - 1, i + 1)], p3 = P[Math.min(P.length - 1, i + 2)];
    return 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t + (-p0 + 3 * p1 - 3 * p2 + p3) * t * t * t);
  };
  const N = 18 * n;
  const pts = [];
  for (let k = 0; k <= N; k++) {
    const ang = -half + (2 * half * k) / N;
    const r = radiusAt(ang);
    pts.push([Math.sin(ang) * r, Math.cos(ang) * r]);
  }
  const segs = [];
  for (let k = 0; k < N; k++) {
    const a = pts[k], b = pts[k + 1];
    const dx = b[0] - a[0], dz = b[1] - a[1], len = Math.hypot(dx, dz);
    let nrm = [dz / len, -dx / len];
    if (nrm[0] * (a[0] + b[0]) + nrm[1] * (a[1] + b[1]) < 0) nrm = [-nrm[0], -nrm[1]];
    const mid = Math.atan2((a[0] + b[0]) / 2, (a[1] + b[1]) / 2);
    segs.push({ a, b, n: nrm, panel: Math.max(0, Math.min(n - 1, Math.floor((mid + half) / sector))) });
  }
  return { segs, pts, centers, radiusAt, sector };
}
const fence = buildFence();
FIELD.fenceSegs = fence.segs;
FIELD.fencePoints = fence.pts;
FIELD.fenceCenters = fence.centers;
FIELD.fenceRadiusAt = fence.radiusAt;
FIELD.fenceSector = fence.sector;

/** Keep a point (engine [x, z]) on the field side of the fence, `margin` meters off its face. */
FIELD.clampInsideFence = (p, margin = 0.35) => {
  const ang = Math.atan2(p[0], p[1]);
  if (p[1] <= 0 || Math.abs(ang) > half) return p;           // foul ground: no fence there
  const r = Math.hypot(p[0], p[1]);
  const R = fence.radiusAt(ang) - margin;
  if (r <= R) return p;
  return [p[0] * R / r, p[1] * R / r];
};
/** Distance beyond the fence face (positive = outside the field), fair territory only. */
FIELD.beyondFence = (x, z) => {
  const ang = Math.atan2(x, z);
  if (z <= 0 || Math.abs(ang) > half) return -Infinity;
  return Math.hypot(x, z) - fence.radiusAt(ang);
};

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
