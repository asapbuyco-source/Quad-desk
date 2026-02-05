import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Hexagon, Activity, ArrowRight, Lock, Terminal, Cpu, Shield } from 'lucide-react';

interface LandingPageProps {
  onEnter: () => void;
}

const LandingPage: React.FC<LandingPageProps> = ({ onEnter }) => {
  const [isInitializing, setIsInitializing] = useState(false);
  const [loadingProgress, setLoadingProgress] = useState(0);

  const handleEnter = () => {
    setIsInitializing(true);
    // Simulate boot sequence
    const interval = setInterval(() => {
        setLoadingProgress(prev => {
            if (prev >= 100) {
                clearInterval(interval);
                setTimeout(onEnter, 200); // Small delay after 100%
                return 100;
            }
            return prev + Math.floor(Math.random() * 15) + 5;
        });
    }, 150);
  };

  return (
    <div className="h-screen w-screen relative overflow-hidden bg-[#050505] font-sans selection:bg-brand-accent/30">
      
      {/* --- Fixed Background Layers --- */}
      <div className="absolute inset-0 z-0 opacity-20 pointer-events-none">
        <div className="absolute inset-0 bg-[linear-gradient(to_right,#80808012_1px,transparent_1px),linear-gradient(to_bottom,#80808012_1px,transparent_1px)] bg-[size:24px_24px] [mask-image:radial-gradient(ellipse_60%_50%_at_50%_0%,#000_70%,transparent_100%)]"></div>
      </div>
      
      {/* --- Ambient Glows --- */}
      <div className="absolute top-[-10%] left-[20%] w-[500px] h-[500px] bg-brand-accent/20 rounded-full blur-[120px] pointer-events-none animate-pulse" />
      <div className="absolute bottom-[-10%] right-[20%] w-[600px] h-[600px] bg-purple-900/10 rounded-full blur-[120px] pointer-events-none" />

      {/* --- Scanline Overlay --- */}
      <div className="absolute inset-0 bg-[url('https://grainy-gradients.vercel.app/noise.svg')] opacity-[0.03] pointer-events-none mix-blend-overlay"></div>
      
      <AnimatePresence mode="wait">
      {!isInitializing ? (
          <motion.div 
            key="hero"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0, scale: 0.95, filter: "blur(10px)" }}
            transition={{ duration: 0.8 }}
            className="absolute inset-0 z-10 overflow-y-auto overflow-x-hidden"
          >
            <div className="min-h-full flex flex-col items-center justify-center py-20 px-6">
                
                {/* Logo Construction Animation */}
                <motion.div
                    initial={{ scale: 0.8, opacity: 0, rotate: -30 }}
                    animate={{ scale: 1, opacity: 1, rotate: 0 }}
                    transition={{ duration: 1.2, type: "spring" }}
                    className="mb-12 relative group cursor-default"
                >
                    <div className="absolute inset-0 bg-brand-accent/30 blur-2xl rounded-full opacity-0 group-hover:opacity-100 transition-opacity duration-700"></div>
                    <div className="relative p-1 rounded-[2rem] bg-gradient-to-b from-white/10 to-transparent backdrop-blur-3xl shadow-2xl">
                        <div className="p-8 rounded-[1.8rem] bg-[#0A0A0A] border border-white/5 relative overflow-hidden">
                            <div className="absolute inset-0 bg-gradient-to-tr from-brand-accent/10 to-transparent opacity-50"></div>
                            <Hexagon size={64} className="text-white relative z-10 drop-shadow-[0_0_15px_rgba(255,255,255,0.3)]" strokeWidth={1} />
                            
                            {/* Internal decorative lines */}
                            <motion.div 
                                animate={{ rotate: 360 }}
                                transition={{ duration: 20, repeat: Infinity, ease: "linear" }}
                                className="absolute inset-0 border-[1px] border-dashed border-white/10 rounded-full scale-150"
                            />
                        </div>
                    </div>
                </motion.div>

                {/* Status Pill */}
                <motion.div
                    initial={{ y: 20, opacity: 0 }}
                    animate={{ y: 0, opacity: 1 }}
                    transition={{ delay: 0.2 }}
                    className="inline-flex items-center gap-3 px-4 py-2 rounded-full bg-white/[0.03] border border-white/[0.08] backdrop-blur-md text-[10px] font-mono text-zinc-400 mb-8 hover:bg-white/[0.05] transition-colors cursor-crosshair"
                >
                    <div className="flex gap-1">
                        <span className="w-1 h-3 rounded-full bg-emerald-500 animate-pulse"></span>
                        <span className="w-1 h-3 rounded-full bg-emerald-500/50 animate-pulse delay-75"></span>
                        <span className="w-1 h-3 rounded-full bg-emerald-500/20 animate-pulse delay-150"></span>
                    </div>
                    <span>SYSTEM STATUS: OPERATIONAL</span>
                    <span className="text-zinc-600">|</span>
                    <span className="text-brand-accent">V 2.4.0</span>
                </motion.div>
                
                {/* Main Title */}
                <div className="space-y-2 mb-8 relative text-center">
                    <motion.h1 
                        initial={{ y: 20, opacity: 0, letterSpacing: "-0.05em" }}
                        animate={{ y: 0, opacity: 1, letterSpacing: "-0.02em" }}
                        transition={{ delay: 0.3, duration: 0.8 }}
                        className="text-6xl md:text-8xl lg:text-9xl font-bold text-white tracking-tighter leading-[0.9]"
                    >
                        QUANT DESK
                    </motion.h1>
                    <motion.div 
                        initial={{ width: 0 }}
                        animate={{ width: "100%" }}
                        transition={{ delay: 0.8, duration: 1 }}
                        className="h-px bg-gradient-to-r from-transparent via-brand-accent/50 to-transparent w-full absolute bottom-2"
                    />
                </div>

                <motion.p
                    initial={{ y: 20, opacity: 0 }}
                    animate={{ y: 0, opacity: 1 }}
                    transition={{ delay: 0.5, duration: 0.8 }}
                    className="text-lg md:text-xl text-zinc-400 max-w-2xl mx-auto mb-16 font-light tracking-wide leading-relaxed text-center"
                >
                    Institutional-grade terminal for the <span className="text-white font-medium">post-latency era</span>. 
                    Real-time order flow analytics, Bayesian risk modeling, and sentinel logic.
                </motion.p>

                {/* Interactive Button */}
                <motion.div
                    initial={{ y: 20, opacity: 0 }}
                    animate={{ y: 0, opacity: 1 }}
                    transition={{ delay: 0.7 }}
                    className="relative z-20 mb-16"
                >
                    <button
                        onClick={handleEnter}
                        className="group relative px-12 py-6 bg-white text-black rounded-full font-bold text-lg tracking-wider overflow-hidden transition-all duration-300 hover:scale-[1.02] hover:shadow-[0_0_40px_-5px_rgba(255,255,255,0.3)]"
                    >
                        <div className="relative z-10 flex items-center gap-4">
                            <Terminal size={18} className="text-zinc-600 group-hover:text-black transition-colors" />
                            <span>INITIALIZE SYSTEM</span>
                            <ArrowRight size={20} className="group-hover:translate-x-1 transition-transform" />
                        </div>
                        
                        {/* Button Background Effects */}
                        <div className="absolute inset-0 bg-gradient-to-r from-transparent via-black/5 to-transparent -translate-x-full group-hover:translate-x-full transition-transform duration-700 ease-in-out"></div>
                    </button>
                </motion.div>

                {/* Feature Tickers */}
                <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ delay: 1, duration: 1 }}
                    className="grid grid-cols-1 md:grid-cols-3 gap-4 w-full max-w-5xl mb-24"
                >
                    <GlassCard 
                        icon={<Activity size={20} />}
                        label="Liquidity"
                        value="98.4%"
                        sub="Deep Depth"
                        delay={0}
                    />
                    <GlassCard 
                        icon={<Cpu size={20} />}
                        label="Latency"
                        value="< 12ms"
                        sub="Direct Fiber"
                        delay={0.1}
                    />
                    <GlassCard 
                        icon={<Shield size={20} />}
                        label="Sentinel"
                        value="Active"
                        sub="Risk Engine"
                        delay={0.2}
                    />
                </motion.div>

                {/* Footer */}
                <motion.div 
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ delay: 1.5 }}
                    className="flex items-center gap-8 text-zinc-700"
                >
                    <div className="h-px w-12 bg-zinc-800"></div>
                    <div className="flex items-center gap-2">
                        <Lock size={12} />
                        <span className="text-[10px] font-mono tracking-[0.2em] uppercase">End-to-End Encrypted // 256-bit</span>
                    </div>
                    <div className="h-px w-12 bg-zinc-800"></div>
                </motion.div>
            </div>
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
                  <span>Establishing Handshake...</span>
                  <span className="text-white">{loadingProgress}%</span>
              </div>
          </motion.div>
      )}
      </AnimatePresence>
    </div>
  );
};

const GlassCard = ({ icon, label, value, sub, delay }: any) => (
    <motion.div 
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 1 + delay, duration: 0.5 }}
        className="group relative p-6 rounded-2xl bg-white/[0.02] border border-white/[0.05] hover:bg-white/[0.05] hover:border-white/10 transition-all duration-300 backdrop-blur-sm overflow-hidden"
    >
        <div className="absolute inset-0 bg-gradient-to-br from-brand-accent/5 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-500"></div>
        
        <div className="relative flex items-center gap-4">
            <div className="p-3 rounded-xl bg-black/50 border border-white/5 text-zinc-400 group-hover:text-white group-hover:border-white/20 transition-colors">
                {icon}
            </div>
            <div className="flex flex-col text-left">
                <span className="text-[10px] uppercase tracking-wider text-zinc-500 font-bold mb-0.5">{label}</span>
                <span className="text-xl font-bold text-white font-mono">{value}</span>
                <span className="text-[10px] text-zinc-600">{sub}</span>
            </div>
        </div>
    </motion.div>
)

export default LandingPage;