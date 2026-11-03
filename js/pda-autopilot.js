/* PDA autonomous paper engine. Browser-only, persistent, fail-closed, and never routes orders. */
(function (root) {
  'use strict';
  const KEY = 'pda_personal_paper_v1';
  const DEFAULTS = { capital: 1000, riskPct: 0.25, dailyLossPct: 1, maxTradesPerDay: 3, symbol: 'BTC/USD', enabled: false };
  const round = n => Math.round(n * 1e8) / 1e8;
  const ema = (values, period) => {
    if (values.length < period) return null;
    const k = 2 / (period + 1);
    let value = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
    for (let i = period; i < values.length; i++) value = values[i] * k + value * (1 - k);
    return value;
  };
  const atr = bars => {
    if (bars.length < 15) return null;
    const tr = bars.slice(-15).map((b, i, a) => {
      const prev = i ? a[i - 1].close : bars[bars.length - 16].close;
      return Math.max(b.high - b.low, Math.abs(b.high - prev), Math.abs(b.low - prev));
    });
    return tr.reduce((a, b) => a + b, 0) / tr.length;
  };
  function create({ feed, storage, clock = () => Date.now() }) {
    if (!feed || typeof feed.candles !== 'function') throw new Error('A market feed is required');
    const store = storage || root.localStorage;
    const read = () => { try { return JSON.parse(store.getItem(KEY)) || {}; } catch (_) { return {}; } };
    let state = Object.assign({ config: Object.assign({}, DEFAULTS), open: null, closed: [], events: [], lastSignalBar: null, gateStatus: 'paused' }, read());
    state.config = Object.assign({}, DEFAULTS, state.config || {});
    const persist = () => { try { store.setItem(KEY, JSON.stringify(state)); } catch (_) { state.config.enabled = false; } };
    const dayKey = () => new Date(clock()).toISOString().slice(0, 10);
    const todayTrades = () => state.closed.filter(t => t.day === dayKey());
    const todayPnl = () => todayTrades().reduce((sum, t) => sum + t.netPnl, 0) + (state.open ? state.open.unrealized || 0 : 0);
    const equity = () => state.config.capital + state.closed.reduce((sum, t) => sum + t.netPnl, 0) + (state.open ? state.open.unrealized || 0 : 0);
    function snapshot() {
      return JSON.parse(JSON.stringify({ config: state.config, open: state.open, closed: state.closed.slice(-100), events: state.events.slice(-20), gateStatus: state.gateStatus,
        equity: round(equity()), realizedPnl: round(state.closed.reduce((s, t) => s + t.netPnl, 0)), todayPnl: round(todayPnl()) }));
    }
    function configure(values) {
      const next = Object.assign({}, state.config, values || {});
      if (!(Number.isFinite(+next.capital) && +next.capital >= 100 && +next.capital <= 10000000)) throw new Error('Capital must be between $100 and $10,000,000');
      if (!(Number.isFinite(+next.riskPct) && +next.riskPct > 0 && +next.riskPct <= 0.5)) throw new Error('Risk per trade must be above 0 and no more than 0.5%');
      if (!(Number.isFinite(+next.dailyLossPct) && +next.dailyLossPct > 0 && +next.dailyLossPct <= 2)) throw new Error('Daily loss limit must be above 0 and no more than 2%');
      next.capital = +next.capital; next.riskPct = +next.riskPct; next.dailyLossPct = +next.dailyLossPct;
      next.maxTradesPerDay = Math.max(1, Math.min(10, Math.floor(+next.maxTradesPerDay || 3)));
      if (typeof next.symbol !== 'string' || !/^[A-Z0-9]+\/[A-Z]+$/.test(next.symbol)) throw new Error('Invalid symbol');
      state.config = next; persist(); return snapshot();
    }
    function setEnabled(enabled) {
      state.config.enabled = !!enabled;
      state.gateStatus = enabled ? 'checking' : 'paused';
      state.events.push({ at: clock(), type: enabled ? 'paper_autopilot_enabled' : 'paper_autopilot_paused' });
      persist(); return snapshot();
    }
    function close(price, reason) {
      const p = state.open; if (!p) return;
      const exit = price * (1 - 0.0005);
      const gross = (exit - p.entry) * p.quantity;
      const exitFee = exit * p.quantity * 0.0026;
      const netPnl = gross - p.entryFee - exitFee;
      state.closed.push({ id: p.id, symbol: p.symbol, entry: p.entry, exit: round(exit), quantity: p.quantity, stop: p.stop,
        target: p.target, openedAt: p.openedAt, closedAt: clock(), day: new Date(clock()).toISOString().slice(0, 10),
        reason, grossPnl: round(gross), fees: round(p.entryFee + exitFee), netPnl: round(netPnl), riskUsd: p.riskUsd });
      state.events.push({ at: clock(), type: 'paper_position_closed', reason, netPnl: round(netPnl) });
      state.open = null; persist();
    }
    function tick() {
      if (!state.config.enabled) { state.gateStatus = 'paused'; return snapshot(); }
      const now = clock(), sym = state.config.symbol;
      const source = String(feed.source || '');
      if (feed.demo || feed.status === 'demo') { state.gateStatus = 'demo_blocked'; return snapshot(); }
      if (/coinbase|fallback/i.test(source) || feed.status === 'fallback') { state.gateStatus = 'fallback_blocked'; return snapshot(); }
      if (source !== 'Kraken' || feed.status !== 'live') { state.gateStatus = 'feed_not_live'; return snapshot(); }
      const quote = typeof feed.quote === 'function' ? feed.quote(sym) : null;
      const quoteAge = typeof feed.age === 'function' ? feed.age(sym) : null;
      const candleAge = typeof feed.candleAge === 'function' ? feed.candleAge(sym, 15) : null;
      if (!quote || !(quote.ask > 0 && quote.bid > 0) || quoteAge == null || quoteAge > 15) { state.gateStatus = 'quote_stale'; return snapshot(); }
      if (candleAge == null || candleAge > 120) { state.gateStatus = 'candles_stale'; return snapshot(); }
      const rows = feed.candles(sym, 15);
      if (!Array.isArray(rows) || rows.length < 60) { state.gateStatus = 'warming_up'; return snapshot(); }
      state.gateStatus = 'ready';
      const bars = rows.slice(0, -1).filter(b => [b.time,b.open,b.high,b.low,b.close].every(Number.isFinite));
      if (bars.length < 50) return snapshot();
      const closes = bars.map(b => b.close), last = bars[bars.length - 1];
      if (state.open) {
        const mark = quote.bid;
        state.open.unrealized = round((mark - state.open.entry) * state.open.quantity - state.open.entryFee - mark * state.open.quantity * 0.0026);
        if (mark <= state.open.stop) close(Math.min(state.open.stop, mark), 'stop');
        else if (mark >= state.open.target) close(state.open.target, 'target');
        else persist();
        return snapshot();
      }
      if (todayPnl() <= -(state.config.capital * state.config.dailyLossPct / 100) || todayTrades().length >= state.config.maxTradesPerDay) {
        state.config.enabled = false; state.events.push({ at: now, type: 'daily_guard_paused' }); persist(); return snapshot();
      }
      const priorFast = ema(closes.slice(0, -1), 9), priorSlow = ema(closes.slice(0, -1), 21);
      const fastNow = ema(closes, 9), slowNow = ema(closes, 21), range = atr(bars);
      if (!(priorFast && priorSlow && fastNow && slowNow && range > 0) ||
          !(priorFast <= priorSlow && fastNow > slowNow && last.close > fastNow)) return snapshot();
      if (state.lastSignalBar === last.time) return snapshot();
      state.lastSignalBar = last.time;
      const entry = quote.ask, stop = entry - 2 * range, distance = entry - stop;
      const riskUsd = equity() * state.config.riskPct / 100;
      const quantity = Math.min(riskUsd / distance, (equity() * 0.1) / entry);
      if (!(quantity > 0 && Number.isFinite(quantity))) { persist(); return snapshot(); }
      const fill = entry * (1 + 0.0005), fee = fill * quantity * 0.0026;
      state.open = { id: 'pda-' + now + '-' + last.time, symbol: sym, side: 'long', entry: round(fill), stop: round(stop),
        target: round(fill + 2 * (fill - stop)), quantity: round(quantity), riskUsd: round(riskUsd), entryFee: round(fee),
        openedAt: now, signalBar: last.time, unrealized: 0 };
      state.events.push({ at: now, type: 'paper_position_opened', strategy: 'ema9_21_atr2_long_experimental' });
      persist(); return snapshot();
    }
    const api = { snapshot, configure, setEnabled, tick, reset() { state = { config: Object.assign({}, DEFAULTS), open: null, closed: [], events: [], lastSignalBar: null, gateStatus: 'paused' }; persist(); return snapshot(); } };
    // The app owns scheduling so the personal engine cannot run while Prop Evaluation is selected.
    return api;
  }
  root.PDAAutoPaper = { create, VERSION: '0.1.0-experimental', DEFAULTS };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.PDAAutoPaper;
})(typeof window !== 'undefined' ? window : globalThis);
