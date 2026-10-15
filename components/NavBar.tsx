import React, { useState } from 'react';
import {
  LayoutGrid, CandlestickChart, Mountain, Droplets, Eye, Layers, Activity,
  Crosshair, Zap, Globe2, Bot, Settings, BarChart2, Radio,
  BookOpen, Hexagon, Menu, X, Compass, Gauge, Landmark,
} from 'lucide-react';
import { AnimatePresence, motion as m } from 'framer-motion';

const motion = m as any;

interface NavBarProps {
  activeTab: string;
  setActiveTab: (tab: string) => void;
}

type NavItem = { id: string; icon: React.ElementType; label: string; hint?: string };
type NavGroup = { title: string; items: NavItem[] };

// Grouped so 18 destinations stay scannable instead of one flat icon wall.
const NAV_GROUPS: NavGroup[] = [
  {
    title: 'Overview',
    items: [
      { id: 'dashboard', icon: LayoutGrid, label: 'Desk', hint: 'Order flow overview' },
      { id: 'charting', icon: CandlestickChart, label: 'Chart', hint: 'Price action' },
    ],
  },
  {
    title: 'Market Structure',
    items: [
      { id: 'depth', icon: Mountain, label: 'Depth', hint: 'Order book depth' },
      { id: 'liquidity', icon: Droplets, label: 'Liquidity', hint: 'Liquidity map' },
      { id: 'dark-pool', icon: Eye, label: 'Dark Pool', hint: 'Hidden flow' },
      { id: 'bias', icon: Layers, label: 'Matrix', hint: 'Bias matrix' },
      { id: 'regime', icon: Activity, label: 'Regime', hint: 'HMM regime state' },
    ],
  },
  {
    title: 'Derivatives',
    items: [
      { id: 'funding', icon: Gauge, label: 'Funding & OI', hint: 'Cross-venue funding, OI, premium' },
    ],
  },
  {
    title: 'Bot',
    items: [
      { id: 'bot-control', icon: Bot, label: 'Bot Control', hint: 'Run / stop the bot' },
      { id: 'ai-tactical', icon: Compass, label: 'Tactical', hint: 'AI tactical scan' },
      { id: 'sentinel', icon: Crosshair, label: 'Sentinel', hint: 'Edge confirmation' },
      { id: 'ulis', icon: Globe2, label: 'ULIS', hint: 'Institutional flow' },
    ],
  },
  {
    title: 'Research',
    items: [
      { id: 'macro', icon: Landmark, label: 'Macro & FX', hint: 'Rates, inflation, dollar, FX' },
      { id: 'macro-strategy', icon: Zap, label: 'Strategy', hint: 'Macro strategy engine' },
      { id: 'intel', icon: Radio, label: 'Intel', hint: 'News & sentiment' },
      { id: 'analytics', icon: BarChart2, label: 'Analytics', hint: 'Performance data' },
    ],
  },
  {
    title: 'System',
    items: [
      { id: 'guide', icon: BookOpen, label: 'Guide', hint: 'How to use' },
      { id: 'settings', icon: Settings, label: 'Settings', hint: 'Preferences' },
    ],
  },
];

const MOBILE_PRIMARY = ['dashboard', 'charting', 'funding', 'bot-control'];
const ALL_ITEMS: NavItem[] = NAV_GROUPS.flatMap(g => g.items);

const NavBar: React.FC<NavBarProps> = ({ activeTab, setActiveTab }) => {
  const [sheetOpen, setSheetOpen] = useState(false);
  const go = (id: string) => { setActiveTab(id); setSheetOpen(false); };
  const primaryItems = MOBILE_PRIMARY.map(id => ALL_ITEMS.find(i => i.id === id)).filter(Boolean) as NavItem[];

  return (
    <>
      {/* ── Desktop sidebar: fixed header, everything else scrolls ────── */}
      <aside className="hidden lg:flex flex-col h-[96vh] my-auto ml-4 w-56 fintech-card z-50 overflow-hidden">
        <div className="flex items-center gap-2.5 px-4 pt-5 pb-4 shrink-0">
          <div className="w-8 h-8 shrink-0 rounded-lg bg-brand-accent/15 flex items-center justify-center text-brand-accent">
            <Hexagon size={17} strokeWidth={2.2} />
          </div>
          <div className="leading-tight">
            <div className="text-[13px] font-bold tracking-[0.16em] text-white">QUANT DESK</div>
            <div className="text-[9px] font-mono text-slate-500">TRADING TERMINAL</div>
          </div>
        </div>

        <nav className="flex-1 overflow-y-auto scrollbar-hide px-2 pb-3">
          {NAV_GROUPS.map(group => (
            <div key={group.title} className="mb-2.5">
              <div className="px-2 pt-2 pb-1 text-[9px] font-semibold uppercase tracking-wider text-slate-600">
                {group.title}
              </div>
              <div className="flex flex-col gap-px">
                {group.items.map(tab => {
                  const isActive = activeTab === tab.id;
                  const Icon = tab.icon;
                  return (
                    <button
                      key={tab.id}
                      onClick={() => go(tab.id)}
                      title={tab.hint}
                      aria-label={tab.label}
                      aria-current={isActive ? 'page' : undefined}
                      className={`group relative flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors
                        ${isActive ? 'bg-brand-accent/15 text-white' : 'text-slate-400 hover:bg-white/5 hover:text-slate-200'}`}
                    >
                      {isActive && <span className="absolute left-0 top-1/2 -translate-y-1/2 h-4 w-[3px] rounded-r bg-brand-accent" />}
                      <Icon size={16} strokeWidth={2} className={isActive ? 'text-brand-accent' : 'shrink-0'} />
                      <span className="truncate text-[12.5px] font-medium">{tab.label}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </nav>
      </aside>

      {/* ── Mobile bottom bar ───────────────────────────────────────── */}
      <div className="lg:hidden fixed bottom-5 left-4 right-4 z-50">
        <div className="fintech-card flex items-center justify-around px-1.5 py-2 shadow-2xl">
          {primaryItems.map(tab => {
            const isActive = activeTab === tab.id;
            const Icon = tab.icon;
            return (
              <button
                key={tab.id}
                onClick={() => go(tab.id)}
                aria-label={tab.label}
                className={`flex flex-col items-center gap-0.5 rounded-xl px-3 py-1.5 transition-colors
                  ${isActive ? 'text-brand-accent' : 'text-slate-400'}`}
              >
                <Icon size={19} strokeWidth={2} />
                <span className="text-[9px] font-semibold tracking-wide">{tab.label}</span>
              </button>
            );
          })}
          <button onClick={() => setSheetOpen(true)} aria-label="More sections"
            className="flex flex-col items-center gap-0.5 rounded-xl px-3 py-1.5 text-slate-400">
            <Menu size={19} strokeWidth={2} />
            <span className="text-[9px] font-semibold tracking-wide">More</span>
          </button>
        </div>
      </div>

      {/* ── Mobile full menu sheet ──────────────────────────────────── */}
      <AnimatePresence>
        {sheetOpen && (
          <motion.div
            key="nav-sheet"
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="lg:hidden fixed inset-0 z-[60] bg-black/70 backdrop-blur-sm"
            onClick={() => setSheetOpen(false)}
          >
            <motion.div
              initial={{ y: '100%' }} animate={{ y: 0 }} exit={{ y: '100%' }}
              transition={{ type: 'spring', damping: 30, stiffness: 300 }}
              onClick={(e: React.MouseEvent) => e.stopPropagation()}
              className="absolute bottom-0 left-0 right-0 max-h-[80vh] overflow-y-auto rounded-t-3xl border-t border-white/10 bg-[#0b0b0d] p-5 pb-8"
            >
              <div className="mb-4 flex items-center justify-between">
                <span className="text-sm font-bold tracking-[0.18em] text-white">ALL SECTIONS</span>
                <button onClick={() => setSheetOpen(false)} aria-label="Close menu"
                  className="rounded-lg p-2 text-slate-400 hover:bg-white/5">
                  <X size={18} />
                </button>
              </div>
              {NAV_GROUPS.map(group => (
                <div key={group.title} className="mb-5">
                  <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-slate-500">{group.title}</div>
                  <div className="grid grid-cols-2 gap-2">
                    {group.items.map(tab => {
                      const isActive = activeTab === tab.id;
                      const Icon = tab.icon;
                      return (
                        <button
                          key={tab.id}
                          onClick={() => go(tab.id)}
                          className={`flex items-center gap-3 rounded-xl border p-3 text-left transition-colors
                            ${isActive ? 'border-brand-accent/40 bg-brand-accent/15 text-white' : 'border-white/5 bg-white/[0.02] text-slate-300 hover:bg-white/5'}`}
                        >
                          <Icon size={17} strokeWidth={2} className={isActive ? 'text-brand-accent' : 'text-slate-400'} />
                          <div className="min-w-0">
                            <div className="truncate text-[13px] font-medium">{tab.label}</div>
                            {tab.hint && <div className="truncate text-[10px] text-slate-500">{tab.hint}</div>}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
};

export default NavBar;
