// chips.js — 3D casino chips: clay-composite chips with beveled edges, recessed printed inlays,
// three-tone edge inserts, gold-foil rings on high denominations, stacks on bets with natural
// irregularity, and placement / dealer payout / sweep animations plus the player's chip-rail bankroll.
import * as THREE from 'three';
import { chipSpot, FELT } from './bets.js';
import { RAIL, WALL_H } from './table.js';
const RAIL_TOP = WALL_H + 0.115; // top of the lacquered rail cap / groove lips

// Real chips are 39 mm x 3.3 mm (aspect kept). Scaled so a chip fills most of a place-box width and
// reads clearly from the gameplay camera, as on a live-dealer table.
export const CHIP_R = 0.5, CHIP_T = 0.083;
const RAIL_S = 0.82; // rail chips are drawn slightly smaller so they sit inside the routed grooves
// base = clay body, spot = edge insert, stripe = accent inside inserts, ink = numeral colour,
// gold = gold-foil inlay ring (premium chips). Albedos are pushed slightly past "true" because
// ACES tone mapping desaturates mid-tones.
export const DENOMS = [
  { v: 1, label: '1', face: '1', base: '#f7f5f0', spot: '#1745c8', stripe: '#e2b43a', ink: '#0b1d63', ring: '#1745c8', gold: false },
  { v: 5, label: '5', face: '5', base: '#c40a26', spot: '#fbf8f0', stripe: '#1748c4', ink: '#7a0016', ring: '#c40a26', gold: false },
  { v: 25, label: '25', face: '25', base: '#008a3c', spot: '#fbf8f0', stripe: '#f0c020', ink: '#00451e', ring: '#008a3c', gold: false },
  { v: 100, label: '100', face: '100', base: '#141418', spot: '#fbf8f0', stripe: '#d81e28', ink: '#060608', ring: '#141418', gold: true },
  { v: 500, label: '500', face: '500', base: '#6a1fb0', spot: '#f7d046', stripe: '#fbf8f0', ink: '#33085e', ring: '#6a1fb0', gold: true },
  // casino orange (not gold): saturated orange clay, burnt-orange edge, so it never reads as a gold chip
  { v: 1000, label: '1K', face: '1000', base: '#e0661a', side: '#cf5814', spot: '#2a1206', stripe: '#fbf8f0', ink: '#6a2404', ring: '#c4520e', gold: true },
];
const DESC = [...DENOMS].sort((a, b) => b.v - a.v);
const GOLD = '#d9b25a';

/** Greedy breakdown (largest first). Returns denom objects bottom->top. */
export function breakdown(amount) {
  const out = []; let r = Math.floor(amount);
  for (const d of DESC) { while (r >= d.v && out.length < 60) { out.push(d); r -= d.v; } }
  return out;
}
/** A more "natural" mix for the chip rail. Returns {value: count}. */
export function railBreakdown(amount) {
  const D = [1, 5, 25, 100, 500, 1000], cap = { 1: 8, 5: 14, 25: 16, 100: 20, 500: 12, 1000: 30 };
  const out = {}; let r = Math.floor(amount);
  for (let i = 0; i < D.length - 1; i++) {
    const d = D[i], nx = D[i + 1], block = nx / d;
    let c = (r % nx) / d;
    while (c + block <= cap[d] && (c + block) * d <= Math.max(r * 0.35, nx)) c += block;
    if (c * d > r) c = Math.floor(r / d);
    out[d] = c; r -= c * d;
  }
  out[1000] = Math.min(cap[1000], Math.floor(r / 1000));
  return out;
}

// ---------------------------------------------------------------- geometry
/**
 * Lathe-style chip/puck body with three material groups: 0 = edge (incl. bevels), 1 = top face,
 * 2 = bottom face. Faces get planar UVs (texture readable from the player side at rotation.y = 0),
 * the edge gets u = angle, v = height. Optional recessed centre inlay with a small step wall.
 */
export function discGeometry(R, T, { bevel = 0.008, recess = 0, inlayR = 0, seg = 48, bevelSteps = 4 } = {}) {
  const h = T / 2, pos = [], nor = [], uv = [], idx = [], groups = [];
  const strip = (pts, uvMode, group) => {
    const start = idx.length, base = pos.length / 3;
    for (const [r, y, nr, ny] of pts) {
      for (let j = 0; j <= seg; j++) {
        const th = (j / seg) * Math.PI * 2, s = Math.sin(th), c = Math.cos(th);
        const x = r * s, z = r * c;
        pos.push(x, y, z); nor.push(nr * s, ny, nr * c);
        if (uvMode === 'top') uv.push(0.5 + x / (2 * R), 0.5 - z / (2 * R));
        else if (uvMode === 'bottom') uv.push(0.5 + x / (2 * R), 0.5 + z / (2 * R));
        else uv.push(j / seg, (y + h) / T);
      }
    }
    const W = seg + 1, P = (i) => [pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]];
    for (let i = 0; i < pts.length - 1; i++) {
      for (let j = 0; j < seg; j++) {
        const a = base + i * W + j, b = base + (i + 1) * W + j, c = b + 1, d = a + 1;
        for (const tri of [[a, b, c], [a, c, d]]) {
          const [p0, p1, p2] = tri.map(P);
          const ux = p1[0] - p0[0], uy = p1[1] - p0[1], uz = p1[2] - p0[2];
          const vx = p2[0] - p0[0], vy = p2[1] - p0[1], vz = p2[2] - p0[2];
          const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
          if (cx * cx + cy * cy + cz * cz < 1e-14) continue; // degenerate (centre)
          const n = tri[0] * 3;
          const dot = cx * (nor[n] + nor[tri[1] * 3]) + cy * (nor[n + 1] + nor[tri[1] * 3 + 1]) + cz * (nor[n + 2] + nor[tri[1] * 3 + 2]);
          if (dot >= 0) idx.push(tri[0], tri[1], tri[2]); else idx.push(tri[0], tri[2], tri[1]);
        }
      }
    }
    groups.push([start, idx.length - start, group]);
  };
  const face = (sgn, mode) => {
    const yF = sgn * h, yR = sgn * (h - recess), w = 0.008;
    if (recess > 0 && inlayR > 0) {
      strip([[0, yR, 0, sgn], [inlayR, yR, 0, sgn]], mode, sgn > 0 ? 1 : 2);
      const l = Math.hypot(recess, w);
      strip([[inlayR, yR, -recess / l, sgn * w / l], [inlayR + w, yF, -recess / l, sgn * w / l]], mode, sgn > 0 ? 1 : 2);
      strip([[inlayR + w, yF, 0, sgn], [R - bevel, yF, 0, sgn]], mode, sgn > 0 ? 1 : 2);
    } else strip([[0, yF, 0, sgn], [R - bevel, yF, 0, sgn]], mode, sgn > 0 ? 1 : 2);
  };
  face(1, 'top');
  const edge = [];
  for (let k = 0; k <= bevelSteps; k++) { const a = (k / bevelSteps) * Math.PI / 2; edge.push([R - bevel + Math.sin(a) * bevel, h - bevel + Math.cos(a) * bevel, Math.sin(a), Math.cos(a)]); }
  for (let k = 0; k <= bevelSteps; k++) { const a = Math.PI / 2 + (k / bevelSteps) * Math.PI / 2; edge.push([R - bevel + Math.sin(a) * bevel, -h + bevel + Math.cos(a) * bevel, Math.sin(a), Math.cos(a)]); }
  strip(edge, 'side', 0);
  face(-1, 'bottom');
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  // merge consecutive groups with the same material
  const merged = [];
  for (const [s, c, m] of groups) { const l = merged[merged.length - 1]; if (l && l[2] === m && l[0] + l[1] === s) l[1] += c; else merged.push([s, c, m]); }
  for (const [s, c, m] of merged) g.addGroup(s, c, m);
  g.computeBoundingSphere();
  return g;
}

// ---------------------------------------------------------------- textures
function rng(seed) { let s = seed >>> 0; return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const INS_W = (20 * Math.PI) / 180;   // edge insert angular width
const INSERT_ANGLES = Array.from({ length: 6 }, (_, k) => (k * Math.PI) / 3);

function speckle(ctx, N, r, { n = 4000, light = 'rgba(255,255,255,0.05)', dark = 'rgba(0,0,0,0.07)', seed = 1, clip = null } = {}) {
  const R = rng(seed);
  ctx.save(); if (clip) { ctx.beginPath(); clip(); ctx.clip(); }
  for (let i = 0; i < n; i++) {
    const x = R() * N, y = R() * N, s = (0.5 + R() * 1.3) * (N / 512);
    ctx.fillStyle = R() < 0.5 ? light : dark; ctx.fillRect(x, y, s, s);
  }
  ctx.restore();
}

/** Colour map for a chip face. */
function drawFace(d, N, seed) {
  const cv = document.createElement('canvas'); cv.width = cv.height = N; const ctx = cv.getContext('2d');
  const c = N / 2, R = N / 2, u = N / 512;
  const ring = (r0, r1, a0 = 0, a1 = Math.PI * 2) => { ctx.beginPath(); ctx.arc(c, c, r1, a0, a1); ctx.arc(c, c, r0, a1, a0, true); ctx.closePath(); };
  // clay body with a faint radial tone (moulded chips are slightly darker toward the rim)
  ctx.fillStyle = d.base; ctx.fillRect(0, 0, N, N);
  const tone = ctx.createRadialGradient(c, c, R * 0.3, c, c, R);
  tone.addColorStop(0, 'rgba(255,255,255,0.05)'); tone.addColorStop(1, 'rgba(0,0,0,0.10)');
  ctx.fillStyle = tone; ctx.fillRect(0, 0, N, N);
  speckle(ctx, N, R, { n: 9000 * u * u, seed });
  // edge inserts: block + two accent stripes, running out to the rim (continue on the edge texture)
  for (const a of INSERT_ANGLES) {
    ctx.fillStyle = d.spot; ring(R * 0.785, R * 1.01, a - INS_W / 2, a + INS_W / 2); ctx.fill();
    ctx.fillStyle = d.stripe;
    ring(R * 0.785, R * 1.01, a - INS_W * 0.09, a + INS_W * 0.09); ctx.fill();
    // insert seam shadow (inlaid clay)
    ctx.strokeStyle = 'rgba(0,0,0,0.18)'; ctx.lineWidth = 1.2 * u; ring(R * 0.785, R * 1.01, a - INS_W / 2, a + INS_W / 2); ctx.stroke();
  }
  // moulded diamonds between inserts
  ctx.fillStyle = d.spot;
  for (const a0 of INSERT_ANGLES) {
    for (const f of [0.3, 0.5, 0.7]) {
      const a = a0 + (Math.PI / 3) * f, rr = R * 0.895, s = R * (f === 0.5 ? 0.04 : 0.028);
      ctx.save(); ctx.translate(c + Math.cos(a) * rr, c + Math.sin(a) * rr); ctx.rotate(a);
      ctx.beginPath(); ctx.moveTo(-s * 1.3, 0); ctx.lineTo(0, -s * 0.7); ctx.lineTo(s * 1.3, 0); ctx.lineTo(0, s * 0.7); ctx.closePath(); ctx.globalAlpha = 0.85; ctx.fill(); ctx.restore();
    }
  }
  ctx.globalAlpha = 1;
  // moulded ring just outside the inlay
  ctx.strokeStyle = 'rgba(0,0,0,0.22)'; ctx.lineWidth = 2.2 * u; ctx.beginPath(); ctx.arc(c, c, R * 0.745, 0, Math.PI * 2); ctx.stroke();
  ctx.strokeStyle = 'rgba(255,255,255,0.12)'; ctx.lineWidth = 1.2 * u; ctx.beginPath(); ctx.arc(c, c, R * 0.758, 0, Math.PI * 2); ctx.stroke();

  // ---- printed inlay (recessed in geometry at r = 0.62R)
  const Ri = R * 0.62;
  const g = ctx.createRadialGradient(c - R * 0.12, c - R * 0.16, R * 0.05, c, c, Ri);
  g.addColorStop(0, '#ffffff'); g.addColorStop(1, '#f1ede4');
  ctx.fillStyle = g; ctx.beginPath(); ctx.arc(c, c, Ri, 0, Math.PI * 2); ctx.fill();
  // outer printed band in the chip colour
  ctx.fillStyle = d.ring; ring(Ri * 0.84, Ri * 0.985); ctx.fill();
  if (d.gold) { ctx.fillStyle = GOLD; ring(Ri * 0.80, Ri * 0.84); ctx.fill(); ring(Ri * 0.985, Ri * 1.0); ctx.fill(); }
  else { ctx.strokeStyle = d.ring; ctx.lineWidth = 1.4 * u; ctx.beginPath(); ctx.arc(c, c, Ri * 0.79, 0, Math.PI * 2); ctx.stroke(); }
  // lettering in the band
  const bandInk = d.v === 1 ? '#f5f0e4' : (d.v === 1000 ? '#fff6e0' : '#f5f0e4');
  ctx.fillStyle = bandInk; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.font = `700 ${Ri * 0.108}px "Segoe UI", Arial, sans-serif`;
  const arcText = (str, rad, mid, dir) => {
    const step = (Ri * 0.1) / rad * 1.08; let a = mid - ((str.length - 1) * step) / 2 * dir;
    for (const ch of str) { ctx.save(); ctx.translate(c + Math.cos(a) * rad, c + Math.sin(a) * rad); ctx.rotate(a + (dir > 0 ? Math.PI / 2 : -Math.PI / 2)); ctx.fillText(ch, 0, 0); ctx.restore(); a += step * dir; }
  };
  void arcText; // micro-lettering turned to mush at table distance: the band now carries bold printed dashes
  for (let k = 0; k < 12; k++) {
    const a = (k * Math.PI) / 6 + Math.PI / 12, hw = 0.11;
    ctx.fillStyle = k % 2 ? bandInk : (d.gold ? GOLD : bandInk);
    ring(Ri * 0.875, Ri * 0.95, a - hw, a + hw); ctx.fill();
  }
  // guilloche rosette behind the numeral
  ctx.save(); ctx.strokeStyle = d.ring; ctx.globalAlpha = 0.13; ctx.lineWidth = 1 * u;
  for (let k = 0; k < 24; k++) { const a = (k * Math.PI) / 12; ctx.beginPath(); ctx.ellipse(c + Math.cos(a) * Ri * 0.3, c + Math.sin(a) * Ri * 0.3, Ri * 0.38, Ri * 0.14, a, 0, Math.PI * 2); ctx.stroke(); }
  ctx.restore();
  // numeral: heavy, full-contrast, as large as the inner window allows (fit by measured width)
  const txt = d.face, len = txt.length;
  const FONT = '"Arial Black", "Segoe UI Black", "Segoe UI", Arial, sans-serif';
  const sx = len >= 4 ? 0.7 : len === 3 ? 0.8 : 0.92;
  ctx.font = `900 100px ${FONT}`;
  const w100 = ctx.measureText(txt).width * sx;
  const fs = Math.min(Ri * 1.42, (Ri * 1.42) / (w100 / 100));
  ctx.font = `900 ${fs}px ${FONT}`;
  ctx.save(); ctx.translate(c, c + fs * 0.04); ctx.scale(sx, 1);
  ctx.fillStyle = 'rgba(0,0,0,0.22)'; ctx.fillText(txt, 1.6 * u, 2.2 * u);
  ctx.fillStyle = d.ink; ctx.fillText(txt, 0, 0);
  ctx.restore();
  // printed-paper grain
  speckle(ctx, N, R, { n: 3000 * u * u, seed: seed + 7, light: 'rgba(255,255,255,0.04)', dark: 'rgba(60,40,20,0.05)', clip: () => ctx.arc(c, c, Ri, 0, Math.PI * 2) });
  return cv;
}

/** Packed roughness (G) / metalness (B) map for a chip face. */
function drawFaceRM(d, N) {
  const cv = document.createElement('canvas'); cv.width = cv.height = N; const ctx = cv.getContext('2d');
  const c = N / 2, R = N / 2, Ri = R * 0.62;
  ctx.fillStyle = 'rgb(0,150,0)'; ctx.fillRect(0, 0, N, N); // polished clay ~0.59
  // rim band is handled more (slightly smoother where fingers polish it)
  ctx.fillStyle = 'rgb(0,128,0)'; ctx.beginPath(); ctx.arc(c, c, R, 0, Math.PI * 2); ctx.arc(c, c, R * 0.8, Math.PI * 2, 0, true); ctx.fill();
  ctx.fillStyle = 'rgb(0,66,0)'; ctx.beginPath(); ctx.arc(c, c, Ri, 0, Math.PI * 2); ctx.fill(); // laminated inlay ~0.26
  if (d.gold) {
    ctx.fillStyle = 'rgb(0,70,255)';
    const ring = (r0, r1) => { ctx.beginPath(); ctx.arc(c, c, r1, 0, Math.PI * 2); ctx.arc(c, c, r0, Math.PI * 2, 0, true); ctx.closePath(); ctx.fill(); };
    ring(Ri * 0.80, Ri * 0.84); ring(Ri * 0.985, Ri * 1.0);
  }
  return cv;
}

/** Bump map: clay grain + moulded relief (diamonds / ring) — the inlay is smooth. */
function drawFaceBump(N, seed) {
  const cv = document.createElement('canvas'); cv.width = cv.height = N; const ctx = cv.getContext('2d');
  const c = N / 2, R = N / 2, u = N / 512;
  ctx.fillStyle = '#808080'; ctx.fillRect(0, 0, N, N);
  speckle(ctx, N, R, { n: 14000 * u * u, seed, light: 'rgba(255,255,255,0.18)', dark: 'rgba(0,0,0,0.18)' });
  ctx.fillStyle = '#9a9a9a';
  for (const a0 of INSERT_ANGLES) for (const f of [0.3, 0.5, 0.7]) {
    const a = a0 + (Math.PI / 3) * f, rr = R * 0.895, s = R * (f === 0.5 ? 0.04 : 0.028);
    ctx.save(); ctx.translate(c + Math.cos(a) * rr, c + Math.sin(a) * rr); ctx.rotate(a);
    ctx.beginPath(); ctx.moveTo(-s * 1.3, 0); ctx.lineTo(0, -s * 0.7); ctx.lineTo(s * 1.3, 0); ctx.lineTo(0, s * 0.7); ctx.closePath(); ctx.fill(); ctx.restore();
  }
  ctx.strokeStyle = '#a8a8a8'; ctx.lineWidth = 3 * u; ctx.beginPath(); ctx.arc(c, c, R * 0.75, 0, Math.PI * 2); ctx.stroke();
  ctx.fillStyle = '#808080'; ctx.beginPath(); ctx.arc(c, c, R * 0.62, 0, Math.PI * 2); ctx.fill();
  return cv;
}

/** Edge texture: u = angle (θ, lathe convention), v = height. Inserts align with the face. */
function drawSide(d, seed) {
  const W = 1024, H = 32;
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H; const ctx = cv.getContext('2d');
  ctx.fillStyle = d.side || d.base; ctx.fillRect(0, 0, W, H);
  speckle(ctx, W, 0, { n: 1400, seed: seed + 3 });
  const iw = (INS_W / (Math.PI * 2)) * W;
  const block = (u0, w, col) => { ctx.fillStyle = col; for (const off of [-W, 0, W]) ctx.fillRect(u0 + off, 0, w, H); };
  for (let k = 0; k < 6; k++) {
    const uc = (0.25 + k / 6) * W; // face canvas angle a_k maps to θ = π/2 - a_k
    block(uc - iw / 2, iw, d.spot);
    block(uc - iw * 0.09, iw * 0.18, d.stripe);
    block(uc - iw / 2 - 0.6, 1.2, 'rgba(0,0,0,0.25)'); block(uc + iw / 2 - 0.6, 1.2, 'rgba(0,0,0,0.25)');
  }
  // slight darkening toward the bevels gives the rim a moulded, rounded feel
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, 'rgba(0,0,0,0.16)'); g.addColorStop(0.2, 'rgba(0,0,0,0)'); g.addColorStop(0.8, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(0,0,0,0.16)');
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  return cv;
}

// ---------------------------------------------------------------- animation helpers
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const easeOut = (t) => 1 - Math.pow(1 - t, 3);
function hash(str, k) { let h = 2166136261 ^ k; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); } return ((h >>> 0) % 10000) / 10000; }
const boxOf = (id) => (/^(place|come|comeOdds)(4|5|6|8|9|10)$/.exec(id) || [])[2];
const money = (n) => '$' + Math.round(n).toLocaleString('en-US');
/**
 * Chip spot with the chips owner's dealer conventions applied on top of the layout's spots:
 * - place / buy bets sit on the box's bottom line at the player's position (the casino spot), so even a tall
 *   stack seen from the player side never rises over the printed numeral behind it;
 * - pass-line odds sit BEHIND the flat bet (toward the player, off the line) and a little to the side,
 *   the way a base dealer sets them, never side by side as a second flat bet.
 */
const PLACE_DZ = 0.4;
function spotOf(id) {
  const s = chipSpot(id);
  if (/^(place|buy)(4|5|6|8|9|10)$/.test(id)) return { ...s, z: s.z + PLACE_DZ };
  if (id === 'passOdds') { const p = chipSpot('pass'); return { x: p.x + CHIP_R * 0.95, z: p.z + CHIP_R * 1.25 }; }
  return s;
}

export const PLAYER_RAIL = new THREE.Vector3(-10.2, RAIL.grooveY + 0.45, FELT.hd + 0.8); // (table owner) follows the rail groove height
// dealer's working bank: on the felt at the back of the layout, so payouts slide out low across the table
// (never over the back rail) and sweeps drop into it
export const HOUSE_BANK = new THREE.Vector3(0, 0.05, -5.95);
// house chip columns in the bank tray, left to right: [denomination, chips in the column]
const BANK_COLS = [[1, 6], [5, 8], [25, 8], [1000, 4], [100, 7], [500, 5], [25, 6]];
const PAY_ARC = 0.45; // peak height of a payout flight
const TAG_H = 0.03;          // value-tag height as a fraction of the view height (screen-constant)
const MAX_FLY_SHADOWS = 20;
const TAG_PARENT = { passOdds: 'pass' }; // odds placed beside (not on) their line bet: tagged together with it

/** Pill-shaped value tag ("$135"): dark glass with a gold hairline, like a live-dealer table overlay. */
function drawTag(text, d = null) {
  const S = 2, h = 46 * S, font = `700 ${27 * S}px "Segoe UI", Arial, sans-serif`;
  const cv = document.createElement('canvas'); let ctx = cv.getContext('2d');
  ctx.font = font; const tw = ctx.measureText(text).width;
  const dot = d ? 30 * S : 0; // chip-colour badge: the denomination reads even where the chips are small
  const w = Math.ceil(tw + 34 * S + dot); cv.width = w; cv.height = h; ctx = cv.getContext('2d');
  const r = h / 2 - 3 * S, x0 = 3 * S, y0 = 3 * S, x1 = w - 3 * S, y1 = h - 3 * S;
  const pill = () => { ctx.beginPath(); ctx.moveTo(x0 + r, y0); ctx.lineTo(x1 - r, y0); ctx.arc(x1 - r, y0 + r, r, -Math.PI / 2, Math.PI / 2); ctx.lineTo(x0 + r, y1); ctx.arc(x0 + r, y0 + r, r, Math.PI / 2, Math.PI * 1.5); ctx.closePath(); };
  const g = ctx.createLinearGradient(0, y0, 0, y1); g.addColorStop(0, 'rgba(34,28,20,0.92)'); g.addColorStop(1, 'rgba(10,8,6,0.92)');
  ctx.fillStyle = g; pill(); ctx.fill();
  ctx.lineWidth = 2 * S; ctx.strokeStyle = 'rgba(226,190,110,0.95)'; pill(); ctx.stroke();
  if (d) {
    const cx = x0 + r + 2 * S, cy = h / 2, rr = r - 6 * S;
    ctx.fillStyle = d.base; ctx.beginPath(); ctx.arc(cx, cy, rr, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = d.spot; ctx.lineWidth = 3.2 * S; ctx.setLineDash([3.6 * S, 3.6 * S]);
    ctx.beginPath(); ctx.arc(cx, cy, rr - 2 * S, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = '#fbf8f0'; ctx.beginPath(); ctx.arc(cx, cy, rr * 0.45, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.55)'; ctx.lineWidth = 1.2 * S; ctx.beginPath(); ctx.arc(cx, cy, rr, 0, Math.PI * 2); ctx.stroke();
  }
  ctx.font = font; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = '#fff8e8';
  ctx.fillText(text, w / 2 + dot / 2, h / 2 + 1 * S);
  const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
  return { tex: t, aspect: w / h };
}

const _v = new THREE.Vector3(), _q = new THREE.Vector3();
const _X = new THREE.Vector3(1, 0, 0), _Z = new THREE.Vector3(0, 0, 1), _Q = new THREE.Quaternion();

export class ChipManager {
  constructor(scene, { faceRes = 256, lite = false } = {}) {
    this.lite = lite; // phones: lacquer as MeshStandardMaterial (no clearcoat layer) for materials made after startup
    this.scene = scene;
    this.group = new THREE.Group(); this.group.name = 'chips'; scene.add(this.group);
    this.geo = discGeometry(CHIP_R, CHIP_T, { bevel: 0.012, recess: 0.0026, inlayR: CHIP_R * 0.62, seg: 56, bevelSteps: 4 });
    const N = Math.max(512, faceRes);
    const bump = new THREE.CanvasTexture(drawFaceBump(N, 5)); bump.anisotropy = 8;
    this.mats = new Map(); this.flyMats = new Map();
    DENOMS.forEach((d, i) => {
      // full anisotropy (three clamps to the GPU max) keeps numeral edges crisp at grazing angles
      const face = new THREE.CanvasTexture(drawFace(d, N, 11 + i * 17)); face.colorSpace = THREE.SRGBColorSpace; face.anisotropy = 16;
      const rm = new THREE.CanvasTexture(drawFaceRM(d, N)); rm.anisotropy = 4;
      const side = new THREE.CanvasTexture(drawSide(d, 31 + i)); side.colorSpace = THREE.SRGBColorSpace; side.anisotropy = 4;
      // polished clay under a thin clear coat: crisp highlights ride the bevels and the laminated inlay
      const sideM = new THREE.MeshPhysicalMaterial({ map: side, color: 0xececec, roughness: 0.44, metalness: 0, clearcoat: 0.7, clearcoatRoughness: 0.22, envMapIntensity: 1.0 });
      const topM = new THREE.MeshPhysicalMaterial({ map: face, color: 0xf3f3f3, roughnessMap: rm, metalnessMap: rm, roughness: 1, metalness: 1, bumpMap: bump, bumpScale: 0.45, clearcoat: 0.65, clearcoatRoughness: 0.2, envMapIntensity: 1.05 });
      this.mats.set(d.v, [sideM, topM, topM]);
      // in flight a chip is seen far more edge-on (and close to the lens) than any resting chip, so the clear coat's
      // Fresnel mirror of the bright canopy env swamped its clay colour (pale, "translucent" chips). Flight
      // variants damp the env/clear-coat term so a chip in the air keeps the same saturated colour it has at rest.
      const fly = (mm) => { const c = mm.clone(); c.envMapIntensity = mm.envMapIntensity * 0.12; c.clearcoat = 0; c.specularIntensity = 0.55; return c; };
      const fs = fly(sideM), ft = fly(topM);
      this.flyMats.set(d.v, [fs, ft, ft]);
    });
    this.stacks = new Map(); // id -> { amount, chips: [{mesh, d, ry}], ao?, tag? }
    this.tweens = [];
    this.rail = [];
    this.railAmount = -1;
    this.time = 0;
    this.paused = false;     // shot modes freeze an animation mid-flight
    this.viewer = null;      // camera: stacks are squared so the top numeral reads upright for it
    this.tagsOn = true;      // floating value tags over each bet
    this.tagCache = new Map();
    // soft contact shadow under stacks
    const cv = document.createElement('canvas'); cv.width = cv.height = 128; const c2 = cv.getContext('2d');
    const gr = c2.createRadialGradient(64, 64, 26, 64, 64, 63);
    gr.addColorStop(0, 'rgba(0,0,0,0.62)'); gr.addColorStop(0.45, 'rgba(0,0,0,0.28)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
    c2.fillStyle = gr; c2.fillRect(0, 0, 128, 128);
    this.aoTex = new THREE.CanvasTexture(cv);
    this.aoMat = new THREE.MeshBasicMaterial({ map: this.aoTex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
    this.aoGeo = new THREE.PlaneGeometry(CHIP_R * 2.9, CHIP_R * 2.9); this.aoGeo.rotateX(-Math.PI / 2);
    // contact shadows for chips in flight (grow + fade with height, like the puck's)
    this.flyShadows = [];
    for (let i = 0; i < MAX_FLY_SHADOWS; i++) {
      const m = new THREE.Mesh(this.aoGeo, new THREE.MeshBasicMaterial({ map: this.aoTex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }));
      m.renderOrder = 1; m.visible = false; this.group.add(m); this.flyShadows.push(m);
    }
    this._buildBank();
  }

  /**
   * The boxman's bank: a lacquered, brass-trimmed chip tray on the felt behind the centre propositions, holding
   * squared columns of house chips. Payouts are lifted off the top of its columns and swept losses are dropped
   * onto them, so no chip ever passes through the cloth.
   */
  _buildBank() {
    const g = new THREE.Group(); g.name = 'houseBank'; this.group.add(g);
    const cols = BANK_COLS.length, pitch = CHIP_R * 2.12, w = cols * pitch + 0.3, dpt = CHIP_R * 2 + 0.3, h = 0.09;
    const wood = new THREE.MeshPhysicalMaterial({ color: 0x3a160a, roughness: 0.32, clearcoat: 1, clearcoatRoughness: 0.12 });
    const brass = new THREE.MeshStandardMaterial({ color: 0xc9a25a, metalness: 1, roughness: 0.28 });
    const well = new THREE.MeshStandardMaterial({ color: 0x0f2a18, roughness: 0.95 });
    const add = (geo, mat, x, y, z) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.castShadow = true; m.receiveShadow = true; g.add(m); return m; };
    const wall = 0.08;
    add(new THREE.BoxGeometry(w, 0.02, dpt), well, 0, 0.01, 0);
    add(new THREE.BoxGeometry(w, h, wall), wood, 0, h / 2, -dpt / 2 + wall / 2);
    add(new THREE.BoxGeometry(w, h, wall), wood, 0, h / 2, dpt / 2 - wall / 2);
    add(new THREE.BoxGeometry(wall, h, dpt), wood, -w / 2 + wall / 2, h / 2, 0);
    add(new THREE.BoxGeometry(wall, h, dpt), wood, w / 2 - wall / 2, h / 2, 0);
    for (let i = 1; i < cols; i++) add(new THREE.BoxGeometry(0.03, h * 0.7, dpt - wall * 2), wood, -w / 2 + 0.15 + i * pitch, h * 0.35, 0);
    const trim = new THREE.BoxGeometry(w + 0.01, 0.012, 0.025);
    add(trim, brass, 0, h + 0.006, dpt / 2 - wall / 2); add(trim, brass, 0, h + 0.006, -dpt / 2 + wall / 2);
    // contact shadow under the tray
    const sh = new THREE.Mesh(new THREE.PlaneGeometry(w + 0.6, dpt + 0.6).rotateX(-Math.PI / 2), this._railShadowMat());
    sh.position.y = 0.004; sh.renderOrder = 1; g.add(sh);
    g.position.set(HOUSE_BANK.x, 0, HOUSE_BANK.z);
    this.bankCols = [];
    BANK_COLS.forEach(([v, n], i) => {
      const d = DENOMS.find((dd) => dd.v === v), x = HOUSE_BANK.x - w / 2 + 0.15 + (i + 0.5) * pitch;
      const im = new THREE.InstancedMesh(this.geo, this.mats.get(v), n);
      im.castShadow = true; im.receiveShadow = true;
      const o = new THREE.Object3D();
      for (let k = 0; k < n; k++) {
        o.position.set(x + (hash('bank' + i, k) - 0.5) * 0.012, 0.02 + CHIP_T * (k + 0.5), HOUSE_BANK.z + (hash('bank' + i, k + 50) - 0.5) * 0.012);
        o.rotation.set(0, hash('bankr' + i, k) * 6.283, 0); o.updateMatrix(); im.setMatrixAt(k, o.matrix);
      }
      this.group.add(im);
      this.bankCols.push({ v, x, top: 0.02 + CHIP_T * n, d });
    });
  }

  makeChip(d) {
    const m = new THREE.Mesh(this.geo, this.mats.get(d.v));
    m.castShadow = true; m.receiveShadow = true; m.userData.d = d;
    this.group.add(m);
    return m;
  }
  _remove(mesh) { this.group.remove(mesh); }

  /** The dealer bank a bet is paid from / swept into: on the felt behind the layout, nearest the bet. */
  _bankFor(x, k = 0, v = null) {
    // the column of that denomination (nearest the bet when the tray holds two), else the column nearest the bet
    const cols = this.bankCols || [];
    let best = null, bd = Infinity;
    for (const c of cols) { const dd = Math.abs(c.x - x) + (v != null && c.v !== v ? 100 : 0); if (dd < bd) { bd = dd; best = c; } }
    if (!best) return HOUSE_BANK.clone();
    return new THREE.Vector3(best.x + ((k % 3) - 1) * 0.01, best.top + CHIP_T * 0.5, HOUSE_BANK.z);
  }
  /**
   * Chip spot with the live table state applied: odds ride ON their base bet shifted 0.3R toward the player
   * (one footprint, the casino convention), and a come bet that travels to the box the puck is sitting in
   * moves down beside the place stack instead of under the puck.
   */
  _cs(id) {
    const m = /^(come|comeOdds|place)(4|5|6|8|9|10)$/.exec(id);
    if (m && this.pointOf && this.pointOf() === Number(m[2])) {
      const n = m[2], p = spotOf('place' + n);
      const both = this.stacks.has('place' + n) && this.stacks.has('come' + n);
      if (m[1] === 'place') return both ? { x: p.x - 0.5, z: p.z } : p;
      const base = { x: p.x + (both ? 0.5 : 0.36), z: p.z - 0.04 };
      return m[1] === 'come' ? base : { x: base.x, z: base.z + CHIP_R * 0.3, stackOn: 'come' + n };
    }
    const s = spotOf(id);
    if (s.stackOn) { const b = this._cs(s.stackOn); return { x: b.x, z: b.z + CHIP_R * 0.3, stackOn: s.stackOn }; }
    return s;
  }
  /** Slide a box's place / come stacks to their current spots (a come bet joining the puck's box). */
  _relayoutBox(n, animate) {
    if (!n) return;
    for (const id of ['place' + n, 'come' + n, 'comeOdds' + n]) {
      const st = this.stacks.get(id); if (!st) continue;
      st.chips.forEach((c, k) => {
        const to = this._chipPos(id, k);
        if (c.mesh.position.distanceTo(to) < 1e-3 && !this.tweens.some((t) => t.mesh === c.mesh)) return;
        const tw = this.tweens.filter((t) => t.mesh === c.mesh).pop();
        if (tw) tw.to.copy(to); else if (animate) this.fly(c.mesh, c.mesh.position.clone(), to, { dur: 0.3, arc: 0, curve: 'out' }); else c.mesh.position.copy(to);
      });
      this._ensureAo(st, id);
    }
  }
  _spotFor(id) {
    const s = this._cs(id);
    let baseY = 0;
    if (s.stackOn && this.stacks.has(s.stackOn)) baseY = this.stacks.get(s.stackOn).chips.length * CHIP_T;
    return { x: s.x, z: s.z, y: baseY };
  }
  /**
   * Dealer-squared stack: chips sit within ~1-2% of a diameter of each other. The small offsets are
   * correlated (a gentle drift/lean up the stack plus a slow wander), not independent per-chip noise.
   */
  _stackOffset(id, k) {
    // hand-stacked, not machined: ~1-2% of the radius per chip (0.005-0.01) plus a slow lean/wander
    if (k === 0) return [0, 0];
    const a = hash(id, 3) * Math.PI * 2, m = 0.0012 + hash(id, 5) * 0.0016;
    const drift = Math.min(k * m, 0.022);
    const wob = Math.sin(k * 0.85 + hash(id, 9) * 6.28) * 0.0045;
    const nx = (hash(id, k) - 0.5) * 0.014, nz = (hash(id, k + 99) - 0.5) * 0.014;
    return [Math.cos(a) * drift - Math.sin(a) * wob + nx, Math.sin(a) * drift + Math.cos(a) * wob + nz];
  }
  _chipPos(id, k) {
    const s = this._spotFor(id), [ox, oz] = this._stackOffset(id, k);
    return new THREE.Vector3(s.x + ox, s.y + CHIP_T * (k + 0.5) + 0.0005, s.z + oz);
  }
  _restTilt(mesh, id, k) {
    // a chip resting on a neighbour's bevel sits visibly off-level (~0.5 deg)
    mesh.rotation.x = (hash(id, k + 41) - 0.5) * 0.02;
    mesh.rotation.z = (hash(id, k + 57) - 0.5) * 0.02;
  }
  /**
   * Yaw that makes a chip face's numeral read upright on screen for the viewer at felt point (x,z):
   * the felt direction that projects to "screen up" is found by un-projecting a point just above it.
   */
  _viewYaw(x, z, y = 0.1) {
    const cam = this.viewer; if (!cam) return 0;
    cam.updateMatrixWorld();
    _v.set(x, y, z).project(cam);
    if (!(Math.abs(_v.x) < 4 && Math.abs(_v.y) < 4 && _v.z < 1)) return Math.atan2(cam.position.x - x, cam.position.z - z);
    _q.set(_v.x, _v.y + 0.03, _v.z).unproject(cam).sub(cam.position);
    if (Math.abs(_q.y) < 1e-6) return 0;
    const t = (y - cam.position.y) / _q.y;
    const dx = cam.position.x + _q.x * t - x, dz = cam.position.z + _q.z * t - z;
    // the numeral's top is the face's local -z
    return Math.atan2(-dx, -dz);
  }
  /** Square a stack toward the viewer: inserts aligned in a column, top numeral exact. */
  _squareStack(st, id) {
    if (!st.chips.length) return;
    const s = this._cs(id), yaw = this._viewYaw(s.x, s.z);
    const n = st.chips.length;
    st.chips.forEach((c, k) => {
      // edges are squared but each lower chip's inserts land at a random turn (+-pi/8): no CG barcode column
      const ry = yaw + (k === n - 1 ? 0 : (hash(id, k + 7) - 0.5) * (Math.PI / 3));
      c.ry = ry;
      const tws = this.tweens.filter((t) => t.mesh === c.mesh);
      const tw = tws.find((t) => t.ryEnd != null);
      if (tw) tw.ryEnd = ry; else if (!tws.length) c.mesh.rotation.y = ry;
    });
  }
  /** Re-square every stack for the current camera (shot modes call this after framing). */
  faceTop() { for (const [id, st] of this.stacks) this._squareStack(st, id); }

  _ensureAo(st, id) {
    if (!st.ao) { st.ao = new THREE.Mesh(this.aoGeo, this.aoMat); st.ao.renderOrder = 1; this.group.add(st.ao); }
    const s = this._spotFor(id); st.ao.position.set(s.x, 0.003 + s.y, s.z); st.ao.visible = st.chips.length > 0 && s.y === 0;
  }

  /** Set the visual amount for a bet. source: 'player' | 'house' | null (instant). */
  setBet(id, amount, { animate = true, source = 'player', delay = 0 } = {}) {
    let st = this.stacks.get(id);
    if (!st) { st = { amount: 0, chips: [] }; this.stacks.set(id, st); }
    const want = breakdown(amount);
    let keep = 0;
    while (keep < st.chips.length && keep < want.length && st.chips[keep].d.v === want[keep].v) keep++;
    const leaving = st.chips.splice(keep);
    const src = source === 'house' ? this._bankFor(this._cs(id).x) : PLAYER_RAIL;
    leaving.reverse().forEach((c, i) => { if (animate) this.fly(c.mesh, c.mesh.position.clone(), src, { delay: delay + i * 0.03, dur: 0.45, remove: true, spin: 2 }); else this._remove(c.mesh); });
    const added = [];
    for (let k = keep; k < want.length; k++) {
      const mesh = this.makeChip(want[k]);
      this._restTilt(mesh, id, k);
      const c = { mesh, d: want[k] }; st.chips.push(c); added.push([c, this._chipPos(id, k), k]);
    }
    // yaws first (squared to the viewer), then queue the flights so each chip lands squared
    this._squareStack(st, id);
    for (const [c, to, k] of added) {
      const mesh = c.mesh;
      mesh.rotation.y = c.ry;
      if (animate) { mesh.position.copy(src); this.fly(mesh, src.clone(), to, { delay: delay + (k - keep) * 0.06, dur: 0.5, sound: true, spin: 3, settle: true, ryEnd: c.ry }); }
      else mesh.position.copy(to);
    }
    st.amount = amount;
    this._ensureAo(st, id);
    if (!want.length) { this._dropStack(st); this.stacks.delete(id); }
    this._relayoutBox(boxOf(id), animate);
    this._restackDependents(id, animate);
    this._updateTags(this._inFlight());
  }
  _dropStack(st) {
    if (st.ao) { st.ao.visible = false; this.group.remove(st.ao); }
    if (st.tag) { this.group.remove(st.tag); st.tag.material.dispose(); st.tag = null; }
  }
  _restackDependents(id, animate) {
    for (const [oid, st] of this.stacks) {
      const s = this._cs(oid);
      if (s.stackOn !== id) continue;
      st.chips.forEach((c, k) => { const to = this._chipPos(oid, k); if (animate) this.fly(c.mesh, c.mesh.position.clone(), to, { dur: 0.3, arc: 0.1 }); else c.mesh.position.copy(to); });
      this._ensureAo(st, oid);
    }
  }

  /** Remove a bet's chips to a destination. Losses are swept low across the felt to the house. */
  clearBet(id, { to = 'player', animate = true, delay = 0 } = {}) {
    const st = this.stacks.get(id); if (!st) return;
    const house = to === 'house';
    const dest = house ? this._bankFor(this._cs(id).x) : PLAYER_RAIL;
    const n = st.chips.length;
    st.chips.forEach((c, i) => {
      if (!animate) { this._remove(c.mesh); return; }
      if (house) {
        // dealer sweep: the stack slides together along the felt, then lifts into the bank
        const p = c.mesh.position.clone();
        const mid = new THREE.Vector3(p.x * 0.6, p.y, p.z * 0.55 + (-FELT.hd + 1.2) * 0.45);
        this.fly(c.mesh, p, mid, { delay: delay + i * 0.004, dur: 0.42, arc: 0, curve: 'out', sound: 'sweep' });
        // ...then the dealer lifts them into the bank tray: each chip drops onto its denomination's column
        const bk = this._bankFor(p.x, i, c.d.v);
        const dist = Math.hypot(bk.x - mid.x, bk.z - mid.z);
        this.fly(c.mesh, mid, bk, { delay: 0.02 + (n - i) * 0.01, dur: 0.34 + dist * 0.02, arc: 0.3 + dist * 0.02, spin: 1, sound: 'bank', remove: true, ryEnd: hash('bankr', i) * 6.283 });
      } else {
        this.fly(c.mesh, c.mesh.position.clone(), dest.clone().add(new THREE.Vector3(i * 0.01, 0, 0)), { delay: delay + (n - 1 - i) * 0.03, dur: 0.55, remove: true, spin: 2, sound: i >= n - 4 ? 'rail' : false });
      }
    });
    this._dropStack(st);
    this.stacks.delete(id);
    this._restackDependents(id, animate);
    this._relayoutBox(boxOf(id), animate);
  }

  /** Move a stack to another bet id (come bet traveling to its number). */
  moveBet(from, to, { delay = 0, animate = true } = {}) {
    const st = this.stacks.get(from); if (!st) return;
    this.stacks.delete(from); if (st.ao) st.ao.visible = false;
    const dst = this.stacks.get(to);
    if (dst) { dst.chips.forEach((c) => this._remove(c.mesh)); this._dropStack(dst); }
    this.stacks.set(to, st);
    st.chips.forEach((c, k) => { const p = this._chipPos(to, k); if (animate) this.fly(c.mesh, c.mesh.position.clone(), p, { delay: delay + k * 0.02, dur: 0.7, arc: 0.6, settle: k === 0, ryEnd: c.mesh.rotation.y }); else c.mesh.position.copy(p); });
    this._squareStack(st, to);
    this._ensureAo(st, to);
    this._restackDependents(to, animate);
    this._relayoutBox(boxOf(to), animate);
  }

  /** Pay a win: chips come from the house, are stacked beside the bet, then go to the player's rail. */
  payWin(id, win, { delay = 0, down = false, hold = 0.9 } = {}) {
    const spot = this._spotFor(id);
    const pile = breakdown(win);
    const side = new THREE.Vector3(spot.x + CHIP_R * 2.15, 0, spot.z + 0.05);
    const yaw = this._viewYaw(side.x, side.z);
    pile.forEach((d, k) => {
      const mesh = this.makeChip(d);
      const ry = yaw + (k === pile.length - 1 ? 0 : (hash(id, k + 3) - 0.5) * (Math.PI / 3));
      mesh.rotation.y = ry;
      this._restTilt(mesh, id + 'w', k);
      // each payout leaves the bank on the dealer's side nearest the bet, low over the felt
      // lifted off the top of that denomination's column in the bank tray (hidden until its flight starts, so
      // the column never shows a doubled top chip)
      const bank = this._bankFor(spot.x, k, d.v);
      mesh.position.copy(bank); mesh.visible = false;
      const [ox, oz] = this._stackOffset(id + 'w', k);
      const p = side.clone(); p.y = CHIP_T * (k + 0.5) + 0.0005; p.x += ox; p.z += oz;
      const dist = Math.hypot(p.x - bank.x, p.z - bank.z);
      this.fly(mesh, bank, p, { delay: delay + k * 0.05, dur: 0.45 + dist * 0.022, sound: true, arc: PAY_ARC + dist * 0.025, spin: 3, settle: true, ryEnd: ry, grow: true, stackN: k === pile.length - 1 ? pile.length : 0 }); // last chip down -> dealer squares the stack (audio riffle)
      // queued after the first flight (tweens on the same mesh run sequentially)
      this.fly(mesh, p, PLAYER_RAIL.clone(), { delay: hold + (pile.length - k) * 0.03, dur: 0.6, remove: true, arc: 0.8, spin: 2, sound: 'rail' });
    });
    const fl = 0.45 + Math.hypot(side.x - HOUSE_BANK.x, side.z - HOUSE_BANK.z) * 0.022;
    if (down) this.clearBet(id, { to: 'player', delay: delay + fl + hold });
    return delay + fl + hold + 0.7;
  }

  /** Animate a list of rules events. Returns total duration in seconds. */
  applyEvents(events, { fast = false } = {}) {
    if (fast) { return 0; }
    let tEnd = 0;
    const losers = events.filter((e) => e.type === 'lose');
    losers.forEach((e, i) => this.clearBet(e.id, { to: 'house', delay: 0.15 + i * 0.06 }));
    if (losers.length) tEnd = 1.1;
    const moves = events.filter((e) => e.type === 'move');
    moves.forEach((e, i) => this.moveBet(e.id, e.to, { delay: 0.4 + i * 0.1 }));
    if (moves.length) tEnd = Math.max(tEnd, 1.2);
    let d = 0.55;
    for (const e of events.filter((x) => x.type === 'win')) { tEnd = Math.max(tEnd, this.payWin(e.id, e.win, { delay: d, down: e.down })); d += 0.12; }
    for (const e of events.filter((x) => x.type === 'push' && x.down)) { this.clearBet(e.id, { to: 'player', delay: 0.5 }); tEnd = Math.max(tEnd, 1.1); }
    return tEnd;
  }

  /** Make visuals match the rules state exactly (instant). */
  sync(bets) {
    for (const id of [...this.stacks.keys()]) if (!bets[id]) this.clearBet(id, { animate: false });
    // base stacks first so dependents get correct heights
    const ids = Object.keys(bets).sort((a, b) => (this._cs(a).stackOn ? 1 : 0) - (this._cs(b).stackOn ? 1 : 0));
    for (const id of ids) { const st = this.stacks.get(id); if (!st || st.amount !== bets[id]) this.setBet(id, bets[id], { animate: false }); }
    this._updateTags(this._inFlight());
  }

  /**
   * Chips in the player's chip-rail grooves representing the bankroll, racked the way a real rail holds them:
   * standing upright on edge, faces square to the groove, in tubes of up to 20 per denomination. Each tube is
   * one mipmapped cylinder whose texture carries every chip's edge (seams, inserts at each chip's own random
   * turn), so it stays smooth at any distance instead of aliasing into thin stripes; real chips cap both ends
   * and a soft contact shadow sits under each tube in the groove. Nothing is sheared: only rotations.
   */
  setRail(amount) {
    amount = Math.max(0, Math.floor(amount));
    if (amount === this.railAmount) return;
    this.railAmount = amount;
    for (const m of this.rail) this._remove(m);
    this.rail.length = 0;
    const counts = railBreakdown(amount);
    const order = [1000, 500, 100, 25, 5, 1];
    const S = RAIL_S, r = CHIP_R * S, t = CHIP_T * S, pitch = t + 0.0015;
    const TUBE = 20, gapTube = 0.1, gapDen = 0.3;
    // straight run of the near rail only (the player-side corners sweep round on FELT.cornerRNear)
    const X0 = -FELT.hw + (FELT.cornerRNear ?? 2.9) + 0.15, X1 = -4.4, y = RAIL.grooveY + r + 0.004;
    let x = X0, groove = 0;
    for (const v of order) {
      let left = counts[v] || 0; if (!left) continue;
      const d = DENOMS.find((dd) => dd.v === v);
      let ti = 0;
      while (left > 0) {
        const n = Math.min(TUBE, left); left -= n;
        const len = n * pitch;
        if (x + len > X1 && groove === 0) { groove = 1; x = X0; }
        const z = FELT.hd + RAIL.grooves[groove];
        const seed = v * 31 + ti * 7 + n;
        if (n >= 3) {
          const tube = new THREE.Mesh(this._tubeGeo(n, r, t, pitch), this._tubeMat(d, n, seed));
          tube.position.set(x + len / 2, y, z); tube.castShadow = true; tube.receiveShadow = true;
          this.group.add(tube); this.rail.push(tube);
        }
        // end chips (or every chip of a short run) are real chips: their faces show at the tube ends
        const ends = n >= 3 ? [0, n - 1] : Array.from({ length: n }, (_, i) => i);
        for (const i of ends) {
          const m = this.makeChip(d);
          // stand on edge with the axis exactly on the tube line (x), then spin about that axis only
          m.quaternion.setFromAxisAngle(_X, hash('rx' + seed, i) * Math.PI * 2).multiply(_Q.setFromAxisAngle(_Z, Math.PI / 2));
          m.scale.setScalar(S);
          m.position.set(x + (i + 0.5) * pitch, y, z);
          this.rail.push(m);
        }
        const sh = new THREE.Mesh(this.railShadowGeo || (this.railShadowGeo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2)), this._railShadowMat());
        sh.scale.set(len + 0.3, 1, 0.5); sh.position.set(x + len / 2, RAIL.grooveY + 0.012, z); sh.renderOrder = 1;
        this.group.add(sh); this.rail.push(sh);
        x += len + (left > 0 ? gapTube : gapDen); ti++;
      }
    }
  }
  _tubeGeo(n, r, t, pitch) {
    this.tubeGeos ??= new Map();
    let g = this.tubeGeos.get(n);
    if (!g) {
      // spans between the two end chips' inner faces (they cap it); radius just under the chip so the bevels read
      // one ring of vertices every 1/6 chip: each chip's rounded edges pinch into a shallow V at the seams, and
      // every chip gets its own tiny radius / centre wobble, so the tube reads as racked chips, not a pipe
      const L = n * pitch - t * 0.9, S = 6;
      g = new THREE.CylinderGeometry(r * 0.985, r * 0.985, L, 64, n * S, true);
      const p = g.attributes.position, R = rng(n * 977 + 13), wob = Array.from({ length: n }, () => [1 + (R() - 0.5) * 0.014, (R() - 0.5) * 0.006, (R() - 0.5) * 0.006]);
      for (let i = 0; i < p.count; i++) {
        const y = p.getY(i), f = (y + L / 2) / L * n, ci = Math.min(n - 1, Math.max(0, Math.floor(f - 1e-6))), fr = f - Math.floor(f + 1e-6);
        const edge = Math.min(fr, 1 - fr) * S; // 0 at a seam, 1 one ring in
        const k = wob[ci][0] * (edge < 0.5 ? 0.965 : edge < 1.5 ? 0.992 : 1);
        p.setX(i, p.getX(i) * k + wob[ci][1]); p.setZ(i, p.getZ(i) * k + wob[ci][2]);
      }
      g.computeVertexNormals();
      g.rotateZ(Math.PI / 2);
      this.tubeGeos.set(n, g);
    }
    return g;
  }
  _tubeMat(d, n, seed) {
    this.tubeMats ??= new Map();
    const key = d.v + ':' + n;
    let m = this.tubeMats.get(key);
    if (m) return m;
    const W = 1024, B = 48, H = n * B;
    const cv = document.createElement('canvas'); cv.width = W; cv.height = H; const ctx = cv.getContext('2d');
    const bv = document.createElement('canvas'); bv.width = W; bv.height = H; const bx = bv.getContext('2d');
    bx.fillStyle = '#ffffff'; bx.fillRect(0, 0, W, H);
    const R = rng(seed), iw = (INS_W / (Math.PI * 2)) * W;
    const rr = (x, y, w, h, r) => { ctx.beginPath(); if (ctx.roundRect) ctx.roundRect(x, y, w, h, r); else ctx.rect(x, y, w, h); ctx.fill(); };
    for (let i = 0; i < n; i++) {
      const y0 = i * B;
      ctx.fillStyle = d.side || d.base; ctx.fillRect(0, y0, W, B);
      // each chip is its own moulding: a slightly different value / warmth
      const vv = (R() - 0.5) * 0.1;
      ctx.fillStyle = vv > 0 ? `rgba(255,248,235,${vv})` : `rgba(0,0,0,${-vv})`; ctx.fillRect(0, y0, W, B);
      const ph = R() * W, jy = (R() - 0.5) * 3;
      // inserts: inlaid clay with softly rounded corners, antialiased (sub-pixel blur), a hair inside the chip's edge
      ctx.save(); ctx.filter = 'blur(0.9px)';
      for (let k = 0; k < 6; k++) {
        const uc = ph + (k / 6) * W + (R() - 0.5) * 4;
        for (const off of [-W, 0, W]) {
          ctx.fillStyle = d.spot; rr(uc + off - iw / 2, y0 + 3 + jy, iw, B - 6, 6);
          ctx.fillStyle = d.stripe; rr(uc + off - iw * 0.09, y0 + 3 + jy, iw * 0.18, B - 6, 3);
        }
      }
      ctx.restore();
      // rounded chip edges meet in a shallow V between neighbours: darker seam, soft highlight on each crown
      const g = ctx.createLinearGradient(0, y0, 0, y0 + B);
      g.addColorStop(0, 'rgba(0,0,0,0.55)'); g.addColorStop(0.16, 'rgba(0,0,0,0.12)'); g.addColorStop(0.5, 'rgba(255,255,255,0.06)');
      g.addColorStop(0.84, 'rgba(0,0,0,0.12)'); g.addColorStop(1, 'rgba(0,0,0,0.55)');
      ctx.fillStyle = g; ctx.fillRect(0, y0, W, B);
      const gb = bx.createLinearGradient(0, y0, 0, y0 + B);
      gb.addColorStop(0, '#000'); gb.addColorStop(0.22, '#bbb'); gb.addColorStop(0.5, '#fff'); gb.addColorStop(0.78, '#bbb'); gb.addColorStop(1, '#000');
      bx.fillStyle = gb; bx.fillRect(0, y0, W, B);
    }
    speckle(ctx, W, 0, { n: n * 900, seed: seed + 5 });
    const map = new THREE.CanvasTexture(cv); map.colorSpace = THREE.SRGBColorSpace; map.anisotropy = 16; map.wrapS = THREE.RepeatWrapping;
    const bump = new THREE.CanvasTexture(bv); bump.anisotropy = 8;
    m = this.lite
      ? new THREE.MeshStandardMaterial({ map, bumpMap: bump, bumpScale: 0.6, color: 0xececec, roughness: 0.36, metalness: 0, envMapIntensity: 1.0 })
      : new THREE.MeshPhysicalMaterial({ map, bumpMap: bump, bumpScale: 0.6, color: 0xececec, roughness: 0.46, metalness: 0, clearcoat: 0.6, clearcoatRoughness: 0.25, envMapIntensity: 1.0 });
    this.tubeMats.set(key, m);
    return m;
  }
  _railShadowMat() {
    if (this.railShadow) return this.railShadow;
    const cv = document.createElement('canvas'); cv.width = 256; cv.height = 64; const c = cv.getContext('2d');
    // a soft rounded bar: the tube touches the groove floor along its whole length
    c.filter = 'blur(9px)'; c.fillStyle = 'rgba(0,0,0,0.85)';
    c.beginPath(); c.roundRect ? c.roundRect(22, 20, 212, 24, 12) : c.rect(22, 20, 212, 24); c.fill();
    this.railShadow = new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(cv), transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
    return this.railShadow;
  }

  /**
   * Queue a flight. Tweens on the same mesh run sequentially.
   * spin: turns about the chip's axis during flight; settle: tiny wobble on landing;
   * curve: 'inout' (default) or 'out' (slides that start fast, e.g. dealer sweeps);
   * ryEnd: yaw the chip must land at (the spin unwinds into it, so stacks land squared).
   */
  fly(mesh, from, to, { delay = 0, dur = 0.5, arc = 0.5, remove = false, sound = false, spin = 0, settle = false, curve = 'inout', ryEnd = null, grow = false, shrink = false, stackN = 0, rail = null } = {}) {
    // flights to / from the player's chip rail follow a cubic path that lifts out of the groove and clears the
    // rail lip (RAIL top + a chip radius) before dropping onto the layout, instead of a sine arc through the wood
    if (rail == null) rail = from.distanceTo(PLAYER_RAIL) < 0.05 ? 'from' : to.distanceTo(PLAYER_RAIL) < 0.4 ? 'to' : null;
    if (rail) arc = 0;
    this.tweens.push({ mesh, from: from.clone(), to: to.clone(), t: -delay, dur, arc, remove, sound, spin, settle, curve, ryEnd, grow, shrink, stackN, rail, started: false });
  }
  /** Point on a rail <-> layout flight: P0 = groove, P1 straight up out of it, P2 above the felt edge, P3 = felt. */
  _railPoint(tw, e, out) {
    const toRail = tw.rail === 'to';
    const R0 = toRail ? tw.to : tw.from, F = toRail ? tw.from : tw.to, u = toRail ? 1 - e : e;
    const lip = RAIL_TOP + CHIP_R + 0.32;
    const p1x = R0.x + (F.x - R0.x) * 0.15, p1y = lip + 0.55, p1z = R0.z - 0.15;
    const p2x = R0.x + (F.x - R0.x) * 0.55, p2y = Math.max(lip + 0.1, F.y + 0.6), p2z = FELT.hd - 0.7;
    const a = (1 - u) ** 3, b = 3 * (1 - u) ** 2 * u, c = 3 * (1 - u) * u * u, d = u ** 3;
    out.set(a * R0.x + b * p1x + c * p2x + d * F.x, a * R0.y + b * p1y + c * p2y + d * F.y, a * R0.z + b * p1z + c * p2z + d * F.z);
    return Math.sin(Math.PI * u); // flight weight for the tilt
  }
  get busy() { return this.tweens.length > 0; }
  onLand = null; // callback(countLanded) for audio
  onRailLand = null; // callback(countLanded): chips returned to the player's rail (quieter variant)
  onSweep = null; // callback(count, pos): losing chips start sliding across the felt (dealer sweep)
  onBankLand = null; // callback(count, pos): swept chips drop into the house bank
  onPayStack = null; // callback(count, pos): a payout stack is complete beside the bet (dealer squares / riffles it)

  _inFlight() { return new Set(this.tweens.map((t) => t.mesh)); }
  _tagText(id, st) {
    const parts = [money(st.amount)];
    for (const [oid, o] of this.stacks) if ((this._cs(oid).stackOn === id || TAG_PARENT[oid] === id) && o.chips.length) parts.push(money(o.amount));
    return parts.join(' + ');
  }
  _updateTags(busy) {
    for (const [id, st] of this.stacks) {
      const spot = this._cs(id);
      const dependent = (spot.stackOn && this.stacks.has(spot.stackOn)) || (TAG_PARENT[id] && this.stacks.has(TAG_PARENT[id]));
      let show = this.tagsOn && !dependent && st.chips.length > 0;
      let topY = st.chips.length * CHIP_T, tx = spot.x;
      if (show) {
        for (const c of st.chips) if (busy.has(c.mesh)) { show = false; break; }
        for (const [oid, o] of this.stacks) if (this._cs(oid).stackOn === id) { topY += o.chips.length * CHIP_T; for (const c of o.chips) if (busy.has(c.mesh)) show = false; }
        // line bet + its odds beside it share one tag centred over the pair ("$25 + $50")
        for (const [oid, o] of this.stacks) if (TAG_PARENT[oid] === id && o.chips.length) { topY = Math.max(topY, o.chips.length * CHIP_T); tx = (spot.x + this._cs(oid).x) / 2; for (const c of o.chips) if (busy.has(c.mesh)) show = false; }
      }
      if (!show) { if (st.tag) st.tag.visible = false; continue; }
      const text = this._tagText(id, st), td = st.chips[st.chips.length - 1].d, key = text + '|' + td.v;
      if (!st.tag) {
        st.tag = new THREE.Sprite(new THREE.SpriteMaterial({ transparent: true, depthWrite: false, sizeAttenuation: false, toneMapped: false }));
        st.tag.center.set(0.5, 0); st.tag.renderOrder = 20; this.group.add(st.tag);
      }
      if (st.tagText !== key) {
        let e = this.tagCache.get(key); if (!e) { e = drawTag(text, td); this.tagCache.set(key, e); }
        st.tag.material.map = e.tex; st.tag.material.needsUpdate = true; st.tagText = key;
        st.tag.scale.set(TAG_H * e.aspect, TAG_H, 1);
      }
      st.tag.visible = true;
      // place / buy stacks sit just under the box numeral: their tag hangs in front of the stack (toward the
      // player) so the numeral above stays readable, as on live-dealer overlays
      const front = /^(place|buy)(4|5|6|8|9|10)$/.test(id);
      if (st.tagFront !== front) { st.tagFront = front; st.tag.center.set(0.5, front ? 1 : 0); st.tag.material.depthTest = false; st.tag.material.needsUpdate = true; }
      // other tags ride just BEHIND the stack (dealer side = up on screen), anchored at the stack's far rim, so the
      // pill never sits on the chips themselves
      if (front) st.tag.position.set(spot.x, 0.02, spot.z + CHIP_R + 0.1);
      else st.tag.position.set(tx, topY + 0.01, spot.z - CHIP_R - 0.06);
      // screen-constant pills shrink and soften when the camera is far away (overview), so the chips stay the subject
      const te = this.tagCache.get(key);
      const dist = this.viewer ? this.viewer.position.distanceTo(st.tag.position) : 12;
      // at overview distance the pill drops to ~half size and goes translucent: chips first, numbers second
      const f = Math.max(0.5, Math.min(1, 11 / dist));
      if (te) st.tag.scale.set(TAG_H * f * te.aspect, TAG_H * f, 1);
      st.tag.material.opacity = 0.55 + 0.45 * (f - 0.5) / 0.5;
    }
  }

  _updateFlyShadows(flying) {
    const pts = [];
    for (const m of flying) {
      if (m.rotation.z > 1 || !m.parent) continue;
      const p = m.position;
      if (Math.abs(p.x) > FELT.hw - 0.2 || Math.abs(p.z) > FELT.hd - 0.15) continue;
      // one shadow per small cluster (a stack moving together casts one shadow, not ten)
      const near = pts.find((q) => Math.abs(q.x - p.x) < 0.2 && Math.abs(q.z - p.z) < 0.2);
      if (near) { near.y = Math.min(near.y, p.y); continue; }
      pts.push({ x: p.x, z: p.z, y: p.y });
      if (pts.length >= MAX_FLY_SHADOWS) break;
    }
    this.flyShadows.forEach((s, i) => {
      const q = pts[i];
      // low chips (sliding / touching down) are already shadowed by the stack contact shadow
      if (!q || q.y < CHIP_T * 1.5) { s.visible = false; return; }
      const h = q.y;
      s.visible = true; s.position.set(q.x, 0.004, q.z);
      s.scale.setScalar(0.85 + h * 0.45); s.material.opacity = Math.min(0.9, 1.0 / (1 + h * 1.3));
    });
  }

  update(dt) {
    if (this.paused) return;
    this.time += dt;
    let landed = 0, railLanded = 0, swept = 0, banked = 0;
    const lp = { x: 0, y: 0, z: 0 }, rp = { x: 0, y: 0, z: 0 }, sp = { x: 0, y: 0, z: 0 }, bp = { x: 0, y: 0, z: 0 }; // summed positions (audio pan)
    const acc = (o, v) => { o.x += v.x; o.y += v.y; o.z += v.z; };
    const avg = (o, n) => ({ x: o.x / n, y: o.y / n, z: o.z / n });
    // process tweens in order; a mesh's later tween waits for earlier ones
    const activeMesh = new Set(), flying = new Set();
    for (let i = 0; i < this.tweens.length; i++) {
      const tw = this.tweens[i];
      if (activeMesh.has(tw.mesh)) continue;
      activeMesh.add(tw.mesh);
      tw.t += dt;
      if (tw.t < 0) continue;
      const m = tw.mesh;
      if (!tw.started) { tw.started = true; if (tw.grow) m.visible = true; tw.from.copy(m.position); tw.ry0 = m.rotation.y; tw.rx0 = m.rotation.x; tw.rz0 = m.rotation.z; if (tw.sound === 'sweep') { swept++; acc(sp, m.position); } }
      const k = Math.min(1, tw.t / tw.dur), e = tw.curve === 'out' ? easeOut(k) : tw.curve === 'in' ? k * k : ease(k);
      let wgt;
      if (tw.rail) wgt = this._railPoint(tw, e, m.position);
      else { m.position.lerpVectors(tw.from, tw.to, e); wgt = Math.sin(Math.PI * e); m.position.y += wgt * tw.arc; }

      const dv = m.userData.d?.v;
      if (dv != null) m.material = (tw.rail || tw.arc > 0.2) && wgt > 0.12 && k < 1 ? this.flyMats.get(dv) : this.mats.get(dv);
      if (tw.ryEnd != null) m.rotation.y = tw.ryEnd - tw.spin * 0.9 * (1 - e);
      else if (tw.spin) m.rotation.y = tw.ry0 + tw.spin * e * 0.9;
      if ((tw.arc > 0.2 || tw.rail) && m.rotation.z < 1) {
        // flight tilt (chips leave the hand slightly tipped, flatten as they arrive) + settle wobble. Kept small:
        // a steep tilt turned the glossy face into a mirror of the canopy lights and read as a washed-out chip
        const tilt = wgt * 0.14;
        let wob = 0;
        if (tw.settle && k > 0.82) { const s = (k - 0.82) / 0.18; wob = Math.sin(s * Math.PI * 3) * (1 - s) * 0.05; }
        m.rotation.x = tw.rx0 + tilt + wob;
        m.rotation.z = tw.rz0 + wob * 0.6;
      }
      if (k < 1) flying.add(m);
      else {
        tw.done = true;
        m.rotation.x = tw.rx0; m.rotation.z = tw.rz0;
        if (tw.ryEnd != null) m.rotation.y = tw.ryEnd;
        if (tw.grow) m.scale.setScalar(1);
        if (tw.sound === 'rail') { railLanded++; acc(rp, tw.to); } else if (tw.sound === 'bank') { banked++; acc(bp, tw.to); } else if (tw.sound === true) { landed++; acc(lp, tw.to); }
        if (tw.stackN && this.onPayStack) { try { this.onPayStack(tw.stackN, { x: tw.to.x, y: tw.to.y, z: tw.to.z }); } catch { } }
        if (tw.remove) this._remove(m);
      }
    }
    if (this.tweens.some((t) => t.done)) this.tweens = this.tweens.filter((t) => !t.done);
    this._updateFlyShadows(flying);
    this._updateTags(this._inFlight());
    if (landed && this.onLand) this.onLand(landed, avg(lp, landed));
    if (railLanded && this.onRailLand) this.onRailLand(railLanded, avg(rp, railLanded));
    if (swept && this.onSweep) this.onSweep(swept, avg(sp, swept));
    if (banked && this.onBankLand) this.onBankLand(banked, avg(bp, banked));
  }

  finishAll() {
    const p = this.paused; this.paused = false;
    for (let guard = 0; guard < 50 && this.tweens.length; guard++) this.update(10);
    this.paused = p;
  }
}
