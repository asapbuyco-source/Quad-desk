import React, { useState } from 'react';
import { ChevronDown, Bell, History, Radio, Check, Calendar, Play } from 'lucide-react';
import { MarketMetrics } from '../types';
import { AnimatePresence, motion } from 'framer-motion';

interface HeaderProps {
  metrics: MarketMetrics;
  isBacktest: boolean;
  onToggleBacktest: () => void;
  activeSymbol: string;
  onSymbolChange: (symbol: string) => void;
  playbackSpeed?: number;
  onPlaybackSpeedChange?: (speed: number) => void;
  backtestDate?: string;
  onBacktestDateChange?: (date: string) => void;
}

const ASSETS = [
    { id: 'BTCUSDT', label: 'BTC/USDT', name: 'Bitcoin' },
    { id: 'ETHUSDT', label: 'ETH/USDT', name: 'Ethereum' },
    { id: 'SOLUSDT', label: 'SOL/USDT', name: 'Solana' },
];

const Header: React.FC<HeaderProps> = ({ 
    metrics, 
    isBacktest, 
    onToggleBacktest, 
    activeSymbol, 
    onSymbolChange,
    playbackSpeed = 1,
    onPlaybackSpeedChange,
    backtestDate,
    onBacktestDateChange
}) => {
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);

  return (
    <header className="h-16 lg:h-20 flex items-center justify-between px-4 lg:px-6 shrink-0 bg-transparent relative z-40 border-b border-white/5 lg:border-none">
      
      {/* Left: Ticker & Price */}
      <div className="flex flex-col justify-center relative">
        <button 
            onClick={() => setIsDropdownOpen(!isDropdownOpen)}
            className="flex items-center gap-2 text-slate-400 text-[10px] lg:text-xs font-semibold tracking-wider uppercase mb-0.5 lg:mb-1 hover:text-white transition-colors"
        >
            <span>Market Overview</span>
            <ChevronDown size={12} className={`w-3 h-3 lg:w-auto lg:h-auto transition-transform ${isDropdownOpen ? 'rotate-180' : ''}`} />
        </button>

        {/* Asset Dropdown */}
        <AnimatePresence>
            {isDropdownOpen && (
                <>
                    <div className="fixed inset-0 z-40" onClick={() => setIsDropdownOpen(false)} />
                    <motion.div
                        initial={{ opacity: 0, y: -10 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -10 }}
                        className="absolute top-full left-0 mt-2 w-48 bg-[#09090b] border border-white/10 rounded-xl shadow-2xl z-50 overflow-hidden py-1"
                    >
                        <div className="px-3 py-2 text-[10px] font-bold text-slate-500 uppercase tracking-widest border-b border-white/5">
                            Select Asset
                        </div>
                        {ASSETS.map((asset) => (
                            <button
                                key={asset.id}
                                onClick={() => {
                                    onSymbolChange(asset.id);
                                    setIsDropdownOpen(false);
                                }}
                                className="w-full flex items-center justify-between px-4 py-3 hover:bg-white/5 transition-colors group"
                            >
                                <div className="flex flex-col items-start">
                                    <span className={`text-sm font-bold ${activeSymbol === asset.id ? 'text-white' : 'text-slate-400 group-hover:text-zinc-200'}`}>
                                        {asset.label}
                                    </span>
                                    <span className="text-[10px] text-slate-600 font-mono">{asset.name}</span>
                                </div>
                                {activeSymbol === asset.id && <Check size={14} className="text-brand-accent" />}
                            </button>
                        ))}
                    </motion.div>
                </>
            )}
        </AnimatePresence>

        <div className="flex items-baseline gap-2 lg:gap-4">
          <h1 className="text-xl lg:text-3xl font-bold text-white tracking-tight font-sans">
            {metrics.pair}
          </h1>
          <div className="flex items-center gap-2 lg:gap-3">
            <span className="text-base lg:text-2xl font-mono font-medium text-white tracking-tight">
                ${metrics.price.toFixed(2)}
            </span>
            <div className={`
                flex items-center px-1.5 lg:px-2 py-0.5 rounded-full text-[10px] lg:text-xs font-bold font-mono
                ${metrics.change > 0 
                    ? 'bg-trade-bid/20 text-trade-bid' 
                    : metrics.change < 0 
                        ? 'bg-trade-ask/20 text-trade-ask' 
                        : 'bg-zinc-500/20 text-zinc-400'}
            `}>
                {metrics.change > 0 ? '+' : ''}{metrics.change}%
            </div>
          </div>
        </div>
      </div>

      {/* Center: Backtest Controls (Only Visible in Backtest Mode) */}
      {isBacktest && (
        <motion.div 
            initial={{ opacity: 0, y: -20, x: "-50%" }}
            animate={{ opacity: 1, y: 0, x: "-50%" }}
            exit={{ opacity: 0, y: -20, x: "-50%" }}
            className="hidden md:flex absolute left-1/2 top-1/2 -translate-y-1/2 items-center gap-4 bg-[#09090b]/80 border border-amber-500/20 rounded-full py-2 px-5 shadow-[0_8px_30px_rgb(0,0,0,0.5)] backdrop-blur-xl z-30"
        >
            {/* Date Selection */}
            <div className="flex items-center gap-3 pr-4 border-r border-white/10 group">
                <Calendar size={14} className="text-amber-500" />
                <div className="relative">
                    <span className="text-[10px] text-zinc-500 uppercase font-bold tracking-wider absolute -top-2 left-0 scale-75 origin-left">Start Date</span>
                    <input 
                        type="date" 
                        value={backtestDate}
                        onChange={(e) => onBacktestDateChange?.(e.target.value)}
                        className="bg-transparent text-xs font-mono text-zinc-200 focus:outline-none [&::-webkit-calendar-picker-indicator]:invert [&::-webkit-calendar-picker-indicator]:cursor-pointer [&::-webkit-calendar-picker-indicator]:opacity-50 hover:[&::-webkit-calendar-picker-indicator]:opacity-100"
                    />
                </div>
            </div>

            {/* Playback Speed */}
            <div className="flex items-center gap-2">
                <div className="p-1.5 rounded-full bg-amber-500/10 text-amber-500 animate-pulse">
                    <Play size={10} fill="currentColor" />
                </div>
                <div className="flex items-center gap-1 bg-white/5 rounded-lg p-0.5">
                    {[0.5, 1, 5, 10].map(speed => (
                        <button
                            key={speed}
                            onClick={() => onPlaybackSpeedChange?.(speed)}
                            className={`
                                px-2 py-1 text-[10px] font-bold rounded-md transition-all
                                ${playbackSpeed === speed 
                                    ? 'bg-amber-500 text-black shadow-sm' 
                                    : 'text-zinc-500 hover:text-white hover:bg-white/10'}
                            `}
                        >
                            {speed}x
                        </button>
                    ))}
                </div>
            </div>
        </motion.div>
      )}

      {/* Right: Actions */}
      <div className="flex items-center gap-2 lg:gap-4">
        
        {/* Backtest Toggle */}
        <button 
          onClick={onToggleBacktest}
          className={`
            flex items-center gap-2 px-2 lg:px-3 py-1.5 rounded-full border transition-all relative z-10
            ${isBacktest 
                ? 'bg-amber-500/20 border-amber-500/50 text-amber-500 shadow-[0_0_15px_rgba(245,158,11,0.2)]' 
                : 'bg-white/5 border-white/5 text-slate-400 hover:bg-white/10'}
          `}
        >
             {isBacktest ? (
                 <>
                    <History size={14} className="animate-spin-slow" />
                    <span className="hidden lg:inline text-xs font-bold uppercase">Replay Mode</span>
                 </>
             ) : (
                 <>
                    <Radio size={14} />
                    <span className="hidden lg:inline text-xs font-medium">Live Feed</span>
                 </>
             )}
        </button>

        {/* Status Pill (Desktop Only) */}
        {!isBacktest && (
            <div className="hidden lg:flex items-center gap-2 px-3 py-1.5 rounded-full bg-white/5 border border-white/5">
                 <div className="w-2 h-2 rounded-full bg-brand-accent animate-pulse"></div>
                 <span className="text-xs font-medium text-slate-300">Connected</span>
            </div>
        )}

        {/* Notifications */}
        <button className="relative p-2 rounded-full hover:bg-white/10 transition-colors text-slate-300">
            <Bell size={20} className="w-5 h-5 lg:w-5 lg:h-5" />
            <span className="absolute top-2 right-2 w-1.5 h-1.5 lg:w-2 lg:h-2 rounded-full bg-trade-ask border-2 border-[#0B101B]"></span>
        </button>

        {/* Profile Avatar */}
        <div className="w-8 h-8 lg:w-9 lg:h-9 rounded-full bg-gradient-to-tr from-brand-accent to-purple-500 border border-white/20"></div>
      </div>
    </header>
  );
};

export default Header;