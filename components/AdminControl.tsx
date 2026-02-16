
import React, { useEffect, useState, useRef } from 'react';
import { motion as m, AnimatePresence } from 'framer-motion';
import { ShieldAlert, ToggleLeft, ToggleRight, X, Activity, Server, Cpu, Terminal, RefreshCw, AlertTriangle, CheckCircle2 } from 'lucide-react';
import { useStore } from '../store';
import { API_BASE_URL } from '../constants';
import { SystemHealth, LogEntry } from '../types';

const motion = m as any;

const SystemMonitor: React.FC = () => {
    const [health, setHealth] = useState<SystemHealth | null>(null);
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const logContainerRef = useRef<HTMLDivElement>(null);

    const fetchStatus = async () => {
        setIsLoading(true);
        try {
            const res = await fetch(`${API_BASE_URL}/admin/system-status`);
            if (!res.ok) throw new Error("Connection Refused");
            const data = await res.json();
            setHealth(data);
            setError(null);
        } catch (e: any) {
            setError(e.message);
        } finally {
            setIsLoading(false);
        }
    };

    // Auto-poll and scroll to bottom
    useEffect(() => {
        fetchStatus();
        const interval = setInterval(fetchStatus, 2000); // 2s polling for live logs
        return () => clearInterval(interval);
    }, []);

    useEffect(() => {
        if (logContainerRef.current) {
            logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
        }
    }, [health?.logs]);

    return (
        <div className="space-y-4">
            {/* Health Stats Bar */}
            <div className="grid grid-cols-4 gap-3">
                <div className="p-3 bg-zinc-900/50 rounded-xl border border-white/5 flex flex-col">
                    <span className="text-[10px] text-zinc-500 font-bold uppercase flex items-center gap-1">
                        <Activity size={12} /> Uptime
                    </span>
                    <span className="text-lg font-mono font-bold text-white">{health?.uptime || '--:--:--'}</span>
                </div>
                <div className="p-3 bg-zinc-900/50 rounded-xl border border-white/5 flex flex-col">
                    <span className="text-[10px] text-zinc-500 font-bold uppercase flex items-center gap-1">
                        <Cpu size={12} /> CPU Load
                    </span>
                    <span className={`text-lg font-mono font-bold ${(health?.cpu_percent || 0) > 80 ? 'text-rose-500' : 'text-emerald-500'}`}>
                        {health?.cpu_percent.toFixed(1) || 0}%
                    </span>
                </div>
                <div className="p-3 bg-zinc-900/50 rounded-xl border border-white/5 flex flex-col">
                    <span className="text-[10px] text-zinc-500 font-bold uppercase flex items-center gap-1">
                        <Server size={12} /> Memory
                    </span>
                    <span className="text-lg font-mono font-bold text-blue-400">
                        {health?.memory_mb.toFixed(0) || 0} MB
                    </span>
                </div>
                 <div className="p-3 bg-zinc-900/50 rounded-xl border border-white/5 flex flex-col">
                    <span className="text-[10px] text-zinc-500 font-bold uppercase flex items-center gap-1">
                        <ShieldAlert size={12} /> Mode
                    </span>
                    <span className={`text-sm font-mono font-bold mt-1 ${health?.autonomous_active ? 'text-purple-400' : 'text-zinc-500'}`}>
                        {health?.autonomous_active ? 'AUTONOMOUS' : 'PASSIVE'}
                    </span>
                </div>
            </div>

            {/* Logs Terminal */}
            <div className="bg-[#0c0c0e] rounded-xl border border-white/10 overflow-hidden flex flex-col h-[300px]">
                <div className="bg-white/5 px-3 py-2 flex items-center justify-between border-b border-white/5">
                    <div className="flex items-center gap-2 text-xs font-mono text-zinc-400">
                        <Terminal size={12} /> backend/logs/stream
                    </div>
                    {error && (
                        <div className="flex items-center gap-1 text-[10px] text-rose-500 font-bold uppercase">
                            <AlertTriangle size={10} /> OFFLINE
                        </div>
                    )}
                    {isLoading && !error && (
                         <RefreshCw size={10} className="text-zinc-500 animate-spin" />
                    )}
                </div>
                
                <div 
                    ref={logContainerRef}
                    className="flex-1 overflow-y-auto p-3 font-mono text-[10px] space-y-1"
                >
                    {error ? (
                        <div className="text-rose-500 opacity-80">> Connection to backend failed: {error}</div>
                    ) : health?.logs && health.logs.length > 0 ? (
                        health.logs.map((log, i) => (
                            <div key={i} className="flex gap-2 hover:bg-white/5 px-1 rounded">
                                <span className="text-zinc-600 shrink-0">[{new Date(log.timestamp).toLocaleTimeString()}]</span>
                                <span className={`shrink-0 font-bold w-12 ${
                                    log.level === 'INFO' ? 'text-emerald-500' :
                                    log.level === 'WARNING' ? 'text-amber-500' :
                                    log.level === 'ERROR' ? 'text-rose-500' : 'text-blue-500'
                                }`}>
                                    {log.level}
                                </span>
                                <span className="text-zinc-500 shrink-0 hidden sm:block w-20 truncate">[{log.module}]</span>
                                <span className="text-zinc-300 break-all">{log.message}</span>
                            </div>
                        ))
                    ) : (
                        <div className="text-zinc-600 italic">> No logs available or buffer empty.</div>
                    )}
                </div>
            </div>
        </div>
    );
};

const AdminControl: React.FC = () => {
    const { auth: { user, registrationOpen }, toggleRegistration } = useStore();
    const [isOpen, setIsOpen] = useState(false);
    const [activeTab, setActiveTab] = useState<'CONFIG' | 'HEALTH'>('CONFIG');

    // Hardcoded Admin Check based on prompt requirements
    const isAdmin = user?.email?.toLowerCase() === 'abrackly@gmail.com';

    if (!isAdmin || !user) return null;

    return (
        <>
            {/* Floating Admin Badge */}
            <motion.button
                onClick={() => setIsOpen(true)}
                className="fixed bottom-6 left-6 z-[60] px-3 py-2 bg-rose-500/10 border border-rose-500/30 rounded-full text-rose-500 flex items-center gap-2 backdrop-blur-md hover:bg-rose-500/20 transition-colors group"
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
            >
                <ShieldAlert size={16} />
                <span className="text-[10px] font-bold uppercase tracking-wider hidden group-hover:inline-block">Admin Control</span>
            </motion.button>

            {/* Admin Modal */}
            <AnimatePresence>
                {isOpen && (
                    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
                        <motion.div 
                            initial={{ opacity: 0 }}
                            animate={{ opacity: 1 }}
                            exit={{ opacity: 0 }}
                            onClick={() => setIsOpen(false)}
                            className="absolute inset-0 bg-black/60 backdrop-blur-sm"
                        />
                        <motion.div 
                            initial={{ scale: 0.95, opacity: 0 }}
                            animate={{ scale: 1, opacity: 1 }}
                            exit={{ scale: 0.95, opacity: 0 }}
                            className="relative z-10 w-full max-w-4xl bg-[#18181b] border border-rose-500/30 rounded-2xl shadow-[0_0_30px_rgba(244,63,94,0.1)] overflow-hidden"
                        >
                            <div className="p-4 border-b border-white/5 flex items-center justify-between bg-rose-500/5">
                                <div className="flex items-center gap-2">
                                    <ShieldAlert size={18} className="text-rose-500" />
                                    <h3 className="text-sm font-bold text-white uppercase tracking-wide">System Administration</h3>
                                </div>
                                <button onClick={() => setIsOpen(false)} className="text-zinc-500 hover:text-white transition-colors">
                                    <X size={18} />
                                </button>
                            </div>
                            
                            {/* Tabs */}
                            <div className="flex p-1 bg-black/40 border-b border-white/5">
                                <button 
                                    onClick={() => setActiveTab('CONFIG')}
                                    className={`flex-1 py-2 text-xs font-bold uppercase rounded-lg transition-all ${activeTab === 'CONFIG' ? 'bg-white/10 text-white' : 'text-zinc-500 hover:text-zinc-300'}`}
                                >
                                    Configuration
                                </button>
                                <button 
                                    onClick={() => setActiveTab('HEALTH')}
                                    className={`flex-1 py-2 text-xs font-bold uppercase rounded-lg transition-all ${activeTab === 'HEALTH' ? 'bg-white/10 text-white' : 'text-zinc-500 hover:text-zinc-300'}`}
                                >
                                    System Monitor
                                </button>
                            </div>

                            <div className="p-6 min-h-[400px]">
                                <p className="text-xs text-zinc-400 mb-6 font-mono border-l-2 border-rose-500/50 pl-3">
                                    AUTHORIZED PERSONNEL ONLY: {user.email}
                                </p>

                                {activeTab === 'CONFIG' ? (
                                    <div className="space-y-4">
                                        <div className="flex items-center justify-between p-4 bg-black/40 rounded-xl border border-white/5">
                                            <div>
                                                <div className="text-sm font-bold text-white mb-1">New Registrations</div>
                                                <div className={`text-[10px] font-bold uppercase ${registrationOpen ? 'text-emerald-500' : 'text-rose-500'}`}>
                                                    Status: {registrationOpen ? 'OPEN' : 'CLOSED'}
                                                </div>
                                            </div>
                                            <button 
                                                onClick={() => toggleRegistration(!registrationOpen)}
                                                className={`p-2 rounded-lg transition-colors ${registrationOpen ? 'text-emerald-500 hover:text-emerald-400' : 'text-rose-500 hover:text-rose-400'}`}
                                            >
                                                {registrationOpen ? <ToggleRight size={32} /> : <ToggleLeft size={32} />}
                                            </button>
                                        </div>
                                    </div>
                                ) : (
                                    <SystemMonitor />
                                )}
                            </div>
                        </motion.div>
                    </div>
                )}
            </AnimatePresence>
        </>
    );
};

export default AdminControl;
