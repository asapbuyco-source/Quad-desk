import React, { useMemo } from 'react';
import { MarketMetrics } from '../types';
import { Activity, Zap, TrendingUp } from 'lucide-react';
import { LineChart, Line, ResponsiveContainer, Tooltip } from 'recharts';

interface OrderFlowMetricsProps {
  metrics: MarketMetrics;
}

const CVDTooltip = ({ active, payload }: any) => {
    if (active && payload && payload.length) {
      return (
        <div className="bg-[#09090b] border border-zinc-800 p-1.5 rounded shadow-lg text-[10px] font-mono font-bold text-white">
          {payload[0].value.toFixed(1)}M
        </div>
      );
    }
    return null;
  };

const OrderFlowMetrics: React.FC<OrderFlowMetricsProps> = ({ metrics }) => {
  const cvdData = useMemo(() => 
    Array.from({ length: 20 }, (_, i) => ({ val: i * 2 + Math.random() * 10 })), 
  []);

  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-6 h-full">
      
      {/* Card 1: OFI */}
      <div className="fintech-card p-5 flex flex-col justify-between relative overflow-hidden group">
        <div className="absolute top-0 right-0 p-3 opacity-10 group-hover:opacity-20 transition-opacity">
            <Zap size={40} />
        </div>
        <div className="flex flex-col gap-1">
           <span className="text-xs font-semibold text-slate-400 uppercase tracking-wide">Imbalance (OFI)</span>
           <span className="text-2xl font-mono font-bold text-white tracking-tight">+{metrics.ofi}</span>
        </div>
        
        <div className="mt-4">
             <div className="w-full h-2 bg-slate-800/50 rounded-full overflow-hidden relative">
                <div className="absolute left-1/2 top-0 bottom-0 w-0.5 bg-slate-600 z-10"></div>
                <div className="absolute left-1/2 top-0 bottom-0 bg-gradient-to-r from-trade-bid to-emerald-400 rounded-full" style={{ width: '35%' }}></div>
             </div>
             <div className="flex justify-between mt-2 text-[10px] text-slate-500 font-bold uppercase">
                <span>Sell Side</span>
                <span className="text-trade-bid">Buy Side</span>
             </div>
        </div>
      </div>

      {/* Card 2: CVD */}
      <div className="fintech-card p-0 flex flex-col relative overflow-hidden group">
        <div className="p-5 pb-0 flex items-center justify-between">
            <div>
                <span className="text-xs font-semibold text-slate-400 uppercase tracking-wide block">Cum. Delta</span>
                <span className="text-lg font-mono font-bold text-white">14.2M</span>
            </div>
            <div className="p-2 bg-purple-500/10 rounded-lg text-purple-400">
                <TrendingUp size={16} />
            </div>
        </div>
        <div className="flex-1 w-full min-h-[60px]">
            <ResponsiveContainer width="100%" height="100%">
                <LineChart data={cvdData}>
                    <Tooltip content={<CVDTooltip />} cursor={{ stroke: 'rgba(255,255,255,0.1)' }} />
                    <Line 
                        type="monotone" 
                        dataKey="val" 
                        stroke="#a855f7" 
                        strokeWidth={2} 
                        dot={false}
                        activeDot={{ r: 4, strokeWidth: 0, fill: '#fff' }} 
                    />
                </LineChart>
            </ResponsiveContainer>
        </div>
      </div>

      {/* Card 3: Toxicity */}
      <div className="fintech-card p-5 flex flex-col justify-between relative overflow-hidden">
         <div className="flex justify-between items-start">
            <div className="flex flex-col">
                <span className="text-xs font-semibold text-slate-400 uppercase tracking-wide">Toxicity</span>
                <span className="text-xs text-slate-500">HFT Probability</span>
            </div>
            <div className={`p-2 rounded-lg ${metrics.toxicity > 80 ? 'bg-trade-warn/10 text-trade-warn' : 'bg-slate-800 text-slate-500'}`}>
                <Activity size={16} />
            </div>
         </div>
         
         <div className="flex items-end gap-2 mt-2">
             <span className={`text-3xl font-mono font-bold ${metrics.toxicity > 80 ? 'text-trade-warn' : 'text-white'}`}>
                {metrics.toxicity}%
             </span>
         </div>
      </div>

    </div>
  );
};

export default OrderFlowMetrics;