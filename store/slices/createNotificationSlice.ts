import { StateCreator } from 'zustand';
import { AppState } from '../types';

export const createNotificationSlice: StateCreator<AppState, [], [], Pick<AppState, 'notifications' | 'alertLogs' | 'addNotification' | 'removeNotification' | 'logAlert'>> = (set) => ({
  notifications: [],
  alertLogs: [],
  addNotification: (toast) => set(state => ({ notifications: [...state.notifications, toast] })),
  removeNotification: (id) => set(state => ({ notifications: state.notifications.filter(n => n.id !== id) })),
  logAlert: async (alert) => set(state => ({ alertLogs: [alert, ...state.alertLogs].slice(0, 50) }))
});
