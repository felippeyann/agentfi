"use client";

import { useState } from "react";
import { RefreshCcw, ShieldCheck, AlertCircle } from "lucide-react";
import { useRouter } from "next/navigation";

interface SyncPolicyButtonProps {
  agentId: string;
}

export function SyncPolicyButton({ agentId }: SyncPolicyButtonProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  const handleSync = async () => {
    setLoading(true);
    setError(null);
    try {
      // 1. Get the sync calldata from backend
      // We pass an empty body since we just want to sync the EXISTING policy from DB
      const patchRes = await fetch(`/api/agents/${agentId}/policy`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ syncOnChain: true }),
      });

      if (!patchRes.ok) {
        const err = await patchRes.json().catch(() => ({ error: 'Failed to generate sync data' }));
        throw new Error(err.error);
      }

      const { onChainSync } = await patchRes.json();
      if (!onChainSync || !onChainSync.actions || onChainSync.actions.length === 0) {
        throw new Error("No on-chain module configured for this agent's chain.");
      }

      // 2. Execute the sync transaction via the agent's batch executor
      // In a real prod environment, the operator might sign this, 
      // but here we use the backend's batch endpoint which uses the operator/agent context.
      const execRes = await fetch(`/api/transactions/batch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chainId: onChainSync.chainId,
          actions: onChainSync.actions,
          // Use an internal API key or operator secret if this were a direct backend call,
          // but we are proxying through admin API.
        }),
      });

      if (!execRes.ok) {
        const err = await execRes.json().catch(() => ({ error: 'Sync transaction failed' }));
        throw new Error(err.error);
      }

      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <button
        onClick={handleSync}
        disabled={loading}
        className="flex items-center gap-2 bg-brand-purple/10 hover:bg-brand-purple/20 border border-brand-purple/30 text-brand-purple px-4 py-2 rounded-lg text-xs font-bold transition-all disabled:opacity-50 group"
      >
        <RefreshCcw className={`size-3.5 ${loading ? 'animate-spin' : 'group-hover:rotate-180 transition-transform duration-500'}`} />
        <span>{loading ? 'Syncing...' : 'Sync to Chain'}</span>
      </button>
      
      {error && (
        <div className="flex items-center gap-1 text-[10px] text-brand-red font-medium px-1">
          <AlertCircle className="size-3" />
          <span>{error}</span>
        </div>
      )}
    </div>
  );
}
