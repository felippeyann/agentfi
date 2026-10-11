"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, Undo2, Gavel, Ban, Scale } from "lucide-react";

/**
 * Operator review of an ERC-8183 job (C3d, decision D9): a requester's
 * contest, a CANCELLED/FAILED job whose deliverable is Submitted on-chain, or
 * a settlement that keeps failing. Same pattern as JobReconcileActions: pick
 * an action, write a note, confirm. The evaluator then settles on-chain.
 */
type Decision = "pay" | "refund" | "quality-rejected" | "payout-blocked";

interface Props {
  jobId: string;
  status: string;
  onChainStatus: string | null;
  contestReason?: string | null;
  expiresAt?: string | null;
}

const ACTIONS: Record<Decision, { label: string; effect: string; body: Record<string, string> }> = {
  pay: {
    label: "Pay provider",
    effect: "complete — the provider is paid, ERC-8004 rating 100",
    body: { decision: "pay" },
  },
  refund: {
    label: "Refund requester",
    effect: "reject — the requester is refunded in full, no rating",
    body: { decision: "refund" },
  },
  "quality-rejected": {
    label: "Refund + quality verdict",
    effect: "reject with the quality verdict — refund AND an ERC-8004 rating of 0 for the provider",
    body: { decision: "refund", verdict: "quality-rejected" },
  },
  "payout-blocked": {
    label: "Payout blocked",
    effect: "reject (payout-blocked) — the provider cannot receive USDC; refund, no rating",
    body: { decision: "payout-blocked" },
  },
};

export function JobReviewActions({ jobId, status, onChainStatus, contestReason, expiresAt }: Props) {
  const router = useRouter();
  const [pending, setPending] = useState<Decision | null>(null);
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (!pending || note.trim().length < 3) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/jobs/${jobId}/resolve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...ACTIONS[pending].body, note: note.trim() }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(body.message ?? body.error ?? "Resolve failed");
      }
      setPending(null);
      setNote("");
      router.refresh();
    } catch (err) {
      setError((err as Error)?.message ?? "Unknown error");
    } finally {
      setSubmitting(false);
    }
  }

  const contested = onChainStatus === "CONTESTED";
  return (
    <div className="rounded-xl border border-brand-purple/30 bg-brand-purple/5 p-6">
      <div className="flex items-start gap-3 mb-4">
        <Scale className="size-5 text-brand-purple shrink-0 mt-0.5" />
        <div>
          <h3 className="text-white font-semibold text-sm">Operator review (escrow)</h3>
          <p className="text-gray-400 text-xs mt-1 leading-relaxed">
            {contested ? (
              <>The requester contested the deliverable{contestReason ? <>: <em>&ldquo;{contestReason}&rdquo;</em></> : null}. </>
            ) : (
              <>This job is <code className="font-mono">{status}</code> while its deliverable is <code className="font-mono">{onChainStatus}</code> on-chain. </>
            )}
            Nothing is settled automatically. Decide before{" "}
            <strong>{expiresAt ? new Date(expiresAt).toLocaleString() : "expiresAt"}</strong>: after it anyone can
            claim the refund and the job ends refunded without feedback. Every decision is recorded with your name and note.
          </p>
        </div>
      </div>

      {pending === null && (
        <div className="flex flex-wrap gap-3">
          <button type="button" onClick={() => setPending("pay")} className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-brand-green/10 border border-brand-green/30 text-brand-green hover:bg-brand-green/20 transition-colors text-sm font-medium">
            <CheckCircle2 className="size-4" />
            {ACTIONS.pay.label}
          </button>
          <button type="button" onClick={() => setPending("refund")} className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-white/5 border border-white/20 text-white hover:bg-white/10 transition-colors text-sm font-medium">
            <Undo2 className="size-4" />
            {ACTIONS.refund.label}
          </button>
          <button type="button" onClick={() => setPending("quality-rejected")} className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-brand-red/10 border border-brand-red/30 text-brand-red hover:bg-brand-red/20 transition-colors text-sm font-medium">
            <Gavel className="size-4" />
            {ACTIONS["quality-rejected"].label}
          </button>
          <button type="button" onClick={() => setPending("payout-blocked")} className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-gray-400 hover:bg-white/10 transition-colors text-xs">
            <Ban className="size-4" />
            {ACTIONS["payout-blocked"].label}
          </button>
        </div>
      )}

      {pending !== null && (
        <div className="space-y-3">
          <div className="text-xs">
            <span className="text-gray-400">You&apos;re about to: </span>
            <span className="text-white font-mono font-semibold">{ACTIONS[pending].effect}</span>
          </div>
          <div>
            <label className="block text-xs text-gray-400 mb-1">Note (required, ≥ 3 chars, recorded on the job)</label>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder='e.g. "Deliverable matches the brief; the requester asked for a different format afterwards"'
              rows={2}
              className="w-full bg-black/40 border border-white/10 rounded px-3 py-2 text-sm text-white placeholder:text-gray-600 focus:outline-none focus:border-brand-accent/50"
            />
          </div>
          {error && <div className="text-xs text-brand-red bg-brand-red/10 border border-brand-red/30 rounded px-3 py-2">{error}</div>}
          <div className="flex gap-2">
            <button type="button" onClick={submit} disabled={submitting || note.trim().length < 3} className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-white/10 border border-white/20 text-white hover:bg-white/20 transition-colors text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed">
              {submitting ? "Submitting…" : "Confirm"}
            </button>
            <button
              type="button"
              onClick={() => {
                setPending(null);
                setNote("");
                setError(null);
              }}
              disabled={submitting}
              className="inline-flex items-center px-4 py-2 rounded-lg bg-white/5 border border-white/10 text-gray-400 hover:bg-white/10 transition-colors text-sm"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
