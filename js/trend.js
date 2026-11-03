// Daily trend-following systems (H15, pre-registered and tested Nov 2, 2026; S2 passed, label 3). One copy of the rules, used by the
// backtest (monitor/trend-test.js) and by the app's paper-forward card, so the two can't drift apart. Signals at the daily close, fills
// at the next daily open, a 2 x ATR20 protective stop placed at entry and never widened. Costs in R. Research, not financial advice.
(function (root) {
'use strict';
const FEE = 0.0004, SLIP = 0.0002, SWAP_DAY = 0.00033, DAY = 86400, WARM = 60;
const atr20 = (c, i) => { if (i < 21) return null; let s = 0; for (let k = i - 19; k <= i; k++) s += Math.max(c[k].high - c[k].low, Math.abs(c[k].high - c[k - 1].close), Math.abs(c[k].low - c[k - 1].close)); return s / 20; };
const sma = (c, i, n) => { if (i < n - 1) return null; let s = 0; for (let k = i - n + 1; k <= i; k++) s += c[k].close; return s / n; };
const hiN = (c, i, n) => { let h = -Infinity; for (let k = i - n; k < i; k++) h = Math.max(h, c[k].high); return h; };
const loN = (c, i, n) => { let l = Infinity; for (let k = i - n; k < i; k++) l = Math.min(l, c[k].low); return l; };
/* entry(c, i): +1 long, -1 short, 0 none, from the close of day i. exit(c, i, dir): true when the open position should close. */
function system(kind, p) {
  if (kind === 'donchian') return { entry: (c, i) => i < p.n + 1 ? 0 : c[i].close > hiN(c, i, p.n) ? 1 : c[i].close < loN(c, i, p.n) ? -1 : 0,
    exit: (c, i, d) => d > 0 ? c[i].close < loN(c, i, p.x) : c[i].close > hiN(c, i, p.x) };
  return { entry: (c, i) => { const f = sma(c, i, p.fast), s = sma(c, i, p.slow); if (f == null || s == null) return 0; return c[i].close > s && f > s ? 1 : c[i].close < s && f < s ? -1 : 0; },
    exit: (c, i, d) => { const f = sma(c, i, p.fast); return f != null && (d > 0 ? c[i].close < f : c[i].close > f); } };
}
const S2 = () => system('sma', { fast: 20, slow: 50 });   // the system that passed H15
const L = (n, k) => Math.max(2, Math.round(n * (k == null ? 1 : k)));   // lookback scaled for the ±20% check
/* The six H18 daily trend rules (E1 = S2). H19 trend portfolio = all six on each coin at 1/6 size, no picking (passed, label 3).
   exit(c, i, dir, pos) -> true = leave at the next open. Used by monitor/strategy-lab.js, monitor/trend-portfolio.js and the Paper tab. */
const ENTRIES = {
  E1: k => ({ entry: (c, i) => { const f = sma(c, i, L(20, k)), s = sma(c, i, L(50, k)); if (f == null || s == null) return 0; return c[i].close > s && f > s ? 1 : c[i].close < s && f < s ? -1 : 0; },
    exit: (c, i, d) => { const f = sma(c, i, L(20, k)); return f != null && (d > 0 ? c[i].close < f : c[i].close > f); } }),
  E2: k => ({ entry: (c, i) => c[i].close > hiN(c, i, L(20, k)) ? 1 : c[i].close < loN(c, i, L(20, k)) ? -1 : 0,
    exit: (c, i, d) => d > 0 ? c[i].close < loN(c, i, L(10, k)) : c[i].close > hiN(c, i, L(10, k)) }),
  E3: k => ({ entry: (c, i) => { const n = L(30, k); if (i < n) return 0; const r = c[i].close / c[i - n].close - 1; return r > 0 ? 1 : r < 0 ? -1 : 0; },
    exit: (c, i, d) => { const n = L(30, k); return d * (c[i].close / c[i - n].close - 1) <= 0; } }),
  E4: k => ({ entry: (c, i) => { const f = sma(c, i, L(50, k)), s = sma(c, i, L(200, k)); if (f == null || s == null) return 0; return f > s ? 1 : f < s ? -1 : 0; },
    exit: (c, i, d) => { const f = sma(c, i, L(50, k)), s = sma(c, i, L(200, k)); return f != null && s != null && d * (f - s) <= 0; } }),
  E5: k => ({ entry: (c, i) => { const f = sma(c, i, L(20, k)), s = sma(c, i, L(50, k)), fp = sma(c, i - 1, L(20, k)); if (f == null || s == null || fp == null) return 0;
      if (f > s && c[i].close > s && c[i - 1].close < fp && c[i].close > f) return 1; if (f < s && c[i].close < s && c[i - 1].close > fp && c[i].close < f) return -1; return 0; },
    exit: (c, i, d) => { const s = sma(c, i, L(50, k)); return s != null && (d > 0 ? c[i].close < s : c[i].close > s); } }),
  E6: k => ({ entry: (c, i) => { const a = atr20(c, i - 1), s = sma(c, i, L(50, k)); if (!a || s == null) return 0; const m = c[i].close - c[i - 1].close;
      return m > a && c[i].close > s ? 1 : m < -a && c[i].close < s ? -1 : 0; },
    exit: (c, i, d, pos) => i - pos.i0 + 1 >= L(10, k) })
};
const RULE_NAMES = { E1: '20/50-day average trend', E2: '20-day breakout (exit 10-day)', E3: '30-day momentum', E4: '50/200-day cross', E5: 'pullback in a 20/50 trend', E6: 'big-day thrust (10-day hold)' };
const PORT = { rules: Object.keys(ENTRIES), w: 1 / 6, warm: 210 };   // as tested in H19 (strategy-lab warm-up 210 days)
const costR = (entry, exit, risk, days) => ((FEE + SLIP) * (entry + exit) + SWAP_DAY * days * entry) / risk;
/* Walk closed daily candles. opt.closeAtEnd: count a still-open trade at the last close (backtest); otherwise return it as `open`.
   opt.warm: first day to check (default WARM; the H19 portfolio uses 210). opt.from: keep only trades ENTERED at or after this unix time (paper-forward: nothing entered before the start counts). */
function run(c, sys, sym, opt) {
  opt = opt || {}; const out = []; let pos = null;
  const close = (j, px, why) => {
    const d = pos.dir, days = Math.max(1, (c[j].time - pos.t) / DAY + (why === 'stop' ? 0.5 : 0)), gross = d * (px - pos.entry) / pos.risk;
    if (opt.from == null || pos.t >= opt.from) out.push({ sym, t: pos.t, exitT: c[j].time, dir: d, entry: pos.entry, exit: px, stop: pos.stop, days: +days.toFixed(1), R: gross - costR(pos.entry, px, pos.risk, days), why, i0: pos.i0, atr: pos.atr });
    pos = null;
  };
  for (let i = opt.warm || WARM; i < c.length - 1; i++) {
    if (pos) { const d = pos.dir, hit = d > 0 ? c[i].low <= pos.stop : c[i].high >= pos.stop;
      if (hit && i >= pos.i0) close(i, d > 0 ? Math.min(c[i].open, pos.stop) : Math.max(c[i].open, pos.stop), 'stop'); }
    if (pos && sys.exit(c, i, pos.dir, pos)) close(i + 1, c[i + 1].open, 'rule');
    if (!pos) { const s = sys.entry(c, i), a = atr20(c, i);
      if (s && a) { const e = c[i + 1].open; pos = { dir: s, entry: e, stop: e - s * 2 * a, risk: 2 * a, i0: i + 1, t: c[i + 1].time, atr: a }; } }
  }
  let open = null;
  if (pos) {   // a stop touched on the last closed day still counts
    const L = c.length - 1, d = pos.dir;
    if (opt.closeAtEnd) close(L, c[L].close, 'end');   // backtest rule as tested (H15)
    else if (L >= pos.i0 && (d > 0 ? c[L].low <= pos.stop : c[L].high >= pos.stop)) close(L, d > 0 ? Math.min(c[L].open, pos.stop) : Math.max(c[L].open, pos.stop), 'stop');
    else if (opt.from == null || pos.t >= opt.from) open = Object.assign({ sym }, pos);
  }
  return opt.closeAtEnd ? out : { trades: out, open };
}
/* What the rule says at the last closed day (for the card), whatever the position: +1 / -1 / 0, with the two averages. */
function stateNow(c, p) {
  p = p || { fast: 20, slow: 50 }; const i = c.length - 1; if (i < p.slow) return null;
  const f = sma(c, i, p.fast), s = sma(c, i, p.slow), x = c[i].close;
  return { close: x, fast: f, slow: s, rule: x > s && f > s ? 1 : x < s && f < s ? -1 : 0, atr: atr20(c, i), day: c[i].time };
}
/* H19 trend portfolio on one coin: every rule run on its own; trades and open positions carry the rule and its 1/6 weight. */
function portfolio(c, sym, opt) {
  const o = Object.assign({}, opt, { warm: PORT.warm }), out = { trades: [], open: [] };
  for (const e of PORT.rules) { const r = run(c, ENTRIES[e](1), sym, o), tag = x => Object.assign(x, { rule: e, w: PORT.w });
    if (o.closeAtEnd) { out.trades.push(...r.map(tag)); continue; }
    out.trades.push(...r.trades.map(tag)); if (r.open) out.open.push(tag(r.open)); }
  return out;
}
/* Open R of an open trend trade at a price (after costs to date). */
function openR(o, px, nowSec) { const days = Math.max(0, (nowSec - o.t) / DAY); return o.dir * (px - o.entry) / o.risk - costR(o.entry, px, o.risk, days); }
const api = { FEE, SLIP, SWAP_DAY, WARM, atr20, sma, hiN, loN, system, S2, ENTRIES, RULE_NAMES, PORT, costR, run, portfolio, stateNow, openR, BACKTEST: { avgR: 0.069, winRate: 0.419, n: 2491, label: 3 },
  BACKTEST_PORT: { n: 4483, avgR: 0.24, winRate: 0.39, heldN: 2878, heldAvgR: 0.125, heldPerYearR: 12.199, maxDrawdownR: -13.422, label: 3 } };   // H19, monitor/trend-portfolio.json (R per rule-trade at full size; portfolio R = R x 1/6)
if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.PDTrend = api;
})(typeof self !== 'undefined' ? self : this);
