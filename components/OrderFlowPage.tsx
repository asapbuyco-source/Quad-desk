import React, { useEffect, useMemo, useState } from 'react';
import { Activity, ArrowDown, ArrowUp, Zap, Radio, Layers, Gauge } from 'lucide-react';
import { useStore } from '../store';
import type { RecentTrade } from '../types';

type Market = 'SPOT' | 'PERP';

interface Roll {
  buy: number;
  sell: number;
  net: number;
  count: number;
  firstPrice: number | null;
  lastPrice: number | null;
}

const WINDOWS: { label: string; ms: number }[] = [
  { label: '1s', ms: 1000 },
  { label: '5s', ms: 5000 },
  { label: '15s', ms: 15000 },
  { label: '60s', ms: 60000 },
];

function roll(trades: RecentTrade[], market: Market, ms: number, now: number): Roll {
  let buy = 0, sell = 0, count = 0;
  let firstPrice: number | null = null, lastPrice: number | null = null;
  // recentTrades is newest-first
  for (const t of trades) {
    if ((t.market ?? 'SPOT') !== market) continue;
    if (now - t.time > ms) continue;
    count++;
    if (lastPrice === null) lastPrice = t.price;
    firstPrice = t.price;
    if (t.side === 'BUY') buy += t.size; else sell += t.size;
  }
  return { buy, sell, net: buy - sell, count, firstPrice, lastPrice };
}

const fmtBtc = (v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(2)}`;
const fmtPct = (v: number | null) => (v === null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(3)}%`);

/** Price impact + absorption diagnostics (PDF §4). */
function diagnose(r15: Roll, r60: Roll): { label: string; tone: string } | null {
  const EPS = 0.05; // BTC — below this, net flow is too small to read
  if (Math.abs(r15.net) < EPS) return null;
  const movePct = (r15.firstPrice && r15.lastPrice)
    ? ((r15.lastPrice - r15.firstPrice) / r15.firstPrice) * 100
    : 0;
  const impact15 = Math.abs(movePct) / Math.max(Math.abs(r15.net), 1e-9);
  const impact60 = (r60.firstPrice && r60.lastPrice)
    ? Math.abs(((r60.lastPrice - r60.firstPrice) / r60.firstPrice) * 100) / Math.max(Math.abs(r60.net), 1e-9)
    : impact15;

  if (r15.net > 0) {
    if (movePct <= 0) return { label: 'possible seller absorption', tone: 'text-amber-400' };
    if (impact15 > impact60 * 1.25) return { label: 'buyers making progress — breakout may develop', tone: 'text-emerald-400' };
    return { label: 'buying with modest impact', tone: 'text-slate-400' };
  }
  if (movePct >= 0) return { label: 'possible buyer absorption', tone: 'text-amber-400' };
  if (impact15 > impact60 * 1.25) return { label: 'sellers making progress — breakdown may develop', tone: 'text-rose-400' };
  return { label: 'selling with modest impact', tone: 'text-slate-400' };
}

const OrderFlowPage: React.FC = () => {
  const recentTrades = useStore(s => s.market.recentTrades);
  // Event-level liquidity changes are derived in the store from the diff-depth
  // stream (sequenced by update id), not from top-20 snapshots.
  const liqEvents = useStore(s => s.liquidityEvents);
  const [, forceTick] = useState(0);

  // Keep rolling windows fresh even when no new print arrives.
  useEffect(() => {
    const i = setInterval(() => forceTick(t => t + 1), 1000);
    return () => clearInterval(i);
  }, []);

  const now = Date.now();
  const rolls = useMemo(() => ({
    SPOT: Object.fromEntries(WINDOWS.map(w => [w.label, roll(recentTrades, 'SPOT', w.ms, now)])) as Record<string, Roll>,
    PERP: Object.fromEntries(WINDOWS.map(w => [w.label, roll(recentTrades, 'PERP', w.ms, now)])) as Record<string, Roll>,
  }), [recentTrades, now]);

  const impact = useMemo(() => {
    const out: Record<Market, { movePct: number | null; impactPerBtc: number | null; dx: ReturnType<typeof diagnose> }> = {
      SPOT: { movePct: null, impactPerBtc: null, dx: null },
      PERP: { movePct: null, impactPerBtc: null, dx: null },
    };
    (['SPOT', 'PERP'] as Market[]).forEach(m => {
      const r15 = rolls[m]['15s']; const r60 = rolls[m]['60s'];
      const move = (r15.firstPrice && r15.lastPrice) ? ((r15.lastPrice - r15.firstPrice) / r15.firstPrice) * 100 : null;
      out[m].movePct = move;
      out[m].impactPerBtc = (move !== null && Math.abs(r15.net) > 0.05)
        ? Math.abs(move) / Math.abs(r15.net)
        : null;
      out[m].dx = diagnose(r15, r60);
    });
    return out;
  }, [rolls]);

  const tape = recentTrades.slice(0, 80);
  const totalSigned = rolls.SPOT['15s'].net + rolls.PERP['15s'].net;

  return (
    <div className="h-full overflow-y-auto p-4 lg:p-6 pb-28 lg:pb-6">
      <div className="mx-auto max-w-6xl space-y-4">
        {/* Header */}
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="flex items-center gap-2 text-lg font-bold tracking-wide text-white">
              <Activity size={18} className="text-brand-accent" /> BTC Quant Execution
            </h1>
            <p className="mt-1 text-xs text-slate-500">
              Executed prints, signed spot/perp flow and price impact · taker-side classification
            </p>
          </div>
          <span className="font-mono text-[10px] text-slate-600">
            Binance spot + USDM perp · aggressor from taker side
          </span>
        </div>

        {/* Flow impact band */}
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <div className="fintech-card p-3">
            <span className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Spot δ · 15s</span>
            <div className={`mt-1 font-mono text-xl font-black ${rolls.SPOT['15s'].net >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
              {fmtBtc(rolls.SPOT['15s'].net)} <span className="text-xs text-slate-500">BTC</span>
            </div>
            <div className="mt-0.5 font-mono text-[10px] text-slate-600">{rolls.SPOT['15s'].count} prints</div>
          </div>
          <div className="fintech-card p-3">
            <span className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Perp δ · 15s</span>
            <div className={`mt-1 font-mono text-xl font-black ${rolls.PERP['15s'].net >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
              {fmtBtc(rolls.PERP['15s'].net)} <span className="text-xs text-slate-500">BTC</span>
            </div>
            <div className="mt-0.5 font-mono text-[10px] text-slate-600">{rolls.PERP['15s'].count} prints</div>
          </div>
          <div className="fintech-card p-3">
            <span className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Signed flow · 15s</span>
            <div className={`mt-1 font-mono text-xl font-black ${totalSigned >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
              {fmtBtc(totalSigned)} <span className="text-xs text-slate-500">BTC</span>
            </div>
            <div className="mt-0.5 font-mono text-[10px] text-slate-600">spot + perp</div>
          </div>
          <div className="fintech-card p-3">
            <span className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Perp price Δ · 15s</span>
            <div className="mt-1 font-mono text-xl font-black text-white">{fmtPct(impact.PERP.movePct)}</div>
            <div className="mt-0.5 font-mono text-[10px] text-slate-600">taker-side mark</div>
          </div>
        </div>

        {/* Diagnostics */}
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {(['SPOT', 'PERP'] as Market[]).map(m => (
            <div key={m} className="fintech-card p-3">
              <div className="flex items-center justify-between">
                <span className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-wider text-slate-400">
                  <Gauge size={13} className="text-brand-accent" /> {m} price impact
                </span>
                <span className="font-mono text-[10px] text-slate-600">
                  {impact[m].impactPerBtc === null ? 'net too small' : `${impact[m].impactPerBtc.toFixed(4)} %/BTC`}
                </span>
              </div>
              <div className={`mt-2 text-xs font-medium ${impact[m].dx?.tone || 'text-slate-500'}`}>
                {impact[m].dx?.label || 'no readable directional edge (net flow ≈ 0)'}
              </div>
              <div className="mt-1 font-mono text-[10px] text-slate-600">
                I = ΔP / V<sup>signed</sup> · compared against the 60s baseline
              </div>
            </div>
          ))}
        </div>

        {/* Rolling flow totals */}
        <div className="fintech-card overflow-hidden">
          <div className="flex items-center gap-2 border-b border-white/5 px-4 py-3">
            <Layers size={14} className="text-brand-accent" />
            <span className="text-xs font-bold uppercase tracking-wider text-slate-400">Rolling flow · by venue</span>
          </div>
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-white/5 text-[10px] uppercase tracking-wider text-slate-500">
                <th className="px-4 py-2">Window</th>
                <th className="px-4 py-2 text-right">Spot buy</th>
                <th className="px-4 py-2 text-right">Spot sell</th>
                <th className="px-4 py-2 text-right">Spot net</th>
                <th className="px-4 py-2 text-right">Perp buy</th>
                <th className="px-4 py-2 text-right">Perp sell</th>
                <th className="px-4 py-2 text-right">Perp net</th>
                <th className="px-4 py-2 text-right">Prints</th>
              </tr>
            </thead>
            <tbody>
              {WINDOWS.map(w => {
                const s = rolls.SPOT[w.label]; const p = rolls.PERP[w.label];
                return (
                  <tr key={w.label} className="border-b border-white/[0.03] last:border-0">
                    <td className="px-4 py-2 font-mono text-[12px] text-slate-300">{w.label}</td>
                    <td className="px-4 py-2 text-right font-mono text-emerald-400/80">{s.buy.toFixed(2)}</td>
                    <td className="px-4 py-2 text-right font-mono text-rose-400/80">{s.sell.toFixed(2)}</td>
                    <td className={`px-4 py-2 text-right font-mono font-bold ${s.net >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>{fmtBtc(s.net)}</td>
                    <td className="px-4 py-2 text-right font-mono text-emerald-400/80">{p.buy.toFixed(2)}</td>
                    <td className="px-4 py-2 text-right font-mono text-rose-400/80">{p.sell.toFixed(2)}</td>
                    <td className={`px-4 py-2 text-right font-mono font-bold ${p.net >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>{fmtBtc(p.net)}</td>
                    <td className="px-4 py-2 text-right font-mono text-slate-500">{s.count + p.count}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          {/* A. Executed trades */}
          <div className="fintech-card lg:col-span-2 overflow-hidden">
            <div className="flex items-center justify-between border-b border-white/5 px-4 py-3">
              <span className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-slate-400">
                <Radio size={13} className="text-brand-accent" /> Executed trades
              </span>
              <span className="font-mono text-[10px] text-slate-600">newest first</span>
            </div>
            <div className="max-h-[420px] overflow-y-auto scrollbar-hide">
              <table className="w-full text-left">
                <thead className="sticky top-0 bg-[#0b0b0d]/95 backdrop-blur">
                  <tr className="text-[10px] uppercase tracking-wider text-slate-500">
                    <th className="px-3 py-2">Time</th>
                    <th className="px-3 py-2 text-right">Price</th>
                    <th className="px-3 py-2 text-right">Size</th>
                    <th className="px-3 py-2 text-center">Aggressor</th>
                    <th className="px-3 py-2 text-right">Market</th>
                  </tr>
                </thead>
                <tbody className="font-mono text-[11px]">
                  {tape.map(t => {
                    const isBuy = t.side === 'BUY';
                    return (
                      <tr key={`${t.id}-${t.market}`} className={`border-b border-white/[0.03] ${t.isWhale ? 'bg-amber-500/10' : ''}`}>
                        <td className="px-3 py-1.5 text-slate-500">
                          {new Date(t.time).toLocaleTimeString([], { hour12: false })}.{String(t.time % 1000).padStart(3, '0')}
                        </td>
                        <td className={`px-3 py-1.5 text-right ${isBuy ? 'text-trade-bid' : 'text-trade-ask'}`}>{t.price.toFixed(1)}</td>
                        <td className="px-3 py-1.5 text-right text-slate-300">
                          {t.size.toFixed(4)}{t.isWhale && <Zap size={9} className="ml-1 inline text-amber-400" />}
                        </td>
                        <td className="px-3 py-1.5 text-center">
                          <span className={`inline-flex items-center gap-1 ${isBuy ? 'text-trade-bid' : 'text-trade-ask'}`}>
                            {isBuy ? <ArrowUp size={9} /> : <ArrowDown size={9} />}{t.side}
                          </span>
                        </td>
                        <td className="px-3 py-1.5 text-right text-[10px] text-slate-500">{t.market ?? 'SPOT'}</td>
                      </tr>
                    );
                  })}
                  {!tape.length && (
                    <tr><td colSpan={5} className="px-3 py-8 text-center text-xs text-slate-500">Waiting for prints…</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {/* C. Liquidity event log */}
          <div className="fintech-card overflow-hidden">
            <div className="flex items-center justify-between border-b border-white/5 px-4 py-3">
              <span className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-slate-400">
                <Layers size={13} className="text-brand-accent" /> Liquidity events
              </span>
              <span className="font-mono text-[10px] text-slate-600">diff-depth · seq</span>
            </div>
            <div className="max-h-[420px] overflow-y-auto scrollbar-hide p-2 space-y-1">
              {liqEvents.map(e => (
                <div key={e.id} className="flex items-center justify-between rounded-lg px-2 py-1.5 hover:bg-white/[0.03]">
                  <div className="min-w-0">
                    <div className="font-mono text-[11px] text-slate-300">{e.price.toFixed(1)}</div>
                    <div className="font-mono text-[9px] text-slate-600">
                      <span className={e.market === 'PERP' ? 'text-purple-400/70' : 'text-slate-500'}>{e.market}</span>
                      {' '}{e.side} · {new Date(e.ts).toLocaleTimeString([], { hour12: false })} · u={e.seq}
                    </div>
                  </div>
                  <span className={`shrink-0 rounded px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider ${
                    e.kind === 'EXECUTED' ? 'bg-rose-500/15 text-rose-300'
                    : e.kind === 'REPLENISHED' ? 'bg-emerald-500/15 text-emerald-300'
                    : 'bg-slate-500/15 text-slate-400'
                  }`}>
                    {e.kind} {e.delta > 0 ? '+' : ''}{e.delta.toFixed(2)}
                  </span>
                </div>
              ))}
              {!liqEvents.length && (
                <div className="px-2 py-8 text-center text-xs text-slate-500">
                  Watching top-of-book changes…
                </div>
              )}
            </div>
            <div className="border-t border-white/5 px-3 py-2 font-mono text-[9px] text-slate-600">
              diff-depth: size removed with a matching print ≈ executed · without ≈ cancelled · added ≈ replenished
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default OrderFlowPage;
