"use client";

import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';

interface VolumePoint {
  date: string;
  volumeUsd: number;
}

async function fetchVolume(): Promise<VolumePoint[]> {
  try {
    const res = await fetch('/api/admin/volume', { cache: 'no-store' });
    if (!res.ok) return [];
    const data = await res.json() as { volume: VolumePoint[] };
    return data.volume;
  } catch {
    return [];
  }
}

const fallbackData = Array.from({ length: 7 }, (_, i) => {
  const d = new Date();
  d.setDate(d.getDate() - (6 - i));
  return { date: d.toISOString().slice(5, 10), volumeUsd: 0 };
});

export function VolumeChart() {
  const [data, setData] = useState(fallbackData);

  useEffect(() => {
    fetchVolume().then((rows) => {
      if (rows.length > 0) {
        setData(rows.map((r) => ({ ...r, date: r.date.slice(5) }))); // MM-DD format
      }
    });
  }, []);

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.6, delay: 0.3 }}
      className="w-full h-[350px] glass rounded-2xl p-6 relative group"
    >
      <div className="absolute right-0 top-0 w-64 h-64 bg-brand-purple/5 blur-3xl -z-10 rounded-full group-hover:bg-brand-purple/10 transition-colors duration-700" />

      <div className="mb-6">
        <h3 className="text-white font-bold text-lg">Transaction Volume</h3>
        <p className="text-gray-400 text-sm">Last 7 days</p>
      </div>

      <div className="h-[250px] w-full">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data} margin={{ top: 0, right: 0, left: -20, bottom: 0 }}>
            <defs>
              <linearGradient id="colorValue" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#00f0ff" stopOpacity={0.3} />
                <stop offset="95%" stopColor="#00f0ff" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="#222224" vertical={false} />
            <XAxis dataKey="date" stroke="#666" fontSize={12} tickLine={false} axisLine={false} />
            <YAxis stroke="#666" fontSize={12} tickLine={false} axisLine={false} tickFormatter={(v) => `$${v}`} />
            <Tooltip
              contentStyle={{ backgroundColor: '#0a0a0b', borderColor: '#222224', borderRadius: '8px', color: '#fff' }}
              itemStyle={{ color: '#00f0ff' }}
              formatter={(v: number) => [`$${v.toFixed(2)}`, 'Volume']}
            />
            <Area type="monotone" dataKey="volumeUsd" stroke="#00f0ff" strokeWidth={3} fillOpacity={1} fill="url(#colorValue)" />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </motion.div>
  );
}
