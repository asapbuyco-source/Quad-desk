import React, { useEffect, useRef, useState } from 'react';
import { createChart, ColorType, IChartApi, ISeriesApi, CrosshairMode, LineStyle, IPriceLine, CandlestickSeries, HistogramSeries } from 'lightweight-charts';
import { CandleData, TradeSignal, PriceLevel, AiScanResult } from '../types';
import { Zap, PanelRight, Rocket, Loader2 } from 'lucide-react';

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
    children,
    onToggleSidePanel,
    isSidePanelOpen
}) => {
  const chartContainerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  // Using any to avoid strict type mismatches during version upgrades
  const candlestickSeriesRef = useRef<ISeriesApi<"Candlestick"> | any>(null);
  const volumeSeriesRef = useRef<ISeriesApi<"Histogram"> | any>(null);
  const priceLinesRef = useRef<IPriceLine[]>([]); 
  const [hoveredData, setHoveredData] = useState<any>(null);

  // Initialize Chart
  useEffect(() => {
    if (!chartContainerRef.current) return;

    // Create Chart with auto-size behavior via ResizeObserver logic later, 
    // but start with container dimensions if available.
    const chart = createChart(chartContainerRef.current, {
      width: chartContainerRef.current.clientWidth || 600,
      height: chartContainerRef.current.clientHeight || 400,
      layout: {
        background: { type: ColorType.Solid, color: 'transparent' },
        textColor: '#71717a',
        fontFamily: 'JetBrains Mono',
      },
      grid: {
        vertLines: { color: 'rgba(255, 255, 255, 0.05)' },
        horzLines: { color: 'rgba(255, 255, 255, 0.05)' },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: {
            width: 1,
            color: 'rgba(255, 255, 255, 0.1)',
            style: LineStyle.Dashed,
            labelBackgroundColor: '#27272a',
        },
        horzLine: {
            width: 1,
            color: 'rgba(255, 255, 255, 0.1)',
            style: LineStyle.Dashed,
            labelBackgroundColor: '#27272a',
        },
      },
      timeScale: {
        borderColor: 'rgba(255, 255, 255, 0.1)',
        timeVisible: true,
        secondsVisible: false,
      },
      rightPriceScale: {
        borderColor: 'rgba(255, 255, 255, 0.1)',
        scaleMargins: {
            top: 0.1,
            bottom: 0.2,
        }
      }
    });

    // Add Series using v5 addSeries API
    const candlestickSeries = chart.addSeries(CandlestickSeries, {
      upColor: '#10b981',
      downColor: '#f43f5e',
      borderVisible: false,
      wickUpColor: '#10b981',
      wickDownColor: '#f43f5e',
    });

    const volumeSeries = chart.addSeries(HistogramSeries, {
      color: '#26a69a',
      priceFormat: {
        type: 'volume',
      },
      priceScaleId: '', 
    });
    
    volumeSeries.priceScale().applyOptions({
        scaleMargins: {
            top: 0.85, 
            bottom: 0,
        },
    });

    chartRef.current = chart;
    candlestickSeriesRef.current = candlestickSeries;
    volumeSeriesRef.current = volumeSeries;

    // Crosshair Handler
    chart.subscribeCrosshairMove((param) => {
        if (
            param.point === undefined ||
            !param.time ||
            param.point.x < 0 ||
            param.point.x > chartContainerRef.current!.clientWidth ||
            param.point.y < 0 ||
            param.point.y > chartContainerRef.current!.clientHeight
        ) {
            setHoveredData(null);
        } else {
            const candle = param.seriesData.get(candlestickSeries);
            const volume = param.seriesData.get(volumeSeries);
            if (candle) {
                setHoveredData({
                    ...candle,
                    volume: volume ? (volume as any).value : 0,
                    time: param.time
                });
            }
        }
    });

    // Robust Resize Handler
    const resizeObserver = new ResizeObserver((entries) => {
        if (entries.length === 0 || !entries[0].contentRect) return;
        const { width, height } = entries[0].contentRect;
        if(chartRef.current) {
            chartRef.current.applyOptions({ width, height });
        }
    });
    resizeObserver.observe(chartContainerRef.current);

    return () => {
      resizeObserver.disconnect();
      if(chartRef.current) {
          chartRef.current.remove();
          chartRef.current = null;
      }
      // CRITICAL: Clear refs to prevent usage of destroyed series
      candlestickSeriesRef.current = null;
      volumeSeriesRef.current = null;
    };
  }, []);

  // Update Data
  useEffect(() => {
    if (!candlestickSeriesRef.current || !volumeSeriesRef.current || data.length === 0) return;

    const candles = data.map(d => ({
        time: d.time as any,
        open: d.open,
        high: d.high,
        low: d.low,
        close: d.close
    }));

    const volumes = data.map(d => ({
        time: d.time as any,
        value: d.volume,
        color: d.close > d.open ? 'rgba(16, 185, 129, 0.3)' : 'rgba(244, 63, 94, 0.3)'
    }));

    candlestickSeriesRef.current.setData(candles);
    volumeSeriesRef.current.setData(volumes);
  }, [data]);

  // Handle AI Scan Results & Manual Levels
  useEffect(() => {
      if (!candlestickSeriesRef.current || !showLevels) return;

      // REMOVE OLD LINES
      priceLinesRef.current.forEach(line => {
          try {
             candlestickSeriesRef.current?.removePriceLine(line);
          } catch(e) {
             // Ignore if line already removed
          }
      });
      priceLinesRef.current = [];

      // ADD NEW LINES
      levels.forEach(l => {
           let color = '#71717a'; 
           let lineStyle = LineStyle.Dashed;
           let lineWidth: 1 | 2 | 3 | 4 = 1;

           if (l.type === 'ENTRY') { color = '#3b82f6'; lineWidth = 2; lineStyle = LineStyle.Solid; }
           else if (l.type === 'STOP_LOSS') { color = '#f43f5e'; lineWidth = 2; lineStyle = LineStyle.Solid; }
           else if (l.type === 'TAKE_PROFIT') { color = '#10b981'; lineWidth = 2; lineStyle = LineStyle.Solid; }
           
           const line = candlestickSeriesRef.current?.createPriceLine({
               price: l.price,
               color: color,
               lineWidth: lineWidth,
               lineStyle: lineStyle,
               axisLabelVisible: true,
               title: l.label,
           });
           if(line) priceLinesRef.current.push(line);
      });

      if (aiScanResult) {
          aiScanResult.support.forEach(price => {
              const line = candlestickSeriesRef.current?.createPriceLine({
                  price,
                  color: '#10b981',
                  lineWidth: 1,
                  lineStyle: LineStyle.Dashed,
                  axisLabelVisible: true,
                  title: 'AI SUPPORT',
              });
              if(line) priceLinesRef.current.push(line);
          });

          aiScanResult.resistance.forEach(price => {
              const line = candlestickSeriesRef.current?.createPriceLine({
                  price,
                  color: '#f43f5e',
                  lineWidth: 1,
                  lineStyle: LineStyle.Dashed,
                  axisLabelVisible: true,
                  title: 'AI RESIST',
              });
              if(line) priceLinesRef.current.push(line);
          });

          const decisionColor = aiScanResult.verdict === 'ENTRY' ? '#3b82f6' : '#f97316';
          const line = candlestickSeriesRef.current?.createPriceLine({
              price: aiScanResult.decision_price,
              color: decisionColor,
              lineWidth: 3,
              lineStyle: LineStyle.Solid,
              axisLabelVisible: true,
              title: `AI PIVOT (${aiScanResult.verdict})`,
          });
          if(line) priceLinesRef.current.push(line);
      }

  }, [levels, aiScanResult, showLevels]);

  // Handle Signals
  useEffect(() => {
    if (!candlestickSeriesRef.current) return;
    
    // Safety check for setMarkers method existence
    if (typeof candlestickSeriesRef.current.setMarkers !== 'function') return;

    if (showSignals) {
        const markers = signals.map(s => ({
            time: s.time as any,
            position: (s.type.includes('SHORT') || s.type.includes('EXIT')) ? 'aboveBar' : 'belowBar',
            color: s.type.includes('ENTRY') ? '#3b82f6' : '#f59e0b',
            shape: (s.type.includes('SHORT') || s.type.includes('EXIT')) ? 'arrowDown' : 'arrowUp',
            text: s.label,
        }));
        candlestickSeriesRef.current.setMarkers(markers);
    } else {
        candlestickSeriesRef.current.setMarkers([]);
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

            {/* AI Scan Button */}
            {onScan && (
                <button
                    onClick={onScan}
                    disabled={isScanning}
                    className={`
                        flex items-center gap-2 px-4 py-1.5 rounded-full text-xs font-bold uppercase tracking-wide transition-all
                        ${isScanning 
                            ? 'bg-purple-500/20 text-purple-400 border border-purple-500/30 cursor-wait' 
                            : 'bg-brand-accent text-white hover:bg-blue-600 shadow-[0_0_15px_rgba(59,130,246,0.4)] hover:shadow-[0_0_20px_rgba(59,130,246,0.6)]'}
                    `}
                >
                    {isScanning ? (
                        <Loader2 size={12} className="animate-spin" />
                    ) : (
                        <Rocket size={12} />
                    )}
                    {isScanning ? 'Scanning...' : 'AI Market Scan'}
                </button>
            )}

            <div className="hidden md:flex flex-1 justify-center">
                {children}
            </div>

            <div className="flex items-center gap-3 shrink-0">
                 <div className="hidden sm:flex items-center gap-2 px-3 py-1 bg-brand-accent/10 border border-brand-accent/20 rounded-full">
                    <Zap size={10} className="text-brand-accent" />
                    <span className="text-[9px] font-bold text-brand-accent uppercase tracking-wide">Sentinel Active</span>
                </div>
                
                {onToggleSidePanel && (
                    <button 
                        onClick={onToggleSidePanel}
                        className={`
                            hidden md:flex p-1.5 rounded-lg transition-colors border
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
                     <span className="text-xs font-mono text-zinc-400">
                        {new Date((hoveredData.time as number) * 1000).toLocaleTimeString()}
                     </span>
                 </div>
                 <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs font-mono">
                     <span className="text-zinc-500">O</span>
                     <span className={hoveredData.close >= hoveredData.open ? "text-emerald-400" : "text-rose-400"}>
                         {hoveredData.open.toFixed(2)}
                     </span>
                     <span className="text-zinc-500">H</span>
                     <span className="text-zinc-300">{hoveredData.high.toFixed(2)}</span>
                     <span className="text-zinc-500">L</span>
                     <span className="text-zinc-300">{hoveredData.low.toFixed(2)}</span>
                     <span className="text-zinc-500">C</span>
                     <span className={hoveredData.close >= hoveredData.open ? "text-emerald-400" : "text-rose-400"}>
                         {hoveredData.close.toFixed(2)}
                     </span>
                     <span className="text-zinc-500">Vol</span>
                     <span className="text-zinc-300">{hoveredData.volume.toLocaleString()}</span>
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