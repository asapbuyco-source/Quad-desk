import { CandleData, OrderBookLevel, SentinelChecklist, MarketMetrics, NewsItem, TradeSignal, PriceLevel } from './types';

export const APP_NAME = "QUANT DESK";

const getApiUrl = () => {
    let url = 'https://quant-desk-backend-production.up.railway.app'; 
    if (typeof window !== 'undefined') {
        const stored = localStorage.getItem('VITE_API_URL');
        if (stored && stored.startsWith('http')) {
            url = stored;
        } 
        else if ((import.meta as any).env?.VITE_API_URL) {
            url = (import.meta as any).env.VITE_API_URL;
        } 
        else if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
             url = 'http://localhost:8000'; 
        }
    }
    return url.replace(/\/$/, "");
};

export const API_BASE_URL = getApiUrl();

export const MOCK_METRICS: MarketMetrics = {
  pair: "---/---",
  price: 0,
  change: 0,
  session: "CONNECTING",
  safetyStatus: "INITIALIZING",
  regime: "UNCERTAIN",
  retailSentiment: 50,
  institutionalCVD: 0,
  zScore: 0,
  toxicity: 0,
  ofi: 0,
  heatmap: [],
  bayesianPosterior: 0.5,
  skewness: 0,
  kurtosis: 0,
  cvdContext: {
      trend: 'FLAT',
      divergence: 'NONE',
      interpretation: 'NEUTRAL',
      value: 0
  }
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
          explanation: "Measures statistical deviation from the VWAP mean. Scores > ±2.0 imply extreme dislocation.",
          variables: [
              { label: "P (Price)", value: "--", unit: "USD", description: "Current execution price" },
              { label: "μ (VWAP)", value: "--", unit: "USD", description: "Volume Weighted Average Price" },
              { label: "σ (Std Dev)", value: "--", unit: "USD", description: "Standard deviation of returns" }
          ],
          thresholds: {
              pass: "|Z| > 2.0 (Significant)",
              warning: "1.5 < |Z| < 2.0 (Developing)",
              fail: "|Z| < 1.5 (Noise)"
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
          explanation: "Updates the probability of trend continuation based on momentum and volume confirmation.",
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
          explanation: "Uses RSI extremes to identify retail exhaustion points before institutional sweeps.",
          variables: [
              { label: "RSI", value: "--", unit: "", description: "Momentum Oscillator" },
              { label: "Bias", value: "--", unit: "", description: "Directional Bias" },
              { label: "State", value: "Neutral", unit: "", description: "Market State" }
          ],
          thresholds: {
              pass: "RSI < 30 or RSI > 70",
              warning: "30 < RSI < 40 or 60 < RSI < 70",
              fail: "40 < RSI < 60 (Neutral)"
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
          explanation: "Measures asymmetry of return distribution. Negative skew identifies tail risk hazards.",
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
          explanation: "Mathematical expectancy of the setup based on targeted risk/reward profile.",
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