from datetime import datetime, timezone
from decimal import Decimal

from pda.models import AssetTier, MarketSnapshot, OrderIntent, Side, Venue
from pda.paper import PaperBroker
from pda.risk import RiskEngine, RiskLimits
from pda.strategy import MomentumStrategy


def snapshot(price: str) -> MarketSnapshot:
    return MarketSnapshot("SOL/USD", Venue.KRAKEN, AssetTier.ESTABLISHED, Decimal(price), datetime.now(timezone.utc), Decimal("500000"), Decimal("1000000"))


def order(quantity: str = "1", price: str = "100") -> OrderIntent:
    return OrderIntent("SOL/USD", Venue.KRAKEN, Side.BUY, Decimal(quantity), Decimal(price), "test", datetime.now(timezone.utc))


def test_risk_engine_approves_valid_paper_intent() -> None:
    result = RiskEngine().evaluate(order(), observed_price=Decimal("100"), liquidity_usd=Decimal("50000"))
    assert result.approved
    assert result.reasons == ()


def test_risk_engine_fails_closed_on_daily_loss_and_liquidity() -> None:
    result = RiskEngine().evaluate(order(), realized_daily_pnl=Decimal("-50"), observed_price=Decimal("100"), liquidity_usd=Decimal("0"))
    assert not result.approved
    assert "daily_loss_limit_reached" in result.reasons
    assert "insufficient_liquidity" in result.reasons


def test_paper_broker_models_buy_slippage_and_fee() -> None:
    fill = PaperBroker(fee_rate=Decimal("0.01"), slippage_bps=Decimal("100")).execute(order())
    assert fill.mode == "paper"
    assert fill.fill_price == Decimal("101.00000000")
    assert fill.fee == Decimal("1.0100000000")
    assert fill.slippage_cost == Decimal("1.00000000")


def test_momentum_strategy_emits_intent_after_threshold() -> None:
    signal = MomentumStrategy(threshold=Decimal("0.01"), quantity=Decimal("1")).generate([snapshot("100"), snapshot("102")])
    assert signal is not None
    assert signal.side is Side.BUY


def test_momentum_strategy_ignores_mixed_market_history() -> None:
    first = snapshot("100")
    second = MarketSnapshot("ETH/USD", Venue.KRAKEN, AssetTier.ESTABLISHED, Decimal("102"), datetime.now(timezone.utc), Decimal("500000"), Decimal("1000000"))
    assert MomentumStrategy().generate([first, second]) is None
