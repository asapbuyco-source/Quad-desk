import React, { useState } from 'react';
import PriceChart from './PriceChart';
import VolumeProfile from './VolumeProfile';
import { CandleData, TradeSignal, PriceLevel } from '../types';
import { motion, AnimatePresence } from 'framer-motion';

interface ChartingViewProps {
  candles: CandleData[];
  signals: TradeSignal[];
  levels: PriceLevel[];
}

const ChartingView: React.FC<ChartingViewProps> = ({ candles, signals, levels }) => {
  const [layers, setLayers] = useState({
    zScore: true,
    levels: true,
    signals: true,
    volumeProfile: true // Default to true
  });

  const toggleLayer = (key: keyof typeof layers) => {
    setLayers(prev => ({ ...prev, [key]: !prev[key] }));
  };

  return (
    <motion.div 
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      className="h-full w-full p-0 lg:p-2 flex flex-col"
    >
      <div className="flex-1 w-full h-full relative overflow-hidden flex gap-2">
        
        {/* Main Chart Area */}
        <div className="flex-1 min-w-0 h-full fintech-card overflow-hidden">
             <PriceChart 
                data={candles} 
                signals={signals} 
                levels={levels} 
                showZScore={layers.zScore}
                showLevels={layers.levels}
                showSignals={layers.signals}
                onToggleSidePanel={() => toggleLayer('volumeProfile')}
                isSidePanelOpen={layers.volumeProfile}
            >
                {/* Header Controls */}
                <div className="flex gap-2 bg-zinc-900/50 p-1 rounded-full border border-white/5 items-center">
                    <button
                        onClick={() => toggleLayer('zScore')}
                        className={`
                            flex items-center gap-2 px-3 py-1.5 rounded-full text-[10px] font-bold transition-all border
                            ${layers.zScore 
                                ? 'bg-brand-accent/20 text-brand-accent border-brand-accent/30 shadow-[0_0_10px_rgba(59,130,246,0.2)]' 
                                : 'bg-transparent text-slate-500 border-transparent hover:bg-white/5'}
                        `}
                    >
                        <div className={`w-1.5 h-1.5 rounded-full ${layers.zScore ? 'bg-brand-accent' : 'bg-slate-600'}`}></div>
                        <span className="hidden sm:inline">AI BANDS</span>
                    </button>
                    
                    <button
                        onClick={() => toggleLayer('levels')}
                        className={`
                            flex items-center gap-2 px-3 py-1.5 rounded-full text-[10px] font-bold transition-all border
                            ${layers.levels 
                                ? 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30 shadow-[0_0_10px_rgba(16,185,129,0.2)]' 
                                : 'bg-transparent text-slate-500 border-transparent hover:bg-white/5'}
                        `}
                    >
                        <div className={`w-1.5 h-1.5 rounded-full ${layers.levels ? 'bg-emerald-500' : 'bg-slate-600'}`}></div>
                        <span className="hidden sm:inline">LEVELS</span>
                    </button>

                    <button
                        onClick={() => toggleLayer('signals')}
                        className={`
                            flex items-center gap-2 px-3 py-1.5 rounded-full text-[10px] font-bold transition-all border
                            ${layers.signals 
                                ? 'bg-amber-500/20 text-amber-400 border-amber-500/30 shadow-[0_0_10px_rgba(245,158,11,0.2)]' 
                                : 'bg-transparent text-slate-500 border-transparent hover:bg-white/5'}
                        `}
                    >
                        <div className={`w-1.5 h-1.5 rounded-full ${layers.signals ? 'bg-amber-500' : 'bg-slate-600'}`}></div>
                        <span className="hidden sm:inline">SIGNALS</span>
                    </button>
                </div>
            </PriceChart>
        </div>

        {/* Side Panel: Volume Profile */}
        <AnimatePresence>
            {layers.volumeProfile && (
                <motion.div 
                    initial={{ width: 0, opacity: 0 }}
                    animate={{ width: 280, opacity: 1 }}
                    exit={{ width: 0, opacity: 0 }}
                    transition={{ type: "spring", stiffness: 300, damping: 30 }}
                    className="h-full shrink-0 hidden md:block"
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