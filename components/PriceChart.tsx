import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { CandleData, TradeSignal, PriceLevel, LiquidityState, RegimeState, PeriodType, BotTrade, BotSettingsState } from '../types';
import { PanelRight, Rocket, Loader2, Clock, X, GripVertical, ChevronDown, ChevronUp, Maximize2, Minimize2, Bot } from 'lucide-react';
import { useLightweightChart } from '../hooks/useChart';

interface PriceChartProps {
    data: CandleData[];
    signals?: TradeSignal[];
    levels?: PriceLevel[];
    aiScanResult?: any;
    liquidity?: LiquidityState;
    regime?: RegimeState;
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
    currentPeriod?: PeriodType;
    botTrades?: BotTrade[];
    botSettings?: BotSettingsState;
}

const TEXT_MUTED = '#71717a';
const TEXT_DIM = '#8b949e';
const BORDER_COLOR = 'rgba(255,255,255,0.06)';
const GRID_COLOR = 'rgba(255,255,255,0.04)';
const UP_COLOR = '#10b981';
const DOWN_COLOR = '#f43f5e';
const UP_VOL = 'rgba(16,185,129,0.35)';
const DOWN_VOL = 'rgba(244,63,94,0.30)';

const isValid = (n: number | undefined | null): boolean => typeof n === 'number' && !isNaN(n);

const PriceChart: React.FC<PriceChartProps> = ({
    data,
    signals = [],
    levels = [],
    aiScanResult,
    liquidity,
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
    const chart = useLightweightChart(chartContainerRef);
    const prevDataLenRef = useRef(0);

    // Verdict panel state
    const [verdictVisible, setVerdictVisible] = useState(false);
    const [verdictCollapsed, setVerdictCollapsed] = useState(false);
    const [verdictExpanded, setVerdictExpanded] = useState(false);
    const [verdictPos, setVerdictPos] = useState({ x: 16, y: 60 });
    const dragRef = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(null);
    const verdictPanelRef = useRef<HTMLDivElement>(null);
    const prevScanResultRef = useRef<any>(null);

    const [hoveredData, setHoveredData] = useState<any>(null);

    useEffect(() => {
        if (aiScanResult && aiScanResult !== prevScanResultRef.current) {
            prevScanResultRef.current = aiScanResult;
            setVerdictVisible(true);
            setVerdictCollapsed(false);
            setVerdictExpanded(false);
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

    const stopDrag = useCallback(() => { dragRef.current = null; }, []);

    // ECharts option builder
    useEffect(() => {
        if (!chart || data.length === 0) return;

        const tsData = data.map(c => [c.time * 1000, c.open, c.close, c.low, c.high] as [number, number, number, number, number]);
        const volData = data.map(c => [c.time * 1000, c.volume, c.close >= c.open ? 1 : -1] as [number, number, number]);

        const series: any[] = [
            {
                name: 'Price',
                type: 'candlestick',
                xAxisIndex: 0,
                yAxisIndex: 0,
                data: tsData,
                itemStyle: {
                    color: UP_COLOR,
                    color0: DOWN_COLOR,
                    borderColor: UP_COLOR,
                    borderColor0: DOWN_COLOR,
                },
                markPoint: {
                    data: [] as any[],
                    symbol: 'pin',
                    symbolSize: 42,
                    label: { show: true, fontSize: 9, color: '#e4e4e7', distance: 8, fontWeight: 'bold' },
                    emphasis: { label: { fontSize: 12, fontWeight: 'bold' }, itemStyle: { shadowBlur: 10, shadowColor: 'rgba(0,0,0,0.5)' } },
                },
                markLine: {
                    silent: true,
                    symbol: 'none',
                    data: [] as any[],
                    lineStyle: { type: 'dashed', width: 1 },
                },
            },
            {
                name: 'Volume',
                type: 'bar',
                xAxisIndex: 1,
                yAxisIndex: 1,
                data: volData,
                itemStyle: {
                    color: (p: any) => (p.data?.[2] ?? 0) >= 0 ? UP_VOL : DOWN_VOL,
                },
            },
        ];

        // Z-Score bands
        if (showZScore) {
            const bandOpts: Array<{ field: keyof CandleData; color: string; dash: boolean }> = [
                { field: 'zScoreUpper2', color: 'rgba(244,63,94,0.5)', dash: false },
                { field: 'zScoreUpper1', color: 'rgba(249,115,22,0.4)', dash: true },
                { field: 'zScoreLower1', color: 'rgba(59,130,246,0.4)', dash: true },
                { field: 'zScoreLower2', color: 'rgba(16,185,129,0.5)', dash: false },
            ];
            for (const b of bandOpts) {
                const lineData = data
                    .filter(c => isValid(c[b.field]) && (c[b.field] as number) > 0)
                    .map(c => [c.time * 1000, c[b.field] as number]);
                if (lineData.length > 0) {
                    series.push({
                        type: 'line',
                        xAxisIndex: 0,
                        yAxisIndex: 0,
                        data: lineData,
                        showSymbol: false,
                        lineStyle: { color: b.color, width: 1, type: b.dash ? 'dashed' : 'solid' },
                        silent: true,
                    });
                }
            }
        }

        // ADX
        const adxData = data.filter(c => isValid(c.adx)).map(c => [c.time * 1000, c.adx ?? 0]);
        if (adxData.length > 0) {
            series.push({
                type: 'line',
                xAxisIndex: 0,
                yAxisIndex: 2,
                data: adxData,
                showSymbol: false,
                lineStyle: { color: '#a855f7', width: 1.5 },
                silent: true,
            });
        }

        // Signals
        if (showSignals && signals.length > 0) {
            const markData = signals
                .filter(s => isValid(s.price) && (typeof s.time === 'number' ? s.time > 0 : !!s.time))
                .map(s => {
                    const signalTime = typeof s.time === 'number' ? s.time * 1000 : new Date(s.time).getTime();
                    const isBuy = s.type === 'ENTRY_LONG';
                    const isExit = s.type === 'EXIT_PROFIT' || s.type === 'EXIT_LOSS';
                    return {
                        name: s.type,
                        coord: [signalTime, s.price],
                        value: s.type,
                        symbol: isExit ? 'arrow' : 'triangle',
                        symbolRotate: s.type === 'ENTRY_SHORT' || s.type === 'EXIT_LOSS' ? 180 : 0,
                        itemStyle: {
                            color: isBuy || s.type === 'EXIT_PROFIT' ? UP_COLOR : DOWN_COLOR,
                        },
                        label: {
                            show: true,
                            formatter: s.label?.substring(0, 4) || s.type.substring(0, 4),
                            fontSize: 8,
                            color: '#e4e4e7',
                            distance: 6,
                        },
                    };
                });
            series[0].markPoint.data.push(...markData);
        }

        // Price levels
        if (showLevels && levels.length > 0 && series[0]?.markLine) {
            const levelLines = levels
                .filter(l => isValid(l.price))
                .map(l => ({
                    yAxis: l.price,
                    name: l.type,
                    label: { show: true, formatter: l.type, fontSize: 9, color: '#e4e4e7' },
                    lineStyle: {
                        color: l.type === 'ENTRY' ? '#3b82f6' :
                               l.type === 'STOP_LOSS' ? '#f43f5e' :
                               l.type === 'TAKE_PROFIT' ? '#10b981' :
                               l.type === 'SUPPORT' ? '#10b981' :
                               l.type === 'RESISTANCE' ? '#f43f5e' : '#71717a',
                        width: l.type === 'ENTRY' || l.type === 'STOP_LOSS' || l.type === 'TAKE_PROFIT' ? 2 : 1,
                        type: l.type?.includes('TACTICAL') ? 'dotted' : 'dashed',
                    },
                }));
            series[0].markLine.data.push(...levelLines);
        }

        // Liquidity sweeps
        if (liquidity && liquidity.sweeps.length > 0) {
            const sweepMarks = liquidity.sweeps
                .map(s => {
                    const st = typeof s.candleTime === 'number' ? s.candleTime : new Date(s.candleTime).getTime() / 1000;
                    const matchCandle = data.find(c => Math.abs(c.time - st) < 1);
                    const sweepPrice = s.price || (matchCandle?.close ?? 0);
                    if (sweepPrice <= 0) return null;
                    return {
                        name: 'SWEEP',
                        coord: [st * 1000, sweepPrice],
                        symbol: 'arrow',
                        symbolRotate: s.side === 'BUY' ? 0 : 180,
                        symbolSize: 10,
                        itemStyle: { color: s.side === 'BUY' ? '#059669' : '#e11d48' },
                    };
                })
                .filter(Boolean) as any[];
            series[0].markPoint.data.push(...sweepMarks);
        }

        // Bot trade markers
        if (botTrades && botTrades.length > 0) {
            const tradeMarks = botTrades
                .filter(t => t.entry_price > 0 && t.ts_ms > 0)
                .map(t => {
                    const isWin = t.result === 'WIN';
                    const isOpen = !t.result;
                    return {
                        name: t.verdict || 'trade',
                        coord: [t.ts_ms, t.entry_price],
                        symbol: 'circle',
                        symbolSize: 10,
                        itemStyle: { color: isOpen ? '#f59e0b' : isWin ? UP_COLOR : DOWN_COLOR },
                        label: {
                            show: true,
                            formatter: isOpen ? '▶' : isWin ? '✓' : '✗',
                            fontSize: 8,
                            color: '#e4e4e7',
                            position: 'top',
                            distance: 3,
                        },
                    };
                });
            series[0].markPoint.data.push(...tradeMarks);
        }

        // BOS / FVG from liquidity
        if (liquidity) {
            const bosMarks: any[] = [];
            for (const b of (liquidity.bos || [])) {
                const bt = typeof b.candleTime === 'number' ? b.candleTime : new Date(b.candleTime).getTime() / 1000;
                bosMarks.push({
                    name: 'BOS',
                    coord: [bt * 1000, b.price],
                    symbol: 'triangle',
                    symbolRotate: b.direction === 'BULLISH' ? 0 : 180,
                    symbolSize: 8,
                    itemStyle: { color: b.direction === 'BULLISH' ? '#10b981' : '#f43f5e' },
                });
            }
            series[0].markPoint.data.push(...bosMarks);
        }

        const option: any = {
            backgroundColor: 'transparent',
            animation: data.length < 50,
            dataZoom: [
                {
                    type: 'inside',
                    xAxisIndex: [0, 1],
                    start: data.length > 60 ? 50 : 0,
                    end: 100,
                    zoomOnMouseWheel: true,
                    moveOnMouseMove: true,
                    moveOnMouseWheel: false,
                },
                {
                    type: 'slider',
                    xAxisIndex: [0, 1],
                    start: data.length > 60 ? 50 : 0,
                    end: 100,
                    height: 18,
                    bottom: 6,
                    borderColor: 'rgba(255,255,255,0.06)',
                    fillerColor: 'rgba(59,130,246,0.1)',
                    handleStyle: { color: '#3b82f6' },
                    textStyle: { color: '#71717a', fontSize: 8 },
                },
            ],
            tooltip: {
                trigger: 'axis',
                axisPointer: { type: 'cross' },
                backgroundColor: 'rgba(9,9,11,0.95)',
                borderColor: BORDER_COLOR,
                borderWidth: 1,
                textStyle: { color: '#e4e4e7', fontFamily: 'JetBrains Mono', fontSize: 10 },
                formatter: (params: any[]) => {
                    if (!params || !params[0]) return '';
                    const p = params[0];
                    const values = p.data ?? p.value ?? [];
                    const t = values[0] ? new Date(values[0]).toLocaleString() : '';
                    const o = values[1]?.toFixed(2) ?? '—';
                    const c = values[2]?.toFixed(2) ?? '—';
                    const l = values[3]?.toFixed(2) ?? '—';
                    const h = values[4]?.toFixed(2) ?? '—';
                    const vol = params.find(x => x.seriesName === 'Volume')?.data?.[1];
                    const z = botSettings?.currentZScore?.toFixed(2) ?? '—';
                    const regime = botSettings?.currentRegime || '—';
                    const b = ((botSettings?.currentBayes ?? 0.5) * 100).toFixed(0);
                    const oiZ = botSettings?.oiZScore?.toFixed(1) ?? '—';
                    const oiD = (botSettings?.oiDelta5mPct ?? 0).toFixed(2);
                    const sig = botSettings?.lastSignal || 'WAIT';
                    return [
                        `<span style="color:${TEXT_DIM}">${t}</span>`,
                        `<span style="color:#e4e4e7;font-weight:bold">O <span style="color:${TEXT_DIM}">${o}</span>  H <span style="color:#e4e4e7">${h}</span>  L <span style="color:#e4e4e7">${l}</span>  C <span style="color:${c >= o ? UP_COLOR : DOWN_COLOR};font-weight:bold">${c}</span></span>`,
                        vol != null ? `<span style="color:${TEXT_DIM}">Vol ${(vol / 1000).toFixed(1)}K</span>` : '',
                        `<span style="color:#484f58;font-size:9px">${regime} · Z ${z} · B ${b}% · OIZ ${oiZ} · Δ${oiD}% · ${sig}</span>`,
                    ].filter(Boolean).join('<br/>');
                },
            },
            grid: [
                { left: 8, right: 12, top: 16, bottom: 36, height: '55%' },
                { left: 8, right: 12, top: '68%', height: '14%' },
            ],
            graphic: (() => {
                const g: any[] = [];
                const lastC = data[data.length - 1];
                const firstC = data[0];
                const price = lastC?.close ?? 0;
                const change = firstC?.close ? ((price - firstC.close) / firstC.close * 100) : 0;
                const z = botSettings?.currentZScore ?? 0;
                const b = (botSettings?.currentBayes ?? 0.5) * 100;
                const regime = botSettings?.currentRegime || '';
                const signal = botSettings?.lastSignal || 'WAIT';
                const isBuySignal = signal.includes('BUY') || signal.includes('LONG');
                const isSellSignal = signal.includes('SELL') || signal.includes('SHORT');
                const pnl = botSettings?.globalSessionPnl ?? 0;

                const rectStyle = (w: number, h: number, bg: string) => ({
                    type: 'rect' as const,
                    shape: { x: 0, y: 0, width: w, height: h },
                    style: { fill: bg, stroke: 'rgba(255,255,255,0.08)', lineWidth: 1 },
                });

                const txt = (x: number, y: number, text: string, color: string, font: string) => ({
                    type: 'text' as const,
                    left: x, top: y,
                    style: { text, fill: color, font },
                });

                const L = 8;
                const W = 118;

                // Price badge
                g.push({
                    type: 'group', left: L, top: 8,
                    children: [
                        rectStyle(W, 52, 'rgba(9,9,11,0.88)'),
                        txt(8, 4, price.toFixed(1), '#e4e4e7', 'bold 13px "JetBrains Mono"'),
                        txt(8, 22, `${change >= 0 ? '+' : ''}${change.toFixed(2)}%`, change >= 0 ? UP_COLOR : DOWN_COLOR, 'bold 10px "JetBrains Mono"'),
                        txt(8, 36, `ATR ${((botSettings?.currentATR || 0) * 100).toFixed(2)}%`, TEXT_DIM, '9px "JetBrains Mono"'),
                    ],
                });

                // Bot bias
                const biasColor = isBuySignal ? UP_COLOR : isSellSignal ? DOWN_COLOR : '#f59e0b';
                g.push({
                    type: 'group', left: L, top: 64,
                    children: [
                        rectStyle(W, 64, 'rgba(9,9,11,0.88)'),
                        txt(8, 4, regime || 'REGIME', '#e4e4e7', 'bold 10px "JetBrains Mono"'),
                        txt(8, 20, `Z ${z >= 0 ? '+' : ''}${z.toFixed(2)}  B ${b.toFixed(0)}%`, Math.abs(z) > 1.5 ? DOWN_COLOR : Math.abs(z) > 1.0 ? '#f59e0b' : UP_COLOR, 'bold 9px "JetBrains Mono"'),
                        txt(8, 36, signal, biasColor, 'bold 9px "JetBrains Mono"'),
                        txt(8, 50, `PnL ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}`, pnl >= 0 ? UP_COLOR : DOWN_COLOR, '9px "JetBrains Mono"'),
                    ],
                });

                // OI panel — right side
                const oiD = botSettings?.oiDelta5mPct ?? 0;
                const oiZ = botSettings?.oiZScore ?? 0;
                const oiRegime = (botSettings?.priceOIRegime || '').replace(/_/g, ' ');
                const R = 8;
                const RW = 110;
                g.push({
                    type: 'group', right: R, top: 8,
                    children: [
                        rectStyle(RW, 44, 'rgba(9,9,11,0.88)'),
                        txt(8, 5, 'OI FLOW', TEXT_DIM, 'bold 8px "JetBrains Mono"'),
                        txt(8, 18, `Z ${oiZ >= 0 ? '+' : ''}${oiZ.toFixed(1)}  Δ${oiD >= 0 ? '+' : ''}${oiD.toFixed(1)}%`, Math.abs(oiD) > 1 ? '#f59e0b' : TEXT_DIM, '9px "JetBrains Mono"'),
                        txt(8, 31, oiRegime || '—', (oiRegime || '').includes('LONG_BUILD') ? UP_COLOR : (oiRegime || '').includes('SHORT_BUILD') ? DOWN_COLOR : TEXT_DIM, '8px "JetBrains Mono"'),
                    ],
                });

                // Risk badge
                const oiRisk = (botSettings?.oiRiskLabel || '').replace(/_/g, ' ');
                if (oiRisk && oiRisk !== 'UNKNOWN') {
                    const riskBg = oiRisk === 'EXTREME_RISK' ? 'rgba(244,63,94,0.2)' : oiRisk === 'ELEVATED_RISK' ? 'rgba(245,158,11,0.2)' : 'rgba(59,130,246,0.15)';
                    g.push({
                        type: 'group', right: R, top: 56,
                        children: [
                            { type: 'rect' as const, shape: { x: 0, y: 0, width: RW, height: 22 }, style: { fill: riskBg, stroke: oiRisk === 'EXTREME_RISK' ? 'rgba(244,63,94,0.4)' : 'rgba(245,158,11,0.25)', lineWidth: 1 } },
                            txt(8, 5, `⚡ ${oiRisk}`, oiRisk === 'EXTREME_RISK' ? DOWN_COLOR : '#f59e0b', 'bold 9px "JetBrains Mono"'),
                        ],
                    });
                }

                // Gate stats
                const gateStats = botSettings?.gateStats ?? {};
                const gateEntries = Object.entries(gateStats)
                    .filter(([, v]) => v > 0)
                    .sort(([, a], [, b]) => b - a)
                    .slice(0, 5);
                if (gateEntries.length > 0) {
                    const totalRejections = gateEntries.reduce((s, [, v]) => s + v, 0);
                    const gateTop = (oiRisk && oiRisk !== 'UNKNOWN') ? 82 : 56;
                    const gateCh: any[] = [
                        { type: 'rect' as const, shape: { x: 0, y: 0, width: RW, height: 14 + gateEntries.length * 13 }, style: { fill: 'rgba(9,9,11,0.88)', stroke: 'rgba(255,255,255,0.08)', lineWidth: 1 } },
                        txt(8, 4, `GATES · ${totalRejections}`, '#484f58', 'bold 7px "JetBrains Mono"'),
                    ];
                    gateEntries.forEach(([name, count], i) => {
                        gateCh.push(txt(8, 14 + i * 13, `${name.replace(/_/g, ' ')}  ${count}`, '#8b949e', '7px "JetBrains Mono"'));
                    });
                    g.push({ type: 'group', right: R, top: gateTop, children: gateCh });
                }

                return g;
            })(),
            xAxis: [
                {
                    type: 'time',
                    gridIndex: 0,
                    axisLine: { lineStyle: { color: BORDER_COLOR } },
                    axisTick: { show: false },
                    axisLabel: { color: TEXT_MUTED, fontSize: 9, fontFamily: 'JetBrains Mono' },
                    splitLine: { show: false },
                },
                {
                    type: 'time',
                    gridIndex: 1,
                    show: false,
                },
            ],
            yAxis: [
                {
                    type: 'value',
                    gridIndex: 0,
                    position: 'right',
                    axisLine: { show: false },
                    axisTick: { show: false },
                    axisLabel: { color: TEXT_MUTED, fontSize: 9, fontFamily: 'JetBrains Mono' },
                    splitLine: { lineStyle: { color: GRID_COLOR } },
                    scale: true,
                },
                {
                    type: 'value',
                    gridIndex: 1,
                    axisLine: { show: false },
                    axisTick: { show: false },
                    axisLabel: { color: TEXT_MUTED, fontSize: 8, fontFamily: 'JetBrains Mono', formatter: (v: number) => v > 1000 ? (v / 1000).toFixed(0) + 'K' : v },
                    splitLine: { show: false },
                },
                {
                    type: 'value',
                    gridIndex: 0,
                    show: false,
                    min: 0,
                    max: 100,
                },
            ],
            series,
        };

        // Only full replace if data array changed significantly, else merge
        const isFullReplace = data.length !== prevDataLenRef.current;
        prevDataLenRef.current = data.length;
        chart.setOption(option, { notMerge: !isFullReplace });

        // Tooltip listener
        const onMouseOver = (params: any) => {
            if (params.componentType === 'series' && params.seriesName === 'Price') {
                const vals = params.data ?? params.value ?? [];
                if (vals && vals.length >= 5) {
                    setHoveredData({
                        time: vals[0] / 1000,
                        open: vals[1],
                        close: vals[2],
                        low: vals[3],
                        high: vals[4],
                    });
                }
            }
        };
        const onMouseOut = () => setHoveredData(null);

        chart.on('mouseover', onMouseOver);
        chart.on('mouseout', onMouseOut);
        chart.on('globalout', onMouseOut);

        return () => {
            chart.off('mouseover', onMouseOver);
            chart.off('mouseout', onMouseOut);
            chart.off('globalout', onMouseOut);
        };
    }, [chart, data, showZScore, showSignals, showLevels, signals, levels, liquidity, botTrades, interval]);

    // Adapt hovered volume from original data for tooltip display
    const hoveredWithVolume = useMemo(() => {
        if (!hoveredData) return null;
        const match = data.find(c => c.time === hoveredData.time);
        return { ...hoveredData, volume: match?.volume ?? 0, adx: match?.adx ?? 0 };
    }, [hoveredData, data]);

    const clearHover = useCallback(() => setHoveredData(null), []);

    // Verdict panel accent
    const isEntry = aiScanResult?.verdict?.toUpperCase?.() === 'BUY' || aiScanResult?.verdict?.toUpperCase?.() === 'LONG';
    const isExit = aiScanResult?.verdict?.toUpperCase?.() === 'SELL' || aiScanResult?.verdict?.toUpperCase?.() === 'SHORT';
    const accentColor = isEntry ? 'text-emerald-400 border-emerald-500/30' : isExit ? 'text-rose-400 border-rose-500/30' : 'text-amber-400 border-amber-500/30';
    const accentBg = isEntry ? 'bg-emerald-500/10' : isExit ? 'bg-rose-500/10' : 'bg-amber-500/10';
    const dotColor = isEntry ? 'bg-emerald-500' : isExit ? 'bg-rose-500' : 'bg-amber-500';
    const glow = isEntry ? 'shadow-[0_0_20px_rgba(16,185,129,0.15)]' : isExit ? 'shadow-[0_0_20px_rgba(244,63,94,0.15)]' : 'shadow-[0_0_20px_rgba(245,158,11,0.15)]';

    return (
        <div className="w-full h-full flex flex-col relative rounded-xl overflow-hidden bg-[#18181b]/50 select-none group">
            <div className="h-10 lg:h-12 flex items-center gap-2 px-2 border-b border-white/5 bg-white/[0.02] backdrop-blur-md z-20 shrink-0 w-full">
                <div className="flex-1 overflow-x-auto scrollbar-hide flex items-center gap-2 pr-4 min-w-0">
                    <div className="flex items-center gap-2 shrink-0">
                        <div className="flex items-center gap-2">
                            <div className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></div>
                            <span className="text-xs font-bold text-white whitespace-nowrap">
                                QUANT-DESK
                            </span>
                        </div>
                    </div>
                    <div className="flex items-center gap-1.5 bg-zinc-900/50 p-0.5 rounded-full border border-white/5">
                        {['1m', '5m', '15m', '1h', '4h', '1d'].map(tf => (
                            <button
                                key={tf}
                                onClick={() => onIntervalChange?.(tf)}
                                className={`
                                    px-2.5 py-1 rounded-full text-[9px] font-bold transition-all whitespace-nowrap
                                    ${interval === tf ? 'bg-brand-accent text-white shadow-sm' : 'text-zinc-500 hover:text-zinc-300 hover:bg-white/5'}
                                `}
                            >
                                {tf}
                            </button>
                        ))}
                    </div>
                    {children}
                </div>

                <div className="flex items-center gap-1.5 shrink-0">
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
                            {isScanning ? <Loader2 size={10} className="animate-spin" /> : <Rocket size={10} />}
                            <span className="hidden sm:inline">{isScanning ? 'SCAN' : 'AI'}</span>
                        </button>
                    )}
                    {onToggleSidePanel && (
                        <button
                            onClick={onToggleSidePanel}
                            className={`p-1.5 rounded-full text-[9px] font-bold transition-all border ${isSidePanelOpen ? 'bg-brand-accent/20 text-brand-accent border-brand-accent/30' : 'text-zinc-500 hover:text-zinc-300 border-transparent hover:bg-white/5'}`}
                        >
                            <PanelRight size={14} />
                        </button>
                    )}
                </div>
            </div>

            <div className="flex-1 w-full min-h-0 relative" onClick={clearHover}>
                <div ref={chartContainerRef} className="w-full h-full" />
                {chart && data.length === 0 && (
                    <div className="absolute inset-0 flex items-center justify-center bg-[#0d1117]/60 z-30">
                        <div className="flex flex-col items-center gap-2">
                            <div className="w-5 h-5 border-2 border-brand-accent border-t-transparent rounded-full animate-spin" />
                            <span className="text-[11px] font-mono text-zinc-400">Loading {interval}...</span>
                        </div>
                    </div>
                )}

                {/* Tooltip */}
                {hoveredWithVolume && (
                    <div className="absolute top-2 left-2 z-50 pointer-events-none bg-[#09090b]/90 backdrop-blur-md border border-white/10 p-2 rounded-lg shadow-xl max-w-[140px] sm:max-w-none">
                        <div className="flex items-center gap-2 mb-1 border-b border-white/5 pb-1">
                            <Clock size={10} className="text-zinc-500" />
                            <span className="text-[10px] font-mono text-zinc-400">
                                {hoveredWithVolume.time && typeof hoveredWithVolume.time === 'number'
                                    ? new Date(hoveredWithVolume.time * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                                    : '-'}
                            </span>
                        </div>
                        <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[10px] font-mono">
                            <span className="text-zinc-600">O</span>
                            <span className={hoveredWithVolume.close >= hoveredWithVolume.open ? "text-emerald-400" : "text-rose-400"}>
                                {isValid(hoveredWithVolume.open) ? hoveredWithVolume.open.toFixed(1) : '-'}
                            </span>
                            <span className="text-zinc-600">H</span>
                            <span className="text-zinc-400">{isValid(hoveredWithVolume.high) ? hoveredWithVolume.high.toFixed(1) : '-'}</span>
                            <span className="text-zinc-600">L</span>
                            <span className="text-zinc-400">{isValid(hoveredWithVolume.low) ? hoveredWithVolume.low.toFixed(1) : '-'}</span>
                            <span className="text-zinc-600">C</span>
                            <span className={hoveredWithVolume.close >= hoveredWithVolume.open ? "text-emerald-400" : "text-rose-400"}>
                                {isValid(hoveredWithVolume.close) ? hoveredWithVolume.close.toFixed(1) : '-'}
                            </span>
                            <span className="text-zinc-600">V</span>
                            <span className="text-zinc-400">{hoveredWithVolume.volume ? (hoveredWithVolume.volume / 1000).toFixed(1) + 'K' : '-'}</span>
                        </div>
                        <div className="mt-1 pt-1 border-t border-white/5 text-[9px] text-zinc-600 font-mono text-right">
                            {currentPeriod}
                        </div>
                    </div>
                )}

                {/* AI Verdict Popup */}
                {verdictVisible && aiScanResult && (
                    (() => {
                        return (
                            <div
                                ref={verdictPanelRef}
                                style={{ left: verdictPos.x, top: verdictPos.y, width: verdictExpanded ? 340 : 260, zIndex: 60 }}
                                className={`absolute select-none rounded-xl border border-white/10 bg-[#0a0a0f]/95 backdrop-blur-xl ${glow} flex flex-col overflow-hidden`}
                            >
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
                                {!verdictCollapsed && (
                                    <div className="overflow-y-auto p-3 space-y-2" style={{ maxHeight: verdictExpanded ? 480 : 220 }}>
                                        <div className="flex items-center gap-2">
                                            <span className={`px-2 py-0.5 rounded-full text-[10px] font-black uppercase tracking-widest border ${accentColor} ${accentBg}`}>
                                                {aiScanResult.verdict}
                                            </span>
                                            {aiScanResult.confidence != null && (
                                                <span className="text-[10px] font-mono text-zinc-400">
                                                    {typeof aiScanResult.confidence === 'number' ? (aiScanResult.confidence * 100).toFixed(1) + '%' : aiScanResult.confidence}
                                                </span>
                                            )}
                                        </div>
                                        {aiScanResult.analysis && (
                                            <p className="text-[10px] text-zinc-300 leading-relaxed italic border-l-2 border-white/10 pl-2">
                                                {aiScanResult.analysis}
                                            </p>
                                        )}
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
                    })()
                )}

                {/* Animated bot heartbeat icon */}
                {botSettings && (
                    <div className="absolute bottom-[68px] right-3 z-20 pointer-events-none">
                        <div className="relative">
                            <div
                                className={`absolute -inset-1 rounded-full ${botSettings.status === 'ONLINE' ? 'bg-green-500/30' : 'bg-red-500/20'}`}
                                style={botSettings.status === 'ONLINE' ? { animation: 'bot-ping 1.5s ease-out infinite' } : {}}
                            />
                            <div
                                className={`absolute -inset-2 rounded-full border ${botSettings.status === 'ONLINE' ? 'border-green-500/30' : 'border-red-500/20'}`}
                                style={botSettings.status === 'ONLINE' ? { animation: 'bot-ring 2s ease-out infinite' } : {}}
                            />
                            <Bot size={18} className={`relative z-10 ${botSettings.status === 'ONLINE' ? 'text-green-400 animate-pulse' : 'text-red-500'}`} />
                        </div>
                    </div>
                )}

                {/* Bot reasoning bar — 2-row decision panel */}
                {botSettings && (
                    <div className="absolute bottom-0 left-0 right-0 bg-[#0a0a0f]/97 border-t border-[#21262d] z-20">
                        <div className="flex items-center gap-2 px-3 py-1.5 text-[10px] font-mono border-b border-white/5">
                            <span className={`w-2 h-2 rounded-full shrink-0 ${botSettings.status === 'ONLINE' ? 'bg-green-400 animate-pulse' : 'bg-red-500'}`} />
                            <span className="font-bold text-white">{botSettings.currentRegime || '—'}</span>
                            <span className={Math.abs(botSettings.currentZScore || 0) > 1.5 ? 'text-red-400' : Math.abs(botSettings.currentZScore || 0) > 1.0 ? 'text-yellow-400' : 'text-green-400'}>
                                Z {(botSettings.currentZScore || 0) >= 0 ? '+' : ''}{botSettings.currentZScore?.toFixed(2) ?? '0.00'}
                            </span>
                            <span className={(botSettings.currentBayes || 0) * 100 > 65 ? 'text-green-400' : (botSettings.currentBayes || 0) * 100 > 50 ? 'text-yellow-400' : 'text-red-400'}>
                                B {((botSettings.currentBayes ?? 0.5) * 100).toFixed(0)}%
                            </span>
                            <span className={botSettings.lastSignal === 'WAIT' ? 'text-[#8b949e]' : (botSettings.lastSignal || '').includes('BUY') || (botSettings.lastSignal || '').includes('LONG') ? 'text-green-400' : 'text-red-400'}>
                                {botSettings.lastSignal || 'WAIT'}
                            </span>
                            {botSettings.lastUlis && botSettings.lastUlis !== '—' && (
                                <span className={`px-1 rounded text-[9px] font-bold ${
                                    botSettings.lastUlis === 'AVOID' || botSettings.lastUlis === 'UNWIND' ? 'bg-red-900/60 text-red-400' :
                                    botSettings.lastUlis === 'CAUTION' ? 'bg-yellow-900/60 text-yellow-400' :
                                    'bg-green-900/60 text-green-400'
                                }`}>
                                    {botSettings.lastUlis}
                                </span>
                            )}
                            <span className="text-[#58a6ff] truncate flex-1 ml-2">
                                {botSettings.lastAnalysis || '—'}
                            </span>
                        </div>
                        <div className="flex items-center gap-2 px-3 py-1 text-[9px] font-mono">
                            <span className="text-[#484f58]">
                                OIZ {(botSettings.oiZScore || 0) >= 0 ? '+' : ''}{botSettings.oiZScore?.toFixed(1) ?? '—'}
                            </span>
                            <span className={Math.abs(botSettings.oiDelta5mPct || 0) > 1 ? 'text-yellow-400' : 'text-[#484f58]'}>
                                Δ5 {(botSettings.oiDelta5mPct || 0) >= 0 ? '+' : ''}{botSettings.oiDelta5mPct?.toFixed(2) ?? '—'}%
                            </span>
                            <span className="text-[#484f58]">{(botSettings.oiUsdM || 0).toFixed(0)}M</span>
                            {botSettings.priceOIRegime && (
                                <span className={`px-1 rounded text-[8px] font-bold ${
                                    (botSettings.priceOIRegime || '').includes('LONG_BUILD') ? 'bg-green-900/60 text-green-400' :
                                    (botSettings.priceOIRegime || '').includes('SHORT_BUILD') ? 'bg-red-900/60 text-red-400' :
                                    (botSettings.priceOIRegime || '').includes('COVERING') ? 'bg-blue-900/60 text-blue-400' :
                                    (botSettings.priceOIRegime || '').includes('LIQUIDATION') ? 'bg-rose-900/60 text-rose-400' :
                                    'text-[#484f58]'
                                }`}>
                                    {botSettings.priceOIRegime.replace(/_/g, ' ')}
                                </span>
                            )}
                            {botSettings.oiRiskLabel && botSettings.oiRiskLabel !== 'UNKNOWN' && (
                                <span className={`px-1 rounded text-[8px] font-bold ${
                                    botSettings.oiRiskLabel === 'EXTREME_RISK' ? 'bg-red-900/60 text-red-400' :
                                    botSettings.oiRiskLabel === 'ELEVATED_RISK' ? 'bg-yellow-900/60 text-yellow-400' :
                                    'bg-blue-900/60 text-blue-400'
                                }`}>
                                    {botSettings.oiRiskLabel.replace(/_/g, ' ')}
                                </span>
                            )}
                            {botSettings.fundingOISignal && botSettings.fundingOISignal !== 'NEUTRAL' && (
                                <span className={`px-1 rounded text-[8px] font-bold ${
                                    (botSettings.fundingOISignal || '').includes('CROWDED') ? 'bg-red-900/60 text-red-400' :
                                    botSettings.fundingOISignal === 'SQUEEZE_SETUP' ? 'bg-purple-900/60 text-purple-400' :
                                    'bg-green-900/60 text-green-400'
                                }`}>
                                    {botSettings.fundingOISignal.replace(/_/g, ' ')}
                                </span>
                            )}
                            <span className="text-[#484f58] ml-auto">
                                RSI {botSettings.currentRSI?.toFixed(0) ?? '—'}
                                {' · '}OFI {botSettings.currentOFI?.toFixed(2) ?? '—'}
                                {' · '}ATR {((botSettings.currentATR || 0) * 100).toFixed(2)}%
                                {' · '}{botSettings.totalTrades || 0}t
                                {' · '}PnL <span className={(botSettings.globalSessionPnl || 0) >= 0 ? 'text-green-400' : 'text-red-400'}>
                                    ${(botSettings.globalSessionPnl || 0).toFixed(2)}
                                </span>
                            </span>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
};

export default PriceChart;
