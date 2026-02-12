
import React, { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { User, LogOut, X, BrainCircuit, Cpu, MessageSquare, Save, Lock, AlertCircle, History, Send } from 'lucide-react';
import { useStore } from '../store';

const AI_MODELS = [
    { id: 'gemini-3-pro-preview', label: 'Gemini 3 Pro', desc: 'High Reasoning (Complex Tasks)' },
    { id: 'gemini-3-flash-preview', label: 'Gemini 3 Flash', desc: 'Low Latency (Fast)' },
    { id: 'gemini-flash-latest', label: 'Gemini Flash', desc: 'Standard Flash' },
];

const ProfileOverlay: React.FC = () => {
    const { 
        auth: { user }, 
        config: { aiModel, telegramBotToken, telegramChatId },
        ui: { isProfileOpen },
        alertLogs,
        setProfileOpen, 
        setAiModel, 
        updateUserProfile,
        logout
    } = useStore();

    const [tempBotToken, setTempBotToken] = useState(telegramBotToken);
    const [tempChatId, setTempChatId] = useState(telegramChatId);
    const [isSaving, setIsSaving] = useState(false);
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
        await updateUserProfile({
            telegramBotToken: tempBotToken,
            telegramChatId: tempChatId
        });
        setIsSaving(false);
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
                                <p className="text-[10px] text-zinc-500 leading-relaxed px-1">
                                    Your AI model preference is synchronized to the cloud and will persist across sessions.
                                </p>
                            </div>

                            {/* Telegram Integration */}
                            <div className="space-y-4 pt-4 border-t border-white/5">
                                <div className="flex items-center justify-between">
                                    <div className="flex items-center gap-2 text-sm font-bold text-white">
                                        <MessageSquare size={16} className="text-blue-400" />
                                        Telegram Alerts
                                    </div>
                                    <div className="text-[9px] font-bold bg-blue-500/10 text-blue-400 px-2 py-0.5 rounded border border-blue-500/20">BETA</div>
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

                                <div className="bg-amber-500/5 border border-amber-500/10 rounded-lg p-3 flex gap-3 items-start">
                                    <AlertCircle size={14} className="text-amber-500 shrink-0 mt-0.5" />
                                    <p className="text-[10px] text-amber-500/80 leading-relaxed">
                                        Providing custom credentials overrides the default system bot. Ensure your bot has permission to post in the specified chat.
                                    </p>
                                </div>

                                <button 
                                    onClick={handleSave}
                                    disabled={isSaving}
                                    className="w-full py-2.5 bg-zinc-800 hover:bg-zinc-700 text-white text-xs font-bold rounded-xl flex items-center justify-center gap-2 transition-all"
                                >
                                    {isSaving ? <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : <Save size={14} />}
                                    SAVE CONFIGURATION
                                </button>
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
