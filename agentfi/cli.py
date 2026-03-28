"""Command-line interface for agentfi."""

from __future__ import annotations

import argparse
import json
import sys

from .agent import Agent
from .tools import (
    calculate_returns,
    compare_stocks,
    get_stock_history,
    get_stock_info,
    get_stock_quote,
)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="agentfi",
        description="agentfi — AI-powered financial analysis agent",
    )
    sub = parser.add_subparsers(dest="command", metavar="COMMAND")

    # ------------------------------------------------------------------
    # quote
    # ------------------------------------------------------------------
    p_quote = sub.add_parser("quote", help="Get the latest stock quote.")
    p_quote.add_argument("ticker", help="Stock ticker symbol (e.g. AAPL)")

    # ------------------------------------------------------------------
    # info
    # ------------------------------------------------------------------
    p_info = sub.add_parser("info", help="Get company information for a ticker.")
    p_info.add_argument("ticker", help="Stock ticker symbol (e.g. MSFT)")

    # ------------------------------------------------------------------
    # history
    # ------------------------------------------------------------------
    p_hist = sub.add_parser("history", help="Get OHLCV price history for a ticker.")
    p_hist.add_argument("ticker", help="Stock ticker symbol")
    p_hist.add_argument(
        "--period",
        default="1mo",
        help="Period: 1d 5d 1mo 3mo 6mo 1y 2y 5y ytd max  (default: 1mo)",
    )
    p_hist.add_argument(
        "--interval",
        default="1d",
        help="Interval: 1m 5m 15m 1h 1d 1wk 1mo  (default: 1d)",
    )

    # ------------------------------------------------------------------
    # returns
    # ------------------------------------------------------------------
    p_ret = sub.add_parser("returns", help="Calculate return statistics for a ticker.")
    p_ret.add_argument("ticker", help="Stock ticker symbol")
    p_ret.add_argument("--period", default="1y", help="Period (default: 1y)")

    # ------------------------------------------------------------------
    # compare
    # ------------------------------------------------------------------
    p_cmp = sub.add_parser("compare", help="Compare return statistics for multiple tickers.")
    p_cmp.add_argument("tickers", nargs="+", help="Two or more stock ticker symbols")
    p_cmp.add_argument("--period", default="1y", help="Period (default: 1y)")

    # ------------------------------------------------------------------
    # chat
    # ------------------------------------------------------------------
    p_chat = sub.add_parser("chat", help="Ask the agent a natural-language financial question.")
    p_chat.add_argument("query", nargs="?", help="Question to ask (reads from stdin if omitted)")
    p_chat.add_argument("--json", action="store_true", dest="as_json", help="Output raw JSON data")

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)

    if args.command is None:
        parser.print_help()
        return 0

    try:
        if args.command == "quote":
            data = get_stock_quote(args.ticker)
            agent = Agent()
            print(agent._format_quote(data))

        elif args.command == "info":
            data = get_stock_info(args.ticker)
            agent = Agent()
            print(agent._format_info(data))

        elif args.command == "history":
            data = get_stock_history(args.ticker, period=args.period, interval=args.interval)
            agent = Agent()
            print(agent._format_history(args.ticker.upper(), data))

        elif args.command == "returns":
            data = calculate_returns(args.ticker, period=args.period)
            agent = Agent()
            print(agent._format_returns(data))

        elif args.command == "compare":
            data = compare_stocks(args.tickers, period=args.period)
            agent = Agent()
            print(agent._format_compare(data))

        elif args.command == "chat":
            query = args.query
            if not query:
                print("Enter your question (Ctrl+D or Ctrl+Z to submit):")
                query = sys.stdin.read().strip()
            if not query:
                print("No query provided.", file=sys.stderr)
                return 1

            if getattr(args, "as_json", False):
                tickers = Agent._extract_tickers(query)
                if tickers:
                    data = get_stock_quote(tickers[0])
                    print(json.dumps(data, indent=2))
                else:
                    print(json.dumps({"error": "No ticker found in query"}))
            else:
                agent = Agent()
                print(agent.run(query))

    except ValueError as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1
    except Exception as exc:  # noqa: BLE001
        print(f"Unexpected error: {exc}", file=sys.stderr)
        return 1

    return 0


if __name__ == "__main__":
    sys.exit(main())
