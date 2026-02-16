
import * as firebaseApp from "firebase/app";
import * as firebaseAuth from "firebase/auth";
import * as firebaseAnalytics from "firebase/analytics";
import * as firebaseFirestore from "firebase/firestore";

const { initializeApp, getApps, getApp } = firebaseApp;
const { getAuth, GoogleAuthProvider } = firebaseAuth;
const { getAnalytics, isSupported } = firebaseAnalytics;
const { 
  getFirestore, 
  initializeFirestore, 
  persistentLocalCache, 
  memoryLocalCache 
} = firebaseFirestore;

export type { FirebaseApp } from "firebase/app";
export type { Auth, User } from "firebase/auth";
export type { Analytics } from "firebase/analytics";
export type { Firestore } from "firebase/firestore";

const firebaseConfig = {
  apiKey: "AIzaSyD6eNi5OkV8mwvaV-hAyvNjOD_gLznNgtg",
  authDomain: "quantdesk-6bcd0.firebaseapp.com",
  projectId: "quantdesk-6bcd0",
  storageBucket: "quantdesk-6bcd0.firebasestorage.app",
  messagingSenderId: "792199101587",
  appId: "1:792199101587:web:f30e81b1c898e3d7dfe166",
  measurementId: "G-Y4JY39HZF3"
};

// Singleton pattern to handle HMR
let app: firebaseApp.FirebaseApp;
let db: firebaseFirestore.Firestore;

if (!getApps().length) {
  app = initializeApp(firebaseConfig);
} else {
  app = getApp();
}

// Robust Firestore Initialization
// 1. Try Persistence (Ideal)
// 2. Fallback to Memory (If IndexedDB blocked/incognito)
// 3. Fallback to Existing (If HMR re-run)
try {
    db = initializeFirestore(app, {
        localCache: persistentLocalCache()
    });
} catch (error: any) {
    try {
        // Fallback: Use memory cache if persistence fails (common in restricted envs)
        db = initializeFirestore(app, {
            localCache: memoryLocalCache()
        });
    } catch (e2: any) {
        // Fallback: If totally failed (e.g., already initialized), just get the existing instance
        try {
            db = getFirestore(app);
        } catch (e3) {
            console.error("Firestore fatal initialization error:", e3);
            throw e3;
        }
    }
}

const auth: firebaseAuth.Auth = getAuth(app);
const googleProvider = new GoogleAuthProvider();

// Initialize Analytics (Async)
let analytics: firebaseAnalytics.Analytics | undefined;
if (typeof window !== 'undefined') {
  isSupported().then(yes => {
    if (yes) {
      analytics = getAnalytics(app);
    }
  }).catch(() => {
    console.warn("Firebase Analytics not supported in this environment.");
  });
}

export { auth, db, googleProvider, analytics };
