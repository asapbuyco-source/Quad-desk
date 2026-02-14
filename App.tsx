
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
import { AnimatePresence, motion } from 'framer-motion';
import { Lock, RefreshCw } from 'lucide-react';
import { useStore } from './store';
import { onAuthStateChanged } from 'firebase/auth';
import { auth } from './lib/firebase';
import { calculateADX } from './utils/analytics'; // Import for Audit Fix #3

const SCAN_COOLDOWN = 60;

const App: React.FC = () => {
  const ui = useStore(state => state.ui);
  const config = useStore(state => state.config);
  const market = useStore(state => state.market);
  const ai = useStore(state => state.ai);
  const authState = useStore(state => state.auth);
  const notifications = useStore(state => state.notifications);
  const [currentPeriod, setCurrentPeriod] = useState<PeriodType>('20-PERIOD');
  
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
    // Logic to update calculations based on period could go here or within components/store logic
    // For simplicity, we might map period type to interval if applicable, or just pass it down.
    // '20-DAY' implies Daily interval context for MA
    // '20-HOUR' implies Hourly interval context for MA
    // '20-PERIOD' implies current chart interval context for MA
    
    if (period === '20-DAY') {
        // You might want to switch the main interval to '1d' or just overlay daily MA
        // setStoreInterval('1d'); 
    } else if (period === '20-HOUR') {
        // setStoreInterval('1h');
    }
    // For now we just track it in state to pass to ChartingView
  };

  useEffect(() => {
    initSystemConfig();

    const unsubscribe = onAuthStateChanged(auth, (user) => {
        if (user) {
            setUser(user);
            loadUserPreferences(); // Restore user settings (active symbol)
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
            
            if (!res.ok) throw new Error(`HTTP Status ${res.status}`);
            
            const data = await res.json();
            
            if (data.error) throw new Error(data.error);
            if (data.msg) throw new Error(`Upstream Error: ${data.msg}`);
            if (data.code && data.msg) throw new Error(`Exchange Error: ${data.msg}`);

            if (!Array.isArray(data)) {
                console.error("Invalid Data Format Received:", data);
                throw new Error("Invalid data format received from backend");
            }

            // --- AUDIT FIX #1: CVD Persistence & Recovery ---
            let runningCVD = 0;
            const cachedCVD = localStorage.getItem(`cvd_${config.activeSymbol}`);
            if (cachedCVD && !isNaN(parseFloat(cachedCVD))) {
                runningCVD = parseFloat(cachedCVD);
            }

            const formattedCandles: CandleData[] = data.map((k: any) => {
                const vol = parseFloat(k[5]);
                const takerBuyVol = parseFloat(k[9]); 
                // Formula: Delta = TakerBuy - TakerSell
                // TakerSell = Total - TakerBuy
                // Delta = TakerBuy - (Total - TakerBuy) = 2*TakerBuy - Total
                const delta = (2 * takerBuyVol) - vol;
                runningCVD += delta;

                return {
                    time: k[0] / 1000,
                    open: parseFloat(k[1]), high: parseFloat(k[2]), low: parseFloat(k[3]), close: parseFloat(k[4]), volume: vol,
                    delta: delta,
                    cvd: runningCVD,
                    zScoreUpper1: 0, zScoreLower1: 0,
                    zScoreUpper2: 0, zScoreLower2: 0,
                    adx: 0 // Placeholder
                };
            }).filter((c: CandleData) => !isNaN(c.close));
            
            // --- AUDIT FIX #3: Calculate ADX for History ---
            const candlesWithADX = calculateADX(formattedCandles, 14);

            setMarketHistory({ candles: candlesWithADX, initialCVD: runningCVD });
        } catch (e: any) {
            console.error(`History Fetch Failed: ${e.message}`);
            addNotification({ 
                id: Date.now().toString(), 
                type: 'error', 
                title: 'Data Feed Error', 
                message: `Could not fetch historical data from backend. (${e.message})` 
            });
        }
    };
    fetchHistory();
  }, [config.interval, config.activeSymbol]);

  useEffect(() => {
      const fetchBands = async () => {
          try {
              const res = await fetch(`${API_BASE_URL}/bands?symbol=${config.activeSymbol}`);
              if (res.ok) {
                  const data = await res.json();
                  if (!data.error) setMarketBands(data);
              }
          } catch(e) {}
      };
      fetchBands();
      const i = setInterval(fetchBands, 60000);
      return () => clearInterval(i);
  }, [config.activeSymbol]);

  useEffect(() => {
      let ws: WebSocket | null = null;
      let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
      let retryCount = 0;
      let useUsEndpoint = false;
      const MAX_RETRIES = 10;
      const BASE_DELAY = 1000;
      
      // --- AUDIT FIX #5: WebSocket Gap Detection ---
      let lastMessageTime = Date.now();
      let gapCheckInterval: ReturnType<typeof setInterval> | null = null;
      const GAP_THRESHOLD = 60000; // 60 seconds

      const checkForGaps = () => {
          const now = Date.now();
          if (now - lastMessageTime > GAP_THRESHOLD && ws?.readyState === WebSocket.OPEN) {
              console.warn("⚠️ Data Gap Detected. Attempting history refetch...");
              // Trigger a basic history refresh by closing socket, forcing a reconnect/reload logic
              // A cleaner way is to just call fetchHistory() again via re-triggering logic, 
              // but closing the socket will trigger the 'onclose' retry which handles connection resets.
              ws.close(); 
          }
      };

      const connect = () => {
          const symbol = config.activeSymbol.toLowerCase();
          const streams = `${symbol}@kline_${config.interval}/${symbol}@aggTrade/${symbol}@depth20@100ms`;
          
          const baseUrl = useUsEndpoint 
              ? 'wss://stream.binance.us:9443' 
              : 'wss://stream.binance.com:9443';

          ws = new WebSocket(`${baseUrl}/stream?streams=${streams}`);
          
          ws.onopen = () => { 
              retryCount = 0;
              lastMessageTime = Date.now();
              if (gapCheckInterval) clearInterval(gapCheckInterval);
              gapCheckInterval = setInterval(checkForGaps, 10000);
          };
          
          ws.onmessage = (event) => {
              lastMessageTime = Date.now(); // Update heartbeat
              const message = JSON.parse(event.data);
              
              if (message.data) {
                  // NOTE: using destructured handlers from store state inside the effect
                  // to avoid stale closure issues if they were not destructured at top level
                  
                  if (message.data.e === 'kline') {
                      processWsTick(message.data.k);
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
                      processTradeTick(trade);
                  }
                  else if (message.stream.includes('@depth20')) {
                      const asksRaw = message.data.asks;
                      const bidsRaw = message.data.bids;

                      const classify = (size: number, avgSize: number): LiquidityType => {
                          if (size > avgSize * 3) return 'WALL';
                          if (size < avgSize * 0.1) return 'HOLE';
                          if (size > avgSize * 1.5) return 'CLUSTER';
                          return 'NORMAL';
                      };

                      const totalVol = [...asksRaw, ...bidsRaw].reduce((acc, curr) => acc + parseFloat(curr[1]), 0);
                      const avgVol = totalVol / (asksRaw.length + bidsRaw.length);

                      const asks: OrderBookLevel[] = asksRaw.map((level: any[]) => {
                          const size = parseFloat(level[1]);
                          return {
                              price: parseFloat(level[0]),
                              size: size,
                              total: 0, 
                              delta: 0, 
                              classification: classify(size, avgVol)
                          };
                      }).reverse();

                      const bids: OrderBookLevel[] = bidsRaw.map((level: any[]) => {
                          const size = parseFloat(level[1]);
                          return {
                              price: parseFloat(level[0]),
                              size: size,
                              total: 0,
                              delta: 0,
                              classification: classify(size, avgVol)
                          };
                      });

                      const bidVol = bids.reduce((acc, b) => acc + b.size, 0);
                      const askVol = asks.reduce((acc, a) => acc + a.size, 0);
                      const imbalance = bidVol - askVol;
                      
                      const newToxicity = Math.min(100, Math.abs(imbalance / (bidVol + askVol)) * 200); 
                      
                      processDepthUpdate({
                          asks,
                          bids,
                          metrics: {
                              ofi: imbalance,
                              toxicity: newToxicity,
                          }
                      });
                  }
              }
          };
          
          ws.onclose = () => {
              if (gapCheckInterval) clearInterval(gapCheckInterval);
              
              if (retryCount < MAX_RETRIES) {
                   if (!useUsEndpoint && retryCount >= 1) {
                       console.log("⚠️ Geo-Restriction Detected. Switching to Binance.US WebSocket stream.");
                       useUsEndpoint = true; 
                       retryCount = 0;
                   }

                   const delay = Math.min(BASE_DELAY * Math.pow(1.5, retryCount), 30000);
                   retryCount++;
                   reconnectTimer = setTimeout(connect, delay);
               }
          };
      };
      
      connect();
      
      return () => {
          if (ws) {
              ws.close();
              ws = null;
          }
          if (reconnectTimer) {
              clearTimeout(reconnectTimer);
              reconnectTimer = null;
          }
          if (gapCheckInterval) clearInterval(gapCheckInterval);
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
