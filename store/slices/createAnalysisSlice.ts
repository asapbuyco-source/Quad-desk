import { StateCreator } from 'zustand';
import { AppState } from '../types';
import { analyzeRegime, calculateRSI } from '../../utils/analytics';
import { TimeframeData, BiasType, BiasMatrixState } from '../../types';

export const createAnalysisSlice: StateCreator<AppState, [], [], Pick<AppState, 'biasMatrix' | 'liquidity' | 'regime' | 'aiTactical' | 'refreshBiasMatrix' | 'refreshLiquidityAnalysis' | 'refreshRegimeAnalysis' | 'refreshTacticalAnalysis'>> = (set, get) => ({
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

  refreshBiasMatrix: async () => {
      set(state => ({ biasMatrix: { ...state.biasMatrix, isLoading: true } }));
      const candles = get().market.candles;
      
      const calculateBiasForWindow = (windowSize: number): TimeframeData => {
          if (candles.length < Math.max(windowSize, 20)) {
              return { bias: 'NEUTRAL', sparkline: new Array(20).fill(50), lastUpdated: Date.now() };
          }
          const slice = candles.slice(-windowSize);
          const closes = slice.map(c => c.close);
          const rsi = calculateRSI(closes, 14);
          
          // Safety: ensure SMA calculation has data
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
          const updatedBiasMatrix: BiasMatrixState = {
              ...state.biasMatrix,
              isLoading: false,
              lastUpdated: Date.now(),
              daily: calculateBiasForWindow(60),
              h4: calculateBiasForWindow(45),
              h1: calculateBiasForWindow(30),
              m5: calculateBiasForWindow(15),
          };
          return { biasMatrix: updatedBiasMatrix };
      });
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
});
