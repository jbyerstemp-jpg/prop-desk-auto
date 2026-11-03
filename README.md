# PDA — Prop Desk Autonomous

PDA is a research-first, dual-market trading platform for Kraken (centralized exchange) and Solana decentralized exchanges. Its first milestone is a **paper-trading-only** foundation.

## Safety status

- Live trading is not implemented or enabled.
- No private keys, seed phrases, exchange secrets, or wallet signing belong in this repository.
- Every proposed order must pass deterministic risk checks before execution.
- Paper fills model fees and configurable slippage; they are simulations, not evidence of real-world execution quality.
- Never fund an unvalidated strategy. Backtests and paper results do not guarantee future performance.

## Initial architecture

- `src/pda/models.py`: normalized market and order data contracts.
- `src/pda/risk.py`: deterministic pre-trade risk gates.
- `src/pda/paper.py`: simulated fill engine with fee/slippage accounting.
- `src/pda/strategy.py`: baseline momentum signal generator.
- `tests/`: unit tests for safety and accounting invariants.

Future adapters will ingest public Kraken and Solana DEX market data into the same normalized contracts. Venue-specific execution remains out of scope until paper validation, security review, and explicit operator approval.

## Quick start

Python 3.11+:

```bash
python -m venv .venv
source .venv/bin/activate  # Windows: .venv\\Scripts\\activate
pip install -e ".[dev]"
pytest
```

## Current scope and limitations

This is a software foundation, not a profitable trading system. The simulator assumes a supplied reference price and does not yet model order-book depth, routing, MEV, chain finality, partial fills, outages, or venue-specific fee schedules. Those must be addressed before any live pilot.

## Development principles

1. Paper trading by default; no live execution path in the initial milestone.
2. Decimal arithmetic for prices, quantities, fees, and balances.
3. Fail closed on invalid inputs or risk-limit breaches.
4. Record every decision and simulated fill for auditability.
5. Separate strategy signals from risk authorization and execution.
