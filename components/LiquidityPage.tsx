
import React, { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useStore } from '../store';
import { Droplets, ArrowUp, ArrowDown, MoveRight, ScanLine, AlertTriangle, RefreshCw, Layers, Clock } from 'lucide-react';

const EventRow: React.FC<{
    label: string;
    price: number;
    time: number;
    direction: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
    type: 'SWEEP' | 'BOS' | 'FVG';
    subtext?: string;
}> = ({ label, price, time, direction, type, subtext }) => {
    
    let color = 'text-zinc-400';
    let icon = <MoveRight size={14} />;
    
    if (direction === 'BULLISH') {
        color = 'text-emerald-400';
        icon = <ArrowUp size={14} />;
    } else if (direction === 'BEARISH') {
        color = 'text-rose-400';
        icon = <ArrowDown size={14} />;
    } else {
        color = 'text-amber-400';
    }

    return (
        <motion.div 
            initial={{ opacity: 0, x: -10 }}
            animate={{ opacity: 1, x: 0 }}
            className="flex items-center justify-between p-3 rounded-lg bg-white/5 border border-white/5 hover:bg-white/10 transition-colors group"
        >
            <div className="flex flex-col gap-1">
                <div className="flex items-center gap-2">
                    <span className={`p-1 rounded bg-black/40 ${color}`}>{icon}</span>
                    <span className="text-sm font-bold text-zinc-200 font-mono tracking-tight">{label}</span>
                </div>
                <span className="text-[10px] text-zinc-500 font-mono flex items-center gap-1">
                    <Clock size={10} /> {new Date(time).toLocaleTimeString()}
                </span>
            </div>
            
            <div className="text-right">
                <div className={`text-sm font-mono font-bold ${color}`}>
                    {price.toFixed(2)}
                </div>
                {subtext && (
                    <div className="text-[9px] text-zinc-500 font-bold uppercase tracking-wider">{subtext}</div>
                )}
            </div>
        </motion.div>
    );
};

const LiquidityPage: React.FC = () => {
    const { liquidity, refreshLiquidityAnalysis, config: { activeSymbol } } = useStore();
    const [activeTab, setActiveTab] = useState<'SWEEPS' | 'BOS' | 'FVG'>('SWEEPS');

    // Auto-refresh every 10 seconds
    useEffect(() => {
        refreshLiquidityAnalysis();
        const i = setInterval(refreshLiquidityAnalysis, 10000);
        return () => clearInterval(i);
    }, []);

    const { sweeps, bos, fvg, lastUpdated } = liquidity;

    return (
        <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="h-full overflow-y-auto px-4 lg:px-8 pb-24 lg:pb-8 max-w-7xl mx-auto pt-6"
        >
            <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-6 mb-8">
                <div>
                    <h1 className="text-3xl font-bold text-white tracking-tight flex items-center gap-3">
                        <div className="p-2 bg-blue-500/20 rounded-xl text-blue-400">
                            <Droplets size={28} />
                        </div>
                        Liquidity Events
                    </h1>
                    <p className="text-zinc-400 text-sm mt-1">
                        Automated structural analysis for {activeSymbol}.
                    </p>
                </div>
                
                <div className="flex items-center gap-4">
                    <div className="text-right hidden md:block">
                        <span className="text-[10px] text-zinc-500 font-bold uppercase block">Last Scan</span>
                        <span className="text-xs text-zinc-300 font-mono">{new Date(lastUpdated).toLocaleTimeString()}</span>
                    </div>
                    <button 
                        onClick={() => refreshLiquidityAnalysis()}
                        className="p-2 rounded-lg bg-zinc-800 border border-zinc-700 text-zinc-400 hover:text-white hover:bg-zinc-700 transition-colors"
                    >
                        <RefreshCw size={18} />
                    </button>
                </div>
            </div>

            {/* Navigation Tabs */}
            <div className="flex gap-2 mb-6 border-b border-white/10 pb-4">
                {[
                    { id: 'SWEEPS', label: 'Sweeps', count: sweeps.length, icon: ScanLine },
                    { id: 'BOS', label: 'Break of Structure', count: bos.length, icon: Layers },
                    { id: 'FVG', label: 'Fair Value Gaps', count: fvg.length, icon: AlertTriangle },
                ].map(tab => (
                    <button
                        key={tab.id}
                        onClick={() => setActiveTab(tab.id as any)}
                        className={`
                            flex items-center gap-2 px-4 py-2 rounded-full text-xs font-bold uppercase tracking-wider transition-all
                            ${activeTab === tab.id 
                                ? 'bg-blue-600 text-white shadow-lg shadow-blue-900/20' 
                                : 'bg-zinc-900/50 text-zinc-500 hover:text-zinc-300 hover:bg-white/5'}
                        `}
                    >
                        <tab.icon size={14} />
                        {tab.label}
                        <span className="ml-1 px-1.5 py-0.5 rounded-full bg-black/20 text-[9px] min-w-[1.5em] text-center">
                            {tab.count}
                        </span>
                    </button>
                ))}
            </div>

            {/* Content Grid */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                
                {/* Main List */}
                <div className="lg:col-span-2 space-y-3">
                    <AnimatePresence mode="wait">
                        {activeTab === 'SWEEPS' && (
                            <motion.div 
                                key="sweeps"
                                initial={{ opacity: 0, y: 10 }}
                                animate={{ opacity: 1, y: 0 }}
                                exit={{ opacity: 0, y: -10 }}
                                className="space-y-2"
                            >
                                {sweeps.length === 0 ? (
                                    <div className="text-center py-12 text-zinc-600 font-mono text-xs">NO SWEEPS DETECTED</div>
                                ) : sweeps.map(s => (
                                    <EventRow 
                                        key={s.id}
                                        label={`${s.side} Liquidity Sweep`}
                                        price={s.price}
                                        time={s.timestamp}
                                        direction={s.side === 'BUY' ? 'BEARISH' : 'BULLISH'} 
                                        type="SWEEP"
                                        subtext={s.side === 'BUY' ? 'HIGHS TAKEN' : 'LOWS TAKEN'}
                                    />
                                ))}
                            </motion.div>
                        )}

                        {activeTab === 'BOS' && (
                            <motion.div 
                                key="bos"
                                initial={{ opacity: 0, y: 10 }}
                                animate={{ opacity: 1, y: 0 }}
                                exit={{ opacity: 0, y: -10 }}
                                className="space-y-2"
                            >
                                {bos.length === 0 ? (
                                    <div className="text-center py-12 text-zinc-600 font-mono text-xs">NO STRUCTURE BREAKS</div>
                                ) : bos.map(b => (
                                    <EventRow 
                                        key={b.id}
                                        label={`${b.direction} BOS`}
                                        price={b.price}
                                        time={b.timestamp}
                                        direction={b.direction} 
                                        type="BOS"
                                    />
                                ))}
                            </motion.div>
                        )}

                        {activeTab === 'FVG' && (
                            <motion.div 
                                key="fvg"
                                initial={{ opacity: 0, y: 10 }}
                                animate={{ opacity: 1, y: 0 }}
                                exit={{ opacity: 0, y: -10 }}
                                className="space-y-2"
                            >
                                {fvg.length === 0 ? (
                                    <div className="text-center py-12 text-zinc-600 font-mono text-xs">EFFICIENT PRICE ACTION</div>
                                ) : fvg.map(f => (
                                    <EventRow 
                                        key={f.id}
                                        label={`${f.direction} Gap`}
                                        price={f.startPrice} // Show start of gap
                                        time={f.timestamp}
                                        direction={f.direction} 
                                        type="FVG"
                                        subtext={`Range: ${Math.abs(f.startPrice - f.endPrice).toFixed(2)}`}
                                    />
                                ))}
                            </motion.div>
                        )}
                    </AnimatePresence>
                </div>

                {/* Explainer Panel */}
                <div className="p-6 rounded-2xl bg-zinc-900/30 border border-white/5 h-fit">
                    <h3 className="text-lg font-bold text-white mb-4">Event Logic</h3>
                    
                    <div className="space-y-6">
                        <div className="space-y-2">
                            <div className="flex items-center gap-2 text-blue-400 text-xs font-bold uppercase tracking-wider">
                                <ScanLine size={14} /> Liquidity Sweeps
                            </div>
                            <p className="text-xs text-zinc-400 leading-relaxed">
                                Occurs when price breaks a swing high/low but fails to close beyond it. 
                                Often signals a reversal as stop orders are triggered.
                            </p>
                        </div>

                        <div className="space-y-2">
                            <div className="flex items-center gap-2 text-emerald-400 text-xs font-bold uppercase tracking-wider">
                                <Layers size={14} /> Break of Structure (BOS)
                            </div>
                            <p className="text-xs text-zinc-400 leading-relaxed">
                                Confirmed trend continuation when candle body closes beyond a previous pivot point.
                            </p>
                        </div>

                        <div className="space-y-2">
                            <div className="flex items-center gap-2 text-amber-400 text-xs font-bold uppercase tracking-wider">
                                <AlertTriangle size={14} /> Fair Value Gaps (FVG)
                            </div>
                            <p className="text-xs text-zinc-400 leading-relaxed">
                                Inefficiencies where price moved too quickly, leaving resting orders unfilled. 
                                Price often returns to these zones.
                            </p>
                        </div>
                    </div>
                </div>

            </div>
        </motion.div>
    );
};

export default LiquidityPage;
