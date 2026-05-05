import Link from 'next/link';
import { adminFetch } from '../../lib/api';
import { StatCard } from '../../components/StatCard';
import { VolumeChart } from '../../components/Chart';
import { Users, Activity, CheckCircle, AlertCircle, DollarSign, Wallet, Clock, AlertTriangle } from 'lucide-react';

interface DashboardStats {
  activeAgents: number;
  totalTransactions: number;
  confirmedToday: number;
  failedToday: number;
  volumeToday: string;
  totalFeesUsd: string;
  paymentPending: number;
  paymentFailed: number;
  stalePaymentPending: number;
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
      paymentPending: 0,
      paymentFailed: 0,
      stalePaymentPending: 0,
    };
  }
}

export default async function DashboardPage() {
  const stats = await getStats();
  const hasPaymentAlert = stats.stalePaymentPending > 0 || stats.paymentFailed > 0;

  return (
    <div className="space-y-8 animate-in fade-in duration-700">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-white mb-1">Overview</h1>
          <p className="text-gray-400">Welcome back, Operator. Here's your protocol status.</p>
        </div>
      </div>

      {hasPaymentAlert && (
        <Link
          href="/jobs?status=PAYMENT_PENDING"
          className="block p-4 rounded-xl bg-yellow-400/5 border border-yellow-400/30 hover:bg-yellow-400/10 transition-colors"
        >
          <div className="flex items-center gap-3">
            <AlertTriangle className="size-5 text-yellow-400 shrink-0" />
            <div className="flex-1">
              <p className="text-yellow-400 font-medium text-sm">
                {stats.stalePaymentPending > 0 && (
                  <>
                    {stats.stalePaymentPending} stale PAYMENT_PENDING job{stats.stalePaymentPending !== 1 ? 's' : ''} (&gt; 5 min)
                  </>
                )}
                {stats.stalePaymentPending > 0 && stats.paymentFailed > 0 && ' · '}
                {stats.paymentFailed > 0 && (
                  <>
                    {stats.paymentFailed} PAYMENT_FAILED awaiting reconcile
                  </>
                )}
              </p>
              <p className="text-yellow-400/70 text-xs mt-0.5">Click to triage on the Jobs page.</p>
            </div>
          </div>
        </Link>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-4">
        <StatCard label="Active Agents" value={stats.activeAgents.toString()} icon={<Users className="size-4" />} delay={0.1} />
        <StatCard label="Total Txs" value={stats.totalTransactions.toString()} icon={<Activity className="size-4" />} delay={0.2} />
        <StatCard label="Confirmed Today" value={stats.confirmedToday.toString()} icon={<CheckCircle className="size-4" />} delay={0.3} sub="transactions" />
        <StatCard label="Failed Today" value={stats.failedToday.toString()} icon={<AlertCircle className="size-4" />} delay={0.4} sub={stats.failedToday > 0 ? 'check errors' : 'clean'} />
        <StatCard label="Volume Today" value={`$${parseFloat(stats.volumeToday).toLocaleString()}`} icon={<DollarSign className="size-4" />} delay={0.5} />
        <StatCard label="Protocol Fees" value={`$${parseFloat(stats.totalFeesUsd).toFixed(2)}`} icon={<Wallet className="size-4" />} delay={0.6} sub="total earned" />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <StatCard
          label="Payment Pending"
          value={stats.paymentPending.toString()}
          icon={<Clock className="size-4" />}
          delay={0.7}
          sub={stats.stalePaymentPending > 0 ? `${stats.stalePaymentPending} stale` : 'in-flight'}
        />
        <StatCard
          label="Payment Failed"
          value={stats.paymentFailed.toString()}
          icon={<AlertCircle className="size-4" />}
          delay={0.8}
          sub={stats.paymentFailed > 0 ? 'awaiting reconcile' : 'clean'}
        />
        <StatCard
          label="Stale (>5 min)"
          value={stats.stalePaymentPending.toString()}
          icon={<AlertTriangle className="size-4" />}
          delay={0.9}
          sub="recovery worker target"
        />
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
