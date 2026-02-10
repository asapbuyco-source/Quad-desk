import React, { useEffect, useRef, useState } from 'react';
import { ISeriesApi, LineStyle, IPriceLine, CandlestickSeries, HistogramSeries, LineSeries, Time, MouseEventHandler } from 'lightweight-charts';
import { CandleData, TradeSignal, PriceLevel, AiScanResult } from '../types';
import { PanelRight, Rocket, Loader2, Clock, TrendingUp, Minus } from 'lucide-react';
import { useLightweightChart } from '../hooks/useChart';

/**
 * Props for the PriceChart component.
 */
interface PriceChartProps {
  /** Array of candlestick data points (OHLCV) */
  data: CandleData[];
  /** Array of trade signal markers (Entry/Exit) */
  signals?: TradeSignal[];
  /** Key price levels to display as horizontal lines */
  levels?: PriceLevel[];
  /** Result from AI analysis containing support/resistance/pivot */
  aiScanResult?: AiScanResult;
  /** Callback to trigger AI analysis */
  onScan?: () => void;
  /** Loading state for AI analysis */
  isScanning?: boolean;
  /** Toggle visibility of Z-Score bands */
  showZScore?: boolean;
  /** Toggle visibility of Price Levels */
  showLevels?: boolean;
  /** Toggle visibility of Signal Markers */
  showSignals?: boolean;
  /** Optional children for header controls */
  children?: React.ReactNode;
  /** Callback to toggle side panel */
  onToggleSidePanel?: () => void;
  /** Side panel state */
  isSidePanelOpen?: boolean;
  /** Current timeframe interval */
  interval?: string;
  /** Callback to change timeframe */
  onIntervalChange?: (interval: string) => void;
}

/**
 * PriceChart
 * 
 * A high-performance financial charting component based on TradingView's lightweight-charts.
 * Handles rendering of candles, volume, technical indicators (ADX, Z-Score Bands), 
 * and overlay primitives (Signal markers, Price lines).
 * 
 * Uses 'useLightweightChart' hook for lifecycle management.
 */
const PriceChart: React.FC<PriceChartProps> = ({ 
    data, 
    signals = [], 
    levels = [],
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
  
  // Performance Tracking Refs
  const lastCandleCountRef = useRef(0);
  const lastCandleTimeRef = useRef<Time | null>(null);

  // Use Shared Hook - returns instance directly
  const chart = useLightweightChart(chartContainerRef, {
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
  const candlestickSeriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volumeSeriesRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const adxSeriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  
  // Band Series Refs
  const upper1SeriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const lower1SeriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const upper2SeriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const lower2SeriesRef = useRef<ISeriesApi<"Line"> | null>(null);

  const priceLinesRef = useRef<IPriceLine[]>([]); 
  const [hoveredData, setHoveredData] = useState<any>(null);
  const [currentAdx, setCurrentAdx] = useState<number>(0);

  // Helper to validate number (Handles null, undefined, NaN)
  const isValid = (n: number | undefined | null): boolean => typeof n === 'number' && !isNaN(n);

  // Initialize Series
  useEffect(() => {
      if (!chart) return;

      let candlestickSeries: ISeriesApi<"Candlestick">;
      let volumeSeries: ISeriesApi<"Histogram">;
      let adxSeries: ISeriesApi<"Line">;
      let upper1: ISeriesApi<"Line">;
      let lower1: ISeriesApi<"Line">;
      let upper2: ISeriesApi<"Line">;
      let lower2: ISeriesApi<"Line">;
      let crosshairHandler: MouseEventHandler<Time>;

      try {
          candlestickSeries = chart.addSeries(CandlestickSeries, {
              upColor: '#10b981',
              downColor: '#f43f5e',
              borderVisible: false,
              wickUpColor: '#10b981',
              wickDownColor: '#f43f5e',
          });

          volumeSeries = chart.addSeries(HistogramSeries, {
              color: '#26a69a',
              priceFormat: { type: 'volume' },
              priceScaleId: '', // Overlay
          });
          
          volumeSeries.priceScale().applyOptions({
              scaleMargins: { top: 0.85, bottom: 0 },
          });

          adxSeries = chart.addSeries(LineSeries, {
              color: '#a855f7', // Purple
              lineWidth: 2,
              priceScaleId: 'left',
              crosshairMarkerVisible: false,
              lastValueVisible: false,
          });

          upper2 = chart.addSeries(LineSeries, { 
              color: 'rgba(244, 63, 94, 0.6)', 
              lineWidth: 1, 
              lineStyle: LineStyle.Solid, 
              crosshairMarkerVisible: false,
              visible: !!showZScore 
          }); 
          upper1 = chart.addSeries(LineSeries, { 
              color: 'rgba(249, 115, 22, 0.5)', 
              lineWidth: 1, 
              lineStyle: LineStyle.Dashed, 
              crosshairMarkerVisible: false,
              visible: !!showZScore 
          }); 
          lower1 = chart.addSeries(LineSeries, { 
              color: 'rgba(59, 130, 246, 0.5)', 
              lineWidth: 1, 
              lineStyle: LineStyle.Dashed, 
              crosshairMarkerVisible: false,
              visible: !!showZScore 
          }); 
          lower2 = chart.addSeries(LineSeries, { 
              color: 'rgba(16, 185, 129, 0.6)', 
              lineWidth: 1, 
              lineStyle: LineStyle.Solid, 
              crosshairMarkerVisible: false,
              visible: !!showZScore 
          }); 

          candlestickSeriesRef.current = candlestickSeries;
          volumeSeriesRef.current = volumeSeries;
          adxSeriesRef.current = adxSeries;
          upper1SeriesRef.current = upper1;
          lower1SeriesRef.current = lower1;
          upper2SeriesRef.current = upper2;
          lower2SeriesRef.current = lower2;

          crosshairHandler = (param) => {
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
                      const c = candle as any;
                      // Defensive check for candle data
                      if (c && isValid(c.open) && isValid(c.close)) {
                          const volVal = volume && (volume as any).value ? (volume as any).value : 0;
                          const adxVal = adx && (adx as any).value ? (adx as any).value : 0;
                          
                          setHoveredData({
                              ...c,
                              volume: volVal,
                              adx: adxVal,
                              time: param.time
                          });
                      }
                  }
              }
          };

          chart.subscribeCrosshairMove(crosshairHandler);

      } catch (e) {
          console.error("Failed to initialize chart series:", e);
      }

      return () => {
          if (chart) {
              try {
                  if (crosshairHandler) chart.unsubscribeCrosshairMove(crosshairHandler);
                  if (candlestickSeries) chart.removeSeries(candlestickSeries);
                  if (volumeSeries) chart.removeSeries(volumeSeries);
                  if (adxSeries) chart.removeSeries(adxSeries);
                  if (upper1) chart.removeSeries(upper1);
                  if (lower1) chart.removeSeries(lower1);
                  if (upper2) chart.removeSeries(upper2);
                  if (lower2) chart.removeSeries(lower2);
              } catch (e) {
                  console.warn("Error cleaning up chart series:", e);
              }
          }
          candlestickSeriesRef.current = null;
          volumeSeriesRef.current = null;
          adxSeriesRef.current = null;
          upper1SeriesRef.current = null;
          lower1SeriesRef.current = null;
          upper2SeriesRef.current = null;
          lower2SeriesRef.current = null;
          priceLinesRef.current = [];
          setHoveredData(null);
      };

  }, [chart]); 

  // Reset tracking on symbol/interval change to force full redraw
  useEffect(() => {
    lastCandleCountRef.current = 0;
    lastCandleTimeRef.current = null;
  }, [interval]);

  // Optimized Data Update (Incremental)
  useEffect(() => {
    if (!chart || !candlestickSeriesRef.current || data.length === 0) return;

    const rafId = requestAnimationFrame(() => {
        if (!chart || !candlestickSeriesRef.current || !volumeSeriesRef.current) return;

        try {
            const currentCount = data.length;
            const lastCandle = data[data.length - 1];
            
            // Ensure data is sorted by time and valid (needed for initial load)
            const mapCandle = (d: CandleData) => ({
                time: d.time as Time,
                open: d.open,
                high: d.high,
                low: d.low,
                close: d.close
            });

            const mapVolume = (d: CandleData) => ({
                time: d.time as Time,
                value: isValid(d.volume) ? d.volume : 0,
                color: d.close > d.open ? 'rgba(16, 185, 129, 0.3)' : 'rgba(244, 63, 94, 0.3)'
            });

            // CASE 1: Reset / First Load / Backtest Jump
            if (lastCandleCountRef.current === 0 || currentCount < lastCandleCountRef.current || !lastCandleTimeRef.current) {
                performance.mark('chart-full-update-start');
                
                const validData = [...data].sort((a, b) => {
                    if (typeof a.time === 'number' && typeof b.time === 'number') return a.time - b.time;
                    return String(a.time).localeCompare(String(b.time));
                });

                const candles = validData.map(mapCandle);
                const volumes = validData.map(mapVolume);
                
                // Full Bands & ADX update
                const adxData = validData.map(d => ({ time: d.time as Time, value: isValid(d.adx) ? (d.adx || 0) : 0 }));
                const u1Data = validData.filter(d => isValid(d.zScoreUpper1)).map(d => ({ time: d.time as Time, value: d.zScoreUpper1 }));
                const l1Data = validData.filter(d => isValid(d.zScoreLower1)).map(d => ({ time: d.time as Time, value: d.zScoreLower1 }));
                
                candlestickSeriesRef.current.setData(candles);
                volumeSeriesRef.current.setData(volumes);
                adxSeriesRef.current?.setData(adxData);
                upper1SeriesRef.current?.setData(u1Data);
                lower1SeriesRef.current?.setData(l1Data);
                upper2SeriesRef.current?.setData(validData.filter(d => isValid(d.zScoreUpper2)).map(d => ({ time: d.time as Time, value: d.zScoreUpper2 })));
                lower2SeriesRef.current?.setData(validData.filter(d => isValid(d.zScoreLower2)).map(d => ({ time: d.time as Time, value: d.zScoreLower2 })));

                if (validData.length > 0) {
                   const lastAdx = validData[validData.length - 1].adx;
                   setCurrentAdx(isValid(lastAdx) ? (lastAdx || 0) : 0);
                }

                performance.mark('chart-full-update-end');
                performance.measure('chart-full-update', 'chart-full-update-start', 'chart-full-update-end');
                
                lastCandleCountRef.current = currentCount;
                lastCandleTimeRef.current = lastCandle.time as Time;
                return;
            }

            // CASE 2: New Candle Added
            if (lastCandle.time !== lastCandleTimeRef.current) {
                performance.mark('chart-new-candle-start');
                candlestickSeriesRef.current.update(mapCandle(lastCandle));
                volumeSeriesRef.current.update(mapVolume(lastCandle));
                // Update bands/indicators incrementally
                if(adxSeriesRef.current) adxSeriesRef.current.update({ time: lastCandle.time as Time, value: lastCandle.adx || 0 });
                if(upper1SeriesRef.current) upper1SeriesRef.current.update({ time: lastCandle.time as Time, value: lastCandle.zScoreUpper1 });
                if(lower1SeriesRef.current) lower1SeriesRef.current.update({ time: lastCandle.time as Time, value: lastCandle.zScoreLower1 });
                // ... Update others similarly if needed, or keep lightweight

                performance.mark('chart-new-candle-end');
                performance.measure('chart-new-candle', 'chart-new-candle-start', 'chart-new-candle-end');
                
                lastCandleTimeRef.current = lastCandle.time as Time;
                lastCandleCountRef.current = currentCount;
            } 
            // CASE 3: Existing Candle Updated (Tick)
            else {
                candlestickSeriesRef.current.update(mapCandle(lastCandle));
                volumeSeriesRef.current.update(mapVolume(lastCandle));
                lastCandleCountRef.current = currentCount;
            }

        } catch (err) {
            console.warn("Chart Data Update Error:", err);
        }
    });

    return () => cancelAnimationFrame(rafId);

  }, [data, chart]); // Keep chart as dependency, but manage updates incrementally

  useEffect(() => {
    if(!upper1SeriesRef.current || !chart) return;
    const visibility = !!showZScore; 
    try {
        upper1SeriesRef.current?.applyOptions({ visible: visibility });
        lower1SeriesRef.current?.applyOptions({ visible: visibility });
        upper2SeriesRef.current?.applyOptions({ visible: visibility });
        lower2SeriesRef.current?.applyOptions({ visible: visibility });
    } catch(e) {
        console.warn("Band visibility error", e);
    }
  }, [showZScore, chart]);

  useEffect(() => {
      if (!candlestickSeriesRef.current || !showLevels || !chart) return;

      try {
          // Clear existing price lines
          priceLinesRef.current.forEach(line => {
              try {
                 candlestickSeriesRef.current?.removePriceLine(line);
              } catch(e) {}
          });
          priceLinesRef.current = [];

          // Render levels (includes AI levels from store)
          levels.forEach(l => {
               if (!isValid(l.price)) return;
               
               let color = '#71717a'; 
               let lineStyle = LineStyle.Dashed;
               let lineWidth: 1 | 2 | 3 | 4 = 1;

               // Apply visual archetypes based on Level Type
               if (l.type === 'ENTRY') { 
                   color = '#3b82f6'; // Blue
                   lineWidth = 2; 
                   lineStyle = LineStyle.Solid; 
               }
               else if (l.type === 'STOP_LOSS') { 
                   color = '#f43f5e'; // Rose
                   lineWidth = 2; 
                   lineStyle = LineStyle.Solid; 
               }
               else if (l.type === 'TAKE_PROFIT') { 
                   color = '#10b981'; // Emerald
                   lineWidth = 2; 
                   lineStyle = LineStyle.Solid; 
               }
               else if (l.type === 'SUPPORT') {
                   color = '#10b981'; // Emerald (Support)
                   lineStyle = LineStyle.Dashed;
               }
               else if (l.type === 'RESISTANCE') {
                   color = '#f43f5e'; // Rose (Resistance)
                   lineStyle = LineStyle.Dashed;
               }
               
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
                   console.warn("Failed to create price line", e);
               }
          });
      } catch(e) {
          console.warn("Price lines error", e);
      }

  }, [levels, showLevels, chart]); 

  useEffect(() => {
    if (!candlestickSeriesRef.current || !chart) return;
    
    const series = candlestickSeriesRef.current as any;
    if (typeof series.setMarkers !== 'function') return;

    try {
        if (showSignals) {
            const markers = signals
                .filter(s => s.time && isValid(s.price))
                .map(s => ({
                    time: s.time as Time,
                    position: (s.type.includes('SHORT') || s.type.includes('EXIT')) ? 'aboveBar' as const : 'belowBar' as const,
                    color: s.type.includes('ENTRY') ? '#3b82f6' : '#f59e0b',
                    shape: (s.type.includes('SHORT') || s.type.includes('EXIT')) ? 'arrowDown' as const : 'arrowUp' as const,
                    text: s.label,
                }));
            series.setMarkers(markers);
        } else {
            series.setMarkers([]);
        }
    } catch(e) {
        console.warn("Signal markers error", e);
    }
  }, [signals, showSignals, chart]);


  return (
    <div className="w-full h-full flex flex-col relative rounded-xl overflow-hidden bg-[#18181b]/50 select-none group">
        
        {/* Header Bar - Scrollable on Mobile */}
        <div className="h-10 lg:h-12 flex items-center gap-2 px-2 border-b border-white/5 bg-white/[0.02] backdrop-blur-md z-20 shrink-0 w-full">
             <div className="flex-1 overflow-x-auto scrollbar-hide flex items-center gap-2 pr-4 min-w-0">
                 {/* Left Group */}
                 <div className="flex items-center gap-2 shrink-0">
                    <div className="flex items-center gap-2">
                        <div className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></div>
                        <span className="text-[10px] font-bold text-emerald-500 uppercase tracking-wide">BTC/USDT</span>
                    </div>

                    {/* ADX Trend Indicator - Compact on Mobile */}
                    <div className="flex items-center gap-1.5 px-2 py-0.5 bg-black/40 rounded-full border border-white/5 shrink-0">
                        {currentAdx > 25 ? (
                            <TrendingUp size={10} className={currentAdx > 50 ? "text-rose-500" : "text-emerald-500"} />
                        ) : (
                            <Minus size={10} className="text-zinc-500" />
                        )}
                        <span className={`text-[9px] font-bold uppercase hidden sm:inline ${
                            currentAdx > 50 ? "text-rose-500" : 
                            currentAdx > 25 ? "text-emerald-500" : 
                            "text-zinc-500"
                        }`}>
                            {currentAdx > 50 ? "TREND" : "RNG"}
                        </span>
                    </div>

                    {/* Timeframe Selector */}
                    {onIntervalChange && (
                        <div className="flex items-center gap-0.5 bg-black/20 p-0.5 rounded-lg border border-white/5 shrink-0">
                            {['1m', '5m', '15m', '1h', '4h'].map(tf => (
                                <button
                                    key={tf}
                                    onClick={() => onIntervalChange(tf)}
                                    className={`
                                        px-1.5 py-0.5 text-[9px] font-bold rounded-md transition-all uppercase
                                        ${interval === tf ? 'bg-brand-accent text-white shadow-sm' : 'text-zinc-500 hover:text-zinc-300 hover:bg-white/5'}
                                    `}
                                >
                                    {tf}
                                </button>
                            ))}
                        </div>
                    )}
                 </div>

                 {/* Middle Group - Controls */}
                 <div className="flex items-center gap-2 shrink-0">
                    {children}
                 </div>
             </div>

            {/* Right Group - Sticky Actions */}
            <div className="flex items-center gap-1.5 shrink-0 ml-auto bg-[#18181b] backdrop-blur-md pl-2 shadow-[-10px_0_10px_rgba(0,0,0,0.5)] md:shadow-none md:bg-transparent md:backdrop-blur-none border-l md:border-l-0 border-white/5 md:border-transparent">
                 {/* AI Scan Button */}
                {onScan && (
                    <button
                        onClick={onScan}
                        disabled={isScanning}
                        className={`
                            flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[9px] font-bold uppercase tracking-wide transition-all border
                            ${isScanning 
                                ? 'bg-purple-500/20 text-purple-400 border-purple-500/30 cursor-wait' 
                                : 'bg-brand-accent/10 text-brand-accent border-brand-accent/20 hover:bg-brand-accent hover:text-white'}
                        `}
                    >
                        {isScanning ? (
                            <Loader2 size={10} className="animate-spin" />
                        ) : (
                            <Rocket size={10} />
                        )}
                        <span className="hidden sm:inline">{isScanning ? 'SCAN' : 'AI'}</span>
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

        {/* Floating Tooltip - Responsive Position */}
        {hoveredData && (
             <div className="absolute top-2 left-2 z-50 pointer-events-none bg-[#09090b]/90 backdrop-blur-md border border-white/10 p-2 rounded-lg shadow-xl max-w-[140px] sm:max-w-none">
                 <div className="flex items-center gap-2 mb-1 border-b border-white/5 pb-1">
                     <Clock size={10} className="text-zinc-500" />
                     <span className="text-[10px] font-mono text-zinc-400">
                        {hoveredData.time && typeof hoveredData.time === 'number' 
                          ? new Date(hoveredData.time * 1000).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})
                          : '-'}
                     </span>
                 </div>
                 <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[10px] font-mono">
                     <span className="text-zinc-600">O</span>
                     <span className={hoveredData.close >= hoveredData.open ? "text-emerald-400" : "text-rose-400"}>
                         {isValid(hoveredData.open) ? hoveredData.open.toFixed(1) : '-'}
                     </span>
                     <span className="text-zinc-600">H</span>
                     <span className="text-zinc-400">{isValid(hoveredData.high) ? hoveredData.high.toFixed(1) : '-'}</span>
                     <span className="text-zinc-600">L</span>
                     <span className="text-zinc-400">{isValid(hoveredData.low) ? hoveredData.low.toFixed(1) : '-'}</span>
                     <span className="text-zinc-600">C</span>
                     <span className={hoveredData.close >= hoveredData.open ? "text-emerald-400" : "text-rose-400"}>
                         {isValid(hoveredData.close) ? hoveredData.close.toFixed(1) : '-'}
                     </span>
                     <span className="text-zinc-600">V</span>
                     <span className="text-zinc-400">{hoveredData.volume ? (hoveredData.volume/1000).toFixed(1) + 'K' : '-'}</span>
                 </div>
             </div>
        )}
        
        {/* Watermark */}
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 pointer-events-none opacity-[0.03]">
            <span className="text-7xl lg:text-9xl font-black text-white tracking-tighter">BTC</span>
        </div>
      </div>
    </div>
  );
};

export default PriceChart;