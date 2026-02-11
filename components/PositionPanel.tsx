
import React, { useState, useEffect } from 'react';
import { useStore } from '../store';
import { ArrowUpCircle, ArrowDownCircle, Target, Shield, Wallet, PlayCircle, StopCircle, RefreshCcw, TrendingUp, TrendingDown, DollarSign, Percent } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';

const PositionPanel: React.FC = () => {
    const { 
        trading: { activePosition, accountSize, riskPercent, dailyStats },
        market: { metrics },
        openPosition,
        closePosition,
        setAccountSize,
        setRiskPercent,
        resetDailyStats
    } = useStore();

    // Local State for Input Form
    const [direction, setDirection] = useState<'LONG' | 'SHORT'>('LONG');
    const [entry, setEntry] = useState<string>('');
    const [stop, setStop] = useState<string>('');
    const [target, setTarget] = useState<string>('');
    const [localRisk, setLocalRisk] = useState<string>(riskPercent.toString());

    // Sync entry with current price if empty
    useEffect(() => {
        if (!activePosition && metrics.price > 0 && entry === '') {
            setEntry(metrics.price.toFixed(2));
        }
    }, [metrics.price, activePosition]);

    const handleOpen = () => {
        const e = parseFloat(entry);
        const s = parseFloat(stop);
        const t = parseFloat(target);
        
        if (isNaN(e) || isNaN(s) || isNaN(t)) return;
        
        openPosition({
            entry: e,
            stop: s,
            target: t,
            direction
        });
    };

    // Derived Calc for Preview
    const riskAmount = accountSize * (parseFloat(localRisk) / 100);
    const priceDiff = Math.abs(parseFloat(entry) - parseFloat(stop));
    const estimatedSize = priceDiff > 0 ? riskAmount / priceDiff : 0;
    const rewardDiff = Math.abs(parseFloat(target) - parseFloat(entry));
    const rrRatio = priceDiff > 0 ? rewardDiff / priceDiff : 0;

    return (
        <div className="fintech-card flex flex-col h-full bg-[#09090b]">
            <div className="p-4 border-b border-white/5 flex items-center justify-between">
                <div className="flex items-center gap-2">
                    <Wallet size={16} className="text-brand-accent" />
                    <span className="text-sm font-bold text-white uppercase tracking-wide">Execution Deck</span>
                </div>
                <div className="text-[10px] font-mono text-zinc-500">
                    BAL: ${(accountSize + (activePosition?.unrealizedPnL || 0)).toLocaleString(undefined, { maximumFractionDigits: 0 })}
                </div>
            </div>

            <div className="flex-1 p-4 overflow-y-auto">
                <AnimatePresence mode="wait">
                    {activePosition ? (
                        <motion.div 
                            key="active"
                            initial={{ opacity: 0, x: 20 }}
                            animate={{ opacity: 1, x: 0 }}
                            exit={{ opacity: 0, x: -20 }}
                            className="flex flex-col gap-4 h-full"
                        >
                            {/* LIVE PNL CARD */}
                            <div className={`
                                p-6 rounded-xl border flex flex-col items-center justify-center relative overflow-hidden transition-colors duration-500
                                ${activePosition.floatingR >= 0 
                                    ? 'bg-emerald-900/10 border-emerald-500/30 shadow-[inset_0_0_30px_rgba(16,185,129,0.1)]' 
                                    : 'bg-rose-900/10 border-rose-500/30 shadow-[inset_0_0_30px_rgba(244,63,94,0.1)]'}
                            `}>
                                <div className="text-[10px] text-zinc-400 font-bold uppercase tracking-widest mb-1">Unrealized PnL</div>
                                <div className={`text-4xl font-black font-mono mb-2 ${activePosition.unrealizedPnL >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                                    {activePosition.unrealizedPnL >= 0 ? '+' : ''}{activePosition.unrealizedPnL.toFixed(2)}
                                </div>
                                <div className={`px-2 py-0.5 rounded text-xs font-bold ${activePosition.floatingR >= 0 ? 'bg-emerald-500/20 text-emerald-400' : 'bg-rose-500/20 text-rose-400'}`}>
                                    {activePosition.floatingR.toFixed(2)}R
                                </div>
                            </div>

                            {/* Position Details */}
                            <div className="grid grid-cols-2 gap-3 text-xs font-mono">
                                <div className="p-2 bg-white/5 rounded border border-white/5">
                                    <span className="text-zinc-500 block mb-1">ENTRY</span>
                                    <span className="text-white">{activePosition.entry}</span>
                                </div>
                                <div className="p-2 bg-white/5 rounded border border-white/5">
                                    <span className="text-zinc-500 block mb-1">SIZE</span>
                                    <span className="text-white">{activePosition.size.toFixed(4)}</span>
                                </div>
                                <div className="p-2 bg-white/5 rounded border border-white/5 relative overflow-hidden">
                                    <div className="absolute left-0 top-0 bottom-0 w-1 bg-rose-500" />
                                    <span className="text-zinc-500 block mb-1 pl-2">STOP</span>
                                    <span className="text-rose-400 pl-2">{activePosition.stop}</span>
                                </div>
                                <div className="p-2 bg-white/5 rounded border border-white/5 relative overflow-hidden">
                                    <div className="absolute left-0 top-0 bottom-0 w-1 bg-emerald-500" />
                                    <span className="text-zinc-500 block mb-1 pl-2">TARGET</span>
                                    <span className="text-emerald-400 pl-2">{activePosition.target}</span>
                                </div>
                            </div>

                            <button
                                onClick={() => closePosition(metrics.price)}
                                className="mt-auto w-full py-3 bg-zinc-800 hover:bg-zinc-700 text-white rounded-lg font-bold flex items-center justify-center gap-2 border border-white/10 transition-all hover:scale-[1.02]"
                            >
                                <StopCircle size={16} className="text-rose-500" /> CLOSE POSITION
                            </button>
                        </motion.div>
                    ) : (
                        <motion.div 
                            key="form"
                            initial={{ opacity: 0, x: -20 }}
                            animate={{ opacity: 1, x: 0 }}
                            exit={{ opacity: 0, x: 20 }}
                            className="flex flex-col gap-4 h-full"
                        >
                            {/* Direction Toggle */}
                            <div className="grid grid-cols-2 gap-2 p-1 bg-black/40 rounded-lg border border-white/5">
                                <button
                                    onClick={() => setDirection('LONG')}
                                    className={`flex items-center justify-center gap-2 py-2 rounded-md text-xs font-bold transition-all ${direction === 'LONG' ? 'bg-emerald-500 text-black shadow-sm' : 'text-zinc-500 hover:text-white'}`}
                                >
                                    <ArrowUpCircle size={14} /> LONG
                                </button>
                                <button
                                    onClick={() => setDirection('SHORT')}
                                    className={`flex items-center justify-center gap-2 py-2 rounded-md text-xs font-bold transition-all ${direction === 'SHORT' ? 'bg-rose-500 text-black shadow-sm' : 'text-zinc-500 hover:text-white'}`}
                                >
                                    <ArrowDownCircle size={14} /> SHORT
                                </button>
                            </div>

                            {/* Inputs */}
                            <div className="space-y-3">
                                <div className="space-y-1">
                                    <label className="text-[10px] text-zinc-500 font-bold uppercase">Entry Price</label>
                                    <div className="relative">
                                        <input 
                                            type="number" 
                                            value={entry} 
                                            onChange={(e) => setEntry(e.target.value)}
                                            className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white font-mono focus:border-brand-accent focus:outline-none"
                                        />
                                        <span className="absolute right-3 top-2.5 text-xs text-zinc-600">USD</span>
                                    </div>
                                </div>
                                <div className="grid grid-cols-2 gap-3">
                                    <div className="space-y-1">
                                        <label className="text-[10px] text-rose-500 font-bold uppercase flex items-center gap-1"><Shield size={10} /> Stop Loss</label>
                                        <input 
                                            type="number" 
                                            value={stop} 
                                            onChange={(e) => setStop(e.target.value)}
                                            className="w-full bg-white/5 border border-rose-500/20 rounded-lg px-3 py-2 text-sm text-white font-mono focus:border-rose-500 focus:outline-none"
                                        />
                                    </div>
                                    <div className="space-y-1">
                                        <label className="text-[10px] text-emerald-500 font-bold uppercase flex items-center gap-1"><Target size={10} /> Target</label>
                                        <input 
                                            type="number" 
                                            value={target} 
                                            onChange={(e) => setTarget(e.target.value)}
                                            className="w-full bg-white/5 border border-emerald-500/20 rounded-lg px-3 py-2 text-sm text-white font-mono focus:border-emerald-500 focus:outline-none"
                                        />
                                    </div>
                                </div>
                                
                                {/* Risk Params */}
                                <div className="grid grid-cols-2 gap-3 pt-2 border-t border-white/5">
                                    <div className="space-y-1">
                                        <label className="text-[10px] text-zinc-500 font-bold uppercase">Risk %</label>
                                        <div className="relative">
                                            <input 
                                                type="number" 
                                                value={localRisk} 
                                                onChange={(e) => {
                                                    setLocalRisk(e.target.value);
                                                    setRiskPercent(parseFloat(e.target.value));
                                                }}
                                                className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-1.5 text-xs text-white font-mono"
                                            />
                                            <Percent size={10} className="absolute right-2 top-2 text-zinc-600" />
                                        </div>
                                    </div>
                                    <div className="space-y-1 opacity-60">
                                        <label className="text-[10px] text-zinc-500 font-bold uppercase">Est. Size</label>
                                        <div className="w-full bg-white/5 border border-white/5 rounded-lg px-3 py-1.5 text-xs text-zinc-300 font-mono">
                                            {estimatedSize.toFixed(4)}
                                        </div>
                                    </div>
                                </div>
                            </div>

                            {/* Preview Badge */}
                            <div className="flex justify-between items-center px-3 py-2 rounded bg-white/5 border border-white/5 text-[10px] font-mono">
                                <span className="text-zinc-500">RR RATIO</span>
                                <span className={rrRatio >= 2 ? 'text-emerald-400 font-bold' : 'text-amber-400'}>
                                    {rrRatio.toFixed(2)}
                                </span>
                            </div>

                            <button
                                onClick={handleOpen}
                                className={`mt-auto w-full py-3 rounded-lg font-bold flex items-center justify-center gap-2 border border-white/10 transition-all hover:scale-[1.02] shadow-lg
                                    ${direction === 'LONG' ? 'bg-emerald-600 hover:bg-emerald-500 text-white' : 'bg-rose-600 hover:bg-rose-500 text-white'}
                                `}
                            >
                                <PlayCircle size={16} /> OPEN {direction}
                            </button>
                        </motion.div>
                    )}
                </AnimatePresence>
            </div>

            {/* Daily Stats Footer */}
            <div className="p-3 bg-black/40 border-t border-white/5 grid grid-cols-2 gap-y-2 gap-x-4">
                <div className="flex justify-between items-center">
                    <span className="text-[9px] text-zinc-500 uppercase font-bold">Today's R</span>
                    <span className={`text-xs font-mono font-bold ${dailyStats.totalR >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                        {dailyStats.totalR > 0 ? '+' : ''}{dailyStats.totalR.toFixed(1)}R
                    </span>
                </div>
                <div className="flex justify-between items-center">
                     <span className="text-[9px] text-zinc-500 uppercase font-bold">W/L</span>
                     <span className="text-xs font-mono text-zinc-300">{dailyStats.wins} / {dailyStats.losses}</span>
                </div>
                 <div className="flex justify-between items-center col-span-2">
                    <span className="text-[9px] text-zinc-500 uppercase font-bold">Max Drawdown</span>
                    <span className="text-xs font-mono text-rose-500">{dailyStats.maxDrawdownR.toFixed(1)}R</span>
                </div>
            </div>
        </div>
    );
};

export default PositionPanel;
