async function getHealthStatus() {
  try {
    const res = await fetch(
      `${process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:3000'}/health/ready`,
      { cache: 'no-store' },
    );
    return res.json() as Promise<{
      status: string;
      checks: Record<string, boolean>;
      timestamp: string;
      escrowConfig?: EscrowChainState[];
    }>;
  } catch {
    return {
      status: 'unreachable',
      checks: { database: false, redis: false, rpc: false, turnkey: false },
      timestamp: new Date().toISOString(),
      escrowConfig: [] as EscrowChainState[],
    };
  }
}

/** Q7: the API process's verification of each ERC-8183 chain (`/health/ready` `escrowConfig`). */
interface EscrowChainState {
  chainId: number;
  state: string;
  allowed: boolean;
  verifiedAt: string | null;
  validUntil: string | null;
  since: string | null;
}

function EscrowChainRow({ chain }: { chain: EscrowChainState }) {
  const detail = chain.allowed
    ? `verified ${chain.verifiedAt ? new Date(chain.verifiedAt).toLocaleTimeString() : ''}, valid until ${chain.validUntil ? new Date(chain.validUntil).toLocaleTimeString() : '-'}`
    : `${chain.state}${chain.since ? ` since ${new Date(chain.since).toLocaleString()}` : ''} — new escrow jobs, escrow transactions and settlements wait`;
  return (
    <div className="flex items-center justify-between px-4 py-3 border-b border-gray-800 last:border-0">
      <span className="text-gray-300">Chain {chain.chainId}</span>
      <span className={`text-sm font-medium ${chain.allowed ? 'text-green-400' : 'text-red-400'}`}>{detail}</span>
    </div>
  );
}

function ServiceRow({ name, healthy }: { name: string; healthy: boolean }) {
  return (
    <div className="flex items-center justify-between px-4 py-3 border-b border-gray-800 last:border-0">
      <span className="text-gray-300 capitalize">{name}</span>
      <span
        className={`text-sm font-medium ${healthy ? 'text-green-400' : 'text-red-400'}`}
      >
        {healthy ? 'healthy' : 'down'}
      </span>
    </div>
  );
}

export default async function HealthPage() {
  const health = await getHealthStatus();
  const allHealthy = health.status === 'ready';

  return (
    <div className="space-y-4 max-w-lg">
      <div className="flex items-center gap-3">
        <h1 className="text-xl font-bold text-white">System Health</h1>
        <span
          className={`text-sm px-2 py-0.5 rounded ${
            allHealthy ? 'bg-green-900 text-green-300' : 'bg-red-900 text-red-300'
          }`}
        >
          {health.status}
        </span>
      </div>

      <div className="border border-gray-800 rounded-lg bg-gray-900">
        {Object.entries(health.checks).map(([name, healthy]) => (
          <ServiceRow key={name} name={name} healthy={healthy} />
        ))}
      </div>

      {health.escrowConfig && health.escrowConfig.length > 0 && (
        <>
          <h2 className="text-sm font-semibold text-gray-300 pt-2">ERC-8183 on-chain configuration (API process)</h2>
          <div className="border border-gray-800 rounded-lg bg-gray-900">
            {health.escrowConfig.map((chain) => (
              <EscrowChainRow key={chain.chainId} chain={chain} />
            ))}
          </div>
          <p className="text-gray-500 text-xs">
            Reasons: <code>GET /admin/escrow/verification</code>. The worker verifies on its own (logs and ESCROW_ALERT notifications).
          </p>
        </>
      )}

      <p className="text-gray-500 text-xs">Last checked: {new Date(health.timestamp).toLocaleString()}</p>
    </div>
  );
}
