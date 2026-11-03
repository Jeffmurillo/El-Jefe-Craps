// main.js — bootstrap, game loop, input, HUD wiring, roll flow and deterministic ?shot modes.
import * as THREE from 'three';
import { createStage } from './scene.js';
import { CameraRig, PRESET_ORDER } from './camera.js';
import { createTable } from './table.js';
import { DiceSet, pickRollTime } from './dice.js';
import { simulateThrow } from './physics.js';
import { ChipManager, DENOMS } from './chips.js';
import { Puck } from './puck.js';
import { AudioEngine } from './audio.js';
import { CrapsGame, makeRng, rollDie, betInfo, autoStrategy, POINTS } from './rules.js';
import { createSideBets } from './sidebets.js';
import { Lammers } from './lammers.js';
import { hitTest, resolveBetId, ZoneHighlighter, FELT, C, ZONES } from './bets.js';

const params = new URLSearchParams(location.search);
const SHOT = params.get('shot');
const SEED = params.has('seed') ? Number(params.get('seed')) : null;
const $ = (id) => document.getElementById(id);
const fmt = (n) => (n < 0 ? '-$' : '$') + Math.abs(Math.round(n)).toLocaleString('en-US');
const fmtSigned = (n) => (n >= 0 ? '+' : '-') + '$' + Math.abs(Math.round(n)).toLocaleString('en-US');

// ---------- persisted settings ----------
const store = {
  get(k, d) { try { const v = localStorage.getItem('craps.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { if (SHOT) return; try { localStorage.setItem('craps.' + k, JSON.stringify(v)); } catch { } },
};
const MOBILE = matchMedia('(pointer: coarse)').matches && /Android|iPad|iPhone|Mobi/i.test(navigator.userAgent);
const settings = {
  // shots run on a software rasteriser: 'medium' (4096 felt, still above screen density) keeps every mode inside the default wait
  // phones/tablets default to the 'mobile' tier: a desktop 'high' frame is several times a mobile GPU's budget
  quality: params.get('quality') || (SHOT ? 'medium' : store.get('quality', MOBILE ? 'mobile' : 'high')),
  fast: SHOT ? false : store.get('fast', false),
  // game speed: 'normal' | 'fast' | 'turbo' (HUD segmented control in ui.js writes settings.speed + craps.speed)
  speed: SHOT ? 'normal' : store.get('speed', store.get('fast', false) ? 'fast' : 'normal'),
  hardWorking: SHOT ? false : store.get('hardWorking', false),
  placeWorking: SHOT ? false : store.get('placeWorking', false),
};
// throw playback multiplier, pickup glide (s), payout-phase divisor
const SPEEDS = { normal: { mul: 1, pickup: 0.38, pay: 1 }, fast: { mul: 1.7, pickup: 0.2, pay: 1.4 }, turbo: { mul: 2.6, pickup: 0.1, pay: 2.2 } };

// ---------- world ----------
const canvas = $('gl');
const stage = createStage({ canvas, quality: settings.quality, isShot: !!SHOT });
const { scene, camera, renderer } = stage;
// software WebGL (browser GPU acceleration off): build the light assets too, or the 8K felt alone takes ages
const assetQuality = stage.software && !SHOT ? 'low' : settings.quality === 'mobile' ? 'medium' : settings.quality;
const table = createTable({ renderer, quality: assetQuality });
if (stage.software && !SHOT && !params.has('nowarn')) {
  // the game can only limp along on a CPU rasteriser: say why, and how to fix it, until dismissed
  const w = document.body.appendChild(document.createElement('div'));
  w.style.cssText = 'position:fixed;left:50%;top:12px;transform:translateX(-50%);z-index:200;max-width:min(640px,calc(100vw - 32px));padding:10px 36px 10px 14px;border-radius:8px;background:#3a1510ee;border:1px solid #c8963c;color:#f6e7c8;font:14px/1.4 system-ui,sans-serif;box-shadow:0 4px 18px #0008';
  w.innerHTML = '<b>Running without graphics acceleration.</b> Your browser is drawing the 3D table on the CPU, so the game is shown in a reduced mode and may still stutter. '
    + 'In Chrome or Edge, open <b>Settings → System</b>, turn on <b>Use graphics acceleration when available</b>, then relaunch the browser.'
    + `<br><small style="opacity:.7">Renderer: ${stage.gpu.replace(/[<>&]/g, '')}</small>`
    + '<button aria-label="Dismiss" style="position:absolute;right:6px;top:6px;background:none;border:0;color:inherit;font-size:18px;cursor:pointer">×</button>';
  w.querySelector('button').onclick = () => w.remove();
}
scene.add(table.group);
stage.applyEnv?.(table.group); // per-material envMapIntensity (lacquered wood reflects the canopy, felt stays matte)
const dice = new DiceSet(scene, { transmission: stage.quality.transmission });
const chips = new ChipManager(scene, { faceRes: assetQuality === 'low' ? 256 : 512 });
const puck = new Puck(scene);
chips.viewer = camera; puck.viewer = camera; // top-chip numerals and the puck lettering read upright for the player
chips.pointOf = () => game.point; // come bets that travel into the puck's box sit beside the place stack
const highlighter = new ZoneHighlighter(scene);
const rig = new CameraRig(camera, canvas);
const audio = new AudioEngine();
chips.onLand = (n, pos) => audio.chips(n, 0, pos); // pos = where the chips touched down (stereo pan)
puck.onLand = () => audio.puck(puck.root?.position);
chips.onRailLand = (n, pos) => audio.chipsRail(n, pos);
chips.onSweep = (n, pos) => audio.sweep(n, pos);       // dealer sweep of losing bets: felt drag sized by chip count
chips.onBankLand = (n, pos) => audio.bankLand(n, pos); // ...and the clack cluster as they reach the bank
chips.onPayStack = (n, pos) => audio.chipStack(n, 0.03, pos); // dealer squares a finished payout stack: the riffle
audio.setListener(camera); // stereo pan follows the camera, not world x

// ?shot=play is a smoke test: default to a fixed seed so its final numbers are reproducible (override with ?seed=N)
const seed0 = SEED ?? (SHOT === 'play' ? 20261102 : ((crypto.getRandomValues(new Uint32Array(1))[0]) >>> 0));
const diceRng = makeRng(seed0);
const physRng = makeRng(seed0 ^ 0x5bd1e995);

// The whole table state (bets included — contract bets stay contract bets) is persisted with
// game.serialize() and rebuilt with CrapsGame.restore(), which validates every field.
const savedGame = SHOT ? null : store.get('game', null);
const game = savedGame ? CrapsGame.restore(savedGame) : new CrapsGame({ bankroll: SHOT ? 1000 : store.get('bankroll', 1000) });
// table rules (buy/lay vig timing, buy & lay minimums, dealer round-up) chosen in Settings, plus the working
// toggles: always applied through the engine's setSettings, which runs sanitizeSettings
game.setSettings({ ...(SHOT ? {} : store.get('tableRules', {})), placeWorkingOnComeOut: settings.placeWorking, hardwaysWorkingOnComeOut: settings.hardWorking });
if (game.totalValue() < 5 && !SHOT) game.reset(1000);
const lammers = new Lammers(scene, chips, game); // white OFF buttons on bets that aren't working
game.stats.startBankroll = SHOT ? 1000 : store.get('sessionStart', game.bankroll);

// ---------- UI state ----------
const ui = {
  phase: 'betting', // betting | rolling | paying
  chip: SHOT ? 25 : store.get('chip', 25),
  oddsMode: false,
  lastBets: null,
  lastWins: [],
  shownBank: game.bankroll,
  pending: {},       // chips pushed toward a bet that is still below its minimum / unit (not yet booked)
  rollValues: null,  // dice values of the throw in flight (persist() resolves them so a reload can't undo a roll)
  // Put-bet confirmation, one record: the first click on a Put arms it (armedAt); a second click on the same
  // bet within 4s confirms it (confirmedAt), and more chips on that bet within 4s of the last are not re-asked.
  putConfirm: { id: null, armedAt: -1, confirmedAt: -1 },
};
/** Dollars pushed toward bets that are not booked yet — held out of the rack (and the HUD bankroll). */
function pendingTotal(except = null) { let t = 0; for (const [id, a] of Object.entries(ui.pending)) if (id !== except) t += a; return t; }

// ---------- scheduler (loop-driven, so fast/shot modes stay deterministic) ----------
let clockT = 0;
const timers = [];
function later(sec, fn) { timers.push({ at: clockT + sec, fn }); }
function runTimers() { for (let i = timers.length - 1; i >= 0; i--) if (timers[i].at <= clockT) { const t = timers.splice(i, 1)[0]; t.fn(); } }

// ---------- HUD ----------
const chipTray = $('chipTray');
for (const d of DENOMS) {
  const b = document.createElement('button');
  b.className = 'chip'; b.dataset.label = d.label; b.dataset.v = d.v; b.title = `$${d.v} chip`;
  b.style.setProperty('--c', d.base); b.style.setProperty('--s', d.spot); b.style.setProperty('--i', d.ink);
  b.addEventListener('click', () => { ui.chip = d.v; store.set('chip', d.v); audio.click(); updateChips(); });
  chipTray.appendChild(b);
}
function updateChips() { for (const b of chipTray.children) b.classList.toggle('selected', Number(b.dataset.v) === ui.chip); }

function miniDie(v) {
  const on = { 1: [4], 2: [0, 8], 3: [0, 4, 8], 4: [0, 2, 6, 8], 5: [0, 2, 4, 6, 8], 6: [0, 2, 3, 5, 6, 8] }[v];
  return `<span class="mini-die">${Array.from({ length: 9 }, (_, i) => `<i class="${on.includes(i) ? 'p' : ''}"></i>`).join('')}</span>`;
}
const OUTCOME_CLASS = { 'seven-out': 'seven', 'point-made': 'made', natural: 'nat', craps: 'craps', 'point-set': 'pointset', roll: '' };
const OUTCOME_TAG = { 'seven-out': '7 out', 'point-made': 'winner', natural: 'winner', craps: 'craps', 'point-set': 'point', roll: '' };

function renderHistory() {
  const list = $('historyList');
  const items = game.history.slice(-14).reverse();
  list.innerHTML = items.map((h) => `<li class="${OUTCOME_CLASS[h.outcome] || ''}">${miniDie(h.d1)}${miniDie(h.d2)}<span class="tag">${OUTCOME_TAG[h.outcome] || (h.hard && [4, 6, 8, 10].includes(h.total) ? 'hard' : '')}</span><span class="tot">${h.total}</span></li>`).join('');
  $('statRolls').textContent = game.stats.rolls;
  $('statPoints').textContent = game.stats.pointsMade;
  $('statBest').textContent = fmt(game.stats.biggestWin);
}

function updateHUD() {
  $('onTable').textContent = fmt(game.totalOnTable());
  $('totalBet').textContent = fmt(game.totalOnTable());
  const sess = game.totalValue() - game.stats.startBankroll; // prepaid (refundable) vig is not a loss
  const se = $('session'); se.textContent = sess ? fmtSigned(sess) : '$0'; se.className = sess > 0 ? 'pos' : sess < 0 ? 'neg' : 'zero';
  const P = game.point;
  const pi = $('puckIcon'); pi.className = 'puck-icon ' + (P ? 'on' : 'off'); pi.textContent = P ? 'ON' : 'OFF';
  $('statusMain').textContent = P ? `Point is ${P}` : 'Come-Out Roll';
  let sub;
  if (ui.phase === 'rolling') sub = 'No more bets — dice are rolling';
  else if (ui.phase === 'paying') sub = 'Paying the table…';
  else if (!P) sub = game.bets.pass || game.bets.dontPass ? '7 or 11 wins · 2, 3, 12 craps' : 'Place your Pass Line bet';
  else sub = game.bets.pass && !game.bets.passOdds ? 'Back your Pass Line with free odds' : `Roll a ${P} before a 7`;
  $('statusSub').textContent = sub;
  $('rollBtn').disabled = ui.phase !== 'betting';
  $('oddsBtn').classList.toggle('active', ui.oddsMode);
  $('workingState').textContent = game.settings.placeWorkingOnComeOut ? 'ON' : 'OFF';
  $('workingBtn').classList.toggle('active', game.settings.placeWorkingOnComeOut);
  $('pressBtn').disabled = !ui.lastWins.length || ui.phase !== 'betting';
  $('rebetBtn').disabled = !ui.lastBets || ui.phase !== 'betting';
  $('maxOddsBtn').disabled = ui.phase !== 'betting';
  $('soundBtn').classList.toggle('muted', audio.muted);
  animateBank();
}
let bankAnim = null;
function animateBank() {
  const target = game.bankroll - pendingTotal(), el = $('bankroll');
  if (SHOT || Math.abs(target - ui.shownBank) < 1) { ui.shownBank = target; el.textContent = fmt(target); return; }
  el.classList.toggle('up', target > ui.shownBank); el.classList.toggle('down', target < ui.shownBank);
  bankAnim = { from: ui.shownBank, to: target, t: 0 };
}
function tickBank(dt) {
  if (!bankAnim) return;
  bankAnim.t = Math.min(1, bankAnim.t + dt / 0.6);
  const e = 1 - Math.pow(1 - bankAnim.t, 3);
  ui.shownBank = bankAnim.from + (bankAnim.to - bankAnim.from) * e;
  $('bankroll').textContent = fmt(ui.shownBank);
  if (bankAnim.t >= 1) { bankAnim = null; ui.shownBank = game.bankroll - pendingTotal(); $('bankroll').classList.remove('up', 'down'); }
}

let toastTimer = 0;
function toast(msg, info = false) {
  const t = $('toast'); t.textContent = msg; t.className = 'toast show' + (info ? ' info' : '');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 2400);
}
function callout(res, { sticky = false } = {}) {
  $('calloutDice').innerHTML = miniDie(res.d1) + miniDie(res.d2);
  $('calloutText').textContent = res.call;
  const c = $('callout'); c.classList.add('show');
  if (!sticky) { clearTimeout(c._t); c._t = setTimeout(() => c.classList.remove('show'), 2600); }
}
function banner(res, { sticky = false, title } = {}) {
  const wins = res.events.filter((e) => e.type === 'win');
  const loses = res.events.filter((e) => e.type === 'lose');
  const wb = $('winBanner');
  if (!wins.length && res.outcome !== 'seven-out') return;
  const totalWin = wins.reduce((a, e) => a + e.win, 0);
  const lost = loses.reduce((a, e) => a + (e.lost ?? e.stake), 0); // lost = stake + any commission paid up front
  if (wins.length) {
    wb.className = 'win-banner show';
    $('wbTitle').textContent = title || (res.outcome === 'point-made' ? 'POINT MADE' : res.total === 7 && !res.pointBefore ? 'WINNER 7' : 'WINNER');
    $('wbAmount').textContent = fmtSigned(totalWin);
    $('wbLines').innerHTML = wins.slice(0, 5).map((e) => `<span>${game.betInfo(e.id).name} <b>+${fmt(e.win)}</b></span>`).join('') + (lost ? `<span class="l">Lost <b>-${fmt(lost)}</b></span>` : '');
  } else {
    wb.className = 'win-banner show lose';
    $('wbTitle').textContent = title || 'SEVEN OUT';
    $('wbAmount').textContent = lost ? fmtSigned(-lost) : 'Line away';
    $('wbLines').innerHTML = '<span>The dice pass to the next shooter</span>';
  }
  if (!sticky) { clearTimeout(wb._t); wb._t = setTimeout(() => wb.classList.remove('show'), 2800); }
}

// ---------- session results: every roll's net win/loss ----------
// Kept with the session (survives a reload, like the Session figure); a bankroll reset starts a new one.
const LOG_MAX = 2000;
let sessionLog = SHOT ? [] : store.get('sessionLog', []);
if (!Array.isArray(sessionLog)) sessionLog = [];
function logRoll(res) {
  const name = (id) => game.betInfo(id)?.name || id;
  const w = res.events.filter((e) => e.type === 'win').map((e) => [name(e.id), e.win]);
  const l = res.events.filter((e) => e.type === 'lose').map((e) => [name(e.id), e.lost ?? e.stake]);
  const net = Number.isFinite(res.net) ? res.net : w.reduce((a, [, v]) => a + v, 0) - l.reduce((a, [, v]) => a + v, 0); // the engine's own net (vig included)
  sessionLog.push({ n: game.stats.rolls, d: [res.d1, res.d2], call: res.call || '', out: res.outcome || '', net, w, l, bal: game.totalValue() });
  if (sessionLog.length > LOG_MAX) sessionLog.splice(0, sessionLog.length - LOG_MAX);
  store.set('sessionLog', sessionLog);
}
/** The status-bar pill: the latest roll's net, always on screen. */
function renderLastResult({ pop = true } = {}) {
  const btn = $('lastResult'); if (!btn) return;
  const r = sessionLog[sessionLog.length - 1];
  const action = r && (r.w.length || r.l.length);
  btn.className = 'last-result ' + (!action ? 'none' : r.net > 0 ? 'win' : r.net < 0 ? 'lose' : 'even');
  $('lrLabel').textContent = r ? `Roll ${r.n} · ${r.d[0] + r.d[1]}` : 'Last roll';
  $('lrAmount').textContent = !r ? '—' : !action ? 'No action' : r.net === 0 ? 'Even' : fmtSigned(r.net);
  if (r && pop && !SHOT) { btn.classList.remove('pop'); void btn.offsetWidth; btn.classList.add('pop'); }
}
function renderResults() {
  const acted = sessionLog.filter((r) => r.w.length || r.l.length);
  const won = sessionLog.reduce((a, r) => a + r.w.reduce((s, [, v]) => s + v, 0), 0);
  const lost = sessionLog.reduce((a, r) => a + r.l.reduce((s, [, v]) => s + v, 0), 0);
  const net = sessionLog.reduce((a, r) => a + r.net, 0); // per-roll engine nets (any vig included), so it matches the Session figure's direction
  const best = acted.reduce((b, r) => (r.net > (b?.net ?? 0) ? r : b), null);
  const worst = acted.reduce((b, r) => (r.net < (b?.net ?? 0) ? r : b), null);
  const cell = (k, v, cls = '') => `<div class="rs-cell ${cls}"><span>${k}</span><b>${v}</b></div>`;
  $('rsSummary').innerHTML =
    cell('Net', net ? fmtSigned(net) : '$0', net > 0 ? 'pos' : net < 0 ? 'neg' : '')
    + cell('Won', fmt(won), 'pos') + cell('Lost', fmt(lost), 'neg')
    + cell('Rolls', `${sessionLog.length}<small> · ${acted.filter((r) => r.net > 0).length}W ${acted.filter((r) => r.net < 0).length}L</small>`)
    + cell('Best roll', best ? fmtSigned(best.net) : '—', best ? 'pos' : '')
    + cell('Worst roll', worst ? fmtSigned(worst.net) : '—', worst ? 'neg' : '');
  const list = $('rsList');
  if (!sessionLog.length) { list.innerHTML = '<li class="rs-empty">No rolls yet this session. Results show here after each roll.</li>'; return; }
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  list.innerHTML = sessionLog.slice().reverse().map((r) => {
    const action = r.w.length || r.l.length;
    const cls = !action ? 'none' : r.net > 0 ? 'win' : r.net < 0 ? 'lose' : 'even';
    const lines = r.w.map(([n, v]) => `<span class="w">${esc(n)} <b>+${fmt(v)}</b></span>`).join('')
      + r.l.map(([n, v]) => `<span class="l">${esc(n)} <b>-${fmt(v)}</b></span>`).join('');
    return `<li class="${cls}"><div class="rs-row"><span class="rs-n">#${r.n}</span>`
      + `<span class="rs-dice">${miniDie(r.d[0])}${miniDie(r.d[1])}</span>`
      + `<span class="rs-call">${esc(r.call)}</span>`
      + `<span class="rs-net">${!action ? '—' : r.net === 0 ? 'Even' : fmtSigned(r.net)}</span></div>`
      + (lines ? `<div class="rs-lines">${lines}</div>` : '')
      + `<div class="rs-bal">Balance ${fmt(r.bal)}</div></li>`;
  }).join('');
}
$('lastResult')?.addEventListener('click', () => { audio.click?.(); renderResults(); $('resultsModal').classList.add('show'); $('rsList').scrollTop = 0; });

// ---------- betting ----------
function placeOn(betId, amount, { silent = false } = {}) {
  if (!betId) return false;
  if (ui.phase !== 'betting') { if (!silent) toast('No more bets — dice are rolling'); return false; }
  // chips pending on OTHER bets are held for them: they are not available for this one
  const held = pendingTotal(betId);
  if (amount + game.upfrontVig(betId, amount) > game.bankroll - held) {
    if (!silent) { toast(held ? 'Insufficient bankroll — chips pending on other bets are held for them' : 'Insufficient bankroll'); audio.error(); }
    return false;
  }
  let r = game.placeBet(betId, amount);
  if (!r.ok && /Odds/.test(betId) && /^Maximum odds/.test(r.reason)) {
    // only an over-the-limit odds bet is clamped: down to the allowed maximum in payable units, never above the request
    const room = Math.min(amount, game.maxOddsAdd(betId, held));
    if (room > 0) r = game.placeBet(betId, room);
  }
  if (!r.ok) { if (!silent) { toast(r.reason); audio.error(); } return false; }
  chips.setBet(betId, game.bets[betId], { animate: !SHOT });
  // chip landing clacks come from chips.onLand as each chip touches down
  updateHUD();
  persist();
  return true;
}
/** Description of how a unit bet is split, for the booking toast. */
function unitSplit(id, total) {
  if (id === 'horn') return `$${total / 4} each on 2, 3, 11, 12`;
  if (id === 'ce') return `$${total / 2} craps, $${total / 2} eleven`;
  if (id === 'world') return `$${total / 5} each on 2, 3, 7, 11, 12`;
  const m = /^hornHigh(\d+)$/.exec(id);
  if (m) { const u = total / 5; return `$${2 * u} on ${m[1]}, $${u} on each other horn number`; }
  return '';
}
function setPendingVisual(id) { chips.setBet(id, game.amount(id) + (ui.pending[id] || 0), { animate: !SHOT }); updateHUD(); }
function clearPending({ silent = false } = {}) {
  const ids = Object.keys(ui.pending);
  if (!ids.length) return;
  const sum = ids.reduce((a, id) => a + ui.pending[id], 0);
  ui.pending = {};
  for (const id of ids) chips.setBet(id, game.amount(id), { animate: !SHOT });
  if (!silent) toast(`${fmt(sum)} below the minimum returned to you`, true);
}
/**
 * A chip click from the player: books the chip the way a dealer would. Small chips accumulate until
 * they reach the bet's minimum, unit bets (Horn $4, C & E $2, World / Horn High $5) are rounded to
 * whole units with change returned, and the first Put bet asks for confirmation.
 */
function placeChip(betId) {
  if (!betId) return false;
  if (ui.phase !== 'betting') { toast('No more bets — dice are rolling'); return false; }
  const info = game.betInfo(betId);
  if (/Odds/.test(betId)) {
    // dealer-style: odds are booked in payable units ($2 on 5/9, $5 on 6/8 …) so nothing is lost to breakage
    const v = game.validate(betId, game.unitFor(betId));
    if (!v.ok && !/Maximum|bankroll/.test(v.reason)) { toast(v.reason); audio.error(); return false; }
    const pend = ui.pending[betId] || 0;
    const s = game.oddsStake(betId, ui.chip, pend, pendingTotal(betId));
    if (s.broke) { toast('Insufficient bankroll — chips pending on other bets are held for them'); audio.error(); return false; }
    if (s.full) { toast(game.amount(betId) ? `${info.name} is at the maximum (${fmt(game.amount(betId))})` : 'Insufficient bankroll for odds'); audio.error(); return false; }
    if (!s.add) {
      ui.pending[betId] = s.pending; setPendingVisual(betId);
      toast(`${fmt(s.pending)} toward ${info.name} — ${fmt(s.short)} more makes a payable bet (${fmt(game.unitFor(betId))} units)`, true);
      return true;
    }
    if (!placeOn(betId, s.add)) return false;
    if (s.pending) { ui.pending[betId] = s.pending; setPendingVisual(betId); } else delete ui.pending[betId];
    const total = game.amount(betId), wins = fmt(game.winFor(betId, total));
    if (s.rounded === 'up') toast(`Odds rounded up to ${fmt(total)} so they pay ${wins} — ${fmt(s.extra)} extra from your rack`, true);
    else if (s.rounded === 'down') toast(`Odds booked at ${fmt(total)} (pays ${wins}) — ${fmt(s.change)} change`, true);
    else if (s.rounded === 'capped') toast(`Max odds: ${fmt(total)} on ${info.name} (pays ${wins})${s.change ? ` — ${fmt(s.change)} change` : ''}`, true);
    return true;
  }
  if (info.put) {
    // every Put (a new one, or more money on a flat bet after the point) needs two clicks within 4s.
    // The confirmation slides for that one bet, so stacking chips on the Put just confirmed is not re-asked.
    const now = performance.now(), c = ui.putConfirm;
    const same = c.id === betId;
    const confirmed = same && c.confirmedAt >= 0 && now - c.confirmedAt < 4000;
    const armed = same && c.armedAt >= 0 && now - c.armedAt < 4000;
    if (!confirmed && !armed) { ui.putConfirm = { id: betId, armedAt: now, confirmedAt: -1 }; toast(`${info.warn}. Click again to confirm.`); audio.error(); return false; }
    ui.putConfirm = { id: betId, armedAt: -1, confirmedAt: now };
  }
  const pend = ui.pending[betId] || 0;
  const held = pendingTotal(betId);
  const s = game.chipStake(betId, ui.chip, pend, held);
  if (s.broke) { toast(held ? 'Insufficient bankroll — chips pending on other bets are held for them' : 'Insufficient bankroll'); audio.error(); return false; }
  if (s.add === 0) {
    // still below the minimum (or less than one unit): keep the chips pending on the layout
    const v = game.validate(betId, Math.max(game.minFor(betId), game.unitFor(betId)));
    if (!v.ok && !/Minimum|units/.test(v.reason)) { toast(v.reason); audio.error(); return false; }
    ui.pending[betId] = s.pending; setPendingVisual(betId);
    const need = s.short || (game.unitFor(betId) - s.pending);
    toast(`${fmt(s.pending)} toward ${info.name} — ${fmt(need)} more to book it (${fmt(s.short ? game.minFor(betId) : game.unitFor(betId))} ${s.short ? 'minimum' : 'units'})`, true);
    return true;
  }
  if (!placeOn(betId, s.add)) return false;
  if (s.pending) { ui.pending[betId] = s.pending; setPendingVisual(betId); } else delete ui.pending[betId];
  const total = game.amount(betId);
  if (game.isUnitBet(betId)) toast(`${fmt(total)} ${info.name} — ${unitSplit(betId, total)}${s.change ? ` · ${fmt(s.change)} change` : ''}`, true);
  else if (s.rounded === 'up') toast(`${info.name} booked at ${fmt(total)} so it pays ${fmt(game.winFor(betId, total))} — ${fmt(s.extra)} extra from your rack`, true);
  else if (s.rounded === 'down') toast(`${info.name} booked at ${fmt(total)} (pays ${fmt(game.winFor(betId, total))}) — ${fmt(s.change)} change`, true);
  else if (s.rounded === 'capped') toast(`Table max: ${fmt(total)} on ${info.name}${s.change ? ` — ${fmt(s.change)} change` : ''}`, true);
  else if (s.rounded === 'raw') { const pw = game.preview(betId, 0).warn; toast(pw || `${fmt(total)} booked on ${info.name}`, true); }
  else if (pend) toast(`${fmt(total)} booked on ${info.name}`, true);
  if (info.put) toast(`${info.name} booked — ${info.warn}`, true);
  return true;
}
/**
 * Alt-click a number box: a Put bet straight on that number (flat come bet with no come-out roll), or —
 * when a come bet already sits there — more flat money on it, which is a Put raise (confirmed, like the Pass Line).
 */
function placePut(n) {
  if (!game.point) { toast('Put bets are made after the point is set — use the Come or Pass Line', true); return false; }
  if (!game.settings.putBets) { toast('This table does not take Put bets'); return false; }
  return placeChip('come' + n);
}
function takeDown(betId, { silent = false } = {}) {
  if (ui.phase !== 'betting') return false;
  const r = game.removeBet(betId);
  if (!r.ok) { if (!silent) { toast(r.reason); audio.error(); } return false; }
  for (const { id } of r.removed) { chips.clearBet(id, { to: 'player' }); delete ui.pending[id]; }
  { let pos = null; try { pos = r.removed[0] && chips._spotFor(r.removed[0].id); } catch { } audio.chipsTake(r.removed.length, pos); } // panned at the bet
  updateHUD();
  persist();
  return true;
}
function removableIdsForZone(zone) {
  const n = zone.n;
  if (zone.key === 'number') return ['comeOdds' + n, 'dontComeOdds' + n, 'place' + n];
  if (zone.key === 'lay') return ['dontComeOdds' + n, 'lay' + n, 'dontCome' + n];
  if (zone.key === 'pass') return ['passOdds', 'pass'];
  if (zone.key === 'dontPass') return ['dontPassOdds', 'dontPass'];
  return [resolveBetId(zone, { oddsMode: ui.oddsMode, game })];
}

function maxOdds() {
  // no past-posting: the dice result is already decided once a throw starts
  if (ui.phase !== 'betting') { toast('No more bets — dice are rolling'); return; }
  let any = false;
  const P = game.point;
  // placeOn handles the phase check, chip animation and persist; maxOddsAdd keeps it in payable units
  // why nothing was added: no eligible flat at all, every eligible bet already at the odds limit, or the rack is short
  let eligible = 0, atMax = 0, short = 0;
  const tryMax = (id) => {
    eligible++;
    const u = game.unitFor(id), limitRoom = Math.floor((game.maxFor(id) || 0) / u) * u - game.amount(id);
    if (limitRoom <= 0) { atMax++; return; }
    const room = game.maxOddsAdd(id, pendingTotal(id));
    if (room > 0 && placeOn(id, room, { silent: true })) { delete ui.pending[id]; any = true; } else short++;
  };
  if (P && game.bets.pass) tryMax('passOdds');
  if (P && game.bets.dontPass) tryMax('dontPassOdds');
  for (const n of POINTS) { if (game.bets['come' + n]) tryMax('comeOdds' + n); if (game.bets['dontCome' + n]) tryMax('dontComeOdds' + n); }
  if (!any) {
    if (!eligible) toast('No line or come bets eligible for more odds', true);
    else if (short) { toast(pendingTotal() ? 'Insufficient bankroll for more odds — chips pending on other bets are held for them' : 'Insufficient bankroll for more odds'); audio.error(); }
    else toast('Already at max odds', true);
  }
  updateHUD();
}
// Press with the winnings (kept in clean, breakage-free units), or shift-click / Shift+P to double.
function press({ double = false } = {}) {
  let any = false;
  for (const { id, win } of ui.lastWins) {
    if (!game.bets[id]) continue;
    const add = double ? game.bets[id] : game.pressAmount(id, win);
    if (add > 0) any = placeOn(id, add, { silent: !any }) || any;
  }
  if (any) toast(double ? 'Pressed — bets doubled' : 'Pressed with the winnings', true);
  ui.lastWins = []; updateHUD();
}
/** Bets on a zone that can be switched ON/OFF, most specific first. */
function workingIdsForZone(zone) {
  const n = zone.n;
  if (zone.key === 'number') return ['comeOdds' + n, 'place' + n];
  if (zone.key === 'buy') return ['buy' + n];
  if (zone.key === 'lay') return ['dontComeOdds' + n, 'lay' + n];
  return [zone.key];
}
function toggleZoneWorking(zone) {
  if (!zone || ui.phase !== 'betting') return false;
  const id = workingIdsForZone(zone).find((x) => game.bets[x] && game.canToggleWorking(x));
  if (!id) { toast('No bet here that can be turned ON/OFF', true); return false; }
  const r = game.toggleWorking(id);
  if (!r.ok) { toast(r.reason); return false; }
  audio.click();
  toast(`${game.betInfo(id).name} is ${r.working ? 'ON (working)' : 'OFF'}`, true);
  return true;
}
function takeDownPlaces() { let any = false; for (const id of Object.keys(game.bets)) if (/^(place|buy|lay)\d/.test(id)) any = takeDown(id, { silent: true }) || any; if (!any) toast('No place bets to take down', true); }
function clearAll() { let any = false; for (const id of Object.keys(game.bets)) if (game.canRemove(id).ok) any = takeDown(id, { silent: true }) || any; if (!any) toast('Nothing removable — line & come bets are contract bets', true); }
function rebet() {
  if (!ui.lastBets || ui.phase !== 'betting') return;
  // the engine re-books each bet for the CURRENT point in payable units (odds from an old 5 behind a new 6 …),
  // never rebets a line bet as a Put, and keeps money pending on other bets out of reach
  const plan = game.rebetPlan(ui.lastBets, pendingTotal());
  // placeOn can still refuse a planned bet (bankroll race, up-front commission): collect those, and only list
  // re-booked amounts for bets that actually went down
  const placed = new Set(), failed = [];
  for (const [id, add] of plan.plan) { if (placeOn(id, add, { silent: true })) placed.add(id); else failed.push(id); }
  const skipPass = plan.skipped.some((x) => x.id === 'pass'), skipDont = plan.skipped.some((x) => x.id === 'dontPass');
  // one toast carrying every message, so a skipped line bet never hides the re-booked amounts
  const msgs = [];
  const rounded = plan.rounded.filter((x) => placed.has(x.id));
  if (rounded.length) msgs.push('Rebet — ' + rounded.map((x) => `${game.betInfo(x.id).name} ${fmt(x.from)} → ${fmt(x.to)}`).join(', ') + ' (re-booked in payable units)');
  if (failed.length) msgs.push(`Not rebet (insufficient bankroll): ${failed.map((id) => game.betInfo(id).name).join(', ')}`);
  if (skipPass) msgs.push('Pass Line not rebet — the point is on. Click the Pass Line to make a Put bet.');
  if (skipDont) msgs.push("Don't Pass not rebet — it is closed once the point is on (Don't Come is open).");
  if (msgs.length) toast(msgs.join(' · '), true);
  if (failed.length) audio.error();
}

// ---------- rolling ----------
function snapshotBets() {
  const s = {};
  for (const [id, a] of Object.entries(game.bets)) if (!/^(come|dontCome|comeOdds|dontComeOdds)\d/.test(id)) s[id] = a;
  if (Object.keys(s).length) ui.lastBets = s;
}

function roll({ instant = false, values = null } = {}) {
  if (ui.phase !== 'betting') return;
  audio.init();
  clearPending();
  snapshotBets();
  const v = values || [rollDie(diceRng), rollDie(diceRng)];
  const sim = simulateThrow(physRng);
  ui.rollValues = v;
  ui.phase = 'rolling';
  stage.hideResult?.();
  sideBets.close();
  persist(); // the outcome is already decided: save it resolved, so reloading mid-throw cannot undo it
  highlighter.set(null); hideTooltip();
  updateHUD();
  if (instant) { dice.freezeAt(sim, v, sim.duration, { trail: false }); settle(v, { instant: true }); return; }
  const SP = SPEEDS[settings.speed] || SPEEDS.normal;
  const speed = SP.mul, pickup = SP.pickup;
  // The whole throw is known now: rattle, release whoosh, felt roll AND every impact are scheduled on the
  // audio clock at once (sample-accurate flams, no snapping to render frames).
  audio.throwDice(sim, { pickup, speed });
  dice.playThrow(sim, v, {
    speed,
    pickup,
    onSettle: () => settle(v),
  });
  // Drive the throw's animation time from the wall clock (offset by the audio output latency), not from
  // accumulated clamped frame dt, so a frame hitch cannot let the visuals fall behind the scheduled audio.
  if (!SHOT && dice.anim) dice.anim.wall0 = performance.now() + audio.latency * 1000;
}
/** Logic dt for the dice: catches an in-flight throw up to the wall clock (see roll()). */
function diceDt(dt) {
  const a = dice.anim;
  if (SHOT || !a || a.wall0 == null) return dt;
  const want = ((performance.now() - a.wall0) / 1000) * a.speed - a.pickup;
  return Math.max(0, (want - a.t) / a.speed);
}

function settle([v1, v2], { instant = false } = {}) {
  ui.rollValues = null;
  const res = game.resolveRoll(v1, v2);
  logRoll(res);
  persist();
  ui.phase = 'paying';
  ui.lastWins = res.events.filter((e) => e.type === 'win' && /^(place|buy)\d/.test(e.id)).map((e) => ({ id: e.id, win: e.win }));
  renderHistory();
  if (instant) {
    chips.sync(game.bets); chips.setRail(game.bankroll); puck.set(game.point, { animate: false });
    ui.phase = 'betting'; updateHUD(); renderLastResult();
    return res;
  }
  callout(res);
  stage.showResult?.(dice.center, v1, v2); // in-world result tag over the resting dice (atmosphere)
  const dur = chips.applyEvents(res.events, { fast: false });
  later(0.55, () => { if (puck.set(game.point)) { /* sound on land */ } });
  later(0.35, () => {
    banner(res);
    renderLastResult(); // lands with the payout ribbon, not while the dice are still tumbling
    audio.result(res);
  });
  updateHUD();
  later(Math.max(1.0, dur + 0.15) / (SPEEDS[settings.speed] || SPEEDS.normal).pay, () => {
    chips.finishAll();
    chips.sync(game.bets);
    chips.setRail(game.bankroll);
    ui.phase = 'betting';
    persist();
    updateHUD();
  });
  return res;
}
function persist() {
  // Full table state, bets included (no refunds on reload). A throw in flight is saved already
  // resolved — its dice were picked before the animation — so reloading cannot undo a seven-out.
  if (SHOT) return;
  let snap = game.serialize();
  if (ui.rollValues) { const g = CrapsGame.restore(snap); g.resolveRoll(ui.rollValues[0], ui.rollValues[1]); snap = g.serialize(); }
  store.set('game', snap);
  store.set('bankroll', snap.bankroll); // legacy key (older builds)
}

// ---------- input ----------
const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();
const feltPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const hitPt = new THREE.Vector3();
let hoverZone = null;
let lastPointer = null; // last pointer position over the canvas (for Alt-key tooltip refresh)
function zoneAt(e) {
  const r = canvas.getBoundingClientRect();
  ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  if (!raycaster.ray.intersectPlane(feltPlane, hitPt)) return null;
  if (Math.abs(hitPt.x) > FELT.hw || Math.abs(hitPt.z) > FELT.hd) return null;
  return hitTest(hitPt.x, hitPt.z);
}
const tooltip = $('tooltip');
/**
 * Bet id a click on a zone makes. After the point, a click on a Pass Line that already has a flat bet goes
 * to the odds (what the player almost always wants); Alt-click adds to the flat bet instead (a Put, confirmed).
 */
function clickId(zone, alt = false) {
  // Alt over a number box = a Put on that number (or a Put raise on a traveled come bet): same as the click
  if (alt && zone.key === 'number' && game.point && game.settings.putBets) return 'come' + zone.n;
  const id = resolveBetId(zone, { oddsMode: ui.oddsMode, game });
  if (id === 'pass' && game.point && game.bets.pass && !alt) return 'passOdds';
  return id;
}
function hideTooltip() { tooltip.classList.remove('show'); }
function showTooltip(zone, e) {
  const id = clickId(zone, e && e.altKey);
  const info = game.betInfo(id);
  const cur = game.amount(id);
  // what a chip click here would actually book (small chips accumulate; unit bets round to units)
  const pend = ui.pending[id] || 0;
  const stake = /Odds/.test(id) ? game.oddsStake(id, ui.chip, pend, pendingTotal(id)) : game.chipStake(id, ui.chip, pend, pendingTotal(id));
  let v = ui.phase === 'betting' ? game.validate(id, stake.add || Math.max(game.minFor(id), game.unitFor(id))) : { ok: false, reason: 'Dice are rolling' };
  if (v.ok && !stake.add) v = { ok: false, reason: `${fmt(stake.pending)} pending — ${fmt(stake.short || game.unitFor(id) - stake.pending)} more books ${info.name}` };
  else if (!v.ok && !stake.add && /Minimum|units/.test(v.reason)) v = { ok: false, reason: `${pend ? `${fmt(pend)} pending · ` : ''}chips stack until ${fmt(game.minFor(id))}` };
  if (v.ok && info.warn) v = { ok: false, reason: info.warn };
  const pv = game.preview(id, v.ok || info.warn ? stake.add : 0);
  const wid = workingIdsForZone(zone).find((x) => game.bets[x] && game.canToggleWorking(x));
  const offTag = cur && !game.isWorking(id) ? ' <span class="tt-off">OFF</span>' : '';
  // line 1: what is on the felt now; line 2: what the next click would make it (only when that add is valid)
  const now = cur ? game.preview(id, 0) : null;
  const nowLine = cur ? `<div class="tt-bet tt-now"><span class="tt-k">On table</span><b>${fmt(cur)}</b>${now && now.win > 0 ? `<i>·</i>wins <b class="w">${fmt(now.win)}</b>` : ''}</div>` : '';
  const nextLine = (v.ok || info.warn) && stake.add > 0 && pv.win > 0 ? `<div class="tt-bet tt-next"><span class="tt-k">Next click</span>${cur ? `+${fmt(stake.add)} → ` : ''}<b>${fmt(pv.total)}</b><i>·</i>wins <b class="w">${fmt(pv.win)}</b></div>` : '';
  const winLine = nowLine + nextLine;
  // keycap hints (no separator glyphs, so a wrap can never orphan one); the click amount is the stake the
  // click really books (stake.add, e.g. rounded to the $6 unit on Place 6/8), matching the "Next click" line
  const unit = game.unitFor(id);
  const hk = [['Click', `+${fmt(stake.add > 0 ? stake.add : ui.chip)}${stake.add > 0 && unit > 1 && ui.chip % unit && !(stake.add % unit) ? ` <i class="tt-unit">(${fmt(unit)} units)</i>` : ''}`]];
  if (cur) hk.push(['Right-click', 'Take down']);
  if (wid) hk.push(['Shift', `Turn ${game.isWorking(wid) ? 'OFF' : 'ON'}`]);
  if (zone.key === 'number' && game.point && game.settings.putBets && !(e && e.altKey)) hk.push(['Alt', game.bets['come' + zone.n] ? `Put raise ${zone.n}` : `Put ${zone.n}`]);
  tooltip.innerHTML = `<div class="tt-name"><span>${info.name}</span>${offTag}<span class="tt-pays">Pays ${info.pays}</span></div>${winLine}${!v.ok && !/Odds/.test(id) ? `<div class="tt-warn">${v.reason}</div>` : pv.warn ? `<div class="tt-warn">${pv.warn}</div>` : ''}<div class="tt-hint">${hk.map(([k, t]) => `<span><kbd>${k}</kbd>${t}</span>`).join('')}</div>${zone.key === 'number' && game.point && game.settings.putBets && e && e.altKey ? `<div class="tt-warn">Alt: booking ${game.bets['come' + zone.n] ? `a Put raise on Come ${zone.n}` : `Put ${zone.n}`}${info.warn ? ' (confirm with a second click)' : ''}</div>` : ''}`;
  placeTooltip(zone, e);
  tooltip.classList.add('show');
}
// Anchor the tooltip to the hovered bet with a pointer arrow, outside the bet's own screen rect (for a
// number column: the whole LAY/number/BUY column), so the hovered zone and its neighbours stay readable.
// Far-half bets open above (over the back wall), near-half bets below (over the front rail), centre props
// beside the prop column; it never overlaps the HUD panels along the top or bottom edge.
const _ttV = new THREE.Vector3();
function hudLimit(x, w, sel, top) {
  let lim = top ? 70 : innerHeight - 10;
  for (const el of document.querySelectorAll(sel)) {
    const q = el.getBoundingClientRect();
    if (!q.width || x >= q.right || x + w <= q.left) continue;
    lim = top ? Math.max(lim, q.bottom + 8) : Math.min(lim, q.top - 8);
  }
  return lim;
}
const topLimit = (x, w) => hudLimit(x, w, '#hud > .plaque, #hud > .status, #hud > .top-actions, #hud > .callout.show', true);
const bottomLimit = (x, w) => hudLimit(x, w, '#historyPanel, #chipTray, .quick-actions, #rollBtn', false);
function placeTooltip(zone, e) {
  const W = innerWidth, tw = tooltip.offsetWidth || 240, th = tooltip.offsetHeight || 120, gap = 14, m = 10;
  let pick = { x: e.clientX - tw / 2, y: e.clientY - 26 - th, arrow: 'down', ax: e.clientX };
  try {
    const b = zone.bbox, centre = zone.side === 0;
    let x0 = centre ? Math.min(C.XE0, C.X0) : b.x0, x1 = centre ? Math.max(-C.XE0, C.X1) : b.x1;
    let z0 = centre ? Math.min(C.ZTOP, b.z0) : b.z0, z1 = centre ? Math.max(C.ZANY + 1, b.z1) : b.z1;
    if (['lay', 'number', 'buy'].includes(zone.key)) {
      for (const q of ZONES) if (q.side === zone.side && q.n === zone.n && ['lay', 'number', 'buy'].includes(q.key)) { z0 = Math.min(z0, q.bbox.z0); z1 = Math.max(z1, q.bbox.z1); }
    }
    const r = canvas.getBoundingClientRect();
    let L = Infinity, R = -Infinity, T = Infinity, B = -Infinity;
    const toS = (px, pz) => { _ttV.set(px, 0, pz).project(camera); return [r.left + (_ttV.x + 1) / 2 * r.width, r.top + (1 - _ttV.y) / 2 * r.height]; };
    for (const [px, pz] of [[x0, z0], [x1, z0], [x0, z1], [x1, z1]]) {
      const [sx, sy] = toS(px, pz); L = Math.min(L, sx); R = Math.max(R, sx); T = Math.min(T, sy); B = Math.max(B, sy);
    }
    const ax = (L + R) / 2; // arrow points at the bet itself, not at the cursor
    const cx = (v) => Math.max(m, Math.min(W - tw - m, v));
    const C_ = {
      above: () => ({ x: cx(ax - tw / 2), y: T - gap - th, arrow: 'down', ax }),
      below: () => ({ x: cx(ax - tw / 2), y: B + gap, arrow: 'up', ax }),
      left: () => ({ x: L - gap - tw, y: e.clientY - th / 2, arrow: 'right', side: true }),
      right: () => ({ x: R + gap, y: e.clientY - th / 2, arrow: 'left', side: true }),
    };
    const fits = (c) => {
      if (c.x < m || c.x + tw > W - m) return false;
      if (c.side) c.y = Math.max(topLimit(c.x, tw), Math.min(bottomLimit(c.x, tw) - th, c.y));
      return c.y >= topLimit(c.x, tw) && c.y + th <= bottomLimit(c.x, tw);
    };
    const toLeft = e.clientX < W / 2;
    const sides = toLeft ? ['left', 'right'] : ['right', 'left'];
    const farHalf = (b.z0 + b.z1) / 2 < 0;
    const order = centre ? [...sides, 'above', 'below'] : farHalf ? ['above', 'below', sides[0]] : ['below', 'above', sides[0]]; // open felt above/below before covering neighbouring boxes
    for (const k of order) { const c = C_[k](); if (fits(c)) { pick = c; break; } }
  } catch { }
  let { x, y } = pick;
  x = Math.max(m, Math.min(W - tw - m, x));
  y = Math.max(topLimit(x, tw), Math.min(innerHeight - th - m, y)); // never on top of the HUD panels along the top edge
  tooltip.dataset.arrow = pick.arrow;
  if (pick.arrow === 'down' || pick.arrow === 'up') tooltip.style.setProperty('--ax', Math.max(16, Math.min(tw - 16, pick.ax - x)) + 'px');
  else tooltip.style.setProperty('--ay', Math.max(16, Math.min(th - 16, e.clientY - y)) + 'px');
  tooltip.style.left = x + 'px'; tooltip.style.top = y + 'px';
}
// ---------- touch: a tap books a chip, a long-press opens the bet menu (touch stand-in for right-click, Alt and Shift) ----------
const LONG_PRESS_MS = 450;
let lp = null;        // the live one-finger press: { id, x, y, timer, fired }
let lastTouchT = -1e9; // Android also fires a native contextmenu on long-press: ignore it for touch
function cancelLongPress() { if (lp) { clearTimeout(lp.timer); lp = null; } }
canvas.addEventListener('pointerdown', (e) => {
  if (e.pointerType !== 'touch') return;
  lastTouchT = performance.now();
  closeBetMenu();
  if (lp) { cancelLongPress(); return; } // a second finger: that's a pinch, not a press
  const p = { id: e.pointerId, x: e.clientX, y: e.clientY, fired: false };
  p.timer = setTimeout(() => {
    if (rig.dragging || ui.phase !== 'betting') return;
    const z = zoneAt({ clientX: p.x, clientY: p.y }); if (!z) return;
    p.fired = true;
    try { navigator.vibrate?.(12); } catch { }
    highlighter.set(z);
    openBetMenu(z, p.x, p.y);
  }, LONG_PRESS_MS);
  lp = p;
});
canvas.addEventListener('pointercancel', () => cancelLongPress());

const betMenu = document.body.appendChild(Object.assign(document.createElement('div'), { id: 'betMenu', className: 'bet-menu' }));
betMenu.setAttribute('role', 'menu');
function closeBetMenu() { if (betMenu.classList.contains('show')) { betMenu.classList.remove('show'); highlighter.set(null); } }
document.addEventListener('pointerdown', (e) => { if (!betMenu.contains(e.target) && e.target !== canvas) closeBetMenu(); });
function openBetMenu(z, x, y) {
  const id = clickId(z), info = game.betInfo(id);
  const onZone = removableIdsForZone(z).reduce((s, b) => s + game.amount(b) + (ui.pending[b] || 0), 0);
  const items = [];
  if (removableIdsForZone(z).some((b) => game.bets[b] || ui.pending[b])) items.push(['Remove bet', () => removeAtZone(z)]);
  if (z.key === 'number' && game.point && game.settings.putBets) items.push([`Put bet on ${z.n}`, () => placePut(z.n)]);
  if (z.key === 'pass' && game.point && game.bets.pass) items.push(['Add to flat Pass Line', () => placeChip('pass')]);
  if (workingIdsForZone(z).some((b) => game.bets[b] && game.canToggleWorking(b))) items.push(['Turn ON / OFF', () => toggleZoneWorking(z)]);
  if (['horn', 'ce', 'any7', 'anyCraps'].includes(z.key)) items.push(['Side bets…', () => sideBets.open()]);
  items.push(['About this bet', () => { showTooltip(z, { clientX: x, clientY: y, altKey: false }); clearTimeout(openBetMenu.tipT); openBetMenu.tipT = setTimeout(hideTooltip, 4500); }]);
  betMenu.replaceChildren();
  const head = betMenu.appendChild(document.createElement('div')); head.className = 'bm-head';
  head.textContent = info?.name || 'Bet';
  if (onZone) { const b = head.appendChild(document.createElement('b')); b.textContent = fmt(onZone); }
  for (const [label, fn] of items) {
    const btn = betMenu.appendChild(document.createElement('button'));
    btn.type = 'button'; btn.className = 'bm-item'; btn.setAttribute('role', 'menuitem'); btn.textContent = label;
    btn.addEventListener('click', () => { closeBetMenu(); audio.init(); fn(); });
  }
  betMenu.classList.add('show');
  // beside the finger (never under it), kept inside the screen
  const w = betMenu.offsetWidth, h = betMenu.offsetHeight, m = 8;
  let left = x + 24; if (left + w > innerWidth - m) left = x - 24 - w;
  betMenu.style.left = Math.max(m, Math.min(innerWidth - w - m, left)) + 'px';
  betMenu.style.top = Math.max(m, Math.min(innerHeight - h - m, y - h / 2)) + 'px';
}

canvas.addEventListener('pointermove', (e) => {
  if (e.pointerType === 'touch') {
    // no hover on a touch screen: only a finger that wanders far enough cancels the long-press
    if (lp && lp.id === e.pointerId && Math.hypot(e.clientX - lp.x, e.clientY - lp.y) > 10) cancelLongPress();
    return;
  }
  if (rig.dragging) { highlighter.set(null); hideTooltip(); canvas.style.cursor = 'grabbing'; return; }
  const z = ui.phase === 'betting' ? zoneAt(e) : null;
  hoverZone = z;
  lastPointer = { clientX: e.clientX, clientY: e.clientY, altKey: e.altKey, shiftKey: e.shiftKey };
  highlighter.set(z);
  canvas.style.cursor = z ? 'pointer' : 'default';
  if (z) showTooltip(z, e); else hideTooltip();
});
canvas.addEventListener('pointerleave', () => { hoverZone = null; highlighter.set(null); hideTooltip(); });
// Alt pressed/released without moving the mouse: re-render the tooltip so it names what the click books (Put vs odds/place)
function onAltKey(e, down) {
  if (e.key !== 'Alt') return;
  e.preventDefault(); // keep Edge/Chrome on Windows from moving focus to the browser menu
  if (!lastPointer) return;
  lastPointer = { ...lastPointer, altKey: down };
  if (hoverZone && ui.phase === 'betting') showTooltip(hoverZone, lastPointer);
}
window.addEventListener('keydown', (e) => onAltKey(e, true));
window.addEventListener('keyup', (e) => onAltKey(e, false));
window.addEventListener('blur', () => { if (lastPointer && lastPointer.altKey) { lastPointer = { ...lastPointer, altKey: false }; if (hoverZone) showTooltip(hoverZone, lastPointer); } });
canvas.addEventListener('pointerup', (e) => {
  if (e.pointerType === 'touch') {
    const fired = lp && lp.id === e.pointerId && lp.fired;
    if (lp && lp.id === e.pointerId) cancelLongPress();
    if (fired) return; // the long-press opened the bet menu: lifting the finger books nothing
  }
  if (e.button !== 0 || rig.dragging) return;
  audio.init();
  const z = zoneAt(e); if (!z) return;
  if (e.shiftKey) { toggleZoneWorking(z); if (hoverZone) showTooltip(z, e); return; }
  if (e.altKey && z.key === 'number') { e.preventDefault(); placePut(z.n); if (hoverZone) showTooltip(z, e); return; }
  placeChip(clickId(z, e.altKey));
  if (hoverZone) showTooltip(z, e);
});
canvas.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  if (performance.now() - lastTouchT < 1500) return; // touch long-press: handled by the bet menu
  const z = zoneAt(e); if (!z) return;
  // Horn / C & E / Any 7 with nothing to take down: open the side-bet menu (World, Horn High, hops…)
  if (!removableIdsForZone(z).some((id) => game.bets[id] || ui.pending[id]) && ['horn', 'ce', 'any7', 'anyCraps'].includes(z.key)) { sideBets.open(); return; }
  removeAtZone(z);
});
/** Right-click / "Remove bet": hand back a pending chip, else take down the most specific bet on the zone. */
function removeAtZone(z) {
  const ids = removableIdsForZone(z).filter((id) => game.bets[id]);
  const pid = removableIdsForZone(z).find((id) => ui.pending[id]);
  if (!ids.length && pid) { toast(`${fmt(ui.pending[pid])} pending on ${game.betInfo(pid).name} returned`, true); delete ui.pending[pid]; setPendingVisual(pid); return; }
  if (!ids.length) return;
  takeDown(ids[0]);
  if (pid) { delete ui.pending[pid]; }
}

// ---------- side bets (World, Horn High, Hops, Fire, All/Tall/Small) ----------
const sideBets = createSideBets({
  game, fmt,
  getChip: () => ui.chip,
  isBetting: () => ui.phase === 'betting',
  pending: (id) => ui.pending[id] || 0,
  place: (id) => { audio.init(); return placeChip(id); },
  remove: (id) => {
    if (ui.pending[id] && !game.bets[id]) { delete ui.pending[id]; setPendingVisual(id); return true; }
    return takeDown(id);
  },
});
{
  const menu = $('moreMenu');
  const sbBtn = document.createElement('button');
  sbBtn.className = menu ? 'mi' : 'act'; sbBtn.id = 'sideBetsBtn'; sbBtn.setAttribute('role', 'menuitem');
  sbBtn.title = 'World, Horn High, Hop bets, Fire Bet, All/Tall/Small (B) · also right-click the Horn box';
  sbBtn.innerHTML = menu ? '<span class="mi-ico">✶</span><span class="mi-txt">Side bets<em>Hops, World, Horn High, Fire, ATS</em></span>' : 'Side bets';
  sbBtn.addEventListener('click', () => { audio.click(); sideBets.toggle(); });
  (menu || $('rollBtn')?.parentElement || document.body).appendChild(sbBtn);
}

$('rollBtn').addEventListener('click', () => roll());
$('oddsBtn').addEventListener('click', () => { ui.oddsMode = !ui.oddsMode; audio.click(); updateHUD(); });
$('maxOddsBtn').addEventListener('click', maxOdds);
$('pressBtn').addEventListener('click', (e) => press({ double: e.shiftKey }));
$('pressBtn').title = 'Press with winnings · Shift-click to double (P / Shift+P)';
$('takeDownBtn').addEventListener('click', takeDownPlaces);
$('clearBtn').addEventListener('click', clearAll);
$('rebetBtn').addEventListener('click', rebet);
$('workingBtn').addEventListener('click', () => { game.setSettings({ placeWorkingOnComeOut: !game.settings.placeWorkingOnComeOut }); store.set('placeWorking', game.settings.placeWorkingOnComeOut); audio.click(); updateHUD(); persist(); });
let camIdx = Math.max(0, PRESET_ORDER.indexOf(rig.presetName));
$('camBtn').addEventListener('click', () => { camIdx = (camIdx + 1) % PRESET_ORDER.length; rig.setPreset(PRESET_ORDER[camIdx]); toast(`View: ${PRESET_ORDER[camIdx]}`, true); });
$('soundBtn').addEventListener('click', () => { audio.init(); audio.setMuted(!audio.muted); updateHUD(); });
$('helpBtn').addEventListener('click', () => $('helpModal').classList.add('show'));
$('settingsBtn').addEventListener('click', () => $('settingsModal').classList.add('show'));
document.querySelectorAll('.modal').forEach((m) => m.addEventListener('click', (e) => { if (e.target === m || e.target.hasAttribute('data-close')) m.classList.remove('show'); }));
// settings modal
$('qualitySel').value = settings.quality;
$('qualitySel').addEventListener('change', (e) => { store.set('quality', e.target.value); toast('Reloading with new quality…', true); setTimeout(() => location.reload(), 500); });
$('volRange').value = audio.volume; $('volRange').addEventListener('input', (e) => { audio.init(); audio.setVolume(Number(e.target.value)); });
$('ambChk').checked = audio.ambienceOn; $('ambChk').addEventListener('change', (e) => { audio.init(); audio.setAmbience(e.target.checked); });
if ($('callChk')) { $('callChk').checked = audio.callouts; $('callChk').addEventListener('change', (e) => { audio.init(); audio.setCallouts(e.target.checked); }); }
if ($('chimeChk')) { $('chimeChk').checked = audio.chimes; $('chimeChk').addEventListener('change', (e) => { audio.init(); audio.setChimes(e.target.checked); }); }
// game speed is driven by the segmented control in ui.js (writes settings.speed)
$('hardChk').checked = game.settings.hardwaysWorkingOnComeOut; $('hardChk').addEventListener('change', (e) => { game.setSettings({ hardwaysWorkingOnComeOut: e.target.checked }); store.set('hardWorking', e.target.checked); persist(); });
$('resetBank').addEventListener('click', () => {
  if (ui.phase !== 'betting') return;
  // game.reset() clears bets, point, ON/OFF overrides, Fire/ATS tracking, history and stats (settings kept)
  ui.pending = {}; ui.lastBets = null; ui.lastWins = []; ui.putConfirm = { id: null, armedAt: -1, confirmedAt: -1 };
  game.reset(1000); store.set('sessionStart', 1000);
  sessionLog = []; store.set('sessionLog', sessionLog); renderLastResult();
  chips.sync(game.bets); chips.setRail(game.bankroll); puck.set(null); persist(); renderHistory(); updateHUD(); sideBets.refresh(); toast('Bankroll reset to $1,000', true);
});

window.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  const k = e.key.toLowerCase();
  if (k === ' ' || k === 'enter') { e.preventDefault(); roll(); }
  else if (k >= '1' && k <= '6') { ui.chip = DENOMS[Number(k) - 1].v; store.set('chip', ui.chip); updateChips(); }
  else if (k === 'o') { ui.oddsMode = !ui.oddsMode; updateHUD(); }
  else if (k === 'c') clearAll();
  else if (k === 'r') rebet();
  else if (k === 'p') { if (ui.lastWins.length && ui.phase === 'betting') press({ double: e.shiftKey }); }
  else if (k === 'w') { if (hoverZone) toggleZoneWorking(hoverZone); }
  else if (k === 'v') $('camBtn').click();
  else if (k === 'm') $('soundBtn').click();
  else if (k === 'h') $('helpModal').classList.toggle('show');
  else if (k === 'b') sideBets.toggle();
  else if (k === 'escape') { document.querySelectorAll('.modal').forEach((m) => m.classList.remove('show')); sideBets.close(); }
});
window.addEventListener('beforeunload', persist);

// ---------- shot modes ----------
function forceRoll(d1, d2) { return settle([d1, d2], { instant: true }); }
function bet(id, amt) { const r = game.placeBet(id, amt); if (!r.ok) throw new Error(`shot setup: ${id} $${amt}: ${r.reason}`); }
function overviewState() {
  bet('pass', 10); forceRoll(4, 2);
  bet('passOdds', 50); bet('place8', 12); bet('field', 10); bet('come', 10); bet('hard6', 5); bet('hard8', 5);
  chips.sync(game.bets); chips.setRail(game.bankroll);
  dice.placeResting(4, 2, [[9.4, -0.9, 0.45], [9.85, -0.45, 1.2]]);
}
function setupShot(name) {
  switch (name) {
    case 'overview': overviewState();
      // ?view=<preset> (e.g. hero) frames the same table state from another camera preset
      if (params.get('view')) rig.setPreset(params.get('view'), { instant: true });
      else { rig.setPreset('overview', { instant: true }); rig.restOn?.(dice.center, { instant: true }); } // resting-dice push, as after a live roll
      stage.showResult?.(dice.center, 4, 2, { instant: true });
      break;
    case 'live': { chips.setRail(game.bankroll); placeOn('pass', 10); placeOn('field', 5); placeOn('any7', 5); setTimeout(() => roll({ values: [3, 4] }), 400); rig.setPreset('overview', { instant: true }); break; }
    case 'layout': chips.setRail(game.bankroll); dice.placeResting(3, 5, [[11.7, 0.32, 0.35], [12.55, 0.06, 1.05]]); rig.setPreset('layout', { instant: true }); break;
    case 'dice': {
      chips.setRail(game.bankroll);
      const dp = params.get('dpos')?.split(',').map(Number); // review override: x1,z1,yaw1,x2,z2,yaw2
      const dv = params.get('dval')?.split(',').map(Number); // review override: top values, e.g. 1,1 for the 1-face close-up
      dice.placeResting(dv?.[0] || 6, dv?.[1] || 5, dp?.length === 6 ? [dp.slice(0, 3), dp.slice(3)] : [[16.05, -0.42, 0.62], [16.42, 0.12, 1.32]]);
      const cam = params.get('cam')?.split(',').map(Number); // review override: x,y,z,tx,ty,tz,fov
      if (cam?.length === 7) rig.lookFrom(cam.slice(0, 3), cam.slice(3, 6), cam[6]);
      else rig.lookFrom([14.85, 0.72, 1.0], [16.28, 0.13, -0.12], 28); // hero close-up: the pair resting just off the diamond rubber
      break;
    }
    case 'settle': {
      // proof of a live roll: play a recorded throw through the normal playback path to rest, then stamp
      // readValue() (read from the final world orientation) next to the values the game asked for
      chips.setRail(game.bankroll);
      const rng = makeRng(SEED ?? 7);
      const want = [1 + Math.floor(rng() * 6), 1 + Math.floor(rng() * 6)];
      const sim = simulateThrow(rng);
      const L = sim.frames[sim.frames.length - 1];
      const cx = (L.p[0] + L.p[3]) / 2, cz = (L.p[2] + L.p[5]) / 2;
      rig.lookFrom([cx - 2.6, 2.4, cz + 1.9], [cx + 0.2, 0.1, cz - 0.1], 34);
      const box = document.body.appendChild(document.createElement('div'));
      box.style.cssText = 'position:fixed;left:50%;top:110px;transform:translateX(-50%);z-index:99;font:600 22px/1.5 system-ui,sans-serif;color:#fff;background:#000c;padding:12px 22px;border-radius:12px;border:1px solid #fff3;text-align:center';
      box.textContent = `seed ${SEED ?? 7} · rolling… want ${want.join('+')}`;
      dice.playThrow(sim, want, {
        pickup: 0, onSettle: () => {
          const got = [dice.readValue(0), dice.readValue(1)], tilt = Math.max(dice.tiltDeg(0), dice.tiltDeg(1));
          const c = dice.center, P = dice.dice.map((d) => d.root.position);
          const k = 1 + Math.hypot(P[0].x - P[1].x, P[0].z - P[1].z) * 0.55; // frame both dice however far apart they rest
          rig.lookFrom([c.x - 2.2 * k, 2.0 * k, c.z + (c.z > 2 ? -1.4 : 1.4) * k], [c.x, 0.12, c.z], 34);
          const ok = got[0] === want[0] && got[1] === want[1] && tilt < 0.1;
          box.innerHTML = `<span style="color:${ok ? '#4fe08a' : '#ff5a5a'}">${ok ? 'PASS' : 'FAIL'}</span> · seed ${SEED ?? 7} · expected ${want.join(' + ')} · readValue ${got.join(' + ')} · tilt ${tilt.toFixed(3)}° · ${sim.duration.toFixed(2)} s · ${sim.attempts} sim(s) · wall dice ${sim.wallDice}<br><small>dice at (${c.x.toFixed(2)}, ${c.y.toFixed(2)}, ${c.z.toFixed(2)}) · cam (${camera.position.toArray().map((v) => v.toFixed(2)).join(', ')})</small>`;
        },
      });
      // drive the real playback loop (dice.update, 60 Hz) to rest before the first render: headless
      // software GL presents frames seconds behind logic, so this keeps the captured pose == stamped pose
      if (!params.has('live')) for (let k = 0; k < 1200 && dice.isRolling; k++) dice.update(1 / 60);
      break;
    }
    case 'pickup': {
      // stickman hand-off: dice dissolve out where they rest, then dissolve in at the shooter (?t in [-pickup, 0))
      overviewState();
      const sim = simulateThrow(makeRng(SEED ?? 11));
      dice.freezeAt(sim, [5, 2], params.has('t') ? Number(params.get('t')) : -0.28, { pickup: 0.38 });
      rig.setPreset('overview', { instant: true });
      break;
    }
    case 'rollmid': {
      // gameplay framing mid-throw: the rig's dolly toward the dice at its in-roll weight (proves the subtle push)
      overviewState();
      const sim = simulateThrow(makeRng(SEED ?? 11));
      const t = params.has('t') ? Number(params.get('t')) : sim.duration * 0.42;
      dice.freezeAt(sim, [5, 2], t, { trail: true });
      rig.setPreset('overview', { instant: true });
      rig.setFocus(dice.center, 0.3); rig.focusWeight = 0.3; rig.update(0);
      break;
    }
    case 'roll': {
      overviewState();
      const sim = simulateThrow(makeRng(SEED ?? 11));
      const cam = params.get('cam')?.split(',').map(Number); // review override: offsets dx,dy,dz,tdx,tdy,tdz,fov
      const o = cam?.length === 7 ? cam : [-1.55, 0.3, 1.8, 0.35, -0.45, -0.35, 34]; // hero framing: the pair fills the frame mid-tumble
      // freeze the airborne moment where the two silhouettes are farthest apart across this view
      const t = params.has('t') ? Number(params.get('t')) : pickRollTime(sim, [o[3] - o[0], 0, o[5] - o[2]]);
      dice.freezeAt(sim, [5, 2], t);
      const c = dice.center;
      rig.lookFrom([c.x + o[0], c.y + o[1], c.z + o[2]], [c.x + o[3], c.y + o[4], c.z + o[5]], o[6]);
      break;
    }
    case 'chips': {
      // high-roller rail so the premium $100 / $500 / $1K chips show on the visible stack tops
      game.bankroll = 25000; game.stats.startBankroll = 25000; // the staged high-roller rail is a stake, not a session win
      bet('pass', 100); forceRoll(4, 2); bet('passOdds', 500); bet('come', 25); forceRoll(3, 2); bet('comeOdds5', 100);
      bet('place8', 1800); bet('place9', 2500); bet('place10', 4000); bet('place4', 725); bet('field', 37); bet('hard6', 5); bet('hard8', 5); bet('dontCome', 10);
      chips.sync(game.bets); chips.setRail(game.bankroll);
      dice.placeResting(3, 2, [[9.4, -0.9, 0.45], [9.85, -0.45, 1.2]]);
      const cam = params.get('cam')?.split(',').map(Number); // review override: x,y,z,tx,ty,tz,fov
      if (cam?.length === 7) rig.lookFrom(cam.slice(0, 3), cam.slice(3, 6), cam[6]);
      else rig.lookFrom([-6.6, 5.6, 2.4], [-9.0, 0.0, -4.4], 46); // player-side view down the place-bet row: every stack, the puck and each box numeral readable
      break;
    }
    case 'chipanim': {
      // chip animation proof frames: ?anim=place|sweep|pay|travel&at=seconds freezes the chips (and puck) mid-move
      const kind = params.get('anim') || 'place', at = Number(params.get('at') ?? 0.3);
      game.bankroll = 5000; game.stats.startBankroll = 5000;
      const A = { place: [[]], sweep: [[], [4, 2]], pay: [[4, 2], [4, 4]], travel: [[4, 2], [3, 2]], puck: [[], [4, 2]] }[kind] || [[]]; // puck: come-out 6 flips the puck OFF->ON and hops it to the 6
      if (kind === 'place') { chips.setRail(game.bankroll); for (const [id, a] of [['pass', 25], ['field', 15], ['place8', 30]]) { bet(id, a); chips.setBet(id, game.bets[id], { animate: true, delay: id === 'pass' ? 0 : 0.12 }); } }
      else {
        if (A[0].length) { bet('pass', 25); forceRoll(...A[0]); }
        if (kind === 'sweep') { bet('pass', 25); bet('field', 25); bet('any7', 10); bet('hard6', 10); }
        if (kind === 'puck') { bet('pass', 25); bet('place5', 25); bet('place8', 30); }
        if (kind === 'pay') { bet('passOdds', 50); bet('place8', 60); bet('hard8', 10); bet('field', 25); }
        if (kind === 'travel') { bet('passOdds', 50); bet('come', 25); bet('place8', 30); }
        chips.sync(game.bets); chips.setRail(game.bankroll); puck.set(game.point, { animate: false });
        const res = game.resolveRoll(...A[1]);
        chips.applyEvents(res.events);
        puck.set(game.point);
        dice.placeResting(A[1][0], A[1][1], [[9.4, -0.9, 0.45], [9.85, -0.45, 1.2]]);
      }
      if (kind === 'puck') rig.lookFrom([-8.2, 6.2, 1.2], [-10.0, 0.4, -4.6], 40); else rig.lookFrom([-6.6, 20.5, 12.2], [-6.6, 0, 0.9], 44); // steep enough that the near PASS LINE band (line bet + odds) clears the rail
      chips.faceTop();
      for (let t = 0; t < at; t += 1 / 60) { chips.update(1 / 60); puck.update(1 / 60); }
      if (kind !== 'puck') puck.update(10); // a frozen proof frame never shows the puck in limbo (except the puck-flip proof)
      chips.paused = true; puck.paused = true;
      break;
    }
    case 'hud': {
      bet('pass', 10);
      for (const [a, b] of [[3, 4], [5, 6], [2, 2], [3, 2], [6, 4], [1, 3]]) forceRoll(a, b); // naturals, point 4 made

      forceRoll(2, 4); // point 6
      bet('passOdds', 50); bet('place8', 12); bet('field', 10); bet('hard6', 5);
      forceRoll(5, 3); // place 8 wins, field loses
      const res = forceRoll(3, 3); // hard six — point made
      dice.placeResting(3, 3, [[9.4, -0.9, 0.45], [9.85, -0.45, 1.2]]);
      rig.setPreset('overview', { instant: true });
      stage.showResult?.(dice.center, 3, 3, { instant: true });
      callout(res, { sticky: true }); banner(res, { sticky: true });
      break;
    }
    case 'play': {
      // Instant rolls skip the rigid-body throw (up to 40 re-simulations each): 30 of them stalled headless
      // captures for minutes. The outcome path is the real one: dice RNG -> settle() -> rules + chips + HUD.
      let i = 0, lastV = [3, 4];
      const step = () => {
        for (let k = 0; k < 3 && i < 30; k++, i++) {
          for (const [id, amt] of autoStrategy(game, 10, i)) game.placeBet(id, amt);
          clearPending(); snapshotBets();
          lastV = [rollDie(diceRng), rollDie(diceRng)];
          settle(lastV, { instant: true });
        }
        updateHUD();
        if (i < 30) setTimeout(step, 0);
        else {
          dice.placeResting(lastV[0], lastV[1], [[9.4, -0.9, 0.45], [9.85, -0.45, 1.2]]);
          rig.setPreset('overview', { instant: true });
          const net = game.totalValue() - 1000;
          // the ribbon below carries the whole summary (no duplicate info toast under it)
          $('wbTitle').textContent = 'AUTO-PLAY · 30 ROLLS'; $('wbAmount').textContent = fmtSigned(net);
          $('wbLines').innerHTML = `<span>Points made ${game.stats.pointsMade} · Seven-outs ${game.stats.sevenOuts}</span><span>Bankroll ${fmt(game.bankroll)} · On table ${fmt(game.totalOnTable())}</span>`;
          $('winBanner').className = 'win-banner show' + (net < 0 ? ' lose' : '');
          window.__playDone = true;
        }
      };
      step();
      break;
    }
    default: overviewState();
  }
  renderHistory(); updateHUD();
}

// ---------- loop ----------
let last = performance.now();
let frames = 0;
// ?dt=0.1&steps=20 forces fixed logic timesteps per rendered frame, so slow headless
// renderers (few frames per capture) can still verify full animated sequences.
const SHOT_DT = params.has('dt') ? Number(params.get('dt')) : 0;
const STEPS = params.has('steps') ? Math.max(1, Number(params.get('steps'))) : 1;
const DEBUG = params.has('debug') ? Object.assign(document.body.appendChild(document.createElement('div')), { style: 'position:fixed;left:8px;top:120px;z-index:99;color:#0f0;font:14px monospace;background:#000a;padding:4px 8px' }) : null;
function tick(dt) {
  clockT += dt;
  runTimers();
  dice.update(diceDt(dt));
  chips.update(dt);
  lammers.update();
  puck.update(dt);
  highlighter.update(dt);
  rig.update(dt);
  tickBank(dt);
}
function frame(now) {
  const raw = Math.max(0, (now - last) / 1000); last = now;
  if (SHOT_DT) for (let i = 0; i < STEPS; i++) tick(SHOT_DT); else tick(Math.min(0.05, raw));
  if (DEBUG) DEBUG.textContent = `frames ${frames} · t ${clockT.toFixed(2)}s · raw ${(raw * 1000).toFixed(0)}ms · phase ${ui.phase} · vp ${innerWidth}x${innerHeight} · cv ${canvas.clientWidth}x${canvas.clientHeight}`;
  stage.render(Math.min(0.05, raw));
  if (++frames === 2) $('loader').classList.add('hide');
  requestAnimationFrame(frame);
}

updateChips();
if (SHOT) { document.body.classList.add('shot'); $('loader').style.display = 'none'; setupShot(SHOT); }
else { chips.sync(game.bets); chips.setRail(game.bankroll); renderHistory(); updateHUD(); renderLastResult({ pop: false }); }
puck.set(game.point, { animate: false });
if (SHOT) { chips.faceTop(); puck.faceToward(); } // square stack tops + puck lettering to the framed shot camera
window.craps = { game, dice, chips, puck, rig, stage, audio, roll, placeOn, placeChip, sideBets, ui, settings, persist, updateHUD, toast };
requestAnimationFrame(frame);
