import React, { useState } from 'react';
import { motion as m, AnimatePresence } from 'framer-motion';
import {
  Shield, Lock, Hexagon, Mail, User, AlertCircle, Loader2, EyeOff,
  ArrowRight, Check, Eye as EyeIcon,
} from 'lucide-react';
import { sendPasswordResetEmail } from 'firebase/auth';
import { auth } from '../lib/firebase';
import { useStore } from '../store';

const motion = m as any;

const cleanError = (msg: string) => {
  const m = (msg || '').replace('Firebase: ', '');
  if (m.includes('auth/invalid-credential') || m.includes('auth/wrong-password') || m.includes('auth/user-not-found')) {
    return 'Email or password is incorrect.';
  }
  if (m.includes('auth/email-already-in-use')) return 'That email already has an account. Try signing in.';
  if (m.includes('auth/weak-password')) return 'Password must be at least 6 characters.';
  if (m.includes('auth/invalid-email')) return 'Enter a valid email address.';
  if (m.includes('auth/too-many-requests')) return 'Too many attempts. Try again in a few minutes.';
  return m || 'Something went wrong. Please try again.';
};

const AuthOverlay: React.FC = () => {
  const { signInGoogle, registerEmail, loginEmail, auth: { registrationOpen } } = useStore();

  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [showPw, setShowPw] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');

  const switchMode = (next: 'login' | 'register') => {
    setMode(next);
    setError(null);
    setNotice(null);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setNotice(null);
    if (mode === 'register' && !registrationOpen) {
      setError('New account creation is currently paused. Please try again later.');
      return;
    }
    setIsLoading(true);
    try {
      if (mode === 'login') await loginEmail(email.trim(), password);
      else await registerEmail(email.trim(), password, name.trim());
    } catch (err: any) {
      setError(cleanError(err?.message));
      setIsLoading(false);
    }
  };

  const forgotPassword = async () => {
    setError(null);
    setNotice(null);
    if (!email.trim()) {
      setError('Enter your email first, then tap “Forgot password”.');
      return;
    }
    try {
      await sendPasswordResetEmail(auth, email.trim());
      setNotice(`Reset link sent to ${email.trim()}.`);
    } catch (err: any) {
      setError(cleanError(err?.message));
    }
  };

  const inputCls =
    'w-full rounded-xl border border-white/10 bg-black/40 py-3 pl-11 pr-11 text-sm text-white outline-none transition-all placeholder:text-zinc-600 focus:border-brand-accent/60 focus:ring-1 focus:ring-brand-accent/40';

  return (
    <div className="fixed inset-0 z-[100] overflow-y-auto bg-[#050507]/92 backdrop-blur-xl">
      <div className="flex min-h-full items-center justify-center p-3 sm:p-6">
        <motion.div
          initial={{ opacity: 0, y: 12, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={{ duration: 0.35, ease: 'easeOut' }}
          className="grid w-full max-w-4xl overflow-hidden rounded-2xl border border-white/10 bg-[#0a0a0c] shadow-[0_40px_120px_-40px_rgba(0,0,0,0.95)] md:grid-cols-2"
        >
          {/* ── Brand / art panel (desktop) ─────────────────────────── */}
          <aside className="relative hidden flex-col justify-between overflow-hidden bg-gradient-to-br from-[#0b1220] via-[#080d16] to-black p-8 md:flex">
            <div className="pointer-events-none absolute -right-24 -top-24 h-64 w-64 rounded-full bg-brand-accent/20 blur-[90px]" />
            <div className="pointer-events-none absolute -bottom-24 -left-16 h-64 w-64 rounded-full bg-emerald-500/10 blur-[90px]" />

            <div className="relative z-10 flex items-center gap-2.5">
              <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-brand-accent/15 text-brand-accent">
                <Hexagon size={18} strokeWidth={2.2} />
              </span>
              <div className="leading-tight">
                <div className="text-[13px] font-bold tracking-[0.16em] text-white">QUANT DESK</div>
                <div className="text-[9px] font-mono text-slate-500">DERIVATIVES TERMINAL</div>
              </div>
            </div>

            <div className="relative z-10">
              <h2 className="text-2xl font-bold leading-snug tracking-tight text-white">
                The derivatives desk for traders who read the tape.
              </h2>
              <p className="mt-3 text-sm leading-relaxed text-slate-400">
                Order flow, funding, liquidations and positioning — in one screen, with sources and timestamps.
              </p>
              <ul className="mt-6 space-y-2.5 text-[12px] text-slate-300">
                {['Executed-trade order flow & CVD', 'Cross-venue funding and open interest', 'Liquidation clusters and whale positioning'].map(t => (
                  <li key={t} className="flex items-center gap-2">
                    <span className="flex h-4 w-4 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-400">
                      <Check size={10} />
                    </span>
                    {t}
                  </li>
                ))}
              </ul>
            </div>

            {/* decorative chart art */}
            <svg viewBox="0 0 320 90" className="pointer-events-none absolute bottom-0 left-0 w-full opacity-50" preserveAspectRatio="none">
              <defs>
                <linearGradient id="authArea" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#3b82f6" stopOpacity="0.35" />
                  <stop offset="100%" stopColor="#3b82f6" stopOpacity="0" />
                </linearGradient>
              </defs>
              <polygon points="0,90 0,62 25,58 50,66 75,44 100,50 125,34 150,40 175,24 200,30 225,16 250,22 275,10 300,16 320,8 320,90" fill="url(#authArea)" />
              <polyline points="0,62 25,58 50,66 75,44 100,50 125,34 150,40 175,24 200,30 225,16 250,22 275,10 300,16 320,8"
                fill="none" stroke="#60a5fa" strokeWidth="1.6" />
            </svg>

            <div className="relative z-10 font-mono text-[9px] tracking-wider text-slate-600">
              DATA: BINANCE · BYBIT · OKX · COINBASE · HYPERLIQUID · FRED / ECB
            </div>
          </aside>

          {/* ── Form panel ──────────────────────────────────────────── */}
          <section className="relative flex flex-col justify-center p-6 sm:p-8">
            <div className="mb-6 flex items-center gap-2 md:hidden">
              <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand-accent/15 text-brand-accent">
                <Hexagon size={16} strokeWidth={2.2} />
              </span>
              <div className="text-[12px] font-bold tracking-[0.16em] text-white">QUANT DESK</div>
            </div>

            <div className="mb-1 flex items-center gap-2 text-[10px] font-bold uppercase tracking-[0.2em] text-brand-accent">
              <Shield size={12} /> {mode === 'login' ? 'Welcome back' : 'Create account'}
            </div>
            <h1 className="text-xl font-bold tracking-tight text-white">
              {mode === 'login' ? 'Sign in to your desk' : 'Start with the free desk'}
            </h1>
            <p className="mt-1 text-xs text-slate-500">
              {mode === 'login' ? 'Core market data stays free. Pro unlocks the advanced desks.' : 'Free forever for live prices, funding and order flow.'}
            </p>

            <div className="mt-5 flex rounded-xl border border-white/5 bg-black/40 p-1">
              {(['login', 'register'] as const).map(k => (
                <button key={k} onClick={() => switchMode(k)}
                  className={`flex-1 rounded-lg py-2 text-[11px] font-bold uppercase tracking-wider transition-all ${
                    mode === k ? 'bg-white/10 text-white shadow-sm' : 'text-zinc-500 hover:text-zinc-300'}`}>
                  {k === 'login' ? 'Sign in' : 'Create account'}
                </button>
              ))}
            </div>

            <AnimatePresence mode="wait">
              {mode === 'register' && !registrationOpen && (
                <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }}
                  className="mt-3 flex items-start gap-2 rounded-lg border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-400">
                  <AlertCircle size={14} className="mt-0.5 shrink-0" />
                  <span>Registration is paused by the administrator. You can still sign in.</span>
                </motion.div>
              )}
              {error && (
                <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }}
                  className="mt-3 flex items-start gap-2 rounded-lg border border-rose-500/20 bg-rose-500/10 px-3 py-2 text-[11px] text-rose-300">
                  <AlertCircle size={14} className="mt-0.5 shrink-0" />
                  <span>{error}</span>
                </motion.div>
              )}
              {notice && (
                <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }}
                  className="mt-3 flex items-start gap-2 rounded-lg border border-emerald-500/20 bg-emerald-500/10 px-3 py-2 text-[11px] text-emerald-300">
                  <Check size={14} className="mt-0.5 shrink-0" />
                  <span>{notice}</span>
                </motion.div>
              )}
            </AnimatePresence>

            <form onSubmit={handleSubmit} className="mt-4 space-y-3">
              {mode === 'register' && (
                <div className="group relative">
                  <User size={16} className="absolute left-4 top-1/2 -translate-y-1/2 text-zinc-500 transition-colors group-focus-within:text-brand-accent" />
                  <input type="text" placeholder="Full name" value={name} onChange={e => setName(e.target.value)}
                    autoComplete="name" className={inputCls} required />
                </div>
              )}

              <div className="group relative">
                <Mail size={16} className="absolute left-4 top-1/2 -translate-y-1/2 text-zinc-500 transition-colors group-focus-within:text-brand-accent" />
                <input type="email" placeholder="Email address" value={email} onChange={e => setEmail(e.target.value)}
                  autoComplete="email" inputMode="email" className={inputCls} required />
              </div>

              <div className="group relative">
                <Lock size={16} className="absolute left-4 top-1/2 -translate-y-1/2 text-zinc-500 transition-colors group-focus-within:text-brand-accent" />
                <input type={showPw ? 'text' : 'password'} placeholder="Password" value={password}
                  onChange={e => setPassword(e.target.value)}
                  autoComplete={mode === 'login' ? 'current-password' : 'new-password'} className={inputCls} required
                  minLength={6} />
                <button type="button" onClick={() => setShowPw(v => !v)} aria-label={showPw ? 'Hide password' : 'Show password'}
                  className="absolute right-3 top-1/2 -translate-y-1/2 rounded-md p-1 text-zinc-500 hover:text-zinc-200">
                  {showPw ? <EyeOff size={15} /> : <EyeIcon size={15} />}
                </button>
              </div>

              {mode === 'login' && (
                <div className="flex justify-end">
                  <button type="button" onClick={forgotPassword}
                    className="text-[11px] text-slate-500 hover:text-brand-accent">
                    Forgot password?
                  </button>
                </div>
              )}

              <button type="submit" disabled={isLoading || (mode === 'register' && !registrationOpen)}
                className="flex w-full items-center justify-center gap-2 rounded-xl bg-brand-accent py-3 text-sm font-bold text-white transition-all hover:bg-brand-accent/90 disabled:cursor-not-allowed disabled:opacity-50">
                {isLoading ? <Loader2 size={16} className="animate-spin" /> : <ArrowRight size={16} />}
                {isLoading ? 'Please wait…' : mode === 'login' ? 'Sign in' : 'Create account'}
              </button>
            </form>

            <div className="my-5 flex w-full items-center gap-3">
              <div className="h-px flex-1 bg-white/5" />
              <span className="text-[9px] font-bold uppercase tracking-widest text-zinc-600">or</span>
              <div className="h-px flex-1 bg-white/5" />
            </div>

            <button onClick={() => signInGoogle()}
              className="flex w-full items-center justify-center gap-3 rounded-xl bg-white py-3 text-sm font-bold text-black transition-transform hover:scale-[1.01] active:scale-[0.99]">
              <img src="https://www.gstatic.com/firebasejs/ui/2.0.0/images/auth/google.svg" alt="" className="h-5 w-5" />
              Continue with Google
            </button>

            <p className="mt-5 text-center text-[10px] leading-relaxed text-slate-600">
              By continuing you agree to our{' '}
              <a href="/terms" className="text-slate-400 hover:text-brand-accent">Terms</a> and{' '}
              <a href="/privacy" className="text-slate-400 hover:text-brand-accent">Privacy Policy</a>.
              Market data is informational only — not investment advice.
            </p>
          </section>
        </motion.div>
      </div>
    </div>
  );
};

export default AuthOverlay;
