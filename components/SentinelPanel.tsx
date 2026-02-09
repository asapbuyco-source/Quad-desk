
import React, { useState } from 'react';
import { SentinelChecklist, AiScanResult, HeatmapItem, MarketMetrics } from '../types';
import { AlertTriangle, CheckCircle2, XCircle, Shield, ScanSearch, Percent, Zap, Activity, ChevronRight, X, Calculator, FunctionSquare, Variable, Info, Lock } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';

interface SentinelPanelProps {
  checklist: SentinelChecklist[];
  aiScanResult?: AiScanResult;
  heatmap?: HeatmapItem[];
  currentRegime?: MarketMetrics['regime'];
}

const ZScoreCell: React.FC<{ item: HeatmapItem }> = ({ item }) => {
    let colorClass = "bg-zinc-800 text-zinc-500 border-zinc-700/50"; // Neutral
    let status = "Norm";

    if (item.zScore < -2.0) {
        colorClass = "bg-blue-600/20 text-blue-400 border-blue-500/50 shadow-[inset_0_0_10px_rgba(37,99,235,0.2)]"; // Cold
        status = "OSOLD";
    } else if (item.zScore > 2.0) {
        colorClass = "bg-rose-600/20 text-rose-400 border-rose-500/50 shadow-[inset_0_0_10px_rgba(225,29,72,0.2)]"; // Hot
        status = "OBGHT";
    }

    return (
        <div className={`flex flex-col items-center justify-center p-2 rounded-lg border ${colorClass} transition-colors duration-500`}>
            <span className="text-[9px] font-bold uppercase tracking-wider mb-0.5">{item.pair}</span>
            <span className="text-xs font-mono font-bold">{item.zScore.toFixed(2)}σ</span>
            <span className="text-[8px] opacity-70 mt-1">{status}</span>
        </div>
    );
};

const SentinelPanel: React.FC<SentinelPanelProps> = ({ checklist, aiScanResult, heatmap, currentRegime = 'MEAN_REVERTING' }) => {
  const [selectedItem, setSelectedItem] = useState<SentinelChecklist | null>(null);

  const handleKeyDown = (e: React.KeyboardEvent, item: SentinelChecklist) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      setSelectedItem(item);
    }
  };

  return (
    <>
        <div className="fintech-card h-full flex flex-col bg-slate-900/40 relative">
        
        {/* Header */}
        <div className="p-5 border-b border-white/5 flex items-center justify-between">
            <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-indigo-500/20 text-indigo-400">
                    <Shield size={18} />
                </div>
                <div>
                    <h2 className="text-sm font-bold text-white">Sentinel System</h2>
                    <p className="text-[10px] text-slate-400 uppercase tracking-wider">Risk Parameters</p>
                </div>
            </div>
            {currentRegime && (
                <div className="px-2 py-1 rounded bg-white/5 border border-white/5 text-[9px] font-mono text-slate-400">
                    REGIME: <span className="text-white font-bold">{currentRegime}</span>
                </div>
            )}
        </div>

        {/* Checklist */}
        <div className="flex-1 overflow-y-auto p-4 space-y-3">
            
            {/* Heatmap Matrix */}
            {heatmap && heatmap.length > 0 && (
                <div className="mb-4 pb-4 border-b border-white/5">
                    <div className="flex items-center gap-2 mb-3 px-1">
                        <Activity size={12} className="text-slate-400" />
                        <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Cross-Asset Dislocation</span>
                    </div>
                    <div className="grid grid-cols-3 gap-2">
                        {heatmap.map(item => (
                            <ZScoreCell key={item.pair} item={item} />
                        ))}
                    </div>
                </div>
            )}

            {/* AI SCAN RESULT CARD */}
            {aiScanResult && (
                <div className="p-4 rounded-xl border mb-4 bg-purple-500/10 border-purple-500/30 relative overflow-hidden group">
                    {/* SIMULATION BADGE */}
                    {(aiScanResult.isSimulated || (aiScanResult as any).is_simulated) && (
                        <div className="absolute top-0 right-0 left-0 bg-amber-500/20 border-b border-amber-500/30 py-1 flex items-center justify-center gap-2">
                            <AlertTriangle size={10} className="text-amber-500" />
                            <span className="text-[9px] font-black text-amber-500 uppercase tracking-widest">
                                ⚠ SIMULATED DATA
                            </span>
                        </div>
                    )}

                    <div className={`flex items-center justify-between mb-2 ${(aiScanResult.isSimulated || (aiScanResult as any).is_simulated) ? 'mt-6' : ''}`}>
                        <div className="flex items-center gap-2">
                            <ScanSearch size={16} className="text-purple-400" />
                            <span className="text-xs font-bold text-white tracking-wide">AI VERDICT</span>
                        </div>
                        {aiScanResult.confidence && (
                            <div className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-black/40 border border-white/10">
                                <Zap size={10} className={aiScanResult.confidence > 0.8 ? "text-brand-accent" : "text-slate-500"} />
                                <span className="text-[10px] font-mono font-bold text-slate-300">
                                    {(aiScanResult.confidence * 100).toFixed(0)}%
                                </span>
                            </div>
                        )}
                    </div>
                    <div className="flex items-baseline gap-2 mb-2">
                        <h3 className={`text-2xl font-black tracking-tighter ${
                            aiScanResult.verdict === 'ENTRY' ? 'text-emerald-400' : 
                            aiScanResult.verdict === 'EXIT' ? 'text-rose-400' : 'text-amber-400'
                        }`}>
                            {aiScanResult.verdict}
                        </h3>
                    </div>
                    <p className="text-[10px] text-slate-300 leading-relaxed font-medium mb-2">
                        "{aiScanResult.analysis}"
                    </p>
                    
                    {/* Risk/Reward Display */}
                    {aiScanResult.risk_reward_ratio && (
                        <div className="flex items-center gap-2 mt-2 pt-2 border-t border-purple-500/20">
                            <Percent size={10} className="text-slate-500" />
                            <span className="text-[10px] text-slate-400">R:R Ratio</span>
                            <span className={`text-[10px] font-bold font-mono ${aiScanResult.risk_reward_ratio >= 2 ? 'text-emerald-400' : 'text-rose-400'}`}>
                                {aiScanResult.risk_reward_ratio.toFixed(2)}
                            </span>
                        </div>
                    )}
                </div>
            )}

            {/* Checklist Items */}
            {checklist.map((item) => {
                // Determine if this item is locked for the current regime
                const isLocked = item.requiredRegime && !item.requiredRegime.includes(currentRegime);

                return (
                    <div 
                        key={item.id} 
                        role="button"
                        tabIndex={0}
                        onClick={() => !isLocked && setSelectedItem(item)}
                        onKeyDown={(e) => !isLocked && handleKeyDown(e, item)}
                        className={`
                            group flex flex-col p-3 rounded-xl transition-all border relative overflow-hidden focus:outline-none 
                            ${isLocked 
                                ? 'bg-zinc-900/50 border-white/5 cursor-not-allowed opacity-60' 
                                : 'bg-white/5 border-white/5 hover:bg-white/10 hover:border-white/10 hover:shadow-lg cursor-pointer focus:ring-1 focus:ring-brand-accent'
                            }
                        `}
                    >
                        <div className="flex items-center justify-between w-full relative z-10">
                            <div className="flex items-center gap-3">
                                {isLocked ? (
                                    <Lock size={16} className="text-slate-600 shrink-0" />
                                ) : (
                                    <>
                                        {item.status === 'pass' && <CheckCircle2 size={16} className="text-trade-bid shrink-0" />}
                                        {item.status === 'fail' && <XCircle size={16} className="text-trade-ask shrink-0" />}
                                        {item.status === 'warning' && <AlertTriangle size={16} className="text-trade-warn shrink-0" />}
                                    </>
                                )}
                                <span className={`text-sm font-medium transition-colors ${isLocked ? 'text-slate-500 line-through decoration-slate-600' : 'text-slate-300 group-hover:text-white'}`}>
                                    {item.label}
                                </span>
                            </div>
                            <div className="flex items-center gap-3">
                                {isLocked ? (
                                    <span className="text-[10px] font-bold text-slate-600 uppercase tracking-wider">REGIME LOCK</span>
                                ) : (
                                    <span className={`text-xs font-mono font-bold ${
                                        item.status === 'pass' ? 'text-trade-bid' : 
                                        item.status === 'fail' ? 'text-trade-ask' : 'text-trade-warn'
                                    }`}>
                                        {item.value}
                                    </span>
                                )}
                                {!isLocked && <ChevronRight size={14} className="text-slate-600 group-hover:text-white transition-colors" />}
                            </div>
                        </div>
                    </div>
                );
            })}
            
        </div>
        </div>

        {/* Calculation Details Modal */}
        <AnimatePresence>
            {selectedItem && selectedItem.details && (
                <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
                    <motion.div
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        onClick={() => setSelectedItem(null)}
                        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
                    />
                    
                    <motion.div
                        layoutId={`card-${selectedItem.id}`}
                        initial={{ opacity: 0, scale: 0.9, y: 20 }}
                        animate={{ opacity: 1, scale: 1, y: 0 }}
                        exit={{ opacity: 0, scale: 0.9, y: 20 }}
                        className="w-full max-w-lg bg-[#18181b] border border-white/10 rounded-2xl shadow-2xl relative z-10 overflow-hidden"
                    >
                        {/* Header */}
                        <div className="p-6 border-b border-white/5 flex items-center justify-between bg-gradient-to-r from-white/5 to-transparent">
                            <div className="flex items-center gap-3">
                                <div className="p-2.5 rounded-xl bg-brand-accent/20 text-brand-accent">
                                    <Calculator size={20} />
                                </div>
                                <div>
                                    <h3 className="text-lg font-bold text-white">{selectedItem.label}</h3>
                                    <span className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded border ${
                                        selectedItem.status === 'pass' ? 'border-emerald-500/20 text-emerald-500 bg-emerald-500/10' :
                                        selectedItem.status === 'fail' ? 'border-rose-500/20 text-rose-500 bg-rose-500/10' :
                                        'border-amber-500/20 text-amber-500 bg-amber-500/10'
                                    }`}>
                                        Status: {selectedItem.status.toUpperCase()}
                                    </span>
                                </div>
                            </div>
                            <button 
                                onClick={() => setSelectedItem(null)}
                                className="p-2 hover:bg-white/10 rounded-full text-slate-400 hover:text-white transition-colors"
                            >
                                <X size={20} />
                            </button>
                        </div>

                        {/* Body */}
                        <div className="p-6 space-y-6">
                            
                            {/* Formula Section */}
                            <div className="space-y-2">
                                <div className="flex items-center gap-2 text-xs font-bold text-slate-400 uppercase tracking-widest">
                                    <FunctionSquare size={14} className="text-brand-accent" />
                                    Mathematical Model
                                </div>
                                <div className="p-4 bg-black/40 rounded-xl border border-white/5 font-mono text-center text-lg text-white shadow-inner">
                                    {selectedItem.details.formula}
                                </div>
                                <p className="text-xs text-slate-400 leading-relaxed px-1">
                                    {selectedItem.details.explanation}
                                </p>
                            </div>

                            {/* Variables Table */}
                            <div className="space-y-2">
                                <div className="flex items-center gap-2 text-xs font-bold text-slate-400 uppercase tracking-widest">
                                    <Variable size={14} className="text-brand-accent" />
                                    Real-Time Variables
                                </div>
                                <div className="bg-white/5 rounded-xl border border-white/5 divide-y divide-white/5">
                                    {selectedItem.details.variables.map((v, i) => (
                                        <div key={i} className="flex items-center justify-between p-3">
                                            <div>
                                                <div className="text-sm font-bold text-slate-200 font-mono">{v.label}</div>
                                                <div className="text-[10px] text-slate-500">{v.description}</div>
                                            </div>
                                            <div className="text-right">
                                                <div className="text-sm font-bold text-white font-mono">{v.value}</div>
                                                <div className="text-[10px] text-slate-500">{v.unit}</div>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            </div>

                            {/* Thresholds Logic */}
                            <div className="bg-slate-900/50 p-4 rounded-xl border border-white/5 text-xs space-y-2">
                                <div className="flex items-center gap-2 text-xs font-bold text-slate-400 uppercase tracking-widest mb-2">
                                    <Info size={14} className="text-brand-accent" />
                                    Logic Gates
                                </div>
                                <div className="flex items-start gap-2">
                                    <CheckCircle2 size={12} className="text-emerald-500 mt-0.5 shrink-0" />
                                    <span className="text-slate-300">PASS: <span className="font-mono text-emerald-500">{selectedItem.details.thresholds.pass}</span></span>
                                </div>
                                <div className="flex items-start gap-2">
                                    <AlertTriangle size={12} className="text-amber-500 mt-0.5 shrink-0" />
                                    <span className="text-slate-300">WARN: <span className="font-mono text-amber-500">{selectedItem.details.thresholds.warning}</span></span>
                                </div>
                                <div className="flex items-start gap-2">
                                    <XCircle size={12} className="text-rose-500 mt-0.5 shrink-0" />
                                    <span className="text-slate-300">FAIL: <span className="font-mono text-rose-500">{selectedItem.details.thresholds.fail}</span></span>
                                </div>
                            </div>

                        </div>
                    </motion.div>
                </div>
            )}
        </AnimatePresence>
    </>
  );
};

export default SentinelPanel;
