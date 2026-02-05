import React, { useState } from 'react';
import { motion, AnimatePresence, useScroll, useTransform } from 'framer-motion';
import { Hexagon, Activity, ArrowRight, Terminal, Shield, Globe, Zap, ChevronRight } from 'lucide-react';

const MotionDiv = motion.div as any;
const MotionHeader = motion.header as any;
const MotionH1 = motion.h1 as any;
const MotionP = motion.p as any;

interface LandingPageProps {
  onEnter: () => void;
}

const LandingPage: React.FC<LandingPageProps> = ({ onEnter }) => {
  const [isInitializing, setIsInitializing] = useState(false);
  const [loadingProgress, setLoadingProgress] = useState(0);
  const { scrollY } = useScroll();
  
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
        <div className="absolute inset-0 bg-[url('https://grainy-gradients.vercel.app/noise.svg')] opacity-[0.03] mix-blend-overlay"></div>
      </div>
      
      <AnimatePresence mode="wait">
      {!isInitializing ? (
          <MotionDiv 
            key="hero"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0, scale: 0.95, filter: "blur(20px)" }}
            transition={{ duration: 0.8 }}
            className="relative z-10 w-full"
          >
            {/* --- Navigation / Header --- */}
            <MotionHeader 
                initial={{ y: -20, opacity: 0 }}
                animate={{ y: 0, opacity: 1 }}
                transition={{ delay: 0.5 }}
                className="fixed top-0 left-0 right-0 z-50 flex justify-between items-center px-6 py-6 lg:px-12 mix-blend-difference"
            >
                <div className="flex items-center gap-2">
                    <Hexagon size={24} className="text-white fill-white/10" />
                    <span className="font-bold text-white tracking-widest text-sm">VANTAGE</span>
                </div>
                <div className="hidden md:flex gap-8 text-xs font-mono text-zinc-400">
                    <span className="hover:text-white cursor-pointer transition-colors">PLATFORM</span>
                    <span className="hover:text-white cursor-pointer transition-colors">INSTITUTIONAL</span>
                    <span className="hover:text-white cursor-pointer transition-colors">API</span>
                </div>
                <button 
                    onClick={handleEnter}
                    className="px-4 py-2 border border-white/20 rounded-full text-[10px] font-bold text-white uppercase tracking-wider hover:bg-white hover:text-black transition-colors"
                >
                    Launch Terminal
                </button>
            </MotionHeader>

            {/* --- Hero Section --- */}
            <section className="min-h-screen flex flex-col items-center justify-center pt-32 pb-20 px-6 relative">
                
                {/* Floating Elements */}
                <MotionDiv style={{ y: y2 }} className="absolute top-1/4 left-[10%] hidden lg:block opacity-20">
                     <Globe size={120} strokeWidth={0.5} className="text-brand-accent animate-[spin_60s_linear_infinite]" />
                </MotionDiv>

                {/* Status Pill */}
                <MotionDiv
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
                </MotionDiv>
                
                {/* Main Title */}
                <div className="space-y-4 mb-10 relative text-center z-20">
                    <MotionH1 
                        initial={{ y: 20, opacity: 0, letterSpacing: "-0.05em" }}
                        animate={{ y: 0, opacity: 1, letterSpacing: "-0.02em" }}
                        transition={{ delay: 0.3, duration: 0.8 }}
                        className="text-6xl md:text-8xl lg:text-9xl font-bold text-white tracking-tighter leading-[0.9]"
                    >
                        QUANT DESK
                    </MotionH1>
                    <MotionDiv 
                        initial={{ scaleX: 0 }}
                        animate={{ scaleX: 1 }}
                        transition={{ delay: 0.8, duration: 1.2, ease: "circOut" }}
                        className="h-px bg-gradient-to-r from-transparent via-brand-accent to-transparent w-full opacity-50"
                    />
                </div>

                <MotionP
                    initial={{ y: 20, opacity: 0 }}
                    animate={{ y: 0, opacity: 1 }}
                    transition={{ delay: 0.5, duration: 0.8 }}
                    className="text-lg md:text-xl text-zinc-400 max-w-2xl mx-auto mb-12 font-light tracking-wide leading-relaxed text-center z-20"
                >
                    Institutional-grade terminal for the <span className="text-white font-medium">post-latency era</span>. 
                    Real-time order flow analytics, Bayesian risk modeling, and sentinel logic.
                </MotionP>

                {/* Primary CTA */}
                <MotionDiv
                    initial={{ scale: 0.9, opacity: 0 }}
                    animate={{ scale: 1, opacity: 1 }}
                    whileHover={{ scale: 1.05 }}
                    transition={{ delay: 0.7, type: "spring" }}
                    className="relative z-20 mb-20"
                >
                    <button
                        onClick={handleEnter}
                        className="group relative px-10 py-5 bg-white text-black rounded-full font-bold text-lg tracking-wider overflow-hidden shadow-[0_0_50px_-10px_rgba(255,255,255,0.3)]"
                    >
                        <div className="relative z-10 flex items-center gap-4">
                            <Terminal size={18} className="text-zinc-600 group-hover:text-black transition-colors" />
                            <span>INITIALIZE SYSTEM</span>
                            <ArrowRight size={20} className="group-hover:translate-x-1 transition-transform" />
                        </div>
                        <div className="absolute inset-0 bg-gradient-to-r from-brand-accent/20 to-transparent -translate-x-full group-hover:translate-x-full transition-transform duration-500 ease-in-out"></div>
                    </button>
                </MotionDiv>

                {/* Scroll Indicator */}
                <MotionDiv 
                    style={{ opacity }}
                    className="absolute bottom-10 left-1/2 -translate-x-1/2 flex flex-col items-center gap-2"
                >
                    <span className="text-[10px] text-zinc-600 uppercase tracking-widest">Scroll to Explore</span>
                    <MotionDiv 
                        animate={{ y: [0, 5, 0] }}
                        transition={{ repeat: Infinity, duration: 2 }}
                        className="w-px h-8 bg-gradient-to-b from-zinc-600 to-transparent" 
                    />
                </MotionDiv>
            </section>

            {/* --- Infinite Ticker --- */}
            <div className="w-full border-y border-white/5 bg-black/50 backdrop-blur-sm py-4 overflow-hidden relative z-20">
                <div className="flex w-max gap-20 animate-[scroll_30s_linear_infinite]">
                    {[...Array(2)].map((_, i) => (
                        <div key={i} className="flex gap-20 items-center opacity-40 grayscale hover:grayscale-0 hover:opacity-100 transition-all duration-500">
                             <PartnerLogo name="GOLDMAN SACHS" />
                             <PartnerLogo name="JP MORGAN" />
                             <PartnerLogo name="CITADEL" />
                             <PartnerLogo name="BLACKROCK" />
                             <PartnerLogo name="JANE STREET" />
                             <PartnerLogo name="TWO SIGMA" />
                             <PartnerLogo name="RENAISSANCE" />
                        </div>
                    ))}
                </div>
            </div>

            {/* --- Bento Grid Features --- */}
            <section className="py-32 px-6 relative z-10">
                <div className="max-w-7xl mx-auto">
                    <MotionDiv 
                        initial={{ opacity: 0, y: 50 }}
                        whileInView={{ opacity: 1, y: 0 }}
                        viewport={{ once: true }}
                        className="mb-16"
                    >
                        <h2 className="text-4xl md:text-5xl font-bold text-white mb-4">Market Structure <span className="text-brand-accent">Decoded</span>.</h2>
                        <p className="text-zinc-400 max-w-xl text-lg">Our proprietary engine processes millions of order book updates per second to reveal the liquidity landscape.</p>
                    </MotionDiv>

                    <div className="grid grid-cols-1 md:grid-cols-3 gap-6 h-auto md:h-[600px]">
                        {/* Large Card Left */}
                        <MotionDiv 
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
                                <h3 className="text-3xl font-bold text-white mb-2">Real-Time Order Flow</h3>
                                <p className="text-zinc-400 max-w-sm">Visualize institutional liquidity walls and hidden iceberg orders before price reacts.</p>
                            </div>
                            
                            {/* Graphic Mockup inside card */}
                            <div className="relative h-48 w-full mt-8 rounded-xl bg-black/50 border border-white/5 overflow-hidden p-4">
                                <div className="flex gap-1 mb-2">
                                    <div className="w-2 h-2 rounded-full bg-rose-500/50" />
                                    <div className="w-2 h-2 rounded-full bg-emerald-500/50" />
                                </div>
                                <div className="flex items-end gap-1 h-24 w-full">
                                    {[40, 60, 30, 80, 50, 90, 20, 40, 70, 45, 80, 95].map((h, i) => (
                                        <MotionDiv 
                                            key={i}
                                            initial={{ height: 0 }}
                                            whileInView={{ height: `${h}%` }}
                                            transition={{ delay: i * 0.05, duration: 1 }}
                                            className="flex-1 bg-zinc-800 hover:bg-brand-accent transition-colors rounded-t-sm opacity-60" 
                                        />
                                    ))}
                                </div>
                            </div>
                        </MotionDiv>

                        {/* Tall Card Right */}
                        <MotionDiv 
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
                            <h3 className="text-2xl font-bold text-white mb-2">Sentinel AI</h3>
                            <p className="text-zinc-400 mb-8 text-sm">Bayesian risk models that halt execution during volatility spikes.</p>
                            
                            <div className="flex-1 flex flex-col gap-3">
                                {['Skewness Audit', 'Gamma Flip', 'Liquidity Gap', 'Tail Risk'].map((item, i) => (
                                    <div key={i} className="flex items-center justify-between p-3 rounded-lg bg-black/40 border border-white/5">
                                        <span className="text-xs text-zinc-300 font-mono uppercase">{item}</span>
                                        <div className="flex items-center gap-2">
                                            <div className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                                            <span className="text-[10px] text-emerald-500 font-bold">PASS</span>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </MotionDiv>

                        {/* Bottom Wide Card */}
                        <MotionDiv 
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
                                <h3 className="text-2xl font-bold text-white mb-2">Ultra-Low Latency Execution</h3>
                                <p className="text-zinc-400">Direct fiber connections to NY4 and LD4 data centers ensure your fill is first in queue.</p>
                            </div>
                            <div className="relative z-10 flex gap-8 mt-8 md:mt-0">
                                <div className="text-center">
                                    <div className="text-4xl font-mono font-bold text-white mb-1">&lt;12ms</div>
                                    <div className="text-xs text-zinc-500 uppercase tracking-wider">Round Trip</div>
                                </div>
                                <div className="w-px bg-white/10" />
                                <div className="text-center">
                                    <div className="text-4xl font-mono font-bold text-white mb-1">99.9%</div>
                                    <div className="text-xs text-zinc-500 uppercase tracking-wider">Uptime</div>
                                </div>
                            </div>
                        </MotionDiv>
                    </div>
                </div>
            </section>

             {/* --- 3D Interface Teaser --- */}
             <section className="py-20 px-6 relative z-10 overflow-hidden">
                <div className="max-w-6xl mx-auto text-center mb-12">
                    <h2 className="text-3xl font-bold text-white mb-4">Command Center</h2>
                    <p className="text-zinc-400">A unified interface for alpha generation.</p>
                </div>
                
                <MotionDiv 
                    initial={{ rotateX: 20, scale: 0.9, opacity: 0 }}
                    whileInView={{ rotateX: 0, scale: 1, opacity: 1 }}
                    transition={{ duration: 1.2, ease: "easeOut" }}
                    viewport={{ once: true }}
                    className="max-w-6xl mx-auto relative perspective-1000"
                >
                    <div className="relative rounded-xl overflow-hidden border border-white/10 shadow-2xl shadow-brand-accent/10 bg-[#09090b]">
                        <div className="absolute top-0 left-0 right-0 h-8 bg-[#18181b] flex items-center gap-2 px-4 border-b border-white/5">
                            <div className="w-3 h-3 rounded-full bg-red-500/20 border border-red-500/50" />
                            <div className="w-3 h-3 rounded-full bg-amber-500/20 border border-amber-500/50" />
                            <div className="w-3 h-3 rounded-full bg-emerald-500/20 border border-emerald-500/50" />
                        </div>
                        {/* Abstract representation of the UI */}
                        <div className="p-8 pt-12 grid grid-cols-12 gap-4 h-[500px] opacity-80">
                            <div className="col-span-3 h-full bg-zinc-800/30 rounded-lg animate-pulse" />
                            <div className="col-span-6 h-full flex flex-col gap-4">
                                <div className="h-2/3 bg-zinc-800/30 rounded-lg" />
                                <div className="h-1/3 bg-zinc-800/30 rounded-lg" />
                            </div>
                            <div className="col-span-3 h-full bg-zinc-800/30 rounded-lg" />
                        </div>
                        
                        {/* Glass Overlay with CTA */}
                        <div className="absolute inset-0 flex items-center justify-center bg-black/60 backdrop-blur-sm group cursor-pointer hover:bg-black/50 transition-colors" onClick={handleEnter}>
                             <div className="p-1 rounded-full border border-white/20 bg-black/50">
                                <div className="px-8 py-3 bg-white text-black rounded-full font-bold flex items-center gap-2 group-hover:scale-105 transition-transform">
                                    ENTER TERMINAL <ChevronRight size={16} />
                                </div>
                             </div>
                        </div>
                    </div>
                </MotionDiv>
             </section>

            {/* --- Footer --- */}
            <footer className="border-t border-white/5 bg-black/50 backdrop-blur-lg py-12 relative z-20">
                <div className="max-w-7xl mx-auto px-6 flex flex-col md:flex-row justify-between items-center gap-6">
                    <div className="flex items-center gap-2">
                        <Hexagon size={20} className="text-zinc-500" />
                        <span className="text-zinc-500 font-bold tracking-widest text-xs">VANTAGE SYSTEMS</span>
                    </div>
                    <div className="flex gap-6 text-xs text-zinc-600 font-mono">
                        <span className="hover:text-zinc-400 cursor-pointer">PRIVACY</span>
                        <span className="hover:text-zinc-400 cursor-pointer">TERMS</span>
                        <span className="hover:text-zinc-400 cursor-pointer">SECURITY</span>
                    </div>
                    <div className="text-xs text-zinc-700">
                        © 2024 VANTAGE LTD. All rights reserved.
                    </div>
                </div>
            </footer>

          </MotionDiv>
      ) : (
          <MotionDiv 
            key="loader"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="absolute inset-0 z-50 flex flex-col items-center justify-center gap-8 bg-[#050505]"
          >
              <div className="w-64 h-1 bg-zinc-900 rounded-full overflow-hidden relative">
                  <MotionDiv 
                    className="absolute inset-y-0 left-0 bg-white"
                    initial={{ width: "0%" }}
                    animate={{ width: `${loadingProgress}%` }}
                    transition={{ ease: "linear" }}
                  />
              </div>
              <div className="font-mono text-xs text-zinc-500 uppercase flex flex-col items-center gap-2">
                  <div className="flex items-center gap-2">
                    <Terminal size={14} className="animate-pulse" />
                    <span>Establishing Handshake...</span>
                  </div>
                  <span className="text-white font-bold">{loadingProgress}%</span>
              </div>
              
              {/* Boot Log */}
              <div className="absolute bottom-12 left-12 font-mono text-[10px] text-zinc-600 flex flex-col gap-1">
                  <span className="text-emerald-500">✓ Kernel loaded</span>
                  <span className={loadingProgress > 30 ? "text-emerald-500" : "opacity-0"}>✓ Crypto modules active</span>
                  <span className={loadingProgress > 60 ? "text-emerald-500" : "opacity-0"}>✓ Connecting to dark pools...</span>
                  <span className={loadingProgress > 90 ? "text-emerald-500" : "opacity-0"}>✓ Access granted</span>
              </div>
          </MotionDiv>
      )}
      </AnimatePresence>
    </div>
  );
};

// Helper for Ticker
const PartnerLogo = ({ name }: { name: string }) => (
    <div className="flex items-center gap-2">
        <div className="w-8 h-8 rounded bg-white/10" />
        <span className="text-lg font-bold font-mono tracking-tighter text-white/50">{name}</span>
    </div>
);

export default LandingPage;