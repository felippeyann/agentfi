export default function SettingsPage() {
  return (
    <div className="space-y-6 animate-in fade-in duration-700 max-w-2xl">
      <div>
        <h1 className="text-3xl font-bold tracking-tight text-white mb-1">Settings</h1>
        <p className="text-gray-400">Operator configuration and protocol parameters.</p>
      </div>

      <div className="glass rounded-xl p-6 space-y-4">
        <h2 className="text-white font-semibold text-lg">Protocol</h2>
        <div className="space-y-3 text-sm">
          <div className="flex justify-between items-center py-3 border-b border-brand-border">
            <span className="text-gray-400">Fee (FREE tier)</span>
            <span className="text-white font-mono">0.30%</span>
          </div>
          <div className="flex justify-between items-center py-3 border-b border-brand-border">
            <span className="text-gray-400">Fee (PRO tier)</span>
            <span className="text-white font-mono">0.15%</span>
          </div>
          <div className="flex justify-between items-center py-3 border-b border-brand-border">
            <span className="text-gray-400">Fee (ENTERPRISE tier)</span>
            <span className="text-white font-mono">0.05%</span>
          </div>
          <div className="flex justify-between items-center py-3 border-b border-brand-border">
            <span className="text-gray-400">Fee Wallet</span>
            <span className="text-white font-mono text-xs">0xD73d0cBF9C3fa2932eA54b6dfe70fa7e45bF8646</span>
          </div>
          <div className="flex justify-between items-center py-3">
            <span className="text-gray-400">Network</span>
            <span className="text-white font-mono">Base Mainnet (8453)</span>
          </div>
        </div>
      </div>

      <div className="glass rounded-xl p-6 space-y-4">
        <h2 className="text-white font-semibold text-lg">Environment</h2>
        <p className="text-gray-500 text-sm">
          Configure environment variables in Railway (backend) and Vercel (admin panel).
          Never commit secrets to the repository.
        </p>
        <div className="bg-black/40 rounded-lg p-4 text-xs font-mono text-gray-400 space-y-1">
          <p>RAILWAY → agentfi backend service → Variables</p>
          <p>VERCEL → agentfi-admin → Settings → Environment Variables</p>
        </div>
      </div>
    </div>
  );
}
