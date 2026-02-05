import React, { useState, useMemo } from 'react';
import { 
  ComposedChart,
  Bar,
  Line,
  XAxis, 
  YAxis, 
  CartesianGrid, 
  Tooltip, 
  ResponsiveContainer,
  Brush,
  ReferenceLine,
  Label,
  ReferenceDot
} from 'recharts';
import { CandleData, TradeSignal, PriceLevel } from '../types';
import { Maximize2, Zap, PanelRight } from 'lucide-react';

interface PriceChartProps {
  data: CandleData[];
  signals?: TradeSignal[];
  levels?: PriceLevel[];
  showZScore?: boolean;
  showLevels?: boolean;
  showSignals?: boolean;
  children?: React.ReactNode;
  onToggleSidePanel?: () => void;
  isSidePanelOpen?: boolean;
}

// Custom Candle Shape
const Candlestick = (props: any) => {
  const { x, y, width, height, payload } = props;
  const { open, close, high, low } = payload;
  const isGrowing = close > open;
  const color = isGrowing ? '#10b981' : '#f43f5e'; // emerald-500 : rose-500
  
  const bodyHeight = Math.abs(open - close);
  const ratio = bodyHeight === 0 ? 0 : height / bodyHeight;

  let yHigh, yLow;
  
  if (ratio === 0) {
      yHigh = y;
      yLow = y + height;
  } else {
      yHigh = y - (high - Math.max(open, close)) * ratio;
      yLow = (y + height) + (Math.min(open, close) - low) * ratio;
  }

  return (
    <g>
      <line x1={x + width / 2} y1={yHigh} x2={x + width / 2} y2={yLow} stroke={color} strokeWidth={1} opacity={0.8} />
      <rect x={x} y={y} width={width} height={height < 2 ? 2 : height} fill={color} stroke="none" rx={1} />
    </g>
  );
};

const CustomTooltip = ({ active, payload, label }: any) => {
  if (active && payload && payload.length) {
    const candle = payload.find((p: any) => p.dataKey === 'candleRange')?.payload || payload[0].payload;
    return (
      <div className="bg-[#09090b]/95 backdrop-blur-xl border border-zinc-800 p-3 rounded-lg shadow-2xl z-50">
        <p className="text-zinc-500 mb-2 font-mono text-[10px] uppercase tracking-wider">{label} UTC</p>
        <div className="space-y-1 text-xs font-mono">
           <div className="flex justify-between gap-4"><span className="text-zinc-500">Price</span> <span className={`font-bold ${candle.close > candle.open ? 'text-trade-bid' : 'text-trade-ask'}`}>{candle.close.toFixed(2)}</span></div>
           <div className="flex justify-between gap-4"><span className="text-zinc-500">High</span> <span className="text-zinc-400">{candle.high.toFixed(2)}</span></div>
           <div className="flex justify-between gap-4"><span className="text-zinc-500">Low</span> <span className="text-zinc-400">{candle.low.toFixed(2)}</span></div>
           <div className="flex justify-between gap-4 border-t border-white/5 pt-1 mt-1"><span className="text-brand-accent">AI Upper</span> <span className="text-zinc-300">{candle.zScoreUpper2.toFixed(2)}</span></div>
           <div className="flex justify-between gap-4"><span className="text-brand-accent">AI Lower</span> <span className="text-zinc-300">{candle.zScoreLower2.toFixed(2)}</span></div>
        </div>
      </div>
    );
  }
  return null;
};

const PriceChart: React.FC<PriceChartProps> = ({ 
    data, 
    signals = [], 
    levels = [],
    showZScore = true,
    showLevels = true,
    showSignals = true,
    children,
    onToggleSidePanel,
    isSidePanelOpen
}) => {
  const [timeframe, setTimeframe] = useState('1H');
  const timeframes = ['1M', '15M', '1H', '4H', '1D'];

  const chartData = useMemo(() => {
    return data.map(d => ({
        ...d,
        candleRange: [Math.min(d.open, d.close), Math.max(d.open, d.close)]
    }));
  }, [data]);

  return (
    <div className="w-full h-full flex flex-col relative rounded-xl overflow-hidden bg-[#18181b]/50">
        {/* Header Bar */}
        <div className="h-16 flex items-center justify-between px-4 border-b border-white/5 bg-white/[0.02] backdrop-blur-md z-20 shrink-0 gap-4">
            {/* Left: Timeframes */}
            <div className="flex gap-1 bg-zinc-900/50 p-1 rounded-lg border border-white/5 shrink-0">
                {timeframes.map((tf) => (
                    <button 
                        key={tf}
                        onClick={() => setTimeframe(tf)}
                        className={`
                            text-[10px] font-bold px-3 py-1.5 rounded-md transition-colors
                            ${timeframe === tf ? 'bg-zinc-700 text-white shadow-sm' : 'text-zinc-500 hover:text-zinc-300 hover:bg-white/5'}
                        `}
                    >
                        {tf}
                    </button>
                ))}
            </div>

            {/* Center: Controls (Injected) */}
            <div className="hidden md:flex flex-1 justify-center">
                {children}
            </div>

            {/* Right: Status & Actions */}
            <div className="flex items-center gap-3 shrink-0">
                 <div className="hidden sm:flex items-center gap-2 px-3 py-1.5 bg-brand-accent/10 border border-brand-accent/20 rounded-full">
                    <Zap size={12} className="text-brand-accent" />
                    <span className="text-[10px] font-bold text-brand-accent uppercase tracking-wide">Sentinel Active</span>
                </div>
                
                {onToggleSidePanel && (
                    <button 
                        onClick={onToggleSidePanel}
                        className={`
                            hidden md:flex p-2 rounded-lg transition-colors border
                            ${isSidePanelOpen 
                                ? 'bg-purple-500/10 text-purple-400 border-purple-500/20 shadow-[0_0_10px_rgba(168,85,247,0.1)]' 
                                : 'text-zinc-500 border-transparent hover:bg-white/5 hover:text-zinc-300'}
                        `}
                        title="Toggle Volume Profile"
                    >
                        <PanelRight size={18} />
                    </button>
                )}

                <button className="text-zinc-500 hover:text-white transition-colors p-2 hover:bg-white/5 rounded-lg">
                    <Maximize2 size={18} />
                </button>
            </div>
        </div>

        {/* Mobile Controls Row */}
        <div className="md:hidden flex justify-center p-2 border-b border-white/5 bg-white/[0.02]">
             {children}
        </div>

      <div className="flex-1 w-full min-h-0 relative">
        <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={chartData} margin={{ top: 20, right: 60, left: -10, bottom: 5 }}>
            <defs>
                <filter id="glow" x="-50%" y="-50%" width="200%" height="200%">
                    <feGaussianBlur stdDeviation="2" result="coloredBlur"/>
                    <feMerge>
                        <feMergeNode in="coloredBlur"/>
                        <feMergeNode in="SourceGraphic"/>
                    </feMerge>
                </filter>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="#27272a" vertical={false} strokeOpacity={0.5} />
            <XAxis 
                dataKey="time" 
                stroke="#52525b" 
                tick={{fontSize: 10, fontFamily: 'JetBrains Mono', fill: '#71717a'}} 
                tickLine={false} 
                axisLine={false} 
                minTickGap={40}
                dy={10}
            />
            <YAxis 
                domain={['auto', 'auto']} 
                orientation="right" 
                stroke="#52525b" 
                tick={{fontSize: 10, fontFamily: 'JetBrains Mono', fill: '#71717a'}} 
                tickLine={false} 
                axisLine={false} 
                width={60}
            />
            <Tooltip content={<CustomTooltip />} cursor={{ stroke: '#3f3f46', strokeWidth: 1, strokeDasharray: '4 4' }} />
            
            {/* AI Auto-Drawn Lines (Z-Score Bands) */}
            {showZScore && (
                <>
                    <Line type="monotone" dataKey="zScoreUpper2" stroke="#3b82f6" strokeWidth={1} strokeDasharray="4 4" dot={false} strokeOpacity={0.4} />
                    <Line type="monotone" dataKey="zScoreLower2" stroke="#3b82f6" strokeWidth={1} strokeDasharray="4 4" dot={false} strokeOpacity={0.4} />
                </>
            )}

            {/* Support & Resistance Levels */}
            {showLevels && levels.map((level, i) => (
                <ReferenceLine 
                    key={`level-${i}`} 
                    y={level.price} 
                    stroke={level.type === 'RESISTANCE' ? '#f43f5e' : '#10b981'} 
                    strokeDasharray="10 5" 
                    strokeOpacity={0.8}
                >
                    <Label value={level.label} position="right" fill={level.type === 'RESISTANCE' ? '#f43f5e' : '#10b981'} fontSize={10} fontWeight="bold" />
                </ReferenceLine>
            ))}

            {/* Entry & Exit Signals */}
            {showSignals && signals.map((sig, i) => (
                <ReferenceDot
                    key={`sig-${i}`}
                    x={sig.time}
                    y={sig.price}
                    r={6}
                    fill={sig.type.includes('ENTRY') ? '#3b82f6' : '#f59e0b'}
                    stroke="#fff"
                    strokeWidth={2}
                    ifOverflow="extendDomain"
                >
                    <Label 
                        value={sig.label} 
                        position={sig.type.includes('SHORT') || sig.type.includes('EXIT') ? "top" : "bottom"} 
                        fill="#fff" 
                        fontSize={10} 
                        fontWeight="bold" 
                        offset={10}
                        className="bg-black/50"
                    />
                </ReferenceDot>
            ))}

            {/* Candlesticks */}
            <Bar 
                dataKey="candleRange" 
                fill="#8884d8" 
                shape={<Candlestick />}
                isAnimationActive={false} 
            />

            <Brush 
                dataKey="time" 
                height={24} 
                stroke="#52525b"
                fill="#18181b"
                tickFormatter={() => ''}
                travellerWidth={10}
                className="opacity-50 hover:opacity-100 transition-opacity"
            />
            </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
};

export default PriceChart;