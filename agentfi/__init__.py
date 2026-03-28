"""agentfi - An AI-powered financial analysis agent."""

from .agent import Agent
from .tools import (
    get_stock_quote,
    get_stock_history,
    get_stock_info,
    calculate_returns,
    compare_stocks,
)

__version__ = "0.1.0"
__all__ = [
    "Agent",
    "get_stock_quote",
    "get_stock_history",
    "get_stock_info",
    "calculate_returns",
    "compare_stocks",
]
