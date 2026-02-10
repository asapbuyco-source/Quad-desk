import React from 'react';
import { motion } from 'framer-motion';
import { Shield, Fingerprint, Lock, Hexagon } from 'lucide-react';
import { useStore } from '../store';

const AuthOverlay: React.FC = () => {
    const { signIn } = useStore();

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
                
                <div className="p-8 flex flex-col items-center text-center relative z-10">
                    <div className="mb-6 p-4 rounded-2xl bg-white/5 border border-white/5 relative group">
                        <div className="absolute inset-0 bg-brand-accent/20 blur-xl rounded-full opacity-0 group-hover:opacity-100 transition-opacity" />
                        <Shield size={42} className="text-white relative z-10" strokeWidth={1.5} />
                    </div>

                    <h2 className="text-2xl font-bold text-white mb-2 tracking-tight">Security Clearance Required</h2>
                    <p className="text-zinc-400 text-sm mb-8 leading-relaxed">
                        Access to the Quant Desk Terminal is restricted to authorized personnel. Please verify your identity to establish a secure uplink.
                    </p>

                    <div className="w-full space-y-3">
                        <button 
                            onClick={() => signIn()}
                            className="w-full py-4 rounded-xl bg-white text-black font-bold flex items-center justify-center gap-3 hover:scale-[1.02] active:scale-[0.98] transition-all shadow-[0_0_20px_rgba(255,255,255,0.2)] group"
                        >
                            <img src="https://www.gstatic.com/firebasejs/ui/2.0.0/images/auth/google.svg" alt="Google" className="w-5 h-5" />
                            <span>Authenticate with Google</span>
                        </button>
                    </div>

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