
import React, { useEffect, useRef, useState, useCallback } from 'react';
import { ISeriesApi, LineStyle, IPriceLine, CandlestickSeries, HistogramSeries, LineSeries, Time, MouseEventHandler } from 'lightweight-charts';
import { CandleData, TradeSignal, PriceLevel, LiquidityState, RegimeState, PeriodType, BotTrade, BotSettingsState } from '../types';
import { PanelRight, Rocket, Loader2, Clock, TrendingUp, Minus, Activity, X, GripVertical, ChevronDown, ChevronUp, Maximize2, Minimize2 } from 'lucide-react';
import { useLightweightChart } from '../hooks/useChart';
import { useStore } from '../store';

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
    aiScanResult?: any;
    liquidity?: LiquidityState;
    /** Regime Analysis State */
    regime?: RegimeState;
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
    /** Selected MA period type context */
    currentPeriod?: PeriodType;
    /** Bot trade history from Firestore for chart markers */
    botTrades?: BotTrade[];
    /** Live bot heartbeat data for reasoning overlay */
    botSettings?: BotSettingsState;
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
    aiScanResult,
    liquidity,
    regime,
    botTrades = [],
    botSettings,
    onScan,
    isScanning,
    showLevels = true,
    showSignals = true,
    showZScore = false,
    children,
    onToggleSidePanel,
    isSidePanelOpen,
    interval = '1m',
    onIntervalChange,
    currentPeriod = '20-PERIOD'
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
    const liquidityLinesRef = useRef<IPriceLine[]>([]); // New Ref for BOS/FVG lines

    const [hoveredData, setHoveredData] = useState<any>(null);
    const [currentAdx, setCurrentAdx] = useState<number>(0);

    // --- Draggable AI Verdict Panel State ---
    const [verdictVisible, setVerdictVisible] = useState(false);
    const [verdictCollapsed, setVerdictCollapsed] = useState(false);
    const [verdictExpanded, setVerdictExpanded] = useState(false);
    const [verdictPos, setVerdictPos] = useState({ x: 16, y: 60 });
    const dragRef = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(null);
    const verdictPanelRef = useRef<HTMLDivElement>(null);
    const prevScanResultRef = useRef<any>(null);

    // Show panel whenever a new scan result arrives
    useEffect(() => {
        if (aiScanResult && aiScanResult !== prevScanResultRef.current) {
            prevScanResultRef.current = aiScanResult;
            setVerdictVisible(true);
            setVerdictCollapsed(false);
            setVerdictExpanded(false);
            // Reset position to top-left of chart
            setVerdictPos({ x: 16, y: 60 });
        }
    }, [aiScanResult]);

    const startDrag = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
        const target = e.currentTarget;
        target.setPointerCapture(e.pointerId);
        dragRef.current = { startX: e.clientX, startY: e.clientY, origX: verdictPos.x, origY: verdictPos.y };
    }, [verdictPos]);

    const onDrag = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
        if (!dragRef.current) return;
        const dx = e.clientX - dragRef.current.startX;
        const dy = e.clientY - dragRef.current.startY;
        const container = chartContainerRef.current?.parentElement;
        const panelW = verdictPanelRef.current?.offsetWidth || 260;
        const panelH = verdictPanelRef.current?.offsetHeight || 180;
        const maxX = (container?.clientWidth || 600) - panelW - 8;
        const maxY = (container?.clientHeight || 400) - panelH - 8;
        setVerdictPos({
            x: Math.max(8, Math.min(maxX, dragRef.current.origX + dx)),
            y: Math.max(50, Math.min(maxY, dragRef.current.origY + dy)),
        });
    }, []);

    const stopDrag = useCallback((_e: React.PointerEvent<HTMLDivElement>) => {
        dragRef.current = null;
    }, []);

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
            liquidityLinesRef.current = [];
            setHoveredData(null);
        };

    }, [chart]);

    // Reset tracking on symbol/interval change to force full redraw
    useEffect(() => {
        lastCandleCountRef.current = 0;
        lastCandleTimeRef.current = null;
    }, [interval, currentPeriod]); // Trigger refresh on period change too

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
                    // Logic: Recalculate bands if period changed? For now, assume backend provides bands for default period
                    // or frontend logic inside Store handles recalculation based on period selector
                    // Here we just map what's in data.
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
                    if (adxSeriesRef.current) adxSeriesRef.current.update({ time: lastCandle.time as Time, value: lastCandle.adx || 0 });
                    if (upper1SeriesRef.current) upper1SeriesRef.current.update({ time: lastCandle.time as Time, value: lastCandle.zScoreUpper1 });
                    if (lower1SeriesRef.current) lower1SeriesRef.current.update({ time: lastCandle.time as Time, value: lastCandle.zScoreLower1 });
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
        if (!upper1SeriesRef.current || !chart) return;
        const visibility = !!showZScore;
        try {
            upper1SeriesRef.current?.applyOptions({ visible: visibility });
            lower1SeriesRef.current?.applyOptions({ visible: visibility });
            upper2SeriesRef.current?.applyOptions({ visible: visibility });
            lower2SeriesRef.current?.applyOptions({ visible: visibility });
        } catch (e) {
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
                } catch (e) { }
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
                else if (l.type === 'TACTICAL_ENTRY') {
                    color = '#f59e0b'; // Amber
                    lineWidth = 2;
                    lineStyle = LineStyle.Dotted;
                }
                else if (l.type === 'TACTICAL_STOP') {
                    color = '#f43f5e'; // Rose
                    lineWidth = 1;
                    lineStyle = LineStyle.Dotted;
                }
                else if (l.type === 'TACTICAL_TARGET') {
                    color = '#10b981'; // Emerald
                    lineWidth = 1;
                    lineStyle = LineStyle.Dotted;
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
                    if (line) priceLinesRef.current.push(line);
                } catch (e) {
                    console.warn("Failed to create price line", e);
                }
            });
        } catch (e) {
            console.warn("Price lines error", e);
        }

    }, [levels, showLevels, chart]);

    // ── Dark Print POC Lines (Institutional Key Levels) ──────────────────────
    const darkPoolStore = useStore((s: any) => s.darkPool);
    const darkPrintLinesRef = useRef<IPriceLine[]>([]);
    useEffect(() => {
        if (!candlestickSeriesRef.current || !chart || !darkPoolStore) return;

        // Clear old dark print lines
        darkPrintLinesRef.current.forEach(l => {
            try { candlestickSeriesRef.current?.removePriceLine(l); } catch (e) { }
        });
        darkPrintLinesRef.current = [];

        // Only draw significant block trades (the filtered "dark prints")
        const prints = (darkPoolStore.blockTrades || []).filter((p: any) => p.isSignificant);
        prints.slice(0, 5).forEach((p: any) => {
            try {
                const color = p.side === 'BUY' ? 'rgba(16, 185, 129, 0.7)' : 'rgba(244, 63, 94, 0.7)';
                const line = candlestickSeriesRef.current?.createPriceLine({
                    price: p.price,
                    color,
                    lineWidth: 1,
                    lineStyle: LineStyle.Dotted,
                    axisLabelVisible: true,
                    title: `⚡ Inst POC ${p.side} (${(p.priceImpactPct * 100).toFixed(3)}%)`,
                });
                if (line) darkPrintLinesRef.current.push(line);
            } catch (e) { }
        });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [darkPoolStore?.blockTrades, chart]);



    // --- Liquidity Integration: Sweeps & Lines ---
    useEffect(() => {
        if (!candlestickSeriesRef.current || !chart) return;
        const series = candlestickSeriesRef.current as any;

        try {
            // 1. Clear old Liquidity Lines (BOS/FVG)
            liquidityLinesRef.current.forEach(line => {
                try {
                    candlestickSeriesRef.current?.removePriceLine(line);
                } catch (e) { }
            });
            liquidityLinesRef.current = [];

            // 2. Render Markers (Signals + Sweeps)
            let markers: any[] = [];

            // Add standard signals
            if (showSignals) {
                markers = markers.concat(signals
                    .filter(s => s.time && isValid(s.price))
                    .map(s => ({
                        time: s.time as Time,
                        position: (s.type.includes('SHORT') || s.type.includes('EXIT')) ? 'aboveBar' : 'belowBar',
                        color: s.type.includes('ENTRY') ? '#3b82f6' : '#f59e0b',
                        shape: (s.type.includes('SHORT') || s.type.includes('EXIT')) ? 'arrowDown' : 'arrowUp',
                        text: s.label,
                    }))
                );
            }

            // Add Sweep Markers
            if (liquidity && liquidity.sweeps.length > 0) {
                markers = markers.concat(liquidity.sweeps.map(s => ({
                    time: s.candleTime as Time,
                    position: s.side === 'BUY' ? 'aboveBar' : 'belowBar',
                    color: s.side === 'BUY' ? '#e11d48' : '#059669',
                    shape: s.side === 'BUY' ? 'arrowDown' : 'arrowUp',
                    text: 'SWEEP',
                    size: 2
                })));
            }

            // Add Bot Trade Markers (win/loss entries + reasoning)
            if (botTrades && botTrades.length > 0) {
                const tradeMarkers = botTrades
                    .filter(t => t.entry_price > 0 && t.ts_ms > 0)
                    .map(t => {
                        const isWin = t.result === 'WIN';
                        const isOpen = !t.result;
                        const entryTime = (t.ts_ms / 1000) as Time;
                        const verdictShort = (t.verdict || '').substring(0, 12);
                        return {
                            time: entryTime,
                            position: t.side === 'buy' ? 'belowBar' : 'aboveBar',
                            color: isOpen ? '#f59e0b' : isWin ? '#22c55e' : '#ef4444',
                            shape: t.side === 'buy' ? 'arrowUp' : 'arrowDown',
                            text: `${isOpen ? '▶' : isWin ? '✓' : '✗'} ${verdictShort}`,
                            size: isOpen ? 2 : 3,
                        };
                    });
                markers = markers.concat(tradeMarkers);
            }

            if (typeof series.setMarkers === 'function') {
                series.setMarkers(markers.sort((a: any, b: any) => (a.time as number) - (b.time as number)));
            }

            // 3. Render Liquidity Lines (BOS)
            // LIMIT: Only show last 2 BOS events to keep chart clean
            if (liquidity && liquidity.bos.length > 0) {
                liquidity.bos.slice(0, 2).forEach(b => {
                    const line = candlestickSeriesRef.current?.createPriceLine({
                        price: b.price,
                        color: b.direction === 'BULLISH' ? 'rgba(16, 185, 129, 0.5)' : 'rgba(244, 63, 94, 0.5)',
                        lineWidth: 1,
                        lineStyle: LineStyle.Solid,
                        axisLabelVisible: false,
                        title: 'BOS',
                    });
                    if (line) liquidityLinesRef.current.push(line);
                });

                // Optional: Render FVG bounds as dashed lines (Last 2 only)
                liquidity.fvg.slice(0, 2).forEach(f => {
                    const startLine = candlestickSeriesRef.current?.createPriceLine({
                        price: f.startPrice,
                        color: 'rgba(245, 158, 11, 0.4)', // Amber low opacity
                        lineWidth: 1,
                        lineStyle: LineStyle.Dotted,
                        axisLabelVisible: false,
                        title: '', // Minimal title
                    });
                    const endLine = candlestickSeriesRef.current?.createPriceLine({
                        price: f.endPrice,
                        color: 'rgba(245, 158, 11, 0.4)',
                        lineWidth: 1,
                        lineStyle: LineStyle.Dotted,
                        axisLabelVisible: false,
                        title: 'FVG',
                    });
                    if (startLine) liquidityLinesRef.current.push(startLine);
                    if (endLine) liquidityLinesRef.current.push(endLine);
                });
            }

        } catch (e) {
            console.warn("Liquidity markers error", e);
        }
    }, [signals, showSignals, chart, liquidity]);

    // Determine Regime Color for Indicator
    let regimeColor = "text-zinc-500";
    let regimeLabel = "UNCERTAIN";
    if (regime) {
        if (regime.regimeType === 'TRENDING') {
            if (regime.trendDirection === 'BULL') {
                regimeColor = "text-emerald-500";
                regimeLabel = "BULL TREND";
            } else {
                regimeColor = "text-rose-500";
                regimeLabel = "BEAR TREND";
            }
        } else if (regime.regimeType === 'EXPANDING') {
            regimeColor = "text-blue-500";
            regimeLabel = "EXPANSION";
        } else if (regime.regimeType === 'COMPRESSING') {
            regimeColor = "text-zinc-300";
            regimeLabel = "SQUEEZE";
        } else if (regime.regimeType === 'RANGING') {
            regimeColor = "text-amber-500";
            regimeLabel = "RANGE";
        }
    }

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
                            <span className={`text-[9px] font-bold uppercase hidden sm:inline ${currentAdx > 50 ? "text-rose-500" :
                                currentAdx > 25 ? "text-emerald-500" :
                                    "text-zinc-500"
                                }`}>
                                {currentAdx > 50 ? "TREND" : "RNG"}
                            </span>
                        </div>

                        {/* Regime Indicator */}
                        {regime && (
                            <div className="flex items-center gap-1.5 px-2 py-0.5 bg-black/40 rounded-full border border-white/5 shrink-0 hidden sm:flex">
                                <Activity size={10} className={regimeColor} />
                                <span className={`text-[9px] font-bold uppercase ${regimeColor}`}>
                                    {regimeLabel}
                                </span>
                            </div>
                        )}

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
                                    ? new Date(hoveredData.time * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
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
                            <span className="text-zinc-400">{hoveredData.volume ? (hoveredData.volume / 1000).toFixed(1) + 'K' : '-'}</span>
                        </div>
                        {/* Show Active Period Context in Tooltip */}
                        <div className="mt-1 pt-1 border-t border-white/5 text-[9px] text-zinc-600 font-mono text-right">
                            MA: {currentPeriod}
                        </div>
                    </div>
                )}

                {/* Watermark */}
                <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 pointer-events-none opacity-[0.03]">
                    <span className="text-7xl lg:text-9xl font-black text-white tracking-tighter">BTC</span>
                </div>

                {/* === Draggable AI Verdict Overlay === */}
                {aiScanResult && verdictVisible && (() => {
                    const v = aiScanResult.verdict?.toUpperCase() ?? '';
                    const isEntry = v === 'ENTRY' || v === 'LONG';
                    const isExit = v === 'EXIT' || v === 'SHORT';
                    const accentColor = isEntry ? 'text-emerald-400 border-emerald-500/30' : isExit ? 'text-rose-400 border-rose-500/30' : 'text-amber-400 border-amber-500/30';
                    const accentBg = isEntry ? 'bg-emerald-500/10' : isExit ? 'bg-rose-500/10' : 'bg-amber-500/10';
                    const dotColor = isEntry ? 'bg-emerald-500' : isExit ? 'bg-rose-500' : 'bg-amber-500';
                    const glow = isEntry ? 'shadow-[0_0_20px_rgba(16,185,129,0.15)]' : isExit ? 'shadow-[0_0_20px_rgba(244,63,94,0.15)]' : 'shadow-[0_0_20px_rgba(245,158,11,0.15)]';
                    return (
                        <div
                            ref={verdictPanelRef}
                            style={{ left: verdictPos.x, top: verdictPos.y, width: verdictExpanded ? 340 : 260, zIndex: 60 }}
                            className={`absolute select-none rounded-xl border border-white/10 bg-[#0a0a0f]/95 backdrop-blur-xl ${glow} flex flex-col overflow-hidden`}
                        >
                            {/* Drag Handle / Header */}
                            <div
                                onPointerDown={startDrag}
                                onPointerMove={onDrag}
                                onPointerUp={stopDrag}
                                style={{ touchAction: 'none', cursor: 'grab' }}
                                className="flex items-center gap-2 px-2 py-1.5 bg-white/[0.04] border-b border-white/5 shrink-0"
                            >
                                <GripVertical size={12} className="text-zinc-600 shrink-0" />
                                <div className={`w-1.5 h-1.5 rounded-full ${dotColor} animate-pulse shrink-0`} />
                                <span className="text-[10px] font-black uppercase tracking-widest text-zinc-400 flex-1 truncate">AI VERDICT</span>
                                <button onClick={() => setVerdictExpanded(p => !p)} className="p-0.5 rounded text-zinc-500 hover:text-zinc-200 transition-colors">
                                    {verdictExpanded ? <Minimize2 size={11} /> : <Maximize2 size={11} />}
                                </button>
                                <button onClick={() => setVerdictCollapsed(p => !p)} className="p-0.5 rounded text-zinc-500 hover:text-zinc-200 transition-colors">
                                    {verdictCollapsed ? <ChevronDown size={11} /> : <ChevronUp size={11} />}
                                </button>
                                <button onClick={() => setVerdictVisible(false)} className="p-0.5 rounded text-zinc-500 hover:text-rose-400 transition-colors">
                                    <X size={11} />
                                </button>
                            </div>

                            {/* Body */}
                            {!verdictCollapsed && (
                                <div className="overflow-y-auto p-3 space-y-2" style={{ maxHeight: verdictExpanded ? 480 : 220 }}>
                                    {/* Verdict badge + confidence */}
                                    <div className="flex items-center gap-2">
                                        <span className={`px-2 py-0.5 rounded-full text-[10px] font-black uppercase tracking-widest border ${accentColor} ${accentBg}`}>
                                            {aiScanResult.verdict}
                                        </span>
                                        {aiScanResult.confidence != null && (
                                            <span className="text-[10px] font-mono text-zinc-400 ml-auto">
                                                {(aiScanResult.confidence * 100).toFixed(0)}% conf
                                            </span>
                                        )}
                                    </div>

                                    {/* Analysis text - scrollable */}
                                    {aiScanResult.analysis && (
                                        <p className="text-[10px] text-zinc-300 leading-relaxed italic border-l-2 border-white/10 pl-2">
                                            {aiScanResult.analysis}
                                        </p>
                                    )}

                                    {/* R:R + Levels */}
                                    {(aiScanResult.risk_reward_ratio || aiScanResult.entry_price || aiScanResult.support) && (
                                        <div className="space-y-1 pt-1 border-t border-white/5">
                                            {aiScanResult.risk_reward_ratio && (
                                                <div className="flex justify-between text-[10px]">
                                                    <span className="text-zinc-500">R:R Ratio</span>
                                                    <span className={`font-mono font-bold ${aiScanResult.risk_reward_ratio >= 2 ? 'text-emerald-400' : 'text-rose-400'}`}>
                                                        {aiScanResult.risk_reward_ratio.toFixed(2)}
                                                    </span>
                                                </div>
                                            )}
                                            {aiScanResult.entry_price && (
                                                <div className="flex justify-between text-[10px]">
                                                    <span className="text-zinc-500">Entry</span>
                                                    <span className="font-mono text-zinc-200">{Number(aiScanResult.entry_price).toFixed(1)}</span>
                                                </div>
                                            )}
                                            {aiScanResult.stop_loss && (
                                                <div className="flex justify-between text-[10px]">
                                                    <span className="text-zinc-500">Stop</span>
                                                    <span className="font-mono text-rose-400">{Number(aiScanResult.stop_loss).toFixed(1)}</span>
                                                </div>
                                            )}
                                            {aiScanResult.take_profit && (
                                                <div className="flex justify-between text-[10px]">
                                                    <span className="text-zinc-500">Target</span>
                                                    <span className="font-mono text-emerald-400">{Number(aiScanResult.take_profit).toFixed(1)}</span>
                                                </div>
                                            )}
                                            {aiScanResult.support && (
                                                <div className="flex justify-between text-[10px]">
                                                    <span className="text-zinc-500">Support</span>
                                                    <span className="font-mono text-zinc-400">{Number(aiScanResult.support).toFixed(1)}</span>
                                                </div>
                                            )}
                                            {aiScanResult.resistance && (
                                                <div className="flex justify-between text-[10px]">
                                                    <span className="text-zinc-500">Resistance</span>
                                                    <span className="font-mono text-zinc-400">{Number(aiScanResult.resistance).toFixed(1)}</span>
                                                </div>
                                            )}
                                        </div>
                                    )}
                                </div>
                            )}
                        </div>
                    );
                })()}

                {/* Bot Reasoning Bar — live bot mind overlay */}
                {botSettings && (
                    <div className="absolute bottom-0 left-0 right-0 bg-[#0d1117]/95 border-t border-[#21262d] px-3 py-1.5 z-20">
                        <div className="flex items-center gap-3 text-[10px] font-mono">
                            <span className={`w-1.5 h-1.5 rounded-full ${botSettings.status === 'ONLINE' ? 'bg-green-400 animate-pulse' : 'bg-red-500'}`} />
                            <span className="text-[#8b949e]">
                                Z={botSettings.currentZScore?.toFixed?.(2) ?? '—'}
                                {' '}R={botSettings.currentRegime || '—'}
                                {' '}B={(botSettings.currentBayes ? botSettings.currentBayes * 100 : 0).toFixed(0)}%
                            </span>
                            <span className="text-[#8b949e]">
                                OIZ={botSettings.oiZScore?.toFixed?.(1) ?? '—'}
                                {' '}Δ={(botSettings.oiDelta5mPct ?? 0) >= 0 ? '+' : ''}{(botSettings.oiDelta5mPct ?? 0).toFixed(1)}%
                                {' '}{(botSettings.oiUsdM ?? 0).toFixed(0)}M
                            </span>
                            <span className={`px-1 py-0.5 rounded text-[9px] font-bold ${
                                (botSettings.priceOIRegime || '').includes('LONG_BUILD') ? 'text-green-400' :
                                (botSettings.priceOIRegime || '').includes('SHORT_BUILD') ? 'text-red-400' :
                                (botSettings.priceOIRegime || '').includes('COVERING') ? 'text-blue-400' :
                                (botSettings.priceOIRegime || '').includes('LIQUIDATION') ? 'text-rose-400' :
                                'text-[#484f58]'
                            }`}>
                                {botSettings.priceOIRegime || 'OI—'}
                            </span>
                            <span className="text-[#58a6ff] truncate flex-1">
                                {botSettings.lastAnalysis || '—'}
                            </span>
                            <span className="text-[#484f58]">
                                {botSettings.totalTrades || 0}t | ${(botSettings.globalSessionPnl || 0).toFixed(2)}
                            </span>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
};

export default PriceChart;
