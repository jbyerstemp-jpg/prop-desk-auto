// Prop Desk market profile: describes every past hour with a few measurable traits, records what happened next, and
// finds the past hours that match the market now. Built from data/history (Coinbase public candles).
// Plain past frequencies, not probabilities or predictions. Research for his own decisions.
//
// Traits of an hour (only data known when that hour closed):
//   d1    daily structure bias (core.js structure on closed daily bars): bull / bear / range
//   h4    4h structure bias (4h built from 1h): bull / bear / range
//   vol   1h ATR(14) as % of price, vs the last 90 days of the same: low (bottom third) / mid / high (top third)
//   rv    1h relative volume (core.js rvol): quiet < 0.8 / normal / busy > 1.5
//   pos   close vs the prior UTC day's range: below_pdl / lower_half / upper_half / above_pdh
//   r24   last 24h change: dump <= -3% / down -3..-1 / flat -1..+1 / up +1..+3 / rip >= +3%
//   ses   New York time: asia 20-03 / london 03-08 / ny 08-16 / late 16-20
// What happened next: change after 4h and 24h, and the biggest move up/down within 24h (as % and in 1h ATRs).
(function (root) {
'use strict';
const C = (typeof module !== 'undefined' && module.exports) ? require('./core.js') : root.Core;
const ORDER = ['d1', 'h4', 'vol', 'pos', 'r24', 'rv', 'ses'];   // most to least important; matching drops from the end
const MIN_N = 30;

const stub = a => a.concat([{ ...a[a.length - 1], time: a[a.length - 1].time + 1 }]);   // helpers ignore the last row (forming bar)
const to4h = c60 => { const o = []; for (const x of c60) { const t = Math.floor(x.time / 14400) * 14400, L = o[o.length - 1];
  if (L && L.time === t) { L.high = Math.max(L.high, x.high); L.low = Math.min(L.low, x.low); L.close = x.close; L.volume += x.volume; } else o.push({ ...x, time: t }); } return o; };
const bucket = (x, cuts, names) => { for (let i = 0; i < cuts.length; i++) if (x < cuts[i]) return names[i]; return names[names.length - 1]; };

/* Traits of the 1h bar c60[i] (closed), using only bars that had closed by then. c1d = closed daily bars. cache = optional {}. */
function featuresAt(c60, c1d, i, cache) {
  cache = cache || {};
  const b = c60[i], tClose = b.time + 3600;
  if (i < 24 * 10) return null;            // 10+ days of hourly bars (volatility rank uses up to 90 days, fewer live on Kraken's 30)
  // daily bias: closed days before this hour's close
  const dKey = Math.floor(tClose / 86400);
  if (cache.dKey !== dKey) { cache.dKey = dKey; let j = c1d.length; while (j > 0 && c1d[j - 1].time + 86400 > tClose) j--;
    const d = c1d.slice(Math.max(0, j - 150), j); cache.d1 = d.length > 20 ? C.structure(stub(d)).bias : null; cache.prevDay = d[d.length - 1] || null; }
  // 4h bias: closed 4h bars
  const hKey = Math.floor(tClose / 14400);
  if (cache.hKey !== hKey) { cache.hKey = hKey; const h = to4h(c60.slice(Math.max(0, i - 900), i + 1)).filter(x => x.time + 14400 <= tClose);
    cache.h4 = h.length > 20 ? C.structure(stub(h.slice(-180))).bias : null; }
  if (!cache.d1 || !cache.h4 || !cache.prevDay) return null;
  // volatility: ATR% now vs the last 90 days (percentile)
  const atrPct = j => { let s = 0; for (let k = j - 13; k <= j; k++) { const x = c60[k], p = c60[k - 1]; s += Math.max(x.high - x.low, Math.abs(x.high - p.close), Math.abs(x.low - p.close)); } return s / 14 / c60[j].close; };
  if (!cache.atr) cache.atr = [];
  cache.atr[i] = atrPct(i);
  const hist = []; for (let k = Math.max(15, i - 2160); k < i; k += 6) { if (cache.atr[k] == null) cache.atr[k] = atrPct(k); hist.push(cache.atr[k]); }
  const rank = hist.filter(x => x < cache.atr[i]).length / Math.max(1, hist.length);
  const rv = C.rvol(c60, i);
  const pd = cache.prevDay, mid = (pd.high + pd.low) / 2;
  const r24 = b.close / c60[i - 24].close - 1;
  const hNY = new Date(tClose * 1000 - 3600e3).toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false }) | 0;
  return {
    d1: cache.d1, h4: cache.h4,
    vol: rank < 1 / 3 ? 'low' : rank > 2 / 3 ? 'high' : 'mid',
    pos: b.close > pd.high ? 'above_pdh' : b.close < pd.low ? 'below_pdl' : b.close >= mid ? 'upper_half' : 'lower_half',
    r24: bucket(r24, [-0.03, -0.01, 0.01, 0.03], ['dump', 'down', 'flat', 'up', 'rip']),
    rv: rv == null ? 'normal' : rv < 0.8 ? 'quiet' : rv > 1.5 ? 'busy' : 'normal',
    ses: (hNY >= 20 || hNY < 3) ? 'asia' : hNY < 8 ? 'london' : hNY < 16 ? 'ny' : 'late',
    atrPct: cache.atr[i],
  };
}
function outcomeAt(c60, i) {
  if (i + 24 >= c60.length) return null;
  const p = c60[i].close; let hi = -Infinity, lo = Infinity;
  for (let k = i + 1; k <= i + 24; k++) { hi = Math.max(hi, c60[k].high); lo = Math.min(lo, c60[k].low); }
  return { r4: c60[i + 4].close / p - 1, r24: c60[i + 24].close / p - 1, up24: hi / p - 1, dn24: lo / p - 1 };
}
const keyOf = (f, depth) => ORDER.slice(0, depth).map(k => k + '=' + f[k]).join('&');

function agg(list) {
  const n = list.length; if (!n) return null;
  const q = (arr, p) => { const s = arr.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
  const r24 = list.map(x => x.r24), r4 = list.map(x => x.r4);
  const pct = x => +(x * 100).toFixed(2);
  return { n, upShare24: +(r24.filter(x => x > 0).length / n).toFixed(3), med24: pct(q(r24, 0.5)), p25_24: pct(q(r24, 0.25)), p75_24: pct(q(r24, 0.75)),
    med4: pct(q(r4, 0.5)), upShare4: +(r4.filter(x => x > 0).length / n).toFixed(3), medUp24: pct(q(list.map(x => x.up24), 0.5)), medDn24: pct(q(list.map(x => x.dn24), 0.5)) };
}

/* Build the profile for one or more coins. Hours are sampled every 4h so neighbouring, overlapping hours don't count many times. */
function build(series, opt) {
  opt = opt || {};
  const rows = [];
  for (const [sym, s] of Object.entries(series)) {
    const c60 = s[60], c1d = s[1440], cache = {};
    for (let i = 24 * 30; i < c60.length; i++) {
      if ((c60[i].time / 3600) % (opt.every || 4) !== 0) continue;
      const f = featuresAt(c60, c1d, i, cache); if (!f) continue;
      const o = outcomeAt(c60, i); if (!o) continue;
      rows.push({ sym, t: c60[i].time, f, o });
    }
  }
  rows.sort((a, b) => a.t - b.t);
  if (!rows.length) return null;
  const cut = rows[Math.floor(rows.length * 0.7)].t;
  const groups = {};
  for (const r of rows) for (let d = 1; d <= ORDER.length; d++) { const k = keyOf(r.f, d); (groups[k] = groups[k] || []).push(r); }
  const out = {};
  for (const [k, list] of Object.entries(groups)) {
    if (list.length < 10) continue;
    const a = agg(list.map(r => r.o)), dev = agg(list.filter(r => r.t < cut).map(r => r.o)), ho = agg(list.filter(r => r.t >= cut).map(r => r.o));
    out[k] = Object.assign(a, { dev: dev ? { n: dev.n, med24: dev.med24, upShare24: dev.upShare24 } : null, held: ho ? { n: ho.n, med24: ho.med24, upShare24: ho.upShare24 } : null });
  }
  const base = agg(rows.map(r => r.o));
  return { version: 1, made: Date.now(), samples: rows.length, from: rows[0].t, to: rows[rows.length - 1].t, heldOutFrom: cut, order: ORDER, minN: MIN_N, base, keys: out,
    note: 'Past hours with the same traits and what followed (all coins pooled, every 4th hour). Frequencies, not probabilities; held-out = last 30% of the period.' };
}

/* Most specific match with at least MIN_N past cases. Returns null if even the broadest level is thin. */
function match(profile, f) {
  if (!profile || !f) return null;
  for (let d = ORDER.length; d >= 2; d--) { const k = keyOf(f, d), s = profile.keys[k];
    if (s && s.n >= (profile.minN || MIN_N)) return Object.assign({ key: k, depth: d, traits: ORDER.slice(0, d) }, s); }
  return null;
}
const describe = f => f ? `daily ${f.d1}, 4h ${f.h4}, volatility ${f.vol}, ${f.pos.replace('_', ' ')}, 24h ${f.r24}, volume ${f.rv}, ${f.ses} session` : '';

/* Split for the monitor: one small file per daily+4h trend pair, so a 5-minute run only loads the slice it needs. */
function shards(p) {
  const out = {}, meta = Object.assign({}, p, { keys: {} });
  for (const [k, v] of Object.entries(p.keys)) { const m = /^d1=(\w+)&h4=(\w+)/.exec(k);
    if (!m) { meta.keys[k] = v; continue; }
    const s = m[1] + '_' + m[2]; (out[s] = out[s] || {})[k] = v; if (k.split('&').length === 2) meta.keys[k] = v; }
  return { meta, shards: out };
}
const shardName = f => f ? f.d1 + '_' + f.h4 : null;
const API = { featuresAt, outcomeAt, build, match, describe, keyOf, shards, shardName, ORDER, MIN_N, to4h };
if (typeof module !== 'undefined' && module.exports) module.exports = API; else root.PDProfile = API;
})(typeof window !== 'undefined' ? window : globalThis);
