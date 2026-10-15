import React, { useEffect, useState, useCallback } from 'react';
import { Activity, TrendingUp, TrendingDown, RefreshCw, Landmark, Percent, DollarSign } from 'lucide-react';
import { apiFetch } from '../utils/apiClient';

interface MacroPoint {
  id: string;
  value: number;
  prev: number;
  change: number;
  date: string;
  yoy_pct?: number;
}
interface MacroResponse {
  series: Record<string, MacroPoint>;
  timestamp?: number;
  note?: string;
}
interface FxResponse {
  base: string;
  date: string;
  rates: Record<string, number>;
}

const SERIES_META: Record<string, { label: string; unit?: string; hint: string }> = {
  fed_funds: { label: 'Fed Funds', unit: '%', hint: 'Effective policy rate' },
  us10y: { label: 'US 10Y', unit: '%', hint: '10-year Treasury yield' },
  us2y: { label: 'US 2Y', unit: '%', hint: '2-year Treasury yield' },
  spread_10y2y: { label: '10Y–2Y', unit: '%', hint: 'Curve spread (recession signal)' },
  cpi: { label: 'CPI YoY', unit: '%', hint: 'Headline inflation, year over year' },
  unemployment: { label: 'Unemployment', unit: '%', hint: 'US unemployment rate' },
  dollar_index: { label: 'Dollar Index', hint: 'Broad USD index' },
  vix: { label: 'VIX', hint: 'Equity volatility' },
};

const fmt = (v: number, unit?: string) => `${v}${unit === '%' ? '%' : ''}`;

const MacroView: React.FC = () => {
  const [macro, setMacro] = useState<MacroResponse | null>(null);
  const [fx, setFx] = useState<FxResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [asOf, setAsOf] = useState<string>('');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [mRes, fRes] = await Promise.all([
        apiFetch('/macro', { timeoutMs: 45000 }),
        apiFetch('/fx', { timeoutMs: 30000 }),
      ]);
      const m = await mRes.json();
      const f = await fRes.json();
      if (m?.note && !m?.series) throw new Error(m.note);
      setMacro(m);
      setFx(f);
      setAsOf(new Date().toLocaleTimeString());
    } catch (e: any) {
      setError(e?.message || 'Failed to load macro data');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const series = macro?.series || {};
  const order = Object.keys(SERIES_META);

  return (
    <div className="h-full overflow-y-auto p-5 lg:p-6 pb-28 lg:pb-6">
      <div className="mx-auto max-w-6xl">
        {/* Header */}
        <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="flex items-center gap-2 text-lg font-bold tracking-wide text-white">
              <Landmark size={18} className="text-brand-accent" /> Macro & FX
            </h1>
            <p className="mt-1 text-xs text-slate-500">
              Rates, inflation and dollar strength from FRED · reference FX from the ECB
            </p>
          </div>
          <div className="flex items-center gap-3">
            {asOf && (
              <span className="font-mono text-[10px] text-slate-500">
                recorded {asOf} · source FRED / ECB
              </span>
            )}
            <button
              onClick={load}
              disabled={loading}
              className="flex items-center gap-2 rounded-lg border border-white/10 px-3 py-1.5 text-xs text-slate-300 hover:bg-white/5 disabled:opacity-50"
            >
              <RefreshCw size={13} className={loading ? 'animate-spin' : ''} /> Refresh
            </button>
          </div>
        </div>

        {error && (
          <div className="mb-5 rounded-xl border border-rose-500/30 bg-rose-500/10 p-4 text-sm text-rose-300">
            {error}
          </div>
        )}

        {/* Rate / inflation grid */}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {order.map(key => {
            const meta = SERIES_META[key];
            const p = series[key];
            if (!p) return null;
            const val = key === 'cpi' && p.yoy_pct !== undefined ? p.yoy_pct : p.value;
            const up = p.change >= 0;
            return (
              <div key={key} className="fintech-card p-4" title={meta.hint}>
                <div className="flex items-center justify-between">
                  <span className="text-[10px] font-bold uppercase tracking-wider text-slate-500">
                    {meta.label}
                  </span>
                  {p.change !== 0 && (
                    <span className={`flex items-center gap-0.5 text-[10px] font-mono ${up ? 'text-emerald-400' : 'text-rose-400'}`}>
                      {up ? <TrendingUp size={11} /> : <TrendingDown size={11} />}
                      {Math.abs(p.change).toFixed(2)}
                    </span>
                  )}
                </div>
                <div className="mt-2 font-mono text-2xl font-black tracking-tight text-white">
                  {fmt(val, meta.unit)}
                </div>
                <div className="mt-1 text-[10px] font-mono text-slate-500">
                  as of {p.date} · {p.id}
                </div>
              </div>
            );
          })}
        </div>

        {/* FX strip */}
        <div className="mt-6">
          <div className="mb-3 flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-slate-400">
            <DollarSign size={14} className="text-brand-accent" /> FX reference rates
          </div>
          <div className="fintech-card grid grid-cols-2 gap-px overflow-hidden sm:grid-cols-3 lg:grid-cols-6">
            {fx?.rates && Object.entries(fx.rates).map(([ccy, rate]) => (
              <div key={ccy} className="p-4">
                <div className="text-[10px] font-bold uppercase tracking-wider text-slate-500">
                  {fx.base}/{ccy}
                </div>
                <div className="mt-1 font-mono text-lg font-bold text-white">
                  {Number(rate).toFixed(4)}
                </div>
              </div>
            ))}
            {!fx?.rates && !loading && (
              <div className="p-4 text-xs text-slate-500">FX unavailable</div>
            )}
          </div>
          {fx?.date && (
            <div className="mt-2 font-mono text-[10px] text-slate-600">
              ECB reference rates · {fx.date} · source frankfurter.dev
            </div>
          )}
        </div>

        {/* Context */}
        <div className="mt-6 fintech-card p-5">
          <div className="mb-2 flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-slate-400">
            <Percent size={14} className="text-brand-accent" /> How to read this
          </div>
          <ul className="space-y-1.5 text-[12px] text-slate-400">
            <li>• A rising <span className="text-slate-200">10Y–2Y spread</span> above zero points to a steepening, risk-on curve.</li>
            <li>• <span className="text-slate-200">CPI YoY</span> above the Fed's 2% target keeps policy tight → pressure on risk assets.</li>
            <li>• A rising <span className="text-slate-200">dollar index</span> is a headwind for crypto; falling is a tailwind.</li>
            <li>• <span className="text-slate-200">VIX</span> spikes usually precede short-term crypto drawdowns.</li>
            <li className="flex items-center gap-1.5 pt-1 text-slate-500">
              <Activity size={11} /> Every card shows its own as-of date and series ID — recorded, not hand-entered.
            </li>
          </ul>
        </div>
      </div>
    </div>
  );
};

export default MacroView;
