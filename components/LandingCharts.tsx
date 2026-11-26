import React, { useEffect, useState } from 'react';
import { cachedJson } from '../utils/cachedFetch';
import { Sparkline } from './Premium';

interface Hourly { t: number; long_usd: number; short_usd: number }
interface Liq { totals?: { long_usd: number; short_usd: number; count: number }; hourly?: Hourly[]; as_of?: string }
interface Funding { history?: { rate: number }[]; latest?: { rate: number }; accumulated_pct?: number; as_of?: string }
interface Alt { index?: number; label?: string; beating?: number; count?: number; as_of?: string }

const usd = (v?: number) => {
  if (v === undefined) return '—';
  if (v >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `$${(v / 1e3).toFixed(0)}K`;
  return `$${Math.round(v)}`;
};

/** Live, recorded charts for the landing page. No placeholder series. */
const LandingCharts: React.FC = () => {
  const [funding, setFunding] = useState<Funding | null>(null);
  const [liq, setLiq] = useState<Liq | null>(null);
  const [alt, setAlt] = useState<Alt | null>(null);

  useEffect(() => {
    let dead = false;
    (async () => {
      try {
        const [f, l, a] = await Promise.all([
          cachedJson<Funding>('/funding-history?symbol=BTCUSDT&limit=42', { ttlMs: 180000, timeoutMs: 45000 }),
          cachedJson<Liq>('/liquidations?minutes=1440', { ttlMs: 180000, timeoutMs: 45000 }),
          cachedJson<Alt>('/altseason?days=30', { ttlMs: 300000, timeoutMs: 60000 }),
        ]);
        if (dead) return;
        setFunding(f); setLiq(l); setAlt(a);
      } catch { /* keep empty */ }
    })();
    return () => { dead = true; };
  }, []);

  const rates = (funding?.history || []).map(p => p.rate);
  const latest = funding?.latest?.rate;
  const hourly = liq?.hourly || [];
  const maxHour = Math.max(1, ...hourly.map(h => h.long_usd + h.short_usd));
  const idx = alt?.index ?? 0;
  const altTone = idx >= 75 ? 'text-emerald-400' : idx <= 25 ? 'text-rose-400' : 'text-amber-300';

  return (
    <section className="px-4 sm:px-6 py-6">
      <div className="mx-auto max-w-6xl">
        <div className="mb-4 flex flex-wrap items-end justify-between gap-2">
          <div>
            <h2 className="text-2xl sm:text-3xl font-bold text-white">Market pulse</h2>
            <p className="mt-1 text-sm text-slate-400">Three charts, recorded from the same feeds the terminal uses.</p>
          </div>
          <a href="/" className="text-[11px] font-semibold text-brand-accent hover:underline">Open the full desk →</a>
        </div>

        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          <div className="premium-card p-4">
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-bold uppercase tracking-wider text-slate-500">BTC funding · 7d</span>
              <span className={`font-mono text-[11px] font-bold ${(latest ?? 0) >= 0 ? 'text-rose-400' : 'text-emerald-400'}`}>
                {latest === undefined ? '—' : `${latest >= 0 ? '+' : ''}${(latest * 100).toFixed(4)}%`}
              </span>
            </div>
            <div className="mt-2">
              {rates.length > 1
                ? <Sparkline values={rates} color={(latest ?? 0) >= 0 ? '#f43f5e' : '#10b981'} height={96} />
                : <div className="h-24 animate-pulse rounded bg-white/[0.04]" />}
            </div>
            <div className="mt-1 font-mono text-[9px] text-slate-600">
              accumulated {funding?.accumulated_pct === undefined ? '—' : `${funding.accumulated_pct}%`} · 8h settlements
            </div>
          </div>

          <div className="premium-card p-4">
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Liquidations · 24h</span>
              <span className="font-mono text-[11px] text-slate-400">
                {usd((liq?.totals?.long_usd ?? 0) + (liq?.totals?.short_usd ?? 0))}
              </span>
            </div>
            <div className="mt-3 flex h-24 items-end gap-1">
              {hourly.length ? hourly.map((h, i) => (
                <div key={i} className="flex h-full flex-1 flex-col justify-end gap-px"
                  title={`L ${usd(h.long_usd)} / S ${usd(h.short_usd)}`}>
                  <div className="w-full rounded-sm bg-rose-500/80" style={{ height: `${(h.long_usd / maxHour) * 100}%` }} />
                  <div className="w-full rounded-sm bg-emerald-500/80" style={{ height: `${(h.short_usd / maxHour) * 100}%` }} />
                </div>
              )) : <div className="h-full w-full animate-pulse rounded bg-white/[0.04]" />}
            </div>
            <div className="mt-1 flex justify-between font-mono text-[9px] text-slate-600">
              <span>red longs · green shorts</span><span>now</span>
            </div>
          </div>

          <div className="premium-card p-4">
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Altseason · 30d</span>
              <span className={`font-mono text-[11px] ${altTone}`}>{alt?.label || '—'}</span>
            </div>
            <div className={`mt-2 font-mono text-5xl font-black ${altTone}`}>{alt?.index ?? '—'}</div>
            <div className="mt-2 h-2 overflow-hidden rounded-full bg-slate-800">
              <div className={`h-full rounded-full ${idx >= 75 ? 'bg-emerald-500' : idx <= 25 ? 'bg-rose-500' : 'bg-amber-500'}`}
                style={{ width: `${idx}%` }} />
            </div>
            <div className="mt-2 font-mono text-[9px] text-slate-600">
              {alt ? `${alt.beating}/${alt.count} alts beating BTC` : 'breadth of majors vs BTC'}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
};

export default LandingCharts;
