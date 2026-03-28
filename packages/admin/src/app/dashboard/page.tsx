import { adminFetch } from '../../lib/api';
import { StatCard } from '../../components/StatCard';
import { VolumeChart } from '../../components/Chart';
import { Users, Activity, CheckCircle, AlertCircle, DollarSign, Wallet } from 'lucide-react';

interface DashboardStats {
  activeAgents: number;
  totalTransactions: number;
  confirmedToday: number;
  failedToday: number;
  volumeToday: string;
  totalFeesUsd: string;
}

async function getStats(): Promise<DashboardStats> {
  try {
    return await adminFetch<DashboardStats>('/admin/stats');
  } catch {
    // Return zeros if backend not reachable (graceful degradation)
    return {
      activeAgents: 0,
      totalTransactions: 0,
      confirmedToday: 0,
      failedToday: 0,
      volumeToday: '0',
      totalFeesUsd: '0',
    };
  }
}

export default async function DashboardPage() {
  const stats = await getStats();

  return (
    <div className="space-y-8 animate-in fade-in duration-700">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-white mb-1">Overview</h1>
          <p className="text-gray-400">Welcome back, Operator. Here's your protocol status.</p>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-4">
        <StatCard label="Active Agents" value={stats.activeAgents.toString()} icon={<Users className="size-4" />} delay={0.1} />
        <StatCard label="Total Txs" value={stats.totalTransactions.toString()} icon={<Activity className="size-4" />} delay={0.2} />
        <StatCard label="Confirmed Today" value={stats.confirmedToday.toString()} icon={<CheckCircle className="size-4" />} delay={0.3} sub="transactions" />
        <StatCard label="Failed Today" value={stats.failedToday.toString()} icon={<AlertCircle className="size-4" />} delay={0.4} sub={stats.failedToday > 0 ? 'check errors' : 'clean'} />
        <StatCard label="Volume Today" value={`$${parseFloat(stats.volumeToday).toLocaleString()}`} icon={<DollarSign className="size-4" />} delay={0.5} />
        <StatCard label="Protocol Fees" value={`$${parseFloat(stats.totalFeesUsd).toFixed(2)}`} icon={<Wallet className="size-4" />} delay={0.6} sub="total earned" />
      </div>

      <div className="w-full">
        <VolumeChart />
      </div>
      
      <div className="p-6 glass rounded-2xl mt-8">
        <h3 className="text-white font-medium mb-2">Protocol Mechanics</h3>
        <p className="text-gray-400 text-sm">
          Revenue model: Protocol fee charged on every confirmed transaction. FREE tier: 0.30%, PRO: 0.15%, ENTERPRISE: 0.05%.
        </p>
      </div>
    </div>
  );
}
