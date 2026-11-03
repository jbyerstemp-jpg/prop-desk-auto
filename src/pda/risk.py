from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal

from pda.models import OrderIntent


@dataclass(frozen=True, slots=True)
class RiskLimits:
    max_order_notional: Decimal = Decimal(100)
    max_symbol_exposure: Decimal = Decimal(250)
    max_daily_loss: Decimal = Decimal(50)
    min_liquidity_usd: Decimal = Decimal(10000)
    max_reference_price_deviation: Decimal = Decimal("0.02")


@dataclass(frozen=True, slots=True)
class RiskDecision:
    approved: bool
    reasons: tuple[str, ...]


class RiskEngine:
    """Deterministic fail-closed pre-trade checks for the paper milestone."""

    def __init__(self, limits: RiskLimits | None = None) -> None:
        self.limits = limits or RiskLimits()

    def evaluate(
        self,
        order: OrderIntent,
        *,
        current_symbol_exposure: Decimal = Decimal(0),
        realized_daily_pnl: Decimal = Decimal(0),
        observed_price: Decimal | None = None,
        liquidity_usd: Decimal = Decimal(0),
    ) -> RiskDecision:
        reasons: list[str] = []
        notional = order.quantity * order.reference_price
        if notional > self.limits.max_order_notional:
            reasons.append("order_notional_limit_exceeded")
        if current_symbol_exposure + notional > self.limits.max_symbol_exposure:
            reasons.append("symbol_exposure_limit_exceeded")
        if realized_daily_pnl <= -self.limits.max_daily_loss:
            reasons.append("daily_loss_limit_reached")
        if liquidity_usd < self.limits.min_liquidity_usd:
            reasons.append("insufficient_liquidity")
        if observed_price is None or observed_price <= 0:
            reasons.append("missing_or_invalid_observed_price")
        else:
            deviation = abs(observed_price - order.reference_price) / order.reference_price
            if deviation > self.limits.max_reference_price_deviation:
                reasons.append("reference_price_deviation_too_high")
        return RiskDecision(approved=not reasons, reasons=tuple(reasons))
