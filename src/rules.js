// rules.js — pure, casino-correct craps engine. No THREE, no DOM.
//
// Money is in whole dollars. Payouts are floored to the dollar (casino "breakage"),
// so the engine never pays fractions of a dollar.
//
// Public surface (backward compatible):
//   new CrapsGame({ bankroll, settings })
//   game.placeBet(id, amount) / validate(id, amount) / removeBet(id) / canRemove(id)
//   game.resolveRoll(d1, d2) -> { events:[{id,type:'win'|'lose'|'push'|'move', stake, win, down, to, note, name, returned}], ... }
//   game.on(type, fn) -> unsubscribe     (types: 'bet','remove','reject','roll','resolve','point','working','*')
//   game.setWorking(id, bool|null), game.isWorking(id), game.canToggleWorking(id), game.toggleWorking(id)
//   game.betInfo(id)  (settings-aware), game.preview(id, add), game.pressAmount(id, win)
//   game.winFor(id, amount), game.payableAmount(id, amount), game.serialize(), CrapsGame.restore(obj)
//   game.chipStake(id, chip, pending) (dealer booking of flat/unit bets), game.oddsStake(id, chip, pending)
//   (dealer booking of odds in payable units), game.maxOddsAdd(id) (clean max-odds top-up),
//   game.rebetPlan(snapshot, held) (dealer re-booking of last bets for the current point). Stake helpers take
//   an optional trailing held = money pending on other bets, so it is never counted twice.
//   Dealer rounding (one policy, _book, for chips on place / buy / lay boxes, take odds and lay odds AND for
//   rebetPlan's re-booking): nearest payable amount, ties down, up only by <= settings.roundUpMax ($2), up for
//   the minimum case ($5 on Place 6 -> $6).
//   game.commissionFor(id) / game.upfrontVig(id, add): buy / lay commission (settings.buyVig, settings.layVig:
//   'win' | 'upfront'). A losing upfront bet's lose event carries { vig, lost: stake + vig }.
//   game.setSettings(patch): sanitized settings change (refunds prepaid vig the new rules no longer need).
//   game.rollOutcomes(): exact net of the next roll for every dice combination (silent copy; no events).
//   game.limitLabel(id): "$min – $max" for a bet (lays are limited by the win; settings.propMax / bonusMax).
//   OFF bets on a roll that would have decided them emit { type:'push', off:true, down:false, note:'Off on the come-out' }.
//
// Bet ids:
//   pass, dontPass, passOdds, dontPassOdds, come, dontCome (on the bar),
//   come4..come10 / dontCome4.. (traveled; come4.. may also be made directly as a Put bet),
//   comeOdds4.. / dontComeOdds4.., place4.., buy4.., lay4.., field, big6, big8,
//   hard4, hard6, hard8, hard10, any7, anyCraps, two, three, eleven, twelve, horn, ce,
//   world, hornHigh2, hornHigh3, hornHigh11, hornHigh12, hop{a}{b} (a<=b, e.g. hop15, hop33),
//   fire (Fire Bet), small, tall, all (All / Tall / Small bonus)

export const POINTS = [4, 5, 6, 8, 9, 10];
export const TRUE_ODDS = { 4: [2, 1], 5: [3, 2], 6: [6, 5], 8: [6, 5], 9: [3, 2], 10: [2, 1] };
export const LAY_ODDS = { 4: [1, 2], 5: [2, 3], 6: [5, 6], 8: [5, 6], 9: [2, 3], 10: [1, 2] };
export const PLACE_PAYS = { 4: [9, 5], 5: [7, 5], 6: [7, 6], 8: [7, 6], 9: [7, 5], 10: [9, 5] };
export const ODDS_345 = { 4: 3, 5: 4, 6: 5, 8: 5, 9: 4, 10: 3 };
export const HARD_PAYS = { 4: [7, 1], 6: [9, 1], 8: [9, 1], 10: [7, 1] };
export const PROP_PAYS = { any7: [4, 1], anyCraps: [7, 1], two: [30, 1], three: [15, 1], eleven: [15, 1], twelve: [30, 1] };
export const HOP_PAYS = { easy: [15, 1], hard: [30, 1] };
/** Fire Bet: unique points made by one shooter -> pays N:1 (paid at the seven-out, or at once on all six). */
export const FIRE_PAYS = { 4: 24, 5: 249, 6: 999 };
/** All / Tall / Small: every listed total must roll before a 7. Pays N:1. */
export const ATS = {
  small: { nums: [2, 3, 4, 5, 6], pays: 34 },
  tall: { nums: [8, 9, 10, 11, 12], pays: 34 },
  all: { nums: [2, 3, 4, 5, 6, 8, 9, 10, 11, 12], pays: 175 },
};
export const NUMBER_WORDS = { 2: 'Two', 3: 'Three', 4: 'Four', 5: 'Five', 6: 'Six', 7: 'Seven', 8: 'Eight', 9: 'Nine', 10: 'Ten', 11: 'Eleven', 12: 'Twelve' };
/** Number of the 36 dice combinations that produce each total. */
export const WAYS = { 2: 1, 3: 2, 4: 3, 5: 4, 6: 5, 7: 6, 8: 5, 9: 4, 10: 3, 11: 2, 12: 1 };

export const DEFAULT_SETTINGS = {
  tableMin: 5,
  tableMax: 5000,
  propMin: 1,
  odds: '345',                  // '345' or a number multiple (e.g. 2, 10, 100)
  placeWorkingOnComeOut: false, // place & buy bets are OFF on the come-out unless set
  hardwaysWorkingOnComeOut: false,
  comeOddsWorkingOnComeOut: false,
  fieldTwoPays: 2,              // field: 2 pays 2:1
  fieldTwelvePays: 3,           // field: 12 pays 3:1 (2:1 at some casinos)
  vigRate: 0.05,                // commission: buy = % of the bet, lay = % of the win; when it is collected: buyVig / layVig
  putBets: true,                // allow Put bets (pass line / come numbers made after the point)
  vigRounding: 'floor',         // how a fractional commission is rounded: 'floor' | 'nearest' | 'ceil' (always >= $1)
  oddsUnits: true,              // placeBet() only accepts odds totals that pay without breakage ($2 units on 5/9, $5 on 6/8 …)
  putOdds: 'full',              // odds allowed behind Put money: 'full' (normal multiple) | 'flat' (1x on the Put portion only;
                                //   contract money from the come-out keeps the normal multiple, see maxFor)
  roundUpMax: 2,                // dealer booking (see _book): a chip that is not a payable amount goes UP to the next clean
                                //   amount only when that is strictly nearer than going down AND costs <= this many dollars;
                                //   otherwise it books DOWN with change. 0 = never round up (except the minimum case).
  buyMin: 0,                    // minimum Buy bet (0 = the table minimum). Many casinos want $20+ on a Buy so the $1 vig is 5%.
  layVig: 'win',                // lay commission: 'win' (taken from the win, the default) | 'upfront' (paid when the lay is
                                //   booked, refunded if the lay is taken down, paid again for each new decision)
  buyVig: 'win',                // buy commission: 'win' (taken from the win: 1.67% edge on Buy 4/10) | 'upfront' (the classic
                                //   rule: 5% paid when the buy is booked, refunded on take-down: 4.76% on Buy 4/10)
  layMin: 0,                    // minimum WIN for a Lay bet (0 = the table minimum). Lays are sized by the win, so on a $5
                                //   table Lay 4 starts at $10 (wins $5); 20 makes the $1 vig an honest 5% (Lay 4 $40).
  propMax: 0,                   // maximum on a proposition (one-roll props, horn family, hops, hardways); 0 = the table
                                //   maximum. The Field and Big 6/8 are table bets and always use tableMax.
  bonusMax: 0,                  // maximum on a bonus bet (Fire Bet, All / Tall / Small); 0 = the table maximum.
};
/** Allowed Put-bet odds policies. */
export const PUT_ODDS = ['full', 'flat'];
/** Allowed commission timings (settings.layVig and settings.buyVig). */
export const LAY_VIG = ['win', 'upfront'];
export const BUY_VIG = LAY_VIG;
/** Allowed commission rounding policies. */
export const VIG_ROUNDING = ['floor', 'nearest', 'ceil'];

/** Allowed odds multiples besides '345'. */
export const ODDS_CHOICES = ['345', 1, 2, 3, 5, 10, 20, 25, 50, 100];
const clampInt = (v, lo, hi) => Math.min(hi, Math.max(lo, Math.round(v)));
/**
 * Coerce a settings object into sane table settings. Unknown keys are dropped, wrong types fall back to
 * the default, and numbers are clamped: tableMin >= 1, tableMax >= tableMin, propMin >= 1,
 * 0 <= vigRate <= 0.1, field 2/12 pays in {2,3}, odds '345' or an integer 1..100.
 */
export function sanitizeSettings(raw) {
  const S = { ...DEFAULT_SETTINGS };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return S;
  const num = (v) => typeof v === 'number' && Number.isFinite(v);
  for (const [k, d] of Object.entries(DEFAULT_SETTINGS)) {
    if (!(k in raw)) continue;
    const v = raw[k];
    if (typeof d === 'boolean') { if (typeof v === 'boolean') S[k] = v; continue; }
    if (k === 'vigRounding') { if (VIG_ROUNDING.includes(v)) S.vigRounding = v; continue; }
    if (k === 'putOdds') { if (PUT_ODDS.includes(v)) S.putOdds = v; continue; }
    if (k === 'layVig') { if (LAY_VIG.includes(v)) S.layVig = v; continue; }
    if (k === 'buyVig') { if (LAY_VIG.includes(v)) S.buyVig = v; continue; }
    if (k === 'odds') {
      if (v === '345') S.odds = '345';
      else if (num(v) && v >= 1) S.odds = clampInt(v, 1, 100);
      continue;
    }
    if (!num(v)) continue;
    if (k === 'tableMin') S.tableMin = clampInt(v, 1, 100000);
    else if (k === 'tableMax') S.tableMax = clampInt(v, 1, 1000000);
    else if (k === 'propMin') S.propMin = clampInt(v, 1, 1000);
    else if (k === 'roundUpMax') S.roundUpMax = clampInt(v, 0, 25);
    else if (k === 'buyMin') S.buyMin = clampInt(v, 0, 100000);
    else if (k === 'layMin') S.layMin = clampInt(v, 0, 100000);
    else if (k === 'propMax' || k === 'bonusMax') S[k] = clampInt(v, 0, 1000000);
    else if (k === 'vigRate') S.vigRate = Math.min(0.1, Math.max(0, v));
    else if (k === 'fieldTwoPays' || k === 'fieldTwelvePays') { if (v === 2 || v === 3) S[k] = v; }
  }
  if (S.tableMax < S.tableMin) S.tableMax = S.tableMin;
  if (S.buyMin > S.tableMax) S.buyMin = S.tableMax;
  // a prop / bonus maximum above the table maximum means nothing; one below the minimum stake would close the bet
  for (const k of ['propMax', 'bonusMax']) { if (S[k] >= S.tableMax) S[k] = 0; else if (S[k] && S[k] < S.propMin * 5) S[k] = S.propMin * 5; }
  return S;
}

/** Seeded PRNG (mulberry32). Returns float in [0,1). */
export function makeRng(seed = Date.now()) {
  let a = (seed >>> 0) || 0x9e3779b9;
  return function rng() {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function rollDie(rng) { return 1 + Math.floor(rng() * 6); }
export function rollDice(rng) { return [rollDie(rng), rollDie(rng)]; }

/** Pays amount at num:den, floored to whole dollars. */
export function payout(amount, [num, den]) { return Math.floor((amount * num) / den + 1e-9); }
/**
 * Commission (default 5%, minimum $1) applied to the bet (buy) or to the win (lay). `rounding` picks how
 * a fractional vig is rounded: 'floor' (default, player-friendly: $39 buy -> $1), 'nearest' ($39 -> $2,
 * $30 -> $2 since 1.5 rounds up) or 'ceil' ($21 -> $2). A 0% table charges nothing.
 */
export function vig(amount, rate = 0.05, rounding = 'floor') {
  if (!(rate > 0) || !(amount > 0)) return 0;
  const raw = amount * rate;
  const v = rounding === 'ceil' ? Math.ceil(raw - 1e-9) : rounding === 'nearest' ? Math.floor(raw + 0.5 + 1e-9) : Math.floor(raw + 1e-9);
  return Math.max(1, v);
}
const VIG_POLICY = { floor: 'rounded down', nearest: 'rounded to the nearest $1', ceil: 'rounded up' };

const NUM_RE = /^(come|dontCome|comeOdds|dontComeOdds|place|buy|lay)(4|5|6|8|9|10)$/;
const HOP_RE = /^hop([1-6])([1-6])$/;
const HORN_HIGH_RE = /^hornHigh(2|3|11|12)$/;
export function parseBetId(id) {
  const m = NUM_RE.exec(id);
  if (m) return { kind: m[1], n: Number(m[2]) };
  const h = HOP_RE.exec(id);
  if (h && Number(h[1]) <= Number(h[2])) return { kind: 'hop', n: Number(h[1]) + Number(h[2]), dice: [Number(h[1]), Number(h[2])], hard: h[1] === h[2] };
  const hh = HORN_HIGH_RE.exec(id);
  if (hh) return { kind: 'hornHigh', n: Number(hh[1]) };
  if (typeof id === 'string' && /^hard(4|6|8|10)$/.test(id)) return { kind: id, n: Number(id.slice(4)) };
  return { kind: id, n: null };
}
/** All hop bet ids (21 dice combinations). */
export const HOP_IDS = (() => { const a = []; for (let i = 1; i <= 6; i++) for (let j = i; j <= 6; j++) a.push(`hop${i}${j}`); return a; })();
export function hopId(d1, d2) { return `hop${Math.min(d1, d2)}${Math.max(d1, d2)}`; }

const NAMES = {
  pass: 'Pass Line', dontPass: "Don't Pass Bar", passOdds: 'Pass Line Odds', dontPassOdds: "Don't Pass Lay Odds",
  come: 'Come', dontCome: "Don't Come Bar", field: 'Field', big6: 'Big 6', big8: 'Big 8',
  hard4: 'Hard 4', hard6: 'Hard 6', hard8: 'Hard 8', hard10: 'Hard 10',
  any7: 'Any Seven', anyCraps: 'Any Craps', two: 'Two (Aces)', three: 'Three (Ace-Deuce)', eleven: 'Eleven (Yo)', twelve: 'Twelve (Boxcars)',
  horn: 'Horn', ce: 'C & E', world: 'World (Whirl)', fire: 'Fire Bet', small: 'All Small', tall: 'All Tall', all: "Make 'Em All",
};
const KIND_NAMES = { come: 'Come', dontCome: "Don't Come", comeOdds: 'Come Odds', dontComeOdds: "Don't Come Odds", place: 'Place', buy: 'Buy', lay: 'Lay' };
const fmtPays = ([a, b]) => `${a}:${b}`;
const ONE_ROLL_FIXED = new Set(['field', 'any7', 'anyCraps', 'two', 'three', 'eleven', 'twelve', 'horn', 'ce', 'world']);
const KNOWN = new Set(['pass', 'dontPass', 'passOdds', 'dontPassOdds', 'come', 'dontCome', 'field', 'big6', 'big8',
  'hard4', 'hard6', 'hard8', 'hard10', 'any7', 'anyCraps', 'two', 'three', 'eleven', 'twelve', 'horn', 'ce',
  'world', 'fire', 'small', 'tall', 'all']);
/** Bet kinds a player may switch ON/OFF individually. */
const TOGGLEABLE = new Set(['place', 'buy', 'lay', 'comeOdds', 'dontComeOdds', 'hard4', 'hard6', 'hard8', 'hard10', 'big6', 'big8']);
const isOneRoll = (id) => ONE_ROLL_FIXED.has(id) || HOP_RE.test(id) || HORN_HIGH_RE.test(id);

/** Broad family of a bet (useful for visuals/grouping). */
export function betGroup(id) {
  const { kind } = parseBetId(id);
  if (['pass', 'dontPass', 'passOdds', 'dontPassOdds'].includes(kind)) return 'line';
  if (['come', 'dontCome', 'comeOdds', 'dontComeOdds'].includes(kind)) return 'come';
  if (['place', 'buy', 'lay'].includes(kind)) return 'box';
  if (kind === 'big6' || kind === 'big8' || kind === 'field') return 'field';
  if (/^hard/.test(kind)) return 'hard';
  if (kind === 'fire' || ATS[kind]) return 'bonus';
  return 'prop';
}

/** True when an id names a bet this engine understands. */
export function isValidBetId(id) {
  if (typeof id !== 'string') return false;
  if (KNOWN.has(id) || NUM_RE.test(id) || HORN_HIGH_RE.test(id)) return true;
  const h = HOP_RE.exec(id);
  return !!h && Number(h[1]) <= Number(h[2]);
}

const pct = (r) => `${+(r * 100).toFixed(2)}%`;
/**
 * Human info about a bet id (name, payout string, one-roll, etc.).
 * Pass `settings` (and optionally the game) for table-accurate strings; game.betInfo(id) does this for you.
 */
export function betInfo(id, settings = DEFAULT_SETTINGS, game = null) {
  const S = { ...DEFAULT_SETTINGS, ...(settings || {}) };
  const { kind, n } = parseBetId(id);
  const P = game ? game.point : null;
  const base = { id, kind, n, oneRoll: isOneRoll(id), group: betGroup(id) };
  if (NUM_RE.test(id)) {
    let name = `${KIND_NAMES[kind]} ${n}`;
    let pays = '';
    if (kind === 'place') pays = fmtPays(PLACE_PAYS[n]);
    else if (kind === 'buy') pays = `${fmtPays(TRUE_ODDS[n])} (${pct(S.vigRate)} commission on the bet, ${VIG_POLICY[S.vigRounding] || VIG_POLICY.floor}, $1 min, ${S.buyVig === 'upfront' ? 'paid up front' : 'paid on win'})`;
    else if (kind === 'lay') pays = `${fmtPays(LAY_ODDS[n])} (${pct(S.vigRate)} of the win as commission, ${VIG_POLICY[S.vigRounding] || VIG_POLICY.floor}, $1 min, ${S.layVig === 'upfront' ? 'paid up front' : 'paid on win'})`;
    else if (kind === 'comeOdds') pays = fmtPays(TRUE_ODDS[n]);
    else if (kind === 'dontComeOdds') pays = fmtPays(LAY_ODDS[n]);
    else pays = '1:1';
    if (kind === 'come' && game && P && S.putBets) {
      // a new flat bet on a number after the point, or more money on a come bet that already traveled, is a Put
      if (!game.bets[id]) return { ...base, name: `Put ${n}`, pays, put: true, warn: PUT_WARN };
      return { ...base, name, pays, put: true, raise: true, warn: PUT_RAISE_WARN };
    }
    // house limit policy for buys and lays (this engine's rule, stated so the player is never surprised):
    // a Buy is capped by the BET at the table max, with the commission charged on top of it; a Lay is
    // capped by its WIN at the table max (Lay 4 $10,000 to win $5,000), commission on top as well
    if (kind === 'buy') return { ...base, name, pays, limit: `Buy up to $${S.tableMax} (the table max on the bet); commission on top` };
    if (kind === 'lay') return { ...base, name, pays, limit: `Lay up to a $${S.tableMax} win (the table max on the win); commission on top` };
    return { ...base, name, pays };
  }
  if (kind === 'hop') {
    const [a, b] = parseBetId(id).dice;
    return { ...base, name: `Hop ${a}-${b}${a === b ? ' (hard)' : ''}`, pays: fmtPays(a === b ? HOP_PAYS.hard : HOP_PAYS.easy) };
  }
  if (kind === 'hornHigh') {
    const hi = n, hiPays = hi === 2 || hi === 12 ? '57:5' : '27:5';
    return { ...base, name: `Horn High ${hi}`, pays: `${hi} nets ${hiPays} · other horn numbers 26:5 / 11:5 ($5 units)` };
  }
  let name = NAMES[id] || id;
  let pays = '1:1';
  let extra = {};
  if (id === 'pass' && P && S.putBets) {
    // any money added to the Pass Line after the point is a Put bet (it has lost the come-out advantage).
    // The name stays "Pass Line" once a flat bet is up, so resolution events still read correctly.
    if (!(game && game.bets.pass)) { name = `Put Bet (Pass Line on ${P})`; pays = '1:1 — back it with odds'; extra = { put: true, warn: PUT_WARN }; }
    else extra = { put: true, raise: true, warn: PUT_RAISE_WARN };
  }
  if (id === 'passOdds') pays = P ? `${fmtPays(TRUE_ODDS[P])} true odds` : 'True odds (2:1 · 3:2 · 6:5)';
  if (id === 'dontPassOdds') pays = P ? `${fmtPays(LAY_ODDS[P])} true odds` : 'True odds (1:2 · 2:3 · 5:6)';
  if (id === 'field') pays = `1:1 · 2 pays ${S.fieldTwoPays}:1 · 12 pays ${S.fieldTwelvePays}:1`;
  if (HARD_PAYS[n] && /^hard/.test(id)) pays = fmtPays(HARD_PAYS[n]);
  if (PROP_PAYS[id]) pays = fmtPays(PROP_PAYS[id]);
  if (id === 'horn') pays = '2/12 pay 30:1 · 3/11 pay 15:1 ($4 units, split 4 ways)';
  if (id === 'ce') pays = 'Craps 3:1 · Eleven 7:1 ($2 units)';
  if (id === 'world') pays = '2/12 net 26:5 · 3/11 net 11:5 · 7 pushes ($5 units)';
  if (id === 'fire') pays = `4 points ${FIRE_PAYS[4]}:1 · 5 points ${FIRE_PAYS[5]}:1 · 6 points ${FIRE_PAYS[6]}:1`;
  if (ATS[id]) pays = `${ATS[id].pays}:1 — ${ATS[id].nums.join(', ')} before a 7`;
  return { ...base, name, pays, ...extra };
}
/** Warning shown for Put bets (flat bets made after the point: no come-out advantage). */
export const PUT_WARN = 'Put bet — no come-out advantage; back it with odds';
/** Warning shown when more money goes on a flat line / come bet after the point (that extra is a Put). */
export const PUT_RAISE_WARN = 'Adding to a flat bet after the point is a Put bet — no come-out advantage; odds pay better';

const STICK = {
  2: 'Aces! Craps', 3: 'Ace-Deuce, Craps', 11: 'Yo-leven!', 12: 'Boxcars! Craps',
};
/** Stickman call for a roll. */
export function stickCall(d1, d2, pointBefore) {
  const t = d1 + d2, hard = d1 === d2;
  if (t === 7) return pointBefore ? 'Seven Out!' : 'Seven, Winner!';
  if (STICK[t]) return t === 11 && !pointBefore ? 'Yo-leven, Winner!' : STICK[t];
  const word = NUMBER_WORDS[t];
  if (pointBefore && t === pointBefore) {
    if ([4, 6, 8, 10].includes(t)) return `${word} ${hard ? 'the hard way' : 'easy'} — Winner, Pay the Line!`;
    return `${word} — Winner, Pay the Line!`;
  }
  if ([4, 6, 8, 10].includes(t)) return hard ? `${word}, the hard way` : `Easy ${word.toLowerCase()}`;
  return t === 9 ? 'Nine, Center Field' : t === 5 ? 'Five, No Field Five' : word;
}

const freshStats = (bank) => ({ rolls: 0, startBankroll: bank, biggestWin: 0, pointsMade: 0, sevenOuts: 0, totalWon: 0, totalLost: 0, naturals: 0, craps: 0, longestRoll: 0, currentRoll: 0 });

export class CrapsGame {
  constructor(opts = {}) {
    this.settings = sanitizeSettings(opts.settings);
    this.bankroll = opts.bankroll ?? 1000;
    this._listeners = {};
    this._clearState();
  }

  _clearState() {
    this.bets = {};
    this.point = null;
    this.history = [];
    this.working = {};          // per-bet ON/OFF overrides: id -> true|false (scoped: see isWorking)
    this.puts = {};             // Put money: id -> dollars of that flat bet made (or added) after the point (Put-odds policy)
    this.vigPaid = {};          // layVig 'upfront': lay id -> commission already paid for the current decision
    this.firePoints = [];       // unique points made by the current shooter (Fire Bet)
    this.atsHits = [];          // totals rolled since the last 7 (All/Tall/Small)
    this.stats = freshStats(this.bankroll);
  }

  /**
   * Start a fresh session at the same table: every bet, the point, ON/OFF overrides, Fire/ATS tracking,
   * history and stats are cleared. Settings and event listeners are kept. Bets are NOT refunded.
   */
  reset(bankroll = 1000) {
    this.bankroll = Number.isFinite(bankroll) && bankroll >= 0 ? Math.floor(bankroll) : 1000;
    this._clearState();
    this._emit('reset', { bankroll: this.bankroll });
    return this;
  }

  // ---------- events ----------
  /** Subscribe to engine events. Returns an unsubscribe function. '*' receives (type, payload). */
  on(type, fn) {
    (this._listeners[type] ||= []).push(fn);
    return () => { const a = this._listeners[type]; const i = a ? a.indexOf(fn) : -1; if (i >= 0) a.splice(i, 1); };
  }
  _emit(type, payload) {
    for (const fn of (this._listeners[type] || []).slice()) { try { fn(payload); } catch (e) { setTimeout(() => { throw e; }); } }
    for (const fn of (this._listeners['*'] || []).slice()) { try { fn(type, payload); } catch (e) { setTimeout(() => { throw e; }); } }
  }

  // ---------- state ----------
  get isComeOut() { return this.point == null; }
  /** Puck state for the visual layer. */
  get puck() { return { on: this.point != null, point: this.point }; }
  amount(id) { return this.bets[id] || 0; }
  totalOnTable() { return Object.values(this.bets).reduce((a, b) => a + b, 0); }
  /** Commission paid up front (layVig / buyVig 'upfront') for bets still up — refundable on take-down. */
  prepaidVig() { return Object.values(this.vigPaid).reduce((a, b) => a + b, 0); }
  /** Bankroll plus everything on the felt (including refundable up-front commission). */
  totalValue() { return this.bankroll + this.totalOnTable() + this.prepaidVig(); }

  /**
   * Change table settings between rolls. The patch is merged and run through sanitizeSettings (so no
   * caller can set an invalid rule). Up-front commission that the new rules no longer prepay (layVig /
   * buyVig switched to 'win') is refunded to the bankroll. Emits 'settings'. Returns { settings, refunds }.
   */
  setSettings(patch) {
    const next = sanitizeSettings({ ...this.settings, ...(patch && typeof patch === 'object' ? patch : {}) });
    this.settings = next;
    // 1) new limits apply at once: every bet over its new maximum is cut to the largest clean amount allowed
    //    and the rest is refunded (the same rule restore() uses), so the live table, a saved table and
    //    rollOutcomes() always agree. Emits 'limits' { trimmed: [{ id, from, to, refund }] } for the visuals.
    const trimmed = this._enforceLimits();
    // 2) up-front commission the new rules no longer need (timing switched to 'win', or a smaller bet) is refunded
    const refunds = [];
    for (const [id, v] of Object.entries(this.vigPaid)) {
      const keep = this.bets[id] && this.vigUpfront(id) ? Math.min(v, this.commissionFor(id)) : 0;
      if (keep < v) { this.bankroll += v - keep; refunds.push({ id, vig: v - keep }); if (keep) this.vigPaid[id] = keep; else delete this.vigPaid[id]; }
    }
    // 3) switching to 'upfront' with a buy / lay up: this decision's commission is collected now (no free
    //    decision). If the rack cannot cover it, the dealer takes it from the win instead (see resolveRoll).
    const charges = [];
    for (const id of Object.keys(this.bets)) {
      if (!this.vigUpfront(id)) continue;
      const due = this.commissionFor(id) - (this.vigPaid[id] || 0);
      if (due > 0 && due <= this.bankroll) { this.bankroll -= due; this.vigPaid[id] = (this.vigPaid[id] || 0) + due; charges.push({ id, vig: due }); }
    }
    this._emit('settings', { settings: next, refunds, charges, trimmed, bankroll: this.bankroll });
    if (trimmed.length) this._emit('limits', { trimmed, bankroll: this.bankroll });
    return { settings: next, refunds, charges, trimmed };
  }
  /**
   * Largest clean total a bet may hold under the current limits: odds at the odds limit; boxes and unit
   * bets in their payable unit (Place 6 on a $5,000 table: $4,998; Lay 5: $7,500; Horn at propMax 7: $4).
   */
  _capFor(id) {
    if (/Odds/.test(id)) return this.maxFor(id) || 0;
    const mx = this.maxFor(id) ?? this.settings.tableMax;
    const u = this.isUnitBet(id) || this.isBoxBet(id) ? this.unitFor(id) : 1;
    return Math.floor(mx / u) * u;
  }
  /** The most a player can actually book on a bet now (the maximum floored to the bet's unit). */
  maxBookable(id) { return this._capFor(id); }
  /** Cut every bet over its limit (flats first, then odds) and refund the excess. Returns [{ id, from, to, refund }]. */
  _enforceLimits() {
    const trimmed = [];
    const ids = Object.keys(this.bets).sort((x, y) => /Odds/.test(x) - /Odds/.test(y));
    for (const id of ids) {
      const amt = this.bets[id]; if (!amt) continue;
      const cap = this._capFor(id);
      if (amt <= cap) continue;
      const to = cap >= (/Odds/.test(id) ? 1 : this.minFor(id)) ? cap : 0;
      this.bankroll += amt - to;
      if (to) { this.bets[id] = to; if (this.puts[id] > to) this.puts[id] = to; }
      else { delete this.bets[id]; delete this.working[id]; delete this.puts[id]; }
      trimmed.push({ id, from: amt, to, refund: amt - to });
    }
    return trimmed;
  }
  oddsMultiple(n) { return this.settings.odds === '345' ? ODDS_345[n] : Number(this.settings.odds); }
  /**
   * Max take-odds for flat amount on number n. Casino allowance: when multiple x flat is not a payable
   * amount, the limit rounds UP to the next payable unit ($2 on 5/9, $5 on 6/8), e.g. $15 flat at 1x may
   * take $16 on a 5, and $7 flat at 1x may take $10 on a 6. A limit that is already clean is not raised:
   * $25 flat at 1x takes exactly $25 on 6/8 (this engine does not give the "$30 behind $25" allowance).
   */
  maxTakeOdds(flat, n, mult = this.oddsMultiple(n)) { const u = TRUE_ODDS[n][1]; return Math.ceil((flat * mult) / u - 1e-9) * u; }
  /** Dollars of a flat bet that are Put money (made or added after the point). */
  putAmount(fid) { return Math.min(this.amount(fid), Math.max(0, Math.floor(this.puts[fid] || 0))); }
  /**
   * Take-odds limit behind a flat bet. Under putOdds 'flat' only the Put portion is capped at 1x; the contract
   * money from the come-out keeps the full multiple, e.g. $10 on the 6 plus a $5 Put at 3-4-5x: 5x$10 + 1x$5 = $55.
   */
  _takeOddsMax(fid, n) {
    const flat = this.amount(fid), put = this.settings.putOdds === 'flat' ? this.putAmount(fid) : 0;
    if (!put) return this.maxTakeOdds(flat, n);
    const u = TRUE_ODDS[n][1];
    return Math.ceil(((flat - put) * this.oddsMultiple(n) + put) / u - 1e-9) * u;
  }
  /**
   * Max lay odds behind a Don't bet of `flat` on n: lay so that the win equals (multiple x flat), with the
   * same allowance as maxTakeOdds — the allowed win rounds up to a payable unit ($1 on 4/10, $2 on 5/9,
   * $5 on 6/8). 3-4-5x => 6x lay on every number ($10 don't pass vs 6 lays $60 to win $50).
   */
  maxLayOdds(flat, n) { const [a, b] = TRUE_ODDS[n]; const w = Math.ceil((flat * this.oddsMultiple(n)) / b - 1e-9) * b; return (w * a) / b; }
  /** Settings-aware bet info (use this for tooltips). */
  betInfo(id) { return betInfo(id, this.settings, this); }

  /**
   * Is this bet currently working (would it be resolved by a roll)?
   * Defaults: place/buy/hardways/come-odds OFF on the come-out; everything else always working.
   * A per-bet override set with setWorking() wins over the default. Overrides are scoped (see resolveRoll):
   * one made on the come-out lasts that roll; one made during a point lasts until the puck moves.
   */
  isWorking(id) {
    const { kind } = parseBetId(id);
    if ((this.working[id] === true || this.working[id] === false) && TOGGLEABLE.has(kind)) return this.working[id];
    if (!this.isComeOut) return true;
    const S = this.settings;
    if (kind === 'place' || kind === 'buy') return !!S.placeWorkingOnComeOut;
    if (/^hard/.test(kind)) return !!S.hardwaysWorkingOnComeOut;
    if (kind === 'comeOdds') return !!S.comeOddsWorkingOnComeOut;
    return true;
  }
  /** Can this bet be switched ON/OFF by the player? (place, buy, lay, come/don't-come odds, hardways, big 6/8) */
  canToggleWorking(id) { return isValidBetId(id) && TOGGLEABLE.has(parseBetId(id).kind); }
  /** Turn a bet ON (true), OFF (false), or back to the default (null). Returns the resulting working state. */
  setWorking(id, on) {
    if (!this.canToggleWorking(id)) return this.isWorking(id);
    if (on === null || on === undefined) delete this.working[id]; else this.working[id] = !!on;
    this._emit('working', { id, working: this.isWorking(id) });
    return this.isWorking(id);
  }
  /** Flip a bet that is on the table between ON and OFF. Returns { ok, working, reason }. */
  toggleWorking(id) {
    if (!this.bets[id]) return { ok: false, reason: 'No bet there' };
    if (!this.canToggleWorking(id)) return { ok: false, reason: `${this.betInfo(id).name} is always working` };
    return { ok: true, working: this.setWorking(id, !this.isWorking(id)) };
  }
  /** Ids of bets on the table that are currently OFF (for OFF lammers). */
  offBets() { return Object.keys(this.bets).filter((id) => !this.isWorking(id)); }

  /** Maximum total allowed for a bet id right now (null if no special cap). */
  maxFor(id) {
    const { kind, n } = parseBetId(id);
    if (id === 'passOdds') return this.point && this.bets.pass ? this._takeOddsMax('pass', this.point) : 0;
    if (id === 'dontPassOdds') return this.point && this.bets.dontPass ? this.maxLayOdds(this.bets.dontPass, this.point) : 0;
    if (kind === 'comeOdds') return this.bets['come' + n] ? this._takeOddsMax('come' + n, n) : 0;
    if (kind === 'dontComeOdds') return this.bets['dontCome' + n] ? this.maxLayOdds(this.bets['dontCome' + n], n) : 0;
    const S = this.settings;
    // a Lay is limited by its WIN: the table maximum is the most a lay may win ($5,000 max: Lay 4 $10,000,
    // Lay 5 $7,500, Lay 6 $6,000), the way a casino books lays against the limit
    if (kind === 'lay') { const [a, b] = LAY_ODDS[n]; return Math.floor(S.tableMax / a) * b; }
    if (S.propMax && (isOneRoll(id) && id !== 'field' || /^hard/.test(kind))) return S.propMax;
    if (S.bonusMax && (id === 'fire' || ATS[id])) return S.bonusMax;
    return S.tableMax;
  }
  /** The table maximum for this bet, as a dealer would say it (lays: the most a lay may win). */
  limitLabel(id) {
    const { kind } = parseBetId(id);
    if (/Odds/.test(id)) { const m = this.maxFor(id); return m ? `max odds $${m}` : 'no odds yet'; }
    const min = this.minFor(id), max = this._capFor(id);
    if (kind === 'lay') { const L = LAY_ODDS[parseBetId(id).n]; return `$${min} – $${max} (wins $${payout(min, L)} – $${payout(max, L)})`; }
    return `$${min} – $${max}`;
  }

  minFor(id) {
    const { kind } = parseBetId(id);
    const pm = this.settings.propMin;
    if (['passOdds', 'dontPassOdds'].includes(id) || kind === 'comeOdds' || kind === 'dontComeOdds') return 1;
    if (id === 'horn') return 4 * pm;
    if (id === 'ce') return 2 * pm;
    if (id === 'world' || kind === 'hornHigh') return 5 * pm;
    if (PROP_PAYS[id] || /^hard/.test(id) || kind === 'hop' || id === 'fire' || ATS[id]) return pm;
    if (kind === 'buy') return Math.max(this.settings.tableMin, this.settings.buyMin || 0);
    if (kind === 'lay') { const [a, b] = LAY_ODDS[parseBetId(id).n]; return Math.ceil(this.layMinWin() / a - 1e-9) * b; }
    return this.settings.tableMin;
  }
  /**
   * Lays are sized by the WIN: the smallest lay must win at least this much (settings.layMin, or the table
   * minimum). $5 table: Lay 4/10 $10, Lay 5/9 $9, Lay 6/8 $6. layMin 20: $40 / $30 / $24 (the $1 vig is 5%).
   */
  layMinWin() { return Math.max(this.settings.tableMin, this.settings.layMin || 0); }

  /** Bet unit that pays without breakage (1 = any amount). */
  unitFor(id) {
    const { kind, n } = parseBetId(id);
    const P = this.point;
    if (kind === 'place') return PLACE_PAYS[n][1];
    if (kind === 'buy' || kind === 'comeOdds') return TRUE_ODDS[n][1];
    if (kind === 'lay' || kind === 'dontComeOdds') return TRUE_ODDS[n][0];
    if (id === 'passOdds') return P ? TRUE_ODDS[P][1] : 1;
    if (id === 'dontPassOdds') return P ? TRUE_ODDS[P][0] : 1;
    if (id === 'horn') return 4;
    if (id === 'ce') return 2;
    if (id === 'world' || kind === 'hornHigh') return 5;
    return 1;
  }

  /**
   * Round an amount down to a value that pays without breakage for that bet
   * (e.g. place 6/8 in $6 units, odds on 5/9 in $2 units, odds on 6/8 in $5 units).
   * Returns the original amount if no clean value >= min exists.
   */
  payableAmount(id, amount) {
    const unit = this.unitFor(id);
    const r = Math.floor(amount / unit) * unit;
    return r >= this.minFor(id) ? r : amount;
  }

  /** Bets accepted only in fixed units (the chip is rounded down to the unit). */
  isUnitBet(id) { const { kind } = parseBetId(id); return id === 'horn' || id === 'ce' || id === 'world' || kind === 'hornHigh'; }

  /**
   * Turn a chip click into a stake, like a dealer would. `pending` is money already pushed toward this bet
   * that has not yet reached a bettable amount. Returns
   *   { add, pending, change, short }
   * add     — dollars to actually place now (0 if still below the minimum / unit),
   * pending — dollars that stay pending toward the bet (below the minimum, or less than one unit),
   * change  — dollars handed back (e.g. a $5 chip on C & E books $4, $1 change),
   * short   — how much more is needed to reach the minimum (0 when booked).
   * Small chips accumulate: five $1 chips on a $5-minimum Pass Line, or $1 chips on C & E ($2) / Horn ($4).
   */
  /**
   * Place / Buy / Lay boxes are booked with the same dealer policy as odds (take AND lay), see _book: in
   * units that pay without breakage (place 6/8 in $6, place 5/9 in $5, buy 5/9 in $2, buy 6/8 in $5,
   * lay 4/10 in $2, lay 5/9 in $3, lay 6/8 in $6):
   *   - a clean total books as is;
   *   - otherwise it books to the NEAREST clean amount, ties DOWN, and up only when that costs at most
   *     settings.roundUpMax ($2): $25 on Place 8 -> $24 + $1 change, $25 on Lay 6 -> $24, $25 on Buy 5 -> $24,
   *     $10 on Place 6 -> $12 (+$2, nearer than $6);
   *   - the minimum case: when nothing clean >= the minimum is below, it goes up ($5 on Place 6 -> $6) if the rack covers it, else as is
   *     (rounded 'raw'). A chip below a lay minimum (sized by the win: $7 on Lay 5, $9 min) stays pending;
   *   - chips smaller than both the unit and the minimum ($1 / $2 chips) stay pending until the total is clean.
   * `held` = money the player already has pending on OTHER bets (it is not available for this one).
   * Extra fields: { extra, rounded: null|'up'|'down'|'capped'|'raw', broke } — broke: the rack cannot cover it.
   */
  isBoxBet(id) { const { kind } = parseBetId(id); return kind === 'place' || kind === 'buy' || kind === 'lay'; }
  /**
   * The one dealer rounding policy for unit bets (boxes, take odds, lay odds). For a non-clean `total`
   * (already > cur) returns { target, rounded: 'up'|'down'|'raw' }. `capClean` = highest clean total allowed.
   */
  _book(total, cur, u, min, capClean) {
    const up = Math.ceil(total / u) * u, down = Math.floor(total / u) * u;
    const upOk = up <= capClean, downOk = down > cur && down >= min;
    const lim = Math.max(0, this.settings.roundUpMax ?? 2);
    if (upOk && (!downOk || (up - total < total - down && up - total <= lim))) return { target: up, rounded: 'up' };
    if (downOk) return { target: down, rounded: 'down' };
    return { target: total, rounded: 'raw' };
  }
  chipStake(id, chip, pending = 0, held = 0) {
    chip = Math.max(0, Math.floor(chip)); pending = Math.max(0, Math.floor(pending));
    const avail = Math.max(0, this.bankroll - Math.max(0, Math.floor(held) || 0));
    const cur = this.amount(id), total = cur + pending + chip, min = this.minFor(id);
    const R = (add, o = {}) => { const r = { add, pending: 0, change: 0, extra: 0, short: 0, rounded: null, broke: false, ...o }; r.vig = r.add > 0 ? this.upfrontVig(id, r.add) : 0; r.broke = r.add + r.pending + r.vig > avail; return r; };
    if (total < min) return R(0, { pending: pending + chip, short: min - total });
    if (this.isBoxBet(id)) {
      const u = this.unitFor(id), max = this.maxFor(id) ?? Infinity;
      const capClean = Math.floor(Math.min(max, cur + avail) / u) * u;
      if (total > max) return capClean > cur ? R(capClean - cur, { change: total - capClean, rounded: 'capped' }) : R(total - cur);
      if (total % u === 0) return R(total - cur);
      const up = Math.ceil(total / u) * u, down = Math.floor(total / u) * u;
      if (chip < u && chip < min) {
        // small chips accumulate toward the next clean amount
        return down > cur && down >= min ? R(down - cur, { pending: total - down, short: up - total }) : R(0, { pending: total - cur, short: up - total });
      }
      const k = this._book(total, cur, u, min, capClean);
      if (k.rounded === 'up') return R(k.target - cur, { extra: k.target - total, rounded: 'up' });
      if (k.rounded === 'down') return R(k.target - cur, { change: total - k.target, rounded: 'down' });
      return R(total - cur, { rounded: 'raw' });
    }
    const unit = this.isUnitBet(id) ? this.unitFor(id) : 1;
    // over the maximum: a dealer books up to the largest clean amount allowed and hands back the rest
    const max = this.maxFor(id) ?? this.settings.tableMax, capClean = Math.floor(max / unit) * unit;
    if (total > max || Math.floor(total / unit) * unit > capClean) {
      return capClean > cur ? R(capClean - cur, { change: total - capClean, rounded: 'capped' }) : R(0, { change: pending + chip, rounded: 'capped' });
    }
    const target = Math.floor(total / unit) * unit;
    const add = Math.max(0, target - cur), left = total - cur - add;
    if (chip < unit) return R(add, { pending: left });
    return R(add, { change: left });
  }

  /** Highest total an odds bet can reach now: the odds limit, or what the bankroll (less `held`) covers if less. */
  _oddsCap(id, held = 0) { return Math.max(0, Math.min(this.maxFor(id) || 0, this.amount(id) + Math.max(0, this.bankroll - Math.max(0, held || 0)))); }

  /**
   * Dealer-style booking of a chip on an odds bet, so the odds always pay without breakage
   * ($2 units on 5/9, $5 on 6/8 for take odds; $2 / $3 / $6 units for lay odds on 4-10 / 5-9 / 6-8).
   *   - a clean total is booked as is;
   *   - otherwise the box policy applies (_book): the NEAREST clean amount, ties DOWN, up only by
   *     <= settings.roundUpMax and within the odds limit / bankroll. $25 behind a 5 books $24 + $1 change,
   *     a $25 lay against the 6 books $24 + $1 change (not $30), $10 laid against the 6 books $12 (+$2);
   *   - a chip smaller than one unit stays pending until the total is clean ($1 chips behind a 6 book at $5);
   *   - over the limit, the total is cut to the largest clean amount allowed (`rounded` = 'capped').
   * Returns { add, pending, change, extra, short, rounded: null|'up'|'down'|'capped', full }.
   * `full` is true when nothing more can be added (at the odds limit / out of bankroll / no flat bet).
   */
  oddsStake(id, chip, pending = 0, held = 0) {
    chip = Math.max(0, Math.floor(chip)); pending = Math.max(0, Math.floor(pending));
    const avail = Math.max(0, this.bankroll - Math.max(0, Math.floor(held) || 0));
    const cur = this.amount(id), u = this.unitFor(id), cap = this._oddsCap(id, held);
    const capClean = Math.floor(cap / u) * u, total = cur + pending + chip;
    const R = (add, o = {}) => { const r = { add, pending: 0, change: 0, extra: 0, short: 0, rounded: null, full: false, broke: false, ...o }; r.broke = r.add + r.pending > avail; return r; };
    if (capClean <= cur) return R(0, { change: pending + chip, full: true });
    if (total > capClean) return R(capClean - cur, { change: total - capClean, rounded: total > (this.maxFor(id) || 0) ? 'capped' : 'down' });
    if (total % u === 0) return R(total - cur);
    const up = Math.ceil(total / u) * u, down = Math.floor(total / u) * u;
    if (chip < u) return down > cur ? R(down - cur, { pending: total - down, short: up - total }) : R(0, { pending: total - cur, short: up - total });
    // same dealer policy as the boxes (_book): nearest clean amount, ties down, up by at most roundUpMax
    const k = this._book(total, cur, u, 1, capClean);
    if (k.rounded === 'up') return R(k.target - cur, { extra: k.target - total, rounded: 'up' });
    if (k.rounded === 'down') return R(k.target - cur, { change: total - k.target, rounded: 'down' });
    return R(0, { change: pending + chip, full: true });
  }

  /** Dollars to add for maximum odds on `id`, in clean units and within the bankroll (0 if none). */
  maxOddsAdd(id, held = 0) {
    const cur = this.amount(id), u = this.unitFor(id);
    return Math.max(0, Math.floor(this._oddsCap(id, held) / u) * u - cur);
  }

  /**
   * Plan a "Rebet" of a snapshot { id: amount } (the bets that were up before the last roll), the way a
   * dealer would put them back: flats first, then odds; every odds / place / buy / lay amount is re-booked
   * in payable units FOR THE CURRENT POINT (e.g. $16 of odds that sat behind a 5 goes behind a new 6 as
   * $15), capped at the odds limit and what the rack covers (less `held`). Line bets are never rebet as
   * Put bets: Pass / Don't Pass are skipped while the point is on (missing OR below the snapshot), and a Come / Don't Come bet on a
   * number is never re-booked or topped up (it can only get there by traveling); odds whose flat is gone are skipped.
   * Returns { plan: [[id, add, note]], skipped: [{ id, reason }], rounded: [{ id, from, to }] } — nothing is placed.
   */
  rebetPlan(snapshot, held = 0) {
    const flatFor = (id) => {
      const { kind, n } = parseBetId(id);
      if (id === 'passOdds') return 'pass'; if (id === 'dontPassOdds') return 'dontPass';
      if (kind === 'comeOdds') return 'come' + n; if (kind === 'dontComeOdds') return 'dontCome' + n;
      return null;
    };
    const plan = [], skipped = [], rounded = [];
    if (!snapshot || typeof snapshot !== 'object') return { plan, skipped, rounded };
    const g = this._silentClone();
    g.bankroll = Math.max(0, g.bankroll - Math.max(0, held || 0));
    const isOdds = (id) => /Odds/.test(id);
    const entries = Object.entries(snapshot).filter(([id, a]) => isValidBetId(id) && Number.isInteger(a) && a > 0);
    entries.sort((x, y) => isOdds(x[0]) - isOdds(y[0]));
    for (const [id, amt] of entries) {
      const cur = g.amount(id);
      if (cur >= amt) continue;
      // while the point is on, any new Pass money (a missing bet or a top-up of one that is up) is a Put, and
      // Don't Pass is closed: never rebet either one, so no Put is ever made without the player confirming it.
      if (g.point && (id === 'pass' || id === 'dontPass')) { skipped.push({ id, reason: cur ? 'point is on; a top-up would be a Put' : 'point is on' }); continue; }
      // come / don't come bets on numbers got there by traveling; re-booking one would be a Put (or a
      // raise on a contract bet). Only money already on that number is kept — nothing is added to it.
      { const { kind, n } = parseBetId(id); if (n != null && (kind === 'come' || kind === 'dontCome')) { skipped.push({ id, reason: 'come bets travel; would be a Put' }); continue; } }
      { const fid = flatFor(id); if (fid && !g.amount(fid)) { skipped.push({ id, reason: 'no flat bet to back' }); continue; } }
      let target = amt;
      if (isOdds(id) || g.isBoxBet(id)) {
        // the SAME dealer policy as a chip on that bet (chipStake / oddsStake): _book picks the nearest
        // payable amount, ties down, up by at most roundUpMax, up for the minimum case; over the odds limit
        // or what the rack covers, the largest clean amount allowed
        const u = g.unitFor(id), min = isOdds(id) ? 1 : g.minFor(id);
        const lim = isOdds(id) ? g._oddsCap(id) : Math.min(g.maxFor(id) ?? Infinity, cur + g.bankroll - g.upfrontVig(id, Math.max(0, amt - cur)));
        const capClean = Math.floor(lim / u) * u;
        if (amt > lim) target = capClean;
        else if (amt % u) {
          const k = g._book(amt, cur, u, min, capClean);
          // a box that cannot be made clean books as is (like a chip, rounded 'raw'); odds never take breakage
          target = k.rounded === 'raw' ? (isOdds(id) ? cur : amt) : k.target;
        }
        if (target !== amt && target > cur) rounded.push({ id, from: amt, to: target });
      }
      const add = target - cur;
      if (add <= 0) { skipped.push({ id, reason: isOdds(id) ? 'no odds room' : 'no room' }); continue; }
      const r = g.placeBet(id, add);
      if (r.ok) plan.push([id, add, target !== amt ? `rebooked ${amt} -> ${target}` : '']);
      else skipped.push({ id, reason: r.reason });
    }
    return { plan, skipped, rounded };
  }

  /** Profit a bet of `amount` would earn if it won on its winning number (for the current point; best case for props). */
  winFor(id, amount = this.amount(id)) {
    const { kind, n } = parseBetId(id);
    const P = this.point, rate = this.settings.vigRate;
    switch (kind) {
      case 'place': return payout(amount, PLACE_PAYS[n]);
      case 'buy': return Math.max(0, payout(amount, TRUE_ODDS[n]) - vig(amount, rate, this.settings.vigRounding));
      case 'lay': { const w = payout(amount, LAY_ODDS[n]); return Math.max(0, w - vig(w, rate, this.settings.vigRounding)); }
      case 'comeOdds': return payout(amount, TRUE_ODDS[n]);
      case 'dontComeOdds': return payout(amount, LAY_ODDS[n]);
      case 'passOdds': return P ? payout(amount, TRUE_ODDS[P]) : 0;
      case 'dontPassOdds': return P ? payout(amount, LAY_ODDS[P]) : 0;
      case 'hard4': case 'hard6': case 'hard8': case 'hard10': return payout(amount, HARD_PAYS[n]);
      case 'horn': return payout(amount, [27, 4]);   // best case (2 or 12)
      case 'ce': return payout(amount, [7, 1]);      // best case (11)
      case 'world': return payout(amount, [26, 5]);  // best case (2 or 12)
      case 'hornHigh': return payout(amount, n === 2 || n === 12 ? [57, 5] : [27, 5]);
      case 'hop': return payout(amount, parseBetId(id).hard ? HOP_PAYS.hard : HOP_PAYS.easy);
      case 'fire': return amount * FIRE_PAYS[4];     // minimum winning case
      case 'small': case 'tall': case 'all': return amount * ATS[kind].pays;
      case 'field': return amount * Math.max(this.settings.fieldTwoPays, this.settings.fieldTwelvePays);
      default: return PROP_PAYS[id] ? payout(amount, PROP_PAYS[id]) : amount;
    }
  }

  /** How much to add to a bet to press it with `win` without creating breakage. Never negative. */
  pressAmount(id, win) {
    const cur = this.amount(id);
    if (!cur || !(win > 0)) return 0;
    const target = this.payableAmount(id, cur + win);
    return Math.max(0, target - cur);
  }

  /**
   * Preview adding `add` to a bet: what it would win, and a breakage warning if the total is not
   * in clean units. { id, name, pays, total, win, clean, suggest, warn, working, validation }
   */
  preview(id, add = 0) {
    const info = this.betInfo(id);
    const total = this.amount(id) + Math.max(0, add | 0);
    const win = this.winFor(id, total);
    const unit = this.unitFor(id);
    const clean = total % unit === 0;
    const suggest = clean ? total : Math.ceil(total / unit) * unit;
    let warn = '';
    if (total > 0 && !clean) {
      const fair = this.winFor(id, suggest);
      warn = `$${total} on ${info.name} pays only $${win} — bet $${suggest} to win $${fair}`;
    }
    const { kind } = parseBetId(id);
    if (!warn && total > 0 && (kind === 'buy' || kind === 'lay')) {
      const base = kind === 'buy' ? total : payout(total, LAY_ODDS[parseBetId(id).n]);
      const v = vig(base, this.settings.vigRate, this.settings.vigRounding);
      if (v / base > this.settings.vigRate + 1e-9) warn = `Vig is $${v} on a $${base} ${kind === 'buy' ? 'bet' : 'win'} — ${pct(v / base)}, not ${pct(this.settings.vigRate)}`;
    }
    return { id, name: info.name, pays: info.pays, total, win, clean, suggest, warn, working: this.isWorking(id), validation: add > 0 ? this.validate(id, add) : { ok: true } };
  }

  /** Commission for a lay of `total` (5% of the win, settings rounding, $1 min). */
  layVigFor(id, total = this.amount(id)) {
    const { kind, n } = parseBetId(id);
    return kind === 'lay' && total > 0 ? vig(payout(total, LAY_ODDS[n]), this.settings.vigRate, this.settings.vigRounding) : 0;
  }
  /** Commission for a buy (5% of the bet) or a lay (5% of the win) of `total`; 0 for every other bet. */
  commissionFor(id, total = this.amount(id)) {
    const { kind } = parseBetId(id);
    if (kind === 'lay') return this.layVigFor(id, total);
    return kind === 'buy' && total > 0 ? vig(total, this.settings.vigRate, this.settings.vigRounding) : 0;
  }
  /** Is this bet's commission collected when it is booked (layVig / buyVig 'upfront')? */
  vigUpfront(id) {
    const { kind } = parseBetId(id);
    return (kind === 'lay' && this.settings.layVig === 'upfront') || (kind === 'buy' && this.settings.buyVig === 'upfront');
  }
  /** Up-front commission due now to add `add` to a buy / lay (0 for every other bet, or a 'win' timing). */
  upfrontVig(id, add) {
    if (!this.vigUpfront(id)) return 0;
    return Math.max(0, this.commissionFor(id, this.amount(id) + add) - (this.vigPaid[id] || 0));
  }

  validate(id, add) {
    const no = (reason) => ({ ok: false, reason });
    if (!isValidBetId(id)) return no('Unknown bet');
    if (!Number.isFinite(add) || add <= 0 || Math.floor(add) !== add) return no('Invalid bet amount');
    if (add > this.bankroll) return no('Insufficient bankroll');
    const uv = this.upfrontVig(id, add);
    if (uv && add + uv > this.bankroll) return no(`Insufficient bankroll — the ${parseBetId(id).kind} needs $${add} plus $${uv} commission up front`);
    return this._rules(id, this.amount(id) + add, false);
  }

  /** Bet rules for a total amount. restoring=true skips "only at this moment" timing rules. */
  _rules(id, total, restoring) {
    const no = (reason) => ({ ok: false, reason });
    const { kind, n } = parseBetId(id);
    const P = this.point, S = this.settings, b = this.bets;
    switch (kind) {
      case 'pass': if (P && !S.putBets && !restoring) return no('Pass Line is a contract bet — only accepted on the come-out roll'); break;
      case 'dontPass': if (P && !restoring) return no("Don't Pass bets are only accepted on the come-out roll"); break;
      case 'passOdds': if (!P) return no('Odds are available once a point is established'); if (!b.pass) return no('Make a Pass Line bet first'); break;
      case 'dontPassOdds': if (!P) return no('Lay odds are available once a point is established'); if (!b.dontPass) return no("Make a Don't Pass bet first"); break;
      case 'come':
        if (n != null) { if (!restoring && !(S.putBets && P)) return no('Come bets travel to the numbers automatically'); break; }
        if (!P) return no('Come bets open once a point is established — use the Pass Line');
        break;
      case 'dontCome':
        if (n != null) { if (!restoring) return no("Don't Come bets travel to the numbers automatically"); break; }
        if (!P) return no("Don't Come bets open once a point is established — use the Don't Pass");
        break;
      case 'comeOdds': if (!b['come' + n]) return no(`No Come bet on ${n} to back with odds`); break;
      case 'dontComeOdds': if (!b['dontCome' + n]) return no(`No Don't Come bet on ${n} to lay odds on`); break;
      case 'place': if (b['buy' + n]) return no(`You already have a Buy bet on ${n} — take it down to place it`); break;
      case 'buy': if (b['place' + n]) return no(`You already have a Place bet on ${n} — take it down to buy it`); break;
      case 'fire': if (!restoring && this.stats.currentRoll > 0) return no('The Fire Bet is only accepted before a new shooter\'s first roll'); break;
      case 'small': case 'tall': case 'all': if (!restoring && this.atsHits.length) return no(`${NAMES[kind]} is only accepted right after a 7, before any number rolls`); break;
      default: break;
    }
    const min = this.minFor(id), max = this.maxFor(id);
    if (total < min) return no(`Minimum for ${this.betInfo(id).name} is $${min}${kind === 'lay' ? ` (a lay must win at least $${this.layMinWin()})` : ''}`);
    if (id === 'horn' && total % 4) return no('Horn bets are in $4 units');
    if (id === 'ce' && total % 2) return no('C & E bets are in $2 units');
    if ((id === 'world' || kind === 'hornHigh') && total % 5) return no(`${this.betInfo(id).name} bets are in $5 units`);
    const isOdds = /Odds/.test(id);
    if (max != null && total > max) {
      if (isOdds) return no(`Maximum odds here is $${max}`);
      if (kind === 'lay') return no(`Table maximum on ${this.betInfo(id).name} is $${max} (a $${S.tableMax} win)`);
      return no(max < S.tableMax ? `Maximum on ${this.betInfo(id).name} is $${max}` : `Table maximum is $${max}`);
    }
    // placeBet() is not a raw path for odds: unless the table allows it (oddsUnits: false), odds must pay
    // without breakage, so no caller (strategy, restore of a fresh bet, API) can book $7 behind a 5.
    if (isOdds && S.oddsUnits && !restoring) {
      const u = this.unitFor(id);
      if (total % u) return no(`Odds on ${kind === 'passOdds' || kind === 'dontPassOdds' ? P : n} are booked in $${u} units — $${Math.floor(total / u) * u} or $${Math.ceil(total / u) * u}`);
    }
    return { ok: true };
  }

  placeBet(id, add) {
    const v = this.validate(id, add);
    if (!v.ok) { this._emit('reject', { id, amount: add, reason: v.reason }); return v; }
    const uv = this.upfrontVig(id, add);
    this.bankroll -= add + uv;
    if (uv) this.vigPaid[id] = (this.vigPaid[id] || 0) + uv;
    // remember Put bets (flat money on the Pass Line or straight on a come number while the point is on)
    const { kind: k, n: kn } = parseBetId(id);
    // (only the added dollars are Put money; contract money from the come-out keeps its status)
    if (this.point && (id === 'pass' || (k === 'come' && kn != null))) this.puts[id] = (this.puts[id] || 0) + add;
    this.bets[id] = this.amount(id) + add;
    this._emit('bet', { id, amount: add, total: this.bets[id], bankroll: this.bankroll, vig: uv });
    return { ok: true, amount: this.bets[id], vig: uv };
  }

  canRemove(id) {
    if (!this.bets[id]) return { ok: false, reason: 'No bet there' };
    const { kind, n } = parseBetId(id);
    if (kind === 'pass' && this.point) return { ok: false, reason: 'Pass Line is a contract bet once the point is set' };
    if (kind === 'come' && n != null) return { ok: false, reason: `Come bet on ${n} is a contract bet` };
    if (kind === 'fire' && this.stats.currentRoll > 0) return { ok: false, reason: 'The Fire Bet stays up until the shooter sevens out' };
    if (ATS[kind] && this.atsHits.length) return { ok: false, reason: `${NAMES[kind]} stays up until a 7 once numbers have rolled` };
    return { ok: true };
  }

  /**
   * Removes a bet (and any odds riding on it), returning the refunded amount(s): [{id, amount, vig}].
   * A lay commission paid up front (layVig 'upfront') is refunded with the lay (`vig`).
   */
  removeBet(id) {
    const c = this.canRemove(id);
    if (!c.ok) return { ok: false, reason: c.reason, removed: [] };
    const removed = [];
    const take = (bid) => {
      if (!this.bets[bid]) return;
      const v = this.vigPaid[bid] || 0;
      removed.push({ id: bid, amount: this.bets[bid], vig: v }); this.bankroll += this.bets[bid] + v;
      delete this.bets[bid]; delete this.working[bid]; delete this.puts[bid]; delete this.vigPaid[bid];
    };
    take(id);
    const { kind, n } = parseBetId(id);
    if (id === 'pass') take('passOdds');
    if (id === 'dontPass') take('dontPassOdds');
    if (kind === 'dontCome' && n != null) take('dontComeOdds' + n);
    this._emit('remove', { id, removed, bankroll: this.bankroll });
    return { ok: true, removed };
  }

  /** Resolve a roll. Returns a full result with ordered events for the visual layer. */
  resolveRoll(d1, d2) {
    for (const d of [d1, d2]) if (!Number.isInteger(d) || d < 1 || d > 6) throw new RangeError(`Invalid die value: ${d}`);
    const t = d1 + d2, hard = d1 === d2, P = this.point, comeOut = P == null;
    const b = this.bets, S = this.settings;
    const working = (id) => this.isWorking(id);
    const events = [];
    let net = 0;
    const vigNote = `${pct(S.vigRate)} vig`;
    const push = (e) => { e.seq = events.length; e.name = this.betInfo(e.id).name; events.push(e); };
    const win = (id, profit, down, note) => {
      const stake = b[id];
      push({ id, type: 'win', stake, win: profit, down: !!down, note, returned: profit + (down ? stake : 0) });
      this.bankroll += profit; net += profit; this.stats.totalWon += profit;
      if (down) { this.bankroll += stake; if (this.vigPaid[id]) { this.bankroll += this.vigPaid[id]; delete this.vigPaid[id]; } delete b[id]; delete this.working[id]; delete this.puts[id]; }
    };
    // a losing bet forfeits its stake AND any commission prepaid for this decision (layVig / buyVig 'upfront'):
    // `vig` is that commission and `lost` the total the player is out, so a banner reads what the bankroll lost
    const lose = (id, note) => {
      const stake = b[id], v = this.vigPaid[id] || 0;
      push({ id, type: 'lose', stake, win: 0, down: true, note, returned: 0, vig: v, lost: stake + v });
      net -= stake + v; this.stats.totalLost += stake + v;
      delete b[id]; delete this.working[id]; delete this.puts[id]; delete this.vigPaid[id];
    };
    // a bet that is OFF on a roll that would have decided it stays up: emitted so the visuals can flash its OFF lammer
    const off = (id) => push({ id, type: 'push', stake: b[id], win: 0, down: false, off: true, note: comeOut ? 'Off on the come-out' : 'Off', returned: 0 });
    const ret = (id, note) => { const stake = b[id]; push({ id, type: 'push', stake, win: 0, down: true, note, returned: stake }); this.bankroll += stake; delete b[id]; delete this.working[id]; delete this.puts[id]; };
    const stay = (id, note) => push({ id, type: 'push', stake: b[id], win: 0, down: false, note, returned: 0 });
    const move = (id, to) => { const stake = b[id]; push({ id, type: 'move', stake, win: 0, to, down: false, returned: 0 }); delete b[id]; b[to] = stake; };

    // 1) Come / Don't Come bets already sitting on numbers.
    for (const n of POINTS) {
      const cid = 'come' + n, oid = 'comeOdds' + n;
      if (b[cid]) {
        const oddsWorking = working(oid);
        if (t === n) {
          win(cid, b[cid], true);
          if (b[oid]) { if (oddsWorking) win(oid, payout(b[oid], TRUE_ODDS[n]), true); else ret(oid, 'Come odds off'); }
        } else if (t === 7) {
          lose(cid);
          if (b[oid]) { if (oddsWorking) lose(oid); else ret(oid, 'Come odds off'); }
        }
      } else if (b[oid]) ret(oid, 'No come bet');
      const did = 'dontCome' + n, doid = 'dontComeOdds' + n;
      if (b[did]) {
        const oddsWorking = working(doid);
        if (t === 7) {
          win(did, b[did], true);
          if (b[doid]) { if (oddsWorking) win(doid, payout(b[doid], LAY_ODDS[n]), true); else ret(doid, 'Lay odds off'); }
        } else if (t === n) {
          lose(did);
          if (b[doid]) { if (oddsWorking) lose(doid); else ret(doid, 'Lay odds off'); }
        }
      } else if (b[doid]) ret(doid, "No don't come bet");
    }

    // 2) Line bets.
    if (comeOut) {
      if (b.pass) { if (t === 7 || t === 11) win('pass', b.pass, false); else if (t === 2 || t === 3 || t === 12) lose('pass'); }
      if (b.dontPass) {
        if (t === 2 || t === 3) win('dontPass', b.dontPass, false);
        else if (t === 12) stay('dontPass', 'Bar 12');
        else if (t === 7 || t === 11) lose('dontPass');
      }
      if (b.passOdds) ret('passOdds', 'No point');
      if (b.dontPassOdds) ret('dontPassOdds', 'No point');
    } else {
      if (t === P) {
        if (b.pass) win('pass', b.pass, false);
        if (b.passOdds) win('passOdds', payout(b.passOdds, TRUE_ODDS[P]), true);
        if (b.dontPass) lose('dontPass');
        if (b.dontPassOdds) lose('dontPassOdds');
      } else if (t === 7) {
        if (b.pass) lose('pass');
        if (b.passOdds) lose('passOdds');
        if (b.dontPass) win('dontPass', b.dontPass, false);
        if (b.dontPassOdds) win('dontPassOdds', payout(b.dontPassOdds, LAY_ODDS[P]), true);
      }
      // Odds without a flat bet behind them (defensive) come back.
      if (b.passOdds && !b.pass) ret('passOdds', 'No pass line bet');
      if (b.dontPassOdds && !b.dontPass) ret('dontPassOdds', "No don't pass bet");
    }

    // 3) Come / Don't Come on the bar.
    if (b.come) {
      if (t === 7 || t === 11) win('come', b.come, true);
      else if (t === 2 || t === 3 || t === 12) lose('come');
      else move('come', 'come' + t);
    }
    if (b.dontCome) {
      if (t === 2 || t === 3) win('dontCome', b.dontCome, true);
      else if (t === 12) stay('dontCome', 'Bar 12');
      else if (t === 7 || t === 11) lose('dontCome');
      else move('dontCome', 'dontCome' + t);
    }

    // 4) Place / Buy / Lay.
    for (const n of POINTS) {
      const pid = 'place' + n, bid = 'buy' + n, lid = 'lay' + n;
      for (const id of [pid, bid, lid]) if (b[id] && !working(id) && (t === n || t === 7)) off(id);
      if (b[pid] && working(pid)) { if (t === n) win(pid, payout(b[pid], PLACE_PAYS[n]), false); else if (t === 7) lose(pid); }
      if (b[bid] && working(bid)) {
        if (t === n) {
          const v = vig(b[bid], S.vigRate, S.vigRounding), w = Math.max(0, payout(b[bid], TRUE_ODDS[n]) - v);
          // 'upfront': this decision's commission was paid at booking; the dealer collects the next one from the win
          // a decision whose commission was never prepaid (timing switched with the bet up and the rack short,
          // or an old save) pays that commission from the win too: no decision is ever commission-free
          if (S.buyVig === 'upfront') { const owed = Math.max(0, v - (this.vigPaid[bid] || 0)); this.vigPaid[bid] = v; win(bid, Math.max(0, w - owed), false, owed ? `${vigNote} for this decision and the next, from the win` : `${vigNote} paid up front for the next decision`); }
          else win(bid, w, false, vigNote);
        } else if (t === 7) lose(bid);
      }
      if (b[lid] && working(lid)) {
        if (t === 7) {
          const w = payout(b[lid], LAY_ODDS[n]), v = vig(w, S.vigRate, S.vigRounding);
          // 'upfront': the decision's commission was paid at booking; the full win is paid and the dealer
          // collects the commission for the next decision from it (the lay stays up) — same net as on-win
          if (S.layVig === 'upfront') { const owed = Math.max(0, v - (this.vigPaid[lid] || 0)); this.vigPaid[lid] = v; win(lid, Math.max(0, w - v - owed), false, owed ? `${vigNote} for this decision and the next, from the win` : `${vigNote} paid up front for the next decision`); }
          else win(lid, Math.max(0, w - v), false, vigNote);
        }
        else if (t === n) lose(lid);
      }
    }

    // 5) Field, Big 6/8, Hardways, one-roll propositions.
    if (b.field) {
      if (t === 2) win('field', b.field * S.fieldTwoPays, false, `2 pays ${S.fieldTwoPays}:1`);
      else if (t === 12) win('field', b.field * S.fieldTwelvePays, false, `12 pays ${S.fieldTwelvePays}:1`);
      else if ([3, 4, 9, 10, 11].includes(t)) win('field', b.field, false); else lose('field');
    }
    for (const [id, x] of [['big6', 6], ['big8', 8]]) if (b[id] && !working(id) && (t === x || t === 7)) off(id);
    for (const x of [4, 6, 8, 10]) if (b['hard' + x] && !working('hard' + x) && (t === x || t === 7)) off('hard' + x);
    if (b.big6 && working('big6')) { if (t === 6) win('big6', b.big6, false); else if (t === 7) lose('big6'); }
    if (b.big8 && working('big8')) { if (t === 8) win('big8', b.big8, false); else if (t === 7) lose('big8'); }
    for (const n of [4, 6, 8, 10]) {
      const id = 'hard' + n;
      if (b[id] && working(id)) {
        if (t === n && hard) win(id, payout(b[id], HARD_PAYS[n]), false, 'Hard way');
        else if (t === n) lose(id, 'Easy way');
        else if (t === 7) lose(id);
      }
    }
    if (b.any7) { if (t === 7) win('any7', payout(b.any7, PROP_PAYS.any7), false); else lose('any7'); }
    if (b.anyCraps) { if ([2, 3, 12].includes(t)) win('anyCraps', payout(b.anyCraps, PROP_PAYS.anyCraps), false); else lose('anyCraps'); }
    for (const [id, num] of [['two', 2], ['three', 3], ['eleven', 11], ['twelve', 12]]) {
      if (b[id]) { if (t === num) win(id, payout(b[id], PROP_PAYS[id]), false); else lose(id); }
    }
    if (b.horn) {
      // Horn = four equal bets on 2, 3, 11, 12. The winning quarter is paid, the other three quarters lose.
      // 2/12: 30q - 3q = 27q ; 3/11: 15q - 3q = 12q.  (Accepted only in $4 units, so this is exact.)
      const a = b.horn;
      if (t === 2 || t === 12) win('horn', payout(a, [27, 4]), false, `Horn ${t}`);
      else if (t === 3 || t === 11) win('horn', payout(a, [12, 4]), false, `Horn ${t}`);
      else lose('horn');
    }
    if (b.ce) {
      // C&E = half on Any Craps (7:1), half on Eleven (15:1). Craps nets 3:1 on the whole, eleven nets 7:1.
      const a = b.ce;
      if ([2, 3, 12].includes(t)) win('ce', payout(a, [6, 2]), false, 'Craps');
      else if (t === 11) win('ce', payout(a, [14, 2]), false, 'Eleven');
      else lose('ce');
    }
    if (b.world) {
      // World = Horn + Any 7 in five units. 2/12: 30u - 4u = 26u ; 3/11: 15u - 4u = 11u ; 7: 4u - 4u = push.
      const a = b.world;
      if (t === 2 || t === 12) win('world', payout(a, [26, 5]), false, `World ${t}`);
      else if (t === 3 || t === 11) win('world', payout(a, [11, 5]), false, `World ${t}`);
      else if (t === 7) stay('world', 'Seven pushes the World');
      else lose('world');
    }
    for (const hi of [2, 3, 11, 12]) {
      const id = 'hornHigh' + hi;
      if (!b[id]) continue;
      // Five units: two on the high number, one on each of the other three horn numbers.
      const a = b[id], pay = (x) => (x === 2 || x === 12 ? 30 : 15);
      if ([2, 3, 11, 12].includes(t)) {
        const units = t === hi ? 2 * pay(t) - 3 : pay(t) - 4;
        win(id, payout(a, [units, 5]), false, `Horn ${t}`);
      } else lose(id);
    }
    const hid = hopId(d1, d2);
    for (const id of HOP_IDS) {
      if (!b[id]) continue;
      if (id === hid) win(id, payout(b[id], hard ? HOP_PAYS.hard : HOP_PAYS.easy), false, hard ? 'Hard hop' : 'Hop');
      else lose(id);
    }

    // 6) All / Tall / Small — totals since the last 7.
    if (t === 7) {
      for (const k of Object.keys(ATS)) if (b[k]) lose(k, 'Seven');
      this.atsHits = [];
    } else {
      if (!this.atsHits.includes(t)) this.atsHits.push(t);
      for (const [k, def] of Object.entries(ATS)) {
        if (b[k] && def.nums.every((x) => this.atsHits.includes(x))) win(k, b[k] * def.pays, true, `${def.nums.join('-')} complete`);
      }
    }

    // 7) Point / puck, then the Fire Bet (it tracks the shooter's points).
    let outcome = 'roll', label = '';
    if (comeOut) {
      if (t === 7 || t === 11) { outcome = 'natural'; label = 'Winner!'; this.stats.naturals++; }
      else if (t === 2 || t === 3 || t === 12) { outcome = 'craps'; label = 'Craps'; this.stats.craps++; }
      else { outcome = 'point-set'; label = `The Point is ${t}`; this.point = t; }
    } else if (t === P) { outcome = 'point-made'; label = `Point Made — ${t}!`; this.point = null; this.stats.pointsMade++; }
    else if (t === 7) { outcome = 'seven-out'; label = 'Seven Out'; this.point = null; this.stats.sevenOuts++; }

    if (outcome === 'point-made' && !this.firePoints.includes(t)) {
      this.firePoints.push(t);
      if (b.fire && this.firePoints.length === 6) win('fire', b.fire * FIRE_PAYS[6], true, 'All six points');
    }
    if (outcome === 'seven-out') {
      const k = this.firePoints.length;
      if (b.fire) { if (FIRE_PAYS[k]) win('fire', b.fire * FIRE_PAYS[k], true, `${k} points made`); else lose('fire', `${k} point${k === 1 ? '' : 's'} made`); }
      this.firePoints = [];
    }

    const totalWin = events.filter((e) => e.type === 'win').reduce((a, e) => a + e.win, 0);
    const totalLost = events.filter((e) => e.type === 'lose').reduce((a, e) => a + e.lost, 0);
    this.stats.rolls++;
    this.stats.currentRoll++;
    this.stats.longestRoll = Math.max(this.stats.longestRoll, this.stats.currentRoll);
    if (outcome === 'seven-out') this.stats.currentRoll = 0;
    this.stats.biggestWin = Math.max(this.stats.biggestWin, totalWin);
    const result = {
      d1, d2, total: t, hard, pointBefore: P, pointAfter: this.point, events, net, totalWin, totalLost,
      outcome, label, call: stickCall(d1, d2, P), bankroll: this.bankroll, puck: this.puck,
      firePoints: this.firePoints.slice(), atsHits: this.atsHits.slice(),
    };
    this.history.push({ d1, d2, total: t, hard, pointBefore: P, pointAfter: this.point, net, outcome });
    if (this.history.length > 500) this.history.shift();

    for (const e of events) this._emit('resolve', e);
    // ON/OFF calls are scoped: a call made on the come-out ("working this roll") lasts for that roll only,
    // and a call made during a point lasts until the puck moves (point made / seven-out). After that every
    // bet is back to the table default, so a Hard 8 turned ON for one come-out is OFF again next come-out.
    const scoped = [];
    if (comeOut || P !== this.point) {
      for (const id of Object.keys(this.working)) { delete this.working[id]; if (b[id]) scoped.push(id); }
    }
    // A Pass Line Put ends with its point: once the puck moves, a Pass Line that stays up is an ordinary line bet.
    // Put money on a come number stays a Put for as long as that bet is up (until it wins or loses).
    if (P !== this.point) delete this.puts.pass;
    for (const id of Object.keys(this.puts)) if (!b[id]) delete this.puts[id];
    if (P !== this.point) this._emit('point', { from: P, to: this.point, outcome });
    for (const id of scoped) this._emit('working', { id, working: this.isWorking(id), reason: 'scope' });
    this._emit('roll', result);
    return result;
  }

  /**
   * What the NEXT roll would do to the bets now up, computed exactly with the engine's own resolution on a
   * silent copy of the table (the live game is not touched and no events fire). One row per dice combination
   * (21: hard and easy ways apart) plus a row per total. For a "what am I rooting for" HUD and risk display.
   * Returns { rows: [{ d1, d2, total, hard, prob, net, outcome, call }], byTotal: [{ total, prob, net, hardNet?, easyNet? }],
   *   expected, best, worst, pWin, pLose, pNone, atRisk }  — net = bankroll change incl. returned stakes' gain;
   *   expected = probability-weighted net; atRisk = the most the next roll can cost.
   */
  rollOutcomes() {
    const rows = [];
    for (let a = 1; a <= 6; a++) for (let c = a; c <= 6; c++) {
      const g = this._silentClone();
      const r = g.resolveRoll(a, c);
      const ways = a === c ? 1 : 2;
      rows.push({ d1: a, d2: c, total: a + c, hard: a === c, ways, prob: ways / 36, net: r.net, outcome: r.outcome, call: r.call });
    }
    // sums are taken over whole ways (integers) and divided once, so whole-dollar answers stay exact
    const byTotal = [];
    for (let t = 2; t <= 12; t++) {
      const rs = rows.filter((r) => r.total === t), w = rs.reduce((s, r) => s + r.ways, 0);
      const row = { total: t, ways: w, prob: w / 36, net: rs.reduce((s, r) => s + r.ways * r.net, 0) / w };
      if ([4, 6, 8, 10].includes(t)) { row.hardNet = rs.find((r) => r.hard).net; row.easyNet = rs.find((r) => !r.hard).net; }
      byTotal.push(row);
    }
    const sum = (f) => rows.reduce((s, r) => s + (f(r) ? r.ways : 0), 0) / 36;
    const nets = rows.map((r) => r.net);
    // "rooting for / against": totals whose average net is positive (best first) or negative (worst first),
    // ties broken by the number of ways (the more likely total first)
    const pick = (f, dir) => byTotal.filter(f).sort((x, y) => dir * (y.net - x.net) || y.ways - x.ways).map(({ total, net, ways, prob }) => ({ total, net, ways, prob }));
    return {
      rows, byTotal,
      bestTotals: pick((r) => r.net > 0, 1), worstTotals: pick((r) => r.net < 0, -1),
      expected: rows.reduce((s, r) => s + r.ways * r.net, 0) / 36,
      best: Math.max(...nets), worst: Math.min(...nets),
      pWin: sum((r) => r.net > 0), pLose: sum((r) => r.net < 0), pNone: sum((r) => r.net === 0),
      atRisk: Math.max(0, -Math.min(...nets)),
    };
  }

  /** A raw, listener-free copy of the live table (no rules re-run), so a what-if roll matches the real one exactly. */
  _silentClone() {
    const c = (o) => JSON.parse(JSON.stringify(o));
    const g = new CrapsGame({ bankroll: this.bankroll });
    g.settings = { ...this.settings }; g.point = this.point;
    g.bets = c(this.bets); g.working = c(this.working); g.puts = c(this.puts); g.vigPaid = c(this.vigPaid);
    g.stats = c(this.stats); g.firePoints = this.firePoints.slice(); g.atsHits = this.atsHits.slice();
    return g;
  }

  // ---------- persistence ----------
  serialize() {
    return JSON.parse(JSON.stringify({
      v: 2, bankroll: this.bankroll, bets: this.bets, point: this.point, settings: this.settings,
      working: this.working, puts: this.puts, vigPaid: this.vigPaid, stats: this.stats, history: this.history.slice(-100),
      firePoints: this.firePoints, atsHits: this.atsHits,
    }));
  }

  /**
   * Rebuild a game from serialize() output. Every field is validated: unknown settings/stats keys and
   * wrong types are ignored, and bets are replayed through the same table rules (orphan odds and
   * bar bets with no point are refunded, odds are capped at the odds limit, flats at the table max,
   * prop bets must be in their units). Refunds go back to the bankroll, so no money is created or lost.
   */
  static restore(obj) {
    const isObj = (o) => o && typeof o === 'object' && !Array.isArray(o);
    const settings = sanitizeSettings(isObj(obj?.settings) ? obj.settings : null);
    const bank = Number.isFinite(obj?.bankroll) && obj.bankroll >= 0 ? Math.floor(obj.bankroll) : 1000;
    const g = new CrapsGame({ bankroll: bank, settings });
    if (!isObj(obj)) return g;
    g.point = POINTS.includes(obj.point) ? obj.point : null;

    if (isObj(obj.stats)) for (const [k, v] of Object.entries(obj.stats)) if (k in g.stats && Number.isFinite(v)) g.stats[k] = v;
    if (Array.isArray(obj.firePoints)) g.firePoints = [...new Set(obj.firePoints.filter((n) => POINTS.includes(n)))];
    if (Array.isArray(obj.atsHits)) g.atsHits = [...new Set(obj.atsHits.filter((n) => Number.isInteger(n) && n >= 2 && n <= 12 && n !== 7))];

    // Bets: flats first so odds can be checked against them.
    const raw = isObj(obj.bets) ? Object.entries(obj.bets).filter(([id, a]) => isValidBetId(id) && Number.isInteger(a) && a > 0) : [];
    const isOdds = (id) => /Odds/.test(id);
    raw.sort((x, y) => isOdds(x[0]) - isOdds(y[0]));
    for (const [id, a] of raw) {
      let amt = a;
      // the same cap as setSettings: the largest clean total allowed (boxes / unit bets floored to their unit)
      { const c = g._capFor(id); if (amt > c) { g.bankroll += amt - c; amt = c; } }
      if (amt > 0 && g._rules(id, amt, true).ok) g.bets[id] = amt;
      else g.bankroll += amt;
    }
    // up-front lay commission already paid: kept (capped at what that lay owes) while the lay is up on an
    // 'upfront' table; any excess, or vig for a lay that was not restored, goes back to the bankroll
    if (isObj(obj.vigPaid)) {
      for (const [id, v] of Object.entries(obj.vigPaid)) {
        if (!isValidBetId(id) || !['lay', 'buy'].includes(parseBetId(id).kind) || !Number.isInteger(v) || v <= 0) continue;
        const keep = g.bets[id] && g.vigUpfront(id) ? Math.min(v, g.commissionFor(id)) : 0;
        if (keep) g.vigPaid[id] = keep;
        g.bankroll += v - keep;
      }
    }
    if (isObj(obj.working)) {
      for (const [id, v] of Object.entries(obj.working)) if (typeof v === 'boolean' && g.canToggleWorking(id) && g.bets[id]) g.working[id] = v;
    }
    // Put money: a number of dollars (capped at the bet), or `true` from older saves (= the whole bet).
    // A Pass Line Put needs a point; a Put on a come number survives the point being made.
    if (isObj(obj.puts)) {
      for (const [id, v] of Object.entries(obj.puts)) {
        if (!g.bets[id] || !((id === 'pass' && g.point) || /^come(4|5|6|8|9|10)$/.test(id))) continue;
        const amt = v === true ? g.bets[id] : Number.isInteger(v) && v > 0 ? Math.min(v, g.bets[id]) : 0;
        if (amt) g.puts[id] = amt;
      }
      // odds restored before the Put status was known may now exceed a 'flat' Put limit: refund the excess
      for (const [oid, fid] of [['passOdds', 'pass'], ...POINTS.map((n) => ['comeOdds' + n, 'come' + n])]) {
        if (!g.puts[fid] || !g.bets[oid]) continue;
        const max = g.maxFor(oid) || 0; if (g.bets[oid] > max) { g.bankroll += g.bets[oid] - max; if (max > 0) g.bets[oid] = max; else delete g.bets[oid]; }
      }
    }
    g.history = Array.isArray(obj.history)
      ? obj.history.filter((h) => isObj(h) && [h.d1, h.d2].every((d) => Number.isInteger(d) && d >= 1 && d <= 6)).slice(-500)
      : [];
    return g;
  }
}

/**
 * Exact expected value per dollar wagered of a bet (per decision), computed analytically
 * from the engine's own payouts over all 36 dice combinations — independent of RNG.
 * Returns a negative number for house games (e.g. ≈ -0.01414 for the pass line).
 * Pushes that leave a one-roll bet up (World on 7) count as a zero-value decision.
 * Commission paid up front (layVig / buyVig 'upfront') is part of the money at risk: a losing decision
 * costs stake + vig, and the edge is per dollar the player puts down (stake + vig) — Buy 4 $20 + $1 =
 * 4.76%, Lay 4 $40 + $1 = 2.44% (2.5% per dollar laid). With the vig taken from the win both are 1.67%.
 */
export function expectedValue(id, amount = 30, settings) {
  const value = (e) => (!e ? null : e.type === 'win' ? e.win : e.type === 'lose' ? -(e.lost ?? e.stake) : e.type === 'push' ? 0 : null);
  let risked = amount;
  const outcome = (point, d1, d2) => {
    const g = new CrapsGame({ bankroll: 1e9, settings: { ...settings, placeWorkingOnComeOut: true, hardwaysWorkingOnComeOut: true } });
    g.point = point;
    const uv = g.upfrontVig(id, amount); // prepaid commission for this decision (0 unless 'upfront')
    g.bets[id] = amount; if (uv) g.vigPaid[id] = uv;
    risked = amount + uv;
    return value(g.resolveRoll(d1, d2).events.find((x) => x.id === id));
  };
  const combos = []; for (let a = 1; a <= 6; a++) for (let c = 1; c <= 6; c++) combos.push([a, c]);
  if (isOneRoll(id)) { const s = combos.reduce((acc, [a, c]) => acc + outcome(null, a, c), 0); return s / 36 / risked; }
  if (id === 'pass' || id === 'dontPass') {
    let ev = 0;
    for (const [a, c] of combos) {
      const v = outcome(null, a, c);
      if (v !== null) { ev += v / 36; continue; }
      // Point established: EV of the point phase = average over decisive rolls (point or 7).
      const t = a + c; let s = 0, w = 0;
      for (const [x, y] of combos) { const pv = outcome(t, x, y); if (pv !== null) { s += pv; w++; } }
      ev += s / w / 36;
    }
    return ev / risked;
  }
  // Multi-roll bets that resolve on specific numbers: average over decisive rolls.
  let s = 0, w = 0;
  for (const [a, c] of combos) { const v = outcome(5, a, c); if (v !== null) { s += v; w++; } }
  return w ? s / w / risked : 0;
}

/** Exact probability that every total in `nums` rolls before a 7 (inclusion–exclusion). */
export function probAllBeforeSeven(nums) {
  let p = 0;
  const k = nums.length;
  for (let mask = 0; mask < 1 << k; mask++) {
    let w = 0, bits = 0;
    for (let i = 0; i < k; i++) if (mask & (1 << i)) { w += WAYS[nums[i]]; bits++; }
    p += (bits % 2 ? -1 : 1) * (6 / (6 + w));
  }
  return p;
}

/**
 * Simple automatic betting strategy (used by ?shot=play smoke test).
 * Returns [[betId, amount], ...] to place before the next roll.
 */
export function autoStrategy(game, unit = 10, rollIndex = 0) {
  const out = [];
  const P = game.point, b = game.bets;
  if (!P) {
    if (!b.pass) out.push(['pass', unit]);
  } else {
    if (b.pass && !b.passOdds) out.push(['passOdds', game.payableAmount('passOdds', Math.min(game.maxTakeOdds(b.pass, P), unit * 2))]);
    const comePts = POINTS.filter((n) => b['come' + n]);
    for (const n of comePts) if (!b['comeOdds' + n]) out.push(['comeOdds' + n, game.payableAmount('comeOdds' + n, unit)]);
    if (comePts.length < 2 && !b.come) out.push(['come', unit]);
    for (const n of [6, 8]) if (n !== P && !b['place' + n] && !b['come' + n]) out.push(['place' + n, 12]);
    if (!b.hard8 && rollIndex % 4 === 1) out.push(['hard8', 2]);
  }
  if (rollIndex % 3 === 0 && !b.field) out.push(['field', 5]);
  if (rollIndex % 7 === 3 && !b.ce) out.push(['ce', 2]);
  return out;
}
