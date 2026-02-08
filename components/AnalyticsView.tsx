import React from 'react';
import { motion } from 'framer-motion';
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, BarChart, Bar, Brush } from 'recharts';

const data = [
  { name: '09:00', uv: 4000, pv: 2400, amt: 2400 },
  { name: '10:00', uv: 3000, pv: 1398, amt: 2210 },
  { name: '11:00', uv: 2000, pv: 9800, amt: 2290 },
  { name: '12:00', uv: 2780, pv: 3908, amt: 2000 },
  { name: '13:00', uv: 1890, pv: 4800, amt: 2181 },
  { name: '14:00', uv: 2390, pv: 3800, amt: 2500 },
  { name: '15:00', uv: 3490, pv: 4300, amt: 2100 },
  { name: '16:00', uv: 4490, pv: 4300, amt: 2100 },
  { name: '17:00', uv: 5490, pv: 3300, amt: 2100 },
  { name: '18:00', uv: 3490, pv: 2300, amt: 2100 },
];

const CustomTooltip = ({ active, payload, label }: any) => {
  if (active && payload && payload.length) {
    return (
      <div className="bg-[#09090b]/95 backdrop-blur-xl border border-zinc-800 p-2 rounded-lg shadow-xl">
        <p className="text-zinc-500 mb-1 font-mono text-[10px] uppercase">{label}</p>
        <p className="text-white font-mono text-xs font-bold">
          Val: {payload[0].value.toLocaleString()}
        </p>
      </div>
    );
  }
  return null;
};

const AnalyticsView: React.FC = () => {
  return (
    <motion.div 
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      className="p-4 h-full overflow-y-auto pb-24 lg:pb-0"
    >
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 h-full">
        
        {/* Chart 1 */}
        <div className="fintech-card p-6 flex flex-col h-80 lg:h-auto min-h-[400px]">
          <div className="flex items-center justify-between mb-2">
            <h2 className="text-sm font-bold text-white tracking-wide font-sans flex items-center gap-2">
                <div className="w-1 h-4 bg-trade-bid rounded-full"></div>
                Volume Profile
            </h2>
          </div>
          <div className="flex-1 w-full min-h-0">
            <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={data} margin={{ top: 10, right: 10, left: -20, bottom: 5 }}>
                <defs>
                    <linearGradient id="colorUv" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#10b981" stopOpacity={0.3}/>
                    <stop offset="95%" stopColor="#10b981" stopOpacity={0}/>
                    </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#27272a" vertical={false} />
                <XAxis dataKey="name" stroke="#52525b" tick={{fontSize: 10, fontFamily: 'JetBrains Mono'}} axisLine={false} tickLine={false} dy={10} />
                <YAxis stroke="#52525b" tick={{fontSize: 10, fontFamily: 'JetBrains Mono'}} axisLine={false} tickLine={false} />
                <Tooltip content={<CustomTooltip />} />
                <Area 
                    type="monotone" 
                    dataKey="uv" 
                    stroke="#10b981" 
                    fill="url(#colorUv)" 
                    strokeWidth={2}
                    activeDot={{ r: 6, strokeWidth: 0, fill: '#fff' }}
                />
                <Brush 
                    dataKey="name" 
                    height={20} 
                    stroke="#52525b"
                    fill="#18181b"
                    tickFormatter={() => ''}
                    className="opacity-50 hover:opacity-100 transition-opacity"
                />
                </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Chart 2 */}
        <div className="fintech-card p-6 flex flex-col h-80 lg:h-auto min-h-[400px]">
           <div className="flex items-center justify-between mb-2">
            <h2 className="text-sm font-bold text-white tracking-wide font-sans flex items-center gap-2">
                <div className="w-1 h-4 bg-trade-ask rounded-full"></div>
                Liquidity Heatmap
            </h2>
          </div>
          <div className="flex-1 w-full min-h-0">
            <ResponsiveContainer width="100%" height="100%">
                <BarChart data={data} margin={{ top: 10, right: 10, left: -20, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#27272a" vertical={false} />
                <XAxis dataKey="name" stroke="#52525b" tick={{fontSize: 10, fontFamily: 'JetBrains Mono'}} axisLine={false} tickLine={false} dy={10} />
                <YAxis stroke="#52525b" tick={{fontSize: 10, fontFamily: 'JetBrains Mono'}} axisLine={false} tickLine={false} />
                <Tooltip content={<CustomTooltip />} cursor={{fill: '#27272a'}} />
                <Bar dataKey="pv" fill="#f43f5e" radius={[4, 4, 0, 0]} barSize={30} activeBar={{ fill: '#fb7185' }} />
                <Brush 
                    dataKey="name" 
                    height={20} 
                    stroke="#52525b"
                    fill="#18181b"
                    tickFormatter={() => ''}
                    className="opacity-50 hover:opacity-100 transition-opacity"
                />
                </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
        
      </div>
    </motion.div>
  );
};

export default AnalyticsView;