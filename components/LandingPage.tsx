
import React, { useEffect, useState } from 'react';
import { motion as m, AnimatePresence, useScroll, useTransform } from 'framer-motion';
import { Hexagon, Activity, ArrowRight, Terminal, Shield, Globe, Zap, Check } from 'lucide-react';
import { upgradeHref, PLAN_FEATURES, PRICING } from '../utils/entitlements';
import AdSlot from './AdSlot';
import MarketRecord from './MarketRecord';
import { apiFetch } from '../utils/apiClient';
import { Sparkline, HeatCell, signedColor } from './Premium';

const motion = m as any;

interface LandingPageProps {
  onEnter: () => void;
}

interface FundingPoint { t: number; rate: number }

const LandingPage: React.FC<LandingPageProps> = ({ onEnter }) => {
  const [isInitializing, setIsInitializing] = useState(false);
  const [loadingProgress, setLoadingProgress] = useState(0);
  const [funding, setFunding] = useState<number[]>([]);
  const [latestFunding, setLatestFunding] = useState<number | undefined>();
  const [accumFunding, setAccumFunding] = useState<number | undefined>();
  const [heatRows, setHeatRows] = useState<{ symbol: string; funding_rate: number }[]>([]);
  const { scrollY } = useScroll();

  // Real market data for the hero preview — degrades silently offline.
  useEffect(() => {
    let dead = false;
    (async () => {
      try {
        const [h, f] = await Promise.all([
          apiFetch('/funding-heatmap', { timeoutMs: 45000 }),
          apiFetch('/funding-history?symbol=BTCUSDT&limit=42', { timeoutMs: 45000 }),
        ]);
        const hj = await h.json();
        const fj = await f.json();
        if (dead) return;
        const rows = [...(hj?.highest || []).slice(0, 6), ...(hj?.lowest || []).slice(0, 6)];
        setHeatRows(rows);
        setFunding((fj?.history || []).map((p: FundingPoint) => p.rate));        setLatestFunding(fj?.latest?.rate);
        setAccumFunding(fj?.accumulated_pct);
      } catch { /* preview is optional */ }
    })();
    return () => { dead = true; };
  }, []);
  
  // Parallax effects
  const y2 = useTransform(scrollY, [0, 500], [0, -150]);
  const opacity = useTransform(scrollY, [0, 300], [1, 0]);

  const handleEnter = () => {
    setIsInitializing(true);
    // Simulate boot sequence
    const interval = setInterval(() => {
        setLoadingProgress(prev => {
            if (prev >= 100) {
                clearInterval(interval);
                setTimeout(onEnter, 200); 
                return 100;
            }
            return prev + Math.floor(Math.random() * 15) + 5;
        });
    }, 120);
  };

  return (
    <div className="h-screen w-screen relative bg-[#050505] font-sans selection:bg-brand-accent/30 overflow-x-hidden">
      
      {/* --- Global Background --- */}
      <div className="fixed inset-0 z-0 pointer-events-none">
        <div className="absolute inset-0 bg-[linear-gradient(to_right,#80808012_1px,transparent_1px),linear-gradient(to_bottom,#80808012_1px,transparent_1px)] bg-[size:24px_24px] [mask-image:radial-gradient(ellipse_60%_50%_at_50%_0%,#000_70%,transparent_100%)]"></div>
        <div className="absolute top-[-10%] left-[20%] w-[500px] h-[500px] bg-brand-accent/10 rounded-full blur-[120px] animate-pulse" />
        <div className="absolute bottom-[-10%] right-[20%] w-[600px] h-[600px] bg-purple-900/10 rounded-full blur-[120px]" />
        <div className="absolute inset-0 bg-[url('/noise.svg')] opacity-[0.03] mix-blend-overlay"></div>
      </div>
      
      <AnimatePresence mode="wait">
      {!isInitializing ? (
          <motion.div 
            key="hero"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0, scale: 0.95, filter: "blur(20px)" }}
            transition={{ duration: 0.8 }}
            className="relative z-10 w-full"
          >
            {/* --- Navigation / Header --- */}
            <motion.header 
                initial={{ y: -20, opacity: 0 }}
                animate={{ y: 0, opacity: 1 }}
                transition={{ delay: 0.5 }}
                className="fixed top-0 left-0 right-0 z-50 flex justify-between items-center px-6 py-6 lg:px-12 mix-blend-difference"
            >
                <div className="flex items-center gap-2">
                    <Hexagon size={24} className="text-white fill-white/10" />
                    <span className="font-bold text-white tracking-widest text-sm">QUANT DESK</span>
                </div>
                <div className="hidden md:flex gap-8 text-xs font-mono text-zinc-400">
                    <a href="/platform" className="hover:text-white transition-colors">PLATFORM</a>
                    <a href="/institutional" className="hover:text-white transition-colors">INSTITUTIONAL</a>
                    <a href="/api" className="hover:text-white transition-colors">API</a>
                    <a href="/blog" className="hover:text-white transition-colors">BLOG</a>
                </div>
                <button 
                    onClick={handleEnter}
                    className="px-4 py-2 border border-white/20 rounded-full text-[10px] font-bold text-white uppercase tracking-wider hover:bg-white hover:text-black transition-colors"
                >
                    Launch Terminal
                </button>
            </motion.header>

            {/* --- Hero Section --- */}
            <section className="min-h-screen flex flex-col items-center justify-center pt-32 pb-20 px-6 relative">
                
                {/* Floating Elements */}
                <motion.div style={{ y: y2 }} className="absolute top-1/4 left-[10%] hidden lg:block opacity-20">
                     <Globe size={120} strokeWidth={0.5} className="text-brand-accent animate-[spin_60s_linear_infinite]" />
                </motion.div>

                {/* Status Pill */}
                <motion.div
                    initial={{ y: 20, opacity: 0 }}
                    animate={{ y: 0, opacity: 1 }}
                    transition={{ delay: 0.2 }}
                    className="inline-flex items-center gap-3 px-4 py-2 rounded-full bg-white/[0.03] border border-white/[0.08] backdrop-blur-md text-[10px] font-mono text-zinc-400 mb-8 hover:bg-white/[0.05] transition-colors cursor-crosshair group"
                >
                    <div className="flex gap-1">
                        <span className="w-1 h-3 rounded-full bg-emerald-500 animate-pulse"></span>
                        <span className="w-1 h-3 rounded-full bg-emerald-500/50 animate-pulse delay-75"></span>
                        <span className="w-1 h-3 rounded-full bg-emerald-500/20 animate-pulse delay-150"></span>
                    </div>
                    <span className="group-hover:text-white transition-colors">SYSTEM STATUS: OPERATIONAL</span>
                    <span className="text-zinc-600">|</span>
                    <span className="text-brand-accent">V 2.4.0</span>
                </motion.div>
                
                {/* Main Title */}
                <div className="space-y-4 mb-10 relative text-center z-20">
                    <motion.h1 
                        initial={{ y: 20, opacity: 0, letterSpacing: "-0.05em" }}
                        animate={{ y: 0, opacity: 1, letterSpacing: "-0.02em" }}
                        transition={{ delay: 0.3, duration: 0.8 }}
                        className="text-4xl sm:text-6xl md:text-7xl lg:text-8xl font-bold text-white tracking-tighter leading-[0.95]"
                    >
                        QUANT DESK
                    </motion.h1>
                    <motion.div 
                        initial={{ scaleX: 0 }}
                        animate={{ scaleX: 1 }}
                        transition={{ delay: 0.8, duration: 1.2, ease: "circOut" }}
                        className="h-px bg-gradient-to-r from-transparent via-brand-accent to-transparent w-full opacity-50"
                    />
                </div>

                <motion.p
                    initial={{ y: 20, opacity: 0 }}
                    animate={{ y: 0, opacity: 1 }}
                    transition={{ delay: 0.5, duration: 0.8 }}
                    className="text-base sm:text-lg md:text-xl text-zinc-400 max-w-2xl mx-auto mb-10 font-light tracking-wide leading-relaxed text-center z-20 px-2"
                >
                    Live <span className="text-white font-medium">order flow</span>, cross-venue funding,
                    liquidation clusters and trader positioning — with sources and timestamps.
                    Core market data is free.
                </motion.p>

                {/* Primary CTA */}
                <motion.div
                    initial={{ scale: 0.9, opacity: 0 }}
                    animate={{ scale: 1, opacity: 1 }}
                    whileHover={{ scale: 1.05 }}
                    transition={{ delay: 0.7, type: "spring" }}
                    className="relative z-20 mb-8"
                >
                    <button
                        onClick={handleEnter}
                        className="group relative px-10 py-5 bg-white text-black rounded-full font-bold text-lg tracking-wider overflow-hidden shadow-[0_0_50px_-10px_rgba(255,255,255,0.3)]"
                    >
                        <div className="relative z-10 flex items-center gap-4">
                            <Terminal size={18} className="text-zinc-600 group-hover:text-black transition-colors" />
                            <span>OPEN THE TERMINAL</span>
                            <ArrowRight size={20} className="group-hover:translate-x-1 transition-transform" />
                        </div>
                        <div className="absolute inset-0 bg-gradient-to-r from-brand-accent/20 to-transparent -translate-x-full group-hover:translate-x-full transition-transform duration-500 ease-in-out"></div>
                    </button>
                </motion.div>

                {/* Live terminal preview (real data) */}
                <motion.div
                    initial={{ y: 24, opacity: 0 }}
                    animate={{ y: 0, opacity: 1 }}
                    transition={{ delay: 0.9, duration: 0.7 }}
                    className="relative z-20 mb-14 w-full max-w-3xl px-1"
                >
                    <div className="premium-card overflow-hidden p-4 sm:p-5 text-left">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                            <div className="flex items-center gap-2">
                                <span className="relative flex h-2 w-2">
                                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
                                    <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
                                </span>
                                <span className="font-mono text-[11px] font-bold text-white">BTCUSDT · FUNDING</span>
                                <span className="rounded bg-white/5 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider text-slate-500">live</span>
                            </div>
                            <div className="flex items-center gap-3 font-mono text-[11px]">
                                <span className={(latestFunding ?? 0) >= 0 ? 'text-rose-400' : 'text-emerald-400'}>
                                    {latestFunding === undefined ? '—' : `${latestFunding >= 0 ? '+' : ''}${(latestFunding * 100).toFixed(4)}%`}
                                </span>
                                <span className="text-slate-600">
                                    7d {accumFunding === undefined ? '—' : `${accumFunding >= 0 ? '+' : ''}${accumFunding}%`}
                                </span>
                            </div>
                        </div>

                        <div className="mt-2">
                            {funding.length > 1
                                ? <Sparkline values={funding} color={(latestFunding ?? 0) >= 0 ? '#f43f5e' : '#10b981'} height={84} />
                                : <div className="h-[84px] animate-pulse rounded-md bg-white/[0.04]" />}
                        </div>

                        <div className="mt-1 flex flex-wrap gap-1">
                            {heatRows.length
                                ? (() => {
                                    const maxAbs = Math.max(...heatRows.map(r => Math.abs(r.funding_rate)), 1e-9);
                                    return heatRows.map(r => (
                                        <HeatCell key={r.symbol}
                                            text={r.symbol.replace('USDT', '')}
                                            color={signedColor(r.funding_rate, maxAbs)}
                                            title={`${r.symbol} · ${(r.funding_rate * 100).toFixed(4)}%`}
                                            className="flex-1 !px-1.5" />
                                    ));
                                })()
                                : Array.from({ length: 12 }).map((_, i) => (
                                    <div key={i} className="h-6 flex-1 animate-pulse rounded-md bg-white/[0.04]" />
                                ))}
                        </div>

                        <div className="mt-2 flex flex-wrap items-center justify-between gap-2 font-mono text-[9px] text-slate-600">
                            <span>funding extremes across perps · red positive / green negative</span>
                            <span>binance · bybit</span>
                        </div>
                    </div>
                </motion.div>

                {/* Scroll Indicator */}
                <motion.div 
                    style={{ opacity }}
                    className="absolute bottom-10 left-1/2 -translate-x-1/2 flex flex-col items-center gap-2"
                >
                    <span className="text-[10px] text-zinc-600 uppercase tracking-widest">Scroll to Explore</span>
                    <motion.div 
                        animate={{ y: [0, 5, 0] }}
                        transition={{ repeat: Infinity, duration: 2 }}
                        className="w-px h-8 bg-gradient-to-b from-zinc-600 to-transparent" 
                    />
                </motion.div>
            </section>

            {/* --- Data source strip --- */}
            <div className="w-full border-y border-white/5 bg-black/50 backdrop-blur-sm py-4 overflow-hidden relative z-20">
                <div className="flex w-max gap-14 animate-[scroll_40s_linear_infinite]">
                    {[...Array(2)].map((_, i) => (
                        <div key={i} className="flex items-center gap-14 font-mono text-[10px] tracking-[0.22em] text-zinc-500">
                            {['BINANCE USDM', 'BYBIT LINEAR', 'OKX SWAP', 'COINBASE SPOT', 'HYPERLIQUID', 'FRED', 'ECB FX'].map(s => (
                                <span key={s} className="whitespace-nowrap">{s}</span>
                            ))}
                        </div>
                    ))}
                </div>
            </div>

            {/* --- Bento Grid Features --- */}
            {/* --- Market record --- */}
            <div className="py-10 sm:py-14">
                <MarketRecord />
            </div>

            <section className="py-16 sm:py-24 px-4 sm:px-6 relative z-10">
                <div className="max-w-7xl mx-auto">
                    <motion.div 
                        initial={{ opacity: 0, y: 50 }}
                        whileInView={{ opacity: 1, y: 0 }}
                        viewport={{ once: true }}
                        className="mb-16"
                    >
                        <h2 className="text-3xl sm:text-4xl md:text-5xl font-bold text-white mb-4">Market Structure <span className="text-brand-accent">Decoded</span>.</h2>
                        <p className="text-zinc-400 max-w-xl text-base sm:text-lg">Every panel is built from public exchange feeds and macro APIs — with the source and timestamp shown, not a black-box score.</p>
                    </motion.div>

                    <div className="grid grid-cols-1 md:grid-cols-3 gap-6 h-auto md:h-[600px]">
                        {/* Large Card Left */}
                        <motion.div 
                            initial={{ opacity: 0, x: -50 }}
                            whileInView={{ opacity: 1, x: 0 }}
                            viewport={{ once: true }}
                            whileHover={{ y: -5 }}
                            className="md:col-span-2 md:row-span-2 rounded-3xl bg-zinc-900/40 border border-white/10 p-8 flex flex-col justify-between relative overflow-hidden group"
                        >
                            <div className="absolute inset-0 bg-gradient-to-br from-brand-accent/10 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-500" />
                            <div className="relative z-10">
                                <div className="p-3 bg-brand-accent/20 w-fit rounded-xl mb-6 text-brand-accent">
                                    <Activity size={32} />
                                </div>
                                <h3 className="text-2xl sm:text-3xl font-bold text-white mb-2">Order Flow &amp; CVD</h3>
                                <p className="text-zinc-400 max-w-sm">Executed prints with taker-side classification, rolling CVD, absorptions and price-impact diagnostics.</p>
                            </div>
                            
                            {/* Graphic Mockup inside card */}
                            <div className="relative h-48 w-full mt-8 rounded-xl bg-black/50 border border-white/5 overflow-hidden p-4">
                                <div className="flex gap-1 mb-2">
                                    <div className="w-2 h-2 rounded-full bg-rose-500/50" />
                                    <div className="w-2 h-2 rounded-full bg-emerald-500/50" />
                                </div>
                                <div className="flex items-end gap-1 h-24 w-full">
                                    {[40, 60, 30, 80, 50, 90, 20, 40, 70, 45, 80, 95].map((h, i) => (
                                        <motion.div 
                                            key={i}
                                            initial={{ height: 0 }}
                                            whileInView={{ height: `${h}%` }}
                                            transition={{ delay: i * 0.05, duration: 1 }}
                                            className="flex-1 bg-zinc-800 hover:bg-brand-accent transition-colors rounded-t-sm opacity-60" 
                                        />
                                    ))}
                                </div>
                            </div>
                        </motion.div>

                        {/* Tall Card Right */}
                        <motion.div 
                             initial={{ opacity: 0, x: 50 }}
                             whileInView={{ opacity: 1, x: 0 }}
                             viewport={{ once: true }}
                             whileHover={{ y: -5 }}
                             className="md:row-span-2 rounded-3xl bg-zinc-900/40 border border-white/10 p-8 flex flex-col relative overflow-hidden group"
                        >
                            <div className="absolute top-0 right-0 w-64 h-64 bg-emerald-500/10 rounded-full blur-[80px] -translate-y-1/2 translate-x-1/2" />
                            <div className="p-3 bg-emerald-500/20 w-fit rounded-xl mb-6 text-emerald-500">
                                <Shield size={32} />
                            </div>
                            <h3 className="text-2xl font-bold text-white mb-2">Positioning &amp; Funding</h3>
                            <p className="text-zinc-400 mb-8 text-sm">Retail versus top-trader positioning, taker flow and cross-venue funding — side by side.</p>

                            <div className="flex-1 flex flex-col gap-3">
                                {['Retail L/S ratio', 'Top-trader positioning', 'Taker buy/sell', 'Funding extremes'].map((item, i) => (
                                    <div key={i} className="flex items-center justify-between p-3 rounded-lg bg-black/40 border border-white/5">
                                        <span className="text-xs text-zinc-300 font-mono uppercase">{item}</span>
                                        <div className="flex items-center gap-2">
                                            <div className="w-1.5 h-1.5 rounded-full bg-brand-accent animate-pulse" />
                                            <span className="text-[10px] text-brand-accent font-bold">LIVE</span>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </motion.div>

                        {/* Bottom Wide Card */}
                        <motion.div 
                            initial={{ opacity: 0, y: 50 }}
                            whileInView={{ opacity: 1, y: 0 }}
                            viewport={{ once: true }}
                            whileHover={{ y: -5 }}
                            className="md:col-span-3 rounded-3xl bg-zinc-900/40 border border-white/10 p-8 flex flex-col md:flex-row items-center justify-between relative overflow-hidden group"
                        >
                            <div className="absolute inset-0 bg-gradient-to-r from-purple-500/10 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-500" />
                            <div className="relative z-10 max-w-lg">
                                <div className="p-3 bg-purple-500/20 w-fit rounded-xl mb-4 text-purple-400">
                                    <Zap size={32} />
                                </div>
                                <h3 className="text-2xl font-bold text-white mb-2">Liquidations &amp; Whale Flow</h3>
                                <p className="text-zinc-400">Forced orders streamed from Binance and OKX, clustered by price, alongside the largest Hyperliquid accounts and their open positions.</p>
                            </div>
                            <div className="relative z-10 flex gap-8 mt-8 md:mt-0">
                                <div className="text-center">
                                    <div className="text-2xl font-mono font-bold text-white mb-1">OKX + Binance</div>
                                    <div className="text-xs text-zinc-500 uppercase tracking-wider">Liquidation tape</div>
                                </div>
                                <div className="w-px bg-white/10" />
                                <div className="text-center">
                                    <div className="text-2xl font-mono font-bold text-white mb-1">Hyperliquid</div>
                                    <div className="text-xs text-zinc-500 uppercase tracking-wider">Whale accounts</div>
                                </div>
                            </div>
                        </motion.div>
                    </div>
                </div>
            </section>

             {/* --- Workspaces --- */}
            <section className="py-16 sm:py-24 px-4 sm:px-6 relative z-10">
                <div className="max-w-6xl mx-auto">
                    <div className="text-center mb-10">
                        <h2 className="text-3xl sm:text-4xl font-bold text-white mb-3">Built like a desk</h2>
                        <p className="text-zinc-400 max-w-xl mx-auto">Six focused workspaces instead of one crowded screen. Free covers the core; Pro unlocks the advanced desks.</p>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                        {[
                            { icon: Activity, name: 'Order Flow', desc: 'Executed prints, taker side, CVD and price impact.', badge: 'PRO' },
                            { icon: Shield, name: 'Positioning', desc: 'Retail vs top-trader long/short and taker flow.', badge: 'PRO' },
                            { icon: Zap, name: 'RSI Screener', desc: 'Multi-timeframe RSI heatmap across liquid perps.', badge: 'PRO' },
                            { icon: Globe, name: 'Liquidations', desc: 'Forced orders clustered by price, 24h heat strip.', badge: 'PRO' },
                            { icon: Terminal, name: 'Whale Positions', desc: 'Largest Hyperliquid accounts and open positions.', badge: 'PRO' },
                            { icon: Hexagon, name: 'Macro & FX', desc: 'Rates, inflation, dollar strength and ECB FX.', badge: 'FREE' },
                        ].map(({ icon: Icon, name, desc, badge }) => (
                            <div key={name} className="premium-card p-4 flex items-start gap-3">
                                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-brand-accent/15 text-brand-accent">
                                    <Icon size={17} />
                                </div>
                                <div className="min-w-0">
                                    <div className="flex items-center gap-2">
                                        <span className="text-sm font-bold text-white">{name}</span>
                                        <span className={`rounded px-1.5 py-0.5 text-[8px] font-black uppercase tracking-wider ${
                                            badge === 'PRO' ? 'bg-brand-accent/15 text-brand-accent' : 'bg-emerald-500/15 text-emerald-400'
                                        }`}>{badge}</span>
                                    </div>
                                    <p className="mt-1 text-[11px] leading-relaxed text-slate-500">{desc}</p>
                                </div>
                            </div>
                        ))}
                    </div>

                    <div className="mt-10 text-center">
                        <button onClick={handleEnter} className="inline-flex items-center gap-2 rounded-full border border-white/15 px-7 py-3 text-sm font-bold text-white hover:bg-white/5">
                            Open the free desk <ArrowRight size={16} />
                        </button>
                    </div>
                </div>
            </section>

            {/* --- Free forever --- */}
            <section className="py-16 sm:py-20 px-4 sm:px-6 relative z-10">
                <div className="max-w-5xl mx-auto text-center">
                    <span className="text-xs font-bold uppercase tracking-[0.2em] text-emerald-400">Free forever</span>
                    <h2 className="mt-3 text-4xl md:text-5xl font-bold text-white">Start free. <span className="text-brand-accent">No card.</span></h2>
                    <p className="mt-4 text-zinc-400 max-w-2xl mx-auto">
                        The core market view stays free — live prices, chart, funding and macro context.
                        Upgrade only when you want the execution desk.
                    </p>
                    <div className="mt-10 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 text-left">
                        {[
                            'Live prices, chart & order book',
                            'Funding & open interest across venues',
                            'Positioning: retail vs top traders',
                            'RSI screener & liquidation clusters',
                            'Watchlist + 3 price alerts',
                            'Macro & FX data (FRED / ECB)',
                            'Market news with sentiment',
                            'Order book depth & liquidity',
                            'No credit card required',
                        ].map(t => (
                            <div key={t} className="fintech-card flex items-start gap-3 p-4">
                                <Check size={16} className="mt-0.5 shrink-0 text-emerald-400" />
                                <span className="text-sm text-zinc-300">{t}</span>
                            </div>
                        ))}
                    </div>
                    <button onClick={handleEnter} className="mt-10 inline-flex items-center gap-2 rounded-full bg-white px-8 py-3 font-bold text-black hover:scale-105 transition-transform">
                        Enter free <ArrowRight size={16} />
                    </button>
                </div>
            </section>

            {/* Ad slot (only renders when consent + AdSense client are set) */}
            <div className="mx-auto max-w-4xl px-6">
                <AdSlot slot="home-mid" format="horizontal" className="py-6" />
            </div>

            {/* --- Pricing --- */}
            <section id="pricing" className="py-16 sm:py-20 px-4 sm:px-6 relative z-10">
                <div className="max-w-5xl mx-auto">
                    <div className="text-center mb-12">
                        <span className="text-xs font-bold uppercase tracking-[0.2em] text-brand-accent">Pricing</span>
                        <h2 className="mt-3 text-4xl md:text-5xl font-bold text-white">One upgrade. <span className="text-brand-accent">The whole desk.</span></h2>
                        <p className="mt-4 text-zinc-400">Cancel anytime. Instant access after payment.</p>
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                        <div className="fintech-card p-6 flex flex-col">
                            <h3 className="text-sm font-bold uppercase tracking-wider text-zinc-300">Free</h3>
                            <div className="mt-2 font-mono text-4xl font-black text-white">$0 <span className="text-xs font-normal text-zinc-500">forever</span></div>
                            <p className="mt-1 text-xs text-zinc-500">Core market view.</p>
                            <ul className="mt-5 flex-1 space-y-2">
                                {PLAN_FEATURES.filter(f => f.free).map(f => (
                                    <li key={f.label} className="flex items-start gap-2 text-sm text-zinc-300">
                                        <Check size={15} className="mt-0.5 shrink-0 text-emerald-400" />{f.label}
                                    </li>
                                ))}
                            </ul>
                            <button onClick={handleEnter} className="mt-5 w-full rounded-xl border border-white/15 py-2.5 text-sm font-semibold text-white hover:bg-white/5">
                                Get started free
                            </button>
                        </div>
                        <div className="fintech-card p-6 flex flex-col border-brand-accent/40 relative">
                            <span className="absolute right-4 top-4 rounded-full bg-brand-accent/15 px-2 py-0.5 text-[9px] font-black uppercase tracking-wider text-brand-accent">Recommended</span>
                            <h3 className="text-sm font-bold uppercase tracking-wider text-white">Pro</h3>
                            <div className="mt-2 font-mono text-4xl font-black text-white">${PRICING.pro.price} <span className="text-xs font-normal text-zinc-500">/ month</span></div>
                            <p className="mt-1 text-xs text-zinc-500">${PRICING.pro.annual}/yr — two months free.</p>
                            <ul className="mt-5 flex-1 space-y-2">
                                {PLAN_FEATURES.map(f => (
                                    <li key={f.label} className="flex items-start gap-2 text-sm text-zinc-300">
                                        <Check size={15} className="mt-0.5 shrink-0 text-emerald-400" />{f.label}
                                    </li>
                                ))}
                            </ul>
                            <a
                                href={upgradeHref() || '#'}
                                onClick={(e) => { if (!upgradeHref()) { e.preventDefault(); handleEnter(); } }}
                                target={upgradeHref() ? '_blank' : undefined}
                                rel="noopener noreferrer"
                                className="mt-5 w-full rounded-xl bg-brand-accent py-2.5 text-center text-sm font-bold text-white hover:bg-brand-accent/90"
                            >
                                Upgrade to Pro
                            </a>
                        </div>
                    </div>
                </div>
            </section>

            {/* --- Footer --- */}
            <footer className="border-t border-white/5 bg-black/50 backdrop-blur-lg py-12 relative z-20">
                <div className="max-w-7xl mx-auto px-6 flex flex-col md:flex-row justify-between items-center gap-6">
                    <div className="flex items-center gap-2">
                        <Hexagon size={20} className="text-zinc-500" />
                        <span className="text-zinc-500 font-bold tracking-widest text-xs">QUANT DESK</span>
                    </div>
                    <div className="flex flex-wrap justify-center gap-6 text-xs text-zinc-600 font-mono">
                        <a href="/platform" className="hover:text-zinc-300 transition-colors">PLATFORM</a>
                        <a href="/institutional" className="hover:text-zinc-300 transition-colors">INSTITUTIONAL</a>
                        <a href="/api" className="hover:text-zinc-300 transition-colors">API</a>
                        <a href="/blog" className="hover:text-zinc-300 transition-colors">BLOG</a>
                        <a href="/learn" className="hover:text-zinc-300 transition-colors">LEARN</a>
                        <a href="/methodology" className="hover:text-zinc-300 transition-colors">METHODOLOGY</a>
                        <a href="/coverage" className="hover:text-zinc-300 transition-colors">COVERAGE</a>
                        <a href="/tools/position-size" className="hover:text-zinc-300 transition-colors">TOOLS</a>
                        <a href="/about" className="hover:text-zinc-300 transition-colors">ABOUT</a>
                        <a href="/privacy" className="hover:text-zinc-300 transition-colors">PRIVACY</a>
                        <a href="/terms" className="hover:text-zinc-300 transition-colors">TERMS</a>
                        <a href="/disclaimer" className="hover:text-zinc-300 transition-colors">DISCLAIMER</a>
                    </div>
                    <div className="text-xs text-zinc-700">
                        © 2026 Quant Desk. All rights reserved.
                    </div>
                </div>
            </footer>

          </motion.div>
      ) : (
          <motion.div 
            key="loader"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="absolute inset-0 z-50 flex flex-col items-center justify-center gap-8 bg-[#050505]"
          >
              <div className="w-64 h-1 bg-zinc-900 rounded-full overflow-hidden relative">
                  <motion.div 
                    className="absolute inset-y-0 left-0 bg-white"
                    initial={{ width: "0%" }}
                    animate={{ width: `${loadingProgress}%` }}
                    transition={{ ease: "linear" }}
                  />
              </div>
              <div className="font-mono text-xs text-zinc-500 uppercase flex flex-col items-center gap-2">
                  <div className="flex items-center gap-2">
                    <Terminal size={14} className="animate-pulse" />
                    <span>Opening your desk…</span>
                  </div>
                  <span className="text-white font-bold">{loadingProgress}%</span>
              </div>
              
              {/* Boot Log */}
              <div className="absolute bottom-12 left-12 font-mono text-[10px] text-zinc-600 flex flex-col gap-1">
                  <span className="text-emerald-500">✓ Loading market data</span>
                  <span className={loadingProgress > 30 ? "text-emerald-500" : "opacity-0"}>✓ Exchange feeds connected</span>
                  <span className={loadingProgress > 60 ? "text-emerald-500" : "opacity-0"}>✓ Scoring positioning & funding</span>
                  <span className={loadingProgress > 90 ? "text-emerald-500" : "opacity-0"}>✓ Desk ready</span>
              </div>
          </motion.div>
      )}
      </AnimatePresence>
    </div>
  );
};

export default LandingPage;
