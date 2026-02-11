
export type LiquidityType = 'WALL' | 'HOLE' | 'CLUSTER' | 'NORMAL';
export type RegimeType = 'TRENDING' | 'MEAN_REVERTING' | 'HIGH_VOLATILITY';

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
  time: string | number;
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
  type: 'SUPPORT' | 'RESISTANCE' | 'ENTRY' | 'STOP_LOSS' | 'TAKE_PROFIT';
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