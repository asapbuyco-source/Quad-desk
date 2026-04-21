import { create } from 'zustand';
import { AppState } from './types';
import { createUISlice } from './slices/createUISlice';
import { createConfigSlice } from './slices/createConfigSlice';
import { createMarketSlice } from './slices/createMarketSlice';
import { createAISlice } from './slices/createAISlice';
import { createAuthSlice } from './slices/createAuthSlice';
import { createTradingSlice } from './slices/createTradingSlice';
import { createAnalysisSlice } from './slices/createAnalysisSlice';
import { createNotificationSlice } from './slices/createNotificationSlice';

export const useStore = create<AppState>((...a) => ({
  ...createUISlice(...a),
  ...createConfigSlice(...a),
  ...createMarketSlice(...a),
  ...createAISlice(...a),
  ...createAuthSlice(...a),
  ...createTradingSlice(...a),
  ...createAnalysisSlice(...a),
  ...createNotificationSlice(...a),
}));
