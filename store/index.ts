import { create } from 'zustand';
import { 
  MarketMetrics, CandleData, RecentTrade, OrderBookLevel, TradeSignal, PriceLevel, 
  AiScanResult, ToastMessage, Position, DailyStats, BiasMatrixState, 
  LiquidityState, RegimeState, AiTacticalState, ExpectedValueData, TimeframeData
} from '../types';
import { MOCK_METRICS } from '../constants';
import { analyzeRegime, calculateRSI } from '../utils/analytics';
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
  
  // CVD State
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
    set(state => ({
        cvdBaseline: initialCVD,
        market: {
            ...state.market,
            candles,
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
    let newCandles = candles;
    
    // Binance 't' is start time in ms. System expects time in seconds.
    const tickTimeSec = Math.floor(tick.t / 1000);
    
    if (tickTimeSec === last.time) {
        // Update current candle
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
    } else if (tickTimeSec > last.time) {
        // New candle started
        // Baseline for next candle includes the final delta of the closed one
        const updatedBaseline = state.cvdBaseline + (last.delta || 0);
        const newCvd = updatedBaseline + realDelta;

        const newCandle: CandleData = {
            time: tickTimeSec,
            open: tick.o,
            high: tick.h,
            low: tick.l,
            close: tick.c,
            volume: tick.v,
            zScoreUpper1: last.zScoreUpper1, // Indicators will be recalculated in analysis loop
            zScoreLower1: last.zScoreLower1,
            zScoreUpper2: last.zScoreUpper2,
            zScoreLower2: last.zScoreLower2,
            adx: last.adx,
            cvd: newCvd,
            delta: realDelta
        };
        newCandles = [...candles.slice(1), newCandle];
        
        return { 
            cvdBaseline: updatedBaseline,
            market: { 
                ...state.market, 
                candles: newCandles,
                metrics: { ...state.market.metrics, price: tick.c, institutionalCVD: newCvd }
            } 
        };
    }
    
    return { 
        market: { 
            ...state.market, 
            candles: newCandles,
            metrics: { ...state.market.metrics, price: tick.c, institutionalCVD: state.cvdBaseline + realDelta }
        } 
    };
  }),

  processTradeTick: (trade) => set(state => {
      const trades = [trade, ...state.market.recentTrades].slice(0, 50);
      return {
          market: { ...state.market, recentTrades: trades }
      };
  }),

  processDepthUpdate: ({ asks, bids }) => set(state => ({
      market: { ...state.market, asks, bids }
  })),

  refreshHeatmap: async () => {
      const mockHeatmap = [
          { pair: 'ETH/USDT', zScore: 1.2, price: 3200 },
          { pair: 'SOL/USDT', zScore: -2.1, price: 145 },
          { pair: 'BNB/USDT', zScore: 0.5, price: 590 },
      ];
      set(state => ({ market: { ...state.market, metrics: { ...state.market.metrics, heatmap: mockHeatmap } } }));
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
  fetchOrderFlowAnalysis: async (_data) => {
      set(state => ({ ai: { ...state.ai, orderFlowAnalysis: { ...state.ai.orderFlowAnalysis, isLoading: true } } }));
      setTimeout(() => {
          set(state => ({ 
              ai: { 
                  ...state.ai, 
                  orderFlowAnalysis: { 
                      isLoading: false, 
                      verdict: 'BULLISH', 
                      confidence: 0.85, 
                      explanation: 'Strong aggressive buying absorbed by passive sellers, leading to a breakout.', 
                      flowType: 'ABSORPTION', 
                      timestamp: Date.now() 
                  } 
              } 
          }));
      }, 2000);
  },

  setUser: (user) => set(state => ({ auth: { ...state.auth, user } })),
  signInGoogle: async () => {
    try {
        await signInWithPopup(auth, googleProvider);
    } catch (e: any) {
        console.error(e);
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
    const size = (get().trading.accountSize * (get().trading.riskPercent / 100)) / Math.abs(entry - stop);
    const newPos: Position = {
        id: Date.now().toString(),
        symbol: get().config.activeSymbol,
        direction,
        entry,
        stop,
        target,
        size,
        riskAmount: get().trading.accountSize * (get().trading.riskPercent / 100),
        isOpen: true,
        openTime: Date.now(),
        floatingR: 0,
        unrealizedPnL: 0
    };
    set(state => ({ trading: { ...state.trading, activePosition: newPos } }));
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
          trading: {
              ...state.trading,
              activePosition: null,
              accountSize: state.trading.accountSize + pnl,
              dailyStats: newStats
          }
      };
  }),
  setRiskPercent: (pct) => set(state => ({ trading: { ...state.trading, riskPercent: pct } })),

  refreshBiasMatrix: async () => {
      set(state => ({ biasMatrix: { ...state.biasMatrix, isLoading: true } }));
      const candles = get().market.candles;
      
      const calculateBiasForWindow = (windowSize: number): TimeframeData => {
          if (candles.length < windowSize) return { bias: 'NEUTRAL', sparkline: [50, 50, 50], lastUpdated: Date.now() };
          const slice = candles.slice(-windowSize);
          const closes = slice.map(c => c.close);
          const sma = closes.reduce((a, b) => a + b, 0) / windowSize;
          const current = closes[closes.length - 1];
          const rsi = calculateRSI(closes, Math.min(14, windowSize - 1));
          
          let bias: 'BULL' | 'BEAR' | 'NEUTRAL' = 'NEUTRAL';
          if (current > sma * 1.002 && rsi > 55) bias = 'BULL';
          else if (current < sma * 0.998 && rsi < 45) bias = 'BEAR';

          return { bias, sparkline: closes.slice(-20), lastUpdated: Date.now() };
      };

      set(state => ({
          biasMatrix: {
              ...state.biasMatrix,
              isLoading: false,
              lastUpdated: Date.now(),
              daily: calculateBiasForWindow(60),
              h4: calculateBiasForWindow(45),
              h1: calculateBiasForWindow(30),
              m5: calculateBiasForWindow(15),
          }
      }));
  },
  refreshLiquidityAnalysis: () => {
      set(state => ({ liquidity: { ...state.liquidity, lastUpdated: Date.now() } }));
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
  refreshTacticalAnalysis: () => {
       set(state => ({
           aiTactical: {
               ...state.aiTactical,
               lastUpdated: Date.now(),
               probability: 65,
               scenario: 'BULLISH',
               confidenceFactors: { ...state.aiTactical.confidenceFactors, aiScore: 0.8 }
           }
       }));
  },

  addNotification: (toast) => set(state => ({ notifications: [...state.notifications, toast] })),
  removeNotification: (id) => set(state => ({ notifications: state.notifications.filter(n => n.id !== id) })),
  logAlert: async (alert) => set(state => ({ alertLogs: [alert, ...state.alertLogs].slice(0, 50) }))
}));