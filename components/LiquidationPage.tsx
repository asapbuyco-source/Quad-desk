import React, { useCallback, useEffect, useState } from 'react';
import { Flame, RefreshCw, ArrowDownRight, ArrowUpRight } from 'lucide-react';
import { apiFetch } from '../utils/apiClient';
import { PageHeader } from './Premium';

interface Cluster { price: number; long_usd: number; short_usd: number; total_usd: number; count: number }
interface SymRow { symbol: string; long_usd: number; short_usd: number; total_usd: number; count: number }
interface Largest { t: string; symbol: string; venue?: string; side: 'long' | 'short'; price: number; notional: number }
interface LiqResponse {
  as_of: string;
  symbol: string;
  minutes: number;
  buffered: number;
  collecting_since: string | null;
  totals: { long_usd: number; short_usd: number; count: number };
  by_symbol: SymRow[];
  clusters: Cluster[];
  largest: Largest[];
  hourly?: { t: number; long_usd: number; short_usd: number; count: number }[];
  error?: string;
}

const SYMBOLS = ['', 'BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'DOGEUSDT'];
const WINDOWS = [60, 240, 1440];
const windowLabel = (w: number) => (w >= 1440 ? '24h' : `${w}m`);

const usd = (v: number) => {
  if (v >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `$${(v / 1e3).toFixed(0)}K`;
  return `$${Math.round(v)}`;
};
const time = (t: string) => { try { return new Date(t).toLocaleTimeString(); } catch { return t; } };

const LiquidationPage: React.FC = () => {
  const [symbol, setSymbol] = useState('');
  const [minutes, setMinutes] = useState(240);
  const [data, setData] = useState<LiqResponse | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (sym: string, mins: number) => {
    setLoading(true);
    try {
      const r = await apiFetch(`/liquidations?symbol=${sym}&minutes=${mins}&limit=20`, { timeoutMs: 45000 });
      setData(await r.json());
    } catch {
      setData(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(symbol, minutes); }, [load, symbol, minutes]);

  const total = (data?.totals.long_usd ?? 0) + (data?.totals.short_usd ?? 0);
  const longShare = total > 0 ? ((data?.totals.long_usd ?? 0) / total) * 100 : 50;
  const maxCluster = Math.max(1, ...(data?.clusters || []).map(c => c.total_usd));

  return (
    <div className="h-full overflow-y-auto p-5 lg:p-6 pb-28 lg:pb-6">
      <div className="mx-auto max-w-6xl">
        <PageHeader
          icon={<Flame size={16} />}
          title="Liquidations"
          badge="PRO"
          subtitle="Forced orders from Binance + OKX — long liqs (red) vs short liqs (green), clustered by price"
        >
          <select value={symbol} onChange={e => setSymbol(e.target.value)}
            className="rounded-lg border border-white/10 bg-black/40 px-3 py-1.5 text-xs text-slate-200 outline-none">
            {SYMBOLS.map(s => <option key={s || 'all'} value={s}>{s ? s.replace('USDT', '') : 'All symbols'}</option>)}
          </select>
          <div className="flex items-center gap-1 rounded-lg border border-white/10 bg-black/30 p-0.5">
            {WINDOWS.map(w => (
              <button key={w} onClick={() => setMinutes(w)}
                className={`rounded-md px-2 py-1 text-[10px] font-bold uppercase tracking-wider transition-colors ${
                  minutes === w ? 'bg-brand-accent/20 text-brand-accent' : 'text-slate-500 hover:text-slate-300'}`}>
                {windowLabel(w)}
              </button>
            ))}
          </div>
          <button onClick={() => load(symbol, minutes)} disabled={loading}
            className="rounded-lg border border-white/10 p-1.5 text-slate-300 hover:bg-white/5 disabled:opacity-50">
            <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
          </button>
        </PageHeader>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div className="premium-card p-4">
            <div className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Long liquidations</div>
            <div className="mt-1 font-mono text-xl font-black text-rose-400">{usd(data?.totals.long_usd ?? 0)}</div>
            <div className="mt-1 text-[10px] text-slate-500">{data?.totals.count ?? 0} forced orders</div>
          </div>
          <div className="premium-card p-4">
            <div className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Short liquidations</div>
            <div className="mt-1 font-mono text-xl font-black text-emerald-400">{usd(data?.totals.short_usd ?? 0)}</div>
            <div className="mt-1 text-[10px] text-slate-500">in the last {windowLabel(minutes)}</div>
          </div>
          <div className="premium-card p-4">
            <div className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Long share</div>
            <div className="mt-1 font-mono text-xl font-black text-white">{longShare.toFixed(0)}%</div>
            <div className="mt-2 flex h-1.5 overflow-hidden rounded-full bg-slate-800">
              <div className="bg-rose-500" style={{ width: `${longShare}%` }} />
              <div className="bg-emerald-500" style={{ width: `${100 - longShare}%` }} />
            </div>
          </div>
        </div>

        {!!data?.hourly?.length && (
          <div className="mt-4 premium-card p-4">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-xs font-bold uppercase tracking-wider text-slate-400">24h liquidation heat</span>
              <span className="font-mono text-[9px] text-slate-600">red = longs liquidated · green = shorts</span>
            </div>
            <div className="flex h-24 items-end gap-1">
              {(() => {
                const max = Math.max(1, ...data.hourly!.map(h => h.long_usd + h.short_usd));
                return data.hourly!.map((h, i) => {
                  const total = h.long_usd + h.short_usd;
                  const lh = (h.long_usd / max) * 100;
                  const sh = (h.short_usd / max) * 100;
                  return (
                    <div key={i} className="group relative flex h-full flex-1 flex-col justify-end gap-px"
                      title={`${new Date(h.t).toLocaleTimeString([], { hour: '2-digit' })} · L ${usd(h.long_usd)} / S ${usd(h.short_usd)}`}>
                      <div className="w-full rounded-sm bg-rose-500/80" style={{ height: `${lh}%` }} />
                      <div className="w-full rounded-sm bg-emerald-500/80" style={{ height: `${sh}%` }} />
                      {total === 0 && <div className="w-full rounded-sm bg-white/5" style={{ height: '2%' }} />}
                    </div>
                  );
                });
              })()}
            </div>
            <div className="mt-1 flex justify-between font-mono text-[9px] text-slate-600">
              <span>-24h</span><span>-18h</span><span>-12h</span><span>-6h</span><span>now</span>
            </div>
          </div>
        )}

        <div className="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-2">
          <div className="premium-card p-4">
            <div className="mb-3 text-xs font-bold uppercase tracking-wider text-slate-400">Price clusters</div>
            <div className="space-y-1.5">
              {(data?.clusters || []).map(c => (
                <div key={c.price} className="flex items-center gap-2">
                  <span className="w-24 shrink-0 text-right font-mono text-[11px] text-slate-400">
                    {c.price.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                  </span>
                  <div className="flex h-4 flex-1 overflow-hidden rounded bg-slate-800/60">
                    <div className="bg-rose-500/80" style={{ width: `${(c.long_usd / maxCluster) * 100}%` }} />
                    <div className="bg-emerald-500/80" style={{ width: `${(c.short_usd / maxCluster) * 100}%` }} />
                  </div>
                  <span className="w-16 shrink-0 text-right font-mono text-[10px] text-slate-500">{usd(c.total_usd)}</span>
                </div>
              ))}
              {!data?.clusters?.length && <div className="py-6 text-center text-xs text-slate-500">
                {data?.collecting_since ? 'No liquidations in this window yet.' : 'Collector starting — data appears within seconds.'}
              </div>}
            </div>
          </div>

          <div className="fintech-card p-4">
            <div className="mb-3 text-xs font-bold uppercase tracking-wider text-slate-400">Largest forced orders</div>
            <div className="space-y-1">
              {(data?.largest || []).map((x, i) => (
                <div key={i} className="flex items-center justify-between rounded-lg px-2 py-1.5 hover:bg-white/[0.03]">
                  <span className="flex items-center gap-2">
                    {x.side === 'long'
                      ? <ArrowDownRight size={12} className="text-rose-400" />
                      : <ArrowUpRight size={12} className="text-emerald-400" />}
                    <span className="font-mono text-[11px] text-slate-300">{x.symbol.replace('USDT', '')}</span>
                    <span className="font-mono text-[8px] uppercase text-slate-600">{x.venue || 'binance'}</span>
                    <span className="font-mono text-[9px] text-slate-600">{time(x.t)}</span>
                  </span>
                  <span className={`font-mono text-[11px] font-bold ${x.side === 'long' ? 'text-rose-400' : 'text-emerald-400'}`}>
                    {usd(x.notional)}
                  </span>
                </div>
              ))}
              {!data?.largest?.length && <div className="py-6 text-center text-xs text-slate-500">Nothing yet</div>}
            </div>
          </div>
        </div>

        <div className="mt-6">
          <div className="mb-2 text-xs font-bold uppercase tracking-wider text-slate-400">By symbol</div>
          <div className="fintech-card overflow-hidden">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-white/5 text-[10px] uppercase tracking-wider text-slate-500">
                  <th className="px-4 py-2.5">Symbol</th>
                  <th className="px-4 py-2.5 text-right">Longs liquidated</th>
                  <th className="px-4 py-2.5 text-right">Shorts liquidated</th>
                  <th className="px-4 py-2.5 text-right">Count</th>
                </tr>
              </thead>
              <tbody>
                {(data?.by_symbol || []).map(r => (
                  <tr key={r.symbol} className="border-b border-white/[0.03] last:border-0 hover:bg-white/[0.02]">
                    <td className="px-4 py-2 font-mono text-[12px] text-slate-200">{r.symbol}</td>
                    <td className="px-4 py-2 text-right font-mono text-[12px] text-rose-400">{usd(r.long_usd)}</td>
                    <td className="px-4 py-2 text-right font-mono text-[12px] text-emerald-400">{usd(r.short_usd)}</td>
                    <td className="px-4 py-2 text-right font-mono text-[12px] text-slate-400">{r.count}</td>
                  </tr>
                ))}
                {!data?.by_symbol?.length && (
                  <tr><td colSpan={4} className="px-4 py-6 text-center text-xs text-slate-500">No data</td></tr>
                )}
              </tbody>
            </table>
          </div>
          <div className="mt-2 font-mono text-[10px] text-slate-600">
            {data?.buffered ?? 0} orders buffered · collector {data?.collecting_since ? `since ${new Date(data.collecting_since).toLocaleString()}` : 'starting'} ·
            history begins when the backend connects to the stream · source binance-forceOrder
          </div>
        </div>
      </div>
    </div>
  );
};

export default LiquidationPage;
