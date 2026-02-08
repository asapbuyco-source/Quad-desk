import React from 'react';
import OrderBook from './OrderBook';
import SentinelPanel from './SentinelPanel';
import OrderFlowMetrics from './OrderFlowMetrics';
import { MarketMetrics, CandleData, OrderBookLevel, SentinelChecklist, AiAnalysis, AiScanResult } from '../types';
import { motion } from 'framer-motion';
import { Terminal } from 'lucide-react';

const MotionDiv = motion.div as any;

interface DashboardViewProps {
  metrics: MarketMetrics;
  candles: CandleData[];
  asks: OrderBookLevel[];
  bids: OrderBookLevel[];
  checklist: SentinelChecklist[];
  aiAnalysis?: AiAnalysis; 
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

const DashboardView: React.FC<DashboardViewProps> = ({ metrics, asks, bids, checklist, aiAnalysis, aiScanResult, interval }) => {
  return (
    <MotionDiv 
      variants={container}
      initial="hidden"
      animate="show"
      className="flex flex-col gap-6 h-full lg:grid lg:grid-cols-12 lg:grid-rows-12 lg:h-full overflow-y-auto lg:overflow-hidden pb-24 lg:pb-0 px-4 lg:px-0"
    >
      {/* Top Row: Metrics Overview */}
      <MotionDiv variants={item} className="order-1 lg:col-span-12 lg:row-span-4 shrink-0">
         <OrderFlowMetrics metrics={metrics} />
      </MotionDiv>

      {/* Bottom Left: Order Book */}
      <MotionDiv variants={item} className="order-2 lg:col-span-8 lg:row-span-8 h-[500px] lg:h-full shrink-0">
        <OrderBook asks={asks} bids={bids} />
      </MotionDiv>

      {/* Bottom Right: Sentinel & System Status */}
      <MotionDiv variants={item} className="order-3 lg:col-span-4 lg:row-span-8 h-auto lg:h-full shrink-0 flex flex-col gap-6">
        <div className="flex-1">
             <SentinelPanel 
                checklist={checklist} 
                aiAnalysis={aiAnalysis} 
                aiScanResult={aiScanResult} 
                heatmap={metrics.heatmap}
             />
        </div>
        
        {/* Terminal/Logs */}
        <div className="h-64 lg:h-1/3 fintech-card p-4 overflow-hidden flex flex-col">
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
                <p>&gt; Monitoring order flow for icebergs...</p>
                {interval && <p className="text-zinc-500">&gt; Timeframe set to {interval}</p>}
            </div>
        </div>
      </MotionDiv>
    </MotionDiv>
  );
};

export default DashboardView;