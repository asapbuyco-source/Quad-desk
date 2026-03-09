import React, { useMemo } from 'react';
import { useStore } from '../store';
import { ShieldAlert, Crosshair, Target, Activity, Flame, ShieldCheck, Siren, Clock, Zap } from 'lucide-react';
import { motion } from 'framer-motion';

const SentinelEdgePage: React.FC = () => {
    const {
        liquidity,
        regime,
        darkPoolBias,
        market: { metrics }
    } = useStore();

    // Stage 1: Environment Definition
    const currentRegime = regime.regimeType;

    // Check Dark Pool Bias direction
    const biasDirection = darkPoolBias > 0.2 ? 'BULLISH' : darkPoolBias < -0.2 ? 'BEARISH' : 'NEUTRAL';
    const biasColor = biasDirection === 'BULLISH' ? 'text-emerald-400' : biasDirection === 'BEARISH' ? 'text-rose-400' : 'text-amber-400';

    const environmentValid = currentRegime === 'RANGING' || currentRegime === 'MEAN_REVERTING';

    // Stage 2: The Trap (Recent Liquidity Sweep)
    // Get the most recent sweep
    const recentSweep = useMemo(() => {
        if (!liquidity.sweeps || liquidity.sweeps.length === 0) return null;
        return liquidity.sweeps[0]; // Assuming they are sorted descending by time
    }, [liquidity.sweeps]);

    const isTrapTriggered = recentSweep !== null && (Date.now() - recentSweep.timestamp < 15 * 60 * 1000); // Trigger valid for 15 mins
    const trapDirection = recentSweep?.side === 'BUY' ? 'BEARISH' : 'BULLISH'; // Buy-side SWEEP = BEARISH setup, Sell-side SWEEP = BULLISH setup
    const trapColor = trapDirection === 'BULLISH' ? 'text-emerald-400 border-emerald-400/30' : 'text-rose-400 border-rose-400/30';

    // Stage 3: The Trigger (OFI & Z-Score)
    const ofi = Number(metrics.ofi) || 0;
    const zScore = Number(metrics.zScore) || 0;

    const ofiThresholdTriggered = trapDirection === 'BULLISH' ? ofi > 10 : ofi < -10;
    const zScoreConditionMet = trapDirection === 'BULLISH' ? zScore < -1.5 : zScore > 1.5;

    // Stage 4: The Verdict
    const calculateVerdict = () => {
        if (!environmentValid) {
            return {
                status: 'WAIT_REGIME',
                title: 'INVALID MARKET REGIME',
                desc: `Sentinel Strategy requires RANGING or MEAN_REVERTING regime. Current is ${currentRegime}. Do not trade.`,
                color: 'text-zinc-500 bg-zinc-900 border-zinc-800'
            };
        }

        if (!isTrapTriggered || !recentSweep) {
            return {
                status: 'SCANNING',
                title: 'SCANNING FOR TRAP',
                desc: 'Waiting for retail stop-losses to be swept (Liquidity Sweep).',
                color: 'text-amber-400 bg-amber-400/10 border-amber-400/30'
            };
        }

        if (!ofiThresholdTriggered) {
            return {
                status: 'WAIT_TRIGGER',
                title: `${trapDirection} SWEEP DETECTED. WAITING FOR OFI.`,
                desc: `Sweep at ${recentSweep.price}. Target OFI: ${trapDirection === 'BULLISH' ? '> +10' : '< -10'}. Current: ${ofi.toFixed(1)}`,
                color: trapDirection === 'BULLISH' ? 'text-emerald-400 bg-emerald-400/10 border-emerald-400/30' : 'text-rose-400 bg-rose-400/10 border-rose-400/30'
            };
        }

        // All conditions met
        return {
            status: 'EXECUTE',
            title: `EXECUTE ${trapDirection === 'BULLISH' ? 'LONG' : 'SHORT'}`,
            desc: `Setup Confirmed. Entry ~${metrics.price}. SL: ${recentSweep.price} (Sweep Extreme). Focus on VWAP for TP1.`,
            color: trapDirection === 'BULLISH' ? 'text-emerald-400 bg-emerald-400/20 border-emerald-400 font-bold shadow-[0_0_30px_rgba(52,211,153,0.3)]' : 'text-rose-400 bg-rose-400/20 border-rose-400 font-bold shadow-[0_0_30px_rgba(244,63,94,0.3)]'
        };
    };

    const verdict = calculateVerdict();

    return (
        <div className="h-full w-full overflow-y-auto p-4 lg:p-8 space-y-6">
            <header className="mb-8">
                <div className="flex items-center gap-3">
                    <Crosshair className="text-brand-accent w-8 h-8" />
                    <h1 className="text-3xl font-black tracking-tighter uppercase">Sentinel Edge Co-Pilot</h1>
                </div>
                <p className="text-zinc-400 text-sm font-mono mt-2">
                    Algorithmic execution assistant for the Quad-Desk Sentinel Strategy.
                </p>
            </header>

            {/* Stage 4: THE VERDICT (Placed at the top because it's the most important) */}
            <section>
                <div className={`p-8 rounded-2xl border-2 transition-all duration-500 flex flex-col items-center justify-center text-center gap-4 ${verdict.color}`}>
                    {verdict.status === 'EXECUTE' ? <AlertBlinker /> : <Target className="w-12 h-12 opacity-50" />}
                    <div>
                        <h2 className="text-3xl lg:text-5xl font-black tracking-tighter uppercase">{verdict.title}</h2>
                        <p className="mt-3 text-sm lg:text-lg font-mono opacity-80">{verdict.desc}</p>
                    </div>
                </div>
            </section>

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">

                {/* Stage 1: Environment */}
                <div className="fintech-card p-6 flex flex-col gap-4">
                    <div className="flex items-center gap-2 border-b border-white/10 pb-4">
                        <Activity className="text-zinc-400" size={20} />
                        <h3 className="font-bold text-lg">Stage 1: Environment</h3>
                    </div>

                    <div className="flex justify-between items-center">
                        <span className="text-zinc-500 font-mono text-xs uppercase">Market Regime</span>
                        <span className={`font-black ${environmentValid ? 'text-emerald-400' : 'text-rose-400'}`}>
                            {currentRegime || 'CALCULATING...'}
                        </span>
                    </div>

                    <div className="flex justify-between items-center">
                        <span className="text-zinc-500 font-mono text-xs uppercase">Dark Pool Bias</span>
                        <span className={`font-black tracking-wider ${biasColor}`}>
                            {biasDirection} ({darkPoolBias.toFixed(2)})
                        </span>
                    </div>

                    <div className="mt-auto pt-4 border-t border-white/5">
                        {environmentValid ? (
                            <div className="flex items-center gap-2 text-emerald-400 text-xs font-mono">
                                <ShieldCheck size={14} /> Conditions Optimal
                            </div>
                        ) : (
                            <div className="flex items-center gap-2 text-rose-400 text-xs font-mono">
                                <ShieldAlert size={14} /> Sub-optimal Regime
                            </div>
                        )}
                    </div>
                </div>

                {/* Stage 2: The Trap */}
                <div className="fintech-card p-6 flex flex-col gap-4">
                    <div className="flex items-center gap-2 border-b border-white/10 pb-4">
                        <Siren className="text-zinc-400" size={20} />
                        <h3 className="font-bold text-lg">Stage 2: The Trap</h3>
                    </div>

                    {isTrapTriggered && recentSweep ? (
                        <div className={`p-4 rounded border ${trapColor} flex flex-col gap-2`}>
                            <div className="flex justify-between items-center">
                                <span className="font-bold uppercase tracking-wider">{trapDirection} SETUP</span>
                                <Clock size={14} className="opacity-70" />
                            </div>
                            <span className="font-mono text-2xl">{recentSweep.price.toFixed(2)}</span>
                            <span className="text-xs opacity-70">
                                {recentSweep.side === 'BUY' ? 'Buy-side liquidity swept (Highs broken).' : 'Sell-side liquidity swept (Lows broken).'}
                            </span>
                        </div>
                    ) : (
                        <div className="flex-1 flex items-center justify-center border border-dashed border-zinc-800 rounded">
                            <span className="text-zinc-600 font-mono text-sm uppercase">No active sweeps</span>
                        </div>
                    )}
                </div>

                {/* Stage 3: The Trigger */}
                <div className="fintech-card p-6 flex flex-col gap-4">
                    <div className="flex items-center gap-2 border-b border-white/10 pb-4">
                        <Zap className="text-zinc-400" size={20} />
                        <h3 className="font-bold text-lg">Stage 3: The Trigger</h3>
                    </div>

                    <div className="space-y-4">
                        <div>
                            <div className="flex justify-between items-center mb-1">
                                <span className="text-zinc-500 font-mono text-xs uppercase">OFI (Trigger)</span>
                                <span className={`font-bold font-mono ${ofi > 10 ? 'text-emerald-400' : ofi < -10 ? 'text-rose-400' : 'text-zinc-300'}`}>
                                    {ofi.toFixed(1)}
                                </span>
                            </div>
                            {/* Simple visual bar for OFI */}
                            <div className="h-1.5 w-full bg-zinc-900 rounded-full overflow-hidden flex">
                                <div className="h-full bg-emerald-400 transition-all" style={{ width: `${Math.min(Math.max(ofi, 0) * 2, 50)}%`, marginLeft: '50%' }} />
                                <div className="h-full bg-rose-400 transition-all" style={{ width: `${Math.min(Math.max(-ofi, 0) * 2, 50)}%`, float: 'right' }} />
                            </div>
                        </div>

                        <div>
                            <div className="flex justify-between items-center mb-1">
                                <span className="text-zinc-500 font-mono text-xs uppercase">Z-Score (Stretch)</span>
                                <span className={`font-bold font-mono ${zScoreConditionMet ? (zScore > 0 ? 'text-rose-400' : 'text-emerald-400') : 'text-zinc-300'}`}>
                                    {zScore.toFixed(2)}
                                </span>
                            </div>
                            {/* Simple visual bar for Z-Score (-3 to 3 scale) */}
                            <div className="h-1.5 w-full bg-zinc-900 rounded-full overflow-hidden relative">
                                <div className="absolute left-1/2 top-0 bottom-0 w-px bg-zinc-700" />
                                <div
                                    className={`absolute top-0 bottom-0 ${zScore > 0 ? 'bg-rose-400' : 'bg-emerald-400'} transition-all`}
                                    style={{
                                        left: zScore < 0 ? `${50 - Math.min((Math.abs(zScore) / 3) * 50, 50)}%` : '50%',
                                        width: `${Math.min((Math.abs(zScore) / 3) * 50, 50)}%`
                                    }}
                                />
                            </div>
                        </div>
                    </div>
                </div>

            </div>
        </div>
    );
};

const AlertBlinker = () => (
    <motion.div
        animate={{ opacity: [1, 0.4, 1] }}
        transition={{ repeat: Infinity, duration: 0.8 }}
    >
        <Flame className="w-16 h-16 drop-shadow-[0_0_15px_rgba(255,255,255,0.5)]" />
    </motion.div>
);

export default SentinelEdgePage;
