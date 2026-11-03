/* PDA read-only adapter for the cloned Prop Desk research model.
   Uses the real Feed + PDResearch contracts. It cannot create orders or paper fills. */
(function (root) {
  'use strict';
  function create(options) {
    const feed = options && options.feed;
    const research = options && options.research;
    const clock = options && options.clock || (() => Date.now());
    if (!feed || !research || typeof research.read !== 'function' || !Array.isArray(research.TFS)) {
      throw new Error('Feed and PDResearch are required');
    }
    const symbols = new Set();
    const latest = new Map();
    const listeners = new Set();
    let started = false;
    const emit = () => {
      for (const fn of listeners) {
        try { fn(api.snapshot()); } catch (_) { /* isolate observers */ }
      }
    };
    function inspect(symbol) {
      const now = clock();
      const source = String(feed.source || 'unknown');
      const demo = feed.demo === true || /demo|synthetic/i.test(source) || feed.status === 'demo';
      const fallback = /coinbase|fallback/i.test(source) || feed.status === 'fallback';
      const venue = demo ? 'synthetic_demo' : fallback ? 'coinbase' :
        source === 'Kraken' ? 'kraken' : 'unverified';
      const status = demo ? 'demo_blocked' : fallback ? 'venue_blocked' :
        venue !== 'kraken' ? 'venue_blocked' :
        feed.status !== 'live' ? 'feed_not_live' : 'observing';
      // PDResearch.read expects raw Feed candles (open-time seconds), milliseconds for now,
      // and returns { version, tfs: { [minutes]: { status, ...summary } } }.
      const result = research.read(symbol, tf => feed.candles(symbol, tf), now, venue);
      const frames = {};
      for (const tf of research.TFS) {
        const item = result.tfs && result.tfs[tf];
        const rows = typeof feed.candles === 'function' ? feed.candles(symbol, tf) : [];
        const last = rows && rows.length ? rows[rows.length - 1] : null;
        const lastCloseMs = last && Number.isFinite(last.time) ? (last.time + tf * 60) * 1000 : null;
        const ageSeconds = lastCloseMs === null ? null : Math.max(0, (now - lastCloseMs) / 1000);
        const staleAfterSeconds = tf * 120 + 120;
        const stale = ageSeconds === null || ageSeconds > staleAfterSeconds;
        const frameStatus = status !== 'observing' ? status :
          !item ? 'unavailable' : item.status === 'error' ? 'model_error' :
          stale ? 'stale' : item.status;
        frames[tf] = {
          status: frameStatus,
          ageSeconds,
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
            if (typeof feed.want === 'function') feed.want(symbol, research.TFS);
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
  root.PDAEngine = { create, VERSION: '0.2.0-read-only' };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.PDAEngine;
})(typeof window !== 'undefined' ? window : globalThis);
