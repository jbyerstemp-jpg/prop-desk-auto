/* Prop Desk momentum & context traits (owner's request, Nov 1 2026). Written down BEFORE testing; graded by monitor/traits-test.js.
   Each trait looks only at closed bars and says 'long', 'short' or null (no view). Shared by the app, the monitor and the tests.
   Grades are past results on Coinbase data, not probabilities. */
(function (root) {
  'use strict';
  const node = typeof module !== 'undefined' && module.exports;
  const C = node ? require('./core.js') : root.Core, P = node ? require('./profile.js') : root.PDProfile;

  const emaLast = (c, n) => { const e = C.ema(c, n); return e.length ? e[e.length - 1].value : null; };
  function rsi(c, n) {
    n = n || 14; if (c.length < n + 1) return null;
    let g = 0, l = 0;
    for (let i = 1; i <= n; i++) { const d = c[i].close - c[i - 1].close; if (d > 0) g += d; else l -= d; }
    g /= n; l /= n;
    for (let i = n + 1; i < c.length; i++) { const d = c[i].close - c[i - 1].close; g = (g * (n - 1) + Math.max(d, 0)) / n; l = (l * (n - 1) + Math.max(-d, 0)) / n; }
    return l === 0 ? 100 : 100 - 100 / (1 + g / l);
  }
  /* Context at the 1h bar c60[i] (closed): profile traits + EMA 50/200, RSI 14, the bar itself. */
  function ctxAt(c60, c1d, i, cache) {
    const f = P.featuresAt(c60, c1d, i, cache); if (!f) return null;
    const w = c60.slice(Math.max(0, i - 400), i + 1), b = c60[i];
    return { f, px: b.close, up: b.close > b.open, ema50: emaLast(w, 50), ema200: emaLast(w, 200), rsi: rsi(w.slice(-120), 14), rv: C.rvol(c60, i), t: b.time };
  }
  const pick = (cond, l, s) => cond === 'l' ? 'long' : cond === 's' ? 'short' : null;
  const TRAITS = [
    { id: 'T1', name: 'Trend alignment', rule: 'daily and 4h structure both bullish (long) / both bearish (short)',
      side: x => x.f.d1 === 'bull' && x.f.h4 === 'bull' ? 'long' : x.f.d1 === 'bear' && x.f.h4 === 'bear' ? 'short' : null },
    { id: 'T2', name: '24h momentum', rule: 'last 24h up >= 1% (long) / down >= 1% (short)',
      side: x => (x.f.r24 === 'up' || x.f.r24 === 'rip') ? 'long' : (x.f.r24 === 'down' || x.f.r24 === 'dump') ? 'short' : null },
    { id: 'T3', name: 'EMA stack (1h)', rule: 'price > EMA50 > EMA200 (long) / price < EMA50 < EMA200 (short)',
      side: x => x.ema50 == null || x.ema200 == null ? null : (x.px > x.ema50 && x.ema50 > x.ema200) ? 'long' : (x.px < x.ema50 && x.ema50 < x.ema200) ? 'short' : null },
    { id: 'T4', name: 'RSI momentum (1h, 14)', rule: 'RSI > 55 (long) / < 45 (short)',
      side: x => x.rsi == null ? null : x.rsi > 55 ? 'long' : x.rsi < 45 ? 'short' : null },
    { id: 'T5', name: 'Volume push', rule: '1h volume >= 1.5x normal on an up bar (long) / down bar (short)',
      side: x => x.rv != null && x.rv >= 1.5 ? (x.up ? 'long' : 'short') : null },
    { id: 'T6', name: 'Range position', rule: 'close above the prior day high (long) / below the prior day low (short)',
      side: x => x.f.pos === 'above_pdh' ? 'long' : x.f.pos === 'below_pdl' ? 'short' : null },
    { id: 'T7', name: 'Active session + 4h trend', rule: 'London or New York hours, 4h bullish (long) / bearish (short)',
      side: x => (x.f.ses === 'london' || x.f.ses === 'ny') ? (x.f.h4 === 'bull' ? 'long' : x.f.h4 === 'bear' ? 'short' : null) : null },
    { id: 'T8', name: 'Market profile lean', rule: 'past matching hours (profile from the development period only) >= 62% higher (long) / <= 38% (short), 50+ cases',
      side: (x, prof) => { const m = prof && P.match(prof, x.f); if (!m || m.n < 50) return null; return m.upShare24 >= 0.62 ? 'long' : m.upShare24 <= 0.38 ? 'short' : null; } },
  ];
  /* Pre-registered grades. Filter grade: held-out (dev) = avg R of setups the trait agrees with minus avg R of all setups. */
  function gradeFilter(dev, held) {
    if (!held || held.n < 30) return { grade: 'I', why: `${held ? held.n : 0} held-out setups agree with it (need 30)` };
    if (held.avgR > 0 && held.lift >= 0.10 && dev && dev.lift > 0) return { grade: 'A', why: 'positive on held-out data and clearly better in both periods' };
    if (held.lift >= 0.05 && dev && dev.lift >= 0.05) return { grade: 'B', why: 'better in both periods' };
    if (held.lift > 0 && dev && dev.lift > 0) return { grade: 'C', why: 'slightly better in both periods' };
    if (held.lift > 0) return { grade: 'D', why: 'helped on held-out data but not in development' };
    return { grade: 'F', why: 'worse on held-out data' };
  }
  /* Direction grade: share of the trait's calls that were right 24h later, minus 50%, in percentage points. */
  function gradeDirection(dev, held) {
    if (dev && dev.heldOutOnly) { const e = held && held.edgePts; if (!held || held.n < 100) return { grade: 'I', why: `${held ? held.n : 0} held-out calls (need 100)` }; return { grade: e >= 5 ? 'A' : e >= 3 ? 'B' : e > 1 ? 'C' : 'F', why: `held-out only (profile built on development): right ${held.hit}% (${e >= 0 ? '+' : ''}${e} pts)` }; }
    if (!held || held.n < 100) return { grade: 'I', why: `${held ? held.n : 0} held-out calls (need 100)` };
    const e = held.edgePts, d = dev ? dev.edgePts : 0;
    if (e >= 5 && d >= 3) return { grade: 'A', why: `right ${held.hit}% held-out (+${e} pts), and in development` };
    if (e >= 3 && d >= 2) return { grade: 'B', why: `+${e} pts held-out, +${d} dev` };
    if (e > 1 && d > 1) return { grade: 'C', why: `small edge: +${e} pts held-out, +${d} dev` };
    if (e > 1 || d > 1) return { grade: 'D', why: `periods disagree (${d >= 0 ? '+' : ''}${d} dev, ${e >= 0 ? '+' : ''}${e} held-out)` };
    return { grade: 'F', why: `no better than a coin flip (${e >= 0 ? '+' : ''}${e} pts held-out)` };
  }
  const API = { TRAITS, ctxAt, rsi, gradeFilter, gradeDirection };
  if (node) module.exports = API; else root.PDTraits = API;
})(typeof window !== 'undefined' ? window : globalThis);
