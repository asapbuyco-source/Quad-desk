
import React, { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { User, LogOut, X, BrainCircuit, Cpu, MessageSquare, Save, Lock, History, Send, Loader } from 'lucide-react';
import { useStore } from '../store';
import { API_BASE_URL } from '../constants';

const AI_MODELS = [
    { id: 'gemini-3-pro-preview', label: 'Gemini 3 Pro', desc: 'High Reasoning (Complex Tasks)' },
    { id: 'gemini-3-flash-preview', label: 'Gemini 3 Flash', desc: 'Low Latency (Fast)' },
    { id: 'gemini-flash-latest', label: 'Gemini Flash', desc: 'Standard Flash' },
];

const ProfileOverlay: React.FC = () => {
    const { 
        auth: { user }, 
        config: { aiModel, telegramBotToken, telegramChatId, activeSymbol },
        ui: { isProfileOpen },
        alertLogs,
        setProfileOpen, 
        setAiModel, 
        updateUserProfile,
        logout,
        addNotification
    } = useStore();

    const [tempBotToken, setTempBotToken] = useState(telegramBotToken);
    const [tempChatId, setTempChatId] = useState(telegramChatId);
    const [isSaving, setIsSaving] = useState(false);
    const [isSendingTest, setIsSendingTest] = useState(false);
    const [activeTab, setActiveTab] = useState<'SETTINGS' | 'LOGS'>('SETTINGS');

    // Sync state when opening
    useEffect(() => {
        if (isProfileOpen) {
            setTempBotToken(telegramBotToken);
            setTempChatId(telegramChatId);
            setActiveTab('SETTINGS');
        }
    }, [isProfileOpen, telegramBotToken, telegramChatId]);

    const handleSave = async () => {
        setIsSaving(true);
        try {
            // Update Store
            await updateUserProfile({
                telegramBotToken: tempBotToken,
                telegramChatId: tempChatId
            });
            
            // Push to Backend for Autonomous Mode
            await fetch(`${API_BASE_URL}/alerts/configure`, {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({
                    symbol: activeSymbol,
                    telegram_bot_token: tempBotToken,
                    telegram_chat_id: tempChatId
                })
            });
            
            addNotification({
                id: Date.now().toString(),
                type: 'success',
                title: 'Settings Saved',
                message: 'Configuration pushed to autonomous backend.'
            });
        } catch (e) {
            console.error(e);
        } finally {
            setIsSaving(false);
        }
    };

    const handleTestAlert = async () => {
        setIsSendingTest(true);
        try {
            const res = await fetch(`${API_BASE_URL}/alerts/test`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    symbol: activeSymbol,
                    direction: 'LONG',
                    confidence: 1.0,
                    entry: 0, stop: 0, target: 0, rrRatio: 0,
                    reasoning: "TEST", conditions: [],
                    botToken: tempBotToken,
                    chatId: tempChatId
                })
            });
            const data = await res.json();
            if (data.success) {
                addNotification({
                    id: Date.now().toString(),
                    type: 'success',
                    title: 'Test Sent',
                    message: 'Check your Telegram for the verification message.'
                });
            } else {
                throw new Error(data.message);
            }
        } catch (e: any) {
            addNotification({
                id: Date.now().toString(),
                type: 'error',
                title: 'Test Failed',
                message: e.message
            });
        } finally {
            setIsSendingTest(false);
        }
    };

    if (!isProfileOpen || !user) return null;

    return (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
            <motion.div 
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                onClick={() => setProfileOpen(false)}
                className="absolute inset-0 bg-black/60 backdrop-blur-sm"
            />
            
            <motion.div 
                initial={{ opacity: 0, scale: 0.95, y: 20 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.95, y: 20 }}
                className="relative z-10 w-full max-w-md bg-[#18181b] border border-white/10 rounded-3xl shadow-2xl overflow-hidden flex flex-col max-h-[85vh]"
            >
                {/* Header Profile Section */}
                <div className="relative p-6 border-b border-white/5 bg-gradient-to-b from-white/5 to-transparent">
                    <button 
                        onClick={() => setProfileOpen(false)}
                        className="absolute top-4 right-4 p-2 rounded-full hover:bg-white/10 text-zinc-500 hover:text-white transition-colors"
                    >
                        <X size={18} />
                    </button>

                    <div className="flex items-center gap-4">
                        <div className="w-16 h-16 rounded-2xl bg-gradient-to-tr from-brand-accent to-purple-600 p-0.5 shadow-lg shadow-purple-500/20">
                            <div className="w-full h-full bg-[#18181b] rounded-2xl overflow-hidden relative">
                                {user.photoURL ? (
                                    <img src={user.photoURL} alt="Profile" className="w-full h-full object-cover" />
                                ) : (
                                    <div className="w-full h-full flex items-center justify-center bg-zinc-800 text-zinc-400">
                                        <User size={24} />
                                    </div>
                                )}
                            </div>
                        </div>
                        <div>
                            <h2 className="text-xl font-bold text-white">{user.displayName || 'Vantage Operator'}</h2>
                            <p className="text-xs text-zinc-400 font-mono">{user.email}</p>
                            <div className="mt-2 flex items-center gap-2">
                                <span className="px-2 py-0.5 rounded bg-emerald-500/10 border border-emerald-500/20 text-[9px] font-bold text-emerald-500 uppercase tracking-wide">
                                    Active Session
                                </span>
                            </div>
                        </div>
                    </div>
                </div>

                {/* Tab Nav */}
                <div className="flex p-1 bg-black/40 border-b border-white/5">
                    <button 
                        onClick={() => setActiveTab('SETTINGS')}
                        className={`flex-1 py-2 text-xs font-bold uppercase rounded-lg transition-all ${activeTab === 'SETTINGS' ? 'bg-white/10 text-white' : 'text-zinc-500 hover:text-zinc-300'}`}
                    >
                        Configuration
                    </button>
                    <button 
                        onClick={() => setActiveTab('LOGS')}
                        className={`flex-1 py-2 text-xs font-bold uppercase rounded-lg transition-all ${activeTab === 'LOGS' ? 'bg-white/10 text-white' : 'text-zinc-500 hover:text-zinc-300'}`}
                    >
                        Alert Logs
                    </button>
                </div>

                <div className="flex-1 overflow-y-auto p-6 space-y-8 bg-[#18181b]">
                    
                    {activeTab === 'SETTINGS' ? (
                        <>
                            {/* AI Configuration */}
                            <div className="space-y-4">
                                <div className="flex items-center gap-2 text-sm font-bold text-white">
                                    <BrainCircuit size={16} className="text-brand-accent" />
                                    AI Configuration
                                </div>
                                
                                <div className="grid gap-2">
                                    {AI_MODELS.map((model) => (
                                        <button
                                            key={model.id}
                                            onClick={() => setAiModel(model.id)}
                                            className={`
                                                flex items-center justify-between p-3 rounded-xl border text-left transition-all
                                                ${aiModel === model.id 
                                                    ? 'bg-brand-accent/10 border-brand-accent/50 shadow-[0_0_15px_rgba(124,58,237,0.1)]' 
                                                    : 'bg-zinc-900/50 border-white/5 hover:border-white/10 hover:bg-zinc-900'}
                                            `}
                                        >
                                            <div>
                                                <div className={`text-sm font-bold ${aiModel === model.id ? 'text-brand-accent' : 'text-zinc-300'}`}>
                                                    {model.label}
                                                </div>
                                                <div className="text-[10px] text-zinc-500">{model.desc}</div>
                                            </div>
                                            {aiModel === model.id && <Cpu size={14} className="text-brand-accent" />}
                                        </button>
                                    ))}
                                </div>
                            </div>

                            {/* Telegram Integration */}
                            <div className="space-y-4 pt-4 border-t border-white/5">
                                <div className="flex items-center justify-between">
                                    <div className="flex items-center gap-2 text-sm font-bold text-white">
                                        <MessageSquare size={16} className="text-blue-400" />
                                        Telegram Alerts
                                    </div>
                                    <div className="text-[9px] font-bold bg-blue-500/10 text-blue-400 px-2 py-0.5 rounded border border-blue-500/20">24/7 AUTONOMOUS</div>
                                </div>

                                <div className="space-y-3">
                                    <div className="space-y-1">
                                        <label className="text-[10px] font-bold text-zinc-500 uppercase ml-1">Bot Token</label>
                                        <div className="relative">
                                            <input 
                                                type="password" 
                                                value={tempBotToken}
                                                onChange={(e) => setTempBotToken(e.target.value)}
                                                placeholder="123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11"
                                                className="w-full bg-zinc-900/50 border border-white/10 rounded-xl px-4 py-2.5 text-sm text-white font-mono focus:outline-none focus:border-blue-500/50 focus:ring-1 focus:ring-blue-500/20 transition-all placeholder:text-zinc-700"
                                            />
                                            <Lock size={12} className="absolute right-4 top-3 text-zinc-600" />
                                        </div>
                                    </div>

                                    <div className="space-y-1">
                                        <label className="text-[10px] font-bold text-zinc-500 uppercase ml-1">Chat ID</label>
                                        <input 
                                            type="text" 
                                            value={tempChatId}
                                            onChange={(e) => setTempChatId(e.target.value)}
                                            placeholder="-100123456789"
                                            className="w-full bg-zinc-900/50 border border-white/10 rounded-xl px-4 py-2.5 text-sm text-white font-mono focus:outline-none focus:border-blue-500/50 focus:ring-1 focus:ring-blue-500/20 transition-all placeholder:text-zinc-700"
                                        />
                                    </div>
                                </div>

                                <div className="flex gap-2">
                                    <button 
                                        onClick={handleTestAlert}
                                        disabled={isSendingTest}
                                        className="flex-1 py-2.5 bg-blue-600/20 hover:bg-blue-600/30 text-blue-400 text-xs font-bold rounded-xl flex items-center justify-center gap-2 border border-blue-600/50 transition-all"
                                    >
                                        {isSendingTest ? <Loader size={14} className="animate-spin" /> : <Send size={14} />}
                                        TEST ALERT
                                    </button>
                                    <button 
                                        onClick={handleSave}
                                        disabled={isSaving}
                                        className="flex-[2] py-2.5 bg-zinc-800 hover:bg-zinc-700 text-white text-xs font-bold rounded-xl flex items-center justify-center gap-2 transition-all"
                                    >
                                        {isSaving ? <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : <Save size={14} />}
                                        SAVE CONFIG
                                    </button>
                                </div>
                            </div>
                        </>
                    ) : (
                        <div className="space-y-4">
                            <div className="flex items-center gap-2 text-sm font-bold text-white mb-2">
                                <History size={16} className="text-zinc-400" />
                                Recent Broadcasts
                            </div>

                            {alertLogs.length === 0 ? (
                                <div className="py-12 flex flex-col items-center justify-center text-zinc-600 gap-2 border border-dashed border-white/5 rounded-xl">
                                    <MessageSquare size={24} className="opacity-20" />
                                    <span className="text-xs font-mono uppercase tracking-widest">No Alerts Logged</span>
                                </div>
                            ) : (
                                <div className="space-y-2">
                                    {alertLogs.map((log) => (
                                        <div key={log.id} className="p-3 bg-zinc-900/50 border border-white/5 rounded-xl flex justify-between items-center group hover:border-white/10 transition-colors">
                                            <div className="flex flex-col gap-1">
                                                <div className="flex items-center gap-2">
                                                    <span className={`text-xs font-bold ${log.direction === 'LONG' ? 'text-emerald-400' : 'text-rose-400'}`}>
                                                        {log.direction} {log.symbol}
                                                    </span>
                                                    <span className="text-[9px] bg-zinc-800 text-zinc-400 px-1.5 py-0.5 rounded font-mono">
                                                        {(log.confidence * 100).toFixed(0)}%
                                                    </span>
                                                </div>
                                                <span className="text-[10px] text-zinc-500 font-mono">
                                                    {new Date(log.timestamp).toLocaleString()}
                                                </span>
                                            </div>
                                            <div className="flex items-center gap-2">
                                                <span className={`text-[10px] font-bold uppercase ${log.result.includes('FAILED') ? 'text-rose-500' : 'text-emerald-500'}`}>
                                                    {log.result === 'SENT' ? 'SENT' : 'ERR'}
                                                </span>
                                                <div className={`p-1.5 rounded-full ${log.result.includes('FAILED') ? 'bg-rose-500/10 text-rose-500' : 'bg-emerald-500/10 text-emerald-500'}`}>
                                                    <Send size={12} />
                                                </div>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>
                    )}

                </div>

                {/* Footer Actions */}
                <div className="p-4 border-t border-white/5 bg-[#121215]">
                    <button 
                        onClick={() => { setProfileOpen(false); logout(); }}
                        className="w-full py-3 border border-rose-500/20 hover:bg-rose-500/10 text-rose-500 text-xs font-bold rounded-xl flex items-center justify-center gap-2 transition-all"
                    >
                        <LogOut size={14} /> LOGOUT SECURELY
                    </button>
                </div>
            </motion.div>
        </div>
    );
};

export default ProfileOverlay;
