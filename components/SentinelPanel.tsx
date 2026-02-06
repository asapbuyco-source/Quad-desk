import React from 'react';
import { SentinelChecklist, AiAnalysis } from '../types';
import { AlertTriangle, CheckCircle2, XCircle, Shield, BrainCircuit } from 'lucide-react';

interface SentinelPanelProps {
  checklist: SentinelChecklist[];
  aiAnalysis?: AiAnalysis;
}

const SentinelPanel: React.FC<SentinelPanelProps> = ({ checklist, aiAnalysis }) => {
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
        
        {/* AI Signal Card */}
        {aiAnalysis ? (
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
                    <span className="text-[10px] font-mono opacity-70">GEMINI-PRO</span>
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

                 {aiAnalysis.metrics && (
                     <div className="mt-3 pt-3 border-t border-white/5 grid grid-cols-2 gap-2 text-[9px] font-mono text-slate-500">
                         <div>Z-SCORE: <span className="text-slate-300">{aiAnalysis.metrics.z_score.toFixed(2)}</span></div>
                         <div>VPIN: <span className="text-slate-300">{aiAnalysis.metrics.vpin.toFixed(2)}</span></div>
                     </div>
                 )}

                 {/* Glow Effect */}
                 <div className={`absolute -right-4 -bottom-4 w-24 h-24 rounded-full blur-[40px] opacity-20 ${
                      aiAnalysis.signal === 'BUY' ? 'bg-emerald-500' : aiAnalysis.signal === 'SELL' ? 'bg-rose-500' : 'bg-slate-500'
                 }`}></div>
            </div>
        ) : (
            <div className="p-4 rounded-xl bg-slate-800/30 border border-white/5 mb-4 flex flex-col items-center justify-center text-center py-6">
                <BrainCircuit size={24} className="text-slate-600 mb-2 animate-pulse" />
                <span className="text-xs text-slate-500 font-mono">Initializing Neural Net...</span>
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
          
          <div className="mt-4 p-4 rounded-xl bg-trade-ask/10 border border-trade-ask/20">
            <div className="flex items-start gap-3">
                <AlertTriangle size={16} className="text-trade-ask mt-0.5" />
                <div>
                    <h4 className="text-xs font-bold text-trade-ask mb-1">Execution Halted</h4>
                    <p className="text-[11px] text-trade-ask/80 leading-relaxed">
                        Risk models indicate high probability of adverse selection. Auto-execution suspended until volatility normalizes.
                    </p>
                </div>
            </div>
          </div>
      </div>
    </div>
  );
};

export default SentinelPanel;