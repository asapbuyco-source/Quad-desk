import { CandleData, OrderBookLevel, SentinelChecklist, MarketMetrics, NewsItem, TradeSignal, PriceLevel } from './types';

export const APP_NAME = "QUANT DESK";
// Use Vite's import.meta.env for production builds, fallback to localhost for dev
export const API_BASE_URL = (import.meta as any).env?.VITE_API_URL || "http://localhost:8000";

export const MOCK_METRICS: MarketMetrics = {
  pair: "XAU/USD",
  price: 2342.50,
  change: -1.24,
  session: "PRE-LONDON",
  safetyStatus: "CB: ACTIVE",
  regime: "FAT-TAIL",
  retailSentiment: 78,
  institutionalCVD: 65, // Positive means buying
  zScore: -2.6,
  toxicity: 92,
  ofi: 450,
  heatmap: [
    { pair: "XAU/USD", zScore: -2.6, price: 2342.50 },
    { pair: "AUD/JPY", zScore: 0.4, price: 98.20 },
    { pair: "EUR/USD", zScore: 2.1, price: 1.0850 },
  ]
};

export const CHECKLIST_ITEMS: SentinelChecklist[] = [
  { 
      id: '1', 
      label: 'Dislocation (Z-Score)', 
      status: 'pass', 
      value: '-2.6σ',
      details: {
          formula: "Z = (P - μ) / σ",
          explanation: "The Z-Score measures how many standard deviations the current price (P) is from the mean (μ). A score beyond ±2.0 indicates a statistically significant deviation, suggesting potential mean reversion.",
          variables: [
              { label: "P (Price)", value: "2342.50", unit: "USD", description: "Current execution price" },
              { label: "μ (VWAP)", value: "2358.10", unit: "USD", description: "Volume Weighted Average Price (Session)" },
              { label: "σ (Std Dev)", value: "6.0", unit: "USD", description: "Volatility of the last 20 periods" }
          ],
          thresholds: {
              pass: "|Z| > 2.0 (Significant Dislocation)",
              warning: "1.5 < |Z| < 2.0 (Developing)",
              fail: "|Z| < 1.5 (Noise / Range Bound)"
          }
      }
  },
  { 
      id: '2', 
      label: 'Bayesian Posterior', 
      status: 'warning', 
      value: '0.42',
      details: {
          formula: "P(A|B) = [P(B|A) * P(A)] / P(B)",
          explanation: "Updates the probability of a 'Trend Continuation' (Hypothesis A) given new 'Order Flow Data' (Evidence B). A low value suggests the prior thesis is degrading.",
          variables: [
              { label: "P(A) Prior", value: "0.65", unit: "", description: "Initial belief in trend continuation" },
              { label: "P(B|A) Likelihood", value: "0.30", unit: "", description: "Prob. of seeing this order flow if trend was strong" },
              { label: "P(B) Evidence", value: "0.46", unit: "", description: "Total probability of observed order flow" }
          ],
          thresholds: {
              pass: "P(A|B) > 0.60",
              warning: "0.40 < P(A|B) < 0.60",
              fail: "P(A|B) < 0.40"
          }
      }
  },
  { 
      id: '3', 
      label: 'Sentiment Washout', 
      status: 'fail', 
      value: '78% Long',
      details: {
          formula: "S = L / (L + S)",
          explanation: "Contrarian indicator measuring the percentage of retail traders positioned Long. Extreme readings (>70% or <30%) often precede liquidity flushes in the opposite direction.",
          variables: [
              { label: "L (Longs)", value: "15,420", unit: "Lots", description: "Retail Open Interest (Long)" },
              { label: "S (Shorts)", value: "4,350", unit: "Lots", description: "Retail Open Interest (Short)" },
              { label: "Total OI", value: "19,770", unit: "Lots", description: "Total Market Participation" }
          ],
          thresholds: {
              pass: "S < 30% (Oversold) or S > 70% (Overbought)",
              warning: "30% < S < 40% or 60% < S < 70%",
              fail: "40% < S < 60% (Neutral/No Edge)"
          }
      }
  },
  { 
      id: '4', 
      label: 'Skewness Audit', 
      status: 'pass', 
      value: 'Valid',
      details: {
          formula: "γ = E[(X - μ)/σ]^3",
          explanation: "Measures the asymmetry of the return distribution. Negative skew implies frequent small gains but rare, large losses (Tail Risk). We strictly filter for positive or neutral skew.",
          variables: [
              { label: "Moment 3", value: "0.12", unit: "", description: "Third standardized moment" },
              { label: "Kurtosis", value: "3.4", unit: "", description: "Fat-tailedness of distribution" }
          ],
          thresholds: {
              pass: "γ > -0.5",
              warning: "-1.0 < γ < -0.5",
              fail: "γ < -1.0 (High Tail Risk)"
          }
      }
  },
  { 
      id: '5', 
      label: 'E[X] Math (2.5:1)', 
      status: 'fail', 
      value: '0.8:1',
      details: {
          formula: "E[X] = (P_win * $Win) - (P_loss * $Loss)",
          explanation: "Expected Value (Expectancy) of the trade setup. We require a Risk:Reward ratio where the potential upside significantly outweighs the downside, adjusted for probability.",
          variables: [
              { label: "P_win", value: "0.45", unit: "%", description: "Estimated Win Probability" },
              { label: "$Win (Target)", value: "$200", unit: "USD", description: "Distance to Take Profit" },
              { label: "$Loss (Stop)", value: "$250", unit: "USD", description: "Distance to Stop Loss" }
          ],
          thresholds: {
              pass: "E[X] > 2.0 R",
              warning: "1.5 R < E[X] < 2.0 R",
              fail: "E[X] < 1.5 R"
          }
      }
  },
];

export const MOCK_NEWS: NewsItem[] = [
  { 
    id: '1', 
    source: 'BLOOMBERG', 
    title: 'Goldman sees "Tactical Upside" in Gold as real rates plateau.', 
    time: '2m ago', 
    impact: 'high', 
    sentiment: 'bullish',
    summary: "Goldman Sachs commodities desk has issued a 'Tactical Buy' note for Gold (XAU/USD) targeting $2,400 by quarter-end. The rationale hinges on the plateauing of 10-year real yields and renewed central bank purchasing from emerging markets. Their proprietary flows indicate smart money accumulation has begun despite retail capitulation."
  },
  { 
    id: '2', 
    source: 'REUTERS', 
    title: 'Central Bank purchases hit 3-month low.', 
    time: '14m ago', 
    impact: 'medium', 
    sentiment: 'bearish',
    summary: "Official Gold reserves data shows a net slowdown in purchasing from the PBoC for the third consecutive month. While long-term accumulation trends remain intact, this short-term pause has removed a key support floor for spot prices in the Asian session, potentially exposing the $2,300 level to test."
  },
  { 
    id: '3', 
    source: 'SENTINEL AI', 
    title: 'Gamma exposure flipped negative at 2340.', 
    time: '22m ago', 
    impact: 'high', 
    sentiment: 'bearish',
    summary: "Options market structure analysis reveals a flip to negative gamma below 2340. Market makers will now be forced to sell into weakness to hedge their books, likely exacerbating volatility and accelerating downside moves if the support level is breached. Volatility targeting funds are expected to de-leverage."
  },
  { 
    id: '4', 
    source: 'ZERO HEDGE', 
    title: 'Liquidity drain in T-Bill issuance causing dollar spike.', 
    time: '45m ago', 
    impact: 'medium', 
    sentiment: 'neutral',
    summary: "The US Treasury's latest massive T-Bill issuance is draining dollar liquidity from the interbank market, causing a spike in the DXY. While not directly correlated to gold's fundamentals, the stronger dollar is acting as a mechanical headwind for all dollar-denominated commodities in the short term."
  },
  { 
    id: '5', 
    source: 'FX STREET', 
    title: 'Technical breakdown below 2350 support level confirmed.', 
    time: '1h ago', 
    impact: 'low', 
    sentiment: 'bearish',
    summary: "XAU/USD has closed a 4-hour candle below the critical 2350 pivot, confirming a bearish breakout from the week-long consolidation pattern. Technical indicators (RSI, MACD) are trending lower with room to run before reaching oversold territory. Next major support lies at the 50-day moving average."
  },
];

// Generate synthetic candle data
const generateCandles = (count: number): CandleData[] => {
  const data: CandleData[] = [];
  let price = 2360.00;
  for (let i = 0; i < count; i++) {
    const volatility = Math.random() * 5;
    const change = (Math.random() - 0.55) * volatility; // Slight downward trend
    const open = price;
    const close = price + change;
    const high = Math.max(open, close) + Math.random() * 2;
    const low = Math.min(open, close) - Math.random() * 2;
    
    // Mean reversion bands logic
    const mean = 2365 - (i * 0.05); 
    const stdDev = 8;

    data.push({
      time: `${10 + Math.floor(i/60)}:${(i%60).toString().padStart(2, '0')}`,
      open,
      high,
      low,
      close,
      volume: Math.floor(Math.random() * 1000) + 200,
      zScoreUpper1: mean + (1.5 * stdDev),
      zScoreLower1: mean - (1.5 * stdDev),
      zScoreUpper2: mean + (2.5 * stdDev),
      zScoreLower2: mean - (2.5 * stdDev),
    });
    price = close;
  }
  return data;
};

export const MOCK_CANDLES = generateCandles(60);

export const MOCK_SIGNALS: TradeSignal[] = [
    { id: '1', type: 'ENTRY_SHORT', price: 2358.50, time: '10:05', label: 'AI SHORT' },
    { id: '2', type: 'EXIT_PROFIT', price: 2345.20, time: '10:45', label: 'TP HIT' },
];

export const MOCK_LEVELS: PriceLevel[] = [
    { price: 2365.00, type: 'RESISTANCE', label: 'Daily High' },
    { price: 2335.00, type: 'SUPPORT', label: 'Liquidity Pool' },
];

export const MOCK_ASKS: OrderBookLevel[] = [
  { price: 2344.50, size: 12, total: 12 },
  { price: 2344.25, size: 45, total: 57 },
  { price: 2344.00, size: 88, total: 145 },
  { price: 2343.75, size: 150, total: 295 },
  { price: 2343.50, size: 320, total: 615 },
  { price: 2343.25, size: 45, total: 660 },
  { price: 2343.00, size: 22, total: 682 },
  { price: 2342.75, size: 10, total: 692 },
  { price: 2342.50, size: 5, total: 697 },
];

export const MOCK_BIDS: OrderBookLevel[] = [
  { price: 2342.25, size: 8, total: 8 },
  { price: 2342.00, size: 35, total: 43 },
  { price: 2341.75, size: 110, total: 153 },
  { price: 2341.50, size: 145, total: 298 },
  { price: 2341.25, size: 210, total: 508 },
  { price: 2341.00, size: 65, total: 573 },
  { price: 2340.50, size: 80, total: 653 },
  { price: 2340.00, size: 500, total: 1153, isLiquidityWall: true },
  { price: 2339.50, size: 120, total: 1273 },
  { price: 2339.00, size: 340, total: 1613 },
];