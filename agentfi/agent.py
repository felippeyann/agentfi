"""AgentFi agent core: an OpenAI-powered agent with financial data tools."""

from __future__ import annotations

import json
import os
from typing import Any

from openai import OpenAI

from .tools import TOOL_FUNCTIONS, TOOLS

SYSTEM_PROMPT = (
    "You are AgentFi, an expert AI financial analyst assistant. "
    "You have access to real-time and historical stock market data via tools. "
    "Use the tools to look up accurate, up-to-date information whenever answering "
    "questions about specific stocks, companies, or financial metrics. "
    "Be concise, precise, and always cite the data you retrieve."
)


class Agent:
    """A conversational financial agent backed by OpenAI tool-calling.

    Parameters
    ----------
    api_key:
        OpenAI API key. Defaults to the ``OPENAI_API_KEY`` environment variable.
    model:
        OpenAI model name. Defaults to ``gpt-4o-mini``.
    max_iterations:
        Maximum number of tool-calling iterations per turn to prevent infinite
        loops. Defaults to 10.
    """

    def __init__(
        self,
        api_key: str | None = None,
        model: str = "gpt-4o-mini",
        max_iterations: int = 10,
    ) -> None:
        self._client = OpenAI(api_key=api_key or os.environ.get("OPENAI_API_KEY"))
        self._model = model
        self._max_iterations = max_iterations
        self._history: list[dict[str, Any]] = []

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def chat(self, user_message: str) -> str:
        """Send *user_message* to the agent and return its response.

        Conversation history is preserved between calls so the agent maintains
        context across a multi-turn session.
        """
        self._history.append({"role": "user", "content": user_message})

        messages: list[dict[str, Any]] = [
            {"role": "system", "content": SYSTEM_PROMPT},
            *self._history,
        ]

        for _ in range(self._max_iterations):
            response = self._client.chat.completions.create(
                model=self._model,
                messages=messages,
                tools=TOOLS,
                tool_choice="auto",
            )

            choice = response.choices[0]
            messages.append(choice.message.model_dump(exclude_unset=False))

            if choice.finish_reason == "tool_calls":
                tool_messages = self._handle_tool_calls(choice.message.tool_calls)
                messages.extend(tool_messages)
                continue

            # Model produced a final text response
            reply = choice.message.content or ""
            self._history.append({"role": "assistant", "content": reply})
            return reply

        # Fallback: should rarely be reached
        reply = "I reached the maximum number of tool-calling iterations."
        self._history.append({"role": "assistant", "content": reply})
        return reply

    def reset(self) -> None:
        """Clear the conversation history."""
        self._history = []

    # ------------------------------------------------------------------
    # Private helpers
    # ------------------------------------------------------------------

    def _handle_tool_calls(self, tool_calls: Any) -> list[dict[str, Any]]:
        results = []
        for call in tool_calls:
            name = call.function.name
            try:
                arguments = json.loads(call.function.arguments)
                func = TOOL_FUNCTIONS.get(name)
                if func is None:
                    output = {"error": f"Unknown tool: {name}"}
                else:
                    output = func(**arguments)
            except Exception as exc:  # noqa: BLE001
                output = {"error": str(exc)}

            results.append(
                {
                    "role": "tool",
                    "tool_call_id": call.id,
                    "content": json.dumps(output),
                }
            )
        return results
