"""Tests for agentfi.tools module."""

from __future__ import annotations

import pytest


# ---------------------------------------------------------------------------
# Fixtures / helpers
# ---------------------------------------------------------------------------

def _mock_ticker(monkeypatch, ticker_info: dict, history_df=None):
    """Patch yfinance.Ticker so tests don't hit the network."""
    import pandas as pd
    import yfinance as yf

    class _FakeTicker:
        def __init__(self, symbol):
            self.info = ticker_info

        def history(self, period="1mo", interval="1d"):
            if history_df is not None:
                return history_df
            dates = pd.date_range("2024-01-01", periods=5, freq="B")
            return pd.DataFrame(
                {
                    "Open": [100.0, 101.0, 102.0, 103.0, 104.0],
                    "High": [105.0, 106.0, 107.0, 108.0, 109.0],
                    "Low": [99.0, 100.0, 101.0, 102.0, 103.0],
                    "Close": [101.0, 102.0, 103.0, 104.0, 105.0],
                    "Volume": [1_000_000, 1_100_000, 900_000, 1_050_000, 980_000],
                },
                index=dates,
            )

    monkeypatch.setattr(yf, "Ticker", _FakeTicker)


# ---------------------------------------------------------------------------
# get_stock_quote
# ---------------------------------------------------------------------------

class TestGetStockQuote:
    def test_returns_expected_keys(self, monkeypatch):
        _mock_ticker(
            monkeypatch,
            {
                "currentPrice": 150.0,
                "previousClose": 148.0,
                "volume": 5_000_000,
                "marketCap": 2_400_000_000_000,
                "currency": "USD",
            },
        )
        from agentfi.tools import get_stock_quote

        result = get_stock_quote("AAPL")
        assert result["ticker"] == "AAPL"
        assert result["price"] == 150.0
        assert result["change"] == pytest.approx(2.0, abs=0.01)
        assert result["change_pct"] == pytest.approx(1.35, abs=0.01)
        assert result["currency"] == "USD"

    def test_normalises_ticker_to_uppercase(self, monkeypatch):
        _mock_ticker(
            monkeypatch,
            {"currentPrice": 100.0, "previousClose": 100.0, "currency": "USD"},
        )
        from agentfi.tools import get_stock_quote

        result = get_stock_quote("aapl")
        assert result["ticker"] == "AAPL"

    def test_raises_when_no_price(self, monkeypatch):
        _mock_ticker(monkeypatch, {})
        from agentfi.tools import get_stock_quote

        with pytest.raises(ValueError, match="Could not retrieve price data"):
            get_stock_quote("FAKE")


# ---------------------------------------------------------------------------
# get_stock_history
# ---------------------------------------------------------------------------

class TestGetStockHistory:
    def test_returns_list_of_dicts(self, monkeypatch):
        _mock_ticker(monkeypatch, {})
        from agentfi.tools import get_stock_history

        records = get_stock_history("AAPL", period="5d")
        assert isinstance(records, list)
        assert len(records) == 5
        assert set(records[0].keys()) == {"date", "open", "high", "low", "close", "volume"}

    def test_raises_on_empty_history(self, monkeypatch):
        import pandas as pd

        _mock_ticker(monkeypatch, {}, history_df=pd.DataFrame())
        from agentfi.tools import get_stock_history

        with pytest.raises(ValueError, match="No history data found"):
            get_stock_history("FAKE")


# ---------------------------------------------------------------------------
# get_stock_info
# ---------------------------------------------------------------------------

class TestGetStockInfo:
    def test_filters_known_keys(self, monkeypatch):
        _mock_ticker(
            monkeypatch,
            {
                "shortName": "Apple Inc.",
                "longName": "Apple Inc.",
                "sector": "Technology",
                "industry": "Consumer Electronics",
                "trailingPE": 28.5,
                "unknownKey": "ignored",
            },
        )
        from agentfi.tools import get_stock_info

        info = get_stock_info("AAPL")
        assert info["ticker"] == "AAPL"
        assert info["sector"] == "Technology"
        assert "trailingPE" in info
        assert "unknownKey" not in info


# ---------------------------------------------------------------------------
# calculate_returns
# ---------------------------------------------------------------------------

class TestCalculateReturns:
    def test_total_return(self, monkeypatch):
        _mock_ticker(monkeypatch, {})
        from agentfi.tools import calculate_returns

        result = calculate_returns("AAPL", period="1y")
        # closes go 101→105, total return ≈ 3.96 %
        assert result["ticker"] == "AAPL"
        assert result["total_return_pct"] == pytest.approx(3.96, abs=0.1)
        assert result["annualised_volatility_pct"] >= 0
        assert result["trading_days"] == 4


# ---------------------------------------------------------------------------
# compare_stocks
# ---------------------------------------------------------------------------

class TestCompareStocks:
    def test_returns_sorted_by_return(self, monkeypatch):
        import pandas as pd
        import yfinance as yf

        class _FakeTicker:
            def __init__(self, symbol):
                self._symbol = symbol.upper()
                self.info = {}

            def history(self, period="1mo", interval="1d"):
                dates = pd.date_range("2024-01-01", periods=5, freq="B")
                if self._symbol == "AAA":
                    closes = [100.0, 110.0, 120.0, 130.0, 150.0]
                else:
                    closes = [100.0, 98.0, 97.0, 96.0, 95.0]
                return pd.DataFrame(
                    {
                        "Open": closes,
                        "High": closes,
                        "Low": closes,
                        "Close": closes,
                        "Volume": [1_000_000] * 5,
                    },
                    index=dates,
                )

        monkeypatch.setattr(yf, "Ticker", _FakeTicker)
        from agentfi.tools import compare_stocks

        results = compare_stocks(["BBB", "AAA"])
        assert results[0]["ticker"] == "AAA"
        assert results[1]["ticker"] == "BBB"
        assert results[0]["total_return_pct"] > results[1]["total_return_pct"]
