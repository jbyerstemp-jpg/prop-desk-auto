/* Prop Desk research read: the adapter between the app's Kraken candles and the experimental research engine
   (js/research-model.js, v0.4). One shared copy for the app, the Coach and (later) the monitor and replay tests.
   Read-only measurements, not signals. No sizing here: account risk stays in core.js (weighIdea). */
(function (root) {
  'use strict';
  const M = (typeof module !== 'undefined' && module.exports) ? require('./research-model.js') : root.PropDeskResearch;
  // Price step per Kraken market (unconfirmed against Kraken's pair list; check before relying on tweezers/zones).
  const TICK = { 'BTC/USD': 0.1, 'ETH/USD': 0.01, 'SOL/USD': 0.01, 'XRP/USD': 0.00001 };
  const TFS = [15, 60, 240, 1440];
  const tickFor = (sym, px) => TICK[sym] || (px >= 1000 ? 0.1 : px >= 10 ? 0.01 : px >= 1 ? 0.001 : 0.00001);

  /* Kraken rows (time = bar OPEN, seconds; last row may still be forming) -> engine stream (time = bar CLOSE, ms).
     Broken rows are dropped; the engine then sees the gap and blocks alerts (it never guesses a missing bar). */
  function toStream(sym, tfMin, rows, nowMs, venue) {
    const iv = tfMin * 60e3, bars = [], seen = new Set();
    let live = null, dropped = 0;
    for (const x of (rows || []).slice().sort((a, b) => a.time - b.time)) {
      const close = x.time * 1000 + iv;
      const okRow = [x.open, x.high, x.low, x.close].every(Number.isFinite) && x.low > 0 && x.high >= Math.max(x.open, x.close) && x.low <= Math.min(x.open, x.close);
      if (!okRow || seen.has(close)) { dropped++; continue; }
      seen.add(close);
      const b = { time: close, open: x.open, high: x.high, low: x.low, close: x.close };
      if (close <= nowMs) bars.push(Object.assign(b, { closed: true }));
      else if (close - nowMs <= iv) live = Object.assign(b, { closed: false });
    }
    if (live && bars.length && live.time !== bars[bars.length - 1].time + iv) live = null;   // engine wants exactly the next bar
    return { stream: { symbol: sym, venue: venue || 'kraken', timeframe: tfMin + 'm', intervalMs: iv, staleAfterMs: 2 * iv + 120e3, bars, liveBar: live }, dropped };
  }

  const recent = (list, since) => list.filter(e => e.eventTime >= since);
  /* Short summary for the UI and Coach: per timeframe, never one blended score. */
  function summarize(r, tfMin) {
    const iv = tfMin * 60e3, since = (r.asOf || 0) - 3 * iv;
    const ev = r.events;
    const pats = recent(ev.filter(e => e.component === 'patterns' && e.type === 'confirmed' && e.bias !== 'neutral'), since)
      .map(e => ({ pattern: e.pattern, bias: e.bias, time: e.eventTime, relaxed: e.variant === 'relaxed' }));
    const changes = ev.filter(e => e.component === 'structure' && e.type === 'state_change' && e.scale === 'major');
    const cands = r.setups.candidates;
    return {
      tf: tfMin, status: r.dataStatus, asOf: r.asOf, bias: r.structure.bias,
      lastChange: changes.length ? { from: changes[changes.length - 1].from, to: changes[changes.length - 1].to, time: changes[changes.length - 1].eventTime } : null,
      patterns: pats,
      // Forming = provisional: a multi-bar pattern that would complete if the live candle closed now, or a one-bar shape that leans a way.
      forming: (r.patterns.previews || []).filter(p => p.candidateId ? (p.status === 'awaiting_final_close' && p.conditionsSatisfiedNow === true) : (p.conditionsSatisfiedNow && p.bias && p.bias !== 'neutral'))
        .map(p => ({ pattern: p.pattern, status: p.status })),
      setups: cands.filter(c => c.status === 'watching' || (c.status === 'triggered' && c.triggeredAt >= since))
        .map(c => ({ dir: c.direction, status: c.status, level: c.level, invalidation: c.invalidation, ref: c.referenceClose, time: c.triggeredAt || c.breakAt })),
    };
  }

  /* Run every timeframe on its own; one failing timeframe never hides the others. candlesFor(tfMin) -> Kraken rows. */
  function read(sym, candlesFor, nowMs, venue) {
    const out = { sym, at: nowMs, version: M.VERSION, tfs: {} };
    for (const tf of TFS) {
      try {
        const { stream, dropped } = toStream(sym, tf, candlesFor(tf), nowMs, venue);
        if (stream.bars.length < 30) { out.tfs[tf] = { tf, status: 'not_enough_data' }; continue; }
        const r = M.analyzeStream(stream, { now: nowMs, config: { tickSize: tickFor(sym, stream.bars[stream.bars.length - 1].close) } });
        out.tfs[tf] = Object.assign(summarize(r, tf), { dropped });
      } catch (e) { out.tfs[tf] = { tf, status: 'error', error: String(e.message || e).slice(0, 120) }; }
    }
    return out;
  }

  /* Coach notes for an open position: things the research read sees AGAINST it. Notes only: never changes the
     1-5 score, never suggests widening a stop. */
  function coachNotes(pos, rd) {
    const notes = [], against = pos.side === 'long' ? 'bearish' : 'bullish', tfName = t => ({ 15: '15m', 60: '1h', 240: '4h', 1440: '1D' }[t]);
    if (!rd) return notes;
    for (const tf of [240, 60, Number(pos.tf) || 15]) {
      const s = rd.tfs[tf]; if (!s || s.status !== 'ready') continue;
      if (s.lastChange && s.lastChange.to.startsWith(against.slice(0, 4)) && rd.at - s.lastChange.time < 3 * tf * 60e3) notes.push(`${tfName(tf)} structure just turned ${s.lastChange.to.replace('_', ' ')}`);
      for (const p of s.patterns.filter(p => p.bias === against)) notes.push(`${tfName(tf)} ${p.pattern.replace(/_/g, ' ')} closed against you${p.relaxed ? ' (relaxed variant)' : ''}`);
      for (const x of s.setups.filter(x => x.status === 'triggered' && x.dir !== pos.side)) notes.push(`${tfName(tf)} break-and-retest ${x.dir} triggered against you`);
    }
    return [...new Set(notes)].slice(0, 4);
  }

  const R = { TICK, TFS, toStream, summarize, read, coachNotes, VERSION: M.VERSION };
  if (typeof module !== 'undefined' && module.exports) module.exports = R; else root.PDResearch = R;
})(typeof window !== 'undefined' ? window : globalThis);
