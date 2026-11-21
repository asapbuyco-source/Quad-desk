import React, { useCallback, useEffect, useState } from 'react';
import { Globe2, RefreshCw } from 'lucide-react';
import { apiFetch } from '../utils/apiClient';
import { PageHeader, HeatCell } from './Premium';

interface CompareRow { symbol: string; change_pct: number; vol_pct: number; beta: number; corr: number }
interface CompareResp { as_of?: string; days: number; symbols: string[]; matrix: number[][]; rows: CompareRow[]; error?: string }
interface AltRow { symbol: string; change_pct: number; vs_btc: number }
interface AltResp { index: number; btc_change_pct: number; beating: number; count: number; label: string; alts: AltRow[]; error?: string }

const SYMS = 'BTCUSDT,ETHUSDT,SOLUSDT,BNBUSDT,XRPUSDT,DOGEUSDT';
const WINDOWS = [30, 60, 90];

const corrColor = (v: number) => {
  const a = Math.min(1, Math.abs(v));
  return v >= 0 ? `rgba(59,130,246,${0.10 + a * 0.55})` : `rgba(244,63,94,${0.10 + a * 0.55})`;
};

const MarketsPage: React.FC = () => {
  const [days, setDays] = useState(30);
  const [cmp, setCmp] = useState<CompareResp | null>(null);
  const [alt, setAlt] = useState<AltResp | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (window: number) => {
    setLoading(true);
    try {
      const [c, a] = await Promise.all([
        apiFetch(`/compare?symbols=${SYMS}&days=${window}`, { timeoutMs: 60000 }),
        apiFetch(`/altseason?days=${window}`, { timeoutMs: 60000 }),
      ]);
      setCmp(await c.json());
      setAlt(await a.json());
    } catch { /* keep previous */ }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(days); }, [load, days]);

  const syms = cmp?.symbols || [];
  const altTone = (alt?.index ?? 50) >= 75 ? 'text-emerald-400' : (alt?.index ?? 50) <= 25 ? 'text-rose-400' : 'text-amber-300';

  return (
    <div className="h-full overflow-y-auto p-5 lg:p-6 pb-28 lg:pb-6">
      <div className="mx-auto max-w-6xl">
        <PageHeader
          icon={<Globe2 size={16} />}
          title="Markets"
          badge="FREE"
          subtitle="Relative performance, correlation and beta across majors · altseason breadth"
        >
          <div className="flex items-center gap-1 rounded-lg border border-white/10 bg-black/30 p-0.5">
            {WINDOWS.map(w => (
              <button key={w} onClick={() => setDays(w)}
                className={`rounded-md px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider ${
                  days === w ? 'bg-brand-accent/20 text-brand-accent' : 'text-slate-500 hover:text-slate-300'}`}>
                {w}d
              </button>
            ))}
          </div>
          <button onClick={() => load(days)} disabled={loading}
            className="rounded-lg border border-white/10 p-1.5 text-slate-300 hover:bg-white/5 disabled:opacity-50">
            <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
          </button>
        </PageHeader>

        <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
          <div className="premium-card p-4 lg:col-span-1">
            <div className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Altseason index</div>
            <div className={`mt-1 font-mono text-4xl font-black ${altTone}`}>{alt?.index ?? '—'}</div>
            <div className="mt-1 text-[11px] text-slate-400">{alt?.label || '—'}</div>
            <div className="mt-3 h-2 overflow-hidden rounded-full bg-slate-800">
              <div className={`h-full rounded-full ${(alt?.index ?? 0) >= 75 ? 'bg-emerald-500' : (alt?.index ?? 0) <= 25 ? 'bg-rose-500' : 'bg-amber-500'}`}
                style={{ width: `${alt?.index ?? 0}%` }} />
            </div>
            <div className="mt-2 flex justify-between font-mono text-[9px] text-slate-600">
              <span>BTC season</span><span>Altseason</span>
            </div>
            <div className="mt-2 font-mono text-[10px] text-slate-500">
              {alt ? `${alt.beating}/${alt.count} alts beating BTC · BTC ${alt.btc_change_pct >= 0 ? '+' : ''}${alt.btc_change_pct}%` : '—'}
            </div>
          </div>

          <div className="premium-card p-4 lg:col-span-2">
            <div className="mb-3 text-xs font-bold uppercase tracking-wider text-slate-400">Alt performance vs BTC</div>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-3">
              {(alt?.alts || []).map(a => (
                <div key={a.symbol} className="flex items-center justify-between gap-2">
                  <span className="font-mono text-[10px] text-slate-400">{a.symbol.replace('USDT', '')}</span>
                  <span className={`font-mono text-[10px] font-bold ${a.vs_btc >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                    {a.vs_btc >= 0 ? '+' : ''}{a.vs_btc}%
                  </span>
                </div>
              ))}
              {!alt?.alts?.length && <div className="text-[11px] text-slate-500">No data</div>}
            </div>
          </div>
        </div>

        <div className="mt-4 premium-card p-4">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs font-bold uppercase tracking-wider text-slate-400">Correlation matrix · daily returns</span>
            <span className="font-mono text-[9px] text-slate-600">blue positive · red negative</span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[520px] text-left text-sm">
              <thead>
                <tr>
                  <th className="px-2 py-1" />
                  {syms.map(s => (
                    <th key={s} className="px-1 py-1 text-center font-mono text-[10px] text-slate-500">{s.replace('USDT', '')}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {syms.map((s, i) => (
                  <tr key={s}>
                    <td className="px-2 py-1 font-mono text-[10px] text-slate-400">{s.replace('USDT', '')}</td>
                    {syms.map((t, j) => (
                      <td key={t} className="px-1 py-1">
                        <HeatCell text={(cmp?.matrix?.[i]?.[j] ?? 0).toFixed(2)} color={corrColor(cmp?.matrix?.[i]?.[j] ?? 0)} />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="mt-4 premium-card overflow-x-auto">
          <table className="w-full min-w-[520px] text-left text-sm">
            <thead>
              <tr className="border-b border-white/5 text-[10px] uppercase tracking-wider text-slate-500">
                <th className="px-4 py-2.5">Symbol</th>
                <th className="px-4 py-2.5 text-right">Change</th>
                <th className="px-4 py-2.5 text-right">Vol (ann.)</th>
                <th className="px-4 py-2.5 text-right">Beta vs BTC</th>
                <th className="px-4 py-2.5 text-right">Corr</th>
              </tr>
            </thead>
            <tbody>
              {(cmp?.rows || []).map(r => (
                <tr key={r.symbol} className="border-b border-white/[0.03] last:border-0 hover:bg-white/[0.02]">
                  <td className="px-4 py-2 font-mono text-[12px] text-slate-200">{r.symbol.replace('USDT', '')}</td>
                  <td className={`px-4 py-2 text-right font-mono text-[12px] ${r.change_pct >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                    {r.change_pct >= 0 ? '+' : ''}{r.change_pct}%
                  </td>
                  <td className="px-4 py-2 text-right font-mono text-[12px] text-slate-300">{r.vol_pct}%</td>
                  <td className="px-4 py-2 text-right font-mono text-[12px] text-slate-300">{r.beta}</td>
                  <td className="px-4 py-2 text-right font-mono text-[12px] text-slate-300">{r.corr}</td>
                </tr>
              ))}
              {!cmp?.rows?.length && (
                <tr><td colSpan={5} className="px-4 py-6 text-center text-xs text-slate-500">{loading ? 'Loading…' : 'No data'}</td></tr>
              )}
            </tbody>
          </table>
        </div>
        <div className="mt-2 font-mono text-[10px] text-slate-600">
          daily klines · {days}d window · recorded {cmp?.as_of || '—'} · source binance / bybit
        </div>
      </div>
    </div>
  );
};

export default MarketsPage;
