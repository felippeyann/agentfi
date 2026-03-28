"""Tests for agentfi CLI."""

from __future__ import annotations

import pytest


def _patch_quote(monkeypatch):
    import agentfi.cli as cli_mod

    monkeypatch.setattr(
        cli_mod,
        "get_stock_quote",
        lambda ticker: {
            "ticker": ticker.upper(),
            "price": 150.0,
            "change": 2.0,
            "change_pct": 1.35,
            "volume": 5_000_000,
            "market_cap": 2_400_000_000_000,
            "currency": "USD",
        },
    )


class TestCLI:
    def test_no_args_exits_0(self):
        from agentfi.cli import main

        assert main([]) == 0

    def test_quote_command(self, monkeypatch, capsys):
        _patch_quote(monkeypatch)
        from agentfi.cli import main

        rc = main(["quote", "AAPL"])
        assert rc == 0
        out = capsys.readouterr().out
        assert "AAPL" in out
        assert "150" in out

    def test_quote_error_returns_1(self, monkeypatch):
        import agentfi.cli as cli_mod

        monkeypatch.setattr(
            cli_mod,
            "get_stock_quote",
            lambda ticker: (_ for _ in ()).throw(ValueError("bad ticker")),
        )
        from agentfi.cli import main

        assert main(["quote", "FAKE"]) == 1

    def test_chat_no_query_reads_stdin(self, monkeypatch, capsys):
        import io
        import sys

        import agentfi.agent as _agent_mod

        monkeypatch.setattr(_agent_mod, "get_stock_quote", lambda ticker: {
            "ticker": "AAPL",
            "price": 150.0,
            "change": 0.0,
            "change_pct": 0.0,
            "volume": 1_000_000,
            "market_cap": None,
            "currency": "USD",
        })
        monkeypatch.setattr(sys, "stdin", io.StringIO("What is the price of AAPL?"))

        from agentfi.cli import main

        rc = main(["chat"])
        assert rc == 0
        out = capsys.readouterr().out
        assert "AAPL" in out
