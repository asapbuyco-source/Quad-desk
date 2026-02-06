import React, { useState, useEffect } from 'react';
import Header from './components/Header';
import NavBar from './components/NavBar';
import DashboardView from './components/DashboardView';
import AnalyticsView from './components/AnalyticsView';
import IntelView from './components/IntelView';
import ChartingView from './components/ChartingView';
import LandingPage from './components/LandingPage';
import { MOCK_METRICS, MOCK_ASKS, MOCK_BIDS, CHECKLIST_ITEMS, MOCK_LEVELS } from './constants';
import { CandleData, OrderBookLevel, MarketMetrics, TradeSignal, AiAnalysis } from './types';
import { AnimatePresence, motion } from 'framer-motion';

const MotionDiv = motion.div as any;

const App: React.FC = () => {
  const [hasEntered, setHasEntered] = useState(false);
  const [activeTab, setActiveTab] = useState('dashboard');
  
  // Data State
  const [metrics, setMetrics] = useState<MarketMetrics>({
      ...MOCK_METRICS,
      pair: "BTC/USDT",
      price: 0, 
  });
  const [candles, setCandles] = useState<CandleData[]>([]);
  const [signals, setSignals] = useState<TradeSignal[]>([]);
  const [aiAnalysis, setAiAnalysis] = useState<AiAnalysis | undefined>(undefined);
  
  const [asks, setAsks] = useState<OrderBookLevel[]>(MOCK_ASKS);
  const [bids, setBids] = useState<OrderBookLevel[]>(MOCK_BIDS);

  // 1. Fetch Historical Data from Binance
  useEffect(() => {
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
  }, []);

  // 2. Real-Time WebSocket Connection (Binance Direct)
  useEffect(() => {
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
  }, []);

  // 3. AI Analysis Polling (FastAPI Backend)
  useEffect(() => {
    const fetchAnalysis = async () => {
        try {
            const response = await fetch('http://localhost:8000/analyze');
            const data = await response.json();
            
            if (data.ai_analysis) {
                setAiAnalysis({
                    ...data.ai_analysis,
                    metrics: data.metrics
                });

                const { signal, confidence, reason } = data.ai_analysis;

                // Marker Logic: Strong Buy Signal (>80% Confidence)
                if (signal === 'BUY' && confidence > 0.8) {
                    const currentTime = Math.floor(Date.now() / 1000);
                    const newSignal: TradeSignal = {
                        id: `sig-${currentTime}`,
                        type: 'ENTRY_LONG',
                        price: metrics.price,
                        time: currentTime,
                        label: `AI BUY (${(confidence * 100).toFixed(0)}%)`
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
  }, [metrics.price]);

  // 4. Background Simulation Engine for Derived Metrics
  useEffect(() => {
    if (!metrics.price) return; // Wait for real data

    const interval = setInterval(() => {
      const currentPrice = metrics.price;
      
      setMetrics(prev => {
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
            heatmap: newHeatmap,
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
  }, [metrics.price]);

  return (
    <div className="h-screen w-screen bg-transparent text-slate-200 font-sans overflow-hidden">
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
                    <Header metrics={metrics} />

                    <main className="flex-1 overflow-hidden p-0 lg:p-6 lg:pl-0">
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
                                levels={MOCK_LEVELS}
                            />
                        )}
                        {activeTab === 'analytics' && <AnalyticsView />}
                        {activeTab === 'intel' && <IntelView />}
                    </main>
                </div>
            </MotionDiv>
        )}
      </AnimatePresence>
    </div>
  );
};

export default App;