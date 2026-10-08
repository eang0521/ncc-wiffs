// Stylized low-poly player figures with simple procedural animation.
import * as THREE from 'three';

const SKIN = [0xf1c27d, 0xe0ac69, 0xc68642, 0x8d5524, 0xffdbac, 0xd4a373];

function numberTexture(num, fg, bg, name) {
  const c = document.createElement('canvas');
  c.width = 128; c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = bg; g.fillRect(0, 0, 128, 128);
  g.fillStyle = fg;
  g.font = 'bold 18px system-ui, sans-serif'; g.textAlign = 'center';
  g.fillText((name || '').split(' ').slice(-1)[0].toUpperCase().slice(0, 10), 64, 30);
  g.font = 'bold 70px system-ui, sans-serif';
  g.fillText(String(num), 64, 105);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export function labelSprite(text, sub, color = '#ffffff') {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 72;
  const g = c.getContext('2d');
  g.fillStyle = 'rgba(12,18,24,0.72)';
  const r = 14;
  g.beginPath(); g.roundRect(4, 4, 248, 64, r); g.fill();
  g.fillStyle = color; g.fillRect(4, 4, 8, 64);
  g.fillStyle = '#fff'; g.font = '600 26px system-ui, sans-serif'; g.textAlign = 'left';
  g.fillText(text, 22, 34);
  g.fillStyle = 'rgba(255,255,255,0.75)'; g.font = '20px system-ui, sans-serif';
  g.fillText(sub || '', 22, 58);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const m = new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true, sizeAttenuation: false });
  const s = new THREE.Sprite(m);
  s.scale.set(0.085, 0.024, 1);
  s.center.set(0.5, 0);
  s.renderOrder = 10;
  return s;
}

/**
 * Build a player figure. Returns a Group with userData parts for animation.
 * opts: { color, accent, number, name, throws, scale, skinIdx }
 */
export function makeFigure(opts) {
  const g = new THREE.Group();
  const jersey = new THREE.MeshStandardMaterial({ color: opts.color, roughness: 0.8 });
  const accent = new THREE.MeshStandardMaterial({ color: opts.accent, roughness: 0.6 });
  const pants = new THREE.MeshStandardMaterial({ color: 0xe9e6dd, roughness: 0.9 });
  const skin = new THREE.MeshStandardMaterial({ color: SKIN[opts.skinIdx % SKIN.length], roughness: 0.7 });
  const shoe = new THREE.MeshStandardMaterial({ color: 0x1d1f22, roughness: 0.6 });
  const glove = new THREE.MeshStandardMaterial({ color: 0x6b3f1d, roughness: 0.8 });

  const body = new THREE.Group();
  g.add(body);

  // legs (pivot at hip)
  const legs = [];
  for (const sx of [-1, 1]) {
    const pivot = new THREE.Group();
    pivot.position.set(sx * 0.1, 0.9, 0);
    const leg = new THREE.Mesh(new THREE.CapsuleGeometry(0.065, 0.72, 3, 8), pants);
    leg.position.y = -0.42; leg.castShadow = true;
    const foot = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.07, 0.24), shoe);
    foot.position.set(0, -0.86, 0.05); foot.castShadow = true;
    pivot.add(leg, foot);
    body.add(pivot);
    legs.push(pivot);
  }
  // torso
  const torso = new THREE.Group();
  torso.position.y = 0.95;
  body.add(torso);
  const chest = new THREE.Mesh(new THREE.CapsuleGeometry(0.17, 0.36, 4, 12), jersey);
  chest.position.y = 0.3; chest.castShadow = true;
  torso.add(chest);
  const back = new THREE.Mesh(new THREE.PlaneGeometry(0.26, 0.26),
    new THREE.MeshStandardMaterial({ map: numberTexture(opts.number, opts.accent, opts.color, opts.name), roughness: 0.8 }));
  back.position.set(0, 0.36, -0.172); back.rotation.y = Math.PI;
  torso.add(back);
  const belt = new THREE.Mesh(new THREE.CylinderGeometry(0.165, 0.165, 0.05, 12), accent);
  belt.position.y = 0.04;
  torso.add(belt);
  // head + cap
  const head = new THREE.Group();
  head.position.y = 0.73;
  torso.add(head);
  const skull = new THREE.Mesh(new THREE.SphereGeometry(0.11, 14, 10), skin);
  skull.castShadow = true;
  head.add(skull);
  const cap = new THREE.Mesh(new THREE.SphereGeometry(0.117, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2), accent);
  cap.position.y = 0.02;
  head.add(cap);
  const brim = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 0.012, 12, 1, false, -Math.PI / 2, Math.PI), accent);
  brim.position.set(0, 0.03, 0.07);
  brim.scale.set(1, 1, 1.2);
  head.add(brim);
  // arms (pivot at shoulder)
  const arms = [];
  for (const sx of [-1, 1]) {
    const pivot = new THREE.Group();
    pivot.position.set(sx * 0.23, 0.55, 0);
    const arm = new THREE.Mesh(new THREE.CapsuleGeometry(0.05, 0.5, 3, 8), jersey);
    arm.position.y = -0.3; arm.castShadow = true;
    const hand = new THREE.Mesh(new THREE.SphereGeometry(0.05, 8, 6), skin);
    hand.position.y = -0.6;
    pivot.add(arm, hand);
    torso.add(pivot);
    arms.push(pivot);
  }
  // glove on the non-throwing hand (left hand for RHT). Figure faces +z; its left is +x.
  const gloveHand = opts.throws === 'L' ? arms[0] : arms[1];
  const gl = new THREE.Mesh(new THREE.SphereGeometry(0.085, 10, 8), glove);
  gl.scale.set(1, 1.2, 0.6);
  gl.position.y = -0.62;
  gloveHand.add(gl);

  const s = opts.scale || 1;
  g.scale.set(s, s, s);
  g.userData = { body, legs, arms, torso, head, glove: gl, throwArm: opts.throws === 'L' ? arms[1] : arms[0], gloveArm: gloveHand, phase: Math.random() * 6 };
  return g;
}

/** Pose the figure. kind: idle | ready | run | throw | field | hold | pitch | bat | celebrate */
export function pose(fig, kind, k = 0, dt = 0, speed = 0) {
  const u = fig.userData;
  const [lL, lR] = u.legs;
  const throwArm = u.throwArm, gloveArm = u.gloveArm;
  u.body.position.y = 0;
  u.torso.rotation.set(0, 0, 0);
  u.body.rotation.set(0, 0, 0);
  for (const a of u.arms) a.rotation.set(0, 0, 0);
  lL.rotation.set(0, 0, 0); lR.rotation.set(0, 0, 0);
  switch (kind) {
    case 'run': {
      u.phase += dt * (4 + speed * 1.6);
      const sw = Math.sin(u.phase) * Math.min(1, 0.35 + speed * 0.12);
      lL.rotation.x = sw * 0.9; lR.rotation.x = -sw * 0.9;
      u.arms[0].rotation.x = -sw * 0.9; u.arms[1].rotation.x = sw * 0.9;
      u.torso.rotation.x = 0.18;
      u.body.position.y = Math.abs(Math.cos(u.phase)) * 0.05;
      break;
    }
    case 'ready':
      u.body.position.y = -0.1;
      lL.rotation.x = -0.35; lR.rotation.x = -0.35; lL.rotation.z = 0.15; lR.rotation.z = -0.15;
      u.torso.rotation.x = 0.45;
      u.arms[0].rotation.x = -0.7; u.arms[1].rotation.x = -0.7;
      break;
    case 'field':
      u.body.position.y = -0.22;
      lL.rotation.x = -0.6; lR.rotation.x = -0.2;
      u.torso.rotation.x = 0.8;
      gloveArm.rotation.x = -1.1; throwArm.rotation.x = -0.9;
      break;
    case 'throw': {
      // k: 0 -> 1 through the throwing motion
      const a = k < 0.5 ? -2.6 * (k / 0.5) : -2.6 + 3.6 * ((k - 0.5) / 0.5);
      throwArm.rotation.x = a;
      gloveArm.rotation.x = -1.2;
      u.torso.rotation.y = (k - 0.5) * 0.8;
      lL.rotation.x = 0.3; lR.rotation.x = -0.3;
      break;
    }
    case 'pitch': {
      // k: -1 (start windup) .. 0 (release) .. 0.6 (follow through)
      if (k < -0.45) {
        const p = (k + 1) / 0.55;
        throwArm.rotation.x = -0.4 - p * 0.3; gloveArm.rotation.x = -0.6 - p * 0.3;
        lL.rotation.x = -p * 0.8;
      } else if (k < 0) {
        const p = (k + 0.45) / 0.45;
        throwArm.rotation.x = -0.7 + p * -2.3 + (p > 0.6 ? (p - 0.6) * 6 : 0);
        gloveArm.rotation.x = -1.2 + p;
        lL.rotation.x = -0.8 + p * 1.1; lR.rotation.x = p * -0.4;
        u.torso.rotation.y = -0.5 + p * 0.9;
      } else {
        const p = Math.min(1, k / 0.6);
        throwArm.rotation.x = 0.9 - p * 0.9; gloveArm.rotation.x = -0.5;
        u.torso.rotation.x = 0.5 * (1 - p); lR.rotation.x = -0.6 * (1 - p);
      }
      break;
    }
    case 'bat':
      u.body.position.y = -0.05;
      lL.rotation.z = 0.2; lR.rotation.z = -0.2;
      u.arms[0].rotation.x = -1.1; u.arms[1].rotation.x = -1.1;
      u.torso.rotation.y = k;
      break;
    case 'hold':
      throwArm.rotation.x = -0.6; gloveArm.rotation.x = -0.6;
      break;
    case 'celebrate':
      u.phase += dt * 8;
      u.arms[0].rotation.x = -2.8; u.arms[1].rotation.x = -2.8;
      u.body.position.y = Math.abs(Math.sin(u.phase)) * 0.15;
      break;
    default:
      u.arms[0].rotation.z = -0.08; u.arms[1].rotation.z = 0.08;
  }
}
