

import { initializeApp, getApps, getApp } from "firebase/app";
import type { FirebaseApp } from "firebase/app";
import { getAuth, GoogleAuthProvider } from "firebase/auth";
import type { Auth } from "firebase/auth";
import { getAnalytics, isSupported } from "firebase/analytics";
import type { Analytics } from "firebase/analytics";
import { 
  getFirestore, 
  initializeFirestore, 
  persistentLocalCache, 
  memoryLocalCache,
} from "firebase/firestore";
import type { Firestore } from "firebase/firestore";

export type { FirebaseApp, Auth, Analytics, Firestore };

const firebaseConfig = {
  apiKey: (import.meta as any).env.VITE_FIREBASE_API_KEY,
  authDomain: (import.meta as any).env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: (import.meta as any).env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: (import.meta as any).env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: (import.meta as any).env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: (import.meta as any).env.VITE_FIREBASE_APP_ID,
  measurementId: (import.meta as any).env.VITE_FIREBASE_MEASUREMENT_ID
};

// Singleton pattern to handle HMR (Hot Module Replacement)
let app: FirebaseApp;
let db: Firestore;

// 1. Initialize App
if (!getApps().length) {
  app = initializeApp(firebaseConfig);
} else {
  app = getApp();
}

// 2. Initialize Firestore
// We use a robust initialization strategy to prevent "Service not available" or "Already Initialized" errors.
try {
    // Try to initialize with persistence (preferred)
    db = initializeFirestore(app, {
        localCache: persistentLocalCache()
    });
} catch (error: any) {
    if (error.message && error.message.includes('already been started')) {
        // If already started (e.g. fast refresh), just get the instance
        db = getFirestore(app);
    } else {
        // If persistence fails (e.g. Incognito mode), fallback to memory
        try {
            db = initializeFirestore(app, {
                localCache: memoryLocalCache()
            });
        } catch (e2: any) {
            // If even memory init fails (rare), it might be already started
            if (e2.message && e2.message.includes('already been started')) {
                db = getFirestore(app);
            } else {
                console.error("Firestore Critical Init Error:", e2);
                // Fallback to getFirestore which might throw if service is truly broken, 
                // but at this point we have few options.
                try {
                    db = getFirestore(app);
                } catch(e3) {
                    console.error("Firestore Service Unavailable:", e3);
                    // We don't crash here to allow Auth to potentially still work
                }
            }
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