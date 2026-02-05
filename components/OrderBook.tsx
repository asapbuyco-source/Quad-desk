import React from 'react';
import { OrderBookLevel } from '../types';
import { ArrowDownUp, Layers } from 'lucide-react';
import { AnimatePresence } from 'framer-motion';

interface OrderBookProps {
  asks: OrderBookLevel[];
  bids: OrderBookLevel[];
}

const OrderRow: React.FC<{ level: OrderBookLevel; type: 'ask' | 'bid' }> = ({ level, type }) => {
  const depthWidth = Math.min((level.size / 600) * 100, 100);
  const isBid = type === 'bid';
  const isWall = level.isLiquidityWall;

  return (
    <div className={`
        relative flex justify-between items-center text-xs font-mono py-1.5 px-4 transition-all cursor-pointer group
        ${isWall
            ? (isBid
                ? 'bg-emerald-500/10 border-y border-emerald-500/30 my-1 shadow-[0_0_15px_rgba(16,185,129,0.1)] z-10'
                : 'bg-rose-500/10 border-y border-rose-500/30 my-1 shadow-[0_0_15px_rgba(244,63,94,0.1)] z-10')
            : 'hover:bg-white/5 border-y border-transparent'
        }
    `}>
      {/* Depth Bar */}
      <div 
        className={`absolute top-1 bottom-1 opacity-20 rounded-sm transition-all duration-300 ${isBid ? 'right-0 bg-trade-bid' : 'right-0 bg-trade-ask'}`}
        style={{ width: `${depthWidth}%` }}
      />
      
      {/* Wall Glow Effects */}
      {isWall && (
          <>
            <div className={`absolute left-0 top-0 bottom-0 w-0.5 ${isBid ? 'bg-emerald-400' : 'bg-rose-500'} shadow-[0_0_8px_currentColor] animate-pulse`} />
            <div className={`absolute right-0 top-0 bottom-0 w-0.5 ${isBid ? 'bg-emerald-400' : 'bg-rose-500'} shadow-[0_0_8px_currentColor] animate-pulse`} />
          </>
      )}
      
      {/* Price */}
      <span className={`z-10 font-bold tracking-tight ${isBid ? 'text-trade-bid' : 'text-trade-ask'} ${isWall ? 'text-sm' : ''}`}>
        {level.price.toFixed(2)}
      </span>
      
      {/* Liquidity Wall Indicator */}
      {isWall && (
        <div className="absolute left-1/2 -translate-x-1/2 z-20">
             <div className={`
                flex items-center gap-1.5 px-3 py-0.5 rounded text-[9px] font-black tracking-[0.2em] uppercase border backdrop-blur-md shadow-xl transform group-hover:scale-105 transition-transform
                ${isBid
                    ? 'bg-[#022c22] border-emerald-500/50 text-emerald-400 shadow-emerald-900/50'
                    : 'bg-[#4c0519] border-rose-500/50 text-rose-400 shadow-rose-900/50'
                }
             `}>
                <Layers size={10} className="animate-pulse" strokeWidth={3} />
                LIQ WALL
             </div>
        </div>
      )}

      {/* Size */}
      <span className={`z-10 transition-colors ${isWall ? 'text-white font-bold text-sm drop-shadow-md' : 'text-slate-500 group-hover:text-white'}`}>
        {level.size.toLocaleString()}
      </span>
    </div>
  );
};

const OrderBook: React.FC<OrderBookProps> = ({ asks, bids }) => {
  return (
    <div className="fintech-card h-full flex flex-col overflow-hidden">
      <div className="px-5 py-4 border-b border-white/5 flex justify-between items-center bg-white/[0.02]">
        <h3 className="text-sm font-bold text-white tracking-wide font-sans flex items-center gap-2">
            <ArrowDownUp size={16} className="text-brand-accent" />
            Order Book
        </h3>
        <div className="flex items-center gap-2">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse"></span>
            <span className="text-[10px] text-slate-500 font-mono uppercase">Live Feed</span>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto font-mono scrollbar-hide py-2">
        {/* Header */}
        <div className="flex justify-between px-4 pb-2 text-[10px] text-slate-500 font-bold uppercase tracking-wider">
            <span>Price (USD)</span>
            <span>Size</span>
        </div>

        {/* Asks */}
        <div className="flex flex-col-reverse">
            <AnimatePresence>
            {asks.map((ask, i) => (
                <OrderRow key={`ask-${i}`} level={ask} type="ask" />
            ))}
            </AnimatePresence>
        </div>

        {/* Spread */}
        <div className="py-2 my-2 bg-white/5 backdrop-blur-sm text-center border-y border-white/5 relative group">
            <div className="absolute inset-0 bg-brand-accent/5 opacity-0 group-hover:opacity-100 transition-opacity"></div>
            <span className="relative z-10 text-xs text-slate-400 font-medium group-hover:text-white transition-colors">Spread: 0.25 (0.01%)</span>
        </div>

        {/* Bids */}
        <div>
            <AnimatePresence>
            {bids.map((bid, i) => (
                <OrderRow key={`bid-${i}`} level={bid} type="bid" />
            ))}
            </AnimatePresence>
        </div>
      </div>
    </div>
  );
};

export default OrderBook;