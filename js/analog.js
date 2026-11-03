// Prop Desk analog matcher (H7, Nov 2 2026): describe an hour by measured numbers, find the past hours that look most like it, and
// report what price did next. Past frequencies, not predictions. Used by monitor/analog-test.js (the honest out-of-sample test) and,
// if the test earns it, by the app. No look-ahead: a feature uses only bars closed by that hour; a neighbour's outcome is only used
// when it was already known at the query hour. Research for his own decisions, not financial advice.
(function (root) {
'use strict';

const NAMES = ['r1', 'r4', 'r24', 'r72', 'rvol', 'vchg4', 'volRatio', 'pos24', 'trend20d', 'hsin', 'hcos', 'wkend'];
const GROUP = { momentum: [0, 1, 2, 3], volume: [4, 5], volatility: [6], position: [7, 8], time: [9, 10, 11] };
const NCONT = 9;                                           // the first 9 are standardised per coin; the last 3 are used as they are
const W_DEFAULT = [0.7, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1.5];   // fixed before testing; r1 (1-hour move) is noisy so it counts less
const HOUR = 3600;

/* Raw features of hourly bar c[i] (closed), oldest-first array of {time, open, high, low, close, volume}; null when there isn't
   30 days of unbroken hourly history behind it. */
function featureAt(c, i) {
  if (i < 719 || !c[i]) return null;
  const b = c[i];
  if (b.time - c[i - 719].time !== 719 * HOUR) return null;                 // a gap inside the 30-day window: skip this hour
  const L = Math.log, cl = c[i].close;
  // volume: this hour vs the median of the 20 hours before; last 4 hours vs the 4 before that
  const prev = []; for (let k = i - 20; k < i; k++) prev.push(c[k].volume); prev.sort((x, y) => x - y);
  const med = (prev[9] + prev[10]) / 2;
  let v4 = 0, v4p = 0; for (let k = 0; k < 4; k++) { v4 += c[i - k].volume; v4p += c[i - 4 - k].volume; }
  if (!(med > 0) || !(b.volume > 0) || !(v4 > 0) || !(v4p > 0)) return null;
  // volatility: mean hourly range % over the last 24 h vs the last 30 days
  let r24 = 0, r720 = 0, hi = -Infinity, lo = Infinity, sum480 = 0;
  for (let k = 0; k < 720; k++) { const x = c[i - k], rg = (x.high - x.low) / x.close; r720 += rg; if (k < 24) { r24 += rg; hi = Math.max(hi, x.high); lo = Math.min(lo, x.low); } if (k < 480) sum480 += x.close; }
  if (!(r24 > 0) || !(r720 > 0)) return null;
  const hour = Math.floor(b.time / HOUR) % 24, dow = (Math.floor(b.time / 86400) + 4) % 7;   // 1970-01-01 was a Thursday; 0 = Sunday
  return [L(cl / c[i - 1].close), L(cl / c[i - 4].close), L(cl / c[i - 24].close), L(cl / c[i - 72].close), L(b.volume / med), L(v4 / v4p),
    L((r24 / 24) / (r720 / 720)), hi > lo ? (cl - lo) / (hi - lo) : 0.5, L(cl / (sum480 / 480)),
    Math.sin(2 * Math.PI * hour / 24), Math.cos(2 * Math.PI * hour / 24), dow === 0 || dow === 6 ? 1 : 0];
}

/* Per-coin mean and sd of the first 9 features, from rows given (use only the early part of history, never the test period). */
function fitScaler(rows) {
  const m = new Array(NCONT).fill(0), s = new Array(NCONT).fill(0); let n = 0;
  for (const f of rows) { if (!f) continue; n++; for (let k = 0; k < NCONT; k++) m[k] += f[k]; }
  if (n < 2) return null;
  for (let k = 0; k < NCONT; k++) m[k] /= n;
  for (const f of rows) { if (!f) continue; for (let k = 0; k < NCONT; k++) s[k] += (f[k] - m[k]) ** 2; }
  return { mean: m, sd: s.map(v => Math.sqrt(v / (n - 1)) || 1) };
}
/* Standardised vector (first 9: z-scores clipped to ±4; last 3 unchanged). `use` = optional array of feature indexes to keep (others 0). */
function standardize(f, sc, use) {
  const z = new Float32Array(NAMES.length);
  for (let k = 0; k < NAMES.length; k++) {
    if (use && !use.includes(k)) { z[k] = 0; continue; }
    z[k] = k < NCONT ? Math.max(-4, Math.min(4, (f[k] - sc.mean[k]) / sc.sd[k])) : f[k];
  }
  return z;
}

/* lib = { n, d, f: Float32Array(n*d), time: Int32Array(n) (sorted oldest first), coin: Uint8Array(n), gross: { H: Float32Array(n) (NaN = unknown) } }
   The K nearest past hours for each horizon in Hs, among rows whose outcome was known at qTime (time <= qTime - (H+1) h).
   Returns { H: { idx: [...], mean, sd, n, nEff (separate H-hour windows among them), up } }. */
function nearest(lib, q, qTime, Hs, w, K, M) {
  w = w || W_DEFAULT; K = K || 200; M = M || 3000;
  const d = lib.d, out = {};
  const pOf = H => { let lo = 0, hi = lib.n; const lim = qTime - (H + 1) * HOUR; while (lo < hi) { const m = (lo + hi) >> 1; if (lib.time[m] <= lim) lo = m + 1; else hi = m; } return lo; };
  const pmax = Math.max(...Hs.map(pOf)), dist = new Float32Array(pmax);
  for (let r = 0; r < pmax; r++) { let s = 0; const o = r * d; for (let k = 0; k < d; k++) { const x = q[k] - lib.f[o + k]; s += w[k] * x * x; } dist[r] = s; }
  for (const H of Hs) {
    const p = pOf(H), hd = new Float32Array(M), hi = new Int32Array(M); let hn = 0;      // max-heap of the M nearest
    const up = (a) => { while (a > 0) { const par = (a - 1) >> 1; if (hd[par] >= hd[a]) break; [hd[par], hd[a]] = [hd[a], hd[par]]; [hi[par], hi[a]] = [hi[a], hi[par]]; a = par; } };
    const down = (a) => { for (;;) { let l = 2 * a + 1, r2 = l + 1, m = a; if (l < hn && hd[l] > hd[m]) m = l; if (r2 < hn && hd[r2] > hd[m]) m = r2; if (m === a) break; [hd[m], hd[a]] = [hd[a], hd[m]]; [hi[m], hi[a]] = [hi[a], hi[m]]; a = m; } };
    const g = lib.gross[H];
    for (let r = 0; r < p; r++) { if (!(g[r] === g[r])) continue;
      if (hn < M) { hd[hn] = dist[r]; hi[hn] = r; up(hn++); } else if (dist[r] < hd[0]) { hd[0] = dist[r]; hi[0] = r; down(0); } }
    const cand = Array.from({ length: hn }, (_, k) => k).sort((a, b) => hd[a] - hd[b]).map(k => hi[k]);
    // The K nearest, as they are (thinning to non-overlapping windows was tried and found to bias the average: it picks the local noise
    // peaks of a trend). Overlapping outcomes are counted instead: nEff = how many separate H-hour windows (per coin) the neighbours
    // come from, which is what sets how sure the average is.
    const idx = cand.slice(0, K), win = new Set(); for (const r of idx) win.add(lib.coin[r] + ':' + Math.floor(lib.time[r] / (H * HOUR)));
    let mean = 0, up2 = 0; for (const r of idx) { mean += g[r]; if (g[r] > 0) up2++; } mean = idx.length ? mean / idx.length : 0;
    let sd = 0; for (const r of idx) sd += (g[r] - mean) ** 2; sd = idx.length > 1 ? Math.sqrt(sd / (idx.length - 1)) : 0;
    out[H] = { idx, mean, sd, n: idx.length, nEff: win.size, up: idx.length ? up2 / idx.length : 0, p };
  }
  return out;
}

/* Feature weights learned from data (never from the test period): w_k proportional to the mean over horizons of |rank correlation| between
   standardised feature k and the forward gross return, rows [0, upto) only; scaled so the weights average 1, floored at 0.05. Features
   that carry no information end up almost ignored, so the nearest hours are similar where it matters. */
function ranksOf(a) { const o = Array.from(a, (v, i) => [v, i]).sort((x, y) => x[0] - y[0]), r = new Float64Array(a.length); for (let i = 0; i < o.length;) { let j = i; while (j + 1 < o.length && o[j + 1][0] === o[i][0]) j++; const rk = (i + j) / 2; for (let k = i; k <= j; k++) r[o[k][1]] = rk; i = j + 1; } return r; }
function learnWeights(lib, upto, Hs) {
  const d = lib.d, rho = new Array(d).fill(0);
  for (const H of Hs) {
    const g = lib.gross[H], idx = []; for (let r = 0; r < upto; r++) if (g[r] === g[r]) idx.push(r);
    if (idx.length < 200) continue;
    const gr = ranksOf(idx.map(r => g[r])), m = (idx.length - 1) / 2, vg = gr.reduce((a, x) => a + (x - m) ** 2, 0);
    for (let k = 0; k < d; k++) { const fr = ranksOf(idx.map(r => lib.f[r * d + k])); let c = 0, vf = 0; for (let i = 0; i < idx.length; i++) { c += (fr[i] - m) * (gr[i] - m); vf += (fr[i] - m) ** 2; } rho[k] += Math.abs(vf > 0 && vg > 0 ? c / Math.sqrt(vf * vg) : 0) / Hs.length; }
  }
  const mean = rho.reduce((a, x) => a + x, 0) / d;
  return mean > 0 ? Float32Array.from(rho, x => Math.max(0.05, x / mean)) : Float32Array.from(W_DEFAULT);
}

const api = { learnWeights, NAMES, GROUP, NCONT, W_DEFAULT, featureAt, fitScaler, standardize, nearest };
if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.PDAnalog = api;
})(typeof self !== 'undefined' ? self : this);
