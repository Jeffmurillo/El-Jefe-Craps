// bets.js — bet zone definitions on the felt (world units, felt plane y=0), hit-testing,
// chip spots, puck spots and hover highlight. Shared by table (drawing) and chips (placement).
// Coordinates: x along table length (-17..17), z across (-6.5 = dealer/boxman side, +6.5 = player side).
import * as THREE from 'three';

// The cloth is a little larger than the printed layout (L/C grids below): a real layout keeps a band of
// bare felt between its outer rule and the rail (~0.55 behind the LAY strip, ~0.75 at the ends, ~0.9 below PASS LINE).
// Racetrack tub: the player-side (z > 0) ends sweep round on a big 3.6 radius concentric with the printed
// PASS LINE curve; the dealer-side corners (cornerR) stay tighter so the Don't Come boxes keep their corner.
export const FELT = { w: 34.6, d: 13.5, hw: 17.3, hd: 6.75, cornerR: 1.6, cornerRNear: 3.6 };
/** Corner radius of the felt outline at the corner on the z side of the table. */
export const cornerRadius = (z) => (z > 0 ? FELT.cornerRNear : FELT.cornerR);
/** Trace the felt outline into a 2D canvas whose origin is the felt's (-hw,-hd) corner, s px per unit. */
export function feltOutline(ctx, s) {
  const w = FELT.w * s, h = FELT.d * s, rf = FELT.cornerR * s, rn = FELT.cornerRNear * s;
  ctx.beginPath(); ctx.moveTo(rf, 0);
  ctx.arcTo(w, 0, w, h, rf); ctx.arcTo(w, h, 0, h, rn); ctx.arcTo(0, h, 0, 0, rn); ctx.arcTo(0, 0, w, 0, rf);
  ctx.closePath();
}
export const POINT_NUMBERS = [4, 5, 6, 8, 9, 10];

// Left-half layout grid (mirrored for the right half).
export const L = {
  X0: -16.55, X1: -15.45, X2: -14.6, XB: -12.35, XC: -4.2,
  // ZN pushed 0.25 toward the player: the number boxes are deep enough for the ON puck above the numeral
  ZT: -6.2, ZN: -3.35, ZF: 0.9, ZDP: 3.9, ZPL: 4.75, ZB: 5.85, ZODD: 6.42,
  LAY_D: 0.46, BUY_D: 0.46, // number area 1.68 deep = the dealer puck's diameter, so the ON puck fits between the rules
  RIN: 0.9, // inner radius of the racetrack corner (Don't Pass inner edge / Big 6-8 corner)
};
L.NUM_W = (L.XC - L.X2) / 6;
/** Printed place numeral centre (z) and the ON puck's centre above it: the numeral is never covered. */
export const NUMERAL_Z = L.ZN - L.BUY_D - 0.5;
const PUCK_ON_Z = L.ZT + 0.76; // (chips owner) puck R is now 0.7: its rim stays just inside the box's top rule
/** OFF puck rest: a printed ring in the upper half of the Don't Come box, clear of the DON'T COME / BAR type. */
export const PUCK_OFF = { x: (L.X0 + L.X2) / 2, z: -5.55 };
// Concentric corner arcs: centre shared by Big 6/8, Don't Pass and Pass Line curves.
L.CX = L.X2 + L.RIN; L.CZ = L.ZDP - L.RIN;
L.R_DP = L.CX - L.X1; // don't pass outer / pass inner radius
L.R_PL = L.CX - L.X0; // pass line outer radius
// Big 6/8 split: line from (XB,ZF) through the arc centre, meeting the inner arc.
L.BIG_A = Math.atan2(L.CZ - L.ZF, L.CX - L.XB);
// Center proposition grid
export const C = { X0: -3.3, X1: 3.3, XE0: -4.08, ZTOP: -5.05, Z7: -3.95, ZH1: -2.6, ZH2: -1.25, ZR1: 0.05, ZR2: 1.35, ZHORN: 2.4, ZANY: 3.45 };

const rect = (x0, z0, x1, z1) => [[x0, z0], [x1, z0], [x1, z1], [x0, z1]];
function arcPts(cx, cz, r, a0, a1, n = 10) { const p = []; for (let i = 0; i <= n; i++) { const a = a0 + (a1 - a0) * (i / n); p.push([cx + Math.cos(a) * r, cz + Math.sin(a) * r]); } return p; }

/** Builds the zone list for the left half (side=-1) or mirrored right half (side=+1). */
function buildHalf(side) {
  const m = (poly) => (side < 0 ? poly : poly.map(([x, z]) => [-x, z]).reverse());
  const zones = [];
  const add = (key, poly, extra = {}) => zones.push({ key, poly: m(poly), side, ...extra });
  const { CX, CZ, RIN, R_DP, R_PL, BIG_A } = L;
  const H = Math.PI / 2, PI = Math.PI;
  // Pass line (racetrack L around the end, concentric curved corner)
  add('pass', [[L.X0, L.ZN], ...arcPts(CX, CZ, R_PL, PI, H, 18), [L.XC, L.ZB], [L.XC, L.ZPL], ...arcPts(CX, CZ, R_DP, H, PI, 14), [L.X1, L.ZN]]);
  // (no printed pass-odds box on authentic layouts: odds go behind the line via the ODDS button / odds mode)
  add('dontPass', [[L.X1, L.ZN], ...arcPts(CX, CZ, R_DP, PI, H, 14), [L.XC, L.ZPL], [L.XC, L.ZDP], ...arcPts(CX, CZ, RIN, H, PI, 10), [L.X2, L.ZN]]);
  // Don't Come box: reaches 0.25 above the number row and its outer corner follows the tub's corner radius,
  // so the upper half holds a full puck-rest ring and the type below gets real padding
  {
    const fcx = -(FELT.hw - FELT.cornerR), fcz = -(FELT.hd - FELT.cornerR), fr = FELT.cornerR - 0.3, zTop = L.ZT - 0.25;
    const a1 = Math.PI + Math.acos((fcx - L.X0) / fr);
    add('dontComeBar', [[L.X2, zTop], [L.X2, L.ZN], [L.X0, L.ZN], ...arcPts(fcx, fcz, fr, a1, Math.PI * 1.5, 10)]);
  }
  add('come', rect(L.X2, L.ZN, L.XC, L.ZF));
  add('field', rect(L.XB, L.ZF, L.XC, L.ZDP));
  const big = (a0, a1) => arcPts(CX, CZ, RIN, a0, a1, 8);
  add('big6', [[L.X2, L.ZF], [L.XB, L.ZF], ...big(BIG_A, PI)]);
  add('big8', [[L.XB, L.ZF], [L.XB, L.ZDP], ...big(H, BIG_A)]);
  POINT_NUMBERS.forEach((n, i) => {
    const x0 = L.X2 + i * L.NUM_W, x1 = x0 + L.NUM_W;
    add('lay', rect(x0, L.ZT, x1, L.ZT + L.LAY_D), { n });
    add('number', rect(x0, L.ZT + L.LAY_D, x1, L.ZN - L.BUY_D), { n });
    add('buy', rect(x0, L.ZN - L.BUY_D, x1, L.ZN), { n });
  });
  return zones;
}

function buildCenter() {
  const z = [];
  const add = (key, poly, extra = {}) => z.push({ key, poly, side: 0, ...extra });
  add('any7', rect(C.XE0, C.ZTOP, -C.XE0, C.Z7));
  add('hard6', rect(C.X0, C.Z7, 0, C.ZH1)); add('hard10', rect(0, C.Z7, C.X1, C.ZH1));
  add('hard8', rect(C.X0, C.ZH1, 0, C.ZH2)); add('hard4', rect(0, C.ZH1, C.X1, C.ZH2));
  add('two', rect(C.X0, C.ZH2, 0, C.ZR1)); add('twelve', rect(0, C.ZH2, C.X1, C.ZR1));
  add('three', rect(C.X0, C.ZR1, 0, C.ZR2)); add('eleven', rect(0, C.ZR1, C.X1, C.ZR2));
  add('horn', rect(C.X0, C.ZR2, C.X1, C.ZHORN));
  add('anyCraps', rect(C.X0, C.ZHORN, C.X1, C.ZANY));
  add('ce', rect(C.XE0, C.Z7, C.X0, C.ZANY));
  add('ce', rect(C.X1, C.Z7, -C.XE0, C.ZANY), { mirror: true });
  return z;
}

export const ZONES = [...buildHalf(-1), ...buildHalf(1), ...buildCenter()];
ZONES.forEach((zn, i) => { zn.uid = i; zn.bbox = bboxOf(zn.poly); });

function bboxOf(poly) { let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity; for (const [x, z] of poly) { a = Math.min(a, x); b = Math.min(b, z); c = Math.max(c, x); d = Math.max(d, z); } return { x0: a, z0: b, x1: c, z1: d }; }
function inPoly(x, z, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i], [xj, zj] = poly[j];
    if (((zi > z) !== (zj > z)) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

/** Returns the zone under felt point (x,z), or null. */
export function hitTest(x, z) {
  for (const zn of ZONES) {
    const b = zn.bbox;
    if (x < b.x0 || x > b.x1 || z < b.z0 || z > b.z1) continue;
    if (inPoly(x, z, zn.poly)) return zn;
  }
  return null;
}

/** Map a zone to the concrete rules bet id given UI mode and game state. */
export function resolveBetId(zone, { oddsMode = false, game = null } = {}) {
  if (!zone) return null;
  const b = game ? game.bets : {};
  const P = game ? game.point : null;
  switch (zone.key) {
    case 'pass': return oddsMode && P && b.pass ? 'passOdds' : 'pass';
    case 'passOdds': return 'passOdds';
    case 'dontPass': return oddsMode && P && b.dontPass ? 'dontPassOdds' : 'dontPass';
    case 'dontComeBar': return 'dontCome';
    case 'number': {
      const n = zone.n;
      if (oddsMode) { if (b['come' + n]) return 'comeOdds' + n; if (b['dontCome' + n]) return 'dontComeOdds' + n; }
      return 'place' + n;
    }
    case 'lay': return oddsMode && b['dontCome' + zone.n] ? 'dontComeOdds' + zone.n : 'lay' + zone.n;
    case 'buy': return 'buy' + zone.n;
    default: return zone.key;
  }
}

/** Zones (all halves) that correspond to a bet id — used to highlight. */
export function zonesForKey(key, n) { return ZONES.filter((z) => z.key === key && (n == null || z.n === n)); }

const numCx = (n) => L.X2 + (POINT_NUMBERS.indexOf(n) + 0.5) * L.NUM_W;
const zMid = (a, b) => (a + b) / 2;

/** Chip spot for a bet id (player's half = left). {x, z, stackOn?: betId, dx?, dz?} */
export function chipSpot(id) {
  const m = /^(come|dontCome|comeOdds|dontComeOdds|place|buy|lay)(4|5|6|8|9|10)$/.exec(id);
  if (m) {
    const k = m[1], n = Number(m[2]), cx = numCx(n);
    const zPlace = L.ZN - L.BUY_D - 0.36;
    switch (k) {
      // place bets sit on the box's bottom edge (over the BUY strip) so the numeral stays readable; come bets ride
      // up-and-right; the puck is centred in the upper part of the box (on the number, as a dealer sets it):
      // full-size chips never collide with each other, the puck, or the neighbouring box's chips
      // (table owner) the numeral now sits low in the box with the ON puck above it: place/buy chips ride on the
      // BUY strip's lower rule, so neither the puck nor a stack ever hides the number
      case 'place': return { x: cx, z: L.ZN - 0.14 };
      case 'come': return { x: cx + 0.42, z: NUMERAL_Z - 0.2 }; // beside the numeral, below the puck's spot
      case 'comeOdds': return { x: cx + 0.42 + 0.09, z: NUMERAL_Z - 0.2 - 0.08, stackOn: 'come' + n };
      case 'buy': return { x: cx + 0.1, z: L.ZN - 0.2 };
      case 'lay': return { x: cx + 0.42, z: L.ZT + L.LAY_D / 2 + 0.02 };
      case 'dontCome': return { x: cx - 0.42, z: L.ZT + L.LAY_D / 2 + 0.02 };
      case 'dontComeOdds': return { x: cx - 0.42 + 0.09, z: L.ZT + L.LAY_D / 2 - 0.06, stackOn: 'dontCome' + n };
    }
  }
  const S = {
    // odds ride just behind and beside the line bet (kept on the felt the gameplay camera sees,
    // not tucked under the rail)
    // line bet + odds in the upper part of the PASS LINE band: the near rail lip hides the lower part from the player camera
    // x: in the clear stretch of the band between the end of the PASS LINE lettering and the centre
    // (so the chip never covers PASS LINE / DON'T PASS BAR); odds sit just behind it, toward the player
    // (chips owner) the line bet sits inside the PASS LINE strip squarely in front of the player's rail position
    // (x -10.2 is the player's spot); the free odds sit beside it in the same strip (a stack behind the line would
    // be hidden under the near rail lip from every gameplay camera)
    pass: { x: -10.0, z: L.ZPL + 0.34 },
    passOdds: { x: -8.94, z: L.ZPL + 0.38 },
    dontPass: { x: -11.2, z: zMid(L.ZDP, L.ZPL) },
    dontPassOdds: { x: -11.2 + 0.09, z: zMid(L.ZDP, L.ZPL) - 0.08, stackOn: 'dontPass' },
    come: { x: -4.74, z: 0.42 },   // right of the COME lettering, clear of its baseline
    dontCome: { x: zMid(L.X0, L.X2), z: L.ZN - 0.75 }, // below the OFF puck rest, over the printed DON'T COME
    field: { x: -7.62, z: 1.2 },  // in the clear band above the 3-4-9-10-11 row, between 9 and 10
    big6: { x: -14.05, z: 1.75 }, big8: { x: -12.9, z: 3.1 },
    any7: { x: -2.15, z: zMid(C.ZTOP, C.Z7) },
  };
  if (S[id]) return S[id];
  // Side bets with no printed box (placed from the Side Bets menu): World / Horn High ride in the
  // Horn box beside the Horn bet; hops and Fire / All-Tall-Small sit in rows on the stickman apron.
  const zh = zMid(C.ZR2, C.ZHORN);
  const SIDE = { world: -1.15, hornHigh2: 0.0, hornHigh3: 0.75, hornHigh11: 1.5, hornHigh12: 2.25 };
  if (id in SIDE) return { x: SIDE[id], z: zh };
  const hop = /^hop([1-6])([1-6])$/.exec(id);
  if (hop) {
    let i = 0; for (let a = 1; a <= 6; a++) for (let b = a; b <= 6; b++, i++) if (a === Number(hop[1]) && b === Number(hop[2])) return { x: -3.0 + (i % 7) * 1.0, z: 3.95 + Math.floor(i / 7) * 0.66 };
  }
  const BONUS = { fire: -2.4, small: -0.8, tall: 0.8, all: 2.4 };
  if (id in BONUS) return { x: BONUS[id], z: 5.95 };
  const center = ZONES.find((z) => z.key === id && z.side === 0);
  if (center) {
    const b = center.bbox;
    const wd = b.x1 - b.x0, cx = (b.x0 + b.x1) / 2;
    if (wd > 4) return { x: b.x0 + 1.0, z: (b.z0 + b.z1) / 2 };
    if (wd < 1.2) return { x: cx, z: (b.z0 + b.z1) / 2 };
    // prop boxes: the chip covers the payout text on the box's outer side, never the printed dice
    return { x: cx + Math.sign(cx) * 1.0, z: (b.z0 + b.z1) / 2 };
  }
  return { x: 0, z: 0 };
}

/** Puck position: on the point number box (player half) when ON, Don't Come bar when OFF. */
export function puckSpot(point) {
  // dealer-size puck (R 0.84, ~1.7x a chip) centred in the top half of the box, clear of the place stack below it
  // number area (between the LAY and BUY rules) is exactly the puck's diameter: centre it there so it never crosses a rule
  // (table owner) ON: over the LAY strip / top of the box, clear above the numeral (NUMERAL_Z) so the point stays readable
  if (point) return { x: numCx(point), z: PUCK_ON_Z };
  // OFF: on the printed puck-rest ring in the upper half of the Don't Come box, clear of DON'T COME / BAR
  return { x: PUCK_OFF.x, z: PUCK_OFF.z };
}

/** Hover highlight: translucent gold fill + bright outline for every zone matching the bet. */
export class ZoneHighlighter {
  constructor(scene) {
    this.group = new THREE.Group();
    this.group.name = 'zoneHighlights';
    scene.add(this.group);
    this.meshes = new Map();
    this.fillMat = new THREE.MeshBasicMaterial({ color: 0xffe08a, transparent: true, opacity: 0.16, depthWrite: false, blending: THREE.AdditiveBlending, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    this.lineMat = new THREE.LineBasicMaterial({ color: 0xffe9a8, transparent: true, opacity: 0.9, depthWrite: false });
    this.current = null;
    this.t = 0;
  }
  _meshFor(zone) {
    if (this.meshes.has(zone.uid)) return this.meshes.get(zone.uid);
    const shape = new THREE.Shape(zone.poly.map(([x, z]) => new THREE.Vector2(x, -z)));
    const g = new THREE.ShapeGeometry(shape);
    g.rotateX(-Math.PI / 2);
    const fill = new THREE.Mesh(g, this.fillMat);
    fill.position.y = 0.006;
    fill.renderOrder = 5;
    const pts = zone.poly.map(([x, z]) => new THREE.Vector3(x, 0.008, z));
    const line = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(pts), this.lineMat);
    const grp = new THREE.Group(); grp.add(fill, line); grp.visible = false;
    this.group.add(grp);
    this.meshes.set(zone.uid, grp);
    return grp;
  }
  /** zone: a zone object or null. Highlights the zone and its mirror twin. */
  set(zone) {
    const key = zone ? zone.key + ':' + (zone.n ?? '') : null;
    if (key === this.current) return;
    this.current = key;
    for (const m of this.meshes.values()) m.visible = false;
    if (!zone) return;
    for (const z of ZONES) if (z.key === zone.key && (z.n ?? null) === (zone.n ?? null)) this._meshFor(z).visible = true;
  }
  update(dt) { this.t += dt; this.fillMat.opacity = 0.13 + 0.06 * Math.sin(this.t * 5); }
}
