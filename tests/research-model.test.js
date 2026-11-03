/* Contract tests for the existing Prop Desk research engine.
 * These tests intentionally assert observation-only behavior: model output is not trade authorization.
 */
'use strict';
const assert = require('node:assert/strict');
const M = require('../js/research-model.js');

const IV = 15 * 60 * 1000;
const makeBars = (n = 80) => {
  const out = [];
  let p = 100;
  for (let i = 0; i < n; i++) {
    const open = p;
    p *= 1 + (i % 9 < 6 ? 0.0018 : -0.0005);
    out.push({
      time: 1_700_000_000_000 + i * IV,
      open,
      high: Math.max(open, p) * 1.001,
      low: Math.min(open, p) * 0.999,
      close: p,
      closed: true,
    });
  }
  return out;
};
const stream = (bars, extra = {}) => ({
  symbol: 'BTC/USD',
  venue: 'kraken',
  timeframe: '15m',
  intervalMs: IV,
  staleAfterMs: 2 * IV + 120_000,
  bars,
  ...extra,
});

{
  const bars = makeBars();
  const result = M.analyzeStream(stream(bars), { now: bars.at(-1).time + 1_000 });
  assert.equal(result.dataStatus, 'ready');
  assert.equal(result.accountRisk.status, 'not_evaluated');
  assert.equal(result.symbol, 'BTC/USD');
  assert.ok(Array.isArray(result.events));
}

{
  const bars = makeBars();
  for (let i = 50; i < bars.length; i++) bars[i].time += IV; // preserve order while leaving one missing interval
  const result = M.analyzeStream(stream(bars), { now: bars.at(-1).time + 1_000 });
  assert.equal(result.dataStatus, 'gap');
  assert.equal(result.gapDetected, true);
  assert.deepEqual(M.alertBatch(result), []);
}

{
  const bars = makeBars();
  const now = bars.at(-1).time + 1_000;
  const liveBar = {
    time: bars.at(-1).time + IV,
    open: bars.at(-1).close,
    high: bars.at(-1).close * 1.001,
    low: bars.at(-1).close * 0.999,
    close: bars.at(-1).close,
    closed: false,
  };
  const result = M.analyzeStream(stream(bars, { liveBar }), { now });
  assert.equal(result.dataStatus, 'ready');
  assert.ok(result.patterns.previews.every(x => x.provisional === true));
}

{
  const bars = makeBars();
  const result = M.analyzeStream(stream(bars), { now: bars.at(-1).time + 10 * IV });
  assert.equal(result.dataStatus, 'stale');
  assert.deepEqual(M.alertBatch(result), []);
}

{
  const bars = makeBars();
  const opts = { now: bars.at(-1).time + 1_000 };
  const a = M.analyzeStream(stream(bars), opts);
  const b = M.analyzeStream(stream(bars), opts);
  assert.deepEqual(a.events.map(x => x.id), b.events.map(x => x.id));
  assert.ok(a.events.every(x => x.classification === undefined || x.classification !== 'trade_instruction'));
  assert.ok(M.registry().length > 20);
}

console.log('research-model contract tests: 5 passed');
