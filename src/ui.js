// ui.js — HUD behaviour layered on top of main.js wiring.
// Decoupled on purpose: reads the live game through window.craps (set by main.js) and only
// touches HUD-owned DOM. No static imports, so the HUD (and the boot-failure fallback) still
// work even if the 3D engine or one of its modules fails to load.

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const SHOT = params.get('shot');
const store = {
  get(k, d) { try { const v = localStorage.getItem('craps.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { if (SHOT) return; try { localStorage.setItem('craps.' + k, JSON.stringify(v)); } catch { } },
};

const track = $('pointTrack');
const shooter = $('shooterRoll');
const status = $('status');
const histPanel = $('historyPanel');
const histList = $('historyList');
const tooltip = $('tooltip');

// ---------- per-frame sync of derived HUD state ----------
let lastKey = '';
function sync() {
  const c = window.craps;
  if (!c || !c.game) return;
  const g = c.game;
  const P = g.point;
  const hist = g.history || [];
  const key = `${P}|${hist.length}|${g.stats.currentRoll}|${g.stats.sevenOuts}`;
  if (key !== lastKey) {
    lastKey = key;
    if (track) for (const s of track.children) s.classList.toggle('lit', Number(s.dataset.n) === P);
    if (status) status.classList.toggle('on', !!P);
    // actual shooter number (one per seven-out) + this shooter's roll count
    if (shooter) shooter.innerHTML = `Shooter <b>#${(g.stats.sevenOuts || 0) + 1}</b><span class="hs-sep">·</span>roll <b>${g.stats.currentRoll}</b>`;
  }
  if (histPanel && histList) {
    // main.js re-renders the real tiles with innerHTML; ghost slots are re-appended here (same frame)
    const real = histList.querySelectorAll('li:not(.ghost)').length;
    const ghosts = histList.querySelectorAll('li.ghost').length;
    histPanel.classList.toggle('empty', real === 0);
    histPanel.classList.toggle('few', real > 0 && real < 4); // compact: no stats row eating space for one or two tiles
    const hk = `${real}|${ghosts}|${g.stats.rolls}|${innerWidth}x${innerHeight}`;
    if (hk !== sync.histKey) {
      sync.histKey = hk;
      layoutHistory(real, g.stats.rolls || 0);
      sync.histKey = `${real}|${histList.querySelectorAll('li.ghost').length}|${g.stats.rolls}|${innerWidth}x${innerHeight}`;
    }
  }
  // ROLL button: visible rolling state while the dice are in the air / the table is paid
  const rb = $('rollBtn');
  if (rb) {
    const busy = rb.disabled;
    if (rb.classList.contains('busy') !== busy) rb.classList.toggle('busy', busy);
  }
}
// History strip: the list is sized to a whole number of tile slots (so no slot is ever cut by the panel edge),
// empty slots are real dashed <li class="ghost"> tiles, and the header says "last N of M" only when rolls
// outnumber the visible slots. Ghosts never sit after the newest tiles when older rolls are hidden.
function layoutHistory(real, rolls) {
  histPanel.classList.remove('fit1', 'fit2', 'fit3');
  const cs = getComputedStyle(histList);
  const tw = parseFloat(cs.getPropertyValue('--tw')) || 54, tg = parseFloat(cs.getPropertyValue('--tg')) || 6;
  const pitch = tw + tg;
  histList.style.width = '';
  for (const gl of histList.querySelectorAll('li.ghost')) gl.remove();
  // available width = what the panel can give the list when it is allowed to fill its grid column
  histList.style.width = '4000px';
  const panelMax = histPanel.getBoundingClientRect().width; // clamped by max-width:100% of the column
  const pcs = getComputedStyle(histPanel);
  const avail = panelMax - parseFloat(pcs.paddingLeft) - parseFloat(pcs.paddingRight) - parseFloat(pcs.borderLeftWidth) - parseFloat(pcs.borderRightWidth);
  let slots = Math.max(1, Math.floor((avail + tg) / pitch));
  if (histPanel.classList.contains('mini')) slots = Math.min(3, slots);
  histList.style.width = (slots * pitch - tg) + 'px';
  const shown = Math.min(real, slots);
  for (let i = shown; i < slots; i++) { const li = document.createElement('li'); li.className = 'ghost'; li.setAttribute('aria-hidden', 'true'); histList.appendChild(li); }
  const of = $('histOf');
  if (of) of.textContent = shown && shown < rolls ? `last ${shown} of` : '';
  // the header never clips at the panel edge: drop "last N of", then "N points", then the roll count
  const head = histPanel.querySelector('.panel-head');
  if (head && head.offsetParent) for (const k of ['fit1', 'fit2', 'fit3']) {
    if (head.scrollWidth <= head.clientWidth + 0.5) break;
    histPanel.classList.add(k);
  }
}
// compact history: the title toggles a 3-tile mode (remembered per viewer)
(function histMini() {
  const t = $('histToggle'); if (!t || !histPanel) return;
  const set = (on) => { histPanel.classList.toggle('mini', on); t.dataset.tip = on ? 'Full history' : 'Compact history · last 3'; sync.histKey = ''; };
  set(!SHOT && store.get('histMini', false));
  t.addEventListener('click', () => { const on = !histPanel.classList.contains('mini'); set(on); store.set('histMini', on); });
})();

// ---------- chip rack: the gold seat sits under the selected chip ----------
(function chipSeat() {
  const tray = $('chipTray'); if (!tray) return;
  const place = () => {
    const sel = tray.querySelector('.chip.selected');
    if (sel) tray.style.setProperty('--seat-x', (sel.offsetLeft + sel.offsetWidth / 2).toFixed(1) + 'px');
  };
  new MutationObserver(place).observe(tray, { attributes: true, attributeFilter: ['class'], subtree: true, childList: true });
  addEventListener('resize', place);
  requestAnimationFrame(place);
})();

// ---------- payout ribbon: the per-bet breakdown folds away after 1.6s, the headline amount stays ----------
// (frozen ?shot captures keep the breakdown unless &fold=1 asks for the folded state)
(function ribbonFold() {
  const wb = $('winBanner'); if (!wb) return;
  let timer = 0;
  const canFold = !SHOT || params.has('fold');
  new MutationObserver(() => {
    const on = wb.classList.contains('show');
    if (!on) { clearTimeout(timer); timer = 0; return; }
    if (!wb.classList.contains('folded') && !timer && canFold) timer = setTimeout(() => { timer = 0; if (wb.classList.contains('show')) wb.classList.add('folded'); }, 1600);
  }).observe(wb, { attributes: true, attributeFilter: ['class'] });
})();

// ---------- plaque: a long figure steps its size down (to a 22px floor) instead of being clipped ----------
(function fitMoney() {
  const items = [['bankroll', null, 22], ['totalBet', null, 22], ['session', 'sess-val', 13]]
    .map(([id, box, floor]) => { const t = $(id); return t && { t, box: box ? t.closest('.' + box) : t, floor }; }).filter(Boolean);
  const fit = ({ t, box, floor }) => {
    t.style.fontSize = '';
    if (!box.offsetParent) return;
    let s = parseFloat(getComputedStyle(t).fontSize);
    const min = Math.min(floor, s);
    while (box.scrollWidth > box.clientWidth + 0.5 && s > min) { s -= 1; t.style.fontSize = s + 'px'; }
  };
  const all = () => items.forEach(fit);
  for (const it of items) new MutationObserver(() => fit(it)).observe(it.t, { childList: true, characterData: true, subtree: true });
  addEventListener('resize', all);
  requestAnimationFrame(all);
  // review hook: ?bank=250000&wager=50000 stages a high-roller plaque (display only)
  if (params.has('bank') || params.has('wager')) setTimeout(() => {
    const f = (v) => '$' + Number(v).toLocaleString('en-US');
    if (params.has('bank')) $('bankroll').textContent = f(params.get('bank'));
    if (params.has('wager')) $('totalBet').textContent = f(params.get('wager'));
  }, 2500);
})();
// 5 Hz is plenty for derived HUD state (a per-frame loop kept the CPU awake at 120 Hz on phones)
function loop() { try { sync(); } catch (e) { /* never break the page over HUD sugar */ } }
setInterval(loop, 200); requestAnimationFrame(loop);

// ---------- bet tooltip: the key-hint row teaches once ----------
// After the player's first chip placed from the felt (a left click while a bet tooltip is up), the hint row
// is dropped for good so the tooltip is just name · pays · wager.
if (store.get('ttLearned', false)) document.body.classList.add('tt-learned');
$('gl')?.addEventListener('pointerup', (e) => {
  if (e.button !== 0 || document.body.classList.contains('tt-learned') || !tooltip?.classList.contains('show')) return;
  setTimeout(() => { document.body.classList.add('tt-learned'); store.set('ttLearned', true); }, 1200);
});

// ---------- overflow ("more") menu ----------
const moreBtn = $('moreBtn'), moreMenu = $('moreMenu');
function setMenu(open) { moreMenu?.classList.toggle('open', open); moreBtn?.classList.toggle('active', open); }
moreBtn?.addEventListener('click', (e) => { e.stopPropagation(); setMenu(!moreMenu.classList.contains('open')); });
moreMenu?.addEventListener('click', (e) => {
  const b = e.target.closest('.mi');
  if (b && !b.classList.contains('toggle')) setMenu(false); // toggles stay open so the state change is visible
});
document.addEventListener('pointerdown', (e) => { if (moreMenu?.classList.contains('open') && !e.target.closest('.more-wrap')) setMenu(false); });

// ---------- settings: segmented controls ----------
function seg(id, value, onPick) {
  const el = $(id); if (!el) return;
  const mark = (v) => { for (const b of el.children) { b.classList.toggle('on', b.dataset.v === v); b.setAttribute('aria-checked', b.dataset.v === v); } };
  mark(value);
  el.addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; mark(b.dataset.v); onPick(b.dataset.v); });
}
const qSel = $('qualitySel');
const TOUCH = matchMedia('(pointer: coarse)').matches && /Android|iPad|iPhone|Mobi/i.test(navigator.userAgent); // same test as main.js MOBILE
const curQuality = params.get('quality') || (SHOT ? 'high' : store.get('quality', TOUCH ? 'mobile' : 'high'));
seg('qualitySeg', curQuality, (v) => {
  if (!qSel || qSel.value === v) return;
  qSel.value = v; qSel.dispatchEvent(new Event('change', { bubbles: true })); // main.js persists + reloads
});
const curSpeed = SHOT ? 'normal' : store.get('speed', store.get('fast', false) ? 'fast' : 'normal');
seg('speedSeg', curSpeed, (v) => {
  store.set('speed', v);
  const s = window.craps?.settings; if (s) { s.speed = v; s.fast = v !== 'normal'; }
});

// ---------- settings: table rules (engine settings, applied via game.setSettings -> sanitizeSettings) ----------
// Saved with the game (serialize) and as craps.tableRules, which main.js re-applies at boot.
(function tableRules() {
  const RULES = [['tableMinSeg', 'tableMin', Number], ['buyVigSeg', 'buyVig', String], ['layVigSeg', 'layVig', String], ['buyMinSeg', 'buyMin', Number], ['layMinSeg', 'layMin', Number], ['roundUpSeg', 'roundUpMax', Number]];
  const ready = () => new Promise((res) => { const t = () => (window.craps?.game ? res(window.craps) : setTimeout(t, 50)); t(); });
  ready().then((c) => {
    for (const [el, key, conv] of RULES) {
      seg(el, String(c.game.settings[key]), (v) => {
        const r = c.game.setSettings({ [key]: conv(v) });
        const saved = store.get('tableRules', {}); saved[key] = r.settings[key]; store.set('tableRules', saved);
        const refunded = r.refunds.reduce((a, x) => a + x.vig, 0);
        try { c.persist?.(); c.updateHUD?.(); if (refunded) c.toast?.(`$${refunded} prepaid commission refunded`, true); else if (key === 'tableMin') c.toast?.(`Table minimum is now $${r.settings.tableMin}`, true); } catch { }
      });
    }
  });
})();

// ---------- shortcuts ----------
window.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  if (e.key === '?') $('helpModal')?.classList.toggle('show');
  if (e.key === 'Escape') setMenu(false);
});

// ---------- boot watchdog: graceful fallback if the engine never comes up ----------
(function watchdog() {
  const started = performance.now();
  const check = () => {
    if (window.craps) return; // booted
    const errored = (window.__bootErrors || 0) > 0;
    // shot captures (slow software rasteriser) only ever show the fallback for a real error; the red
    // overlay carries the details, so a merely slow boot never leaks the fallback into a frame
    if (errored || (!params.has('shot') && performance.now() - started > 15000)) {
      const ld = $('loader'); if (ld) ld.style.display = 'none'; // never cross-fade the loader under the card
      $('bootFail')?.classList.add('show');
      return;
    }
    setTimeout(check, 500);
  };
  setTimeout(check, 1500);
  $('bootReload')?.addEventListener('click', () => location.reload());
})();

// ---------- visual test hooks (headless captures cannot hover/click) ----------
// ?uitest=tooltip[&zone=number:8] | help | settings | menu | toast
// The tooltip hook drives main.js's real hover path: it projects a real bet zone to the
// screen and dispatches a pointermove there, so the capture is exactly what players see.
const uitest = params.get('uitest');
if (uitest === 'bootfail') { const ld = $('loader'); if (ld) ld.style.display = 'none'; $('bootFail')?.classList.add('show'); }
else if (uitest) {
  const when = () => new Promise((res) => { const t = () => (window.craps ? res(window.craps) : setTimeout(t, 50)); t(); });
  when().then((c) => setTimeout(async () => {
    if (uitest === 'help') $('helpModal').classList.add('show');
    else if (uitest === 'settings') $('settingsModal').classList.add('show');
    else if (uitest === 'menu') setMenu(true);
    else if (uitest === 'busy') { const rb = $('rollBtn'); rb.disabled = true; rb.classList.add('busy'); }
    else if (uitest === 'toast') { const t = $('toast'); t.textContent = 'Table maximum is $5,000'; t.className = 'toast show'; }
    else if (uitest === 'tooltip') {
      const THREE = await import('three');
      const { ZONES } = await import('./bets.js');
      const [key, n] = (params.get('zone') || 'number:8').split(':');
      const zone = ZONES.find((z) => z.key === key && (n == null || z.n === Number(n)) && z.side <= 0);
      if (!zone) return;
      const b = zone.bbox;
      const v = new THREE.Vector3((b.x0 + b.x1) / 2, 0, (b.z0 + b.z1) / 2).project(c.stage.camera);
      const r = $('gl').getBoundingClientRect();
      const x = r.left + (v.x + 1) / 2 * r.width, y = r.top + (1 - v.y) / 2 * r.height;
      $('gl').dispatchEvent(new PointerEvent('pointermove', { clientX: x, clientY: y, bubbles: true, pointerType: 'mouse' }));
      // visible cursor marker so the capture shows where the pointer is
      const m = document.createElement('div');
      m.style.cssText = `position:fixed;left:${x - 1}px;top:${y - 1}px;width:0;height:0;border-left:7px solid transparent;border-right:7px solid transparent;border-bottom:18px solid #fff;transform:rotate(-28deg);transform-origin:0 0;filter:drop-shadow(0 1px 2px #000);z-index:30;pointer-events:none`;
      document.body.appendChild(m);
    }
  }, 400));
}

// ---------- stickman call typography: never leave an em dash dangling at a line end ----------
// "Six the hard way — Winner" wraps with the dash glued to the word before it (non-breaking space).
(function glueDashes() {
  const el = $('calloutText'); if (!el) return;
  const fix = () => {
    for (const n of el.childNodes) {
      if (n.nodeType !== 3) continue;
      const t = n.nodeValue.replace(/\s+([—–])\s*/g, ' $1 ');
      if (t !== n.nodeValue) n.nodeValue = t;
    }
  };
  fix();
  new MutationObserver(fix).observe(el, { childList: true, characterData: true, subtree: true });
})();
