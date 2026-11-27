import React, { useState } from 'react';
import { Check, X, Sparkles, CreditCard, ShieldCheck, ExternalLink, KeyRound, Loader2, Gift } from 'lucide-react';
import { useStore } from '../store';
import {
  PLAN_FEATURES, PRICING, PORTAL_URL, isAdminEmail, buildCheckoutUrl, PAYWALL_ENABLED,
} from '../utils/entitlements';

const env = (k: string): string => (import.meta as any).env?.[k] || '';

const REFERRALS = [
  { id: 'binance', name: 'Binance', blurb: 'USDM perps · deepest liquidity', href: env('VITE_REFERRAL_BINANCE') },
  { id: 'bybit', name: 'Bybit', blurb: 'Perps + options', href: env('VITE_REFERRAL_BYBIT') },
  { id: 'okx', name: 'OKX', blurb: 'Perps + spot', href: env('VITE_REFERRAL_OKX') },
].filter(r => !!r.href);

const PricingPage: React.FC = () => {
  const user = useStore(s => s.auth.user);
  const plan = useStore(s => s.auth.plan);
  const status = useStore(s => s.auth.subStatus);
  const renewsAt = useStore(s => s.auth.subRenewsAt);
  const previewAsUser = useStore(s => s.auth.previewAsUser);
  const activateLicense = useStore(s => s.activateLicense);
  const startTrial = useStore(s => s.startTrial);
  const trialUsed = useStore(s => s.auth.trialUsed);
  const trialUntil = useStore(s => s.auth.trialUntil);
  const setActiveTab = useStore(s => s.setActiveTab);
  const [lic, setLic] = useState('');
  const [licBusy, setLicBusy] = useState(false);
  const [licMsg, setLicMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const admin = isAdminEmail(user?.email);
  const effectivePro = plan === 'pro' || (admin && !previewAsUser);
  const isPro = effectivePro;

  const renewLabel = renewsAt ? new Date(renewsAt).toLocaleDateString() : null;

  const checkoutHref = buildCheckoutUrl({ email: user?.email, userId: user?.uid });
  const startCheckout = () => {
    if (!checkoutHref) {
      window.location.href = '/contact?topic=billing';
      return;
    }
    window.open(checkoutHref, checkoutHref.startsWith('mailto:') ? '_self' : '_blank', 'noopener,noreferrer');
  };

  const submitLicense = async () => {
    setLicBusy(true);
    setLicMsg(null);
    const r = await activateLicense(lic);
    setLicBusy(false);
    setLicMsg(r.ok
      ? { ok: true, text: 'License activated — Pro unlocked.' }
      : { ok: false, text: r.error || 'Activation failed.' });
    if (r.ok) setLic('');
  };

  return (
    <div className="h-full overflow-y-auto p-5 lg:p-6 pb-28 lg:pb-6">
      <div className="mx-auto max-w-5xl">
        {/* Header */}
        <div className="mb-8 text-center">
          <div className="mb-2 flex items-center justify-center gap-2 text-brand-accent">
            <Sparkles size={18} />
            <span className="text-xs font-bold uppercase tracking-[0.2em]">Plans</span>
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-white">Plans &amp; Billing</h1>
          <p className="mx-auto mt-2 max-w-xl text-sm text-slate-400">
            Core market data is free forever. Pro unlocks the execution desk, analytics and bot tooling.
          </p>
        </div>

        {/* Current state */}
        <div className="mb-6 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-white/10 bg-white/[0.02] p-4">
          <div>
            <div className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Current plan</div>
            <div className="mt-0.5 flex items-center gap-2">
              <span className="font-mono text-lg font-black text-white">
                {isPro ? 'PRO' : 'FREE'}
              </span>
              <span className={`rounded px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider ${
                isPro ? 'bg-emerald-500/15 text-emerald-300' : 'bg-slate-500/15 text-slate-400'
              }`}>
                {admin && !previewAsUser ? 'admin access' : status}
              </span>
            </div>
            {renewLabel && isPro && (
              <div className="mt-1 font-mono text-[10px] text-slate-500">Renews {renewLabel}</div>
            )}
            {admin && previewAsUser && (
              <div className="mt-1 font-mono text-[10px] text-amber-400">
                Previewing as a free user (toggle in Admin Control)
              </div>
            )}
          </div>

          {isPro ? (
            PORTAL_URL ? (
              <a
                href={PORTAL_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-2 rounded-lg border border-white/10 px-4 py-2 text-xs font-semibold text-slate-200 hover:bg-white/5"
              >
                <CreditCard size={14} /> Manage billing <ExternalLink size={11} />
              </a>
            ) : (
              <span className="text-[11px] text-slate-500">
                {admin && !previewAsUser ? 'Admin — full desk unlocked' : 'Billing portal not configured'}
              </span>
            )
          ) : (
            <button
              onClick={startCheckout}
              title={checkoutHref ? 'Open secure checkout' : 'Request Pro access'}
              className="flex items-center gap-2 rounded-lg bg-brand-accent px-4 py-2 text-xs font-bold text-white transition-colors hover:bg-brand-accent/90"
            >
              <Sparkles size={14} /> {checkoutHref ? 'Upgrade to Pro' : 'Request Pro access'}
            </button>
          )}
        </div>

        {/* Demo trial — one shot, session scoped */}
        {PAYWALL_ENABLED && !isPro && !trialUsed && (
          <div className="mb-6 flex flex-col gap-3 rounded-xl border border-brand-accent/30 bg-brand-accent/[0.07] p-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <div className="text-sm font-bold text-white">Try every Pro desk for 15 minutes</div>
              <p className="mt-0.5 text-[11px] text-slate-400">
                One demo per session — whales, order flow, analytics and the rest. No card needed.
              </p>
            </div>
            <button
              onClick={() => { startTrial(15); setActiveTab('dashboard'); }}
              className="shrink-0 rounded-lg bg-brand-accent px-4 py-2 text-xs font-bold text-white hover:bg-brand-accent/90"
            >
              Start demo
            </button>
          </div>
        )}

        {(trialUntil || trialUsed) && !isPro && (
          <div className="mb-6 rounded-xl border border-white/10 bg-white/[0.02] p-3 font-mono text-[10px] text-slate-500">
            {trialUntil && trialUntil > Date.now()
              ? `Demo active · ${Math.max(1, Math.ceil((trialUntil - Date.now()) / 60000))} min left`
              : 'Demo used. Pro stays unlocked permanently after upgrade.'}
          </div>
        )}

        {/* Plan cards */}
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {/* Free */}
          <div className="fintech-card flex flex-col p-5">
            <div className="flex items-baseline justify-between">
              <h2 className="text-sm font-bold uppercase tracking-wider text-slate-300">{PRICING.free.name}</h2>
              {!isPro && <span className="rounded bg-slate-500/15 px-1.5 py-0.5 text-[9px] font-bold uppercase text-slate-400">Current</span>}
            </div>
            <div className="mt-2 font-mono text-3xl font-black text-white">
              $0 <span className="text-xs font-normal text-slate-500">/ {PRICING.free.period}</span>
            </div>
            <p className="mt-1 text-[11px] text-slate-500">{PRICING.free.blurb}</p>
            <ul className="mt-4 flex-1 space-y-1.5">
              {PLAN_FEATURES.map(f => (
                <li key={f.label} className="flex items-start gap-2 text-[12px]">
                  {f.free
                    ? <Check size={14} className="mt-0.5 shrink-0 text-emerald-400" />
                    : <X size={14} className="mt-0.5 shrink-0 text-slate-600" />}
                  <span className={f.free ? 'text-slate-300' : 'text-slate-600 line-through decoration-slate-700'}>{f.label}</span>
                </li>
              ))}
            </ul>
          </div>

          {/* Pro */}
          <div className="fintech-card relative flex flex-col border-brand-accent/30 p-5">
            <div className="absolute right-4 top-4 rounded-full bg-brand-accent/15 px-2 py-0.5 text-[9px] font-black uppercase tracking-wider text-brand-accent">
              Recommended
            </div>
            <div className="flex items-baseline justify-between">
              <h2 className="text-sm font-bold uppercase tracking-wider text-white">{PRICING.pro.name}</h2>
              {isPro && <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-[9px] font-bold uppercase text-emerald-300">Active</span>}
            </div>
            <div className="mt-2 font-mono text-3xl font-black text-white">
              ${PRICING.pro.price} <span className="text-xs font-normal text-slate-500">/ {PRICING.pro.period}</span>
            </div>
            <p className="mt-1 text-[11px] text-slate-500">
              {PRICING.pro.blurb} · ${PRICING.pro.annual}/yr (2 months free)
            </p>
            <ul className="mt-4 flex-1 space-y-1.5">
              {PLAN_FEATURES.map(f => (
                <li key={f.label} className="flex items-start gap-2 text-[12px]">
                  <Check size={14} className="mt-0.5 shrink-0 text-emerald-400" />
                  <span className="text-slate-300">{f.label}</span>
                </li>
              ))}
            </ul>
            {!isPro && (
              <button
                onClick={startCheckout}
                className="mt-4 w-full rounded-lg bg-brand-accent py-2 text-xs font-bold text-white hover:bg-brand-accent/90"
              >
                {checkoutHref ? 'Start Pro - secure checkout' : 'Request Pro access'}
              </button>
            )}
          </div>
        </div>

        {/* License activation (Lemon Squeezy) */}
        <div className="mt-6 fintech-card p-5">
          <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-slate-400">
            <KeyRound size={14} className="text-brand-accent" /> Already purchased?
          </div>
          <p className="mt-1 text-[11px] text-slate-500">
            Paste the license key from your Lemon Squeezy receipt to unlock Pro on this account.
          </p>
          <div className="mt-3 flex flex-col gap-2 sm:flex-row">
            <input
              value={lic}
              onChange={e => setLic(e.target.value)}
              placeholder="XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX"
              spellCheck={false}
              autoComplete="off"
              className="flex-1 rounded-lg border border-white/10 bg-black/40 px-3 py-2 font-mono text-xs text-slate-200 outline-none focus:border-brand-accent/50"
            />
            <button
              onClick={submitLicense}
              disabled={licBusy || !lic.trim()}
              className="flex items-center justify-center gap-2 rounded-lg bg-brand-accent px-4 py-2 text-xs font-bold text-white hover:bg-brand-accent/90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {licBusy ? <Loader2 size={14} className="animate-spin" /> : <KeyRound size={14} />} Activate
            </button>
          </div>
          {licMsg && (
            <div className={`mt-2 font-mono text-[11px] ${licMsg.ok ? 'text-emerald-400' : 'text-rose-400'}`}>
              {licMsg.text}
            </div>
          )}
        </div>

        {/* Referral / partner venues */}
        {REFERRALS.length > 0 && (
          <div className="mt-6 fintech-card p-5">
            <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-slate-400">
              <Gift size={14} className="text-brand-accent" /> Start trading
            </div>
            <p className="mt-1 text-[11px] text-slate-500">
              Trade on a venue with deep liquidity. Signing up through these links supports the desk at no extra cost.
            </p>
            <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-3">
              {REFERRALS.map(r => (
                <a
                  key={r.id}
                  href={r.href}
                  target="_blank"
                  rel="noopener noreferrer nofollow sponsored"
                  className="flex items-center justify-between rounded-lg border border-white/10 px-3 py-2.5 text-xs font-semibold text-slate-200 hover:bg-white/5"
                >
                  <span className="flex flex-col">
                    <span>{r.name}</span>
                    <span className="text-[10px] font-normal text-slate-500">{r.blurb}</span>
                  </span>
                  <ExternalLink size={12} className="text-slate-500" />
                </a>
              ))}
            </div>
          </div>
        )}

        <div className="mt-6 flex items-center justify-center gap-2 text-[10px] text-slate-600">
          <ShieldCheck size={12} /> Secure checkout via Lemon Squeezy · cancel anytime · instant access with your license key
        </div>
      </div>
    </div>
  );
};

export default PricingPage;
