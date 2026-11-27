import React, { useCallback, useEffect, useState } from 'react';
import { Thermometer, RefreshCw } from 'lucide-react';
import { cachedJson, readCached } from '../utils/cachedFetch';
import { PageHeader, rsiColor } from './Premium';

interface RsiRow {
  symbol: string;
  price: number;
  change_24h: number;
  volume_usd: number;
  rsi: Record<string, number | null>;
  rsi_avg: number | null;
}
interface RsiResponse {
  as_of: string;
  timeframes: string[];
  rows: RsiRow[];
  count: number;
  overbought: number;
  oversold: number;
  error?: string;
}

type SortKey = 'symbol' | 'price' | 'change_24h' | 'rsi_avg' | '15m' | '1h' | '4h';

const fmtUsd = (v: number) => {
  if (v >= 1e9) return `$${(v / 1e9).toFixed(1)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(0)}M`;
  return `$${Math.round(v).toLocaleString()}`;
};

const ScreenerPage: React.FC = () => {
  const [data, setData] = useState<RsiResponse | null>(() => readCached<RsiResponse>('/rsi-screener')?.data ?? null);
  const [loading, setLoading] = useState(true);
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'rsi_avg', dir: -1 });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await cachedJson<RsiResponse>('/rsi-screener', { ttlMs: 180000, timeoutMs: 90000 }));
    } catch { /* keep cached */ }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const tf = data?.timeframes || ['15m', '1h', '4h'];
  const rows = [...(data?.rows || [])].sort((a, b) => {
    const get = (r: RsiRow): number | string => {
      if (sort.key === 'symbol') return r.symbol;
      if (sort.key === '15m' || sort.key === '1h' || sort.key === '4h') return r.rsi[sort.key] ?? -1;
      return (r as any)[sort.key] ?? -1;
    };
    const av = get(a), bv = get(b);
    if (typeof av === 'string' || typeof bv === 'string') return String(av).localeCompare(String(bv)) * sort.dir;
    return (av - bv) * sort.dir;
  });

  const header = (key: SortKey, label: string, align = 'text-right') => (
    <th
      className={`cursor-pointer select-none px-3 py-2.5 ${align} text-[10px] uppercase tracking-wider text-slate-500 hover:text-slate-300`}
      onClick={() => setSort(s => ({ key, dir: s.key === key ? (s.dir === 1 ? -1 : 1) : -1 }))}
    >
      {label}{sort.key === key ? (sort.dir === 1 ? ' â†‘' : ' â†“') : ''}
    </th>
  );

  return (
    <div className="h-full overflow-y-auto p-5 lg:p-6 pb-28 lg:pb-6">
      <div className="mx-auto max-w-6xl">
        <PageHeader
          icon={<Thermometer size={16} />}
          title="RSI Screener"
          badge="FREE"
          subtitle="Multi-timeframe RSI on the most liquid perpetuals Â· green oversold, red overbought"
        >
          <div className="flex items-center gap-3 font-mono text-[11px]">
            <span className="text-emerald-400">{data?.oversold ?? 0} oversold</span>
            <span className="text-rose-400">{data?.overbought ?? 0} overbought</span>
            <span className="text-slate-500">{data?.count ?? 0} symbols</span>
          </div>
          <button onClick={load} disabled={loading}
            className="flex items-center gap-2 rounded-lg border border-white/10 px-3 py-1.5 text-xs text-slate-300 hover:bg-white/5 disabled:opacity-50">
            <RefreshCw size={13} className={loading ? 'animate-spin' : ''} /> Refresh
          </button>
        </PageHeader>

        <div className="mb-4 grid grid-cols-3 gap-3">
          {tf.map(t => {
            const vals = (data?.rows || []).map(r => r.rsi[t]).filter((v): v is number => v !== null && v !== undefined);
            const ob = vals.filter(v => v >= 70).length;
            const os = vals.filter(v => v <= 30).length;
            const avg = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
            return (
              <div key={t} className="premium-card p-3">
                <div className="flex items-center justify-between">
                  <span className="text-[10px] font-bold uppercase tracking-wider text-slate-500">{t} breadth</span>
                  <span className="font-mono text-[10px] text-slate-500">{vals.length}</span>
                </div>
                <div className="mt-1.5 font-mono text-lg font-black text-white">
                  {avg === null ? 'â€”' : avg.toFixed(0)}
                  <span className="ml-1 text-[10px] font-normal text-slate-500">avg RSI</span>
                </div>
                <div className="mt-2 flex h-1.5 overflow-hidden rounded-full bg-slate-800">
                  <div className="bg-emerald-500" style={{ width: `${vals.length ? (os / vals.length) * 100 : 0}%` }} />
                  <div className="bg-rose-500" style={{ width: `${vals.length ? (ob / vals.length) * 100 : 0}%` }} />
                </div>
                <div className="mt-1 flex justify-between font-mono text-[9px]">
                  <span className="text-emerald-400/80">{os} OS</span>
                  <span className="text-rose-400/80">{ob} OB</span>
                </div>
              </div>
            );
          })}
        </div>

        {data?.error && (
          <div className="mb-4 rounded-xl border border-rose-500/30 bg-rose-500/10 p-4 text-sm text-rose-300">{data.error}</div>
        )}

        <div className="premium-card overflow-x-auto">
          <table className="w-full min-w-[620px] text-left text-sm">
            <thead>
              <tr className="border-b border-white/5">
                {header('symbol', 'Symbol', 'text-left')}
                {header('price', 'Price')}
                {header('change_24h', '24h')}
                {tf.map(t => header(t as SortKey, t))}
                {header('rsi_avg', 'Avg')}
              </tr>
            </thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.symbol} className="border-b border-white/[0.03] last:border-0 hover:bg-white/[0.02]">
                  <td className="px-3 py-2 font-mono text-[12px] text-slate-200">
                    {r.symbol.replace('USDT', '')}
                    <span className="ml-1 text-[9px] text-slate-600">USDT</span>
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-[12px] text-slate-300">
                    {r.price >= 1 ? r.price.toLocaleString(undefined, { maximumFractionDigits: 2 })
                      : r.price.toPrecision(4)}
                  </td>
                  <td className={`px-3 py-2 text-right font-mono text-[12px] ${r.change_24h >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                    {r.change_24h >= 0 ? '+' : ''}{r.change_24h}%
                  </td>
                  {tf.map(t => {
                    const v = r.rsi[t];
                    return (
                      <td key={t} className="px-1.5 py-1.5 text-right">
                        <div className="rounded-md px-2 py-1 font-mono text-[12px] font-bold text-white"
                          style={{ background: rsiColor(v) }}>
                          {v === null || v === undefined ? 'â€”' : v.toFixed(1)}
                        </div>
                      </td>
                    );
                  })}
                  <td className="px-3 py-2 text-right font-mono text-[12px] font-black"
                    style={{ color: (r.rsi_avg ?? 50) >= 70 ? '#fb7185' : (r.rsi_avg ?? 50) <= 30 ? '#34d399' : '#e2e8f0' }}>
                    {r.rsi_avg === null ? 'â€”' : r.rsi_avg.toFixed(1)}
                  </td>
                </tr>
              ))}
              {!rows.length && (
                <tr><td colSpan={6 + tf.length} className="px-4 py-10 text-center text-xs text-slate-500">
                  {loading ? 'Computing RSI across the marketâ€¦' : 'No data'}
                </td></tr>
              )}
            </tbody>
          </table>
        </div>

        <div className="mt-2 font-mono text-[10px] text-slate-600">
          Wilder RSI(14) Â· 15m bars resampled to 1h/4h Â· top {data?.count ?? 0} by 24h volume
          {rows[0] ? ` Â· ${rows[0].symbol} ${fmtUsd(rows[0].volume_usd)} 24h` : ''} Â· recorded {data?.as_of || 'â€”'} Â· source binance-fapi
        </div>
      </div>
    </div>
  );
};

export default ScreenerPage;
