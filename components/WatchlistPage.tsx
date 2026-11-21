import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Star, Plus, Bell, Trash2, RefreshCw, ArrowRight, BellRing } from 'lucide-react';
import { apiFetch } from '../utils/apiClient';
import { useStore } from '../store';
import { PageHeader } from './Premium';

interface RsiRow {
  symbol: string;
  price: number;
  change_24h: number;
  rsi: Record<string, number | null>;
  rsi_avg: number | null;
}

const COMMON = [
  'BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'DOGEUSDT', 'LINKUSDT',
  'ADAUSDT', 'AVAXUSDT', 'SUIUSDT', 'TONUSDT', 'LTCUSDT', 'ARBUSDT', 'OPUSDT',
];
const fmtPrice = (v: number) => (v >= 1 ? v.toLocaleString(undefined, { maximumFractionDigits: 2 }) : v.toPrecision(4));

const WatchlistPage: React.FC = () => {
  const watchlist = useStore(s => s.watchlist);
  const toggleWatch = useStore(s => s.toggleWatch);
  const priceAlerts = useStore(s => s.priceAlerts);
  const addPriceAlert = useStore(s => s.addPriceAlert);
  const removePriceAlert = useStore(s => s.removePriceAlert);
  const plan = useStore(s => s.auth.plan);
  const setActiveTab = useStore(s => s.setActiveTab);
  const addNotification = useStore(s => s.addNotification);
  const metrics = useStore(s => s.market.metrics);

  const [rows, setRows] = useState<RsiRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [addSymbol, setAddSymbol] = useState('');
  const [form, setForm] = useState({ symbol: 'BTCUSDT', direction: 'above' as 'above' | 'below', price: '' });
  const [alertMsg, setAlertMsg] = useState<string | null>(null);
  const [notifPerm, setNotifPerm] = useState<string>(() =>
    typeof Notification !== 'undefined' ? Notification.permission : 'unsupported');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await apiFetch('/rsi-screener', { timeoutMs: 90000 });
      const j = await r.json();
      setRows(j?.rows || []);
    } catch { /* keep previous */ }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const bySymbol = useMemo(() => new Map(rows.map(r => [r.symbol, r])), [rows]);
  const activeAlerts = priceAlerts.filter(a => !a.triggeredAt);
  const limit = plan === 'pro' ? 100 : 3;

  const add = () => {
    const s = addSymbol.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    const symbol = s.endsWith('USDT') ? s : `${s}USDT`;
    if (symbol.length < 6) return;
    if (!watchlist.includes(symbol)) toggleWatch(symbol);
    setAddSymbol('');
  };

  const createAlert = () => {
    const price = Number(form.price);
    if (!Number.isFinite(price) || price <= 0) {
      setAlertMsg('Enter a valid price.');
      return;
    }
    const ok = addPriceAlert({ symbol: form.symbol, direction: form.direction, price });
    if (!ok) {
      setAlertMsg(`Free accounts get ${limit} active alerts. Upgrade for unlimited.`);
      return;
    }
    setAlertMsg(`Alert set: ${form.symbol} ${form.direction} ${price}`);
    setForm(f => ({ ...f, price: '' }));
  };

  const askPermission = async () => {
    if (typeof Notification === 'undefined') return;
    const p = await Notification.requestPermission();
    setNotifPerm(p);
    if (p === 'granted') {
      addNotification({ id: `perm_${Date.now()}`, type: 'success', title: 'Notifications enabled', message: 'Price alerts will also show as browser notifications.' });
    }
  };

  return (
    <div className="h-full overflow-y-auto p-5 lg:p-6 pb-28 lg:pb-6">
      <div className="mx-auto max-w-5xl">
        <PageHeader
          icon={<Star size={16} />}
          title="Watchlist & Alerts"
          badge="FREE"
          subtitle="Pin symbols and set price alerts. Alerts run while the desk is open."
        >
          <button onClick={load} disabled={loading}
            className="flex items-center gap-2 rounded-lg border border-white/10 px-3 py-1.5 text-xs text-slate-300 hover:bg-white/5 disabled:opacity-50">
            <RefreshCw size={13} className={loading ? 'animate-spin' : ''} /> Refresh
          </button>
        </PageHeader>

        <div className="mb-4 flex flex-wrap items-center gap-2">
          <div className="relative flex-1 min-w-[200px]">
            <Plus size={13} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
            <input
              list="watch-symbols"
              value={addSymbol}
              onChange={e => setAddSymbol(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') add(); }}
              placeholder="Add symbol (BTC, ETHUSDT…)"
              className="w-full rounded-lg border border-white/10 bg-black/40 py-2 pl-9 pr-3 text-xs uppercase text-slate-200 outline-none focus:border-brand-accent/50"
            />
            <datalist id="watch-symbols">
              {COMMON.map(s => <option key={s} value={s} />)}
            </datalist>
          </div>
          <button onClick={add} className="rounded-lg bg-brand-accent px-4 py-2 text-xs font-bold text-white hover:bg-brand-accent/90">
            Add
          </button>
        </div>

        <div className="premium-card overflow-hidden">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-white/5 text-[10px] uppercase tracking-wider text-slate-500">
                <th className="px-4 py-3">Symbol</th>
                <th className="px-4 py-3 text-right">Price</th>
                <th className="px-4 py-3 text-right">24h</th>
                <th className="px-4 py-3 text-right">RSI 1h</th>
                <th className="px-4 py-3 text-right">Alerts</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {watchlist.map(sym => {
                const r = bySymbol.get(sym);
                const price = r?.price ?? (sym === 'BTCUSDT' ? metrics.price : undefined);
                const ch = r?.change_24h;
                return (
                  <tr key={sym} className="border-b border-white/[0.03] last:border-0 hover:bg-white/[0.02]">
                    <td className="px-4 py-2.5 font-mono text-[12px] text-slate-200">{sym.replace('USDT', '')}<span className="ml-1 text-[9px] text-slate-600">USDT</span></td>
                    <td className="px-4 py-2.5 text-right font-mono text-[12px] text-slate-300">{price === undefined ? '—' : fmtPrice(price)}</td>
                    <td className={`px-4 py-2.5 text-right font-mono text-[12px] ${ch === undefined ? 'text-slate-500' : ch >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                      {ch === undefined ? '—' : `${ch >= 0 ? '+' : ''}${ch}%`}
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono text-[12px] text-slate-300">{r?.rsi?.['1h']?.toFixed(1) ?? '—'}</td>
                    <td className="px-4 py-2.5 text-right font-mono text-[11px] text-slate-500">
                      {activeAlerts.filter(a => a.symbol === sym).length || '—'}
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      <button onClick={() => toggleWatch(sym)} title="Remove from watchlist"
                        className="rounded p-1 text-slate-500 hover:bg-rose-500/10 hover:text-rose-400">
                        <Trash2 size={13} />
                      </button>
                    </td>
                  </tr>
                );
              })}
              {!watchlist.length && (
                <tr><td colSpan={6} className="px-4 py-10 text-center text-xs text-slate-500">Watchlist is empty — add a symbol above.</td></tr>
              )}
            </tbody>
          </table>
        </div>
        <div className="mt-2 font-mono text-[10px] text-slate-600">
          prices from the RSI scan · {loading ? 'refreshing…' : `${rows.length} symbols scanned`} · saved locally in this browser
        </div>

        <div className="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-2">
          <div className="premium-card p-4">
            <div className="mb-3 flex items-center justify-between">
              <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-slate-400">
                <Bell size={13} className="text-brand-accent" /> New price alert
              </div>
              <span className="font-mono text-[10px] text-slate-500">{activeAlerts.length}/{limit === 100 ? '∞' : limit}</span>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <select value={form.symbol} onChange={e => setForm(f => ({ ...f, symbol: e.target.value }))}
                className="rounded-lg border border-white/10 bg-black/40 px-2 py-2 text-xs text-slate-200 outline-none">
                {[...new Set([...watchlist, ...COMMON])].map(s => <option key={s} value={s}>{s}</option>)}
              </select>
              <select value={form.direction} onChange={e => setForm(f => ({ ...f, direction: e.target.value as any }))}
                className="rounded-lg border border-white/10 bg-black/40 px-2 py-2 text-xs text-slate-200 outline-none">
                <option value="above">Above</option>
                <option value="below">Below</option>
              </select>
              <input value={form.price} onChange={e => setForm(f => ({ ...f, price: e.target.value }))}
                type="number" min="0" step="any" placeholder="Trigger price"
                className="col-span-2 rounded-lg border border-white/10 bg-black/40 px-3 py-2 font-mono text-xs text-slate-200 outline-none focus:border-brand-accent/50" />
            </div>
            <button onClick={createAlert}
              className="mt-3 w-full rounded-lg bg-brand-accent py-2 text-xs font-bold text-white hover:bg-brand-accent/90">
              Set alert
            </button>
            {alertMsg && <div className="mt-2 font-mono text-[10px] text-slate-400">{alertMsg}</div>}
            {notifPerm !== 'granted' && notifPerm !== 'unsupported' && (
              <button onClick={askPermission} className="mt-2 flex items-center gap-1.5 text-[10px] text-slate-500 hover:text-brand-accent">
                <BellRing size={11} /> Enable browser notifications
              </button>
            )}
            {plan !== 'pro' && (
              <button onClick={() => setActiveTab('pricing')} className="mt-3 flex w-full items-center justify-between rounded-lg border border-brand-accent/25 bg-brand-accent/[0.06] px-3 py-2 text-[10px] text-slate-300">
                <span>Pro: unlimited alerts + digest</span>
                <ArrowRight size={12} className="text-brand-accent" />
              </button>
            )}
          </div>

          <div className="premium-card p-4">
            <div className="mb-3 text-xs font-bold uppercase tracking-wider text-slate-400">Your alerts</div>
            <div className="space-y-1.5">
              {priceAlerts.slice(0, 12).map(a => (
                <div key={a.id} className="flex items-center justify-between rounded-lg px-2 py-1.5 hover:bg-white/[0.03]">
                  <div className="flex items-center gap-2">
                    <span className={`h-1.5 w-1.5 rounded-full ${a.triggeredAt ? 'bg-slate-600' : 'bg-emerald-400'}`} />
                    <span className="font-mono text-[11px] text-slate-300">{a.symbol.replace('USDT', '')}</span>
                    <span className="font-mono text-[10px] text-slate-500">{a.direction} {a.price}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    {a.triggeredAt && <span className="font-mono text-[9px] uppercase text-amber-400">triggered</span>}
                    <button onClick={() => removePriceAlert(a.id)} className="rounded p-1 text-slate-500 hover:text-rose-400">
                      <Trash2 size={12} />
                    </button>
                  </div>
                </div>
              ))}
              {!priceAlerts.length && <div className="py-6 text-center text-[11px] text-slate-500">No alerts yet.</div>}
            </div>
            <div className="mt-2 font-mono text-[9px] text-slate-600">
              Checked every 20s while the desk is open · saved locally
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default WatchlistPage;
