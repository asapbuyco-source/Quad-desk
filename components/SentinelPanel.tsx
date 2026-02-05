import React from 'react';
import { SentinelChecklist } from '../types';
import { AlertTriangle, CheckCircle2, XCircle, Shield, ChevronRight } from 'lucide-react';

interface SentinelPanelProps {
  checklist: SentinelChecklist[];
}

const SentinelPanel: React.FC<SentinelPanelProps> = ({ checklist }) => {
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