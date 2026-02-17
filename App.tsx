
import React, { useEffect, useState, useRef } from 'react';
import Header from './components/Header';
import NavBar from './components/NavBar';
import DashboardView from './components/DashboardView';
import AnalyticsView from './components/AnalyticsView';
import IntelView from './components/IntelView';
import ChartingView from './components/ChartingView';
import GuideView from './components/GuideView';
import BiasMatrixView from './components/BiasMatrixView';
import LiquidityPage from './components/LiquidityPage';
import RegimePage from './components/RegimePage';
import AITacticalPage from './components/AITacticalPage'; 
import LandingPage from './components/LandingPage';
import AuthOverlay from './components/AuthOverlay';
import AdminControl from './components/AdminControl'; 
import AlertEngine from './components/AlertEngine'; 
import { ToastContainer } from './components/Toast';
import { API_BASE_URL } from './constants';
import type { CandleData, RecentTrade, PeriodType, OrderBookLevel } from './types';
import { AnimatePresence, motion as m } from 'framer-motion';
import { Lock, RefreshCw, Loader2, AlertTriangle, ServerCrash } from 'lucide-react';
import { useStore } from './store';
import * as firebaseAuth from 'firebase/auth';
import { auth } from './lib/firebase';
import { calculateADX } from './utils/analytics'; 
import { toCoinbaseSymbol, getIntervalMs } from './utils/symbolMapping';

const motion = m as any;
const { onAuthStateChanged } = firebaseAuth;

const SCAN_COOLDOWN = 60;

const App: React.FC = () => {
  const ui = useStore(state => state.ui);
  const config = useStore(state => state.config);
  const market = useStore(state => state.market);
  const ai = useStore(state => state.ai);
  const authState = useStore(state => state.auth);
  const notifications = useStore(state => state.notifications);
  const [currentPeriod, setCurrentPeriod] = useState<PeriodType>('20-PERIOD');
  const [connectionError, setConnectionError] = useState<boolean>(false);
  const [connectionErrorMessage, setConnectionErrorMessage] = useState<string>('');
  const [isLoading, setIsLoading] = useState<boolean>(true);
  
  // Local Order Book Buffer for Coinbase Incremental Updates
  const orderBookRef = useRef<{ asks: Map<number, number>, bids: Map<number, number> }>({ asks: new Map(), bids: new Map() });
  
  const {
      setHasEntered,
      setActiveTab,
      setMarketHistory,
      setMarketBands,
      updateAiCooldown,
      addNotification,
      removeNotification,
      setUser,
      initSystemConfig,
      loadUserPreferences,
      processWsTick,
      processTradeTick,
      processDepthUpdate
  } = useStore();

  const handlePeriodChange = (period: PeriodType) => {
    setCurrentPeriod(period);
  };

  useEffect(() => {
    initSystemConfig();

    const unsubscribe = onAuthStateChanged(auth, (user) => {
        if (user) {
            setUser(user);
            loadUserPreferences(); 
            addNotification({
                id: 'auth-success',
                type: 'success',
                title: 'Identity Verified',
                message: `Welcome back, ${user.displayName?.split(' ')[0] || 'Operator'}. Uplink established.`
            });
        } else {
            setUser(null);
        }
    });
    return () => unsubscribe();
  }, []);

  // REST API History Fetcher
  useEffect(() => {
    let retryTimer: ReturnType<typeof setTimeout>;

    const fetchHistory = async () => {
        try {
            console.log(`📡 Connecting to Backend: ${API_BASE_URL}`);
            setConnectionErrorMessage('');
            
            // Backend now connects to Coinbase, expects Binance-like interval param but handles mapping internally
            const res = await fetch(`${API_BASE_URL}/history?symbol=${config.activeSymbol}&interval=${config.interval}`);
            
            if (res.status === 502 || res.status === 503) {
                throw new Error(`Backend Unavailable (HTTP ${res.status})`);
            }

            const contentType = res.headers.get("content-type");
            if (contentType && contentType.includes("text/html")) {
                throw new Error("Invalid API Response (Received HTML, likely error page)");
            }

            if (!res.ok) throw new Error(`HTTP Status ${res.status}`);
            
            const data = await res.json();
            
            if (data.error) throw new Error(data.error);
            if (!Array.isArray(data)) throw new Error("Invalid data format received");

            setConnectionError(false);
            setConnectionErrorMessage('');
            
            let runningCVD = 0;
            const cachedCVD = localStorage.getItem(`cvd_${config.activeSymbol}`);
            if (cachedCVD && !isNaN(parseFloat(cachedCVD))) {
                runningCVD = parseFloat(cachedCVD);
            }

            // Backend maps Coinbase data to Binance structure: [time, open, high, low, close, vol]
            const formattedCandles: CandleData[] = data.map((k: any) => {
                const vol = parseFloat(k[5]);
                // Coinbase doesn't give taker/maker vol in candles easily, so estimate delta or set to 0
                // For simplified simulation, we assume some delta distribution or just 0
                const delta = 0; // Requires tick aggregation for accuracy, defaulting to 0 for initial load
                // Or better: runningCVD stays as is until live trades come in.

                return {
                    time: k[0] / 1000,
                    open: parseFloat(k[1]), high: parseFloat(k[2]), low: parseFloat(k[3]), close: parseFloat(k[4]), volume: vol,
                    delta: delta,
                    cvd: runningCVD,
                    zScoreUpper1: 0, zScoreLower1: 0,
                    zScoreUpper2: 0, zScoreLower2: 0,
                    adx: 0 
                };
            }).filter((c: CandleData) => !isNaN(c.close));
            
            const candlesWithADX = calculateADX(formattedCandles, 14);
            setMarketHistory({ candles: candlesWithADX, initialCVD: runningCVD });
            setIsLoading(false);

        } catch (e: any) {
            console.error(`History Fetch Failed: ${e.message}`);
            
            setConnectionError(true);
            setConnectionErrorMessage(e.message || "Unknown Connection Error");
            setIsLoading(true);
            retryTimer = setTimeout(fetchHistory, 3000);
        }
    };

    setIsLoading(true);
    fetchHistory();

    return () => clearTimeout(retryTimer);
  }, [config.interval, config.activeSymbol]);

  // Bands Fetcher
  useEffect(() => {
      const fetchBands = async () => {
          if (connectionError) return;
          try {
              const res = await fetch(`${API_BASE_URL}/bands?symbol=${config.activeSymbol}`);
              if (res.ok) {
                   const data = await res.json();
                   if (!data.error) setMarketBands(data);
              }
          } catch(e) {
              // Silent fail
          }
      };
      fetchBands();
      const i = setInterval(fetchBands, 60000);
      return () => clearInterval(i);
  }, [config.activeSymbol, connectionError]);

  // Coinbase Pro WebSocket Logic
  useEffect(() => {
      if (connectionError) return; 

      let ws: WebSocket | null = null;
      let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
      let depthThrottle: ReturnType<typeof setTimeout> | null = null;
      let retryCount = 0;
      const MAX_RETRIES = 5;
      
      const connect = () => {
          // Coinbase Pro Websocket
          ws = new WebSocket('wss://ws-feed.pro.coinbase.com');
          const cbSymbol = toCoinbaseSymbol(config.activeSymbol);
          
          ws.onopen = () => { 
              retryCount = 0;
              // Subscribe to Channels
              ws?.send(JSON.stringify({
                  type: "subscribe",
                  product_ids: [cbSymbol],
                  channels: ["level2", "matches", "ticker"]
              }));
          };

          ws.onmessage = (event) => {
              const msg = JSON.parse(event.data);
              
              // 1. Handle Trade (Match) -> Tape
              if (msg.type === 'match') {
                  const trade: RecentTrade = {
                      id: msg.trade_id.toString(),
                      price: parseFloat(msg.price),
                      size: parseFloat(msg.size),
                      side: msg.side === 'sell' ? 'SELL' : 'BUY', // Coinbase: 'sell' means taker sold
                      time: new Date(msg.time).getTime(),
                      isWhale: (parseFloat(msg.price) * parseFloat(msg.size)) > 50000
                  };
                  processTradeTick(trade);
              }

              // 2. Handle Ticker -> Synthetic Kline Update
              // Coinbase doesn't steam klines, so we construct a partial one
              else if (msg.type === 'ticker') {
                  const price = parseFloat(msg.price);
                  const time = new Date(msg.time).getTime();
                  const intervalMs = getIntervalMs(config.interval);
                  
                  // Calculate Candle Start Time (bucketing)
                  const startTime = Math.floor(time / intervalMs) * intervalMs;

                  // Construct synthetic kline compatible with store
                  // Note: Store logic assumes if t matches last, update C/H/L/V. 
                  // If we send price as OHLC, store logic will adjust H/L naturally if it holds state, 
                  // but store `processWsTick` assumes incoming kline is authoritative for that slice.
                  // We simulate a 'tick' where close is current price.
                  const syntheticKline = {
                      t: startTime, // Start time of candle
                      o: price, // Placeholder, store handles Open logic if new
                      h: price, 
                      l: price,
                      c: price, 
                      v: parseFloat(msg.last_size || "0") // Volume of this specific tick
                  };
                  processWsTick(syntheticKline);
              }

              // 3. Handle Orderbook (Snapshot + L2 Update)
              else if (msg.type === 'snapshot') {
                  // Reset Local Map
                  orderBookRef.current.asks.clear();
                  orderBookRef.current.bids.clear();
                  
                  msg.asks.forEach((x: any) => orderBookRef.current.asks.set(parseFloat(x[0]), parseFloat(x[1])));
                  msg.bids.forEach((x: any) => orderBookRef.current.bids.set(parseFloat(x[0]), parseFloat(x[1])));
                  
                  dispatchDepth();
              }
              else if (msg.type === 'l2update') {
                  // Apply diffs
                  msg.changes.forEach((change: any[]) => {
                      const side = change[0]; // "buy" or "sell"
                      const price = parseFloat(change[1]);
                      const size = parseFloat(change[2]);
                      
                      const targetMap = side === 'buy' ? orderBookRef.current.bids : orderBookRef.current.asks;
                      
                      if (size === 0) targetMap.delete(price);
                      else targetMap.set(price, size);
                  });
                  
                  // Throttle dispatch to UI (200ms) to prevent render thrashing
                  if (!depthThrottle) {
                      depthThrottle = setTimeout(() => {
                          dispatchDepth();
                          depthThrottle = null;
                      }, 200);
                  }
              }
          };
          
          ws.onclose = () => {
              if (retryCount < MAX_RETRIES) {
                   const delay = Math.min(1000 * Math.pow(1.5, retryCount), 10000);
                   retryCount++;
                   reconnectTimer = setTimeout(connect, delay);
               }
          };
      };

      // Helper to convert Map to Sorted Arrays for Store
      const dispatchDepth = () => {
          const asks: OrderBookLevel[] = Array.from(orderBookRef.current.asks.entries())
              .sort((a, b) => a[0] - b[0]) // Ascending price
              .slice(0, 20)
              .map(([price, size]) => ({ price, size, total: 0 })); // Total calc handled by component if needed
          
          const bids: OrderBookLevel[] = Array.from(orderBookRef.current.bids.entries())
              .sort((a, b) => b[0] - a[0]) // Descending price
              .slice(0, 20)
              .map(([price, size]) => ({ price, size, total: 0 }));

          processDepthUpdate({ asks, bids, metrics: {} });
      };
      
      connect();
      return () => {
          if (ws) ws.close();
          if (reconnectTimer) clearTimeout(reconnectTimer);
          if (depthThrottle) clearTimeout(depthThrottle);
      };
  }, [config.interval, config.activeSymbol, connectionError]);

  useEffect(() => {
      if (ai.lastScanTime === 0) return;
      const i = setInterval(() => {
          const elapsed = (Date.now() - ai.lastScanTime) / 1000;
          const remaining = Math.max(0, SCAN_COOLDOWN - elapsed);
          updateAiCooldown(Math.ceil(remaining));
      }, 1000);
      return () => clearInterval(i);
  }, [ai.lastScanTime]);

  return (
    <div className={`h-screen h-[100dvh] w-screen bg-transparent text-slate-200 font-sans overflow-hidden ${market.metrics.circuitBreakerTripped ? 'grayscale opacity-80' : ''}`}>
      <AnimatePresence mode='wait'>
        {!ui.hasEntered ? (
            <motion.div
                key="landing"
                exit={{ opacity: 0, y: -50, transition: { duration: 0.5 } }}
                className="absolute inset-0 z-50"
            >
                <LandingPage onEnter={() => setHasEntered(true)} />
            </motion.div>
        ) : !authState.user ? (
            <motion.div
                key="auth"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="absolute inset-0 z-50"
            >
                <AuthOverlay />
            </motion.div>
        ) : isLoading ? (
             <motion.div
                key="loader"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="absolute inset-0 z-50 flex flex-col items-center justify-center bg-[#09090b]"
            >
                <div className="absolute inset-0 bg-[url('https://grainy-gradients.vercel.app/noise.svg')] opacity-[0.05] pointer-events-none"></div>
                
                <div className="relative">
                    <Loader2 size={48} className="text-brand-accent animate-spin" />
                    <div className="absolute inset-0 blur-xl bg-brand-accent/20 animate-pulse"></div>
                </div>
                
                <div className="mt-8 text-center space-y-4 relative z-10 px-4">
                    <div className="space-y-2">
                        <h2 className={`text-xl font-bold tracking-widest uppercase ${connectionError ? 'text-rose-500' : 'text-white'}`}>
                            {connectionError ? "CONNECTION LOST" : "ESTABLISHING UPLINK"}
                        </h2>
                        <p className="text-zinc-500 font-mono text-xs">
                            {connectionError ? `Retrying connection to ${config.activeSymbol}...` : `Syncing market data for ${config.activeSymbol}`}
                        </p>
                    </div>

                    {connectionError && (
                        <motion.div 
                            initial={{ opacity: 0, y: 10 }}
                            animate={{ opacity: 1, y: 0 }}
                            className="bg-rose-500/10 border border-rose-500/20 rounded-lg p-3 max-w-xs mx-auto backdrop-blur-md"
                        >
                            <div className="flex items-center justify-center gap-2 text-rose-400 mb-1">
                                {connectionErrorMessage.includes('502') ? <ServerCrash size={12} /> : <AlertTriangle size={12} />}
                                <span className="text-[10px] font-bold uppercase">
                                    {connectionErrorMessage.includes('502') ? 'Server Unavailable' : 'Diagnostic Info'}
                                </span>
                            </div>
                            <p className="text-xs font-mono text-rose-300 break-words">
                                {connectionErrorMessage}
                            </p>
                            {connectionErrorMessage.includes('Failed to fetch') && (
                                <p className="text-[10px] text-rose-400/70 mt-2">
                                    Is the backend running? Check port 8000.
                                </p>
                            )}
                        </motion.div>
                    )}
                </div>
            </motion.div>
        ) : (
            <motion.div 
                key="app"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ duration: 0.8 }}
                className="flex h-full w-full"
            >
                <NavBar activeTab={ui.activeTab} setActiveTab={setActiveTab} />
                <AdminControl />
                <AlertEngine />

                <div className="flex-1 flex flex-col h-full overflow-hidden relative">
                    <Header />
                    
                    <main className="flex-1 overflow-hidden p-0 lg:p-6 lg:pl-0 relative">
                        {ui.activeTab === 'dashboard' && <DashboardView />}
                        {ui.activeTab === 'charting' && <ChartingView currentPeriod={currentPeriod} onPeriodChange={handlePeriodChange} />}
                        {ui.activeTab === 'bias' && <BiasMatrixView />}
                        {ui.activeTab === 'liquidity' && <LiquidityPage />}
                        {ui.activeTab === 'regime' && <RegimePage />}
                        {ui.activeTab === 'ai-tactical' && <AITacticalPage />}
                        {ui.activeTab === 'analytics' && <AnalyticsView />}
                        {ui.activeTab === 'intel' && <IntelView />}
                        {ui.activeTab === 'guide' && <GuideView />}
                    </main>

                    {market.metrics.circuitBreakerTripped && (
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
      <ToastContainer toasts={notifications} removeToast={removeNotification} />
    </div>
  );
};

export default App;
