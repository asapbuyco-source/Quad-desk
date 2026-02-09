
import React from 'react';
import OrderBook from './OrderBook';
import TradeTape from './TradeTape';
import SentinelPanel from './SentinelPanel';
import OrderFlowMetrics from './OrderFlowMetrics';
import { MarketMetrics, CandleData, OrderBookLevel, SentinelChecklist, AiScanResult, RecentTrade } from '../types';
import { motion } from 'framer-motion';
import { Terminal } from 'lucide-react';

interface DashboardViewProps {
  metrics: MarketMetrics;
  candles: CandleData[];
  asks: OrderBookLevel[];
  bids: OrderBookLevel[];
  recentTrades: RecentTrade[];
  checklist: SentinelChecklist[];
  aiScanResult?: AiScanResult;
  interval?: string;
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

const DashboardView: React.FC<DashboardViewProps> = ({ metrics, asks, bids, recentTrades, checklist, aiScanResult, interval }) => {
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
        <div className="flex-1 min-h-0">
             <SentinelPanel 
                checklist={checklist} 
                aiScanResult={aiScanResult} 
                heatmap={metrics.heatmap}
                currentRegime={metrics.regime}
             />
        </div>
        
        {/* Terminal/Logs */}
        <div className="h-64 lg:h-1/3 fintech-card p-4 overflow-hidden flex flex-col shrink-0">
            <div className="flex items-center gap-2 mb-2 text-slate-400 border-b border-white/5 pb-2">
                <Terminal size={14} />
                <span className="text-xs font-bold uppercase">System Logs</span>
            </div>
            <div className="flex-1 overflow-y-auto font-mono text-[10px] text-slate-500 space-y-1">
                <p>&gt; Connecting to institutional gateway...</p>
                <p className="text-trade-bid">&gt; [SUCCESS] Feed active: 12ms latency</p>
                <p>&gt; AI Model [SENTINEL-X] loaded.</p>
                {aiScanResult && (
                   <p className="text-brand-accent">&gt; [AI] Market Scan Complete: {aiScanResult.verdict}</p> 
                )}
                {metrics.regime && (
                    <p className="text-amber-500">&gt; Regime Update: {metrics.regime}</p>
                )}
                {recentTrades.length > 0 && (
                    <p className="text-zinc-600">&gt; Trade stream active ({recentTrades.length} events buffered)</p>
                )}
                <p>&gt; Monitoring order flow for icebergs...</p>
                {interval && <p className="text-zinc-500">&gt; Timeframe set to {interval}</p>}
            </div>
        </div>
      </motion.div>
    </motion.div>
  );
};

export default DashboardView;
