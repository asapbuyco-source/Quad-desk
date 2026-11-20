import React, { useEffect, useState } from 'react';
import { apiFetch } from '../utils/apiClient';

interface Metric {
  label: string;
  value: string;
  sub: string;
  tone?: string;
}

const usd = (v?: number) => {
  if (v === undefined) return '—';
  if (v >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `$${(v / 1e3).toFixed(0)}K`;
  return `$${Math.round(v)}`;
};
const timeOf = (iso?: string) => {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
};

/**
 * Public "market record" strip — real values from the same endpoints the
 * terminal uses. Every tile prints its own recording time.
 */
const MarketRecord: React.FC = () => {
  const [metrics, setMetrics] = useState<Metric[]>([]);

  useEffect(() => {
    let dead = false;
    (async () => {
      const safe = async (path: string) => {
        try {
          const r = await apiFetch(path, { timeoutMs: 45000 });
          return await r.json();
        } catch { return null; }
      };
      const [f, p, l, pos, h] = await Promise.all([
        safe('/funding-history?symbol=BTCUSDT&limit=42'),
        safe('/premium?symbol=BTCUSDT'),
        safe('/liquidations?minutes=1440'),
        safe('/positioning?symbol=BTCUSDT&period=1h&limit=24'),
        safe('/funding-heatmap'),
      ]);
      if (dead) return;

      const out: Metric[] = [];
      if (f?.latest) {
        const r = f.latest.rate as number;
        out.push({
          label: 'BTC funding',
          value: `${r >= 0 ? '+' : ''}${(r * 100).toFixed(4)}%`,
          sub: `recorded ${timeOf(f.as_of)} · 8h`,
          tone: r >= 0 ? 'text-rose-400' : 'text-emerald-400',
        });
      }
      if (f?.accumulated_pct !== undefined) {
        out.push({
          label: 'BTC funding 7d',
          value: `${f.accumulated_pct >= 0 ? '+' : ''}${f.accumulated_pct}%`,
          sub: `recorded ${timeOf(f.as_of)} · 42 settlements`,
          tone: f.accumulated_pct >= 0 ? 'text-rose-400' : 'text-emerald-400',
        });
      }
      if (p?.premium_pct !== undefined) {
        out.push({
          label: 'Coinbase premium',
          value: `${p.premium_pct >= 0 ? '+' : ''}${p.premium_pct}%`,
          sub: `recorded ${timeOf(p.as_of)} · US spot`,
          tone: p.premium_pct >= 0 ? 'text-emerald-400' : 'text-rose-400',
        });
      }
      if (l?.totals) {
        const net = (l.totals.short_usd || 0) - (l.totals.long_usd || 0);
        out.push({
          label: 'Liquidations 24h',
          value: usd(l.totals.long_usd + l.totals.short_usd),
          sub: `recorded ${timeOf(l.as_of)} · ${l.totals.count} orders`,
          tone: net >= 0 ? 'text-emerald-400' : 'text-rose-400',
        });
      }
      const ratio = pos?.series?.global_accounts?.latest?.ratio;
      if (ratio !== undefined) {
        out.push({
          label: 'Retail long/short',
          value: ratio.toFixed(2),
          sub: `recorded ${timeOf(pos.as_of)} · all accounts`,
          tone: ratio >= 1 ? 'text-emerald-400' : 'text-rose-400',
        });
      }
      if (h?.count) {
        out.push({
          label: 'Perps covered',
          value: String(h.count),
          sub: `recorded ${timeOf(h.as_of)} · funding scan`,
          tone: 'text-slate-200',
        });
      }
      setMetrics(out);
    })();
    return () => { dead = true; };
  }, []);

  return (
    <section className="relative z-10 px-4 sm:px-6">
      <div className="mx-auto max-w-6xl">
        <div className="mb-4 flex flex-wrap items-end justify-between gap-2">
          <div>
            <h2 className="text-2xl sm:text-3xl font-bold text-white">The market, recorded.</h2>
            <p className="mt-1 text-sm text-slate-400">Same data for everyone — every panel prints its source and timestamp.</p>
          </div>
          <a href="/methodology" className="text-[11px] font-semibold text-brand-accent hover:underline">How we collect →</a>
        </div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
          {(metrics.length ? metrics : Array.from({ length: 6 }).map((_, i) => ({
            label: '—', value: '—', sub: 'loading', tone: 'text-slate-600', key: i,
          } as any))).map((m: any, i: number) => (
            <div key={`${m.label}-${i}`} className="premium-card p-3">
              <div className="text-[9px] font-bold uppercase tracking-wider text-slate-500">{m.label}</div>
              <div className={`mt-1 font-mono text-base font-black ${m.tone || 'text-white'}`}>{m.value}</div>
              <div className="mt-0.5 truncate font-mono text-[8px] text-slate-600">{m.sub}</div>
            </div>
          ))}
        </div>
        <div className="mt-3 flex flex-wrap gap-4 font-mono text-[10px] text-slate-600">
          <a href="/methodology" className="hover:text-slate-400">Methodology</a>
          <a href="/coverage" className="hover:text-slate-400">Coverage</a>
          <a href="/changelog" className="hover:text-slate-400">Changelog</a>
          <a href="/learn" className="hover:text-slate-400">Glossary</a>
        </div>
      </div>
    </section>
  );
};

export default MarketRecord;
