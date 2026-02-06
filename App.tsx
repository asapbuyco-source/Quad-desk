import React, { useState, useEffect } from 'react';
import Header from './components/Header';
import NavBar from './components/NavBar';
import DashboardView from './components/DashboardView';
import AnalyticsView from './components/AnalyticsView';
import IntelView from './components/IntelView';
import ChartingView from './components/ChartingView';
import LandingPage from './components/LandingPage';
import { MOCK_METRICS, MOCK_ASKS, MOCK_BIDS, CHECKLIST_ITEMS, MOCK_LEVELS } from './constants';
import { CandleData, OrderBookLevel, MarketMetrics, TradeSignal, AiAnalysis, PriceLevel } from './types';
import { AnimatePresence, motion } from 'framer-motion';
import { Lock, AlertTriangle, RefreshCw } from 'lucide-react';

const MotionDiv = motion.div as any;

// Synthetic Data Generator for Backtest Mode
const generateBacktestData = (): CandleData[] => {
    let price = 42000;
    const data: CandleData[] = [];
    for(let i=0; i<300; i++) {
        // Create a pattern: Flat -> Pump -> Crash -> Recover
        let trend = 0;
        if(i > 50 && i < 100) trend = 50; // Pump
        if(i > 100 && i < 150) trend = -80; // Crash
        if(i > 150) trend = 20; // Recover
        
        const vol = Math.random() * 50;
        const move = trend + (Math.random() - 0.5) * vol;
        const open = price;
        const close = price + move;
        const high = Math.max(open, close) + Math.random() * 20;
        const low = Math.min(open, close) - Math.random() * 20;
        
        data.push({
            time: 1600000000 + (i * 60),
            open, high, low, close,
            volume: 500 + Math.abs(move) * 10,
            zScoreUpper1: close * 1.01,
            zScoreLower1: close * 0.99,
            zScoreUpper2: close * 1.02,
            zScoreLower2: close * 0.98,
        });
        price = close;
    }
    return data;
};

const BACKTEST_DATA = generateBacktestData();

const App: React.FC = () => {
  const [hasEntered, setHasEntered] = useState(false);
  const [activeTab, setActiveTab] = useState('dashboard');
  const [isBacktest, setIsBacktest] = useState(false);
  
  // Data State
  const [metrics, setMetrics] = useState<MarketMetrics>({
      ...MOCK_METRICS,
      pair: "BTC/USDT",
      price: 0,
      dailyPnL: 1250.00, // Starting daily PnL
      circuitBreakerTripped: false,
  });
  const [candles, setCandles] = useState<CandleData[]>([]);
  const [signals, setSignals] = useState<TradeSignal[]>([]);
  const [levels, setLevels] = useState<PriceLevel[]>(MOCK_LEVELS);
  const [aiAnalysis, setAiAnalysis] = useState<AiAnalysis | undefined>(undefined);
  
  const [asks, setAsks] = useState<OrderBookLevel[]>(MOCK_ASKS);
  const [bids, setBids] = useState<OrderBookLevel[]>(MOCK_BIDS);

  // 1. Fetch Historical Data from Binance (LIVE MODE ONLY)
  useEffect(() => {
    if (isBacktest) return;

    const fetchHistory = async () => {
        try {
            const res = await fetch('https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1m&limit=1000');
            const data = await res.json();
            const formattedCandles: CandleData[] = data.map((k: any) => ({
                time: k[0] / 1000, // Unix timestamp in seconds
                open: parseFloat(k[1]),
                high: parseFloat(k[2]),
                low: parseFloat(k[3]),
                close: parseFloat(k[4]),
                volume: parseFloat(k[5]),
                // AI Bands (Simulated based on real data)
                zScoreUpper1: parseFloat(k[4]) * 1.002,
                zScoreLower1: parseFloat(k[4]) * 0.998,
                zScoreUpper2: parseFloat(k[4]) * 1.004,
                zScoreLower2: parseFloat(k[4]) * 0.996,
            }));
            setCandles(formattedCandles);

            // Set initial price
            if (formattedCandles.length > 0) {
                const last = formattedCandles[formattedCandles.length - 1];
                setMetrics(prev => ({ ...prev, price: last.close }));
            }
        } catch (e) {
            console.error("Failed to fetch Binance history", e);
        }
    };

    fetchHistory();
  }, [isBacktest]);

  // 2. Real-Time WebSocket Connection (Binance Direct) - LIVE MODE ONLY
  useEffect(() => {
      if (isBacktest) return;

      const ws = new WebSocket('wss://stream.binance.com:9443/ws/btcusdt@kline_1m');
      
      ws.onmessage = (event) => {
          const message = JSON.parse(event.data);
          const k = message.k;
          
          const newCandle: CandleData = {
              time: k.t / 1000,
              open: parseFloat(k.o),
              high: parseFloat(k.h),
              low: parseFloat(k.l),
              close: parseFloat(k.c),
              volume: parseFloat(k.v),
              zScoreUpper1: parseFloat(k.c) * 1.002,
              zScoreLower1: parseFloat(k.c) * 0.998,
              zScoreUpper2: parseFloat(k.c) * 1.004,
              zScoreLower2: parseFloat(k.c) * 0.996,
          };

          // Update Metrics
          setMetrics(prev => ({
              ...prev,
              price: newCandle.close,
              change: parseFloat(k.P) || 0, // 24h change percent
          }));

          setCandles(prev => {
              const last = prev[prev.length - 1];
              // If same time, update last candle
              if (last && last.time === newCandle.time) {
                  return [...prev.slice(0, -1), newCandle];
              }
              // Else add new candle
              return [...prev, newCandle];
          });
      };

      return () => ws.close();
  }, [isBacktest]);

  // 3. AI Analysis Polling (FastAPI Backend) - LIVE MODE ONLY
  useEffect(() => {
    if (isBacktest) return;

    const fetchAnalysis = async () => {
        try {
            const response = await fetch('http://localhost:8000/analyze');
            const data = await response.json();
            
            if (data.ai_analysis) {
                setAiAnalysis({
                    ...data.ai_analysis,
                    metrics: data.metrics
                });

                const { signal, confidence, reason, entry, stop_loss, take_profit } = data.ai_analysis;

                // Update Levels with AI Trade Setup
                if (signal !== 'WAIT' && entry && stop_loss && take_profit) {
                     const newLevels: PriceLevel[] = [
                         { price: entry, type: 'ENTRY', label: `AI ENTRY (${signal})` },
                         { price: stop_loss, type: 'STOP_LOSS', label: 'STOP' },
                         { price: take_profit, type: 'TAKE_PROFIT', label: 'TARGET' }
                     ];
                     setLevels(newLevels);
                }

                // Marker Logic: Strong Buy Signal (>80% Confidence)
                if ((signal === 'BUY' || signal === 'SELL') && confidence > 0.8) {
                    const currentTime = Math.floor(Date.now() / 1000);
                    const newSignal: TradeSignal = {
                        id: `sig-${currentTime}`,
                        type: signal === 'BUY' ? 'ENTRY_LONG' : 'ENTRY_SHORT',
                        price: metrics.price,
                        time: currentTime,
                        label: `AI ${signal} (${(confidence * 100).toFixed(0)}%)`
                    };

                    setSignals(prev => {
                        // Prevent duplicate signals in short timeframe (last 60s)
                        const lastSig = prev[prev.length - 1];
                        if (lastSig && (currentTime - (lastSig.time as number) < 60)) {
                            return prev;
                        }
                        return [...prev, newSignal];
                    });
                }
            }
        } catch (error) {
            console.error("Backend offline or warming up");
        }
    };

    // Poll every 10 seconds
    const interval = setInterval(fetchAnalysis, 10000);
    return () => clearInterval(interval);
  }, [metrics.price, isBacktest]);

  // 4. Background Simulation Engine (Metrics & Circuit Breaker) - ALWAYS RUNS
  useEffect(() => {
    if (!metrics.price && !isBacktest) return; 

    const interval = setInterval(() => {
      const currentPrice = metrics.price;
      
      setMetrics(prev => {
          // Circuit Breaker Logic
          const maxLoss = -5000;
          const currentPnL = prev.dailyPnL || 0;
          const tripped = currentPnL < maxLoss;

          // Simulate Heatmap Flux around real price
          const newHeatmap = prev.heatmap.map(item => ({
              ...item,
              zScore: item.zScore + (Math.random() - 0.5) * 0.2
          }));
          
          return {
            ...prev,
            // Simulate OFI/Toxicity based on random noise + price movement
            ofi: Math.max(-500, Math.min(500, prev.ofi + Math.floor((Math.random() - 0.5) * 50))),
            toxicity: Math.min(100, Math.max(0, prev.toxicity + Math.floor((Math.random() - 0.5) * 5))),
            zScore: Math.min(4, Math.max(-4, prev.zScore + (Math.random() - 0.5) * 0.1)),
            heatmap: newHeatmap,
            circuitBreakerTripped: tripped,
            // Simulate PnL fluctuation
            dailyPnL: (prev.dailyPnL || 0) + (Math.random() - 0.5) * 50
          };
      });

      // Jitter Book around REAL PRICE
      const generateLevel = (basePrice: number, offset: number) => ({
          price: basePrice + offset,
          size: Math.floor(Math.random() * 500) + 10,
          total: 0
      });

      const spread = 0.05;
      const newAsks = Array.from({length: 10}, (_, i) => generateLevel(currentPrice, spread + (i * spread))).reverse();
      const newBids = Array.from({length: 10}, (_, i) => generateLevel(currentPrice, -(spread + (i * spread))));

      setAsks(newAsks);
      setBids(newBids);

    }, 1000);

    return () => clearInterval(interval);
  }, [metrics.price, isBacktest]);

  // 5. BACKTEST REPLAY ENGINE (Level 5 Feature)
  useEffect(() => {
      if (!isBacktest) return;

      // Reset
      setCandles([]);
      setSignals([]);
      
      let step = 0;
      const interval = setInterval(() => {
          if (step >= BACKTEST_DATA.length) {
              step = 0; // Loop or Stop
              setCandles([]);
              setSignals([]);
          }

          const candle = BACKTEST_DATA[step];
          setCandles(prev => {
              const newC = [...prev, candle];
              return newC.slice(-100); // Keep buffer manageable
          });
          setMetrics(prev => ({ ...prev, price: candle.close }));

          // Simulate AI Triggering on "Crash" or "Pump" events in data
          if (step === 90) { // Top of Pump
              setSignals(prev => [...prev, { id: `bt-${step}`, type: 'ENTRY_SHORT', price: candle.close, time: candle.time, label: 'AI SHORT (BT)' }]);
              setAiAnalysis({ signal: 'SELL', confidence: 0.92, reason: "Backtest: Excessive extension from Mean." });
          }
          if (step === 140) { // Bottom of Crash
              setSignals(prev => [...prev, { id: `bt-${step}`, type: 'ENTRY_LONG', price: candle.close, time: candle.time, label: 'AI LONG (BT)' }]);
              setAiAnalysis({ signal: 'BUY', confidence: 0.88, reason: "Backtest: VPIN Divergence detected." });
          }

          step++;
      }, 100); // 10x Speed

      return () => clearInterval(interval);
  }, [isBacktest]);

  return (
    <div className={`h-screen w-screen bg-transparent text-slate-200 font-sans overflow-hidden ${metrics.circuitBreakerTripped ? 'grayscale opacity-80' : ''}`}>
      <AnimatePresence mode='wait'>
        {!hasEntered ? (
            <MotionDiv
                key="landing"
                exit={{ opacity: 0, y: -50, transition: { duration: 0.5 } }}
                className="absolute inset-0 z-50"
            >
                <LandingPage onEnter={() => setHasEntered(true)} />
            </MotionDiv>
        ) : (
            <MotionDiv 
                key="app"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ duration: 0.8 }}
                className="flex h-full w-full"
            >
                <NavBar activeTab={activeTab} setActiveTab={setActiveTab} />

                <div className="flex-1 flex flex-col h-full overflow-hidden relative">
                    <Header metrics={metrics} isBacktest={isBacktest} onToggleBacktest={() => setIsBacktest(!isBacktest)} />

                    <main className="flex-1 overflow-hidden p-0 lg:p-6 lg:pl-0 relative">
                        {isBacktest && (
                            <div className="absolute top-0 right-0 left-0 h-1 bg-amber-500 z-50 animate-pulse" />
                        )}
                        
                        {activeTab === 'dashboard' && (
                            <DashboardView 
                                metrics={metrics} 
                                candles={candles} 
                                asks={asks} 
                                bids={bids} 
                                checklist={CHECKLIST_ITEMS} 
                                aiAnalysis={aiAnalysis}
                            />
                        )}
                        {activeTab === 'charting' && (
                            <ChartingView 
                                candles={candles}
                                signals={signals}
                                levels={levels}
                            />
                        )}
                        {activeTab === 'analytics' && <AnalyticsView />}
                        {activeTab === 'intel' && <IntelView />}
                    </main>

                    {/* Circuit Breaker Overlay (Level 5: The Armor) */}
                    {metrics.circuitBreakerTripped && (
                        <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/90 backdrop-blur-md">
                            <MotionDiv 
                                initial={{ scale: 0.9, opacity: 0 }}
                                animate={{ scale: 1, opacity: 1 }}
                                className="p-10 border-2 border-red-600 bg-[#09090b] rounded-2xl text-center shadow-[0_0_100px_rgba(220,38,38,0.3)] max-w-md w-full relative overflow-hidden"
                            >
                                <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-transparent via-red-600 to-transparent animate-pulse" />
                                
                                <div className="flex justify-center mb-6 text-red-600">
                                    <Lock size={64} strokeWidth={1.5} />
                                </div>
                                
                                <h1 className="text-3xl font-black text-white mb-2 tracking-tight">CIRCUIT BREAKER</h1>
                                <p className="text-lg text-red-500 font-mono mb-8 font-bold">DAILY LOSS LIMIT EXCEEDED</p>
                                
                                <div className="bg-red-500/10 border border-red-500/20 p-4 rounded-lg mb-8 text-left">
                                    <div className="flex justify-between text-xs text-red-400 font-mono mb-1">
                                        <span>CURRENT PNL</span>
                                        <span>LIMIT</span>
                                    </div>
                                    <div className="flex justify-between font-mono font-bold">
                                        <span className="text-white">-${Math.abs(metrics.dailyPnL || 0).toFixed(2)}</span>
                                        <span className="text-red-500">-$5,000.00</span>
                                    </div>
                                    <div className="w-full bg-red-900/30 h-1.5 rounded-full mt-2">
                                        <div className="bg-red-500 h-full rounded-full w-full animate-pulse"></div>
                                    </div>
                                </div>

                                <div className="space-y-3">
                                    <button disabled className="w-full py-3 bg-zinc-800 text-zinc-500 rounded-lg font-bold text-sm cursor-not-allowed flex items-center justify-center gap-2">
                                        <RefreshCw size={14} /> EXECUTION PAUSED
                                    </button>
                                    <p className="text-[10px] text-zinc-500 font-mono">
                                        Contact Risk Desk to override: <span className="text-zinc-300">ext. 4049</span>
                                    </p>
                                </div>
                            </MotionDiv>
                        </div>
                    )}
                </div>
            </MotionDiv>
        )}
      </AnimatePresence>
    </div>
  );
};

export default App;