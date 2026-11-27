import React, { useEffect, useId, useState } from 'react';

/** Shared "premium" presentation primitives. Visual only — no data logic. */

export const Sparkline: React.FC<{ values: number[]; color?: string; height?: number }> = ({
  values, color = '#3b82f6', height = 36,
}) => {
  const id = useId().replace(/:/g, '');
  if (values.length < 2) return <div style={{ height }} />;
  const w = 240, h = height;
  const min = Math.min(...values), max = Math.max(...values);
  const span = max - min || 1;
  const pts = values.map((v, i) => `${(i / (values.length - 1)) * w},${(h - 2) - ((v - min) / span) * (h - 4)}`).join(' ');
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="w-full" preserveAspectRatio="none" style={{ height }}>
      <defs>
        <linearGradient id={`g${id}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.35" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <polygon points={`0,${h} ${pts} ${w},${h}`} fill={`url(#g${id})`} />
      <polyline points={pts} fill="none" stroke={color} strokeWidth="1.6" vectorEffect="non-scaling-stroke" />
    </svg>
  );
};

export const Provenance: React.FC<{ source?: string; asOf?: string; live?: boolean }> = ({ source, asOf, live }) => {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 15000);
    return () => clearInterval(id);
  }, []);
  const ts = asOf ? new Date(asOf).getTime() : NaN;
  const ageS = Number.isFinite(ts) ? Math.max(0, Math.round((now - ts) / 1000)) : null;
  const label = live ? 'live' : ageS === null ? '—' : ageS < 60 ? `${ageS}s ago` : `${Math.round(ageS / 60)}m ago`;
  const tone = live ? 'text-emerald-400' : ageS !== null && ageS > 120 ? 'text-amber-400' : 'text-slate-500';
  return (
    <span title={asOf ? `recorded ${asOf}` : undefined}
      className="flex items-center gap-1.5 rounded-md border border-white/[0.07] bg-black/40 px-2 py-0.5 font-mono text-[9px] text-slate-500">
      <span className={`h-1.5 w-1.5 rounded-full ${live ? 'bg-emerald-400' : 'bg-slate-600'}`} />
      {source && <span className="uppercase tracking-wider">{source}</span>}
      <span className={tone}>{label}</span>
    </span>
  );
};

export const PageHeader: React.FC<{
  icon: React.ReactNode;
  title: string;
  subtitle?: string;
  badge?: string;
  source?: string;
  asOf?: string;
  live?: boolean;
  children?: React.ReactNode;
}> = ({ icon, title, subtitle, badge, source, asOf, live, children }) => (
  <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
    <div className="min-w-0">
      <div className="flex flex-wrap items-center gap-2">
        <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand-accent/15 text-brand-accent">
          {icon}
        </span>
        <h1 className="page-title text-lg font-bold tracking-wide">{title}</h1>
        {badge && (
          <span className="rounded-full border border-brand-accent/30 bg-brand-accent/10 px-2 py-0.5 text-[9px] font-black uppercase tracking-[0.14em] text-brand-accent">
            {badge}
          </span>
        )}
        {(source || asOf || live) && <Provenance source={source} asOf={asOf} live={live} />}
      </div>
      {subtitle && <p className="mt-1.5 text-xs text-slate-500">{subtitle}</p>}
    </div>
    {children && <div className="flex flex-wrap items-center gap-2">{children}</div>}
  </div>
);

export const StatTile: React.FC<{
  label: string;
  value: React.ReactNode;
  sub?: string;
  tone?: string;
  spark?: number[];
  sparkColor?: string;
}> = ({ label, value, sub, tone = 'text-white', spark, sparkColor }) => (
  <div className="premium-card p-4">
    <div className="text-[10px] font-bold uppercase tracking-wider text-slate-500">{label}</div>
    <div className={`mt-1 font-mono text-xl font-black tracking-tight ${tone}`}>{value}</div>
    {sub && <div className="mt-0.5 font-mono text-[10px] text-slate-500">{sub}</div>}
    {spark && spark.length > 1 && (
      <div className="mt-2 -mb-1">
        <Sparkline values={spark} color={sparkColor || '#3b82f6'} height={30} />
      </div>
    )}
  </div>
);

export const HeatCell: React.FC<{
  text: string | number;
  color: string;
  title?: string;
  className?: string;
}> = ({ text, color, title, className = '' }) => (
  <div
    title={title}
    className={`rounded-md px-1 py-1 text-center font-mono text-[11px] font-bold text-white/95 ${className}`}
    style={{ background: color }}
  >
    {text}
  </div>
);

export const EmptyState: React.FC<{ icon?: React.ReactNode; title: string; hint?: string }> = ({ icon, title, hint }) => (
  <div className="flex flex-col items-center justify-center py-10 text-center">
    <div className="mb-2 flex h-10 w-10 items-center justify-center rounded-xl bg-white/[0.04] text-slate-500">{icon}</div>
    <div className="text-xs font-semibold text-slate-400">{title}</div>
    {hint && <div className="mt-1 max-w-xs text-[11px] text-slate-600">{hint}</div>}
  </div>
);

export const Skeleton: React.FC<{ className?: string }> = ({ className = '' }) => (
  <div className={`animate-pulse rounded-md bg-white/[0.05] ${className}`} />
);

export const SkeletonRows: React.FC<{ rows?: number; colSpan: number }> = ({ rows = 5, colSpan }) => (
  <>
    {Array.from({ length: rows }).map((_, i) => (
      <tr key={i}>
        <td colSpan={colSpan} className="px-3 py-2">
          <div className="h-3 w-full animate-pulse rounded bg-white/[0.05]" style={{ opacity: 1 - i * 0.12 }} />
        </td>
      </tr>
    ))}
  </>
);

/** RSI / intensity colour ramp shared by heatmaps. */
export const rsiColor = (v: number | null | undefined): string => {
  if (v === null || v === undefined) return 'rgba(148,163,184,0.07)';
  if (v >= 70) return 'rgba(244,63,94,0.60)';
  if (v >= 60) return 'rgba(244,63,94,0.32)';
  if (v <= 30) return 'rgba(16,185,129,0.60)';
  if (v <= 40) return 'rgba(16,185,129,0.32)';
  return 'rgba(148,163,184,0.10)';
};

/** Signed-value ramp for funding / basis style heatmaps. */
export const signedColor = (v: number, max: number): string => {
  if (!max) return 'rgba(148,163,184,0.10)';
  const a = Math.min(1, Math.abs(v) / max);
  return v >= 0 ? `rgba(244,63,94,${0.12 + a * 0.5})` : `rgba(16,185,129,${0.12 + a * 0.5})`;
};
