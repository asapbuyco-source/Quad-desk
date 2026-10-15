import React from 'react';
import OrderBook from './OrderBook';
import TradeTape from './TradeTape';
import SentinelPanel from './SentinelPanel';
import OrderFlowMetrics from './OrderFlowMetrics';
import { CHECKLIST_ITEMS } from '../constants';
import { motion as m } from 'framer-motion';
import { useStore } from '../store';

const motion = m as any;

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
  const [mobileTab, setMobileTab] = React.useState<'book' | 'tape'>('book');

  return (
    <motion.div
      variants={container}
      initial="hidden"
      animate="show"
      className="h-full w-full overflow-y-auto lg:overflow-hidden pb-28 lg:pb-0 px-3 lg:px-0
                 flex flex-col gap-3
                 lg:grid lg:grid-cols-12 lg:grid-rows-[168px_minmax(0,1fr)] lg:gap-3"
    >
      {/* Row 1 — order-flow metrics strip (responsive on mobile, fixed 168px on desktop) */}
      <motion.div variants={item} className="order-1 lg:col-span-12 shrink-0 lg:h-[168px]">
        <OrderFlowMetrics metrics={metrics} />
      </motion.div>

      {/* Row 2 — book + tape (8 cols) and sentinel (4 cols) */}
      <motion.div
        variants={item}
        className="order-2 lg:col-span-8 min-h-0 flex flex-col md:grid md:grid-cols-2 gap-3"
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

      <motion.div variants={item} className="order-3 lg:col-span-4 min-h-0 h-[460px] lg:h-full" style={{ minHeight: 0 }}>
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
