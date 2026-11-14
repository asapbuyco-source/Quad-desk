import React, { useCallback, useEffect, useState } from 'react';
import { Users, RefreshCw, Activity } from 'lucide-react';
import { apiFetch } from '../utils/apiClient';
import { useStore } from '../store';

interface Point { t: number; long?: number; short?: number; ratio: number; buy?: number; sell?: number }
interface Bucket { latest?: Point; series?: Point[]; error?: string }
interface PositioningResponse {
  symbol: string;
  period: string;
  as_of: string;
  series: Record<string, Bucket>;
}

const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'DOGEUSDT', 'LINKUSDT'];
const PERIODS = ['5m', '15m', '1h', '4h'];

const Spark: React.FC<{ values: number[]; color?: string }> = ({ values, color = '#3b82f6' }) => {
  if (values.length < 2) return <div className="h-10" />;
  const w = 220, h = 40;
  const min = Math.min(...values), max = Math.max(...values);
  const span = max - min || 1;
  const pts = values.map((v, i) => `${(i / (values.length - 1)) * w},${h - ((v - min) / span) * h}`).join(' ');
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="h-10 w-full" preserveAspectRatio="none">
      <polyline points={pts} fill="none" stroke={color} strokeWidth="1.6" vectorEffect="non-scaling-stroke" />
    </svg>
  );
};

const RatioCard: React.FC<{ title: string; bucket?: Bucket; hint?: string }> = ({ title, bucket, hint }) => {
  const latest = bucket?.latest;
  const longPct = latest?.long !== undefined ? latest.long * 100 : null;
  const shortPct = latest?.short !== undefined ? latest.short * 100 : null;
  const ratio = latest?.ratio;

  return (
    <div className="fintech-card p-4">
      <div className="flex items-start justify-between">
        <div>
          <div className="text-[10px] font-bold uppercase tracking-wider text-slate-500">{title}</div>
          {hint && <div className="mt-0.5 text-[9px] text-slate-600">{hint}</div>}
        </div>
        <div className={`font-mono text-lg font-black ${ratio === undefined ? 'text-slate-500' : ratio >= 1 ? 'text-emerald-400' : 'text-rose-400'}`}>
          {ratio === undefined ? '—' : ratio.toFixed(2)}
        </div>
      </div>

      {longPct !== null && shortPct !== null ? (
        <>
          <div className="mt-3 flex h-1.5 overflow-hidden rounded-full bg-slate-800">
            <div className="bg-emerald-500" style={{ width: `${longPct}%` }} />
            <div className="bg-rose-500" style={{ width: `${shortPct}%` }} />
          </div>
          <div className="mt-1 flex justify-between font-mono text-[9px] text-slate-500">
            <span className="text-emerald-400/80">L {longPct.toFixed(1)}%</span>
            <span className="text-rose-400/80">S {shortPct.toFixed(1)}%</span>
          </div>
        </>
      ) : (
        <div className="mt-3 text-[11px] text-slate-500">{bucket?.error || 'No data'}</div>
      )}

      {bucket?.series && bucket.series.length > 1 && (
        <div className="mt-2">
          <Spark values={bucket.series.map(p => p.ratio)} color={ratio !== undefined && ratio >= 1 ? '#10b981' : '#f43f5e'} />
        </div>
      )}
    </div>
  );
};

const PositioningPage: React.FC = () => {
  const storeSymbol = useStore(s => s.config.activeSymbol as string | undefined);
  const [symbol, setSymbol] = useState((storeSymbol || 'BTCUSDT').toUpperCase());
  const [period, setPeriod] = useState('15m');
  const [data, setData] = useState<PositioningResponse | null>(null);
  const [taker, setTaker] = useState<Bucket | undefined>();
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (sym: string, per: string) => {
    setLoading(true);
    try {
      const res = await apiFetch(`/positioning?symbol=${sym}&period=${per}`, { timeoutMs: 45000 });
      const json: PositioningResponse = await res.json();
      setData(json);
      setTaker(json.series?.taker);
    } catch {
      setData(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(symbol, period); }, [load, symbol, period]);

  const s = data?.series || {};
  const takerRatio = taker?.latest?.ratio;

  return (
    <div className="h-full overflow-y-auto p-5 lg:p-6 pb-28 lg:pb-6">
      <div className="mx-auto max-w-6xl">
        <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="flex items-center gap-2 text-lg font-bold tracking-wide text-white">
              <Users size={18} className="text-brand-accent" /> Positioning
            </h1>
            <p className="mt-1 text-xs text-slate-500">
              Retail vs top-trader long/short, top positions and taker flow — Binance USDM futures
            </p>
          </div>
          <div className="flex items-center gap-2">
            <select value={symbol} onChange={e => setSymbol(e.target.value)}
              className="rounded-lg border border-white/10 bg-black/40 px-3 py-1.5 text-xs text-slate-200 outline-none">
              {SYMBOLS.map(sym => <option key={sym} value={sym}>{sym}</option>)}
            </select>
            <div className="flex items-center gap-1 rounded-lg border border-white/10 bg-black/30 p-0.5">
              {PERIODS.map(p => (
                <button key={p} onClick={() => setPeriod(p)}
                  className={`rounded-md px-2 py-1 text-[10px] font-bold uppercase tracking-wider transition-colors ${
                    period === p ? 'bg-brand-accent/20 text-brand-accent' : 'text-slate-500 hover:text-slate-300'}`}>
                  {p}
                </button>
              ))}
            </div>
            <button onClick={() => load(symbol, period)} disabled={loading}
              className="rounded-lg border border-white/10 p-1.5 text-slate-300 hover:bg-white/5 disabled:opacity-50">
              <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <RatioCard title="Retail accounts" hint="all accounts" bucket={s.global_accounts} />
          <RatioCard title="Top traders" hint="by account" bucket={s.top_accounts} />
          <RatioCard title="Top positions" hint="by position size" bucket={s.top_positions} />
          <div className="fintech-card p-4">
            <div className="flex items-start justify-between">
              <div>
                <div className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Taker flow</div>
                <div className="mt-0.5 text-[9px] text-slate-600">buy vs sell volume</div>
              </div>
              <div className={`font-mono text-lg font-black ${takerRatio === undefined ? 'text-slate-500' : takerRatio >= 1 ? 'text-emerald-400' : 'text-rose-400'}`}>
                {takerRatio === undefined ? '—' : takerRatio.toFixed(2)}
              </div>
            </div>
            {taker?.latest?.buy !== undefined && taker?.latest?.sell !== undefined ? (
              <>
                <div className="mt-3 flex h-1.5 overflow-hidden rounded-full bg-slate-800">
                  <div className="bg-emerald-500" style={{ width: `${(taker.latest.buy / (taker.latest.buy + taker.latest.sell)) * 100}%` }} />
                </div>
                <div className="mt-1 flex justify-between font-mono text-[9px] text-slate-500">
                  <span className="text-emerald-400/80">Buy {Math.round(taker.latest.buy).toLocaleString()}</span>
                  <span className="text-rose-400/80">Sell {Math.round(taker.latest.sell).toLocaleString()}</span>
                </div>
              </>
            ) : (
              <div className="mt-3 text-[11px] text-slate-500">No data</div>
            )}
            {taker?.series && taker.series.length > 1 && (
              <div className="mt-2"><Spark values={taker.series.map(p => p.ratio)} color={takerRatio && takerRatio >= 1 ? '#10b981' : '#f43f5e'} /></div>
            )}
          </div>
        </div>

        <div className="mt-4 fintech-card p-4">
          <div className="mb-2 flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-slate-400">
            <Activity size={13} className="text-brand-accent" /> How to read this
          </div>
          <ul className="space-y-1 text-[11px] text-slate-400">
            <li>• Ratio &gt; 1 means more longs than shorts. Retail extremes often mark local reversals; top-trader positioning is usually the contrarian tell.</li>
            <li>• Divergence between retail and top traders is the signal worth watching, not either number alone.</li>
            <li>• Taker flow &gt; 1 = aggressive buying; watch it with price to judge absorption.</li>
          </ul>
          <div className="mt-2 font-mono text-[10px] text-slate-600">
            recorded {data?.as_of || '—'} · period {period} · source binance-fapi
          </div>
        </div>
      </div>
    </div>
  );
};

export default PositioningPage;
