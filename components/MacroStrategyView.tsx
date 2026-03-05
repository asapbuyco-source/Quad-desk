import React, { useMemo, useRef, useCallback, useState } from 'react';
import { motion as m, AnimatePresence } from 'framer-motion';
import { useStore } from '../store';
import { BrainCircuit, Activity, BarChart2, Zap, Layers, TrendingUp, GripHorizontal, ChevronDown, ChevronUp, ChevronLeft, ChevronRight } from 'lucide-react';

const motion = m as any;

const StatBlock: React.FC<{ label: string; value: string | React.ReactNode; subValue?: string; color?: string }> = ({ label, value, subValue, color = "text-white" }) => (
    <div className="p-5 rounded-2xl bg-zinc-900/40 border border-white/5 flex flex-col justify-between hover:bg-zinc-800/40 transition-colors">
        <span className="text-[11px] font-bold text-zinc-500 uppercase tracking-wider">{label}</span>
        <div className="flex flex-col mt-2">
            <span className={`text-2xl font-black font-mono tracking-tighter ${color}`}>{value}</span>
            {subValue && <span className="text-[11px] text-zinc-400 font-mono mt-1">{subValue}</span>}
        </div>
    </div>
);

const MacroStrategyView: React.FC = () => {
    const { config, fetchMacroStrategyAnalysis } = useStore();
    const { metrics, recentTrades, asks, bids } = useStore(state => state.market);
    const { macroStrategy } = useStore(state => state);

    const [isAiPanelOpen, setIsAiPanelOpen] = useState(false);

    // Pull metrics
    const { skewness, bayesianPosterior, zScore, retailSentiment: rsi, ofi, institutionalCVD: cvd } = metrics;

    // Symbol-agnostic tape analysis, normalized to USD-equivalent
    const tapeAnalysis = useMemo(() => {
        if (!recentTrades || recentTrades.length < 5) return { speed: "NORMAL", dominantSide: "NO DATA" };
        const now = Date.now();
        const last10s = recentTrades.filter(t => (now - t.time) < 10000);
        const last60s = recentTrades.filter(t => (now - t.time) < 60000);

        let buyUsd = 0, sellUsd = 0;
        last10s.forEach(t => {
            const usd = t.price * t.size;
            if (t.side === 'BUY') buyUsd += usd;
            else sellUsd += usd;
        });

        let baseline10sUsd = 0;
        if (last60s.length > 0) {
            const total60sUsd = last60s.reduce((acc, t) => acc + t.price * t.size, 0);
            baseline10sUsd = (total60sUsd / 60) * 10;
        }
        const totalUsd10s = buyUsd + sellUsd;
        const isScreaming = baseline10sUsd > 0
            ? totalUsd10s > baseline10sUsd * 3
            : totalUsd10s > 2_000_000;

        const dominant = buyUsd > sellUsd * 1.5 ? "BUY (ASK HIT)" : sellUsd > buyUsd * 1.5 ? "SELL (BID HIT)" : "BALANCED";
        return { speed: isScreaming ? "SCREAMING" : "NORMAL", dominantSide: dominant, buyUsd, sellUsd };
    }, [recentTrades]);

    // LOB Wall analysis
    const lobAnalysis = useMemo(() => {
        const buyWalls = bids.filter(b => b.classification === 'WALL').slice(0, 5);
        const sellWalls = asks.filter(a => a.classification === 'WALL').slice(0, 5);
        const nearestBuyWall = buyWalls[0];
        const nearestSellWall = sellWalls[0];
        const buyWallDist = nearestBuyWall ? ((metrics.price - nearestBuyWall.price) / metrics.price * 100).toFixed(2) : 'N/A';
        const sellWallDist = nearestSellWall ? ((nearestSellWall.price - metrics.price) / metrics.price * 100).toFixed(2) : 'N/A';
        const allWallsSummary = [
            ...sellWalls.map(w => `SELL@${w.price.toFixed(1)} (${((w.price - metrics.price) / metrics.price * 100).toFixed(2)}% above, size:${w.size.toFixed(2)})`),
            ...buyWalls.map(w => `BUY@${w.price.toFixed(1)} (${((metrics.price - w.price) / metrics.price * 100).toFixed(2)}% below, size:${w.size.toFixed(2)})`)
        ].join('; ');
        return { nearestBuyWallPrice: nearestBuyWall?.price, nearestSellWallPrice: nearestSellWall?.price, buyWallDist, sellWallDist, allWalls: allWallsSummary, buyWallCount: buyWalls.length, sellWallCount: sellWalls.length };
    }, [asks, bids, metrics.price]);

    const handleGenerateAi = () => {
        if (macroStrategy.isLoading) return;
        fetchMacroStrategyAnalysis({
            symbol: config.activeSymbol,
            price: metrics.price,
            skewness: skewness || 0,
            bayesianPosterior: bayesianPosterior || 0.5,
            zScore: zScore || 0,
            rsi: rsi || 50,
            ofi: ofi || 0,
            cvd: cvd || 0,
            tapeSpeed: tapeAnalysis.speed,
            tapeDominant: tapeAnalysis.dominantSide,
            wallContext: `Nearest Buy Wall: ${lobAnalysis.nearestBuyWallPrice ? lobAnalysis.nearestBuyWallPrice.toFixed(1) : 'None'} (-${lobAnalysis.buyWallDist}%), Nearest Sell Wall: ${lobAnalysis.nearestSellWallPrice ? lobAnalysis.nearestSellWallPrice.toFixed(1) : 'None'} (+${lobAnalysis.sellWallDist}%)`,
            allWalls: lobAnalysis.allWalls
        });
    };

    // AI Styling
    let verdictColor = "text-zinc-400";
    let verdictBg = "from-zinc-900/80 to-black";
    let verdictBorder = "border-white/10";

    const aiVerdictStr = macroStrategy.aiResult?.verdict?.toUpperCase() || 'WAIT';

    if (aiVerdictStr === 'BUY' || aiVerdictStr === 'BULLISH') {
        verdictColor = "text-emerald-400";
        verdictBg = "from-emerald-900/30 to-black";
        verdictBorder = "border-emerald-500/30";
    } else if (aiVerdictStr === 'SELL' || aiVerdictStr === 'BEARISH') {
        verdictColor = "text-rose-400";
        verdictBg = "from-rose-900/30 to-black";
        verdictBorder = "border-rose-500/30";
    } else if (aiVerdictStr === 'MEAN_REVERSAL') {
        verdictColor = "text-violet-400";
        verdictBg = "from-violet-900/30 to-black";
        verdictBorder = "border-violet-500/30";
    } else if (aiVerdictStr === 'WAIT' || aiVerdictStr === 'NEUTRAL') {
        verdictColor = "text-amber-400";
        verdictBg = "from-amber-900/30 to-black";
        verdictBorder = "border-amber-500/30";
    }

    // Bayesian helpers
    const getBayesLabel = (p: number) => p > 0.6 ? 'Confirming Upside' : p < 0.4 ? 'Confirming Downside' : 'Neutral';
    const getBayesColor = (p: number) => p > 0.6 ? 'text-emerald-400' : p < 0.4 ? 'text-rose-400' : 'text-zinc-400';

    // Resizable analysis text
    const [analysisHeight, setAnalysisHeight] = useState(160);
    const [analysisCollapsed, setAnalysisCollapsed] = useState(false);
    const analysisResizeRef = useRef<{ startY: number; startH: number } | null>(null);
    const startAnalysisResize = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        analysisResizeRef.current = { startY: e.clientY, startH: analysisHeight };
    }, [analysisHeight]);
    const onAnalysisResize = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
        if (!analysisResizeRef.current) return;
        const dy = e.clientY - analysisResizeRef.current.startY;
        setAnalysisHeight(Math.max(60, Math.min(600, analysisResizeRef.current.startH + dy)));
    }, []);
    const stopAnalysisResize = useCallback(() => { analysisResizeRef.current = null; }, []);

    const dotColor = verdictColor === 'text-emerald-400' ? 'bg-emerald-400'
        : verdictColor === 'text-rose-400' ? 'bg-rose-400'
            : verdictColor === 'text-violet-400' ? 'bg-violet-400' : 'bg-amber-400';

    return (
        <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="h-full w-full flex overflow-hidden relative"
        >
            {/* ── LEFT AI SLIDE PANEL ────────────────────────────────────── */}
            <AnimatePresence>
                {isAiPanelOpen && (
                    <motion.div
                        key="macro-ai-panel"
                        initial={{ width: 0, opacity: 0 }}
                        animate={{ width: 360, opacity: 1 }}
                        exit={{ width: 0, opacity: 0 }}
                        transition={{ type: 'spring', stiffness: 300, damping: 30 }}
                        className="h-full shrink-0 overflow-hidden border-r border-white/10 bg-[#09090b] flex flex-col z-10"
                        style={{ minWidth: 0 }}
                    >
                        {/* Panel Header */}
                        <div className="flex items-center justify-between px-4 py-3 border-b border-white/5 bg-white/[0.02] shrink-0">
                            <div className="flex items-center gap-2">
                                <BrainCircuit size={15} className={verdictColor} />
                                <span className="text-xs font-bold text-white uppercase tracking-widest">Sentinel Synthesis</span>
                            </div>
                            <button onClick={() => setIsAiPanelOpen(false)} className="p-1 rounded text-zinc-500 hover:text-zinc-200 transition-colors">
                                <ChevronLeft size={16} />
                            </button>
                        </div>

                        {/* Panel Content */}
                        <div className={`flex-1 overflow-y-auto p-4 flex flex-col gap-4 bg-gradient-to-b ${verdictBg}`}>

                            {/* Verdict Display */}
                            {macroStrategy.aiResult ? (
                                <div className={`rounded-xl border ${verdictBorder} p-4 flex flex-col gap-3`}>
                                    <div className="flex items-center justify-between">
                                        <h3 className={`text-4xl font-black uppercase tracking-tighter drop-shadow-md ${verdictColor}`}>
                                            {aiVerdictStr}
                                        </h3>
                                        <div className="flex flex-col items-end gap-1">
                                            <span className={`text-[10px] px-2 py-0.5 rounded-full border ${verdictBorder} font-mono ${verdictColor} bg-black/50`}>
                                                {(macroStrategy.aiResult.confidence * 100).toFixed(0)}% conf.
                                            </span>
                                            <button
                                                onClick={() => setAnalysisCollapsed(p => !p)}
                                                className="p-1 rounded text-zinc-500 hover:text-zinc-200 transition-colors"
                                                title={analysisCollapsed ? 'Show analysis' : 'Collapse'}
                                            >
                                                {analysisCollapsed ? <ChevronDown size={12} /> : <ChevronUp size={12} />}
                                            </button>
                                        </div>
                                    </div>
                                    {!analysisCollapsed && (
                                        <div
                                            className="rounded-lg border border-white/5 bg-black/30 flex flex-col overflow-hidden"
                                            style={{ height: analysisHeight }}
                                        >
                                            <p className="text-sm text-zinc-300 leading-relaxed whitespace-pre-wrap overflow-y-auto flex-1 p-3 font-light">
                                                {macroStrategy.aiResult.analysis}
                                            </p>
                                            <div
                                                onPointerDown={startAnalysisResize}
                                                onPointerMove={onAnalysisResize}
                                                onPointerUp={stopAnalysisResize}
                                                style={{ cursor: 'ns-resize', touchAction: 'none' }}
                                                className="shrink-0 flex items-center justify-center h-4 bg-white/[0.03] border-t border-white/5 hover:bg-white/[0.07] transition-colors"
                                                title="Drag to resize"
                                            >
                                                <GripHorizontal size={12} className="text-zinc-600" />
                                            </div>
                                        </div>
                                    )}
                                </div>
                            ) : (
                                <div className="rounded-xl border border-white/5 p-4 text-zinc-500 text-sm italic leading-relaxed">
                                    Click <span className="text-white font-bold not-italic">Generate Signal</span> below to run deep inference on current statistical and microstructure parameters.
                                </div>
                            )}

                            {/* Generate Button */}
                            <button
                                onClick={handleGenerateAi}
                                disabled={macroStrategy.isLoading}
                                className={`w-full flex items-center justify-center gap-2 px-6 py-3.5 rounded-xl font-bold uppercase text-xs tracking-wider transition-all duration-300
                                    ${macroStrategy.isLoading
                                        ? 'bg-zinc-800 text-zinc-500 cursor-not-allowed border border-zinc-700'
                                        : 'bg-brand-accent/20 hover:bg-brand-accent/30 text-brand-accent border border-brand-accent/50 hover:shadow-[0_0_30px_rgba(56,189,248,0.3)] hover:scale-[1.02]'}`}
                            >
                                {macroStrategy.isLoading ? (
                                    <><Activity className="animate-spin" size={16} /><span>Analyzing...</span></>
                                ) : (
                                    <><Zap size={16} /><span>Generate Signal</span></>
                                )}
                            </button>

                            {/* Input snapshot */}
                            <div className="border-t border-white/5 pt-4 flex flex-col gap-2">
                                <span className="text-[10px] text-zinc-600 font-mono uppercase tracking-wider">Live Inputs</span>
                                {[
                                    { label: 'Skewness', value: (skewness || 0).toFixed(4), color: skewness && skewness < -0.1 ? 'text-rose-400' : skewness && skewness > 0.1 ? 'text-emerald-400' : 'text-zinc-400' },
                                    { label: 'Bayes P(Bull)', value: bayesianPosterior !== undefined ? (bayesianPosterior * 100).toFixed(1) + '%' : '50.0%', color: getBayesColor(bayesianPosterior || 0.5) },
                                    { label: 'Z-Score', value: (zScore || 0).toFixed(3), color: zScore && Math.abs(zScore) >= 2.5 ? 'text-violet-400' : zScore && zScore > 0.5 ? 'text-emerald-400' : zScore && zScore < -0.5 ? 'text-rose-400' : 'text-zinc-400' },
                                    { label: 'RSI', value: rsi ? Math.round(rsi).toString() : '50', color: rsi && (rsi < 30 || rsi > 70) ? 'text-amber-400' : rsi && rsi >= 55 ? 'text-emerald-400' : 'text-zinc-400' },
                                    { label: 'OFI', value: (ofi || 0).toFixed(1), color: ofi && ofi > 10 ? 'text-emerald-400' : ofi && ofi < -10 ? 'text-rose-400' : 'text-zinc-400' },
                                    { label: 'CVD', value: cvd ? Math.round(cvd).toLocaleString() : '0', color: cvd && cvd > 0 ? 'text-emerald-400' : cvd && cvd < 0 ? 'text-rose-400' : 'text-zinc-400' },
                                    { label: 'Tape', value: tapeAnalysis.speed, color: tapeAnalysis.speed === 'SCREAMING' ? 'text-amber-400' : 'text-zinc-300' },
                                    { label: 'LOB Walls', value: `${lobAnalysis.buyWallCount}B / ${lobAnalysis.sellWallCount}S`, color: 'text-zinc-300' },
                                ].map(({ label, value, color }) => (
                                    <div key={label} className="flex justify-between items-center text-xs font-mono">
                                        <span className="text-zinc-500">{label}</span>
                                        <span className={color}>{value}</span>
                                    </div>
                                ))}
                            </div>
                        </div>
                    </motion.div>
                )}
            </AnimatePresence>

            {/* ── AI PANEL TRIGGER TAB (left edge) ─────────────────────── */}
            <button
                onClick={() => setIsAiPanelOpen(p => !p)}
                className={`absolute left-0 top-1/2 -translate-y-1/2 z-20 flex flex-col items-center gap-1.5 py-4 px-2 rounded-r-xl border-y border-r transition-all duration-200
                    ${isAiPanelOpen
                        ? 'bg-brand-accent/20 border-brand-accent/30 text-brand-accent shadow-[0_0_20px_rgba(59,130,246,0.2)]'
                        : 'bg-zinc-900 border-white/10 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200 hover:border-white/20'}`}
                title={isAiPanelOpen ? 'Close AI Panel' : 'Open Sentinel Synthesis Panel'}
            >
                <BrainCircuit size={14} />
                <span className="font-bold text-[8px] uppercase tracking-widest" style={{ writingMode: 'vertical-rl', transform: 'rotate(180deg)' }}>
                    Sentinel
                </span>
                {isAiPanelOpen ? <ChevronLeft size={11} /> : <ChevronRight size={11} />}
                {macroStrategy.aiResult && (
                    <div className={`w-1.5 h-1.5 rounded-full mt-1 ${dotColor}`} />
                )}
            </button>

            {/* ── MAIN CONTENT ─────────────────────────────────────────── */}
            <div className="flex-1 min-w-0 h-full overflow-y-auto pl-6 pr-4 lg:pr-8 pb-24 lg:pb-8 pt-6">
                <div className="max-w-7xl mx-auto flex flex-col gap-6">

                    {/* Page Header */}
                    <div className="flex items-center justify-between">
                        <div>
                            <h1 className="text-3xl font-black tracking-tighter uppercase flex items-center gap-3">
                                <BarChart2 className="text-brand-accent" size={28} />
                                Macro Strategy
                            </h1>
                            <p className="text-zinc-500 font-mono text-sm mt-1">Statistical Filter &amp; Microstructure Engine</p>
                        </div>
                    </div>

                    {/* AI quick-status bar (shows when panel is closed) */}
                    {!isAiPanelOpen && macroStrategy.aiResult && (
                        <button
                            onClick={() => setIsAiPanelOpen(true)}
                            className={`w-full flex items-center gap-3 px-4 py-2.5 rounded-xl border ${verdictBorder} bg-gradient-to-r ${verdictBg} hover:opacity-90 transition-opacity text-left`}
                        >
                            <BrainCircuit size={14} className={verdictColor} />
                            <span className={`font-black text-sm tracking-tight ${verdictColor}`}>{aiVerdictStr}</span>
                            <span className="text-zinc-500 text-xs font-mono">{(macroStrategy.aiResult.confidence * 100).toFixed(0)}% confidence</span>
                            <span className="ml-auto text-zinc-600 text-[10px] font-mono uppercase">Click to expand →</span>
                        </button>
                    )}
                    {!isAiPanelOpen && !macroStrategy.aiResult && (
                        <button
                            onClick={() => setIsAiPanelOpen(true)}
                            className="w-full flex items-center gap-3 px-4 py-2.5 rounded-xl border border-white/5 bg-zinc-900/30 hover:bg-zinc-900/60 transition-colors text-left"
                        >
                            <BrainCircuit size={14} className="text-zinc-600" />
                            <span className="text-zinc-500 text-xs font-mono">Sentinel Synthesis — Click to generate AI macro strategy signal</span>
                            <ChevronRight size={12} className="ml-auto text-zinc-600" />
                        </button>
                    )}

                    {/* Statistical Metrics Grid */}
                    <h2 className="text-xl font-bold tracking-widest uppercase border-b border-white/10 pb-2 mt-2 text-zinc-300 flex items-center gap-2">
                        <Layers size={18} className="text-zinc-500" /> Statistical Parameters
                    </h2>
                    <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                        <StatBlock
                            label="Skewness — Log Returns"
                            value={skewness !== undefined && skewness !== null ? skewness.toFixed(4) : "0.0000"}
                            subValue={
                                skewness && Math.abs(skewness) < 0.1 ? "Symmetric — Neutral" :
                                    skewness && skewness < 0 ? "Negative — Downside Tail Risk" : "Positive — Upside Tail Risk"
                            }
                            color={skewness && skewness < -0.1 ? "text-rose-400" : skewness && skewness > 0.1 ? "text-emerald-400" : "text-zinc-400"}
                        />
                        <StatBlock
                            label="Bayesian P(Bull | Evidence)"
                            value={bayesianPosterior !== undefined ? (bayesianPosterior * 100).toFixed(1) + "%" : "50.0%"}
                            subValue={getBayesLabel(bayesianPosterior || 0.5)}
                            color={getBayesColor(bayesianPosterior || 0.5)}
                        />
                        <StatBlock
                            label="Z-Score — VWAP (20p)"
                            value={zScore !== undefined ? zScore.toFixed(3) : "0.000"}
                            subValue={
                                zScore && zScore >= 2.5 ? "Sentiment Wash — Mean Reversal" :
                                    zScore && zScore <= -2.5 ? "Sentiment Wash — Mean Reversal" :
                                        zScore && zScore > 0.5 ? "Bullish Trend" :
                                            zScore && zScore < -0.5 ? "Bearish Trend" : "Neutral"
                            }
                            color={
                                zScore && Math.abs(zScore) >= 2.5 ? "text-violet-400" :
                                    zScore && zScore > 0.5 ? "text-emerald-400" :
                                        zScore && zScore < -0.5 ? "text-rose-400" : "text-zinc-400"
                            }
                        />
                        <StatBlock
                            label="RSI — Sentiment"
                            value={rsi ? Math.round(rsi).toString() : "50"}
                            subValue={
                                rsi && rsi < 30 ? "Capitulation — Reversal Prep" :
                                    rsi && rsi > 70 ? "Overbought Capitulation" :
                                        rsi && rsi >= 55 ? "Building — Bullish Trend" :
                                            rsi && rsi < 45 ? "Reset — Sideways" : "Neutral (45–55)"
                            }
                            color={rsi && (rsi < 30 || rsi > 70) ? "text-amber-400" : rsi && rsi >= 55 ? "text-emerald-400" : "text-zinc-400"}
                        />
                    </div>

                    <h2 className="text-xl font-bold tracking-widest uppercase border-b border-white/10 pb-2 mt-4 text-zinc-300 flex items-center gap-2">
                        <TrendingUp size={18} className="text-zinc-500" /> Microstructure Parameters
                    </h2>
                    <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                        <StatBlock
                            label="Order Flow Imbalance"
                            value={ofi ? ofi.toFixed(1) : "0.0"}
                            subValue={ofi && ofi > 10 ? "Pressure Building (Buy)" : ofi && ofi < -10 ? "Pressure Building (Sell)" : "Balanced / No Signal"}
                            color={ofi && ofi > 10 ? "text-emerald-400" : ofi && ofi < -10 ? "text-rose-400" : "text-zinc-400"}
                        />
                        <StatBlock
                            label="Cumulative Delta"
                            value={cvd ? Math.round(cvd).toLocaleString() : "0"}
                            subValue={cvd && cvd > 0 ? "Aggressive Buyers" : cvd && cvd < 0 ? "Aggressive Sellers" : "Neutral Control"}
                            color={cvd && cvd > 0 ? "text-emerald-400" : cvd && cvd < 0 ? "text-rose-400" : "text-zinc-400"}
                        />
                        <StatBlock
                            label="Tape Speed"
                            value={tapeAnalysis.speed}
                            subValue={`${tapeAnalysis.dominantSide}`}
                            color={tapeAnalysis.speed === 'SCREAMING' ? "text-amber-400" : "text-zinc-300"}
                        />
                        <StatBlock
                            label="LOB Walls"
                            value={
                                <div className="text-sm font-sans flex flex-col gap-1">
                                    <div className="flex justify-between">
                                        <span className="text-zinc-500">Sell walls ({lobAnalysis.sellWallCount})</span>
                                        <span className="text-rose-400">{lobAnalysis.nearestSellWallPrice ? lobAnalysis.nearestSellWallPrice.toFixed(1) : 'NONE'}</span>
                                    </div>
                                    <div className="flex justify-between">
                                        <span className="text-zinc-500">Buy walls ({lobAnalysis.buyWallCount})</span>
                                        <span className="text-emerald-400">{lobAnalysis.nearestBuyWallPrice ? lobAnalysis.nearestBuyWallPrice.toFixed(1) : 'NONE'}</span>
                                    </div>
                                </div>
                            }
                            subValue={`${lobAnalysis.buyWallCount + lobAnalysis.sellWallCount} walls — all sent to AI`}
                        />
                    </div>
                </div>
            </div>
        </motion.div>
    );
};

export default MacroStrategyView;
