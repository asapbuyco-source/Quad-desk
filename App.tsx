import React, { useState, useEffect } from 'react';
import Header from './components/Header';
import NavBar from './components/NavBar';
import DashboardView from './components/DashboardView';
import AnalyticsView from './components/AnalyticsView';
import IntelView from './components/IntelView';
import ChartingView from './components/ChartingView';
import LandingPage from './components/LandingPage';
import { MOCK_METRICS, MOCK_ASKS, MOCK_BIDS, CHECKLIST_ITEMS, MOCK_CANDLES, MOCK_SIGNALS, MOCK_LEVELS } from './constants';
import { CandleData, OrderBookLevel, MarketMetrics } from './types';
import { AnimatePresence, motion } from 'framer-motion';

const App: React.FC = () => {
  const [hasEntered, setHasEntered] = useState(false);
  const [activeTab, setActiveTab] = useState('dashboard');
  
  // Data State
  const [metrics, setMetrics] = useState<MarketMetrics>(MOCK_METRICS);
  const [candles, setCandles] = useState<CandleData[]>(MOCK_CANDLES);
  const [asks, setAsks] = useState<OrderBookLevel[]>(MOCK_ASKS);
  const [bids, setBids] = useState<OrderBookLevel[]>(MOCK_BIDS);

  // Simulation Engine
  useEffect(() => {
    const interval = setInterval(() => {
      // 1. Random Walk Price
      const delta = (Math.random() - 0.5) * 0.5;
      const newPrice = metrics.price + delta;
      
      setMetrics(prev => ({
        ...prev,
        price: newPrice,
        change: prev.change + (Math.random() - 0.5) * 0.05,
        ofi: Math.max(-500, Math.min(500, prev.ofi + Math.floor((Math.random() - 0.5) * 50))),
        toxicity: Math.min(100, Math.max(0, prev.toxicity + Math.floor((Math.random() - 0.5) * 5)))
      }));

      // 2. Update Candle
      setCandles(prev => {
        const last = prev[prev.length - 1];
        const updatedLast = {
          ...last,
          close: newPrice,
          high: Math.max(last.high, newPrice),
          low: Math.min(last.low, newPrice),
          volume: last.volume + Math.floor(Math.random() * 10)
        };
        if (Math.random() > 0.95) {
           const nextTime = "12:00"; 
           return [...prev.slice(1), { ...updatedLast, time: nextTime, open: newPrice, high: newPrice, low: newPrice, close: newPrice, volume: 0 }];
        }
        return [...prev.slice(0, -1), updatedLast];
      });

      // 3. Jitter Book
      const jitterBook = (levels: OrderBookLevel[]) => levels.map(l => ({
          ...l,
          size: Math.max(1, l.size + Math.floor((Math.random() - 0.5) * 10)),
      }));
      setAsks(prev => jitterBook(prev));
      setBids(prev => jitterBook(prev));

    }, 1000);

    return () => clearInterval(interval);
  }, [metrics.price]);

  return (
    <div className="h-screen w-screen bg-transparent text-slate-200 font-sans overflow-hidden">
      <AnimatePresence mode='wait'>
        {!hasEntered ? (
            <motion.div
                key="landing"
                exit={{ opacity: 0, y: -50, transition: { duration: 0.5 } }}
                className="absolute inset-0 z-50"
            >
                <LandingPage onEnter={() => setHasEntered(true)} />
            </motion.div>
        ) : (
            <motion.div 
                key="app"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ duration: 0.8 }}
                className="flex h-full w-full"
            >
                <NavBar activeTab={activeTab} setActiveTab={setActiveTab} />

                <div className="flex-1 flex flex-col h-full overflow-hidden relative">
                    <Header metrics={metrics} />

                    <main className="flex-1 overflow-hidden p-0 lg:p-6 lg:pl-0">
                        {activeTab === 'dashboard' && (
                            <DashboardView 
                                metrics={metrics} 
                                candles={candles} 
                                asks={asks} 
                                bids={bids} 
                                checklist={CHECKLIST_ITEMS} 
                            />
                        )}
                        {activeTab === 'charting' && (
                            <ChartingView 
                                candles={candles}
                                signals={MOCK_SIGNALS}
                                levels={MOCK_LEVELS}
                            />
                        )}
                        {activeTab === 'analytics' && <AnalyticsView />}
                        {activeTab === 'intel' && <IntelView />}
                    </main>
                </div>
            </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};

export default App;