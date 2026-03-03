import React, { useState } from 'react';
import { motion as m } from 'framer-motion';
import { useStore } from '../store';
import { Settings, Shield, Activity, Save, Key, Power, Server, Eye, EyeOff, AlertTriangle } from 'lucide-react';
import { doc, setDoc } from 'firebase/firestore';
import { db, auth } from '../lib/firebase';

const motion = m as any;

const AdminBotControl: React.FC = () => {
    const { botSettings, setBotSettings } = useStore();
    const [isSaving, setIsSaving] = useState(false);
    const [showSecret, setShowSecret] = useState(false);
    const [keyError, setKeyError] = useState('');

    // Local state for the form so we don't spam the store on every keystroke
    const [formData, setFormData] = useState({
        exchange: botSettings.exchange,
        apiKey: botSettings.apiKey,
        apiSecret: botSettings.apiSecret,
        environment: botSettings.environment,
        tradingPair: botSettings.tradingPair,
        maxRiskPerTradePct: botSettings.maxRiskPerTradePct,
    });

    const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
        const { name, value, type } = e.target;
        setFormData(prev => ({
            ...prev,
            [name]: type === 'number' ? parseFloat(value) : value
        }));
    };

    const handleSave = async () => {
        setIsSaving(true);
        try {
            // 1. Save to local Zustand store
            setBotSettings(formData);

            // 2. Save securely to Firebase under the admin's document
            if (auth.currentUser) {
                const userRef = doc(db, 'users', auth.currentUser.uid);
                await setDoc(userRef, { botSettings: formData }, { merge: true });
            }

            // Show brief success state
            setTimeout(() => setIsSaving(false), 500);
        } catch (error) {
            console.error("Failed to save bot settings:", error);
            setIsSaving(false);
        }
    };

    const toggleMasterSwitch = async () => {
        const newState = !botSettings.isActive;

        // Validate API keys exist before going ONLINE
        if (newState && (!formData.apiKey.trim() || !formData.apiSecret.trim())) {
            setKeyError('API Key and Secret are required to activate the engine. Please fill them in and Save first.');
            return;
        }
        setKeyError('');

        const newStatus = newState ? 'ONLINE' : 'OFFLINE';
        setBotSettings({ isActive: newState, status: newStatus });

        // Sync the master switch toggle to Firebase explicitly
        if (auth.currentUser) {
            const userRef = doc(db, 'users', auth.currentUser.uid);
            await setDoc(userRef, { botSettings: { ...formData, isActive: newState, status: newStatus } }, { merge: true });
        }
    };

    return (
        <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="flex flex-col h-full overflow-y-auto px-4 lg:px-8 pb-24 lg:pb-8 pt-6 max-w-4xl mx-auto gap-6"
        >
            <div className="flex items-center justify-between mb-2">
                <div>
                    <h1 className="text-3xl font-black tracking-tighter uppercase flex items-center gap-3">
                        <Settings className="text-brand-accent" size={28} />
                        Bot Control Center
                    </h1>
                    <p className="text-zinc-500 font-mono text-sm mt-1">Manage Macro Strategy Execution Engine</p>
                </div>

                {/* Master Switch */}
                <button
                    onClick={toggleMasterSwitch}
                    className={`flex items-center gap-2 px-6 py-3 rounded-xl font-bold font-mono transition-all ${botSettings.isActive
                        ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/50 shadow-[0_0_20px_rgba(16,185,129,0.2)]'
                        : 'bg-rose-500/10 text-rose-500 border border-rose-500/20'
                        }`}
                >
                    <Power size={18} className={botSettings.isActive ? 'animate-pulse' : ''} />
                    {botSettings.isActive ? 'SYSTEM ONLINE' : 'SYSTEM OFFLINE'}
                </button>
            </div>

            {/* Key Validation Error Banner */}
            {keyError && (
                <div className="flex items-center gap-3 bg-rose-500/10 border border-rose-500/30 rounded-xl px-5 py-3 text-rose-400 font-mono text-sm">
                    <AlertTriangle size={16} className="shrink-0" />
                    {keyError}
                </div>
            )}

            {/* Status Overview */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
                <div className="bg-zinc-900/40 border border-white/5 rounded-2xl p-5 flex items-center justify-between">
                    <div>
                        <p className="text-[11px] font-bold text-zinc-500 uppercase">Engine Status</p>
                        <p className={`font-mono font-bold text-xl ${botSettings.status === 'ONLINE' ? 'text-emerald-400' : 'text-zinc-400'}`}>
                            {botSettings.status}
                        </p>
                    </div>
                    <Activity className={botSettings.status === 'ONLINE' ? 'text-emerald-400/50' : 'text-zinc-500'} size={24} />
                </div>
                <div className="bg-zinc-900/40 border border-white/5 rounded-2xl p-5 flex items-center justify-between">
                    <div>
                        <p className="text-[11px] font-bold text-zinc-500 uppercase">Environment</p>
                        <p className="font-mono font-bold text-xl text-brand-accent uppercase">
                            {formData.environment}
                        </p>
                    </div>
                    <Server className="text-brand-accent/50" size={24} />
                </div>
                <div className="bg-zinc-900/40 border border-white/5 rounded-2xl p-5 flex items-center justify-between">
                    <div>
                        <p className="text-[11px] font-bold text-zinc-500 uppercase">Active Positions</p>
                        <p className="font-mono font-bold text-xl text-white">
                            {botSettings.activePositions}
                        </p>
                    </div>
                    <Shield className="text-zinc-500" size={24} />
                </div>
            </div>

            {/* API Configuration */}
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
                                type={showSecret ? "text" : "password"}
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

            {/* Risk Management */}
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
                            The engine will adjust position size so that hitting the AI stop loss never exceeds this percentage of your account equity.
                        </p>
                    </div>
                </div>
            </div>

            {/* Save Action */}
            <div className="flex justify-end pt-4">
                <button
                    onClick={handleSave}
                    disabled={isSaving}
                    className="px-8 py-4 bg-brand-accent/20 text-brand-accent border border-brand-accent/50 hover:bg-brand-accent/30 rounded-xl font-bold font-mono tracking-widest uppercase flex items-center gap-2 transition-all hover:shadow-[0_0_20px_rgba(56,189,248,0.2)] disabled:opacity-50"
                >
                    <Save size={18} />
                    {isSaving ? 'SAVING...' : 'SAVE CONFIGURATION'}
                </button>
            </div>

            <div className="h-10"></div>
        </motion.div>
    );
};

export default AdminBotControl;
