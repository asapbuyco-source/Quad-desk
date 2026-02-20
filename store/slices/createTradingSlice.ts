import { StateCreator } from 'zustand';
import { AppState } from '../types';

export const createTradingSlice: StateCreator<AppState, [], [], Pick<AppState, 'trading' | 'openPosition' | 'closePosition' | 'setRiskPercent'>> = (set, get) => ({
  trading: {
    activePosition: null,
    accountSize: 10000,
    riskPercent: 1,
    dailyStats: {
        totalR: 0,
        realizedPnL: 0,
        wins: 0,
        losses: 0,
        tradesToday: 0,
        maxDrawdownR: 0
    }
  },
  openPosition: (params) => {
    const { entry, stop, target, direction } = params;
    const riskAmount = get().trading.accountSize * (get().trading.riskPercent / 100);
    const stopDistance = Math.abs(entry - stop);
    const size = stopDistance > 0 ? riskAmount / stopDistance : 0;
    
    set(state => ({ trading: { ...state.trading, activePosition: {
        id: Date.now().toString(),
        symbol: get().config.activeSymbol,
        direction, entry, stop, target, size, riskAmount,
        isOpen: true, openTime: Date.now(), floatingR: 0, unrealizedPnL: 0
    } } }));
  },
  closePosition: (price) => set(state => {
      const pos = state.trading.activePosition;
      if (!pos) return {};
      const pnl = pos.direction === 'LONG' ? (price - pos.entry) * pos.size : (pos.entry - price) * pos.size;
      const r = pnl / pos.riskAmount;
      const newStats = { ...state.trading.dailyStats };
      newStats.totalR += r;
      newStats.realizedPnL += pnl;
      if (r > 0) newStats.wins++; else newStats.losses++;
      newStats.tradesToday++;
      return {
          trading: { ...state.trading, activePosition: null, accountSize: state.trading.accountSize + pnl, dailyStats: newStats }
      };
  }),
  setRiskPercent: (pct) => set(state => ({ trading: { ...state.trading, riskPercent: pct } })),
});
