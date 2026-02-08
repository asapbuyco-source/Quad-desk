import React, { useEffect, useReducer, useRef, useMemo, useCallback } from 'react';
import Header from './components/Header';
import NavBar from './components/NavBar';
import DashboardView from './components/DashboardView';
import AnalyticsView from './components/AnalyticsView';
import IntelView from './components/IntelView';
import ChartingView from './components/ChartingView';
import GuideView from './components/GuideView';
import LandingPage from './components/LandingPage';
import { ToastContainer, ToastMessage } from './components/Toast';
import { MOCK_METRICS, MOCK_ASKS, MOCK_BIDS, CHECKLIST_ITEMS, MOCK_LEVELS, API_BASE_URL } from './constants';
import { CandleData, OrderBookLevel, MarketMetrics, TradeSignal, AiScanResult, PriceLevel } from './types';
import { AnimatePresence, motion } from 'framer-motion';
import { Lock, RefreshCw } from 'lucide-react';
import { calculateADX, generateSyntheticData } from './utils/analytics';

// --- STATE MANAGEMENT ---

interface AppState {
    ui: {
        hasEntered: boolean;
        activeTab: string;
    };
    config: {
        isBacktest: boolean;
        interval: string;
        activeSymbol: string;
        playbackSpeed: number;
        backtestDate: string;
    };
    market: {
        metrics: MarketMetrics;
        candles: CandleData[];
        asks: OrderBookLevel[];
        bids: OrderBookLevel[];
        signals: TradeSignal[];
        levels: PriceLevel[];
        bands: any | null;
    };
    ai: {
        scanResult: AiScanResult | undefined;
        isScanning: boolean;
        lastScanTime: number;
        cooldownRemaining: number;
    };
    notifications: ToastMessage[];
}

const INITIAL_STATE: AppState = {
    ui: { hasEntered: false, activeTab: 'dashboard' },
    config: { 
        isBacktest: false, 
        interval: '1m', 
        activeSymbol: 'BTCUSDT', 
        playbackSpeed: 1, 
        backtestDate: new Date().toISOString().split('T')[0] 
    },
    market: {
        metrics: { ...MOCK_METRICS, pair: "BTC/USDT", price: 0, dailyPnL: 1250.00, circuitBreakerTripped: false },
        candles: [],
        asks: MOCK_ASKS,
        bids: MOCK_BIDS,
        signals: [],
        levels: MOCK_LEVELS,
        bands: null
    },
    ai: { scanResult: undefined, isScanning: false, lastScanTime: 0, cooldownRemaining: 0 },
    notifications: []
};

type Action = 
    | { type: 'UI_ENTER' }
    | { type: 'UI_SET_TAB'; payload: string }
    | { type: 'CONFIG_TOGGLE_BACKTEST' }
    | { type: 'CONFIG_SET_SYMBOL'; payload: string }
    | { type: 'CONFIG_SET_INTERVAL'; payload: string }
    | { type: 'CONFIG_SET_PLAYBACK'; payload: number }
    | { type: 'CONFIG_SET_DATE'; payload: string }
    | { type: 'MARKET_SET_HISTORY'; payload: CandleData[] }
    | { type: 'MARKET_SET_BANDS'; payload: any }
    | { type: 'MARKET_WS_TICK'; payload: any } // Raw kline from WS
    | { type: 'MARKET_SIM_TICK'; payload: { asks: OrderBookLevel[]; bids: OrderBookLevel[]; metrics: Partial<MarketMetrics> } }
    | { type: 'AI_START_SCAN' }
    | { type: 'AI_SCAN_COMPLETE'; payload: AiScanResult }
    | { type: 'AI_SCAN_ERROR' }
    | { type: 'AI_UPDATE_COOLDOWN'; payload: number }
    | { type: 'ADD_NOTIFICATION'; payload: ToastMessage }
    | { type: 'REMOVE_NOTIFICATION'; payload: string };

const appReducer = (state: AppState, action: Action): AppState => {
    switch (action.type) {
        case 'UI_ENTER':
            return { ...state, ui: { ...state.ui, hasEntered: true } };
        case 'UI_SET_TAB':
            return { ...state, ui: { ...state.ui, activeTab: action.payload } };
        case 'CONFIG_TOGGLE_BACKTEST':
            return { 
                ...state, 
                config: { ...state.config, isBacktest: !state.config.isBacktest },
                market: { ...state.market, candles: [], signals: [] } // Reset data on toggle
            };
        case 'CONFIG_SET_SYMBOL':
            return {
                ...state,
                config: { ...state.config, activeSymbol: action.payload },
                market: { 
                    ...state.market, 
                    candles: [], 
                    bands: null,
                    metrics: { ...state.market.metrics, pair: action.payload.replace('USDT', '/USDT') }
                }
            };
        case 'CONFIG_SET_INTERVAL':
            return { ...state, config: { ...state.config, interval: action.payload } };
        case 'CONFIG_SET_PLAYBACK':
            return { ...state, config: { ...state.config, playbackSpeed: action.payload } };
        case 'CONFIG_SET_DATE':
            return { ...state, config: { ...state.config, backtestDate: action.payload } };

        case 'MARKET_SET_HISTORY':
            // Calculate ADX once on history load
            return { ...state, market: { ...state.market, candles: calculateADX(action.payload) } };
        
        case 'MARKET_SET_BANDS':
            return { ...state, market: { ...state.market, bands: action.payload } };

        case 'MARKET_WS_TICK': {
            const k = action.payload;
            const newPrice = parseFloat(k.c);
            const newTime = k.t / 1000;
            const bands = state.market.bands;

            const newCandle: CandleData = {
                time: newTime,
                open: parseFloat(k.o),
                high: parseFloat(k.h),
                low: parseFloat(k.l),
                close: newPrice,
                volume: parseFloat(k.v),
                zScoreUpper1: bands ? bands.upper_1 : newPrice * 1.002,
                zScoreLower1: bands ? bands.lower_1 : newPrice * 0.998,
                zScoreUpper2: bands ? bands.upper_2 : newPrice * 1.005,
                zScoreLower2: bands ? bands.lower_2 : newPrice * 0.995,
            };

            // Optimization: Only update candles array if essential
            let updatedCandles = state.market.candles;
            const lastCandle = updatedCandles[updatedCandles.length - 1];

            if (lastCandle && lastCandle.time === newCandle.time) {
                // Update existing candle (mutation is faster here for temp array but let's stick to immutability for safety)
                updatedCandles = [...updatedCandles.slice(0, -1), newCandle];
            } else {
                updatedCandles = [...updatedCandles, newCandle];
            }

            // Recalculate ADX: In a real high-freq scenario, we'd optimize this to incremental.
            // For React, passing it through our O(N) optimized function is acceptable for <2000 items.
            const candlesWithAdx = calculateADX(updatedCandles);

            return {
                ...state,
                market: {
                    ...state.market,
                    candles: candlesWithAdx,
                    metrics: {
                        ...state.market.metrics,
                        price: newPrice,
                        change: parseFloat(k.P) || 0
                    }
                }
            };
        }

        case 'MARKET_SIM_TICK':
            return {
                ...state,
                market: {
                    ...state.market,
                    asks: action.payload.asks,
                    bids: action.payload.bids,
                    metrics: { ...state.market.metrics, ...action.payload.metrics }
                }
            };

        case 'AI_START_SCAN':
            return { ...state, ai: { ...state.ai, isScanning: true, lastScanTime: Date.now(), cooldownRemaining: 60 } };
        
        case 'AI_SCAN_COMPLETE': {
            // Merge new levels
            const newLevels: PriceLevel[] = [];
            const result = action.payload;
            result.support.forEach((p: number) => newLevels.push({ price: p, type: 'SUPPORT', label: 'AI SUP' }));
            result.resistance.forEach((p: number) => newLevels.push({ price: p, type: 'RESISTANCE', label: 'AI RES' }));
            newLevels.push({ price: result.decision_price, type: 'ENTRY', label: 'AI PIVOT' });
            if (result.stop_loss) newLevels.push({ price: result.stop_loss, type: 'STOP_LOSS', label: 'STOP' });
            if (result.take_profit) newLevels.push({ price: result.take_profit, type: 'TAKE_PROFIT', label: 'TARGET' });

            const updatedLevels = [
                ...state.market.levels.filter(l => !l.label.startsWith('AI') && l.label !== 'STOP' && l.label !== 'TARGET'),
                ...newLevels
            ];

            return { 
                ...state, 
                market: { ...state.market, levels: updatedLevels },
                ai: { ...state.ai, isScanning: false, scanResult: result } 
            };
        }

        case 'AI_SCAN_ERROR':
            return { ...state, ai: { ...state.ai, isScanning: false } };
        
        case 'AI_UPDATE_COOLDOWN':
            return { ...state, ai: { ...state.ai, cooldownRemaining: action.payload } };
        
        case 'ADD_NOTIFICATION':
            return { ...state, notifications: [...state.notifications, action.payload] };
        
        case 'REMOVE_NOTIFICATION':
            return { ...state, notifications: state.notifications.filter(n => n.id !== action.payload) };

        default:
            return state;
    }
};

// Backtest data source (Generated once on load to be consistent)
const BACKTEST_DATA = generateSyntheticData(42000, 300);
const SCAN_COOLDOWN = 60;

const App: React.FC = () => {
  const [state, dispatch] = useReducer(appReducer, INITIAL_STATE);
  
  // Refs for effects to access latest state without dependency loops
  const bandsRef = useRef(state.market.bands);
  const isBacktestRef = useRef(state.config.isBacktest);
  const backtestStepRef = useRef(0);

  // Sync refs
  useEffect(() => { bandsRef.current = state.market.bands; }, [state.market.bands]);
  useEffect(() => { isBacktestRef.current = state.config.isBacktest; }, [state.config.isBacktest]);

  // 1. Fetch Historical Data (LIVE)
  useEffect(() => {
    if (state.config.isBacktest) return;

    const fetchHistory = async () => {
        try {
            // Attempt to fetch from Binance
            const res = await fetch(`https://api.binance.com/api/v3/klines?symbol=${state.config.activeSymbol}&interval=${state.config.interval}&limit=1000`);
            if (!res.ok) throw new Error("Binance API Error");
            
            const data = await res.json();
            const formattedCandles: CandleData[] = data.map((k: any) => ({
                time: k[0] / 1000,
                open: parseFloat(k[1]), high: parseFloat(k[2]), low: parseFloat(k[3]), close: parseFloat(k[4]), volume: parseFloat(k[5]),
                zScoreUpper1: parseFloat(k[4]) * 1.002, zScoreLower1: parseFloat(k[4]) * 0.998,
                zScoreUpper2: parseFloat(k[4]) * 1.005, zScoreLower2: parseFloat(k[4]) * 0.995,
            })).filter((c: CandleData) => !isNaN(c.close));
            
            // Dispatch single update with pre-calculated history
            dispatch({ type: 'MARKET_SET_HISTORY', payload: formattedCandles });
        } catch (e) {
            console.warn("Failed to fetch live history (CORS/Network). Using Fallback.", e);
            
            // FALLBACK: Generate synthetic data if API fails (Critical for Resilience)
            const fallbackPrice = state.config.activeSymbol.startsWith('BTC') ? 64000 : 3200;
            const fallbackData = generateSyntheticData(fallbackPrice, 200);
            
            dispatch({ type: 'MARKET_SET_HISTORY', payload: fallbackData });
            dispatch({
                type: 'ADD_NOTIFICATION',
                payload: { id: Date.now().toString(), type: 'warning', title: 'Data Stream Restricted', message: 'Binance API blocked. Running on synthetic data feed.' }
            });
        }
    };
    fetchHistory();
  }, [state.config.isBacktest, state.config.interval, state.config.activeSymbol]);

  // 2. Fetch Bands
  useEffect(() => {
      if (state.config.isBacktest || state.config.activeSymbol !== 'BTCUSDT') {
          dispatch({ type: 'MARKET_SET_BANDS', payload: null });
          return;
      }
      const fetchBands = async () => {
          try {
              const res = await fetch(`${API_BASE_URL}/bands`);
              if (res.ok) {
                  const data = await res.json();
                  if (!data.error) dispatch({ type: 'MARKET_SET_BANDS', payload: data });
              }
          } catch(e) {}
      };
      fetchBands();
      const i = setInterval(fetchBands, 60000);
      return () => clearInterval(i);
  }, [state.config.isBacktest, state.config.activeSymbol]);

  // 3. WebSocket (Live)
  useEffect(() => {
      if (state.config.isBacktest) return;

      let ws: WebSocket | null = null;
      let reconnectTimer: any = null;
      let retryCount = 0;
      const MAX_RETRIES = 10;
      const BASE_DELAY = 1000;

      const connect = () => {
          ws = new WebSocket(`wss://stream.binance.com:9443/ws/${state.config.activeSymbol.toLowerCase()}@kline_${state.config.interval}`);
          
          ws.onopen = () => { retryCount = 0; };
          ws.onmessage = (event) => {
              const message = JSON.parse(event.data);
              dispatch({ type: 'MARKET_WS_TICK', payload: message.k });
          };
          ws.onclose = () => {
              if (retryCount < MAX_RETRIES) {
                   const delay = Math.min(BASE_DELAY * Math.pow(1.5, retryCount), 30000);
                   retryCount++;
                   reconnectTimer = setTimeout(connect, delay);
               }
          };
      };
      connect();
      return () => {
          if (ws) ws.close();
          if (reconnectTimer) clearTimeout(reconnectTimer);
      };
  }, [state.config.isBacktest, state.config.interval, state.config.activeSymbol]);

  // 4. Cooldown Timer
  useEffect(() => {
      if (state.ai.lastScanTime === 0) return;
      const i = setInterval(() => {
          const elapsed = (Date.now() - state.ai.lastScanTime) / 1000;
          const remaining = Math.max(0, SCAN_COOLDOWN - elapsed);
          dispatch({ type: 'AI_UPDATE_COOLDOWN', payload: Math.ceil(remaining) });
      }, 1000);
      return () => clearInterval(i);
  }, [state.ai.lastScanTime]);

  // 5. AI Scan Handler
  const handleAiScan = useCallback(async () => {
      if (state.ai.isScanning || state.config.isBacktest) return;
      if (state.ai.cooldownRemaining > 0) {
          dispatch({
              type: 'ADD_NOTIFICATION',
              payload: { id: Date.now().toString(), type: 'warning', title: 'Cooldown Active', message: `System cooling down. Wait ${state.ai.cooldownRemaining}s.` }
          });
          return;
      }

      dispatch({ type: 'AI_START_SCAN' });
      
      try {
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 10000);
          const response = await fetch(`${API_BASE_URL}/analyze`, { signal: controller.signal });
          clearTimeout(timeoutId);
          const data = await response.json();
          
          if (data && !data.error) {
              dispatch({ type: 'AI_SCAN_COMPLETE', payload: data });
              dispatch({
                  type: 'ADD_NOTIFICATION',
                  payload: { id: Date.now().toString(), type: 'success', title: 'Scan Complete', message: `Analysis received for ${state.config.activeSymbol}.` }
              });
          } else {
              throw new Error("Invalid response");
          }
      } catch (e) {
          console.warn("Backend unavailable. Simulation fallback.");
          dispatch({
              type: 'ADD_NOTIFICATION',
              payload: { id: Date.now().toString(), type: 'error', title: 'Network Fault', message: 'Backend unreachable. Engaging simulation protocols.' }
          });
          
          await new Promise(r => setTimeout(r, 2000));
          
          const currentPrice = state.market.metrics.price || 43000;
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
          dispatch({ type: 'AI_SCAN_COMPLETE', payload: simResult });
      }
  }, [state.ai.isScanning, state.ai.cooldownRemaining, state.config.isBacktest, state.market.metrics.price, state.config.activeSymbol]);

  // 6. Simulation Engine (Metrics Jitter)
  useEffect(() => {
    // Run even if price is 0 (will use fallback logic in dispatch)
    if (!state.config.isBacktest) { 
        const i = setInterval(() => {
        const price = state.market.metrics.price || 42000;
        // Simulate Order Book & Flux
        const spread = price * 0.0001; 
        const generateLevel = (base: number, off: number) => ({ price: base + off, size: Math.floor(Math.random()*500)+10, total: 0 });
        
        dispatch({ 
            type: 'MARKET_SIM_TICK', 
            payload: {
                asks: Array.from({length: 10}, (_, k) => generateLevel(price, spread + (k * spread))).reverse(),
                bids: Array.from({length: 10}, (_, k) => generateLevel(price, -(spread + (k * spread)))),
                metrics: {
                    ofi: Math.max(-500, Math.min(500, state.market.metrics.ofi + Math.floor((Math.random() - 0.5) * 50))),
                    toxicity: Math.min(100, Math.max(0, state.market.metrics.toxicity + Math.floor((Math.random() - 0.5) * 5))),
                    zScore: Math.min(4, Math.max(-4, state.market.metrics.zScore + (Math.random() - 0.5) * 0.1)),
                    heatmap: state.market.metrics.heatmap.map(item => ({ ...item, zScore: item.zScore + (Math.random() - 0.5) * 0.2 }))
                }
            }
        });
        }, 1000);
        return () => clearInterval(i);
    }
  }, [state.market.metrics.price, state.config.isBacktest]);

  // 7. Backtest Loop
  useEffect(() => {
      if (!state.config.isBacktest) {
          backtestStepRef.current = 0;
          return;
      }
      
      // Guard against empty data to prevent infinite loops
      if (!BACKTEST_DATA || BACKTEST_DATA.length === 0) return;

      const intervalMs = 100 / state.config.playbackSpeed;
      const i = setInterval(() => {
          if (backtestStepRef.current >= BACKTEST_DATA.length) backtestStepRef.current = 0;
          const candle = BACKTEST_DATA[backtestStepRef.current];
          // We cheat here a bit by just overwriting candles for backtest to avoid complex reducer logic for replay
          // In a real app, this would dispatch TICK events.
          if (candle) {
              // Manual dispatch to update price and show chart moving
              dispatch({ 
                  type: 'MARKET_WS_TICK', 
                  payload: { 
                      t: candle.time as number * 1000, o: candle.open, h: candle.high, l: candle.low, c: candle.close, v: candle.volume, P: 0 
                  } 
              });
          }
          backtestStepRef.current++;
      }, intervalMs);
      return () => clearInterval(i);
  }, [state.config.isBacktest, state.config.playbackSpeed]);

  // --- RENDER ---
  return (
    <div className={`h-screen h-[100dvh] w-screen bg-transparent text-slate-200 font-sans overflow-hidden ${state.market.metrics.circuitBreakerTripped ? 'grayscale opacity-80' : ''}`}>
      <AnimatePresence mode='wait'>
        {!state.ui.hasEntered ? (
            <motion.div
                key="landing"
                exit={{ opacity: 0, y: -50, transition: { duration: 0.5 } }}
                className="absolute inset-0 z-50"
            >
                <LandingPage onEnter={() => dispatch({ type: 'UI_ENTER' })} />
            </motion.div>
        ) : (
            <motion.div 
                key="app"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ duration: 0.8 }}
                className="flex h-full w-full"
            >
                <NavBar activeTab={state.ui.activeTab} setActiveTab={(t) => dispatch({ type: 'UI_SET_TAB', payload: t })} />

                <div className="flex-1 flex flex-col h-full overflow-hidden relative">
                    <Header 
                        metrics={state.market.metrics} 
                        isBacktest={state.config.isBacktest} 
                        onToggleBacktest={() => dispatch({ type: 'CONFIG_TOGGLE_BACKTEST' })} 
                        activeSymbol={state.config.activeSymbol}
                        onSymbolChange={(s) => dispatch({ type: 'CONFIG_SET_SYMBOL', payload: s })}
                        playbackSpeed={state.config.playbackSpeed}
                        onPlaybackSpeedChange={(s) => dispatch({ type: 'CONFIG_SET_PLAYBACK', payload: s })}
                        backtestDate={state.config.backtestDate}
                        onBacktestDateChange={(d) => dispatch({ type: 'CONFIG_SET_DATE', payload: d })}
                    />

                    <main className="flex-1 overflow-hidden p-0 lg:p-6 lg:pl-0 relative">
                        {state.config.isBacktest && (
                            <div className="absolute top-0 right-0 left-0 h-1 bg-amber-500 z-50 animate-pulse" />
                        )}
                        
                        {state.ui.activeTab === 'dashboard' && (
                            <DashboardView 
                                metrics={state.market.metrics} 
                                candles={state.market.candles} 
                                asks={state.market.asks} 
                                bids={state.market.bids} 
                                checklist={CHECKLIST_ITEMS} 
                                aiScanResult={state.ai.scanResult}
                                interval={state.config.interval}
                            />
                        )}
                        {state.ui.activeTab === 'charting' && (
                            <ChartingView 
                                candles={state.market.candles}
                                signals={state.market.signals}
                                levels={state.market.levels}
                                aiScanResult={state.ai.scanResult}
                                onScan={handleAiScan}
                                isScanning={state.ai.isScanning || state.ai.cooldownRemaining > 0}
                                interval={state.config.interval}
                                onIntervalChange={(i) => dispatch({ type: 'CONFIG_SET_INTERVAL', payload: i })}
                            />
                        )}
                        {state.ui.activeTab === 'analytics' && <AnalyticsView />}
                        {state.ui.activeTab === 'intel' && <IntelView />}
                        {state.ui.activeTab === 'guide' && <GuideView />}
                    </main>

                    {state.market.metrics.circuitBreakerTripped && (
                        <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/90 backdrop-blur-md">
                            <motion.div 
                                initial={{ scale: 0.9, opacity: 0 }}
                                animate={{ scale: 1, opacity: 1 }}
                                className="p-10 border-2 border-red-600 bg-[#09090b] rounded-2xl text-center shadow-[0_0_100px_rgba(220,38,38,0.3)] max-w-md w-full relative overflow-hidden"
                            >
                                <Lock size={64} className="mx-auto mb-6 text-red-600" />
                                <h1 className="text-3xl font-black text-white mb-2 tracking-tight">CIRCUIT BREAKER</h1>
                                <p className="text-lg text-red-500 font-mono mb-8 font-bold">DAILY LOSS LIMIT EXCEEDED</p>
                                <button disabled className="w-full py-3 bg-zinc-800 text-zinc-500 rounded-lg font-bold text-sm cursor-not-allowed flex items-center justify-center gap-2">
                                    <RefreshCw size={14} /> EXECUTION PAUSED
                                </button>
                            </motion.div>
                        </div>
                    )}
                </div>
            </motion.div>
        )}
      </AnimatePresence>
      <ToastContainer toasts={state.notifications} removeToast={(id) => dispatch({ type: 'REMOVE_NOTIFICATION', payload: id })} />
    </div>
  );
};

export default App;