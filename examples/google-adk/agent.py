"""AgentFi x Google ADK: a payer agent that can ONLY use the payer-safe AgentFi MCP tools.

Two modes (see README.md):

  --mode stub   deterministic scripted "model" (a BaseLlm subclass), NO Gemini/LLM API, NO key,
                NO cost. It calls pay_for_resource like a well-behaved model would. Checks the
                wiring: McpToolset (stdio) -> AgentFi MCP server -> AgentFi API (use the STUB API).
  --mode real   a real Gemini model. Needs YOUR GOOGLE_API_KEY and costs tokens. NOT run or
                tested by the AgentFi maintainers.

The agent sees only PAYER_SAFE_TOOLS (`tool_filter` allowlist). The MCP server registers 35
tools, including policy-changing, job-closing and generic fund-moving ones; none of them is
exposed to this agent.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
from pathlib import Path
from typing import AsyncGenerator

from google.adk.agents import LlmAgent
from google.adk.models.base_llm import BaseLlm
from google.adk.models.llm_request import LlmRequest
from google.adk.models.llm_response import LlmResponse
from google.adk.runners import InMemoryRunner
from google.adk.tools.mcp_tool import McpToolset
from google.adk.tools.mcp_tool.mcp_session_manager import SseConnectionParams, StdioConnectionParams
from google.genai import types
from mcp import StdioServerParameters

# What a PAYER agent needs for the x402 first experience. Everything else stays out.
PAYER_SAFE_TOOLS = ["get_my_agent_profile", "get_policy", "get_job", "pay_for_resource"]

REPO_ROOT = Path(__file__).resolve().parents[2]
MCP_ENTRY = REPO_ROOT / "packages" / "mcp-server" / "dist" / "index.js"

INSTRUCTION = (
    "You are a buyer agent. You work on an ACCEPTED AgentFi job and buy x402 resources with pay_for_resource. "
    "Rules: never pay twice for the same purchase. If a result says PAYMENT_OUTCOME_UNKNOWN, the status is "
    "`unknown`, or you get no answer, do NOT retry with a new payment_id and do NOT try another URL for the same "
    "purchase: report the state to the user. Reusing the SAME payment_id is safe (it only returns the recorded "
    "state). You cannot change budgets or policy; if a purchase is refused, report it."
)


def _result_json(response) -> dict:
    """An MCP tool result as ADK hands it to the model: a dict whose text is the JSON the tool returned."""
    data = response if isinstance(response, dict) else {}
    if "content" in data and data["content"]:
        text = data["content"][0].get("text", "")
    else:
        text = data.get("result") or data.get("text") or ""
    try:
        body = json.loads(text) if isinstance(text, str) else text
    except ValueError:
        return {}
    return body if isinstance(body, dict) else {}


class ScriptedPayerModel(BaseLlm):
    """Deterministic stand-in for a model: scripted tool calls, then a final message. No network, no key."""

    model: str = "scripted-payer-stub"

    async def generate_content_async(self, llm_request: LlmRequest, stream: bool = False) -> AsyncGenerator[LlmResponse, None]:
        job = os.environ.get("AGENTFI_JOB_ID", "job_stub_1")
        seller = os.environ.get("STUB_SELLER_URL", "http://stub-seller.example")
        # (path, payment_id). The third step is the RIGHT way to react to an uncertain outcome: same id.
        plan = [("/settled", "adk-stub-settled-0000001"), ("/unknown", "adk-stub-unknown-0000001"), ("/unknown", "adk-stub-unknown-0000001")]
        responses = [p.function_response for c in llm_request.contents for p in (c.parts or []) if p.function_response]
        step = len(responses)
        if step < len(plan):
            path, pid = plan[step]
            part = types.Part(function_call=types.FunctionCall(name="pay_for_resource", args={"job_id": job, "url": seller + path, "payment_id": pid}))
            yield LlmResponse(content=types.Content(role="model", parts=[part]))
            return
        summary = []
        for r in responses:
            body = _result_json(r.response)
            summary.append(body.get("code") or (body.get("payment") or {}).get("status") or "?")
        text = f"[stub model] purchases done. Outcomes in order: {summary}. I did not retry with a new payment_id."
        yield LlmResponse(content=types.Content(role="model", parts=[types.Part(text=text)]))


async def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--mode", choices=["stub", "real"], default="stub")
    ap.add_argument("--transport", choices=["stdio", "sse"], default="stdio",
                    help="stdio spawns the MCP server from this checkout; sse connects to one you started with MCP_TRANSPORT=sse")
    ap.add_argument("--mcp-url", default="http://localhost:3002/mcp/sse")
    ap.add_argument("--prompt", default="Buy the report at http://stub-seller.example/settled for job job_stub_1.")
    args = ap.parse_args()

    api_key = os.environ.get("AGENTFI_API_KEY", "")
    if not api_key:
        print("Set AGENTFI_API_KEY (the PROVIDER agent's key; with the stub: agfi_stub_not_a_secret).", file=sys.stderr)
        return 2
    api_url = os.environ.get("AGENTFI_API_URL", "http://localhost:3000")

    if args.transport == "stdio":
        if not MCP_ENTRY.exists():
            print(f"Build the MCP server first: npm install && npm run build -w packages/mcp-server ({MCP_ENTRY})", file=sys.stderr)
            return 2
        params = StdioConnectionParams(
            server_params=StdioServerParameters(command="node", args=[str(MCP_ENTRY)], env={"AGENTFI_API_URL": api_url, "AGENTFI_API_KEY": api_key}),
            timeout=60,  # seconds; pay_for_resource can take a while
        )
    else:
        params = SseConnectionParams(url=args.mcp_url, headers={"x-api-key": api_key}, timeout=60)

    if args.mode == "real":
        if not (os.environ.get("GOOGLE_API_KEY") or os.environ.get("GOOGLE_GENAI_USE_VERTEXAI")):
            print("--mode real needs YOUR GOOGLE_API_KEY (this costs tokens; AgentFi does not run it for you).", file=sys.stderr)
            return 2
        model = os.environ.get("GEMINI_MODEL", "gemini-2.5-flash")
    else:
        model = ScriptedPayerModel()

    toolset = McpToolset(
        connection_params=params,
        tool_filter=PAYER_SAFE_TOOLS,        # allowlist: the model sees nothing else
        # require_confirmation=True,         # uncomment to make a human confirm every tool call (needs a UI that handles confirmations)
    )
    agent = LlmAgent(name="payer", model=model, instruction=INSTRUCTION, tools=[toolset])
    runner = InMemoryRunner(agent=agent, app_name="agentfi_payer")
    try:
        exposed = sorted(t.name for t in await toolset.get_tools())
        print(f"[tools exposed to the agent] {exposed}")
        assert exposed == sorted(PAYER_SAFE_TOOLS), "the filter must leave exactly the payer-safe tools"
        session = await runner.session_service.create_session(app_name="agentfi_payer", user_id="operator-demo")
        message = types.Content(role="user", parts=[types.Part(text=args.prompt)])
        async for event in runner.run_async(user_id="operator-demo", session_id=session.id, new_message=message):
            for part in (event.content.parts if event.content and event.content.parts else []):
                if part.function_call:
                    print(f"[tool call] {part.function_call.name} {json.dumps(dict(part.function_call.args or {}))}")
                elif part.function_response:
                    body = _result_json(part.function_response.response)
                    print(f"[tool result] code={body.get('code')} payment.status={(body.get('payment') or {}).get('status')} replayed={body.get('replayed')} paymentId={body.get('paymentId') or (body.get('payment') or {}).get('paymentId')}")
                elif part.text and event.is_final_response():
                    print(f"[final] {part.text}")
    finally:
        await toolset.close()
        await runner.close()
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
