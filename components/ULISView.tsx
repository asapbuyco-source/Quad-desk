import React, { useEffect, useRef, useMemo } from 'react';
import { motion as m } from 'framer-motion';
import { useStore } from '../store';
import {
    Globe2, Layers, Activity, BrainCircuit, AlertTriangle,
    Zap, TrendingUp, Radio, Shield, Info, Cpu
} from 'lucide-react';
import { RadarChart, Radar, PolarGrid, PolarAngleAxis, ResponsiveContainer, Tooltip } from 'recharts';

const motion = m as any;

// ─── Helpers ────────────────────────────────────────────────────────────────

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const normalize = (v: number, lo: number, hi: number) => clamp((v - lo) / (hi - lo), 0, 1);

// ─── Score Badge ─────────────────────────────────────────────────────────────

const ScoreBadge: React.FC<{ value: number; label: string; desc?: string }> = ({ value, label, desc }) => {
    const pct = clamp(value, 0, 1);
    const color = pct > 0.7 ? '#ef4444' : pct > 0.4 ? '#f59e0b' : '#10b981';
    const textColor = pct > 0.7 ? 'text-red-400' : pct > 0.4 ? 'text-amber-400' : 'text-emerald-400';
    return (
        <div className="flex flex-col gap-1">
            <div className="flex justify-between items-center text-[10px] font-mono">
                <span className="text-zinc-500 uppercase tracking-wider font-bold">{label}</span>
                <span className={`font-black ${textColor}`}>{(pct * 100).toFixed(0)}</span>
            </div>
            <div className="h-1.5 rounded-full bg-white/10 overflow-hidden">
                <motion.div
                    className="h-full rounded-full"
                    style={{ background: color }}
                    initial={{ width: 0 }}
                    animate={{ width: `${pct * 100}%` }}
                    transition={{ duration: 1.2, ease: 'easeOut' }}
                />
            </div>
            {desc && <span className="text-[9px] text-zinc-600 font-mono">{desc}</span>}
        </div>
    );
};

// ─── Section Header ───────────────────────────────────────────────────────────

const SectionHeader: React.FC<{ icon: React.ReactNode; title: string; sub?: string; accent?: string }> = ({
    icon, title, sub, accent = 'text-blue-400'
}) => (
    <div className="flex items-center gap-3 mb-5">
        <div className={`p-2.5 rounded-xl bg-white/5 border border-white/10 ${accent}`}>{icon}</div>
        <div>
            <h2 className="text-base font-black text-white uppercase tracking-widest leading-none">{title}</h2>
            {sub && <p className="text-zinc-500 text-[10px] font-mono mt-0.5">{sub}</p>}
        </div>
    </div>
);

// ─── Master Heatmap Canvas ────────────────────────────────────────────────────

const MasterHeatmapCanvas: React.FC<{
    price: number;
    levels: Array<{ price: number; size: number }>;
    asks: Array<{ price: number; size: number }>;
    bids: Array<{ price: number; size: number }>;
    reflexivity: number;
}> = ({ price, levels, asks, bids, reflexivity }) => {
    const canvasRef = useRef<HTMLCanvasElement>(null);

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas || price <= 0) return;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        const W = canvas.width;
        const H = canvas.height;
        ctx.clearRect(0, 0, W, H);

        // Background
        ctx.fillStyle = '#09090b';
        ctx.fillRect(0, 0, W, H);

        // Price range: ±2% from current price
        const range = price * 0.02;
        const minP = price - range;
        const maxP = price + range;
        const cols = 40; // time columns (simulated historical)

        // gather liquidity by price bucket
        const buckets = 32;
        const bucketSize = (maxP - minP) / buckets;
        const liquidityMap: number[] = new Array(buckets).fill(0);

        // Orderbook depth → visible liquidity
        [...asks, ...bids].forEach(level => {
            const idx = Math.floor((level.price - minP) / bucketSize);
            if (idx >= 0 && idx < buckets) {
                liquidityMap[idx] += level.size;
            }
        });

        // Key levels (heatmap data from backend)
        levels.forEach(level => {
            const idx = Math.floor((level.price - minP) / bucketSize);
            if (idx >= 0 && idx < buckets) {
                liquidityMap[idx] += level.size * 3; // weight institutional levels higher
            }
        });

        const maxLiq = Math.max(...liquidityMap, 1);

        const colW = W / cols;
        const rowH = H / buckets;

        // Draw heatmap columns (simulate time progression with slight noise)
        for (let col = 0; col < cols; col++) {
            const timeFactor = col / cols; // older = lower intensity
            for (let row = 0; row < buckets; row++) {
                const bucketIdx = buckets - 1 - row; // flip: top = high price
                const rawLiq = liquidityMap[bucketIdx];
                const norm = rawLiq / maxLiq;
                const noise = (Math.random() * 0.15 - 0.075) * (1 - timeFactor);
                const liq = clamp(norm + noise, 0, 1) * timeFactor;

                if (liq < 0.04) continue; // skip near-zero

                let r, g, b, a;

                // CASCADE EPICENTER (reflexivity zone around current price)
                const bucketPrice = minP + bucketIdx * bucketSize + bucketSize / 2;
                const distFromPrice = Math.abs(bucketPrice - price) / range;
                const isCascadeZone = reflexivity > 0.7 && distFromPrice < 0.15;

                if (isCascadeZone) {
                    // White → cascade epicenter
                    r = 255; g = 255; b = 255; a = liq * 0.9;
                } else if (norm > 0.7) {
                    // Yellow → strong visible liquidity wall
                    r = 250; g = 200; b = 50; a = liq * 0.85;
                } else if (norm > 0.4) {
                    // Red → liquidation cluster
                    r = 239; g = 68; b = 68; a = liq * 0.75;
                } else if (reflexivity > 0.5 && distFromPrice < 0.3) {
                    // Purple → reflexivity pressure zone
                    r = 168; g = 85; b = 247; a = liq * 0.7;
                } else if (distFromPrice > 0.6) {
                    // Blue → macro liquidity (distant levels)
                    r = 59; g = 130; b = 246; a = liq * 0.6;
                } else {
                    // Orange → moderate cluster
                    r = 249; g = 115; b = 22; a = liq * 0.55;
                }

                ctx.fillStyle = `rgba(${r},${g},${b},${a})`;
                ctx.fillRect(Math.floor(col * colW), Math.floor(row * rowH), Math.ceil(colW) + 1, Math.ceil(rowH) + 1);
            }
        }

        // Current price line
        const priceY = ((maxP - price) / (maxP - minP)) * H;
        ctx.strokeStyle = 'rgba(255,255,255,0.9)';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(0, priceY);
        ctx.lineTo(W, priceY);
        ctx.stroke();
        ctx.setLineDash([]);

        // Price label
        ctx.fillStyle = 'rgba(0,0,0,0.75)';
        ctx.fillRect(W - 70, priceY - 10, 68, 18);
        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 10px monospace';
        ctx.textAlign = 'right';
        ctx.fillText(`$${price.toLocaleString(undefined, { maximumFractionDigits: 0 })}`, W - 4, priceY + 4);

        // Y axis price labels (top & bottom)
        ctx.textAlign = 'left';
        ctx.fillStyle = 'rgba(255,255,255,0.4)';
        ctx.font = '9px monospace';
        ctx.fillText(`$${maxP.toLocaleString(undefined, { maximumFractionDigits: 0 })}`, 4, 10);
        ctx.fillText(`$${minP.toLocaleString(undefined, { maximumFractionDigits: 0 })}`, 4, H - 4);

        // "NOW" label
        ctx.fillStyle = 'rgba(255,255,255,0.5)';
        ctx.font = 'bold 8px monospace';
        ctx.textAlign = 'right';
        ctx.fillText('NOW →', W - 4, H - 4);

    }, [price, levels, asks, bids, reflexivity]);

    return (
        <canvas
            ref={canvasRef}
            width={600}
            height={220}
            className="w-full h-full rounded-xl"
            style={{ imageRendering: 'pixelated' }}
        />
    );
};

// ─── Reflexivity Gauge (SVG arc) ──────────────────────────────────────────────

const ReflexivityGauge: React.FC<{ ratio: number }> = ({ ratio }) => {
    const clamped = clamp(ratio, 0, 2);
    const pct = clamped / 2; // 0→1 across gauge

    const cx = 110, cy = 95, r = 78;
    const toRad = (d: number) => ((d - 90) * Math.PI) / 180;

    const arcPath = (startDeg: number, endDeg: number) => {
        const sx = cx + r * Math.cos(toRad(startDeg));
        const sy = cy + r * Math.sin(toRad(startDeg));
        const ex = cx + r * Math.cos(toRad(endDeg));
        const ey = cy + r * Math.sin(toRad(endDeg));
        const large = endDeg - startDeg > 180 ? 1 : 0;
        return `M${sx},${sy} A${r},${r} 0 ${large},1 ${ex},${ey}`;
    };

    // 180°→360° sweep
    const needleAngle = 180 + pct * 180;
    const nRad = toRad(needleAngle);
    const nx = cx + (r - 12) * Math.cos(nRad);
    const ny = cy + (r - 12) * Math.sin(nRad);

    const gaugeColor = clamped > 1 ? '#ef4444' : clamped > 0.5 ? '#f59e0b' : '#10b981';
    const label = clamped > 1 ? 'CASCADE RISK' : clamped > 0.5 ? 'LEVERAGE BUILDING' : 'STABLE';

    return (
        <div className="flex flex-col items-center">
            <svg width={220} height={115} viewBox="0 0 220 115">
                <path d={arcPath(180, 360)} stroke="#1f2937" strokeWidth={12} fill="none" strokeLinecap="round" />
                <path d={arcPath(180, 240)} stroke="#10b98133" strokeWidth={12} fill="none" strokeLinecap="round" />
                <path d={arcPath(240, 300)} stroke="#f59e0b33" strokeWidth={12} fill="none" strokeLinecap="round" />
                <path d={arcPath(300, 360)} stroke="#ef444433" strokeWidth={12} fill="none" strokeLinecap="round" />
                {/* Active fill */}
                <path d={arcPath(180, 180 + pct * 180)} stroke={gaugeColor} strokeWidth={12} fill="none" strokeLinecap="round" />
                {/* Needle */}
                <line x1={cx} y1={cy} x2={nx} y2={ny} stroke={gaugeColor} strokeWidth={3} strokeLinecap="round" />
                <circle cx={cx} cy={cy} r={5} fill={gaugeColor} />
                {/* Value */}
                <text x={cx} y={cy + 18} textAnchor="middle" fill={gaugeColor} fontSize={20} fontWeight="900">
                    {clamped.toFixed(2)}
                </text>
                <text x={cx} y={cy + 32} textAnchor="middle" fill="#6b7280" fontSize={8} fontWeight="bold">{label}</text>
                {/* Zone labels */}
                <text x={22} y={108} fill="#10b981" fontSize={8} fontWeight="bold">STABLE</text>
                <text x={cx - 12} y={18} fill="#f59e0b" fontSize={8} fontWeight="bold">BUILD</text>
                <text x={178} y={108} fill="#ef4444" fontSize={8} fontWeight="bold">CASCADE</text>
            </svg>
            <div className="grid grid-cols-3 gap-2 text-[9px] font-mono w-full mt-1">
                <div className="text-center text-emerald-400/70">{'<0.5'} Stable</div>
                <div className="text-center text-amber-400/70">0.5–1.0 Building</div>
                <div className="text-center text-red-400/70">{'>1.0'} Cascade</div>
            </div>
        </div>
    );
};

// ─── NLF Forecast Canvas ──────────────────────────────────────────────────────

const NLFCanvas: React.FC<{
    price: number;
    zScore: number;
    bayesian: number;
    ofi: number;
}> = ({ price, zScore, bayesian, ofi }) => {
    const canvasRef = useRef<HTMLCanvasElement>(null);

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas || price <= 0) return;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        const W = canvas.width;
        const H = canvas.height;
        ctx.clearRect(0, 0, W, H);

        ctx.fillStyle = '#09090b';
        ctx.fillRect(0, 0, W, H);

        // Build predicted liquidity field
        const steps = 20; // future time steps
        const priceBands = 24;
        const colW = W / steps;
        const rowH = H / priceBands;
        const range = price * 0.015;

        // Bias: positive bayesian + ofi → price moves up (toward lower bucket indexes = higher prices)
        const directionBias = (bayesian - 0.5) * 2 + ofi / 100;
        const meanReversionForce = -zScore * 0.3;
        const totalBias = clamp(directionBias + meanReversionForce, -1, 1);

        for (let col = 0; col < steps; col++) {
            const tFactor = (col + 1) / steps;
            // Expected price drift
            const expectedDrift = totalBias * range * tFactor;
            const uncertainty = range * 0.4 * tFactor;

            for (let row = 0; row < priceBands; row++) {
                const bandMid = priceBands / 2 - row; // positive = above price
                const bucketPrice = bandMid * (range * 2 / priceBands);
                const dist = Math.abs(bucketPrice - expectedDrift);
                const gaussianIntensity = Math.exp(-(dist * dist) / (2 * uncertainty * uncertainty));

                if (gaussianIntensity < 0.05) continue;

                // Color: green = bullish forecast zone, red = bearish
                const isBullZone = bucketPrice > 0;
                const r = isBullZone ? 16 : 239;
                const g = isBullZone ? 185 : 68;
                const b = isBullZone ? 129 : 68;
                ctx.fillStyle = `rgba(${r},${g},${b},${gaussianIntensity * 0.8})`;
                ctx.fillRect(Math.floor(col * colW), Math.floor(row * rowH), Math.ceil(colW) + 1, Math.ceil(rowH) + 1);
            }
        }

        // Current price center line
        ctx.strokeStyle = 'rgba(255,255,255,0.6)';
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(0, H / 2);
        ctx.lineTo(W, H / 2);
        ctx.stroke();
        ctx.setLineDash([]);

        // Labels
        ctx.fillStyle = 'rgba(255,255,255,0.4)';
        ctx.font = 'bold 9px monospace';
        ctx.textAlign = 'left';
        ctx.fillText(`+${(range).toFixed(0)}`, 4, 10);
        ctx.fillText(`-${(range).toFixed(0)}`, 4, H - 4);
        ctx.textAlign = 'right';
        ctx.fillText('T+20 →', W - 4, H - 4);

        // Bias label
        const biasColor = totalBias > 0.2 ? '#10b981' : totalBias < -0.2 ? '#ef4444' : '#f59e0b';
        ctx.fillStyle = biasColor;
        ctx.font = 'bold 10px monospace';
        ctx.textAlign = 'left';
        ctx.fillText(totalBias > 0.2 ? '▲ BULLISH FIELD' : totalBias < -0.2 ? '▼ BEARISH FIELD' : '↔ NEUTRAL FIELD', 4, H / 2 - 5);

    }, [price, zScore, bayesian, ofi]);

    return (
        <canvas
            ref={canvasRef}
            width={500}
            height={160}
            className="w-full h-full rounded-xl"
            style={{ imageRendering: 'pixelated' }}
        />
    );
};

// ─── Signal Badge ─────────────────────────────────────────────────────────────

const SignalBadge: React.FC<{ active: boolean; label: string; sub: string; color: string; icon: React.ReactNode }> = ({
    active, label, sub, color, icon
}) => (
    <div className={`
        flex items-center gap-3 p-4 rounded-xl border transition-all duration-500
        ${active
            ? `border-current ${color} bg-current/5 shadow-[0_0_24px_currentColor] shadow-current/20`
            : 'border-white/5 bg-white/[0.02] text-zinc-600'
        }
    `}>
        <div className={`p-2 rounded-lg ${active ? 'bg-current/10' : 'bg-white/5'}`}>{icon}</div>
        <div>
            <div className={`text-xs font-black uppercase tracking-widest ${active ? '' : 'text-zinc-600'}`}>{label}</div>
            <div className={`text-[9px] font-mono mt-0.5 ${active ? 'opacity-70' : 'text-zinc-700'}`}>{sub}</div>
        </div>
        {active && (
            <div className="ml-auto flex items-center gap-1.5">
                <span className="relative flex h-2 w-2">
                    <span className="animate-ping absolute h-full w-full rounded-full bg-current opacity-75" />
                    <span className="relative inline-flex h-2 w-2 rounded-full bg-current" />
                </span>
                <span className="text-[8px] font-bold uppercase tracking-widest opacity-70">ACTIVE</span>
            </div>
        )}
    </div>
);

// ─── ALDE × ULIS Hybrid Verdict Engine ─────────────────────────────────────
// Merges ALDE's principled liquidity vector, market state classifier, sigmoid
// cascade risk and strict AND-gates with ULIS's Bayesian posterior, CVD,
// reasoning chain, entry/invalidation and 8-type verdict granularity.

type VerdictType = 'STRONG_LONG' | 'LONG' | 'NEUTRAL' | 'SHORT' | 'STRONG_SHORT' | 'AVOID' | 'BREAKOUT_WATCH' | 'UNWIND';
type RiskLevel = 'LOW' | 'MODERATE' | 'HIGH' | 'EXTREME';
type MarketState = 'TRENDING' | 'RANGE' | 'UNSTABLE';

interface VerdictLine {
    symbol: '✓' | '⚠' | '✗' | '→' | '◈';
    text: string;
    weight: 'normal' | 'strong' | 'weak';
}

interface AIVerdict {
    verdict: VerdictType;
    confidence: number;          // 0–100 (ALDE confidence formula)
    riskLevel: RiskLevel;
    reasoning: VerdictLine[];
    action: string;
    entryContext: string;
    invalidation: string;
    targets: string;
    biasStrength: number;        // |liquidityVector|
    regimeLabel: string;
    // ── ALDE additions ──────────────────────────────
    marketState: MarketState;    // TRENDING / RANGE / UNSTABLE
    liquidityVector: number;     // ULP − DLP, −1→+1
    liquidityTarget: number;     // nearest high-liq price level
    expectedMove: number;        // % move toward target
    aldeConfidence: number;      // raw 0–1 ALDE score
    cascadeRiskSigmoid: number;  // sigmoid cascade risk 0–1
    ulp: number;                 // Upward Liquidity Pressure
    dlp: number;                 // Downward Liquidity Pressure
}

// Sigmoid helper (ALDE spec §5)
const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));

const computeAIVerdict = ({
    scores,
    signals,
    ofi,
    zScore,
    bayesianPosterior,
    cvd,
    price,
    sweepCount,
    fvgCount,
    bosList,
    bids,
    asks,
}: {
    scores: any;
    signals: any;
    ofi: number;
    zScore: number;
    bayesianPosterior: number;
    cvd: number;
    price: number;
    sweepCount: number;
    fvgCount: number;
    bosList: any[];
    bids: any[];
    asks: any[];
}): AIVerdict => {

    // ══ PHASE 1 — Feature Fusion ══════════════════════════════════════════════
    const ofiSignal = clamp(ofi / 40, -1, 1);
    const bayesSignal = (bayesianPosterior - 0.5) * 2;
    const leverageProxy = normalize(Math.abs(ofi), 0, 80);

    const totalBidSize = bids.reduce((a: number, b: any) => a + b.size, 0);
    const totalAskSize = asks.reduce((a: number, b: any) => a + b.size, 0);
    const totalDepth = totalBidSize + totalAskSize || 1;
    const bidFraction = totalBidSize / totalDepth;
    const askFraction = totalAskSize / totalDepth;

    const sweepBull = sweepCount > 0 && bayesSignal > 0 ? Math.min(sweepCount / 6, 1) : 0;
    const sweepBear = sweepCount > 0 && bayesSignal < 0 ? Math.min(sweepCount / 6, 1) : 0;

    // ══ PHASE 2 — ALDE Market State Classifier ════════════════════════════════
    // sigmoid(reflexivity×3 + fragility×2 + leverage×2 − 3) keeps midpoint at 0.5
    const cascadeRiskSigmoid = sigmoid(
        scores.reflexivityScore * 3 + scores.fragility * 2 + leverageProxy * 2 - 3
    );
    const trendAgreement =
        Math.sign(ofiSignal) === Math.sign(bayesSignal) &&
        Math.abs(ofiSignal) > 0.15 && Math.abs(bayesSignal) > 0.15;
    const marketState: MarketState =
        cascadeRiskSigmoid > 0.70 || scores.fragility > 0.65 ? 'UNSTABLE' :
            Math.abs(bayesSignal) > 0.25 && trendAgreement ? 'TRENDING' : 'RANGE';

    // ══ PHASE 3 — ALDE Liquidity Pressure Scores ═════════════════════════════
    const ulp = clamp(
        bidFraction * 0.30 +
        scores.nlfScore * scores.latentLiquidity * 0.30 +
        sweepBull * 0.15 +
        (scores.glrComponents?.stablecoins ?? 55) / 100 * 0.25,
        0, 1
    );
    const dlp = clamp(
        askFraction * 0.30 +
        (1 - scores.nlfScore) * scores.latentLiquidity * 0.30 +
        sweepBear * 0.15 +
        (1 - (scores.glrComponents?.etfFlows ?? 50) / 100) * 0.25,
        0, 1
    );

    // ══ PHASE 4 — Net Liquidity Vector (ALDE §4) ══════════════════════════════
    const liquidityVector = clamp(ulp - dlp, -1, 1);

    // ══ PHASE 5 — Cascade Risk already computed above (sigmoid, ALDE §5) ══════

    // ══ PHASE 6 — ALDE Confidence Score (§6) ═════════════════════════════════
    const ilihScore = normalize(totalDepth, 1000, 80000);
    const aldeConf0 =
        0.25 * ilihScore +
        0.20 * scores.glrScore +
        0.25 * scores.nlfScore +
        0.20 * (1 - scores.reflexivityScore) +
        0.10 * (1 - scores.fragility);

    // ══ PHASE 7 — Bayesian + CVD Overlay (ULIS) ══════════════════════════════
    const bayesBoost = (bayesianPosterior - 0.5) * 0.12 * Math.sign(liquidityVector || 1);
    const cvdBoost = clamp(cvd / 5000000, -0.06, 0.06) * Math.sign(liquidityVector || 1);
    const aldeConfidence = clamp(aldeConf0 + bayesBoost + cvdBoost, 0, 1);
    const confidencePct = Math.round(aldeConfidence * 100);

    // ══ PHASE 8 — ALDE Strict AND-Gate Verdicts + ULIS Granularity ═══════════
    const isHighVolatility = scores.fragility > 0.55 || scores.reflexivityScore > 0.55;
    const isMeanReversionPlay = Math.abs(zScore) > 1.8 && !trendAgreement;
    const isLiquidityVacuum = scores.visibleLiquidity < 0.35 && fvgCount > 1;
    const isBOSConfirmed = bosList.length > 0;

    let verdict: VerdictType;
    let regimeLabel: string;

    // Safety overrides (ALDE §7 WAIT/AVOID conditions)
    if (cascadeRiskSigmoid > 0.72 && scores.reflexivityScore > 0.55) {
        verdict = 'AVOID';
        regimeLabel = 'Cascade Risk Critical — Liquidity Singularity Active · STAND ASIDE';
    } else if (signals.cascadeWarning && isHighVolatility && cascadeRiskSigmoid > 0.55) {
        verdict = 'UNWIND';
        regimeLabel = 'Pre-Cascade: Volatility Expansion · Reduce Exposure Now';
    } else if (marketState === 'UNSTABLE' && !isMeanReversionPlay) {
        verdict = 'NEUTRAL';
        regimeLabel = 'Market Unstable — Cascade Sigmoid Elevated · Wait for Regime Stabilisation';
        // STRONG_LONG: ALDE strict 6-condition AND gate
    } else if (
        liquidityVector > 0.28 &&
        scores.nlfScore > 0.58 &&
        scores.glrScore > 0.50 &&
        cascadeRiskSigmoid < 0.45 &&
        aldeConfidence > 0.68 &&
        bayesianPosterior > 0.58
    ) {
        verdict = 'STRONG_LONG';
        regimeLabel = 'ALDE+ULIS Bullish Confluence · Full Alignment — High Probability Long';
        // LONG: relaxed conditions
    } else if (
        liquidityVector > 0.12 &&
        aldeConfidence > 0.58 &&
        cascadeRiskSigmoid < 0.62
    ) {
        verdict = 'LONG';
        regimeLabel = 'Bullish Bias · Liquidity Vector Positive — Moderate ALDE Alignment';
        // STRONG_SHORT: symmetric strict gate
    } else if (
        liquidityVector < -0.28 &&
        scores.nlfScore < 0.42 &&
        scores.glrScore < 0.50 &&
        cascadeRiskSigmoid < 0.45 &&
        aldeConfidence > 0.68 &&
        bayesianPosterior < 0.42
    ) {
        verdict = 'STRONG_SHORT';
        regimeLabel = 'ALDE+ULIS Bearish Confluence · Full Alignment — High Probability Short';
        // SHORT: relaxed
    } else if (
        liquidityVector < -0.12 &&
        aldeConfidence > 0.58 &&
        cascadeRiskSigmoid < 0.62
    ) {
        verdict = 'SHORT';
        regimeLabel = 'Bearish Bias · Liquidity Vector Negative — Moderate ALDE Alignment';
    } else if (isMeanReversionPlay) {
        verdict = zScore > 0 ? 'SHORT' : 'LONG';
        regimeLabel = 'Mean Reversion Play — Z-Score Extreme · Fade the Extension';
    } else if (isLiquidityVacuum && Math.abs(liquidityVector) > 0.12) {
        verdict = 'BREAKOUT_WATCH';
        regimeLabel = 'Liquidity Vacuum · Breakout Conditions Forming — Direction TBD';
    } else {
        verdict = 'NEUTRAL';
        regimeLabel = 'ALDE Equilibrium — Liquidity Vector Near Zero · No Actionable Edge';
    }

    // ── Liquidity Target + Expected Move (ALDE §8) ──────────────────────────
    const atrProxy = price * 0.008 * (1 + scores.fragility);
    const long = verdict.includes('LONG') || verdict === 'BREAKOUT_WATCH';
    const walls = (long ? asks : bids)
        .filter((l: any) => l.classification === 'WALL')
        .sort((a: any, b: any) => long ? a.price - b.price : b.price - a.price);
    const tpMult = verdict.includes('STRONG') ? 2.8 : 1.8;
    const liquidityTarget = walls[0] ? walls[0].price : price + (long ? 1 : -1) * atrProxy * tpMult;
    const expectedMove = ((liquidityTarget - price) / price) * 100;

    // ── Risk Level ──────────────────────────────────────────────────────────
    const riskLevel: RiskLevel =
        cascadeRiskSigmoid > 0.65 ? 'EXTREME' :
            isHighVolatility ? 'HIGH' :
                scores.fragility > 0.35 ? 'MODERATE' : 'LOW';

    // ══ PHASE 9 — ULIS Reasoning Chain ═══════════════════════════════════════
    const reasoning: VerdictLine[] = [];

    // ALDE Liquidity Vector (primary signal)
    reasoning.push({
        symbol: liquidityVector > 0.1 ? '✓' : liquidityVector < -0.1 ? '✗' : '→',
        text: `Liquidity Vector: ULP ${(ulp * 100).toFixed(0)} vs DLP ${(dlp * 100).toFixed(0)} → Net ${liquidityVector >= 0 ? '+' : ''}${liquidityVector.toFixed(3)} — ${Math.abs(liquidityVector) > 0.25 ? 'strong directional force' : Math.abs(liquidityVector) > 0.1 ? 'moderate liquidity bias' : 'equilibrium — no dominant force'}`,
        weight: Math.abs(liquidityVector) > 0.2 ? 'strong' : 'normal',
    });

    // ALDE Cascade Risk (sigmoid)
    reasoning.push({
        symbol: cascadeRiskSigmoid > 0.6 ? '⚠' : cascadeRiskSigmoid < 0.35 ? '✓' : '→',
        text: `Cascade Risk Index: ${(cascadeRiskSigmoid * 100).toFixed(0)}% — sigmoid(reflexivity·3 + fragility·2 + leverage·2 − 3) — ${cascadeRiskSigmoid > 0.7 ? 'CRITICAL: liquidation cascade imminent' : cascadeRiskSigmoid > 0.5 ? 'elevated: reduce size, tighten stops' : cascadeRiskSigmoid > 0.35 ? 'moderate — normal caution' : 'safe: structure stable'}`,
        weight: cascadeRiskSigmoid > 0.6 ? 'strong' : 'normal',
    });

    // ALDE Confidence Score
    reasoning.push({
        symbol: aldeConfidence > 0.65 ? '✓' : aldeConfidence < 0.45 ? '✗' : '→',
        text: `ALDE Confidence: ${confidencePct}% — ILIH ${(ilihScore * 100).toFixed(0)} · GLR ${(scores.glrScore * 100).toFixed(0)} · NLF ${(scores.nlfScore * 100).toFixed(0)} · Stability ${((1 - scores.reflexivityScore) * 100).toFixed(0)}% — ${aldeConfidence > 0.68 ? 'sufficient for high-conviction entry' : aldeConfidence > 0.58 ? 'moderate — reduce sizing' : 'insufficient — wait for alignment'}`,
        weight: aldeConfidence > 0.68 || aldeConfidence < 0.45 ? 'strong' : 'normal',
    });

    // OFI
    if (Math.abs(ofi) > 5) {
        reasoning.push({
            symbol: ofi > 0 ? '✓' : '✗',
            text: `Order Flow Imbalance ${ofi >= 0 ? '+' : ''}${ofi.toFixed(1)} — ${ofi > 15 ? 'strong institutional buy pressure' : ofi < -15 ? 'active sell-side absorption' : 'moderate directional bias'}`,
            weight: Math.abs(ofi) > 15 ? 'strong' : 'normal',
        });
    } else {
        reasoning.push({ symbol: '→', text: 'Order flow near equilibrium — no dominant side', weight: 'weak' });
    }

    // Bayesian
    reasoning.push({
        symbol: bayesianPosterior > 0.55 ? '✓' : bayesianPosterior < 0.45 ? '✗' : '→',
        text: `Bayesian P(Bull) = ${(bayesianPosterior * 100).toFixed(1)}% — ${bayesianPosterior > 0.65 ? 'strong bull probability, multi-factor evidence convergence' : bayesianPosterior < 0.35 ? 'high bear probability, bearish prior strengthened' : 'near-neutral evidence, prior unconfirmed'}`,
        weight: Math.abs(bayesianPosterior - 0.5) > 0.2 ? 'strong' : 'normal',
    });

    // CVD
    if (Math.abs(cvd) > 10000) {
        reasoning.push({
            symbol: cvd > 0 ? '✓' : '✗',
            text: `Institutional CVD ${cvd >= 0 ? '+' : ''}${(cvd / 1000).toFixed(0)}K — ${cvd > 50000 ? 'heavy accumulation' : cvd < -50000 ? 'significant distribution' : cvd > 0 ? 'mild accumulation' : 'mild distribution'}`,
            weight: Math.abs(cvd) > 80000 ? 'strong' : 'normal',
        });
    }

    // Z-Score
    if (Math.abs(zScore) > 1.5) {
        reasoning.push({
            symbol: zScore > 0 ? '⚠' : '✓',
            text: `Z-Score ${zScore.toFixed(2)}σ — ${Math.abs(zScore) > 2.5 ? 'extreme extension, mean-reversion probability high' : 'statistically displaced, reversion odds elevated'}`,
            weight: Math.abs(zScore) > 2.5 ? 'strong' : 'normal',
        });
    }

    // Sweeps / BOS
    if (sweepCount > 0 || isBOSConfirmed) {
        reasoning.push({
            symbol: '◈',
            text: `${sweepCount} liquidity sweeps${isBOSConfirmed ? ` + BOS confirmed (${bosList.length} breaks)` : ''} — ${sweepCount > 3 ? 'aggressive stop-hunt, reversal zone high probability' : sweepCount > 1 ? 'sweep cluster forming' : 'initial sweep observed'}`,
            weight: sweepCount > 2 || isBOSConfirmed ? 'strong' : 'normal',
        });
    }

    // NLF
    reasoning.push({
        symbol: scores.nlfScore > 0.55 ? '✓' : scores.nlfScore < 0.45 ? '✗' : '→',
        text: `Neural Liquidity Field: ${(scores.nlfScore * 100).toFixed(0)} — ${scores.nlfScore > 0.6 ? 'bullish field: predicted liq concentration above' : scores.nlfScore < 0.4 ? 'bearish field: liq vacuum above, concentration below' : 'neutral — no significant directional skew'}`,
        weight: 'normal',
    });

    // GLR
    reasoning.push({
        symbol: scores.glrScore > 0.55 ? '✓' : scores.glrScore < 0.35 ? '✗' : '→',
        text: `Global Liquidity Radar ${(scores.glrScore * 100).toFixed(0)} — ${scores.glrScore > 0.65 ? 'macro supportive' : scores.glrScore < 0.3 ? 'macro tightening (headwind)' : 'macro neutral'}`,
        weight: scores.glrScore > 0.6 || scores.glrScore < 0.3 ? 'normal' : 'weak',
    });

    // Actionable outputs
    const slDist = atrProxy * (cascadeRiskSigmoid > 0.5 ? 0.5 : isHighVolatility ? 0.7 : 1.0);
    const movePct = Math.abs(expectedMove).toFixed(2);

    const action: string =
        verdict === 'STRONG_LONG' ? `ALDE+ULIS: Initiate LONG — full alignment across vector, NLF, GLR, Bayesian` :
            verdict === 'LONG' ? `ALDE+ULIS: Bias LONG — positive liquidity vector, await OFI confirmation` :
                verdict === 'STRONG_SHORT' ? `ALDE+ULIS: Initiate SHORT — full alignment across vector, NLF, GLR, Bayesian` :
                    verdict === 'SHORT' ? `ALDE+ULIS: Bias SHORT — negative liquidity vector, confirm on next candle` :
                        verdict === 'BREAKOUT_WATCH' ? `ALDE+ULIS: Monitor for breakout — liquidity vacuum + directional vector forming` :
                            verdict === 'UNWIND' ? `ALDE+ULIS: Reduce/close — cascade sigmoid elevated, avoid new exposure` :
                                verdict === 'AVOID' ? `ALDE+ULIS: STAND ASIDE — cascade sigmoid critical. Wait for singularity resolution` :
                                    `ALDE+ULIS: No edge — liquidity equilibrium. Wait for vector to develop`;

    const entryContext: string =
        verdict === 'STRONG_LONG' ? `Enter on retest of nearest bid wall. Liquidity Target: $${liquidityTarget.toFixed(0)}` :
            verdict === 'LONG' ? `Enter on OFI confirmation; avoid chasing. Target: $${liquidityTarget.toFixed(0)}` :
                verdict === 'STRONG_SHORT' ? `Enter on failed retest of ask wall. Liquidity Target: $${liquidityTarget.toFixed(0)}` :
                    verdict === 'SHORT' ? `Wait for rejection at ask cluster. Target: $${liquidityTarget.toFixed(0)}` :
                        verdict === 'AVOID' || verdict === 'UNWIND' ? `Do not enter. Manage existing exposure only` :
                            `Define direction first — wait for breakout confirmation`;

    const invalidation: string =
        verdict.includes('LONG') ? `Invalidated if liquidity vector crosses below −0.10 AND OFI flips negative` :
            verdict.includes('SHORT') ? `Invalidated if liquidity vector crosses above +0.10 AND OFI turns positive` :
                verdict === 'AVOID' ? `Re-assess when cascade sigmoid drops below 0.50 and reflexivity normalises` :
                    `Invalidated if 3+ signals flip to a clear directional bias`;

    const targets: string =
        verdict.includes('LONG') ? `Target: $${liquidityTarget.toFixed(0)} (+${movePct}%) · SL: −$${slDist.toFixed(0)} or structure break` :
            verdict.includes('SHORT') ? `Target: $${liquidityTarget.toFixed(0)} (−${movePct}%) · SL: +$${slDist.toFixed(0)} or invalidation` :
                `No fixed targets — wait for directional conviction`;

    return {
        verdict,
        confidence: confidencePct,
        riskLevel,
        reasoning,
        action,
        entryContext,
        invalidation,
        targets,
        biasStrength: Math.abs(liquidityVector),
        regimeLabel,
        marketState,
        liquidityVector,
        liquidityTarget,
        expectedMove,
        aldeConfidence,
        cascadeRiskSigmoid,
        ulp,
        dlp,
    };
};

// ── Typewriter hook ──────────────────────────────────────────────────────────
const useTypewriter = (text: string, speed = 18) => {
    const [displayed, setDisplayed] = React.useState('');
    const [done, setDone] = React.useState(false);
    React.useEffect(() => {
        setDisplayed('');
        setDone(false);
        if (!text) return;
        let i = 0;
        const interval = setInterval(() => {
            i++;
            setDisplayed(text.slice(0, i));
            if (i >= text.length) { clearInterval(interval); setDone(true); }
        }, speed);
        return () => clearInterval(interval);
    }, [text]);
    return { displayed, done };
};

// ── EMA smoother — dampens noisy real-time scalar inputs ─────────────────────
// alpha=0.25 means each new value contributes 25%, history contributes 75%.
// Reacts to real moves in ~4 ticks (~400ms at 100ms depth refresh) but
// ignores single-tick spikes.
const useEMASmooth = (value: number, alpha = 0.25): number => {
    const ref = React.useRef(value);
    React.useEffect(() => {
        ref.current = alpha * value + (1 - alpha) * ref.current;
    });
    return alpha * value + (1 - alpha) * ref.current;
};

// ── Stable book snapshot — only re-references when depth changes by >0.5% ────
// Prevents aiVerdict from recomputing on every 100ms depth tick.
const useStableBook = (live: Array<{ price: number; size: number; total: number; delta: number; classification: string }>) => {
    const ref = React.useRef(live);
    const sumRef = React.useRef(0);
    const total = live.reduce((s, l) => s + l.size, 0);
    if (Math.abs(total - sumRef.current) / (sumRef.current || 1) > 0.005) {
        sumRef.current = total;
        ref.current = live;
    }
    return ref.current;
};

// ── Throttled memo — limits how often an expensive computation runs ───────────
// Returns the last computed value until intervalMs has elapsed.
const useThrottledMemo = <T,>(factory: () => T, deps: React.DependencyList, intervalMs: number): T => {
    const [value, setValue] = React.useState<T>(factory);
    const lastRun = React.useRef(0);
    React.useEffect(() => {
        const now = Date.now();
        if (now - lastRun.current >= intervalMs) {
            lastRun.current = now;
            setValue(factory());
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, deps);
    return value;
};

// ── Verdict hysteresis — prevents rapid flipping at decision boundaries ───────
// The committed verdict only updates if:
//   (a) the incoming verdict has been stable for HOLD_MS, OR
//   (b) compositeScore differs from last committed score by > SCORE_GAP
const HOLD_MS = 5000;    // must hold new verdict for 5s before it's committed
const SCORE_GAP = 0.12;  // a jump > 12% immediately overrides the timer

const useVerdictWithHysteresis = (incoming: AIVerdict): AIVerdict => {
    const [committed, setCommitted] = React.useState<AIVerdict>(incoming);
    const pendingRef = React.useRef<{ verdict: AIVerdict; since: number } | null>(null);
    const committedScoreRef = React.useRef(incoming.biasStrength);

    React.useEffect(() => {
        const newVerdict = incoming.verdict;
        const newScore = incoming.biasStrength;
        const scoreDelta = Math.abs(newScore - committedScoreRef.current);

        // Immediate override if score gap is large enough
        if (scoreDelta > SCORE_GAP) {
            pendingRef.current = null;
            committedScoreRef.current = newScore;
            setCommitted(incoming);
            return;
        }

        // Same verdict as committed: cancel any pending and update in-place
        if (newVerdict === committed.verdict) {
            pendingRef.current = null;
            // Update sub-fields (confidence, reasoning text etc.) without a full label flip
            setCommitted(incoming);
            return;
        }

        // New verdict differs — start or refresh the hold timer
        if (!pendingRef.current || pendingRef.current.verdict.verdict !== newVerdict) {
            pendingRef.current = { verdict: incoming, since: Date.now() };
        } else {
            const held = Date.now() - pendingRef.current.since;
            if (held >= HOLD_MS) {
                pendingRef.current = null;
                committedScoreRef.current = newScore;
                setCommitted(incoming);
            }
        }
    });

    return committed;
};

// ── AI Verdict Component ─────────────────────────────────────────────────────
const VERDICT_META: Record<VerdictType, { label: string; color: string; bg: string; border: string; glow: string }> = {
    STRONG_LONG: { label: '⬆ STRONG LONG', color: 'text-emerald-300', bg: 'bg-emerald-500/10', border: 'border-emerald-500/40', glow: 'shadow-emerald-500/20' },
    LONG: { label: '↑ LONG', color: 'text-emerald-400', bg: 'bg-emerald-500/8', border: 'border-emerald-500/30', glow: 'shadow-emerald-500/15' },
    NEUTRAL: { label: '↔ NEUTRAL', color: 'text-zinc-300', bg: 'bg-zinc-800/60', border: 'border-zinc-600/30', glow: '' },
    SHORT: { label: '↓ SHORT', color: 'text-red-400', bg: 'bg-red-500/8', border: 'border-red-500/30', glow: 'shadow-red-500/15' },
    STRONG_SHORT: { label: '⬇ STRONG SHORT', color: 'text-red-300', bg: 'bg-red-500/10', border: 'border-red-500/40', glow: 'shadow-red-500/20' },
    AVOID: { label: '⊗ AVOID', color: 'text-orange-300', bg: 'bg-orange-500/10', border: 'border-orange-500/40', glow: 'shadow-orange-500/20' },
    BREAKOUT_WATCH: { label: '◎ BREAKOUT WATCH', color: 'text-blue-300', bg: 'bg-blue-500/10', border: 'border-blue-500/30', glow: 'shadow-blue-500/15' },
    UNWIND: { label: '↩ UNWIND', color: 'text-amber-300', bg: 'bg-amber-500/10', border: 'border-amber-500/40', glow: 'shadow-amber-500/20' },
};

const RISK_META: Record<RiskLevel, { color: string; label: string }> = {
    LOW: { color: 'text-emerald-400', label: 'LOW RISK' },
    MODERATE: { color: 'text-amber-400', label: 'MODERATE RISK' },
    HIGH: { color: 'text-orange-400', label: 'HIGH RISK' },
    EXTREME: { color: 'text-red-400', label: 'EXTREME RISK' },
};

const symbolColor = (sym: string) =>
    sym === '✓' ? 'text-emerald-400' :
        sym === '✗' ? 'text-red-400' :
            sym === '⚠' ? 'text-amber-400' :
                sym === '◈' ? 'text-violet-400' : 'text-zinc-500';

const weightOpacity = (w: string) =>
    w === 'strong' ? 'opacity-100' :
        w === 'weak' ? 'opacity-50' : 'opacity-75';

const ULISAIVerdict: React.FC<{
    verdict: AIVerdict;
    symbol: string;
    analysisTs: number;
}> = ({ verdict, symbol, analysisTs }) => {
    const meta = VERDICT_META[verdict.verdict];
    const riskMeta = RISK_META[verdict.riskLevel];
    const { displayed: typedAction, done: typingDone } = useTypewriter(verdict.action, 15);
    const [activeReason, setActiveReason] = React.useState<number | null>(null);
    const tsStr = new Date(analysisTs).toLocaleTimeString();

    return (
        <motion.div
            key={verdict.verdict + verdict.confidence}
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4 }}
            className={`rounded-2xl border ${meta.border} ${meta.bg} p-5 shadow-xl ${meta.glow} mb-6`}
        >
            {/* ── Header ── */}
            <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 mb-5">
                <div className="flex items-center gap-3">
                    <div className={`p-3 rounded-xl bg-black/40 border ${meta.border}`}>
                        <BrainCircuit size={22} className={meta.color} />
                    </div>
                    <div>
                        <div className="flex items-center gap-2">
                            <span className="text-[10px] text-zinc-500 font-bold uppercase tracking-widest">ALDE × ULIS · AI VERDICT ENGINE</span>
                            <span className="text-[9px] text-zinc-700 font-mono">{tsStr}</span>
                        </div>
                        <h2 className={`text-2xl font-black tracking-tight ${meta.color}`}>{meta.label}</h2>
                        <p className="text-zinc-500 text-[10px] font-mono mt-0.5">{verdict.regimeLabel}</p>
                    </div>
                </div>
                {/* Market State badge + Confidence + Risk */}
                <div className="flex gap-3 flex-wrap">
                    {/* Market State badge */}
                    <div className={`flex flex-col items-center justify-center p-3 rounded-xl border min-w-[80px] ${verdict.marketState === 'TRENDING' ? 'bg-blue-500/10 border-blue-500/30' :
                        verdict.marketState === 'UNSTABLE' ? 'bg-red-500/10 border-red-500/30' :
                            'bg-zinc-800/60 border-zinc-600/30'
                        }`}>
                        <span className="text-[8px] text-zinc-500 uppercase font-bold tracking-widest mb-0.5">State</span>
                        <span className={`text-xs font-black font-mono ${verdict.marketState === 'TRENDING' ? 'text-blue-300' :
                            verdict.marketState === 'UNSTABLE' ? 'text-red-300' : 'text-zinc-300'
                            }`}>{verdict.marketState}</span>
                    </div>
                    <div className="flex flex-col items-center p-3 rounded-xl bg-black/40 border border-white/5 min-w-[72px]">
                        <span className="text-[8px] text-zinc-600 uppercase font-bold tracking-widest mb-0.5">Confidence</span>
                        <span className={`text-2xl font-black font-mono ${meta.color}`}>{verdict.confidence}%</span>
                        <div className="w-full h-1 rounded-full bg-white/10 mt-1 overflow-hidden">
                            <motion.div
                                className={`h-full rounded-full ${meta.color.replace('text-', 'bg-')}`}
                                initial={{ width: 0 }}
                                animate={{ width: `${verdict.confidence}%` }}
                                transition={{ duration: 1, ease: 'easeOut' }}
                            />
                        </div>
                    </div>
                    <div className="flex flex-col items-center p-3 rounded-xl bg-black/40 border border-white/5 min-w-[72px]">
                        <span className="text-[8px] text-zinc-600 uppercase font-bold tracking-widest mb-0.5">Risk</span>
                        <span className={`text-sm font-black ${riskMeta.color} text-center leading-tight`}>{riskMeta.label}</span>
                    </div>
                    <div className="flex flex-col items-center p-3 rounded-xl bg-black/40 border border-white/5 min-w-[72px]">
                        <span className="text-[8px] text-zinc-600 uppercase font-bold tracking-widest mb-0.5">Signal</span>
                        <span className="text-xs font-black text-zinc-300 font-mono">{symbol}</span>
                    </div>
                </div>
            </div>

            {/* ── Action Summary (typewriter) ── */}
            <div className={`p-4 rounded-xl border ${meta.border} bg-black/30 mb-5`}>
                <div className="flex items-center gap-2 mb-2">
                    <Zap size={12} className={meta.color} />
                    <span className="text-[9px] text-zinc-500 uppercase font-bold tracking-widest">Recommended Action</span>
                </div>
                <p className={`text-sm font-bold ${meta.color} leading-relaxed font-mono`}>
                    {typedAction}
                    {!typingDone && <span className="animate-pulse">▋</span>}
                </p>
            </div>

            {/* ── ALDE Liquidity Vector Bar ── */}
            <div className="mb-4 p-3 rounded-xl bg-black/25 border border-white/5">
                <div className="flex items-center justify-between mb-2">
                    <span className="text-[9px] text-zinc-500 uppercase font-bold tracking-widest">ALDE Liquidity Vector — ULP vs DLP</span>
                    <span className={`text-[10px] font-black font-mono ${verdict.liquidityVector > 0.1 ? 'text-emerald-400' :
                        verdict.liquidityVector < -0.1 ? 'text-red-400' : 'text-zinc-400'
                        }`}>
                        ULP {(verdict.ulp * 100).toFixed(0)} vs DLP {(verdict.dlp * 100).toFixed(0)} → {verdict.liquidityVector >= 0 ? '+' : ''}{verdict.liquidityVector.toFixed(3)}
                    </span>
                </div>
                {/* Dual bar: left=DLP (red), right=ULP (green), center=0 */}
                <div className="relative h-2 rounded-full bg-white/5 overflow-hidden">
                    {/* DLP bar (left half) */}
                    <motion.div
                        className="absolute right-1/2 h-full bg-red-500/60 rounded-l-full"
                        style={{ width: 0 }}
                        animate={{ width: `${Math.min(verdict.dlp * 50, 50)}%` }}
                        transition={{ duration: 0.8, ease: 'easeOut' }}
                    />
                    {/* ULP bar (right half) */}
                    <motion.div
                        className="absolute left-1/2 h-full bg-emerald-500/60 rounded-r-full"
                        style={{ width: 0 }}
                        animate={{ width: `${Math.min(verdict.ulp * 50, 50)}%` }}
                        transition={{ duration: 0.8, ease: 'easeOut' }}
                    />
                    {/* Center line */}
                    <div className="absolute left-1/2 top-0 w-px h-full bg-white/20" />
                </div>
                <div className="flex justify-between text-[8px] font-mono text-zinc-600 mt-1">
                    <span>← DLP (Sellers)</span>
                    <span>ULP (Buyers) →</span>
                </div>
            </div>

            {/* ── Trade Plan ── */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-5">
                {[
                    { label: 'Entry Context', value: verdict.entryContext, icon: <TrendingUp size={11} />, color: 'text-zinc-300' },
                    { label: `Target · ${verdict.expectedMove >= 0 ? '+' : ''}${verdict.expectedMove.toFixed(2)}%`, value: `$${verdict.liquidityTarget.toFixed(0)} (${verdict.expectedMove >= 0 ? '+' : ''}${verdict.expectedMove.toFixed(2)}%)`, icon: <Activity size={11} />, color: 'text-emerald-400/80' },
                    { label: 'Invalidation', value: verdict.invalidation, icon: <Shield size={11} />, color: 'text-red-400/70' },
                    { label: `Cascade σ · ${(verdict.cascadeRiskSigmoid * 100).toFixed(0)}%`, value: verdict.targets, icon: <AlertTriangle size={11} />, color: verdict.cascadeRiskSigmoid > 0.6 ? 'text-red-400' : verdict.cascadeRiskSigmoid > 0.4 ? 'text-amber-400' : 'text-emerald-400/70' },
                ].map(({ label, value, icon, color }) => (
                    <div key={label} className="p-3 rounded-xl bg-black/25 border border-white/5">
                        <div className={`flex items-center gap-1.5 mb-2 ${color}`}>
                            {icon}
                            <span className="text-[8px] font-bold uppercase tracking-widest">{label}</span>
                        </div>
                        <p className="text-[10px] text-zinc-400 font-mono leading-relaxed">{value}</p>
                    </div>
                ))}
            </div>

            {/* ── Reasoning Chain ── */}
            <div className="border-t border-white/5 pt-4">
                <div className="flex items-center gap-2 mb-3">
                    <Cpu size={12} className="text-zinc-600" />
                    <span className="text-[9px] text-zinc-500 uppercase font-bold tracking-widest">Analytical Reasoning Chain</span>
                    <span className="text-[8px] text-zinc-700 font-mono ml-auto">{verdict.reasoning.length} factors evaluated</span>
                </div>
                <div className="space-y-1.5">
                    {verdict.reasoning.map((line: VerdictLine, idx: number) => (
                        <motion.div
                            key={idx}
                            initial={{ opacity: 0, x: -8 }}
                            animate={{ opacity: 1, x: 0 }}
                            transition={{ delay: idx * 0.06 }}
                            className={`flex items-start gap-2.5 p-2.5 rounded-lg cursor-pointer transition-all duration-200 ${activeReason === idx ? 'bg-white/5' : 'hover:bg-white/[0.02]'}`}
                            onClick={() => setActiveReason(activeReason === idx ? null : idx)}
                        >
                            <span className={`text-sm font-bold shrink-0 mt-0.5 ${symbolColor(line.symbol)}`}>{line.symbol}</span>
                            <span className={`text-[10px] font-mono leading-relaxed ${weightOpacity(line.weight)} text-zinc-300`}>
                                {line.text}
                            </span>
                            {line.weight === 'strong' && (
                                <span className="ml-auto shrink-0 text-[7px] font-bold uppercase tracking-widest text-amber-500/70 bg-amber-500/10 px-1.5 py-0.5 rounded">KEY</span>
                            )}
                        </motion.div>
                    ))}
                </div>
            </div>

            {/* ── Footer: bias strength bar ── */}
            <div className="mt-4 pt-3 border-t border-white/5">
                <div className="flex justify-between text-[8px] font-mono text-zinc-600 mb-1">
                    <span>Signal Strength</span>
                    <span className={meta.color}>{(verdict.biasStrength * 100).toFixed(0)}% decisive</span>
                </div>
                <div className="h-1 rounded-full bg-white/5 overflow-hidden">
                    <motion.div
                        className={`h-full rounded-full ${meta.color.replace('text-', 'bg-')}`}
                        initial={{ width: 0 }}
                        animate={{ width: `${verdict.biasStrength * 100}%` }}
                        transition={{ duration: 1.4, ease: 'easeOut' }}
                    />
                </div>
            </div>
        </motion.div>
    );
};

// ─── Main Page ───────────────────────────────────────────────────────────────

const ULISView: React.FC = () => {
    const { market, config, liquidity, darkPoolBias } = useStore(s => ({
        market: s.market,
        config: s.config,
        liquidity: s.liquidity,
        darkPoolBias: s.darkPoolBias,
    }));

    const { metrics, asks, bids, levels } = market;
    const { price, ofi, zScore, bayesianPosterior, institutionalCVD: cvd, skewness } = metrics;

    // EMA-smoothed inputs — reduces tick-level noise before entering the verdict engine
    const smoothOfi = useEMASmooth(ofi || 0, 0.25);
    const smoothZScore = useEMASmooth(zScore || 0, 0.2);
    const smoothCvd = useEMASmooth(cvd || 0, 0.15);

    // Stable book snapshots — only update reference when depth changes >0.5%
    const stableBids = useStableBook(bids.map(b => ({ ...b, delta: b.delta ?? 0, classification: b.classification ?? '' })));
    const stableAsks = useStableBook(asks.map(a => ({ ...a, delta: a.delta ?? 0, classification: a.classification ?? '' })));

    // ── Derived Scores ──────────────────────────────────────────────────────

    const scores = useMemo(() => {
        // 1. Visible Liquidity depth score (from orderbook depth imbalance)
        const totalBidSize = stableBids.reduce((a: number, b: any) => a + b.size, 0);
        const totalAskSize = stableAsks.reduce((a: number, b: any) => a + b.size, 0);
        const totalDepth = totalBidSize + totalAskSize || 1;
        const visibleLiquidity = normalize(totalDepth, 0, totalDepth * 2); // normalized to 0-1

        // 2. Latent Liquidity proxy: from heatmap levels + sweep clusters
        const sweepDensity = Math.min(liquidity.sweeps.length / 10, 1);
        const fvgDensity = Math.min(liquidity.fvg.length / 8, 1);
        const latentLiquidity = (sweepDensity * 0.6 + fvgDensity * 0.4);

        // 3. Gravity Force: liquidity concentration → price attraction
        const gravityWalls = [...bids, ...asks].filter(l => (l as any).classification === 'WALL');
        const gravityForce = Math.min(gravityWalls.length / 6, 1);

        // 4. Reflexivity Ratio = LiquidationPressure / MarketLiquidity
        // proxy: |OFI| / (totalDepth proxy). High OFI + low depth = high reflexivity
        const ofiAbs = Math.abs(smoothOfi);
        const liquidityProxy = normalize(totalDepth, 1000, 50000);
        const reflexivityRaw = totalDepth > 0 ? ofiAbs / (100 + liquidityProxy * 100) : 0;
        const reflexivityRatio = clamp(reflexivityRaw * 8, 0, 2); // 0→2 scale matching blueprint
        const reflexivityScore = reflexivityRatio / 2; // normalized 0→1

        // 5. Fragility = Elasticity + CancelRate − RefillRate
        // proxy from skewness + smoothed zScore
        const elasticity = normalize(Math.abs(smoothZScore), 0, 3);
        const cancelProxy = normalize(Math.abs(skewness || 0), 0, 1.5);
        const refillProxy = normalize(Math.abs(smoothCvd), 0, 500000) * 0.5;
        const fragility = clamp(elasticity * 0.5 + cancelProxy * 0.3 - refillProxy, 0, 1);

        // 6. GLR proxy: composite macro signal
        //    - darkPoolBias → institutional positioning proxy
        //    - |cvd| / big number → derivatives leverage proxy
        //    - stablecoin & ETF simulated as neutral (no real data)
        const centralBankProxy = normalize(Math.abs(darkPoolBias), 0, 1) * 0.8 + 0.1;
        const dollarLiqProxy = normalize(1 / (1 + Math.exp(-smoothOfi / 30)), 0, 1); // sigmoid of smoothed OFI
        const stablecoinProxy = 0.55; // simulated neutral
        const etfFlowsProxy = normalize(Math.abs(cvd || 0), 0, 200000);
        const derivLevProxy = normalize(ofiAbs, 0, 80);
        const glrScore = (
            0.25 * centralBankProxy +
            0.2 * dollarLiqProxy +
            0.15 * stablecoinProxy +
            0.15 * etfFlowsProxy +
            0.25 * derivLevProxy
        );

        // 7. NLF proxy (neural prediction score)
        const nlfScore = normalize(
            (bayesianPosterior || 0.5) * 0.6 + (1 - fragility) * 0.4,
            0, 1
        );

        // 8. Master Liquidity Score: weighted combination
        const masterScore =
            0.15 * visibleLiquidity +
            0.15 * latentLiquidity +
            0.1 * gravityForce +
            0.15 * reflexivityScore +
            0.15 * fragility +
            0.15 * glrScore +
            0.15 * nlfScore;

        // 9. Singularity Score = density × reflexivity × fragility × gradient
        const gravGradient = normalize(gravityWalls.length, 0, 10);
        const singularityScore = clamp(
            latentLiquidity * reflexivityScore * fragility * (0.3 + gravGradient * 0.7),
            0, 1
        );

        // 10. Cascade Probability (Monte Carlo proxy)
        // High singularity + high reflexivity = high cascade probability
        const cascadeProb = clamp(
            singularityScore * 0.5 + reflexivityScore * 0.3 + fragility * 0.2,
            0, 1
        );

        return {
            visibleLiquidity,
            latentLiquidity,
            gravityForce,
            reflexivityRatio,
            reflexivityScore,
            fragility,
            glrScore,
            nlfScore,
            masterScore,
            singularityScore,
            cascadeProb,
            // GLR components for radar
            glrComponents: {
                centralBank: +(centralBankProxy * 100).toFixed(0),
                dollarLiq: +(dollarLiqProxy * 100).toFixed(0),
                stablecoins: +(stablecoinProxy * 100).toFixed(0),
                etfFlows: +(etfFlowsProxy * 100).toFixed(0),
                derivatives: +(derivLevProxy * 100).toFixed(0),
            }
        };
    }, [stableBids, stableAsks, smoothOfi, smoothZScore, bayesianPosterior, smoothCvd, skewness, darkPoolBias, liquidity]);

    // ── Signal Engine ────────────────────────────────────────────────────

    const signals = useMemo(() => {
        const { reflexivityScore, gravityForce, singularityScore, fragility, visibleLiquidity } = scores;
        return {
            liquiditySqueeze: reflexivityScore > 0.5 && gravityForce > 0.4 && liquidity.sweeps.length > 1,
            vacuumBreakout: visibleLiquidity < 0.35 && Math.abs(ofi || 0) > 20 && fragility > 0.5,
            cascadeWarning: singularityScore > 0.4 && fragility > 0.5 && liquidity.sweeps.length > 2,
        };
    }, [scores, ofi, liquidity.sweeps.length]);

    // ── AI Verdict — throttled at most every 5s, then hysteresis-filtered ──
    const [analysisTs, setAnalysisTs] = React.useState(Date.now());
    const rawVerdict = useThrottledMemo(() => computeAIVerdict({
        scores,
        signals,
        ofi: smoothOfi,
        zScore: smoothZScore,
        bayesianPosterior: bayesianPosterior || 0.5,
        cvd: smoothCvd,
        price,
        sweepCount: liquidity.sweeps.length,
        fvgCount: liquidity.fvg.length,
        bosList: liquidity.bos || [],
        bids: stableBids,
        asks: stableAsks,
    }), [scores, signals, smoothOfi, smoothZScore, bayesianPosterior, smoothCvd, price, liquidity, stableBids, stableAsks], 5000);

    // Apply hysteresis so verdict label only flips after 5s hold or large score jump
    const aiVerdict = useVerdictWithHysteresis(rawVerdict);

    // Stamp timestamp whenever committed verdict changes
    useEffect(() => { setAnalysisTs(Date.now()); }, [aiVerdict.verdict]);

    // GLR Radar data
    const radarData = [
        { axis: 'Central Bank', value: scores.glrComponents.centralBank },
        { axis: 'Dollar Liq', value: scores.glrComponents.dollarLiq },
        { axis: 'Stablecoins', value: scores.glrComponents.stablecoins },
        { axis: 'ETF Flows', value: scores.glrComponents.etfFlows },
        { axis: 'Derivatives', value: scores.glrComponents.derivatives },
    ];

    const masterPct = Math.round(scores.masterScore * 100);
    const masterColor = masterPct > 65 ? 'text-red-400' : masterPct > 40 ? 'text-amber-400' : 'text-emerald-400';
    const masterBorderColor = masterPct > 65 ? 'border-red-500/30' : masterPct > 40 ? 'border-amber-500/30' : 'border-emerald-500/30';

    return (
        <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="h-full overflow-y-auto px-4 lg:px-8 pb-24 lg:pb-8 pt-6 max-w-7xl mx-auto"
        >
            {/* ── Page Header ── */}
            <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 mb-8">
                <div className="flex items-center gap-4">
                    <div className="p-3 bg-violet-500/20 rounded-xl text-violet-400 shadow-[0_0_24px_rgba(139,92,246,0.3)]">
                        <Globe2 size={30} />
                    </div>
                    <div>
                        <h1 className="text-3xl font-black text-white tracking-tight">
                            Unified Liquidity Intelligence
                        </h1>
                        <p className="text-slate-400 text-sm mt-0.5">
                            ULIS — Master Market Physics Engine · {config.activeSymbol}
                        </p>
                    </div>
                </div>
                {/* Master Score pill */}
                <div className={`px-6 py-3 rounded-2xl border ${masterBorderColor} bg-black/40 flex flex-col items-end`}>
                    <span className="text-[9px] text-zinc-500 font-bold uppercase tracking-widest">Master Liquidity Score</span>
                    <span className={`text-4xl font-black font-mono ${masterColor}`}>{masterPct}</span>
                    <span className={`text-[9px] font-mono font-bold uppercase ${masterColor} opacity-60`}>
                        {masterPct > 65 ? 'HIGH TENSION' : masterPct > 40 ? 'BUILDING' : 'STABLE FIELD'}
                    </span>
                </div>
            </div>

            {/* ── Architecture Banner ── */}
            <div className="mb-8 p-4 rounded-2xl border border-white/5 bg-zinc-900/30 overflow-x-auto">
                <div className="flex items-center gap-2 text-[9px] font-bold uppercase tracking-widest font-mono whitespace-nowrap text-zinc-500 flex-nowrap justify-center">
                    {[
                        { label: 'GLR', sub: 'Global Layer', color: 'text-blue-400 border-blue-500/30 bg-blue-500/10' },
                        { label: '→', sub: '', color: 'text-zinc-700 border-transparent' },
                        { label: 'ILIH', sub: 'Microstructure', color: 'text-violet-400 border-violet-500/30 bg-violet-500/10' },
                        { label: '→', sub: '', color: 'text-zinc-700 border-transparent' },
                        { label: 'NLF', sub: 'Neural Predict', color: 'text-emerald-400 border-emerald-500/30 bg-emerald-500/10' },
                        { label: '→', sub: '', color: 'text-zinc-700 border-transparent' },
                        { label: 'LSE', sub: 'Cascade Risk', color: 'text-red-400 border-red-500/30 bg-red-500/10' },
                        { label: '→', sub: '', color: 'text-zinc-700 border-transparent' },
                        { label: 'TDE', sub: 'Execution', color: 'text-amber-400 border-amber-500/30 bg-amber-500/10' },
                    ].map((item, i) => (
                        item.label === '→' ? (
                            <span key={i} className="text-zinc-700 text-sm">→</span>
                        ) : (
                            <div key={i} className={`flex flex-col items-center px-4 py-2 rounded-xl border ${item.color}`}>
                                <span className={`text-sm font-black ${item.color.split(' ')[0]}`}>{item.label}</span>
                                <span className="text-[8px] opacity-70">{item.sub}</span>
                            </div>
                        )
                    ))}
                </div>
            </div>

            {/* ── Signal Engine ── */}
            <div className="mb-8">
                <div className="flex items-center gap-2 mb-4">
                    <Zap size={15} className="text-amber-400" />
                    <span className="text-xs font-black tracking-widest uppercase text-zinc-300">Signal Engine</span>
                    <span className="text-[9px] text-zinc-600 font-mono ml-2">Multi-condition alignment detector</span>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                    <SignalBadge
                        active={signals.liquiditySqueeze}
                        label="Liquidity Squeeze"
                        sub="High gravity + High reflexivity + Sweep cluster"
                        color="text-amber-400"
                        icon={<AlertTriangle size={16} />}
                    />
                    <SignalBadge
                        active={signals.vacuumBreakout}
                        label="Vacuum Breakout"
                        sub="Low depth + High momentum + Low refill"
                        color="text-blue-400"
                        icon={<TrendingUp size={16} />}
                    />
                    <SignalBadge
                        active={signals.cascadeWarning}
                        label="Cascade Warning"
                        sub="High reflexivity + High fragility + Large cluster"
                        color="text-red-400"
                        icon={<Shield size={16} />}
                    />
                </div>
            </div>

            {/* ── AI Verdict Engine ── */}
            <ULISAIVerdict
                verdict={aiVerdict}
                symbol={config.activeSymbol}
                analysisTs={analysisTs}
            />

            {/* ── Main Grid ── */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">

                {/* Panel 1: Master Heatmap */}
                <div className="lg:col-span-2 p-5 rounded-2xl border border-white/5 bg-zinc-900/40 flex flex-col gap-4">
                    <SectionHeader
                        icon={<Layers size={18} />}
                        title="Master Liquidity Heatmap"
                        sub="Unified field: visible + latent + gravity + reflexivity layers"
                        accent="text-violet-400"
                    />
                    <div className="w-full h-[220px]">
                        <MasterHeatmapCanvas
                            price={price}
                            levels={levels.map((l: any) => ({ price: l.price, size: l.size ?? 1 }))}
                            asks={asks}
                            bids={bids}
                            reflexivity={scores.reflexivityScore}
                        />
                    </div>
                    {/* Color legend */}
                    <div className="flex flex-wrap gap-x-5 gap-y-1 text-[9px] font-mono font-bold">
                        {[
                            { color: '#facc15', label: 'Strong Liquidity Wall' },
                            { color: '#ef4444', label: 'Liquidation Cluster' },
                            { color: '#a855f7', label: 'Reflexivity Zone' },
                            { color: '#3b82f6', label: 'Macro Liquidity' },
                            { color: '#ffffff', label: 'Cascade Epicenter' },
                        ].map(({ color, label }) => (
                            <div key={label} className="flex items-center gap-1.5 text-zinc-500">
                                <div className="w-2.5 h-2.5 rounded-sm" style={{ background: color }} />
                                {label}
                            </div>
                        ))}
                    </div>
                    {/* Master Score bars */}
                    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 pt-2 border-t border-white/5">
                        <ScoreBadge value={scores.visibleLiquidity} label="Visible Liquidity" desc="Orderbook depth proxy" />
                        <ScoreBadge value={scores.latentLiquidity} label="Latent Liquidity" desc="Sweep + FVG clusters" />
                        <ScoreBadge value={scores.gravityForce} label="Gravity Force" desc="LOB wall concentration" />
                        <ScoreBadge value={scores.fragility} label="Fragility" desc="Elasticity + cancel rate" />
                    </div>
                </div>

                {/* Panel 2: GLR Radar */}
                <div className="p-5 rounded-2xl border border-blue-500/20 bg-blue-500/5 flex flex-col gap-4">
                    <SectionHeader
                        icon={<Radio size={18} />}
                        title="Global Liquidity Radar"
                        sub="Macro capital flow composite — GLR index"
                        accent="text-blue-400"
                    />
                    <div className="flex flex-col gap-4 items-center">
                        <ResponsiveContainer width="100%" height={200}>
                            <RadarChart data={radarData} cx="50%" cy="50%" outerRadius="65%">
                                <PolarGrid stroke="#1f2937" />
                                <PolarAngleAxis
                                    dataKey="axis"
                                    tick={{ fill: '#6b7280', fontSize: 9, fontWeight: 'bold' }}
                                />
                                <Radar
                                    dataKey="value"
                                    stroke="#3b82f6"
                                    fill="#3b82f6"
                                    fillOpacity={0.2}
                                    dot={{ fill: '#3b82f6', r: 3 }}
                                />
                                <Tooltip
                                    contentStyle={{ background: '#18181b', border: '1px solid #27272a', borderRadius: 8 }}
                                    labelStyle={{ color: '#a1a1aa', fontSize: 10 }}
                                    itemStyle={{ color: '#60a5fa', fontSize: 10 }}
                                />
                            </RadarChart>
                        </ResponsiveContainer>
                        <div className="w-full">
                            <ScoreBadge
                                value={scores.glrScore}
                                label="GLR Composite Index"
                                desc="GLR leads BTC by ~30–70 days in theory"
                            />
                        </div>
                        <div className="w-full grid grid-cols-5 gap-1">
                            {Object.entries(scores.glrComponents).map(([k, v]) => (
                                <div key={k} className="flex flex-col items-center p-2 rounded-lg bg-black/30">
                                    <span className="text-[8px] text-zinc-600 uppercase tracking-wide">{k.replace('Liq', '').replace('Flow', '')}</span>
                                    <span className="text-blue-400 font-black text-sm font-mono">{String(v)}</span>
                                </div>
                            ))}
                        </div>
                        <div className="w-full flex items-start gap-2 p-2.5 rounded-lg bg-blue-500/10 border border-blue-500/20">
                            <Info size={12} className="text-blue-400 shrink-0 mt-0.5" />
                            <p className="text-[9px] text-blue-300/70 font-mono leading-relaxed">
                                <span className="text-blue-300 font-bold">Proxy values</span> — Central Bank &amp; Stablecoin feeds unavailable. Derived from OFI, CVD, dark pool bias.
                            </p>
                        </div>
                    </div>
                </div>

                {/* Panel 3: Reflexivity Index */}
                <div className="p-5 rounded-2xl border border-amber-500/20 bg-amber-500/5 flex flex-col gap-4">
                    <SectionHeader
                        icon={<Activity size={18} />}
                        title="Reflexivity Index"
                        sub="ReflexivityRatio = LiquidationPressure / MarketLiquidity"
                        accent="text-amber-400"
                    />
                    <ReflexivityGauge ratio={scores.reflexivityRatio} />
                    <div className="grid grid-cols-2 gap-3">
                        <ScoreBadge value={scores.reflexivityScore} label="Reflexivity Score" desc="Normalized 0–1" />
                        <ScoreBadge value={scores.singularityScore} label="Singularity Score" desc="LSE cascade proxy" />
                    </div>
                    <div className="space-y-2 text-[10px] font-mono">
                        {[
                            { label: 'OFI (Pressure)', value: (ofi || 0).toFixed(1), color: ofi > 10 ? 'text-emerald-400' : ofi < -10 ? 'text-rose-400' : 'text-zinc-400' },
                            { label: 'Z-Score', value: (zScore || 0).toFixed(3), color: Math.abs(zScore || 0) > 2 ? 'text-violet-400' : 'text-zinc-400' },
                            { label: 'Fragility', value: (scores.fragility * 100).toFixed(0) + '%', color: scores.fragility > 0.6 ? 'text-red-400' : 'text-zinc-400' },
                            { label: 'Gravity Walls', value: [...bids, ...asks].filter(l => (l as any).classification === 'WALL').length.toString(), color: 'text-zinc-300' },
                        ].map(({ label, value, color }) => (
                            <div key={label} className="flex justify-between items-center border-b border-white/5 pb-1.5">
                                <span className="text-zinc-500">{label}</span>
                                <span className={`font-black ${color}`}>{value}</span>
                            </div>
                        ))}
                    </div>
                </div>
            </div>

            {/* ── Bottom Row: Cascade + NLF ── */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">

                {/* Panel 4: Cascade Probability */}
                <div className="p-5 rounded-2xl border border-red-500/20 bg-red-500/5 flex flex-col gap-4">
                    <SectionHeader
                        icon={<AlertTriangle size={18} />}
                        title="Cascade Probability"
                        sub="LSE · Monte-Carlo path estimate"
                        accent="text-red-400"
                    />
                    <div className="flex flex-col items-center gap-4">
                        {/* Big probability display */}
                        <div className="flex flex-col items-center p-6 rounded-2xl bg-black/40 border border-white/5 w-full">
                            <span className="text-[10px] text-zinc-500 uppercase tracking-widest font-bold mb-1">Cascade Risk</span>
                            <span className={`text-6xl font-black font-mono ${scores.cascadeProb > 0.6 ? 'text-red-400' : scores.cascadeProb > 0.35 ? 'text-amber-400' : 'text-emerald-400'}`}>
                                {(scores.cascadeProb * 100).toFixed(0)}%
                            </span>
                            <span className={`text-xs font-bold uppercase tracking-widest mt-1 ${scores.cascadeProb > 0.6 ? 'text-red-400' : scores.cascadeProb > 0.35 ? 'text-amber-400' : 'text-emerald-400'}`}>
                                {scores.cascadeProb > 0.6 ? '⚡ IMMINENT' : scores.cascadeProb > 0.35 ? '⚠ ELEVATED' : '✓ LOW'}
                            </span>
                        </div>
                        {/* Simulated Monte-Carlo paths */}
                        <div className="w-full">
                            <div className="text-[9px] text-zinc-600 font-mono mb-2 flex items-center gap-1.5">
                                <Cpu size={9} />
                                Simulated Path Distribution
                            </div>
                            <div className="flex gap-1 items-end h-16">
                                {Array.from({ length: 20 }, (_, i) => {
                                    const x = (i - 10) / 10; // -1 to +1
                                    const mu = (scores.cascadeProb - 0.5) * 0.8;
                                    const sigma = 0.3 + scores.fragility * 0.4;
                                    const height = Math.exp(-Math.pow(x - mu, 2) / (2 * sigma * sigma));
                                    const isNeg = x < -0.1;
                                    const isPos = x > 0.1;
                                    return (
                                        <div
                                            key={i}
                                            className={`flex-1 rounded-t ${isNeg ? 'bg-emerald-500' : isPos ? 'bg-red-500' : 'bg-amber-500'}`}
                                            style={{ height: `${Math.max(height * 100, 4)}%`, opacity: 0.6 + height * 0.4 }}
                                        />
                                    );
                                })}
                            </div>
                            <div className="flex justify-between text-[8px] text-zinc-600 font-mono mt-1">
                                <span>← Reversal</span>
                                <span>Cascade →</span>
                            </div>
                        </div>
                        <div className="grid grid-cols-2 gap-3 w-full text-[10px] font-mono">
                            <div className="p-3 rounded-xl bg-black/30 border border-white/5">
                                <div className="text-zinc-500 text-[8px] uppercase mb-1">Expected Move (±)</div>
                                <div className="text-white font-black">{(price * 0.005 * (1 + scores.singularityScore)).toFixed(0)}</div>
                            </div>
                            <div className="p-3 rounded-xl bg-black/30 border border-white/5">
                                <div className="text-zinc-500 text-[8px] uppercase mb-1">Vol Expansion</div>
                                <div className={`font-black ${scores.singularityScore > 0.5 ? 'text-red-400' : 'text-zinc-300'}`}>
                                    {scores.singularityScore > 0.5 ? '+' : ''}{((scores.singularityScore - 0.2) * 100).toFixed(0)}%
                                </div>
                            </div>
                        </div>
                    </div>
                </div>

                {/* Panel 5: NLF */}
                <div className="p-5 rounded-2xl border border-emerald-500/20 bg-emerald-500/5 flex flex-col gap-4">
                    <SectionHeader
                        icon={<BrainCircuit size={18} />}
                        title="Neural Liquidity Forecast"
                        sub="NLF · Predicted future liquidity field (proxy via Bayesian+OFI)"
                        accent="text-emerald-400"
                    />
                    <div className="w-full h-[160px]">
                        <NLFCanvas
                            price={price}
                            zScore={zScore || 0}
                            bayesian={bayesianPosterior || 0.5}
                            ofi={ofi || 0}
                        />
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                        <ScoreBadge value={scores.nlfScore} label="NLF Score" desc="Bayesian posterior proxy" />
                        <ScoreBadge value={bayesianPosterior || 0.5} label="P(Bullish)" desc="Multi-factor Bayes" />
                    </div>
                    <div className="p-3 rounded-xl bg-black/30 border border-white/5 space-y-2 text-[10px] font-mono">
                        {[
                            { label: 'Bayesian P(Bull)', value: `${((bayesianPosterior || 0.5) * 100).toFixed(1)}%`, color: (bayesianPosterior || 0.5) > 0.6 ? 'text-emerald-400' : (bayesianPosterior || 0.5) < 0.4 ? 'text-red-400' : 'text-zinc-400' },
                            { label: 'OFI Signal', value: (ofi || 0).toFixed(1), color: (ofi || 0) > 10 ? 'text-emerald-400' : (ofi || 0) < -10 ? 'text-red-400' : 'text-zinc-400' },
                            { label: 'Mean Reversion Force', value: (-(zScore || 0) * 0.3).toFixed(3), color: Math.abs(zScore || 0) > 1.5 ? 'text-violet-400' : 'text-zinc-400' },
                            { label: 'Field Direction', value: scores.nlfScore > 0.6 ? '▲ BULLISH' : scores.nlfScore < 0.4 ? '▼ BEARISH' : '↔ NEUTRAL', color: scores.nlfScore > 0.6 ? 'text-emerald-400' : scores.nlfScore < 0.4 ? 'text-red-400' : 'text-amber-400' },
                        ].map(({ label, value, color }) => (
                            <div key={label} className="flex justify-between items-center border-b border-white/5 pb-1.5 last:border-0 last:pb-0">
                                <span className="text-zinc-500">{label}</span>
                                <span className={`font-black ${color}`}>{value}</span>
                            </div>
                        ))}
                    </div>
                    <div className="flex items-start gap-2 p-2.5 rounded-lg bg-emerald-500/10 border border-emerald-500/20">
                        <Info size={12} className="text-emerald-400 shrink-0 mt-0.5" />
                        <p className="text-[9px] text-emerald-300/70 font-mono leading-relaxed">
                            <span className="text-emerald-300 font-bold">Proxy NLF</span> — True NLF requires a trained 3D-CNN + Transformer. Forecast uses Bayesian posterior + OFI + Z-Score mean-reversion model.
                        </p>
                    </div>
                </div>
            </div>

            {/* ── ULIS Formula Reference ── */}
            <div className="p-5 rounded-2xl border border-white/5 bg-zinc-900/30 flex flex-col gap-5">
                <div className="flex items-center gap-2">
                    <Cpu size={15} className="text-zinc-500" />
                    <span className="text-xs font-black tracking-widest uppercase text-zinc-400">ULIS Formula Reference</span>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 text-[10px] font-mono">
                    {[
                        {
                            label: 'Master Liquidity Score',
                            formula: 'w1·VisLiq + w2·LatLiq + w3·Gravity + w4·Reflex + w5·Fragility + w6·GLR + w7·NLF',
                            color: 'text-violet-400'
                        },
                        {
                            label: 'Reflexivity Ratio',
                            formula: 'LiquidationPressure / MarketLiquidity',
                            color: 'text-amber-400'
                        },
                        {
                            label: 'Fragility Score',
                            formula: 'Elasticity + CancelRate − RefillRate',
                            color: 'text-red-400'
                        },
                        {
                            label: 'Gravity Force',
                            formula: 'Σ LiquidityMass / Distance²',
                            color: 'text-blue-400'
                        },
                        {
                            label: 'Singularity Score (LSE)',
                            formula: 'Density × Reflexivity × Fragility × GravGradient',
                            color: 'text-red-400'
                        },
                        {
                            label: 'GLR Composite',
                            formula: 'w1·CB + w2·Dollar + w3·Stable + w4·ETF + w5·Deriv',
                            color: 'text-blue-400'
                        },
                    ].map(({ label, formula, color }) => (
                        <div key={label} className="p-3 rounded-xl bg-black/30 border border-white/5">
                            <div className={`text-[9px] font-bold uppercase tracking-wide mb-1.5 ${color}`}>{label}</div>
                            <div className="text-zinc-500 leading-relaxed">{formula}</div>
                        </div>
                    ))}
                </div>
                <p className="text-[9px] text-zinc-700 font-mono">
                    Latency target: 20–80ms (production stack: Kafka → Flink → ClickHouse → ML Inference → Visualization).
                    Current implementation uses live WebSocket data &amp; client-side computation as proxy.
                </p>
            </div>

            {/* Bottom spacer on mobile */}
            <div className="h-4 md:h-0" />
        </motion.div>
    );
};

export default ULISView;
