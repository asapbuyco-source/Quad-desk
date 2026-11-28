import React, { useState } from 'react';
import { Mail, Send, CheckCircle2, Loader2 } from 'lucide-react';
import { apiFetch } from '../utils/apiClient';

interface Props {
  compact?: boolean;
  source?: string;
}

const NewsletterSignup: React.FC<Props> = ({ compact = false, source = 'landing' }) => {
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setMsg(null);
    try {
      const res = await apiFetch('/newsletter', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, name, consent, source }),
        timeoutMs: 30000,
      });
      const data: any = await res.json().catch(() => ({}));
      if (res.ok) {
        setMsg({ ok: true, text: data.already ? 'You are already on the list.' : 'You are on the list. Check your inbox.' });
        setEmail('');
        setName('');
        setConsent(false);
      } else if (res.status === 503) {
        setMsg({ ok: false, text: 'Newsletter opens as soon as email delivery is verified.' });
      } else {
        setMsg({ ok: false, text: data.error || 'Could not subscribe. Try again.' });
      }
    } catch {
      setMsg({ ok: false, text: 'Could not reach the server. Try again.' });
    } finally {
      setBusy(false);
    }
  };

  if (compact) {
    return (
      <div className="premium-card p-4">
        <div className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-wider text-slate-400">
          <Mail size={13} className="text-brand-accent" /> Market notes
        </div>
        <p className="mt-1 text-[11px] text-slate-500">
          One short email occasionally: funding extremes, liquidation clusters and new boards.
        </p>
        <form onSubmit={submit} className="mt-3 space-y-2">
          <input
            value={email}
            onChange={e => setEmail(e.target.value)}
            type="email"
            required
            placeholder="you@example.com"
            className="w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-xs text-slate-200 outline-none focus:border-brand-accent/50"
          />
          <label className="flex items-start gap-2 text-[10px] text-slate-500">
            <input
              type="checkbox"
              checked={consent}
              onChange={e => setConsent(e.target.checked)}
              required
              className="mt-0.5 accent-blue-500"
            />
            <span>
              I agree to receive occasional market notes.{' '}
              <a href="/privacy" className="text-brand-accent hover:underline">Privacy</a>.
            </span>
          </label>
          <button
            type="submit"
            disabled={busy || !email || !consent}
            className="flex w-full items-center justify-center gap-2 rounded-lg bg-brand-accent py-2 text-[11px] font-bold text-white disabled:opacity-50"
          >
            {busy ? <Loader2 size={12} className="animate-spin" /> : <Send size={12} />} Subscribe
          </button>
        </form>
        {msg && (
          <div className={`mt-2 flex items-start gap-1.5 text-[10px] ${msg.ok ? 'text-emerald-400' : 'text-amber-400'}`}>
            {msg.ok && <CheckCircle2 size={11} className="mt-0.5 shrink-0" />}
            <span>{msg.text}</span>
          </div>
        )}
      </div>
    );
  }

  return (
    <section className="relative z-10 px-4 py-12 sm:px-6 sm:py-16">
      <div className="mx-auto max-w-5xl overflow-hidden rounded-2xl border border-brand-accent/20 bg-gradient-to-br from-brand-accent/[0.09] via-white/[0.02] to-purple-500/[0.06] p-6 sm:p-9">
        <div className="grid gap-6 lg:grid-cols-2 lg:items-center">
          <div>
            <div className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-[0.2em] text-brand-accent">
              <Mail size={14} /> Quant Desk notes
            </div>
            <h2 className="mt-2 text-2xl font-bold tracking-tight text-white sm:text-3xl">
              The market, once in a while.
            </h2>
            <p className="mt-2 max-w-md text-sm text-slate-400">
              A short email when something actually changes: funding extremes, liquidation clusters,
              new boards and plan updates. No daily spam.
            </p>
            <ul className="mt-4 space-y-1.5 text-[12px] text-slate-400">
              <li>• Funding and open-interest extremes worth watching</li>
              <li>• Liquidation clusters and options levels</li>
              <li>• New data boards and occasional plan offers</li>
            </ul>
          </div>
          <form onSubmit={submit} className="rounded-xl border border-white/10 bg-black/40 p-4">
            <div className="grid gap-2 sm:grid-cols-2">
              <input
                value={name}
                onChange={e => setName(e.target.value)}
                placeholder="Name (optional)"
                autoComplete="name"
                className="rounded-lg border border-white/10 bg-black/50 px-3 py-2 text-xs text-slate-200 outline-none focus:border-brand-accent/50"
              />
              <input
                value={email}
                onChange={e => setEmail(e.target.value)}
                type="email"
                required
                placeholder="you@example.com"
                autoComplete="email"
                className="rounded-lg border border-white/10 bg-black/50 px-3 py-2 text-xs text-slate-200 outline-none focus:border-brand-accent/50"
              />
            </div>
            <label className="mt-3 flex items-start gap-2 text-[10px] leading-relaxed text-slate-500">
              <input
                type="checkbox"
                checked={consent}
                onChange={e => setConsent(e.target.checked)}
                required
                className="mt-0.5 accent-blue-500"
              />
              <span>
                I agree to receive occasional market notes and offers. Unsubscribe anytime.{' '}
                <a href="/privacy" className="text-brand-accent hover:underline">Privacy</a>.
              </span>
            </label>
            <button
              type="submit"
              disabled={busy || !email || !consent}
              className="mt-3 flex w-full items-center justify-center gap-2 rounded-lg bg-brand-accent py-2.5 text-xs font-bold text-white hover:bg-brand-accent/90 disabled:opacity-50"
            >
              {busy ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />} Subscribe to notes
            </button>
            {msg && (
              <div className={`mt-2 flex items-start gap-1.5 text-[10px] ${msg.ok ? 'text-emerald-400' : 'text-amber-400'}`}>
                {msg.ok && <CheckCircle2 size={11} className="mt-0.5 shrink-0" />}
                <span>{msg.text}</span>
              </div>
            )}
            <p className="mt-2 text-[9px] text-slate-600">No spam. No daily email. Unsubscribe in one click.</p>
          </form>
        </div>
      </div>
    </section>
  );
};

export default NewsletterSignup;
