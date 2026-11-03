// dice.js — casino-grade translucent dice.
//  - Body: cellulose-acetate look computed analytically inside the cube. One shader serves every quality
//    tier (it never samples a screen-space transmission buffer, so low / medium / high and the headless
//    capture all render the same die). Each fragment refracts the view ray into the die, traces it to the
//    far faces (with total internal reflection), applies Beer-Lambert absorption over the true path length
//    (thin edges and corners glow bright red, the thick core and grazing views go deep oxblood), lights it
//    by what lies beyond that face (overhead key above, dark felt below) and shows the far faces' pips
//    through the body as crisp pale discs, displaced by refraction.
//  - Polished faces: clearcoat + studio "softbox" reflections (a broad window panel, a tall rim strip and
//    an overhead key strip, placed relative to the viewer) so every face carries a soft specular gradient
//    and a window-like highlight sheet, not a flat fill.
//  - Precision edges: 8-segment micro bevel, clearcoat roughness widened on the bevel (specular AA).
//  - Pips: pure white flush drilled-and-filled paint with a dished normal (meniscus highlight) and a thin
//    grey contact ring where paint meets acetate. Opposite faces sum to 7, standard counter-clockwise
//    1-2-3 handedness.
//  - Grounding: a tight dark contact line hugging the footprint, a soft penumbra, and a focused red
//    caustic thrown through the die onto the cloth on the side away from the overhead key.
//  - Throw playback from a recorded physics trajectory, value remapping and a rail-side pickup.
//    No motion trail (the old onion-skin ghosts are gone): at 60 fps the tumble reads cleanly on its own.
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { DIE_SIZE, DIE_RADIUS, FACE_AXES } from './physics.js';
import { FELT } from './bets.js';

// value -> local face axis (opposite faces sum to 7).
// 1:+y, 2:+z, 3:+x => viewed from the 1-2-3 corner the faces run counter-clockwise (Western/casino dice).
export const VALUE_AXIS = { 1: [0, 1, 0], 6: [0, -1, 0], 2: [0, 0, 1], 5: [0, 0, -1], 3: [1, 0, 0], 4: [-1, 0, 0] };
const PIP_LAYOUT = {
  1: [[0, 0]],
  2: [[-1, -1], [1, 1]],
  3: [[-1, -1], [0, 0], [1, 1]],
  4: [[-1, -1], [1, -1], [-1, 1], [1, 1]],
  5: [[-1, -1], [1, -1], [0, 0], [-1, 1], [1, 1]],
  6: [[-1, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [1, 1]],
};
const BEVEL = DIE_RADIUS / DIE_SIZE; // casino "razor" edge with a hair of radius (shared with physics)
const BEVEL_SEGS = 8;
const PIP_R = 0.094;          // pip radius as fraction of size (19mm die, ~3.6mm pips)
const PIP_SPACING = 0.272;    // pip grid spacing as fraction of size
const HALF = DIE_SIZE / 2;
const KEY_XZ = [0, 2.0];      // overhead key light footprint on the table (scene.js key position x,z)
const f4 = (v) => v.toFixed(5);

function faceBasis(n) {
  const t1 = Math.abs(n.y) > 0.5 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
  const t2 = new THREE.Vector3().crossVectors(n, t1);
  return { t1, t2 };
}

/** For every pip: build() -> geometry part (in +y face space), oriented and placed. Returns the merge. */
function buildPerPip(size, build) {
  const h = size / 2, spacing = size * PIP_SPACING;
  const parts = [];
  for (const [vStr, axis] of Object.entries(VALUE_AXIS)) {
    const n = new THREE.Vector3(...axis);
    const { t1, t2 } = faceBasis(n);
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), n);
    for (const [a, b] of PIP_LAYOUT[Number(vStr)]) {
      const p = n.clone().multiplyScalar(h).addScaledVector(t1, a * spacing).addScaledVector(t2, b * spacing);
      const g = build();
      g.applyQuaternion(q); g.translate(p.x, p.y, p.z);
      // every vertex of this pip knows its pip's centre and face normal (die-local): the fragment shader
      // traces the view ray into the shallow drilled recess from them
      const cnt = g.attributes.position.count, C = new Float32Array(cnt * 3), N = new Float32Array(cnt * 3);
      for (let k = 0; k < cnt; k++) { C.set([p.x, p.y, p.z], k * 3); N.set([n.x, n.y, n.z], k * 3); }
      g.setAttribute('pipC', new THREE.BufferAttribute(C, 3)); g.setAttribute('pipN', new THREE.BufferAttribute(N, 3));
      parts.push(g);
    }
  }
  return mergeGeometries(parts);
}

/**
 * One filled pip: a flush disc whose normals dish gently inward (the paint sits in a drilled cup, so its
 * polished surface is very slightly concave and curls up into a meniscus at the rim). The recess wall,
 * its occlusion and the paint/acetate break are shaded per fragment (see the pip material).
 */
function pipDisc(r) {
  //            radius  (unused)  normal tilt toward centre
  const rings = [[0.0, 1, 0.0], [0.45, 1, 0.03], [0.7, 1, 0.08], [0.84, 1, 0.16], [0.92, 1, 0.26], [0.97, 1, 0.38], [1.0, 1, 0.5]];
  const SEG = 48, pos = [], nor = [], col = [], idx = [];
  for (let k = 0; k < rings.length; k++) {
    const [rr, c, tilt] = rings[k];
    const n = k === 0 ? 1 : SEG;
    for (let s = 0; s < n; s++) {
      const a = (s / SEG) * Math.PI * 2, cx = Math.cos(a), cz = Math.sin(a);
      pos.push(cx * rr * r, 0, cz * rr * r);
      const nv = new THREE.Vector3(-cx * tilt, 1, -cz * tilt).normalize();
      nor.push(nv.x, nv.y, nv.z); col.push(c, c, c);
    }
  }
  const ringStart = (k) => (k === 0 ? 0 : 1 + (k - 1) * SEG);
  for (let s = 0; s < SEG; s++) idx.push(0, ringStart(1) + ((s + 1) % SEG), ringStart(1) + s);
  for (let k = 1; k < rings.length - 1; k++) {
    const A = ringStart(k), B = ringStart(k + 1);
    for (let s = 0; s < SEG; s++) {
      const s1 = (s + 1) % SEG;
      idx.push(A + s, A + s1, B + s, A + s1, B + s1, B + s);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setIndex(idx);
  return g;
}
function capGeometry(size) {
  const r = size * PIP_R, lift = size * 0.0003;
  return buildPerPip(size, () => { const g = pipDisc(r); g.translate(0, lift, 0); return g; });
}

/** Contact shadow: a tight near-black contact line on the footprint, a dark core, a soft penumbra. */
function shadowTexture(square) {
  const N = 512; const cv = document.createElement('canvas'); cv.width = cv.height = N; const ctx = cv.getContext('2d');
  const rr = (s, a, rad = 0.06) => {
    const x = (N - s) / 2, r = s * rad;
    ctx.fillStyle = `rgba(0,0,0,${a})`;
    ctx.beginPath(); ctx.moveTo(x + r, x); ctx.arcTo(x + s, x, x + s, x + s, r); ctx.arcTo(x + s, x + s, x, x + s, r); ctx.arcTo(x, x + s, x, x, r); ctx.arcTo(x, x, x + s, x, r); ctx.fill();
  };
  if (square) {
    // plane is 1.75 die sizes: the footprint is 0.571 N wide; 1 mm of a 19 mm die ~ 0.030 of the footprint
    for (let i = 0; i < 26; i++) { const k = i / 25; rr(N * (0.98 - k * 0.38), 0.016 + k * 0.022, 0.14); } // soft penumbra
    for (let i = 0; i < 6; i++) rr(N * (0.612 - i * 0.006), 0.16, 0.08);                                   // dark core ~2 mm out
    rr(N * 0.584, 0.82, 0.05);                                                                             // crisp contact line < 0.5 mm
  } else {
    const g = ctx.createRadialGradient(N / 2, N / 2, 4, N / 2, N / 2, N / 2 - 2);
    g.addColorStop(0, 'rgba(0,0,0,0.7)'); g.addColorStop(0.5, 'rgba(0,0,0,0.3)'); g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, N, N);
  }
  const t = new THREE.CanvasTexture(cv); t.anisotropy = 4; return t;
}

/**
 * Focused red caustic: light concentrated by the acetate cube into a small, fairly sharp patch inside the
 * die's own shadow. Alpha-blended dark red (it tints the shadowed cloth, it never adds light), with a
 * crisp core and a short falloff. No canvas filters (unsupported on some headless canvases).
 */
function causticTexture() {
  const N = 256; const cv = document.createElement('canvas'); cv.width = cv.height = N; const ctx = cv.getContext('2d');
  const g = ctx.createRadialGradient(N / 2, N / 2, 0, N / 2, N / 2, N / 2);
  g.addColorStop(0, 'rgba(150,18,12,0.8)'); g.addColorStop(0.4, 'rgba(128,12,8,0.62)');
  g.addColorStop(0.66, 'rgba(96,6,4,0.2)'); g.addColorStop(0.84, 'rgba(70,2,2,0.04)'); g.addColorStop(1, 'rgba(60,0,0,0)');
  ctx.fillStyle = g; ctx.fillRect(0, 0, N, N);
  const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; return t;
}

/**
 * GLSL: studio softbox reflections in view space (camera at the origin). The panels sit around the
 * viewer the way a product photographer rigs them, so a face turned toward a panel shows a broad sheet
 * whose edge falls across it (perspective varies the reflection vector over the face) — a soft
 * specular gradient on every visible face instead of a uniform fill.
 */
const SOFTBOX_GLSL = /* glsl */`
float dieBox(vec3 R, vec3 C, vec3 T1, float hu, float hv, float soft) {
  float w = dot(R, C);
  if (w <= 0.05) return 0.0;
  vec3 T2 = normalize(cross(C, T1));
  float u = dot(R, T1) / w, v = dot(R, T2) / w;
  float m = (1.0 - smoothstep(hu - soft, hu + soft, abs(u))) * (1.0 - smoothstep(hv - soft, hv + soft, abs(v)));
  return m * mix(0.45, 1.0, smoothstep(-hv, hv, v)); // brighter toward the panel's top: a graded sheet
}
vec3 dieSoftbox(vec3 N, vec3 V, mat4 viewM) {
  vec3 R = reflect(-V, N);
  vec3 upV = normalize((viewM * vec4(0.0, 1.0, 0.0, 0.0)).xyz);
  vec3 sideV = normalize(cross(upV, vec3(0.0, 0.0, 1.0)));
  float c = clamp(dot(N, V), 0.0, 1.0);
  float F = 0.04 + 0.96 * pow(1.0 - c, 5.0);
  float L = 0.0;
  // broad window panel up-left of the viewer
  L += 7.0 * dieBox(R, normalize(-0.8 * sideV + 0.35 * upV + 0.5 * vec3(0.0, 0.0, 1.0)), sideV, 0.55, 0.7, 0.35);
  // tall narrow rim strip to the right, slightly behind the dice
  L += 7.0 * dieBox(R, normalize(0.85 * sideV + 0.2 * upV + 0.1 * vec3(0.0, 0.0, 1.0)), sideV, 0.16, 0.9, 0.14);
  // overhead canopy (world up): a broad, soft ceiling panel every upward-turned bevel catches
  L += 1.1 * dieBox(R, upV, sideV, 0.9, 0.5, 0.35);
  // dim room dome: keeps grazing faces and every bevel catching a little neutral light
  L += 0.35 * smoothstep(-0.2, 0.7, dot(R, upV));
  // neutral (untinted), Fresnel-limited and compressed so a sheet never exceeds paper white and the red
  // body under it never clips toward orange
  float S = L * F;
  return vec3(0.92 * S / (1.0 + S));
}
`;

/**
 * Shader patch shared by every die material:
 *  - contact occlusion: light falls off within ~0.35 die sizes of the felt;
 *  - dissolve: screen-door discard driven by one shared uniform (pickup fade), no recompiles;
 *  - studio softbox reflections (see SOFTBOX_GLSL), scaled by `box`.
 */
function patchMaterial(mat, fadeU, { ao = 0.5, key = '', box = 1 } = {}) {
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uDiceFade = fadeU;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying float vDiceY;')
      .replace('#include <project_vertex>', '#include <project_vertex>\nvDiceY = (modelMatrix * vec4(transformed, 1.0)).y;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vDiceY;\nuniform float uDiceFade;\n' + SOFTBOX_GLSL)
      .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>
        if (uDiceFade < 0.999) {
          float ign = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
          if (ign >= uDiceFade) discard;
        }`)
      .replace('#include <opaque_fragment>', `outgoingLight += ${box.toFixed(3)} * dieSoftbox(normalize(normal), normalize(vViewPosition), viewMatrix);
        outgoingLight *= mix(${ao.toFixed(3)}, 1.0, smoothstep(0.0, ${(DIE_SIZE * 0.36).toFixed(4)}, vDiceY));
        { // reflections stay neutral: warm light reflected off the clear coat must not push the red body
          // (or the white paint) toward orange / cream, so any green excess over blue is mostly removed
          float m = min(outgoingLight.g, outgoingLight.b);
          outgoingLight.g = m + (outgoingLight.g - m) * 0.3;
        }
        #include <opaque_fragment>`);
  };
  mat.customProgramCacheKey = () => 'dice-ao' + ao + key + '-sb' + box;
  return mat;
}

/** GLSL: the acetate volume (see file header). Adds to outgoingLight before the contact occlusion. */
const VOLUME_GLSL = /* glsl */`
float diePipDist(int v, vec2 uv) {
  float d = 1e3;
  if (v == 1 || v == 3 || v == 5) d = min(d, length(uv));
  if (v >= 2) { d = min(d, length(uv - vec2(-1.0, -1.0))); d = min(d, length(uv - vec2(1.0, 1.0))); }
  if (v >= 4) { d = min(d, length(uv - vec2(1.0, -1.0))); d = min(d, length(uv - vec2(-1.0, 1.0))); }
  if (v == 6) { d = min(d, length(uv - vec2(-1.0, 0.0))); d = min(d, length(uv - vec2(1.0, 0.0))); }
  return d;
}
// distance (in pip radii) from local point p to the nearest pip centre on face n
float diePipR(vec3 p, vec3 n) {
  int v = n.y > 0.5 ? 1 : n.y < -0.5 ? 6 : n.z > 0.5 ? 2 : n.z < -0.5 ? 5 : n.x > 0.5 ? 3 : 4;
  vec3 t1 = abs(n.y) > 0.5 ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 1.0, 0.0);
  vec3 t2 = cross(n, t1);
  vec2 uv = vec2(dot(p, t1), dot(p, t2)) / ${f4(DIE_SIZE * PIP_SPACING)};
  return diePipDist(v, uv) / ${f4(PIP_R / PIP_SPACING)};
}
// radiance arriving from beyond the die along local direction d: one smooth function of the ray's
// elevation (dark felt below, room at the horizon, the overhead key above) with no step anywhere
vec3 dieLightIn(vec3 d, vec3 upL) {
  float u = dot(d, upL);
  float room = 0.55, felt = 0.10, key = 2.3;
  float l = mix(felt, room, smoothstep(-0.85, 0.15, u)) + key * pow(smoothstep(0.05, 1.0, u), 2.0);
  return vec3(l);
}
// one refracted ray through the cube to the far face it exits: Beer-Lambert absorption over that true
// path (thin edges and corners glow, the thick core goes deep oxblood), lit by what lies beyond along the
// refracted direction. Everything here is continuous in the ray (exit point, path length, direction), so
// the body shades as one smooth gradient with no band where the ray switches from one far face to
// another. The far faces' pips show through as small, crisp, refracted discs with a dark rim, dimmer on
// faces that are themselves brightly lit.
vec3 dieTrace(vec3 ro, vec3 n, vec3 I, vec3 upL, out float Lout) {
  const float H = ${f4(HALF)};
  const vec3 SIGMA = vec3(${f4(0.62 / DIE_SIZE)}, ${f4(12.0 / DIE_SIZE)}, ${f4(11.0 / DIE_SIZE)});
  vec3 rd = refract(I, n, 1.0 / 1.49);
  if (dot(rd, rd) < 1e-4) rd = -n;
  vec3 p = ro - n * 1e-4;
  vec3 sd = sign(rd); sd = mix(vec3(1.0), sd, abs(sd));
  vec3 tv = (sd * H - p) / (rd + sd * 1e-6);
  float t = max(0.0, min(tv.x, min(tv.y, tv.z)));
  vec3 pe = p + rd * t;
  Lout = t;
  vec3 nE = (tv.x <= tv.y && tv.x <= tv.z) ? vec3(sd.x, 0.0, 0.0) : (tv.y <= tv.z ? vec3(0.0, sd.y, 0.0) : vec3(0.0, 0.0, sd.z));
  vec3 att = exp(-SIGMA * t);
  vec3 body = 0.92 * att * dieLightIn(rd, upL);
  // far-face pip, seen through ~1.5 IOR: drawn at 62% of its radius (refraction shrinks the far disc), anti-aliased crisp edge, dark rim
  float r = diePipR(pe, nE);
  float w = max(fwidth(r), 0.02);
  float pm = 1.0 - smoothstep(0.62 - w, 0.62 + w, r);
  float rim = (1.0 - smoothstep(0.72 - w, 0.72 + w, r)) - pm;
  float lit = smoothstep(0.2, 0.9, dot(n, upL));
  float op = mix(0.32, 0.1, lit) * (0.5 + 0.5 * att.r);
  vec3 pipBack = vec3(0.62, 0.2, 0.19) * (0.35 + 0.65 * att.r);
  body = mix(body, pipBack, clamp(pm * op, 0.0, 1.0));
  body *= 1.0 - 0.28 * rim * (1.0 - lit * 0.6);
  return body;
}
vec3 dieVolume(vec3 ro, vec3 n, vec3 camL, vec3 upL) {
  vec3 I = normalize(ro - camL);
  float Fin = 0.04 + 0.96 * pow(1.0 - clamp(dot(-I, n), 0.0, 1.0), 5.0);
  // two barely spread rays (micro-roughness of the polished faces): crisp internal edges without aliasing
  vec3 t1 = abs(n.y) > 0.5 ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 1.0, 0.0);
  vec3 t2 = cross(n, t1);
  vec3 acc = vec3(0.0); float L = 0.0, Lk;
  acc += dieTrace(ro, normalize(n + 0.03 * t1 + 0.02 * t2), I, upL, Lk); L += Lk;
  acc += dieTrace(ro, normalize(n - 0.03 * t1 - 0.02 * t2), I, upL, Lk); L += Lk;
  acc *= 0.5; L *= 0.5;
  // forward scatter of the key in the body: strongest where the acetate is thin (edges, corners) and
  // toward the lit top of the die; a smooth function of height and thickness
  float hi = smoothstep(-${f4(HALF)}, ${f4(HALF)}, dot(ro, upL));
  vec3 scatter = vec3(0.26, 0.010, 0.012) * (0.35 + 0.65 * exp(-L * ${f4(1.2 / DIE_SIZE)})) * (0.45 + 0.55 * hi);
  return (acc + scatter) * (1.0 - Fin);
}
`;

const _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _v = new THREE.Vector3(), _w = new THREE.Quaternion();
const AXES = FACE_AXES.map((a) => new THREE.Vector3(...a));

/**
 * Pick the moment of a recorded throw where the pair reads best mid-air: both dice clearly airborne
 * and their silhouettes as far apart as possible across the given (horizontal) view direction.
 */
export function pickRollTime(sim, viewDir = [1, 0, -1]) {
  const vl = Math.hypot(viewDir[0], viewDir[2]) || 1, vx = viewDir[0] / vl, vz = viewDir[2] / vl;
  let best = -Infinity, bestT = 0.2, apexK = 0, yMax = -1;
  sim.frames.forEach((f, k) => { const y = (f.p[1] + f.p[4]) / 2; if (y > yMax) { yMax = y; apexK = k; } });
  // the descent just before the first felt impact: both dice still airborne but low (so each one's soft
  // shadow sits right under it and reads as part of the same moment), as far apart as possible
  for (let k = apexK; k < sim.frames.length; k++) {
    const f = sim.frames[k];
    const lo = Math.min(f.p[1], f.p[4]), hi = Math.max(f.p[1], f.p[4]);
    if (lo < DIE_SIZE * 0.95) break;                                // a die has met the cloth
    if (hi > DIE_SIZE * 2.6) continue;                              // still too high above its shadow
    const dx = f.p[3] - f.p[0], dy = f.p[4] - f.p[1], dz = f.p[5] - f.p[2];
    const across = Math.abs(dx * vz - dz * vx);                    // separation perpendicular to the view
    const s = Math.hypot(across, dy * 0.8) - lo * 0.4;              // prefer lower, wider-apart frames
    if (s > best) { best = s; bestT = k / sim.fps; }
  }
  if (best === -Infinity) { // never low together: fall back to the last frame before the first touchdown
    for (let k = apexK; k < sim.frames.length; k++) { const f = sim.frames[k]; if (Math.min(f.p[1], f.p[4]) < DIE_SIZE * 0.95) break; bestT = k / sim.fps; }
  }
  return bestT;
}

export class DiceSet {
  constructor(scene /* , opts: quality options are accepted but unused — one shader serves every tier */) {
    this.scene = scene;
    this.size = DIE_SIZE;
    this.group = new THREE.Group(); this.group.name = 'dice';
    scene.add(this.group);
    this.fadeU = { value: 1 };
    this.bodyGeo = new RoundedBoxGeometry(DIE_SIZE, DIE_SIZE, DIE_SIZE, BEVEL_SEGS, DIE_SIZE * BEVEL);
    const capGeo = capGeometry(DIE_SIZE);
    this.capGeo = capGeo;
    const env = scene.environment || null;
    this.makeMaterials();
    // filled paint: a satin white (rougher than the acetate) under a thinner, separate clearcoat, so it
    // reads as a different material; slightly cool base + neutral self-illumination keep it paper white
    // (not cream) under the warm key. Each pip sits a hair below the face in a drilled cup: the fragment
    // shader traces the view ray into that recess, so the acetate wall shows as a thin dark crescent on
    // the far side (wider at oblique views, lighter where the wall faces the overhead key) and the paint
    // darkens softly toward the rim (recess occlusion, which thins at grazing angles) — no printed outline.
    this.pipMat = patchMaterial(new THREE.MeshPhysicalMaterial({
      color: 0xe6ebf4, roughness: 0.42, metalness: 0, clearcoat: 0.45, clearcoatRoughness: 0.06,
      specularIntensity: 0.5, transparent: true,
      emissive: new THREE.Color(0x6d7076), envMap: env, envMapIntensity: 0.7,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4,
    }), this.fadeU, { ao: 0.8, key: 'pip', box: 0.45 });
    {
      const base = this.pipMat.onBeforeCompile;
      this.pipMat.onBeforeCompile = (sh, r) => {
        base(sh, r);
        sh.vertexShader = sh.vertexShader
          .replace('#include <common>', '#include <common>\nattribute vec3 pipC;\nattribute vec3 pipN;\nvarying vec3 vPL;\nvarying vec3 vPC;\nvarying vec3 vPN;\nvarying vec3 vPCam;\nvarying vec3 vPUp;')
          .replace('#include <project_vertex>', `#include <project_vertex>
            vPL = position; vPC = pipC; vPN = pipN;
            vPCam = (inverse(modelMatrix) * vec4(cameraPosition, 1.0)).xyz;
            vPUp = normalize(transpose(mat3(modelMatrix)) * vec3(0.0, 1.0, 0.0));`);
        sh.fragmentShader = sh.fragmentShader
          .replace('#include <common>', '#include <common>\nvarying vec3 vPL;\nvarying vec3 vPC;\nvarying vec3 vPN;\nvarying vec3 vPCam;\nvarying vec3 vPUp;')
          .replace('#include <color_fragment>', `#include <color_fragment>
          {
            const float PR = ${f4(DIE_SIZE * PIP_R)};
            const float DEPTH = 0.12;                       // recess depth, in pip radii (~0.25 mm)
            vec3 n = normalize(vPN);
            vec3 d = (vPL - vPC) / PR;
            vec3 I = normalize(vPL - vPCam);
            float cv = max(-dot(I, n), 0.1);
            vec3 It = I - n * dot(I, n);
            vec3 q = d + It * min(DEPTH / cv, 0.3);        // where the view ray meets the paint floor
            float rq = length(q);
            float aw = max(fwidth(rq), 0.015);
            float wall = smoothstep(1.0 - aw, 1.0 + aw, rq);
            vec3 upT = vPUp - n * dot(vPUp, n);
            float facing = dot(-q / max(rq, 1e-3), upT / max(length(upT), 1e-3));
            float wallLit = (length(upT) > 0.1 ? 0.5 + 0.5 * facing : 0.6);
            vec3 wallCol = vec3(0.30, 0.045, 0.045) * (0.35 + 0.9 * wallLit);
            float ao = 1.0 - 0.34 * smoothstep(0.7, 1.0, length(d)) * (0.35 + 0.65 * cv);
            diffuseColor.rgb = mix(diffuseColor.rgb * ao, wallCol, wall);
            totalEmissiveRadiance *= mix(ao, 0.05, wall);
          }`);
      };
      this.pipMat.customProgramCacheKey = () => 'dice-pip-recess-v1';
    }
    const shSq = shadowTexture(true), shRound = shadowTexture(false), caustic = causticTexture();
    this.dice = [0, 1].map(() => {
      const root = new THREE.Group();
      const body = new THREE.Mesh(this.bodyGeo, this.bodyMat);
      body.castShadow = true; body.receiveShadow = false;
      const pips = new THREE.Mesh(capGeo, this.pipMat);
      pips.castShadow = false;
      const visual = new THREE.Group(); visual.add(body, pips);
      root.add(visual);
      const shadow = new THREE.Mesh(new THREE.PlaneGeometry(DIE_SIZE * 1.75, DIE_SIZE * 1.75), new THREE.MeshBasicMaterial({ map: shSq, transparent: true, depthWrite: false, opacity: 1, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }));
      shadow.rotation.order = 'YXZ'; shadow.rotation.x = -Math.PI / 2; shadow.renderOrder = 2;
      const blur = new THREE.Mesh(new THREE.PlaneGeometry(DIE_SIZE * 2.4, DIE_SIZE * 2.4), new THREE.MeshBasicMaterial({ map: shRound, transparent: true, depthWrite: false, opacity: 0, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }));
      blur.rotation.x = -Math.PI / 2; blur.renderOrder = 2;
      // light focused through the die: a small red patch inside its own shadow (alpha-blended, not additive)
      const halo = new THREE.Mesh(new THREE.PlaneGeometry(DIE_SIZE * 0.62, DIE_SIZE * 0.62), new THREE.MeshBasicMaterial({ map: caustic, transparent: true, depthWrite: false, opacity: 0, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }));
      halo.rotation.order = 'YXZ'; halo.rotation.x = -Math.PI / 2; halo.renderOrder = 3;
      this.group.add(root, shadow, blur, halo);
      return { root, visual, body, pips, shadow, blur, halo, correction: new THREE.Quaternion() };
    });
    this.anim = null;
    this.values = [4, 2];
    this.placeResting(4, 2, [[0.15, 4.7, 0.3], [-0.2, 4.95, -0.5]]);
  }

  makeMaterials() {
    this.bodyMat?.dispose?.();
    const env = this.scene.environment || null;
    // the surface layer: almost no diffuse (acetate is clear), a sharp clearcoat over a glossy base;
    // the colour comes from the traced volume below
    const m = new THREE.MeshPhysicalMaterial({
      color: 0x050001, roughness: 0.08, metalness: 0,
      clearcoat: 1, clearcoatRoughness: 0.05, specularIntensity: 0.8,
      emissive: new THREE.Color(0x000000), envMap: env, envMapIntensity: 1.0,
    });
    patchMaterial(m, this.fadeU, { ao: 0.5, key: 'body', box: 1 });
    const base = m.onBeforeCompile;
    m.onBeforeCompile = (sh, r) => {
      base(sh, r);
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vDieLocal;\nvarying vec3 vDieN;\nvarying vec3 vDieCam;\nvarying vec3 vDieUp;')
        .replace('#include <project_vertex>', `#include <project_vertex>
          vDieLocal = position; vDieN = normal;
          vDieCam = (inverse(modelMatrix) * vec4(cameraPosition, 1.0)).xyz;
          vDieUp = normalize(transpose(mat3(modelMatrix)) * vec3(0.0, 1.0, 0.0));`);
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vDieLocal;\nvarying vec3 vDieN;\nvarying vec3 vDieCam;\nvarying vec3 vDieUp;\n' + VOLUME_GLSL)
        // widen the clearcoat lobe where the normal changes fast (the 1 mm bevel): no stair-stepped streaks
        .replace('#include <lights_physical_fragment>', `#include <lights_physical_fragment>
          {
            vec3 dN = fwidth(normalize(vDieN));
            float bevelAA = clamp(length(dN) * 1.6, 0.0, 0.2);
            material.clearcoatRoughness = max(material.clearcoatRoughness, bevelAA);
            material.roughness = max(material.roughness, bevelAA);
          }`)
        .replace('outgoingLight += 1.000 * dieSoftbox(', `outgoingLight += dieVolume(vDieLocal, normalize(vDieN), vDieCam, normalize(vDieUp));
        { // the micro bevel: every edge catches a thin neutral line from the room and the overhead lights,
          // brightest where the bevel turns up toward the canopy; it moves as the die turns
          vec3 an = abs(normalize(vDieN));
          float bev = smoothstep(0.015, 0.1, 1.0 - max(an.x, max(an.y, an.z)));
          vec3 upV = normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz);
          outgoingLight += vec3(0.36) * bev * (0.2 + 0.8 * pow(max(dot(normalize(normal), upV), 0.0), 1.5));
        }
        outgoingLight += 1.000 * dieSoftbox(`);
    };
    m.customProgramCacheKey = () => 'dice-acetate-v6';
    this.bodyMat = m;
    if (this.dice) for (const d of this.dice) d.body.material = this.bodyMat;
  }
  /** Kept for API compatibility: the acetate shader is the same on every quality tier. */
  setTransmission() { }

  /** Rotation that maps the face showing `value` to the local face that ends up pointing up. */
  static correctionFor(value, upAxisIndex) {
    const from = new THREE.Vector3(...VALUE_AXIS[value]);
    const to = new THREE.Vector3(...FACE_AXES[upAxisIndex]);
    return new THREE.Quaternion().setFromUnitVectors(from, to);
  }

  /** Value currently facing up on die i, read from its world orientation (debug / verification). */
  readValue(i) {
    const d = this.dice[i];
    d.visual.getWorldQuaternion(_w);
    let best = -2, val = 0;
    for (const [v, ax] of Object.entries(VALUE_AXIS)) {
      const y = _v.set(...ax).applyQuaternion(_w).y;
      if (y > best) { best = y; val = Number(v); }
    }
    return val;
  }
  /** Tilt of die i's top face away from world up, in degrees (verification). */
  tiltDeg(i) {
    const d = this.dice[i];
    d.visual.getWorldQuaternion(_w);
    let best = -2;
    for (const ax of Object.values(VALUE_AXIS)) best = Math.max(best, _v.set(...ax).applyQuaternion(_w).y);
    return Math.acos(Math.min(1, best)) * 180 / Math.PI;
  }

  /** Instantly place dice resting with the given values. poses: [[x, z, yaw], [x, z, yaw]] */
  placeResting(v1, v2, poses) {
    this.anim = null; this.fadeU.value = 1;
    this.values = [v1, v2];
    [v1, v2].forEach((v, i) => {
      const d = this.dice[i];
      const [x, z, yaw] = poses[i];
      d.root.position.set(x, DIE_SIZE / 2, z);
      d.root.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
      d.correction.setFromUnitVectors(new THREE.Vector3(...VALUE_AXIS[v]), new THREE.Vector3(0, 1, 0));
      d.visual.quaternion.copy(d.correction);
    });
    this._updateShadows();
  }

  get center() { return _v.copy(this.dice[0].root.position).add(this.dice[1].root.position).multiplyScalar(0.5).clone(); }
  get isRolling() { return !!this.anim; }

  /**
   * Play a recorded throw so it lands on values [v1,v2].
   * opts: { speed, onImpact(impact), onSettle(), pickup: seconds for the stick/pickup hand-off }
   * Pickup: the dice fade out where they rest (the stick gathers them), fade back in resting on the felt
   * at the shooter's rail spot, and are lifted from there into the release — never materialised in mid-air.
   */
  playThrow(sim, values, { speed = 1, onImpact, onSettle, pickup = 0.35 } = {}) {
    this.values = values.slice();
    this.dice.forEach((d, i) => d.correction.copy(DiceSet.correctionFor(values[i], sim.up[i])));
    const startPose = this.dice.map((d) => ({ p: d.root.position.clone(), q: d.root.quaternion.clone(), vq: d.visual.quaternion.clone() }));
    this.anim = { sim, t: -pickup, pickup, speed, onImpact, onSettle, nextImpact: 0, startPose };
    if (pickup <= 0) this.fadeU.value = 1;
  }

  /** Freeze the dice at time t of a throw (for ?shot=roll / settle). Negative t = inside the pickup. */
  freezeAt(sim, values, t, { pickup = 0.38 } = {}) {
    this.dice.forEach((d, i) => d.correction.copy(DiceSet.correctionFor(values[i], sim.up[i])));
    if (t < 0) {
      const startPose = this.dice.map((d) => ({ p: d.root.position.clone(), q: d.root.quaternion.clone(), vq: d.visual.quaternion.clone() }));
      this.anim = null;
      this._pickupPose({ sim, pickup, startPose }, t);
      this._updateShadows();
      return;
    }
    this.anim = null; this.fadeU.value = 1;
    this._pose(sim, t);
    this._updateShadows();
  }
  /** No-op (the motion trail was removed); kept so older callers keep working. */
  clearTrail() { }

  _sample(sim, t, i) {
    const f = Math.max(0, Math.min(sim.frames.length - 1.0001, t * sim.fps));
    const i0 = Math.floor(f), a = f - i0;
    const A = sim.frames[i0], B = sim.frames[Math.min(i0 + 1, sim.frames.length - 1)];
    const p = new THREE.Vector3(A.p[i * 3], A.p[i * 3 + 1], A.p[i * 3 + 2]).lerp(new THREE.Vector3(B.p[i * 3], B.p[i * 3 + 1], B.p[i * 3 + 2]), a);
    _q.set(A.q[i * 4], A.q[i * 4 + 1], A.q[i * 4 + 2], A.q[i * 4 + 3]);
    _q2.set(B.q[i * 4], B.q[i * 4 + 1], B.q[i * 4 + 2], B.q[i * 4 + 3]);
    return { p, q: _q.clone().slerp(_q2, a) };
  }
  _pose(sim, t) {
    for (let i = 0; i < 2; i++) {
      const { p, q } = this._sample(sim, t, i);
      const d = this.dice[i];
      d.root.position.copy(p);
      d.root.quaternion.copy(q);
      d.visual.quaternion.copy(d.correction);
    }
  }
  /** Shooter's rest spot: on the felt against the near rail at the throwing end, the two dice side by side. */
  _railSpot(sim, i) {
    const F = sim.frames[0];
    const zMax = FELT.hd - 0.15 - HALF - 0.04;
    return new THREE.Vector3(F.p[0] - 0.05 + i * 0.36, HALF, zMax - 0.02 - i * 0.04);
  }
  /**
   * t in [-pickup, 0): 0-30% fade out where the dice rest; 30-55% fade in resting at the shooter's rail
   * spot; 55-100% the shooter's hand lifts them from the rail into the release pose of the throw.
   */
  _pickupPose(a, t) {
    const k = THREE.MathUtils.clamp(1 + t / a.pickup, 0, 1);
    if (k < 0.3) {
      this.dice.forEach((d, i) => { const sp = a.startPose[i]; d.root.position.copy(sp.p); d.root.quaternion.copy(sp.q); d.visual.quaternion.copy(sp.vq); });
      const e = 1 - k / 0.3; this.fadeU.value = e * e;
      return;
    }
    const F = a.sim.frames[0];
    this.dice.forEach((d, i) => {
      const sp = a.startPose[i], rest = this._railSpot(a.sim, i);
      const Qa = sp.q.clone().multiply(sp.vq);                                  // resting orientation (old roll)
      const Qb = new THREE.Quaternion(F.q[i * 4], F.q[i * 4 + 1], F.q[i * 4 + 2], F.q[i * 4 + 3]).multiply(d.correction);
      const rel = new THREE.Vector3(F.p[i * 3], F.p[i * 3 + 1], F.p[i * 3 + 2]);
      let e = 0;
      if (k >= 0.55) { const u = (k - 0.55) / 0.45; e = u * u * (3 - 2 * u); }
      const pos = rest.clone().lerp(rel, e);
      pos.y += Math.sin(e * Math.PI) * 0.35;                                    // the hand's scoop
      const Q = Qa.clone().slerp(Qb, e);
      d.root.position.copy(pos);
      d.root.quaternion.copy(Q).multiply(d.correction.clone().invert());
      d.visual.quaternion.copy(d.correction);
    });
    const e = Math.min(1, (k - 0.3) / 0.2); this.fadeU.value = Math.min(1, e * (2 - e));
  }

  /** Jump an in-flight throw to its end (fast mode). */
  finishNow() {
    if (!this.anim) return;
    const a = this.anim; this.anim = null; this.fadeU.value = 1;
    this._pose(a.sim, a.sim.duration);
    this._updateShadows();
    a.onSettle?.();
  }

  _updateShadows() {
    const fade = this.fadeU.value;
    for (const d of this.dice) {
      const pos = d.root.position;
      d.visual.getWorldQuaternion(_w);
      let up = 0, yawAxis = null, bestH = 2;
      for (const ax of AXES) {
        const w = _v.copy(ax).applyQuaternion(_w);
        if (Math.abs(w.y) > up) up = Math.abs(w.y);
        if (Math.abs(w.y) < bestH) { bestH = Math.abs(w.y); yawAxis = { x: w.x, z: w.z }; }
      }
      let ext = 0; for (let k = 0; k < 6; k += 2) ext += Math.abs(_v.copy(AXES[k]).applyQuaternion(_w).y);
      const halfY = HALF * ext;
      const gap = Math.max(0, pos.y - halfY);
      const flat = THREE.MathUtils.clamp((up - 0.9) / 0.1, 0, 1) * Math.exp(-gap * 14);
      const yaw = yawAxis ? Math.atan2(yawAxis.x, yawAxis.z) : 0;
      d.shadow.position.set(pos.x + 0.004, 0.004, pos.z - 0.003);
      d.shadow.rotation.y = yaw;
      d.shadow.material.opacity = flat * fade;
      d.blur.position.set(pos.x + gap * 0.06, 0.0035, pos.z - gap * 0.03);
      const s = 1 + gap * 0.9; d.blur.scale.set(s, s, s);
      d.blur.material.opacity = Math.max(flat * 0.3, (1 - flat) * 0.85 / (1 + gap * 2.2)) * fade;
      // focused red caustic thrown on the cloth on the side away from the overhead key, tight to the die
      // and only while it rests on (or skims) the felt
      const away = _v.set(pos.x - KEY_XZ[0], 0, pos.z - KEY_XZ[1]); const L = away.length() || 1; away.multiplyScalar(1 / L);
      d.halo.position.set(pos.x + away.x * DIE_SIZE * 0.42, 0.0045, pos.z + away.z * DIE_SIZE * 0.42);
      d.halo.rotation.y = yaw;
      d.halo.material.opacity = 0.5 * flat * flat * fade; // resting / skimming only: gone while airborne
    }
  }

  update(dt) {
    const a = this.anim;
    if (a) {
      a.t += dt * a.speed;
      if (a.t < 0) { this._pickupPose(a, a.t); }
      else {
        this.fadeU.value = 1;
        const t = Math.min(a.t, a.sim.duration);
        this._pose(a.sim, t);
        const imps = a.sim.impacts;
        while (a.nextImpact < imps.length && imps[a.nextImpact].t <= a.t) { a.onImpact?.(imps[a.nextImpact]); a.nextImpact++; }
        if (a.t >= a.sim.duration) { this.anim = null; a.onSettle?.(); }
      }
      this._updateShadows();
    }
  }
}
