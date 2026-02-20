import { StateCreator } from 'zustand';
import { AppState } from '../types';
import { MOCK_METRICS, API_BASE_URL } from '../../constants';
import { CandleData, OrderBookLevel } from '../../types';

export const createMarketSlice: StateCreator<AppState, [], [], Pick<AppState, 'market' | 'cvdBaseline' | 'setMarketHistory' | 'setMarketBands' | 'processWsTick' | 'processTradeTick' | 'processDepthUpdate' | 'refreshHeatmap' | 'resetCvd'>> = (set, get) => ({
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
  cvdBaseline: 0,

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
    
    const tickTimeSec = Math.floor(tick.t / 1000);
    if (tickTimeSec < last.time) return {};

    if (tickTimeSec === last.time) {
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
        const updatedBaseline = state.cvdBaseline + (last.delta || 0);
        const newCvd = updatedBaseline + realDelta;

        const newCandle: CandleData = {
            time: tickTimeSec,
            open: tick.o,
            high: tick.h,
            low: tick.l,
            close: tick.c,
            volume: tick.v,
            zScoreUpper1: last.zScoreUpper1,
            zScoreLower1: last.zScoreLower1,
            zScoreUpper2: last.zScoreUpper2,
            zScoreLower2: last.zScoreLower2,
            adx: last.adx,
            cvd: newCvd,
            delta: realDelta
        };
        newCandles = [...candles.slice(1), newCandle];
        
        // --- CVD Divergence Analysis ---
        const window = newCandles.slice(-10);
        const firstPrice = window[0].close;
        const lastPrice = window[window.length-1].close;
        const firstCvd = window[0].cvd || 0;
        const lastCvd = window[window.length-1].cvd || 0;
        
        const priceDelta = lastPrice - firstPrice;
        const cvdDelta = lastCvd - firstCvd;

        let interpretation: any = 'NEUTRAL';
        let divergence: any = 'NONE';
        
        if (priceDelta > 0 && cvdDelta > 0) interpretation = 'REAL STRENGTH';
        else if (priceDelta < 0 && cvdDelta < 0) interpretation = 'REAL WEAKNESS';
        else if (priceDelta <= 0 && cvdDelta > 0) {
            interpretation = 'ABSORPTION';
            divergence = 'BULLISH_ABSORPTION';
        }
        else if (priceDelta >= 0 && cvdDelta < 0) {
            interpretation = 'DISTRIBUTION';
            divergence = 'BEARISH_DISTRIBUTION';
        }

        return { 
            cvdBaseline: updatedBaseline,
            market: { 
                ...state.market, 
                candles: newCandles,
                metrics: { 
                    ...state.market.metrics, 
                    price: tick.c, 
                    institutionalCVD: newCvd,
                    cvdContext: {
                        trend: cvdDelta > 0 ? 'UP' : 'DOWN',
                        divergence,
                        interpretation,
                        value: (cvdDelta / (tick.v || 1)) * 100
                    }
                }
            } 
        };
    }
    
    return { 
        market: { 
            ...state.market, 
            candles: newCandles,
            metrics: { ...state.market.metrics, price: tick.c }
        } 
    };
  }),

  processTradeTick: (trade) => set(state => {
      const trades = [trade, ...state.market.recentTrades].slice(0, 50);
      return {
          market: { ...state.market, recentTrades: trades }
      };
  }),

  processDepthUpdate: ({ asks, bids }) => set(state => {
      const bidVol = bids.reduce((acc, b) => acc + b.size, 0);
      const askVol = asks.reduce((acc, a) => acc + a.size, 0);
      const totalVol = bidVol + askVol;
      const imbalance = totalVol > 0 ? ((bidVol - askVol) / totalVol) * 100 : 0;

      const allLevels = [...asks, ...bids];
      const meanSize = allLevels.length > 0 ? allLevels.reduce((acc, l) => acc + l.size, 0) / allLevels.length : 0;
      const threshold = meanSize * 2.5;

      const classify = (l: OrderBookLevel) => {
          if (l.size > threshold) return 'WALL';
          if (l.size < meanSize * 0.1) return 'HOLE';
          return 'NORMAL';
      };

      return {
          market: { 
              ...state.market, 
              asks: asks.map(a => ({ ...a, classification: classify(a) as any })), 
              bids: bids.map(b => ({ ...b, classification: classify(b) as any })),
              metrics: { ...state.market.metrics, ofi: imbalance }
          }
      };
  }),

  refreshHeatmap: async () => {
      try {
          const res = await fetch(`${API_BASE_URL}/heatmap`);
          if (res.ok) {
              const heatmap = await res.json();
              set(state => ({ market: { ...state.market, metrics: { ...state.market.metrics, heatmap } } }));
          }
      } catch (e) {
          console.warn("Heatmap fetch failed");
      }
  },

  resetCvd: () => set(state => ({
      cvdBaseline: 0,
      market: { ...state.market, metrics: { ...state.market.metrics, institutionalCVD: 0 } }
  })),
});
