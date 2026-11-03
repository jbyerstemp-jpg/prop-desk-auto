import base64
from decimal import Decimal

import pytest

from pda.solana_rpc import SolanaRpcClient, SolanaRpcError


def test_token_supply_parses_exact_ui_amount_and_slot() -> None:
    def transport(payload: dict[str, object]) -> dict[str, object]:
        assert payload["method"] == "getTokenSupply"
        return {"result": {"context": {"slot": 123}, "value": {
            "amount": "1234500", "decimals": 6, "uiAmountString": "1.2345"
        }}}

    supply = SolanaRpcClient(transport=transport).get_token_supply("MintAddress")
    assert supply.raw_amount == 1_234_500
    assert supply.decimals == 6
    assert supply.ui_amount == Decimal("1.2345")
    assert supply.slot == 123


def test_account_info_decodes_base64_without_signing() -> None:
    raw = b"read-only-account-data"

    def transport(payload: dict[str, object]) -> dict[str, object]:
        assert payload["method"] == "getAccountInfo"
        assert payload["params"][1]["encoding"] == "base64"  # type: ignore[index]
        return {"result": {"context": {"slot": 99}, "value": {
            "owner": "ProgramAddress", "lamports": 42, "executable": False,
            "data": [base64.b64encode(raw).decode(), "base64"],
        }}}

    account = SolanaRpcClient(transport=transport).get_account_info("AccountAddress")
    assert account is not None
    assert account.data == raw
    assert account.lamports == 42
    assert account.slot == 99


def test_missing_account_returns_none() -> None:
    client = SolanaRpcClient(transport=lambda _: {"result": {"context": {"slot": 1}, "value": None}})
    assert client.get_account_info("MissingAddress") is None


def test_rpc_errors_fail_closed() -> None:
    client = SolanaRpcClient(transport=lambda _: {"error": {"code": -32005, "message": "rate limited"}})
    with pytest.raises(SolanaRpcError, match="rate limited"):
        client.get_slot()


def test_endpoint_must_be_https_and_no_write_api_is_exposed() -> None:
    with pytest.raises(ValueError, match="HTTPS"):
        SolanaRpcClient("http://example.com")
    client = SolanaRpcClient(transport=lambda _: {"result": "ok"})
    assert not hasattr(client, "send_transaction")
    assert not hasattr(client, "sign_transaction")
