import React, { useEffect, useRef, useState } from 'react';
import { ISeriesApi, LineStyle, IPriceLine, CandlestickSeries, HistogramSeries, LineSeries, Time } from 'lightweight-charts';
import { CandleData, TradeSignal, PriceLevel, AiScanResult } from '../types';
import { PanelRight, Rocket, Loader2, Clock, TrendingUp, Minus } from 'lucide-react';
import { useLightweightChart } from '../hooks/useChart';

interface PriceChartProps {
  data: CandleData[];
  signals?: TradeSignal[];
  levels?: PriceLevel[];
  aiScanResult?: AiScanResult;
  onScan?: () => void;
  isScanning?: boolean;
  showZScore?: boolean;
  showLevels?: boolean;
  showSignals?: boolean;
  children?: React.ReactNode;
  onToggleSidePanel?: () => void;
  isSidePanelOpen?: boolean;
  interval?: string;
  onIntervalChange?: (interval: string) => void;
}

const PriceChart: React.FC<PriceChartProps> = ({ 
    data, 
    signals = [], 
    levels = [],
    aiScanResult,
    onScan,
    isScanning,
    showLevels = true,
    showSignals = true,
    showZScore = true,
    children,
    onToggleSidePanel,
    isSidePanelOpen,
    interval = '1m',
    onIntervalChange
}) => {
  const chartContainerRef = useRef<HTMLDivElement>(null);
  
  // Use Shared Hook
  const chartRef = useLightweightChart(chartContainerRef, {
      leftPriceScale: {
          visible: true,
          borderColor: 'rgba(255, 255, 255, 0.1)',
          scaleMargins: {
              top: 0.7,
              bottom: 0,
          }
      }
  });
  
  // Series Refs
  const candlestickSeriesRef = useRef<ISeriesApi<"Candlestick"> | any>(null);
  const volumeSeriesRef = useRef<ISeriesApi<"Histogram"> | any>(null);
  const adxSeriesRef = useRef<ISeriesApi<"Line"> | any>(null);
  
  // Band Series Refs
  const upper1SeriesRef = useRef<ISeriesApi<"Line"> | any>(null);
  const lower1SeriesRef = useRef<ISeriesApi<"Line"> | any>(null);
  const upper2SeriesRef = useRef<ISeriesApi<"Line"> | any>(null);
  const lower2SeriesRef = useRef<ISeriesApi<"Line"> | any>(null);

  const priceLinesRef = useRef<IPriceLine[]>([]); 
  const [hoveredData, setHoveredData] = useState<any>(null);
  const [currentAdx, setCurrentAdx] = useState<number>(0);

  // Helper to validate number (Handles null, undefined, NaN)
  const isValid = (n: number | undefined | null): boolean => typeof n === 'number' && !isNaN(n);

  // Initialize Series
  useEffect(() => {
      if (!chartRef.current) return;

      // Only initialize series if they don't exist
      if (!candlestickSeriesRef.current) {
        const chart = chartRef.current;

        const candlestickSeries = chart.addSeries(CandlestickSeries, {
            upColor: '#10b981',
            downColor: '#f43f5e',
            borderVisible: false,
            wickUpColor: '#10b981',
            wickDownColor: '#f43f5e',
        });

        const volumeSeries = chart.addSeries(HistogramSeries, {
            color: '#26a69a',
            priceFormat: { type: 'volume' },
            priceScaleId: '', // Overlay
        });
        
        volumeSeries.priceScale().applyOptions({
            scaleMargins: { top: 0.85, bottom: 0 },
        });

        // Add ADX Series (Left Scale)
        const adxSeries = chart.addSeries(LineSeries, {
            color: '#a855f7', // Purple
            lineWidth: 2,
            priceScaleId: 'left',
            crosshairMarkerVisible: false,
            lastValueVisible: false,
        });

        // Add AI Band Series
        const upper2 = chart.addSeries(LineSeries, { color: 'rgba(244, 63, 94, 0.6)', lineWidth: 1, lineStyle: LineStyle.Solid, crosshairMarkerVisible: false }); 
        const upper1 = chart.addSeries(LineSeries, { color: 'rgba(249, 115, 22, 0.5)', lineWidth: 1, lineStyle: LineStyle.Dashed, crosshairMarkerVisible: false }); 
        const lower1 = chart.addSeries(LineSeries, { color: 'rgba(59, 130, 246, 0.5)', lineWidth: 1, lineStyle: LineStyle.Dashed, crosshairMarkerVisible: false }); 
        const lower2 = chart.addSeries(LineSeries, { color: 'rgba(16, 185, 129, 0.6)', lineWidth: 1, lineStyle: LineStyle.Solid, crosshairMarkerVisible: false }); 

        candlestickSeriesRef.current = candlestickSeries;
        volumeSeriesRef.current = volumeSeries;
        adxSeriesRef.current = adxSeries;
        upper1SeriesRef.current = upper1;
        lower1SeriesRef.current = lower1;
        upper2SeriesRef.current = upper2;
        lower2SeriesRef.current = lower2;

        // Crosshair Handler
        chart.subscribeCrosshairMove((param) => {
            if (
                param.point === undefined ||
                !param.time ||
                !chartContainerRef.current ||
                param.point.x < 0 ||
                param.point.x > chartContainerRef.current.clientWidth ||
                param.point.y < 0 ||
                param.point.y > chartContainerRef.current.clientHeight
            ) {
                setHoveredData(null);
            } else {
                const candle = param.seriesData.get(candlestickSeries);
                const volume = param.seriesData.get(volumeSeries);
                const adx = param.seriesData.get(adxSeries);
                
                if (candle) {
                    setHoveredData({
                        ...candle,
                        volume: volume ? (volume as any).value : 0,
                        adx: adx ? (adx as any).value : 0,
                        time: param.time
                    });
                }
            }
        });
      }
  }, [chartRef.current]);

  // Update Data & Bands & ADX
  useEffect(() => {
    if (!candlestickSeriesRef.current || !volumeSeriesRef.current || data.length === 0) return;

    // Filter and map valid data only
    const validData = data.filter(d => 
        d.time && isValid(d.open) && isValid(d.high) && isValid(d.low) && isValid(d.close)
    );

    const candles = validData.map(d => ({
        time: d.time as Time,
        open: d.open,
        high: d.high,
        low: d.low,
        close: d.close
    }));

    const volumes = validData.map(d => ({
        time: d.time as Time,
        value: isValid(d.volume) ? d.volume : 0,
        color: d.close > d.open ? 'rgba(16, 185, 129, 0.3)' : 'rgba(244, 63, 94, 0.3)'
    }));

    const adxData = validData.map(d => ({
        time: d.time as Time,
        value: isValid(d.adx) ? (d.adx || 0) : 0
    }));
    
    if (validData.length > 0) {
        const lastAdx = validData[validData.length - 1].adx;
        setCurrentAdx(isValid(lastAdx) ? (lastAdx || 0) : 0);
    }

    try {
        candlestickSeriesRef.current.setData(candles);
        volumeSeriesRef.current.setData(volumes);
        if(adxSeriesRef.current) adxSeriesRef.current.setData(adxData);
        
        // Band Data
        const u1Data = validData.map(d => ({ time: d.time as Time, value: isValid(d.zScoreUpper1) ? d.zScoreUpper1 : 0 }));
        const l1Data = validData.map(d => ({ time: d.time as Time, value: isValid(d.zScoreLower1) ? d.zScoreLower1 : 0 }));
        const u2Data = validData.map(d => ({ time: d.time as Time, value: isValid(d.zScoreUpper2) ? d.zScoreUpper2 : 0 }));
        const l2Data = validData.map(d => ({ time: d.time as Time, value: isValid(d.zScoreLower2) ? d.zScoreLower2 : 0 }));
        
        if(upper1SeriesRef.current) upper1SeriesRef.current.setData(u1Data);
        if(lower1SeriesRef.current) lower1SeriesRef.current.setData(l1Data);
        if(upper2SeriesRef.current) upper2SeriesRef.current.setData(u2Data);
        if(lower2SeriesRef.current) lower2SeriesRef.current.setData(l2Data);
    } catch (err) {
        console.error("Chart Data Update Error:", err);
    }

  }, [data]);

  // Handle Band Visibility
  useEffect(() => {
    if(!upper1SeriesRef.current) return;
    const visibility = !!showZScore; // Ensure boolean
    try {
        upper1SeriesRef.current.applyOptions({ visible: visibility });
        lower1SeriesRef.current.applyOptions({ visible: visibility });
        upper2SeriesRef.current.applyOptions({ visible: visibility });
        lower2SeriesRef.current.applyOptions({ visible: visibility });
    } catch(e) {
        console.error("Band visibility error", e);
    }
  }, [showZScore]);

  // Handle Levels (Support/Resistance)
  useEffect(() => {
      if (!candlestickSeriesRef.current || !showLevels) return;

      // REMOVE OLD LINES
      priceLinesRef.current.forEach(line => {
          try {
             candlestickSeriesRef.current?.removePriceLine(line);
          } catch(e) {}
      });
      priceLinesRef.current = [];

      // ADD NEW LINES
      levels.forEach(l => {
           // Skip invalid levels
           if (!isValid(l.price)) return;

           let color = '#71717a'; 
           let lineStyle = LineStyle.Dashed;
           let lineWidth: 1 | 2 | 3 | 4 = 1;

           if (l.type === 'ENTRY') { color = '#3b82f6'; lineWidth = 2; lineStyle = LineStyle.Solid; }
           else if (l.type === 'STOP_LOSS') { color = '#f43f5e'; lineWidth = 2; lineStyle = LineStyle.Solid; }
           else if (l.type === 'TAKE_PROFIT') { color = '#10b981'; lineWidth = 2; lineStyle = LineStyle.Solid; }
           
           try {
               const line = candlestickSeriesRef.current?.createPriceLine({
                   price: l.price,
                   color: color,
                   lineWidth: lineWidth,
                   lineStyle: lineStyle,
                   axisLabelVisible: true,
                   title: l.label,
               });
               if(line) priceLinesRef.current.push(line);
           } catch(e) {
               console.error("Failed to create price line", e);
           }
      });

      if (aiScanResult) {
          aiScanResult.support.forEach(price => {
              if (!isValid(price)) return;
              try {
                const line = candlestickSeriesRef.current?.createPriceLine({
                    price,
                    color: '#10b981',
                    lineWidth: 1,
                    lineStyle: LineStyle.Dashed,
                    axisLabelVisible: true,
                    title: 'AI SUPPORT',
                });
                if(line) priceLinesRef.current.push(line);
              } catch(e) {}
          });

          aiScanResult.resistance.forEach(price => {
              if (!isValid(price)) return;
              try {
                const line = candlestickSeriesRef.current?.createPriceLine({
                    price,
                    color: '#f43f5e',
                    lineWidth: 1,
                    lineStyle: LineStyle.Dashed,
                    axisLabelVisible: true,
                    title: 'AI RESIST',
                });
                if(line) priceLinesRef.current.push(line);
              } catch(e) {}
          });

          if (isValid(aiScanResult.decision_price)) {
              const decisionColor = aiScanResult.verdict === 'ENTRY' ? '#3b82f6' : '#f97316';
              try {
                const line = candlestickSeriesRef.current?.createPriceLine({
                    price: aiScanResult.decision_price,
                    color: decisionColor,
                    lineWidth: 3,
                    lineStyle: LineStyle.Solid,
                    axisLabelVisible: true,
                    title: `AI PIVOT (${aiScanResult.verdict})`,
                });
                if(line) priceLinesRef.current.push(line);
              } catch(e) {}
          }
      }

  }, [levels, aiScanResult, showLevels]);

  // Handle Signals
  useEffect(() => {
    if (!candlestickSeriesRef.current) return;
    
    if (typeof candlestickSeriesRef.current.setMarkers !== 'function') return;

    if (showSignals) {
        const markers = signals
            .filter(s => s.time && isValid(s.price))
            .map(s => ({
                time: s.time as Time,
                position: (s.type.includes('SHORT') || s.type.includes('EXIT')) ? 'aboveBar' : 'belowBar',
                color: s.type.includes('ENTRY') ? '#3b82f6' : '#f59e0b',
                shape: (s.type.includes('SHORT') || s.type.includes('EXIT')) ? 'arrowDown' : 'arrowUp',
                text: s.label,
            }));
        try {
            candlestickSeriesRef.current.setMarkers(markers);
        } catch(e) {
            console.error("Signal markers error", e);
        }
    } else {
        try {
            candlestickSeriesRef.current.setMarkers([]);
        } catch(e) {}
    }
  }, [signals, showSignals]);


  return (
    <div className="w-full h-full flex flex-col relative rounded-xl overflow-hidden bg-[#18181b]/50 select-none group">
        
        {/* Header Bar */}
        <div className="h-12 flex items-center justify-between px-4 border-b border-white/5 bg-white/[0.02] backdrop-blur-md z-20 shrink-0 gap-4">
             <div className="flex items-center gap-2">
                 <div className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></div>
                 <span className="text-[10px] font-bold text-emerald-500 uppercase tracking-wide">BTC/USDT LIVE</span>
             </div>

             {/* ADX Trend Indicator */}
             <div className="hidden sm:flex items-center gap-2 px-3 py-1 bg-black/40 rounded-full border border-white/5">
                {currentAdx > 25 ? (
                    <TrendingUp size={12} className={currentAdx > 50 ? "text-rose-500" : "text-emerald-500"} />
                ) : (
                    <Minus size={12} className="text-zinc-500" />
                )}
                <span className={`text-[10px] font-bold uppercase ${
                    currentAdx > 50 ? "text-rose-500" : 
                    currentAdx > 25 ? "text-emerald-500" : 
                    "text-zinc-500"
                }`}>
                    {currentAdx > 50 ? "STRONG TREND" : currentAdx > 25 ? "TRENDING" : "RANGING"}
                </span>
                <span className="text-[9px] font-mono text-zinc-600">ADX {currentAdx.toFixed(1)}</span>
             </div>

             {/* Timeframe Selector */}
             {onIntervalChange && (
                 <div className="flex items-center gap-1 bg-black/20 p-1 rounded-lg border border-white/5">
                     {['1m', '5m', '15m', '1h', '4h', '1d'].map(tf => (
                         <button
                            key={tf}
                            onClick={() => onIntervalChange(tf)}
                            className={`
                                px-2 py-0.5 text-[9px] font-bold rounded-md transition-all uppercase
                                ${interval === tf ? 'bg-brand-accent text-white shadow-sm' : 'text-zinc-500 hover:text-zinc-300 hover:bg-white/5'}
                            `}
                         >
                             {tf}
                         </button>
                     ))}
                 </div>
             )}

            <div className="hidden md:flex flex-1 justify-center">
                {children}
            </div>

            <div className="flex items-center gap-3 shrink-0">
                 {/* AI Scan Button */}
                {onScan && (
                    <button
                        onClick={onScan}
                        disabled={isScanning}
                        className={`
                            flex items-center gap-2 px-3 py-1.5 rounded-full text-[10px] font-bold uppercase tracking-wide transition-all
                            ${isScanning 
                                ? 'bg-purple-500/20 text-purple-400 border border-purple-500/30 cursor-wait' 
                                : 'bg-brand-accent/10 text-brand-accent border border-brand-accent/20 hover:bg-brand-accent hover:text-white'}
                        `}
                    >
                        {isScanning ? (
                            <Loader2 size={10} className="animate-spin" />
                        ) : (
                            <Rocket size={10} />
                        )}
                        {isScanning ? 'SCAN' : 'AI SCAN'}
                    </button>
                )}
                
                {onToggleSidePanel && (
                    <button 
                        onClick={onToggleSidePanel}
                        className={`
                            flex p-1.5 rounded-lg transition-colors border
                            ${isSidePanelOpen 
                                ? 'bg-purple-500/10 text-purple-400 border-purple-500/20 shadow-[0_0_10px_rgba(168,85,247,0.1)]' 
                                : 'text-zinc-500 border-transparent hover:bg-white/5 hover:text-zinc-300'}
                        `}
                        title="Toggle Volume Profile"
                    >
                        <PanelRight size={16} />
                    </button>
                )}
            </div>
        </div>

      {/* Chart Container */}
      <div className="flex-1 w-full min-h-0 relative">
        <div ref={chartContainerRef} className="w-full h-full" />

        {/* Floating Tooltip */}
        {hoveredData && (
             <div className="absolute top-2 left-2 z-50 pointer-events-none bg-[#09090b]/80 backdrop-blur-md border border-white/10 p-3 rounded-lg shadow-xl">
                 <div className="flex items-center gap-2 mb-1">
                     <Clock size={10} className="text-zinc-500" />
                     <span className="text-xs font-mono text-zinc-400">
                        {new Date((hoveredData.time as number) * 1000).toLocaleTimeString()}
                     </span>
                 </div>
                 <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs font-mono">
                     <span className="text-zinc-500">O</span>
                     <span className={hoveredData.close >= hoveredData.open ? "text-emerald-400" : "text-rose-400"}>
                         {isValid(hoveredData.open) ? hoveredData.open.toFixed(2) : '-'}
                     </span>
                     <span className="text-zinc-500">H</span>
                     <span className="text-zinc-300">{isValid(hoveredData.high) ? hoveredData.high.toFixed(2) : '-'}</span>
                     <span className="text-zinc-500">L</span>
                     <span className="text-zinc-300">{isValid(hoveredData.low) ? hoveredData.low.toFixed(2) : '-'}</span>
                     <span className="text-zinc-500">C</span>
                     <span className={hoveredData.close >= hoveredData.open ? "text-emerald-400" : "text-rose-400"}>
                         {isValid(hoveredData.close) ? hoveredData.close.toFixed(2) : '-'}
                     </span>
                     <span className="text-zinc-500">Vol</span>
                     <span className="text-zinc-300">{hoveredData.volume ? hoveredData.volume.toLocaleString() : '-'}</span>
                     <span className="text-zinc-500">ADX</span>
                     <span className="text-purple-400">{hoveredData.adx ? hoveredData.adx.toFixed(2) : '-'}</span>
                 </div>
             </div>
        )}
        
        {/* Watermark */}
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 pointer-events-none opacity-[0.03]">
            <span className="text-9xl font-black text-white tracking-tighter">BTC</span>
        </div>
      </div>
    </div>
  );
};

export default PriceChart;