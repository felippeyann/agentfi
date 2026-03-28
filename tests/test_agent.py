"""Tests for agentfi.agent module."""

from __future__ import annotations

import pytest


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _patch_tools(monkeypatch, quote=None, info=None, history=None, returns=None, compare=None):
    """Replace tool functions with simple stubs."""
    import agentfi.agent as _agent_mod

    if quote is not None:
        monkeypatch.setattr(_agent_mod, "get_stock_quote", lambda ticker: quote)
    if info is not None:
        monkeypatch.setattr(_agent_mod, "get_stock_info", lambda ticker: info)
    if history is not None:
        monkeypatch.setattr(_agent_mod, "get_stock_history", lambda ticker, period="1mo": history)
    if returns is not None:
        monkeypatch.setattr(_agent_mod, "calculate_returns", lambda ticker, period="1y": returns)
    if compare is not None:
        monkeypatch.setattr(_agent_mod, "compare_stocks", lambda tickers, period="1y": compare)


# ---------------------------------------------------------------------------
# Agent._extract_tickers
# ---------------------------------------------------------------------------

class TestExtractTickers:
    def test_extracts_single_ticker(self):
        from agentfi.agent import Agent

        assert Agent._extract_tickers("What is the price of AAPL today?") == ["AAPL"]

    def test_extracts_multiple_tickers(self):
        from agentfi.agent import Agent

        tickers = Agent._extract_tickers("Compare MSFT and GOOG")
        assert "MSFT" in tickers
        assert "GOOG" in tickers

    def test_excludes_common_words(self):
        from agentfi.agent import Agent

        tickers = Agent._extract_tickers("What IS the price of AAPL?")
        assert "IS" not in tickers
        assert "AAPL" in tickers

    def test_empty_string(self):
        from agentfi.agent import Agent

        assert Agent._extract_tickers("") == []


# ---------------------------------------------------------------------------
# Agent._extract_period
# ---------------------------------------------------------------------------

class TestExtractPeriod:
    @pytest.mark.parametrize(
        "text,expected",
        [
            ("show me 1 year history", "1y"),
            ("over the past 3 month", "3mo"),
            ("ytd performance", "ytd"),
            ("6mo chart", "6mo"),
            ("no period here", None),
        ],
    )
    def test_period_extraction(self, text, expected):
        from agentfi.agent import Agent

        assert Agent._extract_period(text) == expected


# ---------------------------------------------------------------------------
# Agent.run — rule-based dispatcher
# ---------------------------------------------------------------------------

class TestAgentRun:
    def test_quote_dispatch(self, monkeypatch):
        from agentfi.agent import Agent

        fake_quote = {
            "ticker": "AAPL",
            "price": 150.0,
            "change": 2.0,
            "change_pct": 1.35,
            "volume": 5_000_000,
            "market_cap": 2_400_000_000_000,
            "currency": "USD",
        }
        _patch_tools(monkeypatch, quote=fake_quote)
        agent = Agent()
        result = agent.run("What is the price of AAPL?")
        assert "AAPL" in result
        assert "150" in result

    def test_info_dispatch(self, monkeypatch):
        from agentfi.agent import Agent

        fake_info = {
            "ticker": "MSFT",
            "longName": "Microsoft Corporation",
            "sector": "Technology",
        }
        _patch_tools(monkeypatch, info=fake_info)
        agent = Agent()
        result = agent.run("Tell me about MSFT")
        assert "MSFT" in result or "Microsoft" in result

    def test_returns_dispatch(self, monkeypatch):
        from agentfi.agent import Agent

        fake_returns = {
            "ticker": "TSLA",
            "period": "1y",
            "start_price": 200.0,
            "end_price": 250.0,
            "total_return_pct": 25.0,
            "annualised_volatility_pct": 60.0,
            "trading_days": 252,
        }
        _patch_tools(monkeypatch, returns=fake_returns)
        agent = Agent()
        result = agent.run("What is the return of TSLA?")
        assert "TSLA" in result
        assert "25.00%" in result

    def test_compare_dispatch(self, monkeypatch):
        from agentfi.agent import Agent

        fake_compare = [
            {"ticker": "AAPL", "period": "1y", "total_return_pct": 30.0, "annualised_volatility_pct": 25.0},
            {"ticker": "MSFT", "period": "1y", "total_return_pct": 20.0, "annualised_volatility_pct": 22.0},
        ]
        _patch_tools(monkeypatch, compare=fake_compare)
        agent = Agent()
        result = agent.run("Compare AAPL vs MSFT")
        assert "AAPL" in result
        assert "MSFT" in result

    def test_no_ticker_returns_guidance(self, monkeypatch):
        from agentfi.agent import Agent

        agent = Agent()
        result = agent.run("What is the weather like today?")
        assert "ticker" in result.lower()


# ---------------------------------------------------------------------------
# Agent formatters
# ---------------------------------------------------------------------------

class TestFormatters:
    def test_format_quote_no_change(self):
        from agentfi.agent import Agent

        data = {"ticker": "XYZ", "price": 42.0, "change": None, "change_pct": None,
                "volume": None, "market_cap": None, "currency": "USD"}
        output = Agent._format_quote(data)
        assert "XYZ" in output
        assert "42.00" in output

    def test_format_returns_negative(self):
        from agentfi.agent import Agent

        data = {
            "ticker": "LOSS",
            "period": "1y",
            "start_price": 100.0,
            "end_price": 80.0,
            "total_return_pct": -20.0,
            "annualised_volatility_pct": 30.0,
            "trading_days": 252,
        }
        output = Agent._format_returns(data)
        assert "-20.00%" in output
