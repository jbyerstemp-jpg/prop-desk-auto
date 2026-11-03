/* PDA read-only adapter for the cloned Prop Desk research model.
   It normalizes provenance and model observations. It cannot create orders or paper fills. */
(function (root) {
  'use strict';
  function create(options) {
    const feed = options && options.feed;
    const research = options && options.research;
    const clock = options && options.clock || (() => Date.now());
    if (!feed || !research || typeof research.read !== 'function') throw new Error('Feed and PDResearch are required');
    const symbols = new Set();
    const latest = new Map();
    const listeners = new Set();
    let started = false;
    const key = (symbol, tf) => symbol + '|' + tf;
    const emit = () => { for (const fn of listeners) { try { fn(api.snapshot()); } catch (_) {} } };
    function inspect(symbol) {
      const now = clock();
      const source = String(feed.source || 'unknown');
      const demo = feed.demo === true || /demo|synthetic/i.test(source) || feed.status === 'demo';
      const fallback = /coinbase|fallback/i.test(source) || feed.status === 'fallback';
      const venue = demo ? 'synthetic_demo' : fallback ? 'coinbase' : source === 'Kraken' && feed.status === 'live' ? 'kraken' : 'unverified';
      const status = demo ? 'demo_blocked' : venue !== 'kraken' ? 'venue_blocked' : feed.status !== 'live' ? 'feed_not_live' : 'observing';
      const result = research.read(symbol, tf => feed.candles(symbol, tf), now, venue);
      const frames = {};
      for (const tf of research.TFS || [15, 60, 240, 1440]) {
        const item = result.tfs && result.tfs[tf];
        const age = typeof feed.candleAge === 'function' ? feed.candleAge(symbol, tf) : null;
        const stale = age == null || !Number.isFinite(age) || age > (tf * 120 + 120);
        frames[tf] = {
          status: status !== 'observing' ? status : stale ? 'stale' : item ? item.status : 'unavailable',
          ageSeconds: age,
          observation: status === 'observing' && !stale && item && item.status === 'ready' ? item : null
        };
      }
      const record = {
        symbol, venue, source, feedStatus: feed.status, demo,
        capturedAt: now, modelVersion: result.version,
        status, timeframes: frames,
        classification: 'read_only_research_observations_not_trade_instructions'
      };
      latest.set(symbol, record);
      return record;
    }
    function refresh() {
      for (const symbol of symbols) inspect(symbol);
      emit();
      return api.snapshot();
    }
    const api = {
      start(list) {
        (list || []).forEach(symbol => {
          if (!symbols.has(symbol)) {
            symbols.add(symbol);
            if (typeof feed.want === 'function') feed.want(symbol, research.TFS || [15, 60, 240, 1440]);
          }
        });
        if (!started && typeof feed.on === 'function') { feed.on(refresh); started = true; }
        return refresh();
      },
      refresh,
      get(symbol) { return latest.get(symbol) || null; },
      snapshot() { return Array.from(latest.values()); },
      on(fn) { listeners.add(fn); return () => listeners.delete(fn); }
    };
    return api;
  }
  root.PDAEngine = { create, VERSION: '0.1.0-read-only' };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.PDAEngine;
})(typeof window !== 'undefined' ? window : globalThis);
