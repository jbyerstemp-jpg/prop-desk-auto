const assert = require('node:assert/strict');
const PDAEngine = require('../js/pda-engine.js');

const NOW = 1_700_000_000_000;
function bars(tf) {
  const interval = tf * 60;
  return Array.from({ length: 80 }, (_, i) => {
    const open = 100 + i * 0.1;
    return { time: NOW / 1000 - (79 - i) * interval - interval, open, high: open + 1, low: open - 1, close: open + 0.5 };
  });
}
function harness(overrides = {}) {
  let listener;
  const calls = [];
  const feed = {
    source: 'Kraken', status: 'live', demo: false,
    candles: (_symbol, tf) => bars(tf),
    want: (symbol, tfs) => calls.push([symbol, tfs]),
    on: fn => { listener = fn; },
    ...overrides
  };
  const research = {
    TFS: [15, 60],
    read: (symbol, candlesFor, now, venue) => ({
      version: 'test-model', symbol, now, venue,
      tfs: {
        15: { status: 'ready', bias: 'bullish' },
        60: { status: 'ready', bias: 'bearish' }
      }
    })
  };
  const engine = PDAEngine.create({ feed, research, clock: () => NOW });
  return { engine, feed, calls, tick: () => listener && listener() };
}

{
  const h = harness();
  const [record] = h.engine.start(['BTC/USD']);
  assert.equal(record.venue, 'kraken');
  assert.equal(record.timeframes[15].observation.bias, 'bullish');
  assert.equal(record.classification, 'read_only_research_observations_not_trade_instructions');
  assert.deepEqual(h.calls[0][1], [15, 60]);
  assert.equal('execute' in h.engine, false);
  assert.equal('placeOrder' in h.engine, false);
}
{
  const h = harness({ source: 'Coinbase (fallback)', status: 'fallback' });
  const [record] = h.engine.start(['BTC/USD']);
  assert.equal(record.venue, 'coinbase');
  assert.equal(record.timeframes[15].observation, null);
  assert.equal(record.timeframes[15].status, 'venue_blocked');
}
{
  const h = harness({ source: 'DEMO (synthetic)', status: 'demo', demo: true });
  const [record] = h.engine.start(['BTC/USD']);
  assert.equal(record.venue, 'synthetic_demo');
  assert.equal(record.timeframes[15].observation, null);
}
{
  const h = harness({ candles: () => [] });
  const [record] = h.engine.start(['BTC/USD']);
  assert.equal(record.timeframes[15].status, 'stale');
  assert.equal(record.timeframes[15].observation, null);
}
{
  const h = harness();
  h.engine.start(['BTC/USD']);
  h.engine.refresh();
  assert.equal(h.engine.snapshot().length, 1);
}
console.log('PDA read-only adapter contracts: 5 passed');
