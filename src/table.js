// table.js — the craps table: felt bed, inner tub walls lined with pyramid "diamond" rubber, brass bead,
// grooved hardwood chip rail, stitched padded leather armrest, drink shelf, lacquered apron and plinth.
// Everything is swept along the felt's racetrack outline, so all rails stay concentric.
import * as THREE from 'three';
import { FELT, ZONES } from './bets.js';
import { createFeltTexture, createFeltFiberTexture, createFeltDetailTexture } from './feltTexture.js';

// deep tub: the dice wall stands 2.7 (≈27 cm) above the cloth so it reads as a real backstop
export const WALL_H = 3.3;
const RAIL_TOP_Y = WALL_H + 0.11;
/** Chip rail groove geometry (offset outward from felt edge, y of groove floor). */
// Two routed grooves wide enough for a chip on edge (Ø0.82) and 0.8 deep, so racked chips sit down in the wood
// with only their top edge at the lip line. The padded armrest is the widest, highest, outermost element.
export const RAIL = { grooves: [0.84, 1.93], grooveY: RAIL_TOP_Y - 0.8, grooveW: 0.88, armTop: RAIL_TOP_Y + 1.25, armCenterO: 3.78, armRX: 1.3, armRY: 0.84 };

/** Points around the felt's racetrack outline (big player-side end radii, tighter dealer side), outward normals. */
function roundedRectPath(hw, hd, Rf, Rn, seg = 14) {
  const pts = [];
  const corners = [[hw - Rn, hd - Rn, 0, Rn], [-(hw - Rn), hd - Rn, Math.PI / 2, Rn], [-(hw - Rf), -(hd - Rf), Math.PI, Rf], [hw - Rf, -(hd - Rf), Math.PI * 1.5, Rf]];
  for (const [cx, cz, a0, R] of corners) {
    const n = Math.max(4, Math.round(seg * Math.sqrt(R / 1.4)));
    for (let i = 0; i <= n; i++) {
      const a = a0 + (Math.PI / 2) * (i / n);
      const nx = Math.cos(a), nz = Math.sin(a);
      pts.push({ x: cx + nx * R, z: cz + nz * R, nx, nz });
    }
  }
  pts.push({ ...pts[0] });
  let s = 0;
  pts.forEach((p, i) => { if (i) s += Math.hypot(p.x - pts[i - 1].x, p.z - pts[i - 1].z); p.s = s; });
  return pts;
}

/** Sweep a 2D profile [(offset, y)] around the path. u = arc length at that offset (world units). */
function sweep(path, profile, { uScale = 1, vScale = 1, smooth = true, shade = null } = {}) {
  const pos = [], uv = [], idx = [], col = [];
  const np = profile.length;
  const vlen = [0];
  for (let j = 1; j < np; j++) vlen.push(vlen[j - 1] + Math.hypot(profile[j][0] - profile[j - 1][0], profile[j][1] - profile[j - 1][1]));
  const total = path[path.length - 1].s;
  // cumulative turning angle: arc length at offset o is s + o·θ, so u follows the true length of every ring
  // (grain sweeps round the corners instead of stretching across them); each ring is normalised to the same
  // number of tiles per lap so the loop still closes without a seam
  if (path[0].th === undefined) {
    let th = 0; path[0].th = 0;
    for (let i = 1; i < path.length; i++) {
      const a = path[i - 1], b = path[i];
      th += Math.atan2(a.nx * b.nz - a.nz * b.nx, a.nx * b.nx + a.nz * b.nz); b.th = th;
    }
  }
  const thT = path[path.length - 1].th;
  for (let i = 0; i < path.length; i++) {
    const p = path[i];
    for (let j = 0; j < np; j++) {
      const [o, y] = profile[j];
      pos.push(p.x + p.nx * o, y, p.z + p.nz * o);
      uv.push(((p.s + o * p.th) / (total + o * thT)) * total / uScale, vlen[j] / vScale);
      if (shade) { const v = shade[j]; col.push(v, v, v); }
    }
  }
  for (let i = 0; i < path.length - 1; i++) for (let j = 0; j < np - 1; j++) {
    const a = i * np + j, b = (i + 1) * np + j, c = (i + 1) * np + j + 1, d = i * np + j + 1;
    idx.push(a, b, d, b, c, d); // profile traversed clockwise around the solid → outward normals
  }
  let g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  if (shade) g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3)); // baked cavity AO per profile point
  g.setIndex(idx);
  g.computeVertexNormals();
  if (smooth) seamNormals(g, path.length, np);
  return g;
}
/** The first and last ring coincide — average their normals so the loop has no shading seam. */
function seamNormals(g, nPath, np) {
  const n = g.attributes.normal;
  for (let j = 0; j < np; j++) {
    const a = j, b = (nPath - 1) * np + j;
    const x = n.getX(a) + n.getX(b), y = n.getY(a) + n.getY(b), z = n.getZ(a) + n.getZ(b);
    const l = Math.hypot(x, y, z) || 1;
    n.setXYZ(a, x / l, y / l, z / l); n.setXYZ(b, x / l, y / l, z / l);
  }
}

const smooth01 = (t) => { t = Math.max(0, Math.min(1, t)); return t * t * (3 - 2 * t); };
function arcProfile(cx, cy, r, a0, a1, n) { const p = []; for (let i = 0; i <= n; i++) { const a = a0 + (a1 - a0) * (i / n); p.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]); } return p; }

/** Point + outward normal on the path at arc length s, offset o. */
function pathAt(path, s, o = 0) {
  const total = path[path.length - 1].s; s = ((s % total) + total) % total;
  let lo = 0, hi = path.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (path[m].s <= s) lo = m; else hi = m; }
  const a = path[lo], b = path[hi], t = (s - a.s) / Math.max(1e-6, b.s - a.s);
  let nx = a.nx + (b.nx - a.nx) * t, nz = a.nz + (b.nz - a.nz) * t; const l = Math.hypot(nx, nz); nx /= l; nz /= l;
  return { x: a.x + (b.x - a.x) * t + nx * o, z: a.z + (b.z - a.z) * t + nz * o, nx, nz };
}

/** Arc-length parameterisation of the path offset by o (corners are longer than on the base path). */
function offsetCurve(path, o, n = 4000) {
  const total = path[path.length - 1].s, pts = [];
  let L = 0, prev = null;
  for (let i = 0; i <= n; i++) {
    const p = pathAt(path, (i / n) * total, o);
    if (prev) L += Math.hypot(p.x - prev.x, p.z - prev.z);
    p.L = L; pts.push(p); prev = p;
  }
  return {
    length: L,
    at(l) {
      l = ((l % L) + L) % L; let lo = 0, hi = pts.length - 1;
      while (hi - lo > 1) { const m = (lo + hi) >> 1; if (pts[m].L <= l) lo = m; else hi = m; }
      const a = pts[lo], b = pts[hi], t = (l - a.L) / Math.max(1e-9, b.L - a.L);
      return { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t, nx: a.nx, nz: a.nz };
    },
  };
}

// ---------- procedural materials ----------
function rngOf(seed) { let s = seed; return () => { s = (s * 16807) % 2147483647; return s / 2147483647; }; }

/** Periodic value noise (wraps every `px` cells in x) — keeps the wood tile seamless along the rail. */
function periodicNoise(seed, px, py) {
  const rnd = rngOf(seed), g = new Float32Array(px * py); for (let i = 0; i < g.length; i++) g[i] = rnd();
  const sm = (t) => t * t * (3 - 2 * t);
  return (x, y) => {
    const xi = Math.floor(x), yi = Math.floor(y), fx = sm(x - xi), fy = sm(y - yi);
    const X0 = ((xi % px) + px) % px, X1 = (X0 + 1) % px, Y0 = ((yi % py) + py) % py, Y1 = (Y0 + 1) % py;
    const a = g[Y0 * px + X0], b = g[Y0 * px + X1], c = g[Y1 * px + X0], d = g[Y1 * px + X1];
    return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
  };
}
const hexRGB = (h) => { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };

/** Figured walnut / mahogany, painted per pixel: flowing growth rings with dark latewood lines, open pores
 *  elongated along the grain, ribbon figure (chatoyant cross bands) and a matching roughness map.
 *  Features are sized to survive mipmapping at gameplay distance (grain spacing ≈ 2–6 cm on the table). */
function woodTextures({ w = 2048, h = 512, base = '#8a4a26', dark = '#3c1a0a', light = '#c27c46', seed = 3, rings = 16 } = {}) {
  // The tile spans ~7 world units along the rail (u) and 1 unit across the profile (v): grain lines run along u
  // and are stretched ~10x relative to their spacing, wandering only with long gentle waves (no marble swirls).
  const cv = document.createElement('canvas'); cv.width = w; cv.height = h; const ctx = cv.getContext('2d');
  const rv = document.createElement('canvas'); rv.width = w; rv.height = h; const rx = rv.getContext('2d');
  const img = ctx.createImageData(w, h), d = img.data, rimg = rx.createImageData(w, h), rd = rimg.data;
  const n1 = periodicNoise(seed, 3, 4), n2 = periodicNoise(seed + 1, 10, 12), n3 = periodicNoise(seed + 2, 24, 160), n4 = periodicNoise(seed + 3, 64, 256);
  const B = hexRGB(base), D = hexRGB(dark), Lc = hexRGB(light);
  const rnd = rngOf(seed + 7);
  for (let y = 0; y < h; y++) {
    const v = y / h;
    for (let x = 0; x < w; x++) {
      const u = x / w;
      // long-wavelength waviness (one or two slow swells per tile) + a soft cathedral rise every half tile
      const warp = (n1(u * 3, v * 4) - 0.5) * 1.4 + Math.sin(u * Math.PI * 2 + v * 1.3) * 0.35
        + Math.pow(Math.abs(Math.sin(u * Math.PI * 2 + (n1(u * 3 + 1.7, v * 4) - 0.5) * 1.2)), 3) * 0.6
        + (n2(u * 10, v * 12) - 0.5) * 0.12;
      const t = v * rings + warp;
      const ring = t - Math.floor(t);
      // earlywood → latewood: gentle darkening then a fine dark line
      const late = Math.pow(ring, 2.2) * 0.5 + (ring > 0.88 ? Math.pow((ring - 0.88) / 0.12, 0.7) * 0.42 : 0);
      // fine straight fibre streaks: very elongated along u (24 cells across u vs 160 across v)
      const fine = (n3(u * 24, v * 160) - 0.5);
      const chat = (n2(u * 10 + 3.3, v * 2) - 0.5); // faint, broad chatoyant lift (no cross bands)
      const k = 0.14 + late * 0.78 + fine * 0.16 - chat * 0.06;
      let r = B[0] + (D[0] - B[0]) * k, g = B[1] + (D[1] - B[1]) * k, b = B[2] + (D[2] - B[2]) * k;
      const lift = Math.max(0, (1 - late) * 0.08 + chat * 0.08);
      r += (Lc[0] - r) * lift; g += (Lc[1] - g) * lift; b += (Lc[2] - b) * lift;
      const p = (y * w + x) * 4;
      d[p] = r; d[p + 1] = g; d[p + 2] = b; d[p + 3] = 255;
      const rough = 0.4 + late * 0.16 + (n4(u * 64, v * 256) - 0.5) * 0.06;
      rd[p] = rd[p + 1] = rd[p + 2] = Math.max(0, Math.min(255, rough * 255)); rd[p + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0); rx.putImageData(rimg, 0, 0);
  // open pores: long thin dark ticks running with the grain (wrapped horizontally); the lacquer
  // doesn't fill them, so they are rougher than the surrounding wood
  const dash = (c, x, y, len, th) => { c.fillRect(x, y, len, th); if (x + len > w) c.fillRect(x - w, y, len, th); };
  for (let i = 0; i < 30000; i++) {
    const x = rnd() * w, y = rnd() * h, len = 6 + rnd() * 22;
    ctx.fillStyle = `rgba(30,10,3,${0.16 + rnd() * 0.3})`; dash(ctx, x, y, len, rnd() < 0.75 ? 1 : 1.5);
    rx.fillStyle = 'rgba(255,255,255,0.25)'; dash(rx, x, y, len, 1);
  }
  // a few ray flecks: small lustrous cross-grain ticks, sparse
  for (let i = 0; i < 700; i++) {
    const x = rnd() * w, y = rnd() * h, len = 2 + rnd() * 4;
    ctx.fillStyle = `rgba(214,150,96,${0.06 + rnd() * 0.1})`; ctx.fillRect(x, y, 2.5 + rnd() * 3, len);
    rx.fillStyle = 'rgba(0,0,0,0.12)'; rx.fillRect(x, y, 2.5, len);
  }
  const map = new THREE.CanvasTexture(cv); map.wrapS = map.wrapT = THREE.RepeatWrapping; map.colorSpace = THREE.SRGBColorSpace; map.anisotropy = 8;
  const rough = new THREE.CanvasTexture(rv); rough.wrapS = rough.wrapT = THREE.RepeatWrapping; rough.colorSpace = THREE.NoColorSpace; rough.anisotropy = 8;
  map.userData.rough = rough;
  return map;
}

/** Re-tints every specular lobe (direct, IBL, clear coat) to a warm lamp colour of the same luminance, so the
 *  room's cool rim light / neutral env map can never put a blue-white streak on wood, leather or brass. */
function warmSpecular(mat, tint = [1.0, 0.82, 0.6], key = 'warm') {
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = (sh, r) => {
    prev?.call(mat, sh, r);
    sh.fragmentShader = sh.fragmentShader.replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
    {
      const vec3 WARM = vec3(${tint.map((x) => x.toFixed(3)).join(',')});
      const vec3 LUM = vec3(0.2126, 0.7152, 0.0722);
      reflectedLight.directSpecular = dot(reflectedLight.directSpecular, LUM) * WARM;
      reflectedLight.indirectSpecular = dot(reflectedLight.indirectSpecular, LUM) * WARM;
      #ifdef USE_CLEARCOAT
        clearcoatSpecularDirect = dot(clearcoatSpecularDirect, LUM) * WARM;
        clearcoatSpecularIndirect = dot(clearcoatSpecularIndirect, LUM) * WARM;
      #endif
    }`);
  };
  const prevKey = mat.customProgramCacheKey.bind(mat);
  mat.customProgramCacheKey = () => prevKey() + '|' + key;
  return mat;
}

/** Pebble-grain leather: fine isotropic pebbles (no long creases), colour + bump + roughness. */
function leatherTextures(size = 512, color = '#4e2016', seed = 42) {
  const cv = document.createElement('canvas'); cv.width = cv.height = size; const ctx = cv.getContext('2d');
  const bv = document.createElement('canvas'); bv.width = bv.height = size; const bx = bv.getContext('2d');
  ctx.fillStyle = color; ctx.fillRect(0, 0, size, size);
  bx.fillStyle = '#7a7a7a'; bx.fillRect(0, 0, size, size);
  const rnd = rngOf(seed);
  // dense cellular pebbles: small round discs, wrapped so the tile is seamless
  // dark valley network first, then raised pebbles on top: high contrast so the grain survives at arm's length
  bx.fillStyle = '#4a4a4a'; bx.fillRect(0, 0, size, size);
  for (let i = 0; i < 9000; i++) {
    const x = rnd() * size, y = rnd() * size, r = 2.0 + rnd() * 3.2;
    for (const [ox, oy] of [[0, 0], [size, 0], [-size, 0], [0, size], [0, -size]]) {
      if (x + ox < -r || x + ox > size + r || y + oy < -r || y + oy > size + r) continue;
      const g = bx.createRadialGradient(x + ox, y + oy - r * 0.15, 0, x + ox, y + oy, r);
      g.addColorStop(0, 'rgba(235,235,235,0.85)'); g.addColorStop(0.55, 'rgba(185,185,185,0.55)'); g.addColorStop(0.85, 'rgba(110,110,110,0.2)'); g.addColorStop(1, 'rgba(60,60,60,0)');
      bx.fillStyle = g; bx.fillRect(x + ox - r, y + oy - r, r * 2, r * 2);
    }
  }
  const img = ctx.getImageData(0, 0, size, size), d = img.data, bi = bx.getImageData(0, 0, size, size).data;
  const lo = periodicNoise(seed + 5, 6, 6);
  for (let i = 0, p = 0; i < d.length; i += 4, p++) {
    const x = p % size, y = (p / size) | 0;
    // pebble tops a touch lighter (worn), valleys darker (dirt in the grain) + soft hand-rubbed mottling
    const n = (bi[i] - 128) * 0.12 + (lo((x / size) * 6, (y / size) * 6) - 0.5) * 9;
    d[i] += n; d[i + 1] += n * 0.55; d[i + 2] += n * 0.6;
  }
  ctx.putImageData(img, 0, 0);
  const rv = document.createElement('canvas'); rv.width = rv.height = size; const rx = rv.getContext('2d');
  const rimg = rx.createImageData(size, size), rd = rimg.data;
  // valleys matte, pebble crowns satin-polished by forearms, plus low-frequency burnish patches
  const lo2 = periodicNoise(seed + 9, 4, 4);
  for (let i = 0, p = 0; i < rd.length; i += 4, p++) {
    const x = p % size, y = (p / size) | 0;
    const r = 0.74 - ((bi[i] - 128) / 255) * 0.36 + (lo2((x / size) * 4, (y / size) * 4) - 0.5) * 0.14;
    rd[i] = rd[i + 1] = rd[i + 2] = Math.max(0, Math.min(255, Math.round(r * 255))); rd[i + 3] = 255;
  }
  rx.putImageData(rimg, 0, 0);
  const map = new THREE.CanvasTexture(cv); map.wrapS = map.wrapT = THREE.RepeatWrapping; map.colorSpace = THREE.SRGBColorSpace; map.anisotropy = 8;
  const bump = new THREE.CanvasTexture(bv); bump.wrapS = bump.wrapT = THREE.RepeatWrapping; bump.colorSpace = THREE.NoColorSpace;
  const rough = new THREE.CanvasTexture(rv); rough.wrapS = rough.wrapT = THREE.RepeatWrapping; rough.colorSpace = THREE.NoColorSpace;
  return { map, bump, rough };
}

/** Diamond rubber sheet textures: `cells` x `cells` square pyramids rotated 45° (diamonds, half-offset rows),
 *  low relief with softened ridges. Albedo carries baked cavity AO (valleys darker, worn crowns a touch lighter),
 *  roughness stays matte (0.8-0.92). Normal map is tangent space (u along the rail, v up the wall). */
function diamondRubberTextures(size = 512, cells = 4) {
  const hgt = new Float32Array(size * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const cx = (x / size) * cells, cy = (y / size) * cells;
    const a = cx + cy, b = cx - cy;
    const fa = a - Math.floor(a) - 0.5, fb = b - Math.floor(b) - 0.5;
    let h = 0.5 - Math.max(Math.abs(fa), Math.abs(fb)); // 0 at the valleys, 0.5 at the apex
    h = h * 2; h = h * h * (3 - 2 * h) * 0.15 + h * 0.85;   // rounded ridges, slightly blunt apex
    hgt[y * size + x] = Math.min(h, 0.92);
  }
  const at = (x, y) => hgt[(((y % size) + size) % size) * size + (((x % size) + size) % size)];
  const mk = () => { const c = document.createElement('canvas'); c.width = c.height = size; return c; };
  const nc = mk(), cc = mk(), rc = mk();
  const ni = nc.getContext('2d').createImageData(size, size), ci = cc.getContext('2d').createImageData(size, size), ri = rc.getContext('2d').createImageData(size, size);
  const rnd = rngOf(77);
  const k = size / cells * 0.24; // relief ≈ 3-4 mm, facets ≈ 30°: reads as raised diamonds, not a mesh
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const i = (y * size + x) * 4, h = at(x, y);
    const dx = (at(x + 1, y) - at(x - 1, y)) * 0.5 * k, dy = (at(x, y + 1) - at(x, y - 1)) * 0.5 * k;
    // canvas y runs down = texture v runs up (flipY), so +dh/dy_px tilts the normal toward +v
    let nx = -dx, ny = dy, nz = 1; const l = Math.hypot(nx, ny, nz); nx /= l; ny /= l; nz /= l;
    ni.data[i] = (nx * 0.5 + 0.5) * 255; ni.data[i + 1] = (ny * 0.5 + 0.5) * 255; ni.data[i + 2] = (nz * 0.5 + 0.5) * 255; ni.data[i + 3] = 255;
    const grain = (rnd() - 0.5) * 5;
    const v = 26 + h * 40 + grain; // dark grey: valleys ≈ 26, crowns ≈ 62 (sRGB)
    ci.data[i] = v; ci.data[i + 1] = v * 0.98; ci.data[i + 2] = v * 1.02; ci.data[i + 3] = 255;
    const r = 0.92 - h * 0.14 + (rnd() - 0.5) * 0.04;
    ri.data[i] = ri.data[i + 1] = ri.data[i + 2] = Math.round(r * 255); ri.data[i + 3] = 255;
  }
  nc.getContext('2d').putImageData(ni, 0, 0); cc.getContext('2d').putImageData(ci, 0, 0); rc.getContext('2d').putImageData(ri, 0, 0);
  const tex = (c, srgb) => { const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace; t.anisotropy = 8; t.minFilter = THREE.LinearMipmapLinearFilter; return t; };
  return { map: tex(cc, true), normal: tex(nc, false), rough: tex(rc, false) };
}

/** Diamond rubber: a dark charcoal satin with a faked grazing key (upward facets catch the lamp, sideways
 *  facets get a soft rim) so the pyramid faceting still reads from the gameplay cameras. */
function rubberGrazing(mat, strength = 1) {
  mat.onBeforeCompile = (sh) => {
    sh.fragmentShader = sh.fragmentShader.replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
    {
      vec3 upV = normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz);
      float up = clamp(dot(normal, upV), -1.0, 1.0);
      float fres = pow(1.0 - clamp(abs(dot(normal, normalize(vViewPosition))), 0.0, 1.0), 2.0);
      float key = smoothstep(-0.15, 0.9, up);
      totalEmissiveRadiance += vec3(0.1, 0.094, 0.088) * ${strength.toFixed(3)} * (key * key * 0.9 + fres * 0.45 + 0.08);
    }`);
  };
  mat.customProgramCacheKey = () => 'rubber-graze-' + strength;
  return mat;
}

export function createTable({ renderer, quality = 'high' } = {}) {
  const group = new THREE.Group(); group.name = 'table';
  const { hw, hd } = FELT;
  const hi = quality !== 'low';
  const path = roundedRectPath(hw, hd, FELT.cornerR, FELT.cornerRNear, hi ? 18 : 9);
  const total = path[path.length - 1].s;

  // ---------- felt ----------
  // shot mode renders the close-ups (dice / chips), so it gets the full 8K print (≈237 px per unit)
  const shotMode = typeof location !== 'undefined' && new URLSearchParams(location.search).has('shot');
  const { map } = createFeltTexture({ resolution: quality === 'high' || shotMode ? 8192 : quality === 'medium' ? 4096 : 2048, renderer });
  if (renderer) map.anisotropy = renderer.capabilities.getMaxAnisotropy(); // crisp far-end type at grazing angles
  const fiber = createFeltFiberTexture(256);
  // fine wool nap: ≈4.5 tiles per unit (256 px tile → ≈1150 px/unit) so close-ups show individual fibres
  fiber.repeat.set(FELT.w * 4.5, FELT.d * 4.5);
  fiber.anisotropy = renderer ? Math.min(16, renderer.capabilities.getMaxAnisotropy()) : 8;
  const detail = createFeltDetailTexture(512);
  // Wool cloth: almost no specular (so red ink holds crimson instead of going coral at grazing angles),
  // a velvet sheen lobe that brightens the nap toward the far rail, and fibre bump.
  const feltMat = new THREE.MeshPhysicalMaterial({
    map, roughness: 0.96, metalness: 0, bumpMap: fiber, bumpScale: 2.6,
    specularIntensity: 0.22, specularColor: new THREE.Color('#d8e8dc'),
    sheen: hi ? 0.7 : 0, sheenRoughness: 0.42, sheenColor: new THREE.Color('#2f7a5e'), envMapIntensity: 0.18,
  });
  // Wool detail at three scales: a large nap mottle (~12 tiles across the table, survives at play distance as
  // soft brushed patches), then fine fibre octaves for close-ups. The nap also tilts the normal a little so the
  // canopy light rakes across it, and the red ink is clamped so ACES keeps it crimson.
  feltMat.onBeforeCompile = (sh) => {
    sh.uniforms.feltDetail = { value: detail };
    sh.uniforms.feltDetailRep = { value: new THREE.Vector2(40, 40 * FELT.d / FELT.w) };
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform sampler2D feltDetail;\nuniform vec2 feltDetailRep;\nfloat gFeltNap;')
      .replace('#include <map_fragment>', `#include <map_fragment>
      {
        vec2 duv = vMapUv * feltDetailRep;
        float d0 = texture2D(feltDetail, duv * 0.3 + vec2(0.13, 0.29)).r - 0.5;
        float d1 = texture2D(feltDetail, duv).r - 0.5;
        float d2 = texture2D(feltDetail, duv * 3.73 + vec2(0.37, 0.61)).r - 0.5;
        gFeltNap = d0;
        // printed ink (bright or red) keeps only the low-frequency wear: no per-pixel fibre speckle on the type
        float inkM = smoothstep(0.1, 0.22, max(diffuseColor.r, diffuseColor.g));
        diffuseColor.rgb *= clamp(1.0 + d0 * 0.9 + (d1 * 1.3 + d2 * 1.0) * (1.0 - 0.8 * inkM), 0.55, 1.4);
        // lamp pools over each working half (and a softer one over the props): ≈30% falloff to the rails
        vec2 fw = (vMapUv - 0.5) * vec2(${FELT.w.toFixed(2)}, ${FELT.d.toFixed(2)});
        float pl = exp(-dot((fw - vec2(-8.6, 0.0)) / vec2(8.0, 6.2), (fw - vec2(-8.6, 0.0)) / vec2(8.0, 6.2)));
        float pr = exp(-dot((fw - vec2(8.6, 0.0)) / vec2(8.0, 6.2), (fw - vec2(8.6, 0.0)) / vec2(8.0, 6.2)));
        float pc = exp(-dot(fw / vec2(5.0, 6.0), fw / vec2(5.0, 6.0))) * 0.85;
        diffuseColor.rgb *= 0.63 + 0.45 * max(max(pl, pr), pc);
        // red ink: keep hue, cap the green/blue lift so lit reds stay crimson, not coral
        if (diffuseColor.r > 0.04 && max(diffuseColor.g, diffuseColor.b) < diffuseColor.r * 0.3) diffuseColor.gb = min(diffuseColor.gb, vec2(diffuseColor.r * 0.08));
      }`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
      normal = normalize(normal + gFeltNap * 0.22 * normalize((viewMatrix * vec4(1.0, 0.0, 0.35, 0.0)).xyz));`);
  };
  feltMat.customProgramCacheKey = () => 'felt-detail-v4';
  const feltGeo = new THREE.PlaneGeometry(FELT.w + 0.6, FELT.d + 0.6, 1, 1);
  // keep UVs aligned to the printed felt area (texture spans exactly FELT.w x FELT.d)
  const uvA = feltGeo.attributes.uv; const pA = feltGeo.attributes.position;
  for (let i = 0; i < uvA.count; i++) uvA.setXY(i, (pA.getX(i) + hw) / FELT.w, (pA.getY(i) + hd) / FELT.d);
  const felt = new THREE.Mesh(feltGeo, feltMat);
  felt.rotation.x = -Math.PI / 2; felt.receiveShadow = true; felt.name = 'felt';
  group.add(felt);

  // ---------- materials ----------
  // Warm figured mahogany (lighter than the oxblood leather so the two read apart), satin clear coat.
  // golden-brown mahogany (hue ~25 deg) so it separates from the burgundy leather (hue ~355 deg)
  const capMap = woodTextures({ base: '#8a5230', dark: '#3a1a0a', light: '#d09a60', seed: 3, rings: 7 });
  // u = arc length along the racetrack: a whole number of tiles per lap, so the loop closes without a seam
  const lapRepeat = (len) => Math.max(1, Math.round(total / len)) / total;
  capMap.repeat.set(lapRepeat(7), 1);
  const woodCap = warmSpecular(new THREE.MeshPhysicalMaterial({ map: capMap, roughnessMap: capMap.userData.rough, roughness: 1, clearcoat: 0.4, clearcoatRoughness: 0.3, envMapIntensity: 0.45, specularColor: new THREE.Color('#ffd9b0') }), undefined, 'cap');
  // chip rail: golden mahogany under a satin (not glassy) lacquer: a soft broad sheen, no long white streaks
  const railMap = woodTextures({ base: '#8e532c', dark: '#3a1a0a', light: '#c99260', seed: 9, rings: 6 });
  railMap.repeat.set(lapRepeat(7), 1);
  const railWood = warmSpecular(new THREE.MeshPhysicalMaterial({ map: railMap, roughnessMap: railMap.userData.rough, roughness: 1, clearcoat: 0.7, clearcoatRoughness: 0.27, envMapIntensity: 0.45, vertexColors: true, specularColor: new THREE.Color('#ffd9b0') }), undefined, 'rail');
  // apron under the armrest: darker, quieter wood so the leather owns the outer silhouette
  const apronMap = woodTextures({ base: '#5a2e18', dark: '#220e06', light: '#8a5630', seed: 21, rings: 6 });
  apronMap.repeat.set(lapRepeat(9), 1);
  const apronWood = warmSpecular(new THREE.MeshPhysicalMaterial({ map: apronMap, roughnessMap: apronMap.userData.rough, roughness: 0.9, clearcoat: 0.5, clearcoatRoughness: 0.3, envMapIntensity: 0.4 }), undefined, 'apron');
  const lt = leatherTextures(512, '#5a1e22'); // oxblood, lifted so the armrest separates from the black room
  // 0.75-unit tile (≈8 cm): pebbles ≈1–1.5 mm like real upholstery hide, large enough to read within a metre
  lt.map.repeat.set(1 / 0.75, 1 / 0.75); lt.bump.repeat.copy(lt.map.repeat); lt.rough.repeat.copy(lt.map.repeat);
  // Pebbled oxblood leather: matte (roughness >= 0.75), a soft broad sheen along the crown, no sharp lobe.
  const leatherBase = new THREE.MeshPhysicalMaterial({
    map: lt.map, bumpMap: lt.bump, bumpScale: 2.0, roughness: 1.0, roughnessMap: lt.rough, metalness: 0,
    sheen: 0.8, sheenRoughness: 0.6, sheenColor: new THREE.Color('#b07c6c'), envMapIntensity: 0.6,
    specularIntensity: 0.5, specularColor: new THREE.Color('#f2dcc4'), vertexColors: true,
  });
  // roughness follows the tuck & roll: creases / welt channels (low baked AO) go dull, the crown of the roll
  // is a broad satin; a slow variation along the rail breaks up the highlight like hand-rubbed hide
  leatherBase.onBeforeCompile = (sh) => {
    sh.fragmentShader = sh.fragmentShader.replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
      roughnessFactor = clamp(roughnessFactor * mix(1.3, 0.95, smoothstep(0.35, 1.0, vColor.r)) * (0.95 + 0.1 * sin(vRoughnessMapUv.x * 0.9 + sin(vRoughnessMapUv.x * 0.23) * 3.0)), 0.75, 1.0);`);
  };
  const leather = warmSpecular(leatherBase, [1.0, 0.86, 0.7], 'leather-v5');
  const brass = warmSpecular(new THREE.MeshPhysicalMaterial({ color: 0xb8904e, metalness: 1, roughness: 0.32, envMapIntensity: 0.85 }), [1.0, 0.8, 0.52], 'brass');
  const wallMat = new THREE.MeshStandardMaterial({ color: 0x1c1c1e, roughness: 0.78, metalness: 0, side: THREE.DoubleSide, envMapIntensity: 0.3 });
  // diamond rubber: dark charcoal satin; facets pick up a grazing key so the pattern reads at distance
  const rubber = new THREE.MeshStandardMaterial({ color: 0x232225, roughness: 0.55, metalness: 0, envMapIntensity: 0.4 });
  // diamond rubber: a low-relief (≈2 mm) normal-mapped, mip-mapped sheet; matte charcoal, so it reads as
  // rubber up close and settles to a quiet texture (no moire) from the gameplay camera
  const dr = diamondRubberTextures(hi ? 512 : 256, 4);
  // fewer, larger diamonds (≈2.7 cm cells) with deeper relief and a faint grazing key
  const pyrRubber = rubberGrazing(new THREE.MeshStandardMaterial({ map: dr.map, normalMap: dr.normal, normalScale: new THREE.Vector2(1.8, 1.8), roughnessMap: dr.rough, roughness: 1, metalness: 0, envMapIntensity: 0.4 }), 1.2);
  // waxed tan thread: darker than the gold HUD, matte, so it reads as stitching rather than paint
  const thread = new THREE.MeshStandardMaterial({ color: 0xa07a50, roughness: 0.78, metalness: 0, envMapIntensity: 0.25 });
  const cabinet = new THREE.MeshStandardMaterial({ color: 0x140805, roughness: 0.55 });

  // ---------- inner wall (rubber backing) ----------
  const wall = new THREE.Mesh(sweep(path, [[0, -0.05], [0, WALL_H]], { uScale: 4, vScale: 4 }), wallMat);
  wall.receiveShadow = true; group.add(wall);
  // felt-to-wall cove: a tiny dark fillet hides the seam and grounds the wall
  const cove = new THREE.Mesh(sweep(path, [[-0.16, 0.001], [-0.05, 0.03], [0, 0.11]]), new THREE.MeshStandardMaterial({ color: 0x020604, roughness: 1 }));
  group.add(cove);

  // ---------- pyramid "diamond" rubber (instanced) ----------
  {
    // one rubber sheet (0.1 thick) swept round the tub; diamonds are ≈1.6 cm, a whole number per lap (no seam)
    const y0 = 0.16, y1 = WALL_H - 0.36, cell = 0.36, tile = cell * 4;
    const uTile = total / Math.round(total / tile);
    const sheet = new THREE.Mesh(sweep(path, [[-0.1, y0], [-0.1, y1]], { uScale: uTile, vScale: tile }), pyrRubber);
    sheet.receiveShadow = true; group.add(sheet);
    // rubber sheet edge strips (bottom welt and top binding run right up under the cap's bullnose)
    group.add(new THREE.Mesh(sweep(path, [[-0.002, -0.02], [-0.11, 0.0], [-0.12, y0 + 0.02], [-0.1, y0 + 0.05]]), rubber));
    group.add(new THREE.Mesh(sweep(path, [[-0.1, y1 - 0.04], [-0.12, y1], [-0.12, WALL_H - 0.1], [-0.002, WALL_H - 0.06]]), rubber));
  }

  // ---------- lacquered wood cap: a bullnose lip that overhangs the rubber and rolls onto the rail ----------
  const capProf = [[0.0, WALL_H - 0.15], [-0.04, WALL_H - 0.135],
    ...arcProfile(-0.04, WALL_H - 0.02, 0.105, -Math.PI / 2 - 0.25, -Math.PI * 1.5, hi ? 16 : 8),
    [0.08, WALL_H + 0.105], [0.2, WALL_H + 0.115], [0.32, WALL_H + 0.11]];
  const cap = new THREE.Mesh(sweep(path, capProf, { shade: capProf.map((_, j) => (j < 3 ? 0.35 : 1)) }), woodCap);
  woodCap.vertexColors = true;
  cap.castShadow = true; cap.receiveShadow = true; group.add(cap);

  // ---------- chip rail (two routed grooves, brass-lined lips) ----------
  const gY = RAIL.grooveY, top = WALL_H + 0.11;
  // U-section grooves: rounded arris, near-vertical walls, elliptical floor. Baked cavity AO darkens the walls
  // and floor so the routed depth reads from the default camera even before the chips' own shadows.
  const railProf = [], railAO = [];
  const P_ = (o, y, ao = 1) => { railProf.push([o, y]); railAO.push(ao); };
  P_(0.32, top);
  for (const c of RAIL.grooves) {
    // generous rounded lips (they catch the canopy light as two bright lines along each groove), walls in
    // soft shadow, and a floor that is still clearly lit so the routed channel reads from the player camera
    // Deep routed channel: only the far (outer) arris catches the lamp as one lit lip; the near arris is a
    // tight dim edge, the walls fall into shadow and the floor is dark (AO), so the groove reads as a cut.
    const r = RAIL.grooveW / 2, vr = 0.3, e = 0.07;
    P_(c - r - e * 0.5, top, 0.8); P_(c - r - e * 0.1, top - e * 0.2, 0.62); P_(c - r, top - e * 0.6, 0.45);
    P_(c - r, top - 0.22, 0.3); P_(c - r, gY + vr + 0.06, 0.2);
    for (let i = 0; i <= 14; i++) {
      const a = Math.PI + (i / 14) * Math.PI, depthT = -Math.sin(a); // 0 at the walls, 1 at the floor centre
      P_(c + Math.cos(a) * r, gY + vr + Math.sin(a) * vr, 0.2 - 0.06 * depthT);
    }
    P_(c + r, gY + vr + 0.06, 0.22); P_(c + r, top - 0.22, 0.4); P_(c + r, top - e, 0.75);
    P_(c + r + e * 0.08, top - e * 0.62, 1.0); P_(c + r + e * 0.29, top - e * 0.29, 1.0); P_(c + r + e * 0.62, top - e * 0.08, 1.0); P_(c + r + e, top, 0.95);
  }
  P_(2.5, top + 0.01, 0.8); P_(2.54, top + 0.06, 0.6);
  const rail = new THREE.Mesh(sweep(path, railProf, { shade: railAO }), railWood); rail.receiveShadow = true; rail.castShadow = true; group.add(rail);
  const railEnd = railProf[railProf.length - 1][0];

  // ---------- padded armrest (tufted roll with twin top-stitched welts) ----------
  // A big elliptical padded roll (≈2.6 wide, crown 1.25 above the chip rail): the outermost, highest silhouette.
  const ac = RAIL.armCenterO, rx = RAIL.armRX, ry = RAIL.armRY, ay = RAIL.armTop - ry, ar = (rx + ry) / 2;
  const ell = (a, d = 0) => [ac + Math.cos(a) * (rx - d), ay + Math.sin(a) * (ry - d)];
  const NA = hi ? 170 : 44, A0 = Math.PI * 0.97, A1 = -Math.PI * 0.47;
  const armAngles = []; for (let i = 0; i <= NA; i++) armAngles.push(A0 + (A1 - A0) * (i / NA));
  // welt grooves: pinch the profile at two seam angles; the stitch lines either side sit in shallow channels
  const seamA = [Math.PI * 0.78, Math.PI * 0.2], stitchD = 0.06;
  const stitchA = []; for (const s of seamA) for (const d of [-stitchD, stitchD]) stitchA.push(s + d);
  const armAO = [0.45];
  const armProf = [[railEnd, top + 0.06], ...armAngles.map((a) => {
    let pinch = 0, ao = 1;
    for (const s of seamA) { const g = Math.exp(-Math.pow((a - s) / 0.04, 2)); pinch += g * 0.035; ao -= g * 0.55; }
    for (const s of stitchA) { const g = Math.exp(-Math.pow((a - s) / 0.01, 2)); pinch += g * 0.006; ao -= g * 0.3; }
    // underside tucks into shadow where the roll meets the rail / apron
    ao *= 0.55 + 0.45 * smooth01((Math.sin(a) + 0.55) / 0.9);
    armAO.push(Math.max(0.25, ao));
    return ell(a, pinch);
  })];
  const arm = new THREE.Mesh(sweep(path, armProf, { shade: armAO }), leather);
  arm.castShadow = true; arm.receiveShadow = true; group.add(arm);
  // stitches: fine bronze thread, each stitch slightly canted and sunk into its channel (≈ half buried)
  if (hi) {
    // fine thread: ≈ half the old dash length, thinner, slight per-stitch jitter (length, cant, sink)
    const stitchGeo = new THREE.CylinderGeometry(0.008, 0.008, 0.05, 5, 1);
    stitchGeo.rotateZ(Math.PI / 2); // along local x
    const pitch = 0.075;
    const jit = rngOf(911);
    // stitch rows follow the ellipse, sunk to the channel floor minus half the thread
    const curves = stitchA.map((a) => { const [o, y] = ell(a, 0.006 + 0.0025); return { a, y, cv: offsetCurve(path, o) }; });
    const counts = curves.map((c) => Math.floor(c.cv.length / pitch));
    const st = new THREE.InstancedMesh(stitchGeo, thread, counts.reduce((x, y) => x + y, 0));
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), qc = new THREE.Quaternion(), pos = new THREE.Vector3(), scl = new THREE.Vector3(1, 1, 1);
    const xAxis = new THREE.Vector3(1, 0, 0), dir = new THREE.Vector3(), nrm = new THREE.Vector3();
    let n = 0;
    curves.forEach(({ a, y, cv }, li) => {
      const cnt = counts[li], step = cv.length / cnt;
      const ex = Math.cos(a) / rx, ey = Math.sin(a) / ry; // ellipse normal in the profile plane
      for (let i = 0; i < cnt; i++) {
        const p0 = cv.at(i * step), p1 = cv.at(i * step + 0.02);
        dir.set(p1.x - p0.x, 0, p1.z - p0.z).normalize();
        nrm.set(p0.nx * ex, ey, p0.nz * ex).normalize();
        q.setFromUnitVectors(xAxis, dir);
        qc.setFromAxisAngle(nrm, 0.3 + (jit() - 0.5) * 0.16); q.premultiply(qc);
        pos.set(p0.x, y - jit() * 0.0012, p0.z);
        scl.set(0.85 + jit() * 0.3, 0.9 + jit() * 0.2, 0.9 + jit() * 0.2);
        m.compose(pos, q, scl); st.setMatrixAt(n++, m);
      }
    });
    st.count = n; st.instanceMatrix.needsUpdate = true;
    group.add(st);
  }

  // ---------- outer apron, drink shelf, brass band ----------
  const endArm = armProf[armProf.length - 1];
  const AS = RAIL.armCenterO - 2.12, DY = WALL_H - 2.7; // apron offsets were authored for an arm at 2.12 / wall 2.7
  const apronProf = [[endArm[0] - 0.04, endArm[1] + 0.02], ...[[2.5, 2.12], [2.6, 1.98], [2.62, 1.8], [2.62, 1.32], [3.3, 1.3], [3.42, 1.25], [3.44, 1.15], [3.42, 1.07], [3.3, 1.02], [2.62, 1.0], [2.6, 0.2], [2.45, -0.35], [2.1, -0.72], [1.5, -0.86]].map(([o, y]) => [o + AS, y > 0 ? y + DY : y])];
  const apron = new THREE.Mesh(sweep(path, apronProf), apronWood); apron.castShadow = true; apron.receiveShadow = true; group.add(apron);
  const band = new THREE.Mesh(sweep(path, [[2.62, 1.76], [2.65, 1.71], [2.65, 1.62], [2.62, 1.57]].map(([o, y]) => [o + AS, y + DY])), brass); group.add(band);
  const shelfLip = new THREE.Mesh(sweep(path, [[3.43, 1.23], [3.47, 1.2], [3.47, 1.1], [3.43, 1.07]].map(([o, y]) => [o + AS, y + DY])), brass); group.add(shelfLip);

  // ---------- cabinet base ----------
  const base = new THREE.Mesh(new THREE.BoxGeometry(FELT.w - 2, 6.6, FELT.d - 3), cabinet);
  base.position.y = -0.85 - 3.3; base.castShadow = true; base.receiveShadow = true; group.add(base);
  const kick = new THREE.Mesh(new THREE.BoxGeometry(FELT.w - 1.4, 0.4, FELT.d - 2.4), brass);
  kick.position.y = -7.3; group.add(kick);

  // seal under the felt so nothing shows through gaps
  const bed = new THREE.Mesh(new THREE.PlaneGeometry(FELT.w + 8, FELT.d + 8), cabinet);
  bed.rotation.x = -Math.PI / 2; bed.position.y = -0.86; group.add(bed);

  // ---------- review overlay (?zones): the bets.js hit polygons drawn over the print ----------
  if (typeof location !== 'undefined' && new URLSearchParams(location.search).has('zones')) {
    const zg = new THREE.Group(); zg.name = 'zoneOverlay';
    const hue = (i) => new THREE.Color().setHSL((i * 0.137) % 1, 1, 0.55);
    ZONES.forEach((zn, i) => {
      const pts = zn.poly.map(([x, z]) => new THREE.Vector3(x, 0.012, z));
      const mat = new THREE.LineBasicMaterial({ color: hue(i), depthTest: false, transparent: true, opacity: 0.95 });
      const ln = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(pts), mat); ln.renderOrder = 50; zg.add(ln);
      const shape = new THREE.Shape(zn.poly.map(([x, z]) => new THREE.Vector2(x, -z)));
      const fg = new THREE.ShapeGeometry(shape); fg.rotateX(-Math.PI / 2);
      const fm = new THREE.Mesh(fg, new THREE.MeshBasicMaterial({ color: hue(i), transparent: true, opacity: 0.16, depthTest: false, depthWrite: false }));
      fm.position.y = 0.01; fm.renderOrder = 49; zg.add(fm);
    });
    group.add(zg);
  }

  return {
    group, felt, feltMaterial: feltMat, path,
    /** Shooter-side chip rail position for chip-rail bankroll display. */
    railPoint(x, groove = 0) { return new THREE.Vector3(x, RAIL.grooveY, hd + RAIL.grooves[groove]); },
    dispose() { group.traverse((o) => { o.geometry?.dispose?.(); }); },
  };
}
