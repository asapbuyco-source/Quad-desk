
import { initializeApp, getApps, getApp, FirebaseApp } from "firebase/app";
import { getAuth, GoogleAuthProvider, Auth } from "firebase/auth";
import { getAnalytics, isSupported, Analytics } from "firebase/analytics";
import { 
  getFirestore, 
  initializeFirestore, 
  persistentLocalCache, 
  memoryLocalCache,
  Firestore
} from "firebase/firestore";

export type { FirebaseApp, Auth, Analytics, Firestore };

const firebaseConfig = {
  apiKey: "AIzaSyD6eNi5OkV8mwvaV-hAyvNjOD_gLznNgtg",
  authDomain: "quantdesk-6bcd0.firebaseapp.com",
  projectId: "quantdesk-6bcd0",
  storageBucket: "quantdesk-6bcd0.firebasestorage.app",
  messagingSenderId: "792199101587",
  appId: "1:792199101587:web:f30e81b1c898e3d7dfe166",
  measurementId: "G-Y4JY39HZF3"
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
