import React, { useCallback, useEffect, useState } from 'react';
import { Users, RefreshCw, Activity, ArrowRight } from 'lucide-react';
import { apiFetch } from '../utils/apiClient';
import { useStore } from '../store';
import { PageHeader, StatTile } from './Premium';

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

const PositioningPage: React.FC = () => {
  const storeSymbol = useStore(s => s.config.activeSymbol as string | undefined);
  const setActiveTab = useStore(s => s.setActiveTab);
  const [symbol, setSymbol] = useState((storeSymbol || 'BTCUSDT').toUpperCase());
  const [period, setPeriod] = useState('15m');
  const [data, setData] = useState<PositioningResponse | null>(null);
  const [taker, setTaker] = useState<Bucket | undefined>();
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const next = (storeSymbol || '').toUpperCase();
    if (next && next !== symbol) setSymbol(next);
  }, [storeSymbol]);

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
  const retail = s.global_accounts?.latest?.ratio;
  const topAcc = s.top_accounts?.latest?.ratio;
  const topPos = s.top_positions?.latest?.ratio;
  const divergence = retail !== undefined && topPos !== undefined ? retail - topPos : undefined;
  const divSeries = (s.global_accounts?.series || []).map((p, i) => {
    const t = s.top_positions?.series?.[i]?.ratio;
    return t === undefined ? 0 : p.ratio - t;
  });

  return (
    <div className="h-full overflow-y-auto p-5 lg:p-6 pb-28 lg:pb-6">
      <div className="mx-auto max-w-6xl">
        <PageHeader
          icon={<Users size={16} />}
          title="Positioning"
          badge="FREE"
          source="binance-fapi"
          asOf={data?.as_of}
          subtitle="Retail vs top-trader long/short, top positions and taker flow â€” Binance USDM futures"
        >
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
        </PageHeader>

        <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-5">
          <StatTile
            label="Retail ratio"
            value={retail === undefined ? 'â€”' : retail.toFixed(2)}
            sub={s.global_accounts?.latest?.long !== undefined ? `${(s.global_accounts.latest.long * 100).toFixed(0)}% long` : "all accounts"}
            tone={retail === undefined ? 'text-slate-500' : retail >= 1 ? 'text-emerald-400' : 'text-rose-400'}
            spark={s.global_accounts?.series?.map(p => p.ratio)}
            sparkColor="#60a5fa"
          />
          <StatTile
            label="Top traders"
            value={topAcc === undefined ? 'â€”' : topAcc.toFixed(2)}
            sub={s.top_accounts?.latest?.long !== undefined ? `${(s.top_accounts.latest.long * 100).toFixed(0)}% long` : "by account"}
            tone={topAcc === undefined ? 'text-slate-500' : topAcc >= 1 ? 'text-emerald-400' : 'text-rose-400'}
            spark={s.top_accounts?.series?.map(p => p.ratio)}
            sparkColor="#a78bfa"
          />
          <StatTile
            label="Top positions"
            value={topPos === undefined ? 'â€”' : topPos.toFixed(2)}
            sub={s.top_positions?.latest?.long !== undefined ? `${(s.top_positions.latest.long * 100).toFixed(0)}% long` : "by position size"}
            tone={topPos === undefined ? 'text-slate-500' : topPos >= 1 ? 'text-emerald-400' : 'text-rose-400'}
            spark={s.top_positions?.series?.map(p => p.ratio)}
            sparkColor="#fbbf24"
          />
          <StatTile
            label="Divergence"
            value={divergence === undefined ? 'â€”' : `${divergence >= 0 ? '+' : ''}${divergence.toFixed(2)}`}
            sub={divergence === undefined ? 'retail âˆ’ top' : divergence > 0.5 ? 'retail crowded long' : divergence < -0.5 ? 'retail crowded short' : 'aligned'}
            tone={divergence === undefined ? 'text-slate-500' : Math.abs(divergence) > 0.5 ? 'text-amber-300' : 'text-slate-300'}
            spark={divSeries}
            sparkColor="#f472b6"
          />
          <StatTile
            label="Taker flow"
            value={takerRatio === undefined ? '—' : takerRatio.toFixed(2)}
            sub={taker?.latest?.buy !== undefined && taker?.latest?.sell !== undefined
              ? `${Math.round((taker.latest.buy / (taker.latest.buy + taker.latest.sell)) * 100)}% buy`
              : 'aggressive flow'}
            tone={takerRatio === undefined ? 'text-slate-500' : takerRatio >= 1 ? 'text-emerald-400' : 'text-rose-400'}
            spark={taker?.series?.map(p => p.ratio)}
            sparkColor="#f472b6"
          />
        </div>

        <div className="mt-4 fintech-card p-4">
          <div className="mb-2 flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-slate-400">
            <Activity size={13} className="text-brand-accent" /> How to read this
          </div>
          <ul className="space-y-1 text-[11px] text-slate-400">
            <li>â€¢ Ratio &gt; 1 means more longs than shorts. Retail extremes often mark local reversals; top-trader positioning is usually the contrarian tell.</li>
            <li>â€¢ Divergence between retail and top traders is the signal worth watching, not either number alone.</li>
            <li>â€¢ Taker flow &gt; 1 = aggressive buying; watch it with price to judge absorption.</li>
          </ul>
          <div className="mt-2 font-mono text-[10px] text-slate-600">
            recorded {data?.as_of || 'â€”'} Â· period {period} Â· source binance-fapi
          </div>
        </div>

        <div className="mt-4 premium-card flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <div className="text-xs font-bold text-white">Next: whale positions</div>
            <p className="text-[11px] text-slate-500">See what the largest Hyperliquid accounts hold against this positioning.</p>
          </div>
          <button onClick={() => setActiveTab('whales')}
            className="flex shrink-0 items-center gap-1.5 rounded-lg border border-brand-accent/30 bg-brand-accent/10 px-3 py-1.5 text-[11px] font-bold text-brand-accent hover:bg-brand-accent/20">
            Open Whales <ArrowRight size={12} />
          </button>
        </div>
      </div>
    </div>
  );
};

export default PositioningPage;
