/* Kraken Prop Desk - core math (no DOM). Runs in the browser and in Node tests.
   Rules sources (checked Nov 1, 2026): see RULES.md. Every number here is editable in Settings. */
(function (root) {
  'use strict';

  // ---- Kraken Prop rules -------------------------------------------------
  // MDL, MDD, fees, $200k cap: Kraken support centre. Targets, MDD per plan and prices:
  // Kraken Prop storefront as recorded by PropRubric (27 Oct 2026). Confirm on the purchase screen.
  const PLANS = {
    advanced:     { name: 'Advanced',     target: 0.09, mdd: 0.03, mdl: 0.03,
                    price: { 5000: 20, 10000: 40, 25000: 95, 50000: 180, 100000: 330, 200000: 660 } },
    intermediate: { name: 'Intermediate', target: 0.12, mdd: 0.05, mdl: 0.03,
                    price: { 5000: 33, 10000: 65, 25000: 150, 50000: 280, 100000: 545, 200000: 1090 } },
    starter:      { name: 'Starter',      target: 0.10, mdd: 0.06, mdl: 0.03,
                    price: { 5000: 45, 10000: 85, 25000: 215, 50000: 400, 100000: 800 } },
    custom:       { name: 'Custom',       target: 0.10, mdd: 0.05, mdl: 0.03, price: {} }
  };
  const SIZES = [5000, 10000, 25000, 50000, 100000, 200000];
  const FEES = { commission: 0.0004, fundingPerDay: 0.00033, fundingEveryHours: 4 };
  const CAPITAL_CAP = 200000;
  const ADDON_90 = 0.20;            // +20% of base price for the 90/10 split
  const RESET_MIN_UTC = 30;         // MDL resets 00:30 UTC
  // Max leverage per coin (Breakout symbols list, Oct 29 2026; Kraken blog Aug 18 2026: BTC 10x).
  // Evals bought before Aug 18 2026 may still be on BTC 5x: set per account.
  const LEVERAGE = { BTC: 10, ETH: 5, SOL: 5, XRP: 5, LINK: 5, LTC: 5, DOGE: 5, AVAX: 5, SUI: 5, HYPE: 3, WLD: 3, _default: 2 };
  // Checked in the owner's Kraken Prop app (Advanced Eval, Oct 31 2026): BTC 10x, ETH 5x, HYPE 3x, SOL 5x, WLD 3x, XRP 5x.
  // Max position per market, USD notional (Breakout symbols list). Unknown coins: assume 25k.
  const MAX_NOTIONAL = { BTC: 1e6, ETH: 1e6, SOL: 5e5, XRP: 3e5, LINK: 2e5, LTC: 2e5, DOGE: 2e5, AVAX: 2e5, SUI: 2e5, HYPE: 2e5, _default: 25000 };

  // ---- Risk profiles (his written rules; % of STARTING balance) ------------
  const PROFILES = [
    { id: 'safe',       name: 'Safe',       riskPct: 0.25, maxOpenPct: 0.50, maxTrades: 2, stopAfterLosses: 2,
      note: 'Slow and steady. About 12 losses before a 3% floor.' },
    { id: 'steady',     name: 'Steady',     riskPct: 0.50, maxOpenPct: 1.00, maxTrades: 3, stopAfterLosses: 2,
      note: 'About 6 losses of room on Advanced.' },
    { id: 'push',       name: 'Push',       riskPct: 0.75, maxOpenPct: 1.50, maxTrades: 3, stopAfterLosses: 2,
      note: 'About 4 losses of room on Advanced.' },
    { id: 'aggressive', name: 'Aggressive', riskPct: 1.00, maxOpenPct: 2.00, maxTrades: 3, stopAfterLosses: 2,
      note: 'About 3 losses and the account is gone on Advanced.' },
    { id: 'sprint',     name: 'Sprint',     riskPct: 1.25, maxOpenPct: 1.25, maxTrades: 3, stopAfterLosses: 2,
      note: 'One-day pass attempt. 2 losses ends the day; 3 ends the account on Advanced. Fee is the real bet.' }
  ];
  const profileById = id => PROFILES.find(p => p.id === id) || PROFILES[1];

  // ---- Time --------------------------------------------------------------
  // Daily reset, minutes after 00:00 UTC (Kraken Prop: 30 = 00:30 UTC). Each account can set its own.
  function lastReset(nowMs, resetMin) {
    const m = resetMin == null ? RESET_MIN_UTC : resetMin;
    const d = new Date(nowMs);
    let t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, m);
    if (t > nowMs) t -= 86400000;
    return t;
  }
  const nextReset = (nowMs, resetMin) => lastReset(nowMs, resetMin) + 86400000;
  /* "HH:MM" UTC text -> minutes; null if invalid. */
  function parseResetUtc(t) { const m = /^\s*(\d{1,2}):(\d{2})\s*$/.exec(String(t || '')); if (!m || +m[1] > 23 || +m[2] > 59) return null; return +m[1] * 60 + +m[2]; }

  const _fmtCache = {};
  const _partCache = new Map();
  function tzParts(tsSec, tz) {
    const key = tz + '|' + tsSec;
    let v = _partCache.get(key);
    if (v) return v;
    let f = _fmtCache[tz];
    if (!f) f = _fmtCache[tz] = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short' });
    const p = {};
    for (const x of f.formatToParts(new Date(tsSec * 1000))) p[x.type] = x.value;
    v = { date: `${p.year}-${p.month}-${p.day}`, min: (+p.hour % 24) * 60 + (+p.minute), wd: p.weekday };
    if (_partCache.size > 50000) _partCache.clear();
    _partCache.set(key, v);
    return v;
  }

  // ISO time -> ms without Date.parse (Kraken sends 9 decimal places; older Safari rejects that).
  function parseIsoUtc(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?Z$/.exec(String(s));
    if (!m) return NaN;
    const ms = m[7] ? Math.floor(Number((m[7] + '000').slice(0, 3))) : 0;
    return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], ms);
  }

  /* Prop price estimate: Kraken Prop quotes track USDT-margined perps (Breakout: OKX/Bybit USDT perps
     are the best proxy). Convert the Kraken Futures USD mark into USDT: mark / (USDT price in USD).
     Hypothesis from one same-moment comparison (Oct 31): owner must confirm. Unknown input -> null. */
  function propEstimate(markUsd, usdtUsd) {
    if (!(markUsd > 0) || !(usdtUsd > 0.9 && usdtUsd < 1.1)) return null;
    return markUsd / usdtUsd;
  }

  /* Cross-check live sources. quotes: [{name, price, ageSec}]. Fresh = ageSec <= maxAge.
     Median of fresh prices; any source more than tolBps away is flagged. Fewer than 2 fresh = unverified. */
  function consensus(quotes, maxAge, tolBps) {
    maxAge = maxAge || 60; tolBps = tolBps || 15;
    const fresh = quotes.filter(q => q.price > 0 && q.ageSec != null && q.ageSec <= maxAge);
    if (!fresh.length) return { median: null, fresh: [], outliers: [], verified: false, spreadBps: null };
    const ps = fresh.map(q => q.price).sort((a, b) => a - b);
    const mid = ps.length % 2 ? ps[(ps.length - 1) / 2] : (ps[ps.length / 2 - 1] + ps[ps.length / 2]) / 2;
    const rows = fresh.map(q => Object.assign({}, q, { devBps: (q.price / mid - 1) * 1e4 }));
    const outliers = rows.filter(r => Math.abs(r.devBps) > tolBps).map(r => r.name);
    return { median: mid, fresh: rows, outliers, verified: fresh.length >= 2 && outliers.length < fresh.length / 2,
      spreadBps: (ps[ps.length - 1] / ps[0] - 1) * 1e4 };
  }
  /* Feed reliability log (owner's choice, Nov 2 2026: measure which feed is most reliable instead of guessing).
     Sampled every 15 s while the app is open. Per UTC day and feed: n = samples, live = samples with a fresh price (<= maxAge s),
     off = samples where the price was > tolBps from the median of the live feeds (needs 3+ live feeds), drops = live -> not live changes.
     A gap of more than 60 s since the last sample (app closed, phone asleep) is not counted as a drop. Keeps 30 days. */
  function feedTally(log, quotes, nowMs, maxAge, tolBps) {
    maxAge = maxAge || 60; tolBps = tolBps || 15;
    const L = log && log.days ? log : { days: {}, last: {}, t: 0 };
    const day = new Date(nowMs).toISOString().slice(0, 10), D = L.days[day] || (L.days[day] = {});
    const cs = consensus(quotes, maxAge, tolBps), offSet = cs.fresh.length >= 3 ? new Set(cs.outliers) : new Set(), cont = L.t && nowMs - L.t <= 60000;
    for (const q of quotes) {
      const r = D[q.name] || (D[q.name] = { n: 0, live: 0, off: 0, drops: 0 }), live = q.price > 0 && q.ageSec != null && q.ageSec <= maxAge;
      r.n++; if (live) r.live++; if (live && offSet.has(q.name)) r.off++;
      if (cont && L.last[q.name] === true && !live) r.drops++;
      L.last[q.name] = live;
    }
    L.t = nowMs;
    for (const k of Object.keys(L.days).sort().slice(0, -30)) delete L.days[k];
    return L;
  }
  /* Summary over the last `days` UTC days: per feed live %, off % (of live samples), drops, hours sampled. Best live % first. */
  function feedReport(log, nowMs, days) {
    days = days || 14;
    const keep = new Set(Array.from({ length: days }, (_, k) => new Date(nowMs - k * 86400000).toISOString().slice(0, 10))), sum = {};
    for (const [d, feeds] of Object.entries((log && log.days) || {})) { if (!keep.has(d)) continue;
      for (const [f, r] of Object.entries(feeds)) { const a = sum[f] || (sum[f] = { n: 0, live: 0, off: 0, drops: 0 }); a.n += r.n; a.live += r.live; a.off += r.off; a.drops += r.drops; } }
    return Object.entries(sum).map(([name, a]) => ({ name, livePct: a.n ? a.live / a.n * 100 : null, offPct: a.live ? a.off / a.live * 100 : null, drops: a.drops, hours: a.n * 15 / 3600 }))
      .sort((x, y) => (y.livePct || 0) - (x.livePct || 0));
  }
  /* Calibration to Prop's real price. Each entry: {t, sym, prop, est} where est = the app's estimate at
     that moment. Residual = median of (prop/est - 1) over the last 5 entries from the past 7 days, in bps. */
  function calibration(entries, sym, nowMs) {
    const recent = (entries || []).filter(e => e.sym === sym && e.prop > 0 && e.est > 0 && nowMs - e.t <= 7 * 86400000)
      .sort((a, b) => b.t - a.t).slice(0, 5);
    if (!recent.length) return { bps: 0, n: 0, spreadBps: null };
    const r = recent.map(e => (e.prop / e.est - 1) * 1e4).sort((a, b) => a - b);
    const med = r.length % 2 ? r[(r.length - 1) / 2] : (r[r.length / 2 - 1] + r[r.length / 2]) / 2;
    return { bps: med, n: r.length, spreadBps: r[r.length - 1] - r[0] };
  }

  /* Read a Kraken Prop screen (OCR text or copied text). Returns what it could read; anything not found
     stays null (never 0). Only the Open section is read; closed positions are ignored. */
  function parseKrakenProp(text, nowMs) {
    const num = v => (v == null ? null : Number(String(v).replace(/,/g, '')));
    const T = String(text || '').replace(/\r/g, '');
    const grab = re => { const m = re.exec(T); return m ? num(m[1]) : null; };
    const out = { account: {}, positions: [], groups: [], warnings: [], _now: nowMs };
    const nm = /\b(Advanced|Intermediate|Starter|Lite)\s*(Eval|Funded)\w*\s*#?\s*(\d+)?/i.exec(T);
    if (nm) out.account = { plan: nm[1].toLowerCase(), phase: /fund/i.test(nm[2]) ? 'funded' : 'eval',
      label: (nm[1][0].toUpperCase() + nm[1].slice(1).toLowerCase()) + ' ' + (nm[2][0].toUpperCase() + nm[2].slice(1).toLowerCase()) + (nm[3] ? ' ' + nm[3] : '') };
    out.account.equity = grab(/(?:Total\s+equity|Account\s+equity|Net\s+liquidation(?:\s+value)?|(?:^|\n)\s*Equity)[^\d-]{0,20}([\d,]+\.\d+)/i);
    if (out.account.equity == null) {   // label scrolled off: first "N,NNN.NNNN USD" above Target equity
      const head = T.split(/Target\s+equity/i)[0];
      const m = /(?:^|\n)\s*([\d,]+\.\d{2,})\s*us/i.exec(head);
      if (m && T.length > head.length) out.account.equity = num(m[1]);
    }
    // Portfolio screen: Balance and open P&L are shown directly (most reliable source for the balance).
    out.account.balance = grab(/(?:^|\n)\s*Balance\s+([\d,]+\.\d+)\s*US/i);
    out.account.upnl = (m => m ? num(m[1]) : null)(/(?:^|\n)\s*UP\s*&\s*L\s+([-+]?[\d,]*\.?\d+)/i.exec(T));
    out.account.usedMargin = grab(/Used\s+margin\s+([\d,]+\.\d+)/i);
    out.account.availMargin = grab(/Available\s+margin\s+([\d,]+\.\d+)/i);
    out.account.target = grab(/(?:Target\s+equity|Profit\s+target(?:\s+balance)?)[^\d]{0,10}([\d,]+\.\d+)/i);
    out.account.dailyLimit = grab(/(?:Daily\s+loss\s+limit|Daily\s+drawdown\s+limit|Max(?:imum)?\s+daily\s+loss\s+(?:limit|level))[^\d]{0,10}([\d,]+\.\d+)/i);
    out.account.drawdownLimit = grab(/(?:Drawdown\s+limit|Max(?:imum)?\s+(?:drawdown|loss)\s+(?:limit|level))[^\d]{0,10}([\d,]+\.\d+)/i);
    const parts = T.split(/\n\s*Closed\b/i), openPart = parts[0], closedPart = parts.slice(1).join('\n');
    const lines = openPart.split('\n').map(l => l.trim()).filter(Boolean);
    const sideRe = /\b(Short|Long)\b\s*([-+]?\d+(?:\.\d+)?)\s*%/i;
    const qtyRe = /^([\d]*\.?\d+)\s*([A-Z]{2,6})\b(?!\/)\s*([-+]?[\d,]*\.?\d+)?/;
    const entryRe = /@\s*([\d,]+\.?\d*)\s*(?:US[DPB]?|usD|usp)?\s*([\d,]+\.?\d*)?/i;
    for (let i = 0; i < lines.length; i++) {
      const g = /\b([A-Z]{2,6})\/USD\b\s+([\d,]+\.\d+)/.exec(lines[i]);
      if (g) out.groups.push({ base: g[1], notional: num(g[2]) });
      const sm = sideRe.exec(lines[i]);
      if (!sm || !lines[i + 1]) continue;
      const qm = qtyRe.exec(lines[i + 1].replace(/\s+(?=BTC|ETH|SOL|XRP|HYPE|WLD)/, ''));
      const em = lines[i + 2] ? entryRe.exec(lines[i + 2]) : null;
      if (!qm || !em) { out.warnings.push('Could not read a position near: ' + lines[i]); continue; }
      let tp = false, sl = false;
      for (let j = i + 3; j < Math.min(lines.length, i + 5); j++) {
        if (sideRe.test(lines[j]) || /\b[A-Z]{2,6}\/USD\b/.test(lines[j])) break;
        if (/\d\s*TP\b/i.test(lines[j])) tp = true;
        if (/\d\s*S[LlI1|]\b/.test(lines[j])) sl = true;
      }
      out.positions.push({ side: sm[1].toLowerCase(), qty: num(qm[1]), base: qm[2], sym: qm[2] + '/USD',
        upnl: qm[3] != null ? num(qm[3]) : null, entry: num(em[1]), price: em[2] ? num(em[2]) : null, hasTP: tp, hasSL: sl });
    }
    // Order sheets (tap an order in Kraken Prop, Nov 1 2026 layout): "Limit Buy / 0.094 BTC / @ 77692 USD", then on the Details tab
    // "Status open - 0% filled", "Type buy-limit", "Price 77,692.00", "Open time …", "Order ID …", and on the TP/SL tab "Take profit
    // price …", "Stop loss price …". An order is NOT a position: it's a working order until it's filled.
    out.orders = [];
    let Tg = T;   // text for the general position reader, with order sheets taken out (it would misread "Limit Buy 0.094 BTC @ 77692" as a position)
    { const ore = /\b(Limit|Market|Stop[\s-]*(?:Limit|Market|Loss)?|Take[\s-]*Profit)\s+(Buy|Sell)\s*\n\s*([\d]*\.?\d+)\s*([A-Z]{2,6})\b[^\n]*\n\s*@\s*([\d,]+\.?\d*)\s*(?:US[DPB]?|usD|usp)?([\s\S]*?)(?=\n\s*(?:Limit|Market|Stop|Take[\s-]*Profit)\s+(?:Buy|Sell)\s*\n|$)/gi;
      let om;
      while ((om = ore.exec(T))) {
        const body = om[6], g = re => { const m = re.exec(body); return m ? num(m[1]) : null; };
        const st = /Status\s+(open|filled|closed|cancel+ed|canceled|expired|partially\s*filled)\s*-?\s*(\d{1,3}(?:\.\d+)?)?\s*%?\s*(?:filled)?/i.exec(body);
        const pct = st && st[2] != null ? +st[2] : null, word = st ? st[1].toLowerCase() : null;
        const status = !st ? null : /cancel|expired/.test(word) ? 'cancelled' : (/filled|closed/.test(word) && pct == null) || pct >= 100 ? 'filled' : pct > 0 ? 'partial' : 'working';
        const ot = /Open\s*time\s*([A-Z][a-z]{2})[a-z]*\.?\s+(\d{1,2}),?\s*(\d{4})\s*(?:at)?\s*(\d{1,2}):(\d{2})\s*([AP])\.?M/i.exec(body);
        let openedMs = null;
        if (ot) { const mo = 'janfebmaraprmayjunjulaugsepoctnovdec'.indexOf(ot[1].toLowerCase()) / 3; let h = +ot[4] % 12; if (/p/i.test(ot[6])) h += 12;
          if (mo >= 0) openedMs = new Date(+ot[3], mo, +ot[2], h, +ot[5]).getTime(); }
        const idm = /(?:^|\n)\s*Order\s*ID\s*([A-Z0-9]{4,}(?:-[A-Z0-9]{3,}){1,4})/i.exec(body);
        const pidm = /(?:Parent|Linked|Original|Main)\s*order(?:\s*ID)?\s*([A-Z0-9]{4,}(?:-[A-Z0-9]{3,}){1,4})/i.exec(body);
        // Fill time of a filled order ("Filled/Close/Last fill/Execution time Nov 2, 2026 at 9:41 AM"), phone's local time.
        const ft = /(?:Fill(?:ed)?|Close[d]?|Last\s*fill|Execution|Trigger(?:ed)?)\s*time\s*([A-Z][a-z]{2})[a-z]*\.?\s+(\d{1,2}),?\s*(\d{4})\s*(?:at)?\s*(\d{1,2}):(\d{2})\s*([AP])\.?M/i.exec(body);
        let filledMs = null;
        if (ft) { const mo = 'janfebmaraprmayjunjulaugsepoctnovdec'.indexOf(ft[1].toLowerCase()) / 3; let h = +ft[4] % 12; if (/p/i.test(ft[6])) h += 12;
          if (mo >= 0) filledMs = new Date(+ft[3], mo, +ft[2], h, +ft[5]).getTime(); }
        const avgFill = g(/(?:Average|Avg\.?)\s*(?:fill(?:ed)?\s*|execution\s*)?price\s*([\d,]+\.?\d*)/i);
        const type = /^limit/i.test(om[1]) ? 'limit' : /^market/i.test(om[1]) ? 'market' : /^stop/i.test(om[1]) ? 'stop' : 'take-profit';
        out.orders.push({ type, side: /buy/i.test(om[2]) ? 'long' : 'short', qty: num(om[3]), base: om[4].toUpperCase(), sym: om[4].toUpperCase() + '/USD', price: num(om[5]),
          status, filledPct: pct, tp: g(/Take\s*profit\s*price\s*([\d,]+\.?\d*)/i), sl: g(/Stop\s*loss\s*price\s*([\d,]+\.?\d*)/i), openedMs, orderId: idm ? idm[1].toUpperCase() : null,
          parentId: pidm ? pidm[1].toUpperCase() : null, avgFill, filledMs });
        Tg = Tg.replace(om[0], '\n');
      }
      // The Details tab and the TP/SL tab of one order are two screenshots: join them (same type, side, size and price).
      const mo = [];
      for (const o of out.orders) { const tw = mo.find(m => m.type === o.type && m.side === o.side && m.qty === o.qty && m.price === o.price && (m.orderId == null || o.orderId == null || m.orderId === o.orderId));
        if (tw) { for (const k of Object.keys(o)) if (tw[k] == null && o[k] != null) tw[k] = o[k]; } else mo.push(Object.assign({}, o)); }
      out.orders = mo; }
    // Generic one-line positions from other platforms, e.g. "BTCUSD Long 0.10 @ 77,606.10 P&L -11.36" or "Sell 0.1 BTC at 77606.1".
    out.layout = out.positions.length || /Avg\s*price|Total\s+equity/i.test(T) ? 'kraken' : 'generic';
    if (!out.positions.length) {
      const gre = /(?:\b([A-Z]{2,6})[-\/]?(?:USDT|USDC|USD)?\b[^\n]{0,12}?)?\b(long|short|buy|sell)\b\s*([\d]*\.?\d+)\s*([A-Z]{2,6})?(?:[-\/]?(?:USDT|USDC|USD))?\s*(?:@|at|entry(?:\s*price)?:?)\s*\$?([\d,]+\.?\d*)(?:[^\n]*?(?:P&L|PnL|uPnL|Unrealized)[:\s]*([-+]?\$?[\d,]*\.?\d+))?/gi;
      let gm;
      while ((gm = gre.exec(Tg))) {
        const base = (gm[4] || gm[1] || '').toUpperCase(); if (!base || /^(USD|USDT|USDC)$/.test(base)) continue;
        out.positions.push({ side: /short|sell/i.test(gm[2]) ? 'short' : 'long', qty: num(gm[3]), base, sym: base + '/USD', entry: num(gm[5]),
          upnl: gm[6] != null ? num(gm[6].replace('$', '')) : null, price: null, hasTP: false, hasSL: false });
      }
      if (out.positions.length) out.warnings.push('Read with the general reader (not a known platform layout): check every number before syncing.');
    }
    // Closed list (Kraken shows each closed position's realized P&L, fees included).
    out.closedRows = [];
    { const cl = closedPart.split('\n').map(l => l.trim()).filter(Boolean);
      for (let i = 0; i < cl.length; i++) {
        const sm = /\b(Short|Long)\b/i.exec(cl[i]); if (!sm || !cl[i + 1]) continue;
        const qm = /^([\d]*\.?\d+)\s*([A-Z]{2,6})\b(?!\/)\s*([-+]?[\d,]*\.?\d+)?/.exec(cl[i + 1].replace(/\s+(?=BTC|ETH|SOL|XRP|HYPE|WLD)/, ''));
        const em = cl[i + 2] ? /@\s*([\d,]+\.?\d*)\s*(?:US[DPB]?|usD|usp)?\s*([\d,]+\.?\d*)?/i.exec(cl[i + 2]) : null;
        if (!qm || !em || qm[3] == null) continue;
        out.closedRows.push({ side: sm[1].toLowerCase(), qty: num(qm[1]), base: qm[2], sym: qm[2] + '/USD', realized: num(qm[3]), entry: num(em[1]), exit: em[2] ? num(em[2]) : null });
      } }
    // Trades tab (History -> Trades): each fill with side, open/close, size, order type, price and time.
    // Time-only rows are today (phone's local date); older rows show a date and no time.
    out.fills = [];
    { const fl = T.split('\n').map(l => l.trim()).filter(Boolean);
      const base = new Date(out._now || Date.now());
      for (let i = 0; i < fl.length; i++) {
        const hm = /\b(Buy|Sell)\s+([A-Z]{2,6})\s+(Opening|Closing)\b\s*(?:(\d{1,2}):(\d{2})\s*([AP])\.?M|([A-Z][a-z]{2})\w*\s+(\d{1,2}),\s*(\d{4}))?/i.exec(fl[i]);
        if (!hm || !fl[i + 1]) continue;
        const qm = /^([\d]*\.?\d+)\s*(?:USD|BTC|ETH|SOL|XRP|[A-Z]{2,6})?\b/.exec(fl[i + 1]);
        const pm = fl[i + 2] ? /@\s*(Market|Limit|Stop[\w\s-]*|Take[\w\s-]*)?\s*([\d,]+\.?\d*)/i.exec(fl[i + 2]) : null;
        if (!qm) continue;
        let t = null, day = null;
        if (hm[4]) { let h = +hm[4] % 12; if (/p/i.test(hm[6])) h += 12; t = new Date(base.getFullYear(), base.getMonth(), base.getDate(), h, +hm[5]).getTime(); if (t > base.getTime() + 6e4) t -= 864e5; }
        else if (hm[7]) { const mo = 'janfebmaraprmayjunjulaugsepoctnovdec'.indexOf(hm[7].toLowerCase()) / 3; if (mo >= 0) day = new Date(+hm[9], mo, +hm[8]).getTime(); }
        out.fills.push({ side: hm[1].toLowerCase(), base: hm[2].toUpperCase(), sym: hm[2].toUpperCase() + '/USD', action: /open/i.test(hm[3]) ? 'open' : 'close',
          qty: num(qm[1]), type: pm && pm[1] ? pm[1].trim().toLowerCase() : null, price: pm ? num(pm[2]) : null, t, day });
      } }
    // De-duplicate (the same position can appear on two overlapping screenshots)
    const seen = new Set();
    out.positions = out.positions.filter(p => { const k = [p.side, p.qty, p.entry].join('|'); if (seen.has(k)) return false; seen.add(k); return true; });
    // Position detail sheets (tap a position): side, size, take-profit and stop-loss prices.
    out.details = [];
    const dre = /\b(Short|Long)\s*\n\s*([\d]*\.?\d+)\s*([A-Z]{2,6})\b([\s\S]*?)(?=\n\s*(?:Short|Long)\s*\n|$)/g;
    let dm;
    while ((dm = dre.exec(T))) {
      const body = dm[4];
      const g = re => { const m = re.exec(body); return m ? num(m[1]) : null; };
      const tp = g(/Take\s*profit\s*price\s*([\d,]+\.?\d*)/i), sl = g(/Stop\s*loss\s*price\s*([\d,]+\.?\d*)/i);
      const entry = g(/Average\s*opening\s*price\s*([\d,]+\.?\d*)/i), price = g(/Current\s*price\s*([\d,]+\.?\d*)/i);
      const fee = g(/Opening\s*fee\s*([\d,]*\.?\d+)/i), qty2 = g(/Total\s*open\s*quantity\s*([\d]*\.?\d+)/i);
      // "Open time Oct 31, 2026 at 7:37PM" is the phone's local time.
      const ot = /Open\s*time\s*([A-Z][a-z]{2})[a-z]*\.?\s+(\d{1,2}),?\s*(\d{4})\s*(?:at)?\s*(\d{1,2}):(\d{2})\s*([AP])\.?M/i.exec(body);
      let openedMs = null;
      if (ot) { const mo = 'janfebmaraprmayjunjulaugsepoctnovdec'.indexOf(ot[1].toLowerCase()) / 3; let h = +ot[4] % 12; if (/p/i.test(ot[6])) h += 12;
        if (mo >= 0) openedMs = new Date(+ot[3], mo, +ot[2], h, +ot[5]).getTime(); }
      const did = /Order\s*ID\s*([A-Z0-9]{4,}(?:-[A-Z0-9]{3,}){1,4})/i.exec(body);
      if (tp != null || sl != null || entry != null) out.details.push({ side: dm[1].toLowerCase(), qty: qty2 != null ? qty2 : num(dm[2]), base: dm[3], sym: dm[3] + '/USD',
        tp, sl, entry, price, openFee: fee, openedMs, orderId: did ? did[1].toUpperCase() : null });
    }
    const seenD = new Set();
    out.details = out.details.filter(d => { const k = [d.side, d.qty, d.tp, d.sl, d.entry].join('|'); if (seenD.has(k)) return false; seenD.add(k); return true; });
    // Merge the TP/SL tab and the Details tab of the same position (same side + coin + size, one of each).
    const merged = [];
    for (const d of out.details) {
      const twin = merged.find(m => m.side === d.side && m.base === d.base && m.qty === d.qty &&
        out.details.filter(x => x.side === d.side && x.base === d.base && x.qty === d.qty).length === 2 &&
        ((m.entry == null) !== (d.entry == null)));
      if (twin) { for (const k of Object.keys(d)) if (twin[k] == null && d[k] != null) twin[k] = d[k]; } else merged.push(Object.assign({}, d));
    }
    out.details = merged;
    // Leverage shown on the platform (order ticket, position sheet, market info): "BTC ... 10x", "Leverage 10x", "Max leverage: 5x".
    // A number with x on a line that names one coin (or the line under it); "Leverage Nx" alone counts only when the screen names
    // exactly one coin. Only 1x-200x is believed.
    out.leverage = {};
    { const COINS = /\b(BTC|XBT|ETH|SOL|XRP|LINK|LTC|DOGE|AVAX|SUI|HYPE|WLD|ADA|DOT|BNB|TON|PEPE|ARB|OP|NEAR|APT|TRX|BCH|ATOM)\b/i;
      const ls = T.split('\n'), only = [...new Set((T.match(new RegExp(COINS.source, 'gi')) || []).map(c => c.toUpperCase().replace('XBT', 'BTC')))];
      for (let i = 0; i < ls.length; i++) {
        const m = /(?:^|[\s(])(\d{1,3}(?:\.\d)?)\s?[x×](?=$|[\s)])/i.exec(ls[i]); if (!m) continue;
        const v = +m[1]; if (!(v >= 1 && v <= 200)) continue;
        const coinOf = x => { const c = COINS.exec(x || ''); return c ? c[1].toUpperCase().replace('XBT', 'BTC') : null; };
        const ctx = /lever|cross|isolated/i.test(ls[i]) || /lever/i.test(ls[i - 1] || '');
        const coin = coinOf(ls[i]) || (ctx ? coinOf(ls[i - 1]) || coinOf(ls[i - 2]) || (only.length === 1 ? only[0] : null) : null);
        if (coin && (ctx || coinOf(ls[i]))) out.leverage[coin] = v;
      } }
    // History -> Ledger: each row = type, signed amount, date, running balance; newest first. The top row's running
    // balance is the account balance right now, fees included. Rows are checked against each other (older balance +
    // amount = newer balance); if any link fails, an OCR digit is wrong and the balance isn't used.
    out.ledger = [];
    const LR = /(Prop\s+margin\s+trade|Swap\s+fee|Commission|Deposit|Withdrawal|Payout|Adjustment|Funding\s+fee|Rollover)\s+([+\-\u2212\u2013]\s?[\d,]*\.\d+)\s+([A-Z][a-z]{2}\s+\d{1,2},\s+\d{4})\s+([\d,]+\.\d+)/gi;
    for (let m; (m = LR.exec(T));) {
      const kind = /swap/i.test(m[1]) ? 'swap' : /margin/i.test(m[1]) ? 'trade' : m[1].toLowerCase().replace(/\s+/g, ' ');
      out.ledger.push({ kind, amt: num(m[2].replace(/[\u2212\u2013]/, '-').replace(/\s/g, '')), date: m[3].replace(/\s+/g, ' '), bal: num(m[4]) });
    }
    if (out.ledger.length) {
      const L = out.ledger, bad = [];
      for (let i = 0; i + 1 < L.length; i++) if (Math.abs(L[i + 1].bal + L[i].amt - L[i].bal) > 0.0006) bad.push(i);
      out.ledgerOk = !bad.length;
      out.ledgerSum = { swap: L.filter(x => x.kind === 'swap').reduce((a, x) => a + x.amt, 0), trade: L.filter(x => x.kind === 'trade').reduce((a, x) => a + x.amt, 0), n: L.length };
      if (bad.length) out.warnings.push(`Ledger: ${bad.length} row(s) don't add up (a number was misread), so its balance isn't used. Try a sharper screenshot.`);
      else if (out.account.balance == null) { out.account.balance = L[0].bal; out.account.balanceFrom = 'ledger'; }
    }
        // "Positions·0" means flat; otherwise no rows read means we don't know the open P&L.
    out.flat = /Positions\s*\W?\s*0\b/i.test(T) && !out.positions.length;
    const known = out.positions.every(p => p.upnl != null);
    out.upnlSum = out.positions.length && known ? out.positions.reduce((a, p) => a + p.upnl, 0) : (out.flat ? 0 : null);
    out.balance = out.account.balance != null ? out.account.balance
      : out.account.equity != null && out.account.upnl != null ? out.account.equity - out.account.upnl
      : out.account.equity != null && out.upnlSum != null ? out.account.equity - out.upnlSum : null;
    return out;
  }
  /* Account size from Kraken's limits: drawdown limit = size x (1 - MDD). */
  function sizeFromLimits(plan, drawdownLimit, target) {
    const P = PLANS[plan]; if (!P) return null;
    for (const z of SIZES) {
      if (drawdownLimit != null && Math.abs(z * (1 - P.mdd) - drawdownLimit) < 0.5) return z;
      if (target != null && Math.abs(z * (1 + P.target) - target) < 0.5) return z;
    }
    return null;
  }

  // ---- Symbols -----------------------------------------------------------
  const base = sym => String(sym).split('/')[0].toUpperCase();
  // Leverage comes from the venue, never asked (owner's rule, Nov 1 2026): a value read from his screenshots wins; otherwise the
  // firm's published preset (Kraken Prop table above). A firm without a preset ("Other firm") has NO leverage until a screenshot
  // shows it: levCap returns null and sizing says what's missing instead of guessing.
  function levMap(a) { const m = Object.assign({}, (a && a.leverage) || {}); if (a && a.plan === 'custom') m._preset = false; return m; }
  const levCap = (sym, lev) => { const b = base(sym); if (lev && lev[b]) return lev[b]; if (lev && lev._preset === false) return null; return LEVERAGE[b] || LEVERAGE._default; };
  function levInfo(a, sym) { const b = base(sym), m = (a && a.leverage) || {};
    if (m[b]) return { x: m[b], from: 'screenshot' };
    if (a && a.plan === 'custom') return { x: null, from: null };
    return { x: LEVERAGE[b] || LEVERAGE._default, from: LEVERAGE[b] ? 'preset' : 'preset-default' }; }
  /* What the app still needs from his screenshots for this account (shown on the Desk with the screen to capture). */
  function missingInfo(a, syms) {
    const out = [];
    for (const s of [...new Set(syms || [])]) { const li = levInfo(a, s); if (li.x == null) out.push({ k: 'leverage', sym: s, text: `${base(s)} leverage: screenshot your platform's order screen for ${base(s)} (it shows the leverage)` }); }
    return out;
  }
  const maxNotional = sym => MAX_NOTIONAL[base(sym)] || MAX_NOTIONAL._default;
  // Order size step = the coin's smallest unit (owner-confirmed Nov 1, 2026): 1 satoshi for BTC, 1 drop for XRP.
  const QTY_DP = { BTC: 8, ETH: 8, SOL: 8, XRP: 6 };
  const qtyDp = sym => (QTY_DP[base(sym)] != null ? QTY_DP[base(sym)] : 8);
  const floorTo = (x, dp) => { const m = Math.pow(10, dp); return Math.floor(x * m + 1e-9) / m; };

  // ---- Positions & fees --------------------------------------------------
  // Kraken books fees into BALANCE when charged: entry commission at open, swap fee every 4 hours,
  // exit commission at close (Kraken: Understanding Fees). Kraken Prop's position screen shows the next
  // swap charge exactly 4h after each position's own open time (owner's screenshots, Oct 31 2026), and
  // charges it on the position's current value; we use the entry value (difference ~0.1% of a ~$0.43 fee).
  const dir = p => (p.side === 'short' ? -1 : 1);
  const qtyClosedBy = (p, t) => (p.partials || []).reduce((s, x) => s + (x.t <= t ? x.qty : 0), 0);
  // Rounded to 10 decimals so 0.172 - 0.043 - 0.064 reads 0.065, not 0.06499999...
  const openQty = p => Math.max(0, Math.round((p.qty - (p.partials || []).reduce((s, x) => s + x.qty, 0)) * 1e10) / 1e10);
  function grossPnl(p, price, qty) { return dir(p) * (price - p.entry) * (qty == null ? openQty(p) : qty); }
  const ROLL = 4 * 3600000;
  // Swap charge times for a position opened at openedMs, in (openedMs, toMs]: every 4h from its open.
  function rollovers(openedMs, toMs) {
    const out = [];
    for (let t = openedMs + ROLL; t <= toMs; t += ROLL) out.push(t);
    return out;
  }
  const swapPerCharge = (notional, f) => notional * f.fundingPerDay / (24 / f.fundingEveryHours);
  // Swap fees on `qty` units held from open to atMs (used for a closed portion).
  function fundingEst(notional, openedMs, atMs, f) { f = f || FEES; return swapPerCharge(notional, f) * rollovers(openedMs, atMs).length; }
  // Fee ledger for one position up to nowMs: [{t, amt}] (negative = fee).
  function feeEvents(p, nowMs, f) {
    f = f || FEES;
    const ev = [{ t: p.opened, amt: -p.entry * p.qty * f.commission, kind: 'commission' }];
    const end = Math.min(nowMs, p.closed ? p.closed.t : nowMs);
    for (const t of rollovers(p.opened, end)) {
      const q = p.qty - qtyClosedBy(p, t - 1);
      if (q > 1e-12) ev.push({ t, amt: -swapPerCharge(p.entry * q, f), kind: 'swap' });
    }
    return ev;
  }
  // Fees already charged on the part still open (entry commission share + its swaps).
  function openFeesPaid(p, nowMs, f) {
    f = f || FEES;
    const q = openQty(p);
    return p.entry * q * f.commission + fundingEst(p.entry * q, p.opened, nowMs, f);
  }
  // Net result of the open part if closed at `price` now (all its fees, incl. exit commission).
  function netIfClosed(p, price, nowMs, f) {
    f = f || FEES;
    return grossPnl(p, price) - openFeesPaid(p, nowMs, f) - price * openQty(p) * f.commission;
  }
  // Net realized for closing `qty` at `price` at atMs: gross minus every fee on that portion.
  function realizedFor(p, qty, price, atMs, f) {
    f = f || FEES;
    const n = p.entry * qty;
    return dir(p) * (price - p.entry) * qty - n * f.commission - price * qty * f.commission - fundingEst(n, p.opened, atMs, f);
  }
  function rMultiple(p, price) {
    const risk = Math.abs(p.entry - (p.origStop != null ? p.origStop : p.stop));
    if (!risk) return null;
    return dir(p) * (price - p.entry) / risk;
  }
  /* Owner's rule (Nov 1, 2026): a closed trade is a WIN if its net result after fees is above 0, a LOSS if below 0, BREAKEVEN at
     exactly 0. R = net ÷ risk has the same sign, so counting by R or by dollars always agrees. A close (or partial close) taken
     from the platform without its result on screen is UNKNOWN until he enters it; the daily loss stop counts it as a loss. */
  const outcomeOf = v => v == null || !isFinite(v) ? 'unknown' : v > 0 ? 'win' : v < 0 ? 'loss' : 'even';
  function tradeOutcome(p) {
    if (!p || !p.closed) return null;
    if ((p.closed.synced && !p.closed.resultKnown) || (p.partials || []).some(x => x.resultKnown === false)) return 'unknown';
    return outcomeOf(realizedOfPos(p));
  }
  const realizedOfPos = p => (p.partials || []).reduce((s, x) => s + (x.realized || 0), 0)
    + (p.closed ? (p.closed.realized || 0) : 0);

  // ---- Account state -----------------------------------------------------
  function planOf(a) {
    const b = PLANS[a.plan] || PLANS.custom;
    const ok = (v, lo, hi) => (typeof v === 'number' && isFinite(v) && v >= lo && v <= hi);
    return { name: b.name,
      target: ok(a.target, 0.005, 0.5) ? a.target : b.target,
      mdd: ok(a.mdd, 0.005, 0.2) ? a.mdd : b.mdd,
      mdl: ok(a.mdl, 0.005, 0.2) ? a.mdl : b.mdl };
  }
  /* Rule inputs from the form (percent text). Blank = plan default (null). Out of range = error. */
  function parseRulePct(text, lo, hi) {
    const s = String(text == null ? '' : text).trim();
    if (s === '') return { value: null };
    const v = Number(s);
    if (!isFinite(v) || v < lo || v > hi) return { error: `must be between ${lo}% and ${hi}%` };
    return { value: v / 100 };
  }
  /* Balance ledger for one account, matching Kraken's Balance: every fee when charged, and each
     close/partial's remaining amount so that a portion's total equals its stored net `realized`. */
  function ledger(acctId, positions, nowMs, f) {
    f = f || FEES;
    const ev = [];
    for (const p of positions) {
      if (p.acct !== acctId) continue;
      for (const e of feeEvents(p, nowMs, f)) ev.push(e);
      const portions = (p.partials || []).map(x => ({ t: x.t, qty: x.qty, realized: x.realized || 0 }));
      if (p.closed && (p.closed.realized || 0) !== 0) portions.push({ t: p.closed.t, qty: openQty(p), realized: p.closed.realized });
      for (const x of portions) {
        // Fees for this portion already sit in the ledger; add back so the portion nets to `realized`.
        const booked = p.entry * x.qty * f.commission + fundingEst(p.entry * x.qty, p.opened, x.t, f);
        ev.push({ t: x.t, amt: x.realized + booked, kind: 'close', pos: p.id });
      }
    }
    return ev.filter(e => e.t <= nowMs);
  }
  /* prices: {sym: number}. Returns everything the Desk shows. */
  function accountState(a, positions, prices, nowMs, opt) {
    opt = opt || {};
    const f = opt.fees || FEES;
    const pl = planOf(a);
    const start = a.size;
    // Without a Kraken reconcile, every logged event counts (backfilled trades included).
    const anchorT = a.anchor ? a.anchor.t : -Infinity;
    const anchorBal = a.anchor ? a.anchor.bal : start;
    const ev = ledger(a.id, positions, nowMs, f);
    const reset = lastReset(nowMs, a.resetMin);
    let balance = anchorBal;
    for (const e of ev) if (e.t > anchorT) balance += e.amt;
    let dayStart = anchorBal;
    if (anchorT <= reset) { for (const e of ev) if (e.t > anchorT && e.t <= reset) dayStart += e.amt; }
    else { for (const e of ev) if (e.t > reset && e.t <= anchorT) dayStart -= e.amt; }
    if (a.dayStartOverride && a.dayStartOverride.reset === reset) dayStart = a.dayStartOverride.bal;

    const open = positions.filter(p => p.acct === a.id && !p.closed && openQty(p) > 0);
    let upnl = 0, feesOpen = 0, riskToStops = 0, noStop = 0, slUnknown = 0, missingPx = 0, notional = 0, usedMargin = 0;
    const lev = opt.leverage || levMap(a);
    let marginUnknown = 0;
    for (const p of open) {
      const px = prices[p.sym], q = openQty(p);
      feesOpen += openFeesPaid(p, nowMs, f);
      notional += p.entry * q;
      { const cap = levCap(p.sym, lev); if (cap) usedMargin += p.entry * q / cap; else marginUnknown++; }
      const hasStop = p.stop != null && isFinite(p.stop);
      if (!hasStop) { if (p.krakenSL) slUnknown++; else noStop++; }
      if (px == null || !isFinite(px)) {
        // Unknown price: never treat as flat. Value at the stop (worst planned case); no stop = unlimited.
        missingPx++;
        if (hasStop) { upnl += grossPnl(p, p.stop); riskToStops += p.stop * q * f.commission; }
        else riskToStops = Infinity;
        continue;
      }
      upnl += grossPnl(p, px);
      if (!hasStop) { riskToStops = Infinity; continue; }
      // Loss from here if the stop fills exactly (it may not: stops are not guaranteed).
      riskToStops += Math.max(0, grossPnl(p, px) - grossPnl(p, p.stop)) + p.stop * q * f.commission;
    }
    // Working limit orders (owner's rule, Nov 2 2026): not positions (no P&L, equity unchanged until they fill), but they reserve
    // margin, and if one fills and hits its stop he loses size x (|limit - stop| + both commissions). That loss counts in open risk
    // now, so room, next-trade size and the breach check already include it. An order without a stop = unlimited risk.
    const orders = (opt.orders || []).filter(o => o.acct === a.id && o.status === 'placed' && o.qty > 0 && o.entry > 0);
    let orderRisk = 0, orderMargin = 0;
    for (const o of orders) {
      const cap = levCap(o.sym, lev); if (cap) orderMargin += o.entry * o.qty / cap; else marginUnknown++;
      orderRisk += o.stop != null && isFinite(o.stop) ? o.qty * (Math.abs(o.entry - o.stop) + (o.entry + o.stop) * f.commission) : Infinity;
    }
    usedMargin += orderMargin; riskToStops += orderRisk;
    // Kraken: equity = balance (fees already in it) + unrealized P&L.
    const equity = balance + upnl;
    const dailyFloor = dayStart * (1 - pl.mdl);
    // Platform's own numbers (from an import) win over the preset math.
    const maxFloor = a.ddLimit > 0 ? a.ddLimit : start * (1 - pl.mdd);
    const floor = Math.max(dailyFloor, maxFloor);
    const room = equity - floor;
    const dailyRoom = equity - dailyFloor, maxRoom = equity - maxFloor;
    const targetBal = a.targetEq > 0 ? a.targetEq : start * (1 + pl.target);
    const isFunded = a.phase === 'funded';
    const equityIfStopped = equity - riskToStops;
    // A loss = a position fully closed after the reset whose net result after fees is below 0 (tradeOutcome). A close with an
    // unknown result counts as a loss here until he enters it (safe side). "Reset my day" restarts the app's own counters only.
    const countFrom = Math.max(reset, a.dayResetAt || 0);
    const closedToday = positions.filter(p => p.acct === a.id && p.closed && p.closed.t > countFrom);
    const unknownToday = closedToday.filter(p => tradeOutcome(p) === 'unknown').length;
    const winsToday = closedToday.filter(p => tradeOutcome(p) === 'win').length;
    const lossesToday = closedToday.filter(p => tradeOutcome(p) === 'loss').length + unknownToday;
    const tradesToday = (a.fills && a.fills.length) ? a.fills.filter(f => f.action === 'open' && f.t != null && f.t > countFrom).length
      : positions.filter(p => p.acct === a.id && p.opened > countFrom && !p.openedUnknown).length;
    const prof = profileById(a.profile);
    const openRiskAtEntry = open.reduce((s, p) => s + (p.stop != null ? Math.abs(p.entry - p.stop) * openQty(p) : 0), 0);
    const profRisk = start * prof.riskPct / 100;
    const maxOpen = start * prof.maxOpenPct / 100;
    // What the next trade may risk under his profile, never more than the room left. Unknown risk -> 0.
    const nextRisk = isFinite(riskToStops) ? Math.max(0, Math.min(profRisk, maxOpen - riskToStops, (room - riskToStops) * 0.9)) : 0;
    const cost = (a.fee || 0) + (a.extraCosts || []).reduce((s, x) => s + x.amt, 0);
    const paid = (a.payouts || []).reduce((s, x) => s + x.amt, 0);
    const breached = equity <= floor;
    const reachedTarget = !isFunded && equity >= targetBal;
    const warnings = [];
    for (const m of missingInfo(a, open.map(p => p.sym))) warnings.push({ lvl: 'warn', text: 'Missing: ' + m.text + '. Until then the margin limit for it is not checked.' });
    if (breached) warnings.push({ lvl: 'bad', text: 'Equity is at or below a breach line. Check your platform: the account may already be closed.' });
    if (noStop) warnings.push({ lvl: 'bad', text: `${noStop} open position(s) with no stop logged: risk is unlimited, next trade size set to $0.` });
    if (slUnknown) warnings.push({ lvl: 'warn', text: `${slUnknown} position(s) have a stop on your platform but the app doesn't know its price yet: total risk can't be added up. Import each position's TP/SL screenshot.` });
    if (missingPx) warnings.push({ lvl: 'bad', text: `No live price for ${missingPx} position(s). Valued at the stop (worst planned case) until the feed is back.` });
    if (orders.length) warnings.push({ lvl: orders.some(o => o.stop == null) ? 'bad' : 'ok', text: `${orders.length} working order(s) count now: ${isFinite(orderRisk) ? fmtUsd(orderRisk) + ' at risk if filled and stopped' : 'one has no stop (unlimited risk)'}, ${fmtUsd(orderMargin)} margin reserved.` });
    if (!breached && (open.length || orders.length) && equityIfStopped <= floor)
      warnings.push({ lvl: 'bad', text: isFinite(riskToStops) ? 'If every stop fills, the account breaches. Stops sit past the breach line.' : 'Risk is unlimited until every position has a stop.' });
    if (isFinite(riskToStops) && riskToStops > maxOpen + 0.01)
      warnings.push({ lvl: 'warn', text: `Open risk ${fmtUsd(riskToStops)} is over your ${prof.name} max of ${fmtUsd(maxOpen)}.` });
    if (unknownToday) warnings.push({ lvl: 'warn', text: `${unknownToday} trade(s) closed today with no result on the screenshot: counted as losses until you enter the result (Positions → Closed).` });
    if (lossesToday >= prof.stopAfterLosses)
      warnings.push({ lvl: 'warn', text: `${lossesToday} losses today. Your ${prof.name} rule says done for the day.` });
    if (tradesToday >= prof.maxTrades)
      warnings.push({ lvl: 'warn', text: `${tradesToday} trades today: at your ${prof.name} limit of ${prof.maxTrades}.` });
    if (reachedTarget)
      warnings.push({ lvl: 'warn', text: 'Equity is at the profit target. Check your platform (Kraken Prop auto-closes and marks the eval Passed here).' });
    return {
      plan: pl, profile: prof, start, balance, dayStart, equity, upnl, feesOpen, open: open.length, workingOrders: orders.length, orderRisk, orderMargin,
      dailyFloor, maxFloor, floor, room, dailyRoom, maxRoom, roomPct: room / start,
      binding: dailyFloor >= maxFloor ? 'daily' : 'max',
      targetBal, toTarget: isFunded ? null : targetBal - equity,
      progress: isFunded ? null : (equity - start) / (targetBal - start), reachedTarget,
      riskToStops, riskKnown: isFinite(riskToStops), equityIfStopped, stopsBreach: (open.length > 0 || orders.length > 0) && equityIfStopped <= floor,
      priceComplete: missingPx === 0,
      profRisk, maxOpen, nextRisk, lossesToBreach: profRisk > 0 ? Math.floor(Math.max(0, room) / profRisk) : null,
      winsToPass: (!isFunded && profRisk > 0) ? (r => Math.max(0, Math.ceil((targetBal - equity) / (profRisk * r)))) : null,
      lossesToday, winsToday, unknownToday, tradesToday, reset, nextReset: reset + 86400000,
      cost, paid, net: paid - cost, notional, leverage: notional / Math.max(1, equity), usedMargin,
      availMargin: Math.max(0, equity - usedMargin), marginUnknown, breached, warnings, openRiskAtEntry,
      openBySym: open.reduce((m, p) => (m[p.sym] = (m[p.sym] || 0) + p.entry * openQty(p), m), {}),
      payoutAvail: isFunded ? Math.max(0, balance - start) * (a.addon90 ? 0.9 : 0.8) : null
    };
  }

  /* Plain-language account review (same math as a manual review). prices: P&L price per symbol. */
  function accountReview(a, positions, prices, nowMs, opt) {
    const st = accountState(a, positions, prices, nowMs, opt);
    const f = (opt && opt.fees) || FEES;
    const open = positions.filter(p => p.acct === a.id && !p.closed && openQty(p) > 0);
    const bySym = {};
    for (const p of open) {
      const g = bySym[p.sym] || (bySym[p.sym] = { sym: p.sym, long: 0, short: 0, qtyNet: 0, cost: 0, n: 0, plannedRisk: 0, reward: 0, noStop: 0, noTarget: 0, slUnknown: 0 });
      const q = openQty(p), d = dir(p);
      g.n++; g.qtyNet += d * q; g[p.side] += q; g.cost += p.entry * q;
      if (p.stop != null && isFinite(p.stop)) g.plannedRisk += Math.max(0, -d * (p.stop - p.entry)) * q + p.stop * q * f.commission;
      else if (p.krakenSL) g.slUnknown++; else g.noStop++;
      const tgt = p.tp1 != null ? p.tp1 : p.tp2;
      if (tgt != null) g.reward += Math.max(0, d * (tgt - p.entry)) * q - tgt * q * f.commission; else g.noTarget++;
    }
    const groups = Object.values(bySym).map(g => {
      const px = prices[g.sym];
      const gross = g.long + g.short;
      const g2 = Object.assign(g, { price: px, avgEntry: g.cost / gross, notional: px != null ? px * gross : null,
        perHundred: Math.abs(g.qtyNet) * 100 });
      // Price where equity reaches the binding floor if only this coin moves (before closing fees).
      if (px != null && g.qtyNet !== 0 && st.room > 0) g2.breachPrice = px - st.room / g.qtyNet;
      g2.rr = g.plannedRisk > 0 && !g.noTarget && !g.noStop && !g.slUnknown ? g.reward / g.plannedRisk : null;
      return g2;
    });
    const plannedRisk = groups.reduce((x, g) => x + g.plannedRisk, 0);
    const lines = [];
    const add = (lvl, t) => lines.push({ lvl, t });
    if (!open.length) add('ok', 'No open positions.');
    if (st.riskKnown && open.length) add(st.stopsBreach ? 'bad' : 'ok', `If every stop fills: about ${fmtUsd(-st.riskToStops)} from here, leaving ${fmtUsd(st.equityIfStopped - st.floor)} above the ${st.binding} limit.`);
    if (!st.riskKnown) add('bad', 'Total risk is unknown: at least one position has no stop price in the app.');
    for (const g of groups) {
      if (g.breachPrice != null) add('info', `${g.sym}: ${g.qtyNet < 0 ? 'short' : 'long'} ${Math.abs(+g.qtyNet.toFixed(8))} (avg ${fmtPx(g.avgEntry)}). Each $100 move = ${fmtUsd(g.perHundred)}. With no stops, the account breaches near ${fmtPx(g.breachPrice)}.`);
      if (g.rr != null) add('info', `${g.sym}: planned risk ${fmtUsd(g.plannedRisk)} vs reward at targets ${fmtUsd(g.reward)} (${g.rr.toFixed(1)}R, after closing fees).`);
      if (g.noStop) add('bad', `${g.sym}: ${g.noStop} position(s) with no stop.`);
      if (g.slUnknown) add('warn', `${g.sym}: ${g.slUnknown} stop price(s) not imported yet.`);
      if (g.long > 0 && g.short > 0) add('warn', `${g.sym}: long and short at the same time. Check that it's intentional.`);
    }
    if (open.length && st.riskKnown && plannedRisk > st.maxOpen + 0.01) add('warn', `Planned risk ${fmtUsd(plannedRisk)} is above your ${st.profile.name} limit of ${fmtUsd(st.maxOpen)} total (${fmtUsd(st.profRisk)} per trade).`);
    if (st.room < st.profRisk) add('bad', `Room left (${fmtUsd(st.room)}) is less than one ${st.profile.name} trade. No new trades today.`);
    return { state: st, groups, plannedRisk, lines };
  }

  function deskTotals(accounts, positions, prices, nowMs, opt) {
    let capital = 0, cost = 0, paid = 0, upnl = 0, active = 0, equity = 0, riskToStops = 0;
    const states = {};
    for (const a of accounts) {
      const s = accountState(a, positions, prices, nowMs, opt);
      states[a.id] = s;
      cost += s.cost; paid += s.paid;
      if (a.phase === 'eval' || a.phase === 'funded') {
        active++; capital += a.size; upnl += s.upnl; equity += s.equity; riskToStops += s.riskToStops;
      }
    }
    return { states, capital, cost, paid, net: paid - cost, upnl, active, equity, riskToStops,
      overCap: capital > CAPITAL_CAP, cap: CAPITAL_CAP };
  }

  // ---- Sizing ------------------------------------------------------------
  function sizeFor(o) {
    // o: {sym, entry, stop, risk, equity, usedMargin?, symNotional?, fees?, leverage?}
    // Margin is one shared pool (Kraken Prop dashboard: Used / Available margin), so other open
    // positions reduce what a new one can take. Each market also has a USD notional cap.
    const f = o.fees || FEES;
    const dist = Math.abs(o.entry - o.stop);
    if (!(dist > 0) || !(o.risk > 0)) return { qty: 0, error: 'Need an entry, a stop on the right side, and risk above $0.' };
    const perUnit = dist + (o.entry + o.stop) * f.commission;
    let qty = o.risk / perUnit;
    const cap = levCap(o.sym, o.leverage);
    const freeMargin = Math.max(0, o.equity - (o.usedMargin || 0));
    const byMargin = cap ? freeMargin * cap / o.entry : Infinity;   // leverage unknown: no margin cap, flagged below
    const byMarket = Math.max(0, maxNotional(o.sym) - (o.symNotional || 0)) / o.entry;
    let capped = null;
    if (qty > byMargin) { qty = byMargin; capped = 'margin'; }
    if (qty > byMarket) { qty = byMarket; capped = 'market'; }
    qty = floorTo(qty, qtyDp(o.sym));
    const notional = qty * o.entry;
    return { qty, notional, lossAtStop: qty * perUnit, leverage: notional / o.equity, levCap: cap, levUnknown: !cap, capped,
      freeMargin, fees: o.entry * qty * f.commission * 2, dist };
  }

  // ---- Candle analysis ---------------------------------------------------
  // candles: [{time(sec), open, high, low, close, volume, vwap?}] oldest first; last one may be forming.
  function atr(c, n) {
    n = n || 14;
    if (c.length < 2) return null;
    const tr = [];
    for (let i = 1; i < c.length; i++)
      tr.push(Math.max(c[i].high - c[i].low, Math.abs(c[i].high - c[i - 1].close), Math.abs(c[i].low - c[i - 1].close)));
    const s = tr.slice(-n);
    return s.reduce((a, b) => a + b, 0) / s.length;
  }
  // Fractal swings, confirmed only (k closed candles each side). No look-ahead.
  function swings(c, k) {
    k = k || 2;
    const closed = c.slice(0, -1);
    const out = [];
    for (let i = k; i < closed.length - k; i++) {
      let hi = true, lo = true;
      for (let j = 1; j <= k; j++) {
        if (!(closed[i].high > closed[i - j].high && closed[i].high >= closed[i + j].high)) hi = false;
        if (!(closed[i].low < closed[i - j].low && closed[i].low <= closed[i + j].low)) lo = false;
      }
      if (hi) out.push({ type: 'H', i, time: closed[i].time, price: closed[i].high, confirmedAt: closed[i + k].time });
      if (lo) out.push({ type: 'L', i, time: closed[i].time, price: closed[i].low, confirmedAt: closed[i + k].time });
    }
    return out;
  }
  /* Market structure by closes through confirmed swings.
     Close above the latest unbroken confirmed swing high = break up; below swing low = break down.
     Break in the same direction as the current bias = BOS; against it = CHoCH (bias flips). */
  function structure(c, k) {
    k = k || 2;
    const sw = swings(c, k);
    const closed = c.slice(0, -1);
    let bias = 'range', lastH = null, lastL = null, events = [], si = 0;
    for (let i = 0; i < closed.length; i++) {
      const x = closed[i];
      while (si < sw.length && sw[si].i + k <= i - 0) {   // swing confirmed by candle i-1 or earlier
        const s = sw[si++];
        if (s.type === 'H') lastH = Object.assign({ broken: false }, s); else lastL = Object.assign({ broken: false }, s);
      }
      if (lastH && !lastH.broken && x.close > lastH.price) {
        lastH.broken = true;
        events.push({ kind: bias === 'bear' ? 'CHoCH' : 'BOS', dir: 'up', time: x.time, level: lastH.price });
        bias = 'bull';
      } else if (lastL && !lastL.broken && x.close < lastL.price) {
        lastL.broken = true;
        events.push({ kind: bias === 'bull' ? 'CHoCH' : 'BOS', dir: 'down', time: x.time, level: lastL.price });
        bias = 'bear';
      }
    }
    const highs = sw.filter(s => s.type === 'H'), lows = sw.filter(s => s.type === 'L');
    const h2 = highs.slice(-2), l2 = lows.slice(-2);
    let shape = 'mixed';
    if (h2.length === 2 && l2.length === 2) {
      if (h2[1].price > h2[0].price && l2[1].price > l2[0].price) shape = 'HH/HL';
      else if (h2[1].price < h2[0].price && l2[1].price < l2[0].price) shape = 'LH/LL';
    }
    return { bias, last: events[events.length - 1] || null, events, swingHigh: highs[highs.length - 1] || null,
      swingLow: lows[lows.length - 1] || null, shape, swings: sw };
  }
  /* FVG: 3-candle gap. Bullish when candle[i].low > candle[i-2].high; bearish when candle[i].high < candle[i-2].low.
     Only closed candles. Min size = minAtr x ATR(14). Tracks mitigation by later candles. */
  function fvgs(c, opt) {
    opt = opt || {};
    const minAtr = opt.minAtr != null ? opt.minAtr : 0.15;
    const closed = c.slice(0, -1);
    const a = atr(closed, 14) || 0;
    const out = [];
    for (let i = 2; i < closed.length; i++) {
      const p = closed[i - 2], m = closed[i - 1], n = closed[i];
      let g = null;
      if (n.low > p.high) g = { dir: 'bull', top: n.low, bottom: p.high };
      else if (n.high < p.low) g = { dir: 'bear', top: p.low, bottom: n.high };
      if (!g || g.top - g.bottom < minAtr * a) continue;
      g.time = m.time; g.formed = n.time; g.displacement = Math.abs(m.close - m.open) / (a || 1);
      g.status = 'open';
      for (let j = i + 1; j < c.length; j++) {          // includes forming candle for live mitigation
        const y = c[j];
        if (g.dir === 'bull') { if (y.low <= g.bottom) { g.status = 'filled'; break; } if (y.low < g.top) g.status = 'partial'; }
        else { if (y.high >= g.top) { g.status = 'filled'; break; } if (y.high > g.bottom) g.status = 'partial'; }
      }
      out.push(g);
    }
    return out;
  }
  function liveFvgs(c, n, opt) { return fvgs(c, opt).filter(g => g.status !== 'filled').slice(-(n || 8)); }

  function vwapSince(c, startSec) {
    let pv = 0, v = 0;
    for (const x of c) if (x.time >= startSec) { const tp = x.vwap || (x.high + x.low + x.close) / 3; pv += tp * x.volume; v += x.volume; }
    return v > 0 ? pv / v : null;
  }

  const SESSIONS = [   // ICT-style killzones, New York time (minutes from midnight)
    { id: 'asia', name: 'Asia', from: 20 * 60, to: 24 * 60 },
    { id: 'london', name: 'London', from: 2 * 60, to: 5 * 60 },
    { id: 'nyam', name: 'NY AM', from: 7 * 60, to: 10 * 60 },
    { id: 'nypm', name: 'NY PM', from: 13 * 60 + 30, to: 16 * 60 }
  ];
  function sessionRanges(c, tz) {
    tz = tz || 'America/New_York';
    const res = {};
    for (const s of SESSIONS) {
      let cur = null, last = null;
      for (const x of c) {
        const tp = tzParts(x.time, tz);
        const inS = tp.min >= s.from && tp.min < s.to;
        if (inS) {
          const key = tp.date;
          if (!cur || cur.key !== key) { if (cur) last = cur; cur = { key, id: s.id, name: s.name, high: x.high, low: x.low, from: x.time, to: x.time }; }
          else { cur.high = Math.max(cur.high, x.high); cur.low = Math.min(cur.low, x.low); cur.to = x.time; }
        }
      }
      if (cur) {
        const lastC = c[c.length - 1];
        const tp = tzParts(lastC.time, tz);
        cur.forming = tp.date === cur.key && tp.min >= s.from && tp.min < s.to;
        res[s.id] = cur; res[s.id + '_prev'] = last;
      }
    }
    return res;
  }
  /* Opening range. anchor: 'ny' (09:30 New York), 'utc' (00:00 UTC), 'kraken' (00:30 UTC). durMin: range length.
     breakout = first CLOSED candle after the range that closes beyond it. */
  function openingRange(c, anchor, durMin, tz) {
    if (!c.length) return null;
    const step = c.length > 1 ? c[1].time - c[0].time : 300;
    const inRange = x => {
      if (anchor === 'ny') { const tp = tzParts(x.time, tz || 'America/New_York'); return { on: tp.min >= 570 && tp.min < 570 + durMin, key: tp.date }; }
      const off = anchor === 'kraken' ? 30 : 0;
      const m = Math.floor(((x.time / 60) - off) % 1440 + 1440) % 1440;
      return { on: m < durMin, key: Math.floor((x.time / 60 - off) / 1440) };
    };
    let r = null;
    for (let i = 0; i < c.length; i++) {
      const g = inRange(c[i]);
      if (!g.on) continue;
      if (!r || r.key !== g.key) r = { key: g.key, high: c[i].high, low: c[i].low, from: c[i].time, to: c[i].time, endIdx: i };
      else { r.high = Math.max(r.high, c[i].high); r.low = Math.min(r.low, c[i].low); r.to = c[i].time; r.endIdx = i; }
    }
    if (!r) return null;
    r.complete = (r.to + step - r.from) >= durMin * 60 && r.endIdx < c.length - 1;
    r.breakout = null;
    if (r.complete) {
      for (let i = r.endIdx + 1; i < c.length - 1; i++) {
        if (inRange(c[i]).on) break;
        if (c[i].close > r.high) { r.breakout = { dir: 'up', time: c[i].time, close: c[i].close }; break; }
        if (c[i].close < r.low) { r.breakout = { dir: 'down', time: c[i].time, close: c[i].close }; break; }
      }
    }
    r.anchor = anchor; r.dur = durMin;
    return r;
  }
  /* ---- Market open (H4/H23 definitions in docs/research/HYPOTHESES.md; the card and the test share this code) ----
     New York time. Overnight = 18:00 previous evening to 09:30. Opening range = first orbMin minutes from 09:30.
     Trade: first 15m close beyond the range before 12:00, next-bar open, stop other side, 2R target, else 16:00 close. */
  const OPEN = { tz: 'America/New_York', openMin: 570, lastEntryMin: 720, closeMin: 960, onFromMin: 1080, fee: 0.0004, slip: 0.0002, swap4h: 0.000055, readDrift: 0.25 };
  const nextDate = d => { const t = Date.parse(d + 'T12:00:00Z') + 86400000; return new Date(t).toISOString().slice(0, 10); };
  /* Group 15m bars by New York trading day: {date, wd, i930, iMid, onH, onL, iFirst}. */
  function openDays(c, tz) {
    tz = tz || OPEN.tz; const days = new Map(), get = d => { let x = days.get(d); if (!x) days.set(d, x = { date: d, onH: -Infinity, onL: Infinity, i930: -1, iMid: -1 }); return x; };
    for (let i = 0; i < c.length; i++) {
      const p = tzParts(c[i].time, tz);
      const d = get(p.min >= OPEN.onFromMin ? nextDate(p.date) : p.date);
      if (p.min >= OPEN.onFromMin || p.min < OPEN.openMin) { d.onH = Math.max(d.onH, c[i].high); d.onL = Math.min(d.onL, c[i].low); }
      if (p.date === d.date) { if (d.wd == null) d.wd = p.wd; if (p.min === 0) d.iMid = i; if (p.min === OPEN.openMin) d.i930 = i; }
    }
    return [...days.values()].sort((a, b) => a.date < b.date ? -1 : 1);
  }
  /* 4h trend from 15m bars finished before index i: up / down / mixed. */
  function trend4h(c, i) {
    const b = []; for (let k = Math.max(0, i - 26 * 16); k < i; k++) { const t = Math.floor(c[k].time / 14400) * 14400, L = b[b.length - 1];
      if (L && L.t === t) { L.close = c[k].close; L.n++; } else b.push({ t, close: c[k].close, n: 1 }); }
    const tNow = i < c.length ? c[i].time : c[c.length - 1].time + 900; if (b.length && b[b.length - 1].t + 14400 > tNow) b.pop();   // drop the unfinished 4h bar
    if (b.length < 25) return null;
    const sm = j => { let s = 0; for (let k = j - 19; k <= j; k++) s += b[k].close; return s / 20; }, j = b.length - 1, m = sm(j), m5 = sm(j - 5);
    return b[j].close > m && m > m5 ? 'up' : b[j].close < m && m < m5 ? 'down' : 'mixed';
  }
  function dAtrBefore(d1, tSec) { const f = (d1 || []).filter(x => x.time + 86400 <= tSec); return f.length >= 15 ? atr(f.slice(-15), 14) : null; }
  /* The H4 trade for one day. Returns null (no trigger), or {dir, entry, stop, risk, R, why, t, exitT} (why 'open' if still running). */
  function openTrade(c, i930, orbBars, tz) {
    tz = tz || OPEN.tz; const re = i930 + orbBars - 1; if (re >= c.length) return null;
    let hi = -Infinity, lo = Infinity; for (let k = i930; k <= re; k++) { hi = Math.max(hi, c[k].high); lo = Math.min(lo, c[k].low); }
    const date = tzParts(c[i930].time, tz).date;
    for (let k = re + 1; k < c.length - 1; k++) {
      const p = tzParts(c[k].time, tz); if (p.date !== date || p.min >= OPEN.lastEntryMin) return null;
      const dir = c[k].close > hi ? 1 : c[k].close < lo ? -1 : 0; if (!dir) continue;
      const entry = c[k + 1].open, stop = dir > 0 ? lo : hi, risk = Math.abs(entry - stop); if (!(risk > 0) || dir * (entry - stop) <= 0) return { dir, skipped: 'gap past stop' };
      const tgt = entry + dir * 2 * risk, tr = { dir, entry, stop, risk, target: tgt, t: c[k + 1].time, hi, lo };
      const done = (px, j, why) => { const hrs = (c[j].time + 900 - tr.t) / 3600, cost = (OPEN.fee + OPEN.slip) * (entry + px) + OPEN.swap4h * Math.max(1, Math.ceil(hrs / 4)) * entry;
        return Object.assign(tr, { exit: px, exitT: c[j].time + 900, why, R: (dir * (px - entry) - cost) / risk }); };
      for (let j = k + 1; j < c.length; j++) {
        const q = tzParts(c[j].time, tz), b = c[j];
        if (q.date !== date) return done(c[j - 1].close, j - 1, 'close');
        if (dir > 0 ? b.low <= stop : b.high >= stop) return done(dir > 0 ? Math.min(b.open, stop) : Math.max(b.open, stop), j, 'stop');
        if (dir > 0 ? b.high >= tgt : b.low <= tgt) return done(dir > 0 ? Math.max(b.open, tgt) : Math.min(b.open, tgt), j, 'target');
        if (q.min + 15 >= OPEN.closeMin) return done(b.close, j, 'close');
      }
      return Object.assign(tr, { why: 'open', R: null });
    }
    return null;
  }
  /* Pre-open read for day index k of openDays: drift, trend, overnight width, read. */
  function openRead(c, d1, days, k) {
    const d = days[k]; if (!d || d.i930 < 1 || d.iMid < 0) return null;
    const a = dAtrBefore(d1, c[d.i930].time); if (!a) return null;
    const price = c[d.i930].open, drift = (price - c[d.iMid].open) / a, trend = trend4h(c, d.i930);
    const prev = days.slice(Math.max(0, k - 30), k).filter(x => isFinite(x.onH) && x.wd !== 'Sat' && x.wd !== 'Sun').slice(-20).map(x => x.onH - x.onL).sort((x, y) => x - y);
    const width = prev.length >= 10 ? (d.onH - d.onL) / prev[Math.floor(prev.length / 2)] : null;
    const read = drift >= OPEN.readDrift && trend === 'up' ? 'up' : drift <= -OPEN.readDrift && trend === 'down' ? 'down' : 'none';
    return { price, dAtr: a, drift, trend, width, read, onH: d.onH, onL: d.onL, midOpen: c[d.iMid].open };
  }
  /* The pre-open card: today's plan for both sides, flags, and (after the open) how it played out. Untested idea, not a signal. */
  function openPlan(c, d1, nowSec, opt) {
    opt = opt || {}; const tz = opt.tz || OPEN.tz, orbMin = opt.orbMin === 30 ? 30 : 15, nb = orbMin / 15, now = tzParts(nowSec, tz);
    if (now.wd === 'Sat' || now.wd === 'Sun') return { status: 'weekend', date: now.date };
    if (!c || c.length < 200) return { status: 'nodata', date: now.date };
    const cc = c.slice(-3500), days = openDays(cc, tz), k = days.findIndex(x => x.date === now.date);
    if (k < 0) return { status: 'nodata', date: now.date };
    const d = days[k], last = cc[cc.length - 1], pd = (d1 || []).filter(x => x.time + 86400 <= last.time).slice(-1)[0];
    const plan = { date: now.date, orbMin, status: now.min < OPEN.openMin ? 'pre' : now.min < OPEN.openMin + orbMin ? 'range' : now.min < OPEN.closeMin ? 'live' : 'done',
      onH: isFinite(d.onH) ? d.onH : null, onL: isFinite(d.onL) ? d.onL : null, pdh: pd ? pd.high : null, pdl: pd ? pd.low : null, price: last.close, flags: [] };
    let rd = null;
    if (d.i930 >= 0) rd = openRead(cc, d1, days, k);
    else { const a = dAtrBefore(d1, nowSec), t = trend4h(cc, cc.length), dr = a && d.iMid >= 0 ? (last.close - cc[d.iMid].open) / a : null;   // before 09:30: read so far
      rd = a ? { dAtr: a, drift: dr, trend: t, read: dr == null ? 'none' : dr >= OPEN.readDrift && t === 'up' ? 'up' : dr <= -OPEN.readDrift && t === 'down' ? 'down' : 'none', width: null } : null;
      }
    Object.assign(plan, rd ? { dAtr: rd.dAtr, drift: rd.drift, trend: rd.trend, width: rd.width, read: rd.read } : { read: 'none' });
    // Overnight width: the test uses a 20-weekday median (10+ needed); the live feed keeps ~7 days of 15m bars, so the card falls back to 4+ days and says how many.
    const prevW = days.slice(Math.max(0, k - 30), k).filter(x => isFinite(x.onH) && x.wd !== 'Sat' && x.wd !== 'Sun' && x.i930 >= 0).slice(-20).map(x => x.onH - x.onL).sort((x, y) => x - y);
    plan.widthDays = prevW.length;
    if (plan.width == null && prevW.length >= 4 && plan.onH != null) plan.width = (plan.onH - plan.onL) / prevW[Math.floor(prevW.length / 2)];
    if (d.i930 >= 0 && d.i930 + nb - 1 < cc.length) { let hi = -Infinity, lo = Infinity; for (let j = d.i930; j < d.i930 + nb; j++) { hi = Math.max(hi, cc[j].high); lo = Math.min(lo, cc[j].low); }
      plan.orb = { high: hi, low: lo, complete: d.i930 + nb - 1 < cc.length - 1 || plan.status === 'live' || plan.status === 'done' }; }
    const lvAbove = [plan.onH, plan.pdh].filter(x => x != null), lvBelow = [plan.onL, plan.pdl].filter(x => x != null);
    for (const dir of [1, -1]) { const side = dir > 0 ? 'up' : 'down', s = { trigger: null, entry: null, stop: null, target: null, next: null, withTrend: plan.trend === side };
      if (plan.orb && plan.orb.complete) { s.trigger = dir > 0 ? plan.orb.high : plan.orb.low; s.stop = dir > 0 ? plan.orb.low : plan.orb.high; const r = Math.abs(s.trigger - s.stop); s.target = s.trigger + dir * 2 * r; }
      const ref = s.trigger != null ? s.trigger : dir > 0 ? Math.max(...lvAbove.concat(plan.price)) : Math.min(...lvBelow.concat(plan.price));
      const nx = (dir > 0 ? lvAbove.filter(x => x > ref) : lvBelow.filter(x => x < ref)).sort((x, y) => dir * (x - y))[0]; s.next = nx == null ? null : nx;
      s.watch = dir > 0 ? (plan.onH != null ? plan.onH : null) : (plan.onL != null ? plan.onL : null); plan[side] = s; }
    if (plan.dAtr && plan.orb && plan.orb.complete && plan.orb.high - plan.orb.low > 0.5 * plan.dAtr) plan.flags.push('range wide');
    if (plan.dAtr && plan.drift != null && Math.abs(plan.drift) > 1) plan.flags.push('big overnight move');
    if (plan.orb && plan.orb.complete && plan.orb.high > plan.orb.low) { plan.costShare = 2 * (OPEN.fee + OPEN.slip) * plan.orb.high / (plan.orb.high - plan.orb.low); if (plan.costShare > 0.25) plan.flags.push('costs big'); }
    if (plan.width != null && plan.width > 1.5) plan.flags.push('wide overnight');
    if (plan.width != null && plan.width < 0.67) plan.flags.push('quiet overnight');
    if (opt.news) plan.flags.push('news');
    if (d.i930 >= 0 && plan.status !== 'pre' && plan.status !== 'range') { const t = openTrade(cc, d.i930, nb, tz); plan.trade = t ? { dir: t.dir > 0 ? 'up' : 'down', entry: t.entry, stop: t.stop, target: t.target, R: t.R, why: t.why || t.skipped, t: t.t } : null;
      const j2 = d.i930 + 8; if (j2 < cc.length) plan.move2h = (cc[j2 - 1].close - cc[d.i930].open) / (plan.dAtr || 1); }
    plan.noTrade = plan.flags.includes('news') || plan.flags.includes('range wide') || plan.flags.includes('big overnight move');
    return plan;
  }
  /* Key levels from daily candles (UTC days) plus sessions, ORB and VWAP from intraday. */
  function keyLevels(d1, intraday, opt) {
    opt = opt || {};
    const L = [];
    const add = (id, name, price, kind) => { if (price != null && isFinite(price)) L.push({ id, name, price, kind }); };
    if (d1 && d1.length >= 2) {
      const pd = d1[d1.length - 2], cd = d1[d1.length - 1];
      add('pdh', 'PDH', pd.high, 'day'); add('pdl', 'PDL', pd.low, 'day'); add('do', 'Day open', cd.open, 'open');
      // previous ISO week (Mon 00:00 UTC)
      const wk = t => Math.floor((t / 86400 + 3) / 7);
      const curW = wk(cd.time);
      const prev = d1.filter(x => wk(x.time) === curW - 1);
      if (prev.length) { add('pwh', 'PWH', Math.max(...prev.map(x => x.high)), 'week'); add('pwl', 'PWL', Math.min(...prev.map(x => x.low)), 'week'); }
    }
    if (intraday && intraday.length) {
      const sr = sessionRanges(intraday, opt.tz);
      for (const s of SESSIONS) { const r = sr[s.id]; if (r) { add(s.id + 'h', s.name + ' H', r.high, 'session'); add(s.id + 'l', s.name + ' L', r.low, 'session'); } }
      const orb = openingRange(intraday, opt.orbAnchor || 'ny', opt.orbMin || 15, opt.tz);
      if (orb) { add('orbh', 'ORB H', orb.high, 'orb'); add('orbl', 'ORB L', orb.low, 'orb'); }
      const last = intraday[intraday.length - 1];
      const dayStart = Math.floor(last.time / 86400) * 86400;
      add('vwap', 'VWAP (UTC day)', vwapSince(intraday, dayStart), 'vwap');
    }
    return L;
  }

  // ---- Coach -------------------------------------------------------------
  const SIDE_BIAS = { long: 'bull', short: 'bear' };
  /* ctx: {price, ageSec, struct:{'15':s,'60':s,'240':s,'1440':s}, fvg:{'15':[],'60':[]}, levels:[], atr:{'60':n},
           acct: accountState, rules:{beAt1R:bool}, entryStruct: structure on the position's TF} */
  function health(p, ctx) {
    const items = [];
    const obs = t => items.push({ k: 'observed', t }), inf = t => items.push({ k: 'inferred', t }), act = t => items.push({ k: 'proposal', t });
    if (ctx.price == null || ctx.ageSec == null || ctx.ageSec > (ctx.maxAge || 90))
      return { score: null, label: 'Not assessed', items: [{ k: 'unknown', t: 'Price data is missing or stale. No health score until the feed is current.' }], proposal: 'Wait for fresh data' };
    let score = 5, cap = 5;
    const px = ctx.price, d = dir(p), q = openQty(p);
    const r = rMultiple(p, px);
    const want = SIDE_BIAS[p.side];
    const opp = want === 'bull' ? 'bear' : 'bull';
    let proposal = 'Keep the existing plan';

    // 1. Stop exists and is on the right side
    if ((p.stop == null || !isFinite(p.stop)) && p.krakenSL) { cap = 2; obs('Your platform shows a stop on this position, but its price isn\'t in the app, so the risk can\'t be measured.'); act('Import a screenshot of this position\'s TP/SL so the stop price is known.'); proposal = 'Import the stop price'; }
    else if (p.stop == null || !isFinite(p.stop)) { cap = 1; obs('No stop. Unlimited risk to the account.'); act('Set a stop on your platform now.'); proposal = 'Add protection'; }
    else if ((d > 0 && px <= p.stop) || (d < 0 && px >= p.stop)) { cap = Math.min(cap, 1); obs(`Price ${fmtPx(px)} is through your stop ${fmtPx(p.stop)}. Stop orders can slip or fail to fill.`); act('Check the order state on your platform now. If it filled, log the close.'); proposal = 'Verify order state'; }

    // 2. Account breach line
    const A = ctx.acct;
    if (A && p.stop != null) {
      const lossToStop = -(grossPnl(p, p.stop) - grossPnl(p, px)) + p.stop * q * FEES.commission;
      if (A.equity - lossToStop <= A.floor) { cap = Math.min(cap, 1); obs(`If this stop fills, equity lands at ${fmtUsd(A.equity - lossToStop)}, at or below the breach line ${fmtUsd(A.floor)}. The account dies before the stop does.`); act('Reduce size. Do not move the stop farther away.'); proposal = 'Reduce exposure'; }
      else if ((A.equity - lossToStop - A.floor) < A.start * 0.003) { score -= 1; obs(`A stop-out leaves only ${fmtUsd(A.equity - lossToStop - A.floor)} above the breach line.`); }
      const riskNow = Math.abs(p.entry - (p.origStop != null ? p.origStop : p.stop)) * q;
      if (A.profRisk && riskNow > A.profRisk * 1.25) { score -= 1; obs(`Planned risk ${fmtUsd(riskNow)} is over your ${A.profile.name} size of ${fmtUsd(A.profRisk)}.`); }
    }

    // 3. Structure alignment (higher timeframes)
    const S = ctx.struct || {};
    const b4 = S['240'] && S['240'].bias, b1 = S['60'] && S['60'].bias, bD = S['1440'] && S['1440'].bias;
    if (b4 === opp) { score -= 1; inf(`4h structure is ${opp === 'bull' ? 'bullish' : 'bearish'}; you are ${p.side}. Counter-trend.`); }
    if (b1 === opp) { score -= 1; inf(`1h structure is ${opp === 'bull' ? 'bullish' : 'bearish'}; you are ${p.side}.`); }
    if (b4 === want && b1 === want) inf(`1h and 4h structure agree with your ${p.side}.`);
    if (bD && bD === opp) inf(`Daily structure leans the other way (${opp}).`);

    // 4. Entry-timeframe thesis
    const es = ctx.entryStruct;
    if (es && es.last && es.last.time * 1000 > p.opened && es.last.dir === (d > 0 ? 'down' : 'up')) {
      score -= 2; obs(`${tfName(p.tf)} closed ${d > 0 ? 'below' : 'above'} swing ${fmtPx(es.last.level)} after entry (${es.last.kind}). Thesis weakened.`);
      if (cap > 1) { act('Your plan decides: exit, reduce, or hold to the original stop. Do not widen it.'); proposal = 'Reassess: structure broke against you'; }
    }

    // 5. Targets and obstacles
    const tgt = p.tp1 != null ? p.tp1 : p.tp2;
    if (tgt == null) { score -= 0.5; obs('No target logged.'); }
    const lvls = (ctx.levels || []).concat(...Object.keys(ctx.fvg || {}).map(tf => (ctx.fvg[tf] || [])
      .filter(g => g.dir === opp).map(g => ({ name: `${tfName(tf)} ${g.dir} FVG`, price: d > 0 ? g.bottom : g.top, kind: 'fvg' }))));
    const a1 = (ctx.atr && ctx.atr['60']) || 0;
    const ahead = lvls.filter(l => d > 0 ? (l.price > px * 1.0005 && (tgt == null || l.price < tgt)) : (l.price < px * 0.9995 && (tgt == null || l.price > tgt)))
      .sort((x, y) => Math.abs(x.price - px) - Math.abs(y.price - px));
    if (ahead.length && tgt != null) {
      const o = ahead[0];
      score -= 0.5;
      obs(`${o.name} at ${fmtPx(o.price)} sits between price and your target ${fmtPx(tgt)}.`);
      act(`If your playbook takes partials at the first opposing level, ${fmtPx(o.price)} is it.`);
    }

    // 6. Management rules (only his rules; nothing widens a stop)
    if (r != null) {
      obs(`Open at ${r >= 0 ? '+' : ''}${r.toFixed(2)}R (${fmtUsd(netIfClosed(p, px, ctx.now || Date.now()))} net if closed now, estimate).`);
      const stopBehindEntry = p.stop != null && (d > 0 ? p.stop < p.entry : p.stop > p.entry);
      if (r >= 1 && stopBehindEntry) {
        if (ctx.rules && ctx.rules.beAt1R) { score -= 1; act(`Your rule: stop to breakeven at +1R. Move stop to ${fmtPx(p.entry)} (plus fees).`); proposal = 'Rule-based stop adjustment'; }
        else inf('Past +1R with the stop still behind entry. Only move it if your playbook says so.');
      }
      if (r >= 1 && es && p.stop != null) {
        const sw = d > 0 ? es.swingLow : es.swingHigh;
        if (sw && sw.time * 1000 > p.opened && (d > 0 ? sw.price > p.stop && sw.price < px : sw.price < p.stop && sw.price > px)) {
          const buf = a1 * 0.1;
          const ns = d > 0 ? sw.price - buf : sw.price + buf;
          act(`Trail option (rule to evaluate): new ${tfName(p.tf)} swing ${d > 0 ? 'low' : 'high'} ${fmtPx(sw.price)} formed after entry; a stop behind it (~${fmtPx(ns)}) tightens risk.`);
        }
      }
      if (tgt != null && (d > 0 ? px >= tgt : px <= tgt)) { act(`Price reached target ${fmtPx(tgt)}. Stick to the exit plan; don't stretch the target because it's close.`); proposal = 'Target hit: follow the plan'; }
    }
    // 7. Stop sitting on an obvious swing
    if (p.stop != null && es && a1) {
      const sw = d > 0 ? es.swingLow : es.swingHigh;
      if (sw && Math.abs(p.stop - sw.price) < a1 * 0.1) inf(`Stop is right at the obvious ${tfName(p.tf)} swing ${fmtPx(sw.price)}. Sweeps often tag those. That's an observation, not a reason to widen.`);
    }
    // 8. Holding cost
    const hrs = ((ctx.now || Date.now()) - p.opened) / 3600000;
    if (hrs > 24) obs(`Held ${Math.round(hrs)}h: margin funding about ${fmtUsd(fundingEst(p.entry * q, p.opened, ctx.now || Date.now()))} so far (estimate). It counts toward both loss limits.`);

    score = Math.max(1, Math.min(cap, Math.round(score)));
    const label = ['', 'Danger', 'Weak', 'Watch', 'OK', 'Healthy'][score];
    return { score, label, items, proposal, r };
  }

  /* Ideas to watch: open FVGs in the direction of 4h bias near price. Untested ideas, not signals. */
  function setupsToWatch(sym, data, opt) {
    opt = opt || {};
    const out = [];
    const s4 = data.struct['240'], px = data.price;
    if (px == null) return out;
    // Default: only the 4h direction (old behavior). opt.both: both directions, whatever the 4h says.
    const dirs = opt.both ? ['bull', 'bear'] : (!s4 || s4.bias === 'range' ? [] : [s4.bias]);
    const a1 = data.atr[opt.atrKey || '60'] || px * 0.005;
    for (const want of dirs) for (const tf of (opt.tfs || (opt.both ? ['15', '60', '240'] : ['15', '60']))) {
      for (const g of (data.fvg[tf] || [])) {
        if (g.dir !== want) continue;
        const edge = want === 'bull' ? g.top : g.bottom;
        if (Math.abs(edge - px) > a1 * 2) continue;
        if (want === 'bull' && edge > px) continue;
        if (want === 'bear' && edge < px) continue;
        const sl = want === 'bull' ? g.bottom - a1 * 0.1 : g.top + a1 * 0.1;
        const st = data.struct[tf];
        // Target: nearest opposing liquidity in the profit direction (1h/4h swings, key levels).
        const pool = [];
        for (const iv of (opt.poolTfs || ['60', '240'])) for (const s of ((data.struct[iv] || {}).swings || []).slice(-12))
          if (s.type === (want === 'bull' ? 'H' : 'L')) pool.push(s.price);
        for (const l of (data.levels || [])) pool.push(l.price);
        const minDist = Math.abs(edge - sl) * (opt.minRR || 2);
        const cands = pool.filter(p => want === 'bull' ? p >= edge + minDist : p <= edge - minDist)
          .sort((a, b) => Math.abs(a - edge) - Math.abs(b - edge));
        const tgt = cands[0];
        if (tgt == null) continue;
        const rr = Math.abs(tgt - edge) / Math.abs(edge - sl);
        if (!(rr >= (opt.minRR || 2))) continue;
        out.push({ sym, tf, dir: want === 'bull' ? 'long' : 'short', entry: edge, stop: sl, target: tgt, rr, zone: { top: g.top, bottom: g.bottom },
          aligned1h: data.struct['60'] && data.struct['60'].bias === want, entryTfBias: st && st.bias,
          text: `${tfName(tf)} ${want} FVG ${fmtPx(g.bottom)}–${fmtPx(g.top)} (4h ${s4 ? s4.bias : '?'}). Retest entry ~${fmtPx(edge)}, stop ${fmtPx(sl)}, target next liquidity ${fmtPx(tgt)} (${rr.toFixed(1)}R).` });
      }
    }
    return out.sort((a, b) => Math.abs(a.entry - px) - Math.abs(b.entry - px)).slice(0, 4);
  }

  /* Explicit stop / take-profit suggestions for an open position (owner's request, Nov 1 2026). Exact prices, each with its reason.
     Stops ONLY tighten, never widen. A suggested stop must stay >= 1 ATR (position timeframe, or 0.5 x 1h ATR if larger) from price
     so ordinary noise doesn't take it, and must move the stop by >= 0.25 of that ATR to be worth doing.
     ctx as for health(): price, struct, levels, fvg, atr, entryStruct, rules. Returns [{ type, price, r, why, rule }], best first.
     type: 'stop' | 'tp' | 'partial'. rule: true when it is HIS written rule (e.g. beAt1R), false when it is an option. */
  function levelPlan(p, ctx) {
    const out = [], px = ctx.price, d = dir(p);
    if (px == null || p.entry == null) return out;
    const risk0 = Math.abs(p.entry - (p.origStop != null ? p.origStop : p.stop));
    const rAt = x => risk0 ? d * (x - p.entry) / risk0 : null;
    const a1 = (ctx.atr && ctx.atr['60']) || px * 0.004, aT = (ctx.atr && ctx.atr[String(p.tf)]) || a1;
    const noise = Math.max(aT, 0.5 * a1), step = 0.25 * noise;
    const r = rMultiple(p, px), es = ctx.entryStruct;
    const fees = p.entry * FEES.commission * 2;
    const tighter = x => p.stop == null ? true : (d > 0 ? x >= p.stop + step : x <= p.stop - step);
    const clear = x => d > 0 ? px - x >= noise : x - px >= noise;
    const addStop = (x, why, rule) => { if (x != null && isFinite(x) && tighter(x) && clear(x)) out.push({ type: 'stop', price: x, r: rAt(x), why, rule: !!rule }); };
    // Stops
    if (r != null && r >= 1 && p.stop != null && (d > 0 ? p.stop < p.entry : p.stop > p.entry))
      addStop(p.entry + d * fees, `Breakeven (+ fees) at +${r.toFixed(1)}R: the trade can no longer lose.`, ctx.rules && ctx.rules.beAt1R);
    if (r != null && r >= 2) addStop(p.entry + d * risk0, `Lock in +1R now that you're at +${r.toFixed(1)}R.`);
    const broke = es && es.last && es.last.time * 1000 > (p.opened || 0) && es.last.dir === (d > 0 ? 'down' : 'up');
    const sw = es && (d > 0 ? es.swingLow : es.swingHigh);
    if (sw && sw.time * 1000 > (p.opened || 0)) addStop(sw.price - d * 0.1 * a1, `Trail behind the new ${tfName(p.tf)} swing ${d > 0 ? 'low' : 'high'} ${fmtPx(sw.price)} (formed after entry).`);
    if (broke && sw) addStop(sw.price - d * 0.1 * a1, `${tfName(p.tf)} structure broke against you; tighten to the last swing instead of waiting for the full stop.`);
    // Take profit
    const tgt = p.tp1 != null ? p.tp1 : p.tp2;
    const opp = d > 0 ? 'H' : 'L';
    const pool = (ctx.levels || []).filter(l => l.kind !== 'vwap').map(l => ({ name: l.name, price: l.price }));
    for (const iv of ['60', '240']) for (const w of (((ctx.struct || {})[iv] || {}).swings || []).slice(-12)) if (w.type === opp) pool.push({ name: tfName(iv) + ' swing ' + (opp === 'H' ? 'high' : 'low'), price: w.price });
    for (const tf of Object.keys(ctx.fvg || {})) for (const g of (ctx.fvg[tf] || [])) if (g.dir === (d > 0 ? 'bear' : 'bull')) pool.push({ name: tfName(tf) + ' opposing FVG', price: d > 0 ? g.bottom : g.top });
    const ahead = pool.filter(l => d * (l.price - px) > 0.25 * a1).sort((x, y) => d * (x.price - y.price));
    const first = ahead[0];
    if (tgt == null && ahead.length) {
      const t = ahead.find(l => rAt(l.price) >= 1.5) || ahead[ahead.length - 1];
      out.push({ type: 'tp', price: t.price, r: rAt(t.price), why: `No target logged. Nearest liquidity at 1.5R+ from entry: ${t.name}.` });
    }
    if (tgt != null && first && d * (tgt - first.price) > 0.25 * a1)
      out.push({ type: 'partial', price: first.price, r: rAt(first.price), why: `${first.name} sits before your target ${fmtPx(tgt)}: price often stalls at liquidity. A partial there banks part of the move; the rest still runs to your target.` });
    if (tgt != null && d * (px - tgt) >= 0) {
      const nxt = ahead.find(l => d * (l.price - tgt) > 0.5 * a1);
      if (nxt) out.push({ type: 'tp', price: nxt.price, r: rAt(nxt.price), why: `Target ${fmtPx(tgt)} reached. If you keep a runner: next liquidity ${nxt.name}, only with the stop at +1R or better.` });
    }
    if (tgt != null && ahead.length && rAt(tgt) != null && rAt(tgt) < 1) out.push({ type: 'tp', price: (ahead.find(l => rAt(l.price) >= 1.5) || ahead[ahead.length - 1]).price, r: rAt((ahead.find(l => rAt(l.price) >= 1.5) || ahead[ahead.length - 1]).price), why: `Your target is under 1R from entry; after fees that pays little for the risk. Nearest 1.5R+ liquidity shown.` });
    // De-duplicate stops: keep the best (most protective that still clears noise) first.
    const stops = out.filter(x => x.type === 'stop').sort((x, y) => d * (y.price - x.price));
    const seen = new Set(), rest = out.filter(x => x.type !== 'stop');
    return stops.filter(x => { const k = Math.round(x.price / step); if (seen.has(k)) return false; seen.add(k); return true; }).concat(rest);
  }

  /* Alert grade (Nov 1 2026): the strictest replay version (V4) — sweeps >= 0.25 ATR past the level with sweep-candle volume
     >= 1.5x normal, no 15m setups, fees <= 0.2R of the risk. Replay result was still slightly negative (held-out -0.01R, PF 0.97),
     so passing it means "least bad so far", not "profitable". Same rule as monitor/backtest.js VARIANTS.V4. */
  function alertGrade(e) {
    const feeR = 2 * FEES.commission * e.entry / Math.abs(e.entry - e.stop);
    const why = [];
    if (String(e.tf) === '15') why.push('15m setups lost money in replay');
    if (e.kind === 'sweep' && !(e.pen >= 0.25)) why.push('sweep shallower than 0.25 ATR');
    if (e.kind === 'sweep' && !(e.rvol != null && e.rvol >= 1.5)) why.push('sweep candle volume under 1.5x');
    if (!(feeR <= 0.2)) why.push(`fees ${feeR.toFixed(2)}R of the risk`);
    return { ok: !why.length, why, feeR };
  }

  /* Paper trading (owner's request, Nov 1 2026): try setups with no money, same rules as the replay test, to build a record.
     Opened at the live price when he taps (a market fill). Closed automatically at the stop or target: bars after the open are
     checked first (a bar touching both counts as the STOP), then the live price. Result in R after 0.04%/side fees and swap. */
  function paperOpen(idea, px, nowMs, meta) {
    const d = idea.dir === 'short' ? -1 : 1;
    if (!(px > 0) || idea.stop == null || d * (px - idea.stop) <= 0) return null;          // already past the stop: no trade
    return { id: 'pp' + nowMs.toString(36) + Math.floor(Math.random() * 1e4).toString(36), sym: idea.sym, side: d > 0 ? 'long' : 'short', kind: idea.kind || 'manual',
      tf: String(idea.tf || ''), entry: px, plannedEntry: idea.entry, stop: idea.stop, stop0: idea.stop, target: idea.target != null ? idea.target : null,
      opened: nowMs, status: 'open', mfe: 0, mae: 0, text: idea.text || '', meta: meta || {}, log: [{ t: nowMs, what: 'opened at ' + fmtPx(px) }] };
  }
  function paperR(t, exitPx, nowMs) {
    const d = t.side === 'short' ? -1 : 1, risk = Math.abs(t.entry - t.stop0), days = Math.max(0, (nowMs - t.opened) / 86400e3);
    return d * (exitPx - t.entry) / risk - 2 * FEES.commission * t.entry / risk - FEES.fundingPerDay * days * t.entry / risk;
  }
  /* Paper limit order (owner's rule, Nov 2 2026): when price isn't at the level yet, a paper trade waits as a limit at the level
     ('pending'), exactly like a real one. It opens at the level when price reaches it (limitFill: candles after it was placed, wicks
     count, or the live price); if price runs to the target or the stop first it's cancelled and never counted. */
  function paperLimit(idea, nowMs, meta) {
    const d = idea.dir === 'short' ? -1 : 1;
    if (!(idea.entry > 0) || idea.stop == null || d * (idea.entry - idea.stop) <= 0) return null;
    return { id: 'pp' + nowMs.toString(36) + Math.floor(Math.random() * 1e4).toString(36), sym: idea.sym, side: d > 0 ? 'long' : 'short', kind: idea.kind || 'manual',
      tf: String(idea.tf || ''), entry: idea.entry, plannedEntry: idea.entry, stop: idea.stop, stop0: idea.stop, target: idea.target != null ? idea.target : null,
      opened: nowMs, placedAt: nowMs, status: 'pending', order: 'limit', mfe: 0, mae: 0, text: idea.text || '', meta: meta || {}, log: [{ t: nowMs, what: 'limit placed at ' + fmtPx(idea.entry) }] };
  }
  function paperStep(t, bars, barSec, px, nowMs) {
    if (t && t.status === 'pending') {
      const f = limitFill({ side: t.side, entry: t.entry, stop: t.stop, tp1: t.target, placedAt: t.placedAt }, bars, barSec, px, nowMs);
      if (f.ranAway) return Object.assign({}, t, { status: 'cancelled', closed: nowMs, why: `price ran to the ${f.ranAway} before the limit filled`, log: t.log.concat([{ t: nowMs, what: `cancelled: price reached the ${f.ranAway} first` }]) });
      if (!f.filled) return t;
      // Filled at the limit: the trade starts then; stop/target are checked from the next whole bar (the fill bar can't be split).
      const next = f.t === nowMs ? nowMs : (Math.floor(f.t / 1000 / barSec) + 1) * barSec * 1000;
      t = Object.assign({}, t, { status: 'open', opened: f.t, checkedTo: next, log: t.log.concat([{ t: f.t, what: 'limit filled at ' + fmtPx(t.entry) }]) });
    }
    if (!t || t.status !== 'open') return t;
    const d = t.side === 'short' ? -1 : 1, risk = Math.abs(t.entry - t.stop0), out = Object.assign({}, t);
    const close = (price, why, at) => Object.assign(out, { status: 'closed', exit: price, closed: at, why, R: paperR(t, price, at), log: t.log.concat([{ t: at, what: why + ' at ' + fmtPx(price) }]) });
    const from = (t.checkedTo || t.opened) / 1000;
    for (const b of (bars || [])) {
      if (b.time < from || b.time + barSec > nowMs / 1000) continue;      // only whole bars that opened after the trade (or the last check)
      out.mfe = Math.max(out.mfe, d * ((d > 0 ? b.high : b.low) - t.entry) / risk); out.mae = Math.max(out.mae, d * (t.entry - (d > 0 ? b.low : b.high)) / risk);
      if (d > 0 ? b.low <= t.stop : b.high >= t.stop) return close(t.stop, 'stop', (b.time + barSec) * 1000);
      if (t.target != null && (d > 0 ? b.high >= t.target : b.low <= t.target)) return close(t.target, 'target', (b.time + barSec) * 1000);
      out.checkedTo = (b.time + barSec) * 1000;
    }
    if (px > 0) {
      out.mfe = Math.max(out.mfe, d * (px - t.entry) / risk); out.mae = Math.max(out.mae, -d * (px - t.entry) / risk);
      if (d * (px - t.stop) <= 0) return close(t.stop, 'stop', nowMs);
      if (t.target != null && d * (px - t.target) >= 0) return close(t.target, 'target', nowMs);
      out.openR = paperR(t, px, nowMs);
    }
    return out;
  }
  /* Simulated prop account for paper trades (owner's request, Nov 1 2026). Paper trades become ordinary positions on a
     paper account, so balance, equity, daily/max floors, target, breach and pass come from the SAME accountState() the Desk uses.
     Sized at open with the same sizeFor() and the account's next-trade risk. Paper only: nothing here touches a real account. */
  // Waiting paper limits take margin and risk room in the paper account, like real working orders.
  function paperOrders(trades, acctId) { return (trades || []).filter(t => t.acct === acctId && t.qty > 0 && t.status === 'pending').map(t => ({ acct: acctId, sym: t.sym, side: t.side, qty: t.qty, entry: t.entry, stop: t.stop, status: 'placed' })); }
  function paperPositions(trades, acctId) {
    return (trades || []).filter(t => t.acct === acctId && t.qty > 0 && (t.status === 'open' || t.status === 'closed')).map(t => {
      const p = { id: t.id, acct: acctId, sym: t.sym, side: t.side, qty: t.qty, entry: t.entry, stop: t.stop, origStop: t.stop0, tp1: t.target, opened: t.opened, partials: [] };
      if (t.status === 'closed') p.closed = { t: t.closed, price: t.exit, realized: realizedFor(p, t.qty, t.exit, t.closed) };
      return p;
    });
  }
  function paperSize(acct, trades, idea, px, nowMs, prices) {
    const pos = paperPositions(trades, acct.id), A = accountState(acct, pos, prices || {}, nowMs, { orders: paperOrders(trades, acct.id) });
    const w = weighIdea(Object.assign({}, idea, { entry: px }), A, pos.filter(p => !p.closed), nowMs, { leverage: levMap(acct) });
    if (A.breached) w.rules.unshift({ ok: false, t: 'paper account breached: start a new one' });
    return { A, ok: w.ok && !A.breached && !!(w.size && w.size.qty > 0), rules: w.rules, size: w.size };
  }

  /* Record of closed paper trades, grouped (all / by setup kind / alert grade / with or without volume push). */
  function paperStats(list) {
    const closed = list.filter(t => t.status === 'closed' && t.R != null), g = {};
    const add = (k, t) => (g[k] = g[k] || []).push(t);
    for (const t of closed) { add('all', t); add(t.kind + (t.tf ? ' ' + tfName(t.tf) : ''), t); add(t.meta && t.meta.alertGrade ? 'alert grade' : 'below alert grade', t); }
    const st = l => { const w = l.filter(t => t.R > 0); return { n: l.length, win: l.length ? w.length / l.length : null, avgR: l.reduce((a, t) => a + t.R, 0) / l.length, totalR: l.reduce((a, t) => a + t.R, 0) }; };
    return Object.fromEntries(Object.entries(g).map(([k, l]) => [k, st(l)]));
  }

  /* Entry check: a setup is READY only when every rule passes. Returns each setup with its checklist.
     Rules (owner's playbook, v1): 4h trending; 1h agrees with 4h; 15m agrees (bias or last break);
     open FVG in that direction with >= minRR to the next liquidity; price at the zone now (within 0.25 x 1h ATR);
     account allows a trade (risk known, room >= one profile trade, under max trades, under the loss stop);
     no open position the other way on this coin; not within 30 min before the daily reset.
     Untested idea, not a signal: no backtest yet. */
  /* Impulse legs + fib retracements (owner's request, Nov 1 2026). Measurable rule:
     an up leg starts at a confirmed swing low and ends at the highest high reached before price trades back below that low;
     it counts as an IMPULSE only if: size >= minAtr x ATR(14) (default 3), close-to-close efficiency >= minEff (0.5, i.e. mostly
     one-way), it took <= maxBars (60), and it broke the last confirmed swing high before it started (displacement through structure).
     Down legs mirror it. The end is "provisional" until it is a confirmed swing (price may still extend).
     Fibs measured from the end back toward the start: 0.236 ... 0.786; 0.618-0.786 = OTE zone. Observation only, not a signal. */
  const FIBS = [0.236, 0.382, 0.5, 0.618, 0.705, 0.786];
  /* Relative volume: bar volume / median of the 20 bars before it. null when volume is missing (never guessed). */
  function rvol(closed, i, n) {
    n = n || 20;
    if (!closed[i] || !(closed[i].volume > 0) || i < n) return null;
    const v = closed.slice(i - n, i).map(x => x.volume).filter(x => x > 0).sort((a, b) => a - b);
    if (v.length < n / 2) return null;
    const med = v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2;
    return med > 0 ? closed[i].volume / med : null;
  }
  /* Volume read on an impulse leg and its pullback (owner's request, Nov 1 2026). Rule, not a forecast:
     continuation signs = leg on heavy volume (avg RVOL >= 1.3) AND pullback on light volume (avg RVOL <= 0.8) AND no climax bar against it;
     reversal warning = pullback volume >= leg volume, OR a climax bar (RVOL >= 2) closing against the leg within the last 5 bars of the
     leg or anywhere in the pullback; otherwise unclear. Kraken volume only (one venue). Untested. */
  function volumeRead(closed, i0, iEnd, up) {
    const avg = (a, b) => { const r = []; for (let i = a; i <= b; i++) { const x = rvol(closed, i); if (x != null) r.push(x); } return r.length ? r.reduce((s, x) => s + x, 0) / r.length : null; };
    const leg = avg(i0 + 1, iEnd), pull = iEnd < closed.length - 1 ? avg(iEnd + 1, closed.length - 1) : null;
    if (leg == null) return { read: 'unknown', leg: null, pull: null, climax: false };
    let climax = false;
    for (let i = Math.max(i0 + 1, iEnd - 4); i < closed.length; i++) { const x = rvol(closed, i), against = up ? closed[i].close < closed[i].open : closed[i].close > closed[i].open; if (x != null && x >= 2 && against) climax = true; }
    const read = climax || (pull != null && pull >= leg) ? 'reversal_warning' : (leg >= 1.3 && pull != null && pull <= 0.8) ? 'continuation_signs' : 'unclear';
    return { read, leg, pull, climax };
  }
  function impulseLegs(c, opt) {
    opt = opt || {};
    const k = opt.k || 3, minAtr = opt.minAtr || 3, minEff = opt.minEff || 0.5, maxBars = opt.maxBars || 60;
    const closed = c.slice(0, -1);
    if (closed.length < 40) return [];
    const a = atr(closed, 14); if (!a) return [];
    const sw = swings(c, k), legs = [];
    for (const s0 of sw) {
      const up = s0.type === 'L', d = up ? 1 : -1;
      let end = s0.i, broken = false;
      for (let j = s0.i + 1; j < closed.length; j++) {
        if (up ? closed[j].low < s0.price : closed[j].high > s0.price) { broken = true; break; }
        if (up ? closed[j].high > closed[end].high : closed[j].low < closed[end].low) end = j;
      }
      if (broken || end === s0.i) continue;                       // traded back through the start: no live leg
      const endPx = up ? closed[end].high : closed[end].low, size = Math.abs(endPx - s0.price), bars = end - s0.i;
      if (size < minAtr * a || bars > maxBars) continue;
      let path = 0; for (let j = s0.i + 1; j <= end; j++) path += Math.abs(closed[j].close - closed[j - 1].close);
      const eff = path ? Math.abs(closed[end].close - closed[s0.i].close) / path : 0;
      if (eff < minEff) continue;
      const prior = sw.filter(x => x.type === (up ? 'H' : 'L') && x.i < s0.i).pop();
      if (!prior || !(up ? endPx > prior.price : endPx < prior.price)) continue;   // must break structure
      const after = closed.slice(end + 1), px = opt.price != null ? opt.price : closed[closed.length - 1].close;
      const deepest = after.length ? (up ? Math.min(...after.map(x => x.low)) : Math.max(...after.map(x => x.high))) : endPx;
      const fr = p => d * (endPx - p) / size;                      // 0 at the end, 1 at the start
      const retraceNow = fr(px), retraceMax = fr(deepest);
      const status = end >= closed.length - k ? 'extending' : retraceNow >= 0.618 && retraceNow <= 0.786 ? 'in_ote' : retraceNow > 0.786 ? 'deep' : retraceNow > 0 ? 'retracing' : 'at_high';
      const vol = volumeRead(closed, s0.i, end, up);
      legs.push({ vol, dir: up ? 'up' : 'down', start: { time: s0.time, price: s0.price }, end: { time: closed[end].time, price: endPx, provisional: end >= closed.length - k },
        size, atrMult: size / a, eff, bars, broke: prior.price, retraceNow, retraceMax, status,
        fibs: FIBS.map(r => ({ r, price: endPx - d * r * size })), ote: { top: endPx - d * 0.618 * size, bottom: endPx - d * 0.786 * size } });
    }
    // Latest leg per direction only (older legs are history).
    const pick = dir => legs.filter(l => l.dir === dir).sort((x, y) => y.start.time - x.start.time)[0];
    return [pick('up'), pick('down')].filter(Boolean).sort((x, y) => y.end.time - x.end.time);
  }

  /* Liquidity sweep setups (owner's request, Nov 1 2026). Measurable rule, no storytelling:
     a CLOSED 15m/1h candle trades beyond a liquidity level that was already known before that candle
     (prior day/week high-low, a finished session's high-low, a confirmed 1h/4h swing) by at least 0.05 x 1h ATR,
     and closes back inside it. Long after a sweep of lows, short after a sweep of highs. Only the last 3 closed candles.
     Reference entry = the sweep candle's close; stop = sweep extreme -/+ 0.1 x 1h ATR; target = nearest opposite
     liquidity with >= minRR. Sweeps within 90 min after the Asia (20:00 NY), London (03:00 NY) or New York (09:30 NY)
     open are tagged with that open. Untested idea, not a signal: no backtest yet. Needs data.c = {15: candles, 60: candles}. */
  const OPENS = [{ name: 'Asia open', min: 20 * 60 }, { name: 'London open', min: 3 * 60 }, { name: 'New York open', min: 9 * 60 + 30 }];
  function marketOpenTag(tsSec, tz) {
    const m = tzParts(tsSec, tz || 'America/New_York').min;
    const o = OPENS.find(o => { const d = (m - o.min + 1440) % 1440; return d < 90; });
    return o ? o.name : null;
  }
  function liquidityPool(data, tz, poolTfs) {
    const pool = [];
    for (const l of (data.levels || [])) if (l.kind === 'day' || l.kind === 'week') pool.push({ id: l.id, name: l.name, price: l.price, side: /h$/.test(l.id) ? 'H' : 'L', knownAt: 0 });
    const c15 = (data.c || {})[15];
    if (c15 && c15.length) {
      const sr = sessionRanges(c15, tz);
      for (const sd of SESSIONS) {
        const r = sr[sd.id] && !sr[sd.id].forming ? sr[sd.id] : sr[sd.id + '_prev'];
        if (r) { pool.push({ id: sd.id + 'h', name: r.name + ' H', price: r.high, side: 'H', knownAt: r.to + 900 }); pool.push({ id: sd.id + 'l', name: r.name + ' L', price: r.low, side: 'L', knownAt: r.to + 900 }); }
      }
    }
    for (const iv of (poolTfs || ['60', '240'])) { const ivs = +iv * 60;
      for (const w of (((data.struct || {})[iv] || {}).swings || []).slice(-12)) pool.push({ id: 'sw' + iv + w.type + w.time, name: tfName(iv) + ' swing ' + (w.type === 'H' ? 'high' : 'low'), price: w.price, side: w.type, knownAt: w.confirmedAt + ivs }); }
    return pool;
  }
  function sweepSetups(sym, data, nowMs, opt) {
    opt = opt || {};
    const out = [], a1 = (data.atr || {})[opt.atrKey || '60'], px = data.price;
    if (!a1 || px == null || !data.c) return out;
    const pool = liquidityPool(data, opt.tz, opt.poolTfs), minRR = opt.minRR || 2, seen = new Set(), minPen = opt.minPen || 0.05;
    for (const tf of (opt.tfs || ['15', '60'])) {
      const c = (data.c[tf] || []), sec = +tf * 60;
      const closed = c.filter(x => x.time + sec <= nowMs / 1000);
      for (const k of closed.slice(-3)) {
        for (const L of pool) {
          if (!(L.knownAt <= k.time)) continue;                      // level must exist before the sweep candle
          const long = L.side === 'L', beyond = long ? L.price - k.low : k.high - L.price;
          const back = long ? k.close > L.price : k.close < L.price;
          if (!(beyond >= minPen * a1) || !back) continue;
          const dir = long ? 'long' : 'short', key = [sym, tf, dir, 'sweep', L.id, k.time].join('|');
          if (seen.has(dir + L.id)) continue; seen.add(dir + L.id);
          // One candle that swept several levels is ONE trade (same entry, stop, target): list it once, naming every level.
          const twin = out.find(x => x.kind === 'sweep' && x.tf === tf && x.dir === dir && x.sweepTime === k.time);
          if (twin) { if (!twin.levels.some(l => l.name === L.name && Math.abs(l.price - L.price) < 1e-9 * Math.max(1, L.price))) twin.levels.push(L); twin.alsoKeys.push(key);
            const nm = twin.levels.map(l => `${l.name} ${fmtPx(l.price)}`); twin.text = twin.text.replace(/sweep of .*? \(4h/, `sweep of ${nm.slice(0, -1).join(', ')} and ${nm[nm.length - 1]} (4h`);
            twin.rules[0].t = `${tfName(tf)} swept ${twin.levels.map(l => l.name).join(', ')} and closed back`; continue; }
          const entry = k.close, stop = long ? k.low - 0.1 * a1 : k.high + 0.1 * a1, risk = Math.abs(entry - stop);
          const cands = pool.filter(q => q.side === (long ? 'H' : 'L') && (long ? q.price >= entry + risk * minRR : q.price <= entry - risk * minRR))
            .sort((x, y) => Math.abs(x.price - entry) - Math.abs(y.price - entry));
          const tgt = cands[0], rr = tgt ? Math.abs(tgt.price - entry) / risk : 0;
          const open = marketOpenTag(k.time, opt.tz), want = long ? 'bull' : 'bear', s4 = (data.struct || {})['240'];
          const rv = rvol(c, c.indexOf(k));
          const rules = [], Rl = (ok, t) => rules.push({ ok: !!ok, t });
          Rl(true, `${tfName(tf)} swept ${L.name} ${fmtPx(L.price)} and closed back`);
          Rl(tgt, tgt ? `${rr.toFixed(1)}R to ${tgt.name} ${fmtPx(tgt.price)}` : `no ${minRR}R target in reach`);
          Rl(long ? px > L.price : px < L.price, 'price still back inside the level now');
          Rl(long ? px > stop : px < stop, 'stop not hit yet');
          out.push({ sym, tf, dir, kind: 'sweep', rvol: rv, pen: beyond / a1, level: L, entry, stop, target: tgt ? tgt.price : null, rr, sweepTime: k.time, sweepExtreme: long ? k.low : k.high, open,
            trend4h: s4 ? s4.bias : null, withTrend: !!(s4 && s4.bias === want),
            text: `${tfName(tf)} sweep of ${L.name} ${fmtPx(L.price)}${open ? ' at the ' + open : ''} (4h ${s4 ? s4.bias : '?'}${s4 && s4.bias !== want ? ', counter-trend' : ''}${rv != null ? `, sweep candle volume ${rv.toFixed(1)}× normal` : ''}). Ref entry ${fmtPx(entry)}, stop ${fmtPx(stop)}${tgt ? `, target ${tgt.name} ${fmtPx(tgt.price)} (${rr.toFixed(1)}R)` : ''}.`,
            rules, ready: rules.every(r => r.ok), key, levels: [L], alsoKeys: [] });
        }
      }
    }
    return out;
  }

  /* Market scan (owner's rule, Nov 1 2026): runs all the time, long AND short, with no account, equity or open positions
     involved. A setup is "ready" when every MARKET rule passes. Your account only comes in via weighIdea(), when you tick it. */
  function scanSetups(sym, data, nowMs, opt) {
    opt = opt || {};
    const s4 = data.struct['240'], s1 = data.struct['60'], s15 = data.struct['15'], a1 = data.atr['60'] || 0;
    const all = setupsToWatch(sym, data, { minRR: opt.minRR || 2, both: opt.both !== false }).map(u => {
      const want = u.dir === 'long' ? 'bull' : 'bear', rules = [], R = (ok, t) => rules.push({ ok: !!ok, t });
      R(s4 && s4.bias === want, '4h structure ' + (s4 ? s4.bias : '?'));
      R(s1 && s1.bias === want, '1h agrees with 4h');
      R(s15 && (s15.bias === want || (s15.last && s15.last.dir === (want === 'bull' ? 'up' : 'down'))), '15m agrees');
      R(u.rr >= (opt.minRR || 2), `${u.rr.toFixed(1)}R to next liquidity`);
      R(data.price != null && Math.abs(data.price - u.entry) <= Math.max(a1 * 0.25, data.price * 0.0005), 'price at the zone now');
      return Object.assign({}, u, { kind: 'fvg', rules, ready: rules.every(r => r.ok), key: [sym, u.tf, u.dir, Math.round(u.entry)].join('|') });
    }).concat(opt.both === false ? [] : sweepSetups(sym, data, nowMs, opt));
    return dedupeSetups(all);
  }
  /* Every idea gets a trade ID (coin, side, entry, stop at the price's own precision). Two ideas that are the same trade are
     listed once: the first keeps its key, the others' keys go into alsoKeys so anything logged under them still links up. */
  function tradeId(u) { return fnv([u.sym, u.dir, fmtPx(u.entry), fmtPx(u.stop)].join('|')); }
  function dedupeSetups(list) {
    const out = [], byId = {};
    for (const u of list) {
      const id = tradeId(u), have = byId[id];
      if (have) { have.alsoKeys = (have.alsoKeys || []).concat(u.key, u.alsoKeys || []); continue; }
      const x = Object.assign({}, u, { tradeId: id, alsoKeys: (u.alsoKeys || []).slice() }); byId[id] = x; out.push(x);
    }
    return out;
  }
  /* Weigh one ticked idea against an account: account rules + size from the existing tested sizing. Never changes the idea. */
  function weighIdea(idea, A, positions, nowMs, opt) {
    opt = opt || {};
    const sym = idea.sym, rules = [], R = (ok, t) => rules.push({ ok: !!ok, t });
    R(A && A.riskKnown, 'all open positions have stops');
    R(A && A.room >= A.profRisk, 'room for one ' + (A ? A.profile.name : '') + ' trade');
    R(A && A.tradesToday < A.profile.maxTrades, 'under max trades today');
    R(A && A.lossesToday < A.profile.stopAfterLosses, 'under the daily loss stop');
    R(!(positions || []).some(p => !p.closed && p.sym === sym && p.side !== idea.dir && openQty(p) > 0), 'no open position the other way');
    R(A && A.nextReset - nowMs > 30 * 60000, 'not in the 30 min before reset');
    const ok = rules.every(r => r.ok);
    const size = ok && A ? sizeFor({ sym, entry: idea.entry, stop: idea.stop, risk: A.nextRisk, equity: A.equity, usedMargin: A.usedMargin, symNotional: A.openBySym[sym] || 0, leverage: opt.leverage }) : null;
    return { rules, ok, size };
  }
  /* Cross-check (owner's rule, Nov 1 2026): a setup counts as real only if a second venue's candles show the same gap:
     same direction, same timeframe, zones overlapping. other = { tf: [fvg,...] } from another venue; missing = unverified. */
  function confirmElsewhere(setup, other) {
    if (setup.kind === 'sweep') {   // same candle on the other venue also went past the level (within 0.15%) and closed back
      const k = other && other.c && (other.c[String(setup.tf)] || []).find(x => x.time === setup.sweepTime);
      if (!k) return { status: 'unverified' };
      const L = setup.level.price, tol = L * 0.0015, long = setup.dir === 'long';
      const ok = long ? k.low < L + tol && k.close > L - tol : k.high > L - tol && k.close < L + tol;
      return { status: ok ? 'confirmed' : 'not_seen' };
    }
    const list = other && other[String(setup.tf)];
    if (!list) return { status: 'unverified' };
    const want = setup.dir === 'long' ? 'bull' : 'bear', z = setup.zone || {};
    const hit = list.find(g => g.dir === want && z.top != null && g.bottom <= z.top && g.top >= z.bottom);
    return { status: hit ? 'confirmed' : 'not_seen' };
  }
  // Old combined check (4h direction only, market + account), kept for compatibility.
  function entryCheck(sym, data, A, positions, nowMs, opt) {
    opt = opt || {};
    const out = [];
    for (const m of scanSetups(sym, data, nowMs, Object.assign({}, opt, { both: false }))) {
      const u = m, rules = m.rules.slice();
      const R = (ok, t) => rules.push({ ok: !!ok, t });
      R(A && A.riskKnown, 'all open positions have stops');
      R(A && A.room >= A.profRisk, 'room for one ' + (A ? A.profile.name : '') + ' trade');
      R(A && A.tradesToday < A.profile.maxTrades, 'under max trades today');
      R(A && A.lossesToday < A.profile.stopAfterLosses, 'under the daily loss stop');
      R(!positions.some(p => !p.closed && p.sym === sym && p.side !== u.dir && openQty(p) > 0), 'no open position the other way');
      R(A && A.nextReset - nowMs > 30 * 60000, 'not in the 30 min before reset');
      const ready = rules.every(r => r.ok);
      const size = ready && A ? sizeFor({ sym, entry: u.entry, stop: u.stop, risk: A.nextRisk, equity: A.equity, usedMargin: A.usedMargin, symNotional: A.openBySym[sym] || 0, leverage: opt.leverage }) : null;
      out.push(Object.assign({}, u, { rules, ready, size }));
    }
    return out;
  }

  /* Heikin Ashi (display only, never used for analysis): HAclose = (O+H+L+C)/4; HAopen = (prev HAopen + prev HAclose)/2,
     first HAopen = (O+C)/2; HAhigh = max(H, HAopen, HAclose); HAlow = min(L, HAopen, HAclose). */
  function heikinAshi(c) {
    const out = [];
    for (let i = 0; i < c.length; i++) {
      const x = c[i], cl = (x.open + x.high + x.low + x.close) / 4;
      const op = i ? (out[i - 1].open + out[i - 1].close) / 2 : (x.open + x.close) / 2;
      out.push({ time: x.time, open: op, close: cl, high: Math.max(x.high, op, cl), low: Math.min(x.low, op, cl) });
    }
    return out;
  }
  /* EMA with SMA seed: k = 2/(n+1); first value at index n-1 = average of first n closes. */
  function ema(c, n) {
    const out = [], k = 2 / (n + 1);
    if (c.length < n) return out;
    let e = c.slice(0, n).reduce((a, x) => a + x.close, 0) / n;
    out.push({ time: c[n - 1].time, value: e });
    for (let i = n; i < c.length; i++) { e = c[i].close * k + e * (1 - k); out.push({ time: c[i].time, value: e }); }
    return out;
  }

  /* Reconcile the app's open positions with a platform snapshot. Only what differs changes:
     matched (same side, coin, entry) stays (qty drop = partial close); new ones are added; missing ones are
     closed, with the platform's realized result when its Closed list shows it. Pure: returns a plan. */
  /* Same entry price, allowing for display rounding (a typed 77,652.23 vs the platform's 77,652.2): within 0.002% (about
     $1.50 on BTC, 0.00004 on XRP), never looser than $0.01 on very cheap coins' absolute floor. */
  const samePx = (a, b) => Math.abs(a - b) <= Math.max(0.01 * Math.min(1, Math.abs(a) / 1000), Math.abs(a) * 2e-5);
  function planSync(appOpen, snap, closedRows) {
    const used = new Set(), usedClosed = new Set(), plan = { keep: [], partial: [], add: [], close: [] };
    const same = (p, q) => p.side === q.side && p.sym === q.sym && samePx(p.entry, q.entry);
    for (const q of snap) {
      const exact = appOpen.find(p => !used.has(p.id) && same(p, q) && Math.abs(openQty(p) - q.qty) < 1e-9);
      const m = exact || appOpen.find(p => !used.has(p.id) && same(p, q) && openQty(p) > q.qty + 1e-9);
      if (m) { used.add(m.id); if (exact) plan.keep.push({ pos: m, snap: q }); else plan.partial.push({ pos: m, snap: q, closedQty: +(openQty(m) - q.qty).toFixed(10) }); }
      else plan.add.push(q);
    }
    for (const p of appOpen) if (!used.has(p.id)) {
      const ci = (closedRows || []).findIndex((c, i) => !usedClosed.has(i) && same(p, c) && Math.abs(c.qty - openQty(p)) < 1e-9);
      if (ci >= 0) usedClosed.add(ci);
      plan.close.push({ pos: p, row: ci >= 0 ? closedRows[ci] : null });
    }
    return plan;
  }

  /* Take-profit / stop fills from order screenshots (owner's request, Nov 2 2026): a filled TP or SL order closes (or partly closes)
     the open position it belongs to, at its fill price. Matching, strongest first: the order's own ID saved on the position (tpOrderId /
     slOrderId), the parent order's ID = the position's entry order ID, then the price: same coin, opposite side, size within the open
     size, and the order's price equal to the position's target (take-profit) or stop (stop). A price match must be the only candidate,
     otherwise it is skipped and named. An order already applied (its ID is on a close or partial) is never applied again.
     Returns { actions: [{ pos, order, qty, price, priceKnown, t, full, by }], skipped: [{ order, why }] }. Pure: nothing is changed. */
  function planOrderFills(appOpen, orders, applied) {
    const done = new Set(applied || []), out = { actions: [], skipped: [] }, used = new Map();
    for (const o of (orders || [])) {
      const isExit = o.type === 'stop' || o.type === 'take-profit';
      if (!isExit || !(o.status === 'filled' || o.status === 'partial')) continue;
      if (o.orderId && done.has(o.orderId)) { out.skipped.push({ order: o, why: 'already applied' }); continue; }
      const left = p => openQty(p) - (used.get(p.id) || 0), opp = p => p.sym === o.sym && p.side !== o.side && left(p) > 1e-12;
      let pos = null, by = null;
      if (o.orderId) { pos = appOpen.find(p => opp(p) && (p.tpOrderId === o.orderId || p.slOrderId === o.orderId)); if (pos) by = 'order ID'; }
      if (!pos && o.parentId) { pos = appOpen.find(p => opp(p) && p.orderId === o.parentId); if (pos) by = 'parent order ID'; }
      if (!pos) {
        const lvl = p => o.type === 'take-profit' ? p.tp1 : p.stop;
        const c = appOpen.filter(p => opp(p) && lvl(p) != null && samePx(lvl(p), o.price));   // any size: on Kraken Prop the TP/SL closes whatever is left after manual partials
        if (c.length === 1) { pos = c[0]; by = 'price (no ID match)'; }
        else { out.skipped.push({ order: o, why: c.length ? `${c.length} positions have this ${o.type === 'stop' ? 'stop' : 'target'} and size: tap the position and screenshot its details so the IDs match` : 'no open position with this coin, side, size and price' }); continue; }
      }
      const qty = o.status === 'partial' && o.filledPct != null ? +(o.qty * o.filledPct / 100).toFixed(10) : o.qty;
      const q = o.status === 'partial' ? Math.min(qty, left(pos)) : left(pos), price = o.avgFill != null ? o.avgFill : o.price;
      used.set(pos.id, (used.get(pos.id) || 0) + q);
      out.actions.push({ pos, order: o, qty: q, price, priceKnown: o.avgFill != null || o.type === 'take-profit', t: o.filledMs || null, full: Math.abs(left(pos)) < 1e-9 || used.get(pos.id) >= openQty(pos) - 1e-9, by });
    }
    return out;
  }
  /* Verified screenshots win over what was saved (owner, Nov 2 2026). Corrects trades already CLOSED in the app:
     1) a row of the platform's Closed list (side, coin, size, entry, its net result and exit) that matches a closed trade whose saved
        result or exit differs: the platform's numbers replace the app's (Kraken's own net, fees included);
     2) a filled take-profit / stop order that matched no open position: matched to a closed trade (own ID, parent ID, then a unique
        price + full size match) and its exit and result are recomputed from the fill.
     Only trades closed in the last `days` days (default 14), never one with partial closes (those are edited by hand), never the same
     order twice. Returns [{ pos, kind: 'closedList'|'order', price, realized (null = recompute), t, orderId, by, from }]. Pure. */
  function planCorrections(appClosed, closedRows, orders, applied, nowMs, days) {
    const lim = (nowMs || Date.now()) - (days || 14) * 864e5, done = new Set(applied || []), out = [], used = new Set();
    const ok = p => p.closed && p.closed.t >= lim && !(p.partials || []).length;
    const tol = (a, b) => a != null && b != null && Math.abs(a - b) <= 0.01;
    for (const row of (closedRows || [])) {
      if (row.realized == null) continue;
      const c = appClosed.filter(p => ok(p) && !used.has(p.id) && p.side === row.side && p.sym === row.sym && samePx(p.entry, row.entry) && Math.abs(p.qty - row.qty) < 1e-9);
      if (c.length !== 1) continue;
      const p = c[0], same = tol(p.closed.realized, row.realized) && (row.exit == null || (p.closed.price != null && samePx(p.closed.price, row.exit))) && p.closed.resultKnown !== false;
      used.add(p.id); if (same) continue;
      out.push({ pos: p, kind: 'closedList', price: row.exit != null ? row.exit : p.closed.price, realized: row.realized, t: p.closed.t, orderId: p.closed.orderId || null, by: 'platform Closed list', from: { price: p.closed.price, realized: p.closed.realized } });
    }
    for (const o of (orders || [])) {
      if (!(o.type === 'stop' || o.type === 'take-profit') || o.status !== 'filled' || (o.orderId && done.has(o.orderId))) continue;
      const opp = p => ok(p) && !used.has(p.id) && p.sym === o.sym && p.side !== o.side && (!p.closed.orderId || p.closed.orderId === o.orderId);
      let pos = o.orderId && appClosed.find(p => opp(p) && (p.tpOrderId === o.orderId || p.slOrderId === o.orderId)), by = pos ? 'order ID' : null;
      if (!pos && o.parentId) { pos = appClosed.find(p => opp(p) && p.orderId === o.parentId); if (pos) by = 'parent order ID'; }
      if (!pos) { const lvl = p => o.type === 'take-profit' ? p.tp1 : p.stop;
        const c = appClosed.filter(p => opp(p) && lvl(p) != null && samePx(lvl(p), o.price));
        if (c.length === 1) { pos = c[0]; by = 'price (no ID match)'; } }
      if (!pos) continue;
      const price = o.avgFill != null ? o.avgFill : o.price;
      if (pos.closed.price != null && samePx(pos.closed.price, price) && pos.closed.resultKnown !== false && pos.closed.orderId === o.orderId) { used.add(pos.id); continue; }
      used.add(pos.id);
      out.push({ pos, kind: 'order', price, realized: null, t: o.filledMs || pos.closed.t, orderId: o.orderId || null, orderType: o.type, by, from: { price: pos.closed.price, realized: pos.closed.realized } });
    }
    return out;
  }

  /* Ledger rows (newest first as Kraken lists them) in the order they happened: oldest first, numbered 1, 2, 3 ... Rows have dates but
     no times, so the number is the only exact order within a day. Merging with rows saved earlier: a row is the same row when its
     date, amount and running balance all match. */
  function ledgerTimeline(rows, saved) {
    const k = x => [x.date, x.amt, x.bal].join('|'), by = new Map();
    for (const x of (saved || []).concat(rows || [])) if (!by.has(k(x))) by.set(k(x), Object.assign({}, x));
    const all = [...by.values()], prev = new Map(), next = new Map();
    // Each row's running balance minus its amount is the balance just before it, which is the previous row's running balance.
    // Chaining on that puts rows from any screenshots (newer or older, overlapping or not) in the right order.
    for (const x of all) {
      const before = all.filter(y => y !== x && Math.abs(y.bal + x.amt - x.bal) <= 0.0006 && !next.has(y));
      if (before.length === 1) { prev.set(x, before[0]); next.set(before[0], x); }
    }
    const ms = x => Date.parse(x.date + ' UTC') || 0, chains = [];
    const seen = new Set();
    for (const h of all.filter(x => !prev.has(x))) { const c = []; for (let x = h; x && !seen.has(x); x = next.get(x)) { seen.add(x); c.push(x); } chains.push(c); }
    for (const x of all) if (!seen.has(x)) chains.push([x]);   // a loop (bad OCR digits): keep the rows, unlinked
    chains.sort((p, q) => ms(p[0]) - ms(q[0]));          // separate stretches (a gap between screenshots) go by date
    const out = [].concat(...chains);
    out.forEach((x, i) => { x.seq = i + 1; x.ms = ms(x) || null; x.linked = prev.has(x) || next.has(x); });
    return out;
  }
  /* Link a close to its ledger row: a "trade" row on the close's UTC date whose amount is within 2% (or $0.50) of the gross result
     the app expects, and not linked yet. Evidence only: it shows the platform's own number next to the app's, it doesn't replace it. */
  function linkLedger(close, gross, timeline, used) {
    if (!close || close.t == null || gross == null) return null;
    const day = new Date(close.t).toISOString().slice(0, 10), u = used || new Set();
    const c = (timeline || []).filter(x => x.kind === 'trade' && !u.has(x.seq) && x.ms != null && new Date(x.ms).toISOString().slice(0, 10) === day
      && Math.abs(x.amt - gross) <= Math.max(0.5, Math.abs(gross) * 0.02));
    return c.length === 1 ? c[0] : null;
  }

  /* Market snapshot for a trade at one moment (owner, Nov 2 2026: the model should learn from as much as possible). Built ONLY from candles
     closed by tSec (no look-ahead), so it can be filled in later for imported trades from their open/close time. cs = {15, 60, 240, 1440}
     candle arrays (oldest first); side = 'long' | 'short'. Fields are null when the history doesn't reach that far back. */
  function tradeSnapshot(cs, tSec, side, opt) {
    opt = opt || {};
    const by = (arr, iv) => { const a = arr || []; let lo = 0, hi = a.length; while (lo < hi) { const m = (lo + hi) >> 1; if (a[m].time + iv * 60 <= tSec) lo = m + 1; else hi = m; } return a.slice(Math.max(0, lo - 720), lo); };
    const stub = a => a.length ? a.concat([Object.assign({}, a[a.length - 1], { time: a[a.length - 1].time + 1 })]) : a;
    const s = { 15: by(cs[15], 15), 60: by(cs[60], 60), 240: by(cs[240], 240), 1440: by(cs[1440], 1440) };
    const last = s[15].length ? s[15][s[15].length - 1] : s[60].length ? s[60][s[60].length - 1] : null;
    if (!last) return null;
    const px = last.close, want = side === 'long' ? 'bull' : 'bear', r2 = x => x == null || !isFinite(x) ? null : +x.toFixed(2), r4 = x => x == null || !isFinite(x) ? null : +x.toFixed(4);
    const trend = {}, brk = {};
    for (const iv of [15, 60, 240, 1440]) { if (s[iv].length < 20) { trend[iv] = null; continue; }
      const st = structure(stub(s[iv])); trend[iv] = st.bias;
      const e = st.last; brk[iv] = e ? { kind: e.kind, dir: e.dir, agoBars: Math.max(0, Math.round((tSec - e.time) / (iv * 60))) } : null; }
    const a1 = s[60].length > 15 ? atr(s[60], 14) : null;
    let volRatio = null; if (s[60].length >= 200) { const rg = x => (x.high - x.low) / x.close, h = s[60];
      volRatio = (h.slice(-24).reduce((a, x) => a + rg(x), 0) / 24) / (h.reduce((a, x) => a + rg(x), 0) / h.length); }
    const pct = (arr, n) => arr.length > n ? (px / arr[arr.length - 1 - n].close - 1) * 100 : null;
    const near = [];
    for (const iv of [60, 240]) if (s[iv].length >= 30 && a1) for (const g of liveFvgs(stub(s[iv]), 8)) {
      const dist = px > g.top ? (px - g.top) / a1 : px < g.bottom ? (g.bottom - px) / a1 : 0; near.push({ tf: String(iv), dir: g.dir, distAtr: r2(dist), inside: dist === 0 }); }
    const nearest = d => near.filter(x => x.dir === d).sort((x, y) => x.distAtr - y.distAtr)[0] || null;
    let level = null;
    if (s[1440].length >= 2 && a1) { const L = keyLevels(stub(s[1440]), s[15].length ? stub(s[15]) : null, { tz: opt.tz || 'America/New_York' }).filter(l => l.kind !== 'vwap');
      const n = L.map(l => ({ name: l.name, kind: l.kind, distAtr: r2(Math.abs(px - l.price) / a1), side: l.price >= px ? 'above' : 'below' })).sort((x, y) => x.distAtr - y.distAtr)[0];
      level = n || null; }
    const h = new Date(tSec * 1000).getUTCHours(), dow = new Date(tSec * 1000).getUTCDay();
    const session = dow === 0 || dow === 6 ? 'weekend' : h < 7 ? 'asia' : h < 13 ? 'london' : h < 21 ? 'newyork' : 'late';
    const rv = s[15].length > 21 ? rvol(s[15], s[15].length - 1, 20) : null;
    const agree = [240, 60, 15].filter(iv => trend[iv] === want).length, against = [240, 60, 15].filter(iv => trend[iv] && trend[iv] !== 'range' && trend[iv] !== want).length;
    return { at: tSec, price: px, trend, lastBreak: brk, trendAgree: agree, trendAgainst: against, atr1h: r2(a1), atrPct: a1 ? r4(a1 / px * 100) : null, volRegime: volRatio == null ? null : volRatio < 0.8 ? 'quiet' : volRatio > 1.25 ? 'expanded' : 'normal', volRatio: r2(volRatio),
      move4hPct: r2(pct(s[60], 4)), move24hPct: r2(pct(s[60], 24)), rvol15: r2(rv), session, weekday: dow, nearFvgWith: nearest(want), nearFvgAgainst: nearest(want === 'bull' ? 'bear' : 'bull'), nearestLevel: level };
  }

  /* Alert anti-spam, shared by the 24/7 monitor and the in-app alerts so their rules can't drift. An alert fires when its
     condition starts or gets worse; the same alert waits 2h unless it escalates; memory of an alert is kept 3 days.
     alertQueue sorts most urgent first (a breach is never held back behind an idea); alertSettle forgets anything not
     delivered (over the cap, or the send failed) so the next check sends it again. */
  function alertGate(prev, nowMs, o) {
    o = o || {}; const cool = o.cooldown || 2 * 3600e3, keep = o.keep || 3 * 86400e3;
    const sent = {};
    for (const [k, v] of Object.entries((prev && prev.sent) || {})) { const x = typeof v === 'number' ? { t: v, level: null } : v; if (x && nowMs - x.t < keep) sent[k] = x; }
    const state = { active: {}, sent }, fired = [];
    const fire = (key, level, title, body, prio) => {
      state.active[key] = level;
      const was = prev && prev.active && prev.active[key], last = state.sent[key], escalated = was != null && level > was;
      if ((was == null || escalated) && (!last || nowMs - last.t >= cool || escalated)) { fired.push({ key, title, body, prio: prio || 3 }); state.sent[key] = { t: nowMs, level }; }
    };
    return { fire, fired, state };
  }
  function alertQueue(fired) { return fired.slice().sort((x, y) => (y.prio || 3) - (x.prio || 3)); }
  function alertSettle(state, prev, undelivered) {
    const ps = (prev && prev.sent) || {};
    for (const f of undelivered) {
      delete state.active[f.key];
      if (ps[f.key] != null) state.sent[f.key] = typeof ps[f.key] === 'number' ? { t: ps[f.key], level: null } : ps[f.key]; else delete state.sent[f.key];
    }
    return state;
  }

  /* Reader samples: screenshot text a user chooses to share so the screenshot reader can be fixed for their layout.
     Strips what identifies a person or account (emails, account/order numbers, wallet addresses); keeps the layout and
     prices the reader needs. The user sees and can edit the result before anything leaves the phone. */
  function redactSample(text) {
    return String(text || '').replace(/\r/g, '')
      .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '[email]')
      .replace(/\b0x[0-9a-f]{8,}\b/gi, '[address]')
      .replace(/\b(Eval|Funded|Challenge|Account|Acct|Login|ID|Order|No\.?)(\s*[#:]?\s*)\d{2,}\b/gi, '$1$2#')
      .replace(/#\s*\d{2,}\b/g, '#')
      .replace(/\b\d{6,}\b/g, '[number]')
      .slice(0, 20000);
  }
  /* Automatic reader samples (owner's choice, Nov 1 2026). When the reader misses something, the app sends only the
     screen's LAYOUT: identifiers removed and every digit turned into 9, so no amount, size, price or account number
     leaves the phone. Never the picture. Reviewed by hand and turned into reader fixes and tests. */
  const SAMPLE_REASONS = ['nothing-read', 'warnings', 'general-reader', 'ledger-mismatch', 'position-unread'];
  function sampleReasons(r) {
    const why = [];
    const A = r.account || {};
    const nothing = !r.positions.length && !r.details.length && !(r.fills || []).length && A.equity == null && A.balance == null && !(r.ledger || []).length && !r.flat && !Object.keys(r.leverage || {}).length && !(r.orders || []).length;
    if (nothing) why.push('nothing-read');
    if ((r.ledger || []).length && r.ledgerOk === false) why.push('ledger-mismatch');
    if (r.warnings.some(w => /Could not read a position/.test(w))) why.push('position-unread');
    if (r.warnings.some(w => /general reader/.test(w))) why.push('general-reader');
    if (!why.length && r.warnings.some(w => !/screenshots are \d+ min old/.test(w))) why.push('warnings');
    return why;
  }
  function layoutSample(text) {
    const t = redactSample(text).replace(/[0-9]/g, '9').replace(/\[number\]/g, '999999').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
    return t.slice(0, 8000);
  }
  function sampleFor(r, text, edition) {
    const reasons = sampleReasons(r); if (!reasons.length) return null;
    const layout = layoutSample(text); if (layout.length < 20) return null;
    return { v: 1, edition: edition === 'private' ? 'private' : 'public', reasons, layout,
      counts: { positions: r.positions.length, details: r.details.length, fills: (r.fills || []).length, ledger: (r.ledger || []).length, warnings: r.warnings.length } };
  }
  /* Short fingerprint so the same layout is only sent once from a device. */
  function fnv(str) { let h = 0x811c9dc5; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return h.toString(16).padStart(8, '0'); }

  /* A prefilled "new issue" link on GitHub. Links over ~7,500 characters break in some browsers, so a long body is left
     out and the app copies it to the clipboard for pasting instead. */
  function issueLink(repo, title, body) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo || '')) return null;
    const base = `https://github.com/${repo}/issues/new?title=${encodeURIComponent(String(title).slice(0, 120))}&body=`;
    const full = base + encodeURIComponent(body);
    return full.length <= 7500 ? { url: full, fits: true } : { url: base + encodeURIComponent('(Too long for a link: the text is on your clipboard. Paste it here.)'), fits: false };
  }

  /* ---------- Scorecard: the model learns from closed trades (owner's choice, Nov 1 2026) ----------
     Every closed paper trade and every closed live trade is scored in R (after fees) under the setup type it came from and
     the model version in force when it opened. Status rules were written down BEFORE any results and never change on
     their own; a change of status is only a SUGGESTION until the owner accepts it. Nothing here changes position size. */
  const MODELS = [
    { id: 'M0', from: 0, note: 'Before versioning (rules changed during the day)' },
    { id: 'M1', from: Date.UTC(2026, 10, 1), note: 'FVG + liquidity-sweep scanner on 15m/1h/4h; phone alerts only for replay version V4 (no 15m, sweeps ≥0.25 ATR deep with ≥1.5x volume, fees ≤0.2R)' },
    { id: 'M2', from: Date.UTC(2026, 10, 1, 23, 30), note: 'M1 + phone alerts also need the live check to pass now (every setup rule on live data and 2R+ from the order price after fees); lists ranked by the live check; one trade ID per idea' }
  ];
  const MODEL = MODELS[MODELS.length - 1].id;
  const modelAt = ms => { let m = MODELS[0].id; for (const x of MODELS) if (ms >= x.from) m = x.id; return m; };
  const SCORE_RULES = { minN: 30, z: 1.96 };
  const SETUP_CHOICES = [['fvg|15', 'FVG 15m'], ['fvg|60', 'FVG 1h'], ['fvg|240', 'FVG 4h'], ['fvg|1440', 'FVG 1D'], ['sweep|15', 'Sweep 15m'], ['sweep|60', 'Sweep 1h'], ['sweep|240', 'Sweep 4h'],
    ['orb', 'Opening range'], ['structure', 'Structure'], ['own', 'Own idea'], ['unlinked', 'Not linked yet']];
  function setupKey(kind, tf) {
    const k = String(kind || '').toLowerCase();
    const kk = /fvg/.test(k) ? 'fvg' : /sweep/.test(k) ? 'sweep' : /orb|opening/.test(k) ? 'orb' : /struct/.test(k) ? 'structure' : /import/.test(k) || !k ? 'unlinked' : 'own';
    return (kk === 'fvg' || kk === 'sweep') && tf ? kk + '|' + String(tf) : kk === 'fvg' || kk === 'sweep' ? 'unlinked' : kk;
  }
  const setupLabel = key => (SETUP_CHOICES.find(c => c[0] === key) || [key, key])[1];
  /* R of a closed live trade: total realized (fees included) / dollars at risk at entry (original stop x original size, p.qty).
     null when the result or the original stop isn't known: never guessed. */
  function liveR(p) {
    if (!p.closed || (p.closed.synced && !p.closed.resultKnown)) return null;
    const stop = p.origStop != null ? p.origStop : null; if (stop == null || !(p.entry > 0)) return null;
    if ((p.partials || []).some(x => x.resultKnown === false)) return null;   // a part closed with an unknown result
    const q0 = p.qty || 0;   // p.qty is the ORIGINAL size; partials are taken out of it (openQty)
    const risk = Math.abs(p.entry - stop) * q0; if (!(risk > 0)) return null;
    return realizedOfPos(p) / risk;
  }
  /* All closed trades as one list: {id, src, key, model, R, tag, t, session}. */
  function tradeRecords(paper, positions) {
    const out = [], sess = ms => { const m = tzParts(Math.floor(ms / 1000), 'America/New_York').min; const s = SESSIONS.find(x => m >= x.from && m < x.to); return s ? s.name : 'Other hours'; };
    // A paper trade he then took live is counted once, as the live trade (wentLive), never twice.
    for (const t of paper || []) if (t.status === 'closed' && t.R != null && isFinite(t.R) && !t.wentLive)
      out.push({ id: t.id, src: 'paper', key: setupKey(t.kind, t.tf), model: t.model || modelAt(t.opened), R: t.R, tag: 'plan', t: t.opened, closed: t.closed, session: sess(t.opened), sym: t.sym });
    for (const p of positions || []) { const R = p.closed ? liveR(p) : null; if (R == null) continue;
      out.push({ id: p.id, src: 'live', key: p.ref && p.ref.key ? p.ref.key : setupKey(p.setup, p.tf), model: (p.ref && p.ref.model) || modelAt(p.opened), R, tag: p.tag || 'plan', t: p.opened, closed: p.closed.t, session: sess(p.opened), sym: p.sym }); }
    return out.sort((a, b) => a.closed - b.closed);
  }
  /* n, win rate, average R and a 95% range for the average (normal approximation; shown only from 5 trades). */
  function statsR(rs) {
    const n = rs.length; if (!n) return { n: 0 };
    const avg = rs.reduce((a, x) => a + x, 0) / n, sd = n > 1 ? Math.sqrt(rs.reduce((a, x) => a + (x - avg) ** 2, 0) / (n - 1)) : null;
    const half = n >= 5 && sd != null ? SCORE_RULES.z * sd / Math.sqrt(n) : null;
    return { n, win: rs.filter(x => x > 0).length / n, avg, total: avg * n, lo: half != null ? avg - half : null, hi: half != null ? avg + half : null };
  }
  function statsAgg(a) {   // from pooled sums {n, s, s2, w}
    if (!a || !(a.n > 0)) return { n: 0 };
    const n = a.n, avg = a.s / n, v = n > 1 ? Math.max(0, (a.s2 - n * avg * avg) / (n - 1)) : null, half = n >= 5 && v != null ? SCORE_RULES.z * Math.sqrt(v / n) : null;
    return { n, win: a.w / n, avg, total: a.s, lo: half != null ? avg - half : null, hi: half != null ? avg + half : null };
  }
  /* Status rules (fixed Nov 1, 2026, before any results):
     gathering  < 30 forward trades (paper + live tagged "followed plan")
     proven     30+ and the whole 95% range of the average R is above 0
     disproven  30+ and the whole range is below 0
     below replay 30+ and the whole range is below the replay's average for that setup (worse than history: execution or decay)
     unclear    30+ otherwise */
  function scoreStatus(st, replayAvg) {
    if (!st || st.n < SCORE_RULES.minN || st.lo == null) return 'gathering';
    if (st.lo > 0) return 'proven';
    if (st.hi < 0) return 'disproven';
    if (replayAvg != null && st.hi < replayAvg) return 'below replay';
    return 'unclear';
  }
  const STATUS_ORDER = { proven: 0, unclear: 1, gathering: 2, 'below replay': 3, disproven: 4 };
  function scorecard(records, opt) {
    opt = opt || {};
    const model = opt.model || MODEL, replay = opt.replay || {}, pool = (opt.pool && opt.pool[model]) || {};
    const recs = records.filter(r => r.model === model), keys = new Set(recs.map(r => r.key).concat(Object.keys(pool)));
    keys.delete('unlinked');
    const rows = [...keys].map(key => {
      const P = recs.filter(r => r.key === key && r.src === 'paper').map(r => r.R), L = recs.filter(r => r.key === key && r.src === 'live' && r.tag === 'plan').map(r => r.R);
      const fwd = statsR(P.concat(L)), rp = replay[key] || null, rAvg = rp && rp.n ? rp.avgR : null;
      const pl = pool[key] || {}, poolAll = statsAgg({ n: (pl.paper ? pl.paper.n : 0) + (pl.live ? pl.live.n : 0), s: (pl.paper ? pl.paper.s : 0) + (pl.live ? pl.live.s : 0), s2: (pl.paper ? pl.paper.s2 : 0) + (pl.live ? pl.live.s2 : 0), w: (pl.paper ? pl.paper.w : 0) + (pl.live ? pl.live.w : 0) });
      return { key, label: setupLabel(key), replay: rp, paper: statsR(P), live: statsR(L), forward: fwd, pool: poolAll, status: scoreStatus(fwd, rAvg), poolStatus: scoreStatus(poolAll, rAvg) };
    });
    rows.sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || (b.forward.lo != null ? b.forward.lo : -9) - (a.forward.lo != null ? a.forward.lo : -9) || b.forward.n - a.forward.n);
    return { model, rows, unlinked: recs.filter(r => r.key === 'unlinked').length };
  }
  /* His own patterns from live trades: by tag, by session, and right after a loss. */
  function tradePatterns(records) {
    const live = records.filter(r => r.src === 'live'), out = { byTag: {}, bySession: {}, afterLoss: null };
    for (const k of Object.keys(TRADE_TAGS)) { const st = statsR(live.filter(r => r.tag === k).map(r => r.R)); if (st.n) out.byTag[k] = st; }
    for (const r of records) (out.bySession[r.session] = out.bySession[r.session] || []).push(r.R);
    for (const k of Object.keys(out.bySession)) out.bySession[k] = statsR(out.bySession[k]);
    const after = live.filter(r => live.some(x => x.R < 0 && x.closed <= r.t && r.t - x.closed < 4 * 3600e3)).map(r => r.R);
    out.afterLoss = statsR(after);
    return out;
  }
  /* What a closed trade sends to the shared pool: setup, model, source, R (2 decimals), tag. No coin size, price, money, account or time beyond the day. */
  function resultPayload(rec, edition) {
    return { v: 1, id: fnv(rec.src + '|' + rec.id), edition: edition === 'private' ? 'private' : 'public', model: rec.model, key: rec.key, src: rec.src, tag: rec.tag, R: Math.round(rec.R * 100) / 100 };
  }
  /* Replay averages per setup key from monitor/backtest.json (+ slow.json for 4h/1D FVG), held-out period where it exists. */
  function replayByKey(bt) {
    const out = {}; if (!bt || !bt.groups) return out;
    for (const [k, g] of Object.entries(bt.groups)) if (/^(fvg|sweep)\|\d+$/.test(k) && g.all) out[k] = { n: g.all.n, avgR: g.all.avgR, heldOutAvgR: g.heldOut ? g.heldOut.avgR : null };
    return out;
  }

  /* Where a scanned setup stands (owner's rule, Nov 1 2026): each setup is used once, on paper OR live. Setup keys are stable
     for the same zone (coin|timeframe|side|zone price). Returns null when it's free to use. */
  function setupUse(key, paper, positions, planned, usedLog) {
    if (!key) return null;
    const pp = (paper || []).filter(t => t.setupKey === key), lv = (positions || []).filter(p => p.setupKey === key), pl = (planned || []).filter(x => x.setupKey === key);
    const open = lv.find(p => !p.closed);
    if (open) return { state: 'live', text: 'Live', acct: open.acct };
    if (pl.length) return pl[0].status === 'placed' ? { state: 'planned', text: `Limit placed @ ${fmtPx(pl[0].entry)}: waiting for fill`, acct: pl[0].acct } : { state: 'planned', text: 'Planned: place it on your platform', acct: pl[0].acct };
    if (pp.some(t => t.status === 'open')) return { state: 'paper', text: 'Paper trade open' };
    if (pp.some(t => t.status === 'pending')) return { state: 'paper', text: 'Paper limit waiting' };
    const done = lv.find(p => p.closed), dp = pp.find(t => t.status === 'closed');
    if (done) { const o = tradeOutcome(done); return { state: 'used', acct: done.acct, text: 'Used live' + (o && o !== 'unknown' ? ': ' + (o === 'win' ? 'win' : o === 'loss' ? 'loss' : 'breakeven') : '') }; }
    if (dp) return { state: 'used', text: `Used on paper: ${dp.R >= 0 ? '+' : ''}${dp.R.toFixed(2)}R` };
    // The trade itself may be gone (deleted, cleared, plan cancelled): the log still remembers the setup was used.
    const u = usedLog && usedLog[key];
    if (u) return { state: 'used', acct: u.acct, text: `Used ${u.how === 'paper' ? 'on paper' : u.how === 'planned' ? 'as a live plan' : 'live'} ${new Date(u.t).toISOString().slice(5, 10).replace('-', '/')} (trade since removed)` };
    return null;
  }
  /* Reward:risk of one trade from ITS OWN entry, stop and target, after fees (owner's rule, Nov 1 2026): what he'd make at the
     target over what he'd lose at the stop, per coin, with the 0.04% commission on both sides taken out. Same R the journal and the
     paper record use when the trade closes. null when a number is missing or the stop/target are on the wrong side. */
  function rrOf(side, entry, stop, target, f) {
    f = f || FEES; const d = side === 'short' ? -1 : 1;
    if (!(entry > 0) || stop == null || target == null || d * (entry - stop) <= 0 || d * (target - entry) <= 0) return null;
    const risk = Math.abs(entry - stop) + (entry + stop) * f.commission, reward = Math.abs(target - entry) - (entry + target) * f.commission;
    return reward / risk;
  }
  /* Live check (owner's rule, Nov 1 2026): is this setup valid in the market RIGHT NOW, not just in the replay? The setup's own rule
     checks (structure on 4h/1h/15m, room to the next liquidity, price at the zone, stop not hit) re-run on live data every scan, plus
     the reward:risk from the order he'd actually place now (market price or limit at the level) after fees. Invalid = price past
     the stop or under 1R after fees. Lists sort by this first; the replay's "alert grade" is shown second. */
  function liveCheck(u, price, atr1h) {
    const op = orderPlan(u.entry, price, u.stop, u.dir, atr1h) || { type: 'limit', entry: u.entry };
    const ent = op.type === 'market' ? op.entry : u.entry, rr = op.type === 'none' ? null : rrOf(u.dir, ent, u.stop, u.target);
    const items = (u.rules || []).map(r => ({ ok: !!r.ok, t: r.t }));
    items.push({ ok: rr != null && rr >= 2, t: rr != null ? `${rr.toFixed(1)}R from the ${op.type === 'market' ? 'market price' : 'limit'} after fees` : 'no reward:risk from here' });
    const passed = items.filter(x => x.ok).length, invalid = op.type === 'none' || rr == null || rr < 1;
    return { items, passed, total: items.length, rr, order: op.type, entry: ent, status: invalid ? 'invalid' : passed === items.length ? 'valid' : 'partial' };
  }
  /* Ranked setups board (owner's request, Nov 2 2026): every current setup numbered by the live ranking (already sorted), with how
     far it moved since the last update; setups the scanner no longer finds (zone filled, stop hit, swept level lost) drop to the
     bottom as "no longer valid" with when they were last seen, and clear after keepMs (4 h). mem is carried between updates. */
  function rankBoard(sorted, mem, nowMs, keepMs) {
    keepMs = keepMs || 4 * 3600e3; const next = {}, rows = [];
    sorted.forEach((u, i) => { const prev = mem && mem[u.key], rank = i + 1, live = prev && !prev.gone && prev.rank;
      const changed = live && prev.rank !== rank, move = changed ? prev.rank - rank : live ? prev.move : null, moveAt = changed ? nowMs : live ? prev.moveAt : null;
      const showMove = move && moveAt != null && nowMs - moveAt < 10 * 60e3 ? move : null;   // an arrow stays up 10 min after a move
      rows.push({ u, rank, move: showMove, gone: false, firstSeen: prev ? prev.firstSeen : nowMs });
      next[u.key] = { u, rank, move, moveAt, last: nowMs, firstSeen: prev ? prev.firstSeen : nowMs }; });
    const gone = Object.entries(mem || {}).filter(([k, m]) => !next[k] && nowMs - m.last < keepMs).sort((a, b) => b[1].last - a[1].last);
    for (const [k, m] of gone) { rows.push({ u: m.u, rank: null, move: null, gone: true, lastSeen: m.last, firstSeen: m.firstSeen }); next[k] = Object.assign({}, m, { gone: true }); }
    return { rows, mem: next };
  }
  /* ---------- Pass odds (owner's request, Nov 2 2026) ----------
     Monte Carlo of an evaluation under HIS rules: each day the daily floor is (balance at the reset) x (1 - daily limit); the static
     drawdown floor never moves; pass = equity reaches the target; breach = equity at or below the higher floor. Per trade he risks
     the LOWER of his profile amount and 90% of the room left (the app's sizing rule); a win pays rr x risk, a loss costs the risk, and
     fees cost feeR x risk either way. At most maxTrades a day, and the day ends after stopAfterLosses losses.
     outcomes: optional list of R results (his own closed trades, net of fees) to resample instead of the no-edge coin.
     No edge = win chance 1/(1+rr), so the average trade makes 0 before fees. A pass chance above that is luck, not skill. */
  function passOdds(o) {
    const sims = o.sims || 4000, maxDays = o.maxDays || 120, rr = o.rr || 2, pWin = o.pWin != null ? o.pWin : 1 / (1 + rr), feeR = o.feeR != null ? o.feeR : 0;
    let s = (o.seed >>> 0) || 12345; const rnd = () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    let pass = 0, breach = 0, stuck = 0; const days = [], trades = [];
    for (let k = 0; k < sims; k++) {
      let eq = o.equity, end = null, d = 0, nT = 0;
      for (; d < maxDays && !end; d++) {
        const dayFloor = o.dailyPct != null ? eq * (1 - o.dailyPct) : -Infinity, floor = Math.max(dayFloor, o.maxFloor);
        let losses = 0;
        for (let t = 0; t < o.maxTrades && losses < o.stopAfterLosses; t++) {
          const room = eq - floor, risk = o.fixedSize ? o.riskUsd : Math.min(o.riskUsd, 0.9 * room);
          // Out of room: the next trade would risk under a tenth of his normal amount; in practice the eval is over.
          if (!o.fixedSize && risk < 0.1 * o.riskUsd && eq - o.maxFloor < 0.1 * o.riskUsd / 0.9) { end = 'stuck'; break; }
          if (!(risk > 0.01)) break;
          let R; if (o.outcomes && o.outcomes.length) R = o.outcomes[Math.floor(rnd() * o.outcomes.length)]; else R = (rnd() < pWin ? rr : -1) - feeR;
          eq += R * risk; nT++; if (R < 0) losses++;
          if (eq <= floor + 1e-9) { end = 'breach'; break; }
          if (eq >= o.target - 1e-9) { end = 'pass'; break; }
        }
      }
      if (end === 'pass') { pass++; days.push(d); trades.push(nT); } else if (end === 'breach') breach++; else if (end === 'stuck') stuck++;
    }
    days.sort((a, b) => a - b); trades.sort((a, b) => a - b);
    return { pass: pass / sims, breach: breach / sims, stuck: stuck / sims, fail: (breach + stuck) / sims, open: (sims - pass - breach - stuck) / sims, medianDays: days.length ? days[Math.floor(days.length / 2)] : null, medianTrades: trades.length ? trades[Math.floor(trades.length / 2)] : null, sims, rr, pWin, feeR };
  }

  /* ---------- Card verdict (MASTER-HANDOFF §3[E], §4, §5 verdict logic; display only, Nov 2 2026) ----------
     Code decides, nothing is predicted. Gates run in order; the first one that fails = NO TRADE and the card says which.
     Evidence label (§4): untested 1 · replay_reproduced 3 · held_out_confirmed 4 · paper_forward 5 · live_record 6 (2 is for outside
     publications and is never set by the app). Below label 4, or not starred by the owner, the best a card can be is PAPER ONLY.
     A gate the app can't check yet (the event calendar) is shown as unknown and also caps the card at PAPER ONLY: ELIGIBLE is never
     claimed on an unchecked gate. ELIGIBLE means "passes your rules", not "will win". This does not change alerts, stops or sizing. */
  const LABEL_RANK = { untested: 1, publisher_reported: 2, replay_reproduced: 3, held_out_confirmed: 4, paper_forward: 5, live_record: 6 };
  const LABEL_NAMES = { untested: 'Untested', publisher_reported: 'Publisher-reported', replay_reproduced: 'Replay-reproduced', held_out_confirmed: 'Held-out confirmed', paper_forward: 'Paper-forward', live_record: 'Live record' };
  /* rep: the replay group for this setup type {all, heldOut} (2-year run when there is one); row: its Scorecard row {paper, live}.
     Held-out confirmed = decided-before-looking pass bar from HYPOTHESES.md: held-out n >= 100 and average R above +0.05 after fees. */
  function evidenceLabel(rep, row) {
    if (row && row.live && row.live.n >= 30) return 'live_record';
    if (row && row.paper && row.paper.n >= 30) return 'paper_forward';
    if (rep && rep.heldOut && rep.heldOut.n >= 100 && rep.heldOut.avgR > 0.05) return 'held_out_confirmed';
    if (rep && rep.all && rep.all.n > 0) return 'replay_reproduced';
    return 'untested';
  }
  const costHurdle = (entry, stop) => { const feeR = 2 * FEES.commission * entry / Math.abs(entry - stop); return { ok: feeR <= 0.2, feeR }; };
  const GATE_NAMES = { data_health: 'Data health', event_blackout_clear: 'Event blackout', structure: 'Structure rule', cost_hurdle: 'Cost hurdle', risk_room: 'Owner rules and risk room', model_m2: 'Model gate (M2)' };
  function cardVerdict(c) {
    const unk = (id, why) => ({ id, name: GATE_NAMES[id], ok: true, known: false, why });
    const G = [
      { id: 'data_health', name: GATE_NAMES.data_health, ok: !!c.dataOk, known: true, why: (c.dataIssues || []).join('; ') },
      c.eventsKnown ? { id: 'event_blackout_clear', name: GATE_NAMES.event_blackout_clear, ok: !c.inBlackout, known: true, why: 'inside the news window' } : unk('event_blackout_clear', 'no event calendar yet, so FOMC/CPI/NFP windows are not checked'),
      { id: 'structure', name: GATE_NAMES.structure, ok: !!(c.structure && c.structure.ok), known: true, why: ((c.structure && c.structure.reasons) || []).join('; ') },
      { id: 'cost_hurdle', name: GATE_NAMES.cost_hurdle, ok: !!(c.cost && c.cost.ok), known: true, why: c.cost ? `fees are ${c.cost.feeR.toFixed(2)}R of the stop risk (limit 0.2R)` : '' },
      c.room ? { id: 'risk_room', name: GATE_NAMES.risk_room, ok: !!c.room.ok, known: true, why: (c.room.why || []).join('; ') || 'size 0' } : unk('risk_room', 'add your prop account to check your rules and room'),
      { id: 'model_m2', name: GATE_NAMES.model_m2, ok: !!c.modelOk && !c.benched && !['disproven', 'below replay'].includes(c.scoreStatus), known: true,
        why: c.benched ? 'you benched this setup type' : ['disproven', 'below replay'].includes(c.scoreStatus) ? `Scorecard says ${c.scoreStatus}` : 'not valid now, or below the replay grade' }
    ];
    const label = c.label || 'untested', rank = LABEL_RANK[label], bad = G.find(g => g.known && !g.ok), unknown = G.filter(g => !g.known);
    let verdict, why = [];
    if (bad) verdict = 'NO TRADE';
    else {
      if (rank < LABEL_RANK.held_out_confirmed) why.push(`evidence is ${LABEL_NAMES[label].toLowerCase()}, needs held-out confirmed`);
      if (!c.starred) why.push('not starred by you');
      for (const g of unknown) why.push(g.why);
      verdict = why.length ? 'PAPER ONLY' : 'ELIGIBLE';
    }
    const evidenceLine = rank < LABEL_RANK.held_out_confirmed ? (c.starred ? 'Starred by you, but evidence is still below held-out confirmed: paper trade only.' : 'Untested idea — paper trade only unless you\'ve starred it.')
      : c.starred ? `${LABEL_NAMES[label]} and starred by you.` : `${LABEL_NAMES[label]}, not starred by you yet.`;
    return { verdict, failedGate: bad ? bad.id : null, failedName: bad ? bad.name : null, failedWhy: bad ? bad.why : null, gates: G, label, labelName: LABEL_NAMES[label], why, evidenceLine };
  }

  /* Phone alerts for a setup (model M2, owner's choice Nov 1 2026): the replay's alert grade AND valid in the market now. */
  function alertWorthy(e, price, atr1h) { return !!(e.ready && alertGrade(e).ok && liveCheck(e, price, atr1h).status === 'valid'); }
  function sortLive(list, check, fits, verdictOf) {   // verdict class first (when given), then valid now, what his account can take, checks passing, R:R now, replay grade
    const S = { valid: 0, partial: 1, invalid: 2 }, V = { ELIGIBLE: 0, 'PAPER ONLY': 1, 'NO TRADE': 2 };
    return list.map(u => ({ u, c: check(u), f: fits ? (fits(u) ? 1 : 0) : 0, v: verdictOf ? (V[verdictOf(u)] ?? 1) : 0 })).sort((a, b) => a.v - b.v || S[a.c.status] - S[b.c.status] || b.f - a.f || (b.c.passed / b.c.total) - (a.c.passed / a.c.total) || (b.c.rr || 0) - (a.c.rr || 0) || alertGrade(b.u).ok - alertGrade(a.u).ok).map(x => x.u);
  }
  /* Order type (owner's rule, Nov 1 2026): MARKET when price is within 0.25 x 1h ATR of the setup's level (the same "at the zone"
     distance the setup rules use) or already past the level on the good side (a limit there would fill at once); otherwise a
     LIMIT at the level. Price past the stop: no trade. */
  function orderPlan(level, price, stop, dir, atr1h) {
    const d = dir === 'short' ? -1 : 1;
    if (!(level > 0)) return null;
    if (price == null || !isFinite(price)) return { type: 'limit', entry: level, why: 'no live price: limit at the level' };
    if (stop != null && d * (price - stop) <= 0) return { type: 'none', entry: null, why: 'price is already past the stop: no trade' };
    const near = (atr1h > 0 ? atr1h : price * 0.004) * 0.25, away = d * (price - level);   // > 0: price still above a long's level
    if (away <= near) return { type: 'market', entry: price, why: away <= 0 ? 'price is already through the level: market now' : 'price is at the level: market now' };
    return { type: 'limit', entry: level, why: `price is ${fmtPx(Math.abs(price - level))} from the level (more than 0.25 x 1h ATR): limit at the level` };
  }
  /* A working limit order (placed on the platform, not filled): filled once price reaches the limit after it was placed.
     Checks whole candles that opened after placement (wicks count) and the live price. Returns {filled, t} or {filled:false},
     plus ranAway when price hit the target or the stop first (the setup played out without him: cancel the order). */
  function limitFill(pl, bars, barSec, price, nowMs) {
    const d = pl.side === 'short' ? -1 : 1, from = (pl.placedAt || nowMs) / 1000;
    for (const b of (bars || [])) {
      if (b.time < from) continue;   // only candles that opened after it was placed (an earlier wick in that bar isn't a fill); the live price covers the rest
      if (d > 0 ? b.low <= pl.entry : b.high >= pl.entry) return { filled: true, t: Math.max(pl.placedAt || 0, b.time * 1000) };
      if (pl.tp1 != null && (d > 0 ? b.high >= pl.tp1 : b.low <= pl.tp1)) return { filled: false, ranAway: 'target' };
      if (d > 0 ? b.low <= pl.stop : b.high >= pl.stop) return { filled: false, ranAway: 'stop' };
    }
    if (price != null && isFinite(price) && d * (price - pl.entry) <= 0) return { filled: true, t: nowMs };
    return { filled: false };
  }
  /* A planned live trade the platform screenshot now shows: same coin and side, and the same size or an entry within 0.5% of the plan. */
  function matchPlanned(planned, q) {
    const c = (planned || []).filter(x => x.sym === q.sym && x.side === q.side);
    return c.find(x => x.qty && Math.abs(x.qty - q.qty) < 1e-9) || c.find(x => Math.abs(x.entry - q.entry) <= x.entry * 0.005) || null;
  }

  /* Order history + "what happened" for a closed trade (owner's request, Nov 1 2026). Facts only, from his own log and the candles:
     - timeline: opened, every stop/target change (with why, and widened), partial closes, the close;
     - how it exited: stop / target / by hand / unknown (the exit price vs the stop and target at that time);
     - stop placement: distance in 1h ATR at entry (under 1 ATR = inside normal noise);
     - slippage past the stop; best and worst price while open in R (MFE/MAE, from 15m candles after the open);
     - after the exit (24 h): did price reach the target, or come back through the entry, after he was stopped?
     Never guesses: no candles or no open time -> it says so. */
  function tradeReview(p, c15, c60, nowMs) {
    const d = p.side === 'short' ? -1 : 1, stop0 = p.origStop != null ? p.origStop : (p.stopHist && p.stopHist[0] ? p.stopHist[0].stop : p.stop);
    const risk = stop0 != null ? Math.abs(p.entry - stop0) : null, R = x => risk ? d * (x - p.entry) / risk : null, tgt = p.tp1 != null ? p.tp1 : p.tp2;
    const ev = [{ t: p.opened, kind: 'open', text: `Opened ${p.side} ${p.qty} @ ${fmtPx(p.entry)}${stop0 != null ? ', stop ' + fmtPx(stop0) : ', NO STOP'}${tgt != null ? ', target ' + fmtPx(tgt) : ''}${p.openedUnknown ? ' (open time unknown)' : ''}` }];
    let last = stop0;
    for (const h of (p.stopHist || [])) { if (h.stop == null || h.stop === last) continue;
      const wider = last != null && d * (h.stop - last) < 0;
      ev.push({ t: h.t, kind: wider ? 'widened' : 'stop', text: `Stop ${last != null ? fmtPx(last) + ' → ' : ''}${fmtPx(h.stop)}${wider ? ' (WIDER)' : ''}${h.why ? ' · ' + h.why : ''}` }); last = h.stop; }
    for (const h of (p.tpHist || [])) ev.push({ t: h.t, kind: 'target', text: `Target → ${fmtPx(h.tp)}${h.why ? ' · ' + h.why : ''}` });
    for (const x of (p.partials || [])) ev.push({ t: x.t, kind: 'partial', text: `Closed ${x.qty}${x.price ? ' @ ' + fmtPx(x.price) : ''}${x.resultKnown === false ? ' (result in balance)' : ' · ' + fmtUsd(x.realized || 0)}` });
    const cl = p.closed, out = { events: null, lines: [], exit: 'unknown', mfeR: null, maeR: null, stopAtr: null };
    const finalStop = last;
    if (cl) {
      const xp = cl.price;
      if (xp != null && finalStop != null && Math.abs(xp - finalStop) <= Math.max(finalStop * 0.0015, 1e-9) || (xp != null && finalStop != null && d * (xp - finalStop) < 0)) out.exit = 'stop';
      else if (xp != null && tgt != null && d * (xp - tgt) >= -Math.abs(tgt) * 0.0015) out.exit = 'target';
      else if (xp != null) out.exit = 'manual';
      ev.push({ t: cl.t, kind: 'close', text: `Closed${xp != null ? ' @ ' + fmtPx(xp) : ''} · ${out.exit === 'stop' ? 'stop' : out.exit === 'target' ? 'target' : out.exit === 'manual' ? 'by hand / other' : 'exit price not known'}${cl.resultKnown === false && cl.synced ? '' : ' · ' + fmtUsd(realizedOfPos(p))}${cl.note ? ' · ' + cl.note : ''}` });
    }
    out.events = ev.filter(e => e.t != null).sort((a, b) => a.t - b.t);
    const L = (lvl, t) => out.lines.push({ lvl, t });
    if (stop0 == null) L('bad', 'No stop was recorded at entry: risk was unlimited and R can\'t be measured.');
    if ((p.stopHist || []).some((h, i, a) => i > 0 && a[i - 1].stop != null && h.stop != null && d * (h.stop - a[i - 1].stop) < 0) || p.widened) L('bad', 'The stop was moved farther away during the trade (your rule: never widen a stop).');
    // stop placement vs normal noise (1h ATR from closed candles before the open)
    if (risk && !p.openedUnknown && c60 && c60.length) { const before = c60.filter(b => (b.time + 3600) * 1000 <= p.opened).slice(-40);
      if (before.length > 15) { const a = atr(before, 14); if (a > 0) { out.stopAtr = risk / a;
        L(out.stopAtr < 1 ? 'warn' : 'ok', `Stop was ${fmtPx(risk)} from entry = ${out.stopAtr.toFixed(2)}× the 1h ATR${out.stopAtr < 1 ? ': inside normal noise, easy to get wicked out' : ''}.`); } } }
    // slippage on a stop exit
    if (out.exit === 'stop' && cl && cl.price != null && finalStop != null && risk) { const slip = d * (finalStop - cl.price);
      if (slip > 0) L(slip / risk > 0.1 ? 'warn' : 'ok', `Filled ${fmtPx(slip)} past the stop (${(slip / risk).toFixed(2)}R slippage).`); }
    // excursions while open and after the exit (15m candles that opened after the trade opened)
    if (risk && cl && !p.openedUnknown && c15 && c15.length) {
      const inT = c15.filter(b => b.time * 1000 >= p.opened && (b.time + 900) * 1000 <= cl.t);
      if (inT.length) { out.mfeR = Math.max(...inT.map(b => R(d > 0 ? b.high : b.low))); out.maeR = Math.min(...inT.map(b => R(d > 0 ? b.low : b.high)));
        L('ok', `While open: best +${Math.max(0, out.mfeR).toFixed(2)}R, worst ${Math.min(0, out.maeR).toFixed(2)}R.`);
        if (realizedOfPos(p) < 0 && out.mfeR >= 1) L('warn', `It was +${out.mfeR.toFixed(2)}R in your favor before turning into a loss: a stop to breakeven at +1R would have saved it.`);
        if (tgt != null && out.mfeR >= R(tgt) && out.exit !== 'target') L('warn', 'Price reached your target while the trade was open, but it wasn\'t taken there.'); }
      else L('ok', 'Not enough 15m candles inside the trade to measure how far price went.');
      const after = c15.filter(b => b.time * 1000 >= cl.t && b.time * 1000 < cl.t + 86400e3);
      if (after.length && out.exit === 'stop') {
        const hitT = tgt != null ? after.find(b => d > 0 ? b.high >= tgt : b.low <= tgt) : null, back = after.find(b => d > 0 ? b.high >= p.entry : b.low <= p.entry);
        if (hitT) L('warn', `After you were stopped, price reached your target ${((hitT.time * 1000 - cl.t) / 3600e3).toFixed(1)} h later: the idea was right, the stop was too tight or too early.`);
        else if (back) L('ok', `After the stop, price came back to your entry ${((back.time * 1000 - cl.t) / 3600e3).toFixed(1)} h later but didn't reach the target.`);
        else L('ok', 'After the stop, price did not come back to your entry within 24 h: the stop did its job.'); }
    } else if (cl && (p.openedUnknown || !c15 || !c15.length)) L('ok', p.openedUnknown ? 'Open time unknown (import a History → Trades screenshot), so price movement inside the trade isn\'t checked.' : 'Candles for that time aren\'t loaded: price movement isn\'t checked.');
    if (p.tag && p.tag !== 'plan') L(p.tag === 'rulebreak' ? 'bad' : 'warn', `Tagged: ${TRADE_TAGS[p.tag]}${p.tagNote ? ' — ' + p.tagNote : ''}.`);
    // Lessons to save (machine-readable, for the Scorecard): one flag per finding.
    const has = re => out.lines.some(l => re.test(l.t)), f = [];
    if (stop0 == null) f.push('no_stop');
    if (has(/never widen/)) f.push('stop_widened');
    if (out.stopAtr != null && out.stopAtr < 1) f.push('stop_in_noise');
    if (has(/slippage/) && out.lines.some(l => /slippage/.test(l.t) && l.lvl === 'warn')) f.push('big_slippage');
    if (has(/breakeven at \+1R would have saved/)) f.push('be_would_save');
    if (has(/reached your target .* later/)) f.push('target_after_stop');
    if (has(/target while the trade was open, but it wasn't taken/)) f.push('target_not_taken');
    if (has(/stop did its job/)) f.push('stop_did_job');
    if (!p.thesis) f.push('no_plan');
    out.flags = f;
    out.complete = !!(cl && (out.exit !== 'stop' || nowMs - cl.t >= 86400e3) && !p.openedUnknown && c15 && c15.length);
    return out;
  }

  const LESSON_FLAGS = { no_stop: 'No stop at entry', stop_widened: 'Stop widened', stop_in_noise: 'Stop inside normal noise (< 1 ATR)', big_slippage: 'Slipped past the stop (> 0.1R)',
    be_would_save: 'Was +1R, then lost (breakeven would have saved it)', target_after_stop: 'Target hit after the stop', target_not_taken: 'Target reached but not taken', stop_did_job: 'Stop did its job', no_plan: 'No plan written' };
  const LESSON_TAGS = { early: 'Entered early', late: 'Entered late (chased)', moved: 'Moved my stop/target', ignored: 'Ignored my plan', news: 'News / event', fomo: 'FOMO', revenge: 'Revenge trade', tired: 'Tired / distracted' };
  /* The Coach's one-line verdict for a closed trade (most important finding first). */
  function coachVerdict(rv, p) {
    const f = rv.flags || [], o = tradeOutcome(p);
    if (f.includes('no_stop')) return 'Coach: no stop at entry. Every trade needs one before anything else.';
    if (f.includes('stop_widened')) return 'Coach: the stop was widened. Keep the first stop; size smaller if it needs more room.';
    if (f.includes('target_after_stop') && f.includes('stop_in_noise')) return 'Coach: right idea, stop too tight: it sat inside normal noise and price hit your target after stopping you out. Next time give it at least 1× the 1h ATR and size down to keep the same dollar risk.';
    if (f.includes('be_would_save')) return 'Coach: it was +1R and still lost. Move the stop to breakeven at +1R (Settings has the rule).';
    if (f.includes('target_not_taken')) return 'Coach: price reached the target but it wasn\'t taken. Set the take profit on the platform when you enter.';
    if (f.includes('target_after_stop')) return 'Coach: the idea was right but the stop got hit first. Check whether the entry was early or the stop too close.';
    if (f.includes('big_slippage')) return 'Coach: slippage past the stop was large. Avoid fast news moments, or use a slightly smaller size.';
    if (f.includes('stop_in_noise')) return 'Coach: the stop was inside normal noise (under 1 ATR). Wider stop with smaller size is usually steadier.';
    if (o === 'loss' && f.includes('stop_did_job')) return 'Coach: a clean loss. The stop did its job and price kept going against you. Nothing to fix; this is the cost of trading.';
    if (o === 'win') return 'Coach: plan followed and it worked. Keep doing that.';
    if (f.includes('no_plan')) return 'Coach: no plan was written. Write one line before the next trade.';
    return 'Coach: nothing stands out. ' + (rv.complete ? '' : 'More will show once the candles after the exit are in.');
  }
  /* Lessons across closed trades (owner's request, Nov 1 2026): how often each finding and each of his own tags happens, and the
     average R of those trades. The evidence for changing the model (e.g. wider stops) — counted, never acted on automatically. */
  function lessons(positions, model) {
    const closed = (positions || []).filter(p => p.closed && (!model || ((p.ref && p.ref.model) || modelAt(p.opened)) === model)), out = {};
    const add = (k, label, p) => { const o = out[k] = out[k] || { label, n: 0, rs: [] }; o.n++; const r = liveR(p); if (r != null) o.rs.push(r); };
    for (const p of closed) { for (const k of ((p.review && p.review.flags) || [])) if (LESSON_FLAGS[k]) add('f:' + k, LESSON_FLAGS[k], p);
      for (const k of ((p.lesson && p.lesson.tags) || [])) if (LESSON_TAGS[k]) add('t:' + k, LESSON_TAGS[k], p); }
    return Object.entries(out).map(([k, o]) => ({ key: k, label: o.label, n: o.n, avgR: o.rs.length ? o.rs.reduce((a, x) => a + x, 0) / o.rs.length : null, of: closed.length })).sort((a, b) => b.n - a.n);
  }

  /* Owner's rule: trade both ways only when it makes sense. A side is OK when the 4h trend is that way, or when the
     1h and 15m have both turned that way (an early reversal). Never long and short on the same coin at once. */
  function directionCheck(side, sym, struct, positions, acctId) {
    const want = side === 'long' ? 'bull' : 'bear', reasons = [];
    const b4 = struct && struct['240'] && struct['240'].bias, b1 = struct && struct['60'] && struct['60'].bias, b15 = struct && struct['15'] && struct['15'].bias;
    const trendOk = b4 === want || (b1 === want && b15 === want);
    if (!trendOk) reasons.push(`${side} against structure (4h ${b4 || '?'}, 1h ${b1 || '?'}, 15m ${b15 || '?'})`);
    if (positions.some(p => !p.closed && p.acct === acctId && p.sym === sym && p.side !== side && openQty(p) > 0)) reasons.push(`already ${side === 'long' ? 'short' : 'long'} ${sym}`);
    return { ok: !reasons.length, reasons, known: !!(b4 || b1) };
  }
  const TRADE_TAGS = { plan: 'Followed plan', mistake: 'Mistake (execution/logging)', rulebreak: 'Rule break', data: 'Data problem' };

  /* Use platform fills to complete an open position's story: its real open time and the partial closes that took it
     from the opening size to what's open now. Only applied when the numbers add up exactly; otherwise nothing changes. */
  function fillHistory(p, fills) {
    const openSide = p.side === 'short' ? 'sell' : 'buy', closeSide = p.side === 'short' ? 'buy' : 'sell';
    const op = fills.filter(f => f.action === 'open' && f.side === openSide && f.sym === p.sym && f.price != null && Math.abs(f.price - p.entry) < 0.01 && f.t != null)
      .sort((x, y) => y.t - x.t)[0];
    if (!op) return null;
    const closes = fills.filter(f => f.action === 'close' && f.side === closeSide && f.sym === p.sym && f.t != null && f.t > op.t && f.price != null).sort((x, y) => x.t - y.t);
    const closed = closes.reduce((a, f) => a + f.qty, 0);
    const cur = openQty(p);
    if (Math.abs(op.qty - closed - cur) > 1e-9) return { opened: op.t, partials: null };
    return { opened: op.t, qty: op.qty, partials: closes.map(f => ({ t: f.t, qty: f.qty, price: f.price, realized: realizedFor(Object.assign({}, p, { opened: op.t }), f.qty, f.price, f.t), note: 'partial close on platform (' + (f.type || 'fill') + ')' })) };
  }

  // ---- Formatting --------------------------------------------------------
  function fmtUsd(x) {
    if (x == null || !isFinite(x)) return '—';
    const s = Math.abs(x) >= 1000 ? Math.abs(x).toLocaleString('en-US', { maximumFractionDigits: 0 }) : Math.abs(x).toFixed(2);
    return (x < 0 ? '-$' : '$') + s;
  }
  function fmtPx(x) {
    if (x == null || !isFinite(x)) return '—';
    const a = Math.abs(x);
    const dp = a >= 1000 ? 1 : a >= 10 ? 2 : a >= 1 ? 4 : 5;
    return x.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
  }
  const tfName = tf => ({ '1': '1m', '5': '5m', '15': '15m', '60': '1h', '240': '4h', '1440': '1D' }[String(tf)] || tf + 'm');

  const Core = { passOdds, LABEL_RANK, LABEL_NAMES, evidenceLabel, costHurdle, cardVerdict, rankBoard, paperLimit, paperOrders, coachVerdict, LESSON_FLAGS, LESSON_TAGS, lessons, tradeReview, alertWorthy, liveCheck, sortLive, rrOf, limitFill, tradeId, dedupeSetups, orderPlan, setupUse, matchPlanned, outcomeOf, tradeOutcome, samePx, levMap, levInfo, missingInfo, MODELS, MODEL, modelAt, SCORE_RULES, SETUP_CHOICES, setupKey, setupLabel, liveR, tradeRecords, statsR, statsAgg, scoreStatus, scorecard, tradePatterns, resultPayload, replayByKey, redactSample, issueLink, SAMPLE_REASONS, sampleReasons, layoutSample, sampleFor, fnv, alertGate, alertQueue, alertSettle, fillHistory, directionCheck, TRADE_TAGS, planSync, parseResetUtc, tradeSnapshot, planOrderFills, planCorrections, ledgerTimeline, linkLedger, heikinAshi, ema, entryCheck, scanSetups, weighIdea, confirmElsewhere, sweepSetups, marketOpenTag, impulseLegs, FIBS, rvol, volumeRead, levelPlan, alertGrade, paperOpen, paperStep, paperR, paperStats, paperPositions, paperSize, accountReview, parseIsoUtc, propEstimate, consensus, calibration, feedTally, feedReport, parseKrakenProp, sizeFromLimits, PLANS, SIZES, FEES, CAPITAL_CAP, ADDON_90, LEVERAGE, MAX_NOTIONAL, maxNotional, parseRulePct, ledger, feeEvents, rollovers, PROFILES, SESSIONS, profileById, lastReset, nextReset,
    tzParts, base, levCap, qtyDp, openQty, grossPnl, fundingEst, openFeesPaid, netIfClosed, realizedFor, rMultiple,
    realizedOfPos, planOf, accountState, deskTotals, sizeFor, atr, swings, structure, fvgs, liveFvgs, vwapSince,
    sessionRanges, openingRange, keyLevels, OPEN, openDays, trend4h, openTrade, openRead, openPlan, health, setupsToWatch, fmtUsd, fmtPx, tfName };
  if (typeof module !== 'undefined' && module.exports) module.exports = Core; else root.Core = Core;
})(typeof window !== 'undefined' ? window : globalThis);
