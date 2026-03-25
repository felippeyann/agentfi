'use client';

import { useState } from 'react';

export function PauseButton({ agentId, isActive }: { agentId: string; isActive: boolean }) {
  const [active, setActive] = useState(isActive);
  const [loading, setLoading] = useState(false);

  const toggle = async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/agents/${agentId}/pause`, { method: 'POST' });
      if (res.ok) {
        const data = (await res.json()) as { active: boolean };
        setActive(data.active);
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <button
      onClick={toggle}
      disabled={loading}
      className={`px-3 py-1.5 text-sm rounded transition-colors disabled:opacity-50 ${
        active
          ? 'bg-red-900 text-red-300 hover:bg-red-800'
          : 'bg-green-900 text-green-300 hover:bg-green-800'
      }`}
    >
      {loading ? '...' : active ? 'Pause Agent' : 'Resume Agent'}
    </button>
  );
}
