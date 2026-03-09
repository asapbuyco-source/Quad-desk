import React, { useState, useEffect } from 'react';
import { motion as m } from 'framer-motion';
import { useStore } from '../store';
import {
    Settings, Shield, Activity, Save, Key, Power, Server,
    Eye, EyeOff, AlertTriangle, Wifi, WifiOff, Zap, TrendingUp,
    Clock, ArrowUpRight, ArrowDownRight, History
} from 'lucide-react';
import { doc, setDoc, onSnapshot } from 'firebase/firestore';
import { db, auth } from '../lib/firebase';
import { BotTrade } from '../types';

const motion = m as any;

// Helper: format ms timestamp as "Xs ago" / "Xm ago" / "never"
function timeAgo(ms: number | undefined): string {
    if (!ms) return 'never';
    const age = Math.floor((Date.now() - ms) / 1000);
    if (age < 60) return `${age}s ago`;
    if (age < 3600) return `${Math.floor(age / 60)}m ago`;
    return `${Math.floor(age / 3600)}h ago`;
}

function formatTime(tsMs: number): string {
    if (!tsMs) return '—';
    const d = new Date(tsMs);
    return d.toLocaleString(undefined, {
        month: 'short', day: 'numeric',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        hour12: false,
    });
}

function formatPrice(p: number): string {
    if (!p || p === 0) return '—';
    return p.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Signal colour helper
function signalColor(signal: string | undefined) {
    if (!signal) return 'text-zinc-500';
    if (signal === 'BUY' || signal === 'MEAN_REVERSAL_LONG') return 'text-emerald-400';
    if (signal === 'SELL' || signal === 'MEAN_REVERSAL_SHORT') return 'text-rose-400';
    return 'text-zinc-400';
}

const AdminBotControl: React.FC = () => {
    const { botSettings, setBotSettings, botTrades, subscribeToBotTrades } = useStore();
    const [isSaving, setIsSaving] = useState(false);
    const [showSecret, setShowSecret] = useState(false);
    const [keyError, setKeyError] = useState('');
    const [, setTick] = useState(0); // 1-second ticker for "Xs ago" display

    // Local state for the form so we don't spam the store on every keystroke
    const [formData, setFormData] = useState({
        exchange: botSettings.exchange,
        apiKey: botSettings.apiKey,
        apiSecret: botSettings.apiSecret,
        environment: botSettings.environment,
        tradingPair: botSettings.tradingPair,
        maxRiskPerTradePct: botSettings.maxRiskPerTradePct,
    });

    // ── 1-second tick so "Xs ago" updates without re-fetching ────────────
    useEffect(() => {
        const id = setInterval(() => setTick(t => t + 1), 1000);
        return () => clearInterval(id);
    }, []);

    // ── Subscribe to Firestore bot trade history ──────────────────────────
    useEffect(() => {
        const unsub = subscribeToBotTrades();
        return unsub;
    }, [subscribeToBotTrades]);

    // ── Real-time Firestore heartbeat listener ────────────────────────────
    useEffect(() => {
        const docRef = doc(db, 'botStatus', 'live');
        const unsub = onSnapshot(docRef, (snap) => {
            if (!snap.exists()) return;
            const data = snap.data();
            const heartbeatMs = data.lastHeartbeat?.toMillis?.() ?? 0;
            const isVerified = heartbeatMs > 0 && (Date.now() - heartbeatMs) < 30_000;

            setBotSettings({
                status: isVerified ? 'ONLINE' : 'OFFLINE',
                isActive: isVerified,
                activePositions: data.activePositions ?? 0,
                lastHeartbeat: heartbeatMs,
                botMode: data.mode,
                lastSignal: data.lastSignal,
                totalTrades: data.totalTrades ?? 0,
            });
        });
        return () => unsub();
    }, [setBotSettings]);

    const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
        const { name, value, type } = e.target;
        setFormData(prev => ({
            ...prev,
            [name]: type === 'number' ? parseFloat(value) : value,
        }));
    };

    const handleSave = async () => {
        setIsSaving(true);
        try {
            setBotSettings(formData);
            if (auth.currentUser) {
                const userRef = doc(db, 'users', auth.currentUser.uid);
                await setDoc(userRef, { botSettings: formData }, { merge: true });
            }
            setTimeout(() => setIsSaving(false), 500);
        } catch (error) {
            console.error('Failed to save bot settings:', error);
            setIsSaving(false);
        }
    };

    const toggleMasterSwitch = async () => {
        const newState = !botSettings.isActive;

        if (newState && (!formData.apiKey.trim() || !formData.apiSecret.trim())) {
            setKeyError('API Key and Secret are required. Fill them in and Save first.');
            return;
        }
        setKeyError('');

        const newStatus = newState ? 'ONLINE' : 'OFFLINE';
        setBotSettings({ isActive: newState, status: newStatus });

        if (auth.currentUser) {
            const userRef = doc(db, 'users', auth.currentUser.uid);
            await setDoc(userRef, { botSettings: { ...formData, isActive: newState, status: newStatus } }, { merge: true });
        }
    };

    // Derived values
    const isVerified = botSettings.status === 'ONLINE';
    const heartbeatAge = timeAgo(botSettings.lastHeartbeat);

    return (
        <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="flex flex-col h-full overflow-y-auto px-4 lg:px-8 pb-24 lg:pb-8 pt-6 max-w-4xl mx-auto gap-6"
        >
            {/* ── Header ─────────────────────────────────────────────── */}
            <div className="flex items-center justify-between mb-2">
                <div>
                    <h1 className="text-3xl font-black tracking-tighter uppercase flex items-center gap-3">
                        <Settings className="text-brand-accent" size={28} />
                        Bot Control Center
                    </h1>
                    <p className="text-zinc-500 font-mono text-sm mt-1">Composite Quant Strategy Execution Engine</p>
                </div>

                {/* Master Switch */}
                <button
                    onClick={toggleMasterSwitch}
                    className={`flex items-center gap-2 px-6 py-3 rounded-xl font-bold font-mono transition-all ${isVerified
                        ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/50 shadow-[0_0_20px_rgba(16,185,129,0.2)]'
                        : 'bg-rose-500/10 text-rose-500 border border-rose-500/20'
                        }`}
                >
                    <Power size={18} className={isVerified ? 'animate-pulse' : ''} />
                    {isVerified ? 'SYSTEM ONLINE' : 'SYSTEM OFFLINE'}
                </button>
            </div>

            {/* Key Validation Error */}
            {keyError && (
                <div className="flex items-center gap-3 bg-rose-500/10 border border-rose-500/30 rounded-xl px-5 py-3 text-rose-400 font-mono text-sm">
                    <AlertTriangle size={16} className="shrink-0" />
                    {keyError}
                </div>
            )}

            {/* ── Live Status Cards ───────────────────────────────────── */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">

                {/* Engine Status */}
                <div className="bg-zinc-900/40 border border-white/5 rounded-2xl p-5 flex items-center justify-between">
                    <div>
                        <p className="text-[11px] font-bold text-zinc-500 uppercase">Engine Status</p>
                        <p className={`font-mono font-bold text-lg ${isVerified ? 'text-emerald-400' : 'text-zinc-400'}`}>
                            {isVerified ? 'ONLINE' : 'OFFLINE'}
                        </p>
                        <p className={`text-[10px] font-mono mt-0.5 flex items-center gap-1 ${isVerified ? 'text-emerald-500/70' : 'text-zinc-600'}`}>
                            {isVerified
                                ? <><Wifi size={10} /> Verified {heartbeatAge}</>
                                : <><WifiOff size={10} /> Not connected</>
                            }
                        </p>
                    </div>
                    <Activity className={isVerified ? 'text-emerald-400/50' : 'text-zinc-600'} size={24} />
                </div>

                {/* Bot Mode */}
                <div className="bg-zinc-900/40 border border-white/5 rounded-2xl p-5 flex items-center justify-between">
                    <div>
                        <p className="text-[11px] font-bold text-zinc-500 uppercase">Bot Mode</p>
                        <p className={`font-mono font-bold text-lg uppercase ${botSettings.botMode === 'LIVE' ? 'text-amber-400' : 'text-brand-accent'
                            }`}>
                            {botSettings.botMode ?? formData.environment.toUpperCase()}
                        </p>
                    </div>
                    <Server className="text-brand-accent/50" size={24} />
                </div>

                {/* Last Signal */}
                <div className="bg-zinc-900/40 border border-white/5 rounded-2xl p-5 flex items-center justify-between">
                    <div>
                        <p className="text-[11px] font-bold text-zinc-500 uppercase">Last Signal</p>
                        <p className={`font-mono font-bold text-lg uppercase ${signalColor(botSettings.lastSignal)}`}>
                            {botSettings.lastSignal ?? '—'}
                        </p>
                    </div>
                    <Zap className={signalColor(botSettings.lastSignal)} size={24} />
                </div>

                {/* Active Positions / Trades */}
                <div className="bg-zinc-900/40 border border-white/5 rounded-2xl p-5 flex items-center justify-between">
                    <div>
                        <p className="text-[11px] font-bold text-zinc-500 uppercase">Positions / Trades</p>
                        <p className="font-mono font-bold text-lg text-white">
                            {botSettings.activePositions} / {botSettings.totalTrades ?? 0}
                        </p>
                    </div>
                    <TrendingUp className={botSettings.activePositions > 0 ? 'text-emerald-400/60' : 'text-zinc-600'} size={24} />
                </div>
            </div>

            {/* ── API Configuration ───────────────────────────────────── */}
            <div className="bg-black/40 border border-white/10 rounded-2xl p-6 lg:p-8">
                <h2 className="text-xl font-bold tracking-widest uppercase border-b border-white/10 pb-4 mb-6 text-zinc-300 flex items-center gap-2">
                    <Key size={20} className="text-brand-accent" /> Exchange Integration
                </h2>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-6">
                    <div>
                        <label className="block text-xs font-bold text-zinc-500 uppercase mb-2">Exchange</label>
                        <select
                            name="exchange"
                            value={formData.exchange}
                            onChange={handleChange}
                            className="w-full bg-zinc-900 border border-white/10 rounded-xl px-4 py-3 text-white font-mono outline-none focus:border-brand-accent transition-colors appearance-none"
                        >
                            <option value="binance">Binance</option>
                            <option value="bybit">Bybit</option>
                        </select>
                    </div>
                    <div>
                        <label className="block text-xs font-bold text-zinc-500 uppercase mb-2">Environment</label>
                        <select
                            name="environment"
                            value={formData.environment}
                            onChange={handleChange}
                            className="w-full bg-zinc-900 border border-white/10 rounded-xl px-4 py-3 text-white font-mono outline-none focus:border-brand-accent transition-colors appearance-none"
                        >
                            <option value="testnet">Testnet (Demo Money)</option>
                            <option value="live">Live (Real Capital)</option>
                        </select>
                    </div>
                </div>

                <div className="space-y-4">
                    <div>
                        <label className="block text-xs font-bold text-zinc-500 uppercase mb-2">API Key</label>
                        <input
                            type="text"
                            name="apiKey"
                            value={formData.apiKey}
                            onChange={handleChange}
                            placeholder="Enter your Exchange API Key"
                            className="w-full bg-zinc-900 border border-white/10 rounded-xl px-4 py-3 text-white font-mono text-sm outline-none focus:border-brand-accent transition-colors"
                        />
                    </div>
                    <div>
                        <label className="block text-xs font-bold text-zinc-500 uppercase mb-2">API Secret</label>
                        <div className="relative">
                            <input
                                type={showSecret ? 'text' : 'password'}
                                name="apiSecret"
                                value={formData.apiSecret}
                                onChange={handleChange}
                                placeholder="Enter your Exchange API Secret"
                                className="w-full bg-zinc-900 border border-white/10 rounded-xl px-4 py-3 text-white font-mono text-sm outline-none focus:border-brand-accent transition-colors pr-12"
                            />
                            <button
                                onClick={() => setShowSecret(!showSecret)}
                                className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-white transition-colors"
                            >
                                {showSecret ? <EyeOff size={18} /> : <Eye size={18} />}
                            </button>
                        </div>
                    </div>
                </div>
            </div>

            {/* ── Risk Management ─────────────────────────────────────── */}
            <div className="bg-black/40 border border-white/10 rounded-2xl p-6 lg:p-8">
                <h2 className="text-xl font-bold tracking-widest uppercase border-b border-white/10 pb-4 mb-6 text-zinc-300 flex items-center gap-2">
                    <Shield size={20} className="text-rose-400" /> Risk Management
                </h2>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    <div>
                        <label className="block text-xs font-bold text-zinc-500 uppercase mb-2">Target Trading Pair</label>
                        <input
                            type="text"
                            name="tradingPair"
                            value={formData.tradingPair}
                            onChange={handleChange}
                            placeholder="e.g. BTCUSDT"
                            className="w-full bg-zinc-900 border border-white/10 rounded-xl px-4 py-3 text-white font-mono text-sm outline-none focus:border-rose-400 transition-colors uppercase"
                        />
                    </div>
                    <div>
                        <label className="block text-xs font-bold text-zinc-500 uppercase mb-2">Max Risk Per Trade (%)</label>
                        <div className="flex items-center gap-3">
                            <input
                                type="number"
                                name="maxRiskPerTradePct"
                                value={formData.maxRiskPerTradePct}
                                onChange={handleChange}
                                step="0.1"
                                min="0.1"
                                max="10"
                                className="w-full bg-zinc-900 border border-white/10 rounded-xl px-4 py-3 text-white font-mono text-sm outline-none focus:border-rose-400 transition-colors"
                            />
                            <span className="text-zinc-500 font-mono">%</span>
                        </div>
                        <p className="text-xs text-zinc-500 mt-2">
                            Position size is calculated so that hitting the stop-loss never exceeds this % of equity.
                        </p>
                    </div>
                </div>
            </div>

            {/* ── Save Action ─────────────────────────────────────────── */}
            <div className="flex justify-end pt-2">
                <button
                    onClick={handleSave}
                    disabled={isSaving}
                    className="px-8 py-4 bg-brand-accent/20 text-brand-accent border border-brand-accent/50 hover:bg-brand-accent/30 rounded-xl font-bold font-mono tracking-widest uppercase flex items-center gap-2 transition-all hover:shadow-[0_0_20px_rgba(56,189,248,0.2)] disabled:opacity-50"
                >
                    <Save size={18} />
                    {isSaving ? 'SAVING...' : 'SAVE CONFIGURATION'}
                </button>
            </div>

            {/* ── Bot Trade History ────────────────────────────────────── */}
            <div className="bg-black/40 border border-white/10 rounded-2xl p-6 lg:p-8">
                <h2 className="text-xl font-bold tracking-widest uppercase border-b border-white/10 pb-4 mb-5 text-zinc-300 flex items-center gap-2">
                    <History size={20} className="text-brand-accent" /> Trade History
                    <span className="ml-auto text-xs font-mono text-zinc-600 normal-case tracking-normal">
                        Live from Firestore · Last {botTrades.length} trades
                    </span>
                </h2>

                {botTrades.length === 0 ? (
                    <div className="flex flex-col items-center justify-center py-12 gap-3 text-zinc-600">
                        <Clock size={36} className="opacity-30" />
                        <p className="font-mono text-sm">No trades yet — the bot will log here when it executes.</p>
                    </div>
                ) : (
                    <div className="overflow-x-auto">
                        <table className="w-full text-sm font-mono">
                            <thead>
                                <tr className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest border-b border-white/5">
                                    <th className="text-left pb-3 pr-4">Time</th>
                                    <th className="text-left pb-3 pr-4">Pair</th>
                                    <th className="text-left pb-3 pr-4">Signal</th>
                                    <th className="text-right pb-3 pr-4">Entry</th>
                                    <th className="text-right pb-3 pr-4">Stop Loss</th>
                                    <th className="text-right pb-3">Take Profit</th>
                                </tr>
                            </thead>
                            <tbody>
                                {botTrades.map((trade: BotTrade, idx: number) => {
                                    const isBuy = trade.side === 'buy';
                                    const isFirst = idx === 0;
                                    return (
                                        <tr
                                            key={trade.id}
                                            className={`border-b border-white/5 transition-colors hover:bg-white/[0.02] ${isFirst ? 'bg-white/[0.015]' : ''}`}
                                        >
                                            {/* Time */}
                                            <td className="py-3 pr-4 text-zinc-500 text-[11px] whitespace-nowrap">
                                                {formatTime(trade.ts_ms)}
                                            </td>

                                            {/* Pair */}
                                            <td className="py-3 pr-4 text-white font-bold">
                                                {trade.symbol}
                                                {isFirst && (
                                                    <span className="ml-2 text-[9px] bg-brand-accent/20 text-brand-accent border border-brand-accent/30 px-1.5 py-0.5 rounded-full">
                                                        LATEST
                                                    </span>
                                                )}
                                            </td>

                                            {/* Signal / Side */}
                                            <td className="py-3 pr-4">
                                                <span className={`flex items-center gap-1 font-bold text-xs ${isBuy ? 'text-emerald-400' : 'text-rose-400'}`}>
                                                    {isBuy
                                                        ? <ArrowUpRight size={13} />
                                                        : <ArrowDownRight size={13} />
                                                    }
                                                    {trade.verdict}
                                                </span>
                                                <span className="text-[10px] text-zinc-600 mt-0.5 block">
                                                    {trade.mode}
                                                </span>
                                            </td>

                                            {/* Entry */}
                                            <td className="py-3 pr-4 text-right text-white">
                                                {formatPrice(trade.entry_price)}
                                            </td>

                                            {/* Stop Loss */}
                                            <td className="py-3 pr-4 text-right text-rose-400">
                                                {formatPrice(trade.stop_loss)}
                                            </td>

                                            {/* Take Profit */}
                                            <td className="py-3 text-right text-emerald-400">
                                                {formatPrice(trade.take_profit)}
                                            </td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                    </div>
                )}
            </div>

            <div className="h-10" />
        </motion.div>
    );
};

export default AdminBotControl;
