// three.js field renderer and playback of engine records.
// Engine coords: +x = 1st-base side, +z = center field. three.js coords mirror x so that the view
// from behind home plate shows 1st base on the right.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { FIELD, FT, BAT, BALL } from '../config.js';
import { makeFigure, pose, labelSprite } from './figures.js';
import { accentFor } from '../data/teams.js';

const E = (x, y, z) => new THREE.Vector3(-x, y, z);
const CONTACT_Z = 0.22;
const BENCH = [
  // away bench: 3B side; home bench: 1B side (engine coords)
  [[-9.5, 1.5], [-10.3, 3.0], [-9.6, 4.5], [-10.4, 6.0], [-9.5, 7.5]],
  [[9.5, 1.5], [10.3, 3.0], [9.6, 4.5], [10.4, 6.0], [9.5, 7.5]],
];

function grassTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 512;
  const g = c.getContext('2d');
  for (let i = 0; i < 8; i++) {
    g.fillStyle = i % 2 ? '#4f8a3a' : '#5c9a44';
    g.fillRect(0, i * 64, 512, 64);
  }
  const img = g.getImageData(0, 0, 512, 512);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (Math.random() - 0.5) * 18;
    img.data[i] += n; img.data[i + 1] += n; img.data[i + 2] += n * 0.5;
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

function textTexture(text, { w = 256, h = 128, fg = '#fff', bg = null, font = 'bold 84px system-ui' } = {}) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d');
  if (bg) { g.fillStyle = bg; g.fillRect(0, 0, w, h); }
  g.fillStyle = fg; g.font = font; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(text, w / 2, h / 2 + 4);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function tubeBetween(a, b, r, mat) {
  const dir = new THREE.Vector3().subVectors(b, a);
  const len = dir.length();
  const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, 10), mat);
  m.position.copy(a).addScaledVector(dir, 0.5);
  m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
  m.castShadow = true;
  return m;
}

export class FieldView {
  constructor(container) {
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    container.appendChild(this.renderer.domElement);
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x9cc8ea);
    this.scene.fog = new THREE.Fog(0xb5d6ee, 55, 140);
    this.camera = new THREE.PerspectiveCamera(48, 1, 0.05, 400);
    this.camPos = new THREE.Vector3(); this.camLook = new THREE.Vector3();
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enabled = false;
    this.controls.target.set(0, 0, 8);
    this.cameraMode = 'auto';
    this.speed = 1;
    this.paused = false;
    this.showLabels = true;
    this.showTrail = true;
    this.figures = new Map();
    this.rec = null;
    this.t = 0;
    this._buildWorld();
    this._buildBall();
    this.resize();
    window.addEventListener('resize', () => this.resize());
    this._last = performance.now();
    this._loop = this._loop.bind(this);
    requestAnimationFrame(this._loop);
  }

  resize() {
    const w = this.container.clientWidth || 800, h = this.container.clientHeight || 450;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  // ---------------- World ----------------
  _buildWorld() {
    const S = this.scene;
    const hemi = new THREE.HemisphereLight(0xdbeeff, 0x3d5a2a, 0.9);
    S.add(hemi);
    const sun = new THREE.DirectionalLight(0xfff3dd, 2.1);
    sun.position.set(-18, 30, -10);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const sc = sun.shadow.camera;
    sc.left = -30; sc.right = 30; sc.top = 30; sc.bottom = -30; sc.near = 1; sc.far = 90;
    sun.shadow.bias = -0.0005;
    sun.target.position.set(0, 0, 10);
    S.add(sun, sun.target);

    // Ground
    const tex = grassTexture();
    tex.repeat.set(18, 18);
    tex.rotation = Math.PI / 4;
    const ground = new THREE.Mesh(new THREE.CircleGeometry(160, 64), new THREE.MeshStandardMaterial({ map: tex, roughness: 1 }));
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    S.add(ground);

    const white = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.6 });
    const chalk = new THREE.MeshBasicMaterial({ color: 0xf4f4f0 });
    const line = (a, b, w = 0.05) => {
      const dx = b[0] - a[0], dz = b[1] - a[1];
      const len = Math.hypot(dx, dz);
      const m = new THREE.Mesh(new THREE.PlaneGeometry(w, len), chalk);
      m.rotation.x = -Math.PI / 2;
      m.rotation.z = Math.atan2(-dx, dz);
      m.position.copy(E((a[0] + b[0]) / 2, 0.012, (a[1] + b[1]) / 2));
      S.add(m);
    };
    const h = FIELD.foulHalfAngle;
    const far = 30;
    line([0, 0], [Math.sin(h) * far, Math.cos(h) * far]);
    line([0, 0], [-Math.sin(h) * far, Math.cos(h) * far]);
    // bunt line, straight across 10 ft out
    const bl = FIELD.buntLine;
    line([-bl * Math.tan(h) - 0.6, bl], [bl * Math.tan(h) + 0.6, bl], 0.045);
    // base paths (faint)
    const pathMat = new THREE.MeshBasicMaterial({ color: 0x4a7a33, transparent: true, opacity: 0.55 });
    for (let i = 0; i < 4; i++) {
      const a = FIELD.bases[i], b = FIELD.bases[(i + 1) % 4];
      const dx = b[0] - a[0], dz = b[1] - a[1];
      const len = Math.hypot(dx, dz);
      const m = new THREE.Mesh(new THREE.PlaneGeometry(0.8, len), pathMat);
      m.rotation.x = -Math.PI / 2; m.rotation.z = Math.atan2(-dx, dz);
      m.position.copy(E((a[0] + b[0]) / 2, 0.006, (a[1] + b[1]) / 2));
      S.add(m);
    }
    // bases
    for (let i = 1; i < 4; i++) {
      const b = FIELD.bases[i];
      const m = new THREE.Mesh(new THREE.BoxGeometry(0.38, 0.05, 0.38), white);
      m.position.copy(E(b[0], 0.025, b[1]));
      m.rotation.y = Math.PI / 4;
      m.castShadow = true; m.receiveShadow = true;
      S.add(m);
    }
    // home plate
    const hp = new THREE.Shape();
    const w = 0.216, d = 0.216;
    hp.moveTo(-w, 0); hp.lineTo(w, 0); hp.lineTo(w, d * 0.5); hp.lineTo(0, d); hp.lineTo(-w, d * 0.5); hp.lineTo(-w, 0);
    const plate = new THREE.Mesh(new THREE.ShapeGeometry(hp), white);
    plate.rotation.x = -Math.PI / 2;
    plate.position.set(0, 0.014, 0.0);
    S.add(plate);
    // pitcher's rubber
    const rub = new THREE.Mesh(new THREE.BoxGeometry(0.61, 0.03, 0.15), white);
    rub.position.copy(E(0, 0.015, FIELD.moundZ));
    S.add(rub);

    // PVC strike zone + stand
    const pvc = new THREE.MeshStandardMaterial({ color: 0xf6f6f2, roughness: 0.35 });
    const zw = FIELD.zoneWidth / 2, zb = FIELD.zoneBottom, zt = FIELD.zoneTop, zz = FIELD.zoneZ, r = FIELD.pvcRadius;
    const C = [E(-zw, zb, zz), E(zw, zb, zz), E(zw, zt, zz), E(-zw, zt, zz)];
    for (let i = 0; i < 4; i++) S.add(tubeBetween(C[i], C[(i + 1) % 4], r, pvc));
    for (const sx of [-1, 1]) {
      S.add(tubeBetween(E(sx * zw, 0.02, zz), E(sx * zw, zb, zz), r, pvc));
      S.add(tubeBetween(E(sx * zw, 0.02, zz - 0.25), E(sx * zw, 0.02, zz + 0.25), r, pvc));
    }
    // backstop board
    const bs = FIELD.backstopSize;
    const back = new THREE.Mesh(new THREE.BoxGeometry(bs, bs, 0.04), new THREE.MeshStandardMaterial({ color: 0x24303a, roughness: 0.9 }));
    back.position.copy(E(0, bs / 2, FIELD.backstopZ - 0.02));
    back.castShadow = true; back.receiveShadow = true;
    S.add(back);
    for (const sx of [-1, 1]) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.09, bs + 0.15, 0.09), new THREE.MeshStandardMaterial({ color: 0x8a6a45 }));
      post.position.copy(E(sx * (bs / 2 + 0.04), (bs + 0.15) / 2, FIELD.backstopZ - 0.06));
      post.castShadow = true;
      S.add(post);
    }

    // Fence panels
    const pad = new THREE.MeshStandardMaterial({ color: 0x1f4e79, roughness: 0.85 });
    const cap = new THREE.MeshStandardMaterial({ color: 0xf2c230, roughness: 0.5 });
    for (const s of FIELD.fenceSegs) {
      const a = s.a, b = s.b;
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const H = FIELD.fenceHeight;
      const grp = new THREE.Group();
      const panel = new THREE.Mesh(new THREE.BoxGeometry(len + 0.06, H, 0.06), pad);
      panel.position.y = H / 2; panel.castShadow = true; panel.receiveShadow = true;
      const top = new THREE.Mesh(new THREE.BoxGeometry(len + 0.08, 0.07, 0.09), cap);
      top.position.y = H;
      grp.add(panel, top);
      grp.position.copy(E((a[0] + b[0]) / 2, 0, (a[1] + b[1]) / 2));
      grp.rotation.y = Math.atan2(-(b[1] - a[1]), -(b[0] - a[0]));
      if (!s.connector) {
        const lbl = new THREE.Mesh(new THREE.PlaneGeometry(1.2, 0.6), new THREE.MeshBasicMaterial({ map: textTexture(String(Math.round(FIELD.fencePanels[s.panel] / FT)), { fg: '#ffffff' }), transparent: true }));
        lbl.position.set(0, H * 0.55, -0.035);
        lbl.rotation.y = Math.PI;
        grp.add(lbl);
        const lbl2 = lbl.clone(); lbl2.position.z = 0.035; lbl2.rotation.y = 0; grp.add(lbl2);
      }
      S.add(grp);
    }

    // Trees & surroundings
    const trunk = new THREE.MeshStandardMaterial({ color: 0x5b4632 });
    const leaves = [0x2f6b2f, 0x3b7a35, 0x27592a, 0x467f3a].map((c) => new THREE.MeshStandardMaterial({ color: c, roughness: 1 }));
    let seed = 7;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (let i = 0; i < 70; i++) {
      const ang = rnd() * Math.PI * 2;
      const rad = 36 + rnd() * 40;
      const x = Math.sin(ang) * rad, z = Math.cos(ang) * rad + 8;
      const sc2 = 0.8 + rnd() * 1.4;
      const tr = new THREE.Group();
      const t1 = new THREE.Mesh(new THREE.CylinderGeometry(0.18 * sc2, 0.25 * sc2, 2 * sc2, 6), trunk);
      t1.position.y = sc2;
      const crown = new THREE.Mesh(rnd() > 0.5 ? new THREE.ConeGeometry(1.6 * sc2, 4.5 * sc2, 7) : new THREE.IcosahedronGeometry(1.9 * sc2, 0), leaves[i % 4]);
      crown.position.y = 2 * sc2 + 1.8 * sc2;
      crown.castShadow = true;
      tr.add(t1, crown);
      tr.position.set(x, 0, z);
      S.add(tr);
    }
    // benches
    const benchMat = new THREE.MeshStandardMaterial({ color: 0x8b6b4a });
    for (const side of [-1, 1]) {
      const b = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.45, 7), benchMat);
      b.position.copy(E(side * 11.2, 0.225, 4.5));
      b.castShadow = true;
      S.add(b);
    }
  }

  _buildBall() {
    const tex = (() => {
      const c = document.createElement('canvas'); c.width = 128; c.height = 64;
      const g = c.getContext('2d'); g.fillStyle = '#fbfbf6'; g.fillRect(0, 0, 128, 64);
      g.fillStyle = '#c9c9c0';
      for (let i = 0; i < 8; i++) { g.beginPath(); g.ellipse(8 + i * 16, 18, 4, 7, 0, 0, Math.PI * 2); g.fill(); }
      return new THREE.CanvasTexture(c);
    })();
    this.ball = new THREE.Mesh(new THREE.SphereGeometry(0.052, 18, 12), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.4, emissive: 0x333333 }));
    this.ball.castShadow = true;
    this.scene.add(this.ball);
    this.ballShadow = new THREE.Mesh(new THREE.CircleGeometry(0.07, 16), new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.35, depthWrite: false }));
    this.ballShadow.rotation.x = -Math.PI / 2;
    this.scene.add(this.ballShadow);
    const N = 36;
    this.trailPts = [];
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(N * 3), 3));
    this.trail = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.55 }));
    this.trail.frustumCulled = false;
    this.trailN = N;
    this.scene.add(this.trail);
    // bat
    this.bat = new THREE.Mesh(new THREE.CylinderGeometry(0.024, 0.014, BAT.length, 10), new THREE.MeshStandardMaterial({ color: 0xffd400, roughness: 0.45 }));
    this.bat.castShadow = true;
    this.scene.add(this.bat);
  }

  // ---------------- Teams & figures ----------------
  setTeams(teams) {
    for (const f of this.figures.values()) this.scene.remove(f.fig);
    this.figures.clear();
    this.teams = teams;
    teams.forEach((t, ti) => {
      t.players.forEach((p, i) => {
        const tierScale = { JH: 0.88, HS: 0.96, COL: 1, PRO: 1.02 }[p.tier] || 1;
        const fig = makeFigure({ color: t.def.color, accent: accentFor(t.def.color), number: p.number, name: p.name, throws: p.throws, scale: tierScale, skinIdx: (p.name.length * 7 + i * 3) % 6 });
        const label = labelSprite(`#${p.number} ${p.name.split(' ').slice(-1)[0]}`, '', t.def.color);
        label.position.y = 2.05;
        fig.add(label);
        this.scene.add(fig);
        const bench = BENCH[ti][i % 5];
        fig.position.copy(E(bench[0], 0, bench[1]));
        this.figures.set(p.id, { fig, label, team: ti, player: p, pos: [...bench], target: [...bench], face: 0, lastPos: [...bench] });
      });
    });
    this._applyLabels();
    this._snap = true;
  }

  setLabels(on) { this.showLabels = on; this._applyLabels(); }
  _applyLabels() { for (const f of this.figures.values()) f.label.visible = this.showLabels; }
  setLabelSub(id, text) {
    const f = this.figures.get(id);
    if (!f) return;
    f.fig.remove(f.label);
    f.label = labelSprite(`#${f.player.number} ${f.player.name.split(' ').slice(-1)[0]}`, text, this.teams[f.team].def.color);
    f.label.position.y = 2.05; f.label.visible = this.showLabels;
    f.fig.add(f.label);
  }

  /** Place everyone for an at-bat that hasn't started (after sims / between records). */
  showIdle(state, snap = false) {
    if (snap) this._snap = true;
    this.rec = null;
    this.idle = state;
    this.bat.visible = true;
    this.trailPts = [];
  }

  // ---------------- Playback ----------------
  playRecord(rec, ctx, onEvent, onDone) {
    this.rec = rec;
    this.ctx = ctx;
    this.onEvent = onEvent; this.onDone = onDone;
    this.t = -1.15;
    this.trailPts = [];
    const contactT = rec.contact ? rec.contact.t : null;
    this.contactT = contactT;
    const pitchEnd = rec.frames[rec.frames.length - 1].t;
    this.endT = (rec.play ? contactT + rec.play.frames[rec.play.frames.length - 1].t : pitchEnd) + (rec.play ? 1.1 : 0.7);
    // event timeline
    const evs = [];
    evs.push({ t: 0.02, type: 'release' });
    const zc = rec.frames.find((f) => f.b[2] <= FIELD.zoneZ);
    evs.push({ t: contactT ?? (zc ? zc.t : pitchEnd * 0.8), type: 'pitchResult' });
    if (rec.play) for (const e of rec.play.events) evs.push({ ...e, t: contactT + e.t, play: true });
    evs.sort((a, b) => a.t - b.t);
    this.events = evs;
    this.evIdx = 0;
    this.idle = null;
    this.bat.visible = true;
  }

  finishRecord() {
    if (!this.rec) return;
    this.t = this.endT;
  }

  _interp(frames, t) {
    if (!frames.length) return null;
    if (t <= frames[0].t) return { a: frames[0], b: frames[0], f: 0 };
    let lo = 0, hi = frames.length - 1;
    if (t >= frames[hi].t) return { a: frames[hi], b: frames[hi], f: 0 };
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (frames[m].t <= t) lo = m; else hi = m; }
    const a = frames[lo], b = frames[hi];
    return { a, b, f: (t - a.t) / Math.max(1e-6, b.t - a.t) };
  }

  _loop(now) {
    requestAnimationFrame(this._loop);
    const rdt = Math.min(0.05, (now - this._last) / 1000);
    this._last = now;
    const dt = this.paused ? 0 : rdt * this.speed;
    if (this.rec) {
      this.t += dt;
      while (this.evIdx < this.events.length && this.events[this.evIdx].t <= this.t) {
        const e = this.events[this.evIdx++];
        this.onEvent && this.onEvent(e, this.rec);
      }
    }
    this._updateActors(dt, rdt);
    this._updateCamera(rdt);
    this.renderer.render(this.scene, this.camera);
    if (this.rec && this.t >= this.endT) {
      const cb = this.onDone; const rec = this.rec;
      this.rec = null;
      this._holdState = this._lastState;
      cb && cb(rec);
    }
  }

  _placeFig(id, x, z, kind, dt, faceDir, k = 0) {
    const f = this.figures.get(id);
    if (!f) return;
    f.used = true;
    const dx = x - f.pos[0], dz = z - f.pos[1];
    const d = Math.hypot(dx, dz);
    let moving = false;
    if (d > 1.2 && !this._snap) {
      // visual catch-up (e.g. jogging to the bench or a new alignment)
      const step = Math.min(d, 9 * Math.max(dt, 0.001));
      f.pos[0] += dx / d * step; f.pos[1] += dz / d * step;
      moving = true;
    } else { f.pos[0] = x; f.pos[1] = z; }
    const vx = f.pos[0] - f.lastPos[0], vz = f.pos[1] - f.lastPos[1];
    const sp = dt > 0 ? Math.hypot(vx, vz) / dt : 0;
    f.lastPos = [...f.pos];
    f.fig.position.copy(E(f.pos[0], 0, f.pos[1]));
    let face = f.face;
    if (sp > 0.8 && kind !== 'bat') face = Math.atan2(-vx, vz);
    else if (faceDir) face = Math.atan2(-faceDir[0], faceDir[1]);
    // smooth turn
    let diff = face - f.face;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    f.face += diff * Math.min(1, (dt || 0.016) * 10);
    if (kind === 'bat') f.face = face;
    f.fig.rotation.y = f.face;
    const kindNow = (moving || sp > 0.8) && kind !== 'bat' && kind !== 'pitch' ? 'run' : kind;
    pose(f.fig, kindNow, k, dt, sp);
  }

  _updateActors(dt) {
    for (const f of this.figures.values()) f.used = false;
    const rec = this.rec;
    const state = rec ? null : this.idle;
    const t = this.t;
    let ballPos = null;
    const benchSlot = [0, 0];
    const toBench = (id) => {
      const f = this.figures.get(id); if (!f) return;
      const s = BENCH[f.team][benchSlot[f.team]++ % 5];
      this._placeFig(id, s[0], s[1], 'idle', dt, [-Math.sign(s[0]) * 1, 0.6]);
    };

    if (rec) {
      const inPlay = rec.play && t >= this.contactT;
      const batter = this.figures.get(rec.batterId);
      // ---- defense ----
      if (!inPlay) {
        for (const d of rec.defense) {
          if (d.role === 'P') {
            const k = Math.max(-1, Math.min(0.6, t));
            const z = FIELD.moundZ - (t > -0.45 ? Math.min(1, (t + 0.45) / 0.5) * 0.7 : 0);
            this._placeFig(d.id, rec.pitch.throws === 'L' ? 0.15 : -0.15, z, 'pitch', dt, [0, -1], k);
          } else {
            this._placeFig(d.id, d.pos[0], d.pos[1], 'ready', dt, [-d.pos[0], -d.pos[1]]);
          }
        }
        for (const r of rec.runnersBefore) {
          const b = FIELD.bases[r.base];
          this._placeFig(r.id, b[0] * 0.96, b[1] * 0.97, 'ready', dt, [-b[0], -b[1]]);
        }
      } else {
        const ip = this._interp(rec.play.frames, t - this.contactT);
        const A = ip.a, B = ip.b, fr = ip.f;
        const bmap = new Map(B.f.map((x) => [x[0], x]));
        for (const a of A.f) {
          const b = bmap.get(a[0]) || a;
          const x = a[1] + (b[1] - a[1]) * fr, z = a[2] + (b[2] - a[2]) * fr;
          const anim = b[3];
          const kind = anim === 2 ? 'throw' : anim === 3 ? 'field' : anim === 4 ? 'hold' : anim === 1 ? 'run' : 'ready';
          const bp = A.b;
          this._placeFig(a[0], x, z, kind, dt, [bp[0] - x, bp[2] - z], anim === 2 ? 0.75 : 0);
        }
        const rmapB = new Map(B.r.map((x) => [x[0], x]));
        for (const a of A.r) {
          const b = rmapB.get(a[0]) || a;
          if (a[3] === 5 || a[3] === 6) { continue; }
          const x = a[1] + (b[1] - a[1]) * fr, z = a[2] + (b[2] - a[2]) * fr;
          this._placeFig(a[0], x, z, a[3] === 1 ? 'run' : 'idle', dt, [-x, -z]);
        }
        this._lastState = { A, B };
      }
      // ---- batter ----
      if (!inPlay && batter) {
        const side = rec.swing ? rec.swing.side : (batter.player.bats === 'L' ? -1 : 1);
        const px = rec.swing ? rec.swing.pivot[0] : -side * (BAT.sweet + 0.04);
        let psi = -9;
        if (rec.swing) psi = rec.swing.omega * (t - rec.swing.tPlan);
        const k = rec.swing ? Math.max(-0.9, Math.min(1.4, psi * 0.45)) : -0.9 * 0 - 0.3;
        this._placeFig(rec.batterId, px, CONTACT_Z - 0.05, 'bat', dt, [side, 0], k);
        this._poseBat(rec, side, px, psi);
      } else if (inPlay) {
        // dropped bat
        const side = rec.swing.side;
        this._placeBatGround(rec.swing.pivot[0] + side * 0.35, 0.4);
      }
      // ---- ball ----
      if (t < -0.04) {
        const pf = this.figures.get(rec.pitcherId);
        if (pf) {
          const hand = pf.fig.userData.throwArm.children[1];
          ballPos = hand.getWorldPosition(new THREE.Vector3());
        }
      } else if (inPlay) {
        const ip = this._interp(rec.play.frames, t - this.contactT);
        const a = ip.a.b, b = ip.b.b;
        ballPos = E(a[0] + (b[0] - a[0]) * ip.f, a[1] + (b[1] - a[1]) * ip.f, a[2] + (b[2] - a[2]) * ip.f);
      } else {
        const ip = this._interp(rec.frames, t);
        const a = ip.a.b, b = ip.b.b;
        ballPos = E(a[0] + (b[0] - a[0]) * ip.f, a[1] + (b[1] - a[1]) * ip.f, a[2] + (b[2] - a[2]) * ip.f);
      }
      // bench for everyone else
      for (const [id, f] of this.figures) if (!f.used) toBench(id);
    } else if (state) {
      for (const d of state.defense) {
        if (d.role === 'P') this._placeFig(d.id, 0, FIELD.moundZ, 'idle', dt, [0, -1]);
        else this._placeFig(d.id, d.pos[0], d.pos[1], 'idle', dt, [-d.pos[0], -d.pos[1]]);
      }
      for (const r of state.runners) { const b = FIELD.bases[r.base]; this._placeFig(r.id, b[0] * 0.96, b[1] * 0.97, 'idle', dt, [-b[0], -b[1]]); }
      if (state.batterId) {
        const side = state.batterSide;
        const px = -side * (BAT.sweet + 0.04);
        this._placeFig(state.batterId, px, CONTACT_Z - 0.05, 'bat', dt, [side, 0], -0.3);
        this._poseBat({ swing: null }, side, px, -9);
      }
      for (const [id, f] of this.figures) if (!f.used) toBench(id);
      const pf = state.pitcherId && this.figures.get(state.pitcherId);
      if (pf) { pf.fig.updateMatrixWorld(true); ballPos = pf.fig.userData.gloveArm.children[1].getWorldPosition(new THREE.Vector3()); }
    } else {
      for (const [id, f] of this.figures) if (!f.used) toBench(id);
    }

    if (ballPos) {
      this.ball.visible = true;
      this.ball.position.copy(ballPos);
      this.ballShadow.position.set(ballPos.x, 0.015, ballPos.z);
      const hgt = ballPos.y;
      this.ballShadow.material.opacity = Math.max(0.06, 0.38 - hgt * 0.05);
      this.ballShadow.scale.setScalar(1 + hgt * 0.15);
      this.ballShadow.visible = true;
      if (dt > 0 && this.showTrail && rec && t > 0) {
        this.trailPts.push(ballPos.clone());
        if (this.trailPts.length > this.trailN) this.trailPts.shift();
      }
      this.ballWorld = ballPos;
    }
    const arr = this.trail.geometry.attributes.position.array;
    const pts = this.showTrail ? this.trailPts : [];
    for (let i = 0; i < this.trailN; i++) {
      const p = pts[Math.max(0, pts.length - this.trailN + i)] || pts[0] || this.ball.position;
      arr[i * 3] = p.x; arr[i * 3 + 1] = p.y; arr[i * 3 + 2] = p.z;
    }
    this.trail.geometry.attributes.position.needsUpdate = true;
    this.trail.visible = this.showTrail && pts.length > 1;
    this._snap = false;
  }

  _poseBat(rec, side, px, psi) {
    const sw = rec.swing;
    const yb = sw ? sw.pivot[1] : 0.85;
    const tanA = sw ? Math.tan(sw.alpha) : 0.15;
    // stance (bat cocked over the back shoulder)
    const sH = [px + side * 0.12, 1.32, CONTACT_Z - 0.22];
    const sT = [sH[0] - side * 0.12, sH[1] + 0.7, sH[2] - 0.32];
    let H = sH, T = sT;
    if (sw && psi > -1.9) {
      const p = Math.min(psi, 3.2);
      const ux = side * Math.cos(Math.min(p, 2.0)), uz = Math.sin(Math.min(p, 2.0));
      const y = yb + Math.min(p, 2.0) * BAT.sweet * tanA;
      const aH = [px + ux * BAT.handleOffset, y, CONTACT_Z + uz * BAT.handleOffset];
      const aT = [px + ux * (BAT.handleOffset + BAT.length), y, CONTACT_Z + uz * (BAT.handleOffset + BAT.length)];
      const b = Math.max(0, Math.min(1, (psi + 1.9) / 0.5));
      H = sH.map((v, i) => v + (aH[i] - v) * b);
      T = sT.map((v, i) => v + (aT[i] - v) * b);
      if (p > 2.0) { const k = Math.min(1, (p - 2.0) / 1.2); T = [T[0], T[1] + k * 0.9, T[2] - k * 0.5]; H = [H[0], H[1] + k * 0.35, H[2]]; }
    }
    const a = E(...H), b2 = E(...T);
    const dir = new THREE.Vector3().subVectors(b2, a);
    this.bat.position.copy(a).addScaledVector(dir, 0.5);
    this.bat.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
  }

  _placeBatGround(x, z) {
    this.bat.position.copy(E(x, 0.03, z));
    this.bat.quaternion.setFromEuler(new THREE.Euler(0, 0.7, Math.PI / 2));
  }

  // ---------------- Camera ----------------
  setCamera(mode) {
    this.cameraMode = mode;
    this.controls.enabled = mode === 'free';
    if (mode === 'free') { this.controls.target.set(0, 0.5, 10); this.camera.position.copy(E(0, 12, -14)); }
    this._snapCam = true;
  }

  _updateCamera(rdt) {
    if (this.cameraMode === 'free') { this.controls.update(); return; }
    const rec = this.rec;
    const t = this.t;
    let mode = this.cameraMode;
    const inPlay = rec && rec.play && t >= this.contactT;
    if (mode === 'auto') mode = inPlay ? 'broadcast' : 'pitcher';
    if (mode !== this._lastMode) { this._snapCam = true; this._lastMode = mode; }
    const bp = this.ballWorld || new THREE.Vector3(0, 1, 5);
    let pos, look, fov = 48;
    switch (mode) {
      case 'pitcher': pos = E(2.4, 3.3, 25); look = E(-0.15, 0.95, -0.5); fov = 15; break;
      case 'behind': pos = E(0, 1.45, FIELD.backstopZ + 0.6); look = E(0, 1.1, 9); fov = 50; break;
      case 'high': pos = E(0, 14, -15); look = E(0, 0, 12); fov = 50; break;
      case 'overhead': pos = E(0, 46, 9.5); look = E(0, 0, 10); fov = 45; break;
      case 'first': pos = E(19, 5.5, 3); look = E(-2, 0.5, 9); fov = 50; break;
      case 'third': pos = E(-19, 5.5, 3); look = E(2, 0.5, 9); fov = 50; break;
      case 'ball': {
        const bx = -bp.x, bz = bp.z;
        const dir = Math.hypot(bx, bz) > 1 ? [bx / Math.hypot(bx, bz), bz / Math.hypot(bx, bz)] : [0, 1];
        pos = E(bx - dir[0] * 7, Math.max(2.5, bp.y + 2.5), bz - dir[1] * 7);
        look = bp.clone(); fov = 55;
        break;
      }
      case 'broadcast':
      default: {
        // high behind home, drifting with the ball
        const bx = -bp.x, bz = Math.max(0, bp.z);
        const dist = Math.hypot(bx, bz);
        pos = E(bx * 0.15, 8.5 + dist * 0.1, -11.5 + bz * 0.12);
        look = E(bx * 0.5, 0.3, Math.max(8, bz * 0.7));
        fov = 50;
      }
    }
    const k = this._snapCam ? 1 : 1 - Math.exp(-rdt * (mode === 'ball' ? 6 : 3));
    this._snapCam = false;
    this.camPos.lerp(pos, k);
    this.camLook.lerp(look, k);
    this.camera.position.copy(this.camPos);
    this.camera.lookAt(this.camLook);
    if (Math.abs(this.camera.fov - fov) > 0.1) { this.camera.fov += (fov - this.camera.fov) * k; this.camera.updateProjectionMatrix(); }
  }
}

export { BALL };
