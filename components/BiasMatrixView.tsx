
import React, { useEffect } from 'react';
import { motion as m } from 'framer-motion';
import { useStore } from '../store';
import { Layers, ArrowUpCircle, ArrowDownCircle, MinusCircle, RefreshCw, Clock } from 'lucide-react';
import { LineChart, Line, ResponsiveContainer, YAxis } from 'recharts';
import { TimeframeData } from '../types';

const motion = m as any;

const BiasCard: React.FC<{ 
    label: string; 
    data: TimeframeData | null; 
    delay: number 
}> = ({ label, data, delay }) => {
    
    let color = 'text-zinc-500';
    let bg = 'bg-zinc-900/50';
    let border = 'border-white/5';
    let icon = <MinusCircle size={24} className="text-zinc-600" />;
    
    if (data) {
        if (data.bias === 'BULL') {
            color = 'text-emerald-400';
            bg = 'bg-emerald-900/10';
            border = 'border-emerald-500/30';
            icon = <ArrowUpCircle size={24} className="text-emerald-500" />;
        } else if (data.bias === 'BEAR') {
            color = 'text-rose-400';
            bg = 'bg-rose-900/10';
            border = 'border-rose-500/30';
            icon = <ArrowDownCircle size={24} className="text-rose-500" />;
        } else {
            color = 'text-amber-400';
            bg = 'bg-amber-900/10';
            border = 'border-amber-500/30';
            icon = <MinusCircle size={24} className="text-amber-500" />;
        }
    }

    const chartData = data ? data.sparkline.map((val, i) => ({ i, val })) : [];
    const isLive = data ? (Date.now() - data.lastUpdated < 60000) : false;

    return (
        <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay }}
            className={`p-6 rounded-2xl border ${border} ${bg} backdrop-blur-md relative overflow-hidden group`}
        >
            <div className="flex justify-between items-start mb-4 relative z-10">
                <div className="flex items-center gap-3">
                    <div className="p-2 rounded-lg bg-black/20 border border-white/5">
                        <span className="text-sm font-bold font-mono text-white">{label}</span>
                    </div>
                    {icon}
                </div>
                {data && (
                    <div className="flex items-center gap-1.5 px-2 py-1 rounded-full bg-black/20 border border-white/5">
                        {isLive && <span className="relative flex h-2 w-2 mr-1">
                          <span className={`animate-ping absolute inline-flex h-full w-full rounded-full opacity-75 ${data.bias === 'BULL' ? 'bg-emerald-400' : data.bias === 'BEAR' ? 'bg-rose-400' : 'bg-amber-400'}`}></span>
                          <span className={`relative inline-flex rounded-full h-2 w-2 ${data.bias === 'BULL' ? 'bg-emerald-500' : data.bias === 'BEAR' ? 'bg-rose-500' : 'bg-amber-500'}`}></span>
                        </span>}
                        <span className={`text-xs font-black tracking-widest ${color}`}>
                            {data.bias}
                        </span>
                    </div>
                )}
            </div>

            <div className="h-24 w-full relative z-10">
                {data ? (
                    <ResponsiveContainer width="100%" height="100%">
                        <LineChart data={chartData}>
                            <YAxis domain={['dataMin', 'dataMax']} hide />
                            <Line 
                                type="monotone" 
                                dataKey="val" 
                                stroke={data.bias === 'BULL' ? '#10b981' : data.bias === 'BEAR' ? '#f43f5e' : '#f59e0b'} 
                                strokeWidth={2} 
                                dot={false} 
                                isAnimationActive={false}
                            />
                        </LineChart>
                    </ResponsiveContainer>
                ) : (
                    <div className="w-full h-full flex items-center justify-center">
                        <div className="w-8 h-8 rounded-full border-2 border-zinc-700 border-t-transparent animate-spin" />
                    </div>
                )}
            </div>

            {/* Timestamps */}
            <div className="mt-4 pt-4 border-t border-white/5 flex justify-between items-center text-[10px] text-zinc-500 font-mono relative z-10">
                <div className="flex items-center gap-1">
                    <Clock size={10} />
                    {data ? new Date(data.lastUpdated).toLocaleTimeString() : '--:--'}
                </div>
                <span>TF: {label}</span>
            </div>

            {/* Background Glow */}
            <div className={`absolute inset-0 opacity-0 group-hover:opacity-10 transition-opacity duration-500 bg-gradient-to-br ${
                data?.bias === 'BULL' ? 'from-emerald-500' : 
                data?.bias === 'BEAR' ? 'from-rose-500' : 
                'from-amber-500'
            } to-transparent`} />
        </motion.div>
    );
};

const BiasMatrixView: React.FC = () => {
  const { biasMatrix, refreshBiasMatrix, config: { activeSymbol } } = useStore();
  const { daily, h4, h1, m5, isLoading } = biasMatrix;

  useEffect(() => {
    refreshBiasMatrix();
    const interval = setInterval(refreshBiasMatrix, 30000); // 30s auto-refresh
    return () => clearInterval(interval);
  }, [activeSymbol]); // Refresh when symbol changes

  return (
    <motion.div 
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        className="h-full overflow-y-auto px-4 lg:px-8 pb-24 lg:pb-8 max-w-7xl mx-auto pt-6"
    >
        {/* Header */}
        <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 mb-8">
            <div className="flex items-center gap-4">
                <div className="p-3 bg-brand-accent/20 rounded-xl text-brand-accent shadow-[0_0_20px_rgba(124,58,237,0.2)]">
                    <Layers size={32} />
                </div>
                <div>
                    <h1 className="text-3xl font-bold text-white tracking-tight">Bias Matrix</h1>
                    <p className="text-slate-400 text-sm">Multi-Timeframe Trend Confluence Engine</p>
                </div>
            </div>

            <div className="flex items-center gap-4">
                <div className="flex flex-col items-end">
                    <span className="text-xs text-zinc-500 font-mono uppercase tracking-wider">Active Asset</span>
                    <span className="text-xl font-bold text-white font-mono">{activeSymbol}</span>
                </div>
                <button 
                    onClick={() => refreshBiasMatrix()}
                    disabled={isLoading}
                    className={`p-3 rounded-lg border transition-all ${isLoading ? 'bg-zinc-800 border-zinc-700 text-zinc-500' : 'bg-white/5 border-white/10 text-white hover:bg-white/10'}`}
                >
                    <RefreshCw size={20} className={isLoading ? "animate-spin" : ""} />
                </button>
            </div>
        </div>

        {/* Matrix Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 mb-8">
            <BiasCard label="DAILY" data={daily} delay={0.1} />
            <BiasCard label="H4" data={h4} delay={0.2} />
            <BiasCard label="H1" data={h1} delay={0.3} />
            <BiasCard label="M5" data={m5} delay={0.4} />
        </div>

        {/* Synthesis / Summary */}
        <div className="p-6 rounded-2xl bg-zinc-900/40 border border-white/5 relative overflow-hidden">
             <div className="relative z-10 flex flex-col md:flex-row items-center justify-between gap-6">
                <div className="max-w-xl">
                    <h3 className="text-lg font-bold text-white mb-2">Trend Synthesis</h3>
                    <p className="text-sm text-zinc-400 leading-relaxed">
                        The matrix aggregates trend vectors across fractal timeframes. 
                        Alignment between Daily and H4 suggests high-probability swing setups. 
                        Contradiction indicates a ranging or transitionary market state.
                    </p>
                </div>
                
                <div className="flex items-center gap-4 px-6 py-4 rounded-xl bg-black/40 border border-white/5">
                    <div className="text-right">
                        <div className="text-[10px] text-zinc-500 uppercase font-bold tracking-widest">Global State</div>
                        <div className="text-xl font-bold text-white">
                            {daily?.bias === h4?.bias && h4?.bias === 'BULL' ? 'STRONG UPTREND' :
                             daily?.bias === h4?.bias && h4?.bias === 'BEAR' ? 'STRONG DOWNTREND' :
                             'MIXED / CHOP'}
                        </div>
                    </div>
                    <div className={`w-2 h-12 rounded-full ${
                         daily?.bias === h4?.bias && h4?.bias === 'BULL' ? 'bg-emerald-500 shadow-[0_0_15px_rgba(16,185,129,0.5)]' :
                         daily?.bias === h4?.bias && h4?.bias === 'BEAR' ? 'bg-rose-500 shadow-[0_0_15px_rgba(244,63,94,0.5)]' :
                         'bg-amber-500'
                    }`} />
                </div>
             </div>
        </div>

    </motion.div>
  );
};

export default BiasMatrixView;
