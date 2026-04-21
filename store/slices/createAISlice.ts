import { StateCreator } from 'zustand';
import { AppState } from '../types';
import { API_BASE_URL, SCAN_COOLDOWN } from '../../constants';

export const createAISlice: StateCreator<AppState, [], [], Pick<AppState, 'ai' | 'startAiScan' | 'completeAiScan' | 'updateAiCooldown' | 'fetchOrderFlowAnalysis'>> = (set) => ({
  ai: {
    scanResult: undefined,
    isScanning: false,
    lastScanTime: 0,
    cooldownRemaining: 0,
    orderFlowAnalysis: {
        isLoading: false,
        verdict: '',
        confidence: 0,
        explanation: '',
        flowType: '',
        timestamp: 0
    }
  },
  startAiScan: () => set(state => ({ ai: { ...state.ai, isScanning: true } })),
  completeAiScan: (result) => set(state => ({ 
    ai: { 
        ...state.ai, 
        isScanning: false, 
        scanResult: result, 
        lastScanTime: Date.now(), 
        cooldownRemaining: SCAN_COOLDOWN 
    } 
  })),
  updateAiCooldown: (seconds) => set(state => ({ ai: { ...state.ai, cooldownRemaining: seconds } })),
  
  fetchOrderFlowAnalysis: async (payload) => {
      set(state => ({ ai: { ...state.ai, orderFlowAnalysis: { ...state.ai.orderFlowAnalysis, isLoading: true } } }));
      try {
          const res = await fetch(`${API_BASE_URL}/analyze/flow`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(payload)
          });
          if (res.ok) {
              const analysis = await res.json();
              set(state => ({ 
                  ai: { 
                      ...state.ai, 
                      orderFlowAnalysis: { 
                          isLoading: false, 
                          verdict: analysis.verdict, 
                          confidence: analysis.confidence, 
                          explanation: analysis.explanation, 
                          flowType: analysis.flow_type, 
                          timestamp: Date.now() 
                      } 
                  } 
              }));
          }
      } catch (e) {
          set(state => ({ ai: { ...state.ai, orderFlowAnalysis: { ...state.ai.orderFlowAnalysis, isLoading: false } } }));
      }
  },
});
