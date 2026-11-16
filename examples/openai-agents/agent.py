"""AgentFi x OpenAI Agents SDK: a payer agent that can ONLY use the payer-safe AgentFi MCP tools.

Two modes (see README.md):

  --mode stub   deterministic scripted "model", NO LLM API, NO key, NO cost. It calls
                pay_for_resource exactly like a well-behaved model would. Run this to check
                the wiring: MCP stdio -> AgentFi MCP server -> AgentFi API (use the STUB API).
  --mode real   a real model through the OpenAI API. Needs YOUR OPENAI_API_KEY and costs
                tokens. NOT run or tested by the AgentFi maintainers.

The agent sees only PAYER_SAFE_TOOLS (an allowlist: `create_static_tool_filter`). The MCP
server registers 35 tools, including policy-changing, job-closing and generic fund-moving
ones; none of them is exposed to this agent.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
from pathlib import Path

from agents import Agent, Runner, set_tracing_disabled
from agents.mcp import MCPServerSse, MCPServerStdio, create_static_tool_filter

# What a PAYER agent needs for the x402 first experience. Everything else stays out.
PAYER_SAFE_TOOLS = ["get_my_agent_profile", "get_policy", "get_job", "pay_for_resource"]

REPO_ROOT = Path(__file__).resolve().parents[2]
MCP_ENTRY = REPO_ROOT / "packages" / "mcp-server" / "dist" / "index.js"

INSTRUCTIONS = (
    "You are a buyer agent. You work on an ACCEPTED AgentFi job and buy x402 resources with pay_for_resource. "
    "Rules: never pay twice for the same purchase. If a result says PAYMENT_OUTCOME_UNKNOWN, the status is "
    "`unknown`, or you get no answer, do NOT retry with a new payment_id and do NOT try another URL for the same "
    "purchase: report the state to the user. Reusing the SAME payment_id is safe (it only returns the recorded "
    "state). You cannot change budgets or policy; if a purchase is refused, report it."
)


def _tool_result_json(out) -> dict:
    """MCP tool output reaches the model as text (a JSON string, or {"type":"text","text":...}, or a list of those)."""
    if isinstance(out, list) and out:
        out = out[0]
    if isinstance(out, dict) and "text" in out:
        out = out["text"]
    elif not isinstance(out, str) and hasattr(out, "text"):
        out = out.text
    try:
        body = json.loads(out) if isinstance(out, str) else out
    except ValueError:
        return {}
    return body if isinstance(body, dict) else {}


def build_stub_model():
    """A deterministic Model: scripted tool calls, then a final message. No network, no key."""
    from agents.models.interface import Model, ModelResponse
    from agents.usage import Usage
    from openai.types.responses import ResponseFunctionToolCall, ResponseOutputMessage, ResponseOutputText

    job = os.environ.get("AGENTFI_JOB_ID", "job_stub_1")
    seller = os.environ.get("STUB_SELLER_URL", "http://stub-seller.example")
    # (path, payment_id). The third step is the RIGHT way to react to an uncertain outcome: same id.
    plan = [
        ("/settled", "oa-stub-settled-0000001"),
        ("/unknown", "oa-stub-unknown-0000001"),
        ("/unknown", "oa-stub-unknown-0000001"),
    ]

    class ScriptedPayerModel(Model):
        async def get_response(self, system_instructions, input, model_settings, tools, output_schema, handoffs, tracing, **kwargs):
            items = input if isinstance(input, list) else []
            results = [i for i in items if (i.get("type") if isinstance(i, dict) else getattr(i, "type", None)) == "function_call_output"]
            step = len(results)
            if step < len(plan):
                path, pid = plan[step]
                call = ResponseFunctionToolCall(
                    type="function_call", call_id=f"call_{step}", name="pay_for_resource",
                    arguments=json.dumps({"job_id": job, "url": seller + path, "payment_id": pid}),
                )
                return ModelResponse(output=[call], usage=Usage(), response_id=None)
            summary = []
            for r in results:
                out = r.get("output") if isinstance(r, dict) else getattr(r, "output", "")
                body = _tool_result_json(out)
                summary.append(body.get("code") or (body.get("payment") or {}).get("status") or "?")
            msg = ResponseOutputMessage(
                id="msg_stub", role="assistant", status="completed", type="message",
                content=[ResponseOutputText(type="output_text", annotations=[], text=f"[stub model] purchases done. Payment states / codes in order (money only; delivery is separate): {summary}. I did not retry with a new payment_id.")],
            )
            return ModelResponse(output=[msg], usage=Usage(), response_id=None)

        def stream_response(self, *a, **k):  # not used by Runner.run
            raise NotImplementedError("the stub model does not stream")

    return ScriptedPayerModel()


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
    tool_filter = create_static_tool_filter(allowed_tool_names=PAYER_SAFE_TOOLS)

    if args.transport == "stdio":
        if not MCP_ENTRY.exists():
            print(f"Build the MCP server first: npm install && npm run build -w packages/mcp-server ({MCP_ENTRY})", file=sys.stderr)
            return 2
        server = MCPServerStdio(
            name="agentfi",
            params={"command": "node", "args": [str(MCP_ENTRY)], "env": {"AGENTFI_API_URL": api_url, "AGENTFI_API_KEY": api_key}},
            tool_filter=tool_filter,
            client_session_timeout_seconds=60,  # pay_for_resource can take a while; the default is 5 s
        )
    else:
        server = MCPServerSse(
            name="agentfi",
            params={"url": args.mcp_url, "headers": {"x-api-key": api_key}, "timeout": 60},
            tool_filter=tool_filter,
            client_session_timeout_seconds=60,
        )

    if args.mode == "real":
        if not os.environ.get("OPENAI_API_KEY"):
            print("--mode real needs YOUR OPENAI_API_KEY (this costs tokens; AgentFi does not run it for you).", file=sys.stderr)
            return 2
        model = os.environ.get("OPENAI_MODEL", "gpt-4.1-mini")
    else:
        set_tracing_disabled(True)  # tracing would try to reach the OpenAI backend
        model = build_stub_model()

    async with server:
        exposed = [t.name for t in await server.list_tools()]
        print(f"[tools exposed to the agent] {exposed}")
        assert sorted(exposed) == sorted(PAYER_SAFE_TOOLS), "the filter must leave exactly the payer-safe tools"
        agent = Agent(name="payer", instructions=INSTRUCTIONS, model=model, mcp_servers=[server])
        result = await Runner.run(agent, args.prompt)
        for item in result.new_items:
            kind = type(item).__name__
            if kind == "ToolCallItem":
                raw = item.raw_item
                print(f"[tool call] {getattr(raw, 'name', '?')} {getattr(raw, 'arguments', '')}")
            elif kind == "ToolCallOutputItem":
                text = item.output if isinstance(item.output, str) else json.dumps(item.output)
                print(f"[tool result] {text[:300].replace(chr(10), ' ')}")
        print(f"[final] {result.final_output}")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
