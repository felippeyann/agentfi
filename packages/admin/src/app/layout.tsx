import type { Metadata, Viewport } from 'next';
import './globals.css';
import { Sidebar } from '../components/Sidebar';

export const metadata: Metadata = {
  title: 'AgentFi — Operator Dashboard',
  description: 'Monitor and manage AI agent wallets and transactions',
};

export const viewport: Viewport = {
  themeColor: '#0a0a0b',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body className="bg-brand-black text-white min-h-screen font-sans flex antialiased">
        <Sidebar />
        
        <main className="flex-1 flex flex-col h-screen overflow-hidden">
          {/* Topbar/Header area could go here, for now it's just content area */}
          <div className="flex-1 overflow-y-auto p-8 relative">
            {/* Subtle background glow */}
            <div className="absolute top-0 left-1/4 w-[400px] h-[300px] bg-brand-accent/5 rounded-full blur-[100px] pointer-events-none -z-10" />
            <div className="absolute top-1/4 right-0 w-[500px] h-[400px] bg-brand-purple/5 rounded-full blur-[120px] pointer-events-none -z-10" />
            
            {children}
          </div>
        </main>
      </body>
    </html>
  );
}
