import base64
from decimal import Decimal

import pytest

from pda.solana_rpc import SolanaRpcClient, SolanaRpcError


def test_health_and_slot_use_native_rpc_scalar_results() -> None:
    def transport(payload: dict[str, object]) -> dict[str, object]:
        return {"result": "ok" if payload["method"] == "getHealth" else 456}

    client = SolanaRpcClient(transport=transport)
    assert client.get_health() == "ok"
    assert client.get_slot() == 456


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


def test_token_account_balance_and_multiple_account_batch() -> None:
    raw = b"vault-state"
    encoded = base64.b64encode(raw).decode()

    def transport(payload: dict[str, object]) -> dict[str, object]:
        if payload["method"] == "getTokenAccountBalance":
            return {"result": {"context": {"slot": 101}, "value": {
                "amount": "2500000", "decimals": 6, "uiAmountString": "2.5"
            }}}
        assert payload["method"] == "getMultipleAccounts"
        return {"result": {"context": {"slot": 102}, "value": [
            {"owner": "TokenProgram", "lamports": 10, "executable": False, "data": [encoded, "base64"]},
            None,
        ]}}

    client = SolanaRpcClient(transport=transport)
    balance = client.get_token_account_balance("VaultAddress")
    assert balance.ui_amount == Decimal("2.5")
    assert balance.slot == 101
    accounts = client.get_multiple_accounts(["VaultAddress", "MissingAddress"])
    assert accounts[0] is not None and accounts[0].data == raw
    assert accounts[1] is None


def test_multiple_accounts_rejects_unbounded_requests() -> None:
    client = SolanaRpcClient(transport=lambda _: {"result": {}})
    with pytest.raises(ValueError, match="1 and 100"):
        client.get_multiple_accounts([])
    with pytest.raises(ValueError, match="1 and 100"):
        client.get_multiple_accounts(["A"] * 101)
