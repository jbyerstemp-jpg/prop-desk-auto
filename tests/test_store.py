from dataclasses import replace
from datetime import UTC, datetime
from decimal import Decimal

import pytest

from pda.models import Venue
from pda.store import CandleRecord, DuckDBStore


def candle(close: str = "101") -> CandleRecord:
    return CandleRecord(
        venue=Venue.KRAKEN,
        symbol="BTC/USD",
        timeframe="15m",
        open_time=datetime(2026, 11, 3, 12, tzinfo=UTC),
        open=Decimal("100"),
        high=max(Decimal("102"), Decimal(close)),
        low=Decimal("99"),
        close=Decimal(close),
        volume=Decimal("12.5"),
        source="kraken_spot_ohlc",
    )


def test_duckdb_upsert_and_ordered_readback(tmp_path) -> None:
    with DuckDBStore(tmp_path / "research.duckdb") as store:
        assert store.upsert_candles([candle(), candle("101.5")]) == 2
        assert store.count() == 1
        rows = store.fetch_candles(Venue.KRAKEN, "BTC/USD", "15m")
        assert len(rows) == 1
        assert rows[0].close == Decimal("101.5")
        assert rows[0].source == "kraken_spot_ohlc"


def test_duckdb_separates_venues_and_symbols(tmp_path) -> None:
    kraken = candle()
    raydium = CandleRecord(
        venue=Venue.SOLANA_RAYDIUM,
        symbol="SOL/USDC",
        timeframe="15m",
        open_time=kraken.open_time,
        open=Decimal("100"),
        high=Decimal("102"),
        low=Decimal("99"),
        close=Decimal("101"),
        volume=Decimal("12.5"),
        source="raydium_pool",
    )
    with DuckDBStore(tmp_path / "research.duckdb") as store:
        store.upsert_candles([kraken, raydium])
        assert store.count(Venue.KRAKEN) == 1
        assert store.count(Venue.SOLANA_RAYDIUM) == 1


def test_candle_record_rejects_bad_times_and_ranges() -> None:
    with pytest.raises(ValueError, match="timezone-aware"):
        CandleRecord(
            venue=Venue.KRAKEN, symbol="BTC/USD", timeframe="15m",
            open_time=datetime(2026, 11, 3), open=Decimal("100"), high=Decimal("102"),
            low=Decimal("99"), close=Decimal("103"), volume=Decimal(1), source="test",
        )
    with pytest.raises(ValueError, match="high/low"):
        replace(candle(), low=Decimal("100.5"))


def test_fetch_limit_is_bounded(tmp_path) -> None:
    with DuckDBStore(tmp_path / "research.duckdb") as store:
        with pytest.raises(ValueError, match="limit"):
            store.fetch_candles(Venue.KRAKEN, "BTC/USD", "15m", limit=0)
