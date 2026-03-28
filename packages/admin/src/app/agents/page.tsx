import { adminFetch } from '../../lib/api';
import { Bot, Zap, Plus, ExternalLink } from 'lucide-react';

interface Agent {
  id: string;
  name: string;
  apiKeyPrefix: string;
  safeAddress: string;
  active: boolean;
  tier: 'FREE' | 'PRO' | 'ENTERPRISE';
  chainIds: number[];
  createdAt: string;
  billing?: { txCountThisPeriod: number; totalFeesCollectedUsd: string };
}

async function getAgents(): Promise<Agent[]> {
  try {
    const res = await adminFetch<{ agents: Agent[] }>('/admin/agents');
    return res.agents;
  } catch {
    return [];
  }
}

const TIER_STYLES = {
  FREE: 'bg-gray-500/10 text-gray-400 ring-gray-400/30',
  PRO: 'bg-brand-accent/10 text-brand-accent ring-brand-accent/30',
  ENTERPRISE: 'bg-brand-purple/10 text-brand-purple ring-brand-purple/30',
};

const NETWORK_COLORS: Record<number, string> = {
  1: 'bg-indigo-500/20 text-indigo-300 ring-indigo-500/30',      // ETH
  8453: 'bg-blue-500/20 text-blue-300 ring-blue-500/30',         // Base
  42161: 'bg-cyan-500/20 text-cyan-300 ring-cyan-500/30',        // Arb
  137: 'bg-purple-500/20 text-purple-300 ring-purple-500/30',    // Poly
};

const NETWORK_NAMES: Record<number, string> = {
  1: 'ETH',
  8453: 'Base',
  42161: 'Arb',
  137: 'Poly',
};

export default async function AgentsPage() {
  const agents = await getAgents();

  return (
    <div className="space-y-6 animate-in fade-in duration-700">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-white mb-1 flex items-center gap-2">
            <Bot className="text-brand-accent size-8" />
            Registered Agents
          </h1>
          <p className="text-gray-400">Manage and monitor {agents.length} active agent wallets.</p>
        </div>
        <button className="flex items-center gap-2 px-4 py-2 bg-brand-accent text-brand-black font-semibold rounded-lg hover:bg-brand-accent/90 transition-colors shadow-[0_0_15px_rgba(0,240,255,0.4)]">
          <Plus className="size-4" />
          <span>New Agent</span>
        </button>
      </div>

      <div className="glass rounded-xl overflow-hidden border border-brand-border">
        <table className="w-full text-sm text-left">
          <thead className="bg-brand-black/50 text-gray-400 text-xs uppercase tracking-wider border-b border-brand-border">
            <tr>
              <th className="px-6 py-4 font-semibold">Agent Name</th>
              <th className="px-6 py-4 font-semibold">Tier</th>
              <th className="px-6 py-4 font-semibold">Wallet / Safe</th>
              <th className="px-6 py-4 font-semibold">Networks</th>
              <th className="px-6 py-4 font-semibold text-right">Activity</th>
              <th className="px-6 py-4 font-semibold text-center">Status</th>
              <th className="px-6 py-4 font-semibold text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-brand-border/50">
            {agents.length === 0 && (
              <tr>
                <td colSpan={7} className="px-6 py-12 text-center text-gray-500">
                  <div className="flex flex-col items-center justify-center">
                    <Bot className="size-12 text-gray-600 mb-3" />
                    <p>No agents registered yet.</p>
                  </div>
                </td>
              </tr>
            )}
            {agents.map((agent) => (
              <tr key={agent.id} className="hover:bg-white/[0.02] transition-colors group">
                <td className="px-6 py-4">
                  <div className="flex items-center gap-3">
                    <div className="size-8 rounded-full bg-brand-border flex items-center justify-center text-white font-bold">
                      {agent.name.charAt(0).toUpperCase()}
                    </div>
                    <div>
                      <p className="text-white font-medium group-hover:text-brand-accent transition-colors">{agent.name}</p>
                      <p className="text-gray-500 text-xs font-mono">{agent.apiKeyPrefix}••••••••</p>
                    </div>
                  </div>
                </td>
                <td className="px-6 py-4">
                  <span className={`inline-flex items-center text-xs font-medium px-2 py-1 rounded-md ring-1 inset-ring ${TIER_STYLES[agent.tier]}`}>
                    {agent.tier}
                  </span>
                </td>
                <td className="px-6 py-4">
                  <div className="flex items-center gap-2">
                    <code className="text-xs text-gray-300 bg-black/40 px-2 py-1 rounded border border-white/5">
                      {agent.safeAddress.slice(0, 6)}…{agent.safeAddress.slice(-4)}
                    </code>
                    <a href={`https://app.safe.global/home?safe=eth:${agent.safeAddress}`} target="_blank" rel="noreferrer" className="text-gray-500 hover:text-white transition-colors">
                      <ExternalLink className="size-3" />
                    </a>
                  </div>
                </td>
                <td className="px-6 py-4">
                  <div className="flex flex-wrap gap-1.5">
                    {agent.chainIds.map((id) => (
                      <span
                        key={id}
                        className={`text-[10px] font-bold uppercase px-1.5 py-0.5 rounded ring-1 inset-ring ${NETWORK_COLORS[id] || 'bg-gray-800 text-gray-300 ring-gray-700'}`}
                      >
                        {NETWORK_NAMES[id] ?? id}
                      </span>
                    ))}
                  </div>
                </td>
                <td className="px-6 py-4 text-right">
                  <p className="text-white font-medium">{agent.billing?.txCountThisPeriod ?? 0} <span className="text-gray-500 text-xs font-normal">TXs</span></p>
                  <p className="text-brand-green text-xs">${parseFloat(agent.billing?.totalFeesCollectedUsd ?? '0').toFixed(2)}</p>
                </td>
                <td className="px-6 py-4 text-center">
                  <div className="flex items-center justify-center gap-1.5">
                    <div className={`size-2 rounded-full ${agent.active ? 'bg-brand-green animate-pulse' : 'bg-brand-red'}`} />
                    <span className={`text-xs font-medium ${agent.active ? 'text-gray-300' : 'text-gray-500'}`}>
                      {agent.active ? 'Active' : 'Paused'}
                    </span>
                  </div>
                </td>
                <td className="px-6 py-4 text-right">
                  <a
                    href={`/agents/${agent.id}`}
                    className="inline-flex items-center justify-center px-3 py-1.5 rounded bg-white/5 hover:bg-white/10 text-white text-xs font-medium transition-colors"
                  >
                    Manage
                  </a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
