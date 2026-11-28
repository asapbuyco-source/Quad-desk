import React, { useEffect, useState } from 'react';
import {
  Settings, User as UserIcon, CreditCard, KeyRound, LogOut, Server,
  RefreshCw, CheckCircle2, AlertTriangle, Trash2, Sparkles, ExternalLink, BookOpen, ShieldCheck,
} from 'lucide-react';
import { useStore } from '../store';
import { apiFetch } from '../utils/apiClient';
import { PORTAL_URL, upgradeHref, isAdminEmail, PRICING, PLAN_LABEL } from '../utils/entitlements';

const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'DOGEUSDT', 'LINKUSDT'];
const INTERVALS = ['1m', '5m', '15m', '1h', '4h', '1d'];

interface Prefs { compact: boolean; reduceMotion: boolean }
const PREFS_KEY = 'qd.prefs';
const loadPrefs = (): Prefs => {
  try { return { compact: false, reduceMotion: false, ...JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') }; }
  catch { return { compact: false, reduceMotion: false }; }
};
const applyPrefs = (p: Prefs) => {
  document.documentElement.dataset.density = p.compact ? 'compact' : 'normal';
  document.documentElement.dataset.motion = p.reduceMotion ? 'reduced' : 'full';
};

const Card: React.FC<{ icon: React.ReactNode; title: string; children: React.ReactNode }> = ({ icon, title, children }) => (
  <section className="fintech-card p-5">
    <div className="mb-3 flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-slate-400">
      <span className="text-brand-accent">{icon}</span> {title}
    </div>
    {children}
  </section>
);

const Row: React.FC<{ label: string; hint?: string; children: React.ReactNode }> = ({ label, hint, children }) => (
  <div className="flex items-center justify-between gap-4 border-b border-white/5 py-2.5 last:border-0">
    <div className="min-w-0">
      <div className="text-xs text-slate-200">{label}</div>
      {hint && <div className="text-[10px] text-slate-500">{hint}</div>}
    </div>
    <div className="shrink-0">{children}</div>
  </div>
);

const selectCls = 'rounded-lg border border-white/10 bg-black/40 px-2.5 py-1.5 text-xs text-slate-200 outline-none';
const toggleCls = (on: boolean) =>
  `relative h-5 w-9 rounded-full transition-colors ${on ? 'bg-brand-accent' : 'bg-slate-700'}`;

const SettingsView: React.FC = () => {
  const user = useStore(s => s.auth.user);
  const plan = useStore(s => s.auth.plan);
  const status = useStore(s => s.auth.subStatus);
  const renewsAt = useStore(s => s.auth.subRenewsAt);
  const licenseKey = useStore(s => s.auth.licenseKey);
  const previewAsUser = useStore(s => s.auth.previewAsUser);
  const logout = useStore(s => s.logout);
  const config = useStore(s => s.config);
  const setSymbol = useStore(s => s.setSymbol);
  const setInterval = useStore(s => s.setInterval);

  const [prefs, setPrefs] = useState<Prefs>(loadPrefs);
  const [diag, setDiag] = useState<{ ok: boolean; ms: number; buffered?: number; at: string } | null>(null);
  const [diagBusy, setDiagBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => { applyPrefs(prefs); }, []);

  const updatePrefs = (patch: Partial<Prefs>) => {
    const next = { ...prefs, ...patch };
    setPrefs(next);
    applyPrefs(next);
    try { localStorage.setItem(PREFS_KEY, JSON.stringify(next)); } catch { /* ignore */ }
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };

  const runDiagnostics = async () => {
    setDiagBusy(true);
    const started = performance.now();
    let ok = false;
    let buffered: number | undefined;
    try {
      const h = await apiFetch('/health', { timeoutMs: 60000 });
      ok = h.ok;
      const l = await apiFetch('/liquidations?minutes=5', { timeoutMs: 30000 });
      if (l.ok) { try { buffered = (await l.json()).buffered; } catch { /* ignore */ } }
    } catch { ok = false; }
    setDiag({ ok, ms: Math.round(performance.now() - started), buffered, at: new Date().toLocaleTimeString() });
    setDiagBusy(false);
  };

  const clearLocal = () => {
    try {
      Object.keys(localStorage)
        .filter(k => k.startsWith('qd.'))
        .forEach(k => localStorage.removeItem(k));
    } catch { /* ignore */ }
    setPrefs({ compact: false, reduceMotion: false });
    applyPrefs({ compact: false, reduceMotion: false });
  };

  const admin = isAdminEmail(user?.email);
  const pro = plan !== 'free' || (admin && !previewAsUser);
  const planLabel = admin && !previewAsUser ? 'ADMIN' : PLAN_LABEL[plan].toUpperCase();
  const planPrice = plan === 'free' ? 0 : PRICING[plan].price;
  const renewLabel = renewsAt ? new Date(renewsAt).toLocaleDateString() : null;
  const upgrade = upgradeHref({ email: user?.email, userId: user?.uid });

  return (
    <div className="h-full overflow-y-auto p-5 lg:p-6 pb-28 lg:pb-6">
      <div className="mx-auto max-w-3xl space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="flex items-center gap-2 text-lg font-bold tracking-wide text-white">
              <Settings size={18} className="text-brand-accent" /> Settings
            </h1>
            <p className="mt-1 text-xs text-slate-500">Workspace preferences, account and backend diagnostics</p>
          </div>
          {saved && <span className="flex items-center gap-1 text-[10px] text-emerald-400"><CheckCircle2 size={12} /> Saved</span>}
        </div>

        <Card icon={<UserIcon size={14} />} title="Account">
          <Row label="Signed in as">
            <span className="font-mono text-[11px] text-slate-300">{user?.email || '—'}</span>
          </Row>
          <Row label="Plan" hint={admin && !previewAsUser ? 'Admin access' : status}>
            <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider ${
              pro ? 'bg-emerald-500/15 text-emerald-300' : 'bg-slate-500/15 text-slate-400'}`}>
              {pro ? `${planLabel} · $${planPrice}/mo` : 'FREE'}
            </span>
          </Row>
          {renewLabel && pro && <Row label="Renews"><span className="font-mono text-[11px] text-slate-400">{renewLabel}</span></Row>}
          <Row label="License key" hint={licenseKey ? 'Stored on your account' : 'Paste it on the Plans page'}>
            <span className="font-mono text-[11px] text-slate-400">
              {licenseKey ? `${licenseKey.slice(0, 4)}••••${licenseKey.slice(-4)}` : 'none'}
            </span>
          </Row>
          <div className="mt-3 flex flex-wrap gap-2">
            {PORTAL_URL ? (
              <a href={PORTAL_URL} target="_blank" rel="noopener noreferrer"
                className="flex items-center gap-1.5 rounded-lg border border-white/10 px-3 py-1.5 text-[11px] text-slate-200 hover:bg-white/5">
                <CreditCard size={13} /> Manage billing <ExternalLink size={10} />
              </a>
            ) : null}
            {!pro && upgrade ? (
              <a href={upgrade} target="_blank" rel="noopener noreferrer"
                className="flex items-center gap-1.5 rounded-lg bg-brand-accent px-3 py-1.5 text-[11px] font-bold text-white hover:bg-brand-accent/90">
                <Sparkles size={13} /> Upgrade to Pro
              </a>
            ) : null}
            <button onClick={() => logout()}
              className="flex items-center gap-1.5 rounded-lg border border-white/10 px-3 py-1.5 text-[11px] text-slate-300 hover:bg-white/5">
              <LogOut size={13} /> Sign out
            </button>
          </div>
        </Card>

        <Card icon={<Settings size={14} />} title="Preferences">
          <Row label="Active symbol" hint="Used by the desk, funding and positioning views">
            <select className={selectCls} value={config.activeSymbol} onChange={e => setSymbol(e.target.value)}>
              {SYMBOLS.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </Row>
          <Row label="Chart interval" hint="Live candle stream resolution">
            <select className={selectCls} value={config.interval} onChange={e => setInterval(e.target.value)}>
              {INTERVALS.map(i => <option key={i} value={i}>{i}</option>)}
            </select>
          </Row>
          <Row label="Compact density" hint="Tighter spacing across the terminal">
            <button role="switch" aria-checked={prefs.compact} className={toggleCls(prefs.compact)}
              onClick={() => updatePrefs({ compact: !prefs.compact })}>
              <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-transform ${
                prefs.compact ? 'translate-x-[18px]' : 'translate-x-0.5'}`} />
            </button>
          </Row>
          <Row label="Reduce motion" hint="Disable animations for accessibility">
            <button role="switch" aria-checked={prefs.reduceMotion} className={toggleCls(prefs.reduceMotion)}
              onClick={() => updatePrefs({ reduceMotion: !prefs.reduceMotion })}>
              <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-transform ${
                prefs.reduceMotion ? 'translate-x-[18px]' : 'translate-x-0.5'}`} />
            </button>
          </Row>
        </Card>

        <Card icon={<Server size={14} />} title="Backend & data">
          <Row label="Data server" hint="Render free tier — sleeps after ~15 min idle">
            <button onClick={runDiagnostics} disabled={diagBusy}
              className="flex items-center gap-1.5 rounded-lg border border-white/10 px-3 py-1.5 text-[11px] text-slate-200 hover:bg-white/5 disabled:opacity-50">
              <RefreshCw size={12} className={diagBusy ? 'animate-spin' : ''} /> Run check
            </button>
          </Row>
          {diag && (
            <div className="mt-2 rounded-lg border border-white/5 bg-black/20 p-3 font-mono text-[11px]">
              <div className={`flex items-center gap-1.5 ${diag.ok ? 'text-emerald-400' : 'text-rose-400'}`}>
                {diag.ok ? <CheckCircle2 size={12} /> : <AlertTriangle size={12} />}
                {diag.ok ? 'Online' : 'Unreachable'} · {diag.ms}ms
              </div>
              <div className="mt-1 text-slate-500">
                liquidations buffered: {diag.buffered ?? '—'} · checked {diag.at}
              </div>
            </div>
          )}
          <Row label="API base" hint="Proxied through Vercel to avoid direct onrender access">
            <span className="max-w-[220px] truncate font-mono text-[10px] text-slate-500">
              {(import.meta as any).env?.VITE_API_URL || 'not configured'}
            </span>
          </Row>
          <Row label="Data sources" hint="Binance · OKX · Coinbase · Hyperliquid · FRED">
            <span className="text-[10px] text-slate-400">public, no key</span>
          </Row>
        </Card>

        <Card icon={<BookOpen size={14} />} title="Resources">
          <div className="flex flex-wrap gap-2 text-[11px]">
            {[
              { href: '/learn', label: 'Glossary' },
              { href: '/about', label: 'About' },
              { href: '/privacy', label: 'Privacy' },
              { href: '/terms', label: 'Terms' },
              { href: '/disclaimer', label: 'Risk disclaimer' },
            ].map(l => (
              <a key={l.href} href={l.href} className="rounded-lg border border-white/10 px-2.5 py-1.5 text-slate-300 hover:bg-white/5">
                {l.label}
              </a>
            ))}
          </div>
          <div className="mt-3 flex items-center gap-1.5 text-[10px] text-slate-600">
            <ShieldCheck size={11} /> Client-side preferences only · nothing leaves this device
          </div>
        </Card>

        <Card icon={<Trash2 size={14} />} title="Local data">
          <Row label="Clear local preferences" hint="Removes consent, preferences and saved UI state">
            <button onClick={clearLocal}
              className="flex items-center gap-1.5 rounded-lg border border-rose-500/30 px-3 py-1.5 text-[11px] text-rose-300 hover:bg-rose-500/10">
              <KeyRound size={12} /> Clear
            </button>
          </Row>
        </Card>
      </div>
    </div>
  );
};

export default SettingsView;
