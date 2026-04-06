import { adminFetch } from '../../../lib/api';
import { PauseButton } from '../../../components/PauseButton';
import { SyncPolicyButton } from '../../../components/SyncPolicyButton';

interface AgentDetail {
  id: string;
  name: string;
  safeAddress: string;
  walletId: string;
  active: boolean;
  tier: 'FREE' | 'PRO' | 'ENTERPRISE';
  chainIds: number[];
  policy: {
  maxValuePerTxEth: string;
  maxValueForAutoApprovalEth: string;
  maxDailyVolumeUsd: string;
  allowedContracts: string[];
  allowedTokens: string[];
  cooldownSeconds: number;
  active: boolean;
  } | null;

  billing: {
    txCountThisPeriod: number;
    totalFeesCollectedUsd: string;
    subscriptionActive: boolean;
  } | null;
}

interface Transaction {
  id: string;
  status: string;
  type: string;
  txHash?: string;
  amountIn?: string;
  error?: string;
  createdAt: string;
}

async function getAgent(id: string): Promise<AgentDetail | null> {
  try {
    return await adminFetch<AgentDetail>(`/admin/agents/${id}`);
  } catch {
    return null;
  }
}

async function getAgentTransactions(id: string): Promise<Transaction[]> {
  try {
    const res = await adminFetch<{ transactions: Transaction[] }>(
      `/admin/agents/${id}/transactions?limit=20`,
    );
    return res.transactions;
  } catch {
    return [];
  }
}

const STATUS_COLORS: Record<string, string> = {
  CONFIRMED: 'text-green-400',
  SUBMITTED: 'text-blue-400',
  PENDING: 'text-yellow-400',
  QUEUED: 'text-yellow-400',
  FAILED: 'text-red-400',
  REVERTED: 'text-red-400',
};

export default async function AgentDetailPage({ params }: { params: { id: string } }) {
  const [agent, transactions] = await Promise.all([
    getAgent(params.id),
    getAgentTransactions(params.id),
  ]);

  if (!agent) {
    return <div className="text-red-400">Agent not found.</div>;
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-white">{agent.name}</h1>
          <p className="text-gray-400 text-sm">{agent.id}</p>
        </div>
        <div className="flex gap-2">
          <PauseButton agentId={agent.id} isActive={agent.active} />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="border border-gray-800 rounded-lg p-4 bg-gray-900 space-y-2">
          <h2 className="text-gray-400 text-xs uppercase">Wallet</h2>
          <p className="text-xs text-gray-300">Safe: <code>{agent.safeAddress}</code></p>
          <p className="text-xs text-gray-300">Tier: <span className="text-white">{agent.tier}</span></p>
          <p className="text-xs text-gray-300">
            Status:{' '}
            <span className={agent.active ? 'text-green-400' : 'text-red-400'}>
              {agent.active ? 'active' : 'paused'}
            </span>
          </p>
          {agent.billing && (
            <>
              <p className="text-xs text-gray-300">
                Txs this period: <span className="text-white">{agent.billing.txCountThisPeriod}</span>
              </p>
              <p className="text-xs text-gray-300">
                Fees collected:{' '}
                <span className="text-green-400">${parseFloat(agent.billing.totalFeesCollectedUsd).toFixed(4)}</span>
              </p>
            </>
          )}
        </div>

        <div className="border border-gray-800 rounded-lg p-4 bg-gray-900 space-y-2 relative">
          <div className="flex items-center justify-between mb-1">
            <h2 className="text-gray-400 text-xs uppercase">Policy</h2>
            <SyncPolicyButton agentId={agent.id} />
          </div>
          {agent.policy ? (
            <>
              <p className="text-xs text-gray-300">
                Max value/tx: <span className="text-white">{agent.policy.maxValuePerTxEth} ETH</span>
              </p>
              <p className="text-xs text-brand-purple">
                Auto-approve limit: <span className="font-bold">{agent.policy.maxValueForAutoApprovalEth} ETH</span>
              </p>
              <p className="text-xs text-gray-300">
                Daily limit: <span className="text-white">${agent.policy.maxDailyVolumeUsd}</span>
              </p>
              <p className="text-xs text-gray-300">
                Cooldown: <span className="text-white">{agent.policy.cooldownSeconds}s</span>
              </p>
              <p className="text-xs text-gray-300">
                Allowed contracts:{' '}
                <span className="text-white">
                  {agent.policy.allowedContracts.length === 0 ? 'all' : agent.policy.allowedContracts.length}
                </span>
              </p>
              <p className="text-xs text-gray-300">
                Policy active:{' '}
                <span className={agent.policy.active ? 'text-green-400' : 'text-red-400'}>
                  {agent.policy.active ? 'yes' : 'no (kill switch)'}
                </span>
              </p>
            </>
          ) : (
            <p className="text-gray-500 text-xs">No policy set — all transactions allowed.</p>
          )}
        </div>
      </div>

      <div className="border border-gray-800 rounded-lg overflow-hidden">
        <div className="px-4 py-3 bg-gray-900 text-gray-400 text-xs uppercase">
          Recent Transactions
        </div>
        <table className="w-full text-sm">
          <thead className="bg-gray-900 text-gray-500 text-xs">
            <tr>
              <th className="text-left px-4 py-2">Type</th>
              <th className="text-left px-4 py-2">Status</th>
              <th className="text-left px-4 py-2">Amount</th>
              <th className="text-left px-4 py-2">Tx Hash</th>
              <th className="text-left px-4 py-2">Error</th>
              <th className="text-left px-4 py-2">Time</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-800">
            {transactions.map((tx) => (
              <tr key={tx.id} className="hover:bg-gray-900">
                <td className="px-4 py-2 text-gray-300">{tx.type}</td>
                <td className="px-4 py-2">
                  <span className={STATUS_COLORS[tx.status] ?? 'text-gray-400'}>{tx.status}</span>
                </td>
                <td className="px-4 py-2 text-gray-300">{tx.amountIn ?? '—'}</td>
                <td className="px-4 py-2">
                  {tx.txHash ? (
                    <code className="text-xs text-blue-400">
                      {tx.txHash.slice(0, 10)}…
                    </code>
                  ) : (
                    '—'
                  )}
                </td>
                <td className="px-4 py-2 text-red-400 text-xs">{tx.error ?? ''}</td>
                <td className="px-4 py-2 text-gray-500 text-xs">
                  {new Date(tx.createdAt).toLocaleString()}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
