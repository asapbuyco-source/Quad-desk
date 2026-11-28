import React from 'react';
import {
  User as UserIcon, CreditCard, KeyRound, Star, Bell, Settings, LogOut,
  ShieldAlert, Sparkles, ExternalLink, ArrowRight,
} from 'lucide-react';
import { useStore } from '../store';
import { PageHeader } from './Premium';
import NewsletterSignup from './NewsletterSignup';
import { PORTAL_URL, upgradeHref, isAdminEmail, PRICING, PLAN_LABEL } from '../utils/entitlements';

const ProfilePage: React.FC = () => {
  const user = useStore(s => s.auth.user);
  const plan = useStore(s => s.auth.plan);
  const status = useStore(s => s.auth.subStatus);
  const renewsAt = useStore(s => s.auth.subRenewsAt);
  const licenseKey = useStore(s => s.auth.licenseKey);
  const previewAsUser = useStore(s => s.auth.previewAsUser);
  const trialUntil = useStore(s => s.auth.trialUntil);
  const watchlist = useStore(s => s.watchlist);
  const priceAlerts = useStore(s => s.priceAlerts);
  const logout = useStore(s => s.logout);
  const setActiveTab = useStore(s => s.setActiveTab);
  const setGuest = useStore(s => s.setGuest);

  const admin = isAdminEmail(user?.email);
  const pro = plan !== 'free' || (admin && !previewAsUser);
  const renew = renewsAt ? new Date(renewsAt).toLocaleDateString() : null;
  const trialLeft = trialUntil && trialUntil > Date.now() ? Math.ceil((trialUntil - Date.now()) / 60000) : 0;
  const activeAlerts = priceAlerts.filter(a => !a.triggeredAt).length;
  const upgrade = upgradeHref({ email: user?.email, userId: user?.uid });

  return (
    <div className="h-full overflow-y-auto p-5 lg:p-6 pb-28 lg:pb-6">
      <div className="mx-auto max-w-3xl space-y-4">
        <PageHeader
          icon={<UserIcon size={16} />}
          title="Profile"
          subtitle="Your account, plan and saved workspace"
        />

        <section className="premium-card p-5">
          <div className="flex flex-wrap items-center gap-4">
            <div className="flex h-14 w-14 items-center justify-center overflow-hidden rounded-2xl bg-gradient-to-tr from-brand-accent to-purple-500 text-xl font-black text-white">
              {user?.photoURL
                ? <img src={user.photoURL} alt="" className="h-full w-full object-cover" />
                : (user?.displayName?.charAt(0) || user?.email?.charAt(0) || 'Q')}
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-base font-bold text-white">{user?.displayName || 'Quant Desk member'}</div>
              <div className="truncate font-mono text-[11px] text-slate-400">{user?.email || '—'}</div>
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                <span className={`rounded px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider ${
                  pro ? 'bg-emerald-500/15 text-emerald-300' : 'bg-slate-500/15 text-slate-400'}`}>
                  {admin && !previewAsUser ? 'Admin' : PLAN_LABEL[plan]}
                </span>
                {admin && <span className="rounded bg-rose-500/15 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-rose-300">Admin</span>}
                {!user && <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-amber-300">Guest</span>}
                {trialLeft > 0 && <span className="rounded bg-brand-accent/15 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-brand-accent">Demo · {trialLeft}m</span>}
              </div>
            </div>
            {!pro && upgrade && (
              <a href={upgrade} target="_blank" rel="noopener noreferrer"
                className="flex items-center gap-1.5 rounded-lg bg-brand-accent px-3 py-2 text-[11px] font-bold text-white hover:bg-brand-accent/90">
                <Sparkles size={13} /> Upgrade <ExternalLink size={10} />
              </a>
            )}
          </div>
        </section>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <section className="premium-card p-5">
            <div className="mb-3 flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-slate-400">
              <CreditCard size={14} className="text-brand-accent" /> Plan
            </div>
            <div className="flex items-baseline justify-between">
              <span className="font-mono text-2xl font-black text-white">{admin && !previewAsUser ? 'ADMIN' : PLAN_LABEL[plan].toUpperCase()}</span>
              <span className="text-[10px] text-slate-500">{admin && !previewAsUser ? 'admin access' : status}</span>
            </div>
            <div className="mt-2 space-y-1 text-[11px] text-slate-400">
              <div>Price: {pro ? `$${PRICING[plan].price}/mo` : '$0 forever'}</div>
              {renew && pro && <div>Renews: {renew}</div>}
              <div className="truncate">License: {licenseKey ? `${licenseKey.slice(0, 4)}••••${licenseKey.slice(-4)}` : 'none'}</div>
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              {PORTAL_URL && pro && (
                <a href={PORTAL_URL} target="_blank" rel="noopener noreferrer"
                  className="rounded-lg border border-white/10 px-3 py-1.5 text-[11px] text-slate-200 hover:bg-white/5">
                  Manage billing
                </a>
              )}
              <button onClick={() => setActiveTab('pricing')}
                className="rounded-lg border border-white/10 px-3 py-1.5 text-[11px] text-slate-300 hover:bg-white/5">
                {pro ? 'View plans' : 'See plans'}
              </button>
            </div>
          </section>

          <section className="premium-card p-5">
            <div className="mb-3 flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-slate-400">
              <Star size={14} className="text-brand-accent" /> Workspace
            </div>
            <div className="space-y-2 text-[11px]">
              <div className="flex items-center justify-between">
                <span className="text-slate-400">Watchlist</span>
                <span className="font-mono text-slate-200">{watchlist.length} symbols</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-slate-400">Active alerts</span>
                <span className="font-mono text-slate-200">{activeAlerts} / {pro ? '∞' : 3}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-slate-400">Saved alerts</span>
                <span className="font-mono text-slate-200">{priceAlerts.length}</span>
              </div>
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              <button onClick={() => setActiveTab('watchlist')}
                className="flex items-center gap-1 rounded-lg border border-white/10 px-3 py-1.5 text-[11px] text-slate-200 hover:bg-white/5">
                <Bell size={11} /> Alerts
              </button>
              <button onClick={() => setActiveTab('settings')}
                className="flex items-center gap-1 rounded-lg border border-white/10 px-3 py-1.5 text-[11px] text-slate-200 hover:bg-white/5">
                <Settings size={11} /> Settings
              </button>
            </div>
          </section>
        </div>

        <NewsletterSignup compact source="profile" />

        {admin && (
          <section className="premium-card p-5">
            <div className="mb-2 flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-slate-400">
              <ShieldAlert size={14} className="text-rose-400" /> Admin
            </div>
            <button onClick={() => setActiveTab('admin-users')}
              className="flex w-full items-center justify-between rounded-lg border border-white/10 px-3 py-2 text-[11px] text-slate-200 hover:bg-white/5">
              Manage users and plans <ArrowRight size={12} className="text-brand-accent" />
            </button>
          </section>
        )}

        <section className="premium-card p-5">
          <div className="mb-3 flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-slate-400">
            <KeyRound size={14} className="text-slate-500" /> Account
          </div>
          <div className="flex flex-wrap gap-2">
            {!user && (
              <button onClick={() => setGuest(false)}
                className="flex items-center gap-1.5 rounded-lg bg-brand-accent px-3 py-1.5 text-[11px] font-bold text-white hover:bg-brand-accent/90">
                Sign in / create account
              </button>
            )}
            <button onClick={() => logout()}
              className="flex items-center gap-1.5 rounded-lg border border-rose-500/30 px-3 py-1.5 text-[11px] text-rose-300 hover:bg-rose-500/10">
              <LogOut size={13} /> Sign out
            </button>
            <a href="/privacy" className="rounded-lg border border-white/10 px-3 py-1.5 text-[11px] text-slate-300 hover:bg-white/5">Privacy</a>
            <a href="/terms" className="rounded-lg border border-white/10 px-3 py-1.5 text-[11px] text-slate-300 hover:bg-white/5">Terms</a>
          </div>
        </section>
      </div>
    </div>
  );
};

export default ProfilePage;
