import React from 'react';
import { MarketMetrics } from '../types';
import { Activity, Skull, TrendingUp, Anchor, ArrowRight, TrendingDown, Waves, Zap, Layers, GitMerge } from 'lucide-react';
import { motion as m } from 'framer-motion';
import { useStore } from '../store';

const motion = m as any;

interface OrderFlowMetricsProps {
    metrics: MarketMetrics;
}

// ── Shared micro-card shell ────────────────────────────────────────────────────
const MetricCard: React.FC<{ children: React.ReactNode; className?: string }> = ({ children, className = '' }) => (
    <div className={`fintech-card p-3 flex flex-col justify-between relative overflow-hidden h-full ${className}`}>
        {children}
    </div>
);

const CardLabel: React.FC<{ icon: React.ReactNode; label: string; sub?: string }> = ({ icon, label, sub }) => (
    <div className="flex flex-col gap-0">
        <span className="text-[9px] font-bold text-slate-400 uppercase tracking-widest flex items-center gap-1">
            {icon}{label}
        </span>
        {sub && <span className="text-[9px] text-slate-600 font-mono truncate">{sub}</span>}
    </div>
);

const StatusPill: React.FC<{ children: React.ReactNode; color: string; bg: string }> = ({ children, color, bg }) => (
    <div className={`px-1.5 py-0.5 rounded border border-white/5 text-[8px] font-black uppercase tracking-wider flex items-center gap-0.5 shrink-0 ${color} ${bg}`}>
        {children}
    </div>
);

const BiBar: React.FC<{ value: number; maxPct?: number; colorPos?: string; colorNeg?: string }> = ({
    value, maxPct = 50, colorPos = 'bg-emerald-500', colorNeg = 'bg-rose-500'
}) => {
    const pct = Math.min(Math.abs(value), maxPct);
    return (
        <div className="h-1 w-full bg-slate-800 rounded-full overflow-hidden flex relative mt-auto">
            <div className="absolute left-1/2 top-0 bottom-0 w-px bg-white/20 z-10" />
            <motion.div
                animate={{
                    width: `${pct}%`,
                    left: value > 0 ? '50%' : 'auto',
                    right: value < 0 ? '50%' : 'auto',
                }}
                className={`absolute top-0 bottom-0 ${value >= 0 ? colorPos : colorNeg}`}
            />
        </div>
    );
};

// ── 1. CVD / Whale Hunter ─────────────────────────────────────────────────────
const CvdCard: React.FC<{ metrics: MarketMetrics }> = ({ metrics }) => {
    const cvd = metrics.institutionalCVD;
    const ctx = metrics.cvdContext?.value || 0;
    const interp = metrics.cvdContext?.interpretation || 'NEUTRAL';
    const div = metrics.cvdContext?.divergence || 'NONE';

    let sc = 'text-slate-400'; let sb = 'bg-slate-500/10'; let si = <Activity size={10} />;
    if (interp === 'REAL STRENGTH') { sc = 'text-emerald-400'; sb = 'bg-emerald-500/10'; si = <TrendingUp size={10} />; }
    else if (interp === 'REAL WEAKNESS') { sc = 'text-rose-400'; sb = 'bg-rose-500/10'; si = <TrendingDown size={10} />; }
    else if (interp === 'ABSORPTION' || interp === 'DISTRIBUTION') { sc = 'text-amber-400'; sb = 'bg-amber-500/10'; si = <Anchor size={10} />; }

    return (
        <MetricCard>
            <div className="flex items-start justify-between">
                <CardLabel
                    icon={<Anchor size={10} className={cvd > 0 ? 'text-emerald-400' : 'text-rose-400'} />}
                    label="Cum. Delta"
                    sub="Aggressive Vol."
                />
                <StatusPill color={sc} bg={sb}>{si}{interp.split(' ')[0]}</StatusPill>
            </div>

            <div className="flex items-baseline gap-1 my-1">
                <span className={`text-xl font-mono font-black tracking-tighter leading-none ${cvd > 0 ? 'text-emerald-500' : 'text-rose-500'}`}>
                    {cvd > 0 ? '+' : ''}{cvd.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                </span>
            </div>

            {div !== 'NONE' && (
                <div className="text-[8px] font-bold text-amber-500 uppercase bg-amber-500/10 px-1.5 py-0.5 rounded border border-amber-500/20 text-center mb-1 truncate">
                    ⚠ {div === 'BULLISH_ABSORPTION' ? 'Hidden Buy' : 'Hidden Sell'}
                </div>
            )}

            <BiBar value={ctx} />
            <div className="flex justify-between text-[8px] font-mono text-slate-700 mt-0.5">
                <span>Sell</span><span>Buy</span>
            </div>
        </MetricCard>
    );
};

// ── 2. Regime ────────────────────────────────────────────────────────────────
const RegimeCard: React.FC<{ metrics: MarketMetrics }> = ({ metrics }) => {
    const { regime } = metrics;

    let icon = <Waves size={20} />;
    let title = 'Mean Rev.'; let color = 'text-blue-400'; let bg = 'bg-blue-500/10';
    if (regime === 'TRENDING') { icon = <TrendingUp size={20} />; title = 'Momentum'; color = 'text-emerald-400'; bg = 'bg-emerald-500/10'; }
    else if (regime === 'HIGH_VOLATILITY') { icon = <Zap size={20} />; title = 'Expansion'; color = 'text-amber-400'; bg = 'bg-amber-500/10'; }

    const lockLabel = regime === 'TRENDING' ? 'FADES LOCKED' : regime === 'MEAN_REVERTING' ? 'TREND LOCKED' : 'ALL ACTIVE';

    return (
        <MetricCard>
            <div className="flex items-start justify-between">
                <CardLabel
                    icon={<Activity size={10} className={color} />}
                    label="Regime"
                    sub="HMM State"
                />
                <div className={`p-1.5 rounded-lg ${bg} ${color}`}>{icon}</div>
            </div>

            <div className="my-1">
                <div className={`text-base font-bold leading-none ${color}`}>{title}</div>
                <div className="text-[9px] text-slate-500 font-mono uppercase">{regime?.replace('_', ' ')}</div>
            </div>

            <div className="flex items-center justify-between border-t border-white/5 pt-1.5 mt-auto">
                <span className="text-[8px] text-slate-600 uppercase">Strategy</span>
                <span className="text-[8px] font-bold text-white bg-white/10 px-1.5 py-0.5 rounded">{lockLabel}</span>
            </div>
        </MetricCard>
    );
};

// ── 3. OFI / Book Imbalance ───────────────────────────────────────────────────
const OfiCard: React.FC<{ metrics: MarketMetrics }> = ({ metrics }) => {
    const ofiColor = metrics.ofi > 0 ? 'text-trade-bid' : metrics.ofi < 0 ? 'text-trade-ask' : 'text-slate-500';
    const ofiBg = metrics.ofi > 0 ? 'bg-trade-bid' : metrics.ofi < 0 ? 'bg-trade-ask' : 'bg-slate-500';
    const domLabel = Math.abs(metrics.ofi) > 50 ? (metrics.ofi > 0 ? 'Agg. Buying' : 'Agg. Selling') : 'Balanced';
    const signalState = Math.abs(metrics.ofi) > 30 ? (metrics.ofi > 0 ? 'BULL VALID' : 'BEAR VALID') : 'NEUTRAL';

    return (
        <MetricCard>
            <div className="flex items-start justify-between">
                <CardLabel
                    icon={<Activity size={10} className={ofiColor} />}
                    label="Book Imbalance"
                    sub={domLabel}
                />
                <span className={`text-xl font-mono font-black tracking-tighter leading-none ${ofiColor}`}>
                    {metrics.ofi > 0 ? '+' : ''}{metrics.ofi.toFixed(1)}%
                </span>
            </div>

            <BiBar value={metrics.ofi / 2} colorPos={ofiBg} colorNeg={ofiBg} />
            <div className="flex justify-between text-[8px] font-mono text-slate-700 mt-0.5">
                <span>Sell</span><span>Buy</span>
            </div>

            <div className="flex items-center justify-between border-t border-white/5 pt-1.5 mt-1">
                <div className="flex items-center gap-1 text-[8px] text-slate-500 uppercase">
                    Signal<ArrowRight size={8} className="text-slate-700" />
                </div>
                <div className={`text-[8px] font-bold px-1.5 py-0.5 rounded border ${signalState !== 'NEUTRAL' ? 'border-emerald-500/20 bg-emerald-500/10 text-emerald-400' : 'border-zinc-700 bg-zinc-800/50 text-zinc-500'}`}>
                    {signalState}
                </div>
                <div className="flex items-center gap-1 opacity-50 hover:opacity-100 transition-opacity cursor-help" title="Flow Toxicity (HFT Activity)">
                    <Skull size={9} className="text-zinc-500" />
                    <span className="text-[8px] font-mono text-zinc-600">TOX:{metrics.toxicity}</span>
                </div>
            </div>
        </MetricCard>
    );
};

// ── 4. COFI ───────────────────────────────────────────────────────────────────
const CofiCard: React.FC = () => {
    const cofi = useStore(s => s.cofi);
    const isPos = cofi >= 0;
    const color = isPos ? 'text-emerald-400' : 'text-rose-400';
    const Icon = isPos ? TrendingUp : TrendingDown;
    const pct = Math.min(Math.abs(cofi) / 500 * 100, 100);

    return (
        <MetricCard>
            <div className="absolute top-0 right-0 p-3 opacity-[0.03] pointer-events-none">
                <Layers size={56} />
            </div>
            <div className="flex items-start justify-between z-10">
                <CardLabel
                    icon={<Layers size={10} className={color} />}
                    label="Cum. OFI"
                    sub="Session Flow"
                />
                <StatusPill color={color} bg={isPos ? 'bg-emerald-500/10' : 'bg-rose-500/10'}>
                    <Icon size={8} />{isPos ? 'BUY' : 'SELL'}
                </StatusPill>
            </div>

            <div className="flex items-baseline gap-1 my-1 z-10">
                <span className={`text-xl font-mono font-black tracking-tighter leading-none ${color}`}>
                    {cofi > 0 ? '+' : ''}{cofi.toFixed(1)}
                </span>
                <span className="text-[8px] text-zinc-600 uppercase">Δ OFI</span>
            </div>

            <div className="z-10">
                <BiBar value={pct / 2 * (isPos ? 1 : -1)} />
                <div className="flex justify-between text-[8px] font-mono text-slate-700 mt-0.5">
                    <span>Sell</span><span>Buy</span>
                </div>
            </div>
        </MetricCard>
    );
};

// ── 5. MTF OFI ────────────────────────────────────────────────────────────────
const MtfCard: React.FC = () => {
    const ofiHistory = useStore(s => s.ofiHistory);
    const n = ofiHistory.length;
    const avg = (arr: number[]) => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
    const short = avg(ofiHistory.slice(-5));
    const mid = avg(ofiHistory.slice(-20));
    const long = avg(ofiHistory.slice(-60));
    const classify = (v: number) => v > 5 ? 'BULL' : v < -5 ? 'BEAR' : 'NEUT';
    const sClass = classify(short); const mClass = classify(mid); const lClass = classify(long);
    const allBull = sClass === 'BULL' && mClass === 'BULL' && lClass === 'BULL';
    const allBear = sClass === 'BEAR' && mClass === 'BEAR' && lClass === 'BEAR';
    const converge = allBull ? 'BULLISH' : allBear ? 'BEARISH' : 'MIXED';
    const tc = (c: string) => c === 'BULL' ? 'text-emerald-400' : c === 'BEAR' ? 'text-rose-400' : 'text-zinc-500';
    const bc = (c: string) => c === 'BULL' ? 'bg-emerald-500' : c === 'BEAR' ? 'bg-rose-500' : 'bg-zinc-600';
    const rows = [{ l: '5B', v: short, c: sClass }, { l: '20B', v: mid, c: mClass }, { l: '60B', v: long, c: lClass }];

    return (
        <MetricCard>
            <div className="absolute top-0 right-0 p-3 opacity-[0.03] pointer-events-none">
                <GitMerge size={56} />
            </div>
            <div className="flex items-start justify-between z-10">
                <CardLabel
                    icon={<GitMerge size={10} className="text-purple-400" />}
                    label="MTF OFI"
                    sub="Convergence"
                />
                <StatusPill
                    color={converge === 'BULLISH' ? 'text-emerald-400' : converge === 'BEARISH' ? 'text-rose-400' : 'text-zinc-400'}
                    bg={converge === 'BULLISH' ? 'bg-emerald-500/10' : converge === 'BEARISH' ? 'bg-rose-500/10' : 'bg-zinc-800'}
                >
                    {converge === 'BULLISH' || converge === 'BEARISH' ? '⚡' : ''}{converge}
                </StatusPill>
            </div>

            <div className="mt-1.5 space-y-1.5 z-10 flex-1">
                {n < 5 ? (
                    <p className="text-[9px] text-zinc-600 text-center py-1">Collecting…</p>
                ) : rows.map(({ l, v, c }) => (
                    <div key={l}>
                        <div className="flex justify-between items-center text-[9px] font-mono mb-0.5">
                            <span className="text-zinc-600">{l}</span>
                            <span className={`font-bold ${tc(c)}`}>{v > 0 ? '+' : ''}{v.toFixed(1)} <span className="text-[7px]">{c}</span></span>
                        </div>
                        <div className="h-0.5 bg-slate-800 rounded-full overflow-hidden relative">
                            <div className="absolute left-1/2 top-0 bottom-0 w-px bg-white/10 z-10" />
                            <motion.div
                                animate={{ width: `${Math.min(Math.abs(v) / 2, 50)}%`, left: v > 0 ? '50%' : 'auto', right: v < 0 ? '50%' : 'auto' }}
                                className={`absolute top-0 bottom-0 ${bc(c)}`}
                            />
                        </div>
                    </div>
                ))}
            </div>
        </MetricCard>
    );
};

// ── Main Export ───────────────────────────────────────────────────────────────
const OrderFlowMetrics: React.FC<OrderFlowMetricsProps> = ({ metrics }) => (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2.5 sm:gap-3 auto-rows-[minmax(145px,auto)] lg:auto-rows-auto lg:h-[168px]">
        <CvdCard metrics={metrics} />
        <RegimeCard metrics={metrics} />
        <OfiCard metrics={metrics} />
        <CofiCard />
        <div className="col-span-2 sm:col-span-1 lg:col-span-1 h-full">
            <MtfCard />
        </div>
    </div>
);

export default OrderFlowMetrics;