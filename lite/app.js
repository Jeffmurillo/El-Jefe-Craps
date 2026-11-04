// El Jefe Craps Lite: a flat, top-down 2D table on the same casino-correct engine as the 3D game (../src/rules.js).
// Battery rules: no WebGL, no animation loop. The felt is one static SVG; only the chip layer, puck and dice are
// redrawn, and only when something changes. The dice tumble is a short CSS animation, and the audio context is
// suspended a few seconds after the last sound so the audio hardware can sleep.
import { CrapsGame, POINTS, HOP_IDS, rollDie } from '../src/rules.js';

const $ = (id) => document.getElementById(id);
const KEY = 'jefeLite.';
const store = {
  get(k, d) { try { const v = localStorage.getItem(KEY + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(KEY + k, JSON.stringify(v)); } catch (e) { } },
};
const fmt = (n) => (n < 0 ? '−$' : '$') + Math.abs(Math.round(n)).toLocaleString('en-US');
const signed = (n) => (n > 0 ? '+' : '') + fmt(n);
const esc = (s) => String(s).split('&').join('&amp;').split('<').join('&lt;');

// ---------- state ----------
const prefs = { speed: 'normal', sound: 'on', chip: 5, oddsMult: 'max', autoLimit: '250/300', ...store.get('prefs', {}) };
let game = (() => { const s = store.get('game', null); try { return s ? CrapsGame.restore(s) : new CrapsGame({ bankroll: 1000 }); } catch (e) { return new CrapsGame({ bankroll: 1000 }); } })();
let session = store.get('session', null) || { start: game.totalValue() };
let lastBets = store.get('last', null);
let lastNet = null;
let lastWins = [];          // [[id, stake]] winners from the last roll that stayed up (for Press)
let rolling = false, removeMode = false;
const undo = [];            // stack of batches: [[id, added], ...]
let batch = null;
const FAV_SLOTS = 3;
const favs = (() => { const v = store.get('favs', []); return Array.from({ length: FAV_SLOTS }, (_, i) => (v && v[i] && typeof v[i] === 'object' && v[i].bets ? v[i] : null)); })();
let saveT = 0;
function persist() { clearTimeout(saveT); saveT = setTimeout(() => { store.set('game', game.serialize()); store.set('session', session); store.set('last', lastBets); }, 250); }
window.lite = { busy: () => rolling || !!auto, game: () => game, auto: () => auto };

// ---------- sound: a few synthesized blips; the context sleeps when idle ----------
const sound = {
  ctx: null, t: 0,
  get() {
    if (prefs.sound !== 'on') return null;
    const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return null;
    if (!this.ctx) this.ctx = new AC();
    if (this.ctx.state === 'suspended') this.ctx.resume();
    clearTimeout(this.t); this.t = setTimeout(() => this.ctx && this.ctx.suspend(), 4000);
    return this.ctx;
  },
  tone(f, dur, { type = 'sine', gain = 0.12, at = 0 } = {}) {
    const c = this.get(); if (!c) return;
    const o = c.createOscillator(), g = c.createGain(), t = c.currentTime + at;
    o.type = type; o.frequency.value = f; g.gain.setValueAtTime(gain, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(c.destination); o.start(t); o.stop(t + dur + 0.02);
  },
  click(at = 0, f = 2400) {
    const c = this.get(); if (!c) return;
    const len = Math.floor(c.sampleRate * 0.03), buf = c.createBuffer(1, len, c.sampleRate), d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 3;
    const s = c.createBufferSource(), bp = c.createBiquadFilter(), g = c.createGain();
    bp.type = 'bandpass'; bp.frequency.value = f; bp.Q.value = 1.2; g.gain.value = 0.5;
    s.buffer = buf; s.connect(bp).connect(g).connect(c.destination); s.start(c.currentTime + at);
  },
  chip() { this.click(0, 3200); this.click(0.04, 2800); },
  dice(ms) { for (let t = 0; t < ms / 1000; t += 0.09 + Math.random() * 0.07) this.click(t, 900 + Math.random() * 900); },
  win() { this.tone(784, 0.18, { at: 0 }); this.tone(1046, 0.28, { at: 0.1 }); },
  lose() { this.tone(180, 0.3, { type: 'triangle', gain: 0.1 }); },
  error() { this.tone(240, 0.12, { type: 'square', gain: 0.04 }); },
};

// ---------- toast ----------
let toastT = 0;
function toast(msg, ok = false) {
  const t = $('toast'); t.textContent = msg; t.className = 'toast show' + (ok ? ' ok' : '');
  clearTimeout(toastT); toastT = setTimeout(() => { t.className = 'toast'; }, Math.min(6000, 2200 + msg.length * 25));
  if (!ok) sound.error();
}

// ---------- the felt (built once) ----------
const W = 1000, H = 380;
const NX = (n) => 95 + POINTS.indexOf(n) * 100;          // number box left edge
const R = { A: [6, 114], lay: [6, 32], mid: [32, 88], buy: [88, 114], come: [118, 178], field: [182, 242], dp: [246, 290], pass: [294, 374] };
const PX = 705, PW = 289;                                 // proposition column
const P = { any7: [6, 44], hard1: [48, 104], hard2: [108, 164], one: [168, 222], craps: [226, 262], horn: [266, 304], side: [308, 374] };

const PIPS = { 1: [[0, 0]], 2: [[-1, -1], [1, 1]], 3: [[-1, -1], [0, 0], [1, 1]], 4: [[-1, -1], [1, -1], [-1, 1], [1, 1]], 5: [[-1, -1], [1, -1], [0, 0], [-1, 1], [1, 1]], 6: [[-1, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [1, 1]] };
function dieSVG(cx, cy, s, v, cls = 'mdie') {
  const h = s / 2, k = s * 0.27, r = s * 0.1;
  return `<g class="${cls}"><rect x="${cx - h}" y="${cy - h}" width="${s}" height="${s}" rx="${s * 0.2}"/>` + PIPS[v].map(([a, b]) => `<circle cx="${cx + a * k}" cy="${cy + b * k}" r="${r}"/>`).join('') + '</g>';
}
const area = (id, x, y, w, h, cls = '') => `<rect class="zone ${cls}" data-bet="${id}" x="${x}" y="${y}" width="${w}" height="${h}" rx="6"/>`;
const text = (x, y, s, cls = '', size = 14, extra = '') => `<text class="${cls}" x="${x}" y="${y}" font-size="${size}" ${extra}>${s}</text>`;

function buildFelt() {
  let s = `<defs><radialGradient id="fg" cx="45%" cy="40%" r="75%"><stop offset="0" stop-color="#17704a"/><stop offset="1" stop-color="#0b3d27"/></radialGradient></defs>`;
  s += `<rect x="0" y="0" width="${W}" height="${H}" rx="18" fill="url(#fg)"/>`;
  // don't come bar
  s += area('dontCome', 10, R.A[0], 80, R.A[1] - R.A[0]);
  s += text(50, 58, "DON'T", 'lbl', 12) + text(50, 72, 'COME', 'lbl', 12) + text(50, 86, 'BAR', 'lbl', 12) + dieSVG(42, 102, 12, 6, 'mdie bar') + dieSVG(58, 102, 12, 6, 'mdie bar');
  // place / buy / lay boxes
  for (const n of POINTS) {
    const x = NX(n);
    s += area('lay' + n, x, R.lay[0], 100, R.lay[1] - R.lay[0], 'strip');
    s += text(x + 50, R.lay[0] + 18, 'LAY', 'lbl dim', 11);
    s += area('place' + n, x, R.mid[0], 100, R.mid[1] - R.mid[0], 'num');
    s += text(x + 50, R.mid[0] + 39, String(n), 'numtxt', 32) + (n === 6 || n === 9 ? `<rect class="uline" x="${x + 42}" y="${R.mid[0] + 44}" width="16" height="2"/>` : '');
    s += area('buy' + n, x, R.buy[0], 100, R.buy[1] - R.buy[0], 'strip');
    s += text(x + 50, R.buy[0] + 18, 'BUY', 'lbl dim', 11);
  }
  s += area('come', 10, R.come[0], 685, R.come[1] - R.come[0]);
  s += text(352, R.come[0] + 42, 'COME', 'big', 34);
  s += area('field', 10, R.field[0], 685, R.field[1] - R.field[0]);
  s += text(80, R.field[0] + 38, 'FIELD', 'big gold', 26);
  const fn = [[2, '2×'], [3], [4], [9], [10], [11], [12, '3×']];
  fn.forEach(([n, tag], i) => {
    const x = 180 + i * 72;
    if (tag) s += `<circle class="ring" cx="${x}" cy="${R.field[0] + 30}" r="19"/>` + text(x, R.field[0] + 56, tag, 'lbl dim fieldtag', 10, `data-field="${n}"`);
    s += text(x, R.field[0] + 38, n, 'fnum', 22);
  });
  s += area('dontPass', 10, R.dp[0], 550, R.dp[1] - R.dp[0]);
  s += text(285, R.dp[0] + 29, "DON'T PASS BAR", 'big', 20) + dieSVG(410, R.dp[0] + 22, 15, 6, 'mdie bar') + dieSVG(428, R.dp[0] + 22, 15, 6, 'mdie bar');
  s += area('dontPassOdds', 566, R.dp[0], 129, R.dp[1] - R.dp[0], 'odds');
  s += text(630, R.dp[0] + 27, 'LAY ODDS', 'lbl dim', 12);
  s += area('pass', 10, R.pass[0], 550, R.pass[1] - R.pass[0]);
  s += text(285, R.pass[0] + 52, 'PASS LINE', 'big', 38);
  s += area('passOdds', 566, R.pass[0], 129, R.pass[1] - R.pass[0], 'odds');
  s += text(630, R.pass[0] + 46, 'ODDS', 'lbl dim', 14);
  // proposition column
  s += area('any7', PX, P.any7[0], PW, P.any7[1] - P.any7[0], 'prop red');
  s += text(PX + PW / 2, P.any7[0] + 26, 'SEVEN · 4 to 1', 'ptxt red', 16);
  const hard = [['hard6', 3, 9], ['hard10', 5, 7], ['hard8', 4, 9], ['hard4', 2, 7]];
  hard.forEach(([id, d, pays], i) => {
    const row = i < 2 ? P.hard1 : P.hard2, x = PX + (i % 2) * (PW / 2 + 2), w = PW / 2 - 2, y = row[0], h = row[1] - row[0];
    s += area(id, x, y, w, h, 'prop');
    s += dieSVG(x + w / 2 - 12, y + 22, 20, d) + dieSVG(x + w / 2 + 12, y + 22, 20, d) + text(x + w / 2, y + 49, `${pays} to 1`, 'ptxt', 12);
  });
  const one = [['two', [1, 1], 30], ['three', [1, 2], 15], ['twelve', [6, 6], 30], ['eleven', [5, 6], 15]];
  const ow = PW / 4;
  one.forEach(([id, [a, b], pays], i) => {
    const x = PX + i * ow, y = P.one[0], h = P.one[1] - P.one[0];
    s += area(id, x + 1, y, ow - 2, h, 'prop');
    s += dieSVG(x + ow / 2 - 9, y + 19, 15, a) + dieSVG(x + ow / 2 + 9, y + 19, 15, b) + text(x + ow / 2, y + 45, `${pays}:1`, 'ptxt', 11);
  });
  s += area('anyCraps', PX, P.craps[0], PW, P.craps[1] - P.craps[0], 'prop red');
  s += text(PX + PW / 2, P.craps[0] + 24, 'ANY CRAPS · 7 to 1', 'ptxt red', 15);
  s += area('horn', PX, P.horn[0], PW / 2 - 2, P.horn[1] - P.horn[0], 'prop');
  s += text(PX + PW / 4, P.horn[0] + 24, 'HORN · $4 units', 'ptxt', 12);
  s += area('ce', PX + PW / 2 + 2, P.horn[0], PW / 2 - 2, P.horn[1] - P.horn[0], 'prop');
  s += text(PX + PW * 0.75, P.horn[0] + 24, 'C & E · $2 units', 'ptxt', 12);
  [['fire', 'FIRE', '24–999:1'], ['small', 'SMALL', '2–6 · 34:1'], ['tall', 'TALL', '8–12 · 34:1'], ['all', 'ALL', '175:1']].forEach(([id, t, sub], i) => {
    const x = PX + i * ow, y = P.side[0], h = P.side[1] - P.side[0];
    s += area(id, x + 1, y, ow - 2, h, 'prop side');
    s += text(x + ow / 2, y + 20, t, 'ptxt gold', 13) + text(x + ow / 2, y + 35, sub, 'lbl dim', 9);
  });
  s += '<g id="dynG"></g><g id="betsG"></g><g id="diceG"></g><g id="fxG"></g>';
  $('felt').innerHTML = s;
}

// where each bet's chip sits
function posFor(id) {
  const m = /^([a-zA-Z]+?)(\d+)$/.exec(id);
  if (m && POINTS.includes(Number(m[2])) && !id.startsWith('hard') && !id.startsWith('hop')) {
    const k = m[1], x = NX(Number(m[2]));
    switch (k) {
      case 'place': return [x + 83, 70];
      case 'buy': return [x + 50, 101];
      case 'lay': return [x + 76, 19];
      case 'come': return [x + 17, 72];
      case 'comeOdds': return [x + 27, 62];
      case 'dontCome': return [x + 22, 19];
      case 'dontComeOdds': return [x + 36, 15];
    }
  }
  const hardPos = { hard6: 0, hard10: 1, hard8: 2, hard4: 3 };
  if (id in hardPos) { const i = hardPos[id], row = i < 2 ? P.hard1 : P.hard2; return [PX + (i % 2) * (PW / 2 + 2) + 18, row[0] + 18]; }
  const ow = PW / 4;
  const oneI = ['two', 'three', 'twelve', 'eleven'].indexOf(id); if (oneI >= 0) return [PX + oneI * ow + 14, P.one[0] + 40];
  const sideI = ['fire', 'small', 'tall', 'all'].indexOf(id); if (sideI >= 0) return [PX + sideI * ow + ow / 2, P.side[0] + 52];
  if (id.startsWith('hop')) { const i = HOP_IDS.indexOf(id); return [PX + 20 + (i % 7) * 40, P.any7[0] + 19 + Math.floor(i / 7) * 0]; }
  switch (id) {
    case 'pass': return [150, R.pass[0] + 56];
    case 'passOdds': return [630, R.pass[0] + 62];
    case 'dontPass': return [120, R.dp[0] + 22];
    case 'dontPassOdds': return [630, R.dp[0] + 22];
    case 'come': return [150, R.come[0] + 30];
    case 'dontCome': return [50, 74];
    case 'field': return [40, R.field[0] + 30];
    case 'any7': return [PX + 22, P.any7[0] + 19];
    case 'anyCraps': return [PX + 22, P.craps[0] + 18];
    case 'horn': return [PX + 18, P.horn[0] + 19];
    case 'ce': return [PX + PW / 2 + 20, P.horn[0] + 19];
    case 'big6': return [600, R.come[0] + 30];
    case 'big8': return [645, R.come[0] + 30];
    case 'world': return [PX + PW / 2, P.horn[0] + 19];
    default: if (/^hornHigh/.test(id)) return [PX + 40, P.horn[0] + 19]; return [500, R.come[0] + 30];
  }
}

const DENOMS = [[1000, 'c1k'], [500, 'c500'], [100, 'c100'], [25, 'c25'], [5, 'c5'], [1, 'c1']];
const chipCls = (a) => (DENOMS.find(([d]) => a >= d) || DENOMS[5])[1];
const chipLbl = (a) => (a >= 10000 ? Math.round(a / 1000) + 'K' : a >= 1000 ? (Math.round(a / 100) / 10) + 'K' : String(a));
function chipSVG(id, x, y, a, off) {
  return `<g class="chip ${chipCls(a)}" data-bet="${id}"><circle cx="${x}" cy="${y}" r="13"/><circle class="in" cx="${x}" cy="${y}" r="9"/>`
    + `<text x="${x}" y="${y + 3.6}" font-size="${a >= 1000 ? 9 : 10}">${chipLbl(a)}</text>`
    + (off ? `<g class="off"><rect x="${x - 11}" y="${y - 20}" width="22" height="10" rx="3"/><text x="${x}" y="${y - 12.3}" font-size="8">OFF</text></g>` : '') + '</g>';
}

function renderTable() {
  let b = '';
  const hops = Object.keys(game.bets).filter((id) => id.startsWith('hop'));
  for (const [id, a] of Object.entries(game.bets)) {
    if (id.startsWith('hop')) continue;
    const [x, y] = posFor(id);
    b += chipSVG(id, x, y, a, !game.isWorking(id));
  }
  // hop bets have no box on the felt: show them as a labelled row along the top of the seven box
  hops.forEach((id, i) => { const x = PX + 20 + i * 34, y = P.any7[0] + 19; b += chipSVG(id, x, y, game.bets[id], false) + `<text class="hoplbl" x="${x}" y="${y + 21}" font-size="8">${id[3]}-${id[4]}</text>`; });
  $('betsG').innerHTML = b;
  // puck, odds availability, fire / ATS progress
  let d = '';
  if (game.point) { const x = NX(game.point); d += `<rect class="hilite" x="${x + 2}" y="${R.mid[0] + 1}" width="96" height="${R.mid[1] - R.mid[0] - 2}" rx="6"/>`; d += `<g class="puck on"><circle cx="${x + 86}" cy="${R.mid[0] + 12}" r="11"/><text x="${x + 86}" y="${R.mid[0] + 15.5}" font-size="9">ON</text></g>`; }
  else d += `<g class="puck"><circle cx="50" cy="${R.A[0] + 20}" r="11"/><text x="50" y="${R.A[0] + 23.5}" font-size="8.5">OFF</text></g>`;
  if (!(game.point && game.bets.pass)) d += `<rect class="shade" x="566" y="${R.pass[0]}" width="129" height="${R.pass[1] - R.pass[0]}" rx="6"/>`;
  if (!(game.point && game.bets.dontPass)) d += `<rect class="shade" x="566" y="${R.dp[0]}" width="129" height="${R.dp[1] - R.dp[0]}" rx="6"/>`;
  if (!game.point) d += `<rect class="shade" x="10" y="${R.come[0]}" width="685" height="${R.come[1] - R.come[0]}" rx="6"/><rect class="shade" x="10" y="${R.A[0]}" width="80" height="${R.A[1] - R.A[0]}" rx="6"/>`;
  else d += `<rect class="shade" x="10" y="${R.dp[0]}" width="550" height="${R.dp[1] - R.dp[0]}" rx="6"/>`;
  const ow = PW / 4;
  if (game.stats.currentRoll > 0 && !game.bets.fire) d += `<rect class="shade" x="${PX + 1}" y="${P.side[0]}" width="${ow - 2}" height="${P.side[1] - P.side[0]}" rx="6"/>`;
  if (game.firePoints.length) d += `<text class="prog" x="${PX + ow / 2}" y="${P.side[0] + 47}" font-size="9">${game.firePoints.length} pt${game.firePoints.length > 1 ? 's' : ''}</text>`;
  const ats = { small: [2, 3, 4, 5, 6], tall: [8, 9, 10, 11, 12], all: [2, 3, 4, 5, 6, 8, 9, 10, 11, 12] };
  Object.entries(ats).forEach(([id, nums], i) => {
    const x = PX + (i + 1) * ow;
    if (game.atsHits.length && !game.bets[id]) d += `<rect class="shade" x="${x + 1}" y="${P.side[0]}" width="${ow - 2}" height="${P.side[1] - P.side[0]}" rx="6"/>`;
    const hit = nums.filter((n) => game.atsHits.includes(n)).length;
    if (hit && game.bets[id]) d += `<text class="prog" x="${x + ow / 2}" y="${P.side[0] + 47}" font-size="9">${hit}/${nums.length}</text>`;
  });
  $('dynG').innerHTML = d;
  // field 2 / 12 pays follow the settings
  for (const t of document.querySelectorAll('.fieldtag')) t.textContent = (t.dataset.field === '2' ? game.settings.fieldTwoPays : game.settings.fieldTwelvePays) + '×';
  renderHUD();
}

let dice = store.get('dice', [6, 6]);
function renderDice(cls = '') {
  const [a, b] = dice, cx = 560, cy = R.come[0] + 30;
  $('diceG').innerHTML = `<g class="dice ${cls}">${dieSVG(cx - 26, cy, 40, a, 'bdie')}${dieSVG(cx + 26, cy, 40, b, 'bdie')}</g>`;
}

function renderHUD() {
  $('bank').textContent = fmt(game.bankroll);
  $('onTable').textContent = fmt(game.totalOnTable());
  const net = game.totalValue() - session.start;
  const sn = $('sessionNet'); sn.textContent = signed(net); sn.className = net > 0 ? 'pos' : net < 0 ? 'neg' : '';
  const st = $('status');
  const base = game.point ? `Point is ${game.point}` : 'Come-out roll';
  st.innerHTML = esc(base) + (lastNet != null && lastNet !== 0 ? ` <span class="${lastNet > 0 ? 'pos' : 'neg'}">${lastNet > 0 ? 'won' : 'lost'} ${fmt(Math.abs(lastNet))}</span>` : '');
  const h = game.history.slice(-9);
  $('histStrip').innerHTML = h.map((r) => `<i class="${r.total === 7 ? 'r7' : r.outcome === 'point-made' ? 'rp' : r.outcome === 'natural' ? 'rn' : ''}">${r.total}</i>`).join('') || '<em>no rolls</em>';
  const rb = $('rollBtn'); rb.disabled = rolling && !auto; rb.textContent = auto ? 'STOP' : 'ROLL'; rb.classList.toggle('stop', !!auto);
  $('undoBtn').disabled = !undo.length;
  $('rebetBtn').disabled = !lastBets;
  $('regressBtn').disabled = rolling || !Object.keys(game.bets).some((id) => /^place\d+$/.test(id));
  $('pressBtn').disabled = rolling || !pressPlan().length;
  renderFavs();
}

// ---------- placing bets ----------
const NAME = (id) => game.betInfo(id).name;
function record(id, add) { if (batch) batch.push([id, add]); else undo.push([[id, add]]); if (undo.length > 60) undo.shift(); }
function begin() { batch = []; }
function end() { if (batch && batch.length) undo.push(batch); batch = null; }
let putArm = 0;

/** Tap a chip onto a bet the way a dealer books it (payable units, the table minimum, max odds). */
function addChip(id, chip = prefs.chip, { quiet = false } = {}) {
  if (rolling) { toast('No more bets — dice are rolling'); return false; }
  const isOdds = /Odds/.test(id);
  if (id === 'pass' && game.point && !game.bets.pass) {
    if (Date.now() - putArm > 3000) { putArm = Date.now(); toast('That would be a Put bet (no come-out edge). Tap again to confirm — or use Come instead.'); return false; }
  }
  let r = isOdds ? game.oddsStake(id, chip) : game.chipStake(id, chip);
  let raised = false;
  if (!r.add && r.short && !isOdds) { r = game.chipStake(id, chip + r.short); raised = r.add > 0; }
  if (!r.add) {
    if (isOdds && r.full) { const v = game.validate(id, game.unitFor(id)); toast(v.ok ? `${NAME(id)} is at the maximum` : v.reason); return false; }
    const v = game.validate(id, Math.max(chip, game.minFor(id))); toast(v.ok ? 'Insufficient bankroll' : v.reason); return false;
  }
  const v = game.placeBet(id, r.add);
  if (!v.ok) { toast(v.reason); return false; }
  record(id, r.add);
  if (!quiet) {
    sound.chip();
    if (raised) toast(`${NAME(id)}: raised to the ${fmt(game.minFor(id))} minimum — ${fmt(game.amount(id))} up`, true);
    else if (r.change) toast(`${NAME(id)} booked at ${fmt(game.amount(id))} (pays clean) — ${fmt(r.change)} back`, true);
    else if (r.extra) toast(`${NAME(id)} rounded up to ${fmt(game.amount(id))} so it pays clean`, true);
    else if (v.vig) toast(`${NAME(id)} ${fmt(game.amount(id))} — ${fmt(v.vig)} commission paid`, true);
    renderTable(); persist();
  }
  return true;
}

/** Take down a bet (and anything riding on it). Returns the dollars returned. */
function takeDown(id, { quiet = false } = {}) {
  if (rolling) { toast('No more bets — dice are rolling'); return 0; }
  if (!game.bets[id]) return 0;
  const c = game.canRemove(id);
  if (!c.ok) { if (!quiet) toast(c.reason); return 0; }
  const r = game.removeBet(id);
  const back = r.removed.reduce((s, x) => s + x.amount + (x.vig || 0), 0);
  if (!quiet) { sound.chip(); toast(`${NAME(id)} down — ${fmt(back)} back`, true); renderTable(); persist(); }
  return back;
}

/** What a tap on the felt means: odds behind a bet that is up, the Buy instead of the Place when one exists. */
function tapTarget(id) {
  const m = /^(come|dontCome)(\d+)$/.exec(id); if (m) return (m[1] === 'come' ? 'comeOdds' : 'dontComeOdds') + m[2];
  const p = /^place(\d+)$/.exec(id); if (p && game.bets['buy' + p[1]]) return 'buy' + p[1];
  if (game.point && id === 'pass' && game.bets.pass) return 'passOdds';
  if (game.point && id === 'dontPass' && game.bets.dontPass) return 'dontPassOdds';
  return id;
}
function holdTarget(id) {
  const p = /^place(\d+)$/.exec(id); if (p && !game.bets[id] && game.bets['buy' + p[1]]) return 'buy' + p[1];
  if (id === 'pass' && game.point && game.bets.passOdds) return 'passOdds';
  const m = /^(come|dontCome)(\d+)$/.exec(id); if (m && game.bets[(m[1] === 'come' ? 'comeOdds' : 'dontComeOdds') + m[2]] && m[1] === 'come') return 'comeOdds' + m[2];
  return id;
}

/** Undo the last tap (or the last group / favorite / rebet as a whole). */
function undoLast() {
  if (rolling) return;
  const b = undo.pop(); if (!b) return;
  for (const [id, add] of b.slice().reverse()) {
    const cur = game.amount(id); if (!cur) continue;
    if (!game.canRemove(id).ok) continue;
    const r = game.removeBet(id);
    for (const x of r.removed) {
      const keep = x.id === id ? x.amount - add : x.amount;
      if (keep > 0) game.placeBet(x.id, keep);
    }
  }
  sound.chip(); renderTable(); persist();
}

function clearAll() {
  if (rolling) return;
  let back = 0;
  for (const id of Object.keys(game.bets)) if (game.bets[id] && game.canRemove(id).ok) back += takeDown(id, { quiet: true });
  undo.length = 0;
  if (!back) toast('Nothing to take down — line and come bets are contract bets', true);
  else { sound.chip(); toast(`${fmt(back)} back to your rack`, true); }
  renderTable(); persist();
}

// Odds button size: 1x / 2x the flat bet, or the table maximum. Lay odds are sized by the win (1x = the lay wins the flat).
const ODDS_MULTS = ['1', '2', 'max'];
const oddsMultLabel = (m = prefs.oddsMult) => (m === 'max' ? 'Max' : m + '×');
const LAY_RATIO = { 4: 2, 10: 2, 5: 1.5, 9: 1.5, 6: 1.2, 8: 1.2 };
/** How much to add behind one flat bet to bring its odds up to the chosen size (0 if already there). */
function oddsAddFor(flat, oddsId, num, mult = prefs.oddsMult) {
  const cap = game.maxOddsAdd(oddsId); if (cap <= 0) return 0;
  if (mult === 'max') return cap;
  const u = game.unitFor(oddsId), cur = game.amount(oddsId), lay = oddsId.startsWith('dont');
  const target = Math.ceil((game.amount(flat) * Number(mult) * (lay ? LAY_RATIO[num] : 1)) / u - 1e-9) * u;
  return Math.max(0, Math.min(cap, target - cur));
}
function oddsTargets() {
  const out = [];
  if (game.point) for (const f of ['pass', 'dontPass']) if (game.bets[f]) out.push([f, f + 'Odds', game.point]);
  for (const n of POINTS) for (const f of ['come', 'dontCome']) if (game.bets[f + n]) out.push([f + n, f + 'Odds' + n, n]);
  return out;
}
function maxOdds({ quiet = false } = {}) {
  if (rolling) return 0;
  const t = oddsTargets(); let sum = 0;
  if (!quiet) begin();
  for (const [f, o, n] of t) {
    const add = oddsAddFor(f, o, n); if (add <= 0) continue;
    if (game.placeBet(o, add).ok) { if (!quiet) record(o, add); sum += add; }
  }
  if (quiet) return sum;
  end();
  if (!t.length) { toast(game.point ? 'No line or come bets to back with odds' : 'Odds open once a point is set'); return 0; }
  if (!sum) { toast(`Odds are already at ${oddsMultLabel()} (or the rack is empty)`, true); return 0; }
  sound.chip(); toast(`${oddsMultLabel()} odds — ${fmt(sum)} added`, true); renderTable(); persist();
  return sum;
}
function renderOddsBtn() {
  const m = prefs.oddsMult, b = $('oddsBtn');
  b.innerHTML = `<span class="om">${m === 'max' ? 'MAX' : m + '×'}</span><small>Odds</small>`;
  b.title = `Add ${m === 'max' ? 'maximum' : m + '×'} odds behind the Pass Line and every Come bet · hold to change`;
}
function cycleOddsMult() {
  prefs.oddsMult = ODDS_MULTS[(ODDS_MULTS.indexOf(prefs.oddsMult) + 1) % ODDS_MULTS.length];
  store.set('prefs', prefs); renderOddsBtn(); syncSegs(); sound.click(0, 3000);
  toast(`Odds button now adds ${prefs.oddsMult === 'max' ? 'maximum (3-4-5×)' : prefs.oddsMult + '×'} odds`, true);
}

// ---------- auto-play: runs a line-bet strategy for you and stops at the walk-away limits ----------
const AUTO = {
  molly3: { label: '3-Point Molly', sub: 'Pass + 2 Come', comes: 2 },
  molly2: { label: '2-Point Molly', sub: 'Pass + 1 Come', comes: 1 },
  pass: { label: 'Pass + odds', sub: 'Pass Line only', comes: 0 },
};
const LIMITS = { '250/300': [250, 300], '300/400': [300, 400], '500/500': [500, 500], none: [0, 0] };
let auto = null;   // { key, start, win, loss, t }
function autoBets() {
  const s = AUTO[auto.key], min = game.settings.tableMin;
  if (!game.point) { if (!game.bets.pass && !(game.validate('pass', min).ok && game.placeBet('pass', min).ok)) return false; }
  else {
    const comes = POINTS.filter((n) => game.bets['come' + n]).length;
    if (comes < s.comes && !game.bets.come && game.validate('come', min).ok) game.placeBet('come', min);
    maxOdds({ quiet: true });
  }
  return true;
}
function autoStep() {
  if (!auto) return;
  if (rolling) { auto.t = setTimeout(autoStep, 200); return; }
  const net = game.totalValue() - auto.start;
  if (!game.point) {
    if (auto.win && net >= auto.win) return stopAuto(`Goal reached: ${signed(net)}. Walk away a winner!`, true);
    if (auto.loss && net <= -auto.loss) return stopAuto(`Stop-loss hit: ${signed(net)}. Time for a break.`);
  }
  if (!autoBets()) return stopAuto('Auto-play stopped: not enough chips for the Pass Line');
  renderTable(); roll();
}
function startAuto(key) {
  if (rolling) return;
  const [win, loss] = LIMITS[prefs.autoLimit] || LIMITS['250/300'];
  auto = { key, start: game.totalValue(), win, loss, t: 0 };
  closeSheets(); removeMode && setRemove(false);
  toast(`Auto-play: ${AUTO[key].label} · ${oddsMultLabel()} odds${win ? ` · +${fmt(win)} / −${fmt(loss)}` : ''}`, true);
  renderHUD(); autoStep();
}
function stopAuto(msg, ok) {
  if (!auto) return;
  clearTimeout(auto.t); auto = null;
  renderHUD();
  if (msg) toast(msg + (POINTS.some((n) => game.bets['come' + n]) ? ' (your Come bets are still working)' : ''), ok);
}
const autoDelay = () => (prefs.speed === 'instant' ? 350 : prefs.speed === 'fast' ? 900 : 1700);

// ---------- group bets (Across, Inside, Hardways …): the selected chip is the unit ----------
const GROUPS = [
  { key: 'across', label: 'Across', sub: '4 5 6 8 9 10', nums: [4, 5, 6, 8, 9, 10] },
  { key: 'inside', label: 'Inside', sub: '5 6 8 9', nums: [5, 6, 8, 9] },
  { key: 'outside', label: 'Outside', sub: '4 5 9 10', nums: [4, 5, 9, 10] },
  { key: 'mid', label: 'Mid', sub: '6 & 8', nums: [6, 8] },
  { key: 'hardways', label: 'Hardways', sub: '4 6 8 10', ids: ['hard4', 'hard6', 'hard8', 'hard10'] },
  { key: 'hopHard', label: 'Hop hards', sub: '1-1 … 6-6', ids: ['hop11', 'hop22', 'hop33', 'hop44', 'hop55', 'hop66'] },
  { key: 'ironCross', label: 'Iron Cross', sub: 'Field + 5 6 8', ids: ['field'], nums: [5, 6, 8] },
];
function groupPlan(g) {
  const u = prefs.chip, n = Math.max(1, Math.ceil(u / 5 - 1e-9));
  const plan = [], skipped = [];
  for (const id of g.ids || []) plan.push([id, Math.max(u, game.minFor(id))]);
  for (const num of g.nums || []) {
    if (game.point === num) { skipped.push(num); continue; }
    const id = game.bets['buy' + num] ? 'buy' + num : 'place' + num;
    const unit = num === 6 || num === 8 ? 6 : 5, min = game.minFor(id);
    plan.push([id, Math.max(unit * n, Math.ceil(min / unit - 1e-9) * unit)]);
  }
  return { plan, skipped, total: plan.reduce((s, [id, a]) => s + a + game.upfrontVig(id, a), 0) };
}
function placeGroup(g) {
  if (rolling) { toast('No more bets — dice are rolling'); return false; }
  const p = groupPlan(g);
  if (!p.plan.length) { toast(`${g.label}: the point covers it — nothing to place`, true); return false; }
  const bad = p.plan.map(([id, a]) => game.validate(id, a)).find((v) => !v.ok);
  if (bad) { toast(`${g.label} not booked — ${bad.reason}`); return false; }
  if (p.total > game.bankroll) { toast(`${g.label} needs ${fmt(p.total)} — insufficient bankroll`); return false; }
  begin(); for (const [id, a] of p.plan) if (game.placeBet(id, a).ok) record(id, a); end();
  sound.chip();
  toast(`${fmt(p.total)} ${g.label} — ` + p.plan.map(([id, a]) => `${NAME(id).replace(/^(Place|Buy|Hard|Hop) /, '')} ${fmt(a)}`).join(' · ') + (p.skipped.length ? ` (skips the ${p.skipped[0]}, the point)` : ''), true);
  renderTable(); persist(); return true;
}
function regress() {
  if (rolling) return;
  let back = 0;
  for (const [id, a] of Object.entries(game.bets)) {
    const m = /^place(\d+)$/.exec(id); if (!m) continue;
    const num = Number(m[1]), unit = num === 6 || num === 8 ? 6 : 5, min = game.minFor(id);
    const to = Math.max(Math.ceil(min / unit - 1e-9) * unit, Math.floor(a / 2 / unit) * unit);
    if (to >= a) continue;
    const w = game.isWorking(id);
    if (!game.removeBet(id).ok) continue;
    if (!game.placeBet(id, to).ok) { game.placeBet(id, a); continue; }
    if (game.isWorking(id) !== w) game.setWorking(id, w);
    back += a - to;
  }
  undo.length = 0;
  if (!back) { toast('No place bets to regress (already at the minimum)', true); return; }
  sound.chip(); toast(`Regressed — ${fmt(back)} back to your rack`, true); renderTable(); persist();
}
function downPlaces() {
  let back = 0; for (const id of Object.keys(game.bets)) if (/^(place|buy|lay)\d/.test(id)) back += takeDown(id, { quiet: true });
  if (!back) toast('No place, buy or lay bets up', true); else { sound.chip(); toast(`Place bets down — ${fmt(back)} back`, true); }
  renderTable(); persist();
}

// ---------- layouts: Rebet and favorites ----------
function layoutOf(bets) { const s = {}; for (const [id, a] of Object.entries(bets)) if (!/^(come|dontCome|comeOdds|dontComeOdds)\d/.test(id)) s[id] = a; return s; }
function applyLayout(snapshot, label) {
  if (rolling) { toast('No more bets — dice are rolling'); return false; }
  const plan = game.rebetPlan(snapshot, 0);
  let sum = 0; const failed = [];
  begin();
  for (const [id, add] of plan.plan) { const v = game.placeBet(id, add); if (v.ok) { record(id, add); sum += add; } else failed.push(NAME(id)); }
  end();
  const msgs = [];
  if (plan.skipped.some((x) => x.id === 'pass' && /^point is on/.test(x.reason))) msgs.push('Pass Line skipped — the point is on');
  if (plan.skipped.some((x) => x.id === 'dontPass' && /^point is on/.test(x.reason))) msgs.push("Don't Pass skipped — closed once the point is on");
  const other = plan.skipped.filter((x) => !/^point is on|no (odds )?room|flat bet|travel/.test(x.reason));
  if (other.length) msgs.push(other.map((x) => `${NAME(x.id)}: ${x.reason}`).join(' · '));
  if (failed.length) msgs.push('Not booked (bankroll): ' + failed.join(', '));
  msgs.unshift(sum ? `${label} — ${fmt(sum)} booked` : failed.length || other.length ? `${label} — nothing booked` : `${label} is already on the table`);
  toast(msgs.join(' · '), sum > 0 && !failed.length);
  if (sum) sound.chip();
  renderTable(); persist(); return sum > 0;
}
const atTableMin = (bets) => { const o = {}; for (const [id, a] of Object.entries(bets)) o[id] = /Odds/.test(id) ? a : Math.max(a, game.minFor(id)); return o; };
const SHORT = (id) => NAME(id).replace(/^Place /, 'P').replace(/^Buy /, 'B').replace(/^Lay /, 'L').replace(/^Hard /, 'H').replace(/^Pass Line Odds$/, 'Odds').replace(/^Pass Line$/, 'Pass').replace(/^Don't Pass$/, 'DP');
function favSummary(f) { const ids = Object.keys(f.bets); return `${fmt(Object.values(f.bets).reduce((a, b) => a + b, 0))} — ${ids.slice(0, 5).map(SHORT).join(' · ')}${ids.length > 5 ? ` +${ids.length - 5}` : ''}`; }
function renderFavs() {
  $('favs').innerHTML = favs.map((f, i) => {
    const tot = f ? Object.values(f.bets).reduce((a, b) => a + b, 0) : 0;
    return `<button class="fav ${f ? 'set' : ''}" data-fav="${i}" title="${f ? esc(favSummary(f)) + ' — tap to bet, hold to replace or clear' : 'Empty — tap to save the bets on the table'}">★${i + 1}<small>${f ? fmt(tot) : 'save'}</small></button>`;
  }).join('');
}
function saveFav(i) {
  const bets = layoutOf(game.bets);
  if (!Object.keys(bets).length) { toast('Put the bets you want on the table first, then tap the star', true); return; }
  const had = !!favs[i]; favs[i] = { bets, at: Date.now() }; store.set('favs', favs); renderFavs();
  sound.chip(); toast(`Favorite ${i + 1} ${had ? 'replaced' : 'saved'} — ${favSummary(favs[i])}`, true);
}
let favOpen = -1;
function openFavSheet(i) {
  favOpen = i; const f = favs[i];
  $('favTitle').textContent = `Favorite ${i + 1}`;
  $('favDesc').textContent = f ? favSummary(f) : 'Empty slot.';
  $('favClear').disabled = !f;
  openSheet('favSheet');
}

/** Press: double the bet you put down last — or, right after a roll, every winner that stayed up. One undo step. */
function pressPlan() {
  const top = undo[undo.length - 1];
  if (top) return [...new Set(top.map(([id]) => id))].filter((id) => game.amount(id) > 0).map((id) => [id, game.amount(id)]);
  return lastWins.filter(([id]) => game.amount(id) > 0).map(([id]) => [id, game.amount(id)]);
}
function press() {
  if (rolling) return;
  const plan = pressPlan();
  if (!plan.length) { toast('Nothing to press — place a bet or win one first'); return; }
  begin(); const done = [];
  for (const [id, amt] of plan) if (addChip(id, amt, { quiet: true })) done.push(`${NAME(id)} ${fmt(game.amount(id))}`);
  end();
  if (!done.length) { toast('Couldn’t press that bet (table limit or bankroll)'); return; }
  lastWins = [];
  sound.chip(); toast(`Pressed — ${done.join(' · ')}`, true); renderTable(); persist();
}

// ---------- rolling ----------
function roll() {
  if (rolling) return;
  const snap = layoutOf(game.bets); if (Object.keys(snap).length) lastBets = snap;
  undo.length = 0;
  rolling = true; renderHUD();
  const ms = prefs.speed === 'instant' ? 0 : prefs.speed === 'fast' ? 380 : 850;
  const final = [rollDie(Math.random), rollDie(Math.random)];
  if (!ms) return settle(final);
  sound.dice(ms);
  renderDice('tumble');
  const iv = setInterval(() => { dice = [rollDie(Math.random), rollDie(Math.random)]; renderDice('tumble'); }, 90);
  setTimeout(() => { clearInterval(iv); settle(final); }, ms);
}
function settle([a, b]) {
  dice = [a, b]; store.set('dice', dice);
  renderDice('land');
  const r = game.resolveRoll(a, b);
  lastNet = r.net;
  lastWins = r.events.filter((e) => e.type === 'win' && !e.down).map((e) => [e.id, e.stake]);
  rolling = false;
  renderTable();
  // + / − labels over the bets that were decided
  let fx = '';
  for (const e of r.events) {
    if (e.type !== 'win' && e.type !== 'lose') continue;
    const [x, y] = posFor(e.id.startsWith('hop') ? 'any7' : e.id);
    fx += `<text class="fx ${e.type}" x="${x}" y="${y - 16}" font-size="15">${e.type === 'win' ? '+' + fmt(e.win) : '−' + fmt(e.lost ?? e.stake).slice(1)}</text>`;
  }
  const fxG = $('fxG'); fxG.innerHTML = fx; clearTimeout(fxG._t); fxG._t = setTimeout(() => { fxG.innerHTML = ''; }, 1900);
  // the call
  const c = $('callout');
  const head = r.call + (r.outcome === 'point-set' ? ` · the point is ${r.total}` : '');
  c.innerHTML = `<b>${a + b}</b><span>${esc(head)}</span>` + (r.net ? `<em class="${r.net > 0 ? 'pos' : 'neg'}">${r.net > 0 ? 'You win ' + fmt(r.net) : 'You lose ' + fmt(-r.net)}</em>` : '');
  c.className = 'callout show' + (r.total === 7 && r.pointBefore ? ' bad' : '');
  clearTimeout(c._t); c._t = setTimeout(() => { c.className = 'callout'; }, prefs.speed === 'normal' ? 1700 : 1100);
  if (r.net > 0) sound.win(); else if (r.net < 0) sound.lose();
  if (game.bankroll <= 0 && game.totalOnTable() === 0) toast('Out of chips — start a new session in Settings');
  persist();
  if (auto) { clearTimeout(auto.t); auto.t = setTimeout(autoStep, autoDelay()); }
}

// ---------- sheets ----------
function openSheet(id) { $(id).hidden = false; }
function closeSheets() { for (const s of document.querySelectorAll('.sheet')) s.hidden = true; }
for (const s of document.querySelectorAll('.sheet')) s.addEventListener('click', (e) => { if (e.target === s || e.target.closest('[data-close]')) s.hidden = true; });

function openQuick() {
  $('quickSub').textContent = `${fmt(prefs.chip)} chip · table minimum ${fmt(game.settings.tableMin)}`;
  $('groupGrid').innerHTML = GROUPS.map((g) => { const p = groupPlan(g); return `<button class="qb" data-group="${g.key}"><b>${g.label}</b><small>${g.sub}</small><em>${p.plan.length ? fmt(p.total) : '—'}</em></button>`; }).join('')
    + `<button class="qb" data-act="odds"><b>${oddsMultLabel()} odds</b><small>line & come bets</small></button><button class="qb" data-act="regress"><b>Regress</b><small>halve place bets</small></button><button class="qb" data-act="down"><b>Places down</b><small>take down all boxes</small></button>`;
  $('hopGrid').innerHTML = HOP_IDS.map((id) => `<button class="qb hop ${id[3] === id[4] ? 'hard' : ''}" data-bet="${id}">${id[3]}-${id[4]}${game.bets[id] ? `<em>${fmt(game.bets[id])}</em>` : ''}</button>`).join('');
  $('sideGrid').innerHTML = [['big6', 'Big 6', '1:1'], ['big8', 'Big 8', '1:1'], ['world', 'World', '$5 units'], ['fire', 'Fire Bet', 'new shooter'], ['small', 'Small', '34:1'], ['tall', 'Tall', '34:1'], ['all', 'All', '175:1']]
    .map(([id, t, s]) => `<button class="qb" data-bet="${id}"><b>${t}</b><small>${s}</small>${game.bets[id] ? `<em>${fmt(game.bets[id])}</em>` : ''}</button>`).join('');
  $('autoGrid').innerHTML = Object.entries(AUTO).map(([k, s]) => `<button class="qb auto" data-auto="${k}"><b>▶ ${s.label}</b><small>${s.sub} · ${oddsMultLabel()} odds</small></button>`).join('')
    + `<div class="seg auto-lim">${Object.keys(LIMITS).map((k) => `<button data-lim="${k}" class="${prefs.autoLimit === k ? 'on' : ''}">${k === 'none' ? 'No limit' : `+$${k.split('/')[0]} / −$${k.split('/')[1]}`}</button>`).join('')}</div>`;
  openSheet('quickSheet');
}
$('quickSheet').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b || b.dataset.close != null) return;
  if (b.dataset.auto) { startAuto(b.dataset.auto); return; }
  if (b.dataset.lim) { prefs.autoLimit = b.dataset.lim; store.set('prefs', prefs); openQuick(); return; }
  if (b.dataset.group) { if (placeGroup(GROUPS.find((g) => g.key === b.dataset.group))) closeSheets(); }
  else if (b.dataset.act === 'odds') { closeSheets(); maxOdds(); }
  else if (b.dataset.act === 'regress') { closeSheets(); regress(); }
  else if (b.dataset.act === 'down') { closeSheets(); downPlaces(); }
  else if (b.dataset.bet) { const amt = game.isUnitBet(b.dataset.bet) ? Math.max(prefs.chip, game.unitFor(b.dataset.bet)) : prefs.chip; if (addChip(b.dataset.bet, amt)) openQuick(); }
});

function openHistory() {
  const s = game.stats, h = game.history;
  const net = game.totalValue() - session.start;
  $('histSub').textContent = `started with ${fmt(session.start)} · now ${fmt(game.totalValue())}`;
  const cell = (k, v, cls = '') => `<div><span>${k}</span><b class="${cls}">${v}</b></div>`;
  const counts = {}; for (let t = 2; t <= 12; t++) counts[t] = 0; for (const r of h) counts[r.total]++;
  const maxC = Math.max(1, ...Object.values(counts));
  const WAYS = { 2: 1, 3: 2, 4: 3, 5: 4, 6: 5, 7: 6, 8: 5, 9: 4, 10: 3, 11: 2, 12: 1 };
  $('histStats').innerHTML = cell('Net', signed(net), net > 0 ? 'pos' : net < 0 ? 'neg' : '') + cell('Rolls', s.rolls) + cell('Points made', s.pointsMade) + cell('Seven-outs', s.sevenOuts)
    + cell('Longest hand', `${s.longestRoll} rolls`) + cell('Biggest win', fmt(s.biggestWin)) + cell('Won', fmt(s.totalWon), 'pos') + cell('Lost', fmt(s.totalLost), 'neg')
    + `<div class="dist">${Object.entries(counts).map(([t, c]) => `<i title="${t}: ${c} (expected ${(h.length * WAYS[t] / 36).toFixed(1)})"><u style="height:${Math.round((c / maxC) * 100)}%"></u><b>${c}</b><span>${t}</span></i>`).join('')}</div>`;
  $('histList').innerHTML = h.length ? h.slice().reverse().slice(0, 80).map((r) => `<div class="hr"><span class="hd">${r.d1}·${r.d2}</span><b>${r.total}</b><span class="ho">${r.outcome === 'point-set' ? `point ${r.pointAfter}` : r.outcome === 'point-made' ? 'point made' : r.outcome === 'seven-out' ? 'seven out' : r.outcome === 'natural' ? 'winner' : r.outcome === 'craps' ? 'craps' : ''}</span><span class="${r.net > 0 ? 'pos' : r.net < 0 ? 'neg' : ''}">${r.net ? signed(r.net) : ''}</span></div>`).join('') : '<p class="fine">No rolls yet this session.</p>';
  openSheet('histSheet');
}

// ---------- settings ----------
function syncSegs() {
  for (const seg of document.querySelectorAll('.seg[data-key], .seg[data-pref]')) {
    const cur = seg.dataset.key ? String(game.settings[seg.dataset.key]) : String(prefs[seg.dataset.pref]);
    for (const b of seg.querySelectorAll('button')) b.classList.toggle('on', b.dataset.v === cur);
  }
}
$('settingsSheet').addEventListener('click', (e) => {
  const b = e.target.closest('.seg button'); if (!b) return;
  const seg = b.parentElement;
  if (seg.dataset.pref) { prefs[seg.dataset.pref] = b.dataset.v; store.set('prefs', prefs); syncSegs(); if (seg.dataset.pref === 'sound' && b.dataset.v === 'on') sound.chip(); if (seg.dataset.pref === 'oddsMult') renderOddsBtn(); return; }
  if (seg.dataset.key) {
    if (rolling) return;
    const k = seg.dataset.key, raw = b.dataset.v;
    const v = raw === 'true' ? true : raw === 'false' ? false : raw === '345' ? '345' : Number(raw);
    const r = game.setSettings({ [k]: v });
    syncSegs(); renderTable(); persist();
    if (k === 'tableMin') toast(`Table minimum is now ${fmt(r.settings.tableMin)}`, true);
    else toast('Table rules updated', true);
  }
});
function newSession(bank) {
  if (rolling) return;
  game.reset(bank); session = { start: game.totalValue() }; lastBets = null; lastNet = null; lastWins = []; undo.length = 0;
  closeSheets(); renderTable(); persist(); toast(`New session — ${fmt(bank)} in chips`, true);
}
$('reset1k').onclick = () => newSession(1000);
$('reset5k').onclick = () => newSession(5000);
$('reset25k').onclick = () => newSession(25000);
$('ver').textContent = 'Version ' + (document.querySelector('meta[name="app-version"]')?.content || 'dev');

// ---------- chips & dock ----------
const CHIPS = [1, 5, 25, 100, 500, 1000];
function renderChips() {
  $('chips').innerHTML = CHIPS.map((c) => `<button class="rchip ${chipCls(c)} ${c === prefs.chip ? 'sel' : ''}" data-chip="${c}" aria-label="$${c} chip">${chipLbl(c)}</button>`).join('');
}
$('chips').addEventListener('click', (e) => { const b = e.target.closest('[data-chip]'); if (!b) return; prefs.chip = Number(b.dataset.chip); store.set('prefs', prefs); renderChips(); sound.click(0, 3000); });
$('rollBtn').onclick = () => { if (auto) { stopAuto('Auto-play stopped', true); return; } removeMode && setRemove(false); roll(); };
$('undoBtn').onclick = undoLast;
$('clearBtn').onclick = clearAll;
pressable($('oddsBtn').parentElement, '#oddsBtn', () => maxOdds(), cycleOddsMult);
renderOddsBtn();
$('rebetBtn').onclick = () => { if (lastBets) applyLayout(lastBets, 'Rebet'); };
$('regressBtn').onclick = regress;
$('pressBtn').onclick = press;
$('quickBtn').onclick = openQuick;
$('settingsBtn').onclick = () => { syncSegs(); openSheet('settingsSheet'); };
$('sessionBtn').onclick = openHistory;
$('histStrip').onclick = openHistory;
function setRemove(on) { removeMode = on; $('downBtn').setAttribute('aria-pressed', String(on)); document.body.classList.toggle('removing', on); if (on) toast('Remove mode — tap a bet to take it down', true); }
$('downBtn').onclick = () => setRemove(!removeMode);
$('favReplace').onclick = () => { closeSheets(); saveFav(favOpen); };
$('favClear').onclick = () => { favs[favOpen] = null; store.set('favs', favs); closeSheets(); renderFavs(); toast(`Favorite ${favOpen + 1} cleared`, true); };

// tap / hold on felt bets and favorite stars (hold = 450 ms)
function pressable(root, sel, onTap, onHold) {
  let t = 0, held = false, el = null, x0 = 0, y0 = 0;
  root.addEventListener('pointerdown', (e) => {
    el = e.target.closest(sel); if (!el) return;
    held = false; x0 = e.clientX; y0 = e.clientY;
    clearTimeout(t); t = setTimeout(() => { held = true; if (el) { navigator.vibrate?.(15); onHold(el); } }, 450);
  });
  root.addEventListener('pointermove', (e) => { if (el && Math.hypot(e.clientX - x0, e.clientY - y0) > 12) { clearTimeout(t); el = null; } });
  root.addEventListener('pointerup', (e) => { clearTimeout(t); if (el && !held && e.target.closest(sel) === el) onTap(el); el = null; });
  root.addEventListener('pointercancel', () => { clearTimeout(t); el = null; });
  root.addEventListener('contextmenu', (e) => e.preventDefault());
}
pressable($('felt'), '[data-bet]',
  (el) => { const id = el.dataset.bet; if (removeMode) takeDown(holdTarget(id)); else addChip(tapTarget(id)); },
  (el) => { const id = holdTarget(el.dataset.bet); if (game.bets[id]) takeDown(id); else toast(`No bet on ${NAME(id)}`, true); });
pressable($('favs'), '[data-fav]',
  (el) => { const i = Number(el.dataset.fav); if (!favs[i]) saveFav(i); else applyLayout(atTableMin(favs[i].bets), `Favorite ${i + 1}`); },
  (el) => openFavSheet(Number(el.dataset.fav)));

document.addEventListener('keydown', (e) => {
  if (e.target.closest('input, textarea')) return;
  if (e.key === ' ' || e.key === 'Enter') { if (!document.querySelector('.sheet:not([hidden])')) { e.preventDefault(); roll(); } }
  else if (e.key === 'Escape') closeSheets();
  else if ((e.ctrlKey || e.metaKey) && e.key === 'z') undoLast();
});
// save on the way out (the debounce might not have fired)
document.addEventListener('visibilitychange', () => { if (document.hidden) { stopAuto(); store.set('game', game.serialize()); store.set('session', session); store.set('last', lastBets); } });

buildFelt();
renderChips();
renderDice();
renderTable();
