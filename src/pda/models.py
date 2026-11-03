from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
from decimal import Decimal
from enum import StrEnum


class Venue(StrEnum):
    KRAKEN = "kraken"
    SOLANA_RAYDIUM = "solana_raydium"
    SOLANA_ORCA = "solana_orca"


class AssetTier(StrEnum):
    ESTABLISHED = "established"
    EMERGING = "emerging"


class Side(StrEnum):
    BUY = "buy"
    SELL = "sell"


@dataclass(frozen=True, slots=True)
class MarketSnapshot:
    symbol: str
    venue: Venue
    tier: AssetTier
    price: Decimal
    observed_at: datetime
    liquidity_usd: Decimal
    volume_24h_usd: Decimal

    def __post_init__(self) -> None:
        if not self.symbol.strip():
            raise ValueError("symbol must not be empty")
        if self.price <= 0:
            raise ValueError("price must be positive")
        if self.liquidity_usd < 0 or self.volume_24h_usd < 0:
            raise ValueError("liquidity and volume cannot be negative")
        if self.observed_at.tzinfo is None:
            raise ValueError("observed_at must be timezone-aware")


@dataclass(frozen=True, slots=True)
class OrderIntent:
    symbol: str
    venue: Venue
    side: Side
    quantity: Decimal
    reference_price: Decimal
    strategy_id: str
    created_at: datetime

    def __post_init__(self) -> None:
        if not self.symbol.strip() or not self.strategy_id.strip():
            raise ValueError("symbol and strategy_id are required")
        if self.quantity <= 0 or self.reference_price <= 0:
            raise ValueError("quantity and reference_price must be positive")
        if self.created_at.tzinfo is None:
            raise ValueError("created_at must be timezone-aware")


@dataclass(frozen=True, slots=True)
class PaperFill:
    order: OrderIntent
    fill_price: Decimal
    gross_value: Decimal
    fee: Decimal
    slippage_cost: Decimal
    filled_at: datetime
    mode: str = "paper"


def utc_now() -> datetime:
    return datetime.now(UTC)
