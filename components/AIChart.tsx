import React from 'react';
import { useStore } from '../store';

/** Larger candlestick chart for the AI workspace. Pure SVG, no chart library. */
const AIChart: React.FC = () => {
  const candles = useStore(s => s.market.candles);
  const metrics = useStore(s => s.market.metrics);
  const data = (candles || []).slice(-90);

  if (data.length < 2) {
    return <div className="flex h-full items-center justify-center text-xs text-slate-500">Waiting for candles…</div>;
  }

  const W = 1000, H = 440, PAD_L = 8, PAD_R = 64, PAD_T = 16, PAD_B = 52;
  const min = Math.min(...data.map(c => c.low ?? c.close));
  const max = Math.max(...data.map(c => c.high ?? c.close));
  const span = max - min || 1;
  const innerW = W - PAD_L - PAD_R;
  const innerH = H - PAD_T - PAD_B;
  const slot = innerW / data.length;
  const bodyW = Math.max(2, slot * 0.62);
  const y = (v: number) => PAD_T + (1 - (v - min) / span) * innerH;
  const maxVol = Math.max(...data.map(c => c.volume || 0), 1);
  const last = data[data.length - 1];
  const lastY = y(last.close);
  const gridLines = [0, 0.25, 0.5, 0.75, 1];
  const up = (metrics.change || 0) >= 0;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/5 px-3 py-2">
        <div className="flex items-center gap-2">
          <span className="text-[12px] font-bold tracking-wider text-white">{metrics.pair}</span>
          <span className="font-mono text-[12px] tabular-nums text-slate-200">
            ${metrics.price.toLocaleString(undefined, { maximumFractionDigits: 2 })}
          </span>
          <span className={`font-mono text-[10px] ${up ? 'text-emerald-400' : 'text-rose-400'}`}>
            {up ? '+' : ''}{metrics.change.toFixed(2)}%
          </span>
        </div>
        <div className="flex items-center gap-3 font-mono text-[9px] text-slate-500">
          <span>H {max.toLocaleString(undefined, { maximumFractionDigits: 1 })}</span>
          <span>L {min.toLocaleString(undefined, { maximumFractionDigits: 1 })}</span>
          <span>{data.length} bars</span>
        </div>
      </div>

      <div className="min-h-0 flex-1 p-1">
        <svg viewBox={`0 0 ${W} ${H}`} className="h-full w-full" preserveAspectRatio="none">
          {gridLines.map(g => {
            const price = max - g * span;
            const yy = PAD_T + g * innerH;
            return (
              <g key={g}>
                <line x1={PAD_L} y1={yy} x2={W - PAD_R} y2={yy} stroke="rgba(255,255,255,0.05)" strokeDasharray="3 4" />
                <text x={W - PAD_R + 6} y={yy + 3} fill="#64748b" fontSize="10" fontFamily="JetBrains Mono, monospace">
                  {price.toLocaleString(undefined, { maximumFractionDigits: 1 })}
                </text>
              </g>
            );
          })}

          {data.map((c, i) => {
            const x = PAD_L + i * slot + slot / 2;
            const green = c.close >= c.open;
            const color = green ? '#10b981' : '#f43f5e';
            const yo = y(c.open), yc = y(c.close);
            const top = Math.min(yo, yc);
            const h = Math.max(1, Math.abs(yc - yo));
            const wickTop = y(c.high ?? Math.max(c.open, c.close));
            const wickBot = y(c.low ?? Math.min(c.open, c.close));
            const volH = ((c.volume || 0) / maxVol) * (PAD_B - 12);
            return (
              <g key={i}>
                <line x1={x} y1={wickTop} x2={x} y2={wickBot} stroke={color} strokeWidth="1" />
                <rect x={x - bodyW / 2} y={top} width={bodyW} height={h} fill={color} opacity="0.9" />
                <rect x={x - bodyW / 2} y={H - 4 - volH} width={bodyW} height={volH} fill={color} opacity="0.25" />
              </g>
            );
          })}

          <line x1={PAD_L} y1={lastY} x2={W - PAD_R} y2={lastY} stroke={up ? '#10b981' : '#f43f5e'} strokeWidth="0.8" strokeDasharray="4 4" opacity="0.7" />
          <rect x={W - PAD_R + 2} y={lastY - 9} width={PAD_R - 4} height="18" rx="3" fill={up ? '#065f46' : '#7f1d1d'} />
          <text x={W - PAD_R + 6} y={lastY + 4} fill="#fff" fontSize="10" fontFamily="JetBrains Mono, monospace">
            {last.close.toLocaleString(undefined, { maximumFractionDigits: 1 })}
          </text>
        </svg>
      </div>
    </div>
  );
};

export default AIChart;
