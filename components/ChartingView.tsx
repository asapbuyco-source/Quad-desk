import React, { useState, useEffect, useCallback } from 'react';
import PriceChart from './PriceChart';
import VolumeProfile from './VolumeProfile';
import { AiScanResult } from '../types';
import { motion, AnimatePresence } from 'framer-motion';
import { useStore } from '../store';
import { API_BASE_URL } from '../constants';

const ChartingView: React.FC = () => {
  const { candles, signals, levels, metrics } = useStore(state => state.market);
  const { scanResult, isScanning, cooldownRemaining } = useStore(state => state.ai);
  const { interval, activeSymbol, isBacktest } = useStore(state => state.config);
  
  const { 
      setInterval, 
      startAiScan, 
      completeAiScan, 
      failAiScan, 
      addNotification 
  } = useStore();

  const [layers, setLayers] = useState({
    zScore: true,
    levels: true,
    signals: true,
    volumeProfile: false 
  });

  // Track window size for responsive width
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    const checkMobile = () => setIsMobile(window.innerWidth < 768);
    checkMobile();
    window.addEventListener('resize', checkMobile);
    return () => window.removeEventListener('resize', checkMobile);
  }, []);

  const toggleLayer = (key: keyof typeof layers) => {
    setLayers(prev => ({ ...prev, [key]: !prev[key] }));
  };

  const handleAiScan = useCallback(async () => {
      if (isScanning || isBacktest) return;
      if (cooldownRemaining > 0) {
          addNotification({ 
              id: Date.now().toString(), 
              type: 'warning', 
              title: 'Cooldown Active', 
              message: `System cooling down. Wait ${cooldownRemaining}s.` 
          });
          return;
      }

      startAiScan();
      
      try {
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 10000);
          const response = await fetch(`${API_BASE_URL}/analyze?symbol=${activeSymbol}`, { signal: controller.signal });
          clearTimeout(timeoutId);
          const data = await response.json();
          
          if (data && !data.error) {
              completeAiScan(data);
              addNotification({ 
                  id: Date.now().toString(), 
                  type: 'success', 
                  title: 'Scan Complete', 
                  message: `Analysis received for ${activeSymbol}.` 
              });
          } else {
              throw new Error("Invalid response");
          }
      } catch (e) {
          console.warn("Backend unavailable. Simulation fallback.");
          addNotification({ 
              id: Date.now().toString(), 
              type: 'error', 
              title: 'Network Fault', 
              message: 'Backend unreachable. Engaging simulation protocols.' 
          });
          
          await new Promise(r => setTimeout(r, 2000));
          
          const currentPrice = metrics.price || 43000;
          const isBullish = Math.random() > 0.4;
          const simResult: AiScanResult = {
              support: [currentPrice * 0.985, currentPrice * 0.96],
              resistance: [currentPrice * 1.015, currentPrice * 1.04],
              decision_price: currentPrice * (isBullish ? 0.99 : 1.01),
              verdict: isBullish ? 'ENTRY' : 'WAIT',
              analysis: `[SIMULATION] Network Unreachable. Volatility contraction detected.`,
              risk_reward_ratio: 2.5,
              isSimulated: true
          };
          completeAiScan(simResult);
      }
  }, [isScanning, cooldownRemaining, isBacktest, activeSymbol, metrics.price, startAiScan, completeAiScan, addNotification]);

  return (
    <motion.div 
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      className="h-full w-full flex flex-col p-0 pb-20 lg:p-2 lg:pb-0"
    >
      <div className="flex-1 w-full h-full relative overflow-hidden flex gap-2">
        
        {/* Main Chart Area */}
        <div className="flex-1 min-w-0 h-full fintech-card overflow-hidden relative z-10 border-x-0 lg:border-x border-t-0 lg:border-t rounded-none lg:rounded-xl">
             <PriceChart 
                data={candles} 
                signals={signals} 
                levels={levels}
                aiScanResult={scanResult}
                onScan={handleAiScan}
                isScanning={isScanning || cooldownRemaining > 0}
                showZScore={layers.zScore}
                showLevels={layers.levels}
                showSignals={layers.signals}
                onToggleSidePanel={() => toggleLayer('volumeProfile')}
                isSidePanelOpen={layers.volumeProfile}
                interval={interval}
                onIntervalChange={setInterval}
            >
                {/* Header Controls */}
                <div className="flex gap-1.5 bg-zinc-900/50 p-0.5 rounded-full border border-white/5 items-center">
                    <button
                        onClick={() => toggleLayer('zScore')}
                        className={`
                            flex items-center gap-1.5 px-2 py-1 rounded-full text-[9px] font-bold transition-all border whitespace-nowrap min-w-fit
                            ${layers.zScore 
                                ? 'bg-brand-accent/20 text-brand-accent border-brand-accent/30 shadow-[0_0_10px_rgba(59,130,246,0.2)]' 
                                : 'bg-transparent text-slate-500 border-transparent hover:bg-white/5'}
                        `}
                    >
                        <div className={`w-1 h-1 rounded-full ${layers.zScore ? 'bg-brand-accent' : 'bg-slate-600'}`}></div>
                        <span className="hidden sm:inline">AI BANDS</span>
                        <span className="sm:hidden">AI</span>
                    </button>
                    
                    <button
                        onClick={() => toggleLayer('levels')}
                        className={`
                            flex items-center gap-1.5 px-2 py-1 rounded-full text-[9px] font-bold transition-all border whitespace-nowrap min-w-fit
                            ${layers.levels 
                                ? 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30 shadow-[0_0_10px_rgba(16,185,129,0.2)]' 
                                : 'bg-transparent text-slate-500 border-transparent hover:bg-white/5'}
                        `}
                    >
                        <div className={`w-1 h-1 rounded-full ${layers.levels ? 'bg-emerald-500' : 'bg-slate-600'}`}></div>
                        <span className="hidden sm:inline">LEVELS</span>
                        <span className="sm:hidden">LVL</span>
                    </button>

                    <button
                        onClick={() => toggleLayer('signals')}
                        className={`
                            flex items-center gap-1.5 px-2 py-1 rounded-full text-[9px] font-bold transition-all border whitespace-nowrap min-w-fit
                            ${layers.signals 
                                ? 'bg-amber-500/20 text-amber-400 border-amber-500/30 shadow-[0_0_10px_rgba(245,158,11,0.2)]' 
                                : 'bg-transparent text-slate-500 border-transparent hover:bg-white/5'}
                        `}
                    >
                        <div className={`w-1 h-1 rounded-full ${layers.signals ? 'bg-amber-500' : 'bg-slate-600'}`}></div>
                        <span className="hidden sm:inline">SIGNALS</span>
                        <span className="sm:hidden">SIG</span>
                    </button>
                </div>
            </PriceChart>
        </div>

        {/* Side Panel: Volume Profile */}
        <AnimatePresence>
            {layers.volumeProfile && (
                <motion.div 
                    initial={{ width: 0, opacity: 0 }}
                    animate={{ width: isMobile ? "200px" : "280px", opacity: 1 }}
                    exit={{ width: 0, opacity: 0 }}
                    style={{ maxWidth: '60vw' }}
                    transition={{ type: "spring", stiffness: 300, damping: 30 }}
                    className="h-full shrink-0 absolute right-0 top-0 bottom-0 z-20 md:static bg-[#09090b] md:bg-transparent shadow-2xl md:shadow-none border-l border-white/10 md:border-none"
                >
                     <VolumeProfile data={candles} />
                </motion.div>
            )}
        </AnimatePresence>
      </div>
    </motion.div>
  );
};

export default ChartingView;