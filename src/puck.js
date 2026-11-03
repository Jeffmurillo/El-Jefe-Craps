// puck.js - the ON/OFF point puck: a thick, glossy two-tone dealer puck (bright white "ON" face with a
// black band and heavy black lettering, black "OFF" face, split white/black rim) with a polished
// chamfer, recessed face, flip-and-slide animation and a soft landing wobble.
import * as THREE from 'three';
import { puckSpot } from './bets.js';
import { discGeometry } from './chips.js';

const R = 0.7, T = 0.15; // dealer puck ~1.4x the (display-scaled) chip: sits inside the number area's rules with margin, clear of neighbouring stacks

function face(text, light, N = 512, mirrorV = false) {
  const cv = document.createElement('canvas'); cv.width = cv.height = N; const ctx = cv.getContext('2d');
  const c = N / 2;
  if (mirrorV) { ctx.translate(0, N); ctx.scale(1, -1); }
  const bg = light ? '#ffffff' : '#0c0c0e', fg = light ? '#060607' : '#ffffff';
  ctx.fillStyle = bg; ctx.fillRect(0, 0, N, N);
  // faint moulded sheen (very subtle: the clear coat does the real highlight)
  const g = ctx.createRadialGradient(N * 0.4, N * 0.36, N * 0.03, c, c, N * 0.55);
  g.addColorStop(0, light ? 'rgba(255,255,255,0)' : 'rgba(255,255,255,0.07)'); g.addColorStop(1, light ? 'rgba(0,0,0,0.045)' : 'rgba(0,0,0,0)');
  ctx.fillStyle = g; ctx.fillRect(0, 0, N, N);
  // heavy contrasting band just inside the raised rim (the geometry recess starts at 0.84R)
  ctx.fillStyle = fg; ctx.beginPath(); ctx.arc(c, c, c * 0.8, 0, 6.2832); ctx.arc(c, c, c * 0.68, 6.2832, 0, true); ctx.fill();
  // fine engraved ring outside the band
  ctx.strokeStyle = light ? 'rgba(0,0,0,0.35)' : 'rgba(255,255,255,0.35)'; ctx.lineWidth = N * 0.006;
  ctx.beginPath(); ctx.arc(c, c, c * 0.9, 0, 6.2832); ctx.stroke();
  // little knurl ticks in the band
  ctx.fillStyle = bg;
  for (let k = 0; k < 4; k++) {
    const a = Math.PI / 4 + (k * Math.PI) / 2;
    ctx.beginPath(); ctx.arc(c + Math.cos(a) * c * 0.74, c + Math.sin(a) * c * 0.74, N * 0.018, 0, 6.2832); ctx.fill();
  }
  // lettering: as heavy as the font allows, plus a faux-bold stroke
  const FONT = '"Arial Black", "Segoe UI Black", "Segoe UI", Arial, sans-serif';
  const fs = N * (text.length > 2 ? 0.27 : 0.36);
  ctx.font = `900 ${fs}px ${FONT}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.save(); ctx.translate(c, c + N * 0.018); if (text.length > 2) ctx.scale(0.92, 1);
  ctx.fillStyle = fg; ctx.strokeStyle = fg; ctx.lineWidth = N * 0.012; ctx.lineJoin = 'round';
  ctx.fillText(text, 0, 0); ctx.strokeText(text, 0, 0);
  ctx.restore();
  const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
  return t;
}
/** Bump map for a puck face: a gentle moulded dome (so the clear coat's highlight rolls across the face instead
 *  of a flat matte disc) plus the engraved ring. */
function domeBump(N = 256, mirrorV = false) {
  const cv = document.createElement('canvas'); cv.width = cv.height = N; const ctx = cv.getContext('2d');
  const c = N / 2;
  if (mirrorV) { ctx.translate(0, N); ctx.scale(1, -1); }
  const g = ctx.createRadialGradient(c, c, 0, c, c, c);
  for (let i = 0; i <= 8; i++) { const r = i / 8, h = Math.round(90 + 150 * (1 - r * r)); g.addColorStop(r, `rgb(${h},${h},${h})`); }
  ctx.fillStyle = g; ctx.fillRect(0, 0, N, N);
  ctx.strokeStyle = 'rgba(0,0,0,0.6)'; ctx.lineWidth = N * 0.01; ctx.beginPath(); ctx.arc(c, c, c * 0.9, 0, 6.2832); ctx.stroke();
  return new THREE.CanvasTexture(cv);
}
/** Tangent-space normal map of a gently domed lacquer face (edge tilt ~k rad): fed to the clear coat, it makes
 *  the mirror-tight coat sweep across the bright canopy panels, so a crisp highlight streak runs over the face. */
function domeNormal(N = 256, k = 0.5) {
  const cv = document.createElement('canvas'); cv.width = cv.height = N; const ctx = cv.getContext('2d');
  const img = ctx.createImageData(N, N), c = N / 2;
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const u = (x + 0.5 - c) / c, v = (c - y - 0.5) / c, r = Math.min(1, Math.hypot(u, v));
    const s = k * Math.min(1, r * 1.1) / Math.max(r, 1e-4); // slope grows to the rim, flat centre
    let nx = u * s, ny = v * s, nz = 1; const l = Math.hypot(nx, ny, nz); nx /= l; ny /= l; nz /= l;
    const i = (y * N + x) * 4;
    img.data[i] = (nx * 0.5 + 0.5) * 255; img.data[i + 1] = (ny * 0.5 + 0.5) * 255; img.data[i + 2] = (nz * 0.5 + 0.5) * 255; img.data[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return new THREE.CanvasTexture(cv);
}
function sideTex() {
  const cv = document.createElement('canvas'); cv.width = 64; cv.height = 64; const ctx = cv.getContext('2d');
  ctx.fillStyle = '#0c0c0e'; ctx.fillRect(0, 32, 64, 32);
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, 64, 32);
  ctx.fillStyle = '#9a9a9a'; ctx.fillRect(0, 31, 64, 2);
  const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export class Puck {
  constructor(scene) {
    const geo = discGeometry(R, T, { bevel: 0.042, recess: 0.01, inlayR: R * 0.84, seg: 64, bevelSteps: 6 });
    // v = 1 at top: the side texture is drawn with white on the canvas top half (flipY maps it up)
    // no self-illumination: a lacquered puck reads from env-map reflections and a sharp clear-coat highlight
    // lacquered phenolic: a mirror-tight clear coat over a semi-gloss body, so the env's lamp bar lays a sharp
    // specular streak across the face (scene.environment feeds every MeshPhysicalMaterial)
    const gloss = { clearcoat: 1, clearcoatRoughness: 0.025, envMapIntensity: 2.4, specularIntensity: 1 };
    const side = new THREE.MeshPhysicalMaterial({ map: sideTex(), color: 0xffffff, roughness: 0.16, ...gloss });
    const onTex = face('ON', true);
    const on = new THREE.MeshPhysicalMaterial({ map: onTex, color: 0xffffff, roughness: 0.12, bumpMap: domeBump(), bumpScale: 4, ...gloss, clearcoatNormalMap: domeNormal(256, 1.0), clearcoatNormalScale: new THREE.Vector2(1, 1) });
    const off = new THREE.MeshPhysicalMaterial({ map: face('OFF', false, 512, false), roughness: 0.14, bumpMap: domeBump(256, true), bumpScale: 4, ...gloss });
    this.mesh = new THREE.Mesh(geo, [side, on, off]);
    this.mesh.castShadow = true; this.mesh.receiveShadow = true;
    this.root = new THREE.Group(); this.root.add(this.mesh); this.root.name = 'puck';
    // contact shadow
    const cv = document.createElement('canvas'); cv.width = cv.height = 64; const c2 = cv.getContext('2d');
    const gr = c2.createRadialGradient(32, 32, 14, 32, 32, 31); gr.addColorStop(0, 'rgba(0,0,0,0.6)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
    c2.fillStyle = gr; c2.fillRect(0, 0, 64, 64);
    this.ao = new THREE.Mesh(new THREE.PlaneGeometry(R * 2.8, R * 2.8).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(cv), transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }));
    this.ao.renderOrder = 1;
    scene.add(this.root, this.ao);
    this.point = null;
    this.anim = null;
    this.yaw = 0;       // lettering reads toward the player (+z); faceToward() squares it to a camera
    this.viewer = null; // camera the lettering is squared to whenever the puck is placed
    this.paused = false;
    this._place(null);
  }
  /** Square the lettering so it reads upright for this camera (dealers set the puck facing the players). */
  faceToward(cam) {
    if (cam) this.viewer = cam;
    this.yaw = this._yawAt(this.root.position);
    this.root.rotation.y = this.yaw;
  }
  /** Yaw that makes the lettering read upright on screen for the viewer camera at felt point p. */
  _yawAt(p) {
    const cam = this.viewer; if (!cam) return this.yaw;
    cam.updateMatrixWorld();
    const v = p.clone().project(cam);
    if (!(Math.abs(v.x) < 4 && Math.abs(v.y) < 4 && v.z < 1)) return Math.atan2(cam.position.x - p.x, cam.position.z - p.z);
    const q = new THREE.Vector3(v.x, v.y + 0.03, v.z).unproject(cam).sub(cam.position);
    if (Math.abs(q.y) < 1e-6) return this.yaw;
    const t = (p.y - cam.position.y) / q.y;
    return Math.atan2(-(cam.position.x + q.x * t - p.x), -(cam.position.z + q.z * t - p.z));
  }
  _target(point) { const s = puckSpot(point); return { pos: new THREE.Vector3(s.x, T / 2 + 0.002, s.z), flip: point ? 0 : Math.PI }; }
  _place(point) {
    const t = this._target(point); this.root.position.copy(t.pos);
    this.yaw = this._yawAt(t.pos); this.root.rotation.y = this.yaw;
    // the OFF face is the underside: flipping about x mirrors the text direction, so turn it back
    this.mesh.rotation.set(t.flip, 0, 0); // (table owner) a PI yaw here rendered OFF upside down
    this.ao.position.set(t.pos.x, 0.003, t.pos.z); this.ao.scale.setScalar(1); this.ao.material.opacity = 1;
  }
  /** Set point (null = OFF). */
  set(point, { animate = true } = {}) {
    if (this.paused || (point === this.point && !this.anim)) return false;
    const prev = this.point; this.point = point;
    if (!animate) { this.anim = null; this._place(point); return true; }
    const t = this._target(point);
    const r0 = this.mesh.rotation.x;
    // flip when switching ON<->OFF; between two points it just slides with a small hop
    const r1 = prev && point ? r0 : t.flip;
    // a flip needs ~R of lift to turn over without cutting the felt; a point-to-point move is a low slide
    const hop = prev && point ? 0.22 : R * 0.96;
    let yw1 = this._yawAt(t.pos), yw0 = this.root.rotation.y;
    while (yw1 - yw0 > Math.PI) yw1 -= Math.PI * 2; while (yw1 - yw0 < -Math.PI) yw1 += Math.PI * 2;
    this.anim = { t: 0, dur: 0.9, from: this.root.position.clone(), to: t.pos, r0, r1, y0: this.mesh.rotation.y, y1: 0, hop, wob: 0, yw0, yw1 };
    return true;
  }
  update(dt) {
    const a = this.anim; if (!a || this.paused) return;
    a.t += dt;
    const k = Math.min(1, a.t / a.dur); const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
    if (a.t <= a.dur) {
      this.root.position.lerpVectors(a.from, a.to, e);
      const lift = Math.sin(Math.PI * e) * a.hop;
      this.root.position.y += lift;
      this.mesh.rotation.x = a.r0 + (a.r1 - a.r0) * e;
      this.mesh.rotation.y = a.y0 + (a.y1 - a.y0) * e;
      this.root.rotation.y = a.yw0 + (a.yw1 - a.yw0) * e;
      this.mesh.rotation.z = Math.sin(Math.PI * e) * 0.12;
      this.ao.position.set(this.root.position.x, 0.003, this.root.position.z);
      this.ao.scale.setScalar(1 + lift * 0.8); this.ao.material.opacity = 1 / (1 + lift * 2.5);
      if (k >= 1) this.onLand?.();
      return;
    }
    // landing wobble (damped rock about a random-ish axis), ~0.35 s
    const s = (a.t - a.dur) / 0.35;
    if (s >= 1) { this.anim = null; this._place(this.point); return; }
    const w = Math.sin(s * Math.PI * 4) * (1 - s) * (1 - s) * 0.06;
    this.mesh.rotation.x = a.r1 + w; this.mesh.rotation.z = w * 0.7;
    this.root.position.y = a.to.y + Math.abs(w) * R * 0.5;
  }
}
