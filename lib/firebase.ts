import { initializeApp } from "firebase/app";
import { getAuth, GoogleAuthProvider } from "firebase/auth";
import { getAnalytics } from "firebase/analytics";

const firebaseConfig = {
  apiKey: "AIzaSyD6eNi5OkV8mwvaV-hAyvNjOD_gLznNgtg",
  authDomain: "quantdesk-6bcd0.firebaseapp.com",
  projectId: "quantdesk-6bcd0",
  storageBucket: "quantdesk-6bcd0.firebasestorage.app",
  messagingSenderId: "792199101587",
  appId: "1:792199101587:web:f30e81b1c898e3d7dfe166",
  measurementId: "G-Y4JY39HZF3"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const googleProvider = new GoogleAuthProvider();

// Initialize Analytics (only in browser environment)
let analytics;
if (typeof window !== 'undefined') {
  analytics = getAnalytics(app);
}

export { auth, googleProvider, analytics };