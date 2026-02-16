
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
  show: {
    opacity: 1,
    transition: {
      staggerChildren: 0.1
    }
  }
};

const item = {
  hidden: { opacity: 0, y: 20 },
  show: { opacity: 1, y: 0 }
};

const DashboardView: React.FC = () => {
  const { metrics, asks, bids, recentTrades } = useStore(state => state.market);
  const { scanResult } = useStore(state => state.ai);

  return (
    <motion.div 
      variants={container}
      initial="hidden"
      animate="show"
      className="flex flex-col gap-6 h-full lg:grid lg:grid-cols-12 lg:grid-rows-12 lg:h-full overflow-y-auto lg:overflow-hidden pb-24 lg:pb-0 px-4 lg:px-0"
    >
      {/* Top Row: Metrics Overview */}
      <motion.div variants={item} className="order-1 lg:col-span-12 lg:row-span-4 shrink-0">
         <OrderFlowMetrics metrics={metrics} />
      </motion.div>

      {/* Bottom Left: Order Flow Engine (Book + Trades) */}
      <motion.div variants={item} className="order-2 lg:col-span-8 lg:row-span-8 h-[500px] lg:h-full shrink-0 grid grid-cols-1 md:grid-cols-2 gap-6 md:gap-4">
        <div className="h-full min-h-0">
            <OrderBook asks={asks} bids={bids} />
        </div>
        <div className="h-full min-h-0 hidden md:block">
            <TradeTape trades={recentTrades} />
        </div>
      </motion.div>

      {/* Bottom Right: Sentinel & System Status */}
      <motion.div variants={item} className="order-3 lg:col-span-4 lg:row-span-8 h-auto lg:h-full shrink-0 flex flex-col gap-6">
        <div className="flex-1 min-h-0 h-full">
             <SentinelPanel 
                checklist={CHECKLIST_ITEMS} 
                aiScanResult={scanResult} 
                heatmap={metrics.heatmap}
                currentRegime={metrics.regime}
             />
        </div>
      </motion.div>
    </motion.div>
  );
};

export default DashboardView;
