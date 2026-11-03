// physics.js — deterministic dice throw simulation (cannon-es). The whole throw is simulated
// up-front and recorded as keyframes, so playback is smooth, freezable and reproducible.
import * as CANNON from '../vendor/cannon-es.js';
import { FELT } from './bets.js';

export const DIE_SIZE = 0.28;
// edge radius of the visual rounded cube (dice.js); used to keep the recorded pose exactly on the felt
export const DIE_RADIUS = DIE_SIZE * 0.045;
const H = DIE_SIZE / 2;
const G = 98.1;           // units are decimetres: 9.81 m/s^2
const STEP = 1 / 240;
const REC_FPS = 60;
const WALL_INSET = 0.15;  // pyramid rubber depth (0.13) + clearance
const WALL_TOP = 2.4;     // inner wall height (table.js WALL_H)

/** Rotation-matrix columns (local x,y,z axes in world space) of quaternion [x,y,z,w]. */
function quatAxes(x, y, z, w) {
  return [
    [1 - 2 * (y * y + z * z), 2 * (x * y + w * z), 2 * (x * z - w * y)],
    [2 * (x * y - w * z), 1 - 2 * (x * x + z * z), 2 * (y * z + w * x)],
    [2 * (x * z + w * y), 2 * (y * z - w * x), 1 - 2 * (x * x + y * y)],
  ];
}
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/**
 * Exact OBB-vs-OBB separating-axis test for two cubes of half-size `h`.
 * p0/p1: [x,y,z], q0/q1: [x,y,z,w]. Returns { depth, axis } where depth is the minimum
 * translation (along unit `axis`, pointing from die 0 to die 1) that separates them; depth 0 = apart.
 */
export function obbPenetration(p0, q0, p1, q1, h = H) {
  const A = quatAxes(...q0), B = quatAxes(...q1);
  const T = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]];
  const axes = [...A, ...B];
  for (const a of A) for (const b of B) {
    const c = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    const l = Math.hypot(c[0], c[1], c[2]);
    if (l > 1e-5) axes.push([c[0] / l, c[1] / l, c[2] / l]);
  }
  let best = Infinity, bestAxis = null;
  for (const L of axes) {
    const rA = h * (Math.abs(dot3(A[0], L)) + Math.abs(dot3(A[1], L)) + Math.abs(dot3(A[2], L)));
    const rB = h * (Math.abs(dot3(B[0], L)) + Math.abs(dot3(B[1], L)) + Math.abs(dot3(B[2], L)));
    const d = dot3(T, L);
    const o = rA + rB - Math.abs(d);
    if (o <= 0) return { depth: 0, axis: null };
    if (o < best) { best = o; bestAxis = d < 0 ? [-L[0], -L[1], -L[2]] : L; }
  }
  return { depth: best, axis: bestAxis };
}

/** Clamp one die's recorded position against felt, rubber walls (uses its true rotated extent). */
function clampPose(p, q) {
  const [x, y, z, w] = q, r = DIE_RADIUS, k = H - r;
  const ex = k * (Math.abs(1 - 2 * (y * y + z * z)) + Math.abs(2 * (x * y - w * z)) + Math.abs(2 * (x * z + w * y))) + r;
  const ey = k * (Math.abs(2 * (x * y + w * z)) + Math.abs(1 - 2 * (x * x + z * z)) + Math.abs(2 * (y * z - w * x))) + r;
  const ez = k * (Math.abs(2 * (x * z - w * y)) + Math.abs(2 * (y * z + w * x)) + Math.abs(1 - 2 * (x * x + y * y))) + r;
  const lx = FELT.hw - WALL_INSET - ex, lz = FELT.hd - WALL_INSET - ez;
  p[0] = Math.max(-lx, Math.min(lx, p[0])); p[1] = Math.max(ey, p[1]); p[2] = Math.max(-lz, Math.min(lz, p[2]));
}

/**
 * Seat both dice of one recorded frame: clamp each against felt/walls, then resolve any die-vs-die
 * interpenetration (solver slop, or a clamp that pushed one die into the other) with the exact SAT
 * test, alternating until both constraints hold. Mutates and returns the flat position array.
 */
function seatPair(pos, quat) {
  const p0 = pos.slice(0, 3), p1 = pos.slice(3, 6), q0 = quat.slice(0, 4), q1 = quat.slice(4, 8);
  clampPose(p0, q0); clampPose(p1, q1);
  for (let it = 0; it < 6; it++) {
    const { depth, axis } = obbPenetration(p0, q0, p1, q1, H);
    if (!depth) break;
    // bias the push horizontally when one die is resting on the felt (it cannot move down)
    const s = depth / 2 + 0.0008;
    for (let c = 0; c < 3; c++) { p0[c] -= axis[c] * s; p1[c] += axis[c] * s; }
    clampPose(p0, q0); clampPose(p1, q1);
  }
  pos[0] = p0[0]; pos[1] = p0[1]; pos[2] = p0[2]; pos[3] = p1[0]; pos[4] = p1[1]; pos[5] = p1[2];
  return pos;
}

/** True when a die centred at (x,z) would poke through the table's rounded inner corners. */
function outsideRoundedRect(x, z) {
  const R = z > 0 ? (FELT.cornerRNear ?? FELT.cornerR) : FELT.cornerR, ax = Math.abs(x) - (FELT.hw - R), az = Math.abs(z) - (FELT.hd - R); // (table owner) racetrack: bigger player-side corners
  if (ax <= 0 || az <= 0) return false;
  return Math.hypot(ax, az) > R - WALL_INSET - H * 1.2;
}

/** Local face axes, index order used by `upFace`. */
export const FACE_AXES = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];

function upAxisIndex(q) {
  let best = -1, bi = 0;
  for (let i = 0; i < 6; i++) {
    const [x, y, z] = FACE_AXES[i];
    // y-component of q * v
    const v = q.vmult(new CANNON.Vec3(x, y, z));
    if (v.y > best) { best = v.y; bi = i; }
  }
  return { index: bi, dot: best };
}

/**
 * Simulate a throw. rng: () => [0,1). Returns { frames, duration, up: [axisIdx, axisIdx], impacts, valid }.
 * frames[i] = { p: [x,y,z, x,y,z], q: [x,y,z,w, x,y,z,w] } sampled at 60 fps.
 * opts.from: start x (shooter end, default left end) — dice are thrown toward the opposite end.
 */
/**
 * Hard limits every accepted throw meets (die widths / seconds): the farther die rests within `wall` of
 * the back rubber, the pair within `spread` of each other, and the throw lasts `minDur`..`maxDur` from
 * release to rest. `tight` is the preferred, more natural subset.
 */
export const REST_LIMITS = { wall: 7, spread: 6, minDur: 1.4, maxDur: 4.2, tightWall: 4.5, tightSpread: 4.5, tightMin: 1.6, tightMax: 3.5 };
const MAX_ATTEMPTS = 160;
/** Throw tuning (exported so tests can probe it). */
export const TUNE = { vx: 34, vxR: 4, vy: 12, vyR: 4, aimZ0: -1.2, aimZR: 2.6, aimK: 0.8, dragV: 2, dragW: 0.4, dragZ: 1.5, feltMu: 0.22, feltE: 0.5, absorb: 0.45, abort: 1, spin: 12, spinR: 12, wobble: 28 };

export function simulateThrow(rng, opts = {}) {
  // Casino rule: both dice must hit the back wall. The simulator only accepts such throws; a throw
  // that misses is rejected (usually within a fraction of a second, see the early abort in runOnce)
  // and re-thrown. Every throw returned as 'tight' or 'loose' meets REST_LIMITS (both dice off the back
  // wall, near the diamonds, as a pair). 'tight' throws are taken at once; otherwise the most compact
  // 'loose' one seen is used after a few more tries. 'fallback' (no throw met the limits within
  // MAX_ATTEMPTS) is logged and measured by tests/physics.html; it is not expected in practice.
  // Note on fairness: the faces shown are chosen by the game's own RNG and mapped onto the recorded
  // tumble (DiceSet.correctionFor), so rejecting throws by where they rest cannot bias the outcome.
  let last = null, fallback = null, loose = null;
  const done = (r, n, category) => { r.attempts = n; r.category = category; simStats[category]++; return r; };
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const r = runOnce(rng, opts);
    last = r;
    if (r.valid && r.wallDice === 2) {
      if (r.tight) return done(r, attempt + 1, 'tight');
      if (r.ok && (!loose || r.spreadScore < loose.spreadScore)) loose = r;
      if (loose && attempt >= 11) return done(loose, attempt + 1, 'loose');
    }
    if (r.valid && r.wallDice >= 1 && (!fallback || r.spreadScore < fallback.spreadScore)) fallback = r;
  }
  return done(loose || fallback || last, MAX_ATTEMPTS, loose ? 'loose' : 'fallback');
}
/** Running tally of how the real game's throws were accepted (inspect `simStats` in the console). */
export const simStats = { tight: 0, loose: 0, fallback: 0 };

/**
 * Remove the last few degrees of residual tilt (a die leaning on a pip edge, solver slop) by easing
 * each die's final orientation onto the exact face-up rotation over its final 12 frames, then re-seat.
 * The die is already calm by then, so this is a sub-degree correction that reads as "settling flat".
 */
function flattenRest(frames, ups) {
  const n = Math.min(12, frames.length - 1), last = frames[frames.length - 1];
  for (let i = 0; i < 2; i++) {
    const [qx, qy, qz, qw] = last.q.slice(i * 4, i * 4 + 4);
    const q = new CANNON.Quaternion(qx, qy, qz, qw);
    const up = q.vmult(new CANNON.Vec3(...FACE_AXES[ups[i]]));
    const fix = new CANNON.Quaternion(); fix.setFromVectors(up, new CANNON.Vec3(0, 1, 0));
    for (let k = 0; k <= n; k++) {
      const f = frames[frames.length - 1 - n + k];
      const w = k / n, e = w * w * (3 - 2 * w);
      const part = new CANNON.Quaternion(0, 0, 0, 1).slerp(fix, e, new CANNON.Quaternion());
      const fq = new CANNON.Quaternion(...f.q.slice(i * 4, i * 4 + 4));
      const out = part.mult(fq); out.normalize();
      f.q[i * 4] = out.x; f.q[i * 4 + 1] = out.y; f.q[i * 4 + 2] = out.z; f.q[i * 4 + 3] = out.w;
    }
  }
  for (let k = frames.length - 1 - n; k < frames.length; k++) seatPair(frames[k].p, frames[k].q);
  // the final frame rests exactly on the cloth (no sub-millimetre hover left by solver slop)
  for (let i = 0; i < 2; i++) last.p[i * 3 + 1] = H;
  seatPair(last.p, last.q);
}

export function runOnce(rng, { power = 1, startX = -7.5, startZ = 4.4, maxTime = 7 } = {}) {
  const world = new CANNON.World({ gravity: new CANNON.Vec3(0, -G, 0) });
  world.broadphase = new CANNON.NaiveBroadphase();
  world.solver.iterations = 18;
  world.allowSleep = false;

  const mFelt = new CANNON.Material('felt'), mWall = new CANNON.Material('wall'), mDie = new CANNON.Material('die');
  world.addContactMaterial(new CANNON.ContactMaterial(mDie, mFelt, { friction: TUNE.feltMu, restitution: TUNE.feltE }));
  const cmWall = new CANNON.ContactMaterial(mDie, mWall, { friction: 0.12, restitution: 0.42 });
  world.addContactMaterial(cmWall);
  const cmDice = new CANNON.ContactMaterial(mDie, mDie, { friction: 0.1, restitution: 0.22 });
  world.addContactMaterial(cmDice);

  const ground = new CANNON.Body({ mass: 0, material: mFelt, shape: new CANNON.Plane() });
  ground.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
  world.addBody(ground);
  const walls = [];
  const addWall = (nx, nz, d) => {
    const b = new CANNON.Body({ mass: 0, material: mWall, shape: new CANNON.Plane() });
    // plane normal is local +z; rotate so it points (nx,0,nz)
    const from = new CANNON.Vec3(0, 0, 1), to = new CANNON.Vec3(nx, 0, nz);
    b.quaternion.setFromVectors(from, to);
    b.position.set(-nx * d, 0, -nz * d);
    world.addBody(b); walls.push(b); return b;
  };
  // collision planes sit at the tips of the pyramid rubber so dice never sink into the diamonds
  const endWall = addWall(-1, 0, FELT.hw - WALL_INSET); // far end (+x) facing -x
  addWall(1, 0, FELT.hw - WALL_INSET);
  addWall(0, -1, FELT.hd - WALL_INSET);
  addWall(0, 1, FELT.hd - WALL_INSET);

  const dice = [];
  const shape = new CANNON.Box(new CANNON.Vec3(H, H, H));
  // lofted arc that lands mid-table with enough pace to run both dice into the back diamonds, launched
  // straight at a chosen spot on the rubber; both dice leave the hand together so they travel as a pair
  const T = TUNE;
  const vx = (T.vx + rng() * T.vxR) * power, vy = T.vy + rng() * T.vyR;
  // the shooter aims: pick a spot on the back rubber and launch along that line (no in-flight steering)
  const aimZ = T.aimZ0 + rng() * T.aimZR, vz = (aimZ - startZ) * vx / ((FELT.hw - WALL_INSET - startX) * T.aimK);
  for (let i = 0; i < 2; i++) {
    const b = new CANNON.Body({ mass: 0.01, material: mDie, shape, linearDamping: 0.08, angularDamping: 0.18 });
    b.position.set(startX + (rng() - 0.5) * 0.06 - i * 0.34, 2.9 + i * 0.12 + rng() * 0.15, startZ - i * 0.34); // staggered in the hand: centres 0.49 apart > cube diagonal, so never a spawn overlap
    b.quaternion.setFromEuler(rng() * 6.28, rng() * 6.28, rng() * 6.28);
    // both dice leave one hand together: near-identical launch, so they travel and land as a pair
    b.velocity.set(vx + (rng() - 0.5) * 1.2, vy + (rng() - 0.5) * 0.8, vz + (rng() - 0.5) * 0.35);
    // release spin: the dice roll off the fingertips, so it carries a forward tumble (about the axis across
    // the line of flight) plus a random wobble; a forward-tumbling cube keeps its line and its pace on the felt
    const fw = -(T.spin + rng() * T.spinR), wob = T.wobble;
    b.angularVelocity.set((rng() - 0.5) * wob, (rng() - 0.5) * wob, (rng() - 0.5) * wob);
    { const ax = new CANNON.Vec3(-vz, 0, vx); ax.normalize(); b.angularVelocity.vadd(ax.scale(fw), b.angularVelocity); }
    world.addBody(b); dice.push(b);
  }

  // Diamond rubber: deflect dice randomly when they hit walls. Also record impacts for audio.
  const impacts = [];
  const touching = new Set();
  let time = 0;
  const contactKey = (a, b) => (a.id < b.id ? a.id + ':' + b.id : b.id + ':' + a.id);

  const frames = [];
  let still = 0, steps = 0, clipped = false; const hitEnd = new Set();
  const maxSteps = Math.ceil(maxTime / STEP);
  const recEvery = Math.round(1 / STEP / REC_FPS);
  // slide[k] = per recorded frame, each die's horizontal speed while it touches the felt (0 when airborne):
  // drives the audio's continuous felt scuff/roll layer between discrete impacts.
  const slide = [];
  let feltSpeed = [0, 0];
  const record = () => {
    const q = dice.flatMap((d) => [d.quaternion.x, d.quaternion.y, d.quaternion.z, d.quaternion.w]);
    frames.push({ p: seatPair(dice.flatMap((d) => [d.position.x, d.position.y, d.position.z]), q), q });
    slide.push([feltSpeed[0], feltSpeed[1]]);
  };
  record();
  // audio: closing speed along the contact normal, from the velocities *before* the step resolved it,
  // so grazing/sliding contacts are quiet and straight drops are loud.
  const preV = dice.map(() => new CANNON.Vec3()), preW = dice.map(() => new CANNON.Vec3());
  const _va = new CANNON.Vec3(), _vb = new CANNON.Vec3(), _tmp = new CANNON.Vec3();
  const pointVel = (body, r, out) => {
    const i = dice.indexOf(body);
    if (i < 0) return out.set(0, 0, 0);
    preW[i].cross(r, _tmp); return out.set(preV[i].x + _tmp.x, preV[i].y + _tmp.y, preV[i].z + _tmp.z);
  };
  const lastEmit = new Map();
  while (steps < maxSteps) {
    dice.forEach((d, i) => { preV[i].copy(d.velocity); preW[i].copy(d.angularVelocity); });
    world.step(STEP);
    steps++; time += STEP;
    const now = new Set();
    const pairs = new Map(); // key -> strongest contact equation this step
    feltSpeed = [0, 0];
    for (const c of world.contacts) {
      const a = c.bi, b = c.bj;
      const die = dice.includes(a) ? a : dice.includes(b) ? b : null;
      if (!die) continue;
      const key = contactKey(a, b);
      now.add(key);
      pointVel(a, c.ri, _va); pointVel(b, c.rj, _vb);
      const closing = Math.max(0, -((_vb.x - _va.x) * c.ni.x + (_vb.y - _va.y) * c.ni.y + (_vb.z - _va.z) * c.ni.z));
      const p = pairs.get(key);
      if (!p || closing > p.closing) pairs.set(key, { c, die, other: die === a ? b : a, closing });
    }
    for (const [key, { die, other, closing }] of pairs) {
      let type = 'felt';
      if (dice.includes(other)) type = 'dice';
      else if (walls.includes(other)) type = 'wall';
      if (type === 'felt') { const i = dice.indexOf(die); feltSpeed[i] = Math.hypot(die.velocity.x, die.velocity.z); }
      const fresh = !touching.has(key);
      // continuing contacts still emit when a tumbling/rocking die slaps a new face or edge down
      // (audio round 5: thresholds lowered so the final rocks and settle taps of a throw are emitted too;
      // `closing` is the raw closing speed in m/s, which audio.js maps to loudness itself)
      const reslap = !fresh && closing > 0.45 && time - (lastEmit.get(key) ?? -1) > 0.014;
      if ((fresh && closing > 0.35) || reslap) {
        lastEmit.set(key, time);
        impacts.push({ t: time, type, closing, strength: Math.min(1, closing / (type === 'dice' ? 20 : 30)), x: die.position.x, y: die.position.y, z: die.position.z, die: type === 'dice' ? 2 : dice.indexOf(die) });
      }
      if (!fresh) continue;
      if (type === 'wall' && die.position.y > WALL_TOP - H * 1.5) clipped = true; // would sail over the rail
      if (type === 'wall' && other === endWall) {
        hitEnd.add(die);
        // pyramid rubber randomises the rebound and soaks up most of its energy (the diamonds are soft);
        // a second hit on the rubber is softer still (the die is already spent)
        const v = die.velocity; const second = !!die.__hitOnce;
        const ang = (rng() - 0.5) * (second ? 0.16 : 0.26), absorb = second ? 0.3 : TUNE.absorb;
        die.__hitOnce = true;
        // once the pair has met the rubber it is spent: dice-on-dice and side-rail knocks go dead so the
        // pair cannot ricochet apart across the layout after the wall
        cmDice.restitution = 0.05; cmWall.restitution = 0.22;
        const c2 = Math.cos(ang), s2 = Math.sin(ang);
        die.velocity.set((v.x * c2 - v.z * s2) * absorb, v.y * 0.8 + rng() * 2.5, (v.x * s2 + v.z * c2) * absorb * 0.32);
        die.angularVelocity.set(die.angularVelocity.x * 0.6 + (rng() - 0.5) * 22, die.angularVelocity.y * 0.6 + (rng() - 0.5) * 22, die.angularVelocity.z * 0.6 + (rng() - 0.5) * 22);
      }
    }
    touching.clear(); for (const k of now) touching.add(k);
    // after the back-wall hit the die is spent: a light extra cloth drag on its horizontal run (about a
    // third of the old value) and very little spin loss, so it still takes a tumble or two off the rubber
    // and comes to rest a few die widths off the diamonds. Before the wall nothing steers the dice: the
    // shooter's aim (launch direction) and the forward release spin keep the pair on its line.
    for (const d of hitEnd) {
      const low = d.position.y < H * 1.85;
      const kv = Math.exp(-(low ? T.dragV : 0.5) * STEP), kw = Math.exp(-(low ? T.dragW : 0.6) * STEP);
      d.velocity.x *= kv; d.velocity.z *= kv * Math.exp(-(low ? T.dragZ : 0.6) * STEP);
      d.angularVelocity.scale(kw, d.angularVelocity);
    }
    if (steps % recEvery === 0) {
      record();
      for (const d of dice) if (outsideRoundedRect(d.position.x, d.position.z) || d.position.y < H * 0.8) clipped = true;
    }
    // early reject: a die rolling on the felt that can no longer reach the back wall (friction stop
    // distance v^2/(2*mu*g) short of it) makes this throw unusable, so stop simulating it now
    if (TUNE.abort && time > 0.3 && dice.some((d) => !hitEnd.has(d) && d.position.y < H + 0.06 && Math.max(0, d.velocity.x) ** 2 / (2 * 0.26 * G) < (FELT.hw - WALL_INSET - H) - d.position.x - 0.05)) {
      return { frames, slide, duration: (frames.length - 1) / REC_FPS, fps: REC_FPS, up: [2, 2], impacts, valid: false, wallDice: hitEnd.size, aborted: true };
    }
    const calm = dice.every((d) => d.velocity.length() < 0.12 && d.angularVelocity.length() < 0.25 && d.position.y < H + 0.03);
    still = calm ? still + 1 : 0;
    if (still > 0.3 / STEP) break;
  }
  record();
  const ups = dice.map((d) => upAxisIndex(d.quaternion));
  const final = dice.map((d) => d.position);
  const valid = !clipped && hitEnd.size >= 1 && ups.every((u) => u.dot > 0.996) && final.every((p) => p.y < H + 0.02 && p.x > 4.7 && Math.abs(p.z) < FELT.hd - 0.4 && p.x < FELT.hw - 0.4)
    && Math.hypot(final[0].x - final[1].x, final[0].z - final[1].z) > DIE_SIZE * 1.1;
  if (valid) flattenRest(frames, ups.map((u) => u.index));
  const backX = FELT.hw - WALL_INSET, Lm = REST_LIMITS;
  // same measures as tests/physics.html: centre spread, and the farther die's gap to the rubber tips
  const spread = Math.hypot(final[0].x - final[1].x, final[0].z - final[1].z) / DIE_SIZE;
  const wallGap = (backX - Math.min(final[0].x, final[1].x)) / DIE_SIZE - 0.5;
  const dur = (frames.length - 1) / REC_FPS;
  const ok = valid && spread < Lm.spread && wallGap < Lm.wall && dur > Lm.minDur && dur < Lm.maxDur;
  const tight = ok && spread < Lm.tightSpread && wallGap < Lm.tightWall && dur > Lm.tightMin && dur < Lm.tightMax;
  const spreadScore = spread + wallGap;
  return { frames, slide, duration: dur, fps: REC_FPS, up: ups.map((u) => u.index), impacts, valid, ok, why: clipped ? "clip" : !ups.every((u) => u.dot > 0.996) ? "cocked" : "pos", tight, spreadScore, spread, wallGap, wallDice: hitEnd.size };
}
