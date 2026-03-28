import { adminFetch } from '../../lib/api';
import { Activity, ArrowRightLeft, CheckCircle2, XCircle, Clock, AlertTriangle } from 'lucide-react';

interface Transaction {
  id: string;
  agentId: string;
  status: 'CONFIRMED' | 'SUBMITTED' | 'PENDING' | 'QUEUED' | 'FAILED' | 'REVERTED' | 'SIMULATING';
  type: string;
  chainId: number;
  txHash?: string;
  fromToken?: string;
  toToken?: string;
  amountIn?: string;
  error?: string;
  createdAt: string;
  confirmedAt?: string;
}

async function getTransactions(): Promise<Transaction[]> {
  try {
    const res = await adminFetch<{ transactions: Transaction[] }>(
      '/admin/transactions?limit=50',
    );
    return res.transactions;
  } catch {
    return [];
  }
}

const STATUS_CONFIG: Record<string, { color: string; icon: React.ReactNode }> = {
  CONFIRMED: { color: 'text-brand-green bg-brand-green/10 ring-brand-green/30', icon: <CheckCircle2 className="size-3" /> },
  SUBMITTED: { color: 'text-brand-accent bg-brand-accent/10 ring-brand-accent/30', icon: <ArrowRightLeft className="size-3" /> },
  PENDING: { color: 'text-brand-purple bg-brand-purple/10 ring-brand-purple/30', icon: <Clock className="size-3" /> },
  QUEUED: { color: 'text-brand-purple bg-brand-purple/10 ring-brand-purple/30', icon: <Clock className="size-3" /> },
  FAILED: { color: 'text-brand-red bg-brand-red/10 ring-brand-red/30', icon: <XCircle className="size-3" /> },
  REVERTED: { color: 'text-brand-red bg-brand-red/10 ring-brand-red/30', icon: <XCircle className="size-3" /> },
  SIMULATING: { color: 'text-gray-400 bg-gray-500/10 ring-gray-500/30', icon: <Activity className="size-3" /> },
};

const CHAIN_NAMES: Record<number, string> = {
  1: 'Ethereum',
  8453: 'Base',
  42161: 'Arbitrum',
  137: 'Polygon',
};

export default async function TransactionsPage() {
  const transactions = await getTransactions();

  return (
    <div className="space-y-6 animate-in fade-in duration-700">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-white mb-1 flex items-center gap-2">
            <Activity className="text-brand-purple size-8" />
            Transaction Log
          </h1>
          <p className="text-gray-400">Real-time feed of all agent activities on-chain.</p>
        </div>
      </div>

      <div className="glass rounded-xl overflow-hidden border border-brand-border">
        <table className="w-full text-sm text-left">
          <thead className="bg-brand-black/50 text-gray-400 text-xs uppercase tracking-wider border-b border-brand-border">
            <tr>
              <th className="px-6 py-4 font-semibold">Type</th>
              <th className="px-6 py-4 font-semibold">Status</th>
              <th className="px-6 py-4 font-semibold">Network</th>
              <th className="px-6 py-4 font-semibold">Agent</th>
              <th className="px-6 py-4 font-semibold">Amount</th>
              <th className="px-6 py-4 font-semibold">Tx Hash & Errs</th>
              <th className="px-6 py-4 font-semibold text-right">Time</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-brand-border/50">
            {transactions.length === 0 && (
              <tr>
                <td colSpan={7} className="px-6 py-12 text-center text-gray-500">
                  <div className="flex flex-col items-center justify-center">
                    <Activity className="size-12 text-gray-600 mb-3" />
                    <p>No transactions found.</p>
                  </div>
                </td>
              </tr>
            )}
            {transactions.map((tx) => {
              const statusCfg = STATUS_CONFIG[tx.status] || { color: 'text-gray-400 bg-gray-500/10', icon: <Activity className="size-3" /> };
              
              return (
                <tr key={tx.id} className="hover:bg-white/[0.02] transition-colors group">
                  <td className="px-6 py-4">
                    <span className="text-white font-medium bg-white/5 px-2.5 py-1 rounded-md text-xs">{tx.type}</span>
                  </td>
                  <td className="px-6 py-4">
                    <div className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-[4px] text-xs font-medium ring-1 inset-ring ${statusCfg.color}`}>
                      {statusCfg.icon}
                      <span>{tx.status}</span>
                    </div>
                  </td>
                  <td className="px-6 py-4 text-gray-400 font-medium">
                    {CHAIN_NAMES[tx.chainId] ?? tx.chainId}
                  </td>
                  <td className="px-6 py-4">
                    <code className="text-xs text-gray-400 bg-black/40 px-2 py-1 rounded border border-white/5">
                      {tx.agentId.slice(0, 8)}…
                    </code>
                  </td>
                  <td className="px-6 py-4 text-gray-300 font-medium">
                    {tx.amountIn ?? '—'}
                  </td>
                  <td className="px-6 py-4">
                    {tx.txHash && (
                      <code className="block text-xs text-brand-accent max-w-[120px] truncate mb-1 bg-brand-accent/5 px-1.5 py-0.5 rounded">
                        {tx.txHash}
                      </code>
                    )}
                    {tx.error && (
                      <div className="flex items-start gap-1 max-w-[200px]">
                        <AlertTriangle className="size-3 text-brand-red shrink-0 mt-0.5" />
                        <span className="text-brand-red/80 text-[11px] leading-tight line-clamp-2" title={tx.error}>
                          {tx.error}
                        </span>
                      </div>
                    )}
                    {!tx.txHash && !tx.error && <span className="text-gray-600">—</span>}
                  </td>
                  <td className="px-6 py-4 text-right">
                    <p className="text-gray-300 text-sm">{new Date(tx.createdAt).toLocaleDateString()}</p>
                    <p className="text-gray-500 text-xs">{new Date(tx.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</p>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
