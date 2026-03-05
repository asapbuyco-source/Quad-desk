
import React, { useMemo, useState } from 'react';
import { motion as m, AnimatePresence } from 'framer-motion';
import {
    ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid, Tooltip,
    ResponsiveContainer, Cell, ReferenceLine
} from 'recharts';
import { useStore } from '../store';
import { useVolumeProfileData } from '../hooks/useChart';
import { BarChart2, Activity, Layers, Minus, Anchor, TrendingUp, BrainCircuit, RefreshCw, Zap, ChevronRight, ChevronLeft, GripHorizontal, ChevronDown, ChevronUp } from 'lucide-react';

const motion = m as any;

const CustomTooltip = ({ active, payload, label }: any) => {
    if (active && payload && payload.length) {
        return (
            <div className="bg-[#09090b]/95 backdrop-blur-xl border border-zinc-800 p-3 rounded-lg shadow-xl min-w-[160px] z-50">
                <p className="text-zinc-500 mb-2 font-mono text-[10px] uppercase tracking-wider border-b border-white/5 pb-1">
                    {label}
                </p>
                <div className="space-y-1.5">
                    {payload.map((p: any, idx: number) => (
                        <div key={idx} className="flex justify-between items-center text-xs font-mono">
                            <span className="text-zinc-400 capitalize">{p.name}:</span>
                            <span className="font-bold" style={{ color: p.color }}>
                                {typeof p.value === 'number' ? p.value.toLocaleString(undefined, { maximumFractionDigits: 2 }) : p.value}
                            </span>
                        </div>
                    ))}
                </div>
            </div>
        );
    }
    return null;
};

const StatCard: React.FC<{ label: string; value: string; subValue?: string; color?: string }> = ({ label, value, subValue, color = "text-white" }) => (
    <div className="p-4 rounded-xl bg-zinc-900/40 border border-white/5 flex flex-col justify-between">
        <span className="text-[10px] font-bold text-zinc-500 uppercase tracking-wider">{label}</span>
        <div className="flex items-baseline gap-2 mt-1">
            <span className={`text-2xl font-black font-mono tracking-tighter ${color}`}>{value}</span>
            {subValue && <span className="text-[10px] text-zinc-600 font-mono">{subValue}</span>}
        </div>
    </div>
);

const AnalyticsView: React.FC = () => {
    const { candles, metrics } = useStore(state => state.market);
    const { config, fetchOrderFlowAnalysis } = useStore();
    const { orderFlowAnalysis } = useStore(state => state.ai);

    const [isAiPanelOpen, setIsAiPanelOpen] = useState(false);
    const [analysisHeight, setAnalysisHeight] = useState(160);
    const [analysisCollapsed, setAnalysisCollapsed] = useState(false);

    // 1. Prepare Data for Time-Series Chart (Order Flow)
    const timeData = useMemo(() => {
        return candles.slice(-60).map(c => {
            const buyVol = (c.volume + (c.delta || 0)) / 2;
            const sellVol = (c.volume - (c.delta || 0)) / 2;
            return {
                time: new Date((c.time as number) * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
                price: c.close,
                volume: c.volume,
                delta: c.delta,
                cvd: c.cvd,
                buyVol,
                sellVol: -sellVol,
            };
        });
    }, [candles]);

    // 2. Composite Volume Profile
    const profileData = useVolumeProfileData(candles, 60);

    // 3. Summary Metrics
    const stats = useMemo(() => {
        const totalVol = candles.reduce((acc, c) => acc + c.volume, 0);
        const totalDelta = candles.reduce((acc, c) => acc + (c.delta || 0), 0);
        const poc = profileData.find(p => p.type === 'POC')?.price || 0;
        const startCvd = timeData.length > 0 ? (timeData[0].cvd || 0) : 0;
        const endCvd = timeData.length > 0 ? (timeData[timeData.length - 1].cvd || 0) : 0;
        const cvdTrend = endCvd > startCvd + 50 ? "UP" : endCvd < startCvd - 50 ? "DOWN" : "FLAT";
        return { totalVol, totalDelta, poc, cvdTrend };
    }, [candles, profileData, timeData]);

    const handleAnalysis = () => {
        if (orderFlowAnalysis.isLoading) return;
        fetchOrderFlowAnalysis({
            symbol: config.activeSymbol,
            price: metrics.price,
            netDelta: stats.totalDelta,
            totalVolume: stats.totalVol,
            pocPrice: stats.poc,
            cvdTrend: stats.cvdTrend,
            candleCount: candles.length
        });
    };

    if (!candles || candles.length === 0) {
        return (
            <div className="h-full flex flex-col items-center justify-center text-zinc-600 gap-4">
                <div className="p-4 bg-zinc-900 rounded-full animate-pulse"><Activity size={32} /></div>
                <span className="font-mono text-xs uppercase tracking-widest">Awaiting Market Data feed...</span>
            </div>
        );
    }

    // Verdict Colors
    let verdictColor = "text-zinc-400";
    let verdictBorder = "border-white/10";
    let verdictBg = "from-zinc-900/80 to-black";

    if (orderFlowAnalysis.verdict?.toUpperCase() === 'BULLISH') {
        verdictColor = "text-emerald-400";
        verdictBg = "from-emerald-900/30 to-black";
        verdictBorder = "border-emerald-500/30";
    } else if (orderFlowAnalysis.verdict?.toUpperCase() === 'BEARISH') {
        verdictColor = "text-rose-400";
        verdictBg = "from-rose-900/30 to-black";
        verdictBorder = "border-rose-500/30";
    } else if (orderFlowAnalysis.verdict?.toUpperCase() === 'NEUTRAL') {
        verdictColor = "text-amber-400";
        verdictBg = "from-amber-900/30 to-black";
        verdictBorder = "border-amber-500/30";
    }

    const dotColor = verdictColor === 'text-emerald-400' ? 'bg-emerald-400'
        : verdictColor === 'text-rose-400' ? 'bg-rose-400' : 'bg-amber-400';

    return (
        <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="h-full w-full flex overflow-hidden relative"
        >
            {/* ── LEFT AI SLIDE PANEL ────────────────────────────────────── */}
            <AnimatePresence>
                {isAiPanelOpen && (
                    <motion.div
                        key="ai-panel"
                        initial={{ width: 0, opacity: 0 }}
                        animate={{ width: 340, opacity: 1 }}
                        exit={{ width: 0, opacity: 0 }}
                        transition={{ type: 'spring', stiffness: 300, damping: 30 }}
                        className="h-full shrink-0 overflow-hidden border-r border-white/10 bg-[#09090b] flex flex-col z-10"
                        style={{ minWidth: 0 }}
                    >
                        {/* Panel Header */}
                        <div className="flex items-center justify-between px-4 py-3 border-b border-white/5 bg-white/[0.02] shrink-0">
                            <div className="flex items-center gap-2">
                                <div className="p-1.5 rounded-lg bg-brand-accent/20 text-brand-accent">
                                    <Zap size={13} fill="currentColor" />
                                </div>
                                <span className="text-xs font-bold text-white uppercase tracking-widest">Neural Flow Engine</span>
                            </div>
                            <button onClick={() => setIsAiPanelOpen(false)} className="p-1 rounded text-zinc-500 hover:text-zinc-200 transition-colors">
                                <ChevronLeft size={16} />
                            </button>
                        </div>

                        {/* Panel Content */}
                        <div className={`flex-1 overflow-y-auto p-4 flex flex-col gap-4 bg-gradient-to-b ${verdictBg}`}>
                            {/* Verdict */}
                            {orderFlowAnalysis.verdict ? (
                                <div className={`rounded-xl border ${verdictBorder} p-4 flex flex-col gap-2`}>
                                    <div className="flex items-center justify-between">
                                        <h2 className={`text-4xl font-black tracking-tighter ${verdictColor}`}>
                                            {orderFlowAnalysis.verdict}
                                        </h2>
                                        <span className="text-sm font-mono text-zinc-500 font-bold">
                                            {(orderFlowAnalysis.confidence * 100).toFixed(0)}%
                                        </span>
                                    </div>
                                    <div className="flex items-center justify-between">
                                        <span className="text-[10px] text-zinc-500 font-mono uppercase">Analysis</span>
                                        <button
                                            onClick={() => setAnalysisCollapsed(p => !p)}
                                            className="p-1 rounded text-zinc-600 hover:text-zinc-300 transition-colors"
                                        >
                                            {analysisCollapsed ? <ChevronDown size={12} /> : <ChevronUp size={12} />}
                                        </button>
                                    </div>
                                    {!analysisCollapsed && (
                                        <div
                                            className="rounded-lg border border-white/5 bg-black/30 flex flex-col overflow-hidden"
                                            style={{ height: analysisHeight }}
                                        >
                                            <p className="text-xs text-zinc-300 leading-relaxed whitespace-pre-wrap overflow-y-auto flex-1 p-3 font-light">
                                                {orderFlowAnalysis.explanation}
                                            </p>
                                            <div
                                                onPointerDown={(e) => {
                                                    e.currentTarget.setPointerCapture(e.pointerId);
                                                    const startY = e.clientY;
                                                    const startH = analysisHeight;
                                                    const onMove = (ev: PointerEvent) => setAnalysisHeight(Math.max(60, Math.min(500, startH + ev.clientY - startY)));
                                                    const onUp = () => { window.removeEventListener('pointermove', onMove); window.removeEventListener('pointerup', onUp); };
                                                    window.addEventListener('pointermove', onMove);
                                                    window.addEventListener('pointerup', onUp);
                                                }}
                                                style={{ cursor: 'ns-resize', touchAction: 'none' }}
                                                className="shrink-0 flex items-center justify-center h-4 bg-white/[0.03] border-t border-white/5 hover:bg-white/[0.07] transition-colors"
                                                title="Drag to resize"
                                            >
                                                <GripHorizontal size={10} className="text-zinc-600" />
                                            </div>
                                        </div>
                                    )}
                                    <div className="flex items-center gap-2 mt-1">
                                        <span className="text-[10px] text-zinc-500 font-mono uppercase">Context: {orderFlowAnalysis.flowType}</span>
                                        <span className="text-zinc-700">•</span>
                                        <span className="text-[10px] text-zinc-500 font-mono">{new Date(orderFlowAnalysis.timestamp).toLocaleTimeString()}</span>
                                    </div>
                                </div>
                            ) : (
                                <div className="rounded-xl border border-white/5 p-4 text-zinc-500 text-sm italic leading-relaxed">
                                    Click <span className="text-white font-bold not-italic">Synthesize Flow</span> below to run AI inference on current order flow dynamics.
                                </div>
                            )}

                            {/* Generate Button */}
                            <button
                                onClick={handleAnalysis}
                                disabled={orderFlowAnalysis.isLoading}
                                className={`w-full flex items-center justify-center gap-2 px-6 py-3.5 rounded-xl font-bold uppercase text-xs tracking-wider transition-all shadow-lg
                                    ${orderFlowAnalysis.isLoading
                                        ? 'bg-zinc-800 text-zinc-500 cursor-wait'
                                        : 'bg-white text-black hover:bg-zinc-200 hover:scale-[1.02]'}`}
                            >
                                <RefreshCw size={14} className={orderFlowAnalysis.isLoading ? "animate-spin" : ""} />
                                {orderFlowAnalysis.isLoading ? "Synthesizing..." : "Synthesize Flow"}
                            </button>

                            {/* Context Stats */}
                            <div className="border-t border-white/5 pt-4 flex flex-col gap-2">
                                <span className="text-[10px] text-zinc-600 font-mono uppercase tracking-wider">Input Data</span>
                                {[
                                    { label: 'Session Vol', value: (stats.totalVol / 1000).toFixed(1) + 'K lots', color: '' },
                                    { label: 'Net Delta', value: (stats.totalDelta > 0 ? '+' : '') + (stats.totalDelta / 1000).toFixed(1) + 'K', color: stats.totalDelta > 0 ? 'text-emerald-400' : 'text-rose-400' },
                                    { label: 'POC', value: stats.poc.toFixed(2), color: 'text-amber-400' },
                                    { label: 'CVD Trend', value: stats.cvdTrend, color: stats.cvdTrend === 'UP' ? 'text-emerald-400' : stats.cvdTrend === 'DOWN' ? 'text-rose-400' : 'text-zinc-400' },
                                ].map(({ label, value, color }) => (
                                    <div key={label} className="flex justify-between items-center text-xs font-mono">
                                        <span className="text-zinc-500">{label}</span>
                                        <span className={color || 'text-white'}>{value}</span>
                                    </div>
                                ))}
                            </div>
                        </div>
                    </motion.div>
                )}
            </AnimatePresence>

            {/* ── AI PANEL TRIGGER TAB (left edge) ─────────────────────── */}
            <button
                onClick={() => setIsAiPanelOpen(p => !p)}
                className={`absolute left-0 top-1/2 -translate-y-1/2 z-20 flex flex-col items-center gap-1.5 py-4 px-2 rounded-r-xl border-y border-r transition-all duration-200
                    ${isAiPanelOpen
                        ? 'bg-brand-accent/20 border-brand-accent/30 text-brand-accent shadow-[0_0_20px_rgba(59,130,246,0.2)]'
                        : 'bg-zinc-900 border-white/10 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200 hover:border-white/20'}`}
                title={isAiPanelOpen ? 'Close AI Panel' : 'Open AI Analysis Panel'}
            >
                <BrainCircuit size={14} />
                <span className="font-bold text-[8px] uppercase tracking-widest" style={{ writingMode: 'vertical-rl', transform: 'rotate(180deg)' }}>
                    AI Flow
                </span>
                {isAiPanelOpen ? <ChevronLeft size={11} /> : <ChevronRight size={11} />}
                {orderFlowAnalysis.verdict && (
                    <div className={`w-1.5 h-1.5 rounded-full mt-1 ${dotColor}`} />
                )}
            </button>

            {/* ── MAIN CONTENT ─────────────────────────────────────────── */}
            <div className="flex-1 min-w-0 h-full overflow-y-auto pl-6 pr-4 lg:pr-8 pb-24 lg:pb-8 pt-6">
                <div className="max-w-7xl mx-auto flex flex-col gap-6">

                    {/* Header Metrics */}
                    <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                        <div className="md:col-span-1 flex items-center gap-3">
                            <div className="p-3 bg-brand-accent/20 rounded-xl text-brand-accent">
                                <BarChart2 size={24} />
                            </div>
                            <div>
                                <h1 className="text-xl font-bold text-white tracking-tight">Order Flow</h1>
                                <p className="text-xs text-zinc-400">Deep Market Analytics</p>
                            </div>
                        </div>
                        <StatCard label="Session Volume" value={(stats.totalVol / 1000).toFixed(1) + 'K'} subValue="LOTS" />
                        <StatCard label="Net Delta" value={(stats.totalDelta > 0 ? '+' : '') + (stats.totalDelta / 1000).toFixed(1) + 'K'} color={stats.totalDelta > 0 ? 'text-emerald-400' : 'text-rose-400'} subValue="AGGR." />
                        <StatCard label="Point of Control" value={stats.poc.toFixed(2)} color="text-amber-400" subValue="HVN" />
                    </div>

                    {/* AI quick-status bar (shows when panel is closed) */}
                    {!isAiPanelOpen && orderFlowAnalysis.verdict && (
                        <button
                            onClick={() => setIsAiPanelOpen(true)}
                            className={`w-full flex items-center gap-3 px-4 py-2.5 rounded-xl border ${verdictBorder} bg-gradient-to-r ${verdictBg} hover:opacity-90 transition-opacity text-left`}
                        >
                            <BrainCircuit size={14} className={verdictColor} />
                            <span className={`font-black text-sm tracking-tight ${verdictColor}`}>{orderFlowAnalysis.verdict}</span>
                            <span className="text-zinc-500 text-xs font-mono">{(orderFlowAnalysis.confidence * 100).toFixed(0)}% confidence</span>
                            <span className="ml-auto text-zinc-600 text-[10px] font-mono uppercase">Click to expand →</span>
                        </button>
                    )}
                    {!isAiPanelOpen && !orderFlowAnalysis.verdict && (
                        <button
                            onClick={() => setIsAiPanelOpen(true)}
                            className="w-full flex items-center gap-3 px-4 py-2.5 rounded-xl border border-white/5 bg-zinc-900/30 hover:bg-zinc-900/60 transition-colors text-left"
                        >
                            <BrainCircuit size={14} className="text-zinc-600" />
                            <span className="text-zinc-500 text-xs font-mono">Neural Flow Engine — Click to generate AI order flow analysis</span>
                            <ChevronRight size={12} className="ml-auto text-zinc-600" />
                        </button>
                    )}

                    {/* Main Charts Area */}
                    <div className="flex-1 grid grid-cols-1 lg:grid-cols-3 gap-6 min-h-[500px]">

                        {/* CHART 1: Time-Based Order Flow */}
                        <div className="lg:col-span-2 fintech-card flex flex-col overflow-hidden relative">
                            <div className="p-4 border-b border-white/5 flex justify-between items-center bg-white/[0.02]">
                                <div className="flex items-center gap-2 text-sm font-bold text-zinc-300">
                                    <Activity size={16} className="text-emerald-400" />
                                    <span>Delta Flow &amp; CVD</span>
                                </div>
                                <div className="flex gap-4 text-[10px] font-mono text-zinc-500">
                                    <span className="flex items-center gap-1"><div className="w-2 h-2 bg-emerald-500/50 rounded-sm"></div> BUY VOL</span>
                                    <span className="flex items-center gap-1"><div className="w-2 h-2 bg-rose-500/50 rounded-sm"></div> SELL VOL</span>
                                    <span className="flex items-center gap-1"><div className="w-2 h-0.5 bg-yellow-400"></div> CVD</span>
                                </div>
                            </div>
                            <div className="flex-1 w-full min-h-0 p-2">
                                <ResponsiveContainer width="100%" height="100%">
                                    <ComposedChart data={timeData} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                                        <defs>
                                            <linearGradient id="gradBuy" x1="0" y1="0" x2="0" y2="1">
                                                <stop offset="0%" stopColor="#10b981" stopOpacity={0.4} />
                                                <stop offset="100%" stopColor="#10b981" stopOpacity={0.1} />
                                            </linearGradient>
                                            <linearGradient id="gradSell" x1="0" y1="0" x2="0" y2="1">
                                                <stop offset="0%" stopColor="#f43f5e" stopOpacity={0.1} />
                                                <stop offset="100%" stopColor="#f43f5e" stopOpacity={0.4} />
                                            </linearGradient>
                                        </defs>
                                        <CartesianGrid strokeDasharray="3 3" stroke="#27272a" vertical={false} />
                                        <XAxis dataKey="time" stroke="#52525b" tick={{ fontSize: 9 }} tickLine={false} axisLine={false} minTickGap={30} />
                                        <YAxis yAxisId="vol" stroke="#52525b" tick={{ fontSize: 9 }} tickLine={false} axisLine={false} tickFormatter={(val) => Math.abs(val).toLocaleString()} />
                                        <YAxis yAxisId="cvd" orientation="right" stroke="#fbbf24" tick={{ fontSize: 9 }} tickLine={false} axisLine={false} hide />
                                        <Tooltip content={<CustomTooltip />} cursor={{ fill: '#ffffff05' }} />
                                        <ReferenceLine y={0} yAxisId="vol" stroke="#3f3f46" />
                                        <Bar yAxisId="vol" dataKey="buyVol" fill="url(#gradBuy)" barSize={6} radius={[2, 2, 0, 0]} name="Buy Vol" />
                                        <Bar yAxisId="vol" dataKey="sellVol" fill="url(#gradSell)" barSize={6} radius={[0, 0, 2, 2]} name="Sell Vol" />
                                        <Line yAxisId="cvd" type="monotone" dataKey="cvd" stroke="#fbbf24" strokeWidth={2} dot={false} name="CVD" />
                                    </ComposedChart>
                                </ResponsiveContainer>
                            </div>
                        </div>

                        {/* CHART 2: Composite Volume Profile */}
                        <div className="fintech-card flex flex-col overflow-hidden relative">
                            <div className="p-4 border-b border-white/5 flex justify-between items-center bg-white/[0.02]">
                                <div className="flex items-center gap-2 text-sm font-bold text-zinc-300">
                                    <Layers size={16} className="text-amber-400" />
                                    <span>Composite Profile</span>
                                </div>
                                <div className="text-[10px] font-mono text-zinc-500 uppercase">Price Distribution</div>
                            </div>
                            <div className="flex-1 w-full min-h-0 p-2 pl-0">
                                <ResponsiveContainer width="100%" height="100%">
                                    <ComposedChart layout="vertical" data={profileData} margin={{ top: 10, right: 20, left: 0, bottom: 0 }} barCategoryGap={1}>
                                        <CartesianGrid strokeDasharray="3 3" stroke="#27272a" horizontal={false} />
                                        <XAxis type="number" stroke="#52525b" tick={{ fontSize: 9 }} tickLine={false} axisLine={false} />
                                        <YAxis type="category" dataKey="price" stroke="#52525b" tick={{ fontSize: 9 }} tickLine={false} axisLine={false} width={50} orientation="right" />
                                        <Tooltip
                                            cursor={{ fill: '#ffffff05' }}
                                            content={({ active, payload }) => {
                                                if (active && payload && payload.length) {
                                                    const d = payload[0].payload;
                                                    return (
                                                        <div className="bg-[#09090b]/95 backdrop-blur-xl border border-zinc-800 p-2 rounded-lg shadow-xl z-50">
                                                            <p className="text-white font-mono text-xs font-bold mb-1">{d.rangeLabel}</p>
                                                            <p className="text-zinc-400 text-[10px] font-mono">VOL: <span className="text-white">{d.vol.toLocaleString()}</span></p>
                                                            <p className="text-amber-500 text-[9px] font-bold mt-1 uppercase">{d.type}</p>
                                                        </div>
                                                    );
                                                }
                                                return null;
                                            }}
                                        />
                                        <Bar dataKey="vol" minPointSize={2} barSize={10} radius={[0, 2, 2, 0]}>
                                            {profileData.map((entry, index) => {
                                                let color = '#27272a';
                                                if (entry.type === 'POC') color = '#f59e0b';
                                                else if (entry.type === 'HVN') color = '#3b82f6';
                                                else if (entry.type === 'LVN') color = '#18181b';
                                                return <Cell key={`cell-${index}`} fill={color} />;
                                            })}
                                        </Bar>
                                        {stats.poc > 0 && (
                                            <ReferenceLine y={stats.poc} stroke="#f59e0b" strokeDasharray="3 3" label={{ position: 'insideLeft', value: 'POC', fill: '#f59e0b', fontSize: 9 }} />
                                        )}
                                    </ComposedChart>
                                </ResponsiveContainer>
                            </div>
                            <div className="p-3 border-t border-white/5 bg-white/[0.02] flex justify-between text-[10px] text-zinc-500 font-mono">
                                <span>Low: {profileData[profileData.length - 1]?.price.toFixed(2)}</span>
                                <span>High: {profileData[0]?.price.toFixed(2)}</span>
                            </div>
                        </div>
                    </div>

                    {/* Explainer Footer */}
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4 pb-4">
                        <div className="p-3 rounded-lg bg-zinc-900/30 border border-white/5 flex items-start gap-3">
                            <TrendingUp size={16} className="text-yellow-400 shrink-0 mt-0.5" />
                            <div>
                                <h4 className="text-xs font-bold text-zinc-300">CVD Divergence</h4>
                                <p className="text-[10px] text-zinc-500 leading-tight mt-1">If Price makes a Lower Low but CVD makes a Higher Low, aggressive absorption is occurring (Bullish).</p>
                            </div>
                        </div>
                        <div className="p-3 rounded-lg bg-zinc-900/30 border border-white/5 flex items-start gap-3">
                            <Anchor size={16} className="text-amber-400 shrink-0 mt-0.5" />
                            <div>
                                <h4 className="text-xs font-bold text-zinc-300">Point of Control (POC)</h4>
                                <p className="text-[10px] text-zinc-500 leading-tight mt-1">The price level with the highest traded volume. Often acts as a magnet for price reversion.</p>
                            </div>
                        </div>
                        <div className="p-3 rounded-lg bg-zinc-900/30 border border-white/5 flex items-start gap-3">
                            <Minus size={16} className="text-blue-400 shrink-0 mt-0.5" />
                            <div>
                                <h4 className="text-xs font-bold text-zinc-300">High Volume Nodes (HVN)</h4>
                                <p className="text-[10px] text-zinc-500 leading-tight mt-1">Areas of significant acceptance. Price tends to consolidate here before moving to the next node.</p>
                            </div>
                        </div>
                    </div>

                </div>
            </div>
        </motion.div>
    );
};

export default AnalyticsView;
