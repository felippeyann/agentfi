"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, XCircle, AlertTriangle } from "lucide-react";

interface Props {
  jobId: string;
  status: "PAYMENT_PENDING" | "PAYMENT_FAILED";
}

export function JobReconcileActions({ jobId, status }: Props) {
  const router = useRouter();
  const [pendingAction, setPendingAction] = useState<
    "force_completed" | "force_failed" | null
  >(null);
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (!pendingAction || reason.trim().length < 3) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/jobs/${jobId}/reconcile`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: pendingAction, reason: reason.trim() }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(body.error ?? "Reconcile failed");
      }
      // Success — drop the modal and refetch the page (server component
      // re-runs to reflect the new status).
      setPendingAction(null);
      setReason("");
      router.refresh();
    } catch (err) {
      setError((err as Error)?.message ?? "Unknown error");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="rounded-xl border border-yellow-400/30 bg-yellow-400/5 p-6">
      <div className="flex items-start gap-3 mb-4">
        <AlertTriangle className="size-5 text-yellow-400 shrink-0 mt-0.5" />
        <div>
          <h3 className="text-yellow-300 font-semibold text-sm">
            Manual reconcile
          </h3>
          <p className="text-yellow-400/70 text-xs mt-1 leading-relaxed">
            This Job is in <code className="font-mono text-yellow-300">{status}</code>.
            Use these actions only when you've verified the on-chain state
            externally and the recovery worker can't resolve it automatically.
            Both actions are <strong>logged with audit context</strong>.
          </p>
        </div>
      </div>

      {pendingAction === null && (
        <div className="flex flex-wrap gap-3">
          <button
            type="button"
            onClick={() => setPendingAction("force_completed")}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-brand-green/10 border border-brand-green/30 text-brand-green hover:bg-brand-green/20 transition-colors text-sm font-medium"
          >
            <CheckCircle2 className="size-4" />
            Force COMPLETED
          </button>
          <button
            type="button"
            onClick={() => setPendingAction("force_failed")}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-brand-red/10 border border-brand-red/30 text-brand-red hover:bg-brand-red/20 transition-colors text-sm font-medium"
          >
            <XCircle className="size-4" />
            Force FAILED + Refund
          </button>
        </div>
      )}

      {pendingAction !== null && (
        <div className="space-y-3">
          <div className="text-xs">
            <span className="text-gray-400">You're about to: </span>
            <span
              className={
                pendingAction === "force_completed"
                  ? "text-brand-green font-mono font-semibold"
                  : "text-brand-red font-mono font-semibold"
              }
            >
              {pendingAction === "force_completed"
                ? "FORCE COMPLETED — escrow marked RELEASED, reputation +1"
                : "FORCE FAILED — escrow refunded to requester"}
            </span>
          </div>

          <div>
            <label className="block text-xs text-gray-400 mb-1">
              Reason (required, ≥ 3 chars, lands in audit log)
            </label>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder='e.g. "Provider DM-confirmed receipt of payment off-system, tx 0x..."'
              rows={2}
              className="w-full bg-black/40 border border-white/10 rounded px-3 py-2 text-sm text-white placeholder:text-gray-600 focus:outline-none focus:border-brand-accent/50"
            />
          </div>

          {error && (
            <div className="text-xs text-brand-red bg-brand-red/10 border border-brand-red/30 rounded px-3 py-2">
              {error}
            </div>
          )}

          <div className="flex gap-2">
            <button
              type="button"
              onClick={submit}
              disabled={submitting || reason.trim().length < 3}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-white/10 border border-white/20 text-white hover:bg-white/20 transition-colors text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {submitting ? "Submitting…" : "Confirm"}
            </button>
            <button
              type="button"
              onClick={() => {
                setPendingAction(null);
                setReason("");
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
