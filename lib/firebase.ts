import { initializeApp, getApps, getApp } from "firebase/app";
import type { FirebaseApp } from "firebase/app";
import { getAuth, GoogleAuthProvider } from "firebase/auth";
import type { Auth } from "firebase/auth";
import { getAnalytics, isSupported } from "firebase/analytics";
import type { Analytics } from "firebase/analytics";
import { initializeFirestore, persistentLocalCache, persistentMultipleTabManager, getFirestore } from "firebase/firestore";
import type { Firestore } from "firebase/firestore";

const firebaseConfig = {
  apiKey: "AIzaSyD6eNi5OkV8mwvaV-hAyvNjOD_gLznNgtg",
  authDomain: "quantdesk-6bcd0.firebaseapp.com",
  projectId: "quantdesk-6bcd0",
  storageBucket: "quantdesk-6bcd0.firebasestorage.app",
  messagingSenderId: "792199101587",
  appId: "1:792199101587:web:f30e81b1c898e3d7dfe166",
  measurementId: "G-Y4JY39HZF3"
};

// Singleton pattern: Reuse existing app if available to prevent "Component auth not registered" error during hot-reload
let app: FirebaseApp;
let db: Firestore;

if (!getApps().length) {
  // First initialization
  app = initializeApp(firebaseConfig);
  // Initialize Firestore with settings only once
  db = initializeFirestore(app, {
    localCache: persistentLocalCache({
      tabManager: persistentMultipleTabManager()
    })
  });
} else {
  // Reuse existing instance
  app = getApp();
  // Get existing Firestore instance (avoids "Firestore already started" error)
  db = getFirestore(app);
}

const auth: Auth = getAuth(app);
const googleProvider = new GoogleAuthProvider();

// Initialize Analytics (Async check for browser support)
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