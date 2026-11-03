# PDA app status and operating boundaries

## Separate workspaces

- **Prop Evaluation** is the default workspace. It is for trade planning, manual review, and journaling. PDA does not automatically place or copy prop-firm orders.
- **Personal Capital** has a separate browser-local paper ledger and configurable simulated starting capital. It is not mixed with the Prop Desk manual paper ledger.

## Personal paper autopilot

The browser-session autopilot is an experimental, long-only 15-minute EMA 9/21 bullish-cross baseline with a 2× ATR stop and 2R target. It uses public Kraken spot ticker/candles, simulated 5bp slippage and 0.26% fees per side, a maximum 10% notional allocation, a configurable risk budget capped at 0.5% per trade, a daily loss guard capped at 2%, and a three-trade daily default.

It fails closed unless the feed is live Kraken, the quote is no more than 15 seconds old, and the 15-minute candle series is no more than 120 seconds old. Demo and Coinbase fallback feeds cannot open positions. Stops are prioritized over targets when the market crosses both. State is persisted in the browser under a separate key.

**Important limitations:** this loop runs only while the app is open in the browser. It is not a hosted 24/7 service. The strategy is experimental and unvalidated; it is not a recommendation or a signal. No live order, exchange credential, wallet signing, or money movement path exists. Do not enable it with real-money expectations.

## Validation status

CI covers Python unit tests and lint, research-model contracts, PDA feed-gate contracts, autopilot entry/exit/persistence/venue/freshness checks, monitor contracts, JavaScript syntax checks, and a Playwright browser smoke test for desktop and iPhone-sized viewports, both account modes, autopilot pause behavior, and OCR runtime. CI is not a substitute for a real-device screenshot import check. The pinned Tesseract runtime and English language data have been restored, and the Playwright browser smoke test successfully initializes OCR and processes a blank PNG. A real Kraken screenshot still needs manual device validation.

## Next engineering gates

1. Complete clone asset audit, including OCR and monitor/replay resources.
2. Run browser smoke tests on desktop and mobile layouts.
3. Review persistence, recovery, and paper accounting under reconnects and browser restarts.
4. Collect at least 30 closed paper trades before judging the experimental strategy; perform held-out and placebo comparisons before considering any strategy promotion.
5. Keep live execution out of scope until separate security, venue, legal, and operator approval gates are met.
