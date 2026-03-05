
import React, { useEffect, useRef } from 'react';
import { motion as m } from 'framer-motion';
import { useStore } from '../store';
import { Eye, ArrowDownCircle, ArrowUpCircle, RefreshCw, Activity, Zap, AlertTriangle, TrendingDown, TrendingUp, Minus } from 'lucide-react';
import {
    BarChart, Bar, XAxis, YAxis, ResponsiveContainer, Cell, Tooltip, ReferenceLine, LineChart, Line
} from 'recharts';
import { WhaleTransfer, DarkPrint } from '../types';

const motion = m as any;

// ─── Helpers ────────────────────────────────────────────────────────────────

const fmtBTC = (n: number) => `${n.toFixed(1)} BTC`;
const fmtUSD = (n: number) =>
    n >= 1_000_000_000 ? `$${(n / 1_000_000_000).toFixed(2)}B`
        : n >= 1_000_000 ? `$${(n / 1_000_000).toFixed(1)}M`
            : `$${(n / 1_000).toFixed(0)}K`;
const timeAgo = (ts: number) => {
    const s = Math.floor((Date.now() - ts) / 1000);
    if (s < 60) return `${s}s ago`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ago`;
    return `${Math.floor(m / 60)}h ago`;
};

// ─── Bias Gauge (SVG Arc) ────────────────────────────────────────────────────

const BiasGauge: React.FC<{ bias: number; history: number[] }> = ({ bias, history }) => {
    const clampedBias = Math.max(-1, Math.min(1, bias));
    // Arc from -180° to 0° (left = -1, center = 0, right = +1)
    const angleDeg = clampedBias * 90; // -90 to +90 relative to bottom of arc
    const needleAngle = -90 + (clampedBias + 1) * 90; // maps -1→-90, 0→0, 1→90

    const cx = 120, cy = 120, r = 90;
    const arcPath = (startDeg: number, endDeg: number, color: string) => {
        const toRad = (d: number) => ((d - 90) * Math.PI) / 180;
        const sx = cx + r * Math.cos(toRad(startDeg));
        const sy = cy + r * Math.sin(toRad(startDeg));
        const ex = cx + r * Math.cos(toRad(endDeg));
        const ey = cy + r * Math.sin(toRad(endDeg));
        const large = endDeg - startDeg > 180 ? 1 : 0;
        return <path d={`M${sx},${sy} A${r},${r} 0 ${large},1 ${ex},${ey}`}
            stroke={color} strokeWidth={14} fill="none" strokeLinecap="round" />;
    };

    // Gauge goes from 180° (left) to 360° (right), treating top of circle as 270°
    // We'll use 180°→360° arc, where 270° = top = neutral
    const absAngle = 180 + (clampedBias + 1) * 90; // 180→360
    const needleRad = ((absAngle - 90) * Math.PI) / 180;
    const nx = cx + (r - 10) * Math.cos(needleRad);
    const ny = cy + (r - 10) * Math.sin(needleRad);

    const gaugeColor = clampedBias > 0.3 ? '#10b981' : clampedBias < -0.3 ? '#f43f5e' : '#f59e0b';
    const sparkData = history.map((v, i) => ({ i, v }));

    return (
        <div className="flex flex-col items-center gap-4">
            <svg width={240} height={150} viewBox="0 0 240 150">
                {/* Background arc */}
                {arcPath(180, 360, '#1f2937')}
                {/* Coloured zones */}
                {arcPath(180, 240, '#f43f5e44')}
                {arcPath(240, 300, '#f59e0b44')}
                {arcPath(300, 360, '#10b98144')}
                {/* Active zone fill */}
                {clampedBias < 0 && arcPath(180, 180 + (clampedBias + 1) * 90, '#f43f5e')}
                {clampedBias > 0 && arcPath(270, 270 + clampedBias * 90, '#10b981')}
                {/* Needle */}
                <line x1={cx} y1={cy} x2={nx} y2={ny} stroke={gaugeColor} strokeWidth={3} strokeLinecap="round" />
                <circle cx={cx} cy={cy} r={6} fill={gaugeColor} />
                {/* Labels */}
                <text x={22} y={138} fill="#f43f5e" fontSize={10} fontWeight="bold">−1</text>
                <text x={cx - 6} y={40} fill="#f59e0b" fontSize={10} fontWeight="bold">0</text>
                <text x={210} y={138} fill="#10b981" fontSize={10} fontWeight="bold">+1</text>
                {/* Value */}
                <text x={cx} y={cy + 28} textAnchor="middle" fill={gaugeColor} fontSize={22} fontWeight="900">
                    {clampedBias > 0 ? '+' : ''}{clampedBias.toFixed(2)}
                </text>
                <text x={cx} y={cy + 44} textAnchor="middle" fill="#6b7280" fontSize={9} fontWeight="bold">
                    {clampedBias > 0.3 ? 'BULLISH INSTITUTIONS' : clampedBias < -0.3 ? 'BEARISH INSTITUTIONS' : 'NEUTRAL FLOW'}
                </text>
            </svg>
            {/* Sparkline of last 20 bias readings */}
            {sparkData.length > 1 && (
                <ResponsiveContainer width="100%" height={36}>
                    <LineChart data={sparkData}>
                        <YAxis domain={[-1, 1]} hide />
                        <Line type="monotone" dataKey="v" stroke={gaugeColor} strokeWidth={1.5} dot={false} isAnimationActive={false} />
                        <ReferenceLine y={0} stroke="#374151" strokeDasharray="3 3" />
                    </LineChart>
                </ResponsiveContainer>
            )}
        </div>
    );
};

// ─── Whale Feed Row ──────────────────────────────────────────────────────────

const WhaleFeedRow: React.FC<{ t: WhaleTransfer }> = ({ t }) => {
    const isInflow = t.direction === 'INFLOW';
    const color = isInflow ? 'text-rose-400' : 'text-emerald-400';
    const bgColor = isInflow ? 'bg-rose-500/5 border-rose-500/20' : 'bg-emerald-500/5 border-emerald-500/20';
    return (
        <div className={`flex items-center gap-3 px-3 py-2.5 rounded-lg border ${bgColor} text-xs font-mono`}>
            <div className={`shrink-0 ${color}`}>
                {isInflow ? <ArrowDownCircle size={14} /> : <ArrowUpCircle size={14} />}
            </div>
            <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                    <span className={`font-bold ${color}`}>{fmtBTC(t.amountBTC)}</span>
                    <span className="text-zinc-500 text-[10px]">{fmtUSD(t.amountUSD)}</span>
                </div>
                <div className="text-zinc-500 text-[10px] truncate">{t.fromLabel} → {t.toLabel}</div>
            </div>
            <div className="shrink-0 text-right">
                <div className={`text-[10px] font-bold uppercase ${color}`}>{t.direction}</div>
                <div className="text-zinc-600 text-[9px]">{timeAgo(t.timestamp)}</div>
            </div>
        </div>
    );
};

// ─── Block Trade Row ─────────────────────────────────────────────────────────

const BlockTradeRow: React.FC<{ p: DarkPrint }> = ({ p }) => {
    const isBuy = p.side === 'BUY';
    return (
        <tr className="border-b border-white/5 hover:bg-white/[0.02] transition-colors text-xs font-mono">
            <td className="py-2 px-3 text-zinc-400">{timeAgo(p.timestamp)}</td>
            <td className="py-2 px-3 font-bold text-white">${p.price.toLocaleString(undefined, { maximumFractionDigits: 0 })}</td>
            <td className="py-2 px-3 text-slate-300">{fmtBTC(p.volumeBTC)}</td>
            <td className="py-2 px-3">
                <span className={`${isBuy ? 'text-emerald-400' : 'text-rose-400'} font-bold uppercase`}>{p.side}</span>
            </td>
            <td className="py-2 px-3 text-zinc-400">{(p.priceImpactPct * 100).toFixed(3)}%</td>
            <td className="py-2 px-3">{p.exchange}</td>
            <td className="py-2 px-3">
                {p.isSignificant ? (
                    <span className="px-1.5 py-0.5 rounded text-[9px] bg-violet-500/20 text-violet-400 border border-violet-500/30 font-bold uppercase">⚡ DARK</span>
                ) : (
                    <span className="text-zinc-600 text-[9px]">noise</span>
                )}
            </td>
        </tr>
    );
};

// ─── Custom Tooltip for Histogram ────────────────────────────────────────────

const HistoTooltip = ({ active, payload, label }: any) => {
    if (!active || !payload?.length) return null;
    const net = payload[0]?.payload?.netBTC ?? 0;
    return (
        <div className="bg-zinc-900 border border-white/10 rounded-lg p-2 text-xs font-mono">
            <div className="text-zinc-400 mb-1">{label}</div>
            <div className={`font-bold ${net > 0 ? 'text-rose-400' : 'text-emerald-400'}`}>Net: {net > 0 ? '+' : ''}{net} BTC</div>
        </div>
    );
};

// ─── Main Page ───────────────────────────────────────────────────────────────

const DarkPoolDiscovery: React.FC = () => {
    const { darkPool, darkPoolBias, fetchDarkPoolData, startDarkPoolPolling } = useStore(s => ({
        darkPool: s.darkPool,
        darkPoolBias: s.darkPoolBias,
        fetchDarkPoolData: s.fetchDarkPoolData,
        startDarkPoolPolling: s.startDarkPoolPolling,
    }));

    const stopRef = useRef<(() => void) | null>(null);
    useEffect(() => {
        stopRef.current = startDarkPoolPolling();
        return () => { stopRef.current?.(); };
    }, []);

    const { whaleFeed, blockTrades, inflowOutflow, biasHistory, isLoading, lastUpdated } = darkPool;
    const significantPrints = blockTrades.filter(p => p.isSignificant);
    const netHourFlow = inflowOutflow[inflowOutflow.length - 1]?.netBTC ?? 0;
    const biasIcon = darkPoolBias > 0.3
        ? <TrendingUp size={16} className="text-emerald-400" />
        : darkPoolBias < -0.3
            ? <TrendingDown size={16} className="text-rose-400" />
            : <Minus size={16} className="text-amber-400" />;

    return (
        <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="h-full overflow-y-auto px-4 lg:px-8 pb-24 lg:pb-8 pt-6 max-w-7xl mx-auto"
        >
            {/* Header */}
            <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 mb-8">
                <div className="flex items-center gap-4">
                    <div className="p-3 bg-violet-500/20 rounded-xl text-violet-400 shadow-[0_0_20px_rgba(139,92,246,0.3)]">
                        <Eye size={30} />
                    </div>
                    <div>
                        <h1 className="text-3xl font-black text-white tracking-tight">Dark Pool Discovery</h1>
                        <p className="text-slate-400 text-sm mt-0.5">Institutional Radar · BTC On-Chain & OTC Flow</p>
                    </div>
                </div>
                <div className="flex items-center gap-3">
                    {lastUpdated > 0 && (
                        <span className="text-[10px] text-zinc-500 font-mono">
                            Updated {timeAgo(lastUpdated)}
                        </span>
                    )}
                    <button
                        onClick={fetchDarkPoolData}
                        disabled={isLoading}
                        className={`p-2.5 rounded-lg border transition-all ${isLoading
                            ? 'bg-zinc-800 border-zinc-700 text-zinc-500'
                            : 'bg-white/5 border-white/10 text-white hover:bg-white/10'}`}
                    >
                        <RefreshCw size={16} className={isLoading ? 'animate-spin' : ''} />
                    </button>
                </div>
            </div>

            {/* ── Stat strip ── */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
                {[
                    { label: 'Significant Prints', value: `${significantPrints.length}`, icon: <Zap size={14} className="text-violet-400" />, color: 'text-violet-400' },
                    { label: 'Whale Transfers', value: `${whaleFeed.length}`, icon: <Activity size={14} className="text-blue-400" />, color: 'text-blue-400' },
                    { label: 'Net 1H Flow', value: `${netHourFlow > 0 ? '+' : ''}${netHourFlow} BTC`, icon: netHourFlow > 0 ? <ArrowDownCircle size={14} className="text-rose-400" /> : <ArrowUpCircle size={14} className="text-emerald-400" />, color: netHourFlow > 0 ? 'text-rose-400' : 'text-emerald-400' },
                    { label: 'Inst. Bias', value: `${darkPoolBias > 0 ? '+' : ''}${darkPoolBias.toFixed(2)}`, icon: biasIcon, color: darkPoolBias > 0.3 ? 'text-emerald-400' : darkPoolBias < -0.3 ? 'text-rose-400' : 'text-amber-400' },
                ].map(({ label, value, icon, color }) => (
                    <div key={label} className="p-4 rounded-xl bg-zinc-900/50 border border-white/5 flex items-center gap-3">
                        <div className="p-2 rounded-lg bg-black/30">{icon}</div>
                        <div>
                            <div className="text-[10px] text-zinc-500 uppercase tracking-wide font-bold">{label}</div>
                            <div className={`text-xl font-black font-mono ${color}`}>{value}</div>
                        </div>
                    </div>
                ))}
            </div>

            {/* ── Main 2-column layout ── */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">

                {/* ── Bias Gauge ── */}
                <div className="p-6 rounded-2xl border border-violet-500/20 bg-violet-500/5 flex flex-col gap-3">
                    <div className="flex items-center gap-2">
                        <Activity size={16} className="text-violet-400" />
                        <span className="text-sm font-bold text-white tracking-wide">Aggregated Bias Gauge</span>
                        <span className="text-[10px] text-zinc-500 ml-auto font-mono">4H ROLLING WINDOW</span>
                    </div>
                    <BiasGauge bias={darkPoolBias} history={biasHistory} />

                    {significantPrints.length > 0 && (
                        <div className="mt-2 flex items-start gap-2 p-2.5 rounded-lg bg-amber-500/10 border border-amber-500/20">
                            <AlertTriangle size={13} className="text-amber-400 shrink-0 mt-0.5" />
                            <p className="text-[10px] text-amber-300 leading-relaxed">
                                <span className="font-bold">{significantPrints.length} Significant print(s)</span> detected above the 0.5% daily vol threshold.
                                Institutional positioning confirmed.
                            </p>
                        </div>
                    )}
                </div>

                {/* ── Net Inflow/Outflow Histogram ── */}
                <div className="p-6 rounded-2xl border border-white/5 bg-zinc-900/40 flex flex-col gap-4">
                    <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                            <Activity size={16} className="text-blue-400" />
                            <span className="text-sm font-bold text-white">Net Inflow / Outflow</span>
                        </div>
                        <div className="flex items-center gap-3 text-[10px] font-mono">
                            <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-rose-500 inline-block" /> Inflow (sell pressure)</span>
                            <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-emerald-500 inline-block" /> Outflow (supply shock)</span>
                        </div>
                    </div>
                    <div className="flex-1 min-h-[180px]">
                        <ResponsiveContainer width="100%" height={200}>
                            <BarChart data={inflowOutflow} barCategoryGap="30%">
                                <XAxis dataKey="hour" tick={{ fill: '#6b7280', fontSize: 9 }} axisLine={false} tickLine={false} />
                                <YAxis tick={{ fill: '#6b7280', fontSize: 9 }} axisLine={false} tickLine={false} tickFormatter={v => `${v}`} />
                                <Tooltip content={<HistoTooltip />} />
                                <ReferenceLine y={0} stroke="#374151" />
                                <Bar dataKey="netBTC" radius={[3, 3, 0, 0]}>
                                    {inflowOutflow.map((entry, i) => (
                                        <Cell key={i} fill={entry.netBTC > 0 ? '#f43f5e' : '#10b981'} fillOpacity={0.7} />
                                    ))}
                                </Bar>
                            </BarChart>
                        </ResponsiveContainer>
                    </div>
                    <p className="text-[10px] text-zinc-500 leading-relaxed">
                        <span className="text-rose-400 font-bold">Red bars = net exchange inflow</span> (supply incoming → potential sell pressure).{' '}
                        <span className="text-emerald-400 font-bold">Green bars = net outflow</span> (BTC leaving exchanges → supply shock / accumulation).
                    </p>
                </div>
            </div>

            {/* ── Bottom 2-column layout ── */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">

                {/* ── Whale Feed ── */}
                <div className="rounded-2xl border border-white/5 bg-zinc-900/40 overflow-hidden flex flex-col">
                    <div className="flex items-center gap-2 px-5 py-4 border-b border-white/5">
                        <Eye size={15} className="text-blue-400" />
                        <span className="text-sm font-bold text-white">Whale Feed</span>
                        <span className="ml-auto text-[10px] text-zinc-500 font-mono">BTC &gt; 500 BTC on-chain</span>
                        <span className="relative flex h-2 w-2 ml-2">
                            <span className="animate-ping absolute h-full w-full rounded-full bg-blue-400 opacity-75" />
                            <span className="relative inline-flex h-2 w-2 rounded-full bg-blue-500" />
                        </span>
                    </div>
                    <div className="flex-1 overflow-y-auto p-3 space-y-2 max-h-80">
                        {whaleFeed.length === 0 ? (
                            <div className="flex items-center justify-center h-24 text-zinc-600 text-xs">Waiting for whale activity…</div>
                        ) : (
                            whaleFeed.map(t => <WhaleFeedRow key={t.id} t={t} />)
                        )}
                    </div>
                </div>

                {/* ── Block Trade Tracker ── */}
                <div className="rounded-2xl border border-white/5 bg-zinc-900/40 overflow-hidden flex flex-col">
                    <div className="flex items-center gap-2 px-5 py-4 border-b border-white/5">
                        <Zap size={15} className="text-violet-400" />
                        <span className="text-sm font-bold text-white">Block Trade Tracker</span>
                        <span className="ml-auto text-[10px] text-zinc-500 font-mono">OTC Cross Settlements</span>
                    </div>
                    <div className="overflow-x-auto flex-1 max-h-80 overflow-y-auto">
                        <table className="w-full min-w-[480px]">
                            <thead>
                                <tr className="border-b border-white/5 text-[10px] text-zinc-500 uppercase tracking-wider font-bold">
                                    <th className="py-2 px-3 text-left">Time</th>
                                    <th className="py-2 px-3 text-left">Price</th>
                                    <th className="py-2 px-3 text-left">Size</th>
                                    <th className="py-2 px-3 text-left">Side</th>
                                    <th className="py-2 px-3 text-left">Impact</th>
                                    <th className="py-2 px-3 text-left">Venue</th>
                                    <th className="py-2 px-3 text-left">Flag</th>
                                </tr>
                            </thead>
                            <tbody>
                                {blockTrades.length === 0 ? (
                                    <tr><td colSpan={7} className="py-8 text-center text-zinc-600 text-xs">No block trades yet…</td></tr>
                                ) : (
                                    blockTrades.map(p => <BlockTradeRow key={p.id} p={p} />)
                                )}
                            </tbody>
                        </table>
                    </div>
                    <div className="px-5 py-3 border-t border-white/5 text-[10px] text-zinc-500">
                        <span className="text-violet-400 font-bold">⚡ DARK</span> = price impact &lt; 0.01% AND volume &gt; 0.5% daily avg (Signal vs Noise filter active)
                    </div>
                </div>
            </div>
        </motion.div>
    );
};

export default DarkPoolDiscovery;
