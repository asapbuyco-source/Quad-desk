import React from 'react';
import { ShieldCheck, ChevronDown, Bell } from 'lucide-react';
import { MarketMetrics } from '../types';

interface HeaderProps {
  metrics: MarketMetrics;
}

const Header: React.FC<HeaderProps> = ({ metrics }) => {
  return (
    <header className="h-20 flex items-center justify-between px-2 lg:px-6 shrink-0">
      
      {/* Left: Ticker & Price */}
      <div className="flex flex-col">
        <div className="flex items-center gap-2 text-slate-400 text-xs font-semibold tracking-wider uppercase mb-1">
            <span>Market Overview</span>
            <ChevronDown size={12} />
        </div>
        <div className="flex items-end gap-4">
          <h1 className="text-3xl font-bold text-white tracking-tight font-sans">
            {metrics.pair}
          </h1>
          <div className="flex items-center gap-3 pb-1">
            <span className="text-2xl font-mono font-medium text-white tracking-tight">
                ${metrics.price.toFixed(2)}
            </span>
            <div className={`
                flex items-center px-2 py-0.5 rounded-full text-xs font-bold font-mono
                ${metrics.change >= 0 ? 'bg-trade-bid/20 text-trade-bid' : 'bg-trade-ask/20 text-trade-ask'}
            `}>
                {metrics.change > 0 ? '+' : ''}{metrics.change}%
            </div>
          </div>
        </div>
      </div>

      {/* Right: Actions */}
      <div className="flex items-center gap-4">
        
        {/* Status Pill */}
        <div className="hidden lg:flex items-center gap-2 px-3 py-1.5 rounded-full bg-white/5 border border-white/5">
             <div className="w-2 h-2 rounded-full bg-brand-accent animate-pulse"></div>
             <span className="text-xs font-medium text-slate-300">Live Connection</span>
        </div>

        {/* Notifications */}
        <button className="relative p-2 rounded-full hover:bg-white/10 transition-colors text-slate-300">
            <Bell size={20} />
            <span className="absolute top-2 right-2 w-2 h-2 rounded-full bg-trade-ask border-2 border-[#0B101B]"></span>
        </button>

        {/* Profile Avatar */}
        <div className="w-9 h-9 rounded-full bg-gradient-to-tr from-brand-accent to-purple-500 border border-white/20"></div>
      </div>
    </header>
  );
};

export default Header;