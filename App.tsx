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
import DepthPage from './components/DepthPage';
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
  
  // Ref for last dispatched book for delta calculation
  const lastDispatchedBookRef = useRef<{ asks: Map<number, number>, bids: Map<number, number> }>({ asks: new Map(), bids: new Map() });
  
  // Real-time delta tracker
  const candleDeltaRef = useRef<number>(0);

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

  useEffect(() => {
      refreshHeatmap();
      const interval = setInterval(refreshHeatmap, 60000);
      return () => clearInterval(interval);
  }, [config.activeSymbol]);

  useEffect(() => {
      refreshRegimeAnalysis();
      refreshTacticalAnalysis();
      const interval = setInterval(() => {
          refreshRegimeAnalysis();
          refreshTacticalAnalysis();
      }, 5000);
      return () => clearInterval(interval);
  }, [config.activeSymbol]);

  // REST API History Fetcher (Backend -> Kraken)
  useEffect(() => {
    let retryTimer: ReturnType<typeof setTimeout>;
    const fetchHistory = async () => {
        try {
            console.log(`📡 Fetching History Context: ${config.activeSymbol}`);
            setConnectionErrorMessage('');
            const res = await fetch(`${API_BASE_URL}/history?symbol=${config.activeSymbol}&interval=${config.interval}`);
            if (!res.ok) throw new Error(`HTTP Status ${res.status}`);
            const data = await res.json();
            if (data.error) throw new Error(data.error);
            
            let runningCVD = 0;
            const formattedCandles: CandleData[] = data.map((k: any) => {
                const vol = parseFloat(k[5]);
                const delta = ((parseFloat(k[4]) - parseFloat(k[1])) / (parseFloat(k[2]) - parseFloat(k[3]) || 1)) * vol * 0.5;
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
            candleDeltaRef.current = 0;
            setIsLoading(false);
            setConnectionError(false);
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

  // Combined Binance WebSocket Logic (High-Frequency)
  useEffect(() => {
      if (connectionError) return; 

      let ws: WebSocket | null = null;
      let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
      let retryCount = 0;
      const MAX_RETRIES = 5;
      
      const connect = () => {
          const symbol = config.activeSymbol.toLowerCase();
          const intervalMapping: Record<string, string> = { '1m': '1m', '5m': '5m', '15m': '15m', '1h': '1h', '4h': '4h', '1d': '1d' };
          const interval = intervalMapping[config.interval] || '1m';
          
          // Combined stream for kline, trade, and depth
          const streams = [
              `${symbol}@kline_${interval}`,
              `${symbol}@trade`,
              `${symbol}@depth20@100ms`
          ].join('/');
          
          ws = new WebSocket(`wss://stream.binance.com:9443/stream?streams=${streams}`);
          
          ws.onopen = () => { 
              retryCount = 0;
              resetCvd(); 
          };

          ws.onmessage = (event) => {
              const payload = JSON.parse(event.data);
              const stream = payload.stream;
              const data = payload.data;

              // 1. Kline Update (Visual Chart Core)
              if (stream.includes('@kline')) {
                  const k = data.k;
                  const tick = {
                      t: k.t,
                      o: parseFloat(k.o),
                      h: parseFloat(k.h),
                      l: parseFloat(k.l),
                      c: parseFloat(k.c),
                      v: parseFloat(k.v)
                  };
                  // Logic: Delta can be derived from Taker Buy Volume in Binance Klines
                  // delta = buyVolume - (totalVolume - buyVolume) = 2 * buyVolume - totalVolume
                  const buyVol = parseFloat(k.V);
                  const totalVol = parseFloat(k.v);
                  const klineDelta = (2 * buyVol) - totalVol;
                  
                  processWsTick(tick, klineDelta);
              }

              // 2. Trade Update (Tape & Aggressive Flow)
              else if (stream.includes('@trade')) {
                  const trade: RecentTrade = {
                      id: data.t.toString(),
                      price: parseFloat(data.p),
                      size: parseFloat(data.q),
                      side: data.m ? 'SELL' : 'BUY', // m=true means buyer is maker (it was a sell)
                      time: data.T,
                      isWhale: (parseFloat(data.p) * parseFloat(data.q)) > 50000
                  };
                  processTradeTick(trade);
              }

              // 3. Depth Update (Order Book Deltas)
              else if (stream.includes('@depth')) {
                  const asks: OrderBookLevel[] = data.asks.map((a: any) => {
                      const price = parseFloat(a[0]);
                      const size = parseFloat(a[1]);
                      const prevSize = lastDispatchedBookRef.current.asks.get(price) || size;
                      return { price, size, total: 0, delta: size - prevSize, classification: 'NORMAL' };
                  });
                  const bids: OrderBookLevel[] = data.bids.map((b: any) => {
                      const price = parseFloat(b[0]);
                      const size = parseFloat(b[1]);
                      const prevSize = lastDispatchedBookRef.current.bids.get(price) || size;
                      return { price, size, total: 0, delta: size - prevSize, classification: 'NORMAL' };
                  });

                  // Update cache for next delta cycle
                  data.asks.forEach((a: any) => lastDispatchedBookRef.current.asks.set(parseFloat(a[0]), parseFloat(a[1])));
                  data.bids.forEach((b: any) => lastDispatchedBookRef.current.bids.set(parseFloat(b[0]), parseFloat(b[1])));
                  
                  processDepthUpdate({ asks, bids, metrics: {} });
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

      connect();
      return () => {
          if (ws) ws.close();
          if (reconnectTimer) clearTimeout(reconnectTimer);
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
            <motion.div key="landing" exit={{ opacity: 0, y: -50 }} className="absolute inset-0 z-50">
                <LandingPage onEnter={() => setHasEntered(true)} />
            </motion.div>
        ) : !authState.user ? (
            <motion.div key="auth" initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="absolute inset-0 z-50">
                <AuthOverlay />
            </motion.div>
        ) : isLoading ? (
             <motion.div key="loader" initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="absolute inset-0 z-50 flex flex-col items-center justify-center bg-[#09090b]">
                <Loader2 size={48} className="text-brand-accent animate-spin" />
                <div className="mt-8 text-center px-4">
                    <h2 className="text-xl font-bold tracking-widest uppercase">SYNCHRONIZING CHRONOS</h2>
                    <p className="text-zinc-500 font-mono text-xs">Uplinking to Binance & Kraken...</p>
                </div>
            </motion.div>
        ) : (
            <motion.div key="app" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.8 }} className="flex h-full w-full">
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
                            <motion.div initial={{ scale: 0.9 }} animate={{ scale: 1 }} className="p-10 border-2 border-red-600 bg-[#09090b] rounded-2xl text-center shadow-[0_0_100px_rgba(220,38,38,0.3)]">
                                <Lock size={64} className="mx-auto mb-6 text-red-600" />
                                <h1 className="text-3xl font-black text-white mb-2 uppercase">Circuit Breaker</h1>
                                <p className="text-lg text-red-500 font-mono mb-8 font-bold">LOSS LIMIT REACHED</p>
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