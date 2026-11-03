"""Read-only Solana JSON-RPC adapter. No signing, transactions, or wallet access."""
from __future__ import annotations

import base64
import json
from collections.abc import Callable
from dataclasses import dataclass
from decimal import Decimal
from itertools import count
from urllib.error import URLError
from urllib.request import Request, urlopen


class SolanaRpcError(RuntimeError):
    """Raised when a Solana RPC request fails or returns an invalid payload."""


@dataclass(frozen=True, slots=True)
class TokenSupply:
    mint: str
    raw_amount: int
    decimals: int
    ui_amount: Decimal
    slot: int


@dataclass(frozen=True, slots=True)
class AccountData:
    address: str
    owner: str
    lamports: int
    executable: bool
    data: bytes
    slot: int


Transport = Callable[[dict[str, object]], dict[str, object]]


class SolanaRpcClient:
    """Small read-only mainnet RPC client with injectable transport for deterministic tests."""

    def __init__(
        self,
        endpoint: str = "https://api.mainnet-beta.solana.com",
        *,
        timeout: float = 10.0,
        transport: Transport | None = None,
    ) -> None:
        if not endpoint.startswith("https://"):
            raise ValueError("Solana RPC endpoint must use HTTPS")
        if timeout <= 0:
            raise ValueError("timeout must be positive")
        self.endpoint = endpoint
        self.timeout = timeout
        self._transport = transport
        self._ids = count(1)

    def _request(self, method: str, params: list[object] | None = None) -> object:
        payload: dict[str, object] = {
            "jsonrpc": "2.0",
            "id": next(self._ids),
            "method": method,
            "params": params or [],
        }
        try:
            if self._transport:
                response = self._transport(payload)
            else:
                request = Request(
                    self.endpoint,
                    data=json.dumps(payload).encode("utf-8"),
                    headers={"Content-Type": "application/json", "User-Agent": "PDA-read-only/0.1"},
                    method="POST",
                )
                with urlopen(request, timeout=self.timeout) as result:
                    response = json.loads(result.read().decode("utf-8"))
        except (URLError, TimeoutError, OSError, ValueError) as exc:
            raise SolanaRpcError(f"Solana RPC transport failed: {exc}") from exc
        if not isinstance(response, dict):
            raise SolanaRpcError("Solana RPC returned a non-object response")
        if response.get("error"):
            error = response["error"]
            raise SolanaRpcError(f"Solana RPC {method} error: {error}")
        if "result" not in response:
            raise SolanaRpcError(f"Solana RPC {method} response has no result")
        result = response["result"]
        return result

    def get_health(self) -> str:
        value = self._request("getHealth")
        if not isinstance(value, str):
            raise SolanaRpcError("Solana RPC health response is invalid")
        return value

    def get_slot(self) -> int:
        result = self._request("getSlot", [{"commitment": "confirmed"}])
        try:
            return int(result)
        except (TypeError, ValueError) as exc:
            raise SolanaRpcError("Solana RPC slot response is invalid") from exc

    def get_token_supply(self, mint: str) -> TokenSupply:
        if not mint.strip():
            raise ValueError("mint address is required")
        result = self._request("getTokenSupply", [mint, {"commitment": "confirmed"}])
        try:
            if not isinstance(result, dict):
                raise TypeError("result must be an object")
            value = result["value"]
            context = result["context"]
            raw_amount = int(value["amount"])
            decimals = int(value["decimals"])
            ui_raw = value.get("uiAmountString")
            ui_amount = Decimal(ui_raw) if ui_raw is not None else Decimal(raw_amount) / (Decimal(10) ** decimals)
            return TokenSupply(mint, raw_amount, decimals, ui_amount, int(context["slot"]))
        except (KeyError, TypeError, ValueError, ArithmeticError) as exc:
            raise SolanaRpcError("Solana RPC token supply response is invalid") from exc

    def get_account_info(self, address: str) -> AccountData | None:
        if not address.strip():
            raise ValueError("account address is required")
        result = self._request("getAccountInfo", [address, {"encoding": "base64", "commitment": "confirmed"}])
        try:
            if not isinstance(result, dict):
                raise TypeError("result must be an object")
            context = result["context"]
            value = result["value"]
            if value is None:
                return None
            encoded, encoding = value["data"]
            if encoding != "base64":
                raise SolanaRpcError("Solana RPC returned an unsupported account encoding")
            return AccountData(
                address=address,
                owner=str(value["owner"]),
                lamports=int(value["lamports"]),
                executable=bool(value["executable"]),
                data=base64.b64decode(encoded, validate=True),
                slot=int(context["slot"]),
            )
        except SolanaRpcError:
            raise
        except (KeyError, TypeError, ValueError) as exc:
            raise SolanaRpcError("Solana RPC account response is invalid") from exc
