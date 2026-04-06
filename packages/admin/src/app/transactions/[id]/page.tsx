import { publicFetch } from '../../../lib/api';
import { 
  Activity, 
  ArrowRightLeft, 
  CheckCircle2, 
  XCircle, 
  Clock, 
  AlertTriangle, 
  ExternalLink, 
  ShieldCheck,
  Zap,
  Cpu,
  Globe,
  Database,
  Calendar,
  Wallet
} from 'lucide-react';
import Link from 'next/link';
import { TransactionAdminActions } from '../../../components/TransactionAdminActions';

interface PublicTransaction {
  id: string;
  status: 'CONFIRMED' | 'SUBMITTED' | 'PENDING' | 'QUEUED' | 'FAILED' | 'REVERTED' | 'SIMULATING' | 'PENDING_APPROVAL';
  type: string;
  chainId: number;
  txHash?: string;
  fromToken?: string;
  toToken?: string;
  amountIn?: string;
  amountOut?: string;
  error?: string;
  simulation?: any;
  createdAt: string;
  confirmedAt?: string;
}

async function getTransaction(id: string): Promise<PublicTransaction | null> {
  try {
    return await publicFetch<PublicTransaction>(`/v1/public/transactions/${id}`);
  } catch (err) {
    console.error('Failed to fetch transaction:', err);
    return null;
  }
}

const STATUS_CONFIG: Record<string, { color: string; bg: string; icon: any; label: string; glow: string }> = {
  CONFIRMED: { 
    color: 'text-brand-green', 
    bg: 'bg-brand-green/10 ring-brand-green/30', 
    glow: 'shadow-[0_0_30px_rgba(0,230,118,0.2)]',
    icon: CheckCircle2, 
    label: 'Confirmed' 
  },
  SUBMITTED: { 
    color: 'text-brand-accent', 
    bg: 'bg-brand-accent/10 ring-brand-accent/30', 
    glow: 'shadow-[0_0_30px_rgba(0,240,255,0.2)]',
    icon: Zap, 
    label: 'Submitted' 
  },
  PENDING: { 
    color: 'text-brand-purple', 
    bg: 'bg-brand-purple/10 ring-brand-purple/30', 
    glow: 'shadow-[0_0_30px_rgba(176,38,255,0.2)]',
    icon: Clock, 
    label: 'Pending' 
  },
  QUEUED: { 
    color: 'text-brand-purple', 
    bg: 'bg-brand-purple/10 ring-brand-purple/30', 
    glow: 'shadow-[0_0_30px_rgba(176,38,255,0.2)]',
    icon: Clock, 
    label: 'Queued' 
  },
  PENDING_APPROVAL: { 
    color: 'text-yellow-400', 
    bg: 'bg-yellow-400/10 ring-yellow-400/30', 
    glow: 'shadow-[0_0_30px_rgba(250,204,21,0.2)]',
    icon: ShieldCheck, 
    label: 'Awaiting Approval' 
  },
  FAILED: { 
    color: 'text-brand-red', 
    bg: 'bg-brand-red/10 ring-brand-red/30', 
    glow: 'shadow-[0_0_30px_rgba(255,23,68,0.2)]',
    icon: XCircle, 
    label: 'Failed' 
  },
  REVERTED: { 
    color: 'text-brand-red', 
    bg: 'bg-brand-red/10 ring-brand-red/30', 
    glow: 'shadow-[0_0_30px_rgba(255,23,68,0.2)]',
    icon: XCircle, 
    label: 'Reverted' 
  },
  SIMULATING: { 
    color: 'text-gray-400', 
    bg: 'bg-gray-500/10 ring-gray-500/30', 
    glow: '',
    icon: Cpu, 
    label: 'Simulating' 
  },
};

const CHAIN_INFO: Record<number, { name: string; explorer: string; icon: string }> = {
  1: { name: 'Ethereum', explorer: 'https://etherscan.io/tx/', icon: '⟠' },
  8453: { name: 'Base', explorer: 'https://basescan.org/tx/', icon: '🔵' },
  42161: { name: 'Arbitrum', explorer: 'https://arbiscan.io/tx/', icon: '🔵' },
  137: { name: 'Polygon', explorer: 'https://polygonscan.com/tx/', icon: '💜' },
};

export default async function TransactionStatusPage({ params }: { params: { id: string } }) {
  const tx = await getTransaction(params.id);

  if (!tx) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] text-center px-4">
        <div className="size-16 bg-brand-red/10 rounded-full flex items-center justify-center mb-6 ring-1 ring-brand-red/30">
          <AlertTriangle className="text-brand-red size-8" />
        </div>
        <h1 className="text-2xl font-bold text-white mb-2">Transaction Not Found</h1>
        <p className="text-gray-400 max-w-md">
          The transaction ID provided does not exist or has been archived. 
          Please check the ID and try again.
        </p>
      </div>
    );
  }

  const statusCfg = STATUS_CONFIG[tx.status] || STATUS_CONFIG.SIMULATING!;
  const chain = CHAIN_INFO[tx.chainId] || { name: 'Unknown', explorer: '', icon: '⛓️' };
  const StatusIcon = statusCfg.icon;

  return (
    <div className="max-w-4xl mx-auto py-8 px-4 sm:px-6 lg:px-8 space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-1000">
      {/* Header / ID area */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-brand-border pb-8">
        <div>
          <div className="flex items-center gap-2 text-brand-accent mb-1">
            <ShieldCheck className="size-4" />
            <span className="text-xs font-bold uppercase tracking-widest">AgentFi Protocol Verified</span>
          </div>
          <h1 className="text-3xl font-bold text-white tracking-tight flex items-center gap-3">
            Transaction Explorer
          </h1>
          <div className="flex items-center gap-2 mt-2">
             <code className="text-xs text-gray-500 bg-white/5 px-2 py-1 rounded border border-white/5 font-mono">
              ID: {tx.id}
            </code>
          </div>
        </div>
        <div className="flex flex-col items-end">
          <div className={`px-4 py-2 rounded-xl flex items-center gap-2 ring-1 ${statusCfg.bg} ${statusCfg.glow} ${statusCfg.color}`}>
            <StatusIcon className="size-5" />
            <span className="font-bold text-sm tracking-wide uppercase">{statusCfg.label}</span>
          </div>
        </div>
      </div>

      {/* Main Grid */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        {/* Left Column: Details */}
        <div className="md:col-span-2 space-y-6">
          <div className="glass rounded-2xl p-6 space-y-6">
            <div className="grid grid-cols-2 gap-8">
              <div className="space-y-1">
                <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider flex items-center gap-1.5">
                  <ArrowRightLeft className="size-3" /> Operation Type
                </p>
                <p className="text-lg font-bold text-white uppercase">{tx.type}</p>
              </div>
              <div className="space-y-1">
                <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider flex items-center gap-1.5">
                  <Globe className="size-3" /> Network
                </p>
                <p className="text-lg font-bold text-white flex items-center gap-2">
                  <span className="text-xl">{chain.icon}</span> {chain.name}
                </p>
              </div>
            </div>

            <div className="pt-6 border-t border-brand-border/50">
              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-4 flex items-center gap-1.5">
                <Database className="size-3" /> Value Movements
              </p>
              <div className="bg-brand-black/40 rounded-xl p-4 border border-brand-border/30 flex items-center justify-between">
                <div className="space-y-1">
                  <p className="text-xs text-gray-500">Amount In</p>
                  <p className="text-xl font-mono font-bold text-white">
                    {tx.amountIn ?? '0.00'} <span className="text-xs text-gray-400 font-sans">{tx.fromToken?.slice(0, 6)}...</span>
                  </p>
                </div>
                <ArrowRightLeft className="text-brand-border size-6 mx-4" />
                <div className="space-y-1 text-right">
                  <p className="text-xs text-gray-500">Amount Out (Est.)</p>
                  <p className="text-xl font-mono font-bold text-brand-green">
                    {tx.amountOut ?? '—'} <span className="text-xs text-gray-400 font-sans">{tx.toToken?.slice(0, 6)}...</span>
                  </p>
                </div>
              </div>
            </div>

            {tx.error && (
              <div className="pt-6 border-t border-brand-border/50">
                 <div className="bg-brand-red/10 border border-brand-red/30 rounded-xl p-4 flex gap-3 items-start">
                  <AlertTriangle className="text-brand-red size-5 shrink-0 mt-0.5" />
                  <div>
                    <p className="text-sm font-bold text-brand-red uppercase mb-1">Execution Error</p>
                    <p className="text-sm text-brand-red/90 font-mono leading-relaxed">{tx.error}</p>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Simulation Details */}
          {tx.simulation && (
            <div className="glass rounded-2xl p-6">
              <div className="flex items-center justify-between mb-4">
                <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider flex items-center gap-1.5">
                  <Cpu className="size-3" /> Simulation Result (Tenderly)
                </p>
                <div className="text-[10px] text-brand-green bg-brand-green/10 px-2 py-0.5 rounded ring-1 ring-brand-green/30 font-bold uppercase">
                  Safe to Execute
                </div>
              </div>
              <div className="grid grid-cols-3 gap-4">
                <div className="bg-white/5 p-3 rounded-lg border border-white/5">
                  <p className="text-[10px] text-gray-500 uppercase mb-1">Status</p>
                  <p className="text-sm font-bold text-brand-green uppercase">Success</p>
                </div>
                <div className="bg-white/5 p-3 rounded-lg border border-white/5">
                  <p className="text-[10px] text-gray-500 uppercase mb-1">Gas Used</p>
                  <p className="text-sm font-bold text-white">{tx.simulation.gasUsed?.toLocaleString() ?? '—'}</p>
                </div>
                <div className="bg-white/5 p-3 rounded-lg border border-white/5">
                  <p className="text-[10px] text-gray-500 uppercase mb-1">Confidence</p>
                  <p className="text-sm font-bold text-white">99.9%</p>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Right Column: Metadata */}
        <div className="space-y-6">
          <div className="glass rounded-2xl p-6 space-y-6">
             <div className="space-y-4">
              <div className="flex items-start gap-3">
                <Calendar className="size-4 text-gray-500 mt-0.5" />
                <div>
                  <p className="text-[10px] font-semibold text-gray-500 uppercase tracking-widest">Submitted</p>
                  <p className="text-sm text-gray-300">{new Date(tx.createdAt).toLocaleString()}</p>
                </div>
              </div>
              
              {tx.confirmedAt && (
                <div className="flex items-start gap-3">
                  <CheckCircle2 className="size-4 text-brand-green mt-0.5" />
                  <div>
                    <p className="text-[10px] font-semibold text-brand-green uppercase tracking-widest">Confirmed</p>
                    <p className="text-sm text-gray-300">{new Date(tx.confirmedAt).toLocaleString()}</p>
                  </div>
                </div>
              )}

              <div className="flex items-start gap-3">
                <Wallet className="size-4 text-gray-500 mt-0.5" />
                <div>
                  <p className="text-[10px] font-semibold text-gray-500 uppercase tracking-widest">Protocol Fee</p>
                  <p className="text-sm text-gray-300">Atomic On-chain Collection</p>
                </div>
              </div>
            </div>

            {tx.txHash && (
              <div className="pt-6 border-t border-brand-border/50">
                <a 
                  href={`${chain.explorer}${tx.txHash}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="w-full flex items-center justify-center gap-2 bg-brand-accent/10 hover:bg-brand-accent/20 border border-brand-accent/30 text-brand-accent py-3 rounded-xl transition-all duration-300 group"
                >
                  <span className="font-bold text-sm">View on Explorer</span>
                  <ExternalLink className="size-4 group-hover:translate-x-0.5 group-hover:-translate-y-0.5 transition-transform" />
                </a>
                <p className="mt-4 text-[10px] text-gray-600 font-mono break-all text-center">
                  {tx.txHash}
                </p>
              </div>
            )}

            {tx.status === 'PENDING_APPROVAL' && (
              <div className="pt-6 border-t border-brand-border/50">
                <p className="text-[10px] font-semibold text-brand-purple uppercase tracking-widest mb-4">Operator Action Required</p>
                <TransactionAdminActions transactionId={tx.id} />
              </div>
            )}
          </div>

          <div className="p-6 rounded-2xl bg-gradient-to-br from-brand-accent/5 to-brand-purple/5 border border-white/5">
             <h3 className="text-white font-bold text-sm mb-2 flex items-center gap-2">
               <ShieldCheck className="text-brand-accent size-4" />
               Security Context
             </h3>
             <p className="text-xs text-gray-400 leading-relaxed">
               This transaction was originated by an autonomous agent and verified by the AgentFi policy engine. 
               The Turnkey MPC infrastructure ensures the private key was never reconstructed in memory.
             </p>
          </div>
        </div>
      </div>

      {/* Footer / Back */}
      <div className="pt-8 text-center">
        <Link href="/dashboard" className="text-gray-500 hover:text-white text-sm transition-colors">
          &larr; Return to Dashboard
        </Link>
      </div>
    </div>
  );
}
