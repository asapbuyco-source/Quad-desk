import React, { useMemo } from 'react';
import { OrderBookLevel } from '../types';
import { ArrowDownUp, BoxSelect, Wind, Crosshair, Zap } from 'lucide-react';
import { AnimatePresence, motion as m } from 'framer-motion';

const motion = m as any;

interface OrderBookProps {
  asks: OrderBookLevel[];
  bids: OrderBookLevel[];
}

const OrderRow: React.FC<{ level: OrderBookLevel; type: 'ask' | 'bid'; maxVol: number; maxDelta: number }> = ({ level, type, maxVol, maxDelta }) => {
  const depthWidth = Math.min((level.size / maxVol) * 100, 100);
  const isBid = type === 'bid';
  const { classification, delta } = level;

  // Visual Archetypes based on Classification
  const isWall = classification === 'WALL';
  const isHole = classification === 'HOLE';
  const isCluster = classification === 'CLUSTER';
  
  // Liquidity Delta Visualization
  const absDelta = Math.abs(delta || 0);
  const deltaWidth = maxDelta > 0 ? (absDelta / maxDelta) * 100 : 0;
  const isAdded = delta && delta > 0;
  
  // Power Color: Replenishment vs Cancellation
  let powerColor = isAdded 
    ? (isBid ? 'bg-emerald-500' : 'bg-rose-500') // Orders Added (Bids + / Asks +)
    : (isBid ? 'bg-amber-500' : 'bg-blue-500');  // Orders Pulled (Bids - / Asks -)

  return (
    <div className={`
        relative flex justify-between items-center text-xs font-mono py-1 px-4 transition-all group overflow-hidden
        ${isWall 
            ? (isBid 
                ? 'bg-emerald-500/10 border-y border-emerald-500/30 my-0.5 shadow-[inset_0_0_20px_rgba(16,185,129,0.1)]' 
                : 'bg-rose-500/10 border-y border-rose-500/30 my-0.5 shadow-[inset_0_0_20px_rgba(244,63,94,0.1)]')
            : isHole
                ? 'opacity-40 border-y border-dashed border-zinc-700/50 my-0.5 bg-black/20'
                : isCluster
                    ? 'bg-amber-500/5 border-y border-amber-500/20 my-0.5'
                    : 'hover:bg-white/5 border-y border-transparent'
        }
    `}>
      {/* Depth Bar */}
      <div 
        className={`absolute top-1 bottom-1 opacity-20 rounded-sm transition-all duration-300 ${isBid ? 'right-0 bg-trade-bid' : 'right-0 bg-trade-ask'}`}
        style={{ width: `${depthWidth}%`, opacity: isWall ? 0.4 : 0.15 }}
      />
      
      {/* Wall Glow Effects */}
      {isWall && (
          <>
            <div className={`absolute left-0 top-0 bottom-0 w-0.5 ${isBid ? 'bg-emerald-400' : 'bg-rose-500'} shadow-[0_0_8px_currentColor]`} />
            <div className={`absolute right-0 top-0 bottom-0 w-0.5 ${isBid ? 'bg-emerald-400' : 'bg-rose-500'} shadow-[0_0_8px_currentColor]`} />
          </>
      )}
      
      <div className="flex items-center gap-3 z-10 w-24">
        <span className={`font-bold tracking-tight flex items-center gap-2 ${
            isWall ? (isBid ? 'text-emerald-300' : 'text-rose-300') :
            isHole ? 'text-zinc-600 font-normal' :
            isCluster ? 'text-amber-500' :
            isBid ? 'text-trade-bid' : 'text-trade-ask'
        }`}>
            {level.price.toFixed(2)}
            {isWall && <BoxSelect size={10} strokeWidth={3} className="opacity-80" />}
            {isHole && <Wind size={10} className="opacity-50" />}
            {isCluster && <Crosshair size={10} className="animate-pulse" />}
        </span>
      </div>
      
      {/* POWER / DELTA COLUMN */}
      <div className="absolute left-1/2 -translate-x-1/2 z-20 flex items-center gap-2 w-12 h-4 justify-center">
         {absDelta > 0.01 && (
             <div className="flex-1 bg-white/5 h-1.5 rounded-full overflow-hidden flex relative">
                 <div className="absolute inset-0 flex">
                     <motion.div 
                        initial={{ width: 0 }}
                        animate={{ width: `${deltaWidth}%` }}
                        className={`h-full ${powerColor} ${absDelta > maxDelta * 0.7 ? 'animate-pulse' : ''}`} 
                     />
                 </div>
             </div>
         )}
      </div>

      <div className="flex items-center justify-end gap-3 z-10 min-w-[100px]">
          {/* Delta Indicator */}
          {absDelta > 0.1 && (
             <span className={`text-[9px] font-bold ${isAdded ? (isBid ? 'text-emerald-400' : 'text-rose-400') : 'text-zinc-600'}`}>
                 {isAdded ? '+' : '-'}{absDelta.toFixed(1)}
             </span>
          )}

          {/* Size */}
          <span className={`transition-colors text-right w-12 ${
              isWall ? 'text-white font-black text-sm drop-shadow-md' : 
              isHole ? 'text-zinc-700 text-[10px]' :
              isCluster ? 'text-amber-200 font-bold' :
              'text-slate-500 group-hover:text-white'
          }`}>
            {level.size.toLocaleString()}
          </span>
      </div>
    </div>
  );
};

const OrderBook: React.FC<OrderBookProps> = ({ asks, bids }) => {
    
  const { maxVol, maxDelta, netDelta } = useMemo(() => {
    const allLevels = [...asks, ...bids];
    if (allLevels.length === 0) return { maxVol: 1000, maxDelta: 0, netDelta: 0 };
    
    let net = 0;
    let maxD = 0;
    
    allLevels.forEach(l => {
        if (l.delta) {
            net += l.delta;
            if (Math.abs(l.delta) > maxD) maxD = Math.abs(l.delta);
        }
    });

    return {
        maxVol: Math.max(...allLevels.map(l => l.size)),
        maxDelta: maxD,
        netDelta: net
    };
  }, [asks, bids]);

  return (
    <div className="fintech-card h-full flex flex-col overflow-hidden">
      <div className="px-5 py-4 border-b border-white/5 flex justify-between items-center bg-white/[0.02]">
        <h3 className="text-sm font-bold text-white tracking-wide font-sans flex items-center gap-2">
            <ArrowDownUp size={16} className="text-brand-accent" />
            Depth Engine
        </h3>
        
        <div className="flex items-center gap-4">
            {Math.abs(netDelta) > 0.1 && (
                <div className="flex items-center gap-1.5 px-2 py-0.5 rounded bg-white/5 border border-white/10">
                    <Zap size={10} className={netDelta > 0 ? 'text-emerald-400' : 'text-rose-400'} />
                    <span className={`text-[10px] font-mono font-bold ${netDelta > 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                        {netDelta > 0 ? '+' : ''}{netDelta.toFixed(1)}
                    </span>
                </div>
            )}
            <div className="flex items-center gap-2">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse"></span>
                <span className="text-[10px] text-slate-500 font-mono uppercase">Liquidity Flux</span>
            </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto font-mono scrollbar-hide py-2">
        <div className="flex justify-between px-4 pb-2 text-[10px] text-slate-500 font-bold uppercase tracking-wider border-b border-white/5 mb-1">
            <span>Price (USD)</span>
            <div className="absolute left-1/2 -translate-x-1/2 text-zinc-600">Power</div>
            <div className="flex gap-4">
                <span>Flux</span>
                <span>Size</span>
            </div>
        </div>

        <div className="flex flex-col-reverse">
            <AnimatePresence initial={false}>
            {asks.map((ask) => (
                <OrderRow key={ask.price} level={ask} type="ask" maxVol={maxVol} maxDelta={maxDelta} />
            ))}
            </AnimatePresence>
        </div>

        <div className="py-2 my-1 bg-white/5 backdrop-blur-sm text-center border-y border-white/5 relative group">
            <div className="absolute inset-0 bg-brand-accent/5 opacity-0 group-hover:opacity-100 transition-opacity"></div>
            <span className="relative z-10 text-xs text-slate-400 font-medium group-hover:text-white transition-colors">Spread: Equilibrium</span>
        </div>

        <div>
            <AnimatePresence initial={false}>
            {bids.map((bid) => (
                <OrderRow key={bid.price} level={bid} type="bid" maxVol={maxVol} maxDelta={maxDelta} />
            ))}
            </AnimatePresence>
        </div>
      </div>
    </div>
  );
};

export default OrderBook;