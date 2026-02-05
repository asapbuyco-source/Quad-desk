export interface OrderBookLevel {
  price: number;
  size: number;
  total: number;
  isLiquidityWall?: boolean;
}

export interface CandleData {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  zScoreUpper1: number; // +1.5 sigma
  zScoreLower1: number; // -1.5 sigma
  zScoreUpper2: number; // +2.5 sigma
  zScoreLower2: number; // -2.5 sigma
}

export interface SentinelChecklist {
  id: string;
  label: string;
  status: 'pass' | 'fail' | 'warning';
  value: string;
}

export interface MarketMetrics {
  pair: string;
  price: number;
  change: number;
  session: string;
  safetyStatus: string;
  regime: string;
  retailSentiment: number; // 0-100 (Long %)
  zScore: number;
  toxicity: number; // 0-100
  ofi: number;
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
  time: string; // Should match a candle time
  label: string;
}

export interface PriceLevel {
  price: number;
  type: 'SUPPORT' | 'RESISTANCE';
  label: string;
}