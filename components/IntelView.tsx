import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { MOCK_NEWS } from '../constants';
import { Newspaper, ExternalLink, Clock, X, Share2, Bookmark } from 'lucide-react';
import { NewsItem } from '../types';

const MotionDiv = motion.div as any;

const IntelView: React.FC = () => {
  const [sentimentFilter, setSentimentFilter] = useState<'all' | 'bullish' | 'bearish' | 'neutral'>('all');
  const [selectedNews, setSelectedNews] = useState<NewsItem | null>(null);

  const filteredNews = MOCK_NEWS.filter(item => {
    return sentimentFilter === 'all' || item.sentiment === sentimentFilter;
  });

  const FilterChip = ({ label, active, onClick }: { label: string, active: boolean, onClick: () => void }) => (
    <button
      onClick={onClick}
      className={`
        text-xs font-medium px-4 py-2 rounded-full transition-all border
        ${active 
          ? 'bg-brand-accent text-white border-brand-accent shadow-lg shadow-brand-accent/20' 
          : 'bg-white/5 text-slate-400 border-white/10 hover:bg-white/10 hover:border-white/20'
        }
      `}
    >
      {label}
    </button>
  );

  return (
    <div className="h-full flex flex-col gap-6 max-w-5xl mx-auto px-4 lg:px-0 relative">
      <div className="flex flex-col gap-4">
        <h1 className="text-2xl font-bold text-white tracking-tight flex items-center gap-3">
            <div className="p-2 bg-brand-accent/20 rounded-lg text-brand-accent">
                <Newspaper size={24} />
            </div>
            Market Intelligence
        </h1>

        {/* Filters */}
        <div className="flex flex-wrap gap-2">
            <FilterChip label="All Intel" active={sentimentFilter === 'all'} onClick={() => setSentimentFilter('all')} />
            <FilterChip label="Bullish" active={sentimentFilter === 'bullish'} onClick={() => setSentimentFilter('bullish')} />
            <FilterChip label="Bearish" active={sentimentFilter === 'bearish'} onClick={() => setSentimentFilter('bearish')} />
            <FilterChip label="Neutral" active={sentimentFilter === 'neutral'} onClick={() => setSentimentFilter('neutral')} />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto pb-20 lg:pb-0">
        <AnimatePresence mode='popLayout'>
        {filteredNews.map((item, idx) => (
            <MotionDiv 
              key={item.id}
              layoutId={`news-card-${item.id}`}
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: idx * 0.05 }}
              onClick={() => setSelectedNews(item)}
              className="fintech-card p-5 mb-4 group hover:border-brand-accent/50 transition-all cursor-pointer"
            >
              <div className="flex justify-between items-start mb-3">
                 <div className="flex items-center gap-2">
                    <span className="px-2 py-1 rounded-md bg-white/5 border border-white/10 text-[10px] font-bold text-slate-400 uppercase">
                        {item.source}
                    </span>
                    <span className="text-[11px] text-slate-500 font-medium flex items-center gap-1">
                        <Clock size={12} /> {item.time}
                    </span>
                 </div>
                 <div className={`
                    w-2 h-2 rounded-full
                    ${item.sentiment === 'bullish' ? 'bg-trade-bid shadow-[0_0_8px_rgba(16,185,129,0.5)]' : 
                      item.sentiment === 'bearish' ? 'bg-trade-ask shadow-[0_0_8px_rgba(244,63,94,0.5)]' : 'bg-slate-500'}
                 `} />
              </div>
              
              <h3 className="text-lg font-medium text-slate-200 group-hover:text-white mb-4 leading-snug">
                {item.title}
              </h3>
              
              <div className="flex items-center justify-between border-t border-white/5 pt-4">
                 <div className="flex gap-2">
                    {item.impact === 'high' && (
                        <span className="flex items-center gap-1 text-[10px] font-bold text-trade-warn bg-trade-warn/10 px-2 py-1 rounded">
                            HIGH IMPACT
                        </span>
                    )}
                 </div>
                 <span className="flex items-center gap-1 text-xs font-semibold text-brand-accent group-hover:underline">
                    Read Report <ExternalLink size={12} />
                 </span>
              </div>
            </MotionDiv>
          ))}
        </AnimatePresence>
      </div>

      {/* Modal Overlay */}
      <AnimatePresence>
        {selectedNews && (
            <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
                {/* Backdrop */}
                <MotionDiv 
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    onClick={() => setSelectedNews(null)}
                    className="absolute inset-0 bg-black/80 backdrop-blur-sm"
                />

                {/* Modal Card */}
                <MotionDiv 
                    layoutId={`news-card-${selectedNews.id}`}
                    initial={{ scale: 0.95, opacity: 0 }}
                    animate={{ scale: 1, opacity: 1 }}
                    exit={{ scale: 0.95, opacity: 0 }}
                    className="relative w-full max-w-2xl bg-[#09090b] border border-white/10 rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[85vh]"
                    onClick={(e: React.MouseEvent) => e.stopPropagation()}
                >
                    {/* Header Image/Banner Area */}
                    <div className="h-32 bg-gradient-to-br from-brand-accent/20 to-purple-900/20 flex items-center justify-center relative p-6">
                        <div className="absolute top-4 right-4 flex gap-2">
                            <button className="p-2 rounded-full bg-black/40 hover:bg-black/60 text-white transition-colors">
                                <Share2 size={16} />
                            </button>
                            <button className="p-2 rounded-full bg-black/40 hover:bg-black/60 text-white transition-colors">
                                <Bookmark size={16} />
                            </button>
                            <button 
                                onClick={() => setSelectedNews(null)}
                                className="p-2 rounded-full bg-black/40 hover:bg-red-500/20 hover:text-red-500 text-white transition-colors"
                            >
                                <X size={16} />
                            </button>
                        </div>
                        <Newspaper size={48} className="text-white/10 absolute bottom-[-10px] left-6" />
                        <div className="w-full">
                            <div className="flex items-center gap-3 mb-2">
                                <span className="px-2 py-1 rounded bg-black/40 backdrop-blur text-[10px] font-bold text-white uppercase tracking-wider border border-white/10">
                                    {selectedNews.source}
                                </span>
                                <span className="flex items-center gap-1 text-xs font-mono text-white/80">
                                    <Clock size={12} /> {selectedNews.time}
                                </span>
                            </div>
                        </div>
                    </div>

                    {/* Content */}
                    <div className="p-8 overflow-y-auto">
                        <h2 className="text-2xl font-bold text-white mb-6 leading-tight">
                            {selectedNews.title}
                        </h2>

                        <div className="flex gap-3 mb-8">
                             <div className={`
                                px-3 py-1.5 rounded-md border text-xs font-bold uppercase
                                ${selectedNews.sentiment === 'bullish' ? 'border-trade-bid/30 bg-trade-bid/10 text-trade-bid' : 
                                  selectedNews.sentiment === 'bearish' ? 'border-trade-ask/30 bg-trade-ask/10 text-trade-ask' : 'border-slate-500/30 bg-slate-500/10 text-slate-400'}
                             `}>
                                {selectedNews.sentiment} Sentiment
                             </div>
                             {selectedNews.impact === 'high' && (
                                <div className="px-3 py-1.5 rounded-md border border-trade-warn/30 bg-trade-warn/10 text-trade-warn text-xs font-bold uppercase">
                                    High Impact
                                </div>
                             )}
                        </div>

                        <div className="prose prose-invert prose-sm max-w-none">
                            <p className="text-lg text-slate-300 leading-relaxed font-light">
                                {selectedNews.summary}
                            </p>
                            <br />
                            <p className="text-slate-400 leading-relaxed">
                                Market implications suggest a repricing of risk assets in the short term. Traders are advised to monitor key liquidity levels and adjust stop-losses accordingly. Algorithmic flow is currently skewed towards {selectedNews.sentiment === 'bullish' ? 'accumulation' : 'distribution'}.
                            </p>
                        </div>

                        <div className="mt-8 pt-6 border-t border-white/5 flex justify-between items-center">
                            <span className="text-xs text-slate-500 font-mono">ID: {selectedNews.id} • AI GEN SUMMARY</span>
                            <button className="flex items-center gap-2 px-4 py-2 bg-brand-accent hover:bg-blue-600 text-white rounded-lg text-sm font-semibold transition-colors shadow-lg shadow-blue-500/20">
                                Read Full Report <ExternalLink size={14} />
                            </button>
                        </div>
                    </div>
                </MotionDiv>
            </div>
        )}
      </AnimatePresence>
    </div>
  );
};

export default IntelView;