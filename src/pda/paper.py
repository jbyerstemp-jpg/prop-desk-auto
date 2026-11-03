from decimal import Decimal, ROUND_DOWN

from pda.models import OrderIntent, PaperFill, Side, utc_now


class PaperBroker:
    """Simple paper fill model; it never sends an order to a venue."""

    def __init__(self, *, fee_rate: Decimal = Decimal("0.0026"), slippage_bps: Decimal = Decimal(5)) -> None:
        if fee_rate < 0 or slippage_bps < 0:
            raise ValueError("fee_rate and slippage_bps cannot be negative")
        self.fee_rate = fee_rate
        self.slippage_bps = slippage_bps

    def execute(self, order: OrderIntent) -> PaperFill:
        slip = self.slippage_bps / Decimal(10000)
        direction = Decimal(1) + slip if order.side is Side.BUY else Decimal(1) - slip
        fill_price = (order.reference_price * direction).quantize(Decimal("0.00000001"), rounding=ROUND_DOWN)
        gross = order.quantity * fill_price
        fee = gross * self.fee_rate
        slippage_cost = abs(fill_price - order.reference_price) * order.quantity
        return PaperFill(order, fill_price, gross, fee, slippage_cost, utc_now())
