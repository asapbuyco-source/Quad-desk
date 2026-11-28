
import React, { useState, useEffect } from 'react';
import { ChevronDown, Bell, History, Radio, Check, Calendar, Play, Settings, User as UserIcon, Sparkles, Search } from 'lucide-react';
import { AnimatePresence, motion as m } from 'framer-motion';
import { useStore } from '../store';
import { isAdminEmail, PAYWALL_ENABLED } from '../utils/entitlements';
import { cachedJson } from '../utils/cachedFetch';

const motion = m as any;

const ASSETS = [
    { id: 'BTCUSDT', label: 'BTC/USDT', name: 'Bitcoin' },
    { id: 'ETHUSDT', label: 'ETH/USDT', name: 'Ethereum' },
    { id: 'SOLUSDT', label: 'SOL/USDT', name: 'Solana' },
];

const Header: React.FC = () => {
    const [isDropdownOpen, setIsDropdownOpen] = useState(false);

    const { metrics } = useStore(state => state.market);
    const { isBacktest, activeSymbol, playbackSpeed, backtestDate } = useStore(state => state.config);
    const { user } = useStore(state => state.auth);
    const { plan } = useStore(state => state.auth);
    const priceAlerts = useStore(state => state.priceAlerts);
    const alertCount = priceAlerts.filter(a => !a.triggeredAt).length;
    const [stats, setStats] = useState<{ high?: number; low?: number; volume?: number; next?: number }>({});
    const [clock, setClock] = useState(Date.now());
    useEffect(() => {
        let dead = false;
        cachedJson<any>(`/coin-futures?symbol=${activeSymbol}`, { ttlMs: 120000, timeoutMs: 45000 })
            .then(d => { if (!dead) setStats({ high: d.high_24h, low: d.low_24h, volume: d.volume_24h, next: d.next_funding_time }); })
            .catch(() => {});
        const id = setInterval(() => setClock(Date.now()), 30000);
        return () => { dead = true; clearInterval(id); };
    }, [activeSymbol]);
    const fundingIn = (() => {
        const next = Number(stats.next);
        if (!Number.isFinite(next) || next <= 0) return null;
        const diff = next - clock;
        if (diff <= 0) return 'settling';
        const h = Math.floor(diff / 3600000);
        const m = Math.floor((diff % 3600000) / 60000);
        return h > 0 ? `${h}h ${m}m` : `${m}m`;
    })();
    const { toggleBacktest, setSymbol, setPlaybackSpeed, setBacktestDate, setActiveTab } = useStore();
    const showUpgrade = PAYWALL_ENABLED && plan !== 'pro' && plan !== 'team' && !isAdminEmail(user?.email);

    return (
        <>
            <header className="h-16 lg:h-20 flex items-center justify-between px-4 lg:px-6 shrink-0 bg-transparent relative z-40 border-b border-white/5 lg:border-none">

                {/* Left: Ticker & Price */}
                <div className="flex flex-col justify-center relative min-w-0">
                    <button
                        onClick={() => setIsDropdownOpen(!isDropdownOpen)}
                        className="flex items-center gap-1.5 text-slate-400 hover:text-white transition-colors group mb-0.5"
                    >
                        <span className="text-[10px] lg:text-xs font-semibold tracking-wider uppercase hidden sm:inline">Market Overview</span>
                        <span className="text-[10px] font-semibold tracking-wider uppercase sm:hidden">Market</span>
                        <ChevronDown size={12} className={`w-3 h-3 transition-transform text-slate-500 group-hover:text-white ${isDropdownOpen ? 'rotate-180' : ''}`} />
                    </button>

                    {/* Asset Dropdown */}
                    <AnimatePresence>
                        {isDropdownOpen && (
                            <>
                                <div className="fixed inset-0 z-40" onClick={() => setIsDropdownOpen(false)} />
                                <motion.div
                                    initial={{ opacity: 0, y: -10 }}
                                    animate={{ opacity: 1, y: 0 }}
                                    exit={{ opacity: 0, y: -10 }}
                                    className="absolute top-full left-0 mt-2 w-48 bg-[#09090b] border border-white/10 rounded-xl shadow-2xl z-50 overflow-hidden py-1"
                                >
                                    <div className="px-3 py-2 text-[10px] font-bold text-slate-500 uppercase tracking-widest border-b border-white/5">
                                        Select Asset
                                    </div>
                                    {ASSETS.map((asset) => (
                                        <button
                                            key={asset.id}
                                            onClick={() => {
                                                setSymbol(asset.id);
                                                setIsDropdownOpen(false);
                                            }}
                                            className="w-full flex items-center justify-between px-4 py-3 hover:bg-white/5 transition-colors group"
                                        >
                                            <div className="flex flex-col items-start">
                                                <span className={`text-sm font-bold ${activeSymbol === asset.id ? 'text-white' : 'text-slate-400 group-hover:text-zinc-200'}`}>
                                                    {asset.label}
                                                </span>
                                                <span className="text-[10px] text-slate-600 font-mono">{asset.name}</span>
                                            </div>
                                            {activeSymbol === asset.id && <Check size={14} className="text-brand-accent" />}
                                        </button>
                                    ))}
                                </motion.div>
                            </>
                        )}
                    </AnimatePresence>

                    <div className="flex items-baseline gap-3 lg:gap-4 overflow-hidden">
                        <h1 className="text-xl lg:text-3xl font-bold text-white tracking-tight font-sans truncate">
                            {metrics.pair}
                        </h1>
                        <div className="flex items-center gap-2 lg:gap-3">
                            <span className="text-base lg:text-2xl font-mono font-medium text-white tracking-tight">
                                ${metrics.price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                            </span>
                            <div className={`
                hidden min-[360px]:flex items-center px-1.5 lg:px-2 py-0.5 rounded-full text-[10px] lg:text-xs font-bold font-mono
                ${metrics.change > 0
                                    ? 'bg-trade-bid/20 text-trade-bid'
                                    : metrics.change < 0
                                        ? 'bg-trade-ask/20 text-trade-ask'
                                        : 'bg-zinc-500/20 text-zinc-400'}
            `}>
                                {metrics.change > 0 ? '+' : ''}{metrics.change.toFixed(2)}%
                            </div>
                        </div>
                    </div>
                </div>

                {/* Center: Backtest Controls (Only Visible in Backtest Mode) */}
                {isBacktest && (
                    <motion.div
                        initial={{ opacity: 0, y: -20, x: "-50%" }}
                        animate={{ opacity: 1, y: 0, x: "-50%" }}
                        exit={{ opacity: 0, y: -20, x: "-50%" }}
                        className="hidden md:flex absolute left-1/2 top-1/2 -translate-y-1/2 items-center gap-4 bg-[#09090b]/80 border border-amber-500/20 rounded-full py-2 px-5 shadow-[0_8px_30px_rgb(0,0,0,0.5)] backdrop-blur-xl z-30"
                    >
                        {/* Date Selection */}
                        <div className="flex items-center gap-3 pr-4 border-r border-white/10 group">
                            <Calendar size={14} className="text-amber-500" />
                            <div className="relative">
                                <span className="text-[10px] text-zinc-500 uppercase font-bold tracking-wider absolute -top-2 left-0 scale-75 origin-left">Start Date</span>
                                <input
                                    type="date"
                                    value={backtestDate}
                                    onChange={(e) => setBacktestDate(e.target.value)}
                                    className="bg-transparent text-xs font-mono text-zinc-200 focus:outline-none [&::-webkit-calendar-picker-indicator]:invert [&::-webkit-calendar-picker-indicator]:cursor-pointer [&::-webkit-calendar-picker-indicator]:opacity-50 hover:[&::-webkit-calendar-picker-indicator]:opacity-100"
                                />
                            </div>
                        </div>

                        {/* Playback Speed */}
                        <div className="flex items-center gap-2">
                            <div className="p-1.5 rounded-full bg-amber-500/10 text-amber-500 animate-pulse">
                                <Play size={10} fill="currentColor" />
                            </div>
                            <div className="flex items-center gap-1 bg-white/5 rounded-lg p-0.5">
                                {[0.5, 1, 5, 10].map(speed => (
                                    <button
                                        key={speed}
                                        onClick={() => setPlaybackSpeed(speed)}
                                        className={`
                                px-2 py-1 text-[10px] font-bold rounded-md transition-all
                                ${playbackSpeed === speed
                                                ? 'bg-amber-500 text-black shadow-sm'
                                                : 'text-zinc-500 hover:text-white hover:bg-white/10'}
                            `}
                                    >
                                        {speed}x
                                    </button>
                                ))}
                            </div>
                        </div>
                    </motion.div>
                )}

                {/* Right: Actions */}
                <div className="flex items-center gap-2 lg:gap-4 shrink-0">

                    {/* Backtest Toggle */}
                    <button
                        onClick={toggleBacktest}
                        className={`
            flex items-center gap-2 px-2 lg:px-3 py-1.5 rounded-full border transition-all relative z-10
            ${isBacktest
                                ? 'bg-amber-500/20 border-amber-500/50 text-amber-500 shadow-[0_0_15px_rgba(245,158,11,0.2)]'
                                : 'bg-white/5 border-white/5 text-slate-400 hover:bg-white/10'}
          `}
                    >
                        {isBacktest ? (
                            <>
                                <History size={14} className="animate-spin-slow" />
                                <span className="hidden lg:inline text-xs font-bold uppercase">Replay</span>
                            </>
                        ) : (
                            <>
                                <Radio size={14} />
                                <span className="hidden lg:inline text-xs font-medium">Live</span>
                            </>
                        )}
                    </button>

                    {/* 24h stats + funding countdown (wide screens) */}
                    {!isBacktest && stats.high !== undefined && (
                        <div className="hidden xl:flex items-center gap-3 rounded-full border border-white/5 bg-white/[0.03] px-3 py-1.5 font-mono text-[9px] text-slate-500">
                            <span>H <b className="font-bold text-slate-300">{stats.high.toLocaleString(undefined, { maximumFractionDigits: 1 })}</b></span>
                            <span>L <b className="font-bold text-slate-300">{stats.low?.toLocaleString(undefined, { maximumFractionDigits: 1 })}</b></span>
                            <span>VOL <b className="font-bold text-slate-300">{stats.volume ? `$${(stats.volume / 1e6).toFixed(1)}M` : '—'}</b></span>
                            <span className="text-slate-700">·</span>
                            <span>FUND <b className="font-bold text-slate-300">{fundingIn || '—'}</b></span>
                        </div>
                    )}

                    {/* Upgrade (free users) */}
                    {showUpgrade && (
                        <button onClick={() => setActiveTab('pricing')} title="Upgrade to Pro"
                            className="hidden sm:flex items-center gap-1.5 rounded-full bg-brand-accent px-3 py-1.5 text-[11px] font-bold text-white hover:bg-brand-accent/90 transition-colors">
                            <Sparkles size={12} /> Upgrade
                        </button>
                    )}

                    {/* Quick switcher */}
                    <button onClick={() => window.dispatchEvent(new Event('qd-palette'))} title="Search boards and symbols (⌘K)"
                        className="hidden sm:block p-2 rounded-full hover:bg-white/10 transition-colors text-slate-300">
                        <Search size={18} />
                    </button>

                    {/* Notifications (hidden on the smallest screens to protect header space) */}
                    <button onClick={() => setActiveTab('watchlist')} title={alertCount ? `${alertCount} active alerts` : 'Alerts'}
                        className="relative hidden sm:block p-2 rounded-full hover:bg-white/10 transition-colors text-slate-300">
                        <Bell size={20} className="w-5 h-5 lg:w-5 lg:h-5" />
                        {alertCount > 0 && (
                            <span className="absolute top-2 right-2 w-1.5 h-1.5 lg:w-2 lg:h-2 rounded-full bg-trade-ask border-2 border-[#0B101B]"></span>
                        )}
                    </button>

                    {/* Settings */}
                    <button
                        onClick={() => setActiveTab('settings')}
                        title="Settings"
                        className="p-2 rounded-full hover:bg-white/10 transition-colors text-slate-300"
                    >
                        <Settings size={20} className="w-5 h-5 lg:w-5 lg:h-5" />
                    </button>

                    {/* Profile Avatar / Trigger */}
                    <div className="relative group">
                        {user ? (
                            <button
                                onClick={() => setActiveTab('profile')}
                                title="Profile"
                                className="w-8 h-8 lg:w-9 lg:h-9 rounded-full bg-gradient-to-tr from-brand-accent to-purple-500 border border-white/20 overflow-hidden relative cursor-pointer hover:ring-2 hover:ring-white/20 transition-all"
                            >
                                {user.photoURL ? (
                                    <img src={user.photoURL} alt={user.displayName || "User"} className="w-full h-full object-cover" />
                                ) : (
                                    <div className="w-full h-full flex items-center justify-center text-white font-bold">
                                        {user.displayName?.charAt(0) || <UserIcon size={14} />}
                                    </div>
                                )}
                            </button>
                        ) : (
                            <div className="w-8 h-8 lg:w-9 lg:h-9 rounded-full bg-zinc-800 border border-white/10"></div>
                        )}
                    </div>
                </div>

            </header>
        </>
    );
};

export default Header;
