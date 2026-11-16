"""Minimal AgentFi x402 client: ONE function over urllib, standard library only (Python >= 3.9).

    POST {AGENTFI_API_URL}/v1/jobs/{jobId}/pay-resource      (x-api-key: the PROVIDER agent's key)

Shapes follow docs/api/openapi.yaml (PayResourceRequest / PayResourceResponse /
ResourcePaymentError). One request per call, never a retry: whether to ask
again is the caller's decision, and the only safe way to ask again about an
uncertain payment is the SAME payment_id.

Budget, policy and idempotency are enforced by the AgentFi backend; nothing
financial is computed here.

CLI:
    AGENTFI_API_URL=http://localhost:3000 AGENTFI_API_KEY=<provider key> \
    python agentfi_pay.py <job_id> <resource_url> [--max-amount 0.50] [--payment-id ID]
    python agentfi_pay.py --scenarios <job_id> <stub_base_url>     # STUB API only
"""
from __future__ import annotations

import json
import os
import sys
import uuid
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from typing import Any, Optional

UNKNOWN_ADVICE = (
    "Do not retry with a new payment_id. The amount may have moved and stays reserved against "
    "the job; the worker reconciles it. Check status (re-ask with the SAME payment_id, or ask "
    "the operator for `x402:ops status`)."
)


@dataclass
class PayResult:
    outcome: str  # see pay_resource()
    http_status: Optional[int]
    payment_id: str
    body: Optional[dict]
    new_payment_id_allowed: bool
    advice: str


def pay_resource(
    base_url: str,
    api_key: str,
    job_id: str,
    url: str,
    *,
    method: str = "GET",
    body: Any = None,
    max_amount: Optional[str] = None,
    payment_id: Optional[str] = None,
    timeout: float = 60.0,
) -> PayResult:
    """Outcomes: settled, settled_partial_delivery, replayed, free_resource, budget_exceeded,
    policy_violation, payment_in_progress, outstanding_authorization, refused_after_signing,
    outcome_unknown, no_answer, error."""
    payment_id = payment_id or str(uuid.uuid4())
    payload: dict = {"url": url, "method": method, "paymentId": payment_id}
    if body is not None:
        payload["body"] = body
    if max_amount is not None:
        payload["maxAmount"] = max_amount

    req = urllib.request.Request(
        f"{base_url.rstrip('/')}/v1/jobs/{urllib.parse.quote(job_id, safe='')}/pay-resource",
        data=json.dumps(payload).encode(),
        method="POST",
        headers={"content-type": "application/json", "x-api-key": api_key},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            status, raw = resp.status, resp.read()
    except urllib.error.HTTPError as e:  # 4xx / 5xx still carry the JSON body
        status, raw = e.code, e.read()
    except (urllib.error.URLError, TimeoutError, OSError):
        return PayResult(
            "no_answer", None, payment_id, None, False,
            "No answer (timeout or network). Unknown whether a payment was signed. Re-ask with the "
            "SAME payment_id (the backend replays the recorded state, never pays twice); never use a new one.",
        )
    try:
        data = json.loads(raw or b"{}")
    except ValueError:
        data = {}

    def result(outcome: str, new_id: bool, advice: str) -> PayResult:
        return PayResult(outcome, status, payment_id, data, new_id, advice)

    code = data.get("code")
    if status == 200:
        payment = data.get("payment")
        if data.get("replayed") is True:
            if (payment or {}).get("status") == "unknown":
                return result("outcome_unknown", False, UNKNOWN_ADVICE)
            return result("replayed", False, "Recorded state of the earlier payment with this payment_id; nothing was paid again and the content was not re-fetched (resource is null).")
        if payment is None:
            return result("free_resource", True, "The resource did not ask for payment; nothing was spent.")
        if payment.get("status") == "unknown":
            return result("outcome_unknown", False, UNKNOWN_ADVICE)
        if payment.get("status") == "settled":
            if (data.get("resource") or {}).get("truncated") is True:
                return result("settled_partial_delivery", False, "Paid, but the body was cut at the 64 KiB read limit. Fetching it again would be a NEW purchase: take it up with the seller or the operator.")
            return result("settled", False, "Paid and delivered. Keep the payment_id for your records.")
        return result("outcome_unknown", False, f"Unexpected payment.status {payment.get('status')!r}. Treat it as uncertain: {UNKNOWN_ADVICE}")

    if code == "BUDGET_EXCEEDED":
        return result("budget_exceeded", True, "Nothing was signed. The price is above the remaining job budget or your max_amount (see price/remaining/cap, base units). Do not try to raise the budget from the payer side.")
    if code == "POLICY_VIOLATION":
        return result("policy_violation", True, f"Nothing was signed. The operator policy refused it (rule: {data.get('rule')}). The payer cannot change it.")
    if code == "PAYMENT_IN_PROGRESS":
        return result("payment_in_progress", False, "The same payment_id is being processed. Wait, then re-ask with the SAME payment_id.")
    if code == "OUTSTANDING_AUTHORIZATION":
        return result("outstanding_authorization", False, f"A refused payment to the same payee still has a live authorization (validBefore {data.get('validBefore')}). Nothing was signed now. Re-ask after that time.")
    if code == "PAYMENT_REFUSED":
        return result("refused_after_signing", False, f"The server refused the signed payment but may still hold the authorization until {data.get('countedUntil')}; the amount stays counted. Re-ask with the SAME payment_id after that time.")
    if code == "PAYMENT_OUTCOME_UNKNOWN":
        return result("outcome_unknown", False, UNKNOWN_ADVICE)
    return result("error", False, f"Documented refusal {code or '(no code)'} (HTTP {status}). See docs/api/openapi.yaml. If it is a 5xx, treat it as uncertain and re-ask with the SAME payment_id only.")


def show(label: str, r: PayResult) -> None:
    body = r.body or {}
    p, res = body.get("payment"), body.get("resource")
    print(f"\n== {label}")
    print(f"   outcome        : {r.outcome}   (HTTP {r.http_status if r.http_status is not None else 'no answer'})")
    print(f"   payment_id     : {r.payment_id}")
    if p:
        print(f"   payment.status : {p.get('status')}   amount {p.get('amount')} base units")
    if res:
        print(f"   delivery       : resource.status {res.get('status')}, truncated={res.get('truncated') is True}")
    if body.get("remainingBudget"):
        print(f"   remaining      : {body['remainingBudget'].get('remainingFormatted')} USDC")
    if body.get("code"):
        print(f"   code           : {body['code']}")
    print(f"   new id allowed : {r.new_payment_id_allowed}")
    print(f"   advice         : {r.advice}")


def main(argv: list[str]) -> int:
    base = os.environ.get("AGENTFI_API_URL", "http://localhost:3000")
    key = os.environ.get("AGENTFI_API_KEY", "")
    if not key:
        print("Set AGENTFI_API_KEY to the PROVIDER agent key of the job (it is the identity; never share it).", file=sys.stderr)
        return 2

    def flag(name: str) -> Optional[str]:
        return argv[argv.index(name) + 1] if name in argv else None

    if argv and argv[0] == "--scenarios":
        job_id, stub = argv[1], argv[2].rstrip("/")
        pid = lambda n: f"py-example-{n}-0000000001"  # noqa: E731  fixed ids make the demo repeatable
        for name in ["settled", "partial", "free", "budget", "policy", "in-progress", "outstanding", "refused", "unknown"]:
            show(f"/{name}", pay_resource(base, key, job_id, f"{stub}/{name}", payment_id=pid(name)))
        show("/unknown again, SAME payment_id (replay: the recorded state, nothing paid twice)",
             pay_resource(base, key, job_id, f"{stub}/unknown", payment_id=pid("unknown")))
        show("/settled again, SAME payment_id", pay_resource(base, key, job_id, f"{stub}/settled", payment_id=pid("settled")))
        return 0

    if len(argv) < 2:
        print("usage: python agentfi_pay.py <job_id> <resource_url> [--max-amount 0.50] [--payment-id ID]", file=sys.stderr)
        return 2
    show(argv[1], pay_resource(base, key, argv[0], argv[1], max_amount=flag("--max-amount"), payment_id=flag("--payment-id")))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
