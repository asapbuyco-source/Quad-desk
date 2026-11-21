import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Users, RefreshCw, Search, ShieldAlert, Sparkles, KeyRound, Ban } from 'lucide-react';
import { collection, getDocs, limit, query, doc, setDoc } from 'firebase/firestore';
import { db } from '../lib/firebase';
import { useStore } from '../store';
import { isAdminEmail } from '../utils/entitlements';
import { PageHeader, EmptyState } from './Premium';

interface Row {
  uid: string;
  email?: string;
  displayName?: string;
  plan: 'free' | 'pro';
  status?: string;
  renewsAt?: string | null;
  licenseKey?: string | null;
  source?: string;
}

const thirtyDays = () => new Date(Date.now() + 30 * 86400000).toISOString();
const fmtDate = (v?: string | null) => {
  if (!v) return '—';
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString();
};

const AdminUsers: React.FC = () => {
  const user = useStore(s => s.auth.user);
  const admin = isAdminEmail(user?.email);
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const snap = await getDocs(query(collection(db, 'users'), limit(300)));
      const list: Row[] = snap.docs.map(d => {
        const v: any = d.data() || {};
        const sub = v.subscription || {};
        return {
          uid: d.id,
          email: v.email || v.profile?.email,
          displayName: v.displayName || v.profile?.displayName,
          plan: sub.plan === 'pro' ? 'pro' : 'free',
          status: sub.status || 'inactive',
          renewsAt: sub.renewsAt || null,
          licenseKey: v.licenseKey || null,
          source: sub.source,
        };
      });
      list.sort((a, b) => (a.email || a.uid).localeCompare(b.email || b.uid));
      setRows(list);
    } catch (e: any) {
      setError(e?.code === 'permission-denied'
        ? 'Firestore rules blocked the user list. Deploy the updated firestore.rules (admin read/write on /users).'
        : e?.message || 'Could not load users');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { if (admin) load(); }, [admin, load]);

  const apply = async (row: Row, kind: 'pro30' | 'pro' | 'free' | 'revoke') => {
    setBusy(row.uid);
    setError(null);
    setNotice(null);
    const sub = kind === 'free' || kind === 'revoke'
      ? { plan: 'free', status: 'inactive', renewsAt: null, source: 'admin_ui' }
      : { plan: 'pro', status: 'active', renewsAt: kind === 'pro30' ? thirtyDays() : null, source: 'admin_ui' };
    try {
      await setDoc(doc(db, 'users', row.uid), {
        ...(kind === 'revoke' ? { licenseKey: null } : {}),
        subscription: sub,
      }, { merge: true });
      setRows(rs => rs.map(r => r.uid === row.uid
        ? { ...r, plan: sub.plan as 'free' | 'pro', status: sub.status, renewsAt: sub.renewsAt, licenseKey: kind === 'revoke' ? null : r.licenseKey }
        : r));
      setNotice(`${row.email || row.uid} → ${kind === 'free' || kind === 'revoke' ? 'Free' : 'Pro'} saved. They get it on next sign-in/reload.`);
    } catch (e: any) {
      setError(e?.code === 'permission-denied'
        ? 'Write blocked by Firestore rules. Deploy the updated firestore.rules.'
        : e?.message || 'Update failed');
    } finally {
      setBusy(null);
    }
  };

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return rows;
    return rows.filter(r =>
      (r.email || '').toLowerCase().includes(needle) ||
      (r.displayName || '').toLowerCase().includes(needle) ||
      r.uid.toLowerCase().includes(needle));
  }, [rows, q]);

  const proCount = rows.filter(r => r.plan === 'pro').length;

  if (!admin) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <div className="fintech-card max-w-md p-6 text-center">
          <ShieldAlert size={22} className="mx-auto mb-3 text-rose-400" />
          <h2 className="text-base font-bold text-white">Admin only</h2>
          <p className="mt-2 text-xs text-slate-400">This user manager is restricted to administrator accounts.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto p-5 lg:p-6 pb-28 lg:pb-6">
      <div className="mx-auto max-w-6xl">
        <PageHeader
          icon={<Users size={16} />}
          title="Users"
          badge="ADMIN"
          subtitle="Grant or revoke Pro access. Changes apply on the user's next sign-in or reload."
        >
          <div className="relative">
            <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500" />
            <input
              value={q}
              onChange={e => setQ(e.target.value)}
              placeholder="Search email or uid"
              className="w-56 rounded-lg border border-white/10 bg-black/40 py-1.5 pl-8 pr-3 text-xs text-slate-200 outline-none focus:border-brand-accent/50"
            />
          </div>
          <button onClick={load} disabled={loading}
            className="flex items-center gap-2 rounded-lg border border-white/10 px-3 py-1.5 text-xs text-slate-300 hover:bg-white/5 disabled:opacity-50">
            <RefreshCw size={13} className={loading ? 'animate-spin' : ''} /> Refresh
          </button>
        </PageHeader>

        <div className="mb-4 grid grid-cols-3 gap-3">
          <div className="premium-card p-4">
            <div className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Users</div>
            <div className="mt-1 font-mono text-xl font-black text-white">{rows.length}</div>
          </div>
          <div className="premium-card p-4">
            <div className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Pro</div>
            <div className="mt-1 font-mono text-xl font-black text-emerald-400">{proCount}</div>
          </div>
          <div className="premium-card p-4">
            <div className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Free</div>
            <div className="mt-1 font-mono text-xl font-black text-slate-300">{rows.length - proCount}</div>
          </div>
        </div>

        {error && (
          <div className="mb-4 rounded-xl border border-rose-500/30 bg-rose-500/10 p-4 text-xs text-rose-300">{error}</div>
        )}
        {notice && (
          <div className="mb-4 rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-4 text-xs text-emerald-300">{notice}</div>
        )}

        <div className="premium-card overflow-x-auto">
          <table className="w-full min-w-[760px] text-left text-sm">
            <thead>
              <tr className="border-b border-white/5 text-[10px] uppercase tracking-wider text-slate-500">
                <th className="px-4 py-3">User</th>
                <th className="px-4 py-3">Plan</th>
                <th className="px-4 py-3">Renews</th>
                <th className="px-4 py-3">License</th>
                <th className="px-4 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(r => (
                <tr key={r.uid} className="border-b border-white/[0.03] last:border-0 hover:bg-white/[0.02]">
                  <td className="px-4 py-2.5">
                    <div className="max-w-[240px] truncate text-xs text-slate-200">{r.email || '—'}</div>
                    <div className="font-mono text-[9px] text-slate-600">{r.displayName || r.uid.slice(0, 14)}</div>
                  </td>
                  <td className="px-4 py-2.5">
                    <span className={`rounded px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider ${
                      r.plan === 'pro' ? 'bg-emerald-500/15 text-emerald-300' : 'bg-slate-500/15 text-slate-400'}`}>
                      {r.plan}
                    </span>
                    {r.status && r.status !== 'active' && r.plan === 'pro' && (
                      <span className="ml-1.5 text-[9px] text-amber-400">{r.status}</span>
                    )}
                  </td>
                  <td className="px-4 py-2.5 font-mono text-[11px] text-slate-400">{fmtDate(r.renewsAt)}</td>
                  <td className="px-4 py-2.5 font-mono text-[10px] text-slate-500">
                    {r.licenseKey ? `${r.licenseKey.slice(0, 4)}••••${r.licenseKey.slice(-4)}` : '—'}
                  </td>
                  <td className="px-4 py-2.5">
                    <div className="flex flex-wrap justify-end gap-1.5">
                      <button disabled={busy === r.uid} onClick={() => apply(r, 'pro30')}
                        className="flex items-center gap-1 rounded-md bg-brand-accent px-2 py-1 text-[10px] font-bold text-white hover:bg-brand-accent/90 disabled:opacity-40">
                        <Sparkles size={10} /> Pro 30d
                      </button>
                      <button disabled={busy === r.uid} onClick={() => apply(r, 'pro')}
                        className="rounded-md border border-emerald-500/30 px-2 py-1 text-[10px] font-bold text-emerald-300 hover:bg-emerald-500/10 disabled:opacity-40">
                        Pro
                      </button>
                      <button disabled={busy === r.uid} onClick={() => apply(r, 'free')}
                        className="rounded-md border border-white/10 px-2 py-1 text-[10px] text-slate-300 hover:bg-white/5 disabled:opacity-40">
                        Free
                      </button>
                      {r.licenseKey && (
                        <button disabled={busy === r.uid} onClick={() => apply(r, 'revoke')}
                          title="Set Free and clear license key"
                          className="flex items-center gap-1 rounded-md border border-rose-500/30 px-2 py-1 text-[10px] text-rose-300 hover:bg-rose-500/10 disabled:opacity-40">
                          <Ban size={10} /> Revoke
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
              {!filtered.length && (
                <tr>
                  <td colSpan={5}>
                    <EmptyState
                      icon={<KeyRound size={16} />}
                      title={loading ? 'Loading users…' : rows.length ? 'No match' : 'No user documents yet'}
                      hint={loading ? undefined : 'Users appear here after their first sign-in.'}
                    />
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <div className="mt-2 font-mono text-[10px] text-slate-600">
          Reads/writes go directly to Firestore /users · admin access is enforced by security rules ·
          showing up to 300 accounts
        </div>
      </div>
    </div>
  );
};

export default AdminUsers;
