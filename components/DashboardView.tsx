import React from 'react';
import OrderBook from './OrderBook';
import TradeTape from './TradeTape';
import SentinelPanel from './SentinelPanel';
import OrderFlowMetrics from './OrderFlowMetrics';
import { CHECKLIST_ITEMS } from '../constants';
import { motion as m } from 'framer-motion';
import { useStore } from '../store';
import { apiFetch } from '../utils/apiClient';
import { Gauge, Flame, Users, Activity } from 'lucide-react';

const motion = m as any;

const usd = (v?: number) => {
  if (v === undefined) return '—';
  if (v >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `$${(v / 1e3).toFixed(0)}K`;
  return `$${Math.round(v)}`;
};

/** Compact market-context strip shown above the desk. */
const ContextStrip: React.FC<{ symbol: string }> = ({ symbol }) => {
  const [ctx, setCtx] = React.useState<{
    funding?: number; accum?: number; liqLong?: number; liqShort?: number; retail?: number; top?: number;
  }>({});

  React.useEffect(() => {
    let dead = false;
    const load = async () => {
      try {
        const [f, l, p] = await Promise.all([
          apiFetch(`/funding-history?symbol=${symbol}&limit=21`, { timeoutMs: 45000 }),
          apiFetch('/liquidations?minutes=1440', { timeoutMs: 45000 }),
          apiFetch(`/positioning?symbol=${symbol}&period=1h&limit=24`, { timeoutMs: 45000 }),
        ]);
        const fj = await f.json();
        const lj = await l.json();
        const pj = await p.json();
        if (dead) return;
        setCtx({
          funding: fj?.latest?.rate,
          accum: fj?.accumulated_pct,
          liqLong: lj?.totals?.long_usd,
          liqShort: lj?.totals?.short_usd,
          retail: pj?.series?.global_accounts?.latest?.ratio,
          top: pj?.series?.top_positions?.latest?.ratio,
        });
      } catch { /* keep previous */ }
    };
    load();
    const id = setInterval(load, 180000);
    return () => { dead = true; clearInterval(id); };
  }, [symbol]);

  const fundingPct = ctx.funding === undefined ? undefined : ctx.funding * 100;
  const liqNet = ctx.liqLong !== undefined && ctx.liqShort !== undefined ? ctx.liqShort - ctx.liqLong : undefined;
  const div = ctx.retail !== undefined && ctx.top !== undefined ? ctx.retail - ctx.top : undefined;

  let score = 0;
  if (fundingPct !== undefined) score += fundingPct > 0.01 ? -1 : fundingPct < -0.01 ? 1 : 0;
  if (liqNet !== undefined) score += liqNet > 0 ? 0.6 : -0.6;
  if (div !== undefined) score += div > 0.4 ? -0.4 : div < -0.4 ? 0.4 : 0;
  const biasLabel = score >= 0.5 ? 'Bullish' : score <= -0.5 ? 'Bearish' : 'Neutral';
  const biasWidth = Math.min(100, Math.max(0, ((score + 2) / 4) * 100));
  const biasTone = score >= 0.5 ? 'text-emerald-400' : score <= -0.5 ? 'text-rose-400' : 'text-slate-300';

  return (
    <div className="grid h-full grid-cols-2 gap-2 lg:grid-cols-4">
      <div className="premium-card flex flex-col justify-center px-3 py-2">
        <div className="flex items-center gap-1.5 text-[9px] font-bold uppercase tracking-wider text-slate-500">
          <Gauge size={11} /> {symbol.replace('USDT', '')} funding
        </div>
        <div className={`mt-0.5 font-mono text-base font-black ${fundingPct === undefined ? 'text-slate-500' : fundingPct >= 0 ? 'text-rose-400' : 'text-emerald-400'}`}>
          {fundingPct === undefined ? '—' : `${fundingPct >= 0 ? '+' : ''}${fundingPct.toFixed(4)}%`}
        </div>
        <div className="font-mono text-[9px] text-slate-600">
          accum 7d {ctx.accum === undefined ? '—' : `${ctx.accum >= 0 ? '+' : ''}${ctx.accum}%`}
        </div>
      </div>

      <div className="premium-card flex flex-col justify-center px-3 py-2">
        <div className="flex items-center gap-1.5 text-[9px] font-bold uppercase tracking-wider text-slate-500">
          <Flame size={11} /> Liquidations 24h
        </div>
        <div className={`mt-0.5 font-mono text-base font-black ${liqNet === undefined ? 'text-slate-500' : liqNet >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
          {liqNet === undefined ? '—' : `${liqNet >= 0 ? 'S' : 'L'} ${usd(Math.abs(liqNet))}`}
        </div>
        <div className="font-mono text-[9px] text-slate-600">
          L {usd(ctx.liqLong)} · S {usd(ctx.liqShort)}
        </div>
      </div>

      <div className="premium-card flex flex-col justify-center px-3 py-2">
        <div className="flex items-center gap-1.5 text-[9px] font-bold uppercase tracking-wider text-slate-500">
          <Users size={11} /> Positioning
        </div>
        <div className={`mt-0.5 font-mono text-base font-black ${div === undefined ? 'text-slate-500' : Math.abs(div) > 0.5 ? 'text-amber-300' : 'text-slate-200'}`}>
          {div === undefined ? '—' : `${div >= 0 ? '+' : ''}${div.toFixed(2)}`}
        </div>
        <div className="font-mono text-[9px] text-slate-600">retail − top positions</div>
      </div>

      <div className="premium-card flex flex-col justify-center px-3 py-2">
        <div className="flex items-center gap-1.5 text-[9px] font-bold uppercase tracking-wider text-slate-500">
          <Activity size={11} /> Desk bias
        </div>
        <div className={`mt-0.5 font-mono text-base font-black ${biasTone}`}>{biasLabel}</div>
        <div className="mt-1 h-1 overflow-hidden rounded-full bg-slate-800">
          <div className={`h-full rounded-full ${score >= 0.5 ? 'bg-emerald-500' : score <= -0.5 ? 'bg-rose-500' : 'bg-slate-500'}`}
            style={{ width: `${biasWidth}%` }} />
        </div>
      </div>
    </div>
  );
};

const container = {
  hidden: { opacity: 0 },
  show: { opacity: 1, transition: { staggerChildren: 0.08 } },
};

const item = {
  hidden: { opacity: 0, y: 16 },
  show: { opacity: 1, y: 0 },
};

/**
 * Desk layout — two explicit rows: an auto-height metrics band and a flexible
 * body row that fills the remaining viewport.
 *
 * The previous version used a fixed `grid-rows-12` with `row-span-*` children
 * and no `min-h-0`. Because grid items default to `min-height:auto`, the tall
 * metrics block (two rows of cards) blew past its row and overlapped the
 * book/tape/sentinel panels. Using `minmax(0,1fr)` + `min-h-0` everywhere keeps
 * every panel inside its own box and lets each panel's internal scroller work.
 */
const DashboardView: React.FC = () => {
  const { metrics, asks, bids, recentTrades } = useStore(state => state.market);
  const { scanResult } = useStore(state => state.ai);
  const { activeSymbol } = useStore(state => state.config);
  const [mobileTab, setMobileTab] = React.useState<'book' | 'tape'>('book');

  return (
    <motion.div
      variants={container}
      initial="hidden"
      animate="show"
      className="h-full w-full overflow-y-auto lg:overflow-hidden pb-28 lg:pb-0 px-3 lg:px-0
                 flex flex-col gap-3
                 lg:grid lg:grid-cols-12 lg:grid-rows-[76px_168px_minmax(0,1fr)] lg:gap-3"
    >
      {/* Row 0 — compact market context strip */}
      <motion.div variants={item} className="order-1 lg:col-span-12 shrink-0 lg:h-[76px]">
        <ContextStrip symbol={activeSymbol || 'BTCUSDT'} />
      </motion.div>

      {/* Row 1 — order-flow metrics strip (responsive on mobile, fixed 168px on desktop) */}
      <motion.div variants={item} className="order-2 lg:col-span-12 shrink-0 lg:h-[168px]">
        <OrderFlowMetrics metrics={metrics} />
      </motion.div>

      {/* Row 2 — book + tape (8 cols) and sentinel (4 cols) */}
      <motion.div
        variants={item}
        className="order-3 lg:col-span-8 min-h-0 flex flex-col md:grid md:grid-cols-2 gap-3"
      >
        {/* Mobile View Toggle (hidden on md and above) */}
        <div className="flex md:hidden items-center p-1 rounded-xl bg-white/[0.03] border border-white/5 shrink-0">
          <button
            onClick={() => setMobileTab('book')}
            className={`flex-1 py-1.5 text-xs font-bold uppercase tracking-wider rounded-lg transition-all ${
              mobileTab === 'book'
                ? 'bg-brand-accent/20 text-brand-accent border border-brand-accent/30 shadow-sm'
                : 'text-zinc-500 hover:text-zinc-300'
            }`}
          >
            Order Book
          </button>
          <button
            onClick={() => setMobileTab('tape')}
            className={`flex-1 py-1.5 text-xs font-bold uppercase tracking-wider rounded-lg transition-all ${
              mobileTab === 'tape'
                ? 'bg-brand-accent/20 text-brand-accent border border-brand-accent/30 shadow-sm'
                : 'text-zinc-500 hover:text-zinc-300'
            }`}
          >
            Trade Tape
          </button>
        </div>

        {/* Order Book Panel */}
        <div className={`min-h-0 h-[420px] md:h-full ${mobileTab === 'book' ? 'block' : 'hidden md:block'}`}>
          <OrderBook asks={asks} bids={bids} />
        </div>

        {/* Trade Tape Panel */}
        <div className={`min-h-0 h-[420px] md:h-full ${mobileTab === 'tape' ? 'block' : 'hidden md:block'}`}>
          <TradeTape trades={recentTrades} />
        </div>
      </motion.div>

      <motion.div variants={item} className="order-4 lg:col-span-4 min-h-0 h-[460px] lg:h-full" style={{ minHeight: 0 }}>
        <SentinelPanel
          checklist={CHECKLIST_ITEMS}
          aiScanResult={scanResult}
          heatmap={metrics.heatmap}
          currentRegime={metrics.regime}
        />
      </motion.div>
    </motion.div>
  );
};

export default DashboardView;
