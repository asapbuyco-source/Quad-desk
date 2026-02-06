import React from 'react';
import { motion } from 'framer-motion';
import { Shield, Activity, Terminal, ScanSearch, CandlestickChart, Anchor, BookOpen } from 'lucide-react';

const MotionDiv = motion.div as any;

const GuideCard: React.FC<{ 
    icon: React.ElementType, 
    title: string, 
    children: React.ReactNode, 
    colorClass: string 
}> = ({ icon: Icon, title, children, colorClass }) => (
    <div className={`p-6 rounded-2xl border bg-black/40 backdrop-blur-sm ${colorClass} h-full`}>
        <div className="flex items-center gap-3 mb-4">
            <div className={`p-2 rounded-lg bg-white/5`}>
                <Icon size={24} />
            </div>
            <h3 className="text-xl font-bold text-white tracking-tight">{title}</h3>
        </div>
        <div className="text-sm text-slate-400 leading-relaxed space-y-2">
            {children}
        </div>
    </div>
);

const GuideView: React.FC = () => {
  return (
    <MotionDiv 
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="h-full overflow-y-auto px-4 lg:px-8 pb-24 lg:pb-8 max-w-7xl mx-auto"
    >
        <div className="flex flex-col gap-6 mb-8">
            <div className="flex items-center gap-3">
                <div className="p-3 bg-brand-accent/20 rounded-xl text-brand-accent">
                    <BookOpen size={32} />
                </div>
                <div>
                    <h1 className="text-3xl font-bold text-white tracking-tight">System Reference Guide</h1>
                    <p className="text-slate-400">Operational manual for the Quant Desk Terminal v2.4</p>
                </div>
            </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            
            {/* 1. Sentinel System */}
            <GuideCard 
                icon={Shield} 
                title="Sentinel Risk Engine" 
                colorClass="border-indigo-500/20 shadow-[0_0_20px_rgba(99,102,241,0.05)]"
            >
                <p>The Sentinel System acts as an autonomous risk guardian. It monitors real-time market conditions against a preset checklist of safety parameters.</p>
                <ul className="list-disc pl-4 space-y-1 mt-2 text-slate-500">
                    <li><strong className="text-white">Circuit Breaker:</strong> Automatically halts trading if daily drawdown exceeds defined limits (Simulated).</li>
                    <li><strong className="text-white">Checklist:</strong> Validates Dislocation (Z-Score), Skewness, and Sentiment before permitting entry.</li>
                </ul>
            </GuideCard>

            {/* 2. Order Flow & Liquidity */}
            <GuideCard 
                icon={Anchor} 
                title="Order Flow Dynamics" 
                colorClass="border-emerald-500/20 shadow-[0_0_20px_rgba(16,185,129,0.05)]"
            >
                <p>Advanced metrics to decode institutional intent behind price movements.</p>
                <ul className="list-disc pl-4 space-y-1 mt-2 text-slate-500">
                    <li><strong className="text-white">Whale Hunter:</strong> Detects divergences between Institutional CVD (buying volume) and Retail Sentiment.</li>
                    <li><strong className="text-white">DOM Magnets:</strong> Highlights unusually large limit orders in the order book that may act as price magnets.</li>
                    <li><strong className="text-white">OFI (Order Flow Imbalance):</strong> Measures the net pressure of the bid/ask stack.</li>
                </ul>
            </GuideCard>

            {/* 3. AI Scanner */}
            <GuideCard 
                icon={ScanSearch} 
                title="AI Market Scanner" 
                colorClass="border-purple-500/20 shadow-[0_0_20px_rgba(168,85,247,0.05)]"
            >
                <p>Leverages Google Gemini 3 (Pro & Flash) to analyze market structure in real-time.</p>
                <ul className="list-disc pl-4 space-y-1 mt-2 text-slate-500">
                    <li><strong className="text-white">"AI SCAN" Button:</strong> Located in the Chart view. Sends recent candle data to the backend for analysis.</li>
                    <li><strong className="text-white">Output:</strong> Generates key Support/Resistance levels, a "Decision Price" pivot, and a trade Verdict (ENTRY/WAIT).</li>
                </ul>
            </GuideCard>

            {/* 4. Charting & Indicators */}
            <GuideCard 
                icon={CandlestickChart} 
                title="Technical Toolkit" 
                colorClass="border-blue-500/20 shadow-[0_0_20px_rgba(59,130,246,0.05)]"
            >
                <p>Professional-grade visualization tools overlaid on live Binance data.</p>
                <ul className="list-disc pl-4 space-y-1 mt-2 text-slate-500">
                    <li><strong className="text-white">AI Bands:</strong> Dynamic Z-Score volatility bands (Mean Reversion). Outer bands represent 2.5σ deviations.</li>
                    <li><strong className="text-white">ADX Trend:</strong> Real-time Average Directional Index calculation to gauge trend strength vs ranging conditions.</li>
                    <li><strong className="text-white">Volume Profile:</strong> (Toggleable) Shows volume distribution by price level to identify liquidity nodes.</li>
                </ul>
            </GuideCard>

            {/* 5. Metrics & Heatmap */}
            <GuideCard 
                icon={Activity} 
                title="Quant Metrics" 
                colorClass="border-rose-500/20 shadow-[0_0_20px_rgba(244,63,94,0.05)]"
            >
                <p>Statistical measurements for regime identification.</p>
                <ul className="list-disc pl-4 space-y-1 mt-2 text-slate-500">
                    <li><strong className="text-white">Z-Score Heatmap:</strong> Monitors cross-asset statistical deviation. High Z-Scores indicate potential mean reversion trades.</li>
                    <li><strong className="text-white">Toxicity:</strong> Measures the "aggressiveness" of incoming orders (HFT activity).</li>
                </ul>
            </GuideCard>

             {/* 6. System Controls */}
             <GuideCard 
                icon={Terminal} 
                title="System Controls" 
                colorClass="border-amber-500/20 shadow-[0_0_20px_rgba(245,158,11,0.05)]"
            >
                <p>Global settings to manage the terminal environment.</p>
                <ul className="list-disc pl-4 space-y-1 mt-2 text-slate-500">
                    <li><strong className="text-white">Replay Mode:</strong> Toggles between Live Binance Websocket feed and a historical simulation loop for backtesting strategies.</li>
                    <li><strong className="text-white">Timeframes:</strong> Switch between 1m, 5m, 15m, 1h, 4h, 1d candles to change the scope of analysis.</li>
                </ul>
            </GuideCard>

        </div>

        <div className="mt-12 p-6 rounded-2xl bg-zinc-900/50 border border-white/5">
            <h2 className="text-lg font-bold text-white mb-4">Keyboard Shortcuts & Interaction</h2>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-xs font-mono">
                <div className="flex flex-col gap-1">
                    <span className="text-slate-500">Toggle Backtest</span>
                    <span className="text-white bg-white/10 px-2 py-1 rounded w-fit">Click Header Icon</span>
                </div>
                <div className="flex flex-col gap-1">
                    <span className="text-slate-500">Scan Market</span>
                    <span className="text-white bg-white/10 px-2 py-1 rounded w-fit">Chart &gt; AI SCAN</span>
                </div>
                <div className="flex flex-col gap-1">
                    <span className="text-slate-500">Volume Profile</span>
                    <span className="text-white bg-white/10 px-2 py-1 rounded w-fit">Chart &gt; Side Panel</span>
                </div>
                <div className="flex flex-col gap-1">
                    <span className="text-slate-500">Read Intel</span>
                    <span className="text-white bg-white/10 px-2 py-1 rounded w-fit">Intel &gt; Select Card</span>
                </div>
            </div>
        </div>
    </MotionDiv>
  );
};

export default GuideView;