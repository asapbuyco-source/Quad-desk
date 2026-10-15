import React, { useEffect, useState, useCallback } from 'react';
import { RefreshCw, ArrowUpRight, ArrowDownRight, Layers, Radio, Building2, TrendingUp } from 'lucide-react';
import { apiFetch } from '../utils/apiClient';
import { useStore } from '../store';

interface VenueRow {
  price?: number;
  funding_rate?: number;
  open_interest?: number;
  source?: string;
  error?: string;
}
interface CrossVenueResponse {
  symbol: string;
  as_of: string;
  venues: Record<string, VenueRow>;
}
interface FundingRow {
  symbol: string;
  funding_rate: number;
  mark_price: number;
}
interface FundingHeatmapResponse {
  as_of: string;
  count: number;
  highest: FundingRow[];
  lowest: FundingRow[];
}
interface PremiumResponse {
  symbol: string;
  coinbase?: number;
  binance?: number;
  premium_pct?: number;
  as_of: string;
  error?: string;
}
interface OiRow {
  symbol: string;
  oi_usd: number;
  oi_change_24h_pct: number;
  price_change_24h_pct: number;
}
interface OiResponse {
  as_of: string;
  rows: OiRow[];
}

const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'DOGEUSDT', 'LINKUSDT'];
const pct = (v?: number) => (v === undefined ? '—' : `${(v * 100).toFixed(4)}%`);
const usd = (v?: number) => (v === undefined ? '—' : v.toLocaleString(undefined, { maximumFractionDigits: 0 }));

const DerivedCard: React.FC<{ label: string; value: React.ReactNode; sub?: string; tone?: string }> = ({ label, value, sub, tone = 'text-white' }) => (
  <div className="fintech-card p-4">
    <div className="text-[10px] font-bold uppercase tracking-wider text-slate-500">{label}</div>
    <div className={`mt-1.5 font-mono text-xl font-black tracking-tight ${tone}`}>{value}</div>
    {sub && <div className="mt-1 font-mono text-[10px] text-slate-500">{sub}</div>}
  </div>
);

const DerivativesView: React.FC = () => {
  const storeSymbol = useStore(s => s.config.activeSymbol as string | undefined);
  const [symbol, setSymbol] = useState((storeSymbol || 'BTCUSDT').toUpperCase());
  const [cross, setCross] = useState<CrossVenueResponse | null>(null);
  const [premium, setPremium] = useState<PremiumResponse | null>(null);
  const [heat, setHeat] = useState<FundingHeatmapResponse | null>(null);
  const [oi, setOi] = useState<OiResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (sym: string) => {
    setLoading(true);
    setError(null);
    try {
      const [cRes, pRes, hRes, oRes] = await Promise.all([
        apiFetch(`/cross-venue?symbol=${sym}`, { timeoutMs: 40000 }),
        apiFetch(`/premium?symbol=${sym}`, { timeoutMs: 30000 }),
        apiFetch('/funding-heatmap', { timeoutMs: 40000 }),
        apiFetch('/oi-leaderboard', { timeoutMs: 40000 }),
      ]);
      setCross(await cRes.json());
      setPremium(await pRes.json());
      setHeat(await hRes.json());
      setOi(await oRes.json());
    } catch (e: any) {
      setError(e?.message || 'Failed to load derivatives data');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(symbol); }, [load, symbol]);

  const venues = cross?.venues || {};
  const premTone = (premium?.premium_pct ?? 0) >= 0 ? 'text-emerald-400' : 'text-rose-400';

  return (
    <div className="h-full overflow-y-auto p-5 lg:p-6 pb-28 lg:pb-6">
      <div className="mx-auto max-w-6xl">
        {/* Header */}
        <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="flex items-center gap-2 text-lg font-bold tracking-wide text-white">
              <Layers size={18} className="text-brand-accent" /> Derivatives & Flows
            </h1>
            <p className="mt-1 text-xs text-slate-500">
              Funding and open interest across venues · US spot premium · funding extremes market-wide
            </p>
          </div>
          <div className="flex items-center gap-3">
            <select
              value={symbol}
              onChange={e => setSymbol(e.target.value)}
              className="rounded-lg border border-white/10 bg-black/40 px-3 py-1.5 text-xs text-slate-200 outline-none"
            >
              {SYMBOLS.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
            <button
              onClick={() => load(symbol)}
              disabled={loading}
              className="flex items-center gap-2 rounded-lg border border-white/10 px-3 py-1.5 text-xs text-slate-300 hover:bg-white/5 disabled:opacity-50"
            >
              <RefreshCw size={13} className={loading ? 'animate-spin' : ''} /> Refresh
            </button>
          </div>
        </div>

        {error && (
          <div className="mb-5 rounded-xl border border-rose-500/30 bg-rose-500/10 p-4 text-sm text-rose-300">{error}</div>
        )}

        {/* Premium + venue summary */}
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          <DerivedCard
            label="Coinbase premium"
            tone={premTone}
            value={premium?.premium_pct === undefined ? '—' : `${premium.premium_pct >= 0 ? '+' : ''}${premium.premium_pct}%`}
            sub={premium?.coinbase ? `CB ${premium.coinbase.toLocaleString()} · BN ${premium.binance?.toLocaleString()}` : 'US spot vs global'}
          />
          <DerivedCard
            label="Binance funding"
            tone={(venues.binance?.funding_rate ?? 0) >= 0 ? 'text-emerald-400' : 'text-rose-400'}
            value={pct(venues.binance?.funding_rate)}
            sub={venues.binance?.error ? 'unavailable' : 'per interval · source binance-fapi'}
          />
          <DerivedCard
            label="Binance open interest"
            value={usd(venues.binance?.open_interest)}
            sub="contracts · as of now"
          />
        </div>

        {/* Cross-venue table */}
        <div className="mt-6">
          <div className="mb-3 flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-slate-400">
            <Building2 size={14} className="text-brand-accent" /> Cross-venue — {cross?.symbol || symbol}
          </div>
          <div className="fintech-card overflow-hidden">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-white/5 text-[10px] uppercase tracking-wider text-slate-500">
                  <th className="px-4 py-3">Venue</th>
                  <th className="px-4 py-3 text-right">Mark price</th>
                  <th className="px-4 py-3 text-right">Funding</th>
                  <th className="px-4 py-3 text-right">Open interest</th>
                  <th className="px-4 py-3 text-right">Source</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(venues).map(([name, v]) => (
                  <tr key={name} className="border-b border-white/[0.03] last:border-0 hover:bg-white/[0.02]">
                    <td className="px-4 py-3 font-medium capitalize text-slate-200">{name}</td>
                    <td className="px-4 py-3 text-right font-mono text-slate-300">{v.error ? '—' : usd(v.price)}</td>
                    <td className={`px-4 py-3 text-right font-mono ${(v.funding_rate ?? 0) >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                      {v.error ? '—' : pct(v.funding_rate)}
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-slate-300">{v.error ? '—' : usd(v.open_interest)}</td>
                    <td className="px-4 py-3 text-right font-mono text-[10px] text-slate-500">{v.source || '—'}</td>
                  </tr>
                ))}
                {!Object.keys(venues).length && !loading && (
                  <tr><td colSpan={5} className="px-4 py-6 text-center text-xs text-slate-500">No venue data</td></tr>
                )}
              </tbody>
            </table>
          </div>
          {cross?.as_of && (
            <div className="mt-2 font-mono text-[10px] text-slate-600">recorded {cross.as_of} · public venue APIs</div>
          )}
        </div>

        {/* Funding heatmap */}
        <div className="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-2">
          {[
            { title: 'Most positive funding', rows: heat?.highest, tone: 'text-emerald-400', Icon: ArrowUpRight, note: 'Longs pay shorts — crowded longs' },
            { title: 'Most negative funding', rows: heat?.lowest, tone: 'text-rose-400', Icon: ArrowDownRight, note: 'Shorts pay longs — crowded shorts' },
          ].map(col => (
            <div key={col.title} className="fintech-card p-4">
              <div className="mb-3 flex items-center justify-between">
                <span className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-slate-400">
                  <col.Icon size={14} className={col.tone} /> {col.title}
                </span>
                <span className="text-[10px] text-slate-500">{col.note}</span>
              </div>
              <div className="space-y-1">
                {(col.rows || []).map(r => (
                  <div key={r.symbol} className="flex items-center justify-between rounded-lg px-2 py-1.5 hover:bg-white/[0.03]">
                    <span className="font-mono text-[12px] text-slate-300">{r.symbol}</span>
                    <span className={`font-mono text-[12px] font-bold ${col.tone}`}>{pct(r.funding_rate)}</span>
                  </div>
                ))}
                {!col.rows?.length && !loading && (
                  <div className="py-4 text-center text-xs text-slate-500">No data</div>
                )}
              </div>
            </div>
          ))}
        </div>
        {heat?.as_of && (
          <div className="mt-2 flex items-center gap-1.5 font-mono text-[10px] text-slate-600">
            <Radio size={10} /> {heat.count} Binance USDM perpetuals · recorded {heat.as_of} · source binance-fapi
          </div>
        )}

        {/* Open interest leaderboard */}
        <div className="mt-6">
          <div className="mb-3 flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-slate-400">
            <TrendingUp size={14} className="text-brand-accent" /> Open interest leaderboard — 24h change
          </div>
          <div className="fintech-card overflow-hidden">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-white/5 text-[10px] uppercase tracking-wider text-slate-500">
                  <th className="px-4 py-3">Symbol</th>
                  <th className="px-4 py-3 text-right">Open interest</th>
                  <th className="px-4 py-3 text-right">OI Δ 24h</th>
                  <th className="px-4 py-3 text-right">Price Δ 24h</th>
                </tr>
              </thead>
              <tbody>
                {(oi?.rows || []).map(r => (
                  <tr key={r.symbol} className="border-b border-white/[0.03] last:border-0 hover:bg-white/[0.02]">
                    <td className="px-4 py-2.5 font-mono text-[12px] text-slate-200">{r.symbol}</td>
                    <td className="px-4 py-2.5 text-right font-mono text-slate-300">{usd(r.oi_usd)}</td>
                    <td className={`px-4 py-2.5 text-right font-mono ${r.oi_change_24h_pct >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                      {r.oi_change_24h_pct >= 0 ? '+' : ''}{r.oi_change_24h_pct}%
                    </td>
                    <td className={`px-4 py-2.5 text-right font-mono ${r.price_change_24h_pct >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                      {r.price_change_24h_pct >= 0 ? '+' : ''}{r.price_change_24h_pct}%
                    </td>
                  </tr>
                ))}
                {!oi?.rows?.length && !loading && (
                  <tr><td colSpan={4} className="px-4 py-6 text-center text-xs text-slate-500">No data</td></tr>
                )}
              </tbody>
            </table>
          </div>
          {oi?.as_of && (
            <div className="mt-2 font-mono text-[10px] text-slate-600">
              OI in USD · recorded {oi.as_of} · source binance-fapi · rising OI + rising price = new longs
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default DerivativesView;
