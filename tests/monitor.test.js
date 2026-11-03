// Run: node tests/monitor.test.js — the monitor's alert decisions, with made-up market data.
const C = require('../js/core.js');
const { evaluate, settle, contextLine, heavyFor, parseWatch, trackLine, profileLine, strongLean } = require('../monitor/run.js');
let n = 0, fails = 0; const ok = (c, m) => { n++; if (!c) { fails++; console.log('FAIL', m); } };
const H = 3600e3, NOW = Date.UTC(2026, 10, 1, 4, 0);   // 11 PM Central, 3.5h after the reset
const flat = (px, iv, k, wiggle) => Array.from({ length: k }, (_, i) => { const t = Math.floor(NOW / 1000 / (iv * 60)) * iv * 60 - (k - 1 - i) * iv * 60; const w = (wiggle || 0.001) * px * ((i % 2) ? 1 : -1);
  return { time: t, open: px, high: px + Math.abs(w) + 1, low: px - Math.abs(w) - 1, close: px + w * 0.1, volume: 1 }; });
const mkt = (px, extra) => ({ 'BTC/USD': Object.assign({ price: px, funding: 0, c: { 15: flat(px, 15, 120), 60: flat(px, 60, 120), 240: flat(px, 240, 120), 1440: flat(px, 1440, 60) } }, extra || {}) });
const acct = { id: 'E', label: 'Advanced Eval 12', plan: 'advanced', size: 5000, phase: 'eval', profile: 'steady', created: NOW - 48 * H,
  anchor: { t: NOW - H, bal: 5070.42 }, dayStartOverride: { reset: C.lastReset(NOW), bal: 4929.1621 / 0.97 } };
const pos = (o) => Object.assign({ id: 'P1', acct: 'E', sym: 'BTC/USD', side: 'short', qty: 0.1, entry: 77606.1, stop: 78081.1, origStop: 78081.1, tp1: 76340.3, tf: 15, opened: NOW - 3 * H, partials: [], stopHist: [] }, o || {});
const watch = (ps) => ({ updated: NOW - H, accounts: [acct], positions: ps, symbols: ['BTC/USD'] });
const keys = r => r.fired.map(f => f.key);

// 1. Calm market far from the stop: only the once-a-day summary, then silence.
let r = evaluate(watch([pos()]), mkt(77700), {}, NOW);
ok(keys(r).join() === 'summary|E', 'calm: only daily summary -> ' + keys(r));
let r2 = evaluate(watch([pos()]), mkt(77700), r.state, NOW + 15 * 60e3);
ok(r2.fired.length === 0, 'calm second run: silent -> ' + keys(r2));

// 2. Price near the stop: one alert, not repeated next run, no repeat even after the cooldown while it stays near.
r = evaluate(watch([pos()]), mkt(78050), r2.state, NOW + 30 * 60e3);
ok(keys(r).includes('P1|stopnear'), 'near stop fires');
r2 = evaluate(watch([pos()]), mkt(78055), r.state, NOW + 45 * 60e3);
ok(!keys(r2).includes('P1|stopnear'), 'near stop not repeated');
const r3 = evaluate(watch([pos()]), mkt(78052), r2.state, NOW + 4 * H);
ok(!keys(r3).includes('P1|stopnear'), 'still near after 4h: still quiet (fires on change only)');

// 3. Price goes through the stop: new alert right away.
const r4 = evaluate(watch([pos()]), mkt(78100), r3.state, NOW + 4 * H + 15 * 60e3);
ok(keys(r4).includes('P1|stophit'), 'through stop fires');

// 4. Back away, then near again after the 2h cooldown: alerts again.
const r5 = evaluate(watch([pos()]), mkt(77700), r4.state, NOW + 5 * H);
const r6 = evaluate(watch([pos()]), mkt(78050), r5.state, NOW + 7 * H);
ok(keys(r6).includes('P1|stopnear'), 'new approach after cooldown fires again');

// 5. No stop: unlimited-risk alert.
r = evaluate(watch([pos({ stop: null, origStop: null })]), mkt(77700), { lastSummary: C.lastReset(NOW) }, NOW);
ok(keys(r).includes('E|nostop'), 'no stop alert');

// 6. Target reached.
r = evaluate(watch([pos()]), mkt(76300), { lastSummary: C.lastReset(NOW) }, NOW);
ok(keys(r).includes('P1|tp'), 'target alert');

// 7. Short squeeze: last closed 15m candle ranges 3x normal upward with negative funding.
{
  const m = mkt(77700, { funding: -1e-6 });
  const c = m['BTC/USD'].c[15]; const k = c.length - 2;
  c[k] = { time: c[k].time, open: 77600, high: 78400, low: 77580, close: 78350, volume: 9 };
  r = evaluate(watch([]), m, { lastSummary: C.lastReset(NOW) }, NOW);
  ok(keys(r).includes('BTC/USD|sqz|up'), 'short squeeze alert -> ' + keys(r));
}

// 8. Anti-spam: never more than the alerts that changed; a stale watch file nags once.
r = evaluate(Object.assign(watch([pos()]), { updated: NOW - 30 * H }), mkt(77700), { lastSummary: C.lastReset(NOW) }, NOW);
ok(keys(r).includes('watch|stale'), 'stale watch reminder');
r2 = evaluate(Object.assign(watch([pos()]), { updated: NOW - 30 * H }), mkt(77700), r.state, NOW + 15 * 60e3);
ok(!keys(r2).includes('watch|stale'), 'stale reminder not repeated');

// 9. Entry check: every rule must pass; one failing rule blocks it.
{
  const A = C.accountState(acct, [], {}, NOW);
  const data = { price: 101, atr: { '60': 1 }, levels: [{ name: 'PDL', price: 90 }],
    struct: { '240': { bias: 'bear', swings: [{ type: 'L', price: 92 }] }, '60': { bias: 'bear', swings: [] }, '15': { bias: 'bear', last: { dir: 'down' } } },
    fvg: { '60': [{ dir: 'bear', top: 101.5, bottom: 101 }], '15': [] } };
  let e = C.entryCheck('BTC/USD', data, A, [], NOW);
  ok(e.length === 1 && e[0].ready && e[0].size && e[0].size.qty > 0, 'all rules pass -> ready with size: ' + JSON.stringify(e[0] && e[0].rules.filter(x => !x.ok)));
  e = C.entryCheck('BTC/USD', Object.assign({}, data, { struct: Object.assign({}, data.struct, { '60': { bias: 'bull' } }) }), A, [], NOW);
  ok(e.length && !e[0].ready && e[0].rules.find(x => !x.ok).t === '1h agrees with 4h', '1h disagreeing blocks it');
  e = C.entryCheck('BTC/USD', data, A, [pos({ side: 'long', stop: 90 })], NOW);
  ok(!e[0].ready, 'open position the other way blocks it');
  e = C.entryCheck('BTC/USD', Object.assign({}, data, { price: 99 }), A, [], NOW);
  ok(!e.length || !e[0].ready, 'price not at the zone: not ready');
}
// 10. Urgent first: a breach is never held back behind lower alerts by the per-run cap.
{
  const deep = pos({ qty: 5, stop: 79500, origStop: 79500 });   // 5 BTC short, price 79,000: equity far below the floor
  r = evaluate(watch([deep]), mkt(79000), { lastSummary: C.lastReset(NOW) }, NOW);
  ok(r.fired.length && r.fired[0].key === 'E|breach', 'breach sorted first -> ' + keys(r));
  ok(r.fired.every((f, i, a) => !i || (a[i - 1].prio || 3) >= (f.prio || 3)), 'alerts sorted by priority');
}

// 11. Not delivered (over the cap or ntfy failed): forgotten, so the next run sends it again.
r = evaluate(watch([pos()]), mkt(78050), { lastSummary: C.lastReset(NOW) }, NOW);
ok(keys(r).includes('P1|stopnear'), 'near stop fires (setup)');
settle(r.state, { lastSummary: C.lastReset(NOW) }, r.fired.filter(f => f.key === 'P1|stopnear'));
r2 = evaluate(watch([pos()]), mkt(78050), r.state, NOW + 15 * 60e3);
ok(keys(r2).includes('P1|stopnear'), 'undelivered alert is sent next run -> ' + keys(r2));
const r7 = evaluate(watch([pos()]), mkt(78050), r2.state, NOW + 30 * 60e3);
ok(!keys(r7).includes("P1|stopnear"), "once delivered, quiet again");
// An undelivered summary comes back next run too.
r = evaluate(watch([pos()]), mkt(77700), {}, NOW);
settle(r.state, {}, r.fired);
r2 = evaluate(watch([pos()]), mkt(77700), r.state, NOW + 15 * 60e3);
ok(keys(r2).includes('summary|E'), 'undelivered summary retried');

// 12. Two accounts: each gets its own new-day summary (the old shared memory skipped the second).
{
  const B = Object.assign({}, acct, { id: 'B', label: 'Advanced Eval 2' });
  r = evaluate({ updated: NOW - H, accounts: [acct, B], positions: [], symbols: ['BTC/USD'] }, mkt(77700), {}, NOW);
  ok(keys(r).includes('summary|E') && keys(r).includes('summary|B'), 'both accounts summarized -> ' + keys(r));
  // Old state file (one number for all): no repeat summaries after the upgrade.
  r = evaluate({ updated: NOW - H, accounts: [acct, B], positions: [], symbols: ['BTC/USD'] }, mkt(77700), { lastSummary: C.lastReset(NOW) }, NOW);
  ok(!keys(r).some(k => k.startsWith('summary')), 'old numeric memory respected');
  ok(r.state.lastSummary.E === C.lastReset(NOW) && r.state.lastSummary.B === C.lastReset(NOW) && !('_all' in r.state.lastSummary), 'memory converted per account');
}

// 13. Open position but no price this run: say so instead of going silent.
{
  const m = mkt(77700); m['BTC/USD'].price = null;
  r = evaluate(watch([pos()]), m, { lastSummary: C.lastReset(NOW) }, NOW);
  ok(keys(r).includes('BTC/USD|noprice'), 'no price alert -> ' + keys(r));
}

// 14. Memory of old alerts is dropped after 3 days.
r = evaluate(watch([]), mkt(77700), { lastSummary: C.lastReset(NOW), sent: { 'old|x': { t: NOW - 4 * 24 * H, level: 1 }, 'new|x': { t: NOW - H, level: 1 } } }, NOW);
ok(!r.state.sent['old|x'] && r.state.sent['new|x'], 'old memory pruned, recent kept');
// 15. Scanner runs both ways and ignores the account; weighIdea brings the account in only when ticked.
{
  const data = { price: 101, atr: { '60': 1 }, levels: [{ name: 'PDL', price: 90 }, { name: 'PDH', price: 112 }],
    struct: { '240': { bias: 'bear', swings: [{ type: 'L', price: 92 }, { type: 'H', price: 112 }] }, '60': { bias: 'bear', swings: [] }, '15': { bias: 'bear', last: { dir: 'down' } } },
    fvg: { '60': [{ dir: 'bear', top: 101.5, bottom: 101 }, { dir: 'bull', top: 100.9, bottom: 100.5 }], '15': [] } };
  const sc = C.scanSetups('BTC/USD', data, NOW);
  ok(sc.some(x => x.dir === 'short') && sc.some(x => x.dir === 'long'), 'scan finds long and short -> ' + sc.map(x => x.dir));
  ok(sc.find(x => x.dir === 'short').ready && !sc.find(x => x.dir === 'long').ready, 'with-4h short ready, counter-trend long shown but not ready');
  const broke = Object.assign({}, acct, { dayStartOverride: { reset: C.lastReset(NOW), bal: 6000 } });
  const Abad = C.accountState(broke, [], {}, NOW);
  ok(sc.find(x => x.dir === 'short').ready, 'account state never touches the scan');
  r = evaluate({ updated: NOW - H, accounts: [broke], positions: [pos({ side: 'long', stop: 90, entry: 100 })], symbols: ['BTC/USD'] }, { 'BTC/USD': { price: 101, c: {} } }, { lastSummary: C.lastReset(NOW) }, NOW);
  const s = sc.find(x => x.dir === 'short'), A = C.accountState(acct, [], {}, NOW);
  const w = C.weighIdea(s, A, [], NOW);
  ok(w.ok && w.size && w.size.qty > 0, 'weighIdea: fits a healthy account with a size');
  const w2 = C.weighIdea(s, A, [pos({ side: 'long', stop: 90 })], NOW);
  ok(!w2.ok && w2.size === null, 'weighIdea: open long blocks the short only at weigh time');
  ok(!C.weighIdea(s, Abad, [], NOW).ok, 'weighIdea: account out of room says not now');
}
// 16. Cross-check: alert only when Coinbase shows the same gap.
{
  const sh = { tf: '60', dir: 'short', zone: { top: 101.5, bottom: 101 } };
  ok(C.confirmElsewhere(sh, { 60: [{ dir: 'bear', top: 101.6, bottom: 101.2 }] }).status === 'confirmed', 'overlapping same-side gap on 2nd venue: confirmed');
  ok(C.confirmElsewhere(sh, { 60: [{ dir: 'bull', top: 101.6, bottom: 101.2 }] }).status === 'not_seen', 'opposite gap: not seen');
  ok(C.confirmElsewhere(sh, { 60: [{ dir: 'bear', top: 99, bottom: 98 }] }).status === 'not_seen', 'gap elsewhere: not seen');
  ok(C.confirmElsewhere(sh, null).status === 'unverified', 'no 2nd venue data: unverified (no alert)');
}
// 17. Free-source context: shown with a setup, never blocks it.
{
  const m = { 'BTC/USD': { hl: { funding: 1.25e-5, oiUsd: 3.16e9 } }, _intel: { context: { short: [{ status: 'caution', text: 'Top traders lean long.' }, { status: 'ok', text: 'x' }] }, hyperliquid: { top: { liq_below: [[24257, 1]], liq_above: [[129125, 1]] } } } };
  const t = contextLine(m, 'BTC/USD', 'short');
  ok(/funding 11\.0%\/yr/.test(t) && /OI \$3160M/.test(t), 'HL funding/OI shown -> ' + t);
  ok(/1 caution for a short: Top traders lean long\./.test(t) && /below 24,257\.0, above 129,125\.0/.test(t), 'cautions + nearest liquidations shown');
  ok(contextLine({}, 'BTC/USD', 'long') === '', 'no context data: nothing added (unknown, not made up)');
  ok(!/caution/.test(contextLine(m, 'ETH/USD', 'short')), 'BTC-only context not applied to other coins');
}
// 18. IBIT flow from Pattern Lab's issuer feed: shown when known, left out when unknown.
{
  const m = { 'BTC/USD': {}, _intel: { context: {}, etf_issuer: { funds: { IBIT: { flow_usd: -2.5e8, flow_date: '2026-10-31' } } } } };
  ok(/IBIT ETF flow 2026-10-31: -\$250M/.test(contextLine(m, 'BTC/USD', 'long')), 'IBIT outflow shown');
  m._intel.etf_issuer.funds.IBIT.flow_usd = null;
  ok(!/IBIT/.test(contextLine(m, 'BTC/USD', 'long')), 'unknown flow left out, never shown as $0');
}
// 19. Worker rotation: one coin gets the full check per 5-min run; every coin comes round; positions always price-checked.
{
  const w = { symbols: ['BTC/USD', 'ETH/USD', 'SOL/USD', 'XRP/USD'], positions: [] };
  const seen = new Set(); for (let i = 0; i < 4; i++) seen.add(heavyFor(w, NOW + i * 300e3, true)[0]);
  const seen2 = new Set(); for (let i = 0; i < 4; i++) seen2.add(heavyFor(w, NOW + i * 120e3, 120e3)[0]);
  ok(seen2.size === 4, 'with a 2-minute cron the rotation moves one coin per run: all 4 coins in 8 minutes');
  ok(seen.size === 4 && heavyFor(w, NOW, false).length === 4, 'rotation covers all 4 coins in 20 min; GitHub run checks all');
  // Light run (BTC not in the full check): stop alerts still fire; health/setup memory is kept, not dropped.
  const m = mkt(78100); m['BTC/USD'].c = { 60: m['BTC/USD'].c[60] };
  const prev = { lastSummary: C.lastReset(NOW), active: { 'P1|health': 1, 'entry|BTC/USD|60|short|78000': 1 } };
  r = evaluate(watch([pos()]), m, prev, NOW, { heavy: ['ETH/USD'] });
  ok(keys(r).includes('P1|stophit'), 'light run: stop check still runs');
  ok(r.state.active['P1|health'] === 1 && r.state.active['entry|BTC/USD|60|short|78000'] === 1, 'light run keeps health/setup memory (no repeat alerts later)');
  ok(!keys(r).includes('P1|health'), 'light run: no health score without full candles');
}
// 20. watch.json tolerant parse.
ok(parseWatch('{"v":1}').v === 1 && parseWatch('junk\n{"v":2}').v === 2 && parseWatch('junk') === null, 'watch file: plain, pasted-below-junk, broken');
// 21. Liquidity sweeps: measurable rule, both directions, level must be known before the sweep candle.
{
  const T0 = Math.floor(NOW / 1000 / 900) * 900;               // open of the forming 15m bar
  const bar = (t, o, h, l, c) => ({ time: t, open: o, high: h, low: l, close: c });
  const base = Array.from({ length: 40 }, (_, i) => bar(T0 - (40 - i) * 900, 100, 100.5, 99.5, 100));
  const mk = (sweep, levels, px) => { const c15 = base.slice(); c15[c15.length - 1] = sweep; c15.push(bar(T0, 100, 100.2, 99.9, 100));
    return { price: px, atr: { '60': 1 }, levels, struct: {}, c: { 15: c15, 60: [] } }; };
  const L = [{ id: 'pdl', name: 'PDL', price: 99, kind: 'day' }, { id: 'pdh', name: 'PDH', price: 104, kind: 'day' }];
  let sw = C.sweepSetups('BTC/USD', mk(bar(T0 - 900, 99.6, 99.8, 98.8, 99.4), L, 99.5), NOW);
  ok(sw.length === 1 && sw[0].dir === 'long' && sw[0].ready && Math.abs(sw[0].stop - 98.7) < 1e-9 && sw[0].target === 104, 'long after PDL sweep: ready, stop below wick, target PDH -> ' + JSON.stringify(sw.map(x => [x.dir, x.ready, x.stop, x.target])));
  sw = C.sweepSetups('BTC/USD', mk(bar(T0 - 900, 99.6, 99.8, 98.98, 99.4), L, 99.5), NOW);
  ok(!sw.length, 'wick only 0.02 ATR past the level: not a sweep');
  sw = C.sweepSetups('BTC/USD', mk(bar(T0 - 900, 99.6, 99.8, 98.8, 98.9), L, 99.5), NOW);
  ok(!sw.length, 'closed below the level (no reclaim): not a sweep, it is a break');
  sw = C.sweepSetups('BTC/USD', mk(bar(T0 - 900, 99.6, 99.8, 98.8, 99.4), L, 98.95), NOW);
  ok(sw.length === 1 && !sw[0].ready, 'price back below the level now: shown, not ready');
  const Ls = [{ id: 'pdh', name: 'PDH', price: 101, kind: 'day' }, { id: 'pdl', name: 'PDL', price: 96, kind: 'day' }];
  sw = C.sweepSetups('BTC/USD', mk(bar(T0 - 900, 100.4, 101.2, 100.2, 100.6), Ls, 100.5), NOW);
  ok(sw.length === 1 && sw[0].dir === 'short' && sw[0].ready && sw[0].target === 96, 'short after PDH sweep (mirror)');
  const d = mk(bar(T0 - 900, 99.6, 99.8, 98.8, 99.4), [], 99.5);
  d.struct = { '60': { swings: [{ type: 'L', price: 99, time: T0 - 7200, confirmedAt: T0 - 1800 }] } };
  ok(!C.sweepSetups('BTC/USD', d, NOW).length, 'swing confirmed after the sweep candle opened: ignored (no hindsight)');
  // Market open tag (New York time): 09:45 NY = NY open; 12:00 NY = none; 03:30 NY = London.
  const ny = (h, m) => Date.UTC(2026, 10, 2, h + 5, m) / 1000;   // Nov 2: New York is UTC-5
  ok(C.marketOpenTag(ny(9, 45)) === 'New York open' && C.marketOpenTag(ny(12, 0)) === null && C.marketOpenTag(ny(3, 30)) === 'London open' && C.marketOpenTag(ny(20, 30)) === 'Asia open', 'market open tags');
  // Cross-check on Coinbase: same candle also swept and closed back.
  const set = { kind: 'sweep', tf: '15', dir: 'long', level: { price: 99 }, sweepTime: T0 - 900 };
  ok(C.confirmElsewhere(set, { c: { 15: [bar(T0 - 900, 99.6, 99.8, 98.9, 99.3)] } }).status === 'confirmed', 'Coinbase shows the same sweep: confirmed');
  ok(C.confirmElsewhere(set, { c: { 15: [bar(T0 - 900, 99.6, 99.8, 99.3, 99.5)] } }).status === 'not_seen', 'Coinbase low never reached the level: not seen');
  ok(C.confirmElsewhere(set, {}).status === 'unverified', 'no Coinbase candle: unverified, no alert');
  // weighIdea works on a sweep idea too (account only when ticked).
  sw = C.sweepSetups('BTC/USD', mk(bar(T0 - 900, 99.6, 99.8, 98.8, 99.4), L, 99.5), NOW);
  ok(C.weighIdea(Object.assign({ sym: 'BTC/USD' }, sw[0]), C.accountState(acct, [], {}, NOW), [], NOW).rules.length === 6, 'sweep idea can be weighed');
}
// 22. Impulse leg OTE alert: fires once when a 1h leg's pullback reaches 0.618-0.786, then stays quiet.
{
  const b = (i, o, h, l, c) => ({ time: 1e9 + i * 3600, open: o, high: h, low: l, close: c, volume: 10 });
  const c = []; let i = 0;
  for (let k = 0; k < 30; k++) { const m = 100 + (k % 2 ? 1 : -1); c.push(b(i++, m, m + 1, m - 1, 100)); }
  c.push(b(i++, 100, 103, 99.5, 102), b(i++, 102, 102.5, 100, 101), b(i++, 101, 101.5, 99.5, 100), b(i++, 100, 100.5, 99.2, 99.5), b(i++, 99.5, 99.8, 98, 98.8), b(i++, 98.8, 100, 98.6, 99.8), b(i++, 99.8, 101, 99.4, 100.8), b(i++, 100.8, 102, 100.5, 101.8));
  for (let k = 0; k < 9; k++) { const o = 102 + k * 2; c.push(b(i++, o, o + 2, o - 0.3, o + 1.9)); }
  let p = 119.9; for (const t of [116, 112, 108, 105, 105.5]) { c.push(b(i++, p, Math.max(p, t) + 0.05, Math.min(p, t) - 0.2, t)); p = t; }
  c.push(b(i++, p, p + 0.1, p - 0.1, p));
  const m = { 'BTC/USD': { price: 105.5, funding: 0, c: { 15: [], 60: c, 240: [], 1440: [] } } };
  const w = { updated: NOW - H, accounts: [], positions: [], symbols: ['BTC/USD'] };
  r = evaluate(w, m, {}, NOW);
  ok(keys(r).some(k => /^BTC\/USD\|fib\|60\|up\|/.test(k)), 'OTE alert fires -> ' + keys(r));
  ok(/66% retraced/.test(r.fired.find(f => /fib/.test(f.key)).body), 'alert says how deep: ' + r.fired.find(f => /fib/.test(f.key)).body.slice(0, 90));
  r2 = evaluate(w, m, r.state, NOW + 15 * 60e3);
  ok(!keys(r2).some(k => /fib/.test(k)), 'not repeated next run');
}
// 23. Replay line in setup alerts: most specific group with 20+ trades; says "too few" otherwise; never a probability.
{
  const bt = { groups: { 'sweep|15|long': { all: { n: 8 } }, 'sweep|15': { all: { n: 34, winRate: 0.41, avgR: 0.12 }, heldOut: { n: 10, avgR: -0.05 } } } };
  const t = trackLine(bt, { kind: 'sweep', tf: '15', dir: 'long', withTrend: true });
  ok(/Replay \(sweep 15, 34 past setups\): 41% winners, avg \+0\.12R after fees; held-out 10: avg -0\.05R\./.test(t), 'falls back to a group with 20+ -> ' + t);
  ok(/too few to judge/.test(trackLine({ groups: {} }, { kind: 'fvg', tf: '60', dir: 'short' })), 'no record: says too few');
  ok(trackLine(null, { kind: 'fvg' }) === '', 'no replay file: nothing added');
  ok(!/probab|chance|likely/i.test(t), 'no probability wording');
}
// 24. Market profile: clear-lean rule and the context alert.
{
  const m = (n, up, hn, hup) => ({ n, upShare24: up, med24: 0.8, p25_24: -0.5, p75_24: 1.9, key: 'd1=bull&h4=bull&vol=mid', traits: ['d1', 'h4', 'vol'], held: hn ? { n: hn, upShare24: hup } : null });
  ok(strongLean(m(80, 0.66, 20, 0.6)) === 'higher', '80 cases, 66% higher, held-out agrees: clear lean');
  ok(strongLean(m(80, 0.66, 20, 0.45)) === null, 'held-out disagrees: no lean');
  ok(strongLean(m(30, 0.8, 20, 0.7)) === null, 'only 30 cases: no lean');
  ok(strongLean(m(80, 0.55, 20, 0.6)) === null, '55%: not clear enough');
  ok(strongLean(m(80, 0.33, 20, 0.4)) === 'lower', 'mirror: mostly lower');
  ok(/Past hours like this \(80, 3 traits\): 24h median \+0\.8%, higher after 24h 66% of the time; held-out 20: 60%\./.test(profileLine({ match: m(80, 0.66, 20, 0.6) })), 'alert line wording');
  const mk = { 'BTC/USD': { price: 100, funding: 0, c: {}, profile: { f: { d1: 'bull', h4: 'bull', vol: 'mid', pos: 'upper_half', r24: 'up', rv: 'normal', ses: 'ny' }, match: m(80, 0.66, 20, 0.6) } } };
  const w = { updated: NOW - H, accounts: [], positions: [], symbols: ['BTC/USD'] };
  r = evaluate(w, mk, {}, NOW);
  const f = r.fired.find(x => /\|ctx\|/.test(x.key));
  ok(f && /mostly went higher/.test(f.title) && /not a forecast/.test(f.body), 'context alert fires with plain wording -> ' + (f && f.title));
  r2 = evaluate(w, mk, r.state, NOW + 15 * 60e3);
  ok(!r2.fired.some(x => /\|ctx\|/.test(x.key)), 'same context: not repeated');
}
// 25. Paper trades 24/7: alert when one reaches its stop or target; once only. Paper account breach alert.
{
  const pt = Object.assign(C.paperOpen({ sym: 'BTC/USD', dir: 'long', entry: 100, stop: 99, target: 104, kind: 'sweep', tf: '60' }, 100, NOW - H), { acct: 'pa1', qty: 1 });
  const PP = { accounts: [{ id: 'pa1', label: 'Paper Advanced $5,000', plan: 'advanced', size: 5000, phase: 'eval', profile: 'steady', created: NOW - 48 * H, status: 'active' }], trades: [pt] };
  const w = { updated: NOW - H, accounts: [], positions: [], symbols: ['BTC/USD'] };
  const m = px => ({ _paper: PP, 'BTC/USD': { price: px, funding: 0, c: {} } });
  r = evaluate(w, m(104.2), {}, NOW);
  const f = r.fired.find(x => x.key === `paper|${pt.id}|target`);
  ok(f && /Paper BTC\/USD long: target hit/.test(f.title) && /\+3\.9\dR/.test(f.body), 'paper target alert with R -> ' + (f && f.body.slice(0, 80)));
  r2 = evaluate(w, m(104.3), r.state, NOW + 15 * 60e3);
  ok(!r2.fired.some(x => /^paper\|/.test(x.key)), 'not repeated');
  ok(evaluate(w, m(98.9), {}, NOW).fired.some(x => x.key === `paper|${pt.id}|stop`), 'paper stop alert');
  const big = Object.assign({}, pt, { qty: 20, stop: 1 });
  r = evaluate(w, { _paper: Object.assign({}, PP, { trades: [big] }), 'BTC/USD': { price: 70, funding: 0, c: {} } }, {}, NOW);
  ok(r.fired.some(x => x.key === 'paper|pa1|breach'), 'paper account breach alert');
}
{ // partial level alert (Kraken Prop has no partial TP orders: he closes part by hand when price gets there)
  const a = evaluate(watch([pos({ partialAt: 77200 })]), mkt(77300), {}, NOW);
  ok(!keys(a).some(k => /\|partial\|/.test(k)), 'no partial alert before the level');
  const b = evaluate(watch([pos({ partialAt: 77200 })]), mkt(77150), a.state, NOW + 15 * 60e3);
  ok(keys(b).includes('P1|partial|77200'), 'partial alert when a short reaches its partial level');
  const c = evaluate(watch([pos({ partialAt: 77200 })]), mkt(77100), b.state, NOW + 30 * 60e3);
  ok(!keys(c).includes('P1|partial|77200'), 'partial alert not repeated');
}
// 8. Coach and heads-up alerts (owner, Nov 3 2026): worked examples computed by hand.
{
  const lg = o => Object.assign({ id: 'L', side: 'long', entry: 100, stop: 95, origStop: 95, qty: 1 }, o || {}), sh = o => Object.assign({ id: 'S', side: 'short', entry: 100, stop: 105, origStop: 105, qty: 1 }, o || {});
  let m = C.stopMove(lg(), 105, 1);   // risk 5, +1R: breakeven after fees = 100 * (1 + 2 * 0.0004) = 100.08
  ok(m && m.kind === 'be' && Math.abs(m.to - 100.08) < 1e-9 && m.to > 95, 'long at +1R with the stop below entry: tighten to breakeven after fees');
  ok(C.stopMove(lg(), 100.5, 1) === null, 'long at +0.1R: no stop move');
  m = C.stopMove(lg(), 110, 1); ok(m && m.kind === 'lock1' && m.to === 105, 'long at +2R: lock +1R (stop 105)');
  ok(C.stopMove(lg({ stop: 101 }), 105, 1) === null, 'stop already past breakeven at +1R: nothing to suggest');
  ok(C.stopMove(lg(), 105, 5) === null, 'new stop closer than 1 hourly ATR to price: no suggestion (inside the noise)');
  m = C.stopMove(sh(), 95, 1); ok(m && m.kind === 'be' && Math.abs(m.to - 99.92) < 1e-9, 'short at +1R: breakeven after fees = 99.92');
  ok([lg(), sh()].every((p, i) => { const x = C.stopMove(p, i ? 80 : 120, 1); return x && (p.side === 'long' ? x.to > p.stop : x.to < p.stop); }), 'a stop move always tightens, never widens');
  ok(C.stopMove(lg({ stop: null }), 105, 1) === null && C.stopMove(lg(), null, 1) === null, 'no stop or no price: no suggestion');
  const A = o => Object.assign({ nextReset: NOW + 20 * 60e3, open: 1, workingOrders: 0, dayStart: 5000, equity: 5000, dailyFloor: 4850, dailyRoom: 150, riskToStops: 100, breached: false, room: 150, profRisk: 25 }, o || {});
  let x = C.resetAlert(A(), 'Eval', NOW); ok(x && /20 min/.test(x.title) && x.key === `${NOW + 20 * 60e3}|resetsoon`, 'reset warning 20 min before with a position open');
  ok(C.resetAlert(A({ nextReset: NOW + 45 * 60e3 }), 'Eval', NOW) === null, 'no reset warning 45 min before');
  ok(C.resetAlert(A({ open: 0 }), 'Eval', NOW) === null, 'no reset warning with nothing open and no loss');
  ok(C.resetAlert(A({ open: 0, equity: 4910 }), 'Eval', NOW) !== null, 'reset warning with nothing open but 60% of the daily limit used');
  x = C.lossAlert(A({ equity: 4890, dailyRoom: 40, room: 40 }), 'Eval'); ok(x && x.lvl === 1 && /73%/.test(x.title), 'daily loss 110 of 150 = 73%: warning level 1');
  x = C.lossAlert(A({ equity: 4870, dailyRoom: 20, room: 20, profRisk: 10 }), 'Eval'); ok(x && x.lvl === 2 && x.prio === 4 && /87%/.test(x.title), 'daily loss 130 of 150 = 87%: level 2');
  ok(C.lossAlert(A({ equity: 4950 }), 'Eval') === null, 'daily loss 33%: quiet');
  ok(C.lossAlert(A({ equity: 4870, dailyRoom: 20, room: 20 }), 'Eval') === null, 'room already below one trade: that alert covers it');
  // Through the monitor: 20 min before the reset, with a position open, the warning fires once.
  const T0 = C.nextReset(NOW, 30) - 20 * 60e3, w = watch([pos()]); w.accounts = [Object.assign({}, acct, { dayStartOverride: { reset: C.lastReset(T0), bal: 5000 } })];
  const q = evaluate(w, mkt(77700), {}, T0); ok(keys(q).some(k => /resetsoon/.test(k)), 'monitor: reset warning fires');
  const q2 = evaluate(w, mkt(77700), q.state, T0 + 5 * 60e3); ok(!keys(q2).some(k => /resetsoon/.test(k)), 'monitor: reset warning not repeated');
  const sm1 = evaluate(watch([pos()]), mkt(77100), {}, NOW), sm2 = evaluate(watch([pos()]), mkt(77100), sm1.state, NOW + 15 * 60e3);
  ok(keys(sm1).includes('P1|stopmove|be') && !keys(sm2).includes('P1|stopmove|be'), 'monitor: short +1.07R fires the tighten-stop alert once');
  // NY open heads-up: Tue Nov 3 2026, EST. 09:15 New York = 14:15 UTC (15 min before the open).
  const ser = (endUtc, n) => Array.from({ length: n }, (_, i) => { const t = Math.floor(endUtc / 1000) - (n - 1 - i) * 900, px = 77000 + 300 * Math.sin(i / 9); return { time: t, open: px, high: px + 40, low: px - 40, close: px + 5, volume: 1 }; });
  const d1 = Array.from({ length: 60 }, (_, i) => ({ time: Date.UTC(2026, 8, 5 + i) / 1000, open: 77000, high: 78000, low: 76000, close: 77200, volume: 1 }));
  const at = Date.UTC(2026, 10, 3, 14, 15), oa = C.openAlert(ser(at, 600), d1, at / 1000, 'BTC/USD');
  ok(oa && oa.key === 'open|2026-11-03' && /15 min/.test(oa.title), 'open heads-up 15 min before 09:30 New York');
  ok(C.openAlert(ser(Date.UTC(2026, 10, 3, 13, 15), 600), d1, Date.UTC(2026, 10, 3, 13, 15) / 1000, 'BTC/USD') === null, 'no open heads-up 75 min before');
  ok(C.openAlert(ser(Date.UTC(2026, 10, 3, 14, 45), 600), d1, Date.UTC(2026, 10, 3, 14, 45) / 1000, 'BTC/USD') === null, 'no open heads-up after the open');
  ok(C.openAlert(ser(Date.UTC(2026, 10, 7, 14, 15), 600), d1, Date.UTC(2026, 10, 7, 14, 15) / 1000, 'BTC/USD') === null, 'no open heads-up on a Saturday');
}
// 9. Auto paper trades in the monitor (H24 amendment 1): worked examples
{
  const { autoPaperStep } = require('../monitor/run.js'), NOWX = Date.UTC(2026, 10, 3, 15, 0);
  const row = { key: 'k1', sym: 'BTC/USD', kind: 'fvg', tf: 60, dir: 'long', entry: 78000, stop: 77000, target: 81000, ready: true, rules: [{ ok: true, t: 'x' }], text: 'x' };
  const o = (x) => Object.assign({ prices: { 'BTC/USD': 78050 }, atr: { 'BTC/USD': 400 }, c15: {}, benched: [], hand: [], now: NOWX }, x || {});
  let r = autoPaperStep({ trades: [] }, [row], o());
  ok(r.opened.length === 1 && r.changed && r.trades[0].auto === true && r.trades[0].src === undefined && r.trades[0].meta.src === 'monitor' && r.trades[0].order === 'market' && r.trades[0].status === 'open' && r.trades[0].setupKey === 'k1', 'monitor opens an alert-grade setup as a market auto paper trade');
  const r2 = autoPaperStep({ trades: r.trades }, [row], o({ now: NOWX + 5 * 60e3 }));
  ok(r2.opened.length === 0 && !r2.changed, 'same setup next run: not opened again');
  ok(autoPaperStep({ trades: [] }, [row], o({ hand: [{ status: 'closed', setupKey: 'k1', sym: 'ETH/USD' }] })).opened.length === 0, 'a setup he already took by hand: not opened');
  ok(autoPaperStep({ trades: [] }, [row], o({ hand: [{ status: 'open', setupKey: 'z', sym: 'BTC/USD' }] })).opened.length === 0, 'coin already has an open hand trade: not opened');
  ok(autoPaperStep({ trades: [] }, [row], o({ benched: [C.setupKey('fvg', 60)] })).opened.length === 0, 'benched setup type: not opened');
  ok(autoPaperStep({ trades: [] }, [Object.assign({}, row, { tf: 15 })], o()).opened.length === 0, 'below the replay grade: not opened');
  // closing on the 15m candles: low 76900 goes through the 77000 stop -> closed at the stop, a loss
  const open = r.trades[0], bars = [{ time: NOWX / 1000 - 900 * 2, open: 78000, high: 78100, low: 76900, close: 77000, volume: 1 }];
  const r3 = autoPaperStep({ trades: [Object.assign({}, open, { opened: NOWX - 3600e3 })] }, [], o({ c15: { 'BTC/USD': bars }, now: NOWX }));
  ok(r3.closed.length === 1 && r3.trades[0].status === 'closed' && r3.trades[0].R < 0 && r3.changed, 'open auto trade closes at its stop on the 15m candles (R ' + (r3.trades[0].R || 0).toFixed(2) + ')');
  const many = ['BTC/USD', 'ETH/USD', 'SOL/USD', 'XRP/USD'], rows = many.map((s, i) => Object.assign({}, row, { key: 'm' + i, sym: s, entry: 100, stop: 90, target: 130 }));
  const r4 = autoPaperStep({ trades: [] }, rows, o({ prices: { 'BTC/USD': 100, 'ETH/USD': 100, 'SOL/USD': 100, 'XRP/USD': 100 }, atr: { 'BTC/USD': 4, 'ETH/USD': 4, 'SOL/USD': 4, 'XRP/USD': 4 } }));
  ok(r4.opened.length === 4, 'four coins, four setups: all four open (cap is 4)');
  const r5 = autoPaperStep({ trades: r4.trades }, [Object.assign({}, row, { key: 'm9', sym: 'BTC/USD' })], o({ prices: { 'BTC/USD': 100 }, atr: { 'BTC/USD': 4 } }));
  ok(r5.opened.length === 0, 'cap of 4 open reached: no fifth');
}
console.log(`${n - fails}/${n} passed`); process.exit(fails ? 1 : 0);
