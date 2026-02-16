
import React from 'react';
import { MarketMetrics } from '../types';
import { Activity, Skull, TrendingUp, Anchor, BarChart2, ArrowRight, TrendingDown, Waves, Zap } from 'lucide-react';
import { motion as m } from 'framer-motion';

const motion = m as any;

interface OrderFlowMetricsProps {
  metrics: MarketMetrics;
}

const WhaleHunterWidget: React.FC<{ metrics: MarketMetrics }> = ({ metrics }) => {
    // Extract CVD Context
    const cvd = metrics.cvdContext?.value || 0;
    const interpretation = metrics.cvdContext?.interpretation || 'NEUTRAL';
    const divergence = metrics.cvdContext?.divergence || 'NONE';

    // Status Logic
    let statusColor = "text-slate-400";
    let statusBg = "bg-slate-500/10";
    let statusIcon = <Activity size={12} />;

    if (interpretation === 'REAL STRENGTH') {
        statusColor = "text-emerald-400";
        statusBg = "bg-emerald-500/10";
        statusIcon = <TrendingUp size={12} />;
    } else if (interpretation === 'REAL WEAKNESS') {
        statusColor = "text-rose-400";
        statusBg = "bg-rose-500/10";
        statusIcon = <TrendingDown size={12} />;
    } else if (interpretation === 'ABSORPTION') {
        statusColor = "text-amber-400";
        statusBg = "bg-amber-500/10";
        statusIcon = <Anchor size={12} />;
    } else if (interpretation === 'DISTRIBUTION') {
        statusColor = "text-orange-400";
        statusBg = "bg-orange-500/10";
        statusIcon = <Anchor size={12} />;
    }

    return (
        <div className="fintech-card p-4 relative overflow-hidden flex flex-col justify-between h-full group">
            {/* Header */}
            <div className="flex justify-between items-start relative z-10">
                <div className="flex flex-col">
                    <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest flex items-center gap-1">
                        <Anchor size={12} className={cvd > 0 ? "text-emerald-400" : "text-rose-400"} />
                        Cumulative Delta
                    </span>
                    <span className="text-xs text-slate-500 font-mono mt-0.5">Aggressive Vol. Tracker</span>
                </div>
                
                {/* Interpretation Badge */}
                <div className={`px-2 py-0.5 rounded border border-white/5 text-[9px] font-black uppercase tracking-wider flex items-center gap-1 ${statusColor} ${statusBg}`}>
                    {statusIcon} {interpretation}
                </div>
            </div>

            {/* CVD Value Display */}
            <div className="flex flex-col items-center justify-center my-2">
                <span className={`text-3xl font-mono font-black tracking-tighter ${cvd > 0 ? "text-emerald-500" : "text-rose-500"}`}>
                    {cvd > 0 ? "+" : ""}{cvd.toFixed(0)}
                </span>
                <span className="text-[9px] text-zinc-500 uppercase tracking-wide">Net Market Contracts</span>
            </div>

            {/* Bar & Market Truth */}
            <div className="flex flex-col gap-2 mt-auto">
                {/* Divergence Warning */}
                {divergence !== 'NONE' && (
                    <motion.div 
                        initial={{ opacity: 0 }} animate={{ opacity: 1 }}
                        className="text-center text-[9px] font-bold text-amber-500 uppercase bg-amber-500/10 py-1 rounded border border-amber-500/20"
                    >
                        ⚠ {divergence === 'BULLISH_ABSORPTION' ? 'Hidden Buying Detected' : 'Hidden Selling Detected'}
                    </motion.div>
                )}

                <div className="h-1 w-full bg-slate-800 rounded-full overflow-hidden flex relative">
                     {/* Center Marker */}
                    <div className="absolute left-1/2 top-0 bottom-0 w-0.5 bg-white/20 z-10" />
                    
                    <motion.div 
                        animate={{ 
                            width: `${Math.min(Math.abs(cvd) / 100, 50)}%`,
                            left: cvd > 0 ? '50%' : 'auto',
                            right: cvd < 0 ? '50%' : 'auto'
                        }}
                        className={`h-full relative ${cvd > 0 ? 'bg-emerald-500' : 'bg-rose-500'}`} 
                    />
                </div>
                
                <div className="flex justify-between text-[8px] font-mono text-slate-600">
                    <span>Seller Dominance</span>
                    <span>Buyer Dominance</span>
                </div>
            </div>
        </div>
    );
};

const RegimeWidget: React.FC<{ metrics: MarketMetrics }> = ({ metrics }) => {
    const { regime } = metrics;

    let icon = <Waves size={24} />;
    let title = "Mean Reversion";
    let desc = "Ranging Market";
    let color = "text-blue-400";
    let bg = "bg-blue-500/10";

    if (regime === 'TRENDING') {
        icon = <TrendingUp size={24} />;
        title = "Momentum";
        desc = "Trending Market";
        color = "text-emerald-400";
        bg = "bg-emerald-500/10";
    } else if (regime === 'HIGH_VOLATILITY') {
        icon = <Zap size={24} />;
        title = "Expansion";
        desc = "High Volatility";
        color = "text-amber-400";
        bg = "bg-amber-500/10";
    }

    return (
        <div className="fintech-card p-4 flex flex-col justify-between overflow-hidden relative">
            <div className="absolute top-0 right-0 p-4 opacity-5 pointer-events-none">
                {React.cloneElement(icon as React.ReactElement<any>, { size: 64 })}
            </div>
            
            <div className="flex flex-col">
                <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest flex items-center gap-1">
                    <Activity size={12} className={color} />
                    Regime Detector
                </span>
                
                <div className="mt-4 flex flex-col gap-1">
                     <div className={`p-3 rounded-xl w-fit ${bg} ${color} mb-2`}>
                        {icon}
                     </div>
                     <h3 className={`text-xl font-bold ${color}`}>{title}</h3>
                     <span className="text-xs text-slate-500 font-mono uppercase">{desc}</span>
                </div>
            </div>

            <div className="mt-auto pt-3 border-t border-white/5">
                <div className="flex justify-between items-center">
                     <span className="text-[9px] text-slate-500 uppercase">Strategy Lock</span>
                     <span className="text-[9px] font-bold text-white bg-white/10 px-1.5 py-0.5 rounded">
                         {regime === 'TRENDING' ? 'FADES LOCKED' : regime === 'MEAN_REVERTING' ? 'TREND LOCKED' : 'ALL ACTIVE'}
                     </span>
                </div>
            </div>
        </div>
    );
}

const OrderFlowMetrics: React.FC<OrderFlowMetricsProps> = ({ metrics }) => {
  // Determine OFI State
  const ofiColor = metrics.ofi > 0 ? "text-trade-bid" : metrics.ofi < 0 ? "text-trade-ask" : "text-slate-500";
  const ofiBg = metrics.ofi > 0 ? "bg-trade-bid" : metrics.ofi < 0 ? "bg-trade-ask" : "bg-slate-500";
  const dominanceLabel = metrics.ofi > 50 ? "Aggressive Buying" : metrics.ofi < -50 ? "Aggressive Selling" : "Balanced Flow";
  
  let signalState = "NEUTRAL";
  if (Math.abs(metrics.ofi) > 50) {
      if (metrics.ofi > 0) {
          if (metrics.change > 0) signalState = "VALIDATION (BULL)";
          else signalState = "ABSORPTION (BEAR)";
      } else {
          if (metrics.change < 0) signalState = "VALIDATION (BEAR)";
          else signalState = "ABSORPTION (BULL)";
      }
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-6 h-full">
      
      {/* Widget 1: CVD / Whale Hunter */}
      <WhaleHunterWidget metrics={metrics} />

      {/* Widget 2: Regime Detector */}
      <RegimeWidget metrics={metrics} />

      {/* Widget 3: Order Flow Imbalance (OFI) */}
      <div className="fintech-card p-4 flex flex-col justify-between relative overflow-hidden group">
         {/* Background Decor */}
         <div className="absolute top-0 right-0 p-4 opacity-5 group-hover:opacity-10 transition-opacity">
            <BarChart2 size={64} />
         </div>

         <div className="flex justify-between items-start z-10 relative">
            <div className="flex flex-col">
                <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest flex items-center gap-1">
                    <Activity size={12} className={ofiColor} />
                    Imbalance (OFI)
                </span>
                <span className={`text-[10px] font-bold font-mono mt-1 ${ofiColor} bg-white/5 px-1.5 py-0.5 rounded w-fit`}>
                    {dominanceLabel}
                </span>
            </div>
            <div className="flex flex-col items-end">
                <span className={`text-2xl font-mono font-bold ${ofiColor}`}>
                    {metrics.ofi > 0 ? '+' : ''}{metrics.ofi.toFixed(0)}
                </span>
                <span className="text-[9px] text-slate-500 font-mono">LOTS</span>
            </div>
         </div>
         
         <div className="mt-4 z-10">
            {/* Split Bar Gauge */}
            <div className="w-full h-1.5 bg-slate-800 rounded-full overflow-hidden relative flex">
                 <div className="absolute left-1/2 top-0 bottom-0 w-0.5 bg-white/20 z-20"></div>
                 {/* Fill */}
                 <motion.div 
                    animate={{ 
                        left: metrics.ofi > 0 ? '50%' : 'auto',
                        right: metrics.ofi < 0 ? '50%' : 'auto',
                        width: `${Math.min(Math.abs(metrics.ofi) / 5, 50)}%` 
                    }}
                    className={`absolute top-0 bottom-0 ${ofiBg}`}
                 />
            </div>
            <div className="flex justify-between mt-1 text-[8px] font-mono text-slate-600 uppercase">
                <span>Sell Side</span>
                <span>Buy Side</span>
            </div>
         </div>

         <div className="mt-3 flex justify-between items-center border-t border-white/5 pt-2 z-10">
             <div className="flex items-center gap-2">
                 <span className="text-[10px] text-slate-500 font-bold uppercase">Signal</span>
                 <ArrowRight size={10} className="text-slate-600" />
             </div>
             <div className={`text-[10px] font-bold px-2 py-0.5 rounded border ${
                 signalState.includes("VALIDATION") ? "border-emerald-500/20 bg-emerald-500/10 text-emerald-400" :
                 signalState.includes("ABSORPTION") ? "border-amber-500/20 bg-amber-500/10 text-amber-400" :
                 "border-zinc-700 bg-zinc-800 text-zinc-400"
             }`}>
                {signalState}
             </div>
         </div>

         {/* Secondary Metric: Toxicity */}
         <div className="mt-1 flex items-center gap-2 justify-end opacity-60 hover:opacity-100 transition-opacity cursor-help" title="Flow Toxicity (HFT Activity)">
            <Skull size={10} className="text-zinc-500" />
            <span className="text-[9px] font-mono text-zinc-500">TOX: {metrics.toxicity}</span>
         </div>
      </div>

    </div>
  );
};

export default OrderFlowMetrics;
