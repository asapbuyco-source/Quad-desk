
import { CandleData, OrderBookLevel, SentinelChecklist, MarketMetrics, NewsItem, TradeSignal, PriceLevel } from './types';

export const APP_NAME = "QUANT DESK";

// Backend API URL
// Logic: Check LocalStorage -> Check Env Var -> Check Localhost -> Fallback to Production
const getApiUrl = () => {
    let url = 'https://quant-desk-backend-production.up.railway.app'; // Default Production
    
    if (typeof window !== 'undefined') {
        const stored = localStorage.getItem('VITE_API_URL');
        
        // 1. Priority: Local Storage Override
        if (stored && stored.startsWith('http')) {
            url = stored;
        } 
        // 2. Priority: Environment Variable
        else if ((import.meta as any).env?.VITE_API_URL) {
            url = (import.meta as any).env.VITE_API_URL;
        } 
        // 3. Priority: Localhost Auto-Detect (Fixes 502s locally)
        else if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
             url = 'http://localhost:8000'; 
        }
    }
    
    // Strip trailing slash if present
    return url.replace(/\/$/, "");
};

export const API_BASE_URL = getApiUrl();

console.log('🔗 API Base URL:', API_BASE_URL);

// INITIAL DEFAULT STATE - All values are 0/Neutral until live data flows in.
export const MOCK_METRICS: MarketMetrics = {
  pair: "BTC/USDT",
  price: 0,
  change: 0,
  session: "GLOBAL",
  safetyStatus: "INITIALIZING",
  regime: "MEAN_REVERTING",
  retailSentiment: 50, // Neutral 50%
  institutionalCVD: 0, // Neutral
  zScore: 0,
  toxicity: 0,
  ofi: 0,
  heatmap: [],
  bayesianPosterior: 0.5,
  skewness: 0,
  kurtosis: 0
};

export const CHECKLIST_ITEMS: SentinelChecklist[] = [
  { 
      id: '1', 
      label: 'Dislocation (Z-Score)', 
      status: 'warning', 
      value: 'WAIT',
      requiredRegime: ['MEAN_REVERTING', 'HIGH_VOLATILITY'], 
      details: {
          formula: "Z = (P - μ) / σ",
          explanation: "The Z-Score measures how many standard deviations the current price (P) is from the mean (μ). A score beyond ±2.0 indicates a statistically significant deviation.",
          variables: [
              { label: "P (Price)", value: "--", unit: "USD", description: "Current execution price" },
              { label: "μ (VWAP)", value: "--", unit: "USD", description: "Volume Weighted Average Price" },
              { label: "σ (Std Dev)", value: "--", unit: "USD", description: "Volatility of the last 20 periods" }
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
      value: 'WAIT',
      requiredRegime: ['TRENDING'], 
      details: {
          formula: "P(A|B) = [P(B|A) * P(A)] / P(B)",
          explanation: "Updates the probability of a 'Trend Continuation' (Hypothesis A) given new 'Order Flow Data' (Evidence B).",
          variables: [
              { label: "P(A) Prior", value: "0.50", unit: "", description: "Initial belief" },
              { label: "Trend Strength", value: "--", unit: "", description: "Momentum Factor" },
              { label: "Volume Conf", value: "--", unit: "", description: "Volume Confirmation" }
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
      status: 'warning', 
      value: 'WAIT',
      details: {
          formula: "RSI(14) Proxy",
          explanation: "Uses Relative Strength Index (RSI) as a proxy for retail sentiment. Extreme readings (>70% or <30%) often precede liquidity flushes.",
          variables: [
              { label: "RSI", value: "--", unit: "", description: "Momentum Oscillator" },
              { label: "Bias", value: "--", unit: "", description: "Directional Bias" },
              { label: "State", value: "Neutral", unit: "", description: "Market State" }
          ],
          thresholds: {
              pass: "RSI < 30 (Oversold) or RSI > 70 (Overbought)",
              warning: "30 < RSI < 40 or 60 < RSI < 70",
              fail: "40 < RSI < 60 (Neutral/No Edge)"
          }
      }
  },
  { 
      id: '4', 
      label: 'Skewness Audit', 
      status: 'warning', 
      value: 'WAIT',
      requiredRegime: ['HIGH_VOLATILITY', 'TRENDING'], 
      details: {
          formula: "γ = E[(X - μ)/σ]^3",
          explanation: "Measures the asymmetry of the return distribution. Negative skew implies frequent small gains but rare, large losses (Tail Risk).",
          variables: [
              { label: "Returns", value: "30", unit: "periods", description: "Sample Size" },
              { label: "Kurtosis", value: "--", unit: "", description: "Fat-tailedness" }
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
      status: 'warning', 
      value: 'WAIT',
      details: {
          formula: "E[X] = (P_win * $Win) - (P_loss * $Loss)",
          explanation: "Expected Value (Expectancy) of the trade setup. We require a Risk:Reward ratio where the potential upside significantly outweighs the downside.",
          variables: [
              { label: "P_win", value: "--", unit: "%", description: "Estimated Win Probability" },
              { label: "$Win", value: "--", unit: "USD", description: "Potential Gain" },
              { label: "$Loss", value: "--", unit: "USD", description: "Potential Loss" }
          ],
          thresholds: {
              pass: "E[X] > 2.0 R",
              warning: "1.5 R < E[X] < 2.0 R",
              fail: "E[X] < 1.5 R"
          }
      }
  },
];

export const MOCK_NEWS: NewsItem[] = []; 
export const MOCK_CANDLES: CandleData[] = []; 
export const MOCK_SIGNALS: TradeSignal[] = []; 
export const MOCK_LEVELS: PriceLevel[] = []; 
export const MOCK_ASKS: OrderBookLevel[] = []; 
export const MOCK_BIDS: OrderBookLevel[] = []; 
