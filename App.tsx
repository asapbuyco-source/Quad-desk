
import React, { useEffect, useState } from 'react';
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
import type { CandleData, OrderBookLevel, RecentTrade, LiquidityType, PeriodType } from './types';
import { AnimatePresence, motion as m } from 'framer-motion';
import { Lock, RefreshCw, ServerOff } from 'lucide-react';
import { useStore } from './store';
import { onAuthStateChanged } from 'firebase/auth';
import { auth } from './lib/firebase';
import { calculateADX, generateMockCandles } from './utils/analytics'; 

const motion = m as any;

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

  useEffect(() => {
    const fetchHistory = async () => {
        try {
            console.log(`📡 Connecting to Backend: ${API_BASE_URL}`);
            const res = await fetch(`${API_BASE_URL}/history?symbol=${config.activeSymbol}&interval=${config.interval}`);
            
            // Handle 502/503 specifically
            if (res.status === 502 || res.status === 503) {
                throw new Error("Backend Unavailable (502 Bad Gateway)");
            }

            const contentType = res.headers.get("content-type");
            if (contentType && contentType.includes("text/html")) {
                throw new Error("Invalid API Response (Received HTML, likely error page)");
            }

            if (!res.ok) throw new Error(`HTTP Status ${res.status}`);
            
            const data = await res.json();
            
            if (data.error) throw new Error(data.error);
            if (!Array.isArray(data)) throw new Error("Invalid data format received");

            // Success path
            setConnectionError(false);
            let runningCVD = 0;
            const cachedCVD = localStorage.getItem(`cvd_${config.activeSymbol}`);
            if (cachedCVD && !isNaN(parseFloat(cachedCVD))) {
                runningCVD = parseFloat(cachedCVD);
            }

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
                    zScoreUpper1: 0, zScoreLower1: 0,
                    zScoreUpper2: 0, zScoreLower2: 0,
                    adx: 0 
                };
            }).filter((c: CandleData) => !isNaN(c.close));
            
            const candlesWithADX = calculateADX(formattedCandles, 14);
            setMarketHistory({ candles: candlesWithADX, initialCVD: runningCVD });

        } catch (e: any) {
            console.error(`History Fetch Failed: ${e.message}`);
            
            // SIMULATION FALLBACK
            if (!connectionError) {
                setConnectionError(true);
                addNotification({ 
                    id: 'backend-fail', 
                    type: 'warning', 
                    title: 'System Offline', 
                    message: `Backend unreachable (${e.message}). Switching to Simulation Mode.` 
                });
            }

            // Generate realistic fallback data
            const mockData = generateMockCandles(300); 
            setMarketHistory({ candles: mockData, initialCVD: 0 });
        }
    };
    fetchHistory();
  }, [config.interval, config.activeSymbol]);

  useEffect(() => {
      const fetchBands = async () => {
          if (connectionError) return; // Don't spam if down
          try {
              const res = await fetch(`${API_BASE_URL}/bands?symbol=${config.activeSymbol}`);
              if (res.ok) {
                   const data = await res.json();
                   if (!data.error) setMarketBands(data);
              }
          } catch(e) {
              // Silent fail for bands to avoid console noise
          }
      };
      fetchBands();
      const i = setInterval(fetchBands, 60000);
      return () => clearInterval(i);
  }, [config.activeSymbol, connectionError]);

  // Websocket logic omitted for brevity (it handles its own connection errors)
  // Re-adding essential WS code block below to ensure functionality
  useEffect(() => {
      if (connectionError) return; // Don't try WS if backend/proxy is known bad, actually WS is separate usually but lets keep trying

      let ws: WebSocket | null = null;
      let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
      let retryCount = 0;
      let useUsEndpoint = false;
      const MAX_RETRIES = 5;
      
      const connect = () => {
          const symbol = config.activeSymbol.toLowerCase();
          const streams = `${symbol}@kline_${config.interval}/${symbol}@aggTrade/${symbol}@depth20@100ms`;
          const baseUrl = useUsEndpoint ? 'wss://stream.binance.us:9443' : 'wss://stream.binance.com:9443';

          ws = new WebSocket(`${baseUrl}/stream?streams=${streams}`);
          
          ws.onopen = () => { retryCount = 0; };
          ws.onmessage = (event) => {
              const message = JSON.parse(event.data);
              if (message.data) {
                  if (message.data.e === 'kline') processWsTick(message.data.k);
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
                      processTradeTick(trade);
                  }
                  else if (message.stream.includes('@depth20')) {
                      // ... depth logic (simplified for fallback context)
                      const asks = message.data.asks.map((l:any) => ({price: parseFloat(l[0]), size: parseFloat(l[1])})).reverse();
                      const bids = message.data.bids.map((l:any) => ({price: parseFloat(l[0]), size: parseFloat(l[1])}));
                      processDepthUpdate({ asks, bids, metrics: {} });
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
      
      connect();
      return () => {
          if (ws) ws.close();
          if (reconnectTimer) clearTimeout(reconnectTimer);
      };
  }, [config.interval, config.activeSymbol]);

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
                    
                    {/* Connection Error Banner */}
                    <AnimatePresence>
                        {connectionError && (
                            <motion.div 
                                initial={{ height: 0, opacity: 0 }}
                                animate={{ height: 'auto', opacity: 1 }}
                                exit={{ height: 0, opacity: 0 }}
                                className="bg-rose-500/10 border-b border-rose-500/20 px-4 py-1 flex items-center justify-center gap-2"
                            >
                                <ServerOff size={12} className="text-rose-500" />
                                <span className="text-[10px] font-bold text-rose-500 uppercase tracking-widest">
                                    BACKEND DISCONNECTED - RUNNING SIMULATION
                                </span>
                            </motion.div>
                        )}
                    </AnimatePresence>

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
