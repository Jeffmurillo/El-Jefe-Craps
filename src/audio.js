// audio.js - fully synthesized WebAudio sound design for the craps table.
//
// Everything is generated locally:
//  * one-shot impact samples are pre-rendered with modal synthesis (sums of damped resonances +
//    shaped noise transients) in several random variants each, so repeated hits never sound
//    machine-gunned: dice on felt + acrylic corner ticks, die-on-die clicks, dice against the pyramid
//    rubber back wall, clay chip clacks, chips on felt / on the wooden rail, the puck, a celesta bell.
//  * crowd cheer / groan and two coprime-length babble loops are rendered with chunked plain-JS
//    formant synthesis (PolyBLEP saw + breath voices with per-voice formant scaling through formant
//    band-passes, a broadband pink-noise "roar" layer, claps).
//  * a generated stereo room impulse feeds a shared convolution reverb.
// All of that renders into plain Float32Arrays in idle chunks from page load, so the first user
// gesture only builds the (cheap) node graph and copies the data into AudioBuffers.
//
// Signal chain (exactly as _buildGraph / _installLimiter wire it):
//   sfx / ui / music buses -> mix -> glue comp (-10 dB, 2:1) -> makeup trim --> post
//   dice bus (impacts, felt roll, hand rattle) -----------------------------> post   (no glue: no ducking of the bounces after the slam)
//   reverb return (incl. the ambience's wet send) --------------------------> post
//   post -> master (fixed DRIVE) -> limIn -> lookahead limiter (-1.6 dBFS) -> sum
//   ambience dry -> duck -> ambience fader (ambDry) -> ambMaster (DRIVE) ---> sum   (the bed skips the glue and the
//                                                                                    foreground limiter: no pumping)
//   ambience wet -> duck -> ambience fader (ambWet) -> reverb send -> post        (so the ambient reverb ducks + fades too)
//   sum -> final ceiling (lookahead, -1.3 dBFS; transparent unless bed + limited foreground coincide)
//       -> user fader (volume slider, dB taper, mute: AFTER the dynamics, so GR never depends on volume)
//       -> soft clip (tanh above -1.1 dBFS, 4x oversampled; never reached once the ceiling is installed)
//       -> out -> destination        (analyser / recorder taps hang off the soft clip, diagnostics only)
// Until the worklet module loads, a native DynamicsCompressor stands in for the foreground limiter and the
// final ceiling is absent (the soft clip is then the only safety on the sum).
//
// Public API (used by main.js): init(), ready, muted, volume, ambienceOn, callouts, latency, setMuted(),
// setVolume(), setAmbience(), setCallouts(), setListener(camera),
// throwDice(sim, {pickup, speed}) -> schedules rattle + whoosh + felt roll + EVERY physics impact on the audio
//   clock at throw start (sample-accurate flams, no render-frame quantisation); cancelThrow() aborts them,
// rattle(dur), throwRelease(delay), diceRoll(sim, {delay, speed}), diceHit(type, strength, delay, x, z, die),
// chips(count, delay, pos), chipsRail(count, pos), chipStack(count, delay, pos), chipsTake(count, pos),
// sweep(count, pos) / bankLand(count, pos) (dealer sweep of losing chips, driven by the chip tweens),
// puck(pos), click(), error(), win(size), lose(pos), sevenOut(), cheer(), groan(), result(res), callout(res).
// `pos` = world position {x, y, z} of the sound source; it is panned relative to the camera.
//
// Diagnostics: ?audiotest shows an on-screen badge with the real post-limiter output level (analyser),
// compressor gain reduction, render timings and a simulated throw's hit count. ?audiorec=N records N
// seconds of the post-limiter mix (MediaRecorder) and offers it as a download link. The offline render
// (?audiotest) waits for the crowd buffers and measures the full mix at the default volume AND at 1.0.

const QS = (() => { try { return location.search; } catch { return ''; } })();
const SHOT = /[?&]shot=/.test(QS);
const AUDIOTEST = /[?&]audiotest/.test(QS);
const REC_SECONDS = (() => { const m = /[?&]audiorec=?(\d*)/.exec(QS); return m ? Number(m[1]) || 30 : 0; })();
const RSR = 48000;   // one-shot render rate (the context is requested at 48 kHz; buffers resample otherwise)
const CSR = 22050;   // crowd render rate
const TAU = Math.PI * 2;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
// Every random number in this module comes from urand(). Normally that is Math.random (read live, so the
// offline test's Math.random overrides still apply); under ?audiotest the idle renders (banks, IR, pink
// noise, voices, crowd) each install their own seeded stream, so every run measures identical sounds.
const RNG_DEFAULT = () => Math.random();
let RNG = RNG_DEFAULT;
const urand = () => RNG();
const seededRng = (seed) => { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; };
const rand = (a, b) => a + urand() * (b - a);
const pick = (arr) => arr[(urand() * arr.length) | 0];
// yields to the event loop between render chunks; a render's seeded stream is parked meanwhile so code that
// runs in between (live sounds, the game) neither consumes it nor gets seeded numbers
const yieldFrame = () => { const keep = RNG; RNG = RNG_DEFAULT; return new Promise((r) => setTimeout(r, 0)).then(() => { RNG = keep; }); };
/** Run an async idle render with its own seeded stream under ?audiotest (reproducible measurements). */
async function seededRender(seed, fn) {
  if (!AUDIOTEST) return fn();
  RNG = seededRng(seed);
  try { return await fn(); } finally { RNG = RNG_DEFAULT; }
}
const dB = (x) => (x > 0 ? (20 * Math.log10(x)).toFixed(1) : '-inf');

// WebAudio DynamicsCompressor applies automatic makeup gain = (1 / gain-at-0dBFS)^0.6 (spec + Chromium).
// We undo it with a trim so the compressors only ever reduce level and quiet sounds are not lifted.
function makeupTrim(thresholdDb, ratio, kneeDb) {
  const kneeEnd = thresholdDb + kneeDb / 2;
  const outAt0 = 0 > kneeEnd ? thresholdDb + (0 - thresholdDb) / ratio : 0;
  return Math.pow(10, (outAt0 * 0.6) / 20);
}

// ---------- offline sample synthesis helpers (plain JS, fast) ----------
/**
 * Render a one-shot: modes [{f, a, d, drop?, dropT?, ph?}] are damped sines (d = 1/e decay seconds,
 * drop = relative pitch drop at t=0 that relaxes over dropT); noise {a, d, lp, hp, attack} is a shaped
 * noise transient filtered with one-pole low/high-pass. Returned data is peak-normalised to `peak`.
 */
function renderOneShot(sr, dur, modes, noise, peak = 0.9) {
  const n = Math.max(16, Math.floor(sr * dur));
  const out = new Float32Array(n);
  for (const m of modes) {
    let ph = m.ph ?? urand() * TAU;
    const k = Math.exp(-1 / (m.d * sr));
    let env = m.a;
    const atk = Math.max(1, Math.floor((m.attack || 0.0004) * sr));
    for (let i = 0; i < n; i++) {
      const f = m.drop ? m.f * (1 + m.drop * Math.exp(-(i / sr) / (m.dropT || 0.01))) : m.f;
      ph += TAU * f / sr;
      out[i] += Math.sin(ph) * env * (i < atk ? i / atk : 1);
      env *= k;
      if (env < 1e-5) break;
    }
  }
  if (noise) {
    for (const nz of Array.isArray(noise) ? noise : [noise]) {
      const k = Math.exp(-1 / (nz.d * sr));
      const aL = nz.lp ? 1 - Math.exp(-TAU * nz.lp / sr) : 1;
      const aH = nz.hp ? 1 - Math.exp(-TAU * nz.hp / sr) : 0;
      const atk = Math.max(1, Math.floor((nz.attack || 0.0003) * sr));
      let env = nz.a, lp = 0, lp2 = 0, hpS = 0;
      for (let i = 0; i < n; i++) {
        const x = urand() * 2 - 1;
        lp += aL * (x - lp); lp2 += aL * (lp - lp2); // 2-pole low-pass
        let y = nz.lp ? lp2 : x;
        if (nz.hp) { hpS += aH * (y - hpS); y -= hpS; }
        out[i] += y * env * (i < atk ? i / atk : 1);
        env *= k;
        if (env < 1e-5) break;
      }
    }
  }
  let mx = 0; for (let i = 0; i < n; i++) mx = Math.max(mx, Math.abs(out[i]));
  const g = mx > 0 ? peak / mx : 1;
  const fo = Math.min(n, Math.floor(sr * 0.004)); // tiny fade-out at the very end to avoid clicks
  for (let i = 0; i < n; i++) out[i] *= g * (i > n - fo ? (n - i) / fo : 1);
  return out;
}

/** One-shot bank definitions: [name, variants, () => Float32Array]. */
const BANKS = [
  // die (19 mm acrylic, ~8 g) landing on felt over a padded bed on a plywood deck: a dull "thock", not a
  // plastic tick. Body 240-470 Hz with 11-15 ms decays, a low padded-deck thump (110-150 Hz, ~20 ms, with a
  // pitch drop as the pad compresses), a faint plywood mode ~700 Hz and a muffled transient. Measured
  // (.review/tmp/audio_probe.html): spectral centroid ~270-290 Hz, -20 dB decay ~40 ms (was 9 ms modes).
  // The crisp acrylic corner tick is a separate bank layered on top by strength.
  ['felt', 8, () => renderOneShot(RSR, 0.13, [
    { f: rand(110, 150), a: 0.24, d: 0.026, drop: 0.25, dropT: 0.004 },
    { f: rand(240, 320), a: 0.6, d: 0.02, drop: 0.12, dropT: 0.003 },
    { f: rand(380, 470), a: 0.42, d: 0.014 },
    { f: rand(620, 780), a: 0.14, d: 0.009 },
    { f: rand(900, 1250), a: 0.16, d: 0.005 },
    { f: rand(2000, 2800), a: 0.08, d: 0.004 },
  ], [{ a: 0.65, d: 0.004, lp: rand(1500, 2300) }, { a: 0.07, d: 0.0015, hp: 3000 }])],
  // tiny felt "grain": an edge/face of a tumbling die brushing the felt (retriggered at the tumble rate)
  ['grain', 10, () => renderOneShot(RSR, 0.04, [
    { f: rand(260, 420), a: 0.35, d: 0.004 },
    { f: rand(900, 1400), a: 0.12, d: 0.003 },
  ], [{ a: 0.9, d: rand(0.004, 0.008), lp: rand(1800, 3200), attack: rand(0.0008, 0.002) }, { a: 0.18, d: 0.0015, hp: 2800 }])],
  // acrylic corner/edge tick that rides on every felt or wall hit (scaled by strength)
  ['tick', 8, () => renderOneShot(RSR, 0.03, [
    { f: rand(1600, 2300), a: 0.6, d: 0.0035 },
    { f: rand(2800, 3900), a: 0.9, d: 0.0025 },
    { f: rand(5000, 6500), a: 0.3, d: 0.0015 },
  ], { a: 0.6, d: 0.0008, hp: 1500 })],
  // die on die: hard bright acrylic click
  ['dice', 8, () => renderOneShot(RSR, 0.08, [
    { f: rand(2800, 3600), a: 0.6, d: 0.012 },
    { f: rand(4300, 5400), a: 0.8, d: 0.009 },
    { f: rand(6200, 7600), a: 0.5, d: 0.006 },
    { f: rand(8800, 10500), a: 0.3, d: 0.004 },
    { f: rand(1500, 1900), a: 0.15, d: 0.01 },
  ], { a: 0.7, d: 0.0012, hp: 2500 })],
  // die against the diamond/pyramid rubber over the wooden end wall: knocky, rubber-damped
  ['wall', 6, () => renderOneShot(RSR, 0.12, [
    { f: rand(280, 360), a: 0.6, d: 0.014, drop: 0.15, dropT: 0.004 },
    { f: rand(160, 200), a: 0.14, d: 0.016 },
    { f: rand(650, 900), a: 0.5, d: 0.011 },
    { f: rand(1300, 1700), a: 0.35, d: 0.007 },
    { f: rand(3200, 4200), a: 0.22, d: 0.004 },
  ], [{ a: 0.75, d: 0.003, lp: 3500 }, { a: 0.25, d: 0.0012, hp: 3000 }])],
  // clay composite chip clack (two near modes beat for that "clay" character)
  ['chip', 10, () => { const f = rand(2500, 3300); return renderOneShot(RSR, 0.09, [
    { f, a: 0.9, d: rand(0.012, 0.02) },
    { f: f * rand(1.03, 1.07), a: 0.6, d: rand(0.01, 0.016) },
    { f: f * rand(1.55, 1.72), a: 0.45, d: 0.008 },
    { f: f * rand(2.3, 2.6), a: 0.25, d: 0.005 },
    { f: rand(900, 1300), a: 0.2, d: 0.012 },
  ], { a: 0.55, d: 0.0015, hp: 1800 }); }],
  // chip landing on felt: soft pat + a little clack
  ['chipFelt', 4, () => renderOneShot(RSR, 0.08, [
    { f: rand(240, 320), a: 0.8, d: 0.009, drop: 0.2, dropT: 0.003 },
    { f: rand(2400, 3000), a: 0.22, d: 0.008 },
    { f: rand(1100, 1400), a: 0.15, d: 0.008 },
  ], { a: 0.7, d: 0.004, lp: 1600 })],
  // chips set into the player's wooden rail trough: darker, woody, short
  ['chipRail', 6, () => { const f = rand(2300, 3000); return renderOneShot(RSR, 0.07, [
    { f, a: 0.55, d: 0.01 },
    { f: f * rand(1.03, 1.06), a: 0.35, d: 0.008 },
    { f: rand(520, 720), a: 0.5, d: 0.012 },
    { f: rand(1100, 1400), a: 0.25, d: 0.008 },
  ], { a: 0.5, d: 0.003, lp: 2200 }); }],
  // dealer's puck set down on the felt: plastic thunk
  ['puck', 2, () => renderOneShot(RSR, 0.2, [
    { f: rand(150, 180), a: 0.8, d: 0.03, drop: 0.25, dropT: 0.008 },
    { f: rand(380, 450), a: 0.45, d: 0.025 },
    { f: rand(1150, 1350), a: 0.22, d: 0.012 },
    { f: rand(2900, 3300), a: 0.1, d: 0.006 },
  ], { a: 0.6, d: 0.006, lp: 1800 })],
  // UI tick
  ['ui', 1, () => renderOneShot(RSR, 0.05, [{ f: 1950, a: 1, d: 0.008 }, { f: 3900, a: 0.3, d: 0.004 }], { a: 0.25, d: 0.001, hp: 3000 }, 0.7)],
  // celesta / glockenspiel struck bar for chimes (C6 bank; C7 bank for the top register so the
  // playbackRate never pushes partials past Nyquist). A free-free bar is inharmonic (1 : 2.756 : 5.404 :
  // 8.933), every partial has its own decay (upper ones die fast), a slightly mistuned twin of the
  // fundamental gives the slow beating of a real bar, and a felt/metal mallet transient leads the note.
  ['bell', 3, () => renderBar(1046.5, true)],
  ['bellHi', 3, () => renderBar(2093.0, false)],
  // low wooden mallet bar (marimba-like, rendered at C4): the seven-out motif
  ['marimba', 3, () => { const f = 261.63; return renderOneShot(RSR, 1.5, [
    { f, a: 1.0, d: rand(0.38, 0.46), attack: 0.0012 },
    { f: f * rand(1.0015, 1.003), a: 0.25, d: 0.35 },
    { f: f * 3.93, a: 0.3, d: 0.075 },
    { f: f * 9.2, a: 0.09, d: 0.02 },
    { f: f * 0.5, a: 0.06, d: 0.3 }, // resonator tube
  ], [{ a: 0.5, d: 0.0035, lp: 2400, attack: 0.0004 }, { a: 0.12, d: 0.0012, hp: 2500 }], 0.85); }],
  // low muted hit (felt beater on a big drum) that anchors the seven-out sting; harmonics so laptop
  // speakers still hear it
  ['boom', 2, () => renderOneShot(RSR, 1.0, [
    { f: rand(56, 62), a: 1.0, d: 0.3, drop: 0.55, dropT: 0.035, attack: 0.002 },
    { f: rand(92, 100), a: 0.45, d: 0.16, drop: 0.35, dropT: 0.025 },
    { f: rand(180, 200), a: 0.22, d: 0.07 },
    { f: rand(330, 380), a: 0.08, d: 0.035 },
  ], [{ a: 0.7, d: 0.014, lp: 700, attack: 0.001 }, { a: 0.15, d: 0.003, lp: 3200 }], 0.9)],
  // the stickman's hardwood stick rapped on the table rail (the Realistic seven-out signature): a dry,
  // woody knock, no pitch you could hum. Appended last so the seeded banks above are unchanged.
  ['stick', 3, () => renderOneShot(RSR, 0.16, [
    { f: rand(180, 230), a: 0.4, d: 0.022, drop: 0.12, dropT: 0.003 },
    { f: rand(520, 650), a: 0.75, d: 0.016 },
    { f: rand(1250, 1500), a: 0.42, d: 0.009 },
    { f: rand(2500, 3100), a: 0.2, d: 0.005 },
  ], [{ a: 0.55, d: 0.003, lp: rand(2600, 3600) }, { a: 0.06, d: 0.001, hp: 3500 }])],
];
/** Struck-bar celesta/glockenspiel note at f; `full` keeps the top partial (only for the low bank). */
function renderBar(f, full) {
  const beat = rand(0.7, 1.7);
  const modes = [
    { f, a: 1.0, d: rand(0.8, 1.0), attack: 0.0008 },
    { f: f + beat, a: rand(0.28, 0.38), d: 0.75, attack: 0.0008 }, // mistuned twin: slow beating
    { f: f * 2.002, a: 0.12, d: 0.3 },                             // tuned octave (resonator)
    { f: f * rand(2.74, 2.77), a: 0.26, d: 0.12, attack: 0.0004 },
    { f: f * rand(5.38, 5.42), a: 0.14, d: 0.045, attack: 0.0003 },
    { f: f * 0.5, a: 0.035, d: 0.45 },                             // box resonance (celesta body)
  ];
  if (full) modes.push({ f: f * 8.93, a: 0.07, d: 0.02, attack: 0.0002 });
  // mallet: a very short bright click + a softer felt thump
  return renderOneShot(RSR, 2.3, modes, [{ a: 0.42, d: 0.0011, hp: 3500, attack: 0.0001 }, { a: 0.25, d: 0.004, lp: 1400, attack: 0.0004 }], 0.85);
}
// ---------- stickman voice: Klatt-style cascade formant synthesis of short table calls ----------
// A projected male voice (and a few table players for the "Yo!" shout) rendered from phoneme strings:
// KLGLOTT88 glottal flow-derivative source with jitter/shimmer and open-phase aspiration -> 5 cascade
// formant resonators whose targets glide between phonemes (one-pole coarticulation) -> plus a parallel
// fricative/burst noise branch for s, f, v, z, t, k, p, d. Rendered once at idle, played through the mix
// (glue, limiter, room reverb), so the calls sit IN the table sound instead of on top of it.
const VSR = 32000; // voice render rate (fricative energy tops out near 8 kHz)
const PH = {
  // vowels: formant targets F1-F3 (adult male)
  iy: { f: [280, 2250, 2950] }, ih: { f: [400, 1950, 2600] }, eh: { f: [560, 1800, 2500] }, ae: { f: [690, 1680, 2450] },
  ax: { f: [520, 1400, 2500] }, ah: { f: [620, 1200, 2450] }, aa: { f: [760, 1120, 2450] }, ao: { f: [600, 900, 2450] },
  ow: { f: [500, 880, 2400] }, uh: { f: [440, 1050, 2350] }, uw: { f: [320, 880, 2250] }, er: { f: [480, 1330, 1680] },
  // voiced approximants / nasals (lower voicing level; nasals with a wide, damped F1)
  y: { f: [270, 2150, 3000], av: 0.62 }, w: { f: [300, 640, 2250], av: 0.55 }, l: { f: [380, 1050, 2700], av: 0.6 },
  r: { f: [430, 1250, 1620], av: 0.65 }, n: { f: [260, 1650, 2600], av: 0.4, nasal: 1 }, m: { f: [260, 1100, 2300], av: 0.4, nasal: 1 },
  // fricatives: fr = [centre Hz, bandwidth factor], an = frication level
  v: { f: [320, 1450, 2450], av: 0.28, fr: [4300, 0.9], an: 0.22 }, z: { f: [300, 1700, 2600], av: 0.3, fr: [5600, 0.5], an: 0.38 },
  s: { f: [400, 1750, 2600], av: 0, fr: [6200, 0.45], an: 0.8 }, f: { f: [400, 1350, 2500], av: 0, fr: [5200, 1.2], an: 0.26 },
  th: { f: [400, 1500, 2550], av: 0, fr: [5000, 1.3], an: 0.2 }, h: { av: 0, asp: 0.85 },
  // stops: closure then a burst [Hz, bandwidth factor, seconds]; vb = voiced (short voice bar, no aspiration)
  t: { stop: [4300, 0.6, 0.014] }, k: { stop: [2100, 0.5, 0.02] }, p: { stop: [1100, 0.9, 0.011] },
  d: { stop: [3800, 0.7, 0.009], vb: 1 }, g: { stop: [2000, 0.6, 0.012], vb: 1 }, b: { stop: [900, 0.9, 0.008], vb: 1 },
  _: { av: 0 },
};
// words: [phoneme, seconds] ...; the longest vowel carries the word's accent
const WORDS = {
  two: [['t', 0.06], ['uw', 0.22]], three: [['th', 0.07], ['r', 0.05], ['iy', 0.22]], four: [['f', 0.09], ['ao', 0.14], ['r', 0.14]],
  five: [['f', 0.09], ['aa', 0.13], ['iy', 0.09], ['v', 0.07]], six: [['s', 0.1], ['ih', 0.1], ['k', 0.07], ['s', 0.13]],
  seven: [['s', 0.1], ['eh', 0.11], ['v', 0.05], ['ax', 0.05], ['n', 0.08]], eight: [['eh', 0.13], ['iy', 0.08], ['t', 0.07]],
  nine: [['n', 0.06], ['aa', 0.14], ['iy', 0.08], ['n', 0.1]], ten: [['t', 0.06], ['eh', 0.15], ['n', 0.12]],
  eleven: [['ih', 0.05], ['l', 0.06], ['eh', 0.12], ['v', 0.05], ['ax', 0.05], ['n', 0.11]],
  twelve: [['t', 0.05], ['w', 0.05], ['eh', 0.13], ['l', 0.07], ['v', 0.07]],
  yo: [['y', 0.07], ['ow', 0.2], ['uh', 0.1]], out: [['aa', 0.13], ['uh', 0.09], ['t', 0.07]],
  winner: [['w', 0.06], ['ih', 0.1], ['n', 0.07], ['er', 0.2]], craps: [['k', 0.06], ['r', 0.05], ['ae', 0.16], ['p', 0.06], ['s', 0.14]],
  hard: [['h', 0.06], ['aa', 0.15], ['r', 0.07], ['d', 0.05]], easy: [['iy', 0.1], ['z', 0.08], ['iy', 0.14]],
  line: [['l', 0.06], ['aa', 0.14], ['iy', 0.08], ['n', 0.1]], away: [['ax', 0.06], ['w', 0.06], ['eh', 0.12], ['iy', 0.13]],
  aces: [['eh', 0.11], ['iy', 0.06], ['s', 0.08], ['ih', 0.06], ['z', 0.1]], pay: [['p', 0.06], ['eh', 0.12], ['iy', 0.1]],
  the: [['th', 0.04], ['ax', 0.06]], front: [['f', 0.07], ['r', 0.05], ['ah', 0.11], ['n', 0.06], ['t', 0.05]],
  ace: [['eh', 0.12], ['iy', 0.07], ['s', 0.12]], deuce: [['d', 0.05], ['uw', 0.17], ['s', 0.13]],
  boxcars: [['b', 0.05], ['aa', 0.12], ['k', 0.05], ['s', 0.07], ['k', 0.05], ['aa', 0.12], ['r', 0.06], ['z', 0.1]],
  center: [['s', 0.09], ['eh', 0.1], ['n', 0.05], ['t', 0.04], ['er', 0.14]], field: [['f', 0.08], ['iy', 0.16], ['l', 0.07], ['d', 0.05]],
  no: [['n', 0.06], ['ow', 0.17]], way: [['w', 0.06], ['eh', 0.11], ['iy', 0.12]],
};
const NUM_WORD = { 2: 'two', 3: 'three', 4: 'four', 5: 'five', 6: 'six', 7: 'seven', 8: 'eight', 9: 'nine', 10: 'ten', 11: 'eleven', 12: 'twelve' };
// table calls: phrase = words with accents (0..2); '|' = a short breath pause. This table is the ONE source
// of the stickman's call: the voice renders these words and the on-screen caption (main.js callout ->
// AudioEngine.callText) is spelled from the same words, so the two can never disagree.
const CALLS = (() => {
  const c = {};
  const payLine = ['|', ['winner', 2], '|', ['pay', 1], ['the', 0], ['line', 1]];
  for (const [n, w] of Object.entries(NUM_WORD)) { c['n' + n] = [[w, 2]]; c['w' + n] = [[w, 2], ...payLine]; }
  c.n9 = [['nine', 2], '|', ['center', 1], ['field', 1]];
  c.n5 = [['five', 2], '|', ['no', 1], ['field', 0], ['five', 1]];
  for (const n of [4, 6, 8, 10]) {
    const w = NUM_WORD[n];
    c['h' + n] = [[w, 2], ['the', 0], ['hard', 1], ['way', 1]];   // "Six the hard way."
    c['e' + n] = [['easy', 1], [w, 2]];                            // "Easy six."
    c['hw' + n] = [[w, 2], ['the', 0], ['hard', 1], ['way', 1], ...payLine]; // point made the hard way
    c['ew' + n] = [['easy', 1], [w, 2], ...payLine];                         // point made easy
  }
  c.sevenOutLine = [['seven', 1], ['out', 2], '|', ['line', 1], ['away', 1]];
  c.winner7 = [['seven', 2], ...payLine];
  c.yo = [['yo', 2], ['eleven', 2]];                  // "Yo-leven!" (an eleven during a point)
  c.yoleven = [['yo', 2], ['eleven', 2], '|', ['winner', 2]]; // come-out eleven: "Yo-leven, winner!"
  // craps numbers are called the same on the come-out and during a point (field / any-craps / horn rolls)
  c.craps2 = [['aces', 2], '|', ['craps', 1]]; c.craps3 = [['ace', 1], ['deuce', 2], '|', ['craps', 1]]; c.craps12 = [['boxcars', 2], '|', ['craps', 1]];
  return c;
})();
/** Caption text of a CALLS phrase, built from the very words the voice says ('|' pause -> comma). */
function callPhraseText(key) {
  const ph = CALLS[key]; if (!ph) return '';
  let s = '';
  ph.forEach((w, i) => {
    if (w === '|') { s += ','; return; }
    const prev = ph[i - 1];
    if (prev && prev[0] === 'yo' && w[0] === 'eleven') { s += '-leven'; return; } // spoken run-together: "Yo-leven"
    s += !s ? '' : (prev && prev[0] === 'ace' && w[0] === 'deuce') ? '-' : ' ';
    s += w[0];
  });
  s = s.charAt(0).toUpperCase() + s.slice(1);
  return s + (/winner|yo/.test(s.toLowerCase()) ? '!' : '.');
}
/**
 * Render a phrase to a mono Float32Array. sp = speaker { f0, fscale, rate, bright, breath, shout }.
 * Control parameters are built at 1 kHz from the phoneme targets and smoothed (coarticulation), then
 * the source/filter runs per sample.
 */
function renderSpeech(phrase, sp = {}) {
  const sr = VSR, f0B = sp.f0 || 118, fs = sp.fscale || 1, rate = sp.rate || 1, shout = sp.shout || 0;
  const segs = []; let t = 0.04;
  phrase.forEach((w, wi) => {
    if (w === '|') { segs.push({ p: '_', t0: t, d: 0.07 / rate, acc: 0 }); t += 0.07 / rate; return; }
    const [word, acc] = w, ph = WORDS[word];
    let li = -1, ld = 0; ph.forEach(([p, d], i) => { if (PH[p].f && PH[p].av === undefined && d > ld) { ld = d; li = i; } });
    ph.forEach(([p, d], i) => { const dd = d / rate * (i === li && acc > 1 ? 1.12 : 1); segs.push({ p, t0: t, d: dd, acc: i === li ? acc : acc * 0.3, wi }); t += dd; });
  });
  const T = t + 0.22, CR = 1000, NC = Math.ceil(T * CR) + 2;
  const F = [new Float32Array(NC), new Float32Array(NC), new Float32Array(NC)], AV = new Float32Array(NC), AN = new Float32Array(NC),
    FR = new Float32Array(NC), FB = new Float32Array(NC), ASP = new Float32Array(NC), F0 = new Float32Array(NC), NAS = new Float32Array(NC);
  const bursts = [];
  const lastVowel = segs.reduce((m, s, i) => (PH[s.p].f && PH[s.p].av === undefined ? i : m), -1);
  let prevF = PH.ax.f;
  segs.forEach((s, i) => {
    const P = PH[s.p], next = segs.slice(i + 1).find((q) => PH[q.p].f);
    const f = P.f || (s.p === 'h' && next ? PH[next.p].f : prevF);
    if (P.f) prevF = P.f;
    const c0 = Math.floor(s.t0 * CR), c1 = Math.floor((s.t0 + s.d) * CR);
    const vowel = !!P.f && P.av === undefined;
    const prog = s.t0 / T;
    let f0 = f0B * (1 + (vowel ? 0.13 : 0.05) * s.acc * (1 + shout * 0.5)) * (1 - 0.13 * prog);
    if (i === lastVowel) f0 = f0B * (0.86 - 0.06 * shout); // phrase-final fall
    for (let c = c0; c < c1 && c < NC; c++) {
      const k = (c - c0) / Math.max(1, c1 - c0);
      for (let j = 0; j < 3; j++) F[j][c] = f[j];
      F0[c] = i === lastVowel ? f0B * (1 + 0.1 * s.acc) * (1 - k) + f0 * k : f0;
      NAS[c] = P.nasal ? 1 : 0;
      if (P.stop) {
        const close = k < 0.72;
        AV[c] = close && P.vb && k < 0.4 ? 0.12 : 0; AN[c] = 0;
        ASP[c] = !P.vb && !close ? 0.55 : 0; // aspiration after an unvoiced release
      } else {
        AV[c] = vowel ? 1 + 0.12 * s.acc : (P.av || 0);
        AN[c] = P.an || 0; ASP[c] = P.asp || 0;
        if (P.fr) { FR[c] = P.fr[0]; FB[c] = P.fr[1]; }
      }
    }
    if (P.stop) bursts.push({ t: s.t0 + s.d * 0.72, f: P.stop[0] * (0.95 + 0.1 * urand()), bw: P.stop[1], d: P.stop[2], a: P.vb ? 0.35 : 0.7 });
  });
  // fill unset fricative params and smooth every track (coarticulation / natural onsets)
  const smooth = (x, tau) => { const a = 1 - Math.exp(-1 / (tau * CR)); let y = x[0]; for (let c = 0; c < NC; c++) { y += a * (x[c] - y); x[c] = y; } };
  for (let c = 0; c < NC; c++) { if (!FR[c]) { FR[c] = 5000; FB[c] = 1; } if (!F0[c]) F0[c] = f0B * 0.85; for (let j = 0; j < 3; j++) if (!F[j][c]) F[j][c] = PH.ax.f[j]; }
  for (let j = 0; j < 3; j++) smooth(F[j], 0.016);
  smooth(AV, 0.007); smooth(AN, 0.005); smooth(ASP, 0.006); smooth(F0, 0.035); smooth(FR, 0.01); smooth(NAS, 0.01);
  // ---- per-sample source / filter ----
  const n = Math.floor(T * sr), out = new Float32Array(n);
  const res = () => ({ y1: 0, y2: 0, a: 0, b: 0, c: 0 });
  const R = [res(), res(), res(), res(), res()], FRr = res(), FRr2 = res();
  const setR = (r, f, bw) => { const e = Math.exp(-Math.PI * bw / sr); r.c = -e * e; r.b = 2 * e * Math.cos(TAU * Math.min(f, sr * 0.45) / sr); r.a = 1 - r.b - r.c; };
  const run = (r, x) => { const y = r.a * x + r.b * r.y1 + r.c * r.y2; r.y2 = r.y1; r.y1 = y; return y; };
  setR(R[3], 3400 * fs, 260); setR(R[4], 4100 * fs, 320);
  let ph = 0, amp = 1, jit = 0, tilt = 0, hpX = 0, hpY = 0;
  const tiltA = 1 - Math.exp(-TAU * (2600 + 2200 * (sp.bright ?? 0.5) + 1800 * shout) / sr);
  let bi = 0;
  const active = [];
  for (let i = 0; i < n; i++) {
    const tc = (i / sr) * CR, c = Math.min(NC - 2, Math.floor(tc)), u = tc - c;
    const L = (x) => x[c] + (x[c + 1] - x[c]) * u;
    if ((i & 15) === 0) {
      const nas = L(NAS);
      setR(R[0], L(F[0]) * fs, 80 + 90 * nas); setR(R[1], L(F[1]) * fs, 95 + 40 * nas); setR(R[2], L(F[2]) * fs, 150);
      setR(FRr, L(FR), L(FR) * L(FB) * 0.5); setR(FRr2, L(FR) * 1.35, L(FR) * 0.6);
    }
    // glottal source: KLGLOTT88 flow derivative, 60 % open quotient, jitter + shimmer per period
    const f0 = L(F0) * (1 + jit);
    ph += f0 / sr;
    if (ph >= 1) { ph -= 1; jit = (urand() * 2 - 1) * 0.012; amp = 1 + (urand() * 2 - 1) * 0.06; }
    const OQ = 0.6 - 0.12 * shout, open = ph < OQ;
    const x = open ? (2 * (ph / OQ) - 3 * (ph / OQ) * (ph / OQ)) : 0;
    tilt += tiltA * (x - tilt);
    const nz = urand() * 2 - 1;
    const av = L(AV), asp = L(ASP);
    const src = tilt * av * amp * 2.2 + nz * ((sp.breath ?? 0.05) * av * (open ? 1 : 0.35) + asp * 0.35);
    let y = src; for (let k = 0; k < 5; k++) y = run(R[k], y);
    // frication (parallel branch) + stop bursts
    const an = L(AN);
    let fr = 0; if (an > 0.002) fr = (run(FRr, nz) + 0.5 * run(FRr2, nz)) * an * 0.55; else { run(FRr, 0); run(FRr2, 0); }
    while (bi < bursts.length && bursts[bi].t * sr <= i) { const b = bursts[bi++]; const br = res(); setR(br, b.f, b.f * b.bw); active.push({ r: br, e: b.a, k: Math.exp(-1 / (b.d * 0.4 * sr)), end: i + b.d * sr * 2.5 }); }
    let bu = 0;
    for (let q = active.length - 1; q >= 0; q--) { const B = active[q]; bu += run(B.r, urand() * 2 - 1) * B.e; B.e *= B.k; if (i > B.end) active.splice(q, 1); }
    let v = y + fr + bu * 0.9;
    // radiation-ish gentle high-pass (removes rumble / DC of the cascade)
    hpY = 0.995 * (hpY + v - hpX); hpX = v; v = hpY;
    out[i] = v;
  }
  let mx = 0; for (let i = 0; i < n; i++) mx = Math.max(mx, Math.abs(out[i]));
  const g = mx > 0 ? 0.9 / mx : 1, fo = Math.floor(sr * 0.03);
  for (let i = 0; i < n; i++) out[i] *= g * (i > n - fo ? (n - i) / fo : 1);
  return out;
}
const BELL_BASE = 1046.5, BELL_HI = 2093.0, MARIMBA_BASE = 261.63;
const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);
// Win motifs in C major pentatonic (C D E G A), MIDI notes. Mid and big tiers resolve on a C.
const WIN_VOICINGS = {
  small: [[79, 81, 84], [76, 79, 84], [81, 84, 88], [84, 86, 88], [74, 76, 79]],
  mid: [[76, 79, 81, 86, 84], [79, 81, 84, 88, 96], [84, 86, 88, 91, 96], [81, 79, 84, 86, 88, 84]],
  big: [[84, 86, 88, 91, 93, 91, 96], [79, 81, 84, 86, 88, 91, 96], [76, 79, 81, 84, 86, 88, 91, 84], [72, 76, 79, 84, 88, 91, 96]],
};

function renderIRChannel(sec, rt60) {
  const len = Math.floor(RSR * sec), d = new Float32Array(len), pre = Math.floor(RSR * 0.012);
  for (let r = 0; r < 9; r++) { const i = pre + Math.floor(RSR * rand(0.004, 0.07)); if (i < len) d[i] += (urand() < 0.5 ? -1 : 1) * rand(0.25, 0.6) * (1 - r / 12); }
  // late diffuse tail, darkening over time (envelopes stepped every 64 samples: cheap)
  let lp = 0, a = 0, env = 0;
  for (let i = pre; i < len; i++) {
    if (((i - pre) & 63) === 0) {
      const t = (i - pre) / RSR;
      a = 1 - Math.exp(-TAU * (7000 * Math.exp(-t * 2.2) + 900) / RSR);
      env = Math.exp(-6.9 * t / rt60) * 0.5 * Math.min(1, t / 0.03);
    }
    lp += a * ((urand() * 2 - 1) - lp);
    d[i] += lp * env;
  }
  return d;
}
function renderPinkChannel(n) {
  const d = new Float32Array(n); let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  for (let i = 0; i < n; i++) { // Paul Kellet pink noise
    const w = urand() * 2 - 1;
    b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759; b2 = 0.969 * b2 + w * 0.153852;
    b3 = 0.8665 * b3 + w * 0.3104856; b4 = 0.55 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.016898;
    d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11; b6 = w * 0.115926;
  }
  return d;
}
/** Make a buffer loop seamlessly by crossfading its tail into its head; returns the loop length. */
function loopify(chs, loopLen, xf) {
  for (const d of chs) for (let i = 0; i < xf; i++) { const k = i / xf; d[i] = d[i] * Math.sqrt(k) + d[loopLen + i] * Math.sqrt(1 - k); }
  return loopLen;
}

// Lookahead brickwall limiter (AudioWorklet). Per sample: required gain g = min(1, ceil / peak(L,R));
// a sliding-window minimum over 2L samples (monotonic deque), an exponential release, then an L-sample
// boxcar for a smooth attack; the audio is delayed by L samples. For a peak entering at n, every value
// averaged at output time n+L is <= g[n], so the output sample peak never exceeds `ceil` (no overshoot,
// unlike a 1 ms-attack compressor), and the soft clip after it stays a true safety net.
// Gain staging (polish r2). The user's volume is NOT in front of the dynamics any more:
//   post -> DRIVE (fixed) -> lookahead limiter -> sum <- bed (DRIVE, fixed)
//   sum -> final ceiling -> user fader (dB taper, mute) -> soft clip -> out
// The limiter and the final ceiling therefore see the same signal at every slider position: their gain
// reduction is a property of the mix, not of the volume, and every sound follows the slider dB for dB.
// DRIVE is sized by MEASURED gain reduction (?audiotest "LIMITER GR"): the slam takes ~3 dB, so the
// slam-to-settle dynamics of impactLevel() survive. Loudness comes from the sustained layers (felt roll
// bed ROLL_G, tumble grains GRAIN_G, the rattle) and the crowd, which the limiter barely touches.
const DRIVE = 2.6;           // fixed gain into the limiter (and on the bed)
const FADER_MIN_DB = -40;    // fader taper: dB = FADER_MIN_DB * (1 - v)^FADER_CURVE (v = 0 is silence)
const FADER_CURVE = 1.5;     // 0.9 -> -1.3 dB, 0.75 -> -5 dB, 0.5 -> -14 dB, 0.25 -> -26 dB
const DEFAULT_VOLUME = 0.9;
/** Linear fader gain of slider position v (0..1). */
export function faderGain(v) {
  const x = clamp(Number(v) || 0, 0, 1);
  return x <= 0.001 ? 0 : Math.pow(10, (FADER_MIN_DB * Math.pow(1 - x, FADER_CURVE)) / 20);
}
// ?audiotest reference readings (seeded renders; default volume / volume 1.0): the badge prints each run as
// a delta against these, so a tuning change shows up as a clean number instead of run-to-run noise. Gain
// reduction is the same at every volume now, so there is one GR reference.
const AUDIOTEST_REF = { throwST: -22.8, winMixST: -20.7, throwFull: -20.0, winFull: -16.8, tp: -1.8, tpFull: -1.8, slamGR: -2.5 };
const WIN_G = 0.75, CROWD_G = 1.35, DICE_G = 0.4, VOICE_G = 0.45, RATTLE_G = 1.25;
// Dice gains are set by measured limiter gain reduction, not by loudness (DICE_G 2.0 / RATTLE_G 1.9 once
// had the slam at -13 dB GR and ducked the following bounces by ~10 dB). The throw gets its weight from
// duration and density instead: the felt roll bed and tumble grains, which are not ducked after the slam.
const ROLL_G = 0.7, GRAIN_G = 1.1;
/**
 * Loudness (0..1, linear amplitude) of a die impact from its physical closing speed along the contact
 * normal (world units/s, from physics.js). Measured over 20 seeded throws: felt landings 20-29, mid
 * bounces 3-13, edge rolls and settle rocks 0.5-2; wall hits 15-45; die-on-die 1-20. A power law with
 * exponent 0.7 keeps ~20-26 dB between the first slam and the last settle tap (a real impact's
 * amplitude grows roughly with velocity), so the slam is clearly loudest and the settle rocks stay audible.
 */
export function impactLevel(type, closing) {
  const c = Number(closing) || 0;
  if (c <= 0.25) return 0;
  const ref = type === 'wall' ? 36 : type === 'dice' ? 14 : 28;
  return clamp(Math.pow(c / ref, 0.7), 0, 1);
}
const VOICE_SOFT = 40, VOICE_HARD = 110; // concurrent voices: thin low-priority layers / hard CPU cap
const LIM_CEIL = 0.832;   // foreground limiter: -1.6 dBFS sample ceiling
const FINAL_CEIL = 0.861; // final ceiling on the sum (foreground + bypassing bed): -1.3 dBFS, below the -1.1 dBFS soft-clip knee
const LIMITER_SRC = `
class CrapsLimiter extends AudioWorkletProcessor {
  constructor(o) {
    super();
    const p = (o && o.processorOptions) || {};
    this.ceil = p.ceil || 0.832;
    const L = Math.max(8, Math.round((p.lookahead || 0.003) * sampleRate)), H = 2 * L, Q = H + 1;
    this.L = L; this.H = H; this.Q = Q;
    this.dl = new Float32Array(L); this.dr = new Float32Array(L); this.di = 0;
    this.qi = new Float64Array(Q); this.qv = new Float64Array(Q); this.qh = 0; this.qt = 0; this.n = 0;
    this.box = new Float64Array(L).fill(1); this.bi = 0; this.bs = L;
    this.env = 1; this.rel = 1 - Math.exp(-1 / ((p.release || 0.08) * sampleRate));
    this.report = !!p.report; this.minG = 1; this.blocks = 0;
    this.trace = !!p.trace; this.blk = 0; // ?audiotest offline: per-block gain trace (only blocks that reduced)
  }
  process(inputs, outputs) {
    const inp = inputs[0], out = outputs[0];
    const oL = out[0], oR = out[1] || out[0];
    const iL = inp && inp[0], iR = inp && (inp[1] || inp[0]);
    const N = oL.length, L = this.L, H = this.H, Q = this.Q, ceil = this.ceil, rel = this.rel;
    const qi = this.qi, qv = this.qv, box = this.box, dl = this.dl, dr = this.dr;
    let qh = this.qh, qt = this.qt, n = this.n, env = this.env, bi = this.bi, bs = this.bs, di = this.di, minG = this.minG, bm = 1;
    for (let i = 0; i < N; i++) {
      const xl = iL ? iL[i] : 0, xr = iR ? iR[i] : 0;
      const al = xl < 0 ? -xl : xl, ar = xr < 0 ? -xr : xr, pk = al > ar ? al : ar;
      const g = pk > ceil ? ceil / pk : 1;
      n++;
      while (qt !== qh && qv[(qt + Q - 1) % Q] >= g) qt = (qt + Q - 1) % Q;
      qi[qt] = n; qv[qt] = g; qt = (qt + 1) % Q;
      while (qi[qh] <= n - H) qh = (qh + 1) % Q;
      const m = qv[qh];
      env = m < env ? m : env + (m - env) * rel;
      bs += env - box[bi]; box[bi] = env; bi++; if (bi === L) bi = 0;
      let gain = bs / L; if (gain > 1) gain = 1;
      if (gain < minG) minG = gain;
      if (gain < bm) bm = gain;
      oL[i] = dl[di] * gain; if (out[1]) oR[i] = dr[di] * gain;
      dl[di] = xl; dr[di] = xr; di++; if (di === L) di = 0;
    }
    if ((n & 0x3ffff) < N) { let s = 0; for (let k = 0; k < L; k++) s += box[k]; bs = s; } // re-sum: no float drift
    this.qh = qh; this.qt = qt; this.n = n; this.env = env; this.bi = bi; this.bs = bs; this.di = di;
    if (this.trace) { if (bm < 0.99999) this.port.postMessage([this.blk, bm]); this.blk++; }
    if (this.report && ++this.blocks % 30 === 0) { this.port.postMessage(20 * Math.log10(Math.max(1e-6, minG))); minG = 1; }
    this.minG = minG;
    return true;
  }
}
registerProcessor('craps-limiter', CrapsLimiter);
`;

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.muted = false;
    this.volume = DEFAULT_VOLUME;
    // Casino ambience (room tone + crowd bed): OFF by default (opt-in in Settings). Every older save wrote
    // ambience: true whether or not the player touched it, so only an explicit choice (ambSet) is restored.
    this.ambienceOn = false;
    this._ambSet = false;
    // Stickman calls: OFF by default (opt-in in Settings). The voice is a synthesized formant voice whose
    // intelligibility and naturalness have not been verified (no ASR / blind listening pass), so it does not
    // play on every roll unless the player asks for it. When on, it goes through the mix bus, glue, limiter
    // and room reverb like every other table sound. Only an explicit choice (callSet) is restored.
    this.callouts = false;
    this._callSet = false;
    // Sound profile: 'Realistic' (default, chimes off) lets the crowd, the stickman and the payout chips
    // carry a win, like a real table; 'Win chimes' adds the musical chime / stinger bus on top.
    this.chimes = false;
    try {
      const s = JSON.parse(localStorage.getItem('craps.audio') || '{}');
      if (typeof s.muted === 'boolean') this.muted = s.muted;
      // v5 moved the fader after the limiter (dB taper): an untouched old default (0.8) maps to the new default
      if (typeof s.volume === 'number' && !((s.v || 0) < 5 && s.volume === 0.8)) this.volume = clamp(s.volume, 0, 1);
      if (typeof s.ambience === 'boolean' && s.ambSet === true) { this.ambienceOn = s.ambience; this._ambSet = true; }
      // settings saved before v3 stored the old OS-voice OFF default without the user choosing it: ignore those
      if (typeof s.callouts === 'boolean' && s.callSet === true) { this.callouts = s.callouts; this._callSet = true; }
      if (typeof s.chimes === 'boolean') this.chimes = s.chimes;
    } catch { /* storage unavailable */ }
    this._callRaw = null;   // stickman / shout phrases: key -> Float32Array (VSR), rendered at idle
    this._callBufs = {};    // key -> AudioBuffer (per context)
    this._throwInfo = null; // the throw in flight (for rescheduling after a tab hide)
    this._resumeInfo = null;
    this._vw = [];          // scheduled voice windows [start, end] (audio clock) for the voice budget
    this._duckTok = 0;      // id of the most recent ambience duck (a callout's end only restores its own)
    this._capture = null;   // while scheduling a throw: every source started is collected here
    this._throwSrcs = [];   // sources of the throw in flight (cancelThrow stops them)
    this._tFreeze = null;   // shared time base while scheduling one throw
    this._muteTimer = 0;
    this._muteSuspended = false;
    this.bufs = null;
    this.crowd = {};
    this.crowdStatus = 'waiting';
    this.camera = null;
    this._amb = null;
    this._voices = 0;
    this._lastHit = Object.create(null);
    this._burst = { t: 0, e: 0 };
    this._roll = null;
    this._warned = false;
    this._stats = { initMs: 0, prerenderMs: 0, crowdMs: 0, hitsIn: 0, hitsPlayed: 0, dropped: 0, droppedHi: 0, peak: 0, rmsMax: 0, glueMax: 0, limMax: 0 };
    const evs = ['pointerdown', 'keydown', 'touchend'];
    const unlock = () => {
      // iOS Safari 17+: route Web Audio as media playback so the ringer/silent switch does not mute it
      try { if (navigator.audioSession && navigator.audioSession.type !== 'playback') navigator.audioSession.type = 'playback'; } catch { }
      this.init();
      const c = this.ctx; if (!c) return;
      const done = () => { if (c.state === 'running' || this.muted) for (const e of evs) window.removeEventListener(e, unlock, true); };
      if (c.state === 'running' || this.muted) { done(); return; }
      try { const p = c.resume(); if (p && p.then) p.then(done, () => { }); } catch { }
    };
    for (const e of evs) window.addEventListener(e, unlock, true);
    document.addEventListener('visibilitychange', () => {
      if (!this.ctx) return;
      try {
        if (document.hidden) {
          // the dice animation keeps its wall-clock timeline while hidden; remember the throw so the
          // impacts still to come can be rescheduled from the current animation time on return
          this._resumeInfo = this._throwInfo;
          this.cancelThrow();
          if (this.ctx.state === 'running') { this._autoSuspended = true; this.ctx.suspend(); }
        } else if (this._autoSuspended) {
          this._autoSuspended = false;
          if (!this.muted) {
            const go = () => this._resumeThrow();
            const p = this.ctx.resume(); if (p && p.then) p.then(go, () => { }); else go();
          }
        }
      } catch { }
    });
    // Every public sound method is wrapped so an audio problem can never break the game.
    // A call made while the context is still starting (a fresh AudioContext resumes asynchronously, so a
    // keyboard-first Space/Enter throw arrives while it is 'suspended') or while the samples are still
    // attaching is never dropped: it is queued and replayed the moment the context runs (_flushPending).
    // throwDice is special-cased: the throw keeps its wall-clock start and is scheduled late through
    // _scheduleThrow(elapsed), so the impacts stay in sync with the dice animation.
    this._pending = [];
    for (const name of ['rattle', 'throwRelease', 'diceRoll', 'diceHit', 'throwDice', '_resumeThrow', 'chips', 'chipsRail', 'chipStack', 'chipsTake', 'sweep', 'bankLand', 'puck', 'click', 'error', 'win', 'lose', 'sevenOut', 'result', 'cheer', 'groan', 'callout', 'shout']) {
      if (typeof this[name] !== 'function') continue;
      const fn = this[name].bind(this);
      const queueable = name[0] !== '_';
      this[name] = (...args) => {
        try {
          if (this.ready) fn(...args);
          else if (queueable && this._starting()) this._queue(name, fn, args);
          else if (name === 'throwDice') this._noteSilentThrow(args); // muted / hidden / no context: keep it for unmute
        } catch (e) { this._fail(e); }
      };
    }
    // Pre-render everything into plain arrays in idle chunks shortly after load (no AudioContext needed),
    // so the first click/keypress does almost no work.
    setTimeout(() => this._prerender(), SHOT ? 0 : 700);
    if (AUDIOTEST) { window.__crapsAudio = this; setTimeout(() => this._report(), 20); } // offline measurement does not need the live context
    if (AUDIOTEST || REC_SECONDS) setTimeout(() => this.init(), 50);
  }
  _fail(e) {
    if (SHOT) setTimeout(() => { throw e; }); // surface on the visible error overlay during tests
    else if (!this._warned) { this._warned = true; console.warn('[audio]', e); }
  }
  /** True while the context exists but is still starting up (resume in flight / samples attaching). */
  _starting() {
    const c = this.ctx;
    if (!c || this.muted || this._autoSuspended || c.state === 'closed') return false;
    try { if (document.hidden) return false; } catch { }
    return true;
  }
  /** Throw descriptor on the animation's time base (wall0 = when the dice animation's clock started). */
  _throwDesc(args) {
    const [sim, { pickup = 0.38, speed = 1 } = {}] = args;
    if (!sim) return null;
    const sp = Math.max(0.1, Number(speed) || 1), del = Math.max(0, Number(pickup) || 0) / sp;
    // main.js starts the animation at now + latency; latency reads 0 while the context is not running
    return { sim, sp, del, wall0: performance.now() + this.latency * 1000 };
  }
  /**
   * A throw made while nothing can play it (muted, hidden tab, no context yet): still record it as the throw
   * in flight, so unmuting (setMuted -> _resumeThrow) or the tab's return picks up whatever is left of it.
   */
  _noteSilentThrow(args) {
    const T = this._throwDesc(args); if (!T) return;
    try { this.cancelThrow(); } catch { }
    this._throwInfo = T; this._resumeInfo = T;
  }
  _queue(name, fn, args) {
    if (name === 'throwDice') { const T = this._throwDesc(args); if (T) { this._pendingThrow = T; this._throwInfo = T; } return; }
    if (this._pending.length >= 24) this._pending.shift();
    this._pending.push({ name, fn, args, at: performance.now() });
    // a resume that is not already under way (e.g. the samples were still attaching) is requested here
    try { if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => { }); } catch { }
  }
  /**
   * Replay what was queued while the context was starting (called when it starts running / attaches).
   * Everything is placed on the timeline it belonged to: the throw skips ahead by the time already gone
   * PLUS the output latency (what is scheduled now is heard `latency` later, while the dice animation has
   * been running since the key press), and each queued call's own `delay` argument is shortened by the
   * time it waited. Calls tied to one visual instant with no delay to absorb the wait (chips touching down,
   * the puck) are dropped once they are late enough to be heard out of sync.
   */
  _flushPending() {
    if (!this.ready) return;
    const T = this._pendingThrow, q = this._pending;
    this._pendingThrow = null; this._pending = [];
    const now = performance.now(), lat = this.latency;
    if (T) {
      try {
        this.cancelThrow();
        this._throwInfo = T;
        const elapsed = (now - T.wall0) / 1000 + lat;
        if (elapsed < T.del + (T.sim.duration || 0) / T.sp) this._scheduleThrow(T.sim, T.sp, T.del, Math.max(0, elapsed));
      } catch (e) { this._fail(e); }
    }
    for (const p of q) {
      const waited = (now - p.at) / 1000 + lat;
      if (waited > 1.5) continue; // stale: the moment it belonged to has passed
      const args = AudioEngine._lateArgs(p.name, p.args, waited);
      if (!args) continue;
      try { p.fn(...args); } catch (e) { this._fail(e); }
    }
    if (this._resumeInfo && !T) try { this._resumeThrow(); } catch (e) { this._fail(e); }
  }
  /** Arguments of a queued call replayed `waited` s late, or null when it should be dropped (see _flushPending). */
  static _lateArgs(name, args, waited) {
    const DELAY_ARG = { chips: 1, chipStack: 1, diceHit: 2, throwRelease: 0, cheer: 1, groan: 1 };
    const SYNC = /^(chips|chipStack|chipsRail|chipsTake|sweep|bankLand|puck|diceHit|rattle|throwRelease|diceRoll)$/;
    const TOL = 0.06; // ~ one perceptual sync window: later than this is heard detached from the visual
    const a = args.slice(), k = DELAY_ARG[name];
    if (k !== undefined) {
      const d = (Number(a[k]) || 0) - waited;
      if (d < -TOL && SYNC.test(name)) return null;
      a[k] = Math.max(0, d);
      return a;
    }
    if (name === 'diceRoll') { const o = { ...(a[1] || {}) }, d = (Number(o.delay) || 0) - waited; if (d < -TOL) return null; o.delay = Math.max(0, d); a[1] = o; return a; }
    if (SYNC.test(name) && waited > TOL) return null;
    return a; // result / callout / win / error ...: late but still meaningful
  }
  _save() { try { localStorage.setItem('craps.audio', JSON.stringify({ v: 6, muted: this.muted, volume: this.volume, ambience: this.ambienceOn, ambSet: this._ambSet, callouts: this.callouts, callSet: this._callSet, chimes: this.chimes })); } catch { } }
  /** Seconds between scheduling a sound and hearing it (the visuals can be delayed by this to stay in sync). */
  get latency() { const c = this.ctx; if (!c || c.state !== 'running') return 0; return clamp((c.outputLatency || 0) + (c.baseLatency || 0), 0, 0.25); }
  /** The camera used to place sounds in the stereo field (pan follows the view, not world x). */
  setListener(camera) { this.camera = camera || null; }

  // ---------- offline pre-render (plain JS, chunked) ----------
  _prerender() {
    if (this._rawP) return this._rawP;
    this._rawP = (async () => {
      const t0 = performance.now();
      const raw = await seededRender(1001, () => this._renderBanks());
      this._raw = raw;
      this._stats.prerenderMs = performance.now() - t0;
      if (this.ctx) this._attach();
      // stickman calls next (short, the most important non-dice layer), then crowd + babble
      this._voiceP = seededRender(2002, () => this._renderVoices()).catch((e) => { this._fail(e); });
      await this._voiceP;
      this._crowdP = seededRender(3003, () => this._renderCrowd()).then(() => { this.crowdStatus = 'done'; this._attachCrowd(); }, (e) => { this.crowdStatus = 'error: ' + (e && e.message); this._fail(e); });
      return raw;
    })();
    return this._rawP;
  }
  /** One-shot banks, white + pink noise and the room IR, as plain arrays (chunked). */
  async _renderBanks() {
    {
      const raw = { banks: {} };
      for (const [name, count, fn] of BANKS) {
        raw.banks[name] = Array.from({ length: count }, fn);
        await yieldFrame();
      }
      raw.noise = new Float32Array(RSR * 2); for (let i = 0; i < raw.noise.length; i++) raw.noise[i] = urand() * 2 - 1;
      await yieldFrame();
      raw.pink = [];
      for (let ch = 0; ch < 2; ch++) {
        const n = RSR * 4, d = renderPinkChannel(n + Math.floor(RSR * 0.1));
        raw.pink.push(d.subarray(0, loopify([d], n, Math.floor(RSR * 0.1))));
        await yieldFrame();
      }
      raw.ir = [];
      // carpeted casino floor: fairly dead (RT60 ~0.9 s), so wins read close and punchy, not washy
      for (let ch = 0; ch < 2; ch++) { raw.ir.push(renderIRChannel(1.3, 0.9)); await yieldFrame(); }
      return raw;
    }
  }

  // ---------- setup ----------
  init() {
    if (this.ctx) { try { if (this.ctx.state === 'suspended' && !this._autoSuspended && !this.muted) this.ctx.resume(); } catch { } return; }
    const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return;
    const t0 = performance.now();
    // fixed 48 kHz: keeps convolution cheap on 96/192 kHz devices (the browser resamples)
    try { this.ctx = new AC({ latencyHint: 'interactive', sampleRate: RSR }); } catch { try { this.ctx = new AC(); } catch { return; } }
    this._stats.ctxMs = performance.now() - t0; // browser-side context creation (not our work)
    { const c = this.ctx; try { c.addEventListener('statechange', () => { if (this.ctx === c && c.state === 'running') this._flushPending(); }); } catch { } }
    try { this._buildGraph(); } catch (e) { this._fail(e); this.ctx = null; return; }
    { const c = this.ctx; AudioEngine._loadLimiter(c).then((ok) => { if (ok && this.ctx === c) this._installLimiter(); }, () => { /* compressor fallback stays */ }); }
    try { if (this.ctx.state === 'suspended' && (!this.muted || SHOT || AUDIOTEST)) this.ctx.resume(); } catch { }
    if (this.muted && !SHOT && !AUDIOTEST) { this._muteSuspended = true; try { if (this.ctx.state === 'running') this.ctx.suspend(); } catch { } }
    if (this._raw) this._attach(); else this._prerender(); // _prerender attaches when it finishes
    this._stats.initMs = performance.now() - t0;

    if (REC_SECONDS) this._record(REC_SECONDS);
  }

  _buildGraph() {
    const c = this.ctx;
    const gain = (v, to) => { const g = c.createGain(); g.gain.value = v; if (to) g.connect(to); return g; };
    // output: post -> master (DRIVE) -> limIn -> limiter -> sum -> [final ceiling] -> fader -> soft clip -> out -> destination
    //          ambience dry -> ambMaster -----------> sum   (the room bed skips the foreground limiter: no pumping;
    //          the final ceiling on the sum is what keeps bed + limited peaks off the soft clip)
    // The limiter starts as a native DynamicsCompressor (fallback) and is replaced by a 3 ms lookahead
    // brickwall AudioWorklet (_installLimiter) as soon as its module has loaded; the final ceiling (a second
    // instance) is inserted between sum and the soft clip at the same time.
    this.out = gain(SHOT ? 0 : 1, c.destination); // shot runs are silent, but everything before `out` runs at real gain
    // final safety net: transparent below -1.1 dBFS (above both ceilings), tanh knee to a -0.6 dBFS ceiling (4x oversampled)
    this.clip = c.createWaveShaper();
    this.clip.curve = AudioEngine._clipCurve(); this.clip.oversample = '4x';
    this.clip.connect(this.out);
    // the user fader sits AFTER the limiter and the final ceiling: volume never changes gain reduction
    this.fader = gain(this._faderLevel(), this.clip);
    this.sum = gain(1, this.fader);
    this.limiter = c.createDynamicsCompressor();
    this.limiter.threshold.value = -4.5; this.limiter.knee.value = 0; this.limiter.ratio.value = 20;
    this.limiter.attack.value = 0.001; this.limiter.release.value = 0.09;
    this.tap = gain(makeupTrim(-4.5, 20, 0), this.sum);
    this.limiter.connect(this.tap);
    this.limIn = gain(1, this.limiter);
    this.master = gain(DRIVE, this.limIn);    // fixed internal gain staging (not the volume)
    this.ambMaster = gain(DRIVE, this.sum);
    this.post = gain(1, this.master);
    // glue: only the foreground (sfx/ui/music); gentle, with its auto-makeup trimmed away
    this.glue = c.createDynamicsCompressor();
    this.glue.threshold.value = -10; this.glue.knee.value = 6; this.glue.ratio.value = 2;
    this.glue.attack.value = 0.006; this.glue.release.value = 0.25;
    this.glue.connect(gain(makeupTrim(-10, 2, 6), this.post));
    this.mix = gain(1, this.glue);
    this.sfx = gain(1.0, this.mix);
    // dice impacts + felt roll skip the glue: a 250 ms glue release after the first slam would duck every
    // following bounce and settle tap; the 3 ms lookahead limiter alone catches the slam's peak
    this.diceBus = gain(1.0, this.post);
    this.ui = gain(0.55, this.mix);
    this.music = gain(0.75, this.mix);

    // reverb (generated casino-room impulse; buffer attached after pre-render)
    this.verb = c.createConvolver();
    const verbHp = c.createBiquadFilter(); verbHp.type = 'highpass'; verbHp.frequency.value = 180;
    this.verbIn = gain(1, verbHp); verbHp.connect(this.verb); this.verb.connect(gain(0.9, this.post));

    // ambience: separate dry and wet paths, each through its own duck + fader, so the ambient reverb
    // ducks under wins/losses and fades out with the ambience switch exactly like the dry signal
    this.ambDry = gain(0, this.ambMaster);
    this.ambWet = gain(0, this.verbIn);
    this.duckDry = gain(1, this.ambDry);
    this.duckWet = gain(1, this.ambWet);

    if (AUDIOTEST) { this.analyser = c.createAnalyser(); this.analyser.fftSize = 2048; this.clip.connect(this.analyser); }
  }
  /** Soft-clip transfer curve: identity to A, then A + (C-A)*tanh((|x|-A)/(C-A)); never exceeds C. */
  static _clipCurve() {
    if (AudioEngine._curve) return AudioEngine._curve;
    const N = 4096, A = 0.88, C = 0.93, cv = new Float32Array(N); // A = -1.1 dBFS (above the -1.3 dBFS final ceiling), C ~ -0.6 dBFS
    for (let i = 0; i < N; i++) {
      const x = (i / (N - 1)) * 2 - 1, ax = Math.abs(x);
      cv[i] = Math.sign(x) * (ax <= A ? ax : A + (C - A) * Math.tanh((ax - A) / (C - A)));
    }
    return (AudioEngine._curve = cv);
  }
  /** Blob URL of the lookahead limiter worklet module (shared by the live and offline contexts). */
  static _limiterUrl() {
    if (!AudioEngine._lu) AudioEngine._lu = URL.createObjectURL(new Blob([LIMITER_SRC], { type: 'text/javascript' }));
    return AudioEngine._lu;
  }
  /** Load the limiter module into context `c`; resolves true when the worklet can be created. */
  static async _loadLimiter(c) {
    if (!c || !c.audioWorklet || typeof AudioWorkletNode === 'undefined') return false;
    await c.audioWorklet.addModule(AudioEngine._limiterUrl());
    return true;
  }
  /** Swap the fallback compressor for the lookahead brickwall worklet (keeps the compressor on any failure). */
  _installLimiter() {
    const c = this.ctx; if (!c || this.wlim) return;
    let w, fin;
    const mk = (ceil, release, extra) => new AudioWorkletNode(c, 'craps-limiter', {
      numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2], channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'speakers',
      processorOptions: { ceil, lookahead: 0.003, release, ...extra },
    });
    try {
      w = mk(LIM_CEIL, 0.08, { report: AUDIOTEST && !this._offline, trace: !!this._offline });
      // final ceiling on the whole sum (bed included): a second lookahead brickwall a little above the
      // foreground ceiling, so it only acts when the bypassing bed lands on an already-limited peak
      fin = mk(FINAL_CEIL, 0.05, { trace: !!this._offline });
    } catch (e) { return; }
    w.port.onmessage = (ev) => {
      const g = ev.data;
      if (typeof g === 'number') this._limGR = Math.min(this._limGR || 0, g);
      else if (this._grTrace) this._grTrace.lim.push(g);
    };
    fin.port.onmessage = (ev) => { if (this._grTrace && Array.isArray(ev.data)) this._grTrace.fin.push(ev.data); };
    // sum -> final ceiling -> fader (replaces the direct sum -> fader path)
    try { this.sum.disconnect(this.fader); } catch { }
    fin.connect(this.fader);
    this.sum.connect(fin);
    w.connect(this.sum);
    try { this.limIn.disconnect(); } catch { }
    this.limIn.connect(w);
    try { this.limiter.disconnect(); } catch { }
    this.wlim = w; this.wfin = fin;
  }

  _attach() {
    if (!this.ctx || !this._raw || this.bufs) return;
    const c = this.ctx, raw = this._raw;
    const mk = (data, sr = RSR) => { const b = c.createBuffer(1, data.length, sr); b.getChannelData(0).set(data); return b; };
    const mk2 = (chs, sr = RSR) => { const b = c.createBuffer(chs.length, chs[0].length, sr); chs.forEach((d, i) => b.getChannelData(i).set(d)); return b; };
    const bufs = {};
    for (const [name, arr] of Object.entries(raw.banks)) bufs[name] = arr.map((d) => mk(d));
    this.noise = mk(raw.noise);
    this.pink = mk2(raw.pink);
    this.bufs = bufs;
    // convolver set-up does its FFT partitioning synchronously: keep it off the gesture's frame
    const setVerb = () => { try { this.verb.buffer = mk2(raw.ir); } catch (e) { this._fail(e); } };
    if (this._offline) setVerb(); else setTimeout(setVerb, 30);
    this._attachCrowd();
    if (this.ambienceOn) this._startAmbience();
    if ((SHOT || AUDIOTEST) && !this._offline) this._selfTest();
    if (!this._offline) this._flushPending();
  }
  _attachCrowd() {
    if (!this.ctx || !this._crowdRaw) return;
    const c = this.ctx;
    for (const [k, v] of Object.entries(this._crowdRaw)) {
      if (this.crowd[k]) continue;
      const b = c.createBuffer(2, v.len, CSR); b.getChannelData(0).set(v.L.subarray(0, v.len)); b.getChannelData(1).set(v.R.subarray(0, v.len));
      this.crowd[k] = b;
    }
    if (this._amb) this._startBabble();
  }

  // User fader (after the limiter and the final ceiling): dB taper of the slider, 0 when muted. The fixed
  // DRIVE in front of the limiter sets the dynamics; this only sets how loud the finished mix is played.
  _faderLevel() { return this.muted ? 0 : faderGain(this.volume); }
  get ready() { return !!this.ctx && !!this.bufs && (SHOT || (!this.muted && this.ctx.state === 'running')); }
  setMuted(m) {
    this.muted = !!m; this._save();
    clearTimeout(this._muteTimer);
    if (!this.ctx) return;
    if (this.muted) {
      // remember the throw in flight (or one still waiting for the context) so unmuting can pick it up
      if (this._pendingThrow) this._throwInfo = this._pendingThrow;
      this._pendingThrow = null; this._pending = [];
      if (this._throwInfo) this._resumeInfo = this._throwInfo;
      this.cancelThrow();
      this._applyMaster();
      // after the fade, suspend the whole context: room tone, babble loops, LFO and convolver stop burning CPU
      if (!SHOT && !AUDIOTEST) this._muteTimer = setTimeout(() => {
        if (!this.muted || !this.ctx) return;
        this._muteSuspended = true;
        try { if (this.ctx.state === 'running') this.ctx.suspend(); } catch { }
      }, 900);
    } else {
      // same path as the tab-hide return: reschedule whatever is left of a throw that is still animating
      const go = () => { this._applyMaster(); this._resumeThrow(); };
      let hidden = false; try { hidden = !!document.hidden; } catch { }
      this._muteSuspended = false;
      if (this.ctx.state !== 'running' && hidden) {
        // unmuted from a background tab: leave the context asleep and keep the throw for later; flagging it
        // auto-suspended hands the wake-up to the visibilitychange return path (resume + _resumeThrow)
        this._applyMaster();
        this._autoSuspended = true;
      } else if (this.ctx.state !== 'running') {
        try { const p = this.ctx.resume(); if (p && p.then) p.then(go, go); else go(); } catch { go(); }
      } else go();
    }
  }
  setCallouts(on) { this.callouts = !!on; this._callSet = true; this._save(); }
  /** Sound profile: false = Realistic (no music bus on wins), true = add win chimes / stingers. */
  setChimes(on) { this.chimes = !!on; this._save(); }
  setVolume(v) { this.volume = clamp(Number(v) || 0, 0, 1); this._applyMaster(); this._save(); }
  _applyMaster() {
    if (!this.fader) return;
    this.fader.gain.setTargetAtTime(this._faderLevel(), this.ctx.currentTime, 0.04); // bed and foreground alike
  }
  setAmbience(on) {
    this.ambienceOn = !!on; this._ambSet = true; this._save();
    if (!this.ctx || !this.bufs) return;
    try { if (on) this._startAmbience(); else this._stopAmbience(); } catch (e) { this._fail(e); }
  }

  // ---------- low-level voices (every node created is disconnected when the voice ends) ----------
  _release(nodes) { for (const n of nodes) { try { n.disconnect(); } catch { } } }
  /** Route a voice's output: dry to `bus` (or the ambience dry path) and a reverb send. */
  _route(node, nodes, { bus, amb, wet }) {
    const c = this.ctx;
    node.connect(amb ? this.duckDry : bus || this.sfx);
    if (wet > 0) { const s = c.createGain(); s.gain.value = wet; node.connect(s); s.connect(amb ? this.duckWet : this.verbIn); nodes.push(s); }
  }
  /** Play a buffer. opts: t, gain, rate, pan, wet, lp, hp, bus, amb, priority(0..1) */
  /**
   * Voice budget on the audio clock. Every scheduled source registers its window [start, end]; a new
   * voice is gated on the peak number of windows that will actually be sounding together during ITS
   * window, not on how many sources happen to be queued (a whole throw is scheduled at throw start).
   * Low-priority layers (< 0.6: felt grains, ambient chips, sweetener layers) are thinned first; dice
   * impacts, stingers and UI are only refused at the hard CPU cap.
   */
  _admit(t, dur, priority) {
    const now = this.ctx.currentTime, w = this._vw, e = t + dur;
    if (w.length > 48) { let j = 0; for (let i = 0; i < w.length; i++) if (w[i][1] > now) w[j++] = w[i]; w.length = j; }
    const ov = [];
    for (const v of w) if (v[0] < e && v[1] > t) ov.push(v);
    let peak = 0;
    if (ov.length > (priority < 0.6 ? VOICE_SOFT : VOICE_HARD)) {
      // concurrency at the new window's start and at every later onset inside it
      const pts = [t]; for (const v of ov) if (v[0] > t) pts.push(v[0]);
      for (const p of pts) { let k = 0; for (const v of ov) if (v[0] <= p && v[1] > p) k++; if (k > peak) peak = k; }
    }
    if ((priority < 0.6 && peak >= VOICE_SOFT) || peak >= VOICE_HARD) {
      this._stats.dropped++; if (priority >= 0.6) this._stats.droppedHi++;
      return false;
    }
    const win = [t, e];
    w.push(win);
    return win;
  }
  _play(buf, { t = 0, gain = 1, rate = 1, pan = 0, wet = 0.12, lp = 0, hp = 0, bus = null, amb = false, priority = 0.5 } = {}) {
    if (!buf) return null;
    const c = this.ctx;
    t = Math.max(c.currentTime, t || c.currentTime);
    const win = this._admit(t, buf.duration / Math.max(0.05, rate), priority);
    if (!win) return null;
    const src = c.createBufferSource(); src.buffer = buf; src.playbackRate.value = rate; src._vw = win;
    const nodes = [src];
    let node = src;
    if (lp && lp < 20000) { const f = c.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = lp; f.Q.value = 0.5; node.connect(f); node = f; nodes.push(f); }
    if (hp) { const f = c.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = hp; f.Q.value = 0.5; node.connect(f); node = f; nodes.push(f); }
    const g = c.createGain(); g.gain.value = gain; node.connect(g); node = g; nodes.push(g);
    if (pan && c.createStereoPanner) { const p = c.createStereoPanner(); p.pan.value = clamp(pan, -1, 1); node.connect(p); node = p; nodes.push(p); }
    this._route(node, nodes, { bus, amb, wet });
    this._voices++;
    src.onended = () => { this._voices--; this._release(nodes); };
    src.start(t);
    if (this._capture) this._capture.push(src);
    return src;
  }
  _now(delay = 0) { return Math.max(this.ctx.currentTime, (this._tFreeze ?? this.ctx.currentTime) + (this._base || 0) + 0.004 + Math.max(0, delay)); }

  /** Shaped filtered noise (whooshes, rustle, sweeps, claps). */
  _noise(t, dur, { type = 'bandpass', freq = 1000, freqEnd = 0, q = 1, gain = 0.2, attack = 0.01, pan = 0, wet = 0.1, bus = null, amb = false, buffer = null, priority = 0.5 } = {}) {
    const c = this.ctx;
    t = Math.max(c.currentTime, Number.isFinite(t) ? t : 0); // guard: never schedule in the past / negative
    const win = this._admit(t, dur + 0.05, priority);
    if (!win) return;
    const src = c.createBufferSource(); src.buffer = buffer || this.noise; src.loop = true; src._vw = win;
    const f = c.createBiquadFilter(); f.type = type; f.Q.value = q;
    f.frequency.setValueAtTime(freq, t); if (freqEnd) f.frequency.exponentialRampToValueAtTime(freqEnd, t + dur);
    const g = c.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(gain, t + attack); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f); f.connect(g); let node = g;
    const nodes = [src, f, g];
    if (pan && c.createStereoPanner) { const p = c.createStereoPanner(); p.pan.value = clamp(pan, -1, 1); node.connect(p); node = p; nodes.push(p); }
    this._route(node, nodes, { bus, amb, wet });
    this._voices++; src.onended = () => { this._voices--; this._release(nodes); };
    src.start(t, urand() * 1.5); src.stop(t + dur + 0.05);
    if (this._capture) this._capture.push(src);
  }

  /** Warm synth pad note (detuned band-limited oscillators through an enveloped low-pass). */
  _pad(t, freq, dur, { gain = 0.08, cutoff = 2200, cutoffStart = 500, attack = 0.06, release = 0.7, pan = 0, wet = 0.35, type = 'sawtooth', bus = null, detune = [-7, 6] } = {}) {
    const c = this.ctx; t = Math.max(c.currentTime, Number.isFinite(t) ? t : 0);
    const f = c.createBiquadFilter(); f.type = 'lowpass'; f.Q.value = 0.7;
    f.frequency.setValueAtTime(cutoffStart, t); f.frequency.exponentialRampToValueAtTime(cutoff, t + attack + 0.08); f.frequency.exponentialRampToValueAtTime(Math.max(150, cutoff * 0.45), t + dur + release);
    const g = c.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(gain, t + attack); g.gain.setValueAtTime(gain * 0.85, t + attack + dur); g.gain.exponentialRampToValueAtTime(0.0001, t + attack + dur + release);
    f.connect(g); let node = g;
    const nodes = [f, g];
    if (pan && c.createStereoPanner) { const p = c.createStereoPanner(); p.pan.value = pan; node.connect(p); node = p; nodes.push(p); }
    this._route(node, nodes, { bus: bus || this.music, wet });
    const oscs = detune.map((cents) => { const o = c.createOscillator(); o.type = type; o.frequency.value = freq; o.detune.value = cents; o.connect(f); nodes.push(o); return o; });
    this._voices += oscs.length;
    for (let i = 0; i < oscs.length; i++) this._vw.push([t, t + attack + dur + release + 0.1]); // pads are never dropped, but count toward the budget
    let alive = oscs.length;
    for (const o of oscs) {
      o.onended = () => { this._voices--; if (--alive === 0) this._release(nodes); };
      o.start(t); o.stop(t + attack + dur + release + 0.1);
    }
  }

  /** Struck-bar chime note. Sends are kept low (the room is dead) so wins sound close and punchy. */
  _bell(t, freq, { gain = 0.2, pan = 0, wet = 0.2, bus = null, amb = false, lp = 0 } = {}) {
    const hi = freq >= 1500, base = hi ? BELL_HI : BELL_BASE;
    return this._play(pick(hi ? this.bufs.bellHi : this.bufs.bell), { t, gain, rate: (freq / base) * rand(0.9992, 1.0008), pan, wet, bus: bus || this.music, amb, priority: 0.9, lp });
  }
  /** Low wooden mallet note (seven-out motif). */
  _mallet(t, freq, { gain = 0.2, pan = 0, wet = 0.15, lp = 0 } = {}) {
    return this._play(pick(this.bufs.marimba), { t, gain, rate: freq / MARIMBA_BASE, pan, wet, bus: this.music, priority: 0.9, lp });
  }
  _duckAmbience(amount = 0.45, hold = 1.2) {
    const t = this.ctx.currentTime + (this._base || 0);
    for (const g of [this.duckDry.gain, this.duckWet.gain]) { g.cancelScheduledValues(t); g.setTargetAtTime(amount, t, 0.05); g.setTargetAtTime(1, t + hold, 0.6); }
    return ++this._duckTok;
  }

  /** Stereo position of a world point as seen by the camera: -1 (left of view) .. 1 (right). */
  _panAt(x = 0, y = 0, z = 0) {
    const cam = this.camera;
    if (!cam || !cam.matrixWorld) return clamp((Number(x) || 0) / 17, -1, 1) * 0.7;
    const e = cam.matrixWorld.elements;
    const rx = x - e[12], ry = y - e[13], rz = z - e[14];
    const lateral = rx * e[0] + ry * e[1] + rz * e[2];     // camera right axis
    const depth = -(rx * e[8] + ry * e[9] + rz * e[10]);  // camera looks down -z
    return clamp(Math.atan2(lateral, Math.max(0.5, depth)) / 0.75, -1, 1) * 0.75;
  }

  // ---------- dice ----------
  /** Dice shaken in the cupped hand before the throw; `dur` is the real-time length of the pickup. */
  rattle(dur = 0.38) {
    const d0 = Number(dur);
    const d = clamp(Number.isFinite(d0) ? d0 : 0.38, 0, 1.2);
    // too short for a believable shake (fast / turbo speeds): just the release whoosh
    if (d < 0.15) { this.throwRelease(d); return; }
    const t0 = this._now();
    const pan = this._panAt(-7.5, 3, 4.4); // shooter's hand position
    // 2-3 shakes (~4-6 Hz, a real hand), leaving the last ~12 % for the release
    const shakes = clamp(Math.round(d / 0.16), 2, 3);
    const period = (d * 0.88) / shakes;
    for (let s = 0; s < shakes; s++) {
      const ts = t0 + s * period + rand(-0.006, 0.006);
      const last = s === shakes - 1;
      // the palm is closed around the dice: everything is muffled, opening a little on the last shake
      const lpBase = last ? 3600 : 2400;
      // upstroke: the dice lift off the palm, one or two light knocks
      const up = 1 + ((urand() * 2) | 0);
      for (let h = 0; h < up; h++) {
        this._play(pick(this.bufs.dice), { t: ts + h * rand(0.014, 0.024), gain: RATTLE_G * rand(0.05, 0.09), rate: rand(0.8, 1.0), lp: lpBase * 0.8, pan: pan + rand(-0.05, 0.05), wet: 0.04, priority: 0.65, bus: this.diceBus });
      }
      // downstroke (accent): both dice slam into the palm and into each other
      const td = ts + period * rand(0.46, 0.54);
      this._play(pick(this.bufs.felt), { t: td, gain: RATTLE_G * rand(0.16, 0.22), rate: rand(0.45, 0.55), lp: 900, pan, wet: 0.02, priority: 0.7, bus: this.diceBus }); // palm thump
      const down = 2 + ((urand() * 2) | 0);
      for (let h = 0; h < down; h++) {
        const t = td + rand(0.001, 0.004) + h * rand(0.008, 0.02);
        this._play(pick(this.bufs.dice), { t, gain: RATTLE_G * rand(0.17, 0.27) * (h ? 0.7 : 1) * (last ? 1.1 : 1), rate: rand(0.85, 1.08), lp: lpBase + rand(0, 700), pan: pan + rand(-0.06, 0.06), wet: 0.05, priority: 0.75, bus: this.diceBus });
      }
      this._noise(ts, period * 0.95, { freq: rand(1300, 2000), q: 0.8, gain: 0.014 * RATTLE_G, attack: period * 0.45, pan, wet: 0, bus: this.diceBus }); // skin / palm rustle
    }
    this.throwRelease(d);
  }
  /** Airy whoosh as the dice leave the hand (`delay` = time until release). */
  throwRelease(delay = 0) {
    const t = this._now(Math.max(0, delay - 0.05));
    this._noise(t, 0.26, { freq: 500, freqEnd: 2200, q: 1.4, gain: 0.026, attack: 0.06, pan: this._panAt(-6, 3, 4), wet: 0.06 });
  }

  /**
   * Continuous felt scuff / roll layer for a recorded throw: a band-passed felt "brush" per die whose
   * level and brightness follow the die's speed while it is in contact with the felt (sim.slide).
   * delay = real seconds until sim time 0; speed = playback speed.
   */
  diceRoll(sim, { delay = 0, speed = 1 } = {}) {
    if (!sim || !Array.isArray(sim.slide) || !sim.slide.length) return;
    const c = this.ctx, fps = sim.fps || 60, t0 = this._now(delay), sp = Math.max(0.1, speed);
    this._stopRoll();
    this._roll = [];
    const end = t0 + sim.slide.length / fps / sp + 0.15;
    const tumble = this._tumbleRates(sim);
    for (let die = 0; die < 2; die++) {
      const src = c.createBufferSource(); src.buffer = this.pink; src.loop = true;
      const bp = c.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 0.8; bp.frequency.value = 1400;
      const hp = c.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 350;
      const g = c.createGain(); g.gain.value = 0;
      const am = c.createGain(); am.gain.value = 0.55; // tumble-rate amplitude modulation (face/edge strikes)
      const p = c.createStereoPanner ? c.createStereoPanner() : null;
      src.connect(bp); bp.connect(hp); hp.connect(g); g.connect(am);
      const nodes = [src, bp, hp, g, am];
      let node = am; if (p) { am.connect(p); node = p; nodes.push(p); }
      this._route(node, nodes, { bus: this.diceBus, wet: 0.04 });
      g.gain.setValueAtTime(0, t0); bp.frequency.setValueAtTime(700, t0); am.gain.setValueAtTime(0.55, t0);
      if (p) p.pan.setValueAtTime(this._panAt(-7, 2, 4), t0);
      for (let k = 0; k < sim.slide.length; k += 2) { // 30 Hz control rate is plenty for the bed itself
        const s = sim.slide[k][die] || 0;
        const lv = s > 0.3 ? ROLL_G * Math.pow(Math.min(1, s / 22), 1.1) : 0;
        const t = t0 + k / fps / sp;
        g.gain.linearRampToValueAtTime(lv, t);
        bp.frequency.linearRampToValueAtTime(700 + 2300 * Math.min(1, s / 20), t);
        if (p && sim.frames?.[k]) { const f = sim.frames[k].p; p.pan.linearRampToValueAtTime(this._panAt(f[die * 3], f[die * 3 + 1], f[die * 3 + 2]), t); }
      }
      g.gain.linearRampToValueAtTime(0, end - 0.1);
      // Tumbling on the felt: every quarter turn about a horizontal axis an edge/face strikes the cloth.
      // Retrigger a tiny felt grain at each strike (jittered) and pulse the scuff bed with it.
      const w = tumble[die];
      let ph = urand(), lastG = -1;
      for (let k = 0; k < sim.slide.length && w; k++) {
        const s = sim.slide[k][die] || 0, om = w[k] || 0;
        if (s <= 0 || om < 1.5) continue;         // airborne (or not really tumbling): phase holds
        const step = om / (Math.PI / 2) / fps;    // strikes per recorded frame
        ph += step;
        while (ph >= 1) {
          ph -= 1;
          const frac = clamp(1 - ph / step, 0, 1);
          const tg = t0 + (k - 1 + frac) / fps / sp + rand(-0.0025, 0.0025);
          const energy = Math.min(1, om / 38) * (0.55 + 0.45 * Math.min(1, s / 10));
          if (energy < 0.05 || tg - lastG < 0.016 || tg < t0) continue;
          lastG = tg;
          const fp = sim.frames?.[k]?.p;
          const gp = fp ? this._panAt(fp[die * 3], fp[die * 3 + 1], fp[die * 3 + 2]) : 0;
          this._play(pick(this.bufs.grain), { t: tg, gain: GRAIN_G * Math.pow(energy, 1.25) * rand(0.65, 1.15), rate: rand(0.85, 1.2), pan: gp, wet: 0.03, lp: 1400 + 6000 * energy, priority: 0.3, bus: this.diceBus });
          am.gain.setValueAtTime(1, tg);
          am.gain.setTargetAtTime(0.42, tg + 0.003, clamp(0.3 / Math.max(1, step * fps * sp), 0.006, 0.03));
        }
      }
      this._voices++; this._vw.push([t0, end]); src.onended = () => { this._voices--; this._release(nodes); };
      src.start(t0, urand() * 3); src.stop(end);
      this._roll.push({ src, g });
      if (this._capture) this._capture.push(src);
    }
  }
  _stopRoll() {
    if (!this._roll || !this.ctx) return;
    const t = this.ctx.currentTime;
    for (const { src, g } of this._roll) { try { g.gain.cancelScheduledValues(t); g.gain.setTargetAtTime(0, t, 0.015); src.stop(t + 0.08); } catch { } }
    this._roll = null;
  }
  /** Per die, per recorded frame: angular speed about horizontal axes (rad/s, sim time) from the quaternions. */
  _tumbleRates(sim) {
    const F = sim.frames, fps = sim.fps || 60;
    if (!Array.isArray(F) || F.length < 2 || !F[0].q) return [null, null];
    return [0, 1].map((i) => {
      const w = new Float32Array(F.length);
      for (let k = 1; k < F.length; k++) {
        const a = F[k - 1].q, b = F[k].q, o = i * 4;
        // dq = b * conj(a)  (world-frame rotation over one frame)
        const ax = -a[o], ay = -a[o + 1], az = -a[o + 2], aw = a[o + 3];
        const bx = b[o], by = b[o + 1], bz = b[o + 2], bw = b[o + 3];
        let x = bw * ax + bx * aw + by * az - bz * ay;
        const y = bw * ay - bx * az + by * aw + bz * ax;
        let z = bw * az + bx * ay - by * ax + bz * aw;
        let ww = bw * aw - bx * ax - by * ay - bz * az;
        if (ww < 0) { ww = -ww; x = -x; z = -z; }
        const ang = 2 * Math.acos(Math.min(1, ww)), sn = Math.sqrt(Math.max(1e-12, 1 - ww * ww));
        const horiz = Math.min(1, Math.sqrt(x * x + z * z) / sn); // y is up: ignore pure yaw spin
        w[k] = ang * fps * horiz;
      }
      return w;
    });
  }
  /**
   * Schedule a whole recorded throw on the audio clock at once: the hand rattle, release whoosh, the felt
   * roll bed and every physics impact, all from one shared time base. Impacts are sample-accurate (the
   * two dice landing 10-15 ms apart keep their flam) instead of snapping to render frames.
   * pickup = sim-time length of the pickup (s), speed = playback multiplier.
   */
  throwDice(sim, { pickup = 0.38, speed = 1 } = {}) {
    if (!sim) return;
    this.cancelThrow();
    const sp = Math.max(0.1, Number(speed) || 1), del = Math.max(0, Number(pickup) || 0) / sp;
    // same time base as main.js drives the dice animation with (wall clock + output latency)
    this._throwInfo = { sim, sp, del, wall0: performance.now() + this.latency * 1000 };
    this._scheduleThrow(sim, sp, del, 0);
  }
  /**
   * Schedule a throw whose first `elapsed` real seconds have already happened (0 = from the start):
   * only the impacts and roll-bed frames still ahead of the animation are scheduled.
   */
  _scheduleThrow(sim, sp, del, elapsed) {
    this._tFreeze = this.ctx.currentTime; this._capture = [];
    try {
      if (elapsed <= 0) this.rattle(del);
      else if (elapsed < del) this.rattle(del - elapsed); // late start: the rest of the shake (or just the release whoosh when too short)
      const simFrom = (elapsed - del) * sp; // sim time the animation has already shown (< 0 during pickup)
      // impacts BEFORE the felt roll bed + grains: grains are the only layer the voice budget may thin
      for (const imp of sim.impacts || []) {
        if (elapsed > 0 && imp.t <= simFrom + 0.004) continue;
        this.diceHit(imp.type, imp.strength, del + imp.t / sp - elapsed, imp.x, imp.z, imp.die, imp.closing);
      }
      if (simFrom <= 0) this.diceRoll(sim, { delay: del - Math.max(0, elapsed), speed: sp });
      else if (Array.isArray(sim.slide)) {
        const k0 = Math.floor(simFrom * (sim.fps || 60));
        if (k0 < sim.slide.length - 2) this.diceRoll({ fps: sim.fps, slide: sim.slide.slice(k0), frames: Array.isArray(sim.frames) ? sim.frames.slice(k0) : null }, { delay: 0, speed: sp });
      }
    } finally {
      this._throwSrcs = this._capture; this._capture = null; this._tFreeze = null;
    }
  }
  /** After a tab hide: reschedule the rest of a throw that is still animating (sim.impacts with t > anim.t). */
  _resumeThrow() {
    const T = this._resumeInfo;
    if (!T || T !== this._throwInfo) { this._resumeInfo = null; return; }
    if (!this.ready) return; // kept: _flushPending (context running + samples attached) retries it
    this._resumeInfo = null;
    // + latency: what is scheduled now is heard that much later, while the animation keeps running
    const elapsed = (performance.now() - T.wall0) / 1000 + this.latency;
    if (elapsed >= T.del + (T.sim.duration || 0) / T.sp) return; // the dice already came to rest
    this._scheduleThrow(T.sim, T.sp, T.del, Math.max(0.001, elapsed));
  }
  /** Abort the throw in flight: stop every scheduled hit / grain and fade the roll bed. */
  cancelThrow() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    for (const s of this._throwSrcs) { try { s.stop(t + 0.005); } catch { } if (s._vw) s._vw[1] = Math.min(s._vw[1], t + 0.005); }
    this._throwSrcs = [];
    // forget the cancelled hits' (future) de-flicker / flurry state, so a rescheduled throw is not merged away
    for (const k of Object.keys(this._lastHit)) if (/^(felt|wall|dice)\d$/.test(k)) delete this._lastHit[k];
    this._burst = { t: 0, e: 0 };
    try { this._stopRoll(); } catch { }
  }

  /**
   * Physics impact. type: 'felt' | 'wall' | 'dice'; closing = raw closing speed along the contact normal
   * (physics.js), mapped by impactLevel(); without it `strength` (0..1) is used as the level directly.
   * x/z = world position for stereo; die = 0|1 (2 for die-on-die).
   */
  diceHit(type, strength = 0.5, delay = 0, x = 0, z = 0, die = 0, closing = null) {
    const kind = type === 'wall' ? 'wall' : type === 'dice' ? 'dice' : 'felt';
    const s = closing != null && Number.isFinite(Number(closing)) ? impactLevel(kind, closing) : clamp(Number(strength) || 0, 0, 1);
    this._stats.hitsIn++;
    if (s < 0.02) { this._stats.silent = (this._stats.silent || 0) + 1; return; }
    const t = this._now(delay);
    // de-flicker per die and surface: only solver chatter (< 6-8 ms, weaker than the slam) collapses into
    // one hit; edge rolls and settle rocks 15-20 ms apart all play, and the two dice landing 10-15 ms
    // apart keep their "ka-tok" flam (separate keys per die)
    const key = kind + (die | 0);
    if (t - (this._lastHit[key] || 0) < (kind === 'felt' ? 0.008 : 0.006) && s < 0.5) { this._stats.merged = (this._stats.merged || 0) + 1; return; }
    this._lastHit[key] = t;
    // very dense flurries get slightly quieter (avoids a wall of clicks while tumbling) without
    // flattening the slam-vs-settle dynamics
    const now = t; // scheduled time, so delayed or offline-scheduled hits decay correctly
    this._burst.e *= Math.exp(-Math.max(0, now - this._burst.t) / 0.1); this._burst.t = Math.max(this._burst.t, now); this._burst.e += s;
    const crowd = 1 / (1 + Math.max(0, this._burst.e - 2) * 0.2);
    const loud = DICE_G * s * crowd;
    const tickG = DICE_G * Math.pow(s, 0.8) * crowd;
    const pan = this._panAt(x, 0.15, z);
    const bright = 0.35 + 0.65 * s; // softer hits are darker
    // every layer of a real impact is high priority: the soft settle taps at the end of a throw are what
    // make the dice sound like they come to rest, so the voice budget must never drop them
    let src;
    if (kind === 'felt') {
      src = this._play(pick(this.bufs.felt), { t, gain: 1.0 * loud, rate: rand(0.92, 1.1), pan, wet: 0.16, lp: 1800 + 9000 * bright, priority: 0.7 + 0.3 * s, bus: this.diceBus });
      this._play(pick(this.bufs.tick), { t: t + rand(0, 0.0015), gain: 0.34 * tickG, rate: rand(0.9, 1.12), pan, wet: 0.03, lp: 3500 + 9000 * bright, priority: 0.65 + s * 0.3, bus: this.diceBus });
    } else if (kind === 'wall') {
      src = this._play(pick(this.bufs.wall), { t, gain: 0.85 * loud, rate: rand(0.92, 1.08), pan, wet: 0.18, lp: 2500 + 9000 * bright, priority: 0.9, bus: this.diceBus });
      this._play(pick(this.bufs.tick), { t: t + rand(0.001, 0.003), gain: 0.32 * tickG, rate: rand(0.85, 1.05), pan, wet: 0.06, priority: 0.7, bus: this.diceBus });
    } else {
      src = this._play(pick(this.bufs.dice), { t, gain: 0.6 * loud, rate: rand(0.9, 1.12), pan, wet: 0.08, lp: 4000 + 12000 * bright, priority: 0.8, bus: this.diceBus });
    }
    if (src) this._stats.hitsPlayed++; // counted only when the voice budget actually admitted it
  }

  // ---------- chips ----------
  /** Chips landing on a bet / stack. Called as individual chips land (count per frame). */
  /** Pan for a world-position argument ({x,y,z} or [x,y,z]); `fallback` when none is given. */
  _panPos(pos, fallback = 0) {
    if (!pos) return fallback;
    const x = pos.x ?? pos[0], y = pos.y ?? pos[1] ?? 0, z = pos.z ?? pos[2];
    return Number.isFinite(x) && Number.isFinite(z) ? this._panAt(x, Number(y) || 0, z) : fallback;
  }
  chips(count = 1, delay = 0, pos = null) {
    const n = clamp(count | 0, 1, 8);
    const t0 = this._now(delay), pan = this._panPos(pos, 0.05);
    for (let i = 0; i < n; i++) {
      const t = Math.max(t0 + i * rand(0.022, 0.04), (this._lastHit.chip || 0) + 0.012);
      this._lastHit.chip = t;
      const g = rand(0.32, 0.46) / Math.sqrt(1 + i * 0.3);
      const p = pan + rand(-0.04, 0.04);
      this._play(pick(this.bufs.chip), { t, gain: g, rate: rand(0.9, 1.12), pan: p, wet: 0.1, priority: 0.7 });
      if (urand() < 0.5) this._play(pick(this.bufs.chipFelt), { t, gain: g * 0.5, rate: rand(0.9, 1.1), pan: p, wet: 0.04, priority: 0.3 });
    }
  }
  /** Chips arriving back on the player's rail (winnings, take-downs, pushes): quieter and woodier. */
  chipsRail(count = 1, pos = null) {
    const n = clamp(count | 0, 1, 5);
    const t0 = this._now(), pan = this._panPos(pos, this._panAt(-9.5, 1, 7.5));
    for (let i = 0; i < n; i++) {
      const t = Math.max(t0 + i * rand(0.02, 0.035), (this._lastHit.rail || 0) + 0.02);
      this._lastHit.rail = t;
      const g = rand(0.13, 0.2) / Math.sqrt(1 + i * 0.4);
      const p = pan + rand(-0.05, 0.05);
      this._play(pick(this.bufs.chipRail), { t, gain: g, rate: rand(0.9, 1.08), pan: p, wet: 0.06, lp: 5000, priority: 0.5 });
      if (urand() < 0.5) this._play(pick(this.bufs.chip), { t: t + rand(0.004, 0.012), gain: g * 0.45, rate: rand(0.85, 1.0), pan: p, lp: 4200, wet: 0.05, priority: 0.3 });
    }
  }
  /**
   * Dealer building a payout stack beside the bet (fired by chips.js when the last payout chip lands):
   * the fingers square the chips against each other (soft scrape), an accelerating riffle of clacks, then
   * the stack tapped down square on the felt. `count` = chips in the payout.
   */
  chipStack(count = 5, delay = 0, pos = null) {
    const c = Math.max(1, count | 0), n = clamp(2 + c * 2, 4, 12);
    const pan = this._panPos(pos, 0.1);
    let t = Math.max(this._now(delay), (this._lastHit.chip || 0) + 0.025), dt = 0.052;
    this._noise(t - 0.01, 0.06 + n * 0.018, { type: 'bandpass', freq: rand(2800, 3600), q: 1.1, gain: 0.012, attack: 0.02, pan, wet: 0.03, priority: 0.4 });
    for (let i = 0; i < n; i++) {
      this._play(pick(this.bufs.chip), { t, gain: rand(0.2, 0.3) * (0.8 + 0.25 * i / n), rate: rand(0.95, 1.14), pan: pan + rand(-0.04, 0.04), wet: 0.08, lp: 7500, priority: 0.65 });
      t += dt * rand(0.8, 1.15); dt = Math.max(0.016, dt * 0.83);
    }
    const tt = t + rand(0.035, 0.05); // squared down: one heavier "tock" of the whole stack on the cloth
    this._play(pick(this.bufs.chipFelt), { t: tt, gain: 0.34, rate: rand(0.85, 0.95), pan, wet: 0.05, priority: 0.7 });
    this._play(pick(this.bufs.chip), { t: tt + 0.001, gain: 0.2, rate: rand(0.82, 0.92), pan, wet: 0.08, lp: 5000, priority: 0.7 });
    this._lastHit.chip = tt;
  }
  /** Player picking chips up off the layout (the rail drop comes from the chip animation's landing). */
  chipsTake(count = 1, pos = null) {
    const n = clamp(count | 0, 1, 6);
    const t0 = this._now(), pan = this._panPos(pos, 0);
    this._noise(t0, 0.12, { type: 'highpass', freq: 2500, gain: 0.022, attack: 0.02, pan, wet: 0 }); // fingers sliding
    for (let i = 0; i < Math.min(3, n + 1); i++) this._play(pick(this.bufs.chip), { t: t0 + 0.02 + i * rand(0.018, 0.03), gain: rand(0.14, 0.22), rate: rand(1.0, 1.15), pan: pan + rand(-0.04, 0.04), lp: 6000, wet: 0.06, priority: 0.5 });
  }
  /**
   * Dealer sweeping losing chips off a bet (fired by the chip animation as the slide starts). The felt
   * drag and the stack's own rattle scale with the number of chips moving.
   */
  sweep(count = 1, pos = null, dur = 0.42) {
    const n = clamp(count | 0, 1, 40);
    const t = this._now(), pan = this._panPos(pos, 0.2), size = Math.min(1, Math.sqrt(n) / 4.5);
    // hand + chips dragged across the cloth: band-passed noise falling in brightness as it slows
    this._noise(t, dur + 0.06, { type: 'bandpass', freq: rand(1900, 2300), freqEnd: 900, q: 0.7, gain: 0.014 + 0.02 * size, attack: 0.03, pan, wet: 0.05 });
    this._noise(t, dur * 0.8, { type: 'lowpass', freq: 700, freqEnd: 300, q: 0.5, gain: 0.01 + 0.012 * size, attack: 0.02, pan, wet: 0 });
    // chips in the stack knocking against each other as it starts moving
    const k = Math.min(6, 1 + Math.round(Math.sqrt(n)));
    for (let i = 0; i < k; i++) this._play(pick(this.bufs.chip), { t: t + rand(0.0, dur * 0.6), gain: rand(0.05, 0.09) * (0.7 + 0.3 * size), rate: rand(0.85, 1.0), lp: 3600, pan: pan + rand(-0.04, 0.04), wet: 0.06, priority: 0.35 });
  }
  /** Swept chips dropping into the house bank / dealer's tray: a clack cluster sized by the chip count. */
  bankLand(count = 1, pos = null) {
    const n = clamp(count | 0, 1, 40);
    const t0 = this._now(), pan = this._panPos(pos, 0.35);
    const k = Math.min(9, 1 + Math.round(Math.sqrt(n) * 1.6));
    for (let i = 0; i < k; i++) {
      const t = Math.max(t0 + Math.pow(urand(), 1.5) * (0.03 + 0.012 * k), (this._lastHit.bank || 0) + 0.008);
      this._lastHit.bank = t;
      this._play(pick(this.bufs.chip), { t, gain: rand(0.09, 0.16) / Math.sqrt(1 + i * 0.2), rate: rand(0.82, 0.98), lp: 4200, pan: pan + rand(-0.05, 0.05), wet: 0.12, priority: 0.45 });
      if (i === 0) this._play(pick(this.bufs.chipRail), { t, gain: 0.1, rate: rand(0.9, 1.0), lp: 3000, pan, wet: 0.08, priority: 0.4 });
    }
  }

  puck(pos = null) {
    this._play(pick(this.bufs.puck), { t: this._now(), gain: 0.5, rate: rand(0.95, 1.05), pan: this._panPos(pos, 0), wet: 0.1, priority: 0.9 });
  }
  click() { this._play(this.bufs.ui[0], { t: this._now(), gain: 0.35, rate: rand(0.97, 1.03), wet: 0.02, bus: this.ui, priority: 1 }); }
  error() {
    const t = this._now();
    this._pad(t, 233.1, 0.06, { gain: 0.05, cutoff: 900, cutoffStart: 400, attack: 0.01, release: 0.12, wet: 0.05, type: 'triangle', bus: this.ui });
    this._pad(t + 0.1, 185, 0.08, { gain: 0.05, cutoff: 800, cutoffStart: 400, attack: 0.01, release: 0.16, wet: 0.05, type: 'triangle', bus: this.ui });
  }

  // ---------- results ----------
  /**
   * Win chime; size 0..1 picks the tier. Notes come from the C major pentatonic (C D E G A); every tier
   * has several voicings / inversions, humanised onsets and velocities, and the mid and big tiers
   * resolve on the tonic. opts.gain scales the whole gesture (e.g. a Don't player's win under a groan).
   */
  win(size = 0.3, { gain = 1 } = {}) {
    const s = clamp(Number(size) || 0, 0, 1), G = clamp(gain, 0, 1.5);
    const t0 = this._now(0.03);
    const tier = s > 0.6 ? 'big' : s > 0.25 ? 'mid' : 'small';
    let notes = pick(WIN_VOICINGS[tier]).slice();
    // avoid playing the same voicing twice in a row
    if (this._lastVoicing === tier + notes.join() && WIN_VOICINGS[tier].length > 1) notes = WIN_VOICINGS[tier].find((v) => v.join() !== notes.join()).slice();
    this._lastVoicing = tier + notes.join();
    if (tier === 'small' && urand() < 0.3) notes = notes.map((m) => m - 12); // occasional lower register
    let gap = tier === 'big' ? rand(0.06, 0.072) : rand(0.058, 0.082), t = t0;
    notes.forEach((m, i) => {
      const last = i === notes.length - 1;
      const pan = (i / Math.max(1, notes.length - 1) - 0.5) * 0.6 + rand(-0.06, 0.06);
      const vel = (i === 0 || last ? 1.05 : rand(0.78, 1.0)) * (1 - i * 0.025);
      this._bell(t + rand(-0.007, 0.007), mtof(m), { gain: WIN_G * 0.17 * vel * G, pan, wet: last ? 0.22 : 0.17 });
      if (last && tier !== 'small') this._bell(t + 0.004, mtof(m - 12), { gain: WIN_G * 0.08 * G, pan: -pan * 0.5, wet: 0.22 }); // tonic doubled an octave down
      t += gap * rand(0.88, 1.12);
      if (tier === 'big') gap *= 0.95;
    });
    if (s > 0.25) { // soft warm chord under it (inversion varies)
      const chord = pick([[60, 64, 67], [64, 67, 72], [55, 60, 64], [60, 67, 76]]);
      chord.forEach((m, i) => this._pad(t0 + 0.02 + i * rand(0, 0.015), mtof(m), 0.35 + s * 0.4, { gain: WIN_G * (0.024 + s * 0.016) * G * rand(0.85, 1.05), cutoff: 1800, attack: 0.05, release: 0.7, pan: (i - 1) * 0.3, wet: 0.2 }));
    }
    if (s > 0.6) { // sparkle shimmer after the motif lands
      for (let i = 0; i < 8; i++) this._bell(t + 0.05 + i * rand(0.04, 0.07), mtof(pick([96, 98, 100, 103, 105])), { gain: WIN_G * 0.035 * G * rand(0.7, 1.1), pan: rand(-0.7, 0.7), wet: 0.3 });
    }
    // (payout chip clacks come from the chip animation landing callbacks)
    this._duckAmbience(0.55, 1.2 + s);
  }
  /** One faint bell: a small consolation win inside a losing roll. */
  _faintChime() { if (this.chimes) this._bell(this._now(0.05), mtof(pick([84, 88, 91])), { gain: 0.06, wet: 0.2 }); }
  /** Hardway hit: a bright double strike and a ringing tremolo ("ding-ding!"), not the generic chime. */
  _stingHard(G = 1) {
    const t = this._now(0.03); G *= WIN_G;
    this._bell(t, mtof(91), { gain: 0.2 * G, pan: -0.15, wet: 0.18 });
    this._bell(t + 0.11, mtof(96), { gain: 0.22 * G, pan: 0.15, wet: 0.2 });
    this._bell(t + 0.112, mtof(84), { gain: 0.1 * G, wet: 0.22 });
    for (let i = 0; i < 6; i++) this._bell(t + 0.24 + i * rand(0.055, 0.065), mtof(i % 2 ? 100 : 96), { gain: 0.07 * G * (1 - i * 0.12), pan: (i % 2 ? 0.3 : -0.3), wet: 0.25 });
    this._pad(t + 0.1, mtof(48), 0.25, { gain: 0.03 * G, cutoff: 600, cutoffStart: 200, attack: 0.02, release: 0.6, type: 'triangle', wet: 0.15 });
    this._duckAmbience(0.5, 1.6);
  }
  /** Horn / longshot prop hit: a short synth-brass fanfare stab. */
  _stingHorn(G = 1) {
    const t = this._now(0.03); G *= WIN_G;
    const brass = (tt, m, dur, g, pan) => this._pad(tt, mtof(m), dur, { gain: g * G, cutoff: 3400, cutoffStart: 500, attack: 0.018, release: 0.3, pan, wet: 0.15, detune: [-9, 0, 8] });
    brass(t, 67, 0.07, 0.03, -0.2); brass(t, 72, 0.07, 0.026, 0.2);
    brass(t + 0.13, 67, 0.07, 0.03, -0.2); brass(t + 0.13, 72, 0.07, 0.026, 0.2);
    [72, 76, 79, 84].forEach((m, i) => brass(t + 0.27, m, 0.5, 0.022, (i - 1.5) * 0.25));
    this._bell(t + 0.27, mtof(96), { gain: 0.12 * G, wet: 0.22 });
    this._duckAmbience(0.5, 1.6);
  }
  /** Yo-eleven: a fast rising pentatonic glissando that lands on a sparkle. */
  _stingYo(G = 1) {
    const t = this._now(0.03); G *= WIN_G;
    const run = [72, 74, 76, 79, 81, 84, 86, 88, 91, 93, 96];
    run.forEach((m, i) => this._bell(t + i * 0.03 + rand(-0.004, 0.004), mtof(m), { gain: (0.07 + i * 0.008) * G, pan: (i / run.length - 0.5) * 0.8, wet: 0.17 }));
    this._bell(t + run.length * 0.03 + 0.04, mtof(96), { gain: 0.2 * G, wet: 0.22 });
    this._bell(t + run.length * 0.03 + 0.045, mtof(84), { gain: 0.08 * G, wet: 0.22 });
    this._duckAmbience(0.5, 1.4);
  }
  /** Which special stinger (if any) a roll's winning bets earn. */
  _stingerFor(res) {
    const ids = (res.events || []).filter((e) => e.type === 'win').map((e) => String(e.id));
    if (ids.some((id) => /^hard\d/.test(id))) return 'hard';
    if (ids.some((id) => /^(horn|hornHigh|world|two|three|twelve|anyCraps)/.test(id)) && res.total !== 11) return 'horn';
    if (res.total === 11 && ids.some((id) => /^(eleven|ce|horn|hornHigh|world)/.test(id))) return 'yo';
    return null;
  }
  _sting(kind, G = 1) { if (kind === 'hard') this._stingHard(G); else if (kind === 'horn') this._stingHorn(G); else if (kind === 'yo') this._stingYo(G); }
  /** Generic losing-bet sweep (fallback when no chip animation drives sweep()/bankLand()). */
  lose(pos = null) {
    const t = this._now(0.08), pan = this._panPos(pos, 0.2);
    this._noise(t, 0.35, { type: 'bandpass', freq: 1800, freqEnd: 900, q: 0.7, gain: 0.026, attack: 0.08, pan, wet: 0.05 }); // rake/hand sweep on felt
    for (let i = 0; i < 3; i++) this._play(pick(this.bufs.chip), { t: t + 0.08 + i * rand(0.03, 0.05), gain: rand(0.1, 0.15), rate: rand(0.85, 1.0), lp: 3800, pan: pan + 0.1 + i * 0.05, wet: 0.1, priority: 0.4 });
  }
  /**
   * Seven-out sting: a quick falling minor arpeggio on low wooden mallets (G4 Eb4 Bb3) that lands on a
   * muted drum hit with a low C, over a soft dark swell, then the table's groan. Short, dry and clearly
   * audible above the groan, without any pitch-sliding "sad trombone".
   */
  sevenOut({ gain = 1 } = {}) {
    if (!this.chimes) {
      // Realistic: no music. The stickman's "seven out" leads (callout), the table groans just after it
      // has landed, and the room drops under both.
      this.groan(0.95 * clamp(gain, 0, 1), 0.5);
      this._duckAmbience(0.55, 2.0);
      return;
    }
    const t = this._now(0.02), G = clamp(gain, 0, 1) * WIN_G;
    [67, 63, 58].forEach((m, i) => this._mallet(t + i * 0.105 + rand(-0.004, 0.004), mtof(m), { gain: 0.3 * G * (1 - i * 0.06), pan: 0.12 - i * 0.12, wet: 0.14 }));
    const tl = t + 0.33;
    this._play(pick(this.bufs.boom), { t: tl, gain: 0.55 * G, rate: rand(0.97, 1.03), wet: 0.12, bus: this.music, priority: 0.9 });
    this._mallet(tl + 0.003, mtof(48), { gain: 0.34 * G, wet: 0.15 });
    this._mallet(tl + 0.008, mtof(55), { gain: 0.16 * G, pan: 0.1, wet: 0.15 });
    // dark C-minor swell under the landing (filtered, no glide)
    this._pad(tl, 130.8, 0.4, { gain: 0.035 * G, cutoff: 700, cutoffStart: 250, attack: 0.05, release: 1.1, wet: 0.15, type: 'triangle', detune: [-5, 5] });
    this._pad(tl, 155.6, 0.35, { gain: 0.02 * G, cutoff: 700, cutoffStart: 250, attack: 0.05, release: 1.0, wet: 0.15, type: 'triangle', detune: [0] });
    this.groan(0.9, 0.18);
    this._duckAmbience(0.55, 1.8);
  }
  /** Table crowd cheering. amount 0..1. Falls back to a few claps if the crowd render isn't done yet. */
  cheer(amount = 0.6, delay = 0) {
    const a = clamp(amount, 0, 1);
    const b = this.crowd.cheer;
    if (!b) { this._claps(6 + Math.round(a * 10), delay, 0.05 + a * 0.05); return; }
    this._play(b, { t: this._now(delay), gain: CROWD_G * (0.1 + 0.24 * a), rate: rand(0.97, 1.03), wet: 0.18, lp: 2800 + 3500 * a, priority: 0.9 });
  }
  groan(amount = 0.6, delay = 0) {
    const b = this.crowd.groan; if (!b) return;
    this._play(b, { t: this._now(delay), gain: CROWD_G * (0.1 + 0.24 * clamp(amount, 0, 1)), rate: rand(0.97, 1.03), wet: 0.18, lp: 3000, priority: 0.9 });
  }
  _claps(n, delay, gain) {
    const t0 = this._now(delay);
    for (let i = 0; i < n; i++) this._noise(t0 + Math.pow(urand(), 1.4) * 1.2, 0.035, { freq: rand(900, 2000), q: 1.2, gain, attack: 0.001, pan: rand(-0.7, 0.7), wet: 0.3 });
  }
  /**
   * Pick the response for a resolved roll (rules.js result object). The TABLE reaction (cheer / groan)
   * follows the outcome, the player's own reward follows their NET: a Don't player winning on a seven-out
   * hears the groan and their own chime. Losing chips are heard from the sweep animation (sweep/bankLand).
   */
  result(res) {
    if (!res) return;
    this.callout(res);
    const won = res.totalWin || 0, net = res.net || 0;
    const size = clamp(net / 200, 0, 1), sting = net > 0 || won > 0 ? this._stingerFor(res) : null;
    // Realistic profile: the reward is the table's reaction (crowd, the players' "yo!" shout) and the
    // payout chips (chips.js -> chipStack / chips / chipsRail); only the 'Win chimes' profile adds music.
    const reward = (g = 1, minSize = 0) => {
      if (!this.chimes) return; // cheers below + the "yo!" shout in callout() + payout chips carry it
      if (sting) this._sting(sting, g); else this.win(Math.max(minSize, size), { gain: g });
    };
    switch (res.outcome) {
      case 'seven-out':
        this.sevenOut({ gain: net > 0 ? 0.55 : 1 });
        if (net > 0) reward(0.6);
        return;
      case 'craps':
        this.groan(0.35, 0.3);
        if (net > 0) reward(0.75);
        else if (won > 0 && sting && this.chimes) this._sting(sting, 0.6);
        return;
      case 'point-made': {
        this.cheer(0.9, 0.1);
        if (this.chimes && (net > 0 || (won > 0 && net >= 0))) {
          const t = this._now(0.02);
          pick([[60, 64, 67], [64, 67, 72], [55, 60, 64]]).forEach((m, i) => this._pad(t + i * rand(0.08, 0.1), mtof(m + 12), 0.5, { gain: 0.03 * WIN_G * rand(0.9, 1.05), cutoff: 2600, attack: 0.04, release: 0.8, pan: (i - 1) * 0.35, wet: 0.2 }));
          this._pad(t + 0.3, mtof(84), 0.6, { gain: 0.022 * WIN_G, cutoff: 3200, attack: 0.04, release: 0.9, wet: 0.22 });
          reward(1, 0.65);
        }
        return;
      }
      case 'natural':
        this.cheer(res.total === 11 ? 0.65 : 0.55, 0.15);
        if (net > 0) reward(1);
        else if (won > 0 && won >= Math.abs(net) * 0.5) this._faintChime();
        return;
      default:
        if (net > 0) {
          reward(1);
          if (size > 0.5 || sting) this.cheer(sting ? 0.6 : 0.4, 0.15);
        } else if (won > 0) {
          if (sting && this.chimes) this._sting(sting, 0.55);
          else if (won >= Math.abs(net) * 0.5) this._faintChime();
        }
    }
  }

  // ---------- stickman callouts (synthesized voice, through the mix) ----------
  /**
   * Render every table call once at idle (Klatt-style formant voice, renderSpeech) plus the players'
   * "Yo!" shout layer (four voices, shouted, staggered and panned). Chunked so it never janks.
   */
  async _renderVoices() {
    if (this._callRaw) return this._callRaw;
    const t0 = performance.now(), raw = {};
    // the stickman: a projected baritone, slightly fast, a little breathy (a working voice over a crowd)
    const stick = { f0: 112, fscale: 0.97, rate: 1.06, bright: 0.6, breath: 0.07, shout: 0.25 };
    // shot runs only exercise the path (a few calls); real play renders the whole set
    const keys = SHOT && !AUDIOTEST ? ['sevenOutLine', 'yoleven', 'n6'] : Object.keys(CALLS);
    let k = 0;
    for (const key of keys) {
      raw[key] = renderSpeech(CALLS[key], stick);
      if (++k % 3 === 0) await yieldFrame();
    }
    // "Yo!" from the players around the rail: 4 shouted voices, different sizes / pitches / timing
    {
      const L = new Float32Array(Math.floor(VSR * 0.9)), R = new Float32Array(L.length);
      const who = [{ f0: 128, fscale: 0.95 }, { f0: 150, fscale: 1.0 }, { f0: 210, fscale: 1.12 }, { f0: 104, fscale: 0.92 }];
      who.forEach((p, i) => {
        const d = renderSpeech([['yo', 2]], { ...p, rate: rand(0.95, 1.1), bright: 0.8, breath: 0.12, shout: 1 });
        const off = Math.floor(VSR * (i * 0.035 + rand(0, 0.03))), pan = [-0.6, 0.5, -0.2, 0.8][i], amp = [1, 0.8, 0.6, 0.7][i];
        const pl = Math.cos((pan + 1) * Math.PI / 4) * amp, pr = Math.sin((pan + 1) * Math.PI / 4) * amp;
        for (let j = 0; j < d.length && off + j < L.length; j++) { L[off + j] += d[j] * pl; R[off + j] += d[j] * pr; }
      });
      let mx = 0; for (let j = 0; j < L.length; j++) mx = Math.max(mx, Math.abs(L[j]), Math.abs(R[j]));
      const g = mx > 0 ? 0.9 / mx : 1, fo = Math.floor(VSR * 0.03);
      for (let j = 0; j < L.length; j++) { const f = j > L.length - fo ? (L.length - j) / fo : 1; L[j] *= g * f; R[j] *= g * f; }
      raw.__shoutYo = [L, R];
    }
    this._stats.voiceMs = performance.now() - t0;
    this._callRaw = raw;
    return raw;
  }
  /** AudioBuffer for a rendered call (built lazily per context). */
  _callBuf(key) {
    if (this._callBufs[key]) return this._callBufs[key];
    const d = this._callRaw && this._callRaw[key]; if (!d) return null;
    const chs = Array.isArray(d) ? d : [d];
    const b = this.ctx.createBuffer(chs.length, chs[0].length, VSR);
    chs.forEach((x, i) => b.getChannelData(i).set(x));
    return (this._callBufs[key] = b);
  }
  /**
   * Which call the stickman makes for a resolved roll. Craps numbers (2, 3, 12) get their craps call in
   * every phase, a point made the hard way says "hard", and callText() is derived from the same key, so
   * the caption and the voice can never disagree.
   */
  static callKey(res) {
    if (!res) return null;
    const t = res.total ?? (res.d1 + res.d2), hard = res.hard ?? (res.d1 === res.d2);
    if (!NUM_WORD[t]) return null;
    if (res.outcome === 'seven-out') return 'sevenOutLine';
    if (t === 2 || t === 3 || t === 12) return 'craps' + t;
    if (res.outcome === 'natural') return t === 11 ? 'yoleven' : 'winner7';
    if (t === 11) return 'yo';
    const box = [4, 6, 8, 10].includes(t);
    if (res.outcome === 'point-made') return (box && hard ? 'hw' : 'w') + t;
    if (box) return (hard ? 'h' : 'e') + t;
    return 'n' + t;
  }
  /** What the stickman says for a roll (caption form of exactly the phrase callKey() picks). */
  static callText(res) {
    const key = AudioEngine.callKey(res);
    return key ? callPhraseText(key) : '';
  }
  /**
   * Stickman call over the table (Settings > Stickman calls, off by default): his mic voice from the far
   * side of the layout, band-limited like a table PA, through the glue / limiter / room reverb, with the
   * room ducked under it. On an eleven the players shout "Yo!" with him.
   */
  callout(res) {
    if (!this.callouts || !res) return;
    const key = AudioEngine.callKey(res); if (!key) return;
    const b = this._callBuf(key); if (!b) return;
    const t = this._now(0.04);
    this._play(b, { t, gain: VOICE_G, rate: rand(0.985, 1.015), pan: this._panAt(0.5, 1.6, -6.2), wet: 0.16, hp: 160, lp: 5600, priority: 1 });
    if (key === 'yo' || key === 'yoleven') {
      const s = this._callBuf('__shoutYo');
      if (s) this._play(s, { t: t - 0.02, gain: VOICE_G * 0.55, rate: rand(0.97, 1.03), wet: 0.2, hp: 200, lp: 4800, priority: 0.9 });
    }
    this._duckAmbience(0.6, b.duration * 0.9);
  }
  /** The players' "Yo!" shout on its own (amount 0..1). */
  shout(kind = 'yo', amount = 1) {
    const s = this._callBuf('__shoutYo'); if (!s) return;
    this._play(s, { t: this._now(0.03), gain: VOICE_G * 0.55 * clamp(amount, 0, 1.2), rate: rand(0.97, 1.03), wet: 0.2, hp: 200, lp: 4800, priority: 0.9 });
  }

  // ---------- crowd + ambience rendering (plain JS formant synthesis, chunked so it never janks) ----------
  async _renderCrowd() {
    const t0 = performance.now(), SR = CSR, out = {};
    this.crowdStatus = 'rendering';
    const V = { a: [750, 1200, 2600], e: [550, 1900, 2600], ay: [480, 2100, 2800], o: [500, 850, 2500], aw: [640, 1000, 2500], oo: [350, 800, 2300], i: [300, 2300, 3000], u: [450, 1100, 2400] };
    const vk = Object.values(V);
    // piecewise-linear curve [[t, v], ...] evaluated with a moving cursor (t must be non-decreasing)
    const curve = (pts) => {
      let j = 0;
      return (t) => {
        if (t <= pts[0][0]) return pts[0][1];
        while (j < pts.length - 2 && t > pts[j + 1][0]) j++;
        const [ta, va] = pts[j], [tb, vb] = pts[Math.min(j + 1, pts.length - 1)];
        if (t >= tb) return vb;
        const k = (t - ta) / (tb - ta);
        return Array.isArray(va) ? va.map((x, i) => x + (vb[i] - x) * k) : va + (vb - va) * k;
      };
    };
    const polyBlep = (t, dt) => {
      if (t < dt) { t /= dt; return t + t - t * t - 1; }
      if (t > 1 - dt) { t = (t - 1) / dt; return t * t + t + t + 1; }
      return 0;
    };
    /**
     * One formant voice: PolyBLEP saw + breath noise -> 3 parallel formant band-passes (scaled per
     * voice for vocal-tract size) -> envelope -> equal-power pan.
     */
    const voice = (L, R, { t0, f0, f0Curve, vowels, env, pan, breath = 0.3, fscale = 1, amp = 1 }) => {
      const f0c = curve([[0, 1], ...f0Curve]);
      const vwc = curve(vowels[0][0] > 0 ? [[0, vowels[0][1]], ...vowels] : vowels);
      const envc = curve([[0, 0], ...env]);
      const end = env[env.length - 1][0] + 0.03;
      const i0 = Math.floor(t0 * SR), i1 = Math.min(L.length, Math.floor((t0 + end) * SR));
      const pl = Math.cos((pan + 1) * Math.PI / 4) * amp, pr = Math.sin((pan + 1) * Math.PI / 4) * amp;
      const vibF = rand(4.5, 6.5), vibD = rand(0.006, 0.016), jit = rand(0.004, 0.01), Q = [6, 9, 11], G = [3, 1.5, 0.75];
      const y1 = [0, 0, 0], y2 = [0, 0, 0], b0 = [0, 0, 0], a1 = [0, 0, 0], a2 = [0, 0, 0];
      let x1 = 0, x2 = 0, ph = urand(), nz = 0, drift = 0;
      for (let i = i0; i < i1; i++) {
        const t = (i - i0) / SR;
        if (((i - i0) & 31) === 0) { // update formant filter coefficients every 32 samples
          const F = vwc(t);
          for (let k = 0; k < 3; k++) {
            const w = TAU * Math.min(F[k] * fscale, SR * 0.45) / SR, al = Math.sin(w) / (2 * Q[k]), a0 = 1 + al;
            b0[k] = al / a0; a1[k] = -2 * Math.cos(w) / a0; a2[k] = (1 - al) / a0;
          }
          drift += 0.15 * ((urand() * 2 - 1) * jit - drift); // slow pitch jitter: less "synth"
        }
        const f = f0 * f0c(t) * (1 + vibD * Math.sin(TAU * vibF * t) + drift);
        const dt = Math.min(0.45, f / SR);
        ph += dt; if (ph >= 1) ph -= 1;
        nz += 0.6 * ((urand() * 2 - 1) - nz); // slightly darkened breath
        const x = (2 * ph - 1 - polyBlep(ph, dt)) * 0.6 + nz * breath;
        let y = 0;
        for (let k = 0; k < 3; k++) {
          const yk = b0[k] * x - b0[k] * x2 - a1[k] * y1[k] - a2[k] * y2[k];
          y2[k] = y1[k]; y1[k] = yk; y += yk * G[k];
        }
        x2 = x1; x1 = x;
        const v = y * envc(t);
        L[i] += v * pl; R[i] += v * pr;
      }
    };
    /** Broadband crowd "roar": pink-ish noise through 3 slowly wandering formant band-passes. */
    const roar = (L, R, { t0 = 0, env, amp = 1, center = 1 }) => {
      const envc = curve([[0, 0], ...env]);
      const end = env[env.length - 1][0];
      const i0 = Math.floor(t0 * SR), i1 = Math.min(L.length, Math.floor((t0 + end) * SR));
      const st = [0, 1, 2].map(() => ({ y1: 0, y2: 0, x1: 0, x2: 0, b0: 0, a1: 0, a2: 0, f: rand(500, 900) * center, tgt: 0 }));
      const bands = [[350, 900], [900, 1800], [1800, 3200]];
      let p0 = 0, p1 = 0, p2 = 0, lw = 0, rw = 0;
      for (let i = i0; i < i1; i++) {
        const t = (i - i0) / SR;
        if (((i - i0) & 63) === 0) {
          st.forEach((s, k) => {
            if (urand() < 0.02) s.tgt = rand(bands[k][0], bands[k][1]) * center;
            s.f += 0.05 * ((s.tgt || s.f) - s.f);
            const w = TAU * s.f / SR, al = Math.sin(w) / (2 * 2.2), a0 = 1 + al;
            s.b0 = al / a0; s.a1 = -2 * Math.cos(w) / a0; s.a2 = (1 - al) / a0;
          });
        }
        const w = urand() * 2 - 1; // cheap pink-ish (3-pole Kellet subset)
        p0 = 0.99765 * p0 + w * 0.099046; p1 = 0.963 * p1 + w * 0.2965164; p2 = 0.57 * p2 + w * 1.0526913;
        const x = (p0 + p1 + p2 + w * 0.1848) * 0.25;
        let y = 0;
        for (let k = 0; k < 3; k++) { const s = st[k]; const yk = s.b0 * x - s.b0 * s.x2 - s.a1 * s.y1 - s.a2 * s.y2; s.x2 = s.x1; s.x1 = x; s.y2 = s.y1; s.y1 = yk; y += yk * (k === 1 ? 1.2 : 0.9); }
        const e = envc(t) * amp;
        // decorrelate L/R with two slightly different leaky integrations of the same signal
        lw += 0.9 * (y - lw); rw += 0.7 * (y - rw);
        L[i] += lw * e; R[i] += rw * e;
      }
    };
    const clap = (L, R, t, amp, freq, pan) => {
      const i0 = Math.floor(t * SR), n = Math.floor(0.035 * SR);
      const w = TAU * freq / SR, al = Math.sin(w) / (2 * 1.2), a0 = 1 + al, b0 = al / a0, a1 = -2 * Math.cos(w) / a0, a2 = (1 - al) / a0;
      const pl = Math.cos((pan + 1) * Math.PI / 4), pr = Math.sin((pan + 1) * Math.PI / 4);
      let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
      for (let j = 0; j < n && i0 + j < L.length; j++) {
        const x = urand() * 2 - 1, y = b0 * x - b0 * x2 - a1 * y1 - a2 * y2;
        x2 = x1; x1 = x; y2 = y1; y1 = y;
        const e = amp * (j < 40 ? j / 40 : Math.exp(-(j - 40) / (0.006 * SR)));
        L[i0 + j] += y * e * pl * 3; R[i0 + j] += y * e * pr * 3;
      }
    };
    /**
     * Consonant noise burst at a syllable onset: 't' (bright, ~10 ms), 'k' (mid, ~15 ms), 'h' / 's'
     * (breathy, 40-90 ms). Breaks up the "vowel soup" a pure formant crowd otherwise turns into.
     */
    const cons = (L, R, t, amp, pan, kind = pick(['t', 'k', 'h', 'h', 's'])) => {
      const P = { t: [rand(4500, 7000), 1.0, rand(0.008, 0.013), 0.0008], k: [rand(1700, 2800), 1.6, rand(0.012, 0.02), 0.001], h: [rand(1300, 2600), 0.8, rand(0.04, 0.08), 0.015], s: [rand(5500, 8000), 1.4, rand(0.05, 0.09), 0.012] }[kind];
      const [freq, q, dur, atk] = P;
      const i0 = Math.floor(t * SR), n = Math.floor(dur * SR), na = Math.max(1, Math.floor(atk * SR));
      const w = TAU * Math.min(freq, SR * 0.45) / SR, al = Math.sin(w) / (2 * q), a0 = 1 + al, b0 = al / a0, a1 = -2 * Math.cos(w) / a0, a2 = (1 - al) / a0;
      const pl = Math.cos((pan + 1) * Math.PI / 4), pr = Math.sin((pan + 1) * Math.PI / 4);
      let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
      for (let j = 0; j < n && i0 + j < L.length; j++) {
        if (i0 + j < 0) continue;
        const x = urand() * 2 - 1, y = b0 * x - b0 * x2 - a1 * y1 - a2 * y2;
        x2 = x1; x1 = x; y2 = y1; y1 = y;
        const e = amp * (j < na ? j / na : Math.exp(-(j - na) / (n * 0.35)));
        L[i0 + j] += y * e * pl; R[i0 + j] += y * e * pr;
      }
    };
    const finish = (L, R, len = L.length, peak = 0.9, fade = true) => {
      let mx = 0; for (let i = 0; i < len; i++) mx = Math.max(mx, Math.abs(L[i]), Math.abs(R[i]));
      const g = mx > 0 ? peak / mx : 1;
      const fo = fade ? Math.min(len, Math.floor(SR * 0.02)) : 0;
      for (let i = 0; i < len; i++) { const f = i > len - fo ? (len - i) / fo : 1; L[i] *= g * f; R[i] *= g * f; }
      return { L, R, len };
    };
    const person = () => { // vocal-tract scaling: men, women, a few young/old voices
      const r = urand();
      if (r < 0.5) return { f0: rand(105, 175), fscale: rand(0.85, 1.0) };
      if (r < 0.88) return { f0: rand(185, 290), fscale: rand(1.05, 1.17) };
      return { f0: rand(240, 340), fscale: rand(1.12, 1.2) };
    };
    // cheer vowel gestures, each with its own randomised timing ("yeah", "woo", "hey", "ahh", "yes", "oh!")
    const gestures = [
      () => [V.i, V.e, V.a, V.aw], () => [V.oo, V.oo, V.o], () => [V.e, V.ay, V.i], () => [V.a, V.a, V.aw],
      () => [V.i, V.e, V.e], () => [V.o, V.o, V.u], () => [V.ay, V.e, V.a],
    ];
    const path = (vs, tail) => { // spread the vowel targets over a jittered, per-voice timeline
      const pts = [[0, vs[0]]]; let t = 0;
      for (let k = 1; k < vs.length; k++) { t += rand(0.05, 0.22) * (k === vs.length - 1 ? 2.5 : 1); pts.push([Math.min(t, tail * 0.9), vs[k]]); }
      pts.push([tail, vs[vs.length - 1]]);
      for (let k = 1; k < pts.length; k++) if (pts[k][0] <= pts[k - 1][0]) pts[k][0] = pts[k - 1][0] + 0.01;
      return pts;
    };

    // Cheer: 56 voices kept well under the roar bed, consonant onsets, claps + a whistle
    {
      this.crowdStatus = 'cheer';
      const n = Math.floor(SR * 3.4), L = new Float32Array(n), R = new Float32Array(n);
      roar(L, R, { t0: 0.05, env: [[0.25, 0.9], [0.9, 0.7], [2.0, 0.35], [3.3, 0]], amp: 1.0 });
      await yieldFrame();
      for (let k = 0; k < 56; k++) {
        const { f0, fscale } = person(), t0 = Math.pow(urand(), 1.7) * 0.9;
        const hold = rand(0.2, 0.8), tail = hold + rand(0.5, 1.6), pan = rand(-0.85, 0.85), amp = rand(0.13, 0.36);
        if (urand() < 0.6) cons(L, R, t0 - 0.02, amp * rand(1.2, 2.2), pan, pick(['h', 'h', 'k', 't'])); // "h-yeah", "k'mon", "t-..."
        voice(L, R, {
          t0, f0, fscale, pan, breath: rand(0.35, 0.6), amp,
          f0Curve: [[rand(0.06, 0.18), rand(1.1, 1.35)], [hold, rand(1.0, 1.2)], [tail, rand(0.7, 0.9)]],
          vowels: path(pick(gestures)(), tail),
          env: [[rand(0.03, 0.1), rand(0.4, 1)], [hold, rand(0.3, 0.8)], [tail, 0]],
        });
        if (k % 6 === 5) await yieldFrame();
      }
      for (let k = 0; k < 80; k++) { const t = 0.25 + Math.pow(urand(), 1.6) * 2.7; clap(L, R, t, rand(0.2, 0.55) * (1 - (t - 0.25) / 3.1), rand(900, 2200), rand(-0.9, 0.9)); }
      { // whistle
        const t0 = rand(0.2, 0.5), i0 = Math.floor(t0 * SR), m = Math.floor(0.75 * SR), fc = curve([[0, 1900], [0.25, 2700], [0.7, 2300]]), ec = curve([[0, 0], [0.05, 0.09], [0.5, 0.06], [0.75, 0]]);
        let ph = 0; for (let j = 0; j < m && i0 + j < n; j++) { const t = j / SR; ph += TAU * fc(t) / SR; const v = Math.sin(ph) * ec(t) * 2; L[i0 + j] += v * 0.6; R[i0 + j] += v * 0.8; }
      }
      out.cheer = finish(L, R);
      this._crowdRaw = { ...out }; this._attachCrowd(); // usable as soon as it exists
      await yieldFrame();
    }
    // Groan: falling "awww / ohh" from ~34 voices over a soft roar
    {
      this.crowdStatus = 'groan';
      const n = Math.floor(SR * 2.6), L = new Float32Array(n), R = new Float32Array(n);
      roar(L, R, { t0: 0.05, env: [[0.3, 0.5], [1.2, 0.35], [2.4, 0]], amp: 0.85, center: 0.8 });
      await yieldFrame();
      const groans = [() => [V.aw, V.aw, V.o], () => [V.o, V.o, V.u], () => [V.a, V.aw, V.oo], () => [V.u, V.o, V.o]];
      for (let k = 0; k < 34; k++) {
        const { f0, fscale } = person(), t0 = Math.pow(urand(), 1.5) * 0.4, tail = rand(1.0, 2.0), pan = rand(-0.85, 0.85), amp = rand(0.18, 0.45);
        if (urand() < 0.35) cons(L, R, t0 - 0.03, amp * rand(1, 1.8), pan, 'h'); // breathy "h-aww"
        voice(L, R, {
          t0, f0: f0 * 0.92, fscale, pan, breath: rand(0.4, 0.65), amp,
          f0Curve: [[rand(0.1, 0.2), rand(1.03, 1.12)], [tail, rand(0.62, 0.75)]],
          vowels: path(pick(groans)(), tail),
          env: [[rand(0.12, 0.25), rand(0.4, 0.9)], [tail * rand(0.5, 0.7), rand(0.25, 0.6)], [tail, 0]],
        });
        if (k % 6 === 5) await yieldFrame();
      }
      out.groan = finish(L, R);
      this._crowdRaw = { ...out }; this._attachCrowd();
      await yieldFrame();
    }
    if (SHOT && !AUDIOTEST) { this._stats.crowdMs = performance.now() - t0; return; } // babble is never heard in screenshot runs
    // Babble: two coprime-length loops (11.3 s, 17.9 s) played together at slightly different pitch,
    // so the combined bed only repeats after minutes
    // 24 talkers per loop (48 total) at low individual level: a wash of conversation, not a few
    // intelligible "Simlish" voices. Syllables get consonant onsets; the playback chain band-limits hard.
    for (const [name, LOOP, voices] of [['babbleA', 11.3, 24], ['babbleB', 17.9, 24]]) {
      this.crowdStatus = name;
      const XF = 1.2, n = Math.floor(SR * (LOOP + XF)), L = new Float32Array(n), R = new Float32Array(n);
      for (let k = 0; k < voices; k++) {
        const { f0, fscale } = person(), pan = rand(-0.95, 0.95), amp = rand(0.3, 0.75) * (urand() < 0.3 ? 0.5 : 1); // some talkers further away
        let t = rand(0, 3);
        while (t < LOOP + XF - 1) {
          const phrase = rand(0.6, 2.6), syl = [], vw = [], fc = [];
          let s = 0;
          while (s < phrase) {
            const d = rand(0.09, 0.26);
            if (urand() < 0.45) cons(L, R, t + s, amp * rand(0.25, 0.6), pan);
            syl.push([s + d * 0.25, rand(0.5, 1)], [s + d * 0.85, rand(0.05, 0.3)]); vw.push([s + d * 0.4, pick(vk)]); fc.push([s + d, rand(0.85, 1.2)]); s += d;
          }
          syl.push([s + 0.06, 0]);
          voice(L, R, { t0: t, f0: f0 * 0.9, fscale, pan: clamp(pan + rand(-0.1, 0.1), -1, 1), breath: rand(0.3, 0.45), amp, f0Curve: fc, vowels: vw, env: syl });
          t += s + rand(0.5, 3.2);
        }
        if (k % 2 === 1) await yieldFrame();
      }
      const m = loopify([L, R], Math.floor(LOOP * SR), Math.floor(XF * SR));
      out[name] = finish(L, R, m, 0.8, false); // no end fade: the seam is already crossfaded
      this._crowdRaw = { ...out }; this._attachCrowd();
    }
    // Distant cheer from another table: its own render (not the table's cheer reused), long and diffuse
    {
      this.crowdStatus = 'cheerFar';
      const n = Math.floor(SR * 4.2), L = new Float32Array(n), R = new Float32Array(n);
      const side = rand(-0.8, 0.8);
      roar(L, R, { t0: 0.05, env: [[0.5, 0.8], [1.4, 0.65], [2.8, 0.3], [4.0, 0]], amp: 1.0, center: 0.85 });
      for (let k = 0; k < 18; k++) {
        const { f0, fscale } = person(), t0 = Math.pow(urand(), 1.4) * 1.2, hold = rand(0.3, 0.9), tail = hold + rand(0.6, 1.8);
        voice(L, R, { t0, f0, fscale, pan: clamp(side + rand(-0.3, 0.3), -1, 1), breath: 0.55, amp: rand(0.1, 0.25),
          f0Curve: [[rand(0.08, 0.2), rand(1.05, 1.25)], [tail, rand(0.75, 0.9)]], vowels: path(pick(gestures)(), tail), env: [[rand(0.08, 0.2), rand(0.4, 1)], [hold, rand(0.3, 0.7)], [tail, 0]] });
        if (k % 6 === 5) await yieldFrame();
      }
      for (let k = 0; k < 40; k++) { const t = 0.4 + Math.pow(urand(), 1.3) * 3.2; clap(L, R, t, rand(0.1, 0.3) * (1 - (t - 0.4) / 3.8), rand(800, 1600), clamp(side + rand(-0.4, 0.4), -1, 1)); }
      // distance: a gentle 1-pole low-pass baked in (the live chain adds more + heavy reverb)
      for (const d of [L, R]) { let y = 0; const a = 1 - Math.exp(-TAU * 1500 / SR); for (let i = 0; i < n; i++) { y += a * (d[i] - y); d[i] = y; } }
      out.cheerFar = finish(L, R);
      this._crowdRaw = { ...out }; this._attachCrowd();
      await yieldFrame();
    }
    // Slot floor: a continuous wash of many overlapping, detuned little machine jingles and attract-mode
    // arps (2-op FM bells) in random keys and tempos, played back under heavy low-pass + reverb.
    {
      this.crowdStatus = 'slots';
      const LOOP = 23.3, XF = 1.5, n = Math.floor(SR * (LOOP + XF)), L = new Float32Array(n), R = new Float32Array(n);
      const PENT = [0, 2, 4, 7, 9, 12, 14, 16, 19, 21];
      const fm = (t, f, dur, amp, pan, ratio, index, lpHz) => {
        const i0 = Math.floor(t * SR), m = Math.floor(dur * SR);
        const pl = Math.cos((pan + 1) * Math.PI / 4) * amp, pr = Math.sin((pan + 1) * Math.PI / 4) * amp;
        const k = Math.exp(-1 / (dur * 0.3 * SR)), ki = Math.exp(-1 / (dur * 0.12 * SR)), wc = TAU * f / SR, wm = wc * ratio, a = 1 - Math.exp(-TAU * lpHz / SR);
        let env = 1, ie = index, pc = urand() * TAU, pm = 0, y = 0;
        for (let j = 0; j < m; j++) {
          const i = (i0 + j) % n; // wrap into the loop so the seam stays dense
          pm += wm; pc += wc;
          const v = Math.sin(pc + ie * Math.sin(pm)) * env * (j < 40 ? j / 40 : 1);
          y += a * (v - y);
          L[i] += y * pl; R[i] += y * pr;
          env *= k; ie *= ki;
          if (env < 1e-3) break;
        }
      };
      // ~200 short jingles from "machines" at random positions
      for (let j = 0; j < 210; j++) {
        const t = urand() * LOOP, root = 60 + ((urand() * 14) | 0) - 2, notes = 3 + ((urand() * 6) | 0), step = rand(0.06, 0.13);
        const pan = rand(-1, 1), amp = rand(0.08, 0.3) * (urand() < 0.25 ? 1.6 : 1), ratio = pick([2, 3.5, 1.4, 4]), lpHz = rand(1200, 3200);
        const up = urand() < 0.6, det = rand(-0.012, 0.012);
        for (let q = 0; q < notes; q++) {
          const deg = PENT[(up ? q : notes - q) % PENT.length] + (urand() < 0.15 ? 12 : 0);
          fm(t + q * step * rand(0.95, 1.05), mtof(root + deg) * (1 + det), rand(0.15, 0.4), amp, clamp(pan + rand(-0.05, 0.05), -1, 1), ratio, rand(0.6, 2.2), lpHz);
        }
        if (j % 20 === 19) await yieldFrame();
      }
      // a few attract-mode arps running continuously, slightly detuned against each other
      for (let a = 0; a < 5; a++) {
        const root = 62 + ((urand() * 10) | 0), step = rand(0.11, 0.19), pan = rand(-1, 1), pat = Array.from({ length: 8 }, () => pick(PENT.slice(0, 7)));
        const det = 1 + rand(-0.015, 0.015), amp = rand(0.03, 0.07);
        for (let t = rand(0, 1), q = 0; t < LOOP; t += step, q++) fm(t, mtof(root + pat[q % 8]) * det, 0.22, amp * rand(0.8, 1.1), pan, 2, 0.9, 2000);
        await yieldFrame();
      }
      const m = Math.floor(LOOP * SR); // fm() wraps into [0, n); the tail past the loop point crossfades into the head
      loopify([L, R], m, Math.floor(XF * SR));
      out.slots = finish(L, R, m, 0.8, false);
      this._crowdRaw = { ...out }; this._attachCrowd();
    }
    this._stats.crowdMs = performance.now() - t0;
  }

  _startBabble() {
    const amb = this._amb; if (!amb) return;
    const c = this.ctx;
    const loop = (k, rate, lvl, hpHz, lpHz, wet) => {
      const src = c.createBufferSource(); src.buffer = this.crowd[k]; src.loop = true; src.playbackRate.value = rate;
      const hp = c.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = hpHz;
      const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = lpHz;
      const g = c.createGain(); g.gain.value = lvl;
      src.connect(hp); hp.connect(lp); lp.connect(g);
      const nodes = [src, hp, lp, g];
      this._route(g, nodes, { amb: true, wet });
      src.start(c.currentTime + 0.05, urand() * 10);
      amb.babble.push(src); amb.nodes.push(...nodes);
    };
    if (!amb.babble) amb.babble = [];
    if (!amb.talk && this.crowd.babbleA && this.crowd.babbleB) {
      amb.talk = true;
      loop('babbleA', 1.0, 0.092, 220, 1350, 0.4);
      loop('babbleB', 0.983, 0.08, 220, 1250, 0.4);
    }
    if (!amb.slots && this.crowd.slots) { amb.slots = true; loop('slots', 1.0, 0.042, 300, 2000, 0.5); } // slot floor: far, low, very wet
  }

  _startAmbience() {
    if (!this.ctx || !this.bufs) return;
    const c = this.ctx, t = c.currentTime + (this._base || 0);
    for (const g of [this.ambDry.gain, this.ambWet.gain]) { g.cancelScheduledValues(t); g.setTargetAtTime(1, t, 0.8); }
    if (this._amb) return;
    // switched back on while the last bed is still fading out: keep THAT bed (cancel its teardown and fade it
    // back up) instead of starting a second room tone + babble on top of it
    const fading = this._ambFading;
    if (fading) {
      this._ambFading = null; clearTimeout(fading.kill);
      this._amb = fading.amb;
      this._startBabble();
      if (!this._offline) this._ambSchedulers(this._amb);
      return;
    }
    // room tone: pink noise shaped into a low, warm HVAC/room bed
    const room = c.createBufferSource(); room.buffer = this.pink; room.loop = true;
    const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 650;
    const g = c.createGain(); g.gain.value = 0.038;
    const lfo = c.createOscillator(); lfo.frequency.value = 0.07; const lg = c.createGain(); lg.gain.value = 0.01; lfo.connect(lg); lg.connect(g.gain);
    room.connect(lp); lp.connect(g); g.connect(this.duckDry);
    room.start(); lfo.start();
    this._amb = { room, lfo, timers: {}, nodes: [room, lp, g, lfo, lg], babble: null, talk: false, slots: false };
    this._startBabble();
    if (!this._offline) this._ambSchedulers(this._amb);
  }
  /** Sparse distant events over the bed: chips at other tables, a far-off cheer (timers die with the bed). */
  _ambSchedulers(amb) {
    const c = this.ctx;
    const schedule = (name, minS, maxS, fn) => {
      const tick = () => {
        if (this._amb !== amb) return;
        try { if (this.ctx.state === 'running' && !this.muted) fn(); } catch (e) { this._fail(e); }
        amb.timers[name] = setTimeout(tick, rand(minS, maxS) * 1000); // one live id per scheduler
      };
      amb.timers[name] = setTimeout(tick, rand(minS, maxS) * 1000);
    };
    // (the slot-machine floor is a continuous rendered wash, started with the babble loops)
    schedule('chips', 5, 18, () => {
      const t0 = c.currentTime + 0.02, pan = rand(-1, 1), n = 1 + ((urand() * 6) | 0), g = rand(0.025, 0.055), lp = rand(2200, 3600);
      for (let i = 0; i < n; i++) this._play(pick(this.bufs.chip), { t: t0 + i * rand(0.025, 0.08), gain: g * rand(0.7, 1.1), rate: rand(0.85, 1.1), pan: clamp(pan + rand(-0.05, 0.05), -1, 1), wet: 0.5, lp, amb: true, priority: 0.1 });
    });
    schedule('cheer', 40, 120, () => {
      const b = this.crowd.cheerFar; if (!b) return;
      this._play(b, { t: c.currentTime + 0.02, gain: rand(0.025, 0.05), rate: rand(0.85, 1.12), pan: rand(-0.9, 0.9), wet: 0.6, lp: rand(900, 1500), amb: true, priority: 0.1 });
    });
  }
  _stopAmbience() {
    if (!this._amb) return;
    const c = this.ctx, t = c.currentTime, amb = this._amb;
    this._amb = null;
    for (const g of [this.ambDry.gain, this.ambWet.gain]) { g.cancelScheduledValues(t); g.setTargetAtTime(0, t, 0.25); }
    for (const id of Object.values(amb.timers)) clearTimeout(id);
    amb.timers = {};
    // the sources keep running under the fade; a restart inside this window reuses them (_startAmbience)
    const fading = { amb, kill: 0 };
    fading.kill = setTimeout(() => {
      if (this._ambFading === fading) this._ambFading = null;
      try { amb.room.stop(); amb.lfo.stop(); } catch { }
      for (const s of amb.babble || []) { try { s.stop(); } catch { } }
      this._release(amb.nodes);
    }, 1500);
    this._ambFading = fading;
  }

  // ---------- diagnostics ----------
  /** ?audiotest: on-screen badge with the real post-limiter output level and the dynamics' behaviour. */
  _report() {
    const el = document.createElement('div');
    el.style.cssText = 'position:fixed;left:50%;top:42%;transform:translate(-50%,-50%);z-index:99999;font:600 17px/1.45 monospace;color:#9f9;background:rgba(0,0,0,.88);padding:16px 22px;border:2px solid #9f9;border-radius:10px;white-space:pre';
    document.body.appendChild(el);
    const t0 = performance.now(), st = this._stats, buf = new Float32Array(2048);
    const meter = () => {
      if (this.analyser) {
        this.analyser.getFloatTimeDomainData(buf);
        let pk = 0, s = 0; for (let i = 0; i < buf.length; i++) { const v = Math.abs(buf[i]); if (v > pk) pk = v; s += v * v; }
        st.peak = Math.max(st.peak, pk); st.rmsMax = Math.max(st.rmsMax, Math.sqrt(s / buf.length));
        st.glueMax = Math.min(st.glueMax, this.glue.reduction || 0); st.limMax = Math.min(st.limMax, this.limiter.reduction || 0);
      }
      setTimeout(meter, 40);
    };
    meter();
    const upd = () => {
      const b = this.bufs || {}, cr = this.crowd;
      el.textContent = `AUDIO ENGINE\nctx: ${this.ctx ? this.ctx.state + ' @' + this.ctx.sampleRate + 'Hz' : 'none'}  first-gesture init: ${st.initMs.toFixed(1)} ms (AudioContext ${(st.ctxMs || 0).toFixed(1)} + graph ${(st.initMs - (st.ctxMs || 0)).toFixed(1)})\n` +
        `pre-render: ${st.prerenderMs ? st.prerenderMs.toFixed(0) + ' ms (chunked)' : 'pending'}  crowd: ${this.crowdStatus} ${st.crowdMs ? st.crowdMs.toFixed(0) + ' ms' : ''}\n` +
        `banks: ${Object.entries(b).map(([k, v]) => k + ':' + v.length).join(' ')}\n` +
        `reverb: ${this.verb && this.verb.buffer ? this.verb.buffer.duration.toFixed(2) + 's' : '-'}  crowd: ${Object.entries(cr).map(([k, v]) => k + ' ' + v.duration.toFixed(1) + 's').join(', ') || 'pending'}\n` +
        `OUTPUT (post-limiter, real gain): peak ${dB(st.peak)} dBFS  max rms(43ms) ${dB(st.rmsMax)} dBFS\n` +
        `glue max reduction ${st.glueMax.toFixed(1)} dB   limiter max reduction ${st.limMax.toFixed(1)} dB\n` +
        `test throw: ${st.hitsIn} impacts -> ${st.hitsPlayed} hits played  dropped voices ${st.dropped} (hi-prio ${st.droppedHi})\n` +
        `OFFLINE MIX RENDER: ${st.offline || 'running...'}\n` +
        `ambience: ${this._amb ? 'on' + (this._amb.babble ? '+babble x2' : '') : 'off'}  voices: ${this._voices}\nelapsed: ${((performance.now() - t0) / 1000).toFixed(1)}s`;
      setTimeout(upd, 250);
    };
    upd();
    this._offlineTest().then((r) => { st.offline = r; }, (e) => { st.offline = 'error: ' + (e && e.message); });
  }

  /**
   * Render the complete graph (real gains, real dynamics) offline for a full throw over the ambience,
   * three times with identical seeded randomness: ambience only (A), events only (C), both (B).
   * Because everything else is linear, B - A - C is exactly what the compressors did to the mix:
   * its level against the ambience during the dice impacts is the pumping figure.
   */
  async _offlineTest() {
    const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    if (!OAC) return 'no OfflineAudioContext';
    const tStart = performance.now();
    await this._prerender();
    // wait for the crowd render (cheer, groan, babble, slot wash) so the measured mix is the one players
    // hear; a 150 s cap keeps the badge from hanging if the render failed
    this._stats.offline = "running: waiting for crowd"; if (this._crowdP) await Promise.race([this._crowdP.catch(() => { }), new Promise((r) => setTimeout(r, 150000))]);
    const phys = await import('./physics.js');
    const seeded = seededRng;
    const sim = phys.simulateThrow(seeded(7));
    const T0 = 1.5, REL = 0.38, tEnd = T0 + REL + sim.duration, tRes = tEnd + 0.35, SEC = tRes + 4.0;
    const realRandom = Math.random;
    const crowdSnap = { ...(this._crowdRaw || {}) }; // identical content in all three renders
    const crowdKeys = Object.keys(crowdSnap).join(',') || 'none (claps fallback)';
    if (this._voiceP) await this._voiceP;
    const render = async (withAmb, withEvents, volume = this.volume, chimes = false, extra = null) => {
      const oc = new OAC(2, Math.floor(RSR * SEC), RSR);
      const e = Object.create(AudioEngine.prototype);
      Object.assign(e, {
        ctx: oc, _offline: true, muted: false, volume, ambienceOn: false, callouts: this.callouts, chimes, _pending: [], _pendingThrow: null, _grTrace: { lim: [], fin: [] }, _callRaw: this._callRaw, _callBufs: {}, _throwInfo: null, _resumeInfo: null, crowd: {}, camera: this.camera,
        _amb: null, _voices: 0, _vw: [], _duckTok: 0, _lastHit: Object.create(null), _burst: { t: 0, e: 0 }, _roll: null,
        _capture: null, _throwSrcs: [], _tFreeze: null,
        _stats: { hitsIn: 0, hitsPlayed: 0, dropped: 0, droppedHi: 0 }, _raw: this._raw, _crowdRaw: crowdSnap, _base: 0, bufs: null,
      });
      e._buildGraph(); e.out.gain.value = 1;
      // the real lookahead limiter worklet, exactly as in the live graph (compressor fallback otherwise)
      if (!/[?&]nowl/.test(QS)) try { if (await AudioEngine._loadLimiter(oc)) e._installLimiter(); } catch { }
      this._stats.offline = (this._stats.offline || "") + " [lim " + (e.wlim ? "worklet" : "comp") + "]";
      e._attach();
      try {
        if (withAmb) { Math.random = seeded(101); e._startAmbience(); }
        if (withEvents) {
          Math.random = seeded(202);
          e._base = T0; e.throwDice(sim, { pickup: REL, speed: 1 });
          // what the live game does on a pass-line win: the payout chips land one by one beside the bet,
          // the dealer squares the stack (chipStack), then the chips go to the rail
          e._base = tRes; e.chips(3, 0, { x: -2, y: 0, z: 5 }); e.chipStack(3, 0.75, { x: -2, y: 0, z: 5 }); e.result({ outcome: 'natural', total: 7, d1: 3, d2: 4, totalWin: 60, net: 60, events: [{ type: 'win', id: 'pass', win: 60 }] });
          e._base = tRes + 0.2; e.sweep(6, { x: 4, y: 0, z: 1 });
          e._base = tRes + 0.65; e.bankLand(6, { x: 0, y: 0.3, z: -5 });
          e._base = tRes + 1.3; e.chipsRail(3);
        }
        if (extra) { Math.random = seeded(303); extra(e); }
      } finally { Math.random = realRandom; }
      const b = await oc.startRendering();
      await new Promise((r) => setTimeout(r, 400)); // let the limiters' last gain-trace messages arrive
      return { gr: e._grTrace, L: b.getChannelData(0), R: b.getChannelData(1), hits: e._stats.hitsPlayed, hitsIn: e._stats.hitsIn, dropped: e._stats.dropped, droppedHi: e._stats.droppedHi, lim: !!e.wlim, n: b.length };
    };
    const stage = (s) => { this._stats.offline = "running: " + s; };
    stage("A (bed)"); const A = await render(true, false); stage("C (events)"); const C = await render(false, true); stage("B (mix)"); const B = await render(true, true);
    stage("F (vol 1.0)"); const F = await render(true, true, 1.0); // full volume: the worst case for the limiter and true peak
    stage("G (win chimes profile)"); const G = await render(true, true, this.volume, true);
    // worst case for the bypassing bed: at volume 1.0 a full cheer peaks right as the dice slam lands
    const hitT = (imp) => T0 + 0.004 + REL + imp.t; // scheduled time of an impact (see _scheduleThrow / _now)
    const slamT = sim.impacts.length ? hitT(sim.impacts[0]) : T0 + REL;
    stage("H (slam on a cheer, vol 1.0)"); const H = await render(true, true, 1.0, false, (e) => { e._base = Math.max(0, slamT - 0.3); e.cheer(1.0); });
    stage("analysis");
    const W = Math.floor(RSR * 0.05);
    let peak = 0, pump = -Infinity, ambRms = 0, nW = 0;
    for (let w = 0; w + W <= B.n; w += W) {
      let sa = 0, sr = 0;
      for (let i = w; i < w + W; i++) {
        for (const ch of ['L', 'R']) {
          const b = B[ch][i], a = A[ch][i], r = b - a - C[ch][i];
          const ab = Math.abs(b); if (ab > peak) peak = ab;
          sa += a * a; sr += r * r;
        }
      }
      const t = w / RSR;
      if (t >= T0 && t < tEnd) { // during the throw: how much did the dynamics disturb the ambience?
        const ra = Math.sqrt(sa / (2 * W)), rr = Math.sqrt(sr / (2 * W));
        ambRms += ra; nW++;
        if (ra > 1e-6) pump = Math.max(pump, 20 * Math.log10(rr / ra));
      }
    }
    // ITU-R BS.1770 K-weighting (48 kHz coefficients) and loudness of a window
    const kweight = (x) => {
      const y = new Float32Array(x.length);
      let x1 = 0, x2 = 0, s1 = 0, s2 = 0, o1 = 0, o2 = 0;
      for (let i = 0; i < x.length; i++) {
        const v = x[i];
        // stage 1: high-shelf (head model)
        const s = 1.53512485958697 * v - 2.69169618940638 * x1 + 1.19839281085285 * x2 + 1.69065929318241 * s1 - 0.73248077421585 * s2;
        x2 = x1; x1 = v;
        // stage 2: RLB high-pass
        const o = s - 2 * s1 + s2 + 1.99004745483398 * o1 - 0.99007225036621 * o2;
        s2 = s1; s1 = s; o2 = o1; o1 = o;
        y[i] = o;
      }
      return y;
    };    const kB = [kweight(B.L), kweight(B.R)], kC = [kweight(C.L), kweight(C.R)];
    const lufs = (k, t0, t1) => {
      const i0 = Math.max(0, Math.floor(t0 * RSR)), i1 = Math.min(k[0].length, Math.floor(t1 * RSR));
      let s = 0; for (const ch of k) for (let i = i0; i < i1; i++) s += ch[i] * ch[i];
      const ms = s / Math.max(1, i1 - i0);
      return ms > 0 ? -0.691 + 10 * Math.log10(ms) : -Infinity;
    };
    const maxWin = (k, t0, t1, len, hop = 0.1) => { let m = -Infinity; for (let t = t0; t + len <= t1 + 1e-9; t += hop) m = Math.max(m, lufs(k, t, t + len)); return m; };
    const tThrowEnd = Math.min(T0 + 3, tRes); // never let the throw window run into the win response
    const throwST = lufs(kB, T0, tThrowEnd), throwSTev = lufs(kC, T0, tThrowEnd), throwMom = maxWin(kB, T0, tEnd + 0.2, 0.4);
    const winST = lufs(kC, tRes, tRes + 3), winMom = maxWin(kC, tRes, tRes + 3, 0.4);
    const ambST = lufs([kweight(A.L), kweight(A.R)], 0.2, T0 - 0.05 > 0.6 ? T0 - 0.05 : 1.4);
    // true peak: 4x oversampling with a 48-tap windowed-sinc interpolator per phase
    const truePeak = (x) => {
      const TAPS = 24, ph = [1, 2, 3].map((p) => { const h = new Float32Array(2 * TAPS); for (let k = -TAPS; k < TAPS; k++) { const t = k + p / 4, wv = 0.5 + 0.5 * Math.cos(Math.PI * t / TAPS); h[k + TAPS] = (Math.sin(Math.PI * t) / (Math.PI * t)) * wv; } return h; });
      let m = 0;
      for (let i = TAPS; i < x.length - TAPS; i++) {
        const v = Math.abs(x[i]); if (v > m) m = v;
        if (v < 0.25 && Math.abs(x[i + 1]) < 0.25) continue; // nothing near the ceiling here
        for (const h of ph) { let s = 0; for (let k = 0; k < 2 * TAPS; k++) s += x[i + TAPS - 1 - k + 1] * h[k]; const a = Math.abs(s); if (a > m) m = a; }
      }
      return m;
    };
    const tp = Math.max(truePeak(B.L), truePeak(B.R));
    // full mix (bed + cheer + chime + chips) as heard, at the default volume and at volume 1.0
    const winMixST = lufs(kB, tRes, tRes + 3);
    const kF = [kweight(F.L), kweight(F.R)];
    const tpFull = Math.max(truePeak(F.L), truePeak(F.R));
    const throwFull = lufs(kF, T0, tThrowEnd), winFull = lufs(kF, tRes, tRes + 3), winFullMom = maxWin(kF, tRes, tRes + 3, 0.4);
    let pkF = 0; for (const ch of [F.L, F.R]) for (let i = 0; i < ch.length; i++) { const v = Math.abs(ch[i]); if (v > pkF) pkF = v; }
    // limiter gain reduction, measured (per-block minimum gain traced inside the worklets, 128 samples)
    const BL = 128 / RSR;
    const grDb = (arr, t0, t1) => { let m = 1; for (const [k, g] of arr || []) { const tb = k * BL; if (tb + BL > t0 && tb < t1 && g < m) m = g; } return 20 * Math.log10(m); };
    const grStats = (X) => {
      const per = sim.impacts.map((imp) => ({ t: hitT(imp), type: imp.type, c: imp.closing, gr: grDb(X.gr.lim, hitT(imp), hitT(imp) + 0.035) }));
      const g = per.map((p) => p.gr).sort((a, b) => a - b);
      return {
        slam: per.length ? per[0].gr : 0, worstImpact: g.length ? g[0] : 0, medianImpact: g.length ? g[g.length >> 1] : 0,
        afterSlam: grDb(X.gr.lim, slamT + 0.04, slamT + 0.25), rattle: grDb(X.gr.lim, T0, T0 + REL), win: grDb(X.gr.lim, tRes, tRes + 3),
        finalCeiling: grDb(X.gr.fin, 0, SEC), per,
      };
    };
    const grB = grStats(B), grF = grStats(F), grH = grStats(H);
    let pkA = 0; for (const ch of [A.L, A.R]) for (let i = 0; i < ch.length; i++) { const v = Math.abs(ch[i]); if (v > pkA) pkA = v; }
    let pkH = 0; for (const ch of [H.L, H.R]) for (let i = 0; i < ch.length; i++) { const v = Math.abs(ch[i]); if (v > pkH) pkH = v; }
    const tpH = Math.max(truePeak(H.L), truePeak(H.R));
    const kG = [kweight(G.L), kweight(G.R)], winChimesST = lufs(kG, tRes, tRes + 3), winChimesMom = maxWin(kG, tRes, tRes + 3, 0.4);
    // WAV of the combined mix for listening / A-B comparison against a reference recording
    try {
      const n = B.n, dv = new DataView(new ArrayBuffer(44 + n * 4));
      const wr = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
      wr(0, 'RIFF'); dv.setUint32(4, 36 + n * 4, true); wr(8, 'WAVE'); wr(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 2, true);
      dv.setUint32(24, RSR, true); dv.setUint32(28, RSR * 4, true); dv.setUint16(32, 4, true); dv.setUint16(34, 16, true); wr(36, 'data'); dv.setUint32(40, n * 4, true);
      for (let i = 0, o = 44; i < n; i++, o += 4) { dv.setInt16(o, clamp(B.L[i], -1, 1) * 32767, true); dv.setInt16(o + 2, clamp(B.R[i], -1, 1) * 32767, true); }
      const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([dv.buffer], { type: 'audio/wav' })); a.download = 'craps-mix-offline.wav'; a.textContent = 'Download offline mix (WAV)';
      a.style.cssText = 'position:fixed;right:16px;bottom:120px;z-index:99999;font:600 15px system-ui;color:#000;background:#9f9;padding:10px 14px;border-radius:8px';
      document.body.appendChild(a);
    } catch { }
    const f1 = (v) => (isFinite(v) ? v.toFixed(1) : '-inf');
    const res = {
      samplePeakDbfs: Number(dB(peak)), truePeakDbtp: Number(dB(tp)),
      throwShortTermLufs: throwST, throwShortTermLufsEventsOnly: throwSTev, throwMomentaryMaxLufs: throwMom,
      winStingerShortTermLufs: winST, winStingerMomentaryMaxLufs: winMom, ambienceLufs: ambST,
      winMixShortTermLufs: winMixST, bedLufs: ambST, eventsOverBedDb: throwSTev - ambST, winOverThrowDb: winMixST - throwST,
      throwEventsPer250ms: Array.from({ length: 12 }, (_, i) => Math.round(lufs(kC, T0 + i * 0.25, T0 + (i + 1) * 0.25))).join(' '),
      firstImpactT: sim.impacts.length ? T0 + REL + sim.impacts[0].t : null, simDuration: sim.duration,
      diceFlightToRestLufs: sim.impacts.length ? lufs(kB, T0 + REL + sim.impacts[0].t, T0 + REL + sim.duration) : null, // landing -> settle only (no shake, no silence)
      winChimesProfileShortTermLufs: winChimesST, winChimesProfileMomentaryMaxLufs: winChimesMom, throwMomentaryEventsLufs: maxWin(kC, T0, tEnd + 0.2, 0.4),
      full: { volume: 1, samplePeakDbfs: Number(dB(pkF)), truePeakDbtp: Number(dB(tpFull)), throwShortTermLufs: throwFull, winMixShortTermLufs: winFull, winMomentaryMaxLufs: winFullMom },
      pumpingResidualDb: pump, impacts: sim.impacts.length, hitsIn: C.hitsIn, hitsPlayed: C.hits, droppedVoices: C.dropped, droppedHiPriority: C.droppedHi,
      lookaheadLimiter: C.lim, crowd: crowdKeys, renderMs: Math.round(performance.now() - tStart),
      limiterGR: {
        vol: { slam: grB.slam, worstImpact: grB.worstImpact, medianImpact: grB.medianImpact, afterSlam: grB.afterSlam, rattle: grB.rattle, win: grB.win, finalCeiling: grB.finalCeiling },
        full: { slam: grF.slam, worstImpact: grF.worstImpact, medianImpact: grF.medianImpact, afterSlam: grF.afterSlam, rattle: grF.rattle, win: grF.win, finalCeiling: grF.finalCeiling },
        perImpactVol: grB.per.map((p) => `${(p.t - slamT).toFixed(3)}s ${p.type} c${(+p.c || 0).toFixed(1)} ${p.gr.toFixed(1)}dB`).join(' | '),
      },
      bedSamplePeakDbfs: Number(dB(pkA)),
      slamOnCheerFull: { samplePeakDbfs: Number(dB(pkH)), truePeakDbtp: Number(dB(tpH)), limiterSlam: grH.slam, finalCeiling: grH.finalCeiling },
    };
    // fixed reference values (seeded renders: identical sounds every run) -> report drift as deltas
    const d = (v, r) => (isFinite(v) && isFinite(r) ? (v - r >= 0 ? '+' : '') + (v - r).toFixed(1) : 'n/a');
    const REF = AUDIOTEST_REF;
    res.deltaVsRef = { throwST: d(throwST, REF.throwST), winMixST: d(winMixST, REF.winMixST), throwFull: d(throwFull, REF.throwFull), winFull: d(winFull, REF.winFull), truePeak: d(Number(dB(tp)), REF.tp), truePeakFull: d(Number(dB(tpFull)), REF.tpFull), slamGR: d(grB.slam, REF.slamGR), slamGRFull: d(grF.slam, REF.slamGRFull) };
    this._stats.offlineRes = res;
    const txt = `vol ${this.volume.toFixed(2)}: sample peak ${dB(peak)} dBFS   TRUE PEAK ${dB(tp)} dBTP (target <= -1.0)\n` +
      `  throw: short-term ${f1(throwST)} LUFS (events only ${f1(throwSTev)})  momentary max ${f1(throwMom)} LUFS\n` +
      `  win: events ${f1(winST)} / full mix ${f1(winMixST)} LUFS short-term  momentary max ${f1(winMom)}   bed (room+babble+slots) ${f1(ambST)} LUFS\n` +
      `  events over bed ${f1(throwSTev - ambST)} dB   win over throw ${f1(winMixST - throwST)} dB   'Win chimes' profile win ${f1(winChimesST)} (mom ${f1(winChimesMom)})\n` +
      `vol 1.00: sample peak ${dB(pkF)} dBFS  TRUE PEAK ${dB(tpFull)} dBTP   throw ${f1(throwFull)}  win ${f1(winFull)} (mom ${f1(winFullMom)}) LUFS\n` +
      `  throw: ${sim.impacts.length} impacts -> ${C.hitsIn} hit calls -> ${C.hits} played, dropped voices ${C.dropped} (hi-prio ${C.droppedHi})\n` +
      `  pumping (dynamics residual vs bed during throw): ${isFinite(pump) ? pump.toFixed(1) + ' dB' : 'n/a'}   limiter: ${C.lim ? 'lookahead worklet' : 'compressor fallback'}\n` +
      `  crowd buffers used: ${crowdKeys}   offline render ${res.renderMs} ms\n` +
      `LIMITER GR (measured in the worklet) vol ${this.volume.toFixed(2)}: slam ${f1(grB.slam)} dB  worst hit ${f1(grB.worstImpact)}  median hit ${f1(grB.medianImpact)}  40-250 ms after slam ${f1(grB.afterSlam)}  rattle ${f1(grB.rattle)}  win ${f1(grB.win)}  final ceiling ${f1(grB.finalCeiling)}\n` +
      `  vol 1.00: slam ${f1(grF.slam)} dB  worst hit ${f1(grF.worstImpact)}  median ${f1(grF.medianImpact)}  after slam ${f1(grF.afterSlam)}  rattle ${f1(grF.rattle)}  win ${f1(grF.win)}  final ceiling ${f1(grF.finalCeiling)}\n` +
      `  bed alone: sample peak ${dB(pkA)} dBFS   slam-on-cheer @1.00: peak ${dB(pkH)} dBFS / TP ${dB(tpH)} dBTP, limiter ${f1(grH.slam)} dB, final ceiling ${f1(grH.finalCeiling)} dB\n` +
      `DELTA vs ref: throw ${res.deltaVsRef.throwST}  win ${res.deltaVsRef.winMixST}  throw@1 ${res.deltaVsRef.throwFull}  win@1 ${res.deltaVsRef.winFull}  TP ${res.deltaVsRef.truePeak}/${res.deltaVsRef.truePeakFull}  slam GR ${res.deltaVsRef.slamGR}/${res.deltaVsRef.slamGRFull} dB`;
    try { console.log('[AUDIOTEST] ' + JSON.stringify(res)); } catch { }
    return txt;
  }
  /** ?audiorec=N: record N seconds of the post-limiter mix and offer it as a download. */
  _record(sec) {
    try {
      if (!window.MediaRecorder || !this.ctx.createMediaStreamDestination) return;
      const dest = this.ctx.createMediaStreamDestination(); this.clip.connect(dest);
      const rec = new MediaRecorder(dest.stream), chunks = [];
      rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
      rec.onstop = () => {
        const url = URL.createObjectURL(new Blob(chunks, { type: rec.mimeType || 'audio/webm' }));
        const a = document.createElement('a'); a.href = url; a.download = 'craps-audio.webm'; a.textContent = `Download ${sec}s audio recording`;
        a.style.cssText = 'position:fixed;left:16px;bottom:16px;z-index:99999;font:600 15px system-ui;color:#000;background:#9f9;padding:10px 14px;border-radius:8px';
        document.body.appendChild(a);
        try { this.clip.disconnect(dest); } catch { }
      };
      rec.start(1000);
      setTimeout(() => { try { rec.stop(); } catch { } }, sec * 1000);
    } catch (e) { this._fail(e); }
  }

  /** Shot/test mode: exercise every code path (silent output under ?shot; ?audiotest also meters a real throw). */
  _selfTest() {
    if (!AUDIOTEST) try {
      this.rattle(0.2); this.diceHit('felt', 0.9, 0, -3, 0, 0); this.diceHit('felt', 0.7, 0.012, -3, 0.3, 1); this.diceHit('wall', 0.8, 0.05, 16, 0, 0); this.diceHit('dice', 0.5, 0.1, 10, 0, 2);
      this.diceRoll({ fps: 60, slide: [[0, 0], [12, 4], [20, 9], [6, 0], [0, 0]], frames: null }, { delay: 0.1 });
      this.chips(3); this.chipsRail(2); this.chipStack(6); this.chipsTake(2); this.puck(); this.click(); this.error();
      this.win(0.2); this.win(0.9); this.lose(); this.sevenOut(); this.cheer(); this.groan();
      this.result({ outcome: 'point-made', totalWin: 120, net: 120 }); this.result({ outcome: 'craps', totalWin: 0, net: -10 });
      this.result({ outcome: 'point', totalWin: 5, net: -45 });
      // new paths: net-aware seven-out (Don't player wins), stingers, sweep, spatial chips, callout text
      this.result({ outcome: 'seven-out', total: 7, d1: 3, d2: 4, totalWin: 100, net: 100, events: [{ type: 'win', id: 'dontPass', win: 100 }] });
      this.result({ outcome: 'roll', total: 8, d1: 4, d2: 4, hard: true, totalWin: 90, net: 90, events: [{ type: 'win', id: 'hard8', win: 90 }] });
      this.result({ outcome: 'roll', total: 12, d1: 6, d2: 6, totalWin: 150, net: 150, events: [{ type: 'win', id: 'horn', win: 150 }] });
      this.result({ outcome: 'natural', total: 11, d1: 5, d2: 6, totalWin: 75, net: 75, events: [{ type: 'win', id: 'eleven', win: 75 }] });
      this.sweep(8, { x: 6, y: 0, z: 1 }); this.bankLand(8, { x: 0, y: 0.3, z: -5 }); this.chips(2, 0, { x: 9, y: 0, z: 2 }); this.puck({ x: 4, y: 0, z: -2 });
      for (const o of ['seven-out', 'natural', 'craps', 'point-set', 'point-made', 'roll']) for (const [a, b] of [[3, 4], [5, 6], [1, 1], [1, 2], [6, 6], [3, 3], [2, 3], [4, 5]]) AudioEngine.callText({ outcome: o, d1: a, d2: b, total: a + b, hard: a === b });
      this.cancelThrow();
      // the synthesized stickman + shout once their idle render is done
      let tries = 0;
      const voices = () => {
        if (!this._callRaw) { if (++tries < 150) setTimeout(voices, 200); return; }
        try {
          const co = this.callouts; this.callouts = true; // exercise the voice path even though it is opt-in
          this.callout({ outcome: 'seven-out', total: 7, d1: 3, d2: 4 }); this.callout({ outcome: 'natural', total: 11, d1: 5, d2: 6 }); this.callout({ outcome: 'point-set', total: 6, d1: 2, d2: 4 });
          this.callouts = co;
          this.shout('yo', 0.8);
          for (const o of ['seven-out', 'natural', 'craps', 'point-set', 'point-made', 'roll']) for (const [a, b] of [[3, 4], [5, 6], [1, 1], [1, 2], [6, 6], [3, 3], [2, 3], [4, 5]]) AudioEngine.callKey({ outcome: o, d1: a, d2: b, total: a + b, hard: a === b });
          const chimes = this.chimes; this.chimes = true; this.result({ outcome: 'roll', total: 8, d1: 4, d2: 4, hard: true, totalWin: 90, net: 90, events: [{ type: 'win', id: 'hard8', win: 90 }] }); this.sevenOut(); this.chimes = chimes;
        } catch (e) { this._fail(e); }
      };
      voices();
    } catch (e) { this._fail(e); }
    if (AUDIOTEST) {
      // a real simulated throw at real gain, so the meters show true dice-hit density and dynamics
      this._stats.hitsIn = 0; this._stats.hitsPlayed = 0;
      import('./physics.js').then((m) => {
        const throwOnce = () => {
          // meters cover only realistic play: one throw, a natural win, the payout
          Object.assign(this._stats, { hitsIn: 0, hitsPlayed: 0, dropped: 0, droppedHi: 0, peak: 0, rmsMax: 0, glueMax: 0, limMax: 0 });
          const sim = m.simulateThrow(Math.random);
          this.throwDice(sim, { pickup: 0.38, speed: 1 });
          setTimeout(() => { this.chips(3); this.result({ outcome: 'natural', total: 7, d1: 3, d2: 4, totalWin: 60, net: 60, events: [{ type: 'win', id: 'pass', win: 60 }] }); }, (0.6 + sim.duration) * 1000);
          setTimeout(() => this.chipsRail(3), (1.9 + sim.duration) * 1000);
        };
        setTimeout(throwOnce, 600);
      }).catch((e) => this._fail(e));
    }
  }
}

// test / tuning hooks (.review/tmp/audio_probe.html): bank renderers, the voice synth and the call table
export const __audioDebug = { BANKS, renderOneShot, renderSpeech, CALLS, RSR, VSR };
