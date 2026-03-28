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
    }>;
  } catch {
    return {
      status: 'unreachable',
      checks: { database: false, redis: false, rpc: false, turnkey: false },
      timestamp: new Date().toISOString(),
    };
  }
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

      <p className="text-gray-500 text-xs">Last checked: {new Date(health.timestamp).toLocaleString()}</p>
    </div>
  );
}
