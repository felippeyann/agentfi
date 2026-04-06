"use client";

import { useState } from "react";
import { CheckCircle2, XCircle, ShieldCheck } from "lucide-react";
import { useRouter } from "next/navigation";

interface TransactionAdminActionsProps {
  transactionId: string;
}

export function TransactionAdminActions({ transactionId }: TransactionAdminActionsProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  const handleAction = async (action: 'approve' | 'reject') => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/transactions/${transactionId}/${action}`, {
        method: 'POST',
      });
      
      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: 'Unknown error' }));
        throw new Error(data.error || `Failed to ${action} transaction`);
      }
      
      // Refresh the page to show updated status
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <button
          onClick={() => handleAction('approve')}
          disabled={loading}
          className="flex-1 flex items-center justify-center gap-2 bg-brand-green/10 hover:bg-brand-green/20 border border-brand-green/30 text-brand-green py-3 rounded-xl transition-all duration-300 disabled:opacity-50 group"
        >
          <CheckCircle2 className="size-4 group-hover:scale-110 transition-transform" />
          <span className="font-bold text-sm uppercase tracking-wide">Approve</span>
        </button>
        
        <button
          onClick={() => handleAction('reject')}
          disabled={loading}
          className="flex-1 flex items-center justify-center gap-2 bg-brand-red/10 hover:bg-brand-red/20 border border-brand-red/30 text-brand-red py-3 rounded-xl transition-all duration-300 disabled:opacity-50 group"
        >
          <XCircle className="size-4 group-hover:scale-110 transition-transform" />
          <span className="font-bold text-sm uppercase tracking-wide">Reject</span>
        </button>
      </div>
      
      {error && (
        <p className="text-xs text-brand-red text-center font-medium animate-in fade-in duration-300">
          {error}
        </p>
      )}
      
      <p className="text-[10px] text-gray-500 text-center italic">
        Requires operator privilege. Action will be logged for audit.
      </p>
    </div>
  );
}
