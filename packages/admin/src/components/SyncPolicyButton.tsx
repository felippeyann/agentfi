"use client";

import { useCallback, useEffect, useState } from "react";
import { RefreshCcw, AlertCircle } from "lucide-react";

interface SyncPolicyButtonProps {
  agentId: string;
}

/** The slice of GET /admin/agents/:id/policy/onchain the button shows. */
interface SyncView {
  status: string;
  reason?: string | null;
  walletMode?: string;
  differences?: string[];
  pending?: Array<{ transactionId: string; call: string; status: string }>;
  lastFailure?: { transactionId: string; call: string; status: string; error: string | null } | null;
  warnings?: string[];
}

const STATUS_STYLE: Record<string, string> = {
  "in-sync": "text-green-400",
  pending: "text-yellow-400",
  failed: "text-brand-red",
  "out-of-sync": "text-yellow-400",
};

/**
 * S8 — on-chain policy sync.
 *
 * Shows the stored policy against what the agent chain's AgentPolicyModule
 * holds (GET /api/agents/:id/policy-sync) and, on click, asks the backend to
 * push the STORED policy (POST, no body). The backend signs the module calls
 * with the agent's own wallet and sends them straight to the module
 * (msg.sender == safe for an EOA agent) — never through AgentExecutor, where
 * the executor is msg.sender and every module call reverts Unauthorized
 * (the previous version of this button did exactly that, after a PATCH to an
 * admin route that did not exist).
 */
export function SyncPolicyButton({ agentId }: SyncPolicyButtonProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<SyncView | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`/api/agents/${agentId}/policy-sync`, { cache: "no-store" });
      const body = (await res.json().catch(() => null)) as SyncView | { error?: string } | null;
      if (res.ok && body && "status" in body) setView(body);
      else setError((body as { error?: string } | null)?.error ?? `Status unavailable (${res.status})`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [agentId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleSync = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/agents/${agentId}/policy-sync`, { method: "POST" });
      const body = (await res.json().catch(() => ({}))) as { error?: string; code?: string; status?: string };
      if (!res.ok) {
        throw new Error(body.code ? `${body.code}: ${body.error ?? ""}` : body.error ?? `Sync failed (${res.status})`);
      }
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex flex-col gap-2 items-end">
      <button
        onClick={handleSync}
        disabled={loading}
        className="flex items-center gap-2 bg-brand-purple/10 hover:bg-brand-purple/20 border border-brand-purple/30 text-brand-purple px-4 py-2 rounded-lg text-xs font-bold transition-all disabled:opacity-50 group"
        title="Push the stored policy to AgentPolicyModule (signed by the agent's own wallet, sent straight to the module)"
      >
        <RefreshCcw className={`size-3.5 ${loading ? 'animate-spin' : 'group-hover:rotate-180 transition-transform duration-500'}`} />
        <span>{loading ? 'Syncing...' : 'Sync to Chain'}</span>
      </button>

      {view && (
        <div className="text-[10px] text-right max-w-xs space-y-0.5">
          <p>
            On-chain:{" "}
            <span className={`font-bold ${STATUS_STYLE[view.status] ?? "text-gray-400"}`}>{view.status}</span>
            {view.pending && view.pending.length > 0 && <span className="text-gray-400"> ({view.pending.length} tx pending)</span>}
          </p>
          {view.reason && <p className="text-gray-400">{view.reason}</p>}
          {view.lastFailure && view.status === "failed" && (
            <p className="text-brand-red">Last attempt {view.lastFailure.call}: {view.lastFailure.error ?? view.lastFailure.status}</p>
          )}
          {view.differences && view.differences.length > 0 && (
            <ul className="text-gray-400 list-none">
              {view.differences.slice(0, 4).map((d) => (
                <li key={d}>{d}</li>
              ))}
            </ul>
          )}
          {view.warnings?.map((w) => (
            <p key={w} className="text-yellow-500">{w}</p>
          ))}
        </div>
      )}

      {error && (
        <div className="flex items-center gap-1 text-[10px] text-brand-red font-medium px-1">
          <AlertCircle className="size-3" />
          <span>{error}</span>
        </div>
      )}
    </div>
  );
}
