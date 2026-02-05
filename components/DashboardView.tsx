import React from 'react';
import OrderBook from './OrderBook';
import SentinelPanel from './SentinelPanel';
import OrderFlowMetrics from './OrderFlowMetrics';
import { MarketMetrics, CandleData, OrderBookLevel, SentinelChecklist } from '../types';
import { motion } from 'framer-motion';
import { Terminal } from 'lucide-react';

interface DashboardViewProps {
  metrics: MarketMetrics;
  candles: CandleData[];
  asks: OrderBookLevel[];
  bids: OrderBookLevel[];
  checklist: SentinelChecklist[];
}

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

const DashboardView: React.FC<DashboardViewProps> = ({ metrics, asks, bids, checklist }) => {
  return (
    <motion.div 
      variants={container}
      initial="hidden"
      animate="show"
      className="flex flex-col gap-6 h-full lg:grid lg:grid-cols-12 lg:grid-rows-12 lg:h-full overflow-y-auto lg:overflow-hidden pb-24 lg:pb-0 px-2 lg:px-0"
    >
      {/* Top Row: Metrics Overview - Now prominent at the top */}
      <motion.div variants={item} className="order-1 lg:col-span-12 lg:row-span-4 shrink-0">
         <OrderFlowMetrics metrics={metrics} />
      </motion.div>

      {/* Bottom Left: Order Book - Expanded for better visibility */}
      <motion.div variants={item} className="order-2 lg:col-span-8 lg:row-span-8 h-[500px] lg:h-full shrink-0">
        <OrderBook asks={asks} bids={bids} />
      </motion.div>

      {/* Bottom Right: Sentinel & System Status */}
      <motion.div variants={item} className="order-3 lg:col-span-4 lg:row-span-8 h-auto lg:h-full shrink-0 flex flex-col gap-6">
        <div className="flex-1">
             <SentinelPanel checklist={checklist} />
        </div>
        
        {/* Added a Terminal/Logs box to fill space and look cool */}
        <div className="h-1/3 fintech-card p-4 overflow-hidden flex flex-col">
            <div className="flex items-center gap-2 mb-2 text-slate-400 border-b border-white/5 pb-2">
                <Terminal size={14} />
                <span className="text-xs font-bold uppercase">System Logs</span>
            </div>
            <div className="flex-1 overflow-y-auto font-mono text-[10px] text-slate-500 space-y-1">
                <p>&gt; Connecting to institutional gateway...</p>
                <p className="text-trade-bid">&gt; [SUCCESS] Feed active: 12ms latency</p>
                <p>&gt; AI Model [SENTINEL-X] loaded.</p>
                <p>&gt; Monitoring order flow for icebergs...</p>
                <p className="text-trade-warn">&gt; [WARN] Volatility spike detected in Asian session.</p>
                <p>&gt; Adjusting risk parameters...</p>
            </div>
        </div>
      </motion.div>
    </motion.div>
  );
};

export default DashboardView;