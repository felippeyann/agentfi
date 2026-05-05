import Link from 'next/link';
import { adminFetch } from '../../lib/api';
import {
  Briefcase,
  Clock,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  ArrowRightLeft,
  Ban,
} from 'lucide-react';

interface Job {
  id: string;
  status:
    | 'PENDING'
    | 'ACCEPTED'
    | 'COMPLETED'
    | 'FAILED'
    | 'CANCELLED'
    | 'PAYMENT_PENDING'
    | 'PAYMENT_FAILED';
  reservationStatus?: 'PENDING' | 'RELEASED' | 'CANCELLED' | null;
  reservedAmount?: string | null;
  reservedToken?: string | null;
  reservedChainId?: number | null;
  payload: any;
  reward: any;
  result?: any;
  createdAt: string;
  updatedAt: string;
  requester: { id: string; name: string };
  provider: { id: string; name: string };
}

const STATUS_CONFIG: Record<
  Job['status'],
  { label: string; color: string; icon: React.ReactNode }
> = {
  PENDING: {
    label: 'PENDING',
    color: 'text-brand-purple bg-brand-purple/10 ring-brand-purple/30',
    icon: <Clock className="size-3" />,
  },
  ACCEPTED: {
    label: 'ACCEPTED',
    color: 'text-brand-accent bg-brand-accent/10 ring-brand-accent/30',
    icon: <ArrowRightLeft className="size-3" />,
  },
  COMPLETED: {
    label: 'COMPLETED',
    color: 'text-brand-green bg-brand-green/10 ring-brand-green/30',
    icon: <CheckCircle2 className="size-3" />,
  },
  FAILED: {
    label: 'FAILED',
    color: 'text-brand-red bg-brand-red/10 ring-brand-red/30',
    icon: <XCircle className="size-3" />,
  },
  CANCELLED: {
    label: 'CANCELLED',
    color: 'text-gray-400 bg-gray-500/10 ring-gray-500/30',
    icon: <Ban className="size-3" />,
  },
  PAYMENT_PENDING: {
    label: 'PAYMENT_PENDING',
    color: 'text-yellow-400 bg-yellow-400/10 ring-yellow-400/30',
    icon: <Clock className="size-3" />,
  },
  PAYMENT_FAILED: {
    label: 'PAYMENT_FAILED',
    color: 'text-brand-red bg-brand-red/10 ring-brand-red/30',
    icon: <AlertTriangle className="size-3" />,
  },
};

const FILTER_CHIPS: Array<{ label: string; value: string | null }> = [
  { label: 'All', value: null },
  { label: 'Pending', value: 'PENDING' },
  { label: 'Active', value: 'ACCEPTED' },
  { label: 'Pending Payment', value: 'PAYMENT_PENDING' },
  { label: 'Failed Payment', value: 'PAYMENT_FAILED' },
  { label: 'Completed', value: 'COMPLETED' },
  { label: 'Failed', value: 'FAILED' },
  { label: 'Cancelled', value: 'CANCELLED' },
];

async function getJobs(status: string | null): Promise<Job[]> {
  try {
    const res = await adminFetch<{ jobs: Job[] }>(
      `/admin/jobs?limit=100${status ? `&status=${status}` : ''}`,
    );
    return res.jobs;
  } catch {
    return [];
  }
}

function formatRelative(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const sec = Math.floor(diffMs / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const d = Math.floor(hr / 24);
  return `${d}d ago`;
}

export default async function JobsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const params = await searchParams;
  const activeStatus = params.status ?? null;
  const jobs = await getJobs(activeStatus);

  return (
    <div className="space-y-6 animate-in fade-in duration-700">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-white mb-1 flex items-center gap-2">
            <Briefcase className="text-brand-purple size-8" />
            Jobs
          </h1>
          <p className="text-gray-400">
            A2A service requests across all agents. Filter by lifecycle state to triage.
          </p>
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        {FILTER_CHIPS.map((chip) => {
          const isActive = chip.value === activeStatus;
          const href = chip.value ? `/jobs?status=${chip.value}` : '/jobs';
          const isAlertChip =
            chip.value === 'PAYMENT_PENDING' || chip.value === 'PAYMENT_FAILED';
          return (
            <Link
              key={chip.label}
              href={href}
              className={`inline-flex items-center px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                isActive
                  ? isAlertChip
                    ? 'bg-yellow-400/15 border-yellow-400/40 text-yellow-300'
                    : 'bg-brand-accent/15 border-brand-accent/40 text-white'
                  : isAlertChip
                    ? 'bg-yellow-400/5 border-yellow-400/20 text-yellow-400/80 hover:bg-yellow-400/10'
                    : 'bg-white/5 border-white/10 text-gray-400 hover:bg-white/10'
              }`}
            >
              {chip.label}
            </Link>
          );
        })}
      </div>

      <div className="glass rounded-xl overflow-hidden border border-brand-border">
        <table className="w-full text-sm text-left">
          <thead className="bg-brand-black/50 text-gray-400 text-xs uppercase tracking-wider border-b border-brand-border">
            <tr>
              <th className="px-6 py-4 font-semibold">Status</th>
              <th className="px-6 py-4 font-semibold">Job</th>
              <th className="px-6 py-4 font-semibold">Requester → Provider</th>
              <th className="px-6 py-4 font-semibold">Reward</th>
              <th className="px-6 py-4 font-semibold">Escrow</th>
              <th className="px-6 py-4 font-semibold">Updated</th>
              <th className="px-6 py-4 font-semibold text-right">Action</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-brand-border/50">
            {jobs.length === 0 && (
              <tr>
                <td colSpan={7} className="px-6 py-12 text-center text-gray-500">
                  <div className="flex flex-col items-center justify-center">
                    <Briefcase className="size-12 text-gray-600 mb-3" />
                    <p>No jobs match this filter.</p>
                  </div>
                </td>
              </tr>
            )}
            {jobs.map((job) => {
              const statusCfg = STATUS_CONFIG[job.status] ?? STATUS_CONFIG.PENDING;
              const reward =
                job.reward && typeof job.reward === 'object' ? (job.reward as any) : null;
              const rewardLabel = reward?.amount
                ? `${reward.amount} ${reward.token ?? 'ETH'}`
                : '—';
              return (
                <tr key={job.id} className="hover:bg-white/[0.02] transition-colors group">
                  <td className="px-6 py-4">
                    <div
                      className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-[4px] text-xs font-medium ring-1 inset-ring ${statusCfg.color}`}
                    >
                      {statusCfg.icon}
                      <span>{statusCfg.label}</span>
                    </div>
                  </td>
                  <td className="px-6 py-4">
                    <code className="text-xs text-gray-400 bg-black/40 px-2 py-1 rounded border border-white/5">
                      {job.id.slice(0, 10)}…
                    </code>
                  </td>
                  <td className="px-6 py-4 text-gray-300">
                    <div className="text-xs">
                      <span className="text-gray-400">{job.requester.name}</span>
                      <span className="text-gray-500 mx-1.5">→</span>
                      <span>{job.provider.name}</span>
                    </div>
                  </td>
                  <td className="px-6 py-4 text-gray-300 font-medium">{rewardLabel}</td>
                  <td className="px-6 py-4">
                    {job.reservationStatus ? (
                      <span
                        className={`inline-flex items-center px-2 py-0.5 rounded text-[11px] font-medium ${
                          job.reservationStatus === 'PENDING'
                            ? 'bg-yellow-400/10 text-yellow-400'
                            : job.reservationStatus === 'RELEASED'
                              ? 'bg-brand-green/10 text-brand-green'
                              : 'bg-gray-500/10 text-gray-400'
                        }`}
                      >
                        {job.reservationStatus}
                      </span>
                    ) : (
                      <span className="text-gray-600 text-xs">—</span>
                    )}
                  </td>
                  <td className="px-6 py-4 text-gray-400 text-xs" title={job.updatedAt}>
                    {formatRelative(job.updatedAt)}
                  </td>
                  <td className="px-6 py-4 text-right">
                    <Link
                      href={`/jobs/${job.id}`}
                      className="inline-flex items-center gap-1.5 text-xs font-bold text-gray-400 hover:text-brand-accent transition-colors bg-white/5 hover:bg-brand-accent/10 px-3 py-1.5 rounded-lg border border-white/5 hover:border-brand-accent/30"
                    >
                      View
                    </Link>
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
