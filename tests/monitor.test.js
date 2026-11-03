const assert = require('node:assert/strict');
const { parseWatch, heavyFor, strongLean, evaluate } = require('../monitor/run.js');

const watch = { v: 1, updated: 0, accounts: [], positions: [], symbols: ['BTC/USD', 'ETH/USD', 'SOL/USD', 'XRP/USD'] };
assert.deepEqual(parseWatch(JSON.stringify(watch)), watch);
assert.deepEqual(parseWatch('header text\n' + JSON.stringify(watch)), watch);
assert.equal(heavyFor(watch, 0, true).length, 1);
assert.equal(heavyFor(watch, 0, false).length, 4);
assert.equal(strongLean({ n: 60, upShare24: 0.7, held: { n: 20, upShare24: 0.6 } }), 'higher');
assert.equal(strongLean({ n: 60, upShare24: 0.7, held: { n: 20, upShare24: 0.4 } }), null);
const result = evaluate({ accounts: [], positions: [], symbols: [] }, {}, {}, Date.UTC(2026, 10, 3), {});
assert.deepEqual(result.fired, []);
assert.ok(result.state);
console.log('PDA monitor contracts: all tests passed');
