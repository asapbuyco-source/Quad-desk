
import React, { useState } from 'react';
import { RecentTrade } from '../types';
import { Activity, ArrowDown, ArrowUp, Zap, Filter } from 'lucide-react';
import { AnimatePresence, motion } from 'framer-motion';

interface TradeTapeProps {
  trades: RecentTrade[];
}

const TradeRow: React.FC<{ trade: RecentTrade }> = ({ trade }) => {
    const isBuy = trade.side === 'BUY';
    const isWhale = trade.isWhale;

    return (
        <motion.div 
            layout
            initial={{ opacity: 0, x: -10 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0 }}
            className={`
                flex items-center justify-between py-1.5 px-3 border-b border-white/5 text-xs font-mono
                ${isWhale ? 'bg-amber-500/10' : 'hover:bg-white/5'}
            `}
        >
            <div className="flex items-center gap-2 w-1/3">
                <span className="text-zinc-500 text-[10px]">
                    {new Date(trade.time).toLocaleTimeString([], { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                </span>
            </div>
            
            <div className={`flex items-center gap-1 w-1/3 font-bold ${isBuy ? 'text-trade-bid' : 'text-trade-ask'}`}>
                {isBuy ? <ArrowUp size={10} /> : <ArrowDown size={10} />}
                <span>{trade.price.toFixed(2)}</span>
            </div>

            <div className="flex items-center justify-end gap-2 w-1/3">
                <span className={`
                    ${isWhale ? 'font-black text-white' : 'text-zinc-400'}
                `}>
                    {trade.size.toFixed(4)}
                </span>
                {isWhale && (
                     <div className="p-0.5 rounded bg-amber-500/20 text-amber-500 animate-pulse">
                        <Zap size={8} fill="currentColor" />
                     </div>
                )}
            </div>
        </motion.div>
    );
};

const TradeTape: React.FC<TradeTapeProps> = ({ trades }) => {
  const [showWhalesOnly, setShowWhalesOnly] = useState(false);

  const displayedTrades = showWhalesOnly 
    ? trades.filter(t => t.isWhale) 
    : trades;

  return (
    <div className="fintech-card h-full flex flex-col overflow-hidden">
      <div className="px-4 py-3 border-b border-white/5 flex justify-between items-center bg-white/[0.02]">
        <div className="flex items-center gap-2">
            <Activity size={16} className="text-brand-accent" />
            <h3 className="text-sm font-bold text-white tracking-wide font-sans">Trade Tape</h3>
        </div>
        
        <button 
            onClick={() => setShowWhalesOnly(!showWhalesOnly)}
            className={`
                flex items-center gap-1.5 px-2 py-1 rounded-md text-[9px] font-bold uppercase tracking-wider border transition-all
                ${showWhalesOnly 
                    ? 'bg-amber-500/20 border-amber-500/50 text-amber-500 shadow-[0_0_10px_rgba(245,158,11,0.2)]' 
                    : 'bg-zinc-800 border-zinc-700 text-zinc-500 hover:text-zinc-300'}
            `}
        >
            <Filter size={10} />
            {showWhalesOnly ? 'Whales Only' : 'All Trades'}
        </button>
      </div>

      <div className="flex items-center justify-between px-3 py-2 bg-white/5 border-b border-white/5 text-[10px] font-bold text-zinc-500 uppercase tracking-wider">
          <span className="w-1/3">Time</span>
          <span className="w-1/3">Price</span>
          <span className="w-1/3 text-right">Size</span>
      </div>

      <div className="flex-1 overflow-y-auto scrollbar-hide">
         <AnimatePresence initial={false} mode="popLayout">
            {displayedTrades.map((trade) => (
                <TradeRow key={trade.id} trade={trade} />
            ))}
         </AnimatePresence>
         {displayedTrades.length === 0 && (
             <div className="h-full flex flex-col items-center justify-center text-zinc-600 gap-2 opacity-50 p-8 text-center">
                 <Filter size={24} />
                 <span className="text-xs font-mono">
                     {showWhalesOnly ? "Waiting for Whale Activity..." : "Waiting for trades..."}
                 </span>
             </div>
         )}
      </div>
    </div>
  );
};

export default TradeTape;
