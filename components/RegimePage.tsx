
import React, { useEffect } from 'react';
import { motion as m } from 'framer-motion';
import { useStore } from '../store';
import { Activity, TrendingUp, TrendingDown, Maximize2, Minimize2, Radio, Info, RefreshCw, BarChart2 } from 'lucide-react';

const motion = m as any;

const RegimePage: React.FC = () => {
    const { regime, refreshRegimeAnalysis } = useStore();
    const { regimeType, trendDirection, atr, rangeSize, volatilityPercentile, lastUpdated, symbol } = regime;

    // Auto-refresh hook
    useEffect(() => {
        refreshRegimeAnalysis();
        const interval = setInterval(refreshRegimeAnalysis, 15000);
        return () => clearInterval(interval);
    }, []);

    // Visual Config based on Regime
    let config = {
        color: 'text-zinc-400',
        bg: 'bg-zinc-900',
        border: 'border-white/5',
        icon: Activity,
        label: 'UNCERTAIN',
        gradient: 'from-zinc-800 to-black'
    };

    if (regimeType === 'TRENDING') {
        if (trendDirection === 'BULL') {
            config = { color: 'text-emerald-400', bg: 'bg-emerald-900/20', border: 'border-emerald-500/30', icon: TrendingUp, label: 'BULL TREND', gradient: 'from-emerald-900/40 to-black' };
        } else {
            config = { color: 'text-rose-400', bg: 'bg-rose-900/20', border: 'border-rose-500/30', icon: TrendingDown, label: 'BEAR TREND', gradient: 'from-rose-900/40 to-black' };
        }
    } else if (regimeType === 'EXPANDING') {
        config = { color: 'text-blue-400', bg: 'bg-blue-900/20', border: 'border-blue-500/30', icon: Maximize2, label: 'EXPANSION', gradient: 'from-blue-900/40 to-black' };
    } else if (regimeType === 'COMPRESSING') {
        config = { color: 'text-zinc-300', bg: 'bg-zinc-800/50', border: 'border-zinc-600/30', icon: Minimize2, label: 'SQUEEZE', gradient: 'from-zinc-800/40 to-black' };
    } else if (regimeType === 'RANGING') {
        config = { color: 'text-amber-400', bg: 'bg-amber-900/20', border: 'border-amber-500/30', icon: Radio, label: 'CHOP / RANGE', gradient: 'from-amber-900/40 to-black' };
    }

    return (
        <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="h-full overflow-y-auto px-4 lg:px-8 pb-24 lg:pb-8 max-w-5xl mx-auto pt-6"
        >
            <div className="flex justify-between items-end mb-8">
                <div>
                    <h1 className="text-3xl font-bold text-white tracking-tight flex items-center gap-3">
                        <div className={`p-2 rounded-xl ${config.bg} ${config.color}`}>
                            <config.icon size={28} />
                        </div>
                        Market Regime
                    </h1>
                    <p className="text-zinc-400 text-sm mt-1 ml-1">
                        Algorithmic State Detection for <span className="text-white font-mono font-bold">{symbol}</span>
                    </p>
                </div>
                <div className="text-right">
                    <span className="text-[10px] text-zinc-500 font-bold uppercase block mb-1">Last Analysis</span>
                    <div className="flex items-center gap-2">
                        <span className="text-xs font-mono text-zinc-300">{lastUpdated ? new Date(lastUpdated).toLocaleTimeString() : '--:--:--'}</span>
                        <button onClick={() => refreshRegimeAnalysis()} className="p-1.5 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-400 transition-colors">
                            <RefreshCw size={12} />
                        </button>
                    </div>
                </div>
            </div>

            {/* BIG BANNER */}
            <motion.div 
                key={regimeType + trendDirection}
                initial={{ scale: 0.95, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                className={`relative w-full rounded-3xl border ${config.border} bg-gradient-to-br ${config.gradient} overflow-hidden p-8 mb-8 shadow-2xl`}
            >
                {/* Background Decor */}
                <div className="absolute top-0 right-0 p-8 opacity-10 pointer-events-none">
                    <config.icon size={200} />
                </div>
                
                <div className="relative z-10 flex flex-col md:flex-row items-start md:items-center justify-between gap-8">
                    <div>
                        <div className="flex items-center gap-3 mb-2">
                            <span className={`px-3 py-1 rounded-full text-[10px] font-black uppercase tracking-widest bg-black/40 border border-white/10 ${config.color}`}>
                                CURRENT STATE
                            </span>
                        </div>
                        <h2 className={`text-5xl md:text-7xl font-black tracking-tighter text-white drop-shadow-lg`}>
                            {config.label}
                        </h2>
                    </div>

                    {/* Volatility Gauge */}
                    <div className="bg-black