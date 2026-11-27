import React, { useCallback, useEffect, useState } from 'react';
import { Bitcoin, RefreshCw } from 'lucide-react';
import { cachedJson } from '../utils/cachedFetch';
import { useStore } from '../store';
import { PageHeader, Sparkline, EmptyState } from './Premium';

interface PremiumPoint { t: number; premium: number; coinbase: number; binance: number }
interface PremiumResp {
  latest?: PremiumPoint; avg?: number; min?: number; max?: number; hours?: number;
  series: PremiumPoint[]; error?: string;
}
interface FuturesResp {
  price?: number; index?: number; basis_pct?: number; change_24h?: number; volume_24h?: number;
  funding_rate?: number; next_funding_time?: string; oi_usd?: number; oi_change_24h?: number;
  long_short?: number; taker_ratio?: number;
  liq_24h?: { long_usd: number; short_usd: number; count: number }; error?: string;
}
interface FundingResp { history?: { t: number; rate: number }[]; error?: string }
interface StrikeRow { strike: number; call_oi: number; put_oi: number; iv: number | null }
interface ExpiryRow { expiry: string; days: number | null; oi: number; volume_usd: number; atm_iv: number | null }
interface OptionsResp {
  spot?: number; total_oi_contracts?: number; total_oi_usd?: number; volume_24h_usd?: number;
  call_oi?: number; put_oi?: number; put_call_ratio?: number; max_pain?: number;
  dvol?: number; dvol_percentile_1y?: number; rv_30d?: number; iv_rv_spread?: number;
  dvol_series?: { t: number; close: number }[]; expiries?: ExpiryRow[]; strikes?: StrikeRow[]; error?: string;
}

const COINS = ['BTC', 'ETH', 'SOL'] as const;
type Coin = typeof COINS[number];
type Tab = 'premium' | 'futures' | 'options';

const usd = (v?: number) => {
  if (v === undefined) return '—';
  if (v >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `$${(v / 1e3).toFixed(0)}K`;
  return `$${Math.round(v)}`;
};
const price = (v?: number) => (v === undefined ? '—' : v.toLocaleString(undefined, { maximumFractionDigits: 2 }));

const Tile: React.FC<{ label: string; value: string; sub?: string; tone?: string }> = ({ label, value, sub, tone = 'text-white' }) => (
  <div className="premium-card p-4">
    <div className="text-[10px] font-bold uppercase tracking-wider text-slate-500">{label}</div>
    <div className={`mt-1 font-mono text-xl font-black ${tone}`}>{value}</div>
    {sub && <div className="mt-0.5 font-mono text-[10px] text-slate-500">{sub}</div>}
  </div>
);

const CoinPage: React.FC = () => {
  const [coin, setCoin] = useState<Coin>('BTC');
  const [tab, setTab] = useState<Tab>('premium');
  const [premium, setPremium] = useState<PremiumResp | null>(null);
  const [fut, setFut] = useState<FuturesResp | null>(null);
  const [funding, setFunding] = useState<FundingResp | null>(null);
  const [opt, setOpt] = useState<OptionsResp | null>(null);
  const [loading, setLoading] = useState(true);
  const setActiveTab = useStore(s => s.setActiveTab);
  const symbol = `${coin}USDT`;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      if (tab === 'premium') {
        setPremium(await cachedJson<PremiumResp>(`/premium-history?symbol=${symbol}&hours=168`, { ttlMs: 300000, timeoutMs: 60000 }));
      } else if (tab === 'futures') {
        const [f, h] = await Promise.all([
          cachedJson<FuturesResp>(`/coin-futures?symbol=${symbol}`, { ttlMs: 120000, timeoutMs: 60000 }),
          cachedJson<FundingResp>(`/funding-history?symbol=${symbol}&limit=42`, { ttlMs: 300000, timeoutMs: 45000 }),
        ]);
        setFut(f); setFunding(h);
      } else {
        setOpt(await cachedJson<OptionsResp>(`/options?currency=${coin}`, { ttlMs: 120000, timeoutMs: 60000 }));
      }
    } catch { /* keep cached */ }
    finally { setLoading(false); }
  }, [tab, symbol, coin]);

  useEffect(() => { load(); }, [load]);

  const p = premium;
  const premSeries = (p?.series || []).map(x => x.premium);
  const latestPrem = p?.latest?.premium;
  const dvolSeries = (opt?.dvol_series || []).map(x => x.close);
  const strikes = opt?.strikes || [];
  const maxStrikeOi = Math.max(1, ...strikes.map(s => Math.max(s.call_oi, s.put_oi)));
  const liqTotal = (fut?.liq_24h?.long_usd ?? 0) + (fut?.liq_24h?.short_usd ?? 0);

  return (
    <div className="h-full overflow-y-auto p-5 lg:p-6 pb-28 lg:pb-6">
      <div className="mx-auto max-w-6xl">
        <PageHeader
          icon={<Bitcoin size={16} />}
          title="Coin Explorer"
          badge="FREE"
          subtitle="Premium, futures and options data per coin — recorded with sources and timestamps"
        >
          <div className="flex items-center gap-1 rounded-lg border border-white/10 bg-black/30 p-0.5">
            {COINS.map(c => (
              <button key={c} onClick={() => setCoin(c)}
                className={`rounded-md px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider ${
                  coin === c ? 'bg-brand-accent/20 text-brand-accent' : 'text-slate-500 hover:text-slate-300'}`}>
                {c}
              </button>
            ))}
          </div>
          <button onClick={load} disabled={loading}
            className="rounded-lg border border-white/10 p-1.5 text-slate-300 hover:bg-white/5 disabled:opacity-50">
            <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
          </button>
        </PageHeader>

        <div className="mb-4 flex rounded-lg border border-white/5 bg-black/30 p-0.5">
          {(['premium', 'futures', 'options'] as Tab[]).map(t => (
            <button key={t} onClick={() => setTab(t)}
              className={`flex-1 rounded-md py-2 text-[11px] font-bold uppercase tracking-wider ${
                tab === t ? 'bg-white/10 text-white' : 'text-slate-500 hover:text-slate-300'}`}>
              {t}
            </button>
          ))}
        </div>

        {tab === 'premium' && (
          <div className="space-y-3">
            {p?.error && <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 p-4 text-xs text-rose-300">{p.error}</div>}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div className="premium-card p-4 sm:col-span-1">
                <div className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Coinbase premium</div>
                <div className={`mt-1 font-mono text-3xl font-black ${latestPrem === undefined ? 'text-slate-500' : latestPrem >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                  {latestPrem === undefined ? '—' : `${latestPrem >= 0 ? '+' : ''}${latestPrem}%`}
                </div>
                <div className="mt-1 font-mono text-[10px] text-slate-500">
                  {latestPrem === undefined ? 'waiting for data' : latestPrem >= 0 ? 'US spot bidding above global' : 'US spot below global'}
                </div>
              </div>
              <Tile label="7d average" value={p?.avg === undefined ? '—' : `${p.avg >= 0 ? '+' : ''}${p.avg}%`}
                tone={(p?.avg ?? 0) >= 0 ? 'text-emerald-400' : 'text-rose-400'} sub={`${p?.hours ?? 0} hourly points`} />
              <Tile label="7d range" value={p ? `${p.min}% / ${p.max}%` : '—'} sub="min / max premium" />
            </div>
            <div className="premium-card p-4">
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs font-bold uppercase tracking-wider text-slate-400">Premium · 7d</span>
                <span className="font-mono text-[9px] text-slate-600">Coinbase spot vs Binance USD-M · hourly</span>
              </div>
              {premSeries.length > 1
                ? <Sparkline values={premSeries} color={(latestPrem ?? 0) >= 0 ? '#10b981' : '#f43f5e'} height={140} />
                : <div className="h-32 animate-pulse rounded bg-white/[0.04]" />}
            </div>
            <div className="premium-card p-4 font-mono text-[10px] text-slate-600">
              Positive premium means Coinbase is trading above the Binance reference — often read as US spot demand. Negative means offshore leads.
            </div>
          </div>
        )}

        {tab === 'futures' && (
          <div className="space-y-3">
            {fut?.error && <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 p-4 text-xs text-rose-300">{fut.error}</div>}
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <Tile label="Mark price" value={`$${price(fut?.price)}`} sub={fut ? `${fut.change_24h && fut.change_24h >= 0 ? '+' : ''}${fut.change_24h}% 24h` : ''}
                tone={(fut?.change_24h ?? 0) >= 0 ? 'text-emerald-400' : 'text-rose-400'} />
              <Tile label="Perp basis" value={fut?.basis_pct === undefined ? '—' : `${fut.basis_pct >= 0 ? '+' : ''}${fut.basis_pct}%`}
                sub="mark vs index" tone={(fut?.basis_pct ?? 0) >= 0 ? 'text-emerald-400' : 'text-rose-400'} />
              <Tile label="Funding (8h)" value={fut?.funding_rate === undefined ? '—' : `${(fut.funding_rate * 100).toFixed(4)}%`}
                sub="next settlement shown in Terminal" tone={(fut?.funding_rate ?? 0) >= 0 ? 'text-rose-400' : 'text-emerald-400'} />
              <Tile label="Open interest" value={usd(fut?.oi_usd)} sub={fut?.oi_change_24h === undefined ? '' : `${fut.oi_change_24h >= 0 ? '+' : ''}${fut.oi_change_24h}% 24h`} />
              <Tile label="24h futures volume" value={usd(fut?.volume_24h)} sub="quote volume" />
              <Tile label="Long/short" value={fut?.long_short === undefined ? '—' : fut.long_short.toFixed(2)} sub="retail accounts" />
              <Tile label="Taker buy/sell" value={fut?.taker_ratio === undefined ? '—' : fut.taker_ratio.toFixed(2)} sub="aggressive flow" />
              <Tile label="Liquidations 24h" value={usd(liqTotal)} sub={`L ${usd(fut?.liq_24h?.long_usd)} · S ${usd(fut?.liq_24h?.short_usd)}`} />
            </div>
            <div className="premium-card p-4">
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs font-bold uppercase tracking-wider text-slate-400">Funding history · 42 settlements</span>
                <span className="font-mono text-[9px] text-slate-600">8h settlements · positive = longs pay</span>
              </div>
              {(funding?.history?.length ?? 0) > 1
                ? <Sparkline values={(funding!.history || []).map(x => x.rate)} color="#60a5fa" height={130} />
                : <div className="h-28 animate-pulse rounded bg-white/[0.04]" />}
            </div>
            <div className="flex flex-wrap gap-2">
              <button onClick={() => setActiveTab('positioning')}
                className="rounded-lg border border-white/10 px-3 py-1.5 text-[11px] text-slate-300 hover:bg-white/5">Full positioning →</button>
              <button onClick={() => setActiveTab('liquidations')}
                className="rounded-lg border border-white/10 px-3 py-1.5 text-[11px] text-slate-300 hover:bg-white/5">Liquidation map →</button>
            </div>
          </div>
        )}

        {tab === 'options' && (
          <div className="space-y-3">
            {coin === 'SOL' ? (
              <div className="premium-card p-6">
                <EmptyState icon={<Bitcoin size={16} />} title="No listed SOL options" hint="Deribit options coverage is BTC and ETH. Switch coin to view the chain." />
              </div>
            ) : (
              <>
                {opt?.error && <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 p-4 text-xs text-rose-300">{opt.error}</div>}
                <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                  <Tile label="DVOL" value={opt?.dvol === undefined ? '—' : opt.dvol.toFixed(1)} sub={opt?.dvol_percentile_1y === undefined ? '' : `${opt.dvol_percentile_1y}th percentile · 1y`} />
                  <Tile label="Realised vol 30d" value={opt?.rv_30d === undefined ? '—' : `${opt.rv_30d}%`} sub={opt?.iv_rv_spread === undefined ? '' : `IV−RV ${opt.iv_rv_spread >= 0 ? '+' : ''}${opt.iv_rv_spread}`} />
                  <Tile label="Put / call OI" value={opt?.put_call_ratio === undefined ? '—' : opt.put_call_ratio.toFixed(2)} sub={`P ${opt?.put_oi ?? '—'} · C ${opt?.call_oi ?? '—'}`} />
                  <Tile label="Total OI" value={usd(opt?.total_oi_usd)} sub={`${opt?.total_oi_contracts ?? '—'} contracts`} />
                  <Tile label="24h options volume" value={usd(opt?.volume_24h_usd)} sub="Deribit" />
                  <Tile label="Max pain" value={opt?.max_pain === undefined ? '—' : `$${price(opt.max_pain)}`} sub="strike with least payout" />
                  <Tile label="Spot" value={`$${price(opt?.spot)}`} sub="Deribit index" />
                  <Tile label="Expiries" value={String(opt?.expiries?.length ?? '—')} sub="listed" />
                </div>

                <div className="premium-card p-4">
                  <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                    <span className="text-xs font-bold uppercase tracking-wider text-slate-400">DVOL · 1y</span>
                    <span className="font-mono text-[9px] text-slate-600">Deribit volatility index · daily closes</span>
                  </div>
                  {dvolSeries.length > 1
                    ? <Sparkline values={dvolSeries} color="#a78bfa" height={120} />
                    : <div className="h-24 animate-pulse rounded bg-white/[0.04]" />}
                </div>

                <div className="premium-card p-4">
                  <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                    <span className="text-xs font-bold uppercase tracking-wider text-slate-400">Open interest by strike</span>
                    <span className="font-mono text-[9px] text-slate-600">calls ← · → puts</span>
                  </div>
                  <div className="space-y-1">
                    {strikes.map(s => (
                      <div key={s.strike} className="flex items-center gap-2">
                        <div className="flex flex-1 justify-end">
                          <div className="h-3 rounded-l bg-emerald-500/80" style={{ width: `${(s.call_oi / maxStrikeOi) * 100}%` }} title={`Calls ${s.call_oi}`} />
                        </div>
                        <span className="w-20 shrink-0 text-center font-mono text-[10px] text-slate-400">{s.strike.toLocaleString()}</span>
                        <div className="flex flex-1">
                          <div className="h-3 rounded-r bg-rose-500/80" style={{ width: `${(s.put_oi / maxStrikeOi) * 100}%` }} title={`Puts ${s.put_oi}`} />
                        </div>
                      </div>
                    ))}
                    {!strikes.length && <div className="py-6 text-center text-xs text-slate-500">No chain data</div>}
                  </div>
                </div>

                <div className="premium-card overflow-x-auto">
                  <table className="w-full min-w-[520px] text-left text-sm">
                    <thead>
                      <tr className="border-b border-white/5 text-[10px] uppercase tracking-wider text-slate-500">
                        <th className="px-4 py-2.5">Expiry</th>
                        <th className="px-4 py-2.5 text-right">Days</th>
                        <th className="px-4 py-2.5 text-right">Open interest</th>
                        <th className="px-4 py-2.5 text-right">ATM IV</th>
                        <th className="px-4 py-2.5 text-right">24h volume</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(opt?.expiries || []).map(e => (
                        <tr key={e.expiry} className="border-b border-white/[0.03] last:border-0 hover:bg-white/[0.02]">
                          <td className="px-4 py-2 font-mono text-[12px] text-slate-200">{e.expiry}</td>
                          <td className="px-4 py-2 text-right font-mono text-[12px] text-slate-400">{e.days ?? '—'}</td>
                          <td className="px-4 py-2 text-right font-mono text-[12px] text-slate-300">{e.oi}</td>
                          <td className="px-4 py-2 text-right font-mono text-[12px] text-slate-300">{e.atm_iv === null ? '—' : `${e.atm_iv}%`}</td>
                          <td className="px-4 py-2 text-right font-mono text-[12px] text-slate-300">{usd(e.volume_usd)}</td>
                        </tr>
                      ))}
                      {!opt?.expiries?.length && (
                        <tr><td colSpan={5} className="px-4 py-6 text-center text-xs text-slate-500">{loading ? 'Loading chain…' : 'No data'}</td></tr>
                      )}
                    </tbody>
                  </table>
                </div>
                <div className="font-mono text-[9px] text-slate-600">
                  Deribit public option chain · OI in contracts · IV is mark IV · max pain is modelled from OI, not advice
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

export default CoinPage;
