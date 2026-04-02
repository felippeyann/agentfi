"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { signOut } from "next-auth/react";
import { motion } from "framer-motion";
import { LayoutDashboard, Users, Activity, ShieldCheck, Settings } from "lucide-react";
import { cn } from "../lib/utils";

const navItems = [
  { name: "Overview", href: "/dashboard", icon: LayoutDashboard },
  { name: "Agents", href: "/agents", icon: Users },
  { name: "Transactions", href: "/transactions", icon: Activity },
  { name: "Health", href: "/health", icon: ShieldCheck },
  { name: "Settings", href: "/settings", icon: Settings },
];

export function Sidebar() {
  const pathname = usePathname();
  if (pathname === "/login") return null;

  return (
    <aside className="w-64 h-screen border-r border-brand-border bg-brand-black flex flex-col pt-6 px-4 shrink-0 transition-all duration-300">
      <div className="flex items-center gap-2 px-2 mb-10">
        <div className="size-8 rounded bg-gradient-to-br from-brand-accent to-brand-purple flex items-center justify-center p-[1px]">
          <div className="w-full h-full bg-brand-black rounded flex items-center justify-center">
            <ShieldCheck className="text-brand-accent size-5" />
          </div>
        </div>
        <span className="text-white font-bold text-xl tracking-tight">AgentFi</span>
      </div>

      <nav className="flex-1 space-y-2">
        {navItems.map((item) => {
          const isActive = pathname === item.href || pathname.startsWith(item.href + "/");

          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "relative flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors z-10",
                isActive ? "text-white" : "text-gray-400 hover:text-white hover:bg-white/5"
              )}
            >
              <item.icon className={cn("size-4", isActive ? "text-brand-accent" : "text-gray-400")} />
              {item.name}

              {isActive && (
                <motion.div
                  layoutId="sidebar-active-tab"
                  className="absolute inset-0 bg-brand-accent/10 rounded-lg border border-brand-accent/20 -z-10"
                  initial={false}
                  transition={{ type: "spring", stiffness: 300, damping: 30 }}
                />
              )}
            </Link>
          );
        })}
      </nav>

      <div className="pb-6">
        <div className="p-4 rounded-xl glass relative overflow-hidden group">
          <div className="absolute inset-0 bg-gradient-to-r from-brand-accent/10 to-transparent opacity-0 group-hover:opacity-100 transition-opacity" />
          <p className="text-xs text-gray-400">Operator Tier</p>
          <div className="flex items-center gap-2 mt-1">
            <div className="size-2 rounded-full bg-brand-green animate-pulse" />
            <p className="text-sm text-white font-medium">Enterprise</p>
          </div>
        </div>

        <button
          type="button"
          onClick={() => signOut({ callbackUrl: "/login" })}
          className="mt-3 w-full rounded-lg border border-brand-border bg-white/5 px-3 py-2 text-sm text-gray-200 transition hover:bg-white/10"
        >
          Sign out
        </button>
      </div>
    </aside>
  );
}
