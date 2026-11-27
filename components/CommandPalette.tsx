import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Search, CornerDownLeft } from 'lucide-react';
import { useStore } from '../store';

const TABS = [
  ['dashboard', 'Desk'], ['watchlist', 'Watchlist & Alerts'], ['charting', 'Chart'],
  ['coins', 'Coin Explorer'], ['markets', 'Markets'], ['positioning', 'Positioning'],
  ['screener', 'RSI Screener'], ['liquidations', 'Liquidations'], ['whales', 'Whale Positions'],
  ['funding', 'Funding & OI'], ['order-flow', 'Order Flow'], ['depth', 'Depth'],
  ['liquidity', 'Liquidity'], ['bias', 'Bias Matrix'], ['regime', 'Regime'],
  ['macro', 'Macro & FX'], ['intel', 'Intel'], ['analytics', 'Analytics'],
  ['pricing', 'Plans & Billing'], ['settings', 'Settings'], ['guide', 'Guide'],
] as const;

const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'DOGEUSDT', 'LINKUSDT'];

const CommandPalette: React.FC = () => {
  const setActiveTab = useStore(s => s.setActiveTab);
  const setSymbol = useStore(s => s.setSymbol);
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [idx, setIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen(v => !v);
      } else if (e.key === 'Escape') {
        setOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    const openEvent = () => setOpen(true);
    window.addEventListener('qd-palette', openEvent);
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('qd-palette', openEvent); };
  }, []);

  useEffect(() => {
    if (open) { setQ(''); setIdx(0); setTimeout(() => inputRef.current?.focus(), 30); }
  }, [open]);

  const items = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const tabs = TABS.filter(([, label]) => !needle || label.toLowerCase().includes(needle))
      .map(([id, label]) => ({ kind: 'tab' as const, id, label }));
    const syms = SYMBOLS.filter(s => !needle || s.toLowerCase().includes(needle))
      .map(s => ({ kind: 'symbol' as const, id: s, label: `${s.replace('USDT', '')} / USDT` }));
    return [...tabs, ...syms].slice(0, 10);
  }, [q]);

  if (!open) return null;

  const run = (i: number) => {
    const item = items[i];
    if (!item) return;
    if (item.kind === 'tab') setActiveTab(item.id);
    else { setSymbol(item.id); setActiveTab('dashboard'); }
    setOpen(false);
  };

  return (
    <div className="fixed inset-0 z-[120] flex items-start justify-center bg-black/70 p-4 pt-[12vh] backdrop-blur-sm" onClick={() => setOpen(false)}>
      <div className="w-full max-w-lg overflow-hidden rounded-xl border border-white/10 bg-[#0c0c0f] shadow-2xl" onClick={e => e.stopPropagation()}>
        <div className="flex items-center gap-2 border-b border-white/5 px-3 py-2.5">
          <Search size={15} className="text-slate-500" />
          <input
            ref={inputRef}
            value={q}
            onChange={e => { setQ(e.target.value); setIdx(0); }}
            onKeyDown={e => {
              if (e.key === 'ArrowDown') { e.preventDefault(); setIdx(i => Math.min(i + 1, items.length - 1)); }
              if (e.key === 'ArrowUp') { e.preventDefault(); setIdx(i => Math.max(i - 1, 0)); }
              if (e.key === 'Enter') run(idx);
            }}
            placeholder="Jump to a board or symbol…"
            className="flex-1 bg-transparent text-sm text-white outline-none placeholder:text-slate-600"
          />
          <kbd className="rounded border border-white/10 px-1.5 py-0.5 font-mono text-[9px] text-slate-500">ESC</kbd>
        </div>
        <div className="max-h-[55vh] overflow-y-auto p-1.5">
          {items.map((item, i) => (
            <button key={`${item.kind}-${item.id}`} onMouseEnter={() => setIdx(i)} onClick={() => run(i)}
              className={`flex w-full items-center justify-between rounded-lg px-2.5 py-2 text-left ${i === idx ? 'bg-brand-accent/15 text-white' : 'text-slate-300 hover:bg-white/5'}`}>
              <span className="flex items-center gap-2 text-xs">
                <span className="rounded bg-white/5 px-1.5 py-0.5 font-mono text-[8px] uppercase text-slate-500">{item.kind === 'tab' ? 'board' : 'symbol'}</span>
                {item.label}
              </span>
              {i === idx && <CornerDownLeft size={12} className="text-slate-500" />}
            </button>
          ))}
          {!items.length && <div className="px-3 py-6 text-center text-xs text-slate-500">No match</div>}
        </div>
        <div className="border-t border-white/5 px-3 py-1.5 font-mono text-[9px] text-slate-600">
          ↑↓ to move · Enter to open · ⌘K / Ctrl+K anywhere
        </div>
      </div>
    </div>
  );
};

export default CommandPalette;
