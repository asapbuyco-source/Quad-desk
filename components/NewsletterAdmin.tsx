import React, { useEffect, useMemo, useState } from 'react';
import { Mail, Send, Sparkles, Loader2, RefreshCw, AlertTriangle, CheckCircle2, Clock } from 'lucide-react';
import { useStore } from '../store';
import { adminFetch } from '../utils/apiClient';
import { cachedJson } from '../utils/cachedFetch';
import { isAdminEmail } from '../utils/entitlements';
import { PageHeader } from './Premium';

const usd = (n: number) => `$${Math.round(n).toLocaleString()}`;
const pct = (n: number) => `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;

const NewsletterAdmin: React.FC = () => {
  const user = useStore(s => s.auth.user);
  const admin = isAdminEmail(user?.email);
  const [subject, setSubject] = useState('');
  const [message, setMessage] = useState('');
  const [schedule, setSchedule] = useState('');
  const [testEmail, setTestEmail] = useState(user?.email || '');
  const [stats, setStats] = useState<any>(null);
  const [busy, setBusy] = useState<'snapshot' | 'test' | 'send' | null>(null);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [preview, setPreview] = useState(false);

  const loadStats = async () => {
    try {
      const res = await adminFetch('/admin/newsletter/stats', { timeoutMs: 30000 });
      setStats(await res.json());
    } catch {
      setStats({ configured: false });
    }
  };

  useEffect(() => {
    if (admin) loadStats();
  }, [admin]);

  useEffect(() => {
    if (user?.email) setTestEmail(user.email);
  }, [user?.email]);

  const configured = !!stats?.configured;
  const count = stats?.count;

  const fillSnapshot = async () => {
    setBusy('snapshot');
    setResult(null);
    try {
      const [btc, eth, heat, liq, news] = await Promise.all([
        cachedJson<any>('/coin-futures?symbol=BTCUSDT', { ttlMs: 120000, timeoutMs: 45000 }).catch(() => null),
        cachedJson<any>('/coin-futures?symbol=ETHUSDT', { ttlMs: 120000, timeoutMs: 45000 }).catch(() => null),
        cachedJson<any>('/funding-heatmap', { ttlMs: 180000, timeoutMs: 45000 }).catch(() => null),
        cachedJson<any>('/liquidations?minutes=1440&limit=1', { ttlMs: 180000, timeoutMs: 45000 }).catch(() => null),
        cachedJson<any>('/headlines?symbol=BTCUSDT', { ttlMs: 300000, timeoutMs: 30000 }).catch(() => null),
      ]);
      const lines: string[] = [];
      lines.push(`Market snapshot — ${new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}`);
      if (btc) {
        lines.push(
          `BTC $${Number(btc.price || 0).toLocaleString()} · 24h ${pct(Number(btc.price_change_24h ?? 0))}`
          + ` · funding ${Number(btc.funding_rate ?? 0).toFixed(4)}% · OI ${usd(Number(btc.oi_usd || 0))}`
        );
      }
      if (eth) {
        lines.push(
          `ETH $${Number(eth.price || 0).toLocaleString()} · 24h ${pct(Number(eth.price_change_24h ?? 0))}`
          + ` · funding ${Number(eth.funding_rate ?? 0).toFixed(4)}%`
        );
      }
      if (heat?.highest?.length) {
        lines.push(`Crowded longs (funding): ${heat.highest.slice(0, 3).map((r: any) => `${String(r.symbol).replace('USDT', '')} ${Number(r.funding_rate).toFixed(3)}%`).join(' · ')}`);
      }
      if (heat?.lowest?.length) {
        lines.push(`Crowded shorts (funding): ${heat.lowest.slice(0, 3).map((r: any) => `${String(r.symbol).replace('USDT', '')} ${Number(r.funding_rate).toFixed(3)}%`).join(' · ')}`);
      }
      if (liq?.totals) {
        lines.push(`24h liquidations: ${usd(liq.totals.long_usd || 0)} longs · ${usd(liq.totals.short_usd || 0)} shorts · ${liq.totals.count || 0} forced orders`);
      }
      if (news?.articles?.length) {
        lines.push('Headlines:');
        news.articles.slice(0, 3).forEach((a: any) => lines.push(`- ${a.title} (${a.source || 'news'})`));
      }
      lines.push('Open the desk: https://quantdeskterminal.com');
      setSubject(`Quant Desk market note — ${new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}`);
      setMessage(lines.join('\n'));
      setResult({ ok: true, text: 'Snapshot filled from live data. Edit before sending.' });
    } catch {
      setResult({ ok: false, text: 'Could not build the snapshot. Write the note manually.' });
    } finally {
      setBusy(null);
    }
  };

  const sendTest = async () => {
    if (!subject.trim() || !message.trim()) {
      setResult({ ok: false, text: 'Add a subject and message first.' });
      return;
    }
    setBusy('test');
    setResult(null);
    try {
      const res = await adminFetch('/admin/newsletter/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: testEmail, subject, message }),
        timeoutMs: 45000,
      });
      const data: any = await res.json().catch(() => ({}));
      setResult(res.ok ? { ok: true, text: `Test sent to ${testEmail}.` } : { ok: false, text: data.error || 'Test failed.' });
    } catch {
      setResult({ ok: false, text: 'Could not send the test.' });
    } finally {
      setBusy(null);
    }
  };

  const sendBroadcast = async () => {
    if (!subject.trim() || message.trim().length < 20) {
      setResult({ ok: false, text: 'Subject and a message of at least 20 characters are required.' });
      return;
    }
    const when = schedule ? new Date(schedule) : null;
    if (when && when.getTime() < Date.now() + 60000) {
      setResult({ ok: false, text: 'Choose a schedule at least a minute in the future.' });
      return;
    }
    const label = when ? `scheduled for ${when.toLocaleString()}` : `sent now to ${count ?? 'all'} subscribers`;
    if (!window.confirm(`Send "${subject}" — ${label}?`)) return;

    setBusy('send');
    setResult(null);
    try {
      const res = await adminFetch('/admin/newsletter/broadcast', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subject, message, scheduled_at: when ? when.toISOString() : '' }),
        timeoutMs: 60000,
      });
      const data: any = await res.json().catch(() => ({}));
      if (res.ok) {
        setResult({ ok: true, text: data.scheduled ? 'Broadcast scheduled.' : 'Broadcast sent.' });
        setSubject('');
        setMessage('');
        setSchedule('');
        loadStats();
      } else {
        setResult({ ok: false, text: data.error || 'Broadcast failed.' });
      }
    } catch {
      setResult({ ok: false, text: 'Could not send the broadcast.' });
    } finally {
      setBusy(null);
    }
  };

  const previewHtml = useMemo(
    () => message.split(/\n{2,}/).map((p, i) => (
      <p key={i} className="mb-3 whitespace-pre-wrap text-sm leading-relaxed text-slate-300">{p}</p>
    )),
    [message]
  );

  if (!admin) return <div className="p-6 text-sm text-slate-400">Admin only.</div>;

  return (
    <div className="h-full overflow-y-auto p-5 lg:p-6 pb-28 lg:pb-6">
      <div className="mx-auto max-w-5xl">
        <PageHeader
          icon={<Mail size={16} />}
          title="Newsletter"
          badge="ADMIN"
          subtitle="Send a market note or promo to everyone who subscribed. Test first, then broadcast."
          live
        />

        <div className="mb-3 grid grid-cols-1 gap-2 sm:grid-cols-3">
          <div className="premium-card p-3">
            <div className="text-[9px] font-bold uppercase tracking-wider text-slate-500">Audience</div>
            <div className="mt-0.5 font-mono text-xl font-black text-white">{configured ? (count ?? '—') : 'Not set'}</div>
            <div className="font-mono text-[9px] text-slate-600">{configured ? 'Resend contacts' : 'Add RESEND_AUDIENCE_ID'}</div>
          </div>
          <div className="premium-card p-3">
            <div className="text-[9px] font-bold uppercase tracking-wider text-slate-500">Sender</div>
            <div className="mt-0.5 truncate font-mono text-[11px] text-slate-300">{stats?.from || 'support@quantdeskterminal.com'}</div>
            <div className="font-mono text-[9px] text-slate-600">verified Resend domain</div>
          </div>
          <div className="premium-card p-3">
            <div className="text-[9px] font-bold uppercase tracking-wider text-slate-500">Delivery</div>
            <div className="mt-0.5 font-mono text-xl font-black text-white">{configured ? 'Ready' : 'Setup'}</div>
            <div className="font-mono text-[9px] text-slate-600">unsubscribe handled by Resend</div>
          </div>
        </div>

        {!configured && (
          <div className="mb-3 flex items-start gap-2 rounded-lg border border-amber-500/20 bg-amber-500/[0.06] p-3 text-[11px] text-amber-300">
            <AlertTriangle size={13} className="mt-0.5 shrink-0" />
            <span>
              Set <span className="font-mono">RESEND_API_KEY</span> and <span className="font-mono">RESEND_AUDIENCE_ID</span> on Render,
              then verify the domain in Resend. Subscribers are stored as Resend contacts.
            </span>
          </div>
        )}

        <div className="grid grid-cols-1 gap-3 lg:grid-cols-5">
          <div className="premium-card p-4 lg:col-span-3">
            <div className="mb-2 flex items-center justify-between">
              <div className="text-[11px] font-bold uppercase tracking-wider text-slate-400">Compose</div>
              <button
                onClick={fillSnapshot}
                disabled={busy !== null}
                className="flex items-center gap-1.5 rounded-md border border-brand-accent/30 bg-brand-accent/10 px-2 py-1 text-[10px] font-bold text-brand-accent hover:bg-brand-accent/20 disabled:opacity-50"
              >
                {busy === 'snapshot' ? <Loader2 size={11} className="animate-spin" /> : <Sparkles size={11} />} Market snapshot
              </button>
            </div>
            <label className="text-[9px] font-bold uppercase tracking-wider text-slate-500">Subject</label>
            <input
              value={subject}
              onChange={e => setSubject(e.target.value)}
              maxLength={140}
              placeholder="Quant Desk market note — funding is crowded"
              className="mt-1 w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-xs text-slate-200 outline-none focus:border-brand-accent/50"
            />
            <label className="mt-3 block text-[9px] font-bold uppercase tracking-wider text-slate-500">Message</label>
            <textarea
              value={message}
              onChange={e => setMessage(e.target.value)}
              rows={14}
              maxLength={20000}
              placeholder="Write the note. Blank lines become paragraphs. The unsubscribe link is added automatically."
              className="mt-1 w-full resize-y rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-xs leading-relaxed text-slate-200 outline-none focus:border-brand-accent/50"
            />
            <div className="mt-2 flex items-center justify-between font-mono text-[9px] text-slate-600">
              <span>{message.length.toLocaleString()} / 20,000</span>
              <button onClick={() => setPreview(v => !v)} className="text-brand-accent hover:underline">
                {preview ? 'Edit' : 'Preview'}
              </button>
            </div>
          </div>

          <div className="space-y-3 lg:col-span-2">
            <div className="premium-card p-4">
              <div className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-slate-400">
                <Clock size={12} /> Schedule
              </div>
              <input
                type="datetime-local"
                value={schedule}
                onChange={e => setSchedule(e.target.value)}
                className="mt-2 w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-xs text-slate-200 outline-none focus:border-brand-accent/50"
              />
              <p className="mt-1 text-[9px] text-slate-600">Leave empty to send immediately. Scheduled sends use Resend.</p>
            </div>
            <div className="premium-card p-4">
              <div className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-slate-400">
                <Send size={12} /> Test
              </div>
              <input
                value={testEmail}
                onChange={e => setTestEmail(e.target.value)}
                type="email"
                placeholder="you@example.com"
                className="mt-2 w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-xs text-slate-200 outline-none focus:border-brand-accent/50"
              />
              <button
                onClick={sendTest}
                disabled={busy !== null || !configured}
                className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-lg border border-white/15 py-2 text-[11px] font-bold text-white hover:bg-white/5 disabled:opacity-40"
              >
                {busy === 'test' ? <Loader2 size={12} className="animate-spin" /> : <Send size={12} />} Send test
              </button>
            </div>
            <div className="premium-card p-4">
              <div className="text-[11px] font-bold uppercase tracking-wider text-slate-400">Broadcast</div>
              <p className="mt-1 text-[10px] text-slate-500">Goes to every subscribed contact. Unsubscribe is automatic.</p>
              <button
                onClick={sendBroadcast}
                disabled={busy !== null || !configured}
                className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-lg bg-brand-accent py-2.5 text-[11px] font-bold text-white hover:bg-brand-accent/90 disabled:opacity-40"
              >
                {busy === 'send' ? <Loader2 size={12} className="animate-spin" /> : <Send size={12} />} {schedule ? 'Schedule broadcast' : 'Send broadcast'}
              </button>
              <button
                onClick={loadStats}
                disabled={busy !== null}
                className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-lg border border-white/10 py-1.5 text-[10px] text-slate-400 hover:bg-white/5 disabled:opacity-40"
              >
                <RefreshCw size={10} /> Refresh audience
              </button>
            </div>
          </div>
        </div>

        {result && (
          <div className={`mt-3 flex items-start gap-2 rounded-lg border p-3 text-[11px] ${result.ok ? 'border-emerald-500/20 bg-emerald-500/[0.06] text-emerald-300' : 'border-rose-500/20 bg-rose-500/[0.06] text-rose-300'}`}>
            {result.ok ? <CheckCircle2 size={13} className="mt-0.5 shrink-0" /> : <AlertTriangle size={13} className="mt-0.5 shrink-0" />}
            {result.text}
          </div>
        )}

        {preview && (
          <div className="mt-3 premium-card p-5">
            <div className="mb-3 flex items-center justify-between border-b border-white/5 pb-2">
              <div className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Email preview</div>
              <span className="font-mono text-[9px] text-slate-600">{subject || 'No subject'}</span>
            </div>
            {previewHtml}
            <div className="mt-4 border-t border-white/5 pt-2 text-[10px] text-slate-600">
              Quant Desk · quantdeskterminal.com · Unsubscribe
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default NewsletterAdmin;
