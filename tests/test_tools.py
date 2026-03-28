"""Tests for agentfi.tools."""

from __future__ import annotations

import json
from unittest.mock import MagicMock, patch

import pytest

from agentfi.tools import (
    TOOL_FUNCTIONS,
    TOOLS,
    get_financials,
    get_stock_history,
    get_stock_info,
    get_stock_quote,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_fast_info(**attrs):
    mock = MagicMock()
    for k, v in attrs.items():
        setattr(mock, k, v)
    return mock


# ---------------------------------------------------------------------------
# get_stock_quote
# ---------------------------------------------------------------------------


class TestGetStockQuote:
    def test_returns_expected_keys(self):
        fast_info = _make_fast_info(
            last_price=180.0,
            previous_close=175.0,
            currency="USD",
            three_month_average_volume=50_000_000,
            market_cap=2_800_000_000_000,
        )
        with patch("agentfi.tools.yf.Ticker") as mock_ticker_cls:
            mock_ticker_cls.return_value.fast_info = fast_info
            result = get_stock_quote("AAPL")

        assert result["symbol"] == "AAPL"
        assert result["price"] == 180.0
        assert result["currency"] == "USD"
        assert result["change"] == pytest.approx(5.0, abs=1e-4)
        assert result["change_pct"] == pytest.approx(2.8571, abs=1e-3)
        assert result["volume"] == 50_000_000
        assert result["market_cap"] == 2_800_000_000_000

    def test_ticker_uppercased(self):
        fast_info = _make_fast_info(
            last_price=100.0,
            previous_close=100.0,
            currency="USD",
            three_month_average_volume=1_000_000,
            market_cap=1_000_000_000,
        )
        with patch("agentfi.tools.yf.Ticker") as mock_ticker_cls:
            mock_ticker_cls.return_value.fast_info = fast_info
            result = get_stock_quote("aapl")

        assert result["symbol"] == "AAPL"

    def test_none_price_and_prev_close(self):
        fast_info = _make_fast_info(
            last_price=None,
            previous_close=None,
            currency="USD",
            three_month_average_volume=None,
            market_cap=None,
        )
        with patch("agentfi.tools.yf.Ticker") as mock_ticker_cls:
            mock_ticker_cls.return_value.fast_info = fast_info
            result = get_stock_quote("UNKNOWN")

        assert result["change"] is None
        assert result["change_pct"] is None


# ---------------------------------------------------------------------------
# get_stock_history
# ---------------------------------------------------------------------------


class TestGetStockHistory:
    def test_returns_list_of_dicts(self):
        import pandas as pd

        data = {
            "Open": [100.0, 102.0],
            "High": [105.0, 106.0],
            "Low": [99.0, 101.0],
            "Close": [103.0, 104.0],
            "Volume": [1_000_000, 2_000_000],
        }
        index = pd.to_datetime(["2024-01-02", "2024-01-03"])
        hist_df = pd.DataFrame(data, index=index)

        with patch("agentfi.tools.yf.Ticker") as mock_ticker_cls:
            mock_ticker_cls.return_value.history.return_value = hist_df
            result = get_stock_history("AAPL", period="5d", interval="1d")

        assert len(result) == 2
        assert result[0]["open"] == pytest.approx(100.0)
        assert result[0]["close"] == pytest.approx(103.0)
        assert result[0]["volume"] == 1_000_000

    def test_empty_history(self):
        import pandas as pd

        empty_df = pd.DataFrame(
            columns=["Open", "High", "Low", "Close", "Volume"]
        )
        with patch("agentfi.tools.yf.Ticker") as mock_ticker_cls:
            mock_ticker_cls.return_value.history.return_value = empty_df
            result = get_stock_history("UNKNOWN")

        assert result == []


# ---------------------------------------------------------------------------
# get_stock_info
# ---------------------------------------------------------------------------


class TestGetStockInfo:
    def test_returns_expected_keys(self):
        mock_info = {
            "longName": "Apple Inc.",
            "sector": "Technology",
            "industry": "Consumer Electronics",
            "country": "United States",
            "website": "https://www.apple.com",
            "longBusinessSummary": "Apple designs...",
            "fullTimeEmployees": 160_000,
            "exchange": "NMS",
        }
        with patch("agentfi.tools.yf.Ticker") as mock_ticker_cls:
            mock_ticker_cls.return_value.info = mock_info
            result = get_stock_info("AAPL")

        assert result["symbol"] == "AAPL"
        assert result["name"] == "Apple Inc."
        assert result["sector"] == "Technology"
        assert result["exchange"] == "NMS"

    def test_missing_fields_return_none(self):
        with patch("agentfi.tools.yf.Ticker") as mock_ticker_cls:
            mock_ticker_cls.return_value.info = {}
            result = get_stock_info("XYZ")

        assert result["name"] is None
        assert result["sector"] is None


# ---------------------------------------------------------------------------
# get_financials
# ---------------------------------------------------------------------------


class TestGetFinancials:
    def test_returns_expected_keys(self):
        mock_info = {
            "trailingPE": 28.5,
            "trailingEps": 6.43,
            "dividendYield": 0.005,
            "beta": 1.2,
            "totalRevenue": 394_000_000_000,
            "netIncomeToCommon": 97_000_000_000,
            "debtToEquity": 185.0,
        }
        fast_info = _make_fast_info(year_high=199.62, year_low=124.17)
        with patch("agentfi.tools.yf.Ticker") as mock_ticker_cls:
            mock_ticker_cls.return_value.info = mock_info
            mock_ticker_cls.return_value.fast_info = fast_info
            result = get_financials("AAPL")

        assert result["symbol"] == "AAPL"
        assert result["pe_ratio"] == pytest.approx(28.5)
        assert result["eps"] == pytest.approx(6.43)
        assert result["52w_high"] == pytest.approx(199.62)


# ---------------------------------------------------------------------------
# TOOLS schema & TOOL_FUNCTIONS registry
# ---------------------------------------------------------------------------


class TestToolRegistry:
    def test_all_tools_in_functions(self):
        tool_names = {t["function"]["name"] for t in TOOLS}
        assert tool_names == set(TOOL_FUNCTIONS.keys())

    def test_tool_schemas_have_required_fields(self):
        for tool in TOOLS:
            assert "type" in tool
            assert "function" in tool
            func = tool["function"]
            assert "name" in func
            assert "description" in func
            assert "parameters" in func
