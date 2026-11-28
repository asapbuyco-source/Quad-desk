import React, { useState } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { useStore } from '../store';

/** Lightweight SVG price chart for the desk — collapsible to free space for book/tape. */
const MiniPriceChart: React.FC = () => {
  const candles = useStore(s => s.market.candles);
  const metrics = useStore(s => s.market.metrics);
  const base = (metrics.pair || 'BTC/USDT').replace('USDT', '').replace('/', '');
  const [collapsed, setCollapsed] = useState(() => {
    try { return localStorage.getItem('qd.miniChart.collapsed') === '1'; } catch { return false; }
  });

  const toggle = () => {
    setCollapsed(v => {
      const next = !v;
      try { localStorage.setItem('qd.miniChart.collapsed', next ? '1' : '0'); } catch { /* ignore */ }
      return next;
    });
  };

  const data = (candles || []).slice(-72);
  if (data.length < 2) {
    return <div className="premium-card h-[170px] animate-pulse" />;
  }

  const W = 800, H = 150, PAD = 6;
  const closes = data.map(c => c.close);
  const min = Math.min(...data.map(c => c.low ?? c.close));
  const max = Math.max(...data.map(c => c.high ?? c.close));
  const span = max - min || 1;
  const x = (i: number) => (i / (data.length - 1)) * (W - PAD * 2) + PAD;
  const y = (v: number) => PAD + (1 - (v - min) / span) * (H - PAD * 2);
  const first = closes[0], last = closes[closes.length - 1];
  const up = last >= first;
  const color = up ? '#10b981' : '#f43f5e';
  const pts = closes.map((v, i) => `${x(i)},${y(v)}`).join(' ');
  const id = `mini-${base}`;

  return (
    <div className="premium-card flex shrink-0 flex-col overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/5 px-3 py-1.5">
        <div className="flex items-center gap-2">
          <span className="text-[11px] font-bold tracking-wider text-white">{metrics.pair}</span>
          <span className="font-mono text-[11px] tabular-nums text-slate-300">${metrics.price.toLocaleString(undefined, { maximumFractionDigits: 2 })}</span>
          <span className={`font-mono text-[10px] ${metrics.change >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
            {metrics.change >= 0 ? '+' : ''}{metrics.change.toFixed(2)}%
          </span>
        </div>
        <div className="flex items-center gap-3 font-mono text-[9px] text-slate-500">
          {!collapsed && <span>H {max.toLocaleString(undefined, { maximumFractionDigits: 1 })}</span>}
          {!collapsed && <span>L {min.toLocaleString(undefined, { maximumFractionDigits: 1 })}</span>}
          <span>{data.length} bars</span>
          <button onClick={toggle} title={collapsed ? 'Show chart' : 'Collapse chart for more book/tape space'}
            aria-expanded={!collapsed}
            className="flex items-center gap-1 rounded border border-white/10 px-1.5 py-0.5 text-[9px] text-slate-400 hover:bg-white/5 hover:text-white">
            {collapsed ? <ChevronDown size={11} /> : <ChevronUp size={11} />}
            {collapsed ? 'Show' : 'Hide'}
          </button>
        </div>
      </div>
      {!collapsed && (
        <div className="h-[140px] w-full px-1 pb-1">
          <svg viewBox={`0 0 ${W} ${H}`} className="h-full w-full" preserveAspectRatio="none">
            <defs>
              <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={color} stopOpacity="0.28" />
                <stop offset="100%" stopColor={color} stopOpacity="0" />
              </linearGradient>
            </defs>
            <polygon points={`${x(0)},${H} ${pts} ${x(data.length - 1)},${H}`} fill={`url(#${id})`} />
            <polyline points={pts} fill="none" stroke={color} strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
            <line x1={PAD} y1={y(last)} x2={W - PAD} y2={y(last)} stroke={color} strokeWidth="0.7" strokeDasharray="3 3" opacity="0.5" />
          </svg>
        </div>
      )}
    </div>
  );
};

export default MiniPriceChart;
