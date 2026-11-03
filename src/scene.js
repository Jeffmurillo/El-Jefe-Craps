// scene.js — renderer, lighting, environment, casino room backdrop, post-processing.
// Cinematic look: warm projected canopy light pool on the felt, soft PCF shadows, a custom
// HDR casino environment for reflections, a blurred casino-floor panorama with parallax bokeh,
// bloom, and a display-space grade (vignette, warm split-tone, subtle CA, film grain).
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

export const QUALITY = {
  low: { pixelRatio: 1, shadow: 1024, bloom: false, msaa: 0, transmission: false, bokeh: 40, grain: false, ca: false },
  medium: { pixelRatio: 1.25, shadow: 4096, bloom: true, msaa: 4, transmission: false, bokeh: 90, grain: true, ca: true },
  high: { pixelRatio: 2, shadow: 4096, bloom: true, msaa: 4, transmission: true, bokeh: 140, grain: true, ca: true },
  // software rasteriser (SwiftShader / llvmpipe) or headless ?shot capture: cheap but still graded
  soft: { pixelRatio: 1, shadow: 4096, bloom: true, msaa: 2, transmission: false, bokeh: 40, grain: false, ca: false },
  // phones / tablets (Adreno, Mali, Apple GPUs): sharp enough at ~2.6x DPR, one 2K key shadow, light post
  mobile: { pixelRatio: 1.6, shadow: 2048, bloom: true, msaa: 4, transmission: false, bokeh: 60, grain: false, ca: false, staticFill: true },
  // live play on a software rasteriser (browser GPU acceleration off): the bare minimum that stays interactive
  cpu: { pixelRatio: 0.75, shadow: 1024, bloom: false, msaa: 0, transmission: false, bokeh: 0, grain: false, ca: false, staticFill: true },
};

// review override: ?bloom=strength,radius,threshold
const BLOOM = (() => {
  const v = new URLSearchParams(location.search).get('bloom')?.split(',').map(Number);
  return v?.length === 3 ? { strength: v[0], radius: v[1], threshold: v[2] } : { strength: 0.6, radius: 0.5, threshold: 1.8 };
})();
export const TONE_MAPS = { aces: THREE.ACESFilmicToneMapping, agx: THREE.AgXToneMapping, neutral: THREE.NeutralToneMapping };

/** True when WebGL is running on a CPU rasteriser (SwiftShader, llvmpipe, WARP...). */
export function isSoftwareRenderer(gl) {
  try {
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const s = String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
    return /swiftshader|llvmpipe|softpipe|software|basic render|warp/i.test(s);
  } catch { return false; }
}

// ---------------------------------------------------------------- utils
function rng(seed) { let s = seed >>> 0 || 1; return () => { s = (s * 16807) % 2147483647; return s / 2147483647; }; }
const pick = (r, arr) => arr[Math.floor(r() * arr.length)];

// ---------------------------------------------------------------- grade (display space)
const GradeShader = {
  uniforms: {
    tDiffuse: { value: null }, uTime: { value: 0 }, uRes: { value: new THREE.Vector2(1600, 900) },
    uVignette: { value: 0.7 }, uGrain: { value: 0.018 }, uCA: { value: 0.0008 },
  },
  // compile-time feature flags: the cheap path (software renderers) skips the extra taps entirely
  defines: { USE_CA: 0, USE_GRAIN: 0 },
  vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse; uniform float uTime; uniform vec2 uRes;
    uniform float uVignette; uniform float uGrain; uniform float uCA;
    varying vec2 vUv;
    float hash(vec2 p){ p = fract(p * vec2(443.897, 441.423)); p += dot(p, p.yx + 19.19); return fract((p.x + p.y) * p.x); }
    void main(){
      vec2 d = vUv - 0.5;
      vec3 c;
      #if USE_CA == 1
        // subtle lateral chromatic aberration toward the frame edges only
        float r2 = dot(d * vec2(uRes.x / uRes.y, 1.0), d * vec2(uRes.x / uRes.y, 1.0));
        vec2 off = d * uCA * r2 * 2.4;
        c.r = texture2D(tDiffuse, vUv + off).r;
        c.g = texture2D(tDiffuse, vUv).g;
        c.b = texture2D(tDiffuse, vUv - off).b;
      #else
        c = texture2D(tDiffuse, vUv).rgb;
      #endif
      // warm split-tone: amber highlights, deep warm-brown shadows
      float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
      // cool teal in the deep shadows (separates the lacquered wood and the dark room), warm amber highlights
      vec3 sh = vec3(0.9, 1.0, 1.07), hi = vec3(1.04, 1.0, 0.93);
      c *= mix(sh, hi, smoothstep(0.03, 0.42, l));
      // a little local contrast: lift the mids out of the orange-brown mush
      c = mix(vec3(l), c, 1.06);
      // gentle S-curve for punch (deepens the shadows the pendant pool falls into)
      c = clamp(c, 0.0, 1.0);
      c = mix(c, c * c * (3.0 - 2.0 * c), 0.3);
      // elliptical cinematic vignette
      vec2 v = d * vec2(1.0, 1.15);
      float vig = smoothstep(0.8, 0.2, length(v));
      c *= mix(1.0 - uVignette, 1.0, vig);
      #if USE_GRAIN == 1
        float g = hash(vUv * uRes + fract(uTime) * 917.0) - 0.5;
        c += g * uGrain * (0.35 + 0.65 * (1.0 - l));
      #endif
      gl_FragColor = vec4(max(c, 0.0), 1.0);
    }`,
};

// ---------------------------------------------------------------- HDR environment (reflections only)
function buildEnvScene() {
  const env = new THREE.Scene();
  const hdr = (hex, k) => new THREE.MeshBasicMaterial({ color: new THREE.Color(hex).multiplyScalar(k), side: THREE.DoubleSide });
  const room = new THREE.Mesh(new THREE.BoxGeometry(80, 34, 80), new THREE.MeshBasicMaterial({ color: new THREE.Color(0x140c09), side: THREE.BackSide }));
  room.position.y = 10; env.add(room);
  // the long canopy light right above the table (the dominant reflection on dice, chips, wood)
  // segmented diffuser (five lamp panels with dark mullions): on the lacquered rails this reads as a
  // row of discrete fixture reflections instead of one long smeared streak
  for (let i = 0; i < 5; i++) {
    const w = 4.6, x = (i - 2) * 5.3;
    const panel = new THREE.Mesh(new THREE.PlaneGeometry(w, 5.6), hdr(i % 2 ? 0xffd2a0 : 0xffdcb4, i === 2 ? 11 : 8.5));
    panel.rotation.x = Math.PI / 2; panel.position.set(x, 16, 0); env.add(panel);
  }
  // small hot spot lamps beside the canopy: sharp little glints on dice and chip edges
  for (const [x, z] of [[-9, 5.5], [9, 5.5], [0, -5.5], [-15, -4], [15, -4]]) {
    const s = new THREE.Mesh(new THREE.CircleGeometry(0.55, 16), hdr(0xfff0d8, 22));
    s.rotation.x = Math.PI / 2; s.position.set(x, 15.5, z); env.add(s);
  }
  const canopyRim = new THREE.Mesh(new THREE.PlaneGeometry(30, 0.6), hdr(0xffb870, 4));
  canopyRim.rotation.x = Math.PI / 2; canopyRim.position.set(0, 15.9, 3.4); env.add(canopyRim.clone());
  canopyRim.position.z = -3.4; env.add(canopyRim);
  // long warm cove strips running parallel to the table at ~50 deg elevation fore and aft: a player's eye
  // (40-55 deg down onto the rails) mirrors off the lacquered rail tops straight into them, which lays a
  // long travelling specular streak along each rail, broken by mullions so it reads as fixtures
  for (const zs of [-1, 1]) {
    for (let i = 0; i < 4; i++) {
      const strip = new THREE.Mesh(new THREE.PlaneGeometry(11.5, 1.1), hdr(0xffc890, zs < 0 ? 4.2 : 2.6));
      strip.position.set((i - 1.5) * 12.4, 19.5, zs * 16.5); strip.lookAt(0, 0, 0); env.add(strip);
    }
  }
  // a dimmer ring of ceiling coves at ~30 deg elevation all the way round: low 3/4 cameras catch these
  // as soft highlights on the rail curves, chip edges and dice faces from any bearing
  for (let i = 0; i < 18; i++) {
    const a = (i / 18) * Math.PI * 2;
    const p = new THREE.Mesh(new THREE.PlaneGeometry(5.2, 1.4), hdr(i % 3 ? 0xffb878 : 0xffd6a8, 1.8));
    p.position.set(Math.cos(a) * 24, 13.5, Math.sin(a) * 24); p.lookAt(0, 0, 0); env.add(p);
  }
  // green bounce from the felt
  const felt = new THREE.Mesh(new THREE.PlaneGeometry(10, 4), hdr(0x0f5a2a, 0.12));
  felt.rotation.x = -Math.PI / 2; felt.position.y = -1.2; env.add(felt);
  // distant casino glow: warm wall washes and coloured slot-machine lights around the horizon
  const r = rng(91);
  for (let i = 0; i < 46; i++) {
    const a = r() * Math.PI * 2, rad = 32 + r() * 6;
    const col = pick(r, [0xffb040, 0xff8a2a, 0xffd27a, 0xff3050, 0x6a4dff, 0x30a0ff, 0xff40c0]);
    const m = new THREE.Mesh(new THREE.PlaneGeometry(1.2 + r() * 2.5, 1 + r() * 3), hdr(col, 1.5 + r() * 3.5));
    m.position.set(Math.cos(a) * rad, 1 + r() * 6, Math.sin(a) * rad); m.lookAt(0, 3, 0); env.add(m);
  }
  for (const s of [-1, 1]) {
    const wash = new THREE.Mesh(new THREE.PlaneGeometry(40, 8), hdr(0xff9a50, 0.6));
    wash.position.set(s * 38, 9, 0); wash.rotation.y = -s * Math.PI / 2; env.add(wash);
  }
  // a crisp, bright fixture line behind the far rail at ~22 deg elevation: the gameplay eye mirrors off the far
  // rail's lacquered cap straight into it, so the far rail gets its own specular kick (not only the near rail)
  for (let i = 0; i < 3; i++) {
    const k = new THREE.Mesh(new THREE.PlaneGeometry(13, 0.7), hdr(0xffe0b8, 7.5));
    k.position.set((i - 1) * 14.5, 11, -34); k.lookAt(0, 0, 0); env.add(k);
  }
  // cool fill from the casino floor: teal-ish sky reflection in the wood's grazing angles
  const cool = new THREE.Mesh(new THREE.PlaneGeometry(70, 10), hdr(0x6a8cb0, 0.35));
  cool.position.set(0, 4, -39); env.add(cool);
  const back = new THREE.Mesh(new THREE.PlaneGeometry(50, 6), hdr(0xffa860, 0.5));
  back.position.set(0, 12, -38); env.add(back);
  return env;
}

// ---------------------------------------------------------------- casino panorama (pre-blurred)
function casinoPanorama(seed = 7) {
  const W = 4096, H = 1024; // tile spans half the cylinder (repeat 2)
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H; const ctx = cv.getContext('2d');
  const r = rng(seed);
  // vertical layout (v measured from top): ceiling 0..0.52, horizon ~0.62, floor below 0.80
  const yCeil = H * 0.5, yTop = H * 0.56, yFloor = H * 0.82;
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, '#030202'); g.addColorStop(0.35, '#0a0605'); g.addColorStop(0.52, '#1a0f0a');
  g.addColorStop(0.66, '#2a160d'); g.addColorStop(0.8, '#160b07'); g.addColorStop(1, '#070404');
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  const wrap = (fn) => { fn(0); fn(-W); fn(W); }; // seamless horizontal tiling

  // ---- layer 1: sharp scene, later blurred ----
  const L = document.createElement('canvas'); L.width = W; L.height = H; const c = L.getContext('2d');
  // ceiling: coffers with warm cove light
  c.globalCompositeOperation = 'lighter';
  for (let i = 0; i < 3; i++) {
    const y = yCeil - 40 - i * 70;
    const cg = c.createLinearGradient(0, y - 14, 0, y + 14);
    cg.addColorStop(0, 'rgba(255,150,60,0)'); cg.addColorStop(0.5, `rgba(255,170,80,${0.32 - i * 0.08})`); cg.addColorStop(1, 'rgba(255,150,60,0)');
    c.fillStyle = cg; c.fillRect(0, y - 14, W, 28);
  }
  // pendant lamp pools over distant gaming tables
  for (let i = 0; i < 12; i++) {
    const x = (i + r() * 0.6) * (W / 12), w = 140 + r() * 120, y0 = yCeil - 30 - r() * 40, y1 = yFloor - 30 - r() * 30;
    wrap((o) => {
      const cone = c.createLinearGradient(0, y0, 0, y1);
      cone.addColorStop(0, 'rgba(255,214,150,0.55)'); cone.addColorStop(0.15, 'rgba(255,190,120,0.12)'); cone.addColorStop(1, 'rgba(255,170,90,0.05)');
      c.fillStyle = cone; c.beginPath(); c.moveTo(o + x - w * 0.18, y0); c.lineTo(o + x + w * 0.18, y0); c.lineTo(o + x + w * 0.6, y1); c.lineTo(o + x - w * 0.6, y1); c.closePath(); c.fill();
      // lamp housing glow
      c.fillStyle = 'rgba(255,220,170,0.9)'; c.fillRect(o + x - w * 0.2, y0 - 4, w * 0.4, 6);
      // felt glow (green or burgundy tables)
      const felt = r() < 0.75 ? '30,140,70' : '150,30,40';
      const fg = c.createRadialGradient(o + x, y1, 4, o + x, y1, w * 0.7);
      fg.addColorStop(0, `rgba(${felt},0.55)`); fg.addColorStop(1, `rgba(${felt},0)`);
      c.fillStyle = fg; c.save(); c.translate(o + x, y1); c.scale(1, 0.22); c.translate(-(o + x), -y1); c.beginPath(); c.arc(o + x, y1, w * 0.7, 0, 6.283); c.fill(); c.restore();
    });
  }
  c.globalCompositeOperation = 'source-over';
  // slot machine banks: dark cabinets, bright screens, glowing toppers
  const screenCols = [['#3a5bff', '#9a6bff'], ['#ff9a2a', '#ffd76a'], ['#ff2a5a', '#ff8a3a'], ['#1ad0ff', '#2a6aff'], ['#c040ff', '#ff5ad0'], ['#ffd040', '#ff7a1a']];
  for (let b = 0; b < 9; b++) {
    const bx = (b + 0.15 + r() * 0.3) * (W / 9), n = 5 + Math.floor(r() * 5), cw = 26 + r() * 10, ch = 120 + r() * 40;
    const by = yFloor - 8 - r() * 26, scale = 0.75 + r() * 0.5;
    for (let k = 0; k < n; k++) {
      const x = bx + k * cw * scale * 1.06, w = cw * scale, h = ch * scale;
      wrap((o) => {
        c.fillStyle = '#0b0706'; c.fillRect(o + x, by - h, w, h);
        const [s1, s2] = pick(r, screenCols);
        const sg = c.createLinearGradient(0, by - h * 0.78, 0, by - h * 0.42);
        sg.addColorStop(0, s1); sg.addColorStop(1, s2);
        c.fillStyle = sg; c.fillRect(o + x + w * 0.12, by - h * 0.8, w * 0.76, h * 0.36);
        c.fillStyle = pick(r, ['#ffcf5a', '#ff4a3a', '#ff9a30', '#ffe7a0']);
        c.fillRect(o + x + w * 0.05, by - h * 1.0, w * 0.9, h * 0.1);
        c.fillStyle = 'rgba(255,200,120,0.5)'; c.fillRect(o + x + w * 0.2, by - h * 0.32, w * 0.6, h * 0.04);
      });
    }
  }
  // columns with gold sconces
  for (let i = 0; i < 6; i++) {
    const x = (i + 0.5) * (W / 6) + (r() - 0.5) * 80;
    wrap((o) => {
      c.fillStyle = '#080504'; c.fillRect(o + x - 28, yCeil - 60, 56, yFloor - yCeil + 70);
      c.fillStyle = 'rgba(255,190,110,0.9)'; c.fillRect(o + x - 34, yCeil + 70, 10, 18); c.fillRect(o + x + 24, yCeil + 70, 10, 18);
    });
  }
  // blur the sharp layer into an out-of-focus background
  ctx.save(); ctx.filter = 'blur(9px)'; ctx.globalCompositeOperation = 'lighter'; ctx.drawImage(L, 0, 0); ctx.restore();
  ctx.save(); ctx.filter = 'blur(3px)'; ctx.globalAlpha = 0.35; ctx.globalCompositeOperation = 'lighter'; ctx.drawImage(L, 0, 0); ctx.restore();
  // dark silhouettes in front (blurred) so the glow is occluded naturally
  ctx.save(); ctx.filter = 'blur(6px)';
  ctx.fillStyle = 'rgba(4,2,2,0.85)';
  for (let i = 0; i < 26; i++) { // patrons / chairs / foreground furniture
    const x = r() * W, w = 30 + r() * 70, h = 40 + r() * 90;
    wrap((o) => { ctx.beginPath(); ctx.ellipse(o + x, yFloor + 10, w, h, 0, Math.PI, 0); ctx.fill(); });
  }
  ctx.restore();

  // ---- layer 2: bokeh discs with bright rims ----
  ctx.globalCompositeOperation = 'lighter';
  const hues = [38, 34, 44, 28, 20, 40, 32, 0, 345, 260, 50];
  for (let i = 0; i < 340; i++) {
    const x = r() * W, y = yCeil - 120 + r() * (yFloor - yCeil + 120), rad = 6 + Math.pow(r(), 2.2) * 46;
    const hue = pick(r, hues), sat = hue > 60 && hue < 340 ? 70 : 90, a = 0.03 + r() * 0.12;
    wrap((o) => {
      const gr = ctx.createRadialGradient(o + x, y, 0, o + x, y, rad);
      gr.addColorStop(0, `hsla(${hue},${sat}%,62%,${a * 0.7})`);
      gr.addColorStop(0.78, `hsla(${hue},${sat}%,64%,${a})`);
      gr.addColorStop(0.92, `hsla(${hue},${sat}%,72%,${a * 1.25})`);
      gr.addColorStop(1, `hsla(${hue},${sat}%,60%,0)`);
      ctx.fillStyle = gr; ctx.beginPath(); ctx.arc(o + x, y, rad, 0, 6.283); ctx.fill();
    });
  }
  // tiny chandelier glints in the ceiling
  for (let i = 0; i < 160; i++) {
    const x = r() * W, y = H * 0.12 + r() * (yCeil - H * 0.12), rad = 1 + r() * 2.5;
    ctx.fillStyle = `rgba(255,${200 + r() * 40},${140 + r() * 60},${0.15 + r() * 0.45})`;
    ctx.beginPath(); ctx.arc(x, y, rad, 0, 6.283); ctx.fill();
  }
  ctx.globalCompositeOperation = 'source-over';
  // floor haze fade into black so the carpet plane merges seamlessly
  const fg = ctx.createLinearGradient(0, yFloor - 10, 0, H);
  fg.addColorStop(0, 'rgba(8,4,3,0)'); fg.addColorStop(0.35, 'rgba(8,4,3,0.85)'); fg.addColorStop(1, 'rgba(6,3,2,1)');
  ctx.fillStyle = fg; ctx.fillRect(0, yFloor - 10, W, H - yFloor + 10);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace; t.wrapS = THREE.RepeatWrapping; t.repeat.set(2, 1);
  t.anisotropy = 4; t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter;
  return t;
}

/** A row of slot machines rendered sharp, then blurred like a shallow depth-of-field background. */
function slotBankTexture(seed) {
  const W = 1024, H = 368, r = rng(seed);
  const S = document.createElement('canvas'); S.width = W; S.height = H; const c = S.getContext('2d');
  const n = 8, cw = W / n, floorY = H - 26;
  const screens = [['#2a46ff', '#8a5bff'], ['#ff8a1a', '#ffd25a'], ['#ff1f4a', '#ff8a3a'], ['#18c8ff', '#2050ff'], ['#b030ff', '#ff4ac8'], ['#ffc030', '#ff6010'], ['#20e090', '#1a70ff']];
  for (let k = 0; k < n; k++) {
    const x = k * cw + cw * 0.06, w = cw * 0.88, h = H * (0.78 + r() * 0.1), top = floorY - h;
    // cabinet with chrome edge
    const cg = c.createLinearGradient(x, 0, x + w, 0);
    cg.addColorStop(0, '#2a2220'); cg.addColorStop(0.08, '#120c0b'); cg.addColorStop(0.92, '#120c0b'); cg.addColorStop(1, '#2a2220');
    c.fillStyle = cg; c.fillRect(x, top, w, h);
    // topper sign
    const [t1, t2] = pick(r, screens);
    const tg = c.createLinearGradient(0, top, 0, top + h * 0.16);
    tg.addColorStop(0, t2); tg.addColorStop(1, t1);
    c.fillStyle = tg; c.beginPath(); c.roundRect(x + w * 0.04, top + h * 0.02, w * 0.92, h * 0.15, 10); c.fill();
    c.fillStyle = 'rgba(255,240,200,0.9)'; c.font = `bold ${Math.round(h * 0.08)}px Georgia, serif`; c.textAlign = 'center';
    c.fillText(pick(r, ['777', 'JACKPOT', 'WILD', 'BAR', '$$$', 'FORTUNE']), x + w / 2, top + h * 0.125);
    // main screen
    const [s1, s2] = pick(r, screens);
    const sg = c.createLinearGradient(0, top + h * 0.22, 0, top + h * 0.56);
    sg.addColorStop(0, s1); sg.addColorStop(1, s2);
    c.fillStyle = sg; c.fillRect(x + w * 0.1, top + h * 0.22, w * 0.8, h * 0.34);
    c.fillStyle = 'rgba(255,255,255,0.55)';
    for (let j = 0; j < 3; j++) c.fillRect(x + w * (0.16 + j * 0.24), top + h * 0.3, w * 0.18, h * 0.18);
    // button deck + lit coin tray
    c.fillStyle = '#3a2a1e'; c.fillRect(x + w * 0.06, top + h * 0.6, w * 0.88, h * 0.06);
    for (let j = 0; j < 5; j++) { c.fillStyle = pick(r, ['#ffd040', '#ff3030', '#30ff80', '#ffffff']); c.fillRect(x + w * (0.12 + j * 0.16), top + h * 0.615, w * 0.1, h * 0.025); }
    c.fillStyle = 'rgba(255,180,90,0.35)'; c.fillRect(x + w * 0.2, top + h * 0.8, w * 0.6, h * 0.05);
    // stool silhouette in front
    if (r() < 0.6) { c.fillStyle = '#060404'; c.beginPath(); c.ellipse(x + w / 2, floorY - h * 0.3, w * 0.3, h * 0.05, 0, 0, 6.283); c.fill(); c.fillRect(x + w / 2 - 4, floorY - h * 0.3, 8, h * 0.3); }
  }
  // floor glow under the bank
  const fg = c.createLinearGradient(0, floorY - 6, 0, H);
  fg.addColorStop(0, 'rgba(255,160,90,0.35)'); fg.addColorStop(1, 'rgba(255,160,90,0)');
  c.fillStyle = fg; c.fillRect(0, floorY - 6, W, H - floorY + 6);
  // blur into the final texture, with alpha feathered at the sides and bottom
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H; const ctx = cv.getContext('2d');
  ctx.filter = 'blur(16px)'; ctx.drawImage(S, 0, 0);
  ctx.filter = 'blur(7px)'; ctx.globalAlpha = 0.22; ctx.globalCompositeOperation = 'lighter'; ctx.drawImage(S, 0, 0);
  ctx.filter = 'none'; ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'destination-in';
  const m = ctx.createLinearGradient(0, 0, W, 0);
  m.addColorStop(0, 'rgba(0,0,0,0)'); m.addColorStop(0.06, 'rgba(0,0,0,1)'); m.addColorStop(0.94, 'rgba(0,0,0,1)'); m.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = m; ctx.fillRect(0, 0, W, H);
  ctx.globalCompositeOperation = 'source-over';
  const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
  return t;
}

/** One slot cabinet front (topper, reels, deck, belly glass), drawn sharp then softened a touch. */
function slotCabinetTexture(seed) {
  const W = 256, H = 994, r = rng(seed);
  const S = document.createElement('canvas'); S.width = W; S.height = H; const c = S.getContext('2d');
  const cols = [['#2a46ff', '#8a5bff'], ['#ff8a1a', '#ffd25a'], ['#ff1f4a', '#ff8a3a'], ['#18c8ff', '#2050ff'], ['#b030ff', '#ff4ac8'], ['#ffc030', '#ff6010']];
  const body = c.createLinearGradient(0, 0, W, 0);
  body.addColorStop(0, '#3a302c'); body.addColorStop(0.06, '#100a09'); body.addColorStop(0.94, '#100a09'); body.addColorStop(1, '#3a302c');
  c.fillStyle = body; c.fillRect(0, 0, W, H);
  const [t1, t2] = pick(r, cols);
  const tg = c.createLinearGradient(0, 20, 0, 170); tg.addColorStop(0, t2); tg.addColorStop(1, t1);
  c.fillStyle = tg; c.beginPath(); c.roundRect(14, 18, W - 28, 150, 40); c.fill();
  c.strokeStyle = 'rgba(255,230,170,0.9)'; c.lineWidth = 5; c.stroke();
  c.fillStyle = '#fff4d0'; c.font = 'bold 46px Georgia, serif'; c.textAlign = 'center'; c.textBaseline = 'middle';
  c.fillText(pick(r, ['777', 'WILD', 'BAR', '$$$', 'LUCKY', 'GOLD']), W / 2, 96);
  const [s1, s2] = pick(r, cols);
  const sg = c.createLinearGradient(0, 210, 0, 520); sg.addColorStop(0, s1); sg.addColorStop(1, s2);
  c.fillStyle = sg; c.fillRect(22, 210, W - 44, 310);
  c.fillStyle = 'rgba(255,255,255,0.85)';
  for (let j = 0; j < 3; j++) c.fillRect(34 + j * 64, 290, 52, 150);
  c.fillStyle = pick(r, ['#d02020', '#2040d0', '#e0a000']); c.font = 'bold 40px Georgia, serif';
  for (let j = 0; j < 3; j++) c.fillText(pick(r, ['7', 'B', '$', '*']), 60 + j * 64, 366);
  c.fillStyle = '#2a1e16'; c.fillRect(14, 560, W - 28, 60);
  for (let j = 0; j < 5; j++) { c.fillStyle = pick(r, ['#ffd040', '#ff3030', '#30ff80', '#ffffff']); c.fillRect(26 + j * 44, 578, 32, 22); }
  const bg = c.createLinearGradient(0, 650, 0, 880); bg.addColorStop(0, t1); bg.addColorStop(1, '#120a08');
  c.fillStyle = bg; c.globalAlpha = 0.6; c.fillRect(26, 650, W - 52, 230); c.globalAlpha = 1;
  c.fillStyle = 'rgba(255,190,110,0.8)'; c.fillRect(50, 910, W - 100, 14);
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H; const ctx = cv.getContext('2d');
  ctx.filter = 'blur(6px)'; ctx.drawImage(S, 0, 0);
  const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
  return t;
}

/** Top-down card of a distant gaming table, drawn sharp then heavily blurred (shallow depth of field). */
function blurredTableCard(feltHex) {
  const W = 512, H = 256, S = document.createElement('canvas'); S.width = W; S.height = H; const c = S.getContext('2d');
  const r = rng(feltHex & 0xffff);
  const rr = (x, y, w, h, rad) => { c.beginPath(); c.roundRect(x, y, w, h, rad); c.fill(); };
  c.fillStyle = 'rgba(14,6,4,0.95)'; rr(40, 40, W - 80, H - 80, 60);            // rail
  c.fillStyle = 'rgba(70,32,16,0.9)'; rr(52, 52, W - 104, H - 104, 52);         // lacquer catching its lamp
  const fc = new THREE.Color(feltHex);
  const fg = c.createRadialGradient(W / 2, H / 2, 10, W / 2, H / 2, W * 0.42);
  fg.addColorStop(0, `rgb(${fc.r * 255 * 2.4 | 0},${fc.g * 255 * 2.4 | 0},${fc.b * 255 * 2.4 | 0})`);
  fg.addColorStop(1, `rgb(${fc.r * 255 * 0.9 | 0},${fc.g * 255 * 0.9 | 0},${fc.b * 255 * 0.9 | 0})`);
  c.fillStyle = fg; rr(66, 66, W - 132, H - 132, 40);
  c.fillStyle = 'rgba(230,200,140,0.35)'; for (let i = 0; i < 9; i++) c.fillRect(110 + i * 34, H / 2 - 30 + (i % 2) * 40, 18, 4); // print
  for (let i = 0; i < 14; i++) { // chips + patrons' shoulders around the rail
    const a = r() * Math.PI * 2, px = W / 2 + Math.cos(a) * (W / 2 - 34), py = H / 2 + Math.sin(a) * (H / 2 - 30);
    c.fillStyle = r() < 0.5 ? 'rgba(6,3,3,0.95)' : 'rgba(40,24,20,0.95)'; c.beginPath(); c.ellipse(px, py, 22, 16, a, 0, 6.283); c.fill();
  }
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H; const ctx = cv.getContext('2d');
  ctx.filter = 'blur(10px)'; ctx.drawImage(S, 0, 0);
  const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; return t;
}

function bokehSprite() {
  const N = 128; const cv = document.createElement('canvas'); cv.width = cv.height = N; const ctx = cv.getContext('2d');
  const g = ctx.createRadialGradient(N / 2, N / 2, 0, N / 2, N / 2, N / 2);
  g.addColorStop(0, 'rgba(255,255,255,0.55)'); g.addColorStop(0.72, 'rgba(255,255,255,0.7)');
  g.addColorStop(0.9, 'rgba(255,255,255,1)'); g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g; ctx.beginPath(); ctx.arc(N / 2, N / 2, N / 2, 0, 6.283); ctx.fill();
  const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; return t;
}

function carpetTexture() {
  const N = 512; const cv = document.createElement('canvas'); cv.width = cv.height = N; const ctx = cv.getContext('2d');
  ctx.fillStyle = '#1a0609'; ctx.fillRect(0, 0, N, N);
  const motif = (cx, cy, rr, col) => {
    ctx.strokeStyle = col; ctx.lineWidth = 6;
    ctx.beginPath(); for (let i = 0; i < 8; i++) { const a = (i / 8) * Math.PI * 2; ctx.moveTo(cx, cy); ctx.quadraticCurveTo(cx + Math.cos(a + 0.4) * rr * 0.7, cy + Math.sin(a + 0.4) * rr * 0.7, cx + Math.cos(a) * rr, cy + Math.sin(a) * rr); } ctx.stroke();
    ctx.beginPath(); ctx.arc(cx, cy, rr * 0.32, 0, 6.28); ctx.stroke();
  };
  for (const [x, y] of [[0, 0], [N, 0], [0, N], [N, N]]) motif(x, y, 120, '#5a3d1c');
  motif(N / 2, N / 2, 120, '#3a1a1e');
  ctx.strokeStyle = '#2e0d11'; ctx.lineWidth = 10; ctx.strokeRect(N * 0.25, N * 0.25, N * 0.5, N * 0.5);
  const img = ctx.getImageData(0, 0, N, N), d = img.data; let s = 5;
  for (let i = 0; i < d.length; i += 4) { s = (s * 1103515245 + 12345) & 0x7fffffff; const n = (s / 0x7fffffff - 0.5) * 30; d[i] += n; d[i + 1] += n; d[i + 2] += n; }
  ctx.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(cv); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(40, 40); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
  return t;
}

/** Soft rounded-rectangle cookie for the canopy spot: an even pool over the felt that falls off past the rails. */
function canopyCookie(halfSpan) {
  // Computed per pixel in world units so the falloff is exact:
  //   along the table (x): super-gaussian, ~0.38 at the felt ends (|x|=17, ~1.4 stops down), ~0.05 past the rail;
  //   across (z): flat over the felt (~0.7 at the edges) and dropping to ~0.25 on the rail tops, near-black beyond.
  const N = 256; const cv = document.createElement('canvas'); cv.width = cv.height = N; const ctx = cv.getContext('2d');
  const img = ctx.createImageData(N, N), d = img.data;
  for (let j = 0; j < N; j++) {
    const z = ((j + 0.5) / N * 2 - 1) * halfSpan;
    // across: ~0.6 at the felt edge (z=6.5), ~0.2 on the rail tops (z=8.6), black beyond
    const fz = Math.exp(-Math.pow(Math.abs(z) / 7.6, 3));
    for (let i = 0; i < N; i++) {
      const x = ((i + 0.5) / N * 2 - 1) * halfSpan;
      // along: a gaussian pool rather than a flat-topped softbox: 1.0 centre, ~0.7 over the place boxes
      // (x=7), ~0.45 over the come boxes (x=12), ~0.25 at the felt ends (|x|=17): with the hot core below
      // that is a ~40-45% display-luminance drop from the centre to the end caps
      const fx = Math.exp(-Math.pow(Math.abs(x) / 16.2, 2.6));
      // a hotter elliptical core right under the canopy: the pool reads as a directional pendant
      const core = 1 + 0.95 * Math.exp(-(x * x) / 46 - (z * z) / 14);
      // past the felt's far edge (z < -6.5) keep a little spill alive so the far rubber wall is lit
      const spill = z < -6 ? 0.14 * Math.exp(-Math.pow((-z - 7.2) / 1.6, 2)) * Math.exp(-Math.pow(Math.abs(x) / 17, 4)) : 0;
      const v = Math.min(1, (fx * fz * core) / 1.8 + spill);
      const k = (j * N + i) * 4; const b = Math.round(255 * Math.pow(v, 1 / 2.2)); // stored gamma-ish for precision
      d[k] = d[k + 1] = d[k + 2] = b; d[k + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(cv);
  // decode the gamma-encoded ramp back to linear in the light (sRGB is close to 2.2)
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/**
 * Cookie for the far-wall spill spot: traced per texel through the spot's own projection (the
 * shadow camera three.js uses for light maps: fov = 2*angle, aspect 1, looking at the target), so
 * only rays that meet the plane z=-6.5 between the felt and the rail cap are lit.
 */
function wallBandCookie(pos, target, angle, opt = null) {
  if (opt) return endBandCookie(pos, target, angle, opt);
  const N = 256, cv = document.createElement('canvas'); cv.width = cv.height = N; const ctx = cv.getContext('2d');
  const img = ctx.createImageData(N, N), d = img.data;
  const f = new THREE.Vector3().subVectors(target, pos).normalize();
  const r = new THREE.Vector3().crossVectors(f, new THREE.Vector3(0, 1, 0)).normalize();
  const u = new THREE.Vector3().crossVectors(r, f);
  const th = Math.tan(angle), dir = new THREE.Vector3();
  const ss = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
  for (let j = 0; j < N; j++) {
    const ny = (1 - (j + 0.5) / N) * 2 - 1; // canvas row 0 is v=1 (flipY)
    for (let i = 0; i < N; i++) {
      const nx = ((i + 0.5) / N) * 2 - 1;
      dir.copy(f).addScaledVector(r, nx * th).addScaledVector(u, ny * th);
      let v = 0;
      if (dir.z < -1e-4) {
        const s = (-6.5 - pos.z) / dir.z, x = pos.x + dir.x * s, y = pos.y + dir.y * s;
        // wall band, brighter toward the rubber's lower half; soft at the felt and under the cap
        v = ss(-0.15, 0.25, y) * (1 - ss(2.05, 2.6, y)) * (0.8 + 0.2 * (1 - y / 2.5));
        v *= 1 - ss(15.4, 17.6, Math.abs(x));
      }
      const k = (j * N + i) * 4; const b = Math.round(255 * Math.pow(Math.max(0, v), 1 / 2.2));
      d[k] = d[k + 1] = d[k + 2] = b; d[k + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Band cookie for a short end wall (plane x = opt.plane): the rubber band plus a thin felt skirt beside it. */
function endBandCookie(pos, target, angle, { plane, span }) {
  const N = 256, cv = document.createElement('canvas'); cv.width = cv.height = N; const ctx = cv.getContext('2d');
  const img = ctx.createImageData(N, N), d = img.data;
  const f = new THREE.Vector3().subVectors(target, pos).normalize();
  const r = new THREE.Vector3().crossVectors(f, new THREE.Vector3(0, 1, 0)).normalize();
  const u = new THREE.Vector3().crossVectors(r, f);
  const th = Math.tan(angle), dir = new THREE.Vector3();
  const ss = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
  for (let j = 0; j < N; j++) {
    const ny = (1 - (j + 0.5) / N) * 2 - 1;
    for (let i = 0; i < N; i++) {
      const nx = ((i + 0.5) / N) * 2 - 1;
      dir.copy(f).addScaledVector(r, nx * th).addScaledVector(u, ny * th);
      let v = 0;
      const sw = (plane - pos.x) / dir.x, sf = dir.y < -1e-4 ? -pos.y / dir.y : Infinity;
      if (sw > 0 && sw < sf) {
        const y = pos.y + dir.y * sw, z = pos.z + dir.z * sw;
        v = ss(-0.1, 0.3, y) * (1 - ss(2.2, 2.75, y)) * (0.75 + 0.25 * (1 - y / 2.7)) * (1 - ss(span - 1.6, span, Math.abs(z)));
      } else if (sf < Infinity) {
        // felt skirt: a soft lift within ~3 units of the wall, fading toward the layout centre
        const x = pos.x + dir.x * sf, z = pos.z + dir.z * sf, dw = Math.abs(plane - x);
        v = 0.3 * (1 - ss(0.6, 3.2, dw)) * (1 - ss(span - 1.4, span, Math.abs(z)));
      }
      const k = (j * N + i) * 4; const b = Math.round(255 * Math.pow(Math.max(0, v), 1 / 2.2));
      d[k] = d[k + 1] = d[k + 2] = b; d[k + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/**
 * In-world result readout: a small gold-rimmed glass tag that floats above the resting dice with the
 * total and its name ("6 · HARD SIX"), constant on-screen size so it reads from the gameplay camera.
 */
function makeResultTag() {
  const W = 512, H = 300, cv = document.createElement('canvas'); cv.width = W; cv.height = H; const ctx = cv.getContext('2d');
  const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 4;
  tex.userData.keepCanvas = true; // redrawn on every roll: its canvas must survive the post-upload canvas release
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false, fog: false, toneMapped: false, opacity: 0 });
  const sprite = new THREE.Sprite(mat); sprite.renderOrder = 50; sprite.visible = false;
  sprite.center.set(0.5, 0); // anchored at its pointer tip
  mat.sizeAttenuation = false;
  const NAMES = { 2: 'ACES', 3: 'ACE-DEUCE', 4: 'FOUR', 5: 'FIVE', 6: 'SIX', 7: 'SEVEN', 8: 'EIGHT', 9: 'NINE', 10: 'TEN', 11: 'YO-LEVEN', 12: 'TWELVE' };
  function draw(d1, d2) {
    const tot = d1 + d2, hard = d1 === d2 && tot >= 4 && tot <= 10;
    const label = hard ? `HARD ${NAMES[tot]}` : tot === 7 ? 'SEVEN' : tot === 2 || tot === 3 || tot === 12 ? `CRAPS · ${NAMES[tot]}` : tot === 11 ? 'YO' : `EASY ${NAMES[tot]}`;
    ctx.clearRect(0, 0, W, H);
    const x = 46, y = 16, w = W - 92, h = H - 92, rad = 34;
    // soft drop shadow
    ctx.save(); ctx.shadowColor = 'rgba(0,0,0,0.7)'; ctx.shadowBlur = 22; ctx.shadowOffsetY = 6;
    ctx.fillStyle = 'rgba(14,9,6,0.86)'; ctx.beginPath(); ctx.roundRect(x, y, w, h, rad); ctx.fill(); ctx.restore();
    // pointer
    ctx.fillStyle = 'rgba(14,9,6,0.86)'; ctx.beginPath(); ctx.moveTo(W / 2 - 22, y + h - 1); ctx.lineTo(W / 2 + 22, y + h - 1); ctx.lineTo(W / 2, H - 6); ctx.closePath(); ctx.fill();
    const gold = ctx.createLinearGradient(0, y, 0, y + h); gold.addColorStop(0, '#f6dc96'); gold.addColorStop(0.5, '#c8963c'); gold.addColorStop(1, '#8a5f22');
    ctx.strokeStyle = gold; ctx.lineWidth = 5; ctx.beginPath(); ctx.roundRect(x, y, w, h, rad); ctx.stroke();
    ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
    const num = ctx.createLinearGradient(0, y + 20, 0, y + 150); num.addColorStop(0, '#fff3cf'); num.addColorStop(1, '#e2b25a');
    ctx.fillStyle = num; ctx.font = `700 132px Georgia, "Times New Roman", serif`; ctx.fillText(String(tot), W / 2, y + 140);
    ctx.fillStyle = tot === 7 ? '#ff8a7a' : '#f1d9a6'; ctx.font = `700 34px Georgia, serif`;
    ctx.fillText(label.split('').join(' '), W / 2, y + 190);
    tex.needsUpdate = true;
  }
  let goal = 0;
  return {
    sprite,
    show(point, d1, d2, { instant = false } = {}) {
      draw(d1, d2);
      if (point) sprite.position.set(point.x, (point.y || 0) + 0.75, point.z);
      sprite.visible = true; goal = 1; if (instant) mat.opacity = 1;
    },
    hide() { goal = 0; },
    /** still fading in or out (the render loop keeps drawing until it settles) */
    busy() { return sprite.visible && Math.abs(goal - mat.opacity) > 0.01; },
    update(dt, camera) {
      mat.opacity += (goal - mat.opacity) * (1 - Math.exp(-dt * 7));
      if (goal === 0 && mat.opacity < 0.01) { sprite.visible = false; mat.opacity = 0; }
      if (!sprite.visible) return;
      // ~84 px tall at any fov (sizeAttenuation off: scale is a fraction of the view height x 2 tan(fov/2))
      const k = 2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) * (108 / Math.max(400, (camera.userData.viewH || 900)));
      sprite.scale.set(k * (W / H), k, 1);
    },
  };
}

export function createStage({ canvas, quality = 'high', isShot = false, caps = {} } = {}) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', preserveDrawingBuffer: isShot });
  // CPU rasterisers (and every headless ?shot capture) get the 'soft' profile so a frame costs
  // a fraction of a second instead of tens of seconds; real GPUs keep the requested quality.
  const software = isSoftwareRenderer(renderer.getContext());
  // caps: per-device feature switches learned by main.js's crash guard (a launch that died with MSAA or bloom on
  // turns that feature off for every tier on this device), plus ?msaa=0 / ?bloom=0 overrides for testing
  const sp = new URLSearchParams(location.search);
  const tier = (name) => {
    const q = { ...(isShot ? QUALITY.soft : software ? QUALITY.cpu : (QUALITY[name] || QUALITY.high)) };
    if (caps.noMsaa || sp.get('msaa') === '0') q.msaa = 0;
    if (caps.noBloom || sp.get('bloom') === '0') q.bloom = false;
    return q;
  };
  let Q = tier(quality);
  const viewSize = () => {
    const w = canvas.clientWidth || window.visualViewport?.width || window.innerWidth;
    const h = canvas.clientHeight || window.visualViewport?.height || window.innerHeight;
    return [Math.max(1, Math.round(w)), Math.max(1, Math.round(h))];
  };
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, Q.pixelRatio));
  renderer.setSize(...viewSize(), false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  // tone mapping: ACES (default, punchy), AgX (gentler highlight roll-off) or Khronos Neutral; ?tm=agx
  let toneName = 'aces';
  function setToneMapping(name) {
    toneName = TONE_MAPS[name] !== undefined ? name : 'aces';
    renderer.toneMapping = TONE_MAPS[toneName];
    // AgX/Neutral compress less aggressively in the mids than ACES: matched exposure keeps the felt level
    renderer.toneMappingExposure = toneName === 'agx' ? 1.22 : toneName === 'neutral' ? 0.86 : 1.0;
  }
  setToneMapping(new URLSearchParams(location.search).get('tm') || 'aces');
  renderer.shadowMap.enabled = true;
  // PCFSoft: bilinear-filtered taps, so the 4096 key map gives smooth penumbrae under chips and dice with no
  // stair-stepping or dithered PCF rings (plain PCF with a radius scattered its taps into visible blocks)
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x050303);
  scene.fog = new THREE.FogExp2(0x0a0605, 0.0085);

  const pmrem = new THREE.PMREMGenerator(renderer);
  const envScene = buildEnvScene();
  const envTex = pmrem.fromScene(envScene, 0.025).texture;
  envScene.traverse((o) => { o.geometry?.dispose?.(); o.material?.dispose?.(); });
  pmrem.dispose();
  scene.environment = envTex;
  scene.environmentIntensity = 0.5;

  const [vw0, vh0] = viewSize();
  const camera = new THREE.PerspectiveCamera(38, vw0 / vh0, 0.05, 500);
  camera.position.set(0, 20, 21);

  // ---------- lights ----------
  // no hemisphere / broad fills on the felt: the canopy pool is the only real light on the layout,
  // so the table falls off into darkness at the ends and rails exactly like a pendant-lit pit.
  const hemi = new THREE.HemisphereLight(0xffe2c4, 0x140806, 0.0);
  hemi.visible = false; scene.add(hemi);
  // canopy key: a projected pool over the layout (the hero light, casts the shadows)
  const KEY_ANGLE = 0.56, KEY_H = 34; // cone radius ~21.4 on the felt: covers the layout + rails, no more
  const key = new THREE.SpotLight(0xffe2bc, 6.6, 0, KEY_ANGLE, 0.0, 0);
  key.position.set(0, KEY_H, 2.0); // slight tilt keeps the projector's up-vector well defined
  key.target.position.set(0, 0, 0.3);
  key.map = canopyCookie(KEY_H * Math.tan(KEY_ANGLE));
  key.castShadow = true;
  key.shadow.mapSize.set(Q.shadow, Q.shadow);
  key.shadow.camera.near = 22; key.shadow.camera.far = 46;
  // tighten the shadow frustum to the felt + rails (half-width ~19.5 at 34 up = 0.52 rad of the 0.74 cone):
  // ~2x the texel density on the layout, so chip stacks, the puck and the dice get crisp contact shadows
  // (done by narrowing the cone itself, KEY_ANGLE: shadow.focus would also shrink the cookie projection
  // and leave an unmasked full-intensity ring between the cookie square and the cone edge)
  key.shadow.bias = -0.00015; key.shadow.normalBias = 0.012; key.shadow.radius = 2;
  scene.add(key, key.target);
  // two narrow warm accents high over each end: they don't flatten the pool (tight cones on the
  // rails' near curve) but give the lacquered wood a long travelling specular highlight.
  const fillL = new THREE.SpotLight(0xffc58a, 0.9, 0, 0.16, 0.9, 0);
  fillL.position.set(-9, 30, 22); fillL.target.position.set(-6, 3, 8.2); scene.add(fillL, fillL.target);
  const fillR = new THREE.SpotLight(0xffc58a, 0.9, 0, 0.16, 0.9, 0);
  fillR.position.set(9, 30, 22); fillR.target.position.set(6, 3, 8.2); scene.add(fillR, fillR.target);
  // kept for API compatibility; disabled (it caused the flat look and a hot streak on the near rail)
  const front = new THREE.SpotLight(0xffd7ae, 0, 0, 0.6, 1, 0); front.visible = false;
  // cool rim from the far side: separates dice/chips/rail silhouettes from the dark room
  const rim = new THREE.DirectionalLight(0x9fc4e0, 0.75); rim.position.set(-6, 9, -30); scene.add(rim);
  // grazing warm wash from the player side (~4 deg elevation): lifts the far wall's diamond rubber
  // out of the void and gives chip edges a little form, while adding almost nothing to the felt (N.L~0.07)
  const wallWash = new THREE.DirectionalLight(0xffc890, 0.8); wallWash.position.set(4, 3.2, 40); wallWash.target.position.set(0, 0.5, 0);
  scene.add(wallWash, wallWash.target);
  // far-wall spill: a spot from over the player's shoulder whose cookie is a single horizontal band
  // that lands exactly on the far rubber wall (y 0..2.5 at z=-6.5). Rays in that band pass above the
  // felt and the bets, so it lifts the diamond rubber out of the void without flattening the pool.
  const wallSpot = new THREE.SpotLight(0xffcf9c, 6.0, 0, 0.6, 0, 0);
  wallSpot.position.set(0, 17, 25); wallSpot.target.position.set(0, 1.2, -6.5);
  wallSpot.map = wallBandCookie(wallSpot.position, wallSpot.target.position, 0.6);
  wallSpot.castShadow = true; // required for the cookie; also lets the rail cast onto the wall
  wallSpot.shadow.mapSize.set(512, 512); wallSpot.shadow.camera.near = 8; wallSpot.shadow.camera.far = 50;
  // (table owner) near must sit in front of the player-side rail: three.js skips the cookie for fragments outside
  // the light's depth range, so with near=20 the armrest/apron (depth ~19) got this 6.0 spot unmasked, with a
  // hard cone edge: the "seam" across the wood and the over-bright tomato leather.
  wallSpot.shadow.bias = -0.0005; wallSpot.shadow.normalBias = 0.03;
  scene.add(wallSpot, wallSpot.target);
  // end-wall spills: the same banded-cookie trick for the two short walls (x = +-17.3), thrown from across the
  // table. The dice land against these walls, so the low dice close-ups see lit diamond rubber (a surface, not a
  // void), and a thin skirt of felt next to the wall is lifted so the landing zone is never crushed to black.
  const endSpots = [];
  for (const s of [-1, 1]) {
    const sp = new THREE.SpotLight(0xffd2a4, 5.2, 0, 0.5, 0, 0);
    sp.position.set(-s * 6, 13, 3.5); sp.target.position.set(s * 17.3, 1.0, 0);
    sp.map = wallBandCookie(sp.position, sp.target.position, 0.5, { axis: 'x', plane: s * 17.3, span: 6.2 });
    sp.castShadow = true; sp.shadow.mapSize.set(512, 512); sp.shadow.camera.near = 6; sp.shadow.camera.far = 40;
    sp.shadow.bias = -0.0005; sp.shadow.normalBias = 0.03;
    scene.add(sp, sp.target); endSpots.push(sp);
  }
  // the wall/end-wall spots only throw the (static) rail onto the walls: on phones their three shadow maps are
  // drawn once instead of every frame (a moving die no longer shades the wall; nothing else changes)
  function applyStaticFill() {
    for (const l of [wallSpot, ...endSpots]) { l.shadow.autoUpdate = !Q.staticFill; l.shadow.needsUpdate = true; }
  }
  applyStaticFill();

  // ---------- room ----------
  const room = new THREE.Group(); room.name = 'room'; scene.add(room);
  const floorMat = new THREE.MeshStandardMaterial({ map: carpetTexture(), roughness: 1, color: 0x8a7a78 });
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(320, 320), floorMat);
  floor.rotation.x = -Math.PI / 2; floor.position.y = -7.5; floor.receiveShadow = true; room.add(floor);
  // soft dark contact shadow / light spill under the table on the carpet
  {
    const N = 256, cv = document.createElement('canvas'); cv.width = cv.height = N; const ctx = cv.getContext('2d');
    const g = ctx.createRadialGradient(N / 2, N / 2, 10, N / 2, N / 2, N / 2);
    g.addColorStop(0, 'rgba(0,0,0,0.85)'); g.addColorStop(0.6, 'rgba(0,0,0,0.5)'); g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, N, N);
    const sh = new THREE.Mesh(new THREE.PlaneGeometry(62, 32), new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(cv), transparent: true, depthWrite: false }));
    sh.rotation.x = -Math.PI / 2; sh.position.y = -7.48; room.add(sh);
  }
  const panoH = 150;
  const pano = new THREE.Mesh(
    new THREE.CylinderGeometry(150, 150, panoH, 96, 1, true),
    new THREE.MeshBasicMaterial({ map: casinoPanorama(7), side: THREE.BackSide, fog: false, depthWrite: false }),
  );
  // place the painted floor line (v≈0.18 from bottom) at carpet level
  pano.position.y = -7.5 - panoH * 0.18 + panoH * 0.5;
  pano.renderOrder = -10;
  room.add(pano);

  // out-of-focus slot banks standing on the casino floor around the table (pre-blurred billboards)
  {
    const r = rng(404);
    const texs = [0, 1, 2, 3].map((i) => slotBankTexture(101 + i * 17));
    const banks = [
      // [angle (0 = +x, -PI/2 = behind the table), radius, width]
      [-Math.PI / 2, 29, 50], [-Math.PI / 2 - 0.8, 34, 44], [-Math.PI / 2 + 0.8, 34, 44],
      [-Math.PI / 2 - 1.55, 40, 44], [-Math.PI / 2 + 1.55, 40, 44], [Math.PI / 2 - 0.9, 50, 40], [Math.PI / 2 + 0.9, 50, 40],
    ];
    banks.forEach(([a, rad, w], i) => {
      const h = w * 0.36;
      const mat = new THREE.MeshBasicMaterial({ map: texs[i % texs.length], transparent: true, depthWrite: false, fog: true });
      // kept well under the lit felt so the room reads as out-of-focus glow, not a sharp arcade wall
      mat.color.setRGB(0.9, 0.8, 0.72);
      const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
      m.position.set(Math.cos(a) * rad, -7.5 + h * 0.5 - 0.4, Math.sin(a) * rad);
      m.lookAt(0, m.position.y, 0);
      m.renderOrder = -5;
      room.add(m);
    });
    // warm lamp pools from neighbouring gaming tables / slot banks on the carpet
    const poolTex = (() => {
      const N = 256, cv = document.createElement('canvas'); cv.width = cv.height = N; const ctx = cv.getContext('2d');
      const g = ctx.createRadialGradient(N / 2, N / 2, 0, N / 2, N / 2, N / 2);
      g.addColorStop(0, 'rgba(255,190,120,0.55)'); g.addColorStop(0.45, 'rgba(255,150,80,0.18)'); g.addColorStop(1, 'rgba(255,120,60,0)');
      ctx.fillStyle = g; ctx.fillRect(0, 0, N, N);
      const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; return t;
    })();
    for (let i = 0; i < 14; i++) {
      const a = -Math.PI / 2 + (r() - 0.5) * 4.2, rad = 30 + r() * 26;
      const s = 12 + r() * 18;
      const m = new THREE.Mesh(new THREE.PlaneGeometry(s, s * (0.5 + r() * 0.4)), new THREE.MeshBasicMaterial({ map: poolTex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0.35 + r() * 0.4 }));
      m.rotation.x = -Math.PI / 2; m.rotation.z = r() * Math.PI;
      m.position.set(Math.cos(a) * rad, -7.45, Math.sin(a) * rad);
      room.add(m);
    }
  }

  // parallax bokeh sprites floating in the mid-distance (out-of-focus casino lights)
  const bokehTex = bokehSprite();
  const bokeh = new THREE.Group(); room.add(bokeh);
  function buildBokeh(count) {
    for (const s of bokeh.children.splice(0)) s.material.dispose();
    const r = rng(1234);
    const cols = [0xffb24a, 0xffc56a, 0xff9a3a, 0xffd890, 0xffb060, 0xff7a3a, 0xff4a5a, 0xffe0a0, 0x8a7aff];
    for (let i = 0; i < count; i++) {
      // most discs sit behind the far rail, where the gameplay camera sees them over the table
      const back = r() < 0.75;
      const a = back ? -Math.PI / 2 + (r() - 0.5) * 2.6 : r() * Math.PI * 2, rad = 40 + r() * 60;
      const x = Math.cos(a) * rad, z = Math.sin(a) * rad;
      const m = new THREE.SpriteMaterial({ map: bokehTex, color: new THREE.Color(pick(r, cols)), transparent: true, opacity: 0.08 + r() * 0.2, blending: THREE.AdditiveBlending, depthWrite: false, fog: false });
      const s = new THREE.Sprite(m);
      const size = 2.4 + Math.pow(r(), 1.6) * 7.5;
      s.scale.set(size, size, 1);
      // back discs sit in the band the gameplay camera sees between the far rail and the frame top
      s.position.set(x, back ? -4 + r() * 13 : 2 + r() * 20, z);
      s.userData = { ph: r() * 6.283, sp: 0.3 + r() * 0.8, base: m.opacity };
      bokeh.add(s);
    }
  }
  buildBokeh(Q.bokeh);

  // ---------- room depth: neighbouring gaming tables under their own lamps, with hazy light shafts ----------
  // Real 3D shapes at 30-55 units that parallax against the panorama as the camera orbits: a dark
  // table body, a glowing felt top, an HDR lamp bar (blooms) and an additive volumetric cone of haze.
  {
    const shaftMat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: false,
      uniforms: { uColor: { value: new THREE.Color(1.0, 0.72, 0.42) }, uK: { value: 0.11 } },
      vertexShader: /* glsl */`varying float vH; varying vec3 vN; varying vec3 vV;
        void main(){ vH = uv.y; vec4 mv = modelViewMatrix * vec4(position,1.0); vN = normalize(normalMatrix * normal); vV = normalize(-mv.xyz); gl_Position = projectionMatrix * mv; }`,
      fragmentShader: /* glsl */`uniform vec3 uColor; uniform float uK; varying float vH; varying vec3 vN; varying vec3 vV;
        void main(){ float edge = pow(abs(dot(normalize(vN), normalize(vV))), 1.6); float a = uK * edge * smoothstep(0.0, 0.25, vH) * (0.35 + 0.65 * vH);
          gl_FragColor = vec4(uColor * a, 1.0); }`,
    });
    const lampMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0xffd6a0).multiplyScalar(3.2), fog: false });
    const silMat = new THREE.MeshStandardMaterial({ color: 0x0b0807, roughness: 0.45, metalness: 0.3 });
    const brassMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0xffc070).multiplyScalar(0.9) });
    // mid-ground slot cabinets between the table and the blurred floor: dark, sharp silhouettes with lit
    // screens and glowing toppers, rim-caught by the cool back light. They overlap the bokeh band, so the
    // room reads as layers (table -> cabinets -> blurred floor -> panorama) instead of a backdrop.
    {
      const r = rng(5150);
      const cabGeo = new THREE.BoxGeometry(1.7, 6.6, 1.5), faceGeo = new THREE.PlaneGeometry(1.7, 6.6);
      // each front is a painted cabinet (topper sign, reel window, button deck, belly art), very slightly
      // softened: mid-ground depth of field, so the silhouette reads as a slot machine, not a colour tile
      const faceMats = [0, 1, 2, 3, 4].map((i) => {
        const m = new THREE.MeshBasicMaterial({ map: slotCabinetTexture(900 + i * 31) });
        m.color.setRGB(0.2, 0.18, 0.17); return m;
      });      const rows = [
        // centre angle (0 = +x, -PI/2 = behind the table), radius, cabinets, angular step
        [-Math.PI / 2 + 0.7, 38, 6, 0.09], [-Math.PI / 2 - 0.74, 39, 5, 0.088],
      ];
      for (const [a0, rad, n, step] of rows) {
        for (let k = 0; k < n; k++) {
          const a = a0 + (k - (n - 1) / 2) * step;
          const g = new THREE.Group();
          g.position.set(Math.cos(a) * rad, -7.5, Math.sin(a) * rad);
          g.lookAt(0, -7.5, 0); g.scale.setScalar(2.0); // true scale: a cabinet stands ~1.7x the rail height
          const cab = new THREE.Mesh(cabGeo, silMat); cab.position.y = 3.3; g.add(cab);
          const face = new THREE.Mesh(faceGeo, pick(r, faceMats)); face.position.set(0, 3.3, 0.76); g.add(face);

          room.add(g);
        }
      }
    }
    const spots = [
      // x, z, rotY, felt colour
      // placed in the band the gameplay camera sees between the far rail and the frame top
      [-21, -25, 0.12, 0x0e4a24], [22, -26.5, -0.16, 0x5a1018], [-46, -16, -1.05, 0x0e4a24], [46, -15, 1.05, 0x0e4a24],
    ];
    const pool = (() => {
      const N = 128, cv = document.createElement('canvas'); cv.width = cv.height = N; const ctx = cv.getContext('2d');
      const gr = ctx.createRadialGradient(N / 2, N / 2, 0, N / 2, N / 2, N / 2);
      gr.addColorStop(0, 'rgba(255,190,120,0.5)'); gr.addColorStop(0.5, 'rgba(255,150,80,0.16)'); gr.addColorStop(1, 'rgba(255,120,60,0)');
      ctx.fillStyle = gr; ctx.fillRect(0, 0, N, N);
      const tx = new THREE.CanvasTexture(cv); tx.colorSpace = THREE.SRGBColorSpace; return tx;
    })();
    for (const [x, z, ry, felt] of spots) {
      const g = new THREE.Group(); g.position.set(x, -7.5, z); g.rotation.y = ry;
      const lp = new THREE.Mesh(new THREE.PlaneGeometry(30, 17), new THREE.MeshBasicMaterial({ map: pool, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
      lp.rotation.x = -Math.PI / 2; lp.position.y = 0.06; g.add(lp);
      // the neighbouring table itself is out of focus: a pre-blurred top-down card (dark rail, lit felt,
      // patrons' shoulders) laid at rail height, so it reads as a soft lit shape, never as a sharp prop
      const top = new THREE.Mesh(new THREE.PlaneGeometry(22, 11), new THREE.MeshBasicMaterial({ map: blurredTableCard(felt), transparent: true, depthWrite: false }));
      top.rotation.x = -Math.PI / 2; top.position.y = 3.2; top.renderOrder = -4; g.add(top);
      const lamp = new THREE.Mesh(new THREE.BoxGeometry(12, 0.35, 2.2), lampMat); lamp.position.y = 17; g.add(lamp);
      // the pendant canopy itself: a dark lacquered housing with a thin brass lip over the glowing diffuser,
      // so the neighbouring lamp reads as a fixture silhouette, not a floating light bar
      const housing = new THREE.Mesh(new THREE.BoxGeometry(13.2, 1.3, 3.2), silMat); housing.position.y = 17.85; g.add(housing);
      const lip = new THREE.Mesh(new THREE.BoxGeometry(13.4, 0.1, 3.4), brassMat); lip.position.y = 17.2; g.add(lip);
      for (const sx of [-5, 5]) { const rod = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 14, 6), silMat); rod.position.set(sx, 25.5, 0); g.add(rod); }
      const shaft = new THREE.Mesh(new THREE.CylinderGeometry(4.6, 8.6, 13.6, 24, 1, true), shaftMat);
      shaft.scale.set(1.25, 1, 0.55); shaft.position.y = 10.2; shaft.rotation.y = 0; g.add(shaft);
      // CylinderGeometry uv.y runs 0 (bottom) -> 1 (top): brightest under the lamp, fading toward the floor
      room.add(g);
    }
    // marquee bulbs on the slot-bank toppers: small HDR discs that the bloom picks up
    const bulbTex = bokehTex;
    const r = rng(77);
    const banks = [[-Math.PI / 2, 29, 50], [-Math.PI / 2 - 0.8, 34, 44], [-Math.PI / 2 + 0.8, 34, 44]];
    for (const [a, rad, w] of banks) {
      const cx = Math.cos(a) * rad, cz = Math.sin(a) * rad, h = w * 0.36, yTop = -7.5 + h - 0.4 - h * 0.17;
      const tx = -Math.sin(a), tz = Math.cos(a); // tangent along the bank
      for (let k = 0; k < 8; k++) {
        const along = (k + 0.5) / 8 - 0.5;
        const col = new THREE.Color(pick(r, [0xffd27a, 0xffb050, 0xff6a50, 0xffe6b0])).multiplyScalar(2.6 + r() * 1.4);
        const m = new THREE.SpriteMaterial({ map: bulbTex, color: col, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false, opacity: 0.85 });
        const s = new THREE.Sprite(m); const sz = 0.9 + r() * 0.6; s.scale.set(sz, sz, 1);
        s.position.set(cx + tx * along * w * 0.9 * 1.02, yTop + (r() - 0.5) * 0.6, cz + tz * along * w * 0.9 * 1.02);
        s.position.x *= 0.985; s.position.z *= 0.985; // a hair in front of the billboard
        room.add(s);
      }
    }
  }

  // overhead canopy fixture (visible from low camera angles): dark lacquered housing + glowing diffuser
  const hood = new THREE.Group();
  const hoodMat = new THREE.MeshStandardMaterial({ color: 0x120a06, roughness: 0.35, metalness: 0.7 });
  const hoodBody = new THREE.Mesh(new THREE.BoxGeometry(30, 1.0, 7.5), hoodMat);
  const diffuser = new THREE.Mesh(new THREE.PlaneGeometry(28.6, 6.1), new THREE.MeshBasicMaterial({ color: new THREE.Color(0xffe2b8).multiplyScalar(2.2), fog: false }));
  diffuser.rotation.x = Math.PI / 2; diffuser.position.y = -0.51;
  const trimMat = new THREE.MeshStandardMaterial({ color: 0xc9a14a, metalness: 1, roughness: 0.3 });
  const trim = new THREE.Mesh(new THREE.BoxGeometry(30.2, 0.12, 7.7), trimMat); trim.position.y = -0.5;
  hood.add(hoodBody, diffuser, trim); hood.position.set(0, 44, 1.5); scene.add(hood);

  // ---------- post ----------
  let composer = null, bloom = null, grade = null;
  function buildComposer() {
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    const rt = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType, samples: Q.msaa });
    composer = new EffectComposer(renderer, rt);
    composer.addPass(new RenderPass(scene, camera));
    // bloom from genuinely hot HDR sources only: specular glints on brass/chip edges/dice, the slot
    // marquee bulbs and the neighbouring tables' lamps. Lit felt (incl. its white print) peaks well
    // under the threshold, so the layout and dice faces never grow a halo.
    if (Q.bloom) { bloom = new UnrealBloomPass(new THREE.Vector2(size.x / 2, size.y / 2), BLOOM.strength, BLOOM.radius, BLOOM.threshold); composer.addPass(bloom); } else bloom = null;
    composer.addPass(new OutputPass());
    const shader = { ...GradeShader, defines: { USE_CA: Q.ca ? 1 : 0, USE_GRAIN: Q.grain ? 1 : 0 } };
    grade = new ShaderPass(shader);
    grade.uniforms.uRes.value.set(size.x, size.y);
    composer.addPass(grade);
  }
  buildComposer();

  let lastW = 0, lastH = 0;
  function resize(force = false) {
    const [w, h] = viewSize();
    if (!force && w === lastW && h === lastH) return;
    lastW = w; lastH = h;
    camera.aspect = w / h; camera.userData.viewH = h; camera.updateProjectionMatrix();
    renderer.setSize(w, h, false);
    composer.setPixelRatio(renderer.getPixelRatio());
    composer.setSize(w, h);
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    grade?.uniforms.uRes.value.set(size.x, size.y);
  }
  // size from the canvas box itself (CSS 100vw x 100vh), re-checked whenever layout settles
  canvas.style.width = '100vw'; canvas.style.height = '100vh';
  window.addEventListener('resize', () => resize());
  window.visualViewport?.addEventListener('resize', () => resize());
  try { new ResizeObserver(() => resize()).observe(canvas); } catch { /* old browsers: window resize only */ }
  document.fonts?.ready?.then(() => resize(true)).catch(() => {});
  window.addEventListener('load', () => resize(true));
  resize(true);

  /**
   * three.js replaces material.envMapIntensity with scene.environmentIntensity for materials that
   * rely on scene.environment. Binding the env map explicitly makes each material's own intensity
   * count, so lacquered wood/brass reflect the canopy strongly while the felt stays matte.
   */
  function applyEnv(root) {
    root.traverse((o) => {
      const ms = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of ms) if (m && m.isMeshStandardMaterial && !m.envMap) { m.envMap = envTex; m.needsUpdate = true; }
    });
  }

  const resultTag = makeResultTag(); scene.add(resultTag.sprite);

  let t = 0;
  return {
    applyEnv,
    /** true when the browser rasterises WebGL on the CPU (hardware acceleration off / GPU blocklisted) */
    software,
    /** the WebGL renderer string, for diagnostics */
    gpu: (() => { try { const gl = renderer.getContext(), ext = gl.getExtension('WEBGL_debug_renderer_info'); return String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)); } catch { return ''; } })(),
    /** Float the roll's total over the resting dice (gameplay readout); hidden again by hideResult() on the next throw. */
    showResult(point, d1, d2, opts) { resultTag.show(point, d1, d2, opts); },
    /**
     * Compile the scene's shaders in the background (KHR_parallel_shader_compile) before the first frame.
     * Bound to the composer's HDR target: three.js keys programs on the current render target (offscreen =
     * no tone mapping, linear output), so compiling against the screen built ~40 programs the frame never used.
     */
    precompile() {
      // (compiling one top-level group at a time was measured: same peak, 25% slower, so all at once)
      const prev = renderer.getRenderTarget();
      renderer.setRenderTarget(composer.readBuffer);
      let p;
      try { p = renderer.compileAsync(scene, camera); } finally { renderer.setRenderTarget(prev); }
      return p;
    },
    /** true while the in-world result tag is fading (render-on-demand keeps drawing) */
    busy() { return resultTag.busy(); },
    hideResult() { resultTag.hide(); },
    renderer, scene, camera, lights: { key, fillL, fillR, front, hemi, rim, wallSpot, wallWash, endSpots }, room,
    get quality() { return Q; },
    get toneMapping() { return toneName; },
    setToneMapping,
    /** Rebuilds everything quality-dependent: pixel ratio, shadow maps, MSAA target, bloom, grade defines, bokeh count. */
    setQuality(name) {
      // software rasterisers stay on the cheap profile whatever the menu says (a 'high' frame would take seconds)
      Q = tier(name);
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, Q.pixelRatio));
      key.shadow.mapSize.set(Q.shadow, Q.shadow); key.shadow.map?.dispose(); key.shadow.map = null;
      applyStaticFill();
      if (bokeh.children.length !== Q.bokeh) buildBokeh(Q.bokeh);
      composer?.renderTarget1?.dispose?.(); composer?.renderTarget2?.dispose?.();
      bloom?.dispose?.(); grade?.material?.dispose?.();
      buildComposer(); resize(true);
    },
    render(dt) {
      t += dt;
      if (grade) grade.uniforms.uTime.value = isShot ? 0.37 : t;
      resultTag.update(dt, camera);
      if (!isShot) for (const s of bokeh.children) { const u = s.userData; s.material.opacity = u.base * (0.75 + 0.25 * Math.sin(t * u.sp + u.ph)); }
      composer.render(dt);
    },
    resize,
  };
}
