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

  return (
    <motion.div
      variants={container}
      initial="hidden"
      animate="show"
      className="h-full w-full overflow-y-auto lg:overflow-hidden pb-28 lg:pb-0 px-3 lg:px-0
                 flex flex-col gap-3
                 lg:grid lg:grid-cols-12 lg:grid-rows-[168px_minmax(0,1fr)] lg:gap-3"
    >
      {/* Row 1 — order-flow metrics strip (fixed 168px) */}
      <motion.div variants={item} className="order-1 lg:col-span-12 h-[168px] shrink-0">
        <OrderFlowMetrics metrics={metrics} />
      </motion.div>

      {/* Row 2 — book + tape (8 cols) and sentinel (4 cols) */}
      <motion.div
        variants={item}
        className="order-2 lg:col-span-8 min-h-0 grid grid-cols-1 md:grid-cols-2 gap-3"
      >
        <div className="min-h-0 h-[380px] md:h-full">
          <OrderBook asks={asks} bids={bids} />
        </div>
        <div className="hidden md:block min-h-0 h-[380px] md:h-full">
          <TradeTape trades={recentTrades} />
        </div>
      </motion.div>

      <motion.div variants={item} className="order-3 lg:col-span-4 min-h-0 h-[440px] lg:h-full" style={{ minHeight: 0 }}>
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
