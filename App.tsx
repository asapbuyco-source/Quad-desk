import React, { useEffect, useReducer, useRef, useCallback } from 'react';
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
import { CandleData, OrderBookLevel, MarketMetrics, TradeSignal, AiScanResult, PriceLevel, LiquidityType, RecentTrade } from './types';
import { AnimatePresence, motion } from 'framer-motion';
import { Lock, RefreshCw } from 'lucide-react';
import { calculateADX, generateSyntheticData, detectMarketRegime } from './utils/analytics';

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
        runningCVD: number; // Persistent CVD counter
        recentTrades: RecentTrade[];
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
        bands: null,
        runningCVD: 0,
        recentTrades: []
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
    | { type: 'MARKET_SET_HISTORY'; payload: { candles: CandleData[], initialCVD: number } }
    | { type: 'MARKET_SET_BANDS'; payload: any }
    | { type: 'MARKET_WS_TICK'; payload: any } // Raw kline from WS
    | { type: 'MARKET_TRADE_TICK'; payload: RecentTrade } // Individual trade execution
    | { type: 'MARKET_SIM_TICK'; payload: { asks: OrderBookLevel[]; bids: OrderBookLevel[]; metrics: Partial<MarketMetrics>; trade?: RecentTrade } }
    | { type: 'AI_START_SCAN' }
    | { type: 'AI_SCAN_COMPLETE'; payload: AiScanResult }
    | { type: 'AI_SCAN_ERROR' }
    | { type: 'AI_UPDATE_COOLDOWN'; payload: number }
    | { type: 'ADD_NOTIFICATION'; payload: ToastMessage }
    | { type: 'REMOVE_NOTIFICATION'; payload: string };

const calculateCVDAnalysis = (candles: CandleData[], currentCVD: number) => {
    if (candles.length < 10) return { trend: 'FLAT' as const, divergence: 'NONE' as const, interpretation: 'NEUTRAL' as const, value: currentCVD };

    const lookback = 10;
    const subset = candles.slice(-lookback);
    const first = subset[0];
    const last = subset[subset.length - 1];

    const priceChange = last.close - first.close;
    const cvdChange = (last.cvd || 0) - (first.cvd || 0);

    let interpretation: 'REAL STRENGTH' | 'REAL WEAKNESS' | 'ABSORPTION' | 'DISTRIBUTION' | 'NEUTRAL' = 'NEUTRAL';
    let divergence: 'NONE' | 'BULLISH_ABSORPTION' | 'BEARISH_DISTRIBUTION' = 'NONE';
    let trend: 'UP' | 'DOWN' | 'FLAT' = Math.abs(cvdChange) < 100 ? 'FLAT' : (cvdChange > 0 ? 'UP' : 'DOWN');

    if (priceChange > 0 && cvdChange > 0) interpretation = 'REAL STRENGTH';
    else if (priceChange < 0 && cvdChange < 0) interpretation = 'REAL WEAKNESS';
    else if (priceChange > 0 && cvdChange < 0) {
        interpretation = 'DISTRIBUTION';
        divergence = 'BEARISH_DISTRIBUTION';
    }
    else if (priceChange < 0 && cvdChange > 0) {
        interpretation = 'ABSORPTION';
        divergence = 'BULLISH_ABSORPTION';
    }

    return { trend, divergence, interpretation, value: currentCVD };
};

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
                market: { ...state.market, candles: [], signals: [], runningCVD: 0, recentTrades: [] } // Reset data on toggle
            };
        case 'CONFIG_SET_SYMBOL':
            return {
                ...state,
                config: { ...state.config, activeSymbol: action.payload },
                market: { 
                    ...state.market, 
                    candles: [], 
                    bands: null,
                    runningCVD: 0,
                    recentTrades: [],
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
            const candlesWithAdx = calculateADX(action.payload.candles);
            const initialCvdAnalysis = calculateCVDAnalysis(candlesWithAdx, action.payload.initialCVD);
            const initialRegime = detectMarketRegime(candlesWithAdx);

            return { 
                ...state, 
                market: { 
                    ...state.market, 
                    candles: candlesWithAdx, 
                    runningCVD: action.payload.initialCVD,
                    metrics: {
                        ...state.market.metrics,
                        cvdContext: initialCvdAnalysis,
                        regime: initialRegime
                    }
                } 
            };
        
        case 'MARKET_SET_BANDS':
            return { ...state, market: { ...state.market, bands: action.payload } };

        case 'MARKET_WS_TICK': {
            const k = action.payload;
            const newPrice = parseFloat(k.c);
            const newTime = k.t / 1000;
            const bands = state.market.bands;

            const totalVol = parseFloat(k.v);
            const takerBuyVol = parseFloat(k.V);
            const delta = (2 * takerBuyVol) - totalVol;
            
            let updatedCandles = [...state.market.candles];
            let newRunningCVD = state.market.runningCVD;
            
            if (updatedCandles.length > 0) {
                const lastCandle = updatedCandles[updatedCandles.length - 1];
                if (lastCandle.time === newTime) {
                    const currentCVDValue = (updatedCandles.length > 1 ? updatedCandles[updatedCandles.length - 2].cvd || 0 : 0) + delta;
                    updatedCandles[updatedCandles.length - 1] = {
                        ...lastCandle,
                        close: newPrice,
                        high: Math.max(lastCandle.high, newPrice),
                        low: Math.min(lastCandle.low, newPrice),
                        volume: totalVol,
                        delta: delta,
                        cvd: currentCVDValue
                    };
                    newRunningCVD = currentCVDValue; 
                } else {
                    const prevCVD = updatedCandles[updatedCandles.length - 1].cvd || 0;
                    const currentCVDValue = prevCVD + delta;
                    updatedCandles.push({
                        time: newTime,
                        open: parseFloat(k.o),
                        high: parseFloat(k.h),
                        low: parseFloat(k.l),
                        close: newPrice,
                        volume: totalVol,
                        delta: delta,
                        cvd: currentCVDValue,
                        zScoreUpper1: bands ? bands.upper_1 : newPrice * 1.002,
                        zScoreLower1: bands ? bands.lower_1 : newPrice * 0.998,
                        zScoreUpper2: bands ? bands.upper_2 : newPrice * 1.005,
                        zScoreLower2: bands ? bands.lower_2 : newPrice * 0.995,
                    });
                    newRunningCVD = currentCVDValue;
                }
            } else {
                 updatedCandles.push({
                    time: newTime,
                    open: parseFloat(k.o),
                    high: parseFloat(k.h),
                    low: parseFloat(k.l),
                    close: newPrice,
                    volume: totalVol,
                    delta: delta,
                    cvd: delta,
                    zScoreUpper1: newPrice * 1.002,
                    zScoreLower1: newPrice * 0.998,
                    zScoreUpper2: newPrice * 1.005,
                    zScoreLower2: newPrice * 0.995,
                });
                newRunningCVD = delta;
            }

            const takerSellVol = totalVol - takerBuyVol;
            const ofi = takerBuyVol - takerSellVol;
            const candlesWithAdx = calculateADX(updatedCandles);
            const cvdContext = calculateCVDAnalysis(candlesWithAdx, newRunningCVD);
            const currentRegime = detectMarketRegime(candlesWithAdx);

            return {
                ...state,
                market: {
                    ...state.market,
                    candles: candlesWithAdx,
                    runningCVD: newRunningCVD,
                    metrics: {
                        ...state.market.metrics,
                        price: newPrice,
                        change: parseFloat(k.P) || 0,
                        ofi: ofi,
                        cvdContext: cvdContext,
                        regime: currentRegime
                    }
                }
            };
        }

        case 'MARKET_TRADE_TICK':
            const updatedTrades = [action.payload, ...state.market.recentTrades].slice(0, 50);
            return { ...state, market: { ...state.market, recentTrades: updatedTrades } };

        case 'MARKET_SIM_TICK':
            let simTrades = state.market.recentTrades;
            if (action.payload.trade) {
                simTrades = [action.payload.trade, ...simTrades].slice(0, 50);
            }
            return {
                ...state,
                market: {
                    ...state.market,
                    asks: action.payload.asks,
                    bids: action.payload.bids,
                    recentTrades: simTrades,
                    metrics: { ...state.market.metrics, ...action.payload.metrics }
                }
            };

        case 'AI_START_SCAN':
            return { ...state, ai: { ...state.ai, isScanning: true, lastScanTime: Date.now(), cooldownRemaining: 60 } };
        
        case 'AI_SCAN_COMPLETE': {
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

const BACKTEST_DATA = generateSyntheticData(42000, 300);
const SCAN_COOLDOWN = 60;

const App: React.FC = () => {
  const [state, dispatch] = useReducer(appReducer, INITIAL_STATE);
  
  const backtestStepRef = useRef(0);
  const simulatedAsksRef = useRef<OrderBookLevel[]>([]);
  const simulatedBidsRef = useRef<OrderBookLevel[]>([]);

  // 1. Fetch Historical Data
  useEffect(() => {
    if (state.config.isBacktest) return;

    const fetchHistory = async () => {
        try {
            // PROXY REQUEST TO BACKEND TO AVOID CORS
            const res = await fetch(`${API_BASE_URL}/history?symbol=${state.config.activeSymbol}&interval=${state.config.interval}`);
            if (!res.ok) throw new Error("API Error");
            
            const data = await res.json();
            if (data.error) throw new Error(data.error);

            let runningCVD = 0;
            const formattedCandles: CandleData[] = data.map((k: any) => {
                const vol = parseFloat(k[5]);
                const takerBuyVol = parseFloat(k[9]); 
                const delta = (2 * takerBuyVol) - vol;
                runningCVD += delta;

                return {
                    time: k[0] / 1000,
                    open: parseFloat(k[1]), high: parseFloat(k[2]), low: parseFloat(k[3]), close: parseFloat(k[4]), volume: vol,
                    delta: delta,
                    cvd: runningCVD,
                    zScoreUpper1: parseFloat(k[4]) * 1.002, zScoreLower1: parseFloat(k[4]) * 0.998,
                    zScoreUpper2: parseFloat(k[4]) * 1.005, zScoreLower2: parseFloat(k[4]) * 0.995,
                };
            }).filter((c: CandleData) => !isNaN(c.close));
            
            dispatch({ type: 'MARKET_SET_HISTORY', payload: { candles: formattedCandles, initialCVD: runningCVD } });
        } catch (e) {
            console.warn("History fetch failed. Engaging Fallback.", e);
            
            const fallbackPrice = state.config.activeSymbol.startsWith('BTC') ? 64000 : 3200;
            const fallbackData = generateSyntheticData(fallbackPrice, 200);
            const fallbackCVD = fallbackData.length > 0 ? (fallbackData[fallbackData.length-1].cvd || 0) : 0;
            
            dispatch({ type: 'MARKET_SET_HISTORY', payload: { candles: fallbackData, initialCVD: fallbackCVD } });
            dispatch({
                type: 'ADD_NOTIFICATION',
                payload: { id: Date.now().toString(), type: 'warning', title: 'Data Feed Restricted', message: 'Using synthetic data stream due to connection issues.' }
            });
        }
    };
    fetchHistory();
  }, [state.config.isBacktest, state.config.interval, state.config.activeSymbol]);

  // 2. Fetch Bands
  useEffect(() => {
      if (state.config.isBacktest) {
          dispatch({ type: 'MARKET_SET_BANDS', payload: null });
          return;
      }
      const fetchBands = async () => {
          try {
              const res = await fetch(`${API_BASE_URL}/bands?symbol=${state.config.activeSymbol}`);
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
          const symbol = state.config.activeSymbol.toLowerCase();
          const streams = `${symbol}@kline_${state.config.interval}/${symbol}@aggTrade`;
          ws = new WebSocket(`wss://stream.binance.com:9443/stream?streams=${streams}`);
          
          ws.onopen = () => { retryCount = 0; };
          
          ws.onmessage = (event) => {
              const message = JSON.parse(event.data);
              if (message.data) {
                  if (message.data.e === 'kline') {
                      dispatch({ type: 'MARKET_WS_TICK', payload: message.data.k });
                  } 
                  else if (message.data.e === 'aggTrade') {
                      const isSell = message.data.m; 
                      const trade: RecentTrade = {
                          id: message.data.a.toString(),
                          price: parseFloat(message.data.p),
                          size: parseFloat(message.data.q),
                          side: isSell ? 'SELL' : 'BUY',
                          time: message.data.T,
                          isWhale: (parseFloat(message.data.p) * parseFloat(message.data.q)) > 50000
                      };
                      dispatch({ type: 'MARKET_TRADE_TICK', payload: trade });
                  }
              }
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
          const response = await fetch(`${API_BASE_URL}/analyze?symbol=${state.config.activeSymbol}`, { signal: controller.signal });
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

  // 6. Stateful Simulation Engine
  useEffect(() => {
    if (!state.config.isBacktest) { 
        const i = setInterval(() => {
            const currentPrice = state.market.metrics.price || 42000;
            const spread = currentPrice * 0.0001; 

            const generateLevel = (price: number): OrderBookLevel => {
                 const isWhale = Math.random() > 0.92;
                 const size = isWhale 
                    ? Math.floor(Math.random() * 2500) + 1000 
                    : Math.floor(Math.random() * 300) + 20;
                 return { price, size, total: 0, delta: 0, classification: 'NORMAL' };
            };

            const updateBook = (prevLevels: OrderBookLevel[], isAsk: boolean): OrderBookLevel[] => {
                const newLevels: OrderBookLevel[] = [];
                const basePrice = currentPrice;
                
                for(let k=0; k<15; k++) {
                     const offset = spread + (k * spread * 1.5);
                     const p = isAsk ? basePrice + offset : basePrice - offset;
                     
                     const existing = prevLevels.find(l => Math.abs(l.price - p) < spread * 0.5);
                     
                     if (existing) {
                         let change = Math.floor((Math.random() - 0.5) * 50);
                         if (Math.random() > 0.95 && existing.size > 1000) {
                             change = -Math.floor(existing.size * 0.8);
                         }

                         const newSize = Math.max(1, existing.size + change);
                         newLevels.push({
                             ...existing,
                             price: p,
                             size: newSize,
                             delta: change
                         });
                     } else {
                         newLevels.push({
                             ...generateLevel(p),
                             delta: 100
                         });
                     }
                }
                return isAsk ? newLevels.reverse() : newLevels;
            };

            simulatedAsksRef.current = updateBook(simulatedAsksRef.current, true);
            simulatedBidsRef.current = updateBook(simulatedBidsRef.current, false);

            const avgSize = [...simulatedAsksRef.current, ...simulatedBidsRef.current].reduce((acc, l) => acc + l.size, 0) / 30;
            const classify = (l: OrderBookLevel) => {
                let type: LiquidityType = 'NORMAL';
                if (l.size > avgSize * 2.5) type = 'WALL';
                else if (l.size < avgSize * 0.25) type = 'HOLE';
                else if (l.size > avgSize * 1.5 && Math.random() > 0.85) type = 'CLUSTER';
                return { ...l, classification: type };
            };

            const asks = simulatedAsksRef.current.map(classify);
            const bids = simulatedBidsRef.current.map(classify);

            let simTrade: RecentTrade | undefined;
            if (Math.random() > 0.3) {
                 const isBuy = Math.random() > 0.5;
                 const size = Math.random() * 2;
                 simTrade = {
                     id: Date.now().toString(),
                     price: currentPrice + (Math.random() - 0.5) * 10,
                     size: size,
                     side: isBuy ? 'BUY' : 'SELL',
                     time: Date.now(),
                     isWhale: size > 1.5
                 };
            }
            
            dispatch({ 
                type: 'MARKET_SIM_TICK', 
                payload: {
                    asks,
                    bids,
                    trade: simTrade,
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
      if (!BACKTEST_DATA || BACKTEST_DATA.length === 0) return;

      const intervalMs = 100 / state.config.playbackSpeed;
      const i = setInterval(() => {
          if (backtestStepRef.current >= BACKTEST_DATA.length) backtestStepRef.current = 0;
          const candle = BACKTEST_DATA[backtestStepRef.current];
          if (candle) {
              dispatch({ 
                  type: 'MARKET_WS_TICK', 
                  payload: { 
                      t: candle.time as number * 1000, o: candle.open, h: candle.high, l: candle.low, c: candle.close, v: candle.volume, P: 0, 
                      V: (candle.volume * 0.6)
                  } 
              });
              if (Math.random() > 0.5) {
                   dispatch({
                       type: 'MARKET_TRADE_TICK',
                       payload: {
                           id: Date.now().toString(),
                           price: candle.close,
                           size: Math.random(),
                           side: Math.random() > 0.5 ? 'BUY' : 'SELL',
                           time: Date.now(),
                           isWhale: false
                       }
                   });
              }
          }
          backtestStepRef.current++;
      }, intervalMs);
      return () => clearInterval(i);
  }, [state.config.isBacktest, state.config.playbackSpeed]);

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
                                recentTrades={state.market.recentTrades}
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