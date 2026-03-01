import React, { useMemo } from 'react';
import { motion as m } from 'framer-motion';
import { useStore } from '../store';
import { BrainCircuit, Activity, BarChart2, Zap, Layers, TrendingUp } from 'lucide-react';

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

    // Pull metrics
    const { skewness, bayesianPosterior, zScore, retailSentiment: rsi, ofi, institutionalCVD: cvd } = metrics;

    // --- FIX #5: Symbol-agnostic tape analysis, normalized to USD-equivalent ---
    // Volume is in base asset units (BTC, ETH, etc). Convert to USD using price.
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

        // Compute rolling 60s median per-10s USD volume as dynamic baseline
        let baseline10sUsd = 0;
        if (last60s.length > 0) {
            const total60sUsd = last60s.reduce((acc, t) => acc + t.price * t.size, 0);
            baseline10sUsd = (total60sUsd / 60) * 10; // expected 10s USD volume
        }
        const totalUsd10s = buyUsd + sellUsd;
        // "Screaming" if 10s volume is 3x the expected 10s baseline OR >$2M (absolute floor)
        const isScreaming = baseline10sUsd > 0
            ? totalUsd10s > baseline10sUsd * 3
            : totalUsd10s > 2_000_000;

        const dominant = buyUsd > sellUsd * 1.5 ? "BUY (ASK HIT)" : sellUsd > buyUsd * 1.5 ? "SELL (BID HIT)" : "BALANCED";

        return { speed: isScreaming ? "SCREAMING" : "NORMAL", dominantSide: dominant, buyUsd, sellUsd };
    }, [recentTrades]);

    // --- FIX #6: Persist tape state via the store (uses stored lastTapeSpeed if current window is empty) ---
    // The useMemo will compute from recentTrades every render, but we send whatever was last generated

    // --- FIX #7: Collect ALL LOB walls, not just the nearest one ---
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

        return {
            nearestBuyWallPrice: nearestBuyWall?.price,
            nearestSellWallPrice: nearestSellWall?.price,
            buyWallDist,
            sellWallDist,
            allWalls: allWallsSummary,
            buyWallCount: buyWalls.length,
            sellWallCount: sellWalls.length
        };
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
            tapeDominant: tapeAnalysis.dominantSide,   // FIX #4: send tape side
            wallContext: `Nearest Buy Wall: ${lobAnalysis.nearestBuyWallPrice ? lobAnalysis.nearestBuyWallPrice.toFixed(1) : 'None'} (-${lobAnalysis.buyWallDist}%), Nearest Sell Wall: ${lobAnalysis.nearestSellWallPrice ? lobAnalysis.nearestSellWallPrice.toFixed(1) : 'None'} (+${lobAnalysis.sellWallDist}%)`,
            allWalls: lobAnalysis.allWalls   // FIX #7: send all walls
        });
    };

    // AI Styling
    let verdictColor = "text-zinc-400";
    let verdictBg = "from-zinc-900 to-black";
    let verdictBorder = "border-white/10";

    const aiVerdictStr = macroStrategy.aiResult?.verdict?.toUpperCase() || 'WAIT';

    if (aiVerdictStr === 'BUY' || aiVerdictStr === 'BULLISH') {
        verdictColor = "text-emerald-400";
        verdictBg = "from-emerald-900/20 to-black";
        verdictBorder = "border-emerald-500/20";
    } else if (aiVerdictStr === 'SELL' || aiVerdictStr === 'BEARISH') {
        verdictColor = "text-rose-400";
        verdictBg = "from-rose-900/20 to-black";
        verdictBorder = "border-rose-500/20";
    } else if (aiVerdictStr === 'MEAN_REVERSAL') {
        verdictColor = "text-violet-400";
        verdictBg = "from-violet-900/20 to-black";
        verdictBorder = "border-violet-500/20";
    } else if (aiVerdictStr === 'WAIT' || aiVerdictStr === 'NEUTRAL') {
        verdictColor = "text-amber-400";
        verdictBg = "from-amber-900/20 to-black";
        verdictBorder = "border-amber-500/20";
    }

    // FIX #1 (display): Bayesian Posterior — correct display labels (range is 0-1)
    const getBayesLabel = (p: number) => p > 0.6 ? 'Confirming Upside' : p < 0.4 ? 'Confirming Downside' : 'Neutral';
    const getBayesColor = (p: number) => p > 0.6 ? 'text-emerald-400' : p < 0.4 ? 'text-rose-400' : 'text-zinc-400';

    return (
        <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="flex flex-col h-full overflow-y-auto px-4 lg:px-8 pb-24 lg:pb-8 pt-6 max-w-7xl mx-auto gap-6"
        >
            <div className="flex items-center justify-between">
                <div>
                    <h1 className="text-3xl font-black tracking-tighter uppercase flex items-center gap-3">
                        <BarChart2 className="text-brand-accent" size={28} />
                        Macro Strategy
                    </h1>
                    <p className="text-zinc-500 font-mono text-sm mt-1">Statistical Filter & Microstructure Engine</p>
                </div>
            </div>

            {/* AI Generation Section */}
            <div className={`rounded-2xl border ${verdictBorder} bg-gradient-to-r ${verdictBg} p-6 lg:p-8 relative overflow-hidden group transition-all duration-500`}>
                <div className="absolute top-0 right-0 p-6 opacity-5 group-hover:opacity-10 transition-opacity">
                    <BrainCircuit size={120} />
                </div>

                <div className="relative z-10 flex flex-col lg:flex-row items-start lg:items-center justify-between gap-6 lg:gap-10">
                    <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-2">
                            <BrainCircuit className={verdictColor} size={20} />
                            <span className="font-mono text-xs uppercase tracking-widest text-zinc-400">Sentinel Synthesis</span>
                            {macroStrategy.aiResult?.verdict && (
                                <span className={`text-[10px] px-2 py-0.5 rounded-full border ${verdictBorder} font-mono ${verdictColor} bg-black/50`}>
                                    Confidence: {(macroStrategy.aiResult.confidence * 100).toFixed(0)}%
                                </span>
                            )}
                        </div>

                        {!macroStrategy.aiResult ? (
                            <div className="mt-4">
                                <h3 className="text-xl font-bold text-zinc-300">Awaiting Generation</h3>
                                <p className="text-sm text-zinc-500 mt-2 max-w-2xl font-mono leading-relaxed">
                                    Click below to run a deep inference pass on current Skewness (log-return), Bayes Posterior (4-factor), VWAP Z-Score, LOB walls, OFI, CVD, and Tape velocity.
                                </p>
                            </div>
                        ) : (
                            <div className="mt-4">
                                <h3 className={`text-4xl lg:text-5xl font-black uppercase tracking-tighter drop-shadow-md ${verdictColor}`}>
                                    {aiVerdictStr}
                                </h3>
                                <p className="text-sm text-zinc-300 mt-4 max-w-3xl leading-relaxed whitespace-pre-wrap">
                                    {macroStrategy.aiResult.analysis}
                                </p>
                            </div>
                        )}
                    </div>

                    <div className="flex-shrink-0 w-full lg:w-auto">
                        <button
                            onClick={handleGenerateAi}
                            disabled={macroStrategy.isLoading}
                            className={`w-full lg:w-auto px-8 py-4 rounded-xl flex items-center justify-center gap-3 transition-all duration-300 ${macroStrategy.isLoading
                                ? 'bg-zinc-800 text-zinc-500 cursor-not-allowed border border-zinc-700'
                                : 'bg-brand-accent/20 hover:bg-brand-accent/30 text-brand-accent border border-brand-accent/50 hover:shadow-[0_0_30px_rgba(56,189,248,0.3)] hover:scale-[1.02]'
                                }`}
                        >
                            {macroStrategy.isLoading ? (
                                <>
                                    <Activity className="animate-spin" size={20} />
                                    <span className="font-mono font-bold tracking-widest text-sm">ANALYZING...</span>
                                </>
                            ) : (
                                <>
                                    <Zap size={20} />
                                    <span className="font-mono font-bold tracking-widest text-sm uppercase">Generate Signal</span>
                                </>
                            )}
                        </button>
                    </div>
                </div>
            </div>

            {/* Statistical Metrics Grid */}
            <h2 className="text-xl font-bold tracking-widest uppercase border-b border-white/10 pb-2 mt-4 text-zinc-300 flex items-center gap-2">
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
                {/* FIX #1: Bayesian now correctly labeled as 0–1 probability */}
                <StatBlock
                    label="Bayesian P(Bull | Evidence)"
                    value={bayesianPosterior !== undefined ? (bayesianPosterior * 100).toFixed(1) + "%" : "50.0%"}
                    subValue={getBayesLabel(bayesianPosterior || 0.5)}
                    color={getBayesColor(bayesianPosterior || 0.5)}
                />
                {/* FIX #3: Display VWAP-anchored Z-Score correctly */}
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
                {/* FIX #5: USD-normalized Tape Speed */}
                <StatBlock
                    label="Tape Speed"
                    value={tapeAnalysis.speed}
                    subValue={`${tapeAnalysis.dominantSide}`}
                    color={tapeAnalysis.speed === 'SCREAMING' ? "text-amber-400" : "text-zinc-300"}
                />
                {/* FIX #7: Show all walls count + nearest */}
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
                    subValue={`${lobAnalysis.buyWallCount + lobAnalysis.sellWallCount} walls detected — all sent to AI`}
                />
            </div>
        </motion.div>
    );
};

export default MacroStrategyView;
