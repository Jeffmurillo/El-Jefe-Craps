// feltTexture.js — procedurally paints the full printed craps layout onto the felt (CanvasTexture),
// plus tileable fibre textures (bump + albedo detail) blended in the felt shader.
// Printing model: the layout is drawn crisply onto a separate "ink" layer at full resolution, worn by a
// fibre mask and composited onto the dyed wool base (painted at half resolution: it is all low frequency).
// Baked ambient occlusion is multiplied in last so the tub walls darken both cloth and ink.
// Albedo budget: every ink stays below ~0.75 sRGB so the lit print never crosses the bloom threshold, and
// the reds are pre-darkened so ACES tonemapping keeps them casino red instead of drifting to salmon.
import * as THREE from 'three';
import { FELT, L, C, ZONES, POINT_NUMBERS, PUCK_OFF, NUMERAL_Z, feltOutline } from './bets.js';

const INK = '#c2baa4';      // cream screen print (kept < 0.75 albedo: ink on cloth, not a backlit decal)
const GOLD = '#ae8d48';
const YEL = '#c2a030';      // field yellow
const RED = '#7a0a0f';      // casino red, pre-darkened for the lamp + ACES
const RED_DEEP = '#68080c';
const SERIF = '"Century Schoolbook", "Bookman Old Style", Georgia, "Times New Roman", serif';
const DIDONE = '"Bodoni MT", "Century Schoolbook", Georgia, serif';
const DIDONE_COND = '"Bodoni MT Condensed", "Bodoni MT", "Century Schoolbook", Georgia, serif';
const COND = DIDONE_COND; // one house face for all small type: payouts, captions, BUY/LAY (no sans)

/** Paint the felt. Returns { map, canvas }. resolution = canvas width in px. */
export function createFeltTexture({ resolution = 4096, color = '#0a4838', renderer } = {}) {
  const maxTex = renderer ? renderer.capabilities.maxTextureSize : 8192;
  const W = Math.min(resolution, maxTex), H = Math.round((W * FELT.d) / FELT.w);
  const S = W / FELT.w; // px per world unit
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d');
  const P = (x, z) => [(x + FELT.hw) * S, (z + FELT.hd) * S];
  const rng = mulberry(20241101);

  // ================= dyed wool base (half resolution, upscaled) =================
  {
    const BW = Math.round(W / 2), BH = Math.round(H / 2), BS = BW / FELT.w;
    const bc = document.createElement('canvas'); bc.width = BW; bc.height = BH; const b = bc.getContext('2d');
    // lamp pool + falloff toward the walls (gives the cloth depth even before lighting)
    const g = b.createRadialGradient(BW / 2, BH * 0.5, BH * 0.04, BW / 2, BH * 0.5, BW * 0.58);
    g.addColorStop(0, shade(color, 1.06)); g.addColorStop(0.32, shade(color, 1.0)); g.addColorStop(0.66, shade(color, 0.86)); g.addColorStop(1, shade(color, 0.66));
    b.fillStyle = g; b.fillRect(0, 0, BW, BH);
    // elliptical vignette across the short axis so the long rails also fall off
    const v = b.createLinearGradient(0, 0, 0, BH);
    v.addColorStop(0, 'rgba(0,6,4,0.26)'); v.addColorStop(0.22, 'rgba(0,0,0,0)'); v.addColorStop(0.78, 'rgba(0,0,0,0)'); v.addColorStop(1, 'rgba(0,6,4,0.24)');
    b.fillStyle = v; b.fillRect(0, 0, BW, BH);
    // three overhead lamp pools (one over each working half, one over the props) with a soft darker
    // trough between them: the cloth reads as lit from above, not as a flat fill
    for (const [fx, a] of [[0.24, 0.13], [0.5, 0.09], [0.76, 0.13]]) {
      b.save(); b.translate(BW * fx, BH * 0.5); b.scale(1.35, 1);
      const pg = b.createRadialGradient(0, 0, 0, 0, 0, BH * 0.62);
      pg.addColorStop(0, `rgba(150,220,180,${a})`); pg.addColorStop(0.55, `rgba(120,200,160,${a * 0.45})`); pg.addColorStop(1, 'rgba(120,200,160,0)');
      b.fillStyle = pg; b.fillRect(-BW, -BH, BW * 2, BH * 2); b.restore();
    }
    // outer band in the rail's shadow: the cloth darkens within ~1 unit of the tub wall
    b.save(); b.lineJoin = 'round'; b.filter = `blur(${Math.round(BS * 0.9)}px)`; b.strokeStyle = 'rgba(0,8,5,0.42)'; b.lineWidth = BS * 2.2; feltOutline(b, BS); b.stroke(); b.restore();
    // low-frequency dye mottling so the cloth never reads as a flat fill
    b.save(); b.filter = `blur(${Math.round(BS * 0.6)}px)`;
    for (let i = 0; i < 220; i++) {
      const x = rng() * BW, y = rng() * BH, r = BS * (0.6 + rng() * 2.6);
      b.fillStyle = rng() < 0.5 ? 'rgba(0,0,0,0.016)' : 'rgba(110,170,140,0.012)';
      b.beginPath(); b.ellipse(x, y, r * (1.5 + rng()), r, rng() * 0.6 - 0.3, 0, Math.PI * 2); b.fill();
    }
    b.restore();
    // brushed nap streaks along the table length
    b.save(); b.lineCap = 'round'; b.lineWidth = Math.max(1, BS * 0.006);
    const streaks = Math.round(BW * BH / 700);
    for (let i = 0; i < streaks; i++) {
      const x = rng() * BW, y = rng() * BH, len = BS * (0.03 + rng() * 0.09), a = (rng() - 0.5) * 0.9;
      b.strokeStyle = rng() < 0.5 ? 'rgba(0,0,0,0.07)' : 'rgba(150,200,170,0.045)';
      b.beginPath(); b.moveTo(x, y); b.lineTo(x + Math.cos(a) * len, y + Math.sin(a) * len); b.stroke();
    }
    b.restore();
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bc, 0, 0, W, H);
  }
  // very faint cloth-only speckle (the shader's wool maps do the real fibre work; none of this touches the ink)
  const noiseTile = makeNoiseTile(512, 7);
  ctx.save(); ctx.fillStyle = ctx.createPattern(noiseTile, 'repeat'); ctx.globalAlpha = 0.22; ctx.fillRect(0, 0, W, H); ctx.restore();

  // ================= ink layer (full resolution, crisp) =================
  const ic = document.createElement('canvas'); ic.width = W; ic.height = H;
  const k = ic.getContext('2d');
  // die icons live on their own clean layer: the wear mask never eats a pip
  const dc = document.createElement('canvas'); dc.width = W; dc.height = H;
  const dk = dc.getContext('2d');
  const lw = (u) => Math.max(1, u * S);
  const MAJOR = 0.085, MINOR = 0.05;

  function pathPoly(pts) { k.beginPath(); pts.forEach(([x, z], i) => { const [px, py] = P(x, z); i ? k.lineTo(px, py) : k.moveTo(px, py); }); k.closePath(); }
  function poly(pts, { stroke = INK, width = MAJOR, fill = null } = {}) {
    k.save(); pathPoly(pts);
    if (fill) { k.fillStyle = fill; k.fill(); }
    if (stroke) { k.strokeStyle = stroke; k.lineWidth = lw(width); k.lineJoin = 'round'; k.stroke(); }
    k.restore();
  }
  function line(x0, z0, x1, z1, { color: c = INK, width = MAJOR } = {}) {
    k.save(); k.strokeStyle = c; k.lineWidth = lw(width); k.lineCap = 'round';
    k.beginPath(); k.moveTo(...P(x0, z0)); k.lineTo(...P(x1, z1)); k.stroke(); k.restore();
  }
  function circle(x, z, r, { stroke = INK, width = MINOR, fill = null } = {}) {
    k.save(); k.beginPath(); const [px, py] = P(x, z); k.arc(px, py, r * S, 0, Math.PI * 2);
    if (fill) { k.fillStyle = fill; k.fill(); }
    if (stroke) { k.strokeStyle = stroke; k.lineWidth = lw(width); k.stroke(); }
    k.restore();
  }
  const fontStr = (size, font, weight, italic = false) => `${italic ? 'italic ' : ''}${weight} ${size * S}px ${font}`;
  /** Width of a typeset string in world units (letter spacing included, trailing spacing excluded). */
  function measure(str, size, { font = SERIF, weight = 'bold', spacing = 0 } = {}) {
    k.save(); k.font = fontStr(size, font, weight); try { k.letterSpacing = `${spacing * size * S}px`; } catch { }
    const w = k.measureText(str).width - spacing * size * S; k.restore();
    return w / S;
  }
  /** Typeset a line. maxW squeezes horizontally (down to minSqueeze) before shrinking. */
  function text(str, x, z, size, o = {}) {
    const { color: c = INK, font = SERIF, weight = 'bold', rot = 0, spacing = 0, stroke = null, strokeW = 0.04, maxW = null, italic = false, minSqueeze = 0.82, alpha = 1 } = o;
    k.save(); k.globalAlpha = alpha;
    const [px, py] = P(x, z);
    k.translate(px, py); k.rotate(rot);
    let fs = size * S;
    const setFont = () => { k.font = `${italic ? 'italic ' : ''}${weight} ${fs}px ${font}`; try { k.letterSpacing = `${spacing * fs}px`; } catch { /* older */ } };
    setFont();
    let sx = o.squeeze ?? 1;
    if (maxW) {
      const w = k.measureText(str).width - spacing * fs; // trailing spacing
      const lim = maxW * S;
      if (w > lim) { sx = Math.max(minSqueeze, lim / w); if (w * sx > lim) { fs *= lim / (w * sx); setFont(); } }
    }
    k.scale(sx, 1);
    k.textAlign = 'center'; k.textBaseline = 'middle';
    const dx = (spacing * fs) / 2; // re-centre after trailing letter spacing
    if (stroke) { k.strokeStyle = stroke; k.lineWidth = lw(strokeW) / sx; k.lineJoin = 'round'; k.strokeText(str, dx, fs * 0.03); }
    k.fillStyle = c; k.fillText(str, dx, fs * 0.03);
    k.restore();
  }
  /** Ink (glyph bounding box) width and the offset from advance-centre to ink-centre, world units. */
  function inkBox(str, size, { font = SERIF, weight = 'bold', spacing = 0 } = {}) {
    k.save(); k.font = `${weight} ${size * S}px ${font}`; try { k.letterSpacing = `${spacing * size * S}px`; } catch { }
    k.textAlign = 'center'; k.textBaseline = 'middle'; const m = k.measureText(str); k.restore();
    const tr = spacing * size * S; // trailing letter spacing is not ink
    const l = (m.actualBoundingBoxLeft ?? m.width / 2) - tr / 2, r = (m.actualBoundingBoxRight ?? m.width / 2) + tr / 2; // relative to text()'s re-centred anchor
    const a = m.actualBoundingBoxAscent ?? size * S * 0.35, d = m.actualBoundingBoxDescent ?? size * S * 0.35;
    // h: ink height; cy: ink centre relative to text()'s anchor (text() draws 0.03 em below 'middle')
    return { w: (l + r) / S, off: (r - l) / 2 / S, h: (a + d) / S, cy: ((d - a) / 2 + size * S * 0.03) / S };
  }
  /** Text running around a circle (centred on angle a, 0 = toward the dealer, reading clockwise). */
  function arcText(str, x, z, r, a, size, o = {}) {
    const { color: c = INK, font = COND, weight = 'bold', spacing = 0.08 } = o;
    k.save(); const [px, py] = P(x, z); k.translate(px, py);
    const fs = size * S; k.font = `${weight} ${fs}px ${font}`; try { k.letterSpacing = '0px'; } catch { }
    k.fillStyle = c; k.textAlign = 'center'; k.textBaseline = 'middle';
    const widths = [...str].map((ch) => k.measureText(ch).width + spacing * fs);
    const total = widths.reduce((s, w) => s + w, 0) - spacing * fs;
    let ang = a - total / (r * S) / 2;
    [...str].forEach((ch, i) => {
      const da = widths[i] / (r * S);
      const t = ang + (da - spacing * fs / (r * S)) / 2;
      k.save(); k.rotate(t); k.translate(0, -r * S); k.fillText(ch, 0, 0); k.restore();
      ang += da;
    });
    k.restore();
  }
  const PIPS = { 1: [[0, 0]], 2: [[-1, -1], [1, 1]], 3: [[-1, -1], [0, 0], [1, 1]], 4: [[-1, -1], [1, -1], [-1, 1], [1, 1]], 5: [[-1, -1], [1, -1], [0, 0], [-1, 1], [1, 1]], 6: [[-1, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [1, 1]] };
  /** Printed die icon: red casino die with white pips and a cream keyline. */
  // Pips are big (r = 0.25h) and sit well inside the face so a 2 keeps both pips down to the last mips.
  function die(x, z, s, v, rot = 0) {
    const g = dk;
    g.save(); const [px, py] = P(x, z); g.translate(px, py); g.rotate(rot);
    const h = (s * S) / 2, r = h * 0.24;
    const gr = g.createLinearGradient(-h, -h, h, h); gr.addColorStop(0, '#860a12'); gr.addColorStop(1, '#5a060b');
    g.fillStyle = gr; roundRect(g, -h, -h, h * 2, h * 2, r); g.fill();
    g.strokeStyle = INK; g.lineWidth = Math.max(1, h * 0.1); g.stroke();
    g.fillStyle = '#d8d2c2';
    const sp = v === 6 ? 0.56 : 0.5; // 6 needs its rows a little further apart
    for (const [a, b] of PIPS[v]) { g.beginPath(); g.arc(a * h * sp, b * h * (v === 6 ? 0.6 : sp), h * (v === 6 ? 0.21 : 0.25), 0, Math.PI * 2); g.fill(); }
    g.restore();
  }
  function dicePair(x, z, s, a, b, gap = 0.1, rot = 0) {
    const off = s / 2 + gap / 2, c = Math.cos(rot), sn = Math.sin(rot);
    die(x - off * c, z - off * sn, s, a, rot - 0.06); die(x + off * c, z + off * sn, s, b, rot + 0.07);
  }

  // ---------- zone outlines (everything except the odds strip) ----------
  for (const zn of ZONES) {
    if (zn.key === 'passOdds') continue;
    const minor = zn.key === 'lay' || zn.key === 'buy';
    poly(zn.poly, { width: minor ? MINOR : MAJOR });
  }

  // ================= each end of the table =================
  for (const side of [-1, 1]) {
    const mx = (x) => (side < 0 ? x : -x);
    const vr = side < 0 ? -Math.PI / 2 : Math.PI / 2; // vertical text reads outward from the end rail
    const { CZ } = L;

    // --- Pass Line ---
    const plz = (L.ZPL + L.ZB) / 2;
    text('PASS LINE', mx(-9.0), plz + 0.02, 0.86, { spacing: 0.16, maxW: 8 });
    text('PASS LINE', mx((L.X0 + L.X1) / 2), (L.ZN + CZ) / 2, 0.84, { spacing: 0.16, rot: vr, maxW: 6 });

    // --- Don't Pass Bar ---
    const dpz = (L.ZDP + L.ZPL) / 2;
    text("DON'T PASS BAR", mx(-9.75), dpz + 0.02, 0.54, { spacing: 0.12, maxW: 6 });
    dicePair(mx(-5.85), dpz, 0.5, 6, 6, 0.1);
    const dpvx = mx((L.X1 + L.X2) / 2), dpvz = (L.ZN + CZ) / 2 - side * 0.35;
    text("DON'T PASS BAR", dpvx, dpvz, 0.5, { spacing: 0.1, rot: vr, maxW: 4.1 });
    dicePair(dpvx, dpvz + side * 3.0, 0.44, 6, 6, 0.08, vr);

    // --- Don't Come Bar (corner box; OFF puck rests in its upper half) ---
    {
      // upper half: a printed puck-rest ring (the OFF puck sits here, clear of all type);
      // lower half: DON'T COME on one line, then the 6-6 bar dice stacked under it, all with real padding
      const dcx = mx((L.X0 + L.X2) / 2);
      const boxW = L.X2 - L.X0, inner = boxW - 0.34;
      const ps = PUCK_OFF;
      // only a faint single puck-rest circle (no printed "OFF": real layouts don't carry one)
      circle(dcx, ps.z, 0.74, { stroke: 'rgba(174,141,72,0.35)', width: 0.018 });
      // DON'T COME / BAR stacked, then the 6-6 bar dice under BAR at 2x their old size
      text("DON'T", dcx, L.ZN - 1.42, 0.36, { spacing: 0.06, maxW: inner });
      text('COME BAR', dcx, L.ZN - 1.04, 0.36, { spacing: 0.02, maxW: inner, minSqueeze: 0.72 });
      dicePair(dcx, L.ZN - 0.45, 0.56, 6, 6, 0.12);
    }

    // --- Place / point number boxes: one Didone family, one cap height for all six ---
    // Common cap height: the size at which the condensed cut of NINE fits the box with at most a 6%
    // squeeze; every label (4 5 SIX 8 NINE 10) is set at that one size so they read as one family.
    const labelOf = (n) => (n === 6 ? 'SIX' : n === 9 ? 'NINE' : String(n));
    // All six labels share the condensed Didone cut (digits included) so stroke weight and optical width
    // match; NINE keeps >= 11% clear margin each side.
    // Every label is set in the real condensed cut (Bodoni MT Condensed Bold) at ONE size: the size at which
    // NINE fills 86% of the box. No horizontal scaling anywhere, so stems and serifs match across all six.
    // One cap height for all six, set by the box height (ink fills the clear band between the BUY rule and
    // the ON puck's rim), not by NINE's width. Digits are set at natural width; SIX / NINE get tight tracking
    // and only the horizontal condense needed to keep a 5% margin each side.
    const numFit = L.NUM_W * 0.9, CAP_INK = 0.9;
    const capSize = CAP_INK / inkBox('8', 1, { font: DIDONE_COND }).h;
    if (/[?&]debug/.test(globalThis.location?.search || '')) console.log('[felt] numeral capSize', capSize.toFixed(3));
    POINT_NUMBERS.forEach((n, i) => {
      const cx = mx(L.X2 + (i + 0.5) * L.NUM_W);
      const label = labelOf(n);
      const sp = label.length > 2 ? -0.02 : 0;
      const ib = inkBox(label, capSize, { font: DIDONE_COND, spacing: sp });
      const sx = Math.min(1, numFit / ib.w);
      // ink centred on NUMERAL_Z: the ON puck (over the LAY strip) never covers it
      text(label, cx - ib.off * sx, NUMERAL_Z - ib.cy, capSize, { font: DIDONE_COND, stroke: INK, strokeW: 0.02, spacing: sp, squeeze: sx });
      text('BUY', cx, L.ZN - L.BUY_D / 2, 0.4, { font: DIDONE_COND, spacing: 0.3, alpha: 0.92 });
      text('LAY', cx, L.ZT + L.LAY_D / 2, 0.4, { font: DIDONE_COND, spacing: 0.3, alpha: 0.92 });
    });

    // --- Come ---
    const comeX = mx((L.X2 + L.XC) / 2), comeZ = (L.ZN + L.ZF) / 2;
    text('COME', comeX, comeZ + 0.04, 2.25, { color: RED, font: SERIF, spacing: 0.1, stroke: INK, strokeW: 0.07, maxW: 8.6 });

    // --- Field: fixed optical spacing — every glyph/circle edge sits the same distance from its dot ---
    {
      // optical kerning: every gap is measured between INK edges (glyph bounding boxes, circle outer edges),
      // so 3·4·9 and 10·11 get identical visual gaps; the circles get an extra clear ring around them
      const fx0 = L.XB + 0.45, fx1 = L.XC - 0.45, fz = L.ZF + 1.2;
      const nums = ['2', '3', '4', '9', '10', '11', '12'];
      const CR = 0.5, NS = 0.7, DOT = 0.1, CPAD = 0.09;
      const special = (s) => s === '2' || s === '12';
      const boxes = nums.map((s) => (special(s) ? { w: CR * 2 + 0.05 + CPAD * 2, off: 0 } : inkBox(s, NS)));
      const span = fx1 - fx0, sumW = boxes.reduce((a, b) => a + b.w, 0);
      const g = Math.max(0.1, Math.min(0.2, (span - sumW - DOT * 6) / 12));
      const totalW = sumW + 6 * (DOT + 2 * g);
      let x = (side < 0 ? (fx0 + fx1) / 2 : -(fx0 + fx1) / 2) - totalW / 2;
      nums.forEach((s, i) => {
        const xr = x + boxes[i].w / 2;
        if (special(s)) {
          circle(xr, fz, CR, { stroke: YEL, width: 0.05 });
          arcText(s === '2' ? 'DOUBLE' : 'TRIPLE', xr, fz, CR + 0.21, 0, 0.36, { color: YEL, spacing: 0.06 });
          const ib = inkBox(s, 0.66);
          text(s, xr - ib.off, fz + 0.02, 0.66, { color: YEL, font: SERIF });
        } else text(s, xr - boxes[i].off, fz + 0.02, NS, { color: YEL, font: SERIF });
        x += boxes[i].w;
        if (i < nums.length - 1) { circle(x + g + DOT / 2, fz + 0.02, DOT / 2, { stroke: null, fill: YEL }); x += DOT + 2 * g; }
      });
      text('FIELD', mx((L.XB + L.XC) / 2), L.ZF + 2.24, 1.0, { color: YEL, font: SERIF, spacing: 0.34 });
    }

    // --- Big 6 / 8 ---
    const b6 = [mx(-13.68), 1.82], b8 = [mx(-12.92), 3.05];
    const tilt = side < 0 ? -0.56 : 0.56;
    text('6', b6[0], b6[1], 1.18, { color: RED, font: SERIF, stroke: INK, strokeW: 0.055, rot: tilt });
    text('8', b8[0], b8[1], 1.18, { color: RED, font: SERIF, stroke: INK, strokeW: 0.055, rot: tilt });
  }

  // ================= centre propositions =================
  // double gold keyline frame around the stickman's box
  const fr = (d) => [[C.XE0 - d, C.ZTOP - d], [-C.XE0 + d, C.ZTOP - d], [-C.XE0 + d, C.ZANY + d], [C.XE0 - d, C.ZANY + d]];
  poly(fr(0.06), { stroke: GOLD, width: 0.05 });
  poly(fr(0.17), { stroke: GOLD, width: 0.025 });

  const s7z = (C.ZTOP + C.Z7) / 2 - 0.04;
  text('ANY SEVEN', 0, s7z, 0.68, { color: RED, font: SERIF, spacing: 0.16, stroke: INK, strokeW: 0.04, maxW: 4.4 });
  text('4 TO 1', C.XE0 + 0.78, s7z, 0.5, { font: COND, spacing: 0.06 });
  text('4 TO 1', -C.XE0 - 0.78, s7z, 0.5, { font: COND, spacing: 0.06 });

  // big die icons (0.84 = 1.55x the old 0.54) on the inner side of each box, the payout beside them on the
  // outer side, where the bet's chip lands (chipSpot) so the dice always stay visible
  // one payout size for every box: the widest string (30 TO 1) fits the 1.1 space beside the dice
  const paySize = Math.min(0.56, 1.1 / measure('30 TO 1', 1, { font: COND, spacing: 0.04 }));
  const box = (x0, z0, x1, z1, a, b, pays) => {
    const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2, out = cx < 0 ? -1 : 1;
    dicePair(cx - out * 0.56, cz, 0.84, a, b, 0.12);
    text(pays, cx + out * 1.035, cz + 0.02, paySize, { font: COND, spacing: 0.04 });
  };
  box(C.X0, C.Z7, 0, C.ZH1, 3, 3, '9 TO 1'); box(0, C.Z7, C.X1, C.ZH1, 5, 5, '7 TO 1');
  box(C.X0, C.ZH1, 0, C.ZH2, 4, 4, '9 TO 1'); box(0, C.ZH1, C.X1, C.ZH2, 2, 2, '7 TO 1');
  box(C.X0, C.ZH2, 0, C.ZR1, 1, 1, '30 TO 1'); box(0, C.ZH2, C.X1, C.ZR1, 6, 6, '30 TO 1');
  box(C.X0, C.ZR1, 0, C.ZR2, 1, 2, '15 TO 1'); box(0, C.ZR1, C.X1, C.ZR2, 5, 6, '15 TO 1');
  // section captions sit on the dividing rules, in a knock-out gap cut out of the line
  const caption = (str, z) => {
    const size = 0.42, sp = 0.16;
    const w = measure(str, size, { font: COND, spacing: sp }) + 0.4;
    k.save(); k.globalCompositeOperation = 'destination-out'; const [a, b] = P(-w / 2, z - 0.24); k.fillRect(a, b, w * S, 0.48 * S); k.restore();
    text(str, 0, z, size, { font: COND, spacing: sp, color: GOLD });
  };
  caption('HARDWAYS', C.Z7); caption('ONE ROLL', C.ZH2);
  const hz = (C.ZR2 + C.ZHORN) / 2;
  text('HORN', -1.6, hz, 0.56, { color: YEL, font: SERIF, spacing: 0.22 });
  text('2 · 3 · 11 · 12', 1.5, hz, 0.44, { font: SERIF, spacing: 0.03, maxW: 3.0 });
  const acz = (C.ZHORN + C.ZANY) / 2;
  text('ANY CRAPS', 0, acz, 0.56, { color: RED, font: SERIF, spacing: 0.12, stroke: INK, strokeW: 0.035, maxW: 3.6 });
  text('7 TO 1', C.X0 + 0.6, acz, 0.5, { font: COND, spacing: 0.04, maxW: 1.0 });
  text('7 TO 1', C.X1 - 0.6, acz, 0.5, { font: COND, spacing: 0.04, maxW: 1.0 });
  // C & E circles
  for (const sx of [-1, 1]) {
    const cx = sx * -(C.XE0 + C.X0) / 2;
    const n = 8, stepz = (C.ZANY - C.Z7) / n;
    for (let i = 0; i < n; i++) {
      const cz = C.Z7 + stepz * (i + 0.5);
      const isC = i % 2 === 0;
      circle(cx, cz, 0.3, { stroke: INK, width: 0.04, fill: isC ? RED_DEEP : 'rgba(0,0,0,0)' });
      text(isC ? 'C' : 'E', cx, cz + 0.01, 0.36, { color: isC ? INK : YEL, font: SERIF });
    }
  }

  // ================= house branding (stickman side) & limits (boxman side) =================
  const ez = (C.ZANY + FELT.hd) / 2 + 0.02;
  {
    // laurel-framed crest
    const crestR = 0.62, crz = ez - 0.08;
    circle(0, crz, crestR, { stroke: GOLD, width: 0.04 });
    circle(0, crz, crestR - 0.1, { stroke: GOLD, width: 0.018 });
    text('A', 0, crz + 0.02, 0.78, { color: GOLD, font: DIDONE, weight: 'normal' });
    for (const sx of [-1, 1]) {
      for (let i = 0; i < 7; i++) {
        const a = (sx < 0 ? Math.PI : 0) + sx * (-0.95 + i * 0.3);
        const lx = Math.cos(a) * (crestR + 0.2), lz = crz + Math.sin(a) * (crestR + 0.2) * -1;
        k.save(); const [px, py] = P(lx, lz); k.translate(px, py); k.rotate(-a + (sx < 0 ? -0.6 : 0.6) + Math.PI / 2);
        k.fillStyle = GOLD; k.beginPath(); k.ellipse(0, 0, 0.055 * S, 0.14 * S, 0, 0, Math.PI * 2); k.fill(); k.restore();
      }
    }
    // wordmarks: right/left edges held a fixed clearance from the laurel (outer leaf tip ≈ 0.98)
    const clear = 1.3, wordW = 2.3;
    text('AURELIA', -(clear + wordW / 2), crz - 0.02, 0.54, { color: GOLD, font: DIDONE, weight: 'normal', spacing: 0.2, maxW: wordW });
    text('CASINO', clear + wordW / 2, crz - 0.02, 0.54, { color: GOLD, font: DIDONE, weight: 'normal', spacing: 0.2, maxW: wordW });
    line(-(clear + wordW + 0.05), crz + 0.48, -(clear - 0.05), crz + 0.48, { color: GOLD, width: 0.02 });
    line(clear - 0.05, crz + 0.48, clear + wordW + 0.05, crz + 0.48, { color: GOLD, width: 0.02 });
    text('EST. 1931', -(clear + wordW / 2), crz + 0.82, 0.4, { color: GOLD, font: COND, spacing: 0.3, maxW: wordW });
    text('LAS VEGAS', clear + wordW / 2, crz + 0.82, 0.4, { color: GOLD, font: COND, spacing: 0.3, maxW: wordW });
    diamond(k, P(-(clear + wordW + 0.2), crz + 0.48), 0.07 * S, GOLD); diamond(k, P(clear + wordW + 0.2, crz + 0.48), 0.07 * S, GOLD);
  }
  const lz = (C.ZTOP - FELT.hd) / 2 + 0.14;
  // (table limits live in the HUD; the old 5-px min/max microtype line read as noise)

  // ---------- ink wear: low-frequency, like a cloth that has seen a few thousand shifts ----------
  // Soft blotches (5-40 cm) where forearms and chips have rubbed the print thin, brushed slightly along the
  // nap; no per-pixel speckle (that read as JPEG noise). Never touches the die icons (separate layer).
  {
    const WW = Math.round(W / 8), WH = Math.round(H / 8), WS = WW / FELT.w;
    const wc = document.createElement('canvas'); wc.width = WW; wc.height = WH; const w = wc.getContext('2d');
    w.filter = `blur(${Math.max(1, Math.round(WS * 0.18))}px)`;
    for (let i = 0; i < 420; i++) {
      const x = rng() * WW, y = rng() * WH, r = WS * (0.05 + rng() * 0.35);
      w.fillStyle = `rgba(0,0,0,${0.05 + rng() * 0.12})`;
      w.beginPath(); w.ellipse(x, y, r * (1.6 + rng()), r, (rng() - 0.5) * 0.5, 0, Math.PI * 2); w.fill();
    }
    w.filter = 'none';
    k.save(); k.globalCompositeOperation = 'destination-out'; k.imageSmoothingQuality = 'high'; k.drawImage(wc, 0, 0, W, H); k.restore();
  }
  k.drawImage(dc, 0, 0); // clean die icons on top of the worn print
  // composite ink onto the cloth: a faint bleed halo (computed at half res) then the crisp print, no blur
  {
    const hc = document.createElement('canvas'); hc.width = Math.round(W / 2); hc.height = Math.round(H / 2); const h = hc.getContext('2d');
    h.filter = `blur(${Math.max(1, S * 0.012)}px)`; h.drawImage(ic, 0, 0, hc.width, hc.height);
    ctx.save(); ctx.globalAlpha = 0.14; ctx.drawImage(hc, 0, 0, W, H); ctx.restore();
  }
  ctx.save(); ctx.globalAlpha = 0.95; ctx.drawImage(ic, 0, 0); ctx.restore();
  dc.width = dc.height = 1; // free the icon layer

  // ================= baked ambient occlusion where the cloth meets the tub walls (multiply) =================
  {
    const AW = Math.round(W / 4), AH = Math.round(H / 4), AS = AW / FELT.w;
    const ac = document.createElement('canvas'); ac.width = AW; ac.height = AH; const a = ac.getContext('2d');
    a.fillStyle = '#fff'; a.fillRect(0, 0, AW, AH);
    const edge = () => feltOutline(a, AS);
    a.filter = `blur(${Math.max(1, Math.round(AS * 0.6))}px)`; a.strokeStyle = 'rgba(30,48,40,0.6)'; a.lineWidth = AS * 1.2; edge(); a.stroke();
    a.filter = `blur(${Math.max(1, Math.round(AS * 0.12))}px)`; a.strokeStyle = 'rgba(8,12,10,0.92)'; a.lineWidth = AS * 0.3; edge(); a.stroke();
    ctx.save(); ctx.globalCompositeOperation = 'multiply'; ctx.drawImage(ac, 0, 0, W, H); ctx.restore();
  }

  const map = new THREE.CanvasTexture(cv);
  map.colorSpace = THREE.SRGBColorSpace;
  map.anisotropy = renderer ? Math.min(16, renderer.capabilities.getMaxAnisotropy()) : 8;
  map.generateMipmaps = true;
  map.minFilter = THREE.LinearMipmapLinearFilter;
  return { map, canvas: cv };
}

/** Tileable felt fibre noise (for bumpMap). */
export function createFeltFiberTexture(size = 256) {
  const cv = document.createElement('canvas'); cv.width = cv.height = size;
  const ctx = cv.getContext('2d');
  const img = ctx.createImageData(size, size);
  const rnd = mulberry(1337);
  const base = new Float32Array(size * size);
  for (let i = 0; i < base.length; i++) base[i] = rnd();
  // short tangled fibres
  for (let n = 0; n < size * 9; n++) {
    const x = Math.floor(rnd() * size), y = Math.floor(rnd() * size), len = 3 + rnd() * 8, a = rnd() * Math.PI, v = 0.45 + rnd() * 0.55;
    for (let t = 0; t < len; t++) { const xx = (x + Math.round(Math.cos(a) * t) + size) % size, yy = (y + Math.round(Math.sin(a) * t) + size) % size; base[yy * size + xx] = base[yy * size + xx] * 0.35 + v * 0.65; }
  }
  // 1-px box blur (wrap) so the bump reads as soft wool, not sandpaper
  const out = new Float32Array(base.length);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let s = 0; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) s += base[((y + dy + size) % size) * size + ((x + dx + size) % size)] * (dx || dy ? 1 : 2);
    out[y * size + x] = s / 10;
  }
  for (let i = 0; i < out.length; i++) { const v = Math.max(0, Math.min(255, Math.floor(40 + out[i] * 215))); img.data[i * 4] = v; img.data[i * 4 + 1] = v; img.data[i * 4 + 2] = v; img.data[i * 4 + 3] = 255; }
  ctx.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(cv);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.NoColorSpace;
  return t;
}

/** Tileable wool detail (albedo modulation, ~0.5 mean): curly overlapping fibres + nap clumps. */
export function createFeltDetailTexture(size = 512) {
  const cv = document.createElement('canvas'); cv.width = cv.height = size; const c = cv.getContext('2d');
  const rnd = mulberry(4242);
  c.fillStyle = 'rgb(128,128,128)'; c.fillRect(0, 0, size, size);
  // clumps (soft blobs)
  for (let i = 0; i < 260; i++) {
    const x = rnd() * size, y = rnd() * size, r = 6 + rnd() * 22, v = rnd() < 0.5 ? 0 : 255;
    for (const [ox, oy] of [[0, 0], [size, 0], [-size, 0], [0, size], [0, -size]]) {
      const g = c.createRadialGradient(x + ox, y + oy, 0, x + ox, y + oy, r);
      g.addColorStop(0, `rgba(${v},${v},${v},0.08)`); g.addColorStop(1, `rgba(${v},${v},${v},0)`);
      c.fillStyle = g; c.fillRect(x + ox - r, y + oy - r, r * 2, r * 2);
    }
  }
  // curly fibres
  c.lineCap = 'round';
  for (let i = 0; i < 5200; i++) {
    let x = rnd() * size, y = rnd() * size, a = rnd() * Math.PI * 2;
    const light = rnd() < 0.5, len = 5 + rnd() * 14;
    c.strokeStyle = light ? `rgba(255,255,255,${0.1 + rnd() * 0.16})` : `rgba(0,0,0,${0.1 + rnd() * 0.18})`;
    c.lineWidth = 0.6 + rnd() * 0.9;
    for (const [ox, oy] of [[0, 0], [size, 0], [-size, 0], [0, size], [0, -size]]) {
      let px = x + ox, py = y + oy, pa = a;
      c.beginPath(); c.moveTo(px, py);
      for (let s = 0; s < len; s += 2) { pa += (rnd() - 0.5) * 0.8; px += Math.cos(pa) * 2; py += Math.sin(pa) * 2; c.lineTo(px, py); }
      c.stroke();
    }
  }
  const t = new THREE.CanvasTexture(cv);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.NoColorSpace; t.anisotropy = 8;
  return t;
}

// ---------- utils ----------
function mulberry(a) { return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function roundRect(ctx, x, y, w, h, r) { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }
function diamond(ctx, [x, y], r, c) { ctx.save(); ctx.fillStyle = c; ctx.beginPath(); ctx.moveTo(x, y - r); ctx.lineTo(x + r, y); ctx.lineTo(x, y + r); ctx.lineTo(x - r, y); ctx.closePath(); ctx.fill(); ctx.restore(); }
function shade(hex, f) {
  const n = parseInt(hex.slice(1), 16);
  const r = Math.min(255, Math.round(((n >> 16) & 255) * f)), g = Math.min(255, Math.round(((n >> 8) & 255) * f)), b = Math.min(255, Math.round((n & 255) * f));
  return `rgb(${r},${g},${b})`;
}
/** Transparent tile of light/dark single-pixel speckle, composited as a pattern (cheap at 8K). */
function makeNoiseTile(n, amp) {
  const t = document.createElement('canvas'); t.width = t.height = n; const c = t.getContext('2d');
  const img = c.createImageData(n, n); const d = img.data;
  let s = 987654321;
  for (let i = 0; i < d.length; i += 4) {
    s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
    const r = (s >>> 0) / 4294967296;
    const v = r < 0.5 ? 0 : 255;
    d[i] = d[i + 1] = d[i + 2] = v; d[i + 3] = Math.floor(Math.abs(r - 0.5) * 2 * amp * 2);
  }
  c.putImageData(img, 0, 0);
  return t;
}
