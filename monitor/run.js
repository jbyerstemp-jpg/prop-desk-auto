// Prop Desk monitor: runs the app's own model (js/core.js) and sends ntfy alerts only when something changes.
// One engine, two hosts: the Cloudflare Worker (monitor/worker.js, every 5 min) and GitHub (manual backup, `node monitor/run.js`).
// Read-only: public market data in, phone notification out. No orders.
'use strict';
const C = require('../js/core.js');
const P = require('../js/profile.js');
const TR = require('../js/traits.js');
const COOLDOWN = 2 * 3600e3, KEEP = 3 * 86400e3, MAX_PER_RUN = 6, IV = [15, 60, 240, 1440];

const krPair = s => s.replace('BTC', 'XBT').replace('/', '');
const pf = s => 'PF_' + s.replace('BTC', 'XBT').replace('/', '');

async function getJson(url) { const r = await fetch(url, { headers: { 'User-Agent': 'prop-desk-monitor' } }); if (!r.ok) throw new Error(url.split('?')[0] + ' ' + r.status); return r.json(); }
async function candles(sym, iv, since) {
  const j = await getJson(`https://api.kraken.com/0/public/OHLC?pair=${krPair(sym)}&interval=${iv}` + (since ? `&since=${since}` : ''));
  if (j.error && j.error.length) throw new Error(j.error.join(','));
  const k = Object.keys(j.result).find(x => x !== 'last');
  return j.result[k].map(x => ({ time: +x[0], open: +x[1], high: +x[2], low: +x[3], close: +x[4], vwap: +x[5], volume: +x[6] }));
}

/* Replay record for a setup (monitor/backtest.js results): most specific group with 20+ graded trades.
   Plain numbers, never a probability for this one trade. */
function trackLine(bt, e) {
  if (!bt || !bt.groups) return '';
  const keys = e.kind === 'sweep' ? [`sweep|${e.tf}|${e.dir}`, `sweep|${e.tf}`, e.withTrend ? 'sweep|with_trend' : 'sweep|counter_trend', 'sweep'] : [`fvg|${e.tf}|${e.dir}`, `fvg|${e.tf}`, 'fvg'];
  for (const k of keys) { const g = bt.groups[k]; if (!g || !g.all || g.all.n < 20) continue;
    const h = g.heldOut || {}, pct = x => Math.round(x * 100) + '%', r = x => (x >= 0 ? '+' : '') + x.toFixed(2) + 'R';
    return ` Replay (${k.replace(/\|/g, ' ')}, ${g.all.n} past setups): ${pct(g.all.winRate)} winners, avg ${r(g.all.avgR)} after fees${h.n ? `; held-out ${h.n}: avg ${r(h.avgR)}` : ''}.`; }
  return ' Replay: fewer than 20 past setups of this kind, too few to judge.';
}

/* Market profile match: past hours with the same traits (js/profile.js) and what followed. Frequencies, not probabilities. */
function profileLine(pm) {
  if (!pm || !pm.match) return '';
  const m = pm.match, h = m.held || {};
  return ` Past hours like this (${m.n}, ${m.traits.length} traits): 24h median ${m.med24 >= 0 ? '+' : ''}${m.med24}%, higher after 24h ${Math.round(m.upShare24 * 100)}% of the time${h.n ? `; held-out ${h.n}: ${Math.round(h.upShare24 * 100)}%` : ''}.`;
}
/* A clear lean: 50+ cases, >= 62% (or <= 38%) higher after 24h, and the held-out period (15+) on the same side of 50%. */
function strongLean(m) {
  if (!m || m.n < 50 || !m.held || m.held.n < 15) return null;
  if (m.upShare24 >= 0.62 && m.held.upShare24 > 0.5) return 'higher';
  if (m.upShare24 <= 0.38 && m.held.upShare24 < 0.5) return 'lower';
  return null;
}

/* Context from free sources, shown with a setup; never blocks it or changes size (Pattern Lab rule: cautions only lower size,
   and only once tested). hl = Hyperliquid per coin; _intel = Pattern Lab's intel.json (BTC only), ignored if over 12h old. */
function contextLine(market, sym, dir) {
  const out = [], h = market[sym] && market[sym].hl, I = market._intel;
  if (h) out.push(`Hyperliquid funding ${(h.funding * 24 * 365 * 100).toFixed(1)}%/yr${h.oiUsd ? `, OI $${(h.oiUsd / 1e6).toFixed(0)}M` : ''}`);
  if (I && sym === 'BTC/USD') {
    const cs = ((I.context || {})[dir] || []).filter(c => c.status === 'caution');
    out.push(cs.length ? `${cs.length} caution${cs.length > 1 ? 's' : ''} for a ${dir}: ${cs.map(c => c.text).join(' ')}` : `No context cautions for a ${dir}.`);
    const t = (I.hyperliquid || {}).top || {}, lb = (t.liq_below || [])[0], la = (t.liq_above || [])[0];
    const ef = I.etf_issuer && !I.etf_issuer.stale && I.etf_issuer.funds && I.etf_issuer.funds.IBIT;
    if (ef && ef.flow_usd != null) out.push(`IBIT ETF flow ${ef.flow_date}: ${ef.flow_usd >= 0 ? '+' : '-'}$${Math.abs(ef.flow_usd / 1e6).toFixed(0)}M (BlackRock's file; fund-reported, not intraday buying)`);
    if (lb || la) out.push(`Top-40 trader liquidations nearest: ${lb ? 'below ' + C.fmtPx(lb[0]) : ''}${lb && la ? ', ' : ''}${la ? 'above ' + C.fmtPx(la[0]) : ''} (Hyperliquid only)`);
  }
  return out.length ? ' Context: ' + out.join('. ') + '.' : '';
}

/* Pure decision step (tested): given market data, the watch file and the previous state, return alerts to send and the new state. */
function evaluate(watch, market, prev, now, opt) {
  // lastSummary was one number for all accounts (old state files); now one per account.
  const ls = prev && prev.lastSummary, lastSum = typeof ls === 'number' ? { _all: ls } : Object.assign({}, ls || {});
  const G = C.alertGate(prev, now, { cooldown: COOLDOWN, keep: KEEP });   // shared with the app's alerts
  const state = G.state, fired = G.fired, fire = G.fire;
  state.lastSummary = lastSum;
  const positions = (watch.positions || []).filter(p => !p.closed);
  const syms = [...new Set(((watch.symbols || ['BTC/USD'])).concat(positions.map(p => p.sym)))];
  const heavy = new Set((opt && opt.heavy) || syms);   // coins that get the full candle check this run
  const prices = {};
  for (const s of Object.keys(market)) { const m = market[s]; if (s[0] !== '_' && m && m.price) prices[s] = m.price; }
  const stale = market._ageSec != null && market._ageSec > 600;
  const data = {};
  for (const s of syms) {
    const m = market[s]; if (!m) continue;
    const st = {}, fv = {}, at = {};
    if (!heavy.has(s)) {   // light check: price and 1h ATR only (stop distance, target, breach)
      if (m.c[60] && m.c[60].length > 15) at[60] = C.atr(m.c[60].slice(0, -1), 14);
      data[s] = { sym: s, struct: st, fvg: fv, atr: at, price: prices[s], light: true }; continue;
    }
    for (const iv of IV) if (m.c[iv] && m.c[iv].length > 10) st[iv] = C.structure(m.c[iv]);
    for (const iv of [15, 60, 240]) if (m.c[iv] && m.c[iv].length > 20) fv[iv] = C.liveFvgs(m.c[iv], 6);
    for (const iv of [15, 60]) if (m.c[iv] && m.c[iv].length > 15) at[iv] = C.atr(m.c[iv].slice(0, -1), 14);
    data[s] = { sym: s, struct: st, fvg: fv, atr: at, price: prices[s], ageSec: 0, c: { 15: m.c[15], 60: m.c[60] }, levels: C.keyLevels(m.c[1440], m.c[15], { tz: 'America/New_York' }) };
  }
  const watchAgeH = watch.updated ? (now - watch.updated) / 3600e3 : null;
  for (const a of (watch.accounts || []).filter(a => a.phase === 'eval' || a.phase === 'funded')) {
    const R = C.accountReview(a, positions, prices, now, { orders: watch.orders || [] }), A = R.state;   // working limit orders count in risk and margin
    const name = a.label || 'Prop account';
    if (A.breached) fire(`${a.id}|breach`, 3, `⛔ ${name}: at the breach line`, `Equity ~${C.fmtUsd(A.equity)} vs floor ${C.fmtUsd(A.floor)}. Check your prop platform now.`, 5);
    else if (A.room < A.profRisk) fire(`${a.id}|room`, 2, `${name}: room below one trade`, `Room ${C.fmtUsd(A.room)} (${A.binding} limit). No new trades today.`, 4);
    if (!A.riskKnown && A.open) fire(`${a.id}|nostop`, 2, `${name}: a position has no stop`, 'Risk is unlimited until it has one. Set it on your platform, then re-import.', 4);
    else if (A.stopsBreach) fire(`${a.id}|stopsbreach`, 2, `${name}: stops sit past the breach line`, `If every stop fills, equity lands near ${C.fmtUsd(A.equityIfStopped)}; floor ${C.fmtUsd(A.floor)}.`, 4);
    if (A.reachedTarget) fire(`${a.id}|target`, 1, `🎯 ${name}: equity at the profit target`, 'Check your prop platform (some firms auto-close at the target).', 4);
    for (const p of positions.filter(p => p.acct === a.id)) {
      const px = prices[p.sym];
      if (px == null) { fire(`${p.sym}|noprice`, 2, `${p.sym}: monitor can't see the price`, `Kraken data didn't load this run, so stop and target checks for your ${p.sym} position are paused. Check your platform yourself.`, 4); continue; }
      const d = p.side === 'short' ? -1 : 1, tag = `${p.sym} ${p.side} ${p.qty}@${C.fmtPx(p.entry)}`;
      if (p.stop != null) {
        const toStop = d * (px - p.stop), a1 = (data[p.sym] && data[p.sym].atr[60]) || px * 0.004;
        if (toStop <= 0) fire(`${p.id}|stophit`, 3, `${tag}: price through the stop`, `Price ${C.fmtPx(px)}, stop ${C.fmtPx(p.stop)}. It probably filled; re-import to sync.`, 4);
        else if (toStop < a1 * 0.3) fire(`${p.id}|stopnear`, 2, `${tag}: close to the stop`, `Price ${C.fmtPx(px)}, stop ${C.fmtPx(p.stop)} (${C.fmtPx(toStop)} away). Plan says hold or exit; don't widen it.`, 3);
      }
      const tgt = p.tp1 != null ? p.tp1 : p.tp2;
      if (tgt != null && d * (px - tgt) >= 0) fire(`${p.id}|tp`, 1, `${tag}: target reached`, `Price ${C.fmtPx(px)} at/through target ${C.fmtPx(tgt)}. Re-import to sync.`, 3);
      if (p.partialAt != null && d * (px - p.partialAt) >= 0) fire(`${p.id}|partial|${p.partialAt}`, 1, `${tag}: at your partial level`, `Price ${C.fmtPx(px)} reached ${C.fmtPx(p.partialAt)}. If your plan banks a partial here, close part by hand (Kraken Prop has no partial TP orders), then re-import.`, 3);
      const dd = data[p.sym];
      if (dd && !dd.light) { const h = C.health(p, { price: px, ageSec: 0, struct: dd.struct, fvg: dd.fvg, levels: dd.levels, atr: dd.atr, acct: A, rules: watch.rules || {}, entryStruct: dd.struct[p.tf] || dd.struct[15], now });
        if (h.score != null && h.score <= 2) fire(`${p.id}|health`, 3 - h.score, `${tag}: health ${h.score}/5`, h.proposal + '. ' + h.items.filter(i => i.k !== 'inferred').slice(0, 2).map(i => i.t).join(' '), 4); }
    }
    // Daily summary right after the 00:30 UTC reset.
    const had = state.lastSummary[a.id] != null ? state.lastSummary[a.id] : state.lastSummary._all;
    if (!had || had < A.reset) {
      if (now - A.reset < 12 * 3600e3) fired.push({ key: `summary|${a.id}`, acct: a.id, prevSummary: had, title: `${name}: new trading day`, body: `Equity ~${C.fmtUsd(A.equity)}, daily floor ${C.fmtUsd(A.dailyFloor)}, room ${C.fmtUsd(A.room)}. ${A.open} open. ${R.lines.slice(0, 2).map(l => l.t).join(' ')}`, prio: 2 });
      state.lastSummary[a.id] = A.reset;
    }
  }
  // Setups, both directions, all the time, no account involved (owner's rule, Nov 1 2026). Market rules only;
  // the account is weighed in the app when he ticks the idea.
  for (const s of syms) {
    if (!data[s] || data[s].light) continue;
    for (const e of C.scanSetups(s, data[s], now)) {
      if (!C.alertWorthy(e, prices[s], data[s].atr && data[s].atr[60])) continue;   // M2: replay alert grade (V4) AND valid in the market now
      if (((watch.rules && watch.rules.benched) || []).includes(C.setupKey(e.kind, e.tf))) continue;   // benched by him on the Scorecard
      const chosen = (watch.rules && watch.rules.traits) || [], tc = market[s].traits;
      if (chosen.length && !(tc && chosen.every(id => tc[id] === e.dir))) continue;   // his chosen trait filters must all agree
      const x = C.confirmElsewhere(e, market[s].xfvg);
      if (x.status !== 'confirmed') { continue; }   // only gaps two venues agree on
      fire(`entry|${e.key}`, 1, `✅ ${s} ${C.tfName(e.tf)} ${e.dir.toUpperCase()} ${e.kind === 'sweep' ? 'sweep ' : ''}setup${e.open ? ' (' + e.open + ')' : ''}: market rules pass`,
        `${e.text}${(() => { const tc = market[s].traits; if (!tc) return ''; const agree = Object.keys(tc).filter(k => tc[k] === e.dir); return agree.length ? ' Traits agreeing: ' + agree.join(', ') + '.' : ''; })()} ${e.kind === 'sweep' ? 'Coinbase shows the same sweep.' : 'Same gap seen on Coinbase candles.'}${trackLine(market._bt, e)}${profileLine(market[s].profile)}${contextLine(market, s, e.dir)} Tick it in Prop Desk to weigh it against your account. Untested idea, not a signal. Your call.`, 4);
    }
  }
  // Market profile: one alert when the hour's traits match past hours that clearly leaned one way (observation, not a signal).
  for (const s of syms) {
    const pm = market[s] && market[s].profile, lean = pm && strongLean(pm.match);
    if (!lean) continue;
    const m = pm.match;
    fire(`${s}|ctx|${m.key}`, 1, `${s}: market matches past hours that mostly went ${lean}`,
      `Now: ${P.describe(pm.f)}. ${m.n} past hours with ${m.traits.join(', ')} alike: 24h later ${lean === 'higher' ? Math.round(m.upShare24 * 100) : Math.round((1 - m.upShare24) * 100)}% were ${lean}, median ${m.med24 >= 0 ? '+' : ''}${m.med24}% (middle half ${m.p25_24}% to ${m.p75_24}%); held-out ${m.held.n}: ${Math.round(m.held.upShare24 * 100)}% higher. Past frequencies on Coinbase data, not a forecast.`, 3);
  }
  // Impulse legs on 1h/4h: alert once when price pulls back into the OTE zone (0.618-0.786), with the volume read. Observation, not a signal.
  for (const s of syms) {
    const m = market[s], dd = data[s]; if (!m || !dd || dd.light) continue;
    for (const iv of [60, 240]) {
      if (!(m.c[iv] && m.c[iv].length > 40)) continue;
      for (const L of C.impulseLegs(m.c[iv], { price: prices[s] })) {
        if (L.status !== 'in_ote') continue;
        const vr = { continuation_signs: 'volume shows continuation signs', reversal_warning: 'volume warns of a reversal', unclear: 'volume unclear', unknown: 'no volume data' }[L.vol.read];
        fire(`${s}|fib|${iv}|${L.dir}|${L.start.time}`, 1, `${s} ${C.tfName(iv)} pullback into OTE of the ${L.dir} leg`,
          `${C.tfName(iv)} impulse ${C.fmtPx(L.start.price)}→${C.fmtPx(L.end.price)} (${L.atrMult.toFixed(1)}× ATR) is ${Math.round(L.retraceNow * 100)}% retraced: 0.618 ${C.fmtPx(L.fibs.find(f => f.r === 0.618).price)}, 0.786 ${C.fmtPx(L.fibs.find(f => f.r === 0.786).price)}; ${vr}. Observation, not a signal: look for your own trigger.`, 3);
      }
    }
  }
  // Paper trades (monitor/paper.json from the app): alert when one reaches its stop or target, and when the paper account breaches or
  // passes. The app records the close itself next time it opens (from candles). Paper only, no money.
  const PP = market._paper;
  if (PP && Array.isArray(PP.trades)) {
    for (const t of PP.trades.filter(t => t.status === 'open')) {
      const px = prices[t.sym]; if (px == null) continue;
      const d = t.side === 'short' ? -1 : 1, hitS = d * (px - t.stop) <= 0, hitT = t.target != null && d * (px - t.target) >= 0;
      if (hitS || hitT) { const ex = hitS ? t.stop : t.target, R = C.paperR(t, ex, now);
        fire(`paper|${t.id}|${hitS ? 'stop' : 'target'}`, 1, `📝 Paper ${t.sym} ${t.side}: ${hitS ? 'stop' : 'target'} hit`, `${hitS ? 'Stop' : 'Target'} ${C.fmtPx(ex)} reached (price ${C.fmtPx(px)}): about ${R >= 0 ? '+' : ''}${R.toFixed(2)}R after fees. Paper trade, no money; open the app to record it.`, 2); }
    }
    const pa = (PP.accounts || []).find(a => a.status === 'active');
    if (pa) { const st = C.accountState(pa, C.paperPositions(PP.trades, pa.id), prices, now);
      if (st.breached) fire(`paper|${pa.id}|breach`, 1, `📝 Paper account breached`, `${pa.label}: equity ~${C.fmtUsd(st.equity)} at the breach line ${C.fmtUsd(st.floor)}. Simulated only; start a new one in the Paper tab.`, 3);
      else if (st.reachedTarget) fire(`paper|${pa.id}|pass`, 1, `📝 Paper account passed`, `${pa.label}: equity ~${C.fmtUsd(st.equity)} reached the target. Simulated only.`, 3); }
  }
  // Squeezes / fast moves (observations, not signals)
  for (const s of syms) {
    const m = market[s], dd = data[s]; if (!m || !dd || dd.light) continue;
    const c15 = m.c[15] || [], c60 = m.c[60] || [], a15 = dd.atr[15], a1 = dd.atr[60];
    const l15 = c15[c15.length - 2], l60 = c60[c60.length - 2];
    if (!l15 || !a15) continue;
    const move15 = l15.close - l15.open, big15 = Math.abs(l15.high - l15.low) > 2 * a15, move60 = l60 && a1 ? l60.close - l60.open : 0;
    const up = move15 > 0 && (big15 || move60 > 1.5 * a1), dn = move15 < 0 && (big15 || -move60 > 1.5 * a1);
    if (up && m.funding != null && m.funding < 0) fire(`${s}|sqz|up`, 2, `⚡ ${s}: short squeeze signs`, `Fast push up (${C.fmtPx(l15.low)}→${C.fmtPx(l15.high)} on 15m) with negative funding. Shorts at risk.`, 4);
    else if (dn && m.funding != null && m.funding > 0) fire(`${s}|sqz|dn`, 2, `⚡ ${s}: long squeeze signs`, `Fast drop (${C.fmtPx(l15.high)}→${C.fmtPx(l15.low)} on 15m) with positive funding. Longs at risk.`, 4);
    else if (Math.abs(l15.high - l15.low) > 2.5 * a15) fire(`${s}|fast`, 1, `${s}: fast 15m move`, `Range ${C.fmtPx(Math.abs(l15.high - l15.low))} vs normal ${C.fmtPx(a15)}.`, 3);
  }
  if (positions.length && watchAgeH != null && watchAgeH > 24) fire('watch|stale', 1, 'Monitor data is over a day old', 'Re-import your Kraken screenshots and tap "Send to monitor" so alerts match your real positions.', 2);
  if (stale) fire('feed|stale', 1, 'Monitor: market data stale', 'Kraken public data looked old this run; alerts may be late.', 2);
  // Coins not fully checked this run keep their health/setup/squeeze memory, so nothing repeats when their turn comes.
  const posSym = {}; for (const p of positions) posSym[p.id] = p.sym;
  const heavyKeySym = k => { const x = k.split('|'); return x[1] === 'health' ? posSym[x[0]] : x[0] === 'entry' ? x[1] : (x[1] === 'sqz' || x[1] === 'fast' || x[1] === 'fib' || x[1] === 'ctx') ? x[0] : null; };
  for (const [k, v] of Object.entries((prev && prev.active) || {})) if (state.active[k] == null) { const s = heavyKeySym(k); if (s && !heavy.has(s)) state.active[k] = v; }
  const all = state.lastSummary._all; delete state.lastSummary._all;
  if (all) for (const a of (watch.accounts || [])) if (state.lastSummary[a.id] == null) state.lastSummary[a.id] = all;
  // Most urgent first, so the per-run cap never holds back a breach behind an entry idea.
  return { fired: C.alertQueue(fired), state };
}

/* After sending: anything not delivered (over the cap, or ntfy failed) is forgotten, so the next run sends it as new. */
function settle(state, prev, undelivered) {
  const rest = [];
  for (const f of undelivered) {
    if (f.key.startsWith('summary|')) { if (f.prevSummary) state.lastSummary[f.acct] = f.prevSummary; else delete state.lastSummary[f.acct]; continue; }
    rest.push(f);
  }
  return C.alertSettle(state, prev, rest);
}

// ntfy JSON publish keeps emoji in the title; returns true only if ntfy accepted it.
async function send(topic, f) {
  try {
    const r = await fetch('https://ntfy.sh/', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic, title: f.title, message: f.body, priority: f.prio || 3, tags: [f.prio >= 5 ? 'rotating_light' : 'chart_with_upwards_trend'] }) });
    return r.ok;
  } catch (e) { return false; }
}

/* Coins that get the full candle check. rotate=true (5-minute Worker): one coin per run, in turn, to stay inside the
   free CPU limit. Open positions still get the price checks (stop, target, breach, room) every run. */
function heavyFor(watch, now, rotate) {
  const all = [...new Set((watch.symbols || ['BTC/USD']).concat((watch.positions || []).filter(p => !p.closed).map(p => p.sym)))];
  return rotate ? [all[Math.floor(now / 300e3) % all.length]] : all;
}
// Tolerate a paste that landed below old content: use the last complete JSON object in the file.
function parseWatch(text) {
  try { return JSON.parse(text); } catch (e) { }
  const i = String(text || '').lastIndexOf('\n{');
  if (i >= 0) try { return JSON.parse(text.slice(i + 1)); } catch (e) { }
  return null;
}
async function futTicker(sym, cache) {
  try { const j = await getJson('https://futures.kraken.com/derivatives/api/v3/tickers/' + pf(sym)); if (j.ticker && j.ticker.markPrice != null) return j.ticker; } catch (e) { }
  if (!cache.all) { try { cache.all = (await getJson('https://futures.kraken.com/derivatives/api/v3/tickers')).tickers || []; } catch (e) { cache.all = []; } }
  return cache.all.find(x => x.symbol === pf(sym)) || null;
}

/* One monitor run. o = { topic, log, rotate, env: { PATTERN_LAB_TOKEN, PATTERN_LAB_REPO } }. Returns the new memory; the caller saves it. */
async function runOnce(watch, prev, now, o) {
  o = o || {}; prev = prev || {};
  const log = o.log || (() => { }), env = o.env || {};
  const positions = (watch.positions || []).filter(p => !p.closed);
  const heavy = heavyFor(watch, now, o.rotate);
  const want = [...new Set(heavy.concat(positions.map(p => p.sym)))];
  const market = {}, cache = {};
  let usdt = null, newest = null;
  try { const j = await getJson('https://api.kraken.com/0/public/Ticker?pair=USDTUSD'); const k = Object.keys(j.result)[0]; usdt = +j.result[k].c[0]; } catch (e) { log('usdt: ' + e.message); }
  // Hyperliquid public info API (free, no key): funding, open interest, premium per coin.
  let hl = null;
  try { const r = await fetch('https://api.hyperliquid.xyz/info', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'metaAndAssetCtxs' }) });
    if (r.ok) { const [meta, ctx] = await r.json(); hl = {}; meta.universe.forEach((u, i) => { const x = ctx[i]; if (x) hl[u.name] = { funding: +x.funding, oiUsd: +x.openInterest * +x.markPx, premium: +x.premium }; }); } } catch (e) { log('hyperliquid: ' + e.message); }
  // Pattern Lab's free-source context (optional): secret PATTERN_LAB_TOKEN (read-only) + variable PATTERN_LAB_REPO (owner/name).
  if (env.PATTERN_LAB_TOKEN && env.PATTERN_LAB_REPO) {
    try { const r = await fetch(`https://api.github.com/repos/${env.PATTERN_LAB_REPO}/contents/pipeline/data/intel.json`, { headers: { Authorization: 'Bearer ' + env.PATTERN_LAB_TOKEN, Accept: 'application/vnd.github.raw+json', 'User-Agent': 'prop-desk-monitor' } });
      if (r.ok) { const I = await r.json(), t = Date.parse(String(I.asof || '').replace(' UTC', 'Z').replace(' ', 'T'));
        if (t && now - t < 12 * 3600e3) market._intel = I; else log('pattern lab intel too old, ignored'); } else log('pattern lab: ' + r.status); } catch (e) { log('pattern lab: ' + e.message); }
  }
  // Replay results (monitor/backtest.json), read from the repo with the same read-only key as watch.json.
  if (env.GH_TOKEN && env.GH_REPO) {
    try { const r = await fetch(`https://api.github.com/repos/${env.GH_REPO}/contents/monitor/backtest.json`, { headers: { Authorization: 'Bearer ' + env.GH_TOKEN, Accept: 'application/vnd.github.raw+json', 'User-Agent': 'prop-desk-monitor' } });
      if (r.ok) market._bt = await r.json(); } catch (e) { log('backtest: ' + e.message); }
  } else if (o.readLocal) { market._bt = o.readLocal('backtest.json'); }
  // Paper trades file (optional): same read-only key as watch.json.
  if (env.GH_TOKEN && env.GH_REPO) { try { const r = await fetch(`https://api.github.com/repos/${env.GH_REPO}/contents/monitor/paper.json`, { headers: { Authorization: 'Bearer ' + env.GH_TOKEN, Accept: 'application/vnd.github.raw+json', 'User-Agent': 'prop-desk-monitor' } }); if (r.ok) market._paper = await r.json(); } catch (e) { log('paper: ' + e.message); } }
  else if (o.readLocal) market._paper = o.readLocal('paper.json');
  if (market._paper && Array.isArray(market._paper.trades)) for (const t of market._paper.trades) if (t.status === 'open' && !want.includes(t.sym)) want.push(t.sym);
  for (const s of want) {
    const c = {}, full = heavy.includes(s);
    for (const iv of (full ? IV : [60])) {
      try { c[iv] = await candles(s, iv, full ? null : Math.floor(now / 1000) - 30 * 3600); const L = c[iv][c[iv].length - 1]; if (L) { const end = L.time + iv * 60; if (newest == null || end > newest) newest = end; } }
      catch (e) { log(s + ' ' + iv + ' ' + e.message); }
    }
    const t = await futTicker(s, cache);
    const mark = t ? +t.markPrice : null;
    const k = C.calibration(watch.calib || [], s, now);
    const est = C.propEstimate(mark, usdt);
    const last = (c[15] || c[60] || []).slice(-1)[0], spot = last ? last.close : null;
    // Second venue for the setup cross-check (full check only): Coinbase public candles (15m, 1h; 4h built from 1h).
    const xfvg = {};
    if (full) try {
      const cb = async g => (await getJson(`https://api.exchange.coinbase.com/products/${s.replace('/', '-')}/candles?granularity=${g}`)).map(([t, l, h, o, cl]) => ({ time: t, open: o, high: h, low: l, close: cl })).sort((a, b) => a.time - b.time);
      const c15 = await cb(900), c60 = await cb(3600), c240 = [];
      for (const x of c60) { const t = Math.floor(x.time / 14400) * 14400, L = c240[c240.length - 1];
        if (L && L.time === t) { L.high = Math.max(L.high, x.high); L.low = Math.min(L.low, x.low); L.close = x.close; } else c240.push({ time: t, open: x.open, high: x.high, low: x.low, close: x.close }); }
      const done = (arr, sec) => arr.filter(x => x.time + sec <= now / 1000);   // closed candles only
      xfvg.c = { 15: done(c15, 900), 60: done(c60, 3600) };
      xfvg[15] = C.liveFvgs(done(c15, 900), 6); xfvg[60] = C.liveFvgs(done(c60, 3600), 6); xfvg[240] = C.liveFvgs(done(c240, 14400), 6);
    } catch (e) { log(s + ' coinbase: ' + e.message); }
    market[s] = { xfvg, hl: hl && hl[s.split('/')[0]], c, price: est != null ? est * (1 + k.bps / 1e4) : (mark || spot), funding: t ? +t.fundingRate : null, oi: t ? +t.openInterest : null };
  }
  // Market profile: traits of the last closed hour (Kraken candles) + the matching shard from the repo.
  for (const s of heavy) {
    const m = market[s]; if (!m || !m.c[60] || !m.c[1440]) continue;
    try {
      const h = m.c[60].slice(0, -1), d = m.c[1440].slice(0, -1), f = P.featuresAt(h, d, h.length - 1);
      if (!f) continue;
      let shard = null;
      if (env.GH_TOKEN && env.GH_REPO) { const r = await fetch(`https://api.github.com/repos/${env.GH_REPO}/contents/monitor/profile/${P.shardName(f)}.json`, { headers: { Authorization: 'Bearer ' + env.GH_TOKEN, Accept: 'application/vnd.github.raw+json', 'User-Agent': 'prop-desk-monitor' } }); if (r.ok) shard = await r.json(); }
      else if (o.readLocal) shard = o.readLocal('profile/' + P.shardName(f) + '.json');
      if (shard) m.profile = { f, match: P.match({ keys: shard, minN: P.MIN_N }, f) };
      const x = TR.ctxAt(h, d, h.length - 1); if (x) { m.traits = {}; for (const t of TR.TRAITS) m.traits[t.id] = t.side(x, shard ? { keys: shard, minN: P.MIN_N } : null); }
    } catch (e) { log(s + ' profile: ' + e.message); }
  }
  market._ageSec = newest != null ? now / 1000 - newest : null;   // > 0: even the newest candle has closed, data is late
  const { fired, state } = evaluate(watch, market, prev, now, { heavy });
  if (!o.topic) log('NTFY_TOPIC not set: alerts printed only, not sent');
  const undelivered = fired.slice(MAX_PER_RUN);
  let sent = 0;
  for (const f of fired.slice(0, MAX_PER_RUN)) {
    log('ALERT ' + f.title);
    if (!o.topic) continue;
    if (await send(o.topic, f)) sent++; else { log('ntfy did not accept it; will retry next run'); undelivered.push(f); }
  }
  if (fired.length > MAX_PER_RUN) log(`held back ${fired.length - MAX_PER_RUN} alerts for the next run (anti-spam)`);
  settle(state, prev, undelivered);
  const changed = JSON.stringify([prev.active || {}, prev.sent || {}, prev.lastSummary || null]) !== JSON.stringify([state.active, state.sent, state.lastSummary || null]);
  return { fired, sent, state, changed, checked: heavy };
}

// GitHub / local run: reads monitor/watch.json, saves monitor/state.json.
async function main() {
  // Node only (GitHub backup run). Kept out of runOnce so the Cloudflare Worker bundle has no Node file APIs.
  const fs = require('fs'), path = require('path');
  const readLocal = f => { try { return JSON.parse(fs.readFileSync(path.join(__dirname, f), 'utf8')); } catch (e) { return null; } };
  const WATCH = path.join(__dirname, 'watch.json'), STATE = path.join(__dirname, 'state.json');
  let text = ''; try { text = fs.readFileSync(WATCH, 'utf8'); } catch (e) { }
  const watch = parseWatch(text);
  if (!watch) { console.log('no monitor/watch.json yet'); return; }
  let prev = {}; try { prev = JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch (e) { }
  const r = await runOnce(watch, prev, Date.now(), { topic: process.env.NTFY_TOPIC, log: console.log, env: process.env, readLocal });
  if (r.changed) fs.writeFileSync(STATE, JSON.stringify(r.state, null, 1));
  console.log(r.fired.length ? `${r.fired.length} alert(s)` : 'quiet', r.changed ? '(memory updated)' : '');
}
if (typeof require !== 'undefined' && require.main === module) main().catch(e => { console.error(e); process.exit(1); });
module.exports = { evaluate, settle, contextLine, trackLine, profileLine, strongLean, runOnce, parseWatch, heavyFor, send };
