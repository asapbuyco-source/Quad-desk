import { StateCreator } from 'zustand';
import { AppState } from '../types';

export const createConfigSlice: StateCreator<AppState, [], [], Pick<AppState, 'config' | 'setSymbol' | 'setInterval' | 'toggleBacktest' | 'setPlaybackSpeed' | 'setBacktestDate' | 'setAiModel' | 'initSystemConfig'>> = (set) => ({
  config: {
    activeSymbol: 'BTCUSDT',
    interval: '1m',
    isBacktest: false,
    playbackSpeed: 1,
    backtestDate: new Date().toISOString().split('T')[0],
    aiModel: 'gemini-3-flash-preview',
    telegramBotToken: '',
    telegramChatId: '',
  },
  setSymbol: (symbol) => set(state => ({ config: { ...state.config, activeSymbol: symbol } })),
  setInterval: (interval) => set(state => ({ config: { ...state.config, interval } })),
  toggleBacktest: () => set(state => ({ config: { ...state.config, isBacktest: !state.config.isBacktest } })),
  setPlaybackSpeed: (speed) => set(state => ({ config: { ...state.config, playbackSpeed: speed } })),
  setBacktestDate: (date) => set(state => ({ config: { ...state.config, backtestDate: date } })),
  setAiModel: (model) => set(state => ({ config: { ...state.config, aiModel: model } })),
  initSystemConfig: () => {},
});
