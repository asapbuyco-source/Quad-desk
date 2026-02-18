
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
import DepthPage from './components/DepthPage'; // Import DepthPage
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
import { toKrakenSymbol, getIntervalMs } from './utils/symbolMapping';

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
  
  // Local Order Book Buffer for Kraken Incremental Updates
  const orderBookRef = useRef<{ asks: Map<number, number>, bids: Map<number, number> }>({ asks: new Map(), bids: new Map() });
  
  // Issue #3: Candle Aggregation Refs
  const candleOpenRef = useRef<number | null>(null);
  const candleHighRef = useRef<number | null>(null);
  const candleLowRef = useRef<number | null>(null);
  const candleVolumeRef = useRef<number>(0);
  const candleDeltaRef = useRef<number>(0); // NEW: Track real-time delta
  const lastCandleTimeRef = useRef<number>(0);

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
      processDepthUpdate,
      refreshHeatmap,
      refreshRegimeAnalysis,
      refreshTacticalAnalysis,
      resetCvd
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

  // Issue #6: Poll Heatmap
  useEffect(() => {
      refreshHeatmap();
      const interval = setInterval(refreshHeatmap, 60000);
      return () => clearInterval(interval);
  }, [config.activeSymbol]);

  // Global Analysis Loop (Regime & Tactical)
  useEffect(() => {
      // Run immediately
      refreshRegimeAnalysis();
      refreshTacticalAnalysis();
      
      const interval = setInterval(() => {
          refreshRegimeAnalysis();
          refreshTacticalAnalysis();
      }, 5000); // 5 seconds
      return () => clearInterval(interval);
  }, [config.activeSymbol]); // Re-run if symbol changes

  // REST API History Fetcher (Kraken via Backend)
  useEffect(() => {
    let retryTimer: ReturnType<typeof setTimeout>;

    const fetchHistory = async () => {
        try {
            console.log(`📡 Connecting to Backend: ${API_BASE_URL}`);
            setConnectionErrorMessage('');
            
            // Backend maps symbol/interval to Kraken format
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
            // Removed localStorage cachedCVD priority to fix drift; rely on calculation from history data or 0
            
            // Data comes as [time, open, high, low, close, volume]
            const formattedCandles: CandleData[] = data.map((k: any) => {
                const vol = parseFloat(k[5]);
                // Estimate historical delta since we don't have tick data
                const delta = ((parseFloat(k[4]) - parseFloat(k[1])) / (parseFloat(k[2]) - parseFloat(k[3]) || 1)) * vol * 0.5; // Damped estimation
                runningCVD += delta;

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
            
            // Reset aggregation refs on new history load
            candleOpenRef.current = null;
            candleHighRef.current = null;
            candleLowRef.current = null;
            candleVolumeRef.current = 0;
            candleDeltaRef.current = 0;
            
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

  // Kraken WebSocket Logic
  useEffect(() => {
      if (connectionError) return; 

      let ws: WebSocket | null = null;
      let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
      let depthThrottle: ReturnType<typeof setTimeout> | null = null;
      let retryCount = 0;
      const MAX_RETRIES = 5;
      
      const connect = () => {
          // Kraken Public Websocket
          ws = new WebSocket('wss://ws.kraken.com');
          const krakenSymbol = toKrakenSymbol(config.activeSymbol, false); // "XBT/USDT"
          
          ws.onopen = () => { 
              retryCount = 0;
              resetCvd(); // Reset CVD on reconnect
              
              // Subscribe to Channels
              const subMsg = {
                  event: "subscribe",
                  pair: [krakenSymbol],
                  subscription: {} as any
              };
              
              // 1. Ticker
              ws?.send(JSON.stringify({ ...subMsg, subscription: { name: "ticker" } }));
              // 2. Trade
              ws?.send(JSON.stringify({ ...subMsg, subscription: { name: "trade" } }));
              // 3. Book (Depth 25)
              ws?.send(JSON.stringify({ ...subMsg, subscription: { name: "book", depth: 25 } }));
          };

          ws.onmessage = (event) => {
              const msg = JSON.parse(event.data);
              
              // Handle Heartbeat
              if (msg.event === 'heartbeat' || msg.event === 'systemStatus' || msg.event === 'subscriptionStatus') {
                  return;
              }

              // Kraken sends data as Array: [channelID, data, channelName, pair]
              if (Array.isArray(msg)) {
                  const channelName = msg[2];
                  const data = msg[1];

                  // 1. Handle Trade -> Tape & Candle Volume
                  if (channelName === 'trade') {
                      // data is array of trades: [[price, vol, time, side, type, misc], ...]
                      data.forEach((t: any) => {
                          const price = parseFloat(t[0]);
                          const vol = parseFloat(t[1]);
                          const side = t[3] === 's' ? 'SELL' : 'BUY';
                          const trade: RecentTrade = {
                              id: `${t[2]}-${t[0]}`, // time-price as fake ID
                              price: price,
                              size: vol,
                              side: side,
                              time: parseFloat(t[2]) * 1000,
                              isWhale: (price * vol) > 50000
                          };
                          processTradeTick(trade);
                          
                          // Issue #3: Accumulate volume for synthetic candle
                          candleVolumeRef.current += vol;
                          // Real-time Delta Accumulation
                          if (side === 'BUY') candleDeltaRef.current += vol;
                          else candleDeltaRef.current -= vol;
                      });
                  }

                  // 2. Handle Ticker -> Synthetic Kline
                  else if (channelName === 'ticker') {
                      // data format: { c: [price, vol], ... }
                      const price = parseFloat(data.c[0]);
                      const time = Date.now();
                      const intervalMs = getIntervalMs(config.interval);
                      const startTime = Math.floor(time / intervalMs) * intervalMs;

                      // Reset refs if new candle started
                      if (startTime !== lastCandleTimeRef.current) {
                          candleOpenRef.current = price;
                          candleHighRef.current = price;
                          candleLowRef.current = price;
                          candleVolumeRef.current = 0;
                          candleDeltaRef.current = 0; // Reset Delta for new candle
                          lastCandleTimeRef.current = startTime;
                      }

                      // Initialize if null (e.g. first tick after load)
                      if (candleOpenRef.current === null) candleOpenRef.current = price;
                      
                      // Update High/Low
                      if (candleHighRef.current === null || price > candleHighRef.current) candleHighRef.current = price;
                      if (candleLowRef.current === null || price < candleLowRef.current) candleLowRef.current = price;

                      // Synthetic candle update
                      const syntheticKline = {
                          t: startTime,
                          o: candleOpenRef.current, 
                          h: candleHighRef.current, 
                          l: candleLowRef.current,
                          c: price, 
                          v: candleVolumeRef.current 
                      };
                      
                      // Pass the accumulated real delta to the store
                      processWsTick(syntheticKline, candleDeltaRef.current);
                  }

                  // 3. Handle Book -> Depth
                  else if (channelName.startsWith('book')) {
                      // Snapshot: contains 'as' (asks) and 'bs' (bids)
                      if (data.as || data.bs) {
                          orderBookRef.current.asks.clear();
                          orderBookRef.current.bids.clear();
                          
                          if (data.as) data.as.forEach((x: any) => orderBookRef.current.asks.set(parseFloat(x[0]), parseFloat(x[1])));
                          if (data.bs) data.bs.forEach((x: any) => orderBookRef.current.bids.set(parseFloat(x[0]), parseFloat(x[1])));
                          
                          dispatchDepth();
                      } 
                      // Update: contains 'a' or 'b' or both
                      else {
                          if (data.a) {
                              data.a.forEach((x: any) => {
                                  const price = parseFloat(x[0]);
                                  const size = parseFloat(x[1]);
                                  if (size === 0) orderBookRef.current.asks.delete(price);
                                  else orderBookRef.current.asks.set(price, size);
                              });
                          }
                          if (data.b) {
                              data.b.forEach((x: any) => {
                                  const price = parseFloat(x[0]);
                                  const size = parseFloat(x[1]);
                                  if (size === 0) orderBookRef.current.bids.delete(price);
                                  else orderBookRef.current.bids.set(price, size);
                              });
                          }

                          if (!depthThrottle) {
                              depthThrottle = setTimeout(() => {
                                  dispatchDepth();
                                  depthThrottle = null;
                              }, 200);
                          }
                      }
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

      const dispatchDepth = () => {
          const rawAsks = Array.from(orderBookRef.current.asks.entries()) as [number, number][];
          const rawBids = Array.from(orderBookRef.current.bids.entries()) as [number, number][];

          // Helper to classify liquidity
          const classifyLevels = (levels: [number, number][], isBid: boolean): OrderBookLevel[] => {
              // Sort
              const sorted = levels.sort((a, b) => isBid ? b[0] - a[0] : a[0] - b[0]).slice(0, 20);
              if (sorted.length === 0) return [];

              // Calculate stats for Wall detection
              const sizes = sorted.map(l => l[1]);
              const avgSize = sizes.reduce((a, b) => a + b, 0) / sizes.length;
              // Wall Threshold: 2.5x Average (Heuristic)
              const wallThreshold = avgSize * 2.5;

              return sorted.map(([price, size]) => ({
                  price,
                  size,
                  total: 0, // Calculated in UI if needed
                  classification: size > wallThreshold ? 'WALL' : 'NORMAL'
              }));
          };

          const asks = classifyLevels(rawAsks, false);
          const bids = classifyLevels(rawBids, true);

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
                        {ui.activeTab === 'depth' && <DepthPage />} 
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
