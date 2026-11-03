"""Optional DuckDB candle store for local, reproducible market research."""
from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass
from datetime import UTC, datetime
from decimal import Decimal
from pathlib import Path

from pda.models import Venue


@dataclass(frozen=True, slots=True)
class CandleRecord:
    venue: Venue
    symbol: str
    timeframe: str
    open_time: datetime
    open: Decimal
    high: Decimal
    low: Decimal
    close: Decimal
    volume: Decimal
    source: str

    def __post_init__(self) -> None:
        if not self.symbol.strip() or not self.timeframe.strip() or not self.source.strip():
            raise ValueError("symbol, timeframe, and source are required")
        if self.open_time.tzinfo is None:
            raise ValueError("open_time must be timezone-aware")
        if min(self.open, self.high, self.low, self.close) <= 0:
            raise ValueError("OHLC prices must be positive")
        if self.high < max(self.open, self.close) or self.low > min(self.open, self.close):
            raise ValueError("candle high/low do not contain open and close")
        if self.volume < 0:
            raise ValueError("volume cannot be negative")


class DuckDBStore:
    """Local candle store; DuckDB is an optional research extra, not a runtime requirement."""

    def __init__(self, path: str | Path = "pda-research.duckdb") -> None:
        try:
            import duckdb
        except ImportError as exc:
            raise RuntimeError("Install PDA's research extra: pip install '.[research]'") from exc
        self._db = duckdb.connect(str(path))
        self._db.execute(
            """
            CREATE TABLE IF NOT EXISTS candles (
                venue VARCHAR NOT NULL,
                symbol VARCHAR NOT NULL,
                timeframe VARCHAR NOT NULL,
                open_time TIMESTAMP NOT NULL,
                open_price DECIMAL(38, 18) NOT NULL,
                high_price DECIMAL(38, 18) NOT NULL,
                low_price DECIMAL(38, 18) NOT NULL,
                close_price DECIMAL(38, 18) NOT NULL,
                volume DECIMAL(38, 18) NOT NULL,
                source VARCHAR NOT NULL,
                ingested_at TIMESTAMP NOT NULL,
                PRIMARY KEY (venue, symbol, timeframe, open_time)
            )
            """
        )

    def upsert_candles(self, records: Iterable[CandleRecord]) -> int:
        rows = [
            (
                record.venue.value,
                record.symbol,
                record.timeframe,
                record.open_time.astimezone(UTC).replace(tzinfo=None),
                record.open,
                record.high,
                record.low,
                record.close,
                record.volume,
                record.source,
                datetime.now(UTC).replace(tzinfo=None),
            )
            for record in records
        ]
        if not rows:
            return 0
        self._db.executemany(
            """
            INSERT OR REPLACE INTO candles VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            rows,
        )
        return len(rows)

    def fetch_candles(
        self, venue: Venue, symbol: str, timeframe: str, *, limit: int = 1000
    ) -> list[CandleRecord]:
        if limit < 1 or limit > 100_000:
            raise ValueError("limit must be between 1 and 100000")
        rows = self._db.execute(
            """
            SELECT venue, symbol, timeframe, open_time, open_price, high_price,
                   low_price, close_price, volume, source
            FROM candles
            WHERE venue = ? AND symbol = ? AND timeframe = ?
            ORDER BY open_time DESC
            LIMIT ?
            """,
            [venue.value, symbol, timeframe, limit],
        ).fetchall()
        return [
            CandleRecord(
                venue=Venue(row[0]),
                symbol=row[1],
                timeframe=row[2],
                open_time=row[3].replace(tzinfo=UTC),
                open=Decimal(str(row[4])),
                high=Decimal(str(row[5])),
                low=Decimal(str(row[6])),
                close=Decimal(str(row[7])),
                volume=Decimal(str(row[8])),
                source=row[9],
            )
            for row in reversed(rows)
        ]

    def count(self, venue: Venue | None = None) -> int:
        if venue is None:
            return int(self._db.execute("SELECT count(*) FROM candles").fetchone()[0])
        return int(
            self._db.execute("SELECT count(*) FROM candles WHERE venue = ?", [venue.value]).fetchone()[0]
        )

    def close(self) -> None:
        self._db.close()

    def __enter__(self) -> DuckDBStore:
        return self

    def __exit__(self, *_: object) -> None:
        self.close()
