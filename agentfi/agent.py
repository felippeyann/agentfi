"""Core agent logic for agentfi.

The Agent class provides a simple tool-calling loop:
  1. Decide which tool to use based on the user query.
  2. Call the tool.
  3. Format and return the result.

No external LLM API key is required for the rule-based dispatcher.
When an OpenAI-compatible API key is configured the agent will use an
LLM for richer natural-language responses.
"""

from __future__ import annotations

import os
import re
from typing import Any

from .tools import (
    calculate_returns,
    compare_stocks,
    get_stock_history,
    get_stock_info,
    get_stock_quote,
)

# ---------------------------------------------------------------------------
# Optional OpenAI integration
# ---------------------------------------------------------------------------
try:
    import openai as _openai

    _OPENAI_AVAILABLE = True
except ImportError:
    _LLM_MAX_ROUNDS = 5  # Maximum tool-call rounds before giving up


class Agent:
    """A financial analysis agent that dispatches queries to financial tools.

    Parameters
    ----------
    openai_api_key:
        Optional OpenAI API key.  If provided and the ``openai`` package is
        installed the agent will use GPT to generate responses.  When omitted
        the agent falls back to a rule-based dispatcher that still delivers
        structured financial data.
    model:
        OpenAI model name to use (default ``gpt-4o-mini``).
    """

    def __init__(
        self,
        openai_api_key: str | None = None,
        model: str = "gpt-4o-mini",
    ) -> None:
        self._api_key = openai_api_key or os.environ.get("OPENAI_API_KEY")
        self._model = model
        self._use_llm = bool(self._api_key and _OPENAI_AVAILABLE)

    # ------------------------------------------------------------------
    # Public interface
    # ------------------------------------------------------------------

    def run(self, query: str) -> str:
        """Process *query* and return a human-readable answer."""
        if self._use_llm:
            return self._llm_run(query)
        return self._rule_based_run(query)

    # ------------------------------------------------------------------
    # Rule-based dispatcher
    # ------------------------------------------------------------------

    def _rule_based_run(self, query: str) -> str:
        query_lower = query.lower()
        tickers = self._extract_tickers(query)

        # compare / versus
        if any(kw in query_lower for kw in ("compare", " vs ", " versus ")):
            if len(tickers) >= 2:
                period = self._extract_period(query) or "1y"
                data = compare_stocks(tickers, period=period)
                return self._format_compare(data)

        # history / chart / price over time
        if any(kw in query_lower for kw in ("history", "historical", "chart", "over")):
            if tickers:
                period = self._extract_period(query) or "1mo"
                data = get_stock_history(tickers[0], period=period)
                return self._format_history(tickers[0], data)

        # info / about / company / fundamental
        if any(kw in query_lower for kw in ("info", "about", "company", "fundamental", "sector", "industry")):
            if tickers:
                data = get_stock_info(tickers[0])
                return self._format_info(data)

        # returns / performance / gain / loss
        if any(kw in query_lower for kw in ("return", "performance", "gain", "loss", "volatility")):
            if tickers:
                period = self._extract_period(query) or "1y"
                data = calculate_returns(tickers[0], period=period)
                return self._format_returns(data)

        # default: quote
        if tickers:
            data = get_stock_quote(tickers[0])
            return self._format_quote(data)

        return (
            "I couldn't identify a stock ticker in your query. "
            "Please include a ticker symbol such as AAPL, MSFT, or TSLA."
        )

    # ------------------------------------------------------------------
    # LLM dispatcher (requires openai package + API key)
    # ------------------------------------------------------------------

    def _llm_run(self, query: str) -> str:  # pragma: no cover – requires API key
        import json

        client = _openai.OpenAI(api_key=self._api_key)

        tools = [
            {
                "type": "function",
                "function": {
                    "name": "get_stock_quote",
                    "description": "Get the latest price and basic market data for a stock ticker.",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "ticker": {"type": "string", "description": "Stock ticker symbol, e.g. AAPL"},
                        },
                        "required": ["ticker"],
                    },
                },
            },
            {
                "type": "function",
                "function": {
                    "name": "get_stock_info",
                    "description": "Get fundamental company information for a stock ticker.",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "ticker": {"type": "string"},
                        },
                        "required": ["ticker"],
                    },
                },
            },
            {
                "type": "function",
                "function": {
                    "name": "get_stock_history",
                    "description": "Get OHLCV price history for a stock ticker.",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "ticker": {"type": "string"},
                            "period": {"type": "string", "default": "1mo"},
                            "interval": {"type": "string", "default": "1d"},
                        },
                        "required": ["ticker"],
                    },
                },
            },
            {
                "type": "function",
                "function": {
                    "name": "calculate_returns",
                    "description": "Calculate return and volatility statistics for a stock.",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "ticker": {"type": "string"},
                            "period": {"type": "string", "default": "1y"},
                        },
                        "required": ["ticker"],
                    },
                },
            },
            {
                "type": "function",
                "function": {
                    "name": "compare_stocks",
                    "description": "Compare return statistics for multiple stocks.",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "tickers": {
                                "type": "array",
                                "items": {"type": "string"},
                            },
                            "period": {"type": "string", "default": "1y"},
                        },
                        "required": ["tickers"],
                    },
                },
            },
        ]

        messages = [
            {
                "role": "system",
                "content": (
                    "You are a helpful financial analysis assistant. "
                    "Use the provided tools to fetch real financial data and answer the user's question."
                ),
            },
            {"role": "user", "content": query},
        ]

        tool_map = {
            "get_stock_quote": get_stock_quote,
            "get_stock_info": get_stock_info,
            "get_stock_history": get_stock_history,
            "calculate_returns": calculate_returns,
            "compare_stocks": compare_stocks,
        }

        # Simple single-turn tool-call loop (capped at _LLM_MAX_ROUNDS)
        for _ in range(_LLM_MAX_ROUNDS):
            response = client.chat.completions.create(
                model=self._model,
                messages=messages,
                tools=tools,
                tool_choice="auto",
            )
            msg = response.choices[0].message
            if not msg.tool_calls:
                return msg.content or ""

            messages.append(msg)
            for tc in msg.tool_calls:
                fn_name = tc.function.name
                fn_args = json.loads(tc.function.arguments)
                fn = tool_map.get(fn_name)
                if fn is None:
                    result = {"error": f"Unknown tool: {fn_name}"}
                else:
                    try:
                        result = fn(**fn_args)
                    except Exception as exc:
                        result = {"error": str(exc)}
                messages.append(
                    {
                        "role": "tool",
                        "tool_call_id": tc.id,
                        "content": json.dumps(result),
                    }
                )

        return "I was unable to complete the request after multiple attempts."

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _extract_tickers(text: str) -> list[str]:
        """Naively extract uppercase ticker-like tokens from *text*."""
        # Match standalone 1-5 uppercase letter sequences that aren't common words
        common_words = {
            "I", "A", "AN", "THE", "AND", "OR", "FOR", "IN", "OF", "TO",
            "AT", "BY", "UP", "ME", "MY", "IT", "IS", "ON", "BE", "DO",
            "VS", "PE", "EPS", "YTD", "IPO",
        }
        tokens = re.findall(r"\b[A-Z]{1,5}\b", text)
        return [t for t in tokens if t not in common_words]

    @staticmethod
    def _extract_period(text: str) -> str | None:
        """Extract a yfinance period string from natural language."""
        text_lower = text.lower()
        mapping = {
            "1 day": "1d", "one day": "1d",
            "5 day": "5d", "five day": "5d",
            "1 month": "1mo", "one month": "1mo",
            "3 month": "3mo", "three month": "3mo",
            "6 month": "6mo", "six month": "6mo",
            "1 year": "1y", "one year": "1y",
            "2 year": "2y", "two year": "2y",
            "5 year": "5y", "five year": "5y",
            "ytd": "ytd",
            "max": "max",
        }
        for phrase, period in mapping.items():
            if phrase in text_lower:
                return period
        # short codes like "6mo", "1y"
        match = re.search(r"\b(\d+(?:mo|y|d|wk))\b", text_lower)
        if match:
            return match.group(1)
        return None

    # ------------------------------------------------------------------
    # Formatters
    # ------------------------------------------------------------------

    @staticmethod
    def _format_quote(data: dict[str, Any]) -> str:
        lines = [f"📈 {data['ticker']} — Latest Quote"]
        lines.append(f"  Price:      {data['currency']} {data['price']:,.2f}")
        if data.get("change") is not None:
            sign = "+" if data["change"] >= 0 else ""
            lines.append(f"  Change:     {sign}{data['change']:,.2f} ({sign}{data['change_pct']:.2f}%)")
        if data.get("volume"):
            lines.append(f"  Volume:     {data['volume']:,}")
        if data.get("market_cap"):
            lines.append(f"  Market Cap: {data['currency']} {data['market_cap']:,}")
        return "\n".join(lines)

    @staticmethod
    def _format_info(data: dict[str, Any]) -> str:
        lines = [f"🏢 {data.get('longName', data['ticker'])} ({data['ticker']})"]
        for key in ("sector", "industry", "country", "website", "fullTimeEmployees"):
            if key in data:
                lines.append(f"  {key.replace('full', 'Full ').title():22} {data[key]}")
        for key in ("trailingPE", "forwardPE", "priceToBook", "dividendYield", "beta"):
            if key in data:
                val = data[key]
                lines.append(f"  {key:22} {val:.4f}")
        if "longBusinessSummary" in data:
            summary = data["longBusinessSummary"]
            if len(summary) > 300:
                summary = summary[:297] + "..."
            lines.append(f"\n  {summary}")
        return "\n".join(lines)

    @staticmethod
    def _format_history(ticker: str, records: list[dict[str, Any]]) -> str:
        if not records:
            return f"No history data found for {ticker}."
        lines = [f"📅 {ticker} — Price History ({records[0]['date']} → {records[-1]['date']})"]
        lines.append(f"  {'Date':<12} {'Open':>10} {'High':>10} {'Low':>10} {'Close':>10} {'Volume':>14}")
        lines.append("  " + "-" * 68)
        for row in records[-20:]:  # show last 20 rows
            lines.append(
                f"  {row['date']:<12} {row['open']:>10.2f} {row['high']:>10.2f}"
                f" {row['low']:>10.2f} {row['close']:>10.2f} {row['volume']:>14,}"
            )
        if len(records) > 20:
            lines.append(f"  ... ({len(records) - 20} earlier rows omitted)")
        return "\n".join(lines)

    @staticmethod
    def _format_returns(data: dict[str, Any]) -> str:
        if "error" in data:
            return f"Error for {data['ticker']}: {data['error']}"
        sign = "+" if data["total_return_pct"] >= 0 else ""
        lines = [
            f"📊 {data['ticker']} — Returns ({data['period']})",
            f"  Start price:  {data['start_price']:,.2f}",
            f"  End price:    {data['end_price']:,.2f}",
            f"  Total return: {sign}{data['total_return_pct']:.2f}%",
            f"  Ann. vol:     {data['annualised_volatility_pct']:.2f}%",
            f"  Trading days: {data['trading_days']}",
        ]
        return "\n".join(lines)

    @staticmethod
    def _format_compare(results: list[dict[str, Any]]) -> str:
        lines = ["📊 Stock Comparison"]
        lines.append(f"  {'Ticker':<8} {'Total Return':>14} {'Ann. Vol':>10} {'Period':<8}")
        lines.append("  " + "-" * 44)
        for r in results:
            if "error" in r:
                lines.append(f"  {r['ticker']:<8}  ERROR: {r['error']}")
            else:
                sign = "+" if r["total_return_pct"] >= 0 else ""
                lines.append(
                    f"  {r['ticker']:<8} {sign}{r['total_return_pct']:>12.2f}%"
                    f" {r['annualised_volatility_pct']:>9.2f}%"
                    f" {r['period']:<8}"
                )
        return "\n".join(lines)
