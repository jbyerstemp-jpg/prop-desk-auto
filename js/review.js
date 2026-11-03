// Prop Desk "What did I miss?" (owner's idea, Nov 2 2026): he marks a move on the chart (where it started, where it ended) on the
// 15m, 1h or 4h chart, and the coach lists what was measurable BEFORE the move started, what only showed up during it, and, for
// honesty, how often each of those signs appeared in the loaded history WITHOUT a move that size following. Saved reviews become data
// the model learns from. No look-ahead: everything in "before" uses only candles closed by the start time. Signs are untested ideas,
// not signals. Research for his own decisions, not financial advice.
(function (root) {
'use strict';
const C = root.Core || (typeof require !== 'undefined' ? require('./core.js') : null);
const IVS = [15, 60, 240, 1440];
/* Per chart timeframe: the "higher" timeframes it is read against, how far back "before" looks, and the scanner settings
   (15m = the app's live scanner; 1h/4h = the slow-setups replay's settings, monitor/slow-test.js). */
const CFG = {
  15: { hi: [240, 60], fvgTfs: ['60', '240'], window: 16, need: { 15: 60, 60: 60, 240: 30 } },
  60: { hi: [1440, 240], fvgTfs: ['240', '1440'], window: 8, need: { 60: 60, 240: 30, 1440: 20 }, scan: { tfs: ['60', '240'], sweepTfs: ['60'], atrKey: '60', poolTfs: ['60', '240'] } },
  240: { hi: [1440], fvgTfs: ['1440'], window: 6, need: { 240: 60, 1440: 30 }, scan: { tfs: ['240', '1440'], sweepTfs: ['240'], atrKey: '240', poolTfs: ['240', '1440'] } }
};
const stub = a => a.length ? a.concat([Object.assign({}, a[a.length - 1], { time: a[a.length - 1].time + 1 })]) : a;
const closedBy = (arr, tSec, iv) => { let lo = 0, hi = arr.length; while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m].time + iv * 60 <= tSec) lo = m + 1; else hi = m; } return arr.slice(Math.max(0, lo - 720), lo); };
const hrs = h => h >= 24 && h % 24 === 0 ? (h / 24) + ' day' + (h > 24 ? 's' : '') : h + ' h';

/* The app's view of the market at tSec (unix s), from candles closed by then, for chart timeframe tf. */
function snapshot(sym, cs, tSec, tf) {
  tf = tf || 15; const cfg = CFG[tf], s = {};
  for (const iv of IVS) s[iv] = closedBy(cs[iv] || [], tSec, iv);
  for (const [iv, n] of Object.entries(cfg.need)) if (s[iv].length < n) return null;
  const data = { sym, price: s[tf][s[tf].length - 1].close, struct: {}, fvg: {}, atr: {}, c: {} };
  for (const iv of IVS) if (s[iv].length >= 20) { data.struct[iv] = C.structure(stub(s[iv])); data.fvg[iv] = C.liveFvgs(stub(s[iv]), 6); data.atr[iv] = C.atr(s[iv], 14); data.c[iv] = stub(s[iv]); }
  data.levels = s[1440].length ? C.keyLevels(stub(s[1440]), s[15].length ? stub(s[15]) : null, { tz: 'America/New_York' }) : [];
  return { data, s, tf };
}
/* Setups the app knows at this moment, in the shape the review uses: {kind, tf, dir, ready, missing[]}. */
function setupsAt(sym, data, tSec, tf) {
  const cfg = CFG[tf];
  if (!cfg.scan) return C.scanSetups(sym, data, tSec * 1000).map(u => ({ kind: u.kind, tf: u.tf, dir: u.dir, ready: u.ready, missing: (u.rules || []).filter(r => !r.ok).map(r => r.t) }));
  const a = data.atr[cfg.scan.atrKey] || 0, px = data.price;
  const f = C.setupsToWatch(sym, data, { both: true, tfs: cfg.scan.tfs, atrKey: cfg.scan.atrKey, poolTfs: cfg.scan.poolTfs }).map(u => {
    const at = Math.abs(px - u.entry) <= 0.25 * a; return { kind: 'fvg', tf: u.tf, dir: u.dir, ready: at, missing: at ? [] : ['price at the zone'] }; });
  const sw = C.sweepSetups(sym, data, tSec * 1000, { tfs: cfg.scan.sweepTfs, atrKey: cfg.scan.atrKey, poolTfs: cfg.scan.poolTfs, minPen: 0.25 })
    .map(u => ({ kind: 'sweep', tf: u.tf, dir: u.dir, ready: !!u.ready, missing: u.ready ? [] : (u.rules || []).filter(r => !r.ok).map(r => r.t) }));
  return f.concat(sw);
}
/* The signs at one moment, for direction d (+1 up / -1 down). Each is true/false/null (null = can't tell). */
function signsAt(sym, snap, tSec, d) {
  const { data, s, tf } = snap, cfg = CFG[tf], want = d > 0 ? 'bull' : 'bear', px = data.price, a = data.atr[tf === 15 ? 60 : tf] || 0, dir = d > 0 ? 'long' : 'short';
  const ups = setupsAt(sym, data, tSec, tf), st = data.struct[tf];
  const recent = st && st.events ? st.events.filter(e => e.time >= tSec - cfg.window * tf * 60) : [];
  const atFvg = cfg.fvgTfs.some(k => (data.fvg[k] || []).some(g => g.dir === want && px <= g.top + 0.25 * a && px >= g.bottom - 0.25 * a));
  const lv = (data.levels || []).filter(l => ['day', 'week', 'session'].includes(l.kind)), atLevel = a > 0 && lv.some(l => Math.abs(px - l.price) <= 0.25 * a);
  const c = s[tf], i = c.length - 1, rv = i >= 20 ? C.rvol(c, i, 20) : null, hi = cfg.hi.map(k => data.struct[k] ? data.struct[k].bias === want : null);
  return {
    readySetup: ups.some(u => u.ready && u.dir === dir), sweep: ups.some(u => u.kind === 'sweep' && u.ready && u.dir === dir), wrongWay: ups.some(u => u.ready && u.dir !== dir),
    structTf: recent.some(e => e.dir === (d > 0 ? 'up' : 'down')), trendHi: hi[0], trendHi2: hi.length > 1 ? hi[1] : null,
    atFvg, atLevel, volume: rv != null ? rv >= 1.5 : null, ups: ups.filter(u => u.dir === dir).slice(0, 4)
  };
}
const SIGNS = {
  readySetup: 'The app had a ready setup this way', sweep: 'A level was swept and price closed back (liquidity grab) this way',
  structTf: 'Structure on this chart broke this way just before', trendHi: 'The next timeframe up trended this way', trendHi2: 'The timeframe above that trended this way',
  atFvg: 'Price was at a higher-timeframe fair value gap on this side', atLevel: 'Price was at a day/week/session level', volume: 'The start candle had 1.5x+ normal volume',
  wrongWay: 'The app had a ready setup the OTHER way'
};
/* Sign names for one chart timeframe, so the modal says exactly what was checked. */
function signLabels(tf) {
  const cfg = CFG[tf], L = Object.assign({}, SIGNS), w = hrs(cfg.window * tf / 60);
  L.structTf = `${C.tfName(tf)} structure broke this way in the ${w} before`; L.trendHi = `${C.tfName(cfg.hi[0])} trend pointed this way`;
  L.trendHi2 = cfg.hi[1] ? `${C.tfName(cfg.hi[1])} trend pointed this way` : SIGNS.trendHi2;
  L.atFvg = `Price was at a ${cfg.fvgTfs.map(C.tfName).join('/')} fair value gap on this side`;
  return L;
}
const WINDOW = ['readySetup', 'sweep', 'wrongWay'];               // these count if they showed up any time in the window before
/* Signs at every close of the chart timeframe in the loaded history (each from candles closed by then), for direction d. */
function signGrid(sym, cs, d, tf) {
  tf = tf || 15; const c = cs[tf] || [], grid = [];
  for (let i = 0; i < c.length; i++) { const t = c[i].time + tf * 60, sn = snapshot(sym, cs, t, tf); grid.push(sn ? Object.assign(signsAt(sym, sn, t, d), { t, px: sn.data.price }) : null); }
  return grid;
}
function signsWithWindow(grid, i, win) {
  const g = grid[i]; if (!g) return null; const out = Object.assign({}, g);
  for (const k of WINDOW) for (let j = Math.max(0, i - win); j < i; j++) if (grid[j] && grid[j][k]) out[k] = true;
  return out;
}
/* Review of a move from t0 to t1 (unix s, open times of the tapped candles on chart timeframe opt.tf: 15, 60 or 240).
   cs = {15: [...], 60, 240, 1440} oldest first. Returns { tf, move, before, during, base, found }. */
function review(sym, cs, t0, t1, opt) {
  opt = opt || {}; const tf = opt.tf || 15, cfg = CFG[tf], sec = tf * 60;
  if (!cfg) return { error: 'Use the 15m, 1h or 4h chart to mark a move.' };
  if (t1 < t0) [t0, t1] = [t1, t0];
  const c = cs[tf] || [], i0 = c.findIndex(x => x.time === Math.floor(t0 / sec) * sec), i1 = c.findIndex(x => x.time === Math.floor(t1 / sec) * sec);
  if (i0 < 0 || i1 < 0 || i1 <= i0) return { error: `Pick two different candles inside the loaded ${C.tfName(tf)} history.` };
  const b0 = c[i0], b1 = c[i1], d = b1.close >= b0.close ? 1 : -1, path = c.slice(i0 + 1, i1 + 1);
  const ext = d > 0 ? Math.max(...path.map(x => x.high)) : Math.min(...path.map(x => x.low));
  const grid = opt.grid || signGrid(sym, cs, d, tf), before = signsWithWindow(grid, i0, cfg.window);
  if (!before) return { error: 'Not enough candle history before that point to read it (pick a move further right on the chart).' };
  const snap0 = snapshot(sym, cs, b0.time + sec, tf), a = snap0.data.atr[tf === 15 ? 60 : tf] || null, sizePct = (ext / b0.close - 1) * 100 * d, bars = i1 - i0;
  const move = { tf, dir: d > 0 ? 'up' : 'down', from: b0.close, to: ext, sizePct: +sizePct.toFixed(2), atr: a ? +(Math.abs(ext - b0.close) / a).toFixed(1) : null, atrTf: tf === 15 ? 60 : tf,
    hours: bars * tf / 60, t0: b0.time + sec, t1: b1.time + sec };
  const snapE = snapshot(sym, cs, b1.time + sec, tf), during = [];
  if (snapE) for (const iv of [tf, cfg.hi[cfg.hi.length - 1]]) { const ev = (snapE.data.struct[iv] && snapE.data.struct[iv].events || []).filter(e => e.time > b0.time && e.time <= b1.time && e.dir === (d > 0 ? 'up' : 'down'));
    if (ev.length) during.push(`${C.tfName(iv)} ${ev.map(e => e.kind).join(', ')} during the move (confirmation: only visible after it started)`); }
  // Base rates: at every other close in the history (outside this move and the window before it), which signs were there, and did
  // a move at least this big, this way, follow within the same number of bars? Signs that show up all the time without moves aren't warnings.
  const base = { _all: { n: 0, hits: 0 } }; for (const k of Object.keys(SIGNS)) base[k] = { n: 0, hits: 0 };
  for (let i = 0; i + bars < c.length; i++) {
    if (i >= i0 - cfg.window && i <= i1) continue;
    const g = signsWithWindow(grid, i, cfg.window); if (!g) continue;
    const fut = c.slice(i + 1, i + 1 + bars), p0 = c[i].close, best = d > 0 ? Math.max(...fut.map(x => x.high)) : Math.min(...fut.map(x => x.low));
    const hit = (best / p0 - 1) * 100 * d >= sizePct;
    base._all.n++; if (hit) base._all.hits++;
    for (const k of Object.keys(SIGNS)) if (g[k] === true) { base[k].n++; if (hit) base[k].hits++; }
  }
  // The setups the app itself had this way in the window before the start (the direct answer to "what was the setup I missed?")
  const seen = {}; for (let j = Math.max(0, i0 - cfg.window); j <= i0; j++) for (const u of (grid[j] && grid[j].ups) || []) {
    const k = u.kind + '|' + u.tf, mins = (i0 - j) * tf; if (!seen[k] || (u.ready && !seen[k].ready)) seen[k] = Object.assign({}, u, { minsBefore: mins }); }
  return { sym, tf, move, before, during, base, found: Object.values(seen).sort((x, y) => y.ready - x.ready) };
}
const ago = m => m >= 60 ? (m / 60).toFixed(m % 60 ? 1 : 0) + ' h' : m + ' min';
/* Plain-English lines for the modal and for "Copy for Claude". */
function lines(r) {
  if (r.error) return [r.error];
  const m = r.move, out = [], all = r.base._all, pAll = all && all.n ? all.hits / all.n : null, L = signLabels(r.tf || 15), unit = C.tfName(r.tf || 15);
  out.push(`${r.sym} (${unit} chart): ${m.dir === 'up' ? '▲' : '▼'} ${m.sizePct}% in ${hrs(m.hours)} (${m.atr != null ? m.atr + '× ' + C.tfName(m.atrTf) + ' ATR' : 'ATR unknown'}).`);
  if (all && all.n) out.push(`A move this big, this way, within ${hrs(m.hours)} followed ${all.hits} of ${all.n} random ${unit} closes in the loaded history (${(100 * pAll).toFixed(1)}%). ${all.hits < 5 ? ' A move this big is too rare in the loaded history to judge any sign by it: save it anyway; saved moves add up.' : ' Signs below are worth watching only if their rate beats that.'}`);
  const ready = (r.found || []).filter(u => u.ready), near = (r.found || []).filter(u => !u.ready);
  const nm = u => `${u.kind === 'sweep' ? 'Liquidity sweep' : 'FVG retest'} on ${C.tfName(u.tf)}`;
  if (ready.length) out.push(`SETUP: ${ready.map(u => `${nm(u)} (ready ${u.minsBefore ? ago(u.minsBefore) + ' before the start' : 'at the start'})`).join('; ')}. Check the history rate below before trusting it.`);
  else if (near.length) out.push(`SETUP: none was ready. Closest: ${nm(near[0])}, missing: ${near[0].missing.join('; ') || '—'}.`);
  else out.push('SETUP: none of the setups the app knows (FVG retests, liquidity sweeps) was there before this move. Nothing measurable gave it away.');
  for (const k of Object.keys(SIGNS)) {
    const v = r.before[k], b = r.base[k]; if (v == null) continue;
    const rate = b && b.n ? ` · in history: ${b.n}× seen, a move this size followed ${b.hits}× (${(100 * b.hits / b.n).toFixed(1)}%${pAll != null ? ` vs ${(100 * pAll).toFixed(1)}% at any time` : ''})` : '';
    out.push(`${v ? '✔' : '✘'} ${L[k]}${v ? rate : ''}`);
  }
  for (const x of r.during) out.push('• ' + x);
  return out;
}
/* Saved reviews -> per sign: how often it was there before his marked moves, next to its base rate. Learning data, not a signal. */
function lessons(saved) {
  const out = {}; for (const k of Object.keys(SIGNS)) out[k] = { label: SIGNS[k], before: 0, of: 0, baseN: 0, baseHits: 0 };
  for (const r of saved || []) for (const k of Object.keys(SIGNS)) { const v = r.before && r.before[k]; if (v == null) continue; out[k].of++; if (v) out[k].before++;
    const b = r.base && r.base[k]; if (b) { out[k].baseN += b.n; out[k].baseHits += b.hits; } }
  return out;
}
const api = { CFG, snapshot, signsAt, signGrid, review, lines, lessons, signLabels, SIGNS };
if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.PDReview = api;
})(typeof self !== 'undefined' ? self : this);
