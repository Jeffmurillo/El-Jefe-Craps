// sidebets.js — "Side Bets" panel for bets with no printed box on the felt:
// group bets (Across, Inside, Outside, Mid, All Hardways, Hop the Hardways, Iron Cross, Regress),
// World, Horn High 2/3/11/12, the 21 Hop bets, Fire Bet and All / Tall / Small.
// Pure DOM; bets go through the same chip-booking path as felt clicks (main.js placeChip).
import { HOP_IDS, FIRE_PAYS, ATS } from './rules.js';

const CSS = `
.sb-panel { position: fixed; left: 50%; top: 50%; transform: translate(-50%, -48%) scale(.98); width: min(680px, calc(100vw - 32px)); max-height: calc(100vh - 48px); overflow: auto;
  padding: 18px 20px 16px; border-radius: 18px; z-index: 45; opacity: 0; pointer-events: none; transition: opacity .18s, transform .18s;
  background: linear-gradient(180deg, rgba(30,22,15,.97), rgba(11,8,6,.97)) padding-box, var(--hair, linear-gradient(#d6b062,#8a6524)) border-box; border: 1px solid transparent;
  box-shadow: 0 24px 60px rgba(0,0,0,.7); color: var(--ink, #f4eddc); font: 13px/1.35 var(--sans, "Segoe UI", Arial, sans-serif); }
.sb-panel.show { opacity: 1; pointer-events: auto; transform: translate(-50%, -50%) scale(1); }
.sb-head { display: flex; align-items: baseline; gap: 12px; margin-bottom: 10px; }
.sb-head h3 { margin: 0; font: 600 22px/1.1 var(--serif, Georgia, serif); color: #fff4da; letter-spacing: .4px; }
.sb-head .sb-chip { color: var(--muted, #b6ab93); font-size: 12px; }
.sb-head .sb-chip b { color: var(--gold-hi, #f7e3a6); }
.sb-x { margin-left: auto; background: none; border: 1px solid rgba(214,176,98,.3); color: var(--muted, #b6ab93); width: 30px; height: 30px; border-radius: 50%; cursor: pointer; font-size: 14px; }
.sb-x:hover { color: #fff; border-color: var(--gold, #d6b062); }
.sb-sec { margin: 12px 0 6px; font: 700 10.5px/1 var(--sans, sans-serif); letter-spacing: 2px; text-transform: uppercase; color: var(--gold, #d6b062); display: flex; gap: 10px; align-items: center; }
.sb-sec::after { content: ""; flex: 1; height: 1px; background: linear-gradient(90deg, rgba(214,176,98,.35), transparent); }
.sb-sec em { font-style: normal; letter-spacing: .3px; text-transform: none; color: var(--dim, #8c816c); font-weight: 400; font-size: 11px; }
.sb-grid { display: grid; gap: 7px; }
.sb-grid.c5 { grid-template-columns: repeat(5, minmax(0, 1fr)); }
.sb-grid.c4 { grid-template-columns: repeat(4, minmax(0, 1fr)); }
.sb-grid.c7 { grid-template-columns: repeat(7, minmax(0, 1fr)); }
.sb-grid.c8 { grid-template-columns: repeat(4, minmax(0, 1fr)); }
.sb-b.grp { background: linear-gradient(180deg, rgba(70,48,22,.6), rgba(30,20,10,.8)); }
.sb-b.grp .sb-s { font: 400 10.5px/1.2 var(--sans, sans-serif); color: var(--muted, #b6ab93); text-align: center; }
.sb-b.grp .sb-p { font-weight: 700; }
.sb-b { position: relative; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 3px; min-height: 58px; padding: 7px 4px 6px; border-radius: 11px; cursor: pointer;
  border: 1px solid rgba(214,176,98,.28); background: linear-gradient(180deg, rgba(34,70,46,.55), rgba(12,30,19,.75)); color: var(--ink, #f4eddc); font: 600 12.5px/1.1 var(--sans, sans-serif); transition: border-color .15s, transform .12s, background .15s; }
.sb-b:hover { border-color: var(--gold-hi, #f7e3a6); transform: translateY(-1px); }
.sb-b:active { transform: translateY(0); }
.sb-b.off { opacity: .42; cursor: not-allowed; filter: saturate(.4); }
.sb-b .sb-n { font: 600 14px/1.1 var(--serif, Georgia, serif); color: #fff4da; text-align: center; }
.sb-b .sb-p { font-size: 10.5px; color: var(--gold-hi, #f7e3a6); letter-spacing: .3px; }
.sb-b .sb-amt { position: absolute; top: -7px; right: -5px; min-width: 22px; padding: 2px 6px; border-radius: 10px; background: linear-gradient(180deg, #f0cf7a, #b0832f); color: #1a1206; font: 800 10.5px/1.2 var(--sans, sans-serif); box-shadow: 0 2px 6px rgba(0,0,0,.5); }
.sb-b .sb-amt.pend { background: linear-gradient(180deg, #6a5a40, #3c3020); color: #f7e3a6; }
.sb-dice { display: flex; gap: 3px; }
.sb-d { width: 17px; height: 17px; border-radius: 4px; background: linear-gradient(160deg, #e8394a, #a3111f); display: grid; grid-template-columns: repeat(3, 1fr); grid-template-rows: repeat(3, 1fr); padding: 2px; box-shadow: inset 0 1px 0 rgba(255,255,255,.35); }
.sb-d i { border-radius: 50%; margin: .5px; } .sb-d i.p { background: #fff; }
.sb-foot { margin-top: 12px; font-size: 11px; color: var(--dim, #8c816c); line-height: 1.5; }
.sb-foot b { color: var(--muted, #b6ab93); font-weight: 600; }
.sb-trk { color: var(--muted, #b6ab93); }
.sb-trk b { color: var(--gold-hi, #f7e3a6); }
@media (max-width: 560px) { .sb-grid.c7 { grid-template-columns: repeat(4, minmax(0, 1fr)); } .sb-grid.c5 { grid-template-columns: repeat(3, minmax(0, 1fr)); } .sb-grid.c4 { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
`;

const PIPS = { 1: [4], 2: [0, 8], 3: [0, 4, 8], 4: [0, 2, 6, 8], 5: [0, 2, 4, 6, 8], 6: [0, 2, 3, 5, 6, 8] };
const die = (v) => `<span class="sb-d">${Array.from({ length: 9 }, (_, i) => `<i class="${PIPS[v].includes(i) ? 'p' : ''}"></i>`).join('')}</span>`;

/**
 * opts: { game, getChip(), place(id) -> bool, remove(id) -> bool, pending(id) -> number, isBetting() -> bool, fmt(n) }
 * Returns { open(), close(), toggle(), refresh(), isOpen }
 */
export function createSideBets(opts) {
  const { game, getChip, place, remove, pending, isBetting, fmt, groups = [], groupPlan, placeGroup, regress } = opts;
  if (!document.getElementById('sb-style')) { const st = document.createElement('style'); st.id = 'sb-style'; st.textContent = CSS; document.head.appendChild(st); }
  const el = document.createElement('div');
  el.className = 'sb-panel'; el.setAttribute('role', 'dialog'); el.setAttribute('aria-label', 'Side bets');
  document.body.appendChild(el);

  const btn = (id, label, pays, extra = '') => {
    const amt = game.amount(id), pend = pending(id);
    const v = isBetting() ? game.validate(id, Math.max(getChip(), game.minFor(id))) : { ok: false, reason: 'Dice are rolling' };
    const blocked = !v.ok && !amt && /only accepted|rolling/.test(v.reason || '');
    const info = game.betInfo(id);
    const title = `${info.name} — pays ${info.pays}\nLimits ${game.limitLabel(id)}${blocked ? `\n${v.reason}` : ''}\nClick +chip · right-click take down`;
    const badge = amt ? `<span class="sb-amt">${fmt(amt)}</span>` : pend ? `<span class="sb-amt pend">${fmt(pend)}…</span>` : '';
    return `<button class="sb-b${blocked ? ' off' : ''}" data-id="${id}" title="${title.replace(/"/g, '&quot;')}">${badge}${extra}${label ? `<span class="sb-n">${label}</span>` : ''}<span class="sb-p">${pays}</span></button>`;
  };

  function render() {
    const hops = HOP_IDS.map((id) => { const a = Number(id[3]), b = Number(id[4]); return btn(id, '', a === b ? '30:1' : '15:1', `<span class="sb-dice">${die(a)}${die(b)}</span>`); }).join('');
    const grp = groups.map((g) => {
      const p = groupPlan(g.key), off = !isBetting() || !p.plan.length;
      const cost = p.plan.length ? fmt(p.total) : 'point covers it';
      const tip = p.plan.map(([id, a]) => `${game.betInfo(id).name} ${fmt(a)}`).join('&#10;') + (p.skipped.length ? `&#10;Skips ${p.skipped.join(', ')} (the point)` : '');
      return `<button class="sb-b grp${off ? ' off' : ''}" data-group="${g.key}" title="${tip}"><span class="sb-n">${g.label}</span><span class="sb-s">${g.sub}</span><span class="sb-p">${cost}</span></button>`;
    }).join('') + (regress ? `<button class="sb-b grp${isBetting() ? '' : ' off'}" data-act="regress" title="Cut every place bet about in half, in payable units; the rest goes back to your rack"><span class="sb-n">Regress</span><span class="sb-s">Halve place bets</span><span class="sb-p">take half down</span></button>` : '');
    const fp = game.firePoints.length, ats = game.atsHits.slice().sort((a, b) => a - b);
    el.innerHTML = `
      <div class="sb-head"><h3>Quick &amp; Side Bets</h3><span class="sb-chip">Chip <b>${fmt(getChip())}</b> · click to add · right-click to take down</span><button class="sb-x" aria-label="Close">✕</button></div>
      ${grp ? `<div class="sb-sec">Group bets <em>one tap per unit · your chip is the unit · 6 &amp; 8 in $6s · skips the point</em></div>
      <div class="sb-grid c8">${grp}</div>` : ''}
      <div class="sb-sec">Horn family <em>one roll · booked in $5 units · max ${fmt(game.maxBookable("world"))}</em></div>
      <div class="sb-grid c5">
        ${btn('world', 'World', '2·3·7·11·12')}
        ${btn('hornHigh2', 'Horn High 2', '2 nets 57:5')}
        ${btn('hornHigh3', 'Horn High 3', '3 nets 27:5')}
        ${btn('hornHigh11', 'Horn High 11', '11 nets 27:5')}
        ${btn('hornHigh12', 'Horn High 12', '12 nets 57:5')}
      </div>
      <div class="sb-sec">Hop bets <em>one roll · exact dice · easy 15:1 · hard 30:1 · max ${fmt(game.maxBookable("hop11"))}</em></div>
      <div class="sb-grid c7">${hops}</div>
      <div class="sb-sec">Bonus bets <em>Fire: new shooter only · ATS: right after a 7 · max ${fmt(game.maxBookable("fire"))}</em></div>
      <div class="sb-grid c4">
        ${btn('fire', 'Fire Bet', `4 pts ${FIRE_PAYS[4]}:1 · 6 pts ${FIRE_PAYS[6]}:1`)}
        ${btn('small', 'All Small', `${ATS.small.pays}:1 · 2–6`)}
        ${btn('tall', 'All Tall', `${ATS.tall.pays}:1 · 8–12`)}
        ${btn('all', "Make 'Em All", `${ATS.all.pays}:1`)}
      </div>
      <div class="sb-foot"><span class="sb-trk">Fire points this shooter: <b>${fp ? game.firePoints.join(', ') : 'none'}</b> · Rolled since last 7: <b>${ats.length ? ats.join(', ') : 'none'}</b></span><br>
      World = Horn + Any 7 in five units (7 pushes). Horn High = Horn with an extra unit on the named number. Small chips accumulate until they reach a bettable amount.</div>`;
  }

  el.addEventListener('click', (e) => {
    if (e.target.closest('.sb-x')) { close(); return; }
    const b = e.target.closest('.sb-b'); if (!b) return;
    if (b.dataset.group) placeGroup(b.dataset.group);
    else if (b.dataset.act === 'regress') regress();
    else place(b.dataset.id);
    render();
  });
  el.addEventListener('contextmenu', (e) => {
    const b = e.target.closest('.sb-b'); if (!b || !b.dataset.id) return;
    e.preventDefault(); remove(b.dataset.id); render();
  });
  game.on('*', () => { if (api.isOpen) render(); });

  function open() { render(); el.classList.add('show'); api.isOpen = true; }
  function close() { el.classList.remove('show'); api.isOpen = false; }
  const api = { open, close, toggle: () => (api.isOpen ? close() : open()), refresh: () => { if (api.isOpen) render(); }, isOpen: false, el };
  return api;
}
