import Link from 'next/link';
import { notFound } from 'next/navigation';
import { adminFetch } from '../../../lib/api';
import { JobReconcileActions } from '../../../components/JobReconcileActions';
import {
  ArrowLeft,
  Briefcase,
  Clock,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Ban,
  ArrowRightLeft,
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
  reservedAt?: string | null;
  payload: any;
  reward: any;
  result?: any;
  signature?: string | null;
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
    icon: <Clock className="size-4" />,
  },
  ACCEPTED: {
    label: 'ACCEPTED',
    color: 'text-brand-accent bg-brand-accent/10 ring-brand-accent/30',
    icon: <ArrowRightLeft className="size-4" />,
  },
  COMPLETED: {
    label: 'COMPLETED',
    color: 'text-brand-green bg-brand-green/10 ring-brand-green/30',
    icon: <CheckCircle2 className="size-4" />,
  },
  FAILED: {
    label: 'FAILED',
    color: 'text-brand-red bg-brand-red/10 ring-brand-red/30',
    icon: <XCircle className="size-4" />,
  },
  CANCELLED: {
    label: 'CANCELLED',
    color: 'text-gray-400 bg-gray-500/10 ring-gray-500/30',
    icon: <Ban className="size-4" />,
  },
  PAYMENT_PENDING: {
    label: 'PAYMENT_PENDING',
    color: 'text-yellow-400 bg-yellow-400/10 ring-yellow-400/30',
    icon: <Clock className="size-4" />,
  },
  PAYMENT_FAILED: {
    label: 'PAYMENT_FAILED',
    color: 'text-brand-red bg-brand-red/10 ring-brand-red/30',
    icon: <AlertTriangle className="size-4" />,
  },
};

async function getJob(id: string): Promise<Job | null> {
  try {
    // The backend has GET /v1/jobs/:id (auth via API key) and a list at
    // /admin/jobs. There's no per-id admin endpoint yet, so we list with a
    // wide window and pick. Cheap (single-row index hit) and avoids a new
    // backend route just for the detail view.
    const res = await adminFetch<{ jobs: Job[] }>(`/admin/jobs?limit=200`);
    return res.jobs.find((j) => j.id === id) ?? null;
  } catch {
    return null;
  }
}

const CHAIN_NAMES: Record<number, string> = {
  1: 'Ethereum',
  8453: 'Base',
  42161: 'Arbitrum',
  137: 'Polygon',
};

export default async function JobDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const job = await getJob(id);
  if (!job) notFound();

  const statusCfg = STATUS_CONFIG[job.status] ?? STATUS_CONFIG.PENDING;
  const reward =
    job.reward && typeof job.reward === 'object' ? (job.reward as any) : null;
  const reservedChain = job.reservedChainId ? CHAIN_NAMES[job.reservedChainId] ?? job.reservedChainId : null;

  return (
    <div className="space-y-6 animate-in fade-in duration-700">
      <Link
        href="/jobs"
        className="inline-flex items-center gap-2 text-sm text-gray-400 hover:text-white transition-colors"
      >
        <ArrowLeft className="size-4" />
        Back to jobs
      </Link>

      <div className="flex items-start justify-between gap-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-white mb-2 flex items-center gap-2">
            <Briefcase className="text-brand-purple size-6" />
            Job <code className="font-mono text-base text-gray-400">{job.id}</code>
          </h1>
          <div
            className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium ring-1 inset-ring ${statusCfg.color}`}
          >
            {statusCfg.icon}
            <span>{statusCfg.label}</span>
          </div>
        </div>
      </div>

      {(job.status === 'PAYMENT_PENDING' || job.status === 'PAYMENT_FAILED') && (
        <JobReconcileActions jobId={job.id} status={job.status} />
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="glass rounded-xl p-5 border border-brand-border">
          <p className="text-xs text-gray-500 mb-1 uppercase tracking-wider">Requester</p>
          <p className="text-white font-medium">{job.requester.name}</p>
          <code className="text-xs text-gray-400 block mt-1 truncate">
            {job.requester.id}
          </code>
        </div>
        <div className="glass rounded-xl p-5 border border-brand-border">
          <p className="text-xs text-gray-500 mb-1 uppercase tracking-wider">Provider</p>
          <p className="text-white font-medium">{job.provider.name}</p>
          <code className="text-xs text-gray-400 block mt-1 truncate">
            {job.provider.id}
          </code>
        </div>
      </div>

      <div className="glass rounded-xl p-5 border border-brand-border">
        <p className="text-xs text-gray-500 mb-3 uppercase tracking-wider">Reward & Escrow</p>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div>
            <p className="text-xs text-gray-500">Reward</p>
            <p className="text-white font-medium text-sm mt-0.5">
              {reward?.amount ? `${reward.amount} ${reward.token ?? 'ETH'}` : '—'}
            </p>
          </div>
          <div>
            <p className="text-xs text-gray-500">Chain</p>
            <p className="text-white font-medium text-sm mt-0.5">
              {reward?.chainId ? CHAIN_NAMES[reward.chainId] ?? reward.chainId : '—'}
            </p>
          </div>
          <div>
            <p className="text-xs text-gray-500">Reservation</p>
            <p
              className={`font-medium text-sm mt-0.5 ${
                job.reservationStatus === 'PENDING'
                  ? 'text-yellow-400'
                  : job.reservationStatus === 'RELEASED'
                    ? 'text-brand-green'
                    : job.reservationStatus === 'CANCELLED'
                      ? 'text-gray-400'
                      : 'text-gray-600'
              }`}
            >
              {job.reservationStatus ?? '—'}
            </p>
          </div>
          <div>
            <p className="text-xs text-gray-500">Reserved Amount</p>
            <p className="text-white font-medium text-sm mt-0.5">
              {job.reservedAmount
                ? `${job.reservedAmount} ${job.reservedToken ?? 'ETH'}`
                : '—'}
            </p>
          </div>
        </div>
        {reservedChain && job.reservedAt && (
          <p className="text-[11px] text-gray-500 mt-3">
            Reserved on {reservedChain} at {new Date(job.reservedAt).toLocaleString()}
          </p>
        )}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="glass rounded-xl p-5 border border-brand-border">
          <p className="text-xs text-gray-500 mb-2 uppercase tracking-wider">Payload</p>
          <pre className="text-xs text-gray-300 font-mono bg-black/40 p-3 rounded overflow-x-auto max-h-64">
            {JSON.stringify(job.payload, null, 2)}
          </pre>
        </div>
        <div className="glass rounded-xl p-5 border border-brand-border">
          <p className="text-xs text-gray-500 mb-2 uppercase tracking-wider">Result</p>
          {job.result ? (
            <pre className="text-xs text-gray-300 font-mono bg-black/40 p-3 rounded overflow-x-auto max-h-64">
              {JSON.stringify(job.result, null, 2)}
            </pre>
          ) : (
            <p className="text-sm text-gray-600 italic">No result recorded.</p>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs text-gray-400">
        <div className="glass rounded-xl p-5 border border-brand-border">
          <p className="text-gray-500 mb-1 uppercase tracking-wider">Created</p>
          <p>{new Date(job.createdAt).toLocaleString()}</p>
        </div>
        <div className="glass rounded-xl p-5 border border-brand-border">
          <p className="text-gray-500 mb-1 uppercase tracking-wider">Last updated</p>
          <p>{new Date(job.updatedAt).toLocaleString()}</p>
        </div>
      </div>
    </div>
  );
}
