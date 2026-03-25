"use client";

import { motion } from "framer-motion";
import { cn } from "../lib/utils";

interface StatCardProps {
  label: string;
  value: string;
  sub?: string;
  icon?: React.ReactNode;
  delay?: number;
}

export function StatCard({ label, value, sub, icon, delay = 0 }: StatCardProps) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, delay, ease: [0.23, 1, 0.32, 1] }}
      className={cn(
        "relative overflow-hidden rounded-2xl glass p-5 group transition-all duration-300",
        "hover:border-brand-accent/30 hover:shadow-[0_0_30px_rgba(0,240,255,0.05)]"
      )}
    >
      {/* Background Glow */}
      <div className="absolute -inset-x-10 -inset-y-10 bg-gradient-to-r from-brand-accent/0 to-brand-accent/5 opacity-0 group-hover:opacity-100 blur-2xl transition-opacity duration-500" />
      
      <div className="relative z-10 flex flex-col h-full">
        <div className="flex justify-between items-start mb-4">
          <p className="text-gray-400 text-xs font-semibold uppercase tracking-wider">{label}</p>
          {icon && (
            <div className="p-2 rounded-lg bg-white/5 text-gray-400 group-hover:text-brand-accent group-hover:bg-brand-accent/10 transition-colors">
              {icon}
            </div>
          )}
        </div>
        
        <p className="text-3xl font-bold text-white tracking-tight">{value}</p>
        
        {sub && (
          <p className="text-gray-500 text-sm mt-2 font-medium">{sub}</p>
        )}
      </div>
    </motion.div>
  );
}
