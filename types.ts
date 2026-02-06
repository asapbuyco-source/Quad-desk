export interface OrderBookLevel {
  price: number;
  size: number;
  total: number;
  isLiquidityWall?: boolean; // Legacy, we will calculate dynamic magnets now
}

export interface CandleData {
  time: string | number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  zScoreUpper1: number; // +1.5 sigma
  zScoreLower1: number; // -1.5 sigma
  zScoreUpper2: number; // +2.5 sigma
  zScoreLower2: number; // -2.5 sigma
  adx?: number; // Average Directional Index
}

export interface SentinelChecklist {
  id: string;
  label: string;
  status: 'pass' | 'fail' | 'warning';
  value: string;
}

export interface HeatmapItem {
  pair: string;
  zScore: number;
  price: number;
}

export interface MarketMetrics {
  pair: string;
  price: number;
  change: number;
  session: string;
  safetyStatus: string;
  regime: string;
  retailSentiment: number; // 0-100 (Long %)
  institutionalCVD: number; // Normalized -100 to 100
  zScore: number;
  toxicity: number; // 0-100
  ofi: number;
  heatmap: HeatmapItem[];
  dailyPnL?: number;
  circuitBreakerTripped?: boolean;
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
  analysis: string;
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