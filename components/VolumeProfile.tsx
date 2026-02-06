import React from 'react';
import { 
  BarChart, 
  Bar, 
  XAxis, 
  YAxis, 
  Tooltip, 
  ResponsiveContainer,
  Cell
} from 'recharts';
import { CandleData } from '../types';
import { AlignHorizontalJustifyStart } from 'lucide-react';
import { useVolumeProfileData } from '../hooks/useChart';

interface VolumeProfileProps {
  data: CandleData[];
}

const VolumeProfile: React.FC<VolumeProfileProps> = ({ data }) => {
  // Use Shared Hook for Calculation Logic
  const profileData = useVolumeProfileData(data, 40);

  // Recharts defaults: Category Y Axis usually starts top. We want High price at top.
  // So we pass data sorted High -> Low.
  const chartData = [...profileData];

  const getBarColor = (type: string) => {
    switch (type) {
      case 'POC': return '#f59e0b'; // Amber
      case 'HVN': return '#3b82f6'; // Blue
      case 'LVN': return '#27272a'; // Zinc 800
      default: return '#52525b'; // Zinc 600
    }
  };

  return (
    <div className="flex flex-col h-full bg-[#09090b]/95 md:bg-[#18181b]/50 rounded-xl overflow-hidden border border-white/5 relative shadow-2xl md:shadow-none">
        {/* Header aligned with PriceChart (h-12) */}
        <div className="h-12 flex items-center justify-between px-4 border-b border-white/5 bg-white/[0.02] backdrop-blur-md shrink-0">
            <div className="flex items-center gap-2 text-slate-300">
                <AlignHorizontalJustifyStart size={16} />
                <span className="text-xs font-bold uppercase tracking-wider">Volume Profile</span>
            </div>
            <div className="text-[10px] text-slate-500 font-mono">
                SESSION
            </div>
        </div>

        <div className="flex-1 w-full min-h-0 relative p-1">
            {/* Legend Overlay */}
            <div className="absolute bottom-4 right-4 z-10 flex flex-col gap-1 pointer-events-none">
                <div className="flex items-center gap-2 justify-end">
                    <span className="text-[9px] text-slate-500 uppercase font-bold">POC</span>
                    <div className="w-2 h-2 bg-amber-500 rounded-sm"></div>
                </div>
                <div className="flex items-center gap-2 justify-end">
                    <span className="text-[9px] text-slate-500 uppercase font-bold">HVN</span>
                    <div className="w-2 h-2 bg-blue-500 rounded-sm"></div>
                </div>
                 <div className="flex items-center gap-2 justify-end">
                    <span className="text-[9px] text-slate-500 uppercase font-bold">Low Liq</span>
                    <div className="w-2 h-2 bg-zinc-800 rounded-sm border border-zinc-700"></div>
                </div>
            </div>

            <ResponsiveContainer width="100%" height="100%">
                <BarChart 
                    layout="vertical" 
                    data={chartData} 
                    margin={{ top: 10, right: 10, left: 0, bottom: 5 }}
                    barGap={0}
                    barCategoryGap={1}
                >
                    <Tooltip 
                        cursor={{fill: 'rgba(255,255,255,0.05)'}}
                        content={({ active, payload }) => {
                            if (active && payload && payload.length) {
                                const d = payload[0].payload;
                                return (
                                    <div className="bg-[#09090b]/95 backdrop-blur-xl border border-zinc-800 p-2.5 rounded-lg shadow-xl z-50 min-w-[120px]">
                                        <p className="text-zinc-500 mb-1 font-mono text-[9px] uppercase tracking-wider">Price Level</p>
                                        <p className="text-white font-mono text-xs font-bold mb-2">{d.rangeLabel}</p>
                                        
                                        <div className="flex justify-between items-center border-t border-white/5 pt-2">
                                            <span className="text-zinc-500 text-[9px] uppercase">Volume</span>
                                            <span className="text-white font-mono text-xs">{d.vol.toLocaleString()}</span>
                                        </div>
                                        
                                        <div className="mt-2 text-right">
                                            <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded ${
                                                d.type === 'POC' ? 'bg-amber-500/20 text-amber-500' :
                                                d.type === 'HVN' ? 'bg-blue-500/20 text-blue-500' :
                                                d.type === 'LVN' ? 'bg-red-500/10 text-red-500' : 'bg-zinc-800 text-zinc-400'
                                            }`}>
                                                {d.type === 'LVN' ? 'LIQ HOLE' : d.type}
                                            </span>
                                        </div>
                                    </div>
                                );
                            }
                            return null;
                        }}
                    />
                    <XAxis type="number" hide />
                    <YAxis type="category" dataKey="price" hide width={0} />
                    <Bar dataKey="vol" minPointSize={2} radius={[0, 2, 2, 0]}>
                        {chartData.map((entry, index) => (
                            <Cell key={`cell-${index}`} fill={getBarColor(entry.type)} />
                        ))}
                    </Bar>
                </BarChart>
            </ResponsiveContainer>
        </div>
    </div>
  );
};

export default VolumeProfile;