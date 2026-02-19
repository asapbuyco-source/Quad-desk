import { create } from 'zustand';
import { 
  MarketMetrics, CandleData, RecentTrade, OrderBookLevel, TradeSignal, PriceLevel, 
  AiScanResult, ToastMessage, Position, DailyStats, BiasMatrixState, 
  LiquidityState, RegimeState, AiTacticalState, ExpectedValueData, TimeframeData,
  BiasType
} from '../types';
import { MOCK_METRICS, API_BASE_URL } from '../constants';
import { analyzeRegime, calculateRSI, calculateBollingerBands, analyzeLiquidity } from '../utils/analytics';
import { auth, googleProvider, db } from '../lib/firebase';
import { 
  signInWithPopup, signInWithEmailAndPassword, createUserWithEmailAndPassword, 
  signOut, updateProfile, User 
} from 'firebase/auth';
import { doc, getDoc } from 'firebase/firestore';

interface AppState {
  ui: {
    activeTab: string;
    hasEntered: boolean;
    isProfileOpen: boolean;
  };
  config: {
    activeSymbol: string;
    interval: string;
    isBacktest: boolean;
    playbackSpeed: number;
    backtestDate: string;
    aiModel: string;
    telegramBotToken: string;
    telegramChatId: string;
  };
  market: {
    metrics: MarketMetrics;
    candles: CandleData[];
    asks: OrderBookLevel[];
    bids: OrderBookLevel[];
    recentTrades: RecentTrade[];
    signals: TradeSignal[];
    levels: PriceLevel[];
    expectedValue: ExpectedValueData | null;
  };
  ai: {
    scanResult: AiScanResult | undefined;
    isScanning: boolean;
    lastScanTime: number;
    cooldownRemaining: number;
    orderFlowAnalysis: {
        isLoading: boolean;
        verdict: string;
        confidence: number;
        explanation: string;
        flowType: string;
        timestamp: number;
    };
  };
  auth: {
    user: User | null;
    registrationOpen: boolean;
  };
  trading: {
    activePosition: Position | null;
    accountSize: number;
    riskPercent: number;
    dailyStats: DailyStats;
  };
  biasMatrix: BiasMatrixState;
  liquidity: LiquidityState;
  regime: RegimeState;
  aiTactical: AiTacticalState;
  notifications: ToastMessage[];
  alertLogs: any[];
  
  cvdBaseline: number;

  setHasEntered: (val: boolean) => void;
  setActiveTab: (tab: string) => void;
  setProfileOpen: (isOpen: boolean) => void;
  setSymbol: (symbol: string) => void;
  setInterval: (interval: string) => void;
  toggleBacktest: () => void;
  setPlaybackSpeed: (speed: number) => void;
  setBacktestDate: (date: string) => void;
  setAiModel: (model: string) => void;
  
  setMarketHistory: (payload: { candles: CandleData[], initialCVD: number }) => void;
  setMarketBands: (bands: any) => void;
  processWsTick: (tick: any, realDelta?: number) => void;
  processTradeTick: (trade: RecentTrade) => void;
  processDepthUpdate: (data: { asks: OrderBookLevel[], bids: OrderBookLevel[], metrics: any }) => void;
  refreshHeatmap: () => Promise<void>;
  resetCvd: () => void;
  
  startAiScan: () => void;
  completeAiScan: (result: AiScanResult) => void;
  updateAiCooldown: (seconds: number) => void;
  fetchOrderFlowAnalysis: (data: any) => Promise<void>;
  
  setUser: (user: User | null) => void;
  signInGoogle: () => Promise<void>;
  loginEmail: (e: string, p: string) => Promise<void>;
  registerEmail: (e: string, p: string, n: string) => Promise<void>;
  logout: () => Promise<void>;
  updateUserProfile: (data: any) => Promise<void>;
  loadUserPreferences: () => Promise<void>;
  toggleRegistration: (isOpen: boolean) => void;
  initSystemConfig: () => void;
  
  openPosition: (params: any) => void;
  closePosition: (price: number) => void;
  setRiskPercent: (pct: number) => void;
  
  refreshBiasMatrix: () => Promise<void>;
  refreshLiquidityAnalysis: () => void;
  refreshRegimeAnalysis: () => void;
  refreshTacticalAnalysis: () => void;
  
  addNotification: (toast: ToastMessage) => void;
  removeNotification: (id: string) => void;
  logAlert: (alert: any) => Promise<void>;
}

export const useStore = create<AppState>((set, get) => ({
  ui: {
    activeTab: 'dashboard',
    hasEntered: false,
    isProfileOpen: false,
  },
  config: {
    activeSymbol: 'BTCUSDT',
    interval: '1m',
    isBacktest: false,
    playbackSpeed: 1,
    backtestDate: new Date().toISOString().split('T')[0],
    aiModel: 'gemini-3-flash-preview',
    telegramBotToken: '',
    telegramChatId: '',
  },
  market: {
    metrics: MOCK_METRICS,
    candles: [],
    asks: [],
    bids: [],
    recentTrades: [],
    signals: [],
    levels: [],
    expectedValue: null,
  },
  ai: {
    scanResult: undefined,
    isScanning: false,
    lastScanTime: 0,
    cooldownRemaining: 0,
    orderFlowAnalysis: {
        isLoading: false,
        verdict: '',
        confidence: 0,
        explanation: '',
        flowType: '',
        timestamp: 0
    }
  },
  auth: {
    user: null,
    registrationOpen: true,
  },
  trading: {
    activePosition: null,
    accountSize: 10000,
    riskPercent: 1,
    dailyStats: {
        totalR: 0,
        realizedPnL: 0,
        wins: 0,
        losses: 0,
        tradesToday: 0,
        maxDrawdownR: 0
    }
  },
  biasMatrix: {
    symbol: 'BTCUSDT',
    daily: null,
    h4: null,
    h1: null,
    m5: null,
    lastUpdated: 0,
    isLoading: false,
  },
  liquidity: {
    sweeps: [],
    bos: [],
    fvg: [],
    lastUpdated: 0,
  },
  regime: {
    symbol: 'BTCUSDT',
    regimeType: 'UNCERTAIN',
    trendDirection: 'NEUTRAL',
    atr: 0,
    rangeSize: 0,
    volatilityPercentile: 0,
    lastUpdated: 0,
  },
  aiTactical: {
    symbol: 'BTCUSDT',
    probability: 50,
    scenario: 'NEUTRAL',
    entryLevel: 0,
    stopLevel: 0,
    exitLevel: 0,
    confidenceFactors: {
        biasAlignment: false,
        liquidityAgreement: false,
        regimeAgreement: false,
        aiScore: 0,
    },
    lastUpdated: 0,
  },
  notifications: [],
  alertLogs: [],
  cvdBaseline: 0,

  setHasEntered: (val) => set(state => ({ ui: { ...state.ui, hasEntered: val } })),
  setActiveTab: (tab) => set(state => ({ ui: { ...state.ui, activeTab: tab } })),
  setProfileOpen: (isOpen) => set(state => ({ ui: { ...state.ui, isProfileOpen: isOpen } })),
  setSymbol: (symbol) => set(state => ({ config: { ...state.config, activeSymbol: symbol } })),
  setInterval: (interval) => set(state => ({ config: { ...state.config, interval } })),
  toggleBacktest: () => set(state => ({ config: { ...state.config, isBacktest: !state.config.isBacktest } })),
  setPlaybackSpeed: (speed) => set(state => ({ config: { ...state.config, playbackSpeed: speed } })),
  setBacktestDate: (date) => set(state => ({ config: { ...state.config, backtestDate: date } })),
  setAiModel: (model) => set(state => ({ config: { ...state.config, aiModel: model } })),

  setMarketHistory: ({ candles, initialCVD }) => {
    // 1. Calculate Bands for History
    const bands = calculateBollingerBands(candles, 20);
    
    set(state => ({
        cvdBaseline: initialCVD,
        market: {
            ...state.market,
            candles: bands,
            metrics: { ...state.market.metrics, institutionalCVD: initialCVD }
        }
    }));
    get().refreshBiasMatrix();
  },

  setMarketBands: (_bands) => {},

  processWsTick: (tick, realDelta = 0) => set(state => {
    const candles = [...state.market.candles];
    if (candles.length === 0) return {};

    const last = candles[candles.length - 1];
    const tickTimeSec = Math.floor(tick.t / 1000);
    
    // Ignore out-of-order ticks
    if (tickTimeSec < last.time) return {};

    // Helper to calculate bands for a single candle context (simplified for performance)
    // For rigorous accuracy, we recalculate the last window.
    const updateBands = (list: CandleData[]) => {
        const windowSize = 20;
        if (list.length < windowSize) return list;
        
        // Only update the last candle's bands
        const subset = list.slice(-windowSize);
        const closes = subset.map(c => c.close);
        const mean = closes.reduce((a, b) => a + b, 0) / windowSize;
        const variance = closes.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / windowSize;
        const std = Math.sqrt(variance);
        
        const lastIdx = list.length - 1;
        list[lastIdx].zScoreUpper1 = mean + std;
        list[lastIdx].zScoreLower1 = mean - std;
        list[lastIdx].zScoreUpper2 = mean + (std * 2);
        list[lastIdx].zScoreLower2 = mean - (std * 2);
        
        return list;
    };

    let newCandles = candles;
    let newCvdBaseline = state.cvdBaseline;

    if (tickTimeSec === last.time) {
        // UPDATE CURRENT CANDLE
        const updatedCvd = state.cvdBaseline + realDelta;
        
        newCandles[newCandles.length - 1] = {
            ...last,
            close: tick.c,
            high: Math.max(last.high, tick.c),
            low: Math.min(last.low, tick.c),
            volume: tick.v,
            delta: realDelta,
            cvd: updatedCvd 
        };
        
        // Recalculate bands for the live candle
        newCandles = updateBands(newCandles);

    } else if (tickTimeSec > last.time) {
        // NEW CANDLE
        // 1. Commit the previous candle's delta to the baseline
        newCvdBaseline = state.cvdBaseline + (last.delta || 0);
        const newCvd = newCvdBaseline + realDelta;

        const newCandle: CandleData = {
            time: tickTimeSec,
            open: tick.o,
            high: tick.h,
            low: tick.l,
            close: tick.c,
            volume: tick.v,
            zScoreUpper1: last.zScoreUpper1, // inherit previous bands initially
            zScoreLower1: last.zScoreLower1,
            zScoreUpper2: last.zScoreUpper2,
            zScoreLower2: last.zScoreLower2,
            adx: last.adx, // ADX calculation is heavy, maybe do it less frequently or in separate loop
            cvd: newCvd,
            delta: realDelta
        };
        
        newCandles = [...candles.slice(1), newCandle]; // Keep fixed size roughly
        newCandles = updateBands(newCandles);
    }
    
    // --- CVD Divergence Analysis ---
    const window = newCandles.slice(-10);
    const firstPrice = window[0].close;
    const lastPrice = window[window.length-1].close;
    const firstCvd = window[0].cvd || 0;
    const lastCvd = window[window.length-1].cvd || 0;
    
    const priceDelta = lastPrice - firstPrice;
    const cvdDelta = lastCvd - firstCvd;

    let interpretation: any = 'NEUTRAL';
    let divergence: any = 'NONE';
    
    if (priceDelta > 0 && cvdDelta > 0) interpretation = 'REAL STRENGTH';
    else if (priceDelta < 0 && cvdDelta < 0) interpretation = 'REAL WEAKNESS';
    else if (priceDelta <= 0 && cvdDelta > 0) {
        interpretation = 'ABSORPTION';
        divergence = 'BULLISH_ABSORPTION';
    }
    else if (priceDelta >= 0 && cvdDelta < 0) {
        interpretation = 'DISTRIBUTION';
        divergence = 'BEARISH_DISTRIBUTION';
    }

    // Calc Z-Score for Metrics (Price deviation from Mean)
    const zScore = (tick.c - newCandles[newCandles.length-1].zScoreUpper1 + newCandles[newCandles.length-1].zScoreLower1) / 2; // Rough approx or use actual band diff

    return { 
        cvdBaseline: newCvdBaseline,
        market: { 
            ...state.market, 
            candles: newCandles,
            metrics: { 
                ...state.market.metrics, 
                price: tick.c, 
                zScore: (tick.c - ((newCandles[newCandles.length-1].zScoreUpper1 + newCandles[newCandles.length-1].zScoreLower1) / 2)) / ((newCandles[newCandles.length-1].zScoreUpper1 - newCandles[newCandles.length-1].zScoreLower1) / 2 || 1), // Real Z-Score
                institutionalCVD: newCandles[newCandles.length-1].cvd || 0,
                cvdContext: {
                    trend: cvdDelta > 0 ? 'UP' : 'DOWN',
                    divergence,
                    interpretation,
                    value: (cvdDelta / (tick.v || 1)) * 100
                }
            }
        } 
    };
  }),

  processTradeTick: (trade) => set(state => {
      const trades = [trade, ...state.market.recentTrades].slice(0, 50);
      return {
          market: { ...state.market, recentTrades: trades }
      };
  }),

  processDepthUpdate: ({ asks, bids }) => set(state => {
      const bidVol = bids.reduce((acc, b) => acc + b.size, 0);
      const askVol = asks.reduce((acc, a) => acc + a.size, 0);
      const totalVol = bidVol + askVol;
      const imbalance = totalVol > 0 ? ((bidVol - askVol) / totalVol) * 100 : 0;

      const allLevels = [...asks, ...bids];
      const meanSize = allLevels.length > 0 ? allLevels.reduce((acc, l) => acc + l.size, 0) / allLevels.length : 0;
      const threshold = meanSize * 2.5;

      const classify = (l: OrderBookLevel) => {
          if (l.size > threshold) return 'WALL';
          if (l.size < meanSize * 0.1) return 'HOLE';
          return 'NORMAL';
      };

      return {
          market: { 
              ...state.market, 
              asks: asks.map(a => ({ ...a, classification: classify(a) as any })), 
              bids: bids.map(b => ({ ...b, classification: classify(b) as any })),
              metrics: { ...state.market.metrics, ofi: imbalance }
          }
      };
  }),

  refreshHeatmap: async () => {
      try {
          const res = await fetch(`${API_BASE_URL}/heatmap`);
          if (res.ok) {
              const heatmap = await res.json();
              set(state => ({ market: { ...state.market, metrics: { ...state.market.metrics, heatmap } } }));
          }
      } catch (e) {
          console.warn("Heatmap fetch failed");
      }
  },

  resetCvd: () => set(state => ({
      cvdBaseline: 0,
      market: { ...state.market, metrics: { ...state.market.metrics, institutionalCVD: 0 } }
  })),

  startAiScan: () => set(state => ({ ai: { ...state.ai, isScanning: true } })),
  completeAiScan: (result) => set(state => ({ 
    ai: { 
        ...state.ai, 
        isScanning: false, 
        scanResult: result, 
        lastScanTime: Date.now(), 
        cooldownRemaining: 60 
    } 
  })),
  updateAiCooldown: (seconds) => set(state => ({ ai: { ...state.ai, cooldownRemaining: seconds } })),
  
  fetchOrderFlowAnalysis: async (payload) => {
      set(state => ({ ai: { ...state.ai, orderFlowAnalysis: { ...state.ai.orderFlowAnalysis, isLoading: true } } }));
      try {
          const res = await fetch(`${API_BASE_URL}/analyze/flow`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(payload)
          });
          if (res.ok) {
              const analysis = await res.json();
              set(state => ({ 
                  ai: { 
                      ...state.ai, 
                      orderFlowAnalysis: { 
                          isLoading: false, 
                          verdict: analysis.verdict, 
                          confidence: analysis.confidence, 
                          explanation: analysis.explanation, 
                          flowType: analysis.flow_type, 
                          timestamp: Date.now() 
                      } 
                  } 
              }));
          }
      } catch (e) {
          set(state => ({ ai: { ...state.ai, orderFlowAnalysis: { ...state.ai.orderFlowAnalysis, isLoading: false } } }));
      }
  },

  setUser: (user) => set(state => ({ auth: { ...state.auth, user } })),
  signInGoogle: async () => {
    try { await signInWithPopup(auth, googleProvider); } catch (e: any) {
        get().addNotification({ id: Date.now().toString(), type: 'error', title: 'Auth Failed', message: e.message });
    }
  },
  loginEmail: async (e, p) => { await signInWithEmailAndPassword(auth, e, p); },
  registerEmail: async (e, p, n) => {
    const res = await createUserWithEmailAndPassword(auth, e, p);
    if (res.user) { await updateProfile(res.user, { displayName: n }); }
  },
  logout: async () => { await signOut(auth); },
  updateUserProfile: async (data) => { set(state => ({ config: { ...state.config, ...data } })); },
  loadUserPreferences: async () => {
      try {
          const user = get().auth.user;
          if(user) {
              const snap = await getDoc(doc(db, 'users', user.uid));
              if(snap.exists()) set(s => ({ config: { ...s.config, ...snap.data().config } }));
          }
      } catch(e) {}
  },
  toggleRegistration: (isOpen) => set(state => ({ auth: { ...state.auth, registrationOpen: isOpen } })),
  initSystemConfig: () => {},

  openPosition: (params) => {
    const { entry, stop, target, direction } = params;
    const riskAmount = get().trading.accountSize * (get().trading.riskPercent / 100);
    const stopDistance = Math.abs(entry - stop);
    const size = stopDistance > 0 ? riskAmount / stopDistance : 0;
    
    set(state => ({ trading: { ...state.trading, activePosition: {
        id: Date.now().toString(),
        symbol: get().config.activeSymbol,
        direction, entry, stop, target, size, riskAmount,
        isOpen: true, openTime: Date.now(), floatingR: 0, unrealizedPnL: 0
    } } }));
  },
  closePosition: (price) => set(state => {
      const pos = state.trading.activePosition;
      if (!pos) return {};
      const pnl = pos.direction === 'LONG' ? (price - pos.entry) * pos.size : (pos.entry - price) * pos.size;
      const r = pnl / pos.riskAmount;
      const newStats = { ...state.trading.dailyStats };
      newStats.totalR += r;
      newStats.realizedPnL += pnl;
      if (r > 0) newStats.wins++; else newStats.losses++;
      newStats.tradesToday++;
      return {
          trading: { ...state.trading, activePosition: null, accountSize: state.trading.accountSize + pnl, dailyStats: newStats }
      };
  }),
  setRiskPercent: (pct) => set(state => ({ trading: { ...state.trading, riskPercent: pct } })),

  refreshBiasMatrix: async () => {
      set(state => ({ biasMatrix: { ...state.biasMatrix, isLoading: true } }));
      const candles = get().market.candles;
      
      const calculateBiasForWindow = (candleCount: number): TimeframeData => {
          if (candles.length < candleCount) {
              return { bias: 'NEUTRAL', sparkline: new Array(20).fill(50), lastUpdated: Date.now() };
          }
          const slice = candles.slice(-candleCount);
          const closes = slice.map(c => c.close);
          const rsi = calculateRSI(closes, 14);
          
          const sma = closes.length > 0 ? (closes.reduce((a, b) => a + b, 0) / closes.length) : 0;
          const current = closes.length > 0 ? (closes[closes.length - 1] ?? 0) : 0;
          
          let bias: BiasType = 'NEUTRAL';
          if (current > sma && rsi > 55) bias = 'BULL';
          else if (current < sma && rsi < 45) bias = 'BEAR';

          return { 
              bias, 
              sparkline: closes.slice(-20), 
              lastUpdated: Date.now() 
          };
      };

      set(state => {
          // Dynamic windows based on loaded history (assuming 1m interval for now as base)
          // M5 = 5 candles, H1 = 60, H4 = 240, Daily = ~1440 (clipped by max history)
          const updatedBiasMatrix: BiasMatrixState = {
              ...state.biasMatrix,
              isLoading: false,
              lastUpdated: Date.now(),
              m5: calculateBiasForWindow(5),
              h1: calculateBiasForWindow(60),
              h4: calculateBiasForWindow(240),
              daily: calculateBiasForWindow(Math.min(1440, candles.length)),
          };
          return { biasMatrix: updatedBiasMatrix };
      });
  },
  refreshLiquidityAnalysis: () => {
      // Execute actual liquidity analysis from utils
      const { candles } = get().market;
      const { sweeps, bos, fvg } = analyzeLiquidity(candles);
      set(state => ({ 
          liquidity: { 
              sweeps, 
              bos, 
              fvg, 
              lastUpdated: Date.now() 
          } 
      }));
  },
  refreshRegimeAnalysis: () => set(state => {
      const candles = state.market.candles;
      if (candles.length < 50) return {};
      const analysis = analyzeRegime(candles);
      return {
          regime: {
              ...state.regime,
              regimeType: analysis.type,
              trendDirection: analysis.trendDirection,
              atr: analysis.atr,
              rangeSize: analysis.rangeSize,
              volatilityPercentile: analysis.volatilityPercentile,
              lastUpdated: Date.now()
          },
          market: { ...state.market, metrics: { ...state.market.metrics, regime: analysis.type } }
      };
  }),
  refreshTacticalAnalysis: () => set(state => {
       const matrix = state.biasMatrix;
       const regimeType = state.regime.regimeType;
       const trendDir = state.regime.trendDirection;
       const ofi = state.market.metrics.ofi;
       
       let prob = 50;
       let scenario: 'BULLISH' | 'BEARISH' | 'NEUTRAL' = 'NEUTRAL';

       // Algorithmic Confluence Scoring
       let bullScore = 0;
       if (matrix.daily?.bias === 'BULL') bullScore += 10;
       if (matrix.h4?.bias === 'BULL') bullScore += 10;
       if (matrix.h1?.bias === 'BULL') bullScore += 10;
       if (regimeType === 'TRENDING' && trendDir === 'BULL') bullScore += 30;
       if (ofi > 20) bullScore += 20;
       if (state.liquidity.sweeps.length > 0 && state.liquidity.sweeps[0].side === 'SELL') bullScore += 20;

       let bearScore = 0;
       if (matrix.daily?.bias === 'BEAR') bearScore += 10;
       if (matrix.h4?.bias === 'BEAR') bearScore += 10;
       if (matrix.h1?.bias === 'BEAR') bearScore += 10;
       if (regimeType === 'TRENDING' && trendDir === 'BEAR') bearScore += 30;
       if (ofi < -20) bearScore += 20;
       if (state.liquidity.sweeps.length > 0 && state.liquidity.sweeps[0].side === 'BUY') bearScore += 20;

       if (bullScore > bearScore) {
           prob = 50 + (bullScore / 2);
           scenario = 'BULLISH';
       } else if (bearScore > bullScore) {
           prob = 50 + (bearScore / 2);
           scenario = 'BEARISH';
       }

       const currentPrice = state.market.metrics.price;
       const atr = state.regime.atr || currentPrice * 0.005;

       return {
           aiTactical: {
               ...state.aiTactical,
               symbol: state.config.activeSymbol,
               lastUpdated: Date.now(),
               probability: Math.min(prob, 95),
               scenario,
               entryLevel: currentPrice,
               stopLevel: scenario === 'BULLISH' ? currentPrice - (atr * 1.5) : currentPrice + (atr * 1.5),
               exitLevel: scenario === 'BULLISH' ? currentPrice + (atr * 3) : currentPrice - (atr * 3),
               confidenceFactors: { 
                   biasAlignment: bullScore > 20 || bearScore > 20,
                   liquidityAgreement: state.liquidity.sweeps.length > 0,
                   regimeAgreement: regimeType === 'TRENDING',
                   aiScore: Math.min(prob / 100, 1)
               }
           }
       };
  }),

  addNotification: (toast) => set(state => ({ notifications: [...state.notifications, toast] })),
  removeNotification: (id) => set(state => ({ notifications: state.notifications.filter(n => n.id !== id) })),
  logAlert: async (alert) => set(state => ({ alertLogs: [alert, ...state.alertLogs].slice(0, 50) }))
}));