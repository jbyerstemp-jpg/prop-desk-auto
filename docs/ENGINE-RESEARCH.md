# PDA engine research and integration plan

Status: architecture audit; no strategy rules or live execution changed.

## Objective

Use the existing Prop Desk research model as PDA's first decision/research layer, and use the seven owner-selected repositories as implementation references. Keep the prop-evaluation workflow separate from autonomous personal-capital trading. The initial engine milestone remains paper-only.

## Existing Prop Desk model audit

### Research model: `js/research-model.js` v0.4.0-experimental

The model is deterministic and dependency-free. Its current outputs include:

- Confirmed and developing candlestick-pattern observations.
- Internal and major swing structure, protected highs/lows, breaks, and structure transitions.
- Range detection and break/retest setup lifecycle (watching, triggered, invalidated, expired).
- Optional flow and liquidation-heatmap context with source, scope, time-window, freshness, and consistency checks.
- Event IDs/namespaces for deduplication and replay.
- Explicit data states: empty, gap, stale, warming_up, ready.
- Alert batches classified as `research_observations_not_trade_instructions`.

Important boundary: `accountRisk.status` and setup `riskEligibility` are `not_evaluated`. The model is not an order generator or risk engine. Preserve that boundary; downstream components must independently validate an opportunity and authorize its size.

### Existing app adapter: `js/research.js`

- Converts Kraken candle rows to closed/live stream bars.
- Evaluates 15m, 1h, 4h, and daily independently.
- Requires at least 30 closed bars for a timeframe.
- Drops malformed/duplicate bars and surfaces gaps instead of filling them.
- Produces summaries and coach notes, not trade authorization.

### Existing trend engine: `js/trend.js`

- Implements six daily trend rules E1–E6 and the fixed 1/6-per-rule H19 portfolio.
- Uses next-daily-open entries, ATR20-based initial stops, fees/slippage/swap assumptions, and forward-only start filtering.
- Includes H15/H19 historical research metrics in code. These are historical study results, not a guarantee or a live signal.
- Existing app's `trendForward()` displays paper-forward positions from daily candles; the Paper tab also supports manually created setup records.
- This is not yet a general autonomous execution loop. Do not confuse the read-only trend-forward card with a persistent broker/account engine.

### Live feed constraints

`js/feed.js` exposes Kraken public REST/WS candle and ticker data, quote bid/ask/last/timestamp, feed age/status, and a clearly labelled synthetic `?demo` mode. It may also use separately labelled Coinbase fallback data. Automated paper fills must identify the venue/source and refuse synthetic demo data in a live-data run. Do not silently mix Coinbase candles with Kraken fills. A REST candle close is not a live quote.

## Owner-selected repository review

The repositories are engineering references; PDA should not copy large codebases wholesale. Integrate only the narrow interfaces needed and preserve license notices/obligations.

| Repository | Useful role in PDA | Integration decision / constraint |
|---|---|---|
| [solana-py](https://github.com/michaelhly/solana-py) | Python async Solana JSON-RPC and websocket client; useful for a future Solana data adapter and account-state reader. | MIT. Suitable as an optional backend dependency when the Solana adapter is scheduled. Keep public market-data reads separate from any wallet signer. |
| [Raydium SDK V2](https://github.com/raydium-io/raydium-sdk-V2) | TypeScript SDK patterns for token/pool discovery, pool metadata, and venue-specific quotes/swaps. | Repository LICENSE is GPL-3.0. Do not bundle/import into PDA until distribution and copyleft obligations are deliberately reviewed. Study the interface and pool math; keep a venue adapter boundary. |
| [Orca Whirlpools](https://github.com/orca-so/whirlpools) | Concentrated-liquidity AMM account model, tick arrays, quoting, and venue-specific pool state. | Current repository license is the Orca License, with a non-commercial-use grant and additional terms; it is not simply Apache-2.0 for current code. Do not integrate or redistribute current code until the intended use is confirmed to fit the license or permission is obtained. |
| [vectorbt](https://github.com/polakowo/vectorbt) | Vectorized research, parameter sweeps, portfolio simulation, fee-aware comparison, and experiment analysis. | Apache-2.0 with Commons Clause. The Commons Clause restricts selling the software or a product/service whose value derives substantially from it. Keep optional/research-only pending a distribution/commercial-use decision; do not make PDA's production engine depend on it. |
| [DuckDB](https://github.com/duckdb/duckdb) | Local analytical store for normalized candles, model observations, experiment runs, fills, and equity/return series. | MIT. Strong fit for research/replay storage; keep the append-only trade/event ledger as the source of truth. |
| [QuantStats](https://github.com/ranaroussi/quantstats) | Return-series analytics, drawdown/rolling metrics, Monte Carlo analysis, and HTML reporting. | Apache-2.0. Use for portfolio-period returns and risk reporting, not as a replacement for trade-level accounting; its own README distinguishes period metrics from individual-trade win rates. |
| [Lightweight Charts](https://github.com/tradingview/lightweight-charts) | Existing browser chart and future overlays for model events, candidate entries, stops, fills, and equity context. | Apache-2.0 with attribution requirements. Already vendored in the imported app with a license file; retain notices. |

## Proposed PDA architecture

1. **Venue data adapters**
   - Kraken: start with the existing read-only `Feed` implementation; normalize candles, quotes, timestamps, source/venue, and freshness.
   - Solana: later add a Python async RPC/websocket market/account-data adapter using solana-py. Raydium and Orca must remain separate venue adapters because pool state, quoting, liquidity, fees, and execution semantics differ.
   - Never infer executable liquidity from 24-hour volume alone. Record quote depth/impact and source timestamp where available.

2. **Existing model layer**
   - Keep `research-model.js` as the authoritative structure/pattern/setup observation engine initially.
   - Keep `trend.js` as a separate, explicitly identified strategy family.
   - Version every model/configuration. Store raw inputs, model version, outputs, and event IDs so a decision can be reconstructed.

3. **Decision / strategy layer**
   - Convert model observations into candidate opportunities only through explicit, preregistered policies.
   - Evaluate timeframe alignment, structure state, setup lifecycle, quote freshness, spread, volatility, and venue conditions.
   - Require a clear entry trigger, invalidation/stop, exit policy, expiry, and rationale. Unknown/stale/gapped data means no entry.
   - Do not optimize thresholds on the same sample used to report performance. Log all tested variants and use chronological held-out data plus placebo/baseline comparisons.

4. **Risk and paper execution**
   - Deterministic risk gate is independent of model/AI output and can only reject or reduce risk.
   - Simulated broker handles bid/ask, fees, spread, slippage/impact, partial fills where modeled, and rejected/stale quotes.
   - Separate ledgers and risk profiles for personal-capital simulation and each prop-firm evaluation. Prop-firm mode is analysis/coaching/manual execution unless that firm's current rules explicitly permit automation.
   - Persist decisions, rejects, fills, fees, open positions, realized/unrealized P&L, equity, and drawdown. Start/pause/kill controls must fail closed.

5. **Research and reporting**
   - DuckDB stores immutable normalized event/candle/trade facts for replay and experiments.
   - vectorbt is an optional research harness only after the Commons Clause use case is reviewed; otherwise use our own transparent event-driven simulator.
   - QuantStats summarizes daily/period returns; PDA separately calculates trade-level win rate, expectancy, profit factor, MAE/MFE, exposure, and costs.
   - Lightweight Charts visualizes the exact same event/trade records shown in the ledger.

## First implementation sequence

1. Add contract tests around the existing research model: closed/live candle rules, gaps, stale data, duplicate event IDs, pattern/setup lifecycle, and no-risk-authorization invariant.
2. Add a read-only PDA adapter that feeds normalized Kraken candles to `PDResearch.read()` and records model observations. No orders or simulated positions yet.
3. Replay the existing model on historical Kraken candles and compare candidate policies against no-trade, simple trend, and shuffled/placebo baselines. Preregister the policy and pass criteria before measuring.
4. Only after the adapter/replay tests pass, connect a deterministic paper broker and risk gate. The strategy must not be called validated until forward paper evidence meets the predeclared bar.
5. Add Solana adapters only after the Kraken loop is reproducible and the Raydium/Orca license boundaries are resolved.

## Non-negotiable boundaries

- Paper-only in this milestone; no exchange orders, wallet signing, private keys, seed phrases, or credential storage.
- The AI/model cannot override deterministic risk checks.
- Never widen a live stop; no raise-risk-to-catch-up behavior.
- Demo data is never counted as live-market paper performance.
- A backtest, a pattern observation, or a model score is not proof of future profitability.
- Keep the original Prop Desk repositories untouched; work only in the PDA repository/branch.
