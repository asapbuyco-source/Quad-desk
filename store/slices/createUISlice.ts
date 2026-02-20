import { StateCreator } from 'zustand';
import { AppState } from '../types';

export const createUISlice: StateCreator<AppState, [], [], Pick<AppState, 'ui' | 'setHasEntered' | 'setActiveTab' | 'setProfileOpen'>> = (set) => ({
  ui: {
    activeTab: 'dashboard',
    hasEntered: false,
    isProfileOpen: false,
  },
  setHasEntered: (val) => set(state => ({ ui: { ...state.ui, hasEntered: val } })),
  setActiveTab: (tab) => set(state => ({ ui: { ...state.ui, activeTab: tab } })),
  setProfileOpen: (isOpen) => set(state => ({ ui: { ...state.ui, isProfileOpen: isOpen } })),
});
