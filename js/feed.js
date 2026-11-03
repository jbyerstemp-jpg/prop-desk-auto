/* Market data: Kraken public feed (REST history + WebSocket v2 live). Coinbase public candles as a
   labeled fallback (different venue). No keys, read-only. Demo mode (?demo) is synthetic and labeled. */
(function (root) {
  'use strict';
  const INTERVALS = [5, 15, 60, 240, 1440];
  const store = {};        // "SYM|iv" -> candles
  const tick = {};         // sym -> {last, bid, ask, t}
  const subs = new Set();  // "SYM|iv"
  const tickSubs = new Set();
  const listeners = [];
  const F = { source: 'connecting', status: 'connecting', note: '', demo: false, errors: [] };
  let ws = null, wsBackoff = 1000, fallbackTimer = null, lastMsg = 0, pending = false;

  const krPair = sym => sym.replace('BTC', 'XBT').replace('/', '');
  const cbPair = sym => sym.replace('/', '-');
  const key = (s, iv) => s + '|' + iv;
  function emit() { if (pending) return; pending = true; setTimeout(() => { pending = false; listeners.forEach(f => { try { f(); } catch (e) { console.error(e); } }); }, 120); }
  const candleUpd = {};
  function upsert(k, c) {
    if (!isFinite(c.time)) { if (F.errors.length < 50) F.errors.push('bad candle time on ' + k); return; }
    candleUpd[k] = Date.now();
    const a = store[k] || (store[k] = []);
    const last = a[a.length - 1];
    if (last && last.time === c.time) a[a.length - 1] = c;
    else if (!last || c.time > last.time) { a.push(c); if (a.length > 1500) a.shift(); }
    else { const i = a.findIndex(x => x.time === c.time); if (i >= 0) a[i] = c; }
  }
  function setTick(sym, last, bid, ask, t) {
    tick[sym] = { last: +last, bid: bid != null ? +bid : null, ask: ask != null ? +ask : null, t: t || Date.now() };
  }

  // ---- Kraken REST history ----
  async function krHistory(sym, iv) {
    const r = await fetch(`https://api.kraken.com/0/public/OHLC?pair=${krPair(sym)}&interval=${iv}`, { cache: 'no-store' });
    const j = await r.json();
    if (j.error && j.error.length) throw new Error(j.error.join(','));
    const k = Object.keys(j.result).find(x => x !== 'last');
    const rows = j.result[k].map(x => ({ time: +x[0], open: +x[1], high: +x[2], low: +x[3], close: +x[4], vwap: +x[5], volume: +x[6] }));
    store[key(sym, iv)] = rows; candleUpd[key(sym, iv)] = Date.now();
    const l = rows[rows.length - 1];
    if (l && !tick[sym]) setTick(sym, l.close, null, null, Date.now() - 60000);   // REST close is not a live tick
  }

  // ---- Kraken WebSocket v2 ----
  function wsSend(o) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); }
  function wsSubscribeAll() {
    const syms = [...tickSubs];
    if (syms.length) wsSend({ method: 'subscribe', params: { channel: 'ticker', symbol: syms } });
    const byIv = {};
    for (const k of subs) { const [s, iv] = k.split('|'); (byIv[iv] = byIv[iv] || []).push(s); }
    for (const iv in byIv) wsSend({ method: 'subscribe', params: { channel: 'ohlc', symbol: byIv[iv], interval: +iv, snapshot: true } });
  }
  function wsConnect() {
    if (F.demo) return;
    try { ws = new WebSocket('wss://ws.kraken.com/v2'); } catch (e) { F.errors.push('ws: ' + e.message); startFallback(); return; }
    F.status = 'connecting';
    ws.onopen = () => { wsBackoff = 1000; F.status = 'live'; F.source = 'Kraken'; stopFallback(); wsSubscribeAll(); emit(); };
    ws.onmessage = ev => {
      lastMsg = Date.now();
      let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m.channel === 'ticker' && m.data) { for (const d of m.data) setTick(d.symbol, d.last, d.bid, d.ask); emit(); }
      else if (m.channel === 'ohlc' && m.data) {
        for (const d of m.data) {
          const c = { time: Math.floor(window.Core.parseIsoUtc(d.interval_begin) / 1000), open: +d.open, high: +d.high, low: +d.low, close: +d.close, vwap: +d.vwap, volume: +d.volume };
          upsert(key(d.symbol, d.interval), c);
        }
        emit();
      }
    };
    ws.onclose = () => { F.status = 'reconnecting'; emit(); setTimeout(wsConnect, wsBackoff); wsBackoff = Math.min(30000, wsBackoff * 2); if (wsBackoff >= 8000) startFallback(); };
    ws.onerror = () => { F.errors.push('Kraken WebSocket error'); };
  }

  // ---- Kraken Futures perp mark price (P&L basis; Kraken Prop values positions at a mark price) ----
  const mark = {};            // sym -> {price, t}
  const markSubs = new Set();
  let fws = null, fBackoff = 2000;
  const pfId = sym => 'PF_' + sym.replace('BTC', 'XBT').replace('/', '');
  const pfSym = id => id.replace(/^PF_/, '').replace(/^XBT/, 'BTC').replace(/USD$/, '/USD');
  function fwsConnect() {
    if (F.demo || !markSubs.size) return;
    try { fws = new WebSocket('wss://futures.kraken.com/ws/v1'); } catch (e) { F.errors.push('futures ws: ' + e.message); return; }
    fws.onopen = () => { fBackoff = 2000; fws.send(JSON.stringify({ event: 'subscribe', feed: 'ticker', product_ids: [...markSubs].map(pfId) })); };
    fws.onmessage = ev => {
      let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m.feed === 'ticker' && m.product_id && isFinite(+m.markPrice) && +m.markPrice > 0) { mark[pfSym(m.product_id)] = { price: +m.markPrice, t: Date.now() }; emit(); }
      else if (m.event === 'error' || m.event === 'subscribed_failed') F.errors.push('futures: ' + (m.message || m.event));
    };
    fws.onclose = () => { setTimeout(fwsConnect, fBackoff); fBackoff = Math.min(60000, fBackoff * 2); };
    fws.onerror = () => { F.errors.push('Kraken Futures WebSocket error'); };
  }
  F.wantMark = sym => {
    if (markSubs.has(sym)) return;
    markSubs.add(sym);
    if (F.demo) return;
    if (fws && fws.readyState === 1) fws.send(JSON.stringify({ event: 'subscribe', feed: 'ticker', product_ids: [pfId(sym)] }));
    else if (!fws || fws.readyState > 1) fwsConnect();
  };
  F.candleAge = (sym, iv) => (candleUpd[key(sym, iv)] ? (Date.now() - candleUpd[key(sym, iv)]) / 1000 : null);
  // Reload one series from REST (used when live candle updates stall).
  F.reloadSeries = async (sym, iv) => { if (F.demo) return; try { await krHistory(sym, iv); emit(); } catch (e) { F.errors.push('reload ' + sym + ' ' + iv); } };
  F.mark = sym => (mark[sym] ? mark[sym].price : null);
  F.markAge = sym => (mark[sym] ? (Date.now() - mark[sym].t) / 1000 : null);

  // ---- Cross-check feeds (free, public, no keys): Coinbase Exchange ticker, Hyperliquid mids ----
  const refs = {};            // name -> sym -> {price, t}
  const refSubs = new Set();
  const setRef = (name, sym, price) => { if (!(price > 0)) return; (refs[name] = refs[name] || {})[sym] = { price, t: Date.now() }; };
  let cbws = null, hlws = null, cbBack = 3000, hlBack = 3000;
  function cbConnect() {
    if (F.demo || !refSubs.size) return;
    try { cbws = new WebSocket('wss://ws-feed.exchange.coinbase.com'); } catch (e) { return; }
    cbws.onopen = () => { cbBack = 3000; cbws.send(JSON.stringify({ type: 'subscribe', product_ids: [...refSubs].map(cbPair), channels: ['ticker'] })); };
    cbws.onmessage = ev => { let m; try { m = JSON.parse(ev.data); } catch (e) { return; } if (m.type === 'ticker' && m.product_id) { setRef('Coinbase', m.product_id.replace('-', '/'), +m.price); emit(); } };
    cbws.onclose = () => { setTimeout(cbConnect, cbBack); cbBack = Math.min(60000, cbBack * 2); };
  }
  function hlConnect() {
    if (F.demo || !refSubs.size) return;
    try { hlws = new WebSocket('wss://api.hyperliquid.xyz/ws'); } catch (e) { return; }
    hlws.onopen = () => { hlBack = 3000; hlws.send(JSON.stringify({ method: 'subscribe', subscription: { type: 'allMids' } })); };
    hlws.onmessage = ev => { let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m.channel === 'allMids' && m.data && m.data.mids) { for (const sym of refSubs) { const v = m.data.mids[sym.split('/')[0]]; if (v != null) setRef('Hyperliquid', sym, +v); } emit(); } };
    hlws.onclose = () => { setTimeout(hlConnect, hlBack); hlBack = Math.min(60000, hlBack * 2); };
  }
  F.wantRefs = sym => {
    if (refSubs.has(sym)) return;
    refSubs.add(sym);
    if (F.demo) return;
    if (cbws && cbws.readyState === 1) cbws.send(JSON.stringify({ type: 'subscribe', product_ids: [cbPair(sym)], channels: ['ticker'] }));
    else if (!cbws || cbws.readyState > 1) cbConnect();
    if (!hlws || hlws.readyState > 1) hlConnect();
  };
  // All live quotes for one symbol, for the cross-check panel.
  F.sources = sym => {
    const now = Date.now(), out = [];
    if (tick[sym]) out.push({ name: 'Kraken spot', price: tick[sym].last, ageSec: (now - tick[sym].t) / 1000 });
    if (mark[sym]) out.push({ name: 'Kraken Futures mark', price: mark[sym].price, ageSec: (now - mark[sym].t) / 1000 });
    for (const n of Object.keys(refs)) if (refs[n][sym]) out.push({ name: n, price: refs[n][sym].price, ageSec: (now - refs[n][sym].t) / 1000 });
    return out;
  };

  // ---- Coinbase fallback (different venue: labeled) ----
  async function cbCandles(sym, iv) {
    const gran = { 1: 60, 5: 300, 15: 900, 60: 3600, 240: 3600, 1440: 86400 }[iv];
    const r = await fetch(`https://api.exchange.coinbase.com/products/${cbPair(sym)}/candles?granularity=${gran}`, { cache: 'no-store' });
    let rows = (await r.json()).map(x => ({ time: x[0], low: x[1], high: x[2], open: x[3], close: x[4], volume: x[5] })).reverse();
    if (iv === 240) {
      const out = [];
      for (const c of rows) {
        const t = Math.floor(c.time / 14400) * 14400, l = out[out.length - 1];
        if (l && l.time === t) { l.high = Math.max(l.high, c.high); l.low = Math.min(l.low, c.low); l.close = c.close; l.volume += c.volume; }
        else out.push(Object.assign({}, c, { time: t }));
      }
      rows = out;
    }
    store[key(sym, iv)] = rows;
    const l = rows[rows.length - 1];
    if (l) setTick(sym, l.close, null, null, Date.now());
  }
  function startFallback() {
    if (fallbackTimer || F.demo) return;
    F.source = 'Coinbase (fallback)'; F.note = 'Kraken feed down: showing Coinbase prices. Kraken Prop fills can differ.';
    const run = async () => {
      for (const k of subs) { const [s, iv] = k.split('|'); try { await cbCandles(s, +iv); } catch (e) { F.errors.push('coinbase ' + k); } }
      F.status = 'fallback'; emit();
    };
    run(); fallbackTimer = setInterval(run, 20000);
  }
  function stopFallback() { if (fallbackTimer) { clearInterval(fallbackTimer); fallbackTimer = null; F.note = ''; } }

  // ---- Demo (synthetic) ----
  function demoStart() {
    F.demo = true; F.source = 'DEMO (synthetic)'; F.status = 'demo'; F.note = 'DEMO DATA: made-up prices for testing. Not the market.';
    const startPx = { 'BTC/USD': 77500, 'ETH/USD': 3900, 'SOL/USD': 190, 'XRP/USD': 2.4, 'USDT/USD': 0.999 };
    let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const now = Math.floor(Date.now() / 60000) * 60;
    const gen = sym => {
      let p = startPx[sym] || 100; const m = [];
      for (let t = now - 60 * 60 * 24 * 60; t <= now; t += 300) {
        const drift = Math.sin(t / 400000) * 0.00004, o = p;
        p = p * (1 + drift + (rnd() - 0.5) * 0.003);
        m.push({ time: t, open: o, high: Math.max(o, p) * (1 + rnd() * 0.0015), low: Math.min(o, p) * (1 - rnd() * 0.0015), close: p, volume: 1 + rnd() * 10 });
      }
      for (const iv of INTERVALS) {
        const s = iv * 60, out = [];
        for (const c of m) { const t = Math.floor(c.time / s) * s, l = out[out.length - 1];
          if (l && l.time === t) { l.high = Math.max(l.high, c.high); l.low = Math.min(l.low, c.low); l.close = c.close; l.volume += c.volume; }
          else out.push(Object.assign({}, c, { time: t })); }
        store[key(sym, iv)] = out.slice(-720);
      }
      // 1m (demo only): split the last 144 five-minute bars into five 1-minute bars each, along a straight path
      const one = [];
      for (const c of store[key(sym, 5)].slice(-144)) for (let k = 0; k < 5; k++) {
        const a = c.open + (c.close - c.open) * k / 5, b = c.open + (c.close - c.open) * (k + 1) / 5;
        one.push({ time: c.time + 60 * k, open: a, high: Math.max(a, b) * (1 + rnd() * 0.0005), low: Math.min(a, b) * (1 - rnd() * 0.0005), close: b, volume: c.volume / 5 });
      }
      store[key(sym, 1)] = one.filter(x => x.time <= now);   // no bars in the future
      setTick(sym, p);
    };
    Object.keys(startPx).forEach(gen);
    setInterval(() => {
      for (const sym of Object.keys(startPx)) {
        const tk = tick[sym]; const p = sym === 'USDT/USD' ? 0.999 : tk.last * (1 + (rnd() - 0.5) * 0.0008);
        setTick(sym, p, p * 0.9999, p * 1.0001);
        if (markSubs.has(sym)) mark[sym] = { price: p * 1.0002, t: Date.now() };
        if (refSubs.has(sym)) { setRef('Coinbase', sym, p * 0.9999); setRef('Hyperliquid', sym, p * 1.0001); }
        const t = Math.floor(Date.now() / 1000);
        for (const iv of [1].concat(INTERVALS)) {
          const a = store[key(sym, iv)], s = iv * 60, bt = Math.floor(t / s) * s, l = a[a.length - 1];
          if (l.time === bt) { l.high = Math.max(l.high, p); l.low = Math.min(l.low, p); l.close = p; }
          else a.push({ time: bt, open: l.close, high: Math.max(l.close, p), low: Math.min(l.close, p), close: p, volume: 1 });
        }
      }
      emit();
    }, 1000);
  }

  // ---- Public API ----
  F.candles = (sym, iv) => store[key(sym, iv)] || [];
  F.price = sym => (tick[sym] ? tick[sym].last : null);
  F.quote = sym => tick[sym] || null;
  F.age = sym => (tick[sym] ? (Date.now() - tick[sym].t) / 1000 : null);
  F.on = f => listeners.push(f);
  F.want = async function (sym, ivs) {
    const newOnes = [];
    if (!tickSubs.has(sym)) { tickSubs.add(sym); if (ws && ws.readyState === 1) wsSend({ method: 'subscribe', params: { channel: 'ticker', symbol: [sym] } }); }
    for (const iv of ivs) { const k = key(sym, iv); if (!subs.has(k)) { subs.add(k); newOnes.push(iv); } }
    if (F.demo || !newOnes.length) return;
    for (const iv of newOnes) {
      try { await krHistory(sym, iv); }
      catch (e) { F.errors.push(`Kraken REST ${sym} ${iv}: ${e.message}`); if (fallbackTimer) { try { await cbCandles(sym, iv); } catch (x) { } } }
      if (ws && ws.readyState === 1) wsSend({ method: 'subscribe', params: { channel: 'ohlc', symbol: [sym], interval: iv, snapshot: true } });
    }
    emit();
  };
  // Refresh: reload history for everything watched and reconnect the live socket.
  F.refresh = async function () {
    if (F.demo) { emit(); return; }
    const ks = [...subs];
    for (const k of ks) { const [s, iv] = k.split('|'); try { await krHistory(s, +iv); } catch (e) { try { await cbCandles(s, +iv); } catch (x) { } } }
    try { if (ws) ws.close(); } catch (e) { }
    try { if (fws) fws.close(); } catch (e) { }
    try { if (cbws) cbws.close(); } catch (e) { }
    try { if (hlws) hlws.close(); } catch (e) { }
    emit();
  };
  F.start = function (opt) {
    opt = opt || {};
    if (opt.demo) { demoStart(); return; }
    wsConnect();
    // watchdog: no messages for 20s while "live" -> reconnect
    setInterval(() => { if (!F.demo && F.status === 'live' && lastMsg && Date.now() - lastMsg > 20000) { try { ws.close(); } catch (e) { } } }, 5000);
  };
  F.INTERVALS = INTERVALS;
  root.Feed = F;
})(window);
