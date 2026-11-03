from collections.abc import Sequence
from decimal import Decimal

from pda.models import MarketSnapshot, OrderIntent, Side, utc_now


class MomentumStrategy:
    """Minimal baseline: emit a buy intent when short-term return clears a threshold."""

    def __init__(self, *, threshold: Decimal = Decimal("0.01"), quantity: Decimal = Decimal("0.001")) -> None:
        if threshold < 0 or quantity <= 0:
            raise ValueError("threshold must be non-negative and quantity positive")
        self.threshold = threshold
        self.quantity = quantity

    def generate(self, history: Sequence[MarketSnapshot]) -> OrderIntent | None:
        if len(history) < 2:
            return None
        previous, latest = history[-2], history[-1]
        if previous.symbol != latest.symbol or previous.venue != latest.venue:
            return None
        if previous.price <= 0:
            return None
        change = (latest.price - previous.price) / previous.price
        if change < self.threshold:
            return None
        return OrderIntent(
            symbol=latest.symbol,
            venue=latest.venue,
            side=Side.BUY,
            quantity=self.quantity,
            reference_price=latest.price,
            strategy_id="baseline_momentum",
            created_at=utc_now(),
        )
