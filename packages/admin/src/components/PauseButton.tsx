'use client';

import { useState } from 'react';

/** Backend response of POST /admin/agents/:id/pause (toggle). The policy fields are present only when it resumed. */
type ToggleResponse = { active: boolean; policyReactivated?: boolean; policyNote?: string };

export function PauseButton({ agentId, isActive }: { agentId: string; isActive: boolean }) {
  const [active, setActive] = useState(isActive);
  const [loading, setLoading] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const toggle = async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/agents/${agentId}/pause`, { method: 'POST' });
      if (res.ok) {
        const data = (await res.json()) as ToggleResponse;
        setActive(data.active);
        // A resume that did not re-activate the DB policy leaves the agent
        // blocked; show the backend's explanation next to the green state.
        setNote(data.active && data.policyReactivated === false ? data.policyNote ?? null : null);
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex flex-col items-end gap-1">
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
      {note && <p className="text-xs text-amber-400 max-w-xs text-right">{note}</p>}
    </div>
  );
}
