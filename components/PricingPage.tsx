import React, { useEffect, useRef, useState } from 'react';
import { Check, Sparkles, CreditCard, ShieldCheck, ExternalLink, KeyRound, Loader2, Users, Gift, Lock } from 'lucide-react';
import { useStore } from '../store';
import {
  PLAN_FEATURES, PLAN_LABEL, PRICING, PORTAL_URL, ANNUAL_CHECKOUT_AVAILABLE, isAdminEmail, buildCheckoutUrl, PAYWALL_ENABLED, type Plan,
} from '../utils/entitlements';

const env = (k: string): string => (import.meta as any).env?.[k] || '';

const REFERRALS = [
  { id: 'binance', name: 'Binance', blurb: 'USDM perps · deepest liquidity', href: env('VITE_REFERRAL_BINANCE') },
  { id: 'bybit', name: 'Bybit', blurb: 'Perps + options', href: env('VITE_REFERRAL_BYBIT') },
  { id: 'okx', name: 'OKX', blurb: 'Perps + spot', href: env('VITE_REFERRAL_OKX') },
].filter(r => !!r.href);

const TIERS: Plan[] = ['free', 'starter', 'pro', 'team'];
const LABEL = PLAN_LABEL;

const PricingPage: React.FC = () => {
  const user = useStore(s => s.auth.user);
  const plan = useStore(s => s.auth.plan);
  const status = useStore(s => s.auth.subStatus);
  const renewsAt = useStore(s => s.auth.subRenewsAt);
  const previewAsUser = useStore(s => s.auth.previewAsUser);
  const trialUsed = useStore(s => s.auth.trialUsed);
  const trialUntil = useStore(s => s.auth.trialUntil);
  const activateLicense = useStore(s => s.activateLicense);
  const startTrial = useStore(s => s.startTrial);
  const setActiveTab = useStore(s => s.setActiveTab);
  const [billing, setBilling] = useState<'month' | 'year'>('month');
  const [lic, setLic] = useState('');
  const [licBusy, setLicBusy] = useState(false);
  const [licMsg, setLicMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const admin = isAdminEmail(user?.email);
  const renewLabel = renewsAt ? new Date(renewsAt).toLocaleDateString() : null;

  const linkFor = (tier: Exclude<Plan, 'free'>) =>
    buildCheckoutUrl({ email: user?.email, userId: user?.uid }, tier, billing === 'year');

  const startCheckout = (tier: Exclude<Plan, 'free'>) => {
    const href = linkFor(tier);
    if (!href) { window.location.href = '/contact?topic=billing'; return; }
    window.open(href, '_blank', 'noopener,noreferrer');
  };

  const submitLicense = async () => {
    setLicBusy(true);
    setLicMsg(null);
    const r = await activateLicense(lic);
    setLicBusy(false);
    setLicMsg(r.ok ? { ok: true, text: 'License activated.' } : { ok: false, text: r.error || 'Activation failed.' });
    if (r.ok) {
      setLic('');
      if (window.location.search) {
        window.history.replaceState(null, '', window.location.pathname);
      }
    }
  };

  // Post-checkout: Lemon Squeezy can return the buyer with a licence key in the
  // query string. If one is present, activate it automatically; if the return
  // only carries a success flag, prompt for the key from the receipt.
  const autoRan = useRef(false);
  useEffect(() => {
    if (autoRan.current) return;
    autoRan.current = true;
    const sp = new URLSearchParams(window.location.search);
    const key = (sp.get('license_key') || sp.get('license') || sp.get('key') || '').trim();
    const success = sp.get('checkout') === 'success' || sp.get('status') === 'success';
    if (key) {
      setLic(key);
      setLicBusy(true);
      activateLicense(key).then(r => {
        setLicBusy(false);
        setLicMsg(r.ok
          ? { ok: true, text: 'License detected and activated.' }
          : { ok: false, text: r.error || 'Activation failed — paste the key below.' });
        if (r.ok) window.history.replaceState(null, '', window.location.pathname);
      });
    } else if (success) {
      setLicMsg({ ok: true, text: 'Payment received. Paste the licence key from your receipt to activate instantly.' });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const priceLabel = (tier: Plan) => {
    if (tier === 'free') return { big: '$0', small: 'forever' };
    const p = PRICING[tier];
    return billing === 'year'
      ? { big: `$${p.annual}`, small: 'per year' }
      : { big: `$${p.price}`, small: 'per month' };
  };

  return (
    <div className="h-full overflow-y-auto p-5 lg:p-6 pb-28 lg:pb-6">
      <div className="mx-auto max-w-6xl">
        <div className="mb-6 text-center">
          <div className="mb-1 flex items-center justify-center gap-2 text-brand-accent">
            <Sparkles size={16} />
            <span className="text-[10px] font-bold uppercase tracking-[0.2em]">Plans</span>
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-white">Plans &amp; billing</h1>
          <p className="mx-auto mt-1 max-w-xl text-sm text-slate-400">
            Core data stays free. Starter adds order flow and whales; Pro adds every desk.
          </p>
          <div className="mt-4 inline-flex rounded-lg border border-white/10 bg-black/30 p-0.5">
            {(['month', 'year'] as const).map(b => {
              const disabled = b === 'year' && !ANNUAL_CHECKOUT_AVAILABLE;
              return (
                <button key={b} onClick={() => !disabled && setBilling(b)}
                  disabled={disabled}
                  title={disabled ? 'Annual checkout is not configured yet' : undefined}
                  className={`rounded-md px-3 py-1.5 text-[11px] font-bold uppercase tracking-wider ${
                    billing === b ? 'bg-brand-accent/20 text-brand-accent' : 'text-slate-500 hover:text-slate-300'} disabled:cursor-not-allowed disabled:opacity-40`}>
                  {b === 'month' ? 'Monthly' : ANNUAL_CHECKOUT_AVAILABLE ? 'Annual · save ~20%' : 'Annual · soon'}
                </button>
              );
            })}
          </div>
        </div>

        <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-white/10 bg-white/[0.02] p-4">
          <div>
            <div className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Current plan</div>
            <div className="mt-0.5 flex items-center gap-2">
              <span className="font-mono text-lg font-black text-white">{LABEL[plan].toUpperCase()}</span>
              <span className={`rounded px-1.5 py-0.5 text-[9px] font-bold uppercase ${plan === 'free' ? 'bg-slate-500/15 text-slate-400' : 'bg-emerald-500/15 text-emerald-300'}`}>
                {admin && !previewAsUser ? 'admin' : status}
              </span>
            </div>
            {renewLabel && plan !== 'free' && <div className="mt-1 font-mono text-[10px] text-slate-500">Renews {renewLabel}</div>}
          </div>
          {plan !== 'free' && PORTAL_URL && (
            <a href={PORTAL_URL} target="_blank" rel="noopener noreferrer"
              className="flex items-center gap-2 rounded-lg border border-white/10 px-3 py-1.5 text-[11px] text-slate-200 hover:bg-white/5">
              <CreditCard size={13} /> Manage billing <ExternalLink size={10} />
            </a>
          )}
        </div>

        {PAYWALL_ENABLED && plan === 'free' && !trialUsed && (
          <div className="mb-4 flex flex-col gap-3 rounded-xl border border-brand-accent/30 bg-brand-accent/[0.07] p-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <div className="text-sm font-bold text-white">Try every desk for 15 minutes</div>
              <p className="text-[11px] text-slate-400">One demo per session, no card. Then pick a plan.</p>
            </div>
            <button onClick={() => { startTrial(15); setActiveTab('dashboard'); }}
              className="rounded-lg bg-brand-accent px-4 py-2 text-xs font-bold text-white hover:bg-brand-accent/90">Start demo</button>
          </div>
        )}
        {(trialUntil || trialUsed) && plan === 'free' && (
          <div className="mb-4 rounded-lg border border-white/10 bg-white/[0.02] p-2.5 font-mono text-[10px] text-slate-500">
            {trialUntil && trialUntil > Date.now()
              ? `Demo active · ${Math.max(1, Math.ceil((trialUntil - Date.now()) / 60000))} min left`
              : 'Demo used. Paid desks stay unlocked after purchase.'}
          </div>
        )}

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {TIERS.map(tier => {
            const p = PRICING[tier];
            const active = plan === tier;
            const price = priceLabel(tier);
            return (
              <div key={tier} className={`premium-card flex flex-col p-4 ${tier === 'pro' ? 'border-brand-accent/40' : ''}`}>
                <div className="flex items-center justify-between">
                  <h2 className="text-[12px] font-bold uppercase tracking-wider text-white">{LABEL[tier]}</h2>
                  {tier === 'pro' && <span className="rounded-full bg-brand-accent/15 px-2 py-0.5 text-[8px] font-black uppercase tracking-wider text-brand-accent">Best value</span>}
                  {active && <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-[8px] font-bold uppercase text-emerald-300">Current</span>}
                </div>
                <div className="mt-2 flex items-baseline gap-1">
                  <span className="font-mono text-3xl font-black text-white">{price.big}</span>
                  <span className="text-[10px] text-slate-500">{price.small}</span>
                </div>
                <p className="mt-1 min-h-[30px] text-[11px] text-slate-500">{p.blurb}</p>
                <ul className="mt-3 flex-1 space-y-1.5">
                  {PLAN_FEATURES.filter(f => f[tier]).map(f => (
                    <li key={f.label} className="flex items-start gap-1.5 text-[11px] text-slate-300">
                      <Check size={12} className="mt-0.5 shrink-0 text-emerald-400" /> {f.label}
                    </li>
                  ))}
                </ul>
                {tier !== 'team' && (() => {
                  const next = (tier === 'free' ? 'starter' : tier === 'starter' ? 'pro' : 'team') as Exclude<Plan, 'free'>;
                  const adds = PLAN_FEATURES.filter(f => f[next] && !f[tier]).slice(0, 2);
                  return adds.length > 0 ? (
                    <div className="mt-2 rounded-md border border-white/5 bg-white/[0.02] p-2">
                      <div className="mb-1 font-mono text-[8px] uppercase tracking-wider text-slate-500">{LABEL[next]} adds</div>
                      {adds.map(f => (
                        <div key={f.label} className="flex items-start gap-1.5 text-[10px] text-slate-600">
                          <Lock size={10} className="mt-0.5 shrink-0" /> {f.label}
                        </div>
                      ))}
                    </div>
                  ) : null;
                })()}
                {tier === 'free' ? (
                  <button onClick={() => setActiveTab('dashboard')}
                    className="mt-4 w-full rounded-lg border border-white/15 py-2 text-[11px] font-semibold text-white hover:bg-white/5">
                    Open free desk
                  </button>
                ) : tier === 'team' ? (
                  <button onClick={() => startCheckout('team')}
                    className="mt-4 flex w-full items-center justify-center gap-1.5 rounded-lg border border-white/15 py-2 text-[11px] font-semibold text-white hover:bg-white/5">
                    <Users size={12} /> {linkFor('team') ? 'Start Institutional' : 'Talk to us'}
                  </button>
                ) : (
                  <button onClick={() => startCheckout(tier)}
                    className={`mt-4 w-full rounded-lg py-2 text-[11px] font-bold ${tier === 'pro' ? 'bg-brand-accent text-white hover:bg-brand-accent/90' : 'border border-brand-accent/30 bg-brand-accent/10 text-brand-accent hover:bg-brand-accent/20'}`}>
                    {linkFor(tier) ? `Choose ${LABEL[tier]}` : 'Request access'}
                  </button>
                )}
              </div>
            );
          })}
        </div>

        <div className="mt-3 grid grid-cols-1 gap-2 text-[10px] text-slate-500 sm:grid-cols-3">
          <div className="rounded-lg border border-white/5 bg-white/[0.02] p-2.5">Annual billing is roughly 25% off monthly.</div>
          <div className="rounded-lg border border-white/5 bg-white/[0.02] p-2.5">Lemon Squeezy handles tax and invoices as merchant of record.</div>
          <div className="rounded-lg border border-white/5 bg-white/[0.02] p-2.5">Cancel from the billing portal; access runs to period end.</div>
        </div>

        <div className="mt-6 premium-card p-5">
          <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-slate-400">
            <KeyRound size={14} className="text-brand-accent" /> Already purchased?
          </div>
          <p className="mt-1 text-[11px] text-slate-500">Paste the licence key from your receipt. Starter, Pro and Institutional keys are detected automatically.</p>
          <div className="mt-3 flex flex-col gap-2 sm:flex-row">
            <input value={lic} onChange={e => setLic(e.target.value)} placeholder="XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX"
              spellCheck={false} autoComplete="off"
              className="flex-1 rounded-lg border border-white/10 bg-black/40 px-3 py-2 font-mono text-xs text-slate-200 outline-none focus:border-brand-accent/50" />
            <button onClick={submitLicense} disabled={licBusy || !lic.trim()}
              className="flex items-center justify-center gap-2 rounded-lg bg-brand-accent px-4 py-2 text-xs font-bold text-white disabled:opacity-50">
              {licBusy ? <Loader2 size={14} className="animate-spin" /> : <KeyRound size={14} />} Activate
            </button>
          </div>
          {licMsg && <div className={`mt-2 font-mono text-[11px] ${licMsg.ok ? 'text-emerald-400' : 'text-rose-400'}`}>{licMsg.text}</div>}
        </div>

        {REFERRALS.length > 0 && (
          <div className="mt-6 premium-card p-5">
            <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-slate-400">
              <Gift size={14} className="text-brand-accent" /> Start trading
            </div>
            <p className="mt-1 text-[11px] text-slate-500">Partner links support the desk at no extra cost.</p>
            <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-3">
              {REFERRALS.map(r => (
                <a key={r.id} href={r.href} target="_blank" rel="noopener noreferrer nofollow sponsored"
                  className="flex items-center justify-between rounded-lg border border-white/10 px-3 py-2 text-[11px] text-slate-200 hover:bg-white/5">
                  <span>{r.name}<span className="block text-[9px] text-slate-500">{r.blurb}</span></span>
                  <ExternalLink size={11} className="text-slate-500" />
                </a>
              ))}
            </div>
          </div>
        )}

        <div className="mt-6 premium-card p-5">
          <div className="mb-3 text-xs font-bold uppercase tracking-wider text-slate-400">Billing questions</div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {[
              ['Can I cancel anytime?', 'Yes. Cancel from the billing portal; access continues to the end of the paid period. No cancellation fee.'],
              ['Monthly or annual?', 'Annual billing is about 20% cheaper. Monthly is best for testing; annual is best for daily use.'],
              ['What counts as a seat?', 'Every paid plan is one login. Institutional adds team seats, API access and priority support.'],
              ['Do you offer refunds?', 'If the desk is not a fit, contact billing within 7 days of your first payment for a refund.'],
            ].map(([q, a]) => (
              <div key={q} className="rounded-lg border border-white/5 bg-white/[0.02] p-3">
                <div className="text-[11px] font-semibold text-slate-200">{q}</div>
                <p className="mt-1 text-[10px] leading-relaxed text-slate-500">{a}</p>
              </div>
            ))}
          </div>
        </div>

        <div className="mt-6 flex items-center justify-center gap-2 text-[10px] text-slate-600">
          <ShieldCheck size={12} /> Secure checkout via Lemon Squeezy · cancel anytime · not investment advice
        </div>
      </div>
    </div>
  );
};

export default PricingPage;
