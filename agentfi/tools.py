"""Financial data tools for agentfi."""

from __future__ import annotations

import datetime
from typing import Any

import yfinance as yf


def get_stock_quote(ticker: str) -> dict[str, Any]:
    """Return the latest quote for *ticker*.

    Returns a dict with keys: ticker, price, change, change_pct,
    volume, market_cap, currency.
    """
    ticker = ticker.upper().strip()
    stock = yf.Ticker(ticker)
    info = stock.info

    price = info.get("currentPrice") or info.get("regularMarketPrice") or info.get("previousClose")
    prev_close = info.get("previousClose") or info.get("regularMarketPreviousClose")

    if price is None:
        raise ValueError(f"Could not retrieve price data for ticker '{ticker}'.")

    change = round(price - prev_close, 4) if prev_close else None
    change_pct = round((change / prev_close) * 100, 2) if (change is not None and prev_close) else None

    return {
        "ticker": ticker,
        "price": price,
        "change": change,
        "change_pct": change_pct,
        "volume": info.get("volume"),
        "market_cap": info.get("marketCap"),
        "currency": info.get("currency", "USD"),
    }


def get_stock_history(
    ticker: str,
    period: str = "1mo",
    interval: str = "1d",
) -> list[dict[str, Any]]:
    """Return OHLCV history for *ticker*.

    *period* can be 1d, 5d, 1mo, 3mo, 6mo, 1y, 2y, 5y, 10y, ytd, max.
    *interval* can be 1m, 2m, 5m, 15m, 30m, 60m, 90m, 1h, 1d, 5d, 1wk, 1mo, 3mo.
    """
    ticker = ticker.upper().strip()
    stock = yf.Ticker(ticker)
    hist = stock.history(period=period, interval=interval)

    if hist.empty:
        raise ValueError(f"No history data found for ticker '{ticker}'.")

    records = []
    for ts, row in hist.iterrows():
        records.append(
            {
                "date": ts.strftime("%Y-%m-%d"),
                "open": round(float(row["Open"]), 4),
                "high": round(float(row["High"]), 4),
                "low": round(float(row["Low"]), 4),
                "close": round(float(row["Close"]), 4),
                "volume": int(row["Volume"]),
            }
        )
    return records


def get_stock_info(ticker: str) -> dict[str, Any]:
    """Return fundamental information for *ticker*."""
    ticker = ticker.upper().strip()
    stock = yf.Ticker(ticker)
    info = stock.info

    keys = [
        "shortName",
        "longName",
        "sector",
        "industry",
        "country",
        "website",
        "longBusinessSummary",
        "fullTimeEmployees",
        "marketCap",
        "trailingPE",
        "forwardPE",
        "priceToBook",
        "dividendYield",
        "beta",
        "52WeekHigh",
        "52WeekLow",
        "currency",
    ]
    result: dict[str, Any] = {"ticker": ticker}
    for key in keys:
        value = info.get(key)
        if value is not None:
            result[key] = value
    return result


def calculate_returns(ticker: str, period: str = "1y") -> dict[str, Any]:
    """Calculate return statistics for *ticker* over *period*."""
    ticker = ticker.upper().strip()
    records = get_stock_history(ticker, period=period, interval="1d")

    if len(records) < 2:
        raise ValueError(f"Not enough data to calculate returns for '{ticker}'.")

    closes = [r["close"] for r in records]
    start_price = closes[0]
    end_price = closes[-1]

    total_return = round(((end_price - start_price) / start_price) * 100, 2)

    daily_returns = [
        (closes[i] - closes[i - 1]) / closes[i - 1]
        for i in range(1, len(closes))
    ]
    n = len(daily_returns)
    mean_return = sum(daily_returns) / n
    variance = sum((r - mean_return) ** 2 for r in daily_returns) / n
    std_dev = variance ** 0.5
    annualised_vol = round(std_dev * (252 ** 0.5) * 100, 2)

    return {
        "ticker": ticker,
        "period": period,
        "start_price": start_price,
        "end_price": end_price,
        "total_return_pct": total_return,
        "annualised_volatility_pct": annualised_vol,
        "trading_days": n,
    }


def compare_stocks(tickers: list[str], period: str = "1y") -> list[dict[str, Any]]:
    """Compare return statistics for a list of tickers over *period*."""
    results = []
    for ticker in tickers:
        try:
            stats = calculate_returns(ticker, period=period)
            results.append(stats)
        except ValueError as exc:
            results.append({"ticker": ticker.upper(), "error": str(exc)})
    results.sort(key=lambda x: x.get("total_return_pct", float("-inf")), reverse=True)
    return results
