import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Bot, X, Send, Sparkles, Loader2 } from 'lucide-react';
import { useStore } from '../store';
import { isAdminEmail } from '../utils/entitlements';
import { cachedJson } from '../utils/cachedFetch';
import { runAssistant, AssistantMessage } from '../utils/groq';

const LIMIT_FREE = 5;
const LIMIT_PRO = 100;
const USAGE_KEY = 'qd.ai.usage.v1';

const readUsage = (): { day: string; count: number } => {
  const day = new Date().toISOString().slice(0, 10);
  try {
    const raw = JSON.parse(localStorage.getItem(USAGE_KEY) || '{}');
    return raw.day === day ? { day, count: Number(raw.count) || 0 } : { day, count: 0 };
  } catch { return { day, count: 0 }; }
};

const AIAssistant: React.FC = () => {
  const metrics = useStore(s => s.market.metrics);
  const activeSymbol = useStore(s => s.config.activeSymbol);
  const activeTab = useStore(s => s.ui.activeTab);
  const watchlist = useStore(s => s.watchlist);
  const priceAlerts = useStore(s => s.priceAlerts);
  const plan = useStore(s => s.auth.plan);
  const admin = isAdminEmail(useStore(s => s.auth.user?.email));
  const setActiveTab = useStore(s => s.setActiveTab);

  const [open, setOpen] = useState(false);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [messages, setMessages] = useState<AssistantMessage[]>([{
    role: 'assistant',
    content: 'Ask me about the terminal or the market. I read the same recorded feeds as the boards and will say when data is missing.',
  }]);
  const [error, setError] = useState<string | null>(null);
  const [usage, setUsage] = useState(readUsage);
  const listRef = useRef<HTMLDivElement>(null);
  const [vp, setVp] = useState(() => ({
    w: typeof window !== 'undefined' ? window.innerWidth : 1280,
    h: typeof window !== 'undefined' ? window.innerHeight : 800,
  }));
  const [pos, setPos] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem('qd.ai.pos') || 'null');
      if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) return saved;
    } catch { /* ignore */ }
    const w = typeof window !== 'undefined' ? window.innerWidth : 1280;
    const h = typeof window !== 'undefined' ? window.innerHeight : 800;
    return { x: Math.max(8, w - 72), y: Math.max(8, h - (w < 1024 ? 220 : 88)) };
  });
  const dragRef = useRef<{ active: boolean; moved: boolean; sx: number; sy: number; ox: number; oy: number } | null>(null);

  useEffect(() => {
    const onResize = () => setVp({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  useEffect(() => {
    try { localStorage.setItem('qd.ai.pos', JSON.stringify(pos)); } catch { /* ignore */ }
  }, [pos]);

  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

  const onDown = (e: React.PointerEvent<HTMLButtonElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { active: true, moved: false, sx: e.clientX, sy: e.clientY, ox: pos.x, oy: pos.y };
  };
  const onMove = (e: React.PointerEvent<HTMLButtonElement>) => {
    const d = dragRef.current;
    if (!d?.active) return;
    const dx = e.clientX - d.sx;
    const dy = e.clientY - d.sy;
    if (Math.abs(dx) + Math.abs(dy) > 4) d.moved = true;
    setPos({ x: clamp(d.ox + dx, 8, vp.w - 56), y: clamp(d.oy + dy, 8, vp.h - 56) });
  };
  const onUp = () => {
    const d = dragRef.current;
    if (d && !d.moved) setOpen(v => !v);
    dragRef.current = null;
  };

  const panelW = Math.min(560, vp.w - 24);
  const panelH = Math.min(Math.max(420, Math.round(vp.h * 0.66)), vp.h - 24);
  const panelX = clamp(pos.x + 56 - panelW, 12, Math.max(12, vp.w - panelW - 12));
  const panelY = clamp(pos.y + 56 - panelH, 12, Math.max(12, vp.h - panelH - 12));

  const limit = admin ? Infinity : plan === 'pro' ? LIMIT_PRO : LIMIT_FREE;
  const left = Math.max(0, limit - usage.count);

  useEffect(() => {
    if (open) setTimeout(() => listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' }), 50);
  }, [messages, open]);

  const quotaLabel = admin ? 'admin · unlimited' : `${left}/${limit} left today`;

  const context = async (): Promise<string> => {
    const sym = activeSymbol || 'BTCUSDT';
    const base = sym.replace('USDT', '');
    const [fut, pos, fund, opt] = await Promise.all([
      cachedJson<any>(`/coin-futures?symbol=${sym}`, { ttlMs: 60000, timeoutMs: 45000 }).catch(() => null),
      cachedJson<any>(`/positioning?symbol=${sym}&period=1h&limit=24`, { ttlMs: 60000, timeoutMs: 45000 }).catch(() => null),
      cachedJson<any>(`/funding-history?symbol=${sym}&limit=21`, { ttlMs: 120000, timeoutMs: 45000 }).catch(() => null),
      (base === 'BTC' || base === 'ETH')
        ? cachedJson<any>(`/options?currency=${base}`, { ttlMs: 120000, timeoutMs: 60000 }).catch(() => null)
        : Promise.resolve(null),
    ]);
    const snap = {
      app: {
        boards: 'Desk, Chart, Coins, Markets, Positioning, RSI Screener, Liquidations, Whales, Funding & OI, Order Flow, Depth, Liquidity, Bias, Regime, Macro, Intel, Analytics, Pricing',
        free: 'prices, chart, funding, positioning, RSI, liquidations, macro, news, watchlist, 3 alerts',
        pro: 'order flow, whales, depth, liquidity, regime, bias, analytics, AI scans, unlimited alerts',
        disclaimer: 'data only, not investment advice',
      },
      current: {
        tab: activeTab,
        symbol: sym,
        price: metrics.price,
        change24h: metrics.change,
        watchlist,
        activeAlerts: priceAlerts.filter(a => !a.triggeredAt).length,
      },
      futures: fut ? {
        price: fut.price, basis_pct: fut.basis_pct, funding_rate: fut.funding_rate,
        oi_usd: fut.oi_usd, oi_change_24h: fut.oi_change_24h, volume_24h: fut.volume_24h,
        long_short: fut.long_short, taker_ratio: fut.taker_ratio, liq_24h: fut.liq_24h,
      } : null,
      positioning: pos?.series ? {
        retail: pos.series.global_accounts?.latest,
        top_accounts: pos.series.top_accounts?.latest,
        top_positions: pos.series.top_positions?.latest,
        taker: pos.series.taker?.latest,
        as_of: pos.as_of,
      } : null,
      funding: fund ? { latest: fund.latest, accumulated_pct: fund.accumulated_pct, settlements: fund.settlements } : null,
      options: opt ? {
        dvol: opt.dvol, dvol_percentile_1y: opt.dvol_percentile_1y,
        rv_30d: opt.rv_30d, put_call_ratio: opt.put_call_ratio,
        max_pain: opt.max_pain, total_oi_usd: opt.total_oi_usd, expiries: (opt.expiries || []).slice(0, 4),
      } : null,
    };
    return JSON.stringify(snap);
  };

  const send = async (text?: string) => {
    const q = (text ?? input).trim();
    if (!q || busy) return;
    if (left <= 0) {
      setError('Daily AI limit reached. Upgrade for more requests.');
      return;
    }
    setError(null);
    setBusy(true);
    setInput('');
    const next = [...messages, { role: 'user' as const, content: q }];
    setMessages(next);
    try {
      const ctx = await context();
      const answer = await runAssistant(next, ctx);
      setMessages(m => [...m, { role: 'assistant', content: answer }]);
      const u = { day: usage.day, count: usage.count + 1 };
      setUsage(u);
      try { localStorage.setItem(USAGE_KEY, JSON.stringify(u)); } catch { /* ignore */ }
    } catch (e: any) {
      setError(e?.message || 'AI request failed.');
    } finally {
      setBusy(false);
    }
  };

  const suggestions = useMemo(() => [
    `What is ${activeSymbol.replace('USDT', '')} funding right now?`,
    'Explain what this board shows',
    'Where are liquidations clustered?',
    'What does Pro include?',
  ], [activeSymbol]);

  return (
    <>
      <button
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        style={{ left: pos.x, top: pos.y }}
        aria-label="Open AI assistant (drag to move)"
        title="Drag to move · click to open"
        className="fixed z-[65] flex h-12 w-12 touch-none cursor-grab items-center justify-center rounded-full bg-gradient-to-tr from-brand-accent to-purple-500 text-white shadow-[0_10px_30px_-8px_rgba(59,130,246,0.8)] transition-transform active:scale-95 active:cursor-grabbing"
      >
        {open ? <X size={20} /> : <Bot size={21} />}
      </button>

      {open && (
        <div
          style={{ left: panelX, top: panelY, width: panelW, height: panelH }}
          className="fixed z-[64] flex flex-col overflow-hidden rounded-xl border border-white/10 bg-[#0b0b0e]/98 shadow-2xl backdrop-blur-md"
        >
          <div className="flex items-center justify-between border-b border-white/5 px-3 py-2.5">
            <div className="flex items-center gap-2">
              <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-brand-accent/15 text-brand-accent"><Sparkles size={14} /></span>
              <div>
                <div className="text-[12px] font-bold text-white">Desk AI</div>
                <div className="font-mono text-[9px] text-slate-500">{quotaLabel}</div>
              </div>
            </div>
            <button onClick={() => setOpen(false)} className="rounded p-1 text-slate-500 hover:text-white"><X size={16} /></button>
          </div>

          <div ref={listRef} className="flex-1 space-y-2 overflow-y-auto p-3">
            {messages.map((m, i) => (
              <div key={i} className={`rounded-lg px-3 py-2 text-[12px] leading-relaxed ${m.role === 'user' ? 'ml-6 bg-brand-accent/15 text-slate-100' : 'mr-2 bg-white/[0.04] text-slate-300'}`}>
                <div className="whitespace-pre-wrap">{m.content}</div>
              </div>
            ))}
            {busy && <div className="flex items-center gap-2 px-2 text-[11px] text-slate-500"><Loader2 size={12} className="animate-spin" /> reading live data…</div>}
            {error && <div className="rounded-lg border border-rose-500/20 bg-rose-500/10 px-3 py-2 text-[11px] text-rose-300">{error}</div>}
          </div>

          {messages.length <= 1 && (
            <div className="flex flex-wrap gap-1.5 px-3 pb-2">
              {suggestions.map(s => (
                <button key={s} onClick={() => send(s)} className="rounded-full border border-white/10 px-2 py-1 text-[9px] text-slate-400 hover:bg-white/5 hover:text-slate-200">{s}</button>
              ))}
            </div>
          )}

          <div className="border-t border-white/5 p-2">
            <div className="flex items-end gap-2">
              <textarea
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
                rows={1}
                placeholder={left > 0 ? 'Ask about the app or the market…' : 'Daily limit reached'}
                disabled={left <= 0}
                className="max-h-24 flex-1 resize-none rounded-lg border border-white/10 bg-black/40 px-2.5 py-2 text-[12px] text-slate-200 outline-none focus:border-brand-accent/50 disabled:opacity-60"
              />
              <button onClick={() => send()} disabled={busy || !input.trim() || left <= 0}
                className="flex h-9 w-9 items-center justify-center rounded-lg bg-brand-accent text-white hover:bg-brand-accent/90 disabled:opacity-40">
                <Send size={14} />
              </button>
            </div>
            <div className="mt-1 flex items-center justify-between font-mono text-[8px] text-slate-600">
              <span>Recorded data · not investment advice</span>
              {plan !== 'pro' && !admin && left <= 0 && (
                <button onClick={() => setActiveTab('pricing')} className="text-brand-accent hover:underline">Upgrade</button>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
};

export default AIAssistant;
