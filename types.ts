

export type LiquidityType = 'WALL' | 'HOLE' | 'CLUSTER' | 'NORMAL';
export type PeriodType = '20-DAY' | '20-HOUR' | '20-PERIOD';

// Unified Regime Types
export type MarketRegimeType = "TRENDING" | "RANGING" | "MEAN_REVERTING" | "EXPANDING" | "COMPRESSING" | "HIGH_VOLATILITY" | "UNCERTAIN";
export type RegimeType = MarketRegimeType;

export interface OrderBookLevel {
  price: number;
  size: number;
  total: number;
  delta?: number; // Change in size since last tick
  classification?: LiquidityType;
  isLiquidityWall?: boolean; // Legacy support
}

export interface RecentTrade {
  id: string;
  price: number;
  size: number;
  side: 'BUY' | 'SELL';
  time: number;
  isWhale: boolean;
}

export interface CandleData {
  time: number; // Changed from string | number to number for type safety
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  zScoreUpper1: number; // +1.0 sigma
  zScoreLower1: number; // -1.0 sigma
  zScoreUpper2: number; // +2.0 sigma
  zScoreLower2: number; // -2.0 sigma
  adx?: number; // Average Directional Index
  delta?: number; // Net Buy - Sell Volume for this candle
  cvd?: number; // Cumulative Volume Delta running total
}

export interface CalculationVariable {
  label: string;
  value: string | number;
  unit?: string;
  description: string;
}

export interface CalculationDetails {
  formula: string;
  variables: CalculationVariable[];
  explanation: string;
  thresholds: {
    pass: string;
    warning: string;
    fail: string;
  };
}

export interface SentinelChecklist {
  id: string;
  label: string;
  status: 'pass' | 'fail' | 'warning';
  value: string;
  details?: CalculationDetails; // Enhanced details object
  requiredRegime?: RegimeType[]; // New: strategies valid only in specific regimes
}

export interface HeatmapItem {
  pair: string;
  zScore: number;
  price: number;
}

export interface ExpectedValueData {
  ev: number; // Actual expected value in price units
  rrRatio: number; // Risk:Reward ratio
  winProbability: number;
  winAmount: number;
  lossAmount: number;
}

export interface MarketMetrics {
  pair: string;
  price: number;
  change: number;
  session: string;
  safetyStatus: string;
  regime: RegimeType; // Updated to strict type
  retailSentiment: number; // 0-100 (Long %)
  institutionalCVD: number; // Normalized -100 to 100
  zScore: number;
  toxicity: number; // 0-100 (VPIN)
  ofi: number;
  heatmap: HeatmapItem[];
  dailyPnL?: number;
  circuitBreakerTripped?: boolean;
  cvdContext?: {
    trend: 'UP' | 'DOWN' | 'FLAT';
    divergence: 'NONE' | 'BULLISH_ABSORPTION' | 'BEARISH_DISTRIBUTION';
    interpretation: 'REAL STRENGTH' | 'REAL WEAKNESS' | 'ABSORPTION' | 'DISTRIBUTION' | 'NEUTRAL';
    value: number;
  };
  // Advanced Analytics
  bayesianPosterior?: number; // 0-1 probability
  skewness?: number; // -3 to +3 typically
  kurtosis?: number; // Excess kurtosis
}

export interface NewsItem {
  id: string;
  source: string;
  title: string;
  time: string;
  impact: 'high' | 'medium' | 'low';
  sentiment: 'bullish' | 'bearish' | 'neutral';
  summary: string;
}

export interface TradeSignal {
  id: string;
  type: 'ENTRY_LONG' | 'ENTRY_SHORT' | 'EXIT_PROFIT' | 'EXIT_LOSS';
  price: number;
  time: string | number; // Match CandleData time
  label: string;
}

export interface PriceLevel {
  price: number;
  type: 'SUPPORT' | 'RESISTANCE' | 'ENTRY' | 'STOP_LOSS' | 'TAKE_PROFIT' | 'TACTICAL_ENTRY' | 'TACTICAL_STOP' | 'TACTICAL_TARGET';
  label: string;
}

export interface AiScanResult {
  support: number[];
  resistance: number[];
  decision_price: number;
  verdict: 'ENTRY' | 'EXIT' | 'WAIT';
  confidence?: number; // Added to match backend
  analysis: string;
  risk_reward_ratio?: number;
  entry_price?: number;
  stop_loss?: number;
  take_profit?: number;
  isSimulated?: boolean; // New Flag
}

export interface AiAnalysis {
  signal: 'BUY' | 'SELL' | 'WAIT';
  confidence: number;
  reason: string;
  entry?: number;
  stop_loss?: number;
  take_profit?: number;
  metrics?: {
    z_score: number;
    vpin: number;
  }
}

export interface ToastMessage {
  id: string;
  type: 'success' | 'error' | 'info' | 'warning';
  title: string;
  message: string;
}

// --- Position & Risk Engine Types ---

export interface Position {
  id: string;
  symbol: string;
  direction: "LONG" | "SHORT";
  entry: number;
  stop: number;
  target: number;
  size: number; // Position size in units (e.g., BTC amount)
  riskAmount: number; // Dollar amount risked
  isOpen: boolean;
  openTime: number;

  // Dynamic State
  floatingR: number;
  unrealizedPnL: number;
}

export interface ClosedTrade extends Omit<Position, 'floatingR' | 'unrealizedPnL'> {
  closeTime: number;
  exitPrice: number;
  resultR: number;
  realizedPnL: number;
}

export interface DailyStats {
  totalR: number;
  realizedPnL: number;
  wins: number;
  losses: number;
  tradesToday: number;
  maxDrawdownR: number;
}

// --- Bias Matrix Types ---

export type BiasType = "BULL" | "BEAR" | "NEUTRAL";

export interface TimeframeData {
  bias: BiasType;
  sparkline: number[]; // Last 20 closes
  lastUpdated: number;
}

export interface BiasMatrixState {
  symbol: string;
  daily: TimeframeData | null;
  h4: TimeframeData | null;
  h1: TimeframeData | null;
  m5: TimeframeData | null;
  lastUpdated: number;
  isLoading: boolean;
}

// --- Liquidity Events Types ---

export interface SweepEvent {
  id: string;
  price: number;
  side: "BUY" | "SELL"; // BUY side liquidity swept (Highs taken) -> Bearish Indication
  timestamp: number;
  candleTime: number | string;
}

export interface BreakOfStructure {
  id: string;
  price: number;
  direction: "BULLISH" | "BEARISH";
  timestamp: number;
  candleTime: number | string;
}

export interface FairValueGap {
  id: string;
  startPrice: number;
  endPrice: number;
  direction: "BULLISH" | "BEARISH";
  resolved: boolean;
  timestamp: number;
  candleTime: number | string;
}

export interface LiquidityState {
  sweeps: SweepEvent[];
  bos: BreakOfStructure[];
  fvg: FairValueGap[];
  lastUpdated: number;
}

// --- Regime Types ---

export interface RegimeState {
  symbol: string;
  regimeType: MarketRegimeType;
  trendDirection: "BULL" | "BEAR" | "NEUTRAL";
  atr: number;
  rangeSize: number;
  volatilityPercentile: number;
  lastUpdated: number;
}

// --- AI Tactical Types ---

export interface AiTacticalState {
  symbol: string;
  probability: number;  // 0-100%
  scenario: "BULLISH" | "BEARISH" | "NEUTRAL";
  entryLevel: number;
  exitLevel: number;
  stopLevel: number;
  confidenceFactors: {
    biasAlignment: boolean;
    liquidityAgreement: boolean;
    regimeAgreement: boolean;
    aiScore: number; // 0-1
  };
  lastUpdated: number;
}

// --- Admin System Types ---

export interface LogEntry {
  timestamp: string;
  level: string;
  message: string;
  module: string;
}

export interface SystemHealth {
  status: string;
  uptime: string;
  cpu_percent: number;
  memory_mb: number;
  threads: number;
  autonomous_active: boolean;
  logs: LogEntry[];
}