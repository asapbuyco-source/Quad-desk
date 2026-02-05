import React from 'react';
import { MarketMetrics, HeatmapItem } from '../types';
import { Activity, Skull, TrendingUp, Anchor } from 'lucide-react';
import { motion } from 'framer-motion';

interface OrderFlowMetricsProps {
  metrics: MarketMetrics;
}

const WhaleHunterWidget: React.FC<{ instCVD: number, retailSentiment: number }> = ({ instCVD, retailSentiment }) => {
    // Logic: Trap exists if Institutions are Buying (CVD > 0) AND Retail is Buying (> 65%)
    // OR Institutions Selling (CVD < 0) AND Retail is Selling (< 35%)
    const isTrap = (instCVD > 10 && retailSentiment > 70) || (instCVD < -10 && retailSentiment < 30);

    return (
        <div className="fintech-card p-4 relative overflow-hidden flex flex-col justify-between h-full group">
            <div className="flex justify-between items-start relative z-10">
                <div className="flex flex-col">
                    <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest flex items-center gap-1">
                        <Anchor size={12} className={instCVD > 0 ? "text-emerald-400" : "text-rose-400"} />
                        Whale Hunter
                    </span>
                    <span className="text-xs text-slate-500 font-mono mt-0.5">Inst. vs Retail Delta</span>
                </div>
                {isTrap && (
                    <motion.div 
                        initial={{ opacity: 0, scale: 0.8 }}
                        animate={{ opacity: 1, scale: 1 }}
                        transition={{ repeat: Infinity, duration: 1.5, repeatType: "reverse" }}
                        className="px-2 py-0.5 rounded bg-amber-500/20 border border-amber-500/50 text-amber-500 text-[9px] font-black uppercase tracking-wider shadow-[0_0_10px_rgba(245,158,11,0.3)]"
                    >
                        ⚠ LIQUIDITY GRAB
                    </motion.div>
                )}
            </div>

            <div className="flex flex-col gap-4 mt-2">
                {/* Institutional Bar */}
                <div className="space-y-1">
                    <div className="flex justify-between text-[10px] font-mono font-bold">
                        <span className="text-white">Institutional CVD</span>
                        <span className={instCVD > 0 ? "text-trade-bid" : "text-trade-ask"}>
                            {instCVD > 0 ? "+" : ""}{instCVD.toFixed(1)}M
                        </span>
                    </div>
                    <div className="h-1.5 w-full bg-slate-800 rounded-full overflow-hidden flex">
                        <div className="w-1/2 flex justify-end">
                            {instCVD < 0 && (
                                <motion.div 
                                    initial={{ width: 0 }} animate={{ width: `${Math.min(Math.abs(instCVD), 100)}%` }}
                                    className="h-full bg-trade-ask rounded-l-full" 
                                />
                            )}
                        </div>
                        <div className="w-1/2 flex justify-start">
                             {instCVD > 0 && (
                                <motion.div 
                                    initial={{ width: 0 }} animate={{ width: `${Math.min(Math.abs(instCVD), 100)}%` }}
                                    className="h-full bg-trade-bid rounded-r-full" 
                                />
                            )}
                        </div>
                    </div>
                </div>

                {/* Retail Sentiment Bar */}
                <div className="space-y-1">
                     <div className="flex justify-between text-[10px] font-mono font-bold">
                        <span className="text-slate-400">Retail Sentiment</span>
                        <span className="text-white">{retailSentiment}% LONG</span>
                    </div>
                    <div className="h-1.5 w-full bg-slate-800 rounded-full overflow-hidden relative">
                        <motion.div 
                            initial={{ width: "50%" }} 
                            animate={{ width: `${retailSentiment}%` }}
                            className="absolute top-0 bottom-0 left-0 bg-brand-accent"
                        />
                         {/* Marker for extreme sentiment */}
                        <div className="absolute top-0 bottom-0 left-[70%] w-0.5 bg-trade-ask/50 z-10" />
                        <div className="absolute top-0 bottom-0 left-[30%] w-0.5 bg-trade-bid/50 z-10" />
                    </div>
                </div>
            </div>
        </div>
    );
};

const ZScoreCell: React.FC<{ item: HeatmapItem }> = ({ item }) => {
    let colorClass = "bg-zinc-800 text-zinc-500 border-zinc-700/50"; // Neutral
    let status = "Norm";

    if (item.zScore < -2.0) {
        colorClass = "bg-blue-600/20 text-blue-400 border-blue-500/50 shadow-[inset_0_0_10px_rgba(37,99,235,0.2)]"; // Cold
        status = "OSOLD";
    } else if (item.zScore > 2.0) {
        colorClass = "bg-rose-600/20 text-rose-400 border-rose-500/50 shadow-[inset_0_0_10px_rgba(225,29,72,0.2)]"; // Hot
        status = "OBGHT";
    }

    return (
        <div className={`flex flex-col items-center justify-center p-2 rounded-lg border ${colorClass} transition-colors duration-500`}>
            <span className="text-[9px] font-bold uppercase tracking-wider mb-0.5">{item.pair}</span>
            <span className="text-xs font-mono font-bold">{item.zScore.toFixed(2)}σ</span>
            <span className="text-[8px] opacity-70 mt-1">{status}</span>
        </div>
    );
};

const OrderFlowMetrics: React.FC<OrderFlowMetricsProps> = ({ metrics }) => {
  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-6 h-full">
      
      {/* Widget 1: Whale Hunter (CVD vs Retail) */}
      <WhaleHunterWidget instCVD={metrics.institutionalCVD} retailSentiment={metrics.retailSentiment} />

      {/* Widget 2: Z-Score Heatmap Matrix */}
      <div className="fintech-card p-4 flex flex-col justify-between overflow-hidden">
         <div className="flex justify-between items-center mb-3">
             <div className="flex flex-col">
                <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest flex items-center gap-1">
                    <TrendingUp size={12} className="text-brand-accent" />
                    Mean Reversion
                </span>
             </div>
             <div className="text-[9px] font-mono text-slate-600">H4 LOOKBACK</div>
         </div>
         
         <div className="grid grid-cols-3 gap-2 flex-1">
             {metrics.heatmap.map((item) => (
                 <ZScoreCell key={item.pair} item={item} />
             ))}
         </div>
      </div>

      {/* Widget 3: Toxicity / OFI */}
      <div className="fintech-card p-4 flex flex-col justify-between relative overflow-hidden">
         <div className="flex justify-between items-start z-10">
            <div className="flex flex-col">
                <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest flex items-center gap-1">
                    <Skull size={12} className="text-trade-warn" />
                    Toxicity
                </span>
                <span className="text-xs text-slate-500 font-mono mt-0.5">Order Flow Toxicity</span>
            </div>
            <div className="flex flex-col items-end">
                <span className={`text-2xl font-mono font-bold ${metrics.toxicity > 80 ? 'text-trade-warn animate-pulse' : 'text-white'}`}>
                    {metrics.toxicity}
                </span>
            </div>
         </div>
         
         <div className="mt-4 z-10">
            <div className="flex justify-between items-center text-[10px] text-slate-500 font-bold uppercase mb-1">
                <span>Imbalance (OFI)</span>
                <span className={metrics.ofi > 0 ? "text-trade-bid" : "text-trade-ask"}>{metrics.ofi} lots</span>
            </div>
            <div className="w-full h-1.5 bg-slate-800 rounded-full overflow-hidden relative">
                 <div className="absolute left-1/2 top-0 bottom-0 w-0.5 bg-white/20 z-20"></div>
                 {metrics.ofi !== 0 && (
                     <motion.div 
                        animate={{ 
                            left: metrics.ofi > 0 ? '50%' : 'auto',
                            right: metrics.ofi < 0 ? '50%' : 'auto',
                            width: `${Math.min(Math.abs(metrics.ofi) / 10, 50)}%` 
                        }}
                        className={`absolute top-0 bottom-0 ${metrics.ofi > 0 ? 'bg-trade-bid' : 'bg-trade-ask'}`}
                     />
                 )}
            </div>
         </div>

         {/* Background Decor */}
         <div className="absolute -bottom-4 -right-4 text-white/5 rotate-12">
             <Activity size={80} strokeWidth={1} />
         </div>
      </div>

    </div>
  );
};

export default OrderFlowMetrics;