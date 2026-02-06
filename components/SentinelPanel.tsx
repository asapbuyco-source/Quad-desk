import React from 'react';
import { SentinelChecklist, AiAnalysis, AiScanResult } from '../types';
import { AlertTriangle, CheckCircle2, XCircle, Shield, BrainCircuit, ScanSearch, Percent, Zap } from 'lucide-react';

interface SentinelPanelProps {
  checklist: SentinelChecklist[];
  aiAnalysis?: AiAnalysis;
  aiScanResult?: AiScanResult;
}

const SentinelPanel: React.FC<SentinelPanelProps> = ({ checklist, aiAnalysis, aiScanResult }) => {
  return (
    <div className="fintech-card h-full flex flex-col bg-slate-900/40">
      
      {/* Header */}
      <div className="p-5 border-b border-white/5 flex items-center gap-3">
        <div className="p-2 rounded-lg bg-indigo-500/20 text-indigo-400">
            <Shield size={18} />
        </div>
        <div>
            <h2 className="text-sm font-bold text-white">Sentinel System</h2>
            <p className="text-[10px] text-slate-400 uppercase tracking-wider">Risk Parameters</p>
        </div>
      </div>

      {/* Checklist */}
      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        
        {/* AI SCAN RESULT CARD (New Feature) */}
        {aiScanResult && (
             <div className="p-4 rounded-xl border mb-4 bg-purple-500/10 border-purple-500/30 relative overflow-hidden group">
                 <div className="flex items-center justify-between mb-2">
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

        {/* Existing AI Signal Card (Legacy Polling) */}
        {aiAnalysis && !aiScanResult && (
            <div className={`p-4 rounded-xl border mb-4 relative overflow-hidden transition-all duration-500 ${
                aiAnalysis.signal === 'BUY' ? 'bg-emerald-500/10 border-emerald-500/30' :
                aiAnalysis.signal === 'SELL' ? 'bg-rose-500/10 border-rose-500/30' :
                'bg-slate-800/50 border-white/10'
            }`}>
                 <div className="flex items-center justify-between mb-2 relative z-10">
                    <div className="flex items-center gap-2">
                        <BrainCircuit size={16} className={aiAnalysis.signal === 'BUY' ? 'text-emerald-400' : aiAnalysis.signal === 'SELL' ? 'text-rose-400' : 'text-slate-400'} />
                        <span className="text-xs font-bold text-white tracking-wide">AI SIGNAL</span>
                    </div>
                 </div>
                 
                 <div className="flex items-baseline gap-2 mb-2 relative z-10">
                    <h3 className={`text-2xl font-black tracking-tighter ${
                         aiAnalysis.signal === 'BUY' ? 'text-emerald-400' : aiAnalysis.signal === 'SELL' ? 'text-rose-400' : 'text-white'
                    }`}>
                        {aiAnalysis.signal}
                    </h3>
                    <span className="text-xs font-mono font-bold text-slate-400">
                        {(aiAnalysis.confidence * 100).toFixed(0)}% CONFIDENCE
                    </span>
                 </div>
                 
                 <p className="text-[10px] text-slate-300 leading-relaxed font-medium relative z-10">
                     "{aiAnalysis.reason}"
                 </p>
            </div>
        )}

        {checklist.map((item) => (
            <div key={item.id} className="group flex items-center justify-between p-3 rounded-xl bg-white/5 hover:bg-white/10 transition-colors border border-white/5 cursor-default">
              <div className="flex items-center gap-3">
                {item.status === 'pass' && <CheckCircle2 size={16} className="text-trade-bid" />}
                {item.status === 'fail' && <XCircle size={16} className="text-trade-ask" />}
                {item.status === 'warning' && <AlertTriangle size={16} className="text-trade-warn" />}
                <span className="text-sm font-medium text-slate-300 group-hover:text-white">{item.label}</span>
              </div>
              <div className="flex items-center gap-3">
                <span className={`text-xs font-mono font-bold ${
                    item.status === 'pass' ? 'text-trade-bid' : 
                    item.status === 'fail' ? 'text-trade-ask' : 'text-trade-warn'
                }`}>
                    {item.value}
                </span>
              </div>
            </div>
          ))}
          
      </div>
    </div>
  );
};

export default SentinelPanel;