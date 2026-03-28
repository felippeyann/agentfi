"""AgentFi – an AI-powered financial analysis agent."""

__version__ = "0.1.0"

from .agent import Agent
from .tools import (
    get_stock_quote,
    get_stock_history,
    get_stock_info,
    get_financials,
)

__all__ = [
    "Agent",
    "get_stock_quote",
    "get_stock_history",
    "get_stock_info",
    "get_financials",
]
