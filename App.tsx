
import React, { useEffect, useRef } from 'react';
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
import AITacticalPage from './components/AITacticalPage'; // New Import
import LandingPage from './components/LandingPage';
import AuthOverlay from './components/AuthOverlay';
import AdminControl from './components/AdminControl'; // Import Admin Panel
import AlertEngine from './components/AlertEngine'; // Import Alert Engine
import { ToastContainer } from './components/Toast';
import { API_BASE_URL } from './constants';
import { CandleData, OrderBookLevel, RecentTrade, LiquidityType } from './types';
import { AnimatePresence, motion } from 'framer-motion';
import { Lock, RefreshCw } from 'lucide-react';
import { generateSyntheticData } from './utils/analytics';
import { useStore } from './store';
import { onAuthStateChanged } from 'firebase/auth';
import { auth } from './lib/firebase';

const BACKTEST_DATA = generateSyntheticData(42000, 300);
const SCAN_COOLDOWN = 60;

const App: React.FC = () => {
  // Access State and Actions from Zustand Store
  const ui = useStore(state => state.ui);
  const config = useStore(state => state.config);
  const market = useStore(state => state.market);
  const ai = useStore(state => state.ai);
  const authState = useStore(state => state.auth);
  const notifications = useStore(state => state.notifications);
  
  const {
      setHasEntered,
      setActiveTab,
      setMarketHistory,
      setMarketBands,
      processWsTick,
      processTradeTick,
      updateAiCooldown,
      addNotification,
      removeNotification,
      setUser,
      initSystemConfig // Config Action
  } = useStore();

  const backtestStepRef = useRef(0);
  const simulatedAsksRef = useRef<OrderBookLevel[]>([]);
  const simulatedBidsRef = useRef<OrderBookLevel[]>([]);

  // 0. Auth Listener & System Config
  useEffect(() => {
    // Initialize system listener (e.g., registration status)
    initSystemConfig();

    const unsubscribe = onAuthStateChanged(auth, (user) => {
        if (user) {
            setUser(user);
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

  // 1. Fetch Historical Data
  useEffect(() => {
    if (config.isBacktest) return;

    const fetchHistory = async () => {
        try {
            console.log(`📡 Connecting to Backend: ${API_BASE_URL}`);
            // PROXY REQUEST TO BACKEND TO AVOID CORS
            const res = await fetch(`${API_BASE_URL}/history?symbol=${config.activeSymbol}&interval=${config.interval}`);
            
            if (!res.ok) throw new Error(`HTTP Status ${res.status}`);
            
            const data = await res.json();
            
            // Check for error responses from backend or upstream proxies
            if (data.error) throw new Error(data.error);
            if (data.msg) throw new Error(`Upstream Error: ${data.msg}`);
            if (data.code && data.msg) throw new Error(`Exchange Error: ${data.msg}`);

            if (!Array.isArray(data)) {
                console.error("Invalid Data Format Received:", data);
                throw new Error("Invalid data format received from backend");
            }

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
            
            setMarketHistory({ candles: formattedCandles, initialCVD: runningCVD });
        } catch (e: any) {
            console.warn(`⚠️ History fetch failed [${API_BASE_URL}]. Engaging Fallback. Reason: ${e.message}`);
            
            const fallbackPrice = config.activeSymbol.startsWith('BTC') ? 64000 : 3200;
            const fallbackData = generateSyntheticData(fallbackPrice, 200);
            const fallbackCVD = fallbackData.length > 0 ? (fallbackData[fallbackData.length-1].cvd || 0) : 0;
            
            setMarketHistory({ candles: fallbackData, initialCVD: fallbackCVD });
            
            // Only notify if we were expecting a live connection
            if (API_BASE_URL.includes('localhost') || API_BASE_URL.includes('render')) {
                addNotification({ 
                    id: Date.now().toString(), 
                    type: 'warning', 
                    title: 'Data Feed Restricted', 
                    message: `Using synthetic data. Backend unreachable (${e.message}).` 
                });
            }
        }
    };
    fetchHistory();
  }, [config.isBacktest, config.interval, config.activeSymbol]);

  // 2. Fetch Bands
  useEffect(() => {
      if (config.isBacktest) {
          setMarketBands(null);
          return;
      }
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
  }, [config.isBacktest, config.activeSymbol]);

  // 3. WebSocket (Live)
  useEffect(() => {
      if (config.isBacktest) return;

      let ws: WebSocket | null = null;
      let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
      let retryCount = 0;
      let useUsEndpoint = false; // Toggle for US endpoint fallback
      const MAX_RETRIES = 10;
      const BASE_DELAY = 1000;

      const connect = () => {
          const symbol = config.activeSymbol.toLowerCase();
          const streams = `${symbol}@kline_${config.interval}/${symbol}@aggTrade`;
          
          // Fallback logic for US users
          const baseUrl = useUsEndpoint 
              ? 'wss://stream.binance.us:9443' 
              : 'wss://stream.binance.com:9443';

          ws = new WebSocket(`${baseUrl}/stream?streams=${streams}`);
          
          ws.onopen = () => { retryCount = 0; };
          
          ws.onmessage = (event) => {
              const message = JSON.parse(event.data);
              if (message.data) {
                  // Use getState() to avoid stale closures
                  const { processWsTick, processTradeTick } = useStore.getState();

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
              }
          };
          
          ws.onclose = () => {
              if (retryCount < MAX_RETRIES) {
                   // Failover Logic: If connection fails instantly, try US Endpoint
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
      };
  }, [config.isBacktest, config.interval, config.activeSymbol]); // Correct dependencies

  // 4. Cooldown Timer
  useEffect(() => {
      if (ai.lastScanTime === 0) return;
      const i = setInterval(() => {
          const elapsed = (Date.now() - ai.lastScanTime) / 1000;
          const remaining = Math.max(0, SCAN_COOLDOWN - elapsed);
          updateAiCooldown(Math.ceil(remaining));
      }, 1000);
      return () => clearInterval(i);
  }, [ai.lastScanTime]);

  // 5. Stateful Simulation Engine
  useEffect(() => {
    if (!config.isBacktest) { 
        const intervalId = setInterval(() => {
            // Always get fresh state
            const { market, processSimTick } = useStore.getState();
            
            const currentPrice = market.metrics.price || 42000;
            const currentMetrics = market.metrics;

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
            
            processSimTick({
                asks,
                bids,
                trade: simTrade,
                metrics: {
                    ofi: Math.max(-500, Math.min(500, currentMetrics.ofi + Math.floor((Math.random() - 0.5) * 50))),
                    toxicity: Math.min(100, Math.max(0, currentMetrics.toxicity + Math.floor((Math.random() - 0.5) * 5))),
                    zScore: Math.min(4, Math.max(-4, currentMetrics.zScore + (Math.random() - 0.5) * 0.1)),
                    heatmap: currentMetrics.heatmap.map(item => ({ ...item, zScore: item.zScore + (Math.random() - 0.5) * 0.2 })),
                    retailSentiment: Math.max(0, Math.min(100, (currentMetrics.retailSentiment || 50) + (Math.random() - 0.5) * 2))
                }
            });
        }, 1000);
        return () => clearInterval(intervalId);
    }
  }, [config.isBacktest]); // Dependencies correct, uses getState() internally

  // 6. Backtest Loop
  useEffect(() => {
      if (!config.isBacktest) {
          backtestStepRef.current = 0;
          return;
      }
      if (!BACKTEST_DATA || BACKTEST_DATA.length === 0) return;

      const intervalMs = 100 / config.playbackSpeed;
      const i = setInterval(() => {
          if (backtestStepRef.current >= BACKTEST_DATA.length) backtestStepRef.current = 0;
          const candle = BACKTEST_DATA[backtestStepRef.current];
          if (candle) {
              processWsTick({ 
                  t: typeof candle.time === 'number' ? candle.time * 1000 : 0, 
                  o: candle.open, h: candle.high, l: candle.low, c: candle.close, v: candle.volume, P: 0, 
                  V: (candle.volume * 0.6)
              });
              if (Math.random() > 0.5) {
                   processTradeTick({
                       id: Date.now().toString(),
                       price: candle.close,
                       size: Math.random(),
                       side: Math.random() > 0.5 ? 'BUY' : 'SELL',
                       time: Date.now(),
                       isWhale: false
                   });
              }
          }
          backtestStepRef.current++;
      }, intervalMs);
      return () => clearInterval(i);
  }, [config.isBacktest, config.playbackSpeed]);

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
                
                {/* Admin Control Panel */}
                <AdminControl />
                
                {/* Alert Engine (Background Service) */}
                <AlertEngine />

                <div className="flex-1 flex flex-col h-full overflow-hidden relative">
                    <Header />

                    <main className="flex-1 overflow-hidden p-0 lg:p-6 lg:pl-0 relative">
                        {config.isBacktest && (
                            <div className="absolute top-0 right-0 left-0 h-1 bg-amber-500 z-50 animate-pulse" />
                        )}
                        
                        {ui.activeTab === 'dashboard' && <DashboardView />}
                        {ui.activeTab === 'charting' && <ChartingView />}
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
