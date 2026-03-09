import React from 'react';
import { MarketMetrics } from '../types';
import { Activity, Skull, TrendingUp, Anchor, BarChart2, ArrowRight, TrendingDown, Waves, Zap, Layers, GitMerge } from 'lucide-react';
import { motion as m } from 'framer-motion';
import { useStore } from '../store';

const motion = m as any;

interface OrderFlowMetricsProps {
    metrics: MarketMetrics;
}

const WhaleHunterWidget: React.FC<{ metrics: MarketMetrics }> = ({ metrics }) => {
    const cumulativeCvd = metrics.institutionalCVD;
    const contextValue = metrics.cvdContext?.value || 0;
    const interpretation = metrics.cvdContext?.interpretation || 'NEUTRAL';
    const divergence = metrics.cvdContext?.divergence || 'NONE';

    let statusColor = "text-slate-400";
    let statusBg = "bg-slate-500/10";
    let statusIcon = <Activity size={12} />;

    if (interpretation === 'REAL STRENGTH') {
        statusColor = "text-emerald-400"; statusBg = "bg-emerald-500/10"; statusIcon = <TrendingUp size={12} />;
    } else if (interpretation === 'REAL WEAKNESS') {
        statusColor = "text-rose-400"; statusBg = "bg-rose-500/10"; statusIcon = <TrendingDown size={12} />;
    } else if (interpretation === 'ABSORPTION') {
        statusColor = "text-amber-400"; statusBg = "bg-amber-500/10"; statusIcon = <Anchor size={12} />;
    } else if (interpretation === 'DISTRIBUTION') {
        statusColor = "text-orange-400"; statusBg = "bg-orange-500/10"; statusIcon = <Anchor size={12} />;
    }

    return (
        <div className="fintech-card p-4 relative overflow-hidden flex flex-col justify-between h-full group">
            <div className="flex justify-between items-start relative z-10">
                <div className="flex flex-col">
                    <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest flex items-center gap-1">
                        <Anchor size={12} className={cumulativeCvd > 0 ? "text-emerald-400" : "text-rose-400"} />
                        Cumulative Delta
                    </span>
                    <span className="text-xs text-slate-500 font-mono mt-0.5">Aggressive Vol. Tracker</span>
                </div>
                <div className={`px-2 py-0.5 rounded border border-white/5 text-[9px] font-black uppercase tracking-wider flex items-center gap-1 ${statusColor} ${statusBg}`}>
                    {statusIcon} {interpretation}
                </div>
            </div>

            <div className="flex flex-col items-center justify-center my-2">
                <span className={`text-3xl font-mono font-black tracking-tighter ${cumulativeCvd > 0 ? "text-emerald-500" : "text-rose-500"}`}>
                    {cumulativeCvd > 0 ? "+" : ""}{cumulativeCvd.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                </span>
                <span className="text-[9px] text-zinc-500 uppercase tracking-wide">Net Market Contracts</span>
            </div>

            <div className="flex flex-col gap-2 mt-auto">
                {divergence !== 'NONE' && (
                    <motion.div
                        initial={{ opacity: 0 }} animate={{ opacity: 1 }}
                        className="text-center text-[9px] font-bold text-amber-500 uppercase bg-amber-500/10 py-1 rounded border border-amber-500/20"
                    >
                        ⚠ {divergence === 'BULLISH_ABSORPTION' ? 'Hidden Buying Detected' : 'Hidden Selling Detected'}
                    </motion.div>
                )}
                <div className="h-1 w-full bg-slate-800 rounded-full overflow-hidden flex relative">
                    <div className="absolute left-1/2 top-0 bottom-0 w-0.5 bg-white/20 z-10" />
                    <motion.div
                        animate={{
                            width: `${Math.min(Math.abs(contextValue), 50)}%`,
                            left: contextValue > 0 ? '50%' : 'auto',
                            right: contextValue < 0 ? '50%' : 'auto'
                        }}
                        className={`h-full relative ${contextValue > 0 ? 'bg-emerald-500' : 'bg-rose-500'}`}
                    />
                </div>
                <div className="flex justify-between text-[8px] font-mono text-slate-600">
                    <span>Sell Pressure</span>
                    <span>Buy Pressure</span>
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
        icon = <TrendingUp size={24} />; title = "Momentum"; desc = "Trending Market";
        color = "text-emerald-400"; bg = "bg-emerald-500/10";
    } else if (regime === 'HIGH_VOLATILITY') {
        icon = <Zap size={24} />; title = "Expansion"; desc = "High Volatility";
        color = "text-amber-400"; bg = "bg-amber-500/10";
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
                    <div className={`p-3 rounded-xl w-fit ${bg} ${color} mb-2`}>{icon}</div>
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
};

/** Feature: Cumulative OFI (COFI) Widget */
const CofiWidget: React.FC = () => {
    const cofi = useStore(s => s.cofi);
    const isPositive = cofi >= 0;
    const color = isPositive ? 'text-emerald-400' : 'text-rose-400';
    const bg = isPositive ? 'bg-emerald-500/10 border-emerald-500/20' : 'bg-rose-500/10 border-rose-500/20';
    const Icon = isPositive ? TrendingUp : TrendingDown;

    // Clamp for gauge: treat ±500 as full-scale
    const pct = Math.min(Math.abs(cofi) / 500 * 100, 100);

    return (
        <div className="fintech-card p-4 flex flex-col justify-between relative overflow-hidden">
            <div className="absolute top-0 right-0 p-4 opacity-5 pointer-events-none">
                <Layers size={64} />
            </div>
            <div className="flex justify-between items-start z-10">
                <div>
                    <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest flex items-center gap-1">
                        <Layers size={12} className={color} /> Cumulative OFI
                    </span>
                    <span className="text-xs text-slate-500 font-mono mt-0.5 block">Session Flow Pressure</span>
                </div>
                <div className={`px-2 py-0.5 rounded border text-[9px] font-black uppercase tracking-wider flex items-center gap-1 ${color} ${bg}`}>
                    <Icon size={10} /> {isPositive ? 'BUY BIAS' : 'SELL BIAS'}
                </div>
            </div>

            <div className="flex flex-col items-center justify-center my-3 z-10">
                <span className={`text-3xl font-mono font-black tracking-tighter ${color}`}>
                    {cofi > 0 ? '+' : ''}{cofi.toFixed(1)}
                </span>
                <span className="text-[9px] text-zinc-500 uppercase tracking-wide">Δ OFI Accumulated</span>
            </div>

            <div className="mt-auto z-10 space-y-1.5">
                <div className="flex justify-between text-[8px] font-mono text-slate-600 uppercase">
                    <span>Sell Bias</span><span>Buy Bias</span>
                </div>
                <div className="h-1.5 w-full bg-slate-800 rounded-full overflow-hidden relative">
                    <div className="absolute left-1/2 top-0 bottom-0 w-0.5 bg-white/20 z-10" />
                    <motion.div
                        animate={{
                            width: `${pct / 2}%`,
                            left: isPositive ? '50%' : 'auto',
                            right: !isPositive ? '50%' : 'auto',
                        }}
                        className={`absolute top-0 bottom-0 ${isPositive ? 'bg-emerald-500' : 'bg-rose-500'}`}
                    />
                </div>
                <p className="text-[8px] text-zinc-600 text-center">
                    Resets on CVD reset · Scale: ±500 = full bar
                </p>
            </div>
        </div>
    );
};

/** Feature: Multi-Timeframe OFI Convergence Widget */
const MtfOfiWidget: React.FC = () => {
    const ofiHistory = useStore(s => s.ofiHistory);
    const n = ofiHistory.length;

    const avg = (arr: number[]) => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
    const short = avg(ofiHistory.slice(-5));   // ~5-bar  (last 5 readings)
    const mid = avg(ofiHistory.slice(-20));  // ~20-bar
    const long = avg(ofiHistory.slice(-60));  // ~60-bar

    const classify = (v: number) => v > 5 ? 'BULL' : v < -5 ? 'BEAR' : 'NEUT';
    const sClass = classify(short);
    const mClass = classify(mid);
    const lClass = classify(long);

    const allBull = sClass === 'BULL' && mClass === 'BULL' && lClass === 'BULL';
    const allBear = sClass === 'BEAR' && mClass === 'BEAR' && lClass === 'BEAR';
    const converge = allBull ? 'BULLISH' : allBear ? 'BEARISH' : 'MIXED';

    const barColor = (cls: string) =>
        cls === 'BULL' ? 'bg-emerald-500' : cls === 'BEAR' ? 'bg-rose-500' : 'bg-zinc-600';
    const textColor = (cls: string) =>
        cls === 'BULL' ? 'text-emerald-400' : cls === 'BEAR' ? 'text-rose-400' : 'text-zinc-400';

    const labelsAndValues = [
        { label: 'Short (5)', val: short, cls: sClass },
        { label: 'Mid (20)', val: mid, cls: mClass },
        { label: 'Long (60)', val: long, cls: lClass },
    ];

    return (
        <div className="fintech-card p-4 flex flex-col justify-between relative overflow-hidden">
            <div className="absolute top-0 right-0 p-4 opacity-5 pointer-events-none">
                <GitMerge size={64} />
            </div>

            <div className="flex justify-between items-start z-10">
                <div>
                    <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest flex items-center gap-1">
                        <GitMerge size={12} className="text-purple-400" /> MTF OFI
                    </span>
                    <span className="text-xs text-slate-500 font-mono mt-0.5 block">Multi-Timeframe Convergence</span>
                </div>
                <div className={`px-2 py-0.5 rounded border text-[9px] font-black uppercase tracking-wider ${converge === 'BULLISH' ? 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20 animate-pulse' :
                        converge === 'BEARISH' ? 'text-rose-400 bg-rose-500/10 border-rose-500/20 animate-pulse' :
                            'text-zinc-400 bg-zinc-800 border-zinc-700'
                    }`}>
                    {converge}
                </div>
            </div>

            <div className="mt-4 space-y-3 z-10">
                {n < 5 && (
                    <p className="text-[10px] text-zinc-500 text-center py-2">Collecting data…</p>
                )}
                {n >= 5 && labelsAndValues.map(({ label, val, cls }) => (
                    <div key={label}>
                        <div className="flex justify-between text-[10px] font-mono mb-1">
                            <span className="text-zinc-500">{label}</span>
                            <span className={`font-bold ${textColor(cls)}`}>
                                {val > 0 ? '+' : ''}{val.toFixed(1)}  <span className="text-[8px]">{cls}</span>
                            </span>
                        </div>
                        <div className="h-1 bg-slate-800 rounded-full overflow-hidden relative">
                            <div className="absolute left-1/2 top-0 bottom-0 w-px bg-white/10 z-10" />
                            <motion.div
                                animate={{
                                    width: `${Math.min(Math.abs(val) / 2, 50)}%`,
                                    left: val > 0 ? '50%' : 'auto',
                                    right: val < 0 ? '50%' : 'auto',
                                }}
                                className={`absolute top-0 bottom-0 ${barColor(cls)}`}
                            />
                        </div>
                    </div>
                ))}
            </div>

            {(allBull || allBear) && (
                <motion.div
                    initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }}
                    className={`mt-3 text-center text-[9px] font-bold uppercase py-1 rounded border ${allBull ? 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20' : 'text-rose-400 bg-rose-500/10 border-rose-500/20'
                        }`}
                >
                    ⚡ All TF Aligned — High-Confidence {allBull ? 'Buy' : 'Sell'} Signal
                </motion.div>
            )}
        </div>
    );
};

const OrderFlowMetrics: React.FC<OrderFlowMetricsProps> = ({ metrics }) => {
    const ofiColor = metrics.ofi > 0 ? "text-trade-bid" : metrics.ofi < 0 ? "text-trade-ask" : "text-slate-500";
    const ofiBg = metrics.ofi > 0 ? "bg-trade-bid" : metrics.ofi < 0 ? "bg-trade-ask" : "bg-slate-500";
    const dominanceLabel = Math.abs(metrics.ofi) > 50 ? (metrics.ofi > 0 ? "Aggressive Buying" : "Aggressive Selling") : "Balanced Flow";

    let signalState = "NEUTRAL";
    if (Math.abs(metrics.ofi) > 30) {
        signalState = metrics.ofi > 0 ? "VALIDATION (BULL)" : "VALIDATION (BEAR)";
    }

    return (
        <div className="space-y-6">
            {/* Row 1: CVD / Regime / OFI (existing) */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                <WhaleHunterWidget metrics={metrics} />
                <RegimeWidget metrics={metrics} />

                {/* Widget 3: OFI */}
                <div className="fintech-card p-4 flex flex-col justify-between relative overflow-hidden group">
                    <div className="absolute top-0 right-0 p-4 opacity-5 group-hover:opacity-10 transition-opacity">
                        <BarChart2 size={64} />
                    </div>
                    <div className="flex justify-between items-start z-10 relative">
                        <div className="flex flex-col">
                            <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest flex items-center gap-1">
                                <Activity size={12} className={ofiColor} /> Book Imbalance
                            </span>
                            <span className={`text-[10px] font-bold font-mono mt-1 ${ofiColor} bg-white/5 px-1.5 py-0.5 rounded w-fit`}>
                                {dominanceLabel}
                            </span>
                        </div>
                        <div className="flex flex-col items-end">
                            <span className={`text-2xl font-mono font-bold ${ofiColor}`}>
                                {metrics.ofi > 0 ? '+' : ''}{metrics.ofi.toFixed(1)}%
                            </span>
                            <span className="text-[9px] text-slate-500 font-mono">NET PRESSURE</span>
                        </div>
                    </div>
                    <div className="mt-4 z-10">
                        <div className="w-full h-1.5 bg-slate-800 rounded-full overflow-hidden relative flex">
                            <div className="absolute left-1/2 top-0 bottom-0 w-0.5 bg-white/20 z-20"></div>
                            <motion.div
                                animate={{
                                    left: metrics.ofi > 0 ? '50%' : 'auto',
                                    right: metrics.ofi < 0 ? '50%' : 'auto',
                                    width: `${Math.min(Math.abs(metrics.ofi) / 2, 50)}%`
                                }}
                                className={`absolute top-0 bottom-0 ${ofiBg}`}
                            />
                        </div>
                        <div className="flex justify-between mt-1 text-[8px] font-mono text-slate-600 uppercase">
                            <span>Sell Side</span><span>Buy Side</span>
                        </div>
                    </div>
                    <div className="mt-3 flex justify-between items-center border-t border-white/5 pt-2 z-10">
                        <div className="flex items-center gap-2">
                            <span className="text-[10px] text-slate-500 font-bold uppercase">Signal</span>
                            <ArrowRight size={10} className="text-slate-600" />
                        </div>
                        <div className={`text-[10px] font-bold px-2 py-0.5 rounded border ${signalState.includes("VALIDATION") ? "border-emerald-500/20 bg-emerald-500/10 text-emerald-400" :
                                "border-zinc-700 bg-zinc-800 text-zinc-400"
                            }`}>
                            {signalState}
                        </div>
                    </div>
                    <div className="mt-1 flex items-center gap-2 justify-end opacity-60 hover:opacity-100 transition-opacity cursor-help" title="Flow Toxicity (HFT Activity)">
                        <Skull size={10} className="text-zinc-500" />
                        <span className="text-[9px] font-mono text-zinc-500">TOX: {metrics.toxicity}</span>
                    </div>
                </div>
            </div>

            {/* Row 2: NEW — COFI + MTF OFI */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <CofiWidget />
                <MtfOfiWidget />
            </div>
        </div>
    );
};

export default OrderFlowMetrics;