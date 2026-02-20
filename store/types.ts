import { 
  MarketMetrics, CandleData, RecentTrade, OrderBookLevel, TradeSignal, PriceLevel, 
  AiScanResult, ToastMessage, Position, DailyStats, BiasMatrixState, 
  LiquidityState, RegimeState, AiTacticalState
} from '../types';
import { User } from 'firebase/auth';

export interface AppState {
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
    expectedValue: any; // ExpectedValueData | null
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
