
import React, { useMemo } from 'react';
import { useStore } from '../store';
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, ReferenceLine } from 'recharts';
import { ArrowDown, ArrowUp, Mountain, Activity, BoxSelect, Scale } from 'lucide-react';
import { motion as m } from 'framer-motion';
import { OrderBookLevel } from '../types';

const motion = m as any;

const CustomTooltip = ({ active, payload, label }: any) => {
    if (active && payload && payload.length) {
        return (
            <div className="bg-[#09090b]/95 backdrop-blur-xl border border-zinc-800 p-3 rounded-lg shadow-xl min-w-[140px] z-50">
                <p className="text-zinc-500 mb-2 font-mono text-[10px] uppercase tracking-wider border-b border-white/5 pb-1">
                    Price: {label}
                </p>
                <div className="space-y-1.5">
                    {payload.map((p: any, idx: number) => (
                        <div key={idx} className="flex justify-between items-center text-xs font-mono">
                            <span className="text-zinc-400 capitalize">{p.name}:</span>
                            <span className="font-bold" style={{ color: p.color }}>
                                {p.value.toLocaleString()}
                            </span>
                        </div>
                    ))}
                </div>
            </div>
        );
    }
    return null;
};

const DepthRow: React.FC<{ level: OrderBookLevel; type: 'BID' | 'ASK'; maxVol: number }> = ({ level, type, maxVol }) => {
    const isBid = type === 'BID';
    const percent = Math.min((level.size / maxVol) * 100, 100);
    const isWall = level.classification === 'WALL';

    return (
        <div className={`
            relative flex items-center justify-between py-1 px-3 font-mono text-xs border-y border-transparent transition-colors group
            ${isWall 
                ? (isBid 
                    ? 'bg-emerald-500/10 border-emerald-500/30 my-0.5 shadow-[inset_0_0_15px_rgba(16,185,129,0.1)]' 
                    : 'bg-rose-500/10 border-rose-500/30 my-0.5 shadow-[inset_0_0_15px_rgba(244,63,94,0.1)]')
                : 'hover:bg-white/5'
            }
        `}>
            {/* Background Depth Bar */}
            <div 
                className={`absolute top-0 bottom-0 ${isBid ? 'right-0 bg-emerald-500' : 'left-0 bg-rose-500'} opacity-10 transition-all duration-500`}
                style={{ width: `${percent}%` }}
            />

            {/* Content Container based on Side */}
            {isBid ? (
                <>
                    <div className="flex items-center gap-2 relative z-10 w-1/3">
                        <span className={`font-bold ${level.size > maxVol * 0.8 ? 'text-white' : 'text-zinc-400'}`}>
                            {level.size.toLocaleString()}
                        </span>
                        {isWall && <BoxSelect size={12} className="text-emerald-500 animate-pulse" />}
                    </div>
                    <div className="relative z-10 text-emerald-400 font-bold w-1/3 text-right">
                        {level.price.toFixed(2)}
                    </div>
                    <div className="relative z-10 text-zinc-600 text-[10px] w-1/3 text-right">
                        {(level.price * level.size).toLocaleString(undefined, { notation: 'compact', maximumFractionDigits: 1 })}
                    </div>
                </>
            ) : (
                <>
                    <div className="relative z-10 text-rose-400 font-bold w-1/3 text-left">
                        {level.price.toFixed(2)}
                    </div>
                    <div className="flex items-center justify-end gap-2 relative z-10 w-1/3">
                        {isWall && <BoxSelect size={12} className="text-rose-500 animate-pulse" />}
                        <span className={`font-bold ${level.size > maxVol * 0.8 ? 'text-white' : 'text-zinc-400'}`}>
                            {level.size.toLocaleString()}
                        </span>
                    </div>
                    <div className="relative z-10 text-zinc-600 text-[10px] w-1/3 text-left pl-2">
                        {(level.price * level.size).toLocaleString(undefined, { notation: 'compact', maximumFractionDigits: 1 })}
                    </div>
                </>
            )}
        </div>
    );
};

const DepthPage: React.FC = () => {
    const { asks, bids, metrics } = useStore(state => state.market);
    const { activeSymbol } = useStore(state => state.config);

    // 1. Process Data for Chart & Lists
    const { chartData, maxVol, bidTotal, askTotal, imbalance } = useMemo(() => {
        // Calculate cumulative for chart
        const sortedBids = [...bids].sort((a, b) => b.price - a.price); // Descending
        const sortedAsks = [...asks].sort((a, b) => a.price - b.price); // Ascending

        let bidAcc = 0;
        const bidPoints = sortedBids.map(b => {
            bidAcc += b.size;
            return { price: b.price, bidDepth: bidAcc, askDepth: null };
        }).reverse(); // Reverse for chart (Low -> High price)

        let askAcc = 0;
        const askPoints = sortedAsks.map(a => {
            askAcc += a.size;
            return { price: a.price, bidDepth: null, askDepth: askAcc };
        });

        // Combine for Recharts
        // We filter out nulls to connect lines properly or use separate areas
        const combined = [...bidPoints, ...askPoints];

        // Stats
        const bTotal = bids.reduce((acc, b) => acc + b.size, 0);
        const aTotal = asks.reduce((acc, a) => acc + a.size, 0);
        const maxV = Math.max(
            ...bids.map(b => b.size), 
            ...asks.map(a => a.size)
        );
        
        // Imbalance (-100 to 100)
        const total = bTotal + aTotal;
        const imb = total > 0 ? ((bTotal - aTotal) / total) * 100 : 0;

        return { 
            chartData: combined, 
            maxVol: maxV, 
            bidTotal: bTotal, 
            askTotal: aTotal,
            imbalance: imb 
        };
    }, [asks, bids]);

    const imbalanceColor = imbalance > 0 ? 'text-emerald-500' : 'text-rose-500';
    const imbalanceBg = imbalance > 0 ? 'bg-emerald-500' : 'bg-rose-500';

    return (
        <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="h-full flex flex-col px-4 lg:px-8 pb-24 lg:pb-8 pt-6 max-w-7xl mx-auto overflow-hidden"
        >
            {/* Header */}
            <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-6 mb-6 shrink-0">
                <div>
                    <h1 className="text-3xl font-bold text-white tracking-tight flex items-center gap-3">
                        <div className="p-2 bg-indigo-500/20 rounded-xl text-indigo-400">
                            <Mountain size={28} />
                        </div>
                        Market Depth
                    </h1>
                    <p className="text-zinc-400 text-sm mt-1 ml-1">
                        Liquidity Structure & Wall Detection for <span className="text-white font-mono font-bold">{activeSymbol}</span>
                    </p>
                </div>

                {/* Imbalance Meter */}
                <div className="flex flex-col items-end gap-2 w-full md:w-auto">
                    <div className="flex items-center gap-2">
                        <Scale size={14} className="text-zinc-500" />
                        <span className="text-xs font-bold text-zinc-400 uppercase tracking-wide">Book Imbalance</span>
                        <span className={`text-sm font-mono font-bold ${imbalanceColor}`}>
                            {imbalance > 0 ? '+' : ''}{imbalance.toFixed(1)}%
                        </span>
                    </div>
                    <div className="w-full md:w-64 h-2 bg-zinc-800 rounded-full overflow-hidden relative">
                        <div className="absolute left-1/2 top-0 bottom-0 w-0.5 bg-white/20 z-10" />
                        <motion.div 
                            initial={{ width: 0 }}
                            animate={{ 
                                width: `${Math.min(Math.abs(imbalance), 50)}%`,
                                left: imbalance > 0 ? '50%' : 'auto',
                                right: imbalance < 0 ? '50%' : 'auto'
                            }}
                            className={`h-full absolute top-0 ${imbalanceBg}`}
                        />
                    </div>
                </div>
            </div>

            {/* Depth Chart */}
            <div className="h-64 shrink-0 bg-zinc-900/40 border border-white/5 rounded-2xl p-4 mb-6 relative overflow-hidden">
                <div className="absolute top-4 left-4 z-10 flex items-center gap-2">
                    <Activity size={14} className="text-zinc-500" />
                    <span className="text-[10px] font-bold text-zinc-500 uppercase tracking-wider">Depth Visualizer</span>
                </div>
                
                <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={chartData} margin={{ top: 10, right: 0, left: 0, bottom: 0 }}>
                        <defs>
                            <linearGradient id="colorBid" x1="0" y1="0" x2="0" y2="1">
                                <stop offset="5%" stopColor="#10b981" stopOpacity={0.3}/>
                                <stop offset="95%" stopColor="#10b981" stopOpacity={0}/>
                            </linearGradient>
                            <linearGradient id="colorAsk" x1="0" y1="0" x2="0" y2="1">
                                <stop offset="5%" stopColor="#f43f5e" stopOpacity={0.3}/>
                                <stop offset="95%" stopColor="#f43f5e" stopOpacity={0}/>
                            </linearGradient>
                        </defs>
                        <CartesianGrid strokeDasharray="3 3" stroke="#27272a" vertical={false} />
                        <XAxis 
                            dataKey="price" 
                            type="number" 
                            domain={['dataMin', 'dataMax']} 
                            hide 
                        />
                        <YAxis hide />
                        <Tooltip content={<CustomTooltip />} cursor={{ stroke: 'rgba(255,255,255,0.1)', strokeWidth: 1 }} />
                        
                        {/* Center Price Line */}
                        <ReferenceLine x={metrics.price} stroke="#71717a" strokeDasharray="3 3" label={{ position: 'top', value: 'CURRENT', fill: '#71717a', fontSize: 10 }} />

                        <Area 
                            type="stepAfter" 
                            dataKey="bidDepth" 
                            stroke="#10b981" 
                            fillOpacity={1} 
                            fill="url(#colorBid)" 
                            name="Bid Liquidity"
                        />
                        <Area 
                            type="stepBefore" 
                            dataKey="askDepth" 
                            stroke="#f43f5e" 
                            fillOpacity={1} 
                            fill="url(#colorAsk)" 
                            name="Ask Liquidity"
                        />
                    </AreaChart>
                </ResponsiveContainer>
            </div>

            {/* Side-by-Side Order Book */}
            <div className="flex-1 min-h-0 grid grid-cols-2 gap-px bg-zinc-800 border border-white/5 rounded-2xl overflow-hidden">
                
                {/* BIDS COLUMN */}
                <div className="bg-[#09090b] flex flex-col min-h-0">
                    <div className="px-4 py-3 border-b border-white/5 bg-emerald-900/10 flex justify-between items-center">
                        <div className="flex items-center gap-2 text-emerald-500">
                            <ArrowUp size={16} />
                            <span className="text-sm font-bold uppercase">Bids</span>
                        </div>
                        <span className="text-xs font-mono text-zinc-400">{bidTotal.toLocaleString()} Vol</span>
                    </div>
                    
                    {/* Headers */}
                    <div className="flex px-3 py-2 text-[10px] font-bold text-zinc-600 uppercase tracking-wider border-b border-white/5">
                        <span className="w-1/3">Size</span>
                        <span className="w-1/3 text-right">Price</span>
                        <span className="w-1/3 text-right">Val (USD)</span>
                    </div>

                    <div className="flex-1 overflow-y-auto scrollbar-hide">
                        {bids.map((bid) => (
                            <DepthRow key={bid.price} level={bid} type="BID" maxVol={maxVol} />
                        ))}
                    </div>
                </div>

                {/* ASKS COLUMN */}
                <div className="bg-[#09090b] flex flex-col min-h-0">
                    <div className="px-4 py-3 border-b border-white/5 bg-rose-900/10 flex justify-between items-center">
                         <span className="text-xs font-mono text-zinc-400">{askTotal.toLocaleString()} Vol</span>
                        <div className="flex items-center gap-2 text-rose-500">
                            <span className="text-sm font-bold uppercase">Asks</span>
                            <ArrowDown size={16} />
                        </div>
                    </div>

                     {/* Headers */}
                     <div className="flex px-3 py-2 text-[10px] font-bold text-zinc-600 uppercase tracking-wider border-b border-white/5">
                        <span className="w-1/3">Price</span>
                        <span className="w-1/3 text-right">Size</span>
                        <span className="w-1/3 text-left pl-2">Val (USD)</span>
                    </div>

                    <div className="flex-1 overflow-y-auto scrollbar-hide">
                        {asks.map((ask) => (
                            <DepthRow key={ask.price} level={ask} type="ASK" maxVol={maxVol} />
                        ))}
                    </div>
                </div>
                
            </div>
            
            {/* Wall Legend */}
            <div className="mt-4 flex justify-center gap-6">
                 <div className="flex items-center gap-2">
                    <div className="w-3 h-3 bg-emerald-500/20 border border-emerald-500/50 rounded flex items-center justify-center">
                        <div className="w-1 h-1 bg-emerald-500 rounded-full" />
                    </div>
                    <span className="text-[10px] text-zinc-500 font-bold uppercase tracking-wide">Bid Wall</span>
                 </div>
                 <div className="flex items-center gap-2">
                    <div className="w-3 h-3 bg-rose-500/20 border border-rose-500/50 rounded flex items-center justify-center">
                         <div className="w-1 h-1 bg-rose-500 rounded-full" />
                    </div>
                    <span className="text-[10px] text-zinc-500 font-bold uppercase tracking-wide">Ask Wall</span>
                 </div>
            </div>

        </motion.div>
    );
};

export default DepthPage;
