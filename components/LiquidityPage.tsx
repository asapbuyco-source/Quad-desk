import React, { useEffect, useState, useMemo } from 'react';
import { motion as m, AnimatePresence } from 'framer-motion';
import { useStore } from '../store';
import { Droplets, ArrowUp, ArrowDown, MoveRight, ScanLine, AlertTriangle, RefreshCw, Layers, Clock, ShieldAlert, Siren, Eye } from 'lucide-react';

const motion = m as any;

type EventDirection = 'BULLISH' | 'BEARISH' | 'NEUTRAL' | 'CONTINUATION' | 'CONFLICT';

const DIRECTION_STYLES: Record<EventDirection, { color: string; bg: string; border: string; icon: React.ReactNode }> = {
    BULLISH: { color: 'text-emerald-400', bg: 'bg-emerald-500/10', border: 'border-emerald-500/20', icon: <ArrowUp size={14} /> },
    BEARISH: { color: 'text-rose-400', bg: 'bg-rose-500/10', border: 'border-rose-500/20', icon: <ArrowDown size={14} /> },
    NEUTRAL: { color: 'text-amber-400', bg: 'bg-amber-500/10', border: 'border-amber-500/20', icon: <MoveRight size={14} /> },
    CONTINUATION: { color: 'text-blue-400', bg: 'bg-blue-500/10', border: 'border-blue-500/20', icon: <MoveRight size={14} /> },
    CONFLICT: { color: 'text-orange-400', bg: 'bg-orange-500/10', border: 'border-orange-500/20', icon: <ShieldAlert size={14} /> },
};

const EventRow: React.FC<{
    label: string;
    price: number;
    time: number;
    direction: EventDirection;
    type: 'SWEEP' | 'BOS' | 'FVG';
    subtext?: string;
    note?: string;
}> = ({ label, price, time, direction, subtext, note }) => {
    const s = DIRECTION_STYLES[direction] ?? DIRECTION_STYLES.NEUTRAL;
    return (
        <motion.div
            initial={{ opacity: 0, x: -10 }}
            animate={{ opacity: 1, x: 0 }}
            className="flex flex-col gap-2 p-3 rounded-lg bg-white/5 border border-white/5 hover:bg-white/10 transition-colors"
        >
            <div className="flex items-center justify-between">
                <div className="flex flex-col gap-1">
                    <div className="flex items-center gap-2">
                        <span className={`p-1 rounded bg-black/40 ${s.color}`}>{s.icon}</span>
                        <span className="text-sm font-bold text-zinc-200 font-mono tracking-tight">{label}</span>
                    </div>
                    <span className="text-[10px] text-zinc-500 font-mono flex items-center gap-1">
                        <Clock size={10} /> {new Date(time).toLocaleTimeString()}
                    </span>
                </div>
                <div className="text-right">
                    <div className={`text-sm font-mono font-bold ${s.color}`}>{price.toFixed(2)}</div>
                    {subtext && <div className="text-[9px] text-zinc-500 font-bold uppercase tracking-wider">{subtext}</div>}
                </div>
            </div>
            {note && (
                <div className={`text-[10px] font-mono px-2 py-1 rounded border ${s.bg} ${s.border} ${s.color} leading-snug`}>
                    {note}
                </div>
            )}
        </motion.div>
    );
};

const LiquidityPage: React.FC = () => {
    const { liquidity, refreshLiquidityAnalysis, config: { activeSymbol } } = useStore();
    const [activeTab, setActiveTab] = useState<'SWEEPS' | 'BOS' | 'FVG'>('SWEEPS');

    // Auto-refresh every 10 seconds
    useEffect(() => {
        refreshLiquidityAnalysis();
        const i = setInterval(refreshLiquidityAnalysis, 10000);
        return () => clearInterval(i);
    }, []);

    const { sweeps, bos, fvg, lastUpdated } = liquidity;

    // ─── 3-Signal Confluence Verdict Engine ──────────────────────────────────────
    // We classify each signal independently, then combine them to produce one of
    // 7 named verdicts. BOS + FVG must AGREE with the sweep reversal direction
    // before we commit to a bullish/bearish bias.
    const biasData = useMemo(() => {
        const details: string[] = [];

        // ── Signal 1: Sweep (momentum reversal hint) ────────────────────────────
        //  BUY sweep  = highs taken = retail LONGS trapped → expect reversal DOWN
        //  SELL sweep = lows taken  = retail SHORTS trapped → expect reversal UP
        const recentSweep = [...sweeps].reverse()[0] ?? null;
        const sweepSignal: 'BULL' | 'BEAR' | null = recentSweep
            ? (recentSweep.side === 'SELL' ? 'BULL' : 'BEAR')
            : null;

        if (recentSweep) {
            if (sweepSignal === 'BULL') {
                details.push(`🪤 Sell-side sweep at ${recentSweep.price.toFixed(2)} — lows taken, retail SHORTS likely trapped. Potential bullish reversal.`);
            } else {
                details.push(`🪤 Buy-side sweep at ${recentSweep.price.toFixed(2)} — highs taken, retail LONGS likely trapped. Potential bearish reversal.`);
            }
        }

        // ── Signal 2: BOS (trend direction confirmation) ────────────────────────
        const recentBOS = [...bos].reverse()[0] ?? null;
        const bosSignal: 'BULL' | 'BEAR' | null = recentBOS
            ? (recentBOS.direction === 'BULLISH' ? 'BULL' : 'BEAR')
            : null;

        if (recentBOS) {
            if (bosSignal === 'BULL') {
                details.push(`📐 Bullish BOS at ${recentBOS.price.toFixed(2)} — market broke above prior swing high, confirming upward structure.`);
            } else {
                details.push(`📐 Bearish BOS at ${recentBOS.price.toFixed(2)} — market broke below prior swing low, confirming downward structure.`);
            }
        }

        // ── Signal 3: FVG (draw-on-liquidity / price magnet) ───────────────────
        const recentFVG = [...fvg].reverse()[0] ?? null;
        const fvgSignal: 'BULL' | 'BEAR' | null = recentFVG
            ? (recentFVG.direction === 'BULLISH' ? 'BULL' : 'BEAR')
            : null;

        if (recentFVG) {
            const gapSize = Math.abs(recentFVG.startPrice - recentFVG.endPrice).toFixed(2);
            if (fvgSignal === 'BULL') {
                details.push(`📊 Bullish FVG at ${recentFVG.startPrice.toFixed(2)}–${recentFVG.endPrice.toFixed(2)} (${gapSize} pts) — unfilled demand zone, price may be drawn up.`);
            } else {
                details.push(`📊 Bearish FVG at ${recentFVG.startPrice.toFixed(2)}–${recentFVG.endPrice.toFixed(2)} (${gapSize} pts) — unfilled supply zone, price may be drawn down.`);
            }
        }

        // ── Confluence: combine all 3 signals to derive verdict ─────────────────
        //
        //  VERDICT MATRIX:
        //  Sweep  BOS    FVG      →  Verdict
        //  BULL   BULL   BULL    →  TRAPPED SHORTS — HIGH CONVICTION BUY
        //  BEAR   BEAR   BEAR    →  TRAPPED LONGS  — HIGH CONVICTION SELL
        //  BULL   BULL   BEAR    →  REVERSAL BULLISH — AWAIT FVG FILL
        //  BEAR   BEAR   BULL    →  REVERSAL BEARISH — AWAIT FVG FILL
        //  BULL   BEAR   *       →  WATCH — SWEEP vs BOS CONFLICT
        //  BEAR   BULL   *       →  WATCH — SWEEP vs BOS CONFLICT
        //  null   BULL   BULL    →  BULLISH CONTINUATION
        //  null   BEAR   BEAR    →  BEARISH CONTINUATION
        //  *      null   null    →  NEUTRAL — INSUFFICIENT DATA

        type Verdict = {
            id: string;
            label: string;
            direction: EventDirection;
            subLabel: string;
            icon: React.ReactNode;
        };

        let verdict: Verdict;

        const allBull = sweepSignal === 'BULL' && bosSignal === 'BULL' && fvgSignal === 'BULL';
        const allBear = sweepSignal === 'BEAR' && bosSignal === 'BEAR' && fvgSignal === 'BEAR';
        const sweepBullBosBull = sweepSignal === 'BULL' && bosSignal === 'BULL';
        const sweepBearBosBear = sweepSignal === 'BEAR' && bosSignal === 'BEAR';
        const sweepVsBosConflict = sweepSignal !== null && bosSignal !== null && sweepSignal !== bosSignal;
        const continuationBull = !sweepSignal && bosSignal === 'BULL' && fvgSignal === 'BULL';
        const continuationBear = !sweepSignal && bosSignal === 'BEAR' && fvgSignal === 'BEAR';

        if (allBull) {
            verdict = {
                id: 'trapped-shorts', label: 'TRAPPED SHORTS', direction: 'BULLISH',
                subLabel: 'High-Conviction Long Setup',
                icon: <Siren size={20} className="text-emerald-400" />
            };
            details.push('✅ ALL 3 SIGNALS AGREE: Sweep + BOS + FVG all point bullish. Retail shorts are trapped below sweeps. Strong buy confluence.');
        } else if (allBear) {
            verdict = {
                id: 'trapped-longs', label: 'TRAPPED LONGS', direction: 'BEARISH',
                subLabel: 'High-Conviction Short Setup',
                icon: <Siren size={20} className="text-rose-400" />
            };
            details.push('✅ ALL 3 SIGNALS AGREE: Sweep + BOS + FVG all point bearish. Retail longs are trapped above sweeps. Strong sell confluence.');
        } else if (sweepBullBosBull) {
            verdict = {
                id: 'reversal-bull', label: 'BULLISH REVERSAL', direction: 'BULLISH',
                subLabel: fvgSignal === 'BEAR' ? 'Watch bearish FVG fill first' : 'Await BOS retest entry',
                icon: <ArrowUp size={20} className="text-emerald-400" />
            };
            details.push(fvgSignal === 'BEAR'
                ? '⚠️ Sweep + BOS confirm bullish reversal, but FVG draw is bearish — price may fill the gap before reversing. Wait for retest.'
                : '✅ Sweep reversal and BOS both bullish. Look for a pullback to the BOS level for entry.');
        } else if (sweepBearBosBear) {
            verdict = {
                id: 'reversal-bear', label: 'BEARISH REVERSAL', direction: 'BEARISH',
                subLabel: fvgSignal === 'BULL' ? 'Watch bullish FVG fill first' : 'Await BOS retest entry',
                icon: <ArrowDown size={20} className="text-rose-400" />
            };
            details.push(fvgSignal === 'BULL'
                ? '⚠️ Sweep + BOS confirm bearish reversal, but FVG draw is bullish — price may fill the gap before dropping. Wait for retest.'
                : '✅ Sweep reversal and BOS both bearish. Look for a rally back to the BOS level for a short entry.');
        } else if (sweepVsBosConflict) {
            verdict = {
                id: 'conflict', label: 'STRUCTURE CONFLICT', direction: 'CONFLICT',
                subLabel: 'Do not trade — signals oppose each other',
                icon: <ShieldAlert size={20} className="text-orange-400" />
            };
            details.push(`⚡ CONFLICT: Sweep hints ${sweepSignal === 'BULL' ? 'bullish' : 'bearish'} reversal but BOS is ${bosSignal === 'BULL' ? 'bullish' : 'bearish'} continuation. Wait for one signal to invalidate the other before acting.`);
        } else if (continuationBull) {
            verdict = {
                id: 'continuation-bull', label: 'BULLISH CONTINUATION', direction: 'CONTINUATION',
                subLabel: 'No sweep trap, structure trending up',
                icon: <MoveRight size={20} className="text-blue-400" />
            };
            details.push('📈 No sweep present. BOS + FVG both bullish = price likely continues higher. Trend-following long is favoured.');
        } else if (continuationBear) {
            verdict = {
                id: 'continuation-bear', label: 'BEARISH CONTINUATION', direction: 'CONTINUATION',
                subLabel: 'No sweep trap, structure trending down',
                icon: <MoveRight size={20} className="text-blue-400" />
            };
            details.push('📉 No sweep present. BOS + FVG both bearish = price likely continues lower. Trend-following short is favoured.');
        } else {
            verdict = {
                id: 'neutral', label: 'WAIT FOR CONFLUENCE', direction: 'NEUTRAL',
                subLabel: 'Not enough aligned signals',
                icon: <Eye size={20} className="text-amber-400" />
            };
            details.push('🔍 Signals are mixed or insufficient. Wait for a sweep + BOS + FVG alignment before committing to a directional bias.');
        }

        if (details.length === 0) details.push('No recent significant liquidity events to analyze.');

        const s = DIRECTION_STYLES[verdict.direction];
        return { verdict, details, sweepSignal, bosSignal, fvgSignal, color: s.color, bgColor: s.bg, borderColor: s.border, iconColor: s.color };
    }, [sweeps, bos, fvg]);

    return (
        <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="h-full overflow-y-auto px-4 lg:px-8 pb-24 lg:pb-8 max-w-7xl mx-auto pt-6"
        >
            <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-6 mb-8">
                <div>
                    <h1 className="text-3xl font-bold text-white tracking-tight flex items-center gap-3">
                        <div className="p-2 bg-blue-500/20 rounded-xl text-blue-400">
                            <Droplets size={28} />
                        </div>
                        Liquidity Events
                    </h1>
                    <p className="text-zinc-400 text-sm mt-1">
                        Automated structural analysis for {activeSymbol}.
                    </p>
                </div>

                <div className="flex items-center gap-4">
                    <div className="text-right hidden md:block">
                        <span className="text-[10px] text-zinc-500 font-bold uppercase block">Last Scan</span>
                        <span className="text-xs text-zinc-300 font-mono">{new Date(lastUpdated).toLocaleTimeString()}</span>
                    </div>
                    <button
                        onClick={() => refreshLiquidityAnalysis()}
                        className="p-2 rounded-lg bg-zinc-800 border border-zinc-700 text-zinc-400 hover:text-white hover:bg-zinc-700 transition-colors"
                    >
                        <RefreshCw size={18} />
                    </button>
                </div>
            </div>

            {/* Navigation Tabs */}
            <div className="flex gap-2 mb-6 border-b border-white/10 pb-4">
                {[
                    { id: 'SWEEPS', label: 'Sweeps', count: sweeps.length, icon: ScanLine },
                    { id: 'BOS', label: 'Break of Structure', count: bos.length, icon: Layers },
                    { id: 'FVG', label: 'Fair Value Gaps', count: fvg.length, icon: AlertTriangle },
                ].map(tab => (
                    <button
                        key={tab.id}
                        onClick={() => setActiveTab(tab.id as any)}
                        className={`
                            flex items-center gap-2 px-4 py-2 rounded-full text-xs font-bold uppercase tracking-wider transition-all
                            ${activeTab === tab.id
                                ? 'bg-blue-600 text-white shadow-lg shadow-blue-900/20'
                                : 'bg-zinc-900/50 text-zinc-500 hover:text-zinc-300 hover:bg-white/5'}
                        `}
                    >
                        <tab.icon size={14} />
                        {tab.label}
                        <span className="ml-1 px-1.5 py-0.5 rounded-full bg-black/20 text-[9px] min-w-[1.5em] text-center">
                            {tab.count}
                        </span>
                    </button>
                ))}
            </div>

            {/* Content Grid */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">

                {/* Main List */}
                <div className="lg:col-span-2 space-y-3">
                    <AnimatePresence mode="wait">
                        {activeTab === 'SWEEPS' && (
                            <motion.div
                                key="sweeps"
                                initial={{ opacity: 0, y: 10 }}
                                animate={{ opacity: 1, y: 0 }}
                                exit={{ opacity: 0, y: -10 }}
                                className="space-y-2"
                            >
                                {sweeps.length === 0 ? (
                                    <div className="text-center py-12 text-zinc-600 font-mono text-xs">NO SWEEPS DETECTED</div>
                                ) : sweeps.map(s => {
                                    // Determine direction considering BOS alignment
                                    const sweepDir = s.side === 'BUY' ? 'BEAR' : 'BULL';
                                    const recentBOS = [...bos].reverse()[0];
                                    const bosDir = recentBOS?.direction === 'BULLISH' ? 'BULL' : recentBOS?.direction === 'BEARISH' ? 'BEAR' : null;
                                    let rowDir: EventDirection = sweepDir === 'BULL' ? 'BULLISH' : 'BEARISH';
                                    let note: string | undefined;

                                    if (bosDir && bosDir !== sweepDir) {
                                        rowDir = 'CONFLICT';
                                        note = `Sweep direction (${sweepDir === 'BULL' ? 'bullish reversal' : 'bearish reversal'}) conflicts with recent BOS (${bosDir === 'BULL' ? 'bullish' : 'bearish'} trend). Wait for resolution.`;
                                    } else if (bosDir && bosDir === sweepDir) {
                                        note = `BOS confirms ${sweepDir === 'BULL' ? 'bullish' : 'bearish'} reversal direction — stronger conviction.`;
                                    }

                                    return (
                                        <EventRow
                                            key={s.id}
                                            label={`${s.side} Liquidity Sweep`}
                                            price={s.price}
                                            time={s.timestamp}
                                            direction={rowDir}
                                            type="SWEEP"
                                            subtext={s.side === 'BUY' ? 'HIGHS TAKEN' : 'LOWS TAKEN'}
                                            note={note}
                                        />
                                    );
                                })}
                            </motion.div>
                        )}

                        {activeTab === 'BOS' && (
                            <motion.div
                                key="bos"
                                initial={{ opacity: 0, y: 10 }}
                                animate={{ opacity: 1, y: 0 }}
                                exit={{ opacity: 0, y: -10 }}
                                className="space-y-2"
                            >
                                {bos.length === 0 ? (
                                    <div className="text-center py-12 text-zinc-600 font-mono text-xs">NO STRUCTURE BREAKS</div>
                                ) : bos.map(b => {
                                    const recentSweep = [...sweeps].reverse()[0];
                                    const sweepDir = recentSweep?.side === 'SELL' ? 'BULL' : recentSweep?.side === 'BUY' ? 'BEAR' : null;
                                    const bosDir = b.direction === 'BULLISH' ? 'BULL' : 'BEAR';
                                    let note: string | undefined;

                                    if (sweepDir && sweepDir === bosDir) {
                                        note = `✅ BOS aligns with recent sweep reversal — confluence confirmed.`;
                                    } else if (sweepDir && sweepDir !== bosDir) {
                                        note = `⚠️ BOS direction conflicts with recent sweep. Mixed signals — do not trade this alone.`;
                                    }

                                    return (
                                        <EventRow
                                            key={b.id}
                                            label={`${b.direction} BOS`}
                                            price={b.price}
                                            time={b.timestamp}
                                            direction={b.direction as EventDirection}
                                            type="BOS"
                                            note={note}
                                        />
                                    );
                                })}
                            </motion.div>
                        )}

                        {activeTab === 'FVG' && (
                            <motion.div
                                key="fvg"
                                initial={{ opacity: 0, y: 10 }}
                                animate={{ opacity: 1, y: 0 }}
                                exit={{ opacity: 0, y: -10 }}
                                className="space-y-2"
                            >
                                {fvg.length === 0 ? (
                                    <div className="text-center py-12 text-zinc-600 font-mono text-xs">EFFICIENT PRICE ACTION</div>
                                ) : fvg.map(f => {
                                    const recentSweep = [...sweeps].reverse()[0];
                                    const sweepDir = recentSweep?.side === 'SELL' ? 'BULL' : recentSweep?.side === 'BUY' ? 'BEAR' : null;
                                    const fvgDir = f.direction === 'BULLISH' ? 'BULL' : 'BEAR';
                                    let note: string | undefined;

                                    if (sweepDir && sweepDir === fvgDir) {
                                        note = `✅ FVG draw agrees with sweep reversal — ${fvgDir === 'BULL' ? 'price likely drawn upward' : 'price likely drawn downward'}.`;
                                    } else if (sweepDir && sweepDir !== fvgDir) {
                                        note = `⚠️ FVG draw conflicts with sweep — ${fvgDir === 'BULL' ? 'bullish gap' : 'bearish gap'} may pull price in opposite direction before reversal completes.`;
                                    }

                                    return (
                                        <EventRow
                                            key={f.id}
                                            label={`${f.direction} FVG`}
                                            price={f.startPrice}
                                            time={f.timestamp}
                                            direction={f.direction as EventDirection}
                                            type="FVG"
                                            subtext={`Gap: ${Math.abs(f.startPrice - f.endPrice).toFixed(2)} pts`}
                                            note={note}
                                        />
                                    );
                                })}
                            </motion.div>
                        )}
                    </AnimatePresence>
                </div>

                {/* Explainer & Bias Panel */}
                <div className="flex flex-col gap-6">
                    {/* Algorithmic Bias Indicator */}
                    <div className={`p-6 rounded-2xl border ${biasData.bgColor} ${biasData.borderColor}`}>
                        <div className="flex items-center gap-3 mb-4">
                            {biasData.verdict.icon}
                            <div>
                                <h3 className="text-sm font-bold text-white uppercase tracking-wider">Confluence Verdict</h3>
                                <p className={`text-xl font-black tracking-tighter ${biasData.color}`}>
                                    {biasData.verdict.label}
                                </p>
                                <p className={`text-[10px] font-mono font-bold uppercase tracking-wide opacity-70 ${biasData.color}`}>
                                    {biasData.verdict.subLabel}
                                </p>
                            </div>
                        </div>

                        {/* Signal matrix summary */}
                        <div className="grid grid-cols-3 gap-1 mb-4">
                            {[
                                { label: 'SWEEP', val: biasData.sweepSignal },
                                { label: 'BOS', val: biasData.bosSignal },
                                { label: 'FVG', val: biasData.fvgSignal },
                            ].map(({ label, val }) => (
                                <div key={label} className="bg-black/30 rounded-lg p-2 text-center">
                                    <div className="text-[8px] text-zinc-500 font-bold uppercase tracking-widest">{label}</div>
                                    <div className={`text-[10px] font-black font-mono mt-0.5 ${val === 'BULL' ? 'text-emerald-400' : val === 'BEAR' ? 'text-rose-400' : 'text-zinc-600'
                                        }`}>
                                        {val ?? '—'}
                                    </div>
                                </div>
                            ))}
                        </div>

                        <div className="space-y-3">
                            {biasData.details.map((detail, idx) => (
                                <div key={idx} className="flex items-start gap-2 text-xs text-zinc-300">
                                    <span className="leading-snug">{detail}</span>
                                </div>
                            ))}
                        </div>
                    </div>

                    {/* Explainer Panel */}
                    <div className="p-6 rounded-2xl bg-zinc-900/30 border border-white/5 h-fit">
                        <h3 className="text-lg font-bold text-white mb-4">Event Logic</h3>

                        <div className="space-y-6">
                            <div className="space-y-2">
                                <div className="flex items-center gap-2 text-blue-400 text-xs font-bold uppercase tracking-wider">
                                    <ScanLine size={14} /> Liquidity Sweeps
                                </div>
                                <p className="text-xs text-zinc-400 leading-relaxed">
                                    Occurs when price breaks a swing high/low but fails to close beyond it.
                                    Often signals a reversal as stop orders are triggered.
                                </p>
                            </div>

                            <div className="space-y-2">
                                <div className="flex items-center gap-2 text-emerald-400 text-xs font-bold uppercase tracking-wider">
                                    <Layers size={14} /> Break of Structure (BOS)
                                </div>
                                <p className="text-xs text-zinc-400 leading-relaxed">
                                    Confirmed trend continuation when candle body closes beyond a previous pivot point.
                                </p>
                            </div>

                            <div className="space-y-2">
                                <div className="flex items-center gap-2 text-amber-400 text-xs font-bold uppercase tracking-wider">
                                    <AlertTriangle size={14} /> Fair Value Gaps (FVG)
                                </div>
                                <p className="text-xs text-zinc-400 leading-relaxed">
                                    Inefficiencies where price moved too quickly, leaving resting orders unfilled.
                                    Price often returns to these zones.
                                </p>
                            </div>
                        </div>
                    </div>

                </div>
            </div>
        </motion.div>
    );
};

export default LiquidityPage;
