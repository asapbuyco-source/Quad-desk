import React, { useState, useEffect } from 'react';
import Header from './components/Header';
import NavBar from './components/NavBar';
import DashboardView from './components/DashboardView';
import AnalyticsView from './components/AnalyticsView';
import IntelView from './components/IntelView';
import ChartingView from './components/ChartingView';
import GuideView from './components/GuideView';
import LandingPage from './components/LandingPage';
import { MOCK_METRICS, MOCK_ASKS, MOCK_BIDS, CHECKLIST_ITEMS, MOCK_LEVELS } from './constants';
import { CandleData, OrderBookLevel, MarketMetrics, TradeSignal, AiScanResult, PriceLevel } from './types';
import { AnimatePresence, motion } from 'framer-motion';
import { Lock, RefreshCw } from 'lucide-react';

const MotionDiv = motion.div as any;

// --- ADX Calculation Utility ---
const calculateADX = (data: CandleData[], period = 14): CandleData[] => {
    if (data.length === 0) return [];
    
    // Copy data to avoid mutation during calculation steps if we were using refs, but map creates new array
    const result = [...data];
    
    let trs: number[] = [];
    let plusDMs: number[] = [];
    let minusDMs: number[] = [];

    // 1. Calculate TR, +DM, -DM
    for (let i = 0; i < result.length; i++) {
        const curr = result[i];
        const prev = result[i - 1];

        if (i === 0) {
            trs.push(0);
            plusDMs.push(0);
            minusDMs.push(0);
            continue;
        }

        // True Range
        const tr = Math.max(
            curr.high - curr.low,
            Math.abs(curr.high - prev.close),
            Math.abs(curr.low - prev.close)
        );
        trs.push(tr);

        // Directional Movement
        const upMove = curr.high - prev.high;
        const downMove = prev.low - curr.low;

        let plusDM = 0;
        let minusDM = 0;

        if (upMove > downMove && upMove > 0) {
            plusDM = upMove;
        }
        if (downMove > upMove && downMove > 0) {
            minusDM = downMove;
        }

        plusDMs.push(plusDM);
        minusDMs.push(minusDM);
    }

    // 2. Smooth TR, +DM, -DM (Wilder's Smoothing)
    let smoothTR = 0;
    let smoothPlusDM = 0;
    let smoothMinusDM = 0;
    let dxValues: number[] = new Array(result.length).fill(0);

    for (let i = 0; i < result.length; i++) {
        if (i < period) {
             // Initial accumulation
             smoothTR += trs[i];
             smoothPlusDM += plusDMs[i];
             smoothMinusDM += minusDMs[i];
             
             // At index period-1, we have enough for the first smoothed value (Sum)
             // But Wilder's usually starts processing after. 
             // Simplified: standard algo often sums first N, then smooths.
             // We will stick to the iterative approach for i >= period.
        }
        
        if (i === period) {
            // First smoothed value is just the sum (some variations use sum/period, Wilder uses Sum)
            // But to make DX valid immediately after period, let's treat the sum as the starting previous value
            // Actually, Wilder's technique: First TR14 = Sum(TR, 14).
            // Next TR14 = Previous TR14 - (Previous TR14 / 14) + Current TR
        }

        if (i >= period) {
             smoothTR = smoothTR - (smoothTR / period) + trs[i];
             smoothPlusDM = smoothPlusDM - (smoothPlusDM / period) + plusDMs[i];
             smoothMinusDM = smoothMinusDM - (smoothMinusDM / period) + minusDMs[i];
             
             const plusDI = (smoothPlusDM / smoothTR) * 100;
             const minusDI = (smoothMinusDM / smoothTR) * 100;
             
             if (plusDI + minusDI !== 0) {
                 dxValues[i] = (Math.abs(plusDI - minusDI) / (plusDI + minusDI)) * 100;
             }
        }
    }

    // 3. Calculate ADX (Smoothed DX)
    let adxValues: number[] = new Array(result.length).fill(0);
    let smoothDX = 0;
    
    // ADX calculation needs 2 * period of data to start stabilizing
    const adxStart = period * 2;

    for (let i = 0; i < result.length; i++) {
        if (i < adxStart) {
            smoothDX += dxValues[i];
        } 
        if (i === adxStart) {
             // First ADX is average of previous N DXs
             smoothDX = smoothDX / period;
             adxValues[i] = smoothDX;
        }
        if (i > adxStart) {
             smoothDX = ((smoothDX * (period - 1)) + dxValues[i]) / period;
             adxValues[i] = smoothDX;
        }
    }

    // Assign back to candles
    return result.map((c, i) => ({
        ...c,
        adx: adxValues[i]
    }));
};


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
    return calculateADX(data);
};

const BACKTEST_DATA = generateBacktestData();

// RATE LIMITING CONSTANTS
const SCAN_COOLDOWN = 60; // Seconds

const App: React.FC = () => {
  const [hasEntered, setHasEntered] = useState(false);
  const [activeTab, setActiveTab] = useState('dashboard');
  const [isBacktest, setIsBacktest] = useState(false);
  const [interval, setTimeframeInterval] = useState('1m'); // State for Timeframe
  
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
  
  // Bands State
  const [bands, setBands] = useState<any>(null);

  // AI Scan State
  const [aiScanResult, setAiScanResult] = useState<AiScanResult | undefined>(undefined);
  const [isScanning, setIsScanning] = useState(false);
  const [lastScanTime, setLastScanTime] = useState(0);
  const [cooldownRemaining, setCooldownRemaining] = useState(0);

  const [asks, setAsks] = useState<OrderBookLevel[]>(MOCK_ASKS);
  const [bids, setBids] = useState<OrderBookLevel[]>(MOCK_BIDS);

  // 1. Fetch Historical Data from Binance (LIVE MODE ONLY)
  useEffect(() => {
    if (isBacktest) return;

    const fetchHistory = async () => {
        setCandles([]); // Clear data on interval change to prevent visual glitches
        try {
            const res = await fetch(`https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=${interval}&limit=1000`);
            const data = await res.json();
            const formattedCandles: CandleData[] = data.map((k: any) => ({
                time: k[0] / 1000, // Unix timestamp in seconds
                open: parseFloat(k[1]),
                high: parseFloat(k[2]),
                low: parseFloat(k[3]),
                close: parseFloat(k[4]),
                volume: parseFloat(k[5]),
                // Placeholders, will be enriched by bands
                zScoreUpper1: parseFloat(k[4]) * 1.002,
                zScoreLower1: parseFloat(k[4]) * 0.998,
                zScoreUpper2: parseFloat(k[4]) * 1.005,
                zScoreLower2: parseFloat(k[4]) * 0.995,
            }));
            
            // Calculate ADX on initial load
            const withAdx = calculateADX(formattedCandles);
            setCandles(withAdx);

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
  }, [isBacktest, interval]);

  // 2. Polling for Bands from Backend
  useEffect(() => {
      if (isBacktest) return;
      const fetchBands = async () => {
          try {
              const res = await fetch('http://localhost:8000/bands');
              if (res.ok) {
                  const data = await res.json();
                  if (!data.error) setBands(data);
              }
          } catch(e) {
              // Silent fail
          }
      };
      
      fetchBands();
      const i = setInterval(fetchBands, 60000); // Poll every minute
      return () => clearInterval(i);
  }, [isBacktest]);

  // 3. Real-Time WebSocket Connection (Binance Direct) - LIVE MODE ONLY
  useEffect(() => {
      if (isBacktest) return;

      let ws: WebSocket | null = null;
      let reconnectTimer: any = null;

      const connect = () => {
          ws = new WebSocket(`wss://stream.binance.com:9443/ws/btcusdt@kline_${interval}`);
          
          ws.onopen = () => {
              console.log("WS Connected");
          };

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
                  // Use real bands if available, else simulated
                  zScoreUpper1: bands ? bands.upper_1 : parseFloat(k.c) * 1.002,
                  zScoreLower1: bands ? bands.lower_1 : parseFloat(k.c) * 0.998,
                  zScoreUpper2: bands ? bands.upper_2 : parseFloat(k.c) * 1.005,
                  zScoreLower2: bands ? bands.lower_2 : parseFloat(k.c) * 0.995,
              };

              // Update Metrics
              setMetrics(prev => ({
                  ...prev,
                  price: newCandle.close,
                  change: parseFloat(k.P) || 0, // 24h change percent
              }));

              setCandles(prev => {
                  const last = prev[prev.length - 1];
                  let updatedCandles = [...prev];

                  // If same time, update last candle
                  if (last && last.time === newCandle.time) {
                      updatedCandles = [...prev.slice(0, -1), newCandle];
                  } else {
                      // Else add new candle
                      updatedCandles = [...prev, newCandle];
                  }
                  
                  return calculateADX(updatedCandles);
              });
          };

          ws.onerror = (err) => {
              console.error("WS Error", err);
              ws?.close();
          };

          ws.onclose = () => {
              console.warn("WS Closed, reconnecting...");
              reconnectTimer = setTimeout(connect, 5000);
          };
      };

      connect();

      return () => {
          if (ws) ws.close();
          if (reconnectTimer) clearTimeout(reconnectTimer);
      };
  }, [isBacktest, interval, bands]); // Re-bind if bands change to update realtime calc

  // Cooldown Timer
  useEffect(() => {
      if (lastScanTime === 0) return;
      
      const interval = setInterval(() => {
          const now = Date.now();
          const elapsed = (now - lastScanTime) / 1000;
          const remaining = Math.max(0, SCAN_COOLDOWN - elapsed);
          setCooldownRemaining(Math.ceil(remaining));
      }, 1000);

      return () => clearInterval(interval);
  }, [lastScanTime]);

  // 4. Manual AI Market Scan with Rate Limiting
  const handleAiScan = async () => {
      if (isScanning || isBacktest) return;
      
      // Check Cooldown
      if (cooldownRemaining > 0) {
          alert(`Wait ${cooldownRemaining}s before next scan.`);
          return;
      }

      setIsScanning(true);
      setLastScanTime(Date.now());
      setCooldownRemaining(SCAN_COOLDOWN);
      
      try {
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 10000); // 10s timeout
          
          const response = await fetch('http://localhost:8000/analyze', {
              signal: controller.signal
          });
          clearTimeout(timeoutId);
          
          const data = await response.json();
          
          if (data && !data.error) {
              setAiScanResult(data);
              updateLevelsFromScan(data);
          } else {
              if (data.message) alert(`AI Error: ${data.message}`);
              throw new Error(data.error || "Invalid response");
          }
      } catch (e) {
          console.warn("Backend unavailable. Engaging Sentinel Simulation Protocol.", e);
          
          // Simulation Fallback
          await new Promise(r => setTimeout(r, 2000)); // Simulate processing
          
          const currentPrice = metrics.price || 43000;
          const isBullish = Math.random() > 0.4;
          
          const simResult: AiScanResult = {
              support: [currentPrice * 0.985, currentPrice * 0.96],
              resistance: [currentPrice * 1.015, currentPrice * 1.04],
              decision_price: currentPrice * (isBullish ? 0.99 : 1.01),
              verdict: isBullish ? 'ENTRY' : 'WAIT',
              analysis: `[SIMULATION] Volatility contraction detected near key Fibonacci levels. Order flow suggests ${isBullish ? 'institutional accumulation' : 'distribution'} with hidden iceberg orders.`,
              risk_reward_ratio: 2.5
          };
          
          setAiScanResult(simResult);
          updateLevelsFromScan(simResult);
      } finally {
          setIsScanning(false);
      }
  };

  const updateLevelsFromScan = (data: AiScanResult) => {
      const newLevels: PriceLevel[] = [];
      data.support.forEach((p: number) => newLevels.push({ price: p, type: 'SUPPORT', label: 'AI SUP' }));
      data.resistance.forEach((p: number) => newLevels.push({ price: p, type: 'RESISTANCE', label: 'AI RES' }));
      newLevels.push({ price: data.decision_price, type: 'ENTRY', label: 'AI PIVOT' });
      
      if (data.stop_loss) newLevels.push({ price: data.stop_loss, type: 'STOP_LOSS', label: 'STOP' });
      if (data.take_profit) newLevels.push({ price: data.take_profit, type: 'TAKE_PROFIT', label: 'TARGET' });
      
      setLevels(prev => [
          ...prev.filter(l => !l.label.startsWith('AI') && l.label !== 'STOP' && l.label !== 'TARGET'), 
          ...newLevels
      ]);
  };

  // 5. Background Simulation Engine (Metrics & Circuit Breaker) - ALWAYS RUNS
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

  // 6. BACKTEST REPLAY ENGINE
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
              // Ensure we maintain enough history for ADX, but slice for performance if needed
              // However, calculateADX expects contiguous data. 
              // Since BACKTEST_DATA is already fully calculated, we can just slice.
              return newC.slice(-100); 
          });
          setMetrics(prev => ({ ...prev, price: candle.close }));

          step++;
      }, 100); 

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
                                aiScanResult={aiScanResult}
                                interval={interval}
                            />
                        )}
                        {activeTab === 'charting' && (
                            <ChartingView 
                                candles={candles}
                                signals={signals}
                                levels={levels}
                                aiScanResult={aiScanResult}
                                onScan={handleAiScan}
                                isScanning={isScanning || cooldownRemaining > 0}
                                interval={interval}
                                onIntervalChange={setTimeframeInterval}
                            />
                        )}
                        {activeTab === 'analytics' && <AnalyticsView />}
                        {activeTab === 'intel' && <IntelView />}
                        {activeTab === 'guide' && <GuideView />}
                    </main>

                    {/* Circuit Breaker Overlay */}
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
                                
                                <div className="space-y-3 mt-8">
                                    <button disabled className="w-full py-3 bg-zinc-800 text-zinc-500 rounded-lg font-bold text-sm cursor-not-allowed flex items-center justify-center gap-2">
                                        <RefreshCw size={14} /> EXECUTION PAUSED
                                    </button>
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