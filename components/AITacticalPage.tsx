
import React, { useEffect } from 'react';
import { motion } from 'framer-motion';
import { useStore } from '../store';
import { Target, Shield, Crosshair, CheckCircle2, XCircle, BrainCircuit, RefreshCw, ArrowRight, TrendingUp, TrendingDown, Minus } from 'lucide-react';

const FactorRow: React.FC<{ label: string; isActive: boolean; score?: number }> = ({ label, isActive, score }) => (
    <div className={`flex items-center justify-between p-3 rounded-xl border ${isActive ? 'bg-emerald-500/10 border-emerald-500/20' : 'bg-zinc-900/30 border-white/5'}`}>
        <span className={`text-sm font-medium ${isActive ? 'text-white' : 'text-zinc-500'}`}>{label}</span>
        <div className="flex items-center gap-2">
            {score !== undefined && isActive && (
                <span className="text-xs font-mono text-emerald-400 font-bold">{(score * 100).toFixed(0)}% CONF</span>
            )}
            {isActive ? (
                <CheckCircle2 size={18} className="text-emerald-500" />
            ) : (
                <XCircle size={18} className="text-zinc-600" />
            )}
        </div>
    </div>
);

const AITacticalPage: React.FC = () => {
    const { aiTactical, refreshTacticalAnalysis, market: { metrics } } = useStore();
    const { probability, scenario, entryLevel, stopLevel, exitLevel, confidenceFactors, lastUpdated, symbol } = aiTactical;

    useEffect(() => {
        refreshTacticalAnalysis();
        const interval = setInterval(refreshTacticalAnalysis, 5000); // 5s refresh for tactical
        return () => clearInterval(interval);
    }, []);

    // Visual Config
    let color = 'text-zinc-400';
    let bg = 'bg-zinc-900';
    let icon = <Minus size={48} />;
    
    if (scenario === 'BULLISH') {
        color = 'text-emerald-400';
        bg = 'bg-emerald-900/10 border-emerald-500/30';
        icon = <TrendingUp size={48} />;
    } else if (scenario === 'BEARISH') {
        color = 'text-rose-400';
        bg = 'bg-rose-900/10 border-rose-500/30';
        icon = <TrendingDown size={48} />;
    }

    const rrRatio = Math.abs(exitLevel - entryLevel) / Math.abs(entryLevel - stopLevel);

    return (
        <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="h-full overflow-y-auto px-4 lg:px-8 pb-24 lg:pb-8 max-w-6xl mx-auto pt-6"
        >
            <div className="flex justify-between items-end mb-8">
                <div>
                    <h1 className="text-3xl font-bold text-white tracking-tight flex items-center gap-3">
                        <div className="p-2 bg-purple-500/20 rounded-xl text-purple-400">
                            <BrainCircuit size={28} />
                        </div>
                        AI Tactical
                    </h1>
                    <p className="text-zinc-400 text-sm mt-1 ml-1">
                        Probabilistic Scenario Planning for <span className="text-white font-mono font-bold">{symbol}</span>
                    </p>
                </div>
                <div className="text-right">
                    <span className="text-[10px] text-zinc-500 font-bold uppercase block mb-1">Probability Engine</span>
                    <div className="flex items-center gap-2">
                        <span className="text-xs font-mono text-zinc-300">{new Date(lastUpdated).toLocaleTimeString()}</span>
                        <button onClick={() => refreshTacticalAnalysis()} className="p-1.5 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-400 transition-colors">
                            <RefreshCw size={12} />
                        </button>
                    </div>
                </div>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                
                {/* Main Probability Card */}
                <div className={`lg:col-span-2 p-8 rounded-3xl border ${scenario === 'NEUTRAL' ? 'border-white/10 bg-zinc-900/50' : bg} relative overflow-hidden flex flex-col justify-between min-h-[300px]`}>
                    <div className="absolute top-0 right-0 p-8 opacity-10">
                        {icon}
                    </div>
                    
                    <div>
                        <div className="flex items-center gap-3 mb-2">
                            <span className={`px-3 py-1 rounded-full text-[10px] font-black uppercase tracking-widest bg-black/40 border border-white/10 ${color}`}>
                                {scenario} SCENARIO
                            </span>
                        </div>
                        <h2 className="text-5xl md:text-7xl font-black tracking-tighter text-white drop-shadow-lg mb-4">
                            {probability}% <span className="text-2xl font-bold text-zinc-500">PROBABILITY</span>
                        </h2>
                    </div>

                    <div className="grid grid-cols-3 gap-4 mt-8">
                        <div className="p-4 rounded-2xl bg-black/40 border border-white/10 backdrop-blur-md">
                            <div className="flex items-center gap-2 text-zinc-400 text-xs font-bold uppercase mb-1">
                                <Target size={14} /> Entry
                            </div>
                            <div className="text-xl font-mono font-bold text-white">{entryLevel.toFixed(2)}</div>
                        </div>
                        <div className="p-4 rounded-2xl bg-black/40 border border-white/10 backdrop-blur-md relative overflow-hidden">
                            <div className="absolute left-0 top-0 bottom-0 w-1 bg-rose-500" />
                            <div className="flex items-center gap-2 text-rose-400 text-xs font-bold uppercase mb-1 pl-2">
                                <Shield size={14} /> Stop
                            </div>
                            <div className="text-xl font-mono font-bold text-white pl-2">{stopLevel.toFixed(2)}</div>
                        </div>
                        <div className="p-4 rounded-2xl bg-black/40 border border-white/10 backdrop-blur-md relative overflow-hidden">
                            <div className="absolute left-0 top-0 bottom-0 w-1 bg-emerald-500" />
                            <div className="flex items-center gap-2 text-emerald-400 text-xs font-bold uppercase mb-1 pl-2">
                                <Crosshair size={14} /> Target
                            </div>
                            <div className="text-xl font-mono font-bold text-white pl-2">{exitLevel.toFixed(2)}</div>
                        </div>
                    </div>
                </div>

                {/* Factors Checklist */}
                <div className="space-y-4">
                    <div className="p-6 rounded-3xl bg-zinc-900/50 border border-white/5 h-full">
                        <h3 className="text-lg font-bold text-white mb-6">Confluence Factors</h3>
                        <div className="space-y-3">
                            <FactorRow label="Bias Matrix Alignment" isActive={confidenceFactors.biasAlignment} />
                            <FactorRow label="Liquidity Structure" isActive={confidenceFactors.liquidityAgreement} />
                            <FactorRow label="Regime Support" isActive={confidenceFactors.regimeAgreement} />
                            <FactorRow label="AI Sentinel Validation" isActive={confidenceFactors.aiScore > 0} score={confidenceFactors.aiScore} />
                        </div>

                        <div className="mt-8 pt-6 border-t border-white/5">
                            <div className="flex justify-between items-center text-xs text-zinc-400 mb-2">
                                <span>Estimated R:R</span>
                                <span className={rrRatio >= 2 ? 'text-emerald-400 font-bold' : 'text-zinc-300'}>{rrRatio.toFixed(2)}R</span>
                            </div>
                            <div className="w-full bg-zinc-800 rounded-full h-1.5 overflow-hidden">
                                <div 
                                    className={`h-full ${rrRatio >= 2 ? 'bg-emerald-500' : 'bg-amber-500'}`} 
                                    style={{ width: `${Math.min((rrRatio / 4) * 100, 100)}%` }}
                                />
                            </div>
                        </div>
                    </div>
                </div>

            </div>

            {/* Execution Bar */}
            {probability > 60 && (
                <motion.div 
                    initial={{ y: 20, opacity: 0 }}
                    animate={{ y: 0, opacity: 1 }}
                    className="mt-8 p-1 rounded-2xl bg-gradient-to-r from-zinc-800 to-zinc-900 border border-white/5 flex items-center justify-between pl-6 pr-2 py-2"
                >
                    <div className="flex items-center gap-4">
                        <div className={`w-3 h-3 rounded-full animate-pulse ${color.replace('text-', 'bg-')}`} />
                        <span className="text-sm font-bold text-white tracking-wide">High Probability Setup Detected</span>
                    </div>
                    <button className="px-6 py-3 rounded-xl bg-white text-black font-bold text-sm flex items-center gap-2 hover:scale-105 transition-transform">
                        EXECUTE STRATEGY <ArrowRight size={16} />
                    </button>
                </motion.div>
            )}

        </motion.div>
    );
};

export default AITacticalPage;
