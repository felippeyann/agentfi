/**
 * `pay_for_resource`: the one money-moving tool of the alpha path.
 *
 * It maps 1:1 onto `POST /v1/jobs/{id}/pay-resource` (docs/api/openapi.yaml).
 * The caller must be the job's PROVIDER agent (the API key is the identity).
 *
 * What this module deliberately does NOT do:
 *  - compute or check a budget, a policy or a price (the backend does, before signing);
 *  - retry, on any status or on a transport error/timeout;
 *  - generate a NEW paymentId after an uncertain outcome.
 *
 * What it does: pass `paymentId` through (generating one when the model gave
 * none, so a timeout can be answered with "retry with THIS id"), and hand the
 * backend's answer back to the model verbatim, plus a `guidance` line that
 * says what to do next, in particular never to retry an uncertain payment
 * with a new paymentId.
 */
import { randomUUID } from 'node:crypto';
import { AgentFiClient } from './client.js';

export const PAY_RESOURCE_TOOL_NAME = 'agentfi_pay_for_resource';

const PAYMENT_ID_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
const JOB_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_AMOUNT_PATTERN = /^\d+(\.\d{1,6})?$/;

export interface PayResourceArgs {
  job_id: string;
  url: string;
  method?: 'GET' | 'POST';
  body?: Record<string, unknown>;
  max_amount?: string;
  payment_id?: string;
}

/** JSON Schema of the arguments (used by the OpenAI and LangChain shapes). */
export const PAY_RESOURCE_PARAMETERS = {
  type: 'object',
  properties: {
    job_id: { type: 'string', description: 'ID of the ACCEPTED job whose reward budget pays for the resource. You must be its provider.' },
    url: { type: 'string', description: 'Absolute http(s) URL of the HTTP 402 (x402) resource.' },
    method: { type: 'string', enum: ['GET', 'POST'], description: 'HTTP method. Default GET.' },
    body: { type: 'object', description: 'JSON body, POST only.' },
    max_amount: { type: 'string', description: 'Your own cap for this payment in USDC, e.g. "0.50". The backend applies the lower of this and the remaining job budget.' },
    payment_id: {
      type: 'string',
      description:
        'Idempotency key, 16-128 chars of [A-Za-z0-9_-]. Omit it for a new purchase (one is generated and returned). ' +
        'To retry the SAME purchase, send the SAME payment_id: that never pays twice.',
    },
  },
  required: ['job_id', 'url'],
} as const;

export const PAY_RESOURCE_DESCRIPTION =
  "Pays an HTTP 402 (x402) resource from the remaining reward budget of a job you accepted as provider, and returns the backend's answer verbatim. " +
  'This SPENDS YOUR OWN USDC. The backend applies the job budget and your operator policy BEFORE signing anything; you cannot change them. ' +
  'Payment and delivery are separate: check `payment.status` (money) and `resource.status` / `resource.truncated` (what you received). ' +
  'The result echoes `paymentId`: keep it. If the result says PAYMENT_OUTCOME_UNKNOWN, a timeout occurred, or the status is `unknown`, `pending` or `reserved`, ' +
  'the money MAY have moved: do NOT pay again, do NOT use a new payment_id, and do not try another URL for the same purchase. ' +
  'Report the state to the user; the operator reconciles it. Retrying with the SAME payment_id only returns the recorded state and never pays twice.';

/** Next-step text per backend code. Static, no financial logic. */
const GUIDANCE: Record<string, string> = {
  PAYMENT_OUTCOME_UNKNOWN:
    'Outcome unknown: a signed authorization may have settled. Do NOT retry with a new payment_id and do not buy this resource again. The worker/operator reconciles it; the amount stays reserved against the job. Report this state to the user. Calling again with the SAME payment_id only returns the recorded state.',
  PAYMENT_IN_PROGRESS: 'The same payment_id is currently being processed. Wait, then retry with the SAME payment_id. Do not use a new one.',
  OUTSTANDING_AUTHORIZATION: 'A refused payment to the same payee still has a live authorization. Nothing was signed now. Retry the same payment_id only after `validBefore`; do not pay another way.',
  PAYMENT_REFUSED: 'The resource server refused the signed payment but may still hold the authorization until `countedUntil`; the amount stays counted. Retry the same payment_id only after `countedUntil`.',
  BUDGET_EXCEEDED: 'Refused before signing: the price is above the remaining job budget or your max_amount. Nothing was spent. Do not try to raise the budget; report to the user.',
  POLICY_VIOLATION: 'Refused before signing by the operator policy (`rule`). Nothing was spent. You cannot change the policy; report to the user.',
  PAYMENT_ID_CONFLICT: 'This payment_id was already used for a different URL or method. Do not reuse it for another purchase.',
};

const UNREADABLE_GUIDANCE =
  'The answer arrived but its body could not be read or parsed, so the payment state is UNKNOWN: it may have settled. Do NOT start a new purchase and do NOT use a new payment_id. Call again with the SAME payment_id only to read the recorded state, and report the uncertainty to the user.';
const NO_PAYMENT_FIELD_GUIDANCE =
  'The answer has no "payment" field (only an explicit null means the resource was free), so the state is uncertain. Do NOT use a new payment_id; report it to the user.';
const NOT_DELIVERED_GUIDANCE =
  'Payment and delivery differ: the payment is settled (the money is spent) but the seller answered with an HTTP error, so the resource was NOT delivered. Do NOT pay again with a new payment_id; report it to the user.';
const PARTIAL_GUIDANCE =
  'Paid, but the body was cut at the 64 KiB read limit (resource.truncated): partial delivery. Fetching it again would be a NEW purchase; report it to the user.';
const REPLAY_GUIDANCE =
  'Replay: this is the recorded state of an earlier payment with the same payment_id. Nothing was paid again and `resource` is null: the content was not re-fetched.';
const UNKNOWN_STATE_GUIDANCE =
  'payment.status is `unknown`: the money may have moved. Do not retry with a new payment_id; report the state to the user.';
const UNKNOWN_TRANSPORT_GUIDANCE =
  'No answer was received (timeout or network failure), so it is NOT known whether a payment was signed. Do NOT start a new purchase and do NOT use a new payment_id. You may call again with the SAME payment_id: the backend returns the recorded state and never pays twice. Report the uncertainty to the user.';

export interface PayResourceResult {
  /** HTTP status from the backend; null when no answer was received. */
  httpStatus: number | null;
  /** The backend body verbatim (or a client-side description when no answer arrived). */
  [key: string]: unknown;
}

/** Runs the tool. Never throws on a backend answer; never retries. */
export async function payForResource(client: AgentFiClient, args: PayResourceArgs): Promise<PayResourceResult> {
  const jobId = typeof args?.job_id === 'string' ? args.job_id : '';
  if (!JOB_ID_PATTERN.test(jobId)) return { httpStatus: null, error: 'job_id is required (letters, digits, _ or -)', code: 'ADAPTER_INVALID_INPUT' };
  if (typeof args.url !== 'string' || args.url === '') return { httpStatus: null, error: 'url is required', code: 'ADAPTER_INVALID_INPUT' };
  if (args.method !== undefined && args.method !== 'GET' && args.method !== 'POST') return { httpStatus: null, error: 'method must be GET or POST', code: 'ADAPTER_INVALID_INPUT' };
  if (args.max_amount !== undefined && !MAX_AMOUNT_PATTERN.test(args.max_amount)) return { httpStatus: null, error: 'max_amount must be a USDC decimal such as "0.50"', code: 'ADAPTER_INVALID_INPUT' };
  if (args.payment_id !== undefined && !PAYMENT_ID_PATTERN.test(args.payment_id)) return { httpStatus: null, error: 'payment_id must be 16-128 chars of [A-Za-z0-9_-]', code: 'ADAPTER_INVALID_INPUT' };

  // Idempotency plumbing, not a financial rule: a known id makes a timeout answerable.
  const paymentId = args.payment_id ?? randomUUID();
  const request = {
    url: args.url,
    method: args.method ?? 'GET',
    ...(args.body !== undefined ? { body: args.body } : {}),
    ...(args.max_amount !== undefined ? { maxAmount: args.max_amount } : {}),
    paymentId,
  };

  let res: { status: number; body: Record<string, unknown>; unreadable: boolean };
  try {
    res = await client.raw('POST', `/v1/jobs/${encodeURIComponent(jobId)}/pay-resource`, request);
  } catch (err) {
    // Single attempt only. The request may or may not have reached the backend.
    return {
      httpStatus: null,
      error: `No response from the AgentFi API (${err instanceof Error ? err.name : 'error'}).`,
      code: 'CLIENT_OUTCOME_UNKNOWN',
      paymentId,
      guidance: UNKNOWN_TRANSPORT_GUIDANCE,
    };
  }

  const body = res.body;
  const code = typeof body['code'] === 'string' ? (body['code'] as string) : undefined;
  const payment = body['payment'] as { status?: string } | null | undefined;
  const resource = body['resource'] as { status?: unknown; truncated?: unknown } | null | undefined;
  let guidance: string | undefined = code ? GUIDANCE[code] : undefined;
  if (res.unreadable) guidance = UNREADABLE_GUIDANCE;
  else if (!guidance && res.status === 200 && body['replayed'] !== true && !('payment' in body)) guidance = NO_PAYMENT_FIELD_GUIDANCE;
  if (!guidance && payment?.status === 'settled' && body['replayed'] !== true) {
    const rs = resource?.status;
    if (typeof rs !== 'number' || rs < 200 || rs >= 300) guidance = NOT_DELIVERED_GUIDANCE;
    else if (resource?.truncated === true) guidance = PARTIAL_GUIDANCE;
  }
  if (!guidance && res.status >= 500) guidance = UNKNOWN_TRANSPORT_GUIDANCE;
  if (!guidance && body['replayed'] === true) guidance = REPLAY_GUIDANCE;
  if (!guidance && payment?.status === 'unknown') guidance = UNKNOWN_STATE_GUIDANCE;

  return { httpStatus: res.status, paymentId, ...body, ...(res.unreadable ? { code: 'RESPONSE_UNREADABLE' } : {}), ...(guidance ? { guidance } : {}) };
}
