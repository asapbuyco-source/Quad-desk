
import { initializeApp, getApps, getApp, FirebaseApp } from "firebase/app";
import { getAuth, GoogleAuthProvider, Auth } from "firebase/auth";
import { getAnalytics, isSupported, Analytics } from "firebase/analytics";
import { 
  getFirestore, 
  Firestore, 
  initializeFirestore, 
  persistentLocalCache, 
  memoryLocalCache 
} from "firebase/firestore";

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
let app: FirebaseApp;
let db: Firestore;

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
            // We cannot recover if we can't get an instance, but we avoid throwing the specific "Service not available" to the UI if possible.
            // In a real scenario, this might need a mock DB or UI error state.
            // For now, we allow the error to surface if it's truly unrecoverable, but the memory fallback usually fixes 99% of cases.
            throw e3;
        }
    }
}

const auth: Auth = getAuth(app);
const googleProvider = new GoogleAuthProvider();

// Initialize Analytics (Async)
let analytics: Analytics | undefined;
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
