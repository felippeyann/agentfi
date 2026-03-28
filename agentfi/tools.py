"""Financial data tools powered by yfinance."""

from __future__ import annotations

import json
from typing import Any

import yfinance as yf


def get_stock_quote(ticker: str) -> dict[str, Any]:
    """Return the latest quote for *ticker*.

    Returns a dict with keys: symbol, price, currency, change, change_pct,
    volume, market_cap.
    """
    t = yf.Ticker(ticker)
    info = t.fast_info

    price = getattr(info, "last_price", None)
    prev_close = getattr(info, "previous_close", None)
    change = (price - prev_close) if price is not None and prev_close is not None else None
    change_pct = (change / prev_close * 100) if change is not None and prev_close else None

    return {
        "symbol": ticker.upper(),
        "price": price,
        "currency": getattr(info, "currency", None),
        "change": round(change, 4) if change is not None else None,
        "change_pct": round(change_pct, 4) if change_pct is not None else None,
        "volume": getattr(info, "three_month_average_volume", None),
        "market_cap": getattr(info, "market_cap", None),
    }


def get_stock_history(ticker: str, period: str = "1mo", interval: str = "1d") -> list[dict[str, Any]]:
    """Return OHLCV history for *ticker*.

    Parameters
    ----------
    ticker:
        Stock ticker symbol, e.g. "AAPL".
    period:
        How far back to fetch data. Valid values: 1d, 5d, 1mo, 3mo, 6mo,
        1y, 2y, 5y, 10y, ytd, max.
    interval:
        Bar interval. Valid values: 1m, 2m, 5m, 15m, 30m, 60m, 90m, 1h,
        1d, 5d, 1wk, 1mo, 3mo.

    Returns a list of dicts with keys: date, open, high, low, close, volume.
    """
    t = yf.Ticker(ticker)
    hist = t.history(period=period, interval=interval)
    hist.index = hist.index.astype(str)
    records = []
    for date, row in hist.iterrows():
        records.append(
            {
                "date": str(date),
                "open": round(row["Open"], 4),
                "high": round(row["High"], 4),
                "low": round(row["Low"], 4),
                "close": round(row["Close"], 4),
                "volume": int(row["Volume"]),
            }
        )
    return records


def get_stock_info(ticker: str) -> dict[str, Any]:
    """Return descriptive information about *ticker*.

    Returns a dict with company name, sector, industry, country, website,
    description, employees, and exchange.
    """
    t = yf.Ticker(ticker)
    info = t.info
    return {
        "symbol": ticker.upper(),
        "name": info.get("longName") or info.get("shortName"),
        "sector": info.get("sector"),
        "industry": info.get("industry"),
        "country": info.get("country"),
        "website": info.get("website"),
        "description": info.get("longBusinessSummary"),
        "employees": info.get("fullTimeEmployees"),
        "exchange": info.get("exchange"),
    }


def get_financials(ticker: str) -> dict[str, Any]:
    """Return key financial metrics for *ticker*.

    Returns a dict with pe_ratio, eps, dividend_yield, beta, 52w_high,
    52w_low, revenue, net_income, debt_to_equity.
    """
    t = yf.Ticker(ticker)
    info = t.info
    fast = t.fast_info

    return {
        "symbol": ticker.upper(),
        "pe_ratio": info.get("trailingPE"),
        "eps": info.get("trailingEps"),
        "dividend_yield": info.get("dividendYield"),
        "beta": info.get("beta"),
        "52w_high": getattr(fast, "year_high", None),
        "52w_low": getattr(fast, "year_low", None),
        "revenue": info.get("totalRevenue"),
        "net_income": info.get("netIncomeToCommon"),
        "debt_to_equity": info.get("debtToEquity"),
    }


# ---------------------------------------------------------------------------
# Tool definitions in OpenAI function-calling schema
# ---------------------------------------------------------------------------

TOOLS: list[dict[str, Any]] = [
    {
        "type": "function",
        "function": {
            "name": "get_stock_quote",
            "description": (
                "Get the latest stock quote (price, change, volume, market cap) "
                "for a given ticker symbol."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "ticker": {
                        "type": "string",
                        "description": "Stock ticker symbol, e.g. AAPL, TSLA, MSFT.",
                    },
                },
                "required": ["ticker"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_stock_history",
            "description": (
                "Retrieve historical OHLCV (open/high/low/close/volume) price data "
                "for a given ticker symbol."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "ticker": {
                        "type": "string",
                        "description": "Stock ticker symbol.",
                    },
                    "period": {
                        "type": "string",
                        "description": (
                            "How far back to fetch data. "
                            "Options: 1d, 5d, 1mo, 3mo, 6mo, 1y, 2y, 5y, 10y, ytd, max. "
                            "Default: 1mo."
                        ),
                        "default": "1mo",
                    },
                    "interval": {
                        "type": "string",
                        "description": (
                            "Bar interval. "
                            "Options: 1m, 2m, 5m, 15m, 30m, 60m, 90m, 1h, "
                            "1d, 5d, 1wk, 1mo, 3mo. Default: 1d."
                        ),
                        "default": "1d",
                    },
                },
                "required": ["ticker"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_stock_info",
            "description": (
                "Get descriptive information about a company (sector, industry, "
                "country, description, employee count, etc.) for a given ticker."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "ticker": {
                        "type": "string",
                        "description": "Stock ticker symbol.",
                    },
                },
                "required": ["ticker"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_financials",
            "description": (
                "Get key financial metrics (P/E ratio, EPS, dividend yield, beta, "
                "52-week high/low, revenue, net income, debt-to-equity) for a given ticker."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "ticker": {
                        "type": "string",
                        "description": "Stock ticker symbol.",
                    },
                },
                "required": ["ticker"],
            },
        },
    },
]


# Mapping of tool name -> callable used by the agent
TOOL_FUNCTIONS: dict[str, Any] = {
    "get_stock_quote": get_stock_quote,
    "get_stock_history": get_stock_history,
    "get_stock_info": get_stock_info,
    "get_financials": get_financials,
}
