
import React, { useState, useEffect, useCallback, useMemo } from 'react';
import PriceChart from './PriceChart';
import VolumeProfile from './VolumeProfile';
import PeriodSelector from './PeriodSelector';
import { motion as m, AnimatePresence } from 'framer-motion';
import { useStore } from '../store';
import { API_BASE_URL } from '../constants';
import { PeriodType } from '../types';

const motion = m as any;

interface ChartingViewProps {
    currentPeriod?: PeriodType;
    onPeriodChange?: (period: PeriodType) => void;
}

const ChartingView: React.FC<ChartingViewProps> = ({ currentPeriod: propCurrentPeriod, onPeriodChange: propOnPeriodChange }) => {
  const { candles, signals, levels: marketLevels, metrics } = useStore(state => state.market);
  const { scanResult, isScanning, cooldownRemaining } = useStore(state => state.ai);
  const { interval, activeSymbol, aiModel } = useStore(state => state.config);
  const { activePosition } = useStore(state => state.trading);
  const { liquidity, regime, aiTactical } = useStore(state => state);
  
  // Local state if not provided by props (for standalone usage if needed)
  const [localPeriod, setLocalPeriod] = useState<PeriodType>('20-PERIOD');
  
  const currentPeriod = propCurrentPeriod || localPeriod;
  const onPeriodChange = propOnPeriodChange || setLocalPeriod;

  const { 
      setInterval: setChartInterval, 
      startAiScan, 
      completeAiScan, 
      addNotification 
  } = useStore();

  const [layers, setLayers] = useState({
    zScore: true,
    levels: true,
    signals: true,
    volumeProfile: false 
  });

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

  const chartLevels = useMemo(() => {
      const currentPrice = metrics.price;
      if (!currentPrice) return [];

      const rangeFilter = (p: number) => Math.abs((p - currentPrice) / currentPrice) < 0.15;
      
      const supports = marketLevels
        .filter(l => l.type === 'SUPPORT' && rangeFilter(l.price))
        .sort((a, b) => b.price - a.price)
        .slice(0, 3);

      const resistances = marketLevels
        .filter(l => l.type === 'RESISTANCE' && rangeFilter(l.price))
        .sort((a, b) => a.price - b.price) 
        .slice(0, 3);

      const otherLevels = marketLevels.filter(l => l.type !== 'SUPPORT' && l.type !== 'RESISTANCE');

      const baseLevels = [...supports, ...resistances, ...otherLevels];
      
      if (activePosition && activePosition.isOpen) {
          baseLevels.push(
              { price: activePosition.entry, type: 'ENTRY', label: 'OPEN' },
              { price: activePosition.stop, type: 'STOP_LOSS', label: 'SL' },
              { price: activePosition.target, type: 'TAKE_PROFIT', label: 'TP' }
          );
      }

      if (aiTactical.probability > 60) {
          baseLevels.push(
              { price: aiTactical.entryLevel, type: 'TACTICAL_ENTRY', label: `PLAN (${aiTactical.probability}%)` },
              { price: aiTactical.stopLevel, type: 'TACTICAL_STOP', label: 'PLAN SL' },
              { price: aiTactical.exitLevel, type: 'TACTICAL_TARGET', label: 'PLAN TP' }
          );
      }

      return baseLevels;
  }, [marketLevels, activePosition, aiTactical, metrics.price]);

  const handleAiScan = useCallback(async () => {
      if (isScanning) return;
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
          const timeoutId = setTimeout(() => controller.abort(), 60000);
          
          const response = await fetch(`${API_BASE_URL}/analyze?symbol=${activeSymbol}&model=${aiModel}`, { signal: controller.signal });
          clearTimeout(timeoutId);
          
          if (!response.ok) {
              throw new Error(`HTTP ${response.status}`);
          }

          const data = await response.json();
          
          if (data && !data.error) {
              completeAiScan(data);
              addNotification({ 
                  id: Date.now().toString(), 
                  type: 'success', 
                  title: 'Scan Complete', 
                  message: `Analysis received for ${activeSymbol} using ${aiModel}.` 
              });
          } else {
              throw new Error("Invalid response");
          }
      } catch (e: any) {
          console.error("AI Scan Failed", e);
          const errorMsg = e.name === 'AbortError' ? 'Request timed out (Backend Sleeping)' : e.message;
          
          addNotification({ 
              id: Date.now().toString(), 
              type: 'error', 
              title: 'Analysis Failed', 
              message: `${errorMsg}. Please try again later.` 
          });
      }
  }, [isScanning, cooldownRemaining, activeSymbol, metrics.price, aiModel, startAiScan, completeAiScan, addNotification]);

  return (
    <motion.div 
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      className="h-full w-full flex flex-col p-0 pb-24 lg:p-2 lg:pb-0"
    >
      <div className="flex-1 w-full h-full relative overflow-hidden flex gap-2">
        
        <div className="flex-1 min-w-0 h-full fintech-card overflow-hidden relative z-10 border-x-0 lg:border-x border-t-0 lg:border-t rounded-none lg:rounded-xl">
             <PriceChart 
                data={candles} 
                signals={signals} 
                levels={chartLevels}
                aiScanResult={scanResult}
                liquidity={liquidity}
                regime={regime}
                onScan={handleAiScan}
                isScanning={isScanning || cooldownRemaining > 0}
                showZScore={layers.zScore}
                showLevels={layers.levels}
                showSignals={layers.signals}
                onToggleSidePanel={() => toggleLayer('volumeProfile')}
                isSidePanelOpen={layers.volumeProfile}
                interval={interval}
                onIntervalChange={setChartInterval}
                currentPeriod={currentPeriod} // Pass period type to chart
            >
                <div className="flex gap-1.5 bg-zinc-900/50 p-0.5 rounded-full border border-white/5 items-center overflow-x-auto scrollbar-hide max-w-full">
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

                    {/* Separator */}
                    <div className="w-px h-4 bg-white/10 mx-1"></div>

                    {/* Period Selector Component */}
                    <PeriodSelector currentPeriod={currentPeriod} onPeriodChange={onPeriodChange} />
                </div>
            </PriceChart>
        </div>

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
