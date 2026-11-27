import React, { useCallback, useEffect, useState } from 'react';
import { Wallet, RefreshCw, ExternalLink } from 'lucide-react';
import { cachedJson, readCached } from '../utils/cachedFetch';
import { PageHeader } from './Premium';

interface Position {
  coin: string;
  side: 'long' | 'short';
  notional: number;
  entry: number;
  pnl: number;
  leverage?: number | null;
  liq?: string | null;
}
interface Whale {
  address: string;
  account_value: number;
  position_count: number;
  long_usd: number;
  short_usd: number;
  positions: Position[];
}
interface WhalesResponse {
  as_of: string;
  whales: Whale[];
  count: number;
  error?: string;
}

const usd = (v: number) => {
  if (v >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
  if (v >= 1e3) return `$${(v / 1e3).toFixed(0)}K`;
  return `$${Math.round(v)}`;
};
const short = (a: string) => (a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);

const WhalesPage: React.FC = () => {
  const [data, setData] = useState<WhalesResponse | null>(() => readCached<WhalesResponse>('/whales?limit=8')?.data ?? null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await cachedJson<WhalesResponse>('/whales?limit=8', { ttlMs: 600000, timeoutMs: 90000 }));
    } catch { /* keep cached */ }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const whales = data?.whales || [];
  const coinMap: Record<string, number> = {};
  whales.forEach(w => w.positions.forEach(p => { coinMap[p.coin] = (coinMap[p.coin] || 0) + p.notional; }));
  const coinRows = Object.entries(coinMap).sort((a, b) => b[1] - a[1]).slice(0, 10);
  const maxCoin = Math.max(1, ...coinRows.map(r => r[1]));
  const totalLong = whales.reduce((a, w) => a + w.long_usd, 0);
  const totalShort = whales.reduce((a, w) => a + w.short_usd, 0);
  const biasLong = totalLong + totalShort > 0 ? (totalLong / (totalLong + totalShort)) * 100 : 50;

  return (
    <div className="h-full overflow-y-auto p-5 lg:p-6 pb-28 lg:pb-6">
      <div className="mx-auto max-w-6xl">
        <PageHeader
          icon={<Wallet size={16} />}
          title="Whale Positions"
          badge="PRO"
          source="hyperliquid"
          asOf={data?.as_of}
          subtitle="Largest Hyperliquid accounts and their biggest open perpetual positions · cached 10 min"
        >
          <button onClick={load} disabled={loading}
            className="flex items-center gap-2 rounded-lg border border-white/10 px-3 py-1.5 text-xs text-slate-300 hover:bg-white/5 disabled:opacity-50">
            <RefreshCw size={13} className={loading ? 'animate-spin' : ''} /> Refresh
          </button>
        </PageHeader>

        {data?.error && (
          <div className="mb-4 rounded-xl border border-rose-500/30 bg-rose-500/10 p-4 text-sm text-rose-300">
            {data.error}
          </div>
        )}

        <div className="mb-4 grid grid-cols-1 gap-3 lg:grid-cols-2">
          <div className="premium-card p-4">
            <div className="mb-3 text-xs font-bold uppercase tracking-wider text-slate-400">Aggregate whale exposure</div>
            <div className="space-y-1.5">
              {coinRows.map(([coin, notional]) => (
                <div key={coin} className="flex items-center gap-2">
                  <span className="w-14 shrink-0 font-mono text-[11px] text-slate-400">{coin}</span>
                  <div className="h-3 flex-1 overflow-hidden rounded bg-slate-800/60">
                    <div className="h-full rounded bg-gradient-to-r from-brand-accent/50 to-brand-accent"
                      style={{ width: `${(notional / maxCoin) * 100}%` }} />
                  </div>
                  <span className="w-16 shrink-0 text-right font-mono text-[10px] text-slate-500">{usd(notional)}</span>
                </div>
              ))}
              {!coinRows.length && <div className="py-6 text-center text-xs text-slate-500">No exposure data</div>}
            </div>
          </div>
          <div className="premium-card p-4">
            <div className="text-xs font-bold uppercase tracking-wider text-slate-400">Whale net bias</div>
            <div className="mt-2 flex items-baseline gap-2">
              <span className="font-mono text-3xl font-black text-white">{biasLong.toFixed(0)}%</span>
              <span className="text-[10px] uppercase tracking-wider text-slate-500">long</span>
            </div>
            <div className="mt-3 flex h-2 overflow-hidden rounded-full bg-slate-800">
              <div className="bg-emerald-500" style={{ width: `${biasLong}%` }} />
              <div className="bg-rose-500" style={{ width: `${100 - biasLong}%` }} />
            </div>
            <div className="mt-2 flex justify-between font-mono text-[10px]">
              <span className="text-emerald-400">L {usd(totalLong)}</span>
              <span className="text-rose-400">S {usd(totalShort)}</span>
            </div>
            <div className="mt-3 font-mono text-[9px] text-slate-600">
              across {whales.length} tracked accounts · positions ≥ $10K
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          {(data?.whales || []).map(w => {
            const total = w.long_usd + w.short_usd;
            const longShare = total > 0 ? (w.long_usd / total) * 100 : 50;
            return (
              <div key={w.address} className="fintech-card p-4">
                <div className="flex items-start justify-between">
                  <div>
                    <a href={`https://app.hyperliquid.xyz/explorer/address/${w.address}`}
                      target="_blank" rel="noopener noreferrer"
                      className="flex items-center gap-1 font-mono text-[12px] text-slate-200 hover:text-brand-accent">
                      {short(w.address)} <ExternalLink size={10} />
                    </a>
                    <div className="mt-0.5 text-[10px] text-slate-500">
                      {w.position_count} open · {usd(w.account_value)} account
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="font-mono text-[11px] text-emerald-400">L {usd(w.long_usd)}</div>
                    <div className="font-mono text-[11px] text-rose-400">S {usd(w.short_usd)}</div>
                  </div>
                </div>

                <div className="mt-2 flex h-1.5 overflow-hidden rounded-full bg-slate-800">
                  <div className="bg-emerald-500" style={{ width: `${longShare}%` }} />
                  <div className="bg-rose-500" style={{ width: `${100 - longShare}%` }} />
                </div>

                <div className="mt-3 space-y-1">
                  {w.positions.map((p, i) => (
                    <div key={`${p.coin}-${i}`} className="flex items-center justify-between rounded-lg px-2 py-1 hover:bg-white/[0.03]">
                      <span className="flex items-center gap-2">
                        <span className={`h-1.5 w-1.5 rounded-full ${p.side === 'long' ? 'bg-emerald-400' : 'bg-rose-400'}`} />
                        <span className="font-mono text-[11px] text-slate-300">{p.coin}</span>
                        <span className="font-mono text-[9px] uppercase text-slate-600">{p.side}</span>
                        {p.leverage ? <span className="font-mono text-[9px] text-slate-600">{p.leverage}x</span> : null}
                      </span>
                      <span className="flex items-center gap-2">
                        <span className="font-mono text-[10px] text-slate-500">{usd(p.notional)}</span>
                        <span className={`font-mono text-[10px] font-bold ${p.pnl >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                          {p.pnl >= 0 ? '+' : ''}{usd(Math.abs(p.pnl))}
                        </span>
                      </span>
                    </div>
                  ))}
                  {!w.positions.length && <div className="py-3 text-center text-[11px] text-slate-500">No positions above $10K</div>}
                </div>
              </div>
            );
          })}
        </div>

        {!data?.whales?.length && !loading && !data?.error && (
          <div className="fintech-card p-10 text-center text-xs text-slate-500">No whale data available</div>
        )}

        <div className="mt-3 font-mono text-[10px] text-slate-600">
          Positions ≥ $10K · top {data?.count ?? 0} accounts by account value · recorded {data?.as_of || '—'} · source hyperliquid
        </div>
      </div>
    </div>
  );
};

export default WhalesPage;
