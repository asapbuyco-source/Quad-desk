import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Shield, Fingerprint, Lock, Hexagon, Mail, User, AlertCircle, Loader2 } from 'lucide-react';
import { useStore } from '../store';

const AuthOverlay: React.FC = () => {
    const { signInGoogle, registerEmail, loginEmail, auth: { registrationOpen } } = useStore();
    
    const [mode, setMode] = useState<'login' | 'register'>('login');
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // Form State
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [name, setName] = useState('');

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setError(null);
        setIsLoading(true);

        try {
            if (mode === 'login') {
                await loginEmail(email, password);
            } else {
                await registerEmail(email, password, name);
            }
        } catch (err: any) {
            setError(err.message.replace('Firebase: ', ''));
            setIsLoading(false);
        }
    };

    return (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/80 backdrop-blur-xl">
            <motion.div 
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                className="w-full max-w-md bg-[#09090b] border border-white/10 rounded-3xl overflow-hidden shadow-2xl relative"
            >
                {/* Background FX */}
                <div className="absolute inset-0 bg-[url('https://grainy-gradients.vercel.app/noise.svg')] opacity-[0.05] mix-blend-overlay pointer-events-none"></div>
                <div className="absolute top-0 right-0 w-64 h-64 bg-brand-accent/5 rounded-full blur-[80px] -translate-y-1/2 translate-x-1/2" />
                
                <div className="p-8 flex flex-col items-center relative z-10">
                    <div className="mb-6 p-4 rounded-2xl bg-white/5 border border-white/5 relative group">
                        <div className="absolute inset-0 bg-brand-accent/20 blur-xl rounded-full opacity-0 group-hover:opacity-100 transition-opacity" />
                        <Shield size={42} className="text-white relative z-10" strokeWidth={1.5} />
                    </div>

                    <h2 className="text-2xl font-bold text-white mb-2 tracking-tight">Security Clearance</h2>
                    <p className="text-zinc-400 text-sm mb-6 text-center leading-relaxed">
                        Access to Vantage systems is restricted. Verify identity.
                    </p>

                    {/* Mode Toggle */}
                    <div className="w-full bg-black/40 p-1 rounded-xl flex mb-6 border border-white/5">
                        <button 
                            onClick={() => { setMode('login'); setError(null); }}
                            className={`flex-1 py-2 text-xs font-bold rounded-lg transition-all ${mode === 'login' ? 'bg-white/10 text-white shadow-sm' : 'text-zinc-500 hover:text-zinc-300'}`}
                        >
                            LOGIN
                        </button>
                        <button 
                            onClick={() => { setMode('register'); setError(null); }}
                            className={`flex-1 py-2 text-xs font-bold rounded-lg transition-all ${mode === 'register' ? 'bg-white/10 text-white shadow-sm' : 'text-zinc-500 hover:text-zinc-300'}`}
                        >
                            REGISTER
                        </button>
                    </div>

                    <AnimatePresence mode='wait'>
                        {/* REGISTRATION CLOSED WARNING */}
                        {mode === 'register' && !registrationOpen && (
                            <motion.div 
                                initial={{ height: 0, opacity: 0 }}
                                animate={{ height: 'auto', opacity: 1 }}
                                exit={{ height: 0, opacity: 0 }}
                                className="w-full mb-4 px-4 py-3 bg-amber-500/10 border border-amber-500/20 rounded-xl flex items-start gap-3"
                            >
                                <AlertCircle size={16} className="text-amber-500 shrink-0 mt-0.5" />
                                <div className="text-xs text-amber-500">
                                    <span className="font-bold block">REGISTRATION HALTED</span>
                                    New account creation is currently disabled by the administrator.
                                </div>
                            </motion.div>
                        )}
                        
                        {/* ERROR MESSAGE */}
                        {error && (
                            <motion.div 
                                initial={{ height: 0, opacity: 0 }}
                                animate={{ height: 'auto', opacity: 1 }}
                                exit={{ height: 0, opacity: 0 }}
                                className="w-full mb-4 px-4 py-3 bg-rose-500/10 border border-rose-500/20 rounded-xl flex items-center gap-3"
                            >
                                <AlertCircle size={16} className="text-rose-500 shrink-0" />
                                <span className="text-xs text-rose-500 font-medium">{error}</span>
                            </motion.div>
                        )}
                    </AnimatePresence>

                    {/* Form */}
                    <form onSubmit={handleSubmit} className="w-full space-y-3">
                        {mode === 'register' && (
                            <div className="relative group">
                                <User size={16} className="absolute left-4 top-1/2 -translate-y-1/2 text-zinc-500 group-focus-within:text-brand-accent transition-colors" />
                                <input 
                                    type="text" 
                                    placeholder="Full Name"
                                    value={name}
                                    onChange={(e) => setName(e.target.value)}
                                    className="w-full bg-black/40 border border-white/10 rounded-xl py-3 pl-11 pr-4 text-sm text-white focus:outline-none focus:border-brand-accent/50 focus:ring-1 focus:ring-brand-accent/50 transition-all placeholder:text-zinc-600"
                                    required={mode === 'register'}
                                />
                            </div>
                        )}
                        
                        <div className="relative group">
                            <Mail size={16} className="absolute left-4 top-1/2 -translate-y-1/2 text-zinc-500 group-focus-within:text-brand-accent transition-colors" />
                            <input 
                                type="email" 
                                placeholder="Email Address"
                                value={email}
                                onChange={(e) => setEmail(e.target.value)}
                                className="w-full bg-black/40 border border-white/10 rounded-xl py-3 pl-11 pr-4 text-sm text-white focus:outline-none focus:border-brand-accent/50 focus:ring-1 focus:ring-brand-accent/50 transition-all placeholder:text-zinc-600"
                                required
                            />
                        </div>

                        <div className="relative group">
                            <Lock size={16} className="absolute left-4 top-1/2 -translate-y-1/2 text-zinc-500 group-focus-within:text-brand-accent transition-colors" />
                            <input 
                                type="password" 
                                placeholder="Password"
                                value={password}
                                onChange={(e) => setPassword(e.target.value)}
                                className="w-full bg-black/40 border border-white/10 rounded-xl py-3 pl-11 pr-4 text-sm text-white focus:outline-none focus:border-brand-accent/50 focus:ring-1 focus:ring-brand-accent/50 transition-all placeholder:text-zinc-600"
                                required
                            />
                        </div>

                        <button 
                            type="submit"
                            disabled={isLoading}
                            className="w-full py-3 mt-2 rounded-xl bg-brand-accent hover:bg-brand-accent/90 text-white font-bold flex items-center justify-center gap-2 transition-all shadow-[0_0_20px_rgba(124,58,237,0.3)] disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                            {isLoading ? <Loader2 size={16} className="animate-spin" /> : (mode === 'login' ? 'ESTABLISH UPLINK' : 'REQUEST CLEARANCE')}
                        </button>
                    </form>

                    <div className="w-full flex items-center gap-4 my-6">
                        <div className="h-px bg-white/5 flex-1" />
                        <span className="text-[10px] text-zinc-600 uppercase font-bold tracking-widest">OR</span>
                        <div className="h-px bg-white/5 flex-1" />
                    </div>

                    <button 
                        onClick={() => signInGoogle()}
                        className="w-full py-3 rounded-xl bg-white text-black font-bold flex items-center justify-center gap-3 hover:scale-[1.02] active:scale-[0.98] transition-all shadow-[0_0_20px_rgba(255,255,255,0.2)]"
                    >
                        <img src="https://www.gstatic.com/firebasejs/ui/2.0.0/images/auth/google.svg" alt="Google" className="w-5 h-5" />
                        <span>Continue with Google</span>
                    </button>

                    <div className="mt-8 pt-6 border-t border-white/5 w-full flex justify-between items-center text-[10px] text-zinc-600 font-mono uppercase tracking-widest">
                        <span className="flex items-center gap-1">
                            <Lock size={10} /> 256-BIT ENCRYPTION
                        </span>
                        <span className="flex items-center gap-1">
                            <Fingerprint size={10} /> BIO-METRIC READY
                        </span>
                    </div>
                </div>

                {/* Footer Bar */}
                <div className="bg-[#18181b] p-3 flex justify-center border-t border-white/5">
                    <div className="flex items-center gap-2 text-zinc-500 text-xs font-bold">
                        <Hexagon size={12} className="fill-zinc-800" />
                        VANTAGE SYSTEMS ID: 884-29-X
                    </div>
                </div>
            </motion.div>
        </div>
    );
};

export default AuthOverlay;