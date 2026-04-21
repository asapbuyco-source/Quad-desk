import { StateCreator } from 'zustand';
import { AppState } from '../types';
import { auth, googleProvider, db } from '../../lib/firebase';
import { 
  signInWithPopup, signInWithEmailAndPassword, createUserWithEmailAndPassword, 
  signOut, updateProfile 
} from 'firebase/auth';
import { doc, getDoc } from 'firebase/firestore';

export const createAuthSlice: StateCreator<AppState, [], [], Pick<AppState, 'auth' | 'setUser' | 'signInGoogle' | 'loginEmail' | 'registerEmail' | 'logout' | 'updateUserProfile' | 'loadUserPreferences' | 'toggleRegistration'>> = (set, get) => ({
  auth: {
    user: null,
    registrationOpen: true,
  },
  setUser: (user) => set(state => ({ auth: { ...state.auth, user } })),
  signInGoogle: async () => {
    try { await signInWithPopup(auth, googleProvider); } catch (e: any) {
        get().addNotification({ id: Date.now().toString(), type: 'error', title: 'Auth Failed', message: e.message });
    }
  },
  loginEmail: async (e, p) => { await signInWithEmailAndPassword(auth, e, p); },
  registerEmail: async (e, p, n) => {
    const res = await createUserWithEmailAndPassword(auth, e, p);
    if (res.user) { await updateProfile(res.user, { displayName: n }); }
  },
  logout: async () => { await signOut(auth); },
  updateUserProfile: async (data) => { set(state => ({ config: { ...state.config, ...data } })); },
  loadUserPreferences: async () => {
      try {
          const user = get().auth.user;
          if(user) {
              const snap = await getDoc(doc(db, 'users', user.uid));
              if(snap.exists()) set(s => ({ config: { ...s.config, ...snap.data().config } }));
          }
      } catch(e) {}
  },
  toggleRegistration: (isOpen) => set(state => ({ auth: { ...state.auth, registrationOpen: isOpen } })),
});
