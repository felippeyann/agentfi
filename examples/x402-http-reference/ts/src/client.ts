/**
 * Minimal AgentFi x402 client: ONE function over `fetch`, no dependencies.
 *
 *   POST {AGENTFI_API_URL}/v1/jobs/{jobId}/pay-resource      (x-api-key: the PROVIDER agent's key)
 *
 * Shapes follow docs/api/openapi.yaml (PayResourceRequest / PayResourceResponse /
 * ResourcePaymentError). The client makes exactly ONE request per call and
 * never retries: whether to ask again is the caller's decision, and the only
 * safe way to ask again about an uncertain payment is the SAME paymentId.
 *
 * Budget, policy and idempotency are enforced by the AgentFi backend. This file
 * computes nothing financial.
 */
import { randomUUID } from 'node:crypto';

export interface PayOptions {
  baseUrl: string;
  apiKey: string;
  jobId: string;
  /** The 402 resource to buy. */
  url: string;
  method?: 'GET' | 'POST';
  body?: unknown;
  /** Your own cap in USDC, e.g. "0.50". The backend uses the lower of this and the remaining job budget. */
  maxAmount?: string;
  /** Idempotency key (16-128 chars of [A-Za-z0-9_-]). Generate once per purchase and REUSE it on every retry of that purchase. */
  paymentId?: string;
  timeoutMs?: number;
}

export type Outcome =
  | 'settled' // 200, payment.status settled, resource 2xx and whole: paid AND delivered
  | 'settled_not_delivered' // 200, settled, but the seller answered HTTP >= 400 (or a non-2xx): paid, NOT delivered
  | 'settled_partial_delivery' // 200, settled, resource.truncated: paid, but only the first 64 KiB arrived
  | 'replayed' // 200, replayed: recorded state of an earlier call, nothing paid again, resource null
  | 'free_resource' // 200 with an explicit payment: null: the resource never asked for payment
  | 'budget_exceeded' // 402 BUDGET_EXCEEDED, nothing signed
  | 'policy_violation' // 403 POLICY_VIOLATION, nothing signed
  | 'payment_in_progress' // 409 PAYMENT_IN_PROGRESS
  | 'outstanding_authorization' // 409 OUTSTANDING_AUTHORIZATION, nothing signed now
  | 'refused_after_signing' // 402 PAYMENT_REFUSED
  | 'outcome_unknown' // 502 PAYMENT_OUTCOME_UNKNOWN, 200 with payment.status unknown, or an answer whose body could not be read/parsed
  | 'no_answer' // timeout / network failure: unknown whether the backend acted
  | 'error'; // any other documented refusal (JOB_NOT_ACTIVE, NOT_PROVIDER, INVALID_URL, ...)

export interface PayResult {
  outcome: Outcome;
  httpStatus: number | null;
  paymentId: string;
  /** Backend body, verbatim (null when no answer arrived). */
  body: Record<string, any> | null;
  /** Safe to call again with a NEW paymentId (a new purchase)? Only when nothing could have been signed. */
  newPaymentIdAllowed: boolean;
  /** One line telling the caller what to do next. */
  advice: string;
}

const UNKNOWN_ADVICE =
  'Do not retry with a new paymentId. The amount may have moved and stays reserved against the job; the worker reconciles it. Check status (re-ask with the SAME paymentId, or ask the operator for `x402:ops status`).';

export async function payResource(opts: PayOptions): Promise<PayResult> {
  const paymentId = opts.paymentId ?? randomUUID();
  const payload = {
    url: opts.url,
    method: opts.method ?? 'GET',
    ...(opts.body !== undefined ? { body: opts.body } : {}),
    ...(opts.maxAmount !== undefined ? { maxAmount: opts.maxAmount } : {}),
    paymentId,
  };

  let status: number;
  let body: Record<string, any>;
  let unreadable = false;
  try {
    const res = await fetch(`${opts.baseUrl.replace(/\/+$/, '')}/v1/jobs/${encodeURIComponent(opts.jobId)}/pay-resource`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': opts.apiKey },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 60_000),
    });
    status = res.status;
    // The headers arrived, so the backend acted. A body that cannot be read (connection cut, timeout
    // mid-body, invalid JSON) is NOT an empty answer: the payment may have settled.
    try {
      const parsed = await res.json();
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
      body = parsed as Record<string, any>;
    } catch {
      body = {};
      unreadable = true;
    }
  } catch {
    return {
      outcome: 'no_answer', httpStatus: null, paymentId, body: null, newPaymentIdAllowed: false,
      advice: 'No answer (timeout or network). Unknown whether a payment was signed. Re-ask with the SAME paymentId (the backend replays the recorded state, never pays twice); never use a new one.',
    };
  }

  if (unreadable) {
    return {
      outcome: 'outcome_unknown', httpStatus: status, paymentId, body: null, newPaymentIdAllowed: false,
      advice: `The answer (HTTP ${status}) arrived but its body could not be read or parsed, so the payment state is unknown: it may have settled. ${UNKNOWN_ADVICE}`,
    };
  }
  const code = body['code'] as string | undefined;
  const result = (outcome: Outcome, newPaymentIdAllowed: boolean, advice: string): PayResult =>
    ({ outcome, httpStatus: status, paymentId, body, newPaymentIdAllowed, advice });

  if (status === 200) {
    const payment = body['payment'];
    if (body['replayed'] === true) {
      return payment?.status === 'unknown'
        ? result('outcome_unknown', false, UNKNOWN_ADVICE)
        : result('replayed', false, 'Recorded state of the earlier payment with this paymentId; nothing was paid again and the content was not re-fetched (resource is null).');
    }
    if (payment === undefined) return result('outcome_unknown', false, `The 200 answer has no "payment" field (only an explicit null means free). Treat it as uncertain: ${UNKNOWN_ADVICE}`);
    if (payment === null) return result('free_resource', true, 'The resource did not ask for payment; nothing was spent.');
    if (payment.status === 'unknown') return result('outcome_unknown', false, UNKNOWN_ADVICE);
    if (payment.status === 'settled') {
      // Payment and delivery are judged separately.
      const resource = body['resource'];
      const rs = resource?.status;
      if (typeof rs !== 'number' || rs < 200 || rs >= 300) {
        return result('settled_not_delivered', false, `Paid (settled), but the seller answered ${rs ?? 'nothing usable'}: the resource was NOT delivered. The money is spent: do not pay again with a new paymentId. Take it up with the seller or the operator.`);
      }
      return resource.truncated === true
        ? result('settled_partial_delivery', false, 'Paid, but the body was cut at the 64 KiB read limit. Fetching it again would be a NEW purchase: take it up with the seller or the operator.')
        : result('settled', false, 'Paid and delivered (resource 2xx, not truncated). Keep the paymentId for your records.');
    }
    return result('outcome_unknown', false, `Unexpected payment.status "${payment.status}". Treat it as uncertain: ${UNKNOWN_ADVICE}`);
  }

  switch (code) {
    case 'BUDGET_EXCEEDED':
      return result('budget_exceeded', true, 'Nothing was signed. The price is above the remaining job budget or your maxAmount (see price/remaining/cap, base units). Do not try to raise the budget from the payer side.');
    case 'POLICY_VIOLATION':
      return result('policy_violation', true, `Nothing was signed. The operator policy refused it (rule: ${body['rule']}). The payer cannot change it.`);
    case 'PAYMENT_IN_PROGRESS':
      return result('payment_in_progress', false, 'The same paymentId is being processed. Wait, then re-ask with the SAME paymentId.');
    case 'OUTSTANDING_AUTHORIZATION':
      return result('outstanding_authorization', false, `A refused payment to the same payee still has a live authorization (validBefore ${body['validBefore']}). Nothing was signed now. Re-ask after that time.`);
    case 'PAYMENT_REFUSED':
      return result('refused_after_signing', false, `The server refused the signed payment but may still hold the authorization until ${body['countedUntil']}; the amount stays counted. Re-ask with the SAME paymentId after that time.`);
    case 'PAYMENT_OUTCOME_UNKNOWN':
      return result('outcome_unknown', false, UNKNOWN_ADVICE);
    default:
      // PAYMENT_FAILED (502, before signing), JOB_NOT_ACTIVE, NOT_PROVIDER, INVALID_URL, ... : report, do not guess.
      return result('error', false, `Documented refusal ${code ?? '(no code)'} (HTTP ${status}). See docs/api/openapi.yaml. If it is a 5xx, treat it as uncertain and re-ask with the SAME paymentId only.`);
  }
}
