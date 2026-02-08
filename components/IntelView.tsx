import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Newspaper, ExternalLink, Clock, RefreshCw, Zap, TrendingUp, TrendingDown, Minus, Anchor, BrainCircuit, AlertTriangle } from 'lucide-react';
import { API_BASE_URL } from '../constants';

interface NewsArticle {
    source: { id: string | null; name: string };
    author: string | null;
    title: string;
    description: string;
    url: string;
    urlToImage: string | null;
    publishedAt: string;
    content: string;
}

interface IntelligenceData {
    main_narrative: string;
    whale_impact: 'High' | 'Medium' | 'Low';
    ai_sentiment_score: number;
}

interface MarketIntelResponse {
    articles: NewsArticle[];
    intelligence: IntelligenceData;
    timestamp?: number;
    is_simulated?: boolean; // Backend flag
    isSimulated?: boolean; // Frontend cache/fallback flag
}

const CACHE_KEY = 'market_intel_cache';
const CACHE_DURATION = 10 * 60 * 1000; // 10 minutes

// Fallback Mock Data for when Backend/NewsAPI is unavailable
const MOCK_INTEL_DATA: MarketIntelResponse = {
    articles: [
        {
            source: { id: 'bloomberg', name: 'BLOOMBERG' },
            author: 'Crypto Desk',
            title: 'Institutional Order Flow Indicates Accumulation in $62k-$64k Zone',
            description: 'Proprietary flow data suggests smart money is front-running expected volatility, with iceberg buy orders detected across major exchanges.',
            url: '#',
            urlToImage: null,
            publishedAt: new Date().toISOString(),
            content: ''
        },
        {
            source: { id: 'reuters', name: 'REUTERS' },
            author: 'Tech',
            title: 'Global Liquidity cycle turns positive for Risk Assets',
            description: 'Central bank balance sheet expansion in Asia is correlating with renewed bid in crypto markets, despite Fed hawkishness.',
            url: '#',
            urlToImage: null,
            publishedAt: new Date(Date.now() - 3600000).toISOString(),
            content: ''
        },
        {
            source: { id: 'glassnode', name: 'GLASSNODE' },
            author: 'On-Chain',
            title: 'Long-Term Holder Supply reaches all-time high',
            description: 'Coins held for longer than 155 days have crossed 76% of total supply, signaling extreme supply shock potential.',
            url: '#',
            urlToImage: null,
            publishedAt: new Date(Date.now() - 7200000).toISOString(),
            content: ''
        },
        {
            source: { id: 'deribit', name: 'DERIBIT' },
            author: 'Options',
            title: 'Call Open Interest clusters at $70k strike',
            description: 'Options market dealers are short gamma above $68k, which could fuel a self-reinforcing rally if price breaks resistance.',
            url: '#',
            urlToImage: null,
            publishedAt: new Date(Date.now() - 10800000).toISOString(),
            content: ''
        },
        {
             source: { id: 'coindesk', name: 'COINDESK' },
             author: 'Market',
             title: 'Layer 2 Volume flips Ethereum Mainnet',
             description: 'Arbitrum and Optimism activity surges as DeFi yields attract capital rotation away from traditional staking.',
             url: '#',
             urlToImage: null,
             publishedAt: new Date(Date.now() - 14400000).toISOString(),
             content: ''
        }
    ],
    intelligence: {
        main_narrative: "Supply Shock meets Institutional Demand",
        whale_impact: "High",
        ai_sentiment_score: 0.85
    },
    timestamp: Date.now(),
    isSimulated: true
};

const IntelView: React.FC = () => {
  const [data, setData] = useState<MarketIntelResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchIntelligence = async (forceRefresh = false) => {
      setLoading(true);
      setError(null);

      // 1. Check Cache
      if (!forceRefresh) {
          const cached = localStorage.getItem(CACHE_KEY);
          if (cached) {
              const parsed: MarketIntelResponse = JSON.parse(cached);
              const now = Date.now();
              if (parsed.timestamp && now - parsed.timestamp < CACHE_DURATION) {
                  setData(parsed);
                  setLoading(false);
                  return;
              }
          }
      }

      // 2. Fetch Live
      try {
          // Check if we are in a browser environment that cant hit localhost backend easily
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 8000); // 8s timeout

          const res = await fetch(`${API_BASE_URL}/market-intelligence`, {
              signal: controller.signal
          });
          clearTimeout(timeoutId);
          
          if (!res.ok) throw new Error("Backend connection failed");
          
          const json = await res.json();
          if (json.error) throw new Error(json.error);

          const result: MarketIntelResponse = {
              ...json,
              timestamp: Date.now()
          };

          localStorage.setItem(CACHE_KEY, JSON.stringify(result));
          setData(result);
      } catch (err: any) {
          console.warn("Intel fetch failed, switching to simulation:", err);
          
          // Fallback Strategy:
          // 1. Try Cache (even if expired, better than mock)
          // 2. Use Mock Data
          const cached = localStorage.getItem(CACHE_KEY);
          if (cached && !forceRefresh) {
               setData(JSON.parse(cached));
               setError("Live uplink failed. Displaying cached intelligence.");
          } else {
               setData(MOCK_INTEL_DATA);
               setError("Backend offline. Simulation Mode Active.");
          }
      } finally {
          setLoading(false);
      }
  };

  useEffect(() => {
      fetchIntelligence();
  }, []);

  // Helper to format time
  const formatTime = (isoString: string) => {
      const date = new Date(isoString);
      const now = new Date();
      const diffMins = Math.floor((now.getTime() - date.getTime()) / 60000);
      
      if (diffMins < 60) return `${diffMins}m ago`;
      if (diffMins < 1440) return `${Math.floor(diffMins / 60)}h ago`;
      return date.toLocaleDateString();
  };

  // Helper for Sentiment Badge
  const getSentimentInfo = (score: number) => {
      if (score > 0.2) return { label: 'BULLISH', color: 'text-emerald-400', bg: 'bg-emerald-500/10', border: 'border-emerald-500/20', icon: TrendingUp };
      if (score < -0.2) return { label: 'BEARISH', color: 'text-rose-400', bg: 'bg-rose-500/10', border: 'border-rose-500/20', icon: TrendingDown };
      return { label: 'NEUTRAL', color: 'text-zinc-400', bg: 'bg-zinc-500/10', border: 'border-zinc-500/20', icon: Minus };
  };

  const isSimulated = data?.isSimulated || data?.is_simulated || !!error;

  return (
    <div className="h-full w-full overflow-y-auto">
        <div className="flex flex-col gap-6 max-w-7xl mx-auto px-4 lg:px-0 relative w-full pb-24 lg:pb-12 pt-2">
      
      {/* Header Section */}
      <div className="flex flex-col gap-6">
        <div className="flex items-center justify-between">
            <h1 className="text-2xl font-bold text-white tracking-tight flex items-center gap-3">
                <div className="p-2 bg-brand-accent/20 rounded-lg text-brand-accent">
                    <BrainCircuit size={24} />
                </div>
                Market Intelligence
            </h1>
            <div className="flex items-center gap-3">
                {isSimulated && (
                    <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-amber-500/20 border border-amber-500/30">
                        <AlertTriangle size={14} className="text-amber-500" />
                        <span className="text-[10px] font-bold text-amber-500 uppercase tracking-widest hidden md:inline">
                            SIMULATED DATA
                        </span>
                    </div>
                )}
                <button 
                    onClick={() => fetchIntelligence(true)}
                    disabled={loading}
                    className={`
                        flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-bold uppercase tracking-wide border transition-all
                        ${loading 
                            ? 'bg-zinc-800 text-zinc-500 border-zinc-700 cursor-wait' 
                            : 'bg-brand-accent/10 text-brand-accent border-brand-accent/30 hover:bg-brand-accent hover:text-white'}
                    `}
                >
                    <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
                    {loading ? "ANALYZING..." : "REFRESH INTEL"}
                </button>
            </div>
        </div>

        {/* AI Pulse Dashboard */}
        <AnimatePresence mode='wait'>
            {data && data.intelligence ? (
                <motion.div 
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="grid grid-cols-1 md:grid-cols-12 gap-4"
                >
                    {/* Main Narrative Card */}
                    <div className="md:col-span-8 p-6 rounded-2xl bg-gradient-to-br from-zinc-900 to-black border border-white/10 relative overflow-hidden group">
                        <div className="absolute top-0 right-0 p-4 opacity-10 group-hover:opacity-20 transition-opacity">
                            <Newspaper size={120} />
                        </div>
                        <div className="relative z-10">
                            <div className="flex items-center gap-2 mb-3">
                                <Zap size={16} className="text-brand-accent fill-brand-accent" />
                                <span className="text-xs font-bold text-brand-accent uppercase tracking-widest">Global Narrative</span>
                            </div>
                            <h2 className="text-xl md:text-2xl font-medium text-white leading-relaxed font-light">
                                "{data.intelligence.main_narrative}"
                            </h2>
                        </div>
                    </div>

                    {/* Metrics Cards */}
                    <div className="md:col-span-4 flex flex-col gap-4">
                        {/* Whale Impact */}
                        <div className="flex-1 p-5 rounded-2xl bg-zinc-900/50 border border-white/5 flex items-center justify-between relative overflow-hidden">
                             <div className="absolute inset-0 bg-blue-500/5" />
                             <div>
                                 <span className="text-[10px] font-bold text-slate-500 uppercase tracking-widest flex items-center gap-1 mb-1">
                                    <Anchor size={12} /> Whale Impact
                                 </span>
                                 <span className={`text-2xl font-black ${
                                     data.intelligence.whale_impact === 'High' ? 'text-amber-400' : 'text-white'
                                 }`}>
                                     {data.intelligence.whale_impact}
                                 </span>
                             </div>
                             <div className="h-full flex items-center">
                                 <div className={`w-2 h-12 rounded-full ${
                                     data.intelligence.whale_impact === 'High' ? 'bg-amber-500 shadow-[0_0_15px_rgba(245,158,11,0.5)]' : 
                                     data.intelligence.whale_impact === 'Medium' ? 'bg-blue-500' : 'bg-zinc-700'
                                 }`} />
                             </div>
                        </div>

                        {/* Sentiment Score */}
                        <div className="flex-1 p-5 rounded-2xl bg-zinc-900/50 border border-white/5 flex items-center justify-between relative overflow-hidden">
                             <div className="absolute inset-0 bg-purple-500/5" />
                             <div>
                                 <span className="text-[10px] font-bold text-slate-500 uppercase tracking-widest flex items-center gap-1 mb-1">
                                    <BrainCircuit size={12} /> AI Sentiment
                                 </span>
                                 <div className="flex items-baseline gap-2">
                                     <span className={`text-2xl font-black ${getSentimentInfo(data.intelligence.ai_sentiment_score).color}`}>
                                         {data.intelligence.ai_sentiment_score > 0 ? '+' : ''}{data.intelligence.ai_sentiment_score}
                                     </span>
                                     <span className="text-xs font-mono text-zinc-500">/ 1.0</span>
                                 </div>
                             </div>
                             {React.createElement(getSentimentInfo(data.intelligence.ai_sentiment_score).icon, { 
                                 size: 32, 
                                 className: getSentimentInfo(data.intelligence.ai_sentiment_score).color 
                             })}
                        </div>
                    </div>
                </motion.div>
            ) : (
                // Loading Skeleton for Header
                <div className="h-48 rounded-2xl bg-white/5 animate-pulse border border-white/5 flex items-center justify-center">
                     <div className="flex flex-col items-center gap-3">
                         <div className="w-8 h-8 rounded-full border-2 border-brand-accent border-t-transparent animate-spin" />
                         <span className="text-xs font-mono text-zinc-500">
                             {loading ? "GEMINI IS ANALYZING MARKET DATA..." : "WAITING FOR UPLINK"}
                         </span>
                     </div>
                </div>
            )}
        </AnimatePresence>
      </div>

      {/* Error / Status Message */}
      {error && (
          <div className="px-4 py-2 rounded-lg bg-amber-500/10 border border-amber-500/20 text-amber-500 text-xs font-mono flex items-center gap-2">
              <div className="w-1.5 h-1.5 bg-amber-500 rounded-full animate-pulse" />
              {error}
          </div>
      )}

      {/* News Grid */}
      <div className="flex-1">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            <AnimatePresence mode='popLayout'>
            {data?.articles.map((article, idx) => {
                const sentiment = data ? getSentimentInfo(data.intelligence.ai_sentiment_score) : getSentimentInfo(0);
                
                return (
                    <motion.div 
                        key={idx}
                        initial={{ opacity: 0, y: 20 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ delay: idx * 0.05 }}
                        className="fintech-card p-5 group hover:border-brand-accent/30 transition-all flex flex-col justify-between h-full max-w-full"
                    >
                        <div>
                            <div className="flex justify-between items-start mb-4">
                                <div className="flex items-center gap-2">
                                    <span className="px-2 py-1 rounded bg-white/5 border border-white/10 text-[10px] font-bold text-zinc-400 uppercase tracking-wide truncate max-w-[100px]">
                                        {article.source.name}
                                    </span>
                                    <span className="text-[10px] text-zinc-600 font-mono flex items-center gap-1">
                                        <Clock size={10} /> {formatTime(article.publishedAt)}
                                    </span>
                                </div>
                                
                                {/* Sentiment Badge (Contextual) */}
                                <div className={`flex items-center gap-1 px-2 py-0.5 rounded text-[9px] font-black uppercase tracking-wider border ${sentiment.bg} ${sentiment.color} ${sentiment.border}`}>
                                    {sentiment.label}
                                </div>
                            </div>
                            
                            <h3 className="text-sm font-medium text-zinc-200 group-hover:text-white mb-3 leading-relaxed line-clamp-3">
                                {article.title}
                            </h3>
                            <p className="text-xs text-zinc-500 line-clamp-2 leading-relaxed font-light mb-4">
                                {article.description}
                            </p>
                        </div>
                        
                        <div className="pt-4 border-t border-white/5 flex justify-between items-center">
                            <a 
                                href={article.url} 
                                target={article.url === '#' ? '_self' : '_blank'} 
                                onClick={(e) => article.url === '#' && e.preventDefault()}
                                rel="noopener noreferrer"
                                className={`flex items-center gap-1 text-[10px] font-bold ${article.url === '#' ? 'text-zinc-600 cursor-not-allowed' : 'text-brand-accent hover:underline decoration-brand-accent/50 underline-offset-4'}`}
                            >
                                {article.url === '#' ? 'SOURCE RESTRICTED' : 'READ SOURCE'} <ExternalLink size={10} />
                            </a>
                        </div>
                    </motion.div>
                );
            })}
            </AnimatePresence>
        </div>
      </div>
    </div>
    </div>
  );
};

export default IntelView;