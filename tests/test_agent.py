"""Tests for agentfi.agent."""

from __future__ import annotations

import json
from unittest.mock import MagicMock, patch

import pytest

from agentfi.agent import Agent


def _make_response(content: str = "", finish_reason: str = "stop", tool_calls=None):
    """Build a minimal mock chat completion response."""
    message = MagicMock()
    message.content = content
    message.tool_calls = tool_calls
    message.model_dump.return_value = {
        "role": "assistant",
        "content": content,
        "tool_calls": tool_calls,
    }

    choice = MagicMock()
    choice.finish_reason = finish_reason
    choice.message = message

    response = MagicMock()
    response.choices = [choice]
    return response


def _make_tool_call(call_id: str, name: str, arguments: dict):
    tc = MagicMock()
    tc.id = call_id
    tc.function.name = name
    tc.function.arguments = json.dumps(arguments)
    return tc


class TestAgent:
    def test_chat_simple_response(self):
        agent = Agent(api_key="test-key")
        response = _make_response(content="Hello from AgentFi!")

        with patch.object(agent._client.chat.completions, "create", return_value=response):
            reply = agent.chat("Hi")

        assert reply == "Hello from AgentFi!"

    def test_chat_appends_to_history(self):
        agent = Agent(api_key="test-key")
        response = _make_response(content="Apple's price is $180.")

        with patch.object(agent._client.chat.completions, "create", return_value=response):
            agent.chat("What is the price of AAPL?")

        assert agent._history[-2]["role"] == "user"
        assert agent._history[-1]["role"] == "assistant"
        assert agent._history[-1]["content"] == "Apple's price is $180."

    def test_reset_clears_history(self):
        agent = Agent(api_key="test-key")
        agent._history = [{"role": "user", "content": "hello"}]
        agent.reset()
        assert agent._history == []

    def test_chat_with_tool_call(self):
        agent = Agent(api_key="test-key")

        tool_call = _make_tool_call("call_abc", "get_stock_quote", {"ticker": "AAPL"})
        tool_response = _make_response(finish_reason="tool_calls", tool_calls=[tool_call])
        final_response = _make_response(content="AAPL is at $180.")

        mock_quote = {"symbol": "AAPL", "price": 180.0, "currency": "USD",
                      "change": 5.0, "change_pct": 2.86, "volume": 50_000_000,
                      "market_cap": 2_800_000_000_000}

        with patch.object(
            agent._client.chat.completions, "create",
            side_effect=[tool_response, final_response]
        ):
            with patch("agentfi.agent.TOOL_FUNCTIONS", {"get_stock_quote": lambda **kw: mock_quote}):
                reply = agent.chat("What is the price of AAPL?")

        assert reply == "AAPL is at $180."

    def test_chat_unknown_tool_returns_error_in_content(self):
        agent = Agent(api_key="test-key")

        tool_call = _make_tool_call("call_xyz", "unknown_tool", {})
        tool_response = _make_response(finish_reason="tool_calls", tool_calls=[tool_call])
        final_response = _make_response(content="Sorry, I encountered an error.")

        with patch.object(
            agent._client.chat.completions, "create",
            side_effect=[tool_response, final_response]
        ):
            reply = agent.chat("Do something weird")

        assert reply == "Sorry, I encountered an error."

    def test_max_iterations_fallback(self):
        agent = Agent(api_key="test-key", max_iterations=2)

        tool_call = _make_tool_call("call_loop", "get_stock_quote", {"ticker": "AAPL"})
        looping_response = _make_response(finish_reason="tool_calls", tool_calls=[tool_call])
        mock_quote = {"symbol": "AAPL", "price": 180.0}

        with patch.object(
            agent._client.chat.completions, "create",
            return_value=looping_response,
        ):
            with patch("agentfi.agent.TOOL_FUNCTIONS", {"get_stock_quote": lambda **kw: mock_quote}):
                reply = agent.chat("Loop forever")

        assert "maximum" in reply.lower()
