import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useStore } from '../store';
import { BotSettingsState, BotTrade, BacktestResult, LogEntry } from '../types';
import { ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip } from 'recharts';

const API_BASE = (import.meta as any).env.VITE_API_URL || 'http://localhost:8000';

// ── Design Tokens ────────────────────────────────────────────────────────────

const C = {
  bg: '#05070a',
  surface: 'rgba(15, 18, 35, 0.6)',
  border: 'rgba(255, 255, 255, 0.07)',
  accent: '#7c6cf0',
  cyan: '#60e6ff',
  success: '#10f0a0',
  danger: '#f44771',
  warning: '#ffe566',
  muted: '#636e8b',
  text: '#e0eaff',
  buy: '#10f0a0',
  sell: '#f44771',
};

const VERDICT_COLOUR: Record<string, string> = {
  BUY: C.success, SELL: C.danger, WAIT: C.muted,
  MEAN_REVERSAL_LONG: C.success, MEAN_REVERSAL_SHORT: C.danger,
};

const ULIS_COLOUR: Record<string, string> = {
  STRONG_LONG: C.success, LONG: '#4ec9b0', NEUTRAL: C.muted,
  SHORT: '#ff9966', STRONG_SHORT: C.danger, AVOID: '#ff3355',
  UNWIND: '#ff6644', BREAKOUT_WATCH: C.warning, GATE_DISABLED: '#66aacc',
};

const ulisColor = (v?: string) => ULIS_COLOUR[v ?? ''] ?? C.muted;
const verdictColor = (v?: string) => VERDICT_COLOUR[v ?? ''] ?? C.muted;

const fmt = (n: number) => n.toFixed(2);
const fmtPct = (n: number) => (n >= 0 ? '+' : '') + n.toFixed(2) + '%';
const fmtUSD = (n: number) => (n >= 0 ? '+$' : '-$') + Math.abs(n).toFixed(2);

// ── Sub-components ───────────────────────────────────────────────────────────

const GlassCard: React.FC<{ children: React.ReactNode; style?: React.CSSProperties; glow?: string }> = ({ children, style, glow }) => (
  <div style={{
    background: C.surface,
    backdropFilter: 'blur(16px)',
    WebkitBackdropFilter: 'blur(16px)',
    border: `1px solid ${C.border}`,
    borderRadius: 20,
    padding: 24,
    boxShadow: glow ? `0 10px 40px -10px ${glow}55` : '0 8px 32px 0 rgba(0,0,0,0.37)',
    ...style
  }}>
    {children}
  </div>
);

const StatCard: React.FC<{ label: string; value: React.ReactNode; sub?: string; color?: string; accent?: string }> = ({ label, value, sub, color = C.text, accent }) => (
  <div style={{
    background: accent ? `linear-gradient(135deg, ${accent}12, rgba(0,0,0,0))` : 'rgba(255,255,255,0.025)',
    border: `1px solid ${accent ? accent + '30' : 'rgba(255,255,255,0.05)'}`,
    borderRadius: 16, padding: '20px', flex: 1, minWidth: 150,
    transition: 'transform 0.2s',
  }}>
    <div style={{ color: C.muted, fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 1.5, marginBottom: 8 }}>{label}</div>
    <div style={{ color, fontSize: 22, fontWeight: 800, letterSpacing: -0.5 }}>{value}</div>
    {sub && <div style={{ color: 'rgba(255,255,255,0.25)', fontSize: 11, marginTop: 6 }}>{sub}</div>}
  </div>
);

const TabBtn: React.FC<{ label: string; active: boolean; onClick: () => void; icon: string; badge?: number }> = ({ label, active, onClick, icon, badge }) => (
  <button onClick={onClick} style={{
    background: active ? `linear-gradient(135deg, ${C.accent}22, ${C.cyan}11)` : 'transparent',
    border: active ? `1px solid ${C.accent}44` : '1px solid transparent',
    borderRadius: 12, color: active ? C.text : C.muted, padding: '10px 20px',
    cursor: 'pointer', fontSize: 14, fontWeight: 600,
    transition: 'all 0.3s', display: 'flex', alignItems: 'center', gap: 8, outline: 'none', position: 'relative',
  }}>
    <span style={{ fontSize: 16, filter: active ? 'none' : 'grayscale(100%) opacity(0.5)' }}>{icon}</span>
    {label}
    {badge !== undefined && badge > 0 && (
      <span style={{ background: C.accent, color: '#fff', borderRadius: 10, fontSize: 9, fontWeight: 900, padding: '2px 6px', marginLeft: 4 }}>{badge}</span>
    )}
  </button>
);

const FIELD_STYLE: React.CSSProperties = {
  width: '100%', background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)',
  borderRadius: 12, color: C.text, padding: '12px 16px', fontSize: 14, outline: 'none',
  boxSizing: 'border-box', fontFamily: "'Fira Code', monospace", transition: 'border-color 0.2s',
};

const InputField: React.FC<{
  label: string; value: string; placeholder?: string; type?: string;
  rows?: number; hint?: string; onChange: (v: string) => void;
}> = ({ label, value, placeholder, type = 'text', rows, hint, onChange }) => (
  <div style={{ marginBottom: 20 }}>
    <label style={{ display: 'block', color: C.muted, fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 8 }}>{label}</label>
    {rows ? (
      <textarea value={value} placeholder={placeholder} rows={rows} onChange={e => onChange(e.target.value)} style={FIELD_STYLE as any} />
    ) : (
      <input type={type} value={value} placeholder={placeholder} onChange={e => onChange(e.target.value)} style={FIELD_STYLE as any} />
    )}
    {hint && <p style={{ color: 'rgba(255,255,255,0.2)', fontSize: 10, marginTop: 6 }}>{hint}</p>}
  </div>
);

const PulseDot: React.FC<{ color: string; size?: number }> = ({ color, size = 10 }) => (
  <span style={{ display: 'inline-block', width: size, height: size, borderRadius: '50%', background: color, boxShadow: `0 0 12px ${color}`, flexShrink: 0, animation: 'pulse 2s ease-in-out infinite' }} />
);

// ── Trade Card (for mobile-friendly history) ─────────────────────────────────

const TradeRow: React.FC<{ trade: BotTrade }> = ({ trade: t }) => {
  const isOpen = t.exit_price === undefined || t.exit_price === null;
  const pnlNum = t.pnl ?? 0;
  const win = pnlNum > 0;
  const pnlColor = isOpen ? C.warning : (win ? C.success : C.danger);
  const sideColor = t.side === 'buy' ? C.buy : C.sell;

  return (
    <tr style={{ borderBottom: `1px solid ${C.border}`, transition: 'background 0.2s' }}
      onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.02)')}
      onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
    >
      {/* Time */}
      <td style={{ padding: '16px 20px', fontSize: 11, color: C.muted, whiteSpace: 'nowrap', fontFamily: "'Fira Code', monospace" }}>
        {new Date(t.ts_ms).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })}
      </td>
      {/* Asset */}
      <td style={{ padding: '16px 20px', fontSize: 13, fontWeight: 700 }}>{t.symbol ?? '—'}</td>
      {/* Side */}
      <td style={{ padding: '16px 20px' }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, background: `${sideColor}18`, padding: '4px 12px', borderRadius: 8, fontSize: 11, fontWeight: 900, color: sideColor, border: `1px solid ${sideColor}30` }}>
          {t.side === 'buy' ? '▲' : '▼'} {t.side?.toUpperCase() ?? '—'}
        </span>
      </td>
      {/* Entry */}
      <td style={{ padding: '16px 20px', fontSize: 12, fontFamily: "'Fira Code', monospace" }}>${fmt(t.entry_price)}</td>
      {/* Exit */}
      <td style={{ padding: '16px 20px', fontSize: 12, fontFamily: "'Fira Code', monospace", color: isOpen ? C.warning : C.text }}>
        {isOpen ? <span style={{ animation: 'pulse 1.5s ease-in-out infinite', display: 'inline-block' }}>OPEN ●</span> : `$${fmt(t.exit_price!)}`}
      </td>
      {/* PnL */}
      <td style={{ padding: '16px 20px' }}>
        {isOpen ? (
          <span style={{ color: C.warning, fontSize: 12, fontWeight: 700 }}>Pending…</span>
        ) : (
          <span style={{ color: pnlColor, fontWeight: 800, fontSize: 13, filter: `drop-shadow(0 0 8px ${pnlColor}44)`, fontFamily: "'Fira Code', monospace" }}>
            {fmtUSD(pnlNum)}
          </span>
        )}
      </td>
      {/* Result */}
      <td style={{ padding: '16px 20px' }}>
        {isOpen ? (
          <span style={{ fontSize: 9, fontWeight: 900, background: `${C.warning}22`, color: C.warning, padding: '4px 10px', borderRadius: 6, border: `1px solid ${C.warning}44` }}>LIVE</span>
        ) : (
          <span style={{ fontSize: 9, fontWeight: 900, background: `${pnlColor}22`, color: pnlColor, padding: '4px 10px', borderRadius: 6, border: `1px solid ${pnlColor}44` }}>
            {win ? '✓ WIN' : '✗ LOSS'}
          </span>
        )}
      </td>
      {/* Mode */}
      <td style={{ padding: '16px 20px' }}>
        <span style={{ fontSize: 9, fontWeight: 700, color: t.mode === 'LIVE' ? C.danger : C.muted, background: t.mode === 'LIVE' ? `${C.danger}18` : 'rgba(255,255,255,0.05)', padding: '3px 8px', borderRadius: 5 }}>
          {t.mode ?? '—'}
        </span>
      </td>
    </tr>
  );
};

// ── Tabs ─────────────────────────────────────────────────────────────────────

const TABS = [
  { id: 'live',     icon: '📡', label: 'Live Monitor' },
  { id: 'history',  icon: '📊', label: 'Trade History' },
  { id: 'exchange', icon: '⚡', label: 'Exchange' },
  { id: 'strategy', icon: '🧠', label: 'Strategy' },
  { id: 'backtest', icon: '🧪', label: 'Analytics' },
  { id: 'terminal', icon: '📟', label: 'Console' },
] as const;

type TabId = typeof TABS[number]['id'];

// ── Main Component ────────────────────────────────────────────────────────────

const AdminBotControl: React.FC = () => {
  const { botSettings, setBotSettings, botTrades, subscribeToBotTrades, botLogs, subscribeToBotLogs, subscribeToBotStatus } = useStore();
  const [tab, setTab] = useState<TabId>('history');
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState('');
  const unsubRef = useRef<(() => void) | null>(null);

  const [btSymbol, setBtSymbol] = useState('BTCUSDT');
  const [btInterval, setBtInterval] = useState('15m');
  const [btFrom, setBtFrom] = useState('2025-01-01');
  const [btTo, setBtTo] = useState('2025-03-01');
  const [btRunning, setBtRunning] = useState(false);
  const [btResult, setBtResult] = useState<BacktestResult | null>(null);
  const [btError, setBtError] = useState('');
  const [btPage, setBtPage] = useState(0);
  const BT_PAGE_SIZE = 15;

  const [hbAge, setHbAge] = useState<string>('—');

  useEffect(() => {
    unsubRef.current = subscribeToBotTrades();
    const unsubLogs = subscribeToBotLogs();
    const unsubStatus = subscribeToBotStatus();
    return () => { unsubRef.current?.(); unsubLogs(); unsubStatus(); };
  }, [subscribeToBotTrades, subscribeToBotLogs, subscribeToBotStatus]);

  useEffect(() => {
    const id = setInterval(() => {
      if (botSettings.lastHeartbeat) {
        const secs = Math.floor((Date.now() - botSettings.lastHeartbeat) / 1000);
        setHbAge(secs < 60 ? `${secs}s ago` : `${Math.floor(secs / 60)}m ago`);
      } else {
        setHbAge('Offline');
      }
    }, 1000);
    return () => clearInterval(id);
  }, [botSettings.lastHeartbeat]);

  const update = useCallback((patch: Partial<BotSettingsState>) => setBotSettings(patch), [setBotSettings]);

  const saveSettings = () => {
    setSaving(true);
    setTimeout(() => { setSaving(false); setSaveMsg('Configuration Synchronized ✓'); setTimeout(() => setSaveMsg(''), 3000); }, 800);
  };

  const runBacktest = async () => {
    setBtRunning(true); setBtError(''); setBtResult(null); setBtPage(0);
    try {
      const resp = await fetch(`${API_BASE}/backtest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol: btSymbol.toUpperCase(), from_date: btFrom, to_date: btTo, risk_pct: botSettings.maxRiskPerTradePct, min_confidence: botSettings.minConfidence, account_size: botSettings.accountSize, interval: btInterval }),
      });
      if (!resp.ok) throw new Error('Simulation Engine Error');
      setBtResult(await resp.json());
    } catch (e: any) { setBtError(e.message || 'System Failure'); }
    setBtRunning(false);
  };

  // ── Computed trade stats ──────────────────────────────────────────────────
  const closedTrades = botTrades.filter(t => t.exit_price !== undefined && t.exit_price !== null);
  const openTrades   = botTrades.filter(t => t.exit_price === undefined || t.exit_price === null);
  const wins         = closedTrades.filter(t => (t.pnl ?? 0) > 0);
  const losses       = closedTrades.filter(t => (t.pnl ?? 0) <= 0);
  const totalPnl     = closedTrades.reduce((s, t) => s + (t.pnl ?? 0), 0);
  const winRate      = closedTrades.length > 0 ? (wins.length / closedTrades.length) * 100 : 0;
  const avgWin       = wins.length > 0 ? wins.reduce((s, t) => s + (t.pnl ?? 0), 0) / wins.length : 0;
  const avgLoss      = losses.length > 0 ? losses.reduce((s, t) => s + (t.pnl ?? 0), 0) / losses.length : 0;

  const equityCurveData = btResult?.equity_curve?.map((eq, i) => ({ i, equity: eq })) ?? [];
  const btTradeList = btResult?.trades ?? [];
  const pagedTrades = btTradeList.slice(btPage * BT_PAGE_SIZE, (btPage + 1) * BT_PAGE_SIZE);
  const totalPages = Math.ceil(btTradeList.length / BT_PAGE_SIZE);
  const bStats = btResult?.stats;

  const isOnline = botSettings.status === 'ONLINE';

  return (
    <div style={{ fontFamily: "'Inter', sans-serif", color: C.text, height: '100%', overflowY: 'auto', background: C.bg, padding: '36px 32px', scrollBehavior: 'smooth' }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=Fira+Code:wght@400;500&display=swap');
        @keyframes pulse { 0%,100%{opacity:1;box-shadow:0 0 8px currentColor} 50%{opacity:0.5;box-shadow:0 0 20px currentColor} }
        @keyframes spin  { to{transform:rotate(360deg)} }
        @keyframes slideUp { from{opacity:0;transform:translateY(16px)} to{opacity:1;transform:translateY(0)} }
        @keyframes blink { 0%,80%{opacity:1} 90%{opacity:0.2} 100%{opacity:1} }
        ::-webkit-scrollbar { width:5px; }
        ::-webkit-scrollbar-track { background:transparent; }
        ::-webkit-scrollbar-thumb { background:rgba(255,255,255,0.08); border-radius:10px; }
        .tab-content { animation: slideUp 0.35s cubic-bezier(0.4,0,0.2,1); }
        tr:hover td { background: rgba(255,255,255,0.02); }
      `}</style>

      {/* ── Header ── */}
      <div style={{ marginBottom: 32, display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', flexWrap: 'wrap', gap: 16 }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 6 }}>
            <PulseDot color={isOnline ? C.success : C.muted} size={12} />
            <h1 style={{ margin: 0, fontSize: 28, fontWeight: 800, letterSpacing: -1, background: `linear-gradient(135deg, #fff 0%, ${C.accent} 100%)`, WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>
              Quad-Desk Terminal
            </h1>
          </div>
          <p style={{ color: C.muted, margin: 0, fontSize: 13, fontWeight: 500 }}>
            {isOnline ? `● Bot Online · ${botSettings.botMode ?? 'DRY-RUN'} · ${(botSettings.exchange ?? 'BINANCE').toUpperCase()}` : '● Bot Offline — Firebase Not Connected'}
          </p>
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <div style={{ fontSize: 11, color: C.muted, textAlign: 'right' }}>
            <div>Last Heartbeat</div>
            <div style={{ color: isOnline ? C.success : C.danger, fontWeight: 700 }}>{hbAge}</div>
          </div>
        </div>
      </div>

      {/* ── Live Market Pulse Bar ── */}
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 32 }}>
        <StatCard label="Engine Status" accent={isOnline ? C.success : C.muted}
          value={<span style={{ display: 'flex', alignItems: 'center', gap: 8 }}><PulseDot color={isOnline ? C.success : C.muted} />{botSettings.status ?? 'OFFLINE'}</span>}
          sub={`${botSettings.botMode ?? 'DRY-RUN'} · ${(botSettings.exchange ?? 'Binance').toUpperCase()}`}
          color={isOnline ? C.success : C.muted}
        />
        <StatCard label="Last Signal" value={botSettings.lastSignal ?? 'WAIT'}
          sub="Bayesian Verdict" color={verdictColor(botSettings.lastSignal)} accent={verdictColor(botSettings.lastSignal)}
        />
        <StatCard label="ULIS Gate" value={botSettings.lastUlis ?? '—'}
          sub={botSettings.ulisGateEnabled ? 'Noise Filter Active' : 'Gate Disabled'} color={ulisColor(botSettings.lastUlis)}
        />
        <StatCard label="Session PnL" accent={totalPnl >= 0 ? C.success : C.danger}
          value={<span style={{ color: totalPnl >= 0 ? C.success : C.danger }}>{fmtUSD(totalPnl)}</span>}
          sub={`${closedTrades.length} trades · ${winRate.toFixed(0)}% win rate`}
        />
        <StatCard label="Open Positions" accent={openTrades.length > 0 ? C.warning : undefined}
          value={openTrades.length}
          sub={openTrades.length > 0 ? `${openTrades.map(t => t.symbol).join(', ')}` : 'No open trades'} color={openTrades.length > 0 ? C.warning : C.muted}
        />
      </div>

      {/* ── Navigation ── */}
      <GlassCard style={{ padding: 8, marginBottom: 32, borderRadius: 16 }}>
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
          {TABS.map(t => (
            <TabBtn key={t.id} icon={t.icon} label={t.label} active={tab === t.id} onClick={() => setTab(t.id)}
              badge={t.id === 'history' ? openTrades.length : undefined}
            />
          ))}
        </div>
      </GlassCard>

      <div className="tab-content">

        {/* ══════════════════════════════════════ */}
        {/* LIVE MONITOR                           */}
        {/* ══════════════════════════════════════ */}
        {tab === 'live' && (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24, maxWidth: 1100 }}>
            <GlassCard glow={C.accent}>
              <h3 style={{ margin: '0 0 20px', fontSize: 16, fontWeight: 700 }}>📡 Live Engine Output</h3>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                {[
                  { label: 'Symbol', value: botSettings.tradingPair ?? 'BTCUSDT' },
                  { label: 'Mode', value: botSettings.botMode ?? '—', color: botSettings.botMode === 'LIVE' ? C.danger : C.warning },
                  { label: 'Exchange', value: (botSettings.exchange ?? 'Binance').toUpperCase() },
                  { label: 'Last Signal', value: botSettings.lastSignal ?? 'WAIT', color: verdictColor(botSettings.lastSignal) },
                  { label: 'ULIS Verdict', value: botSettings.lastUlis ?? '—', color: ulisColor(botSettings.lastUlis) },
                  { label: 'Active Positions', value: String(botSettings.activePositions ?? 0), color: botSettings.activePositions ? C.warning : C.muted },
                  { label: 'Total Trades', value: String(botSettings.totalTrades ?? 0) },
                  { label: 'Heartbeat Age', value: hbAge, color: isOnline ? C.success : C.danger },
                ].map(row => (
                  <div key={row.label} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 16px', background: 'rgba(255,255,255,0.02)', borderRadius: 10, border: '1px solid rgba(255,255,255,0.04)' }}>
                    <span style={{ color: C.muted, fontSize: 12, fontWeight: 600 }}>{row.label}</span>
                    <span style={{ color: row.color ?? C.text, fontFamily: "'Fira Code', monospace", fontSize: 13, fontWeight: 700 }}>{row.value}</span>
                  </div>
                ))}
              </div>
            </GlassCard>

            <GlassCard>
              <h3 style={{ margin: '0 0 20px', fontSize: 16, fontWeight: 700 }}>⚡ Session Summary</h3>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
                {[
                  { label: 'Total Trades', value: String(closedTrades.length), color: C.cyan },
                  { label: 'Win Rate', value: `${winRate.toFixed(1)}%`, color: winRate > 50 ? C.success : C.danger },
                  { label: 'Wins', value: String(wins.length), color: C.success },
                  { label: 'Losses', value: String(losses.length), color: C.danger },
                  { label: 'Avg Win', value: `$${avgWin.toFixed(2)}`, color: C.success },
                  { label: 'Avg Loss', value: `$${Math.abs(avgLoss).toFixed(2)}`, color: C.danger },
                  { label: 'Net PnL', value: fmtUSD(totalPnl), color: totalPnl >= 0 ? C.success : C.danger },
                  { label: 'Open Trades', value: String(openTrades.length), color: openTrades.length > 0 ? C.warning : C.muted },
                ].map(item => (
                  <div key={item.label} style={{ background: 'rgba(255,255,255,0.02)', borderRadius: 12, padding: 16, border: '1px solid rgba(255,255,255,0.04)' }}>
                    <div style={{ fontSize: 10, color: C.muted, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 1.2, marginBottom: 6 }}>{item.label}</div>
                    <div style={{ fontSize: 20, fontWeight: 800, color: item.color }}>{item.value}</div>
                  </div>
                ))}
              </div>

              {closedTrades.length > 0 && (
                <div style={{ marginTop: 20 }}>
                  <div style={{ fontSize: 11, color: C.muted, marginBottom: 8, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 1 }}>Win / Loss Distribution</div>
                  <div style={{ display: 'flex', height: 10, borderRadius: 10, overflow: 'hidden', gap: 2 }}>
                    <div style={{ flex: wins.length, background: C.success, transition: 'flex 0.5s' }} />
                    <div style={{ flex: losses.length, background: C.danger }} />
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 6, fontSize: 11, color: C.muted }}>
                    <span style={{ color: C.success }}>{wins.length} wins</span>
                    <span style={{ color: C.danger }}>{losses.length} losses</span>
                  </div>
                </div>
              )}
            </GlassCard>
          </div>
        )}

        {/* ══════════════════════════════════════ */}
        {/* TRADE HISTORY                          */}
        {/* ══════════════════════════════════════ */}
        {tab === 'history' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>

            {/* Summary bar */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 16 }}>
              <StatCard label="Total Trades"  value={closedTrades.length} sub="Closed" color={C.cyan} />
              <StatCard label="Win Rate"      value={`${winRate.toFixed(1)}%`} sub={`${wins.length}W / ${losses.length}L`} color={winRate >= 50 ? C.success : C.danger} accent={winRate >= 50 ? C.success : C.danger} />
              <StatCard label="Net PnL"       value={fmtUSD(totalPnl)} sub="After fees" color={totalPnl >= 0 ? C.success : C.danger} accent={totalPnl >= 0 ? C.success : C.danger} />
              <StatCard label="Avg Win"       value={`$${avgWin.toFixed(2)}`} sub="Per winner" color={C.success} />
              <StatCard label="Open"          value={openTrades.length} sub="Positions active" color={openTrades.length > 0 ? C.warning : C.muted} accent={openTrades.length > 0 ? C.warning : undefined} />
            </div>

            {/* Win/Loss progress bar */}
            {closedTrades.length > 0 && (
              <GlassCard style={{ padding: '20px 28px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 12 }}>
                  <span style={{ fontSize: 13, fontWeight: 700, color: C.text }}>Win / Loss Ratio</span>
                  <span style={{ fontSize: 13, fontWeight: 700, color: winRate >= 50 ? C.success : C.danger }}>{winRate.toFixed(1)}%</span>
                </div>
                <div style={{ display: 'flex', height: 14, borderRadius: 14, overflow: 'hidden', background: 'rgba(255,255,255,0.05)', gap: 2 }}>
                  <div style={{ flex: wins.length || 0.01, background: `linear-gradient(90deg, ${C.success}, #00ff99)`, transition: 'flex 0.8s cubic-bezier(0.4,0,0.2,1)', boxShadow: `0 0 16px ${C.success}66` }} />
                  <div style={{ flex: losses.length || 0.01, background: `linear-gradient(90deg, #ff2255, ${C.danger})` }} />
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 8, fontSize: 11, color: C.muted }}>
                  <span style={{ color: C.success }}>✓ {wins.length} Wins · Avg +${avgWin.toFixed(2)}</span>
                  <span style={{ color: C.danger }}>✗ {losses.length} Losses · Avg -${Math.abs(avgLoss).toFixed(2)}</span>
                </div>
              </GlassCard>
            )}

            {/* Ledger table */}
            <GlassCard style={{ padding: 0, overflow: 'hidden' }}>
              <div style={{ padding: '20px 24px', borderBottom: `1px solid ${C.border}`, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div>
                  <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>📜 Transactional Ledger</h3>
                  <p style={{ margin: '4px 0 0', color: C.muted, fontSize: 12 }}>{botTrades.length} trades recorded · sorted newest first</p>
                </div>
                {openTrades.length > 0 && (
                  <span style={{ display: 'flex', alignItems: 'center', gap: 8, background: `${C.warning}18`, border: `1px solid ${C.warning}44`, padding: '6px 14px', borderRadius: 10, fontSize: 12, fontWeight: 700, color: C.warning }}>
                    <span style={{ animation: 'blink 1.2s infinite' }}>●</span> {openTrades.length} OPEN
                  </span>
                )}
              </div>

              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left' }}>
                  <thead>
                    <tr style={{ background: 'rgba(255,255,255,0.02)' }}>
                      {['TIME', 'ASSET', 'SIDE', 'ENTRY', 'EXIT', 'NET PnL', 'RESULT', 'MODE'].map(h => (
                        <th key={h} style={{ padding: '14px 20px', fontSize: 9, fontWeight: 800, color: C.muted, letterSpacing: 1.5, whiteSpace: 'nowrap', textTransform: 'uppercase' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {botTrades.length === 0 ? (
                      <tr><td colSpan={8} style={{ padding: 80, textAlign: 'center', color: C.muted, fontSize: 14 }}>
                        <div style={{ fontSize: 40, marginBottom: 16 }}>📭</div>
                        <div style={{ fontWeight: 600 }}>No trades recorded yet</div>
                        <div style={{ fontSize: 12, marginTop: 8, opacity: 0.6 }}>The bot is waiting for a high-confidence signal (&gt;70%) to enter</div>
                      </td></tr>
                    ) : [...botTrades].sort((a, b) => b.ts_ms - a.ts_ms).map(t => (
                      <TradeRow key={t.id} trade={t} />
                    ))}
                  </tbody>
                </table>
              </div>
            </GlassCard>
          </div>
        )}

        {/* ══════════════════════════════════════ */}
        {/* EXCHANGE SETTINGS                      */}
        {/* ══════════════════════════════════════ */}
        {tab === 'exchange' && (
          <div style={{ maxWidth: 800 }}>
            <GlassCard>
              <h2 style={{ fontSize: 20, fontWeight: 700, margin: '0 0 24px' }}>Broker Connectivity</h2>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24, marginBottom: 24 }}>
                <div>
                  <label style={{ color: C.muted, fontSize: 11, fontWeight: 700, textTransform: 'uppercase', marginBottom: 8, display: 'block', letterSpacing: 1 }}>Primary Exchange</label>
                  <div style={{ display: 'flex', gap: 12 }}>
                    {(['coinbase', 'binance'] as const).map(ex => (
                      <button key={ex} onClick={() => update({ exchange: ex, tradingPair: ex === 'coinbase' ? 'BTC-USD' : 'BTCUSDT' })} style={{ flex: 1, padding: '16px', borderRadius: 14, cursor: 'pointer', fontSize: 13, fontWeight: 600, background: botSettings.exchange === ex ? `${C.accent}22` : 'rgba(255,255,255,0.03)', border: `1px solid ${botSettings.exchange === ex ? C.accent : 'rgba(255,255,255,0.06)'}`, color: botSettings.exchange === ex ? C.text : C.muted, transition: 'all 0.2s' }}>
                        {ex.toUpperCase()}
                      </button>
                    ))}
                  </div>
                </div>
                <div>
                  <label style={{ color: C.muted, fontSize: 11, fontWeight: 700, textTransform: 'uppercase', marginBottom: 8, display: 'block', letterSpacing: 1 }}>Risk Environment</label>
                  <div style={{ display: 'flex', gap: 12 }}>
                    {(['live', 'testnet'] as const).map(env => (
                      <button key={env} onClick={() => update({ environment: env })} style={{ flex: 1, padding: '16px', borderRadius: 14, cursor: 'pointer', fontSize: 13, fontWeight: 600, background: botSettings.environment === env ? (env === 'live' ? `${C.danger}22` : `${C.success}22`) : 'rgba(255,255,255,0.03)', border: `1px solid ${botSettings.environment === env ? (env === 'live' ? C.danger : C.success) : 'rgba(255,255,255,0.06)'}`, color: botSettings.environment === env ? (env === 'live' ? C.danger : C.success) : C.muted, transition: 'all 0.2s' }}>
                        {env.toUpperCase()}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
              <div style={{ background: 'rgba(255,255,255,0.03)', padding: 20, borderRadius: 16, marginBottom: 24, border: '1px solid rgba(255,255,255,0.05)' }}>
                <InputField label="Asset Symbol" value={botSettings.tradingPair} onChange={v => update({ tradingPair: v })} />
                <InputField label="Operational Capital (USDT)" value={String(botSettings.accountSize)} type="number" onChange={v => update({ accountSize: Number(v) })} />
              </div>
              <button onClick={saveSettings} disabled={saving} style={{ width: '100%', padding: '18px', borderRadius: 14, cursor: saving ? 'wait' : 'pointer', background: `linear-gradient(135deg, ${C.accent}, ${C.cyan})`, border: 'none', color: '#fff', fontSize: 15, fontWeight: 800, boxShadow: `0 8px 24px -6px ${C.accent}66` }}>
                {saving ? 'Synchronizing...' : 'Initialize Configuration'}
              </button>
              {saveMsg && <p style={{ color: C.success, fontSize: 12, textAlign: 'center', marginTop: 12, fontWeight: 600 }}>{saveMsg}</p>}
            </GlassCard>
          </div>
        )}

        {/* ══════════════════════════════════════ */}
        {/* STRATEGY SETTINGS                      */}
        {/* ══════════════════════════════════════ */}
        {tab === 'strategy' && (
          <div style={{ maxWidth: 900 }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'minmax(400px, 1fr) 300px', gap: 24 }}>
              <GlassCard>
                <h2 style={{ fontSize: 20, fontWeight: 700, margin: '0 0 24px' }}>Risk Architecture</h2>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24 }}>
                  <InputField label="Max Risk %" value={String(botSettings.maxRiskPerTradePct)} onChange={v => update({ maxRiskPerTradePct: Number(v) })} />
                  <InputField label="Target Confidence %" value={String(Math.round((botSettings.minConfidence ?? 0.7) * 100))} onChange={v => update({ minConfidence: Number(v) / 100 })} />
                  <InputField label="Analysis Frequency (s)" value={String(botSettings.analysisIntervalSec)} onChange={v => update({ analysisIntervalSec: Number(v) })} />
                  <InputField label="Daily Loss Cap %" value={String(botSettings.maxDailyLossPct)} onChange={v => update({ maxDailyLossPct: Number(v) })} />
                </div>
                <div style={{ margin: '24px 0', padding: '20px', background: 'rgba(255,255,255,0.02)', borderRadius: 16, border: '1px solid rgba(255,255,255,0.05)' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div>
                      <h4 style={{ margin: 0, fontSize: 15, color: C.text }}>Neural Final Gate (ULIS)</h4>
                      <p style={{ margin: '4px 0 0', fontSize: 11, color: C.muted }}>Vetoes high-noise signals automatically</p>
                    </div>
                    <div onClick={() => update({ ulisGateEnabled: !botSettings.ulisGateEnabled })} style={{ width: 50, height: 26, borderRadius: 13, cursor: 'pointer', background: botSettings.ulisGateEnabled ? C.accent : '#1a1d2e', position: 'relative', transition: 'all 0.3s' }}>
                      <div style={{ position: 'absolute', top: 3, left: botSettings.ulisGateEnabled ? 27 : 3, width: 20, height: 20, borderRadius: '50%', background: '#fff', transition: 'all 0.3s' }} />
                    </div>
                  </div>
                </div>
                <button onClick={saveSettings} style={{ width: '100%', padding: '16px', borderRadius: 12, background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', color: C.cyan, fontWeight: 700, cursor: 'pointer' }}>Commit Changes</button>
              </GlassCard>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
                <GlassCard style={{ padding: 20 }}>
                  <h4 style={{ margin: '0 0 12px', fontSize: 13, color: C.muted }}>Max Loss Per Trade</h4>
                  <div style={{ fontSize: 28, fontWeight: 800, color: C.danger }}>${((botSettings.accountSize ?? 100) * (botSettings.maxRiskPerTradePct ?? 1) / 100).toFixed(2)}</div>
                  <p style={{ fontSize: 11, color: C.muted, margin: '4px 0 0' }}>Est. max stop-loss drawdown</p>
                </GlassCard>
                <GlassCard style={{ padding: 20, borderTop: `4px solid ${C.accent}` }}>
                  <h4 style={{ margin: '0 0 12px', fontSize: 13, color: C.muted }}>Signal Threshold</h4>
                  <div style={{ fontSize: 28, fontWeight: 800 }}>{Math.round((botSettings.minConfidence ?? 0.70) * 100)}%</div>
                  <p style={{ fontSize: 11, color: C.muted, margin: '4px 0 0' }}>Bayesian P(edge) required</p>
                </GlassCard>
              </div>
            </div>
          </div>
        )}

        {/* ══════════════════════════════════════ */}
        {/* BACKTEST & ANALYTICS                   */}
        {/* ══════════════════════════════════════ */}
        {tab === 'backtest' && (
          <div>
            <div style={{ display: 'grid', gridTemplateColumns: '320px 1fr', gap: 24 }}>
              <GlassCard>
                <h2 style={{ fontSize: 18, fontWeight: 700, margin: '0 0 20px' }}>Simulation Parameters</h2>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                  <InputField label="Asset" value={btSymbol} onChange={setBtSymbol} />
                  <InputField label="Interval" value={btInterval} onChange={setBtInterval} />
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                    <InputField type="date" label="Start" value={btFrom} onChange={setBtFrom} />
                    <InputField type="date" label="End" value={btTo} onChange={setBtTo} />
                  </div>
                  <button onClick={runBacktest} disabled={btRunning} style={{ marginTop: 12, padding: '16px', borderRadius: 12, background: C.accent, border: 'none', color: '#fff', fontWeight: 800, cursor: btRunning ? 'wait' : 'pointer' }}>
                    {btRunning ? '⟳ Computing...' : '▶ Launch Simulation'}
                  </button>
                </div>
              </GlassCard>

              {btResult ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 16 }}>
                    <StatCard label="Win Rate" value={`${bStats?.winRate}%`} color={C.success} />
                    <StatCard label="Total PnL" value={`${bStats?.totalReturn}%`} color={(bStats?.totalReturn ?? 0) > 0 ? C.success : C.danger} />
                    <StatCard label="Drawdown" value={`${bStats?.maxDrawdown}%`} color={C.warning} />
                    <StatCard label="Sharpe" value={bStats?.sharpe ?? '0'} color={C.cyan} />
                  </div>
                  <GlassCard style={{ height: 300 }}>
                    <ResponsiveContainer width="100%" height="100%">
                      <AreaChart data={equityCurveData}>
                        <defs>
                          <linearGradient id="colorEquity" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="5%" stopColor={C.accent} stopOpacity={0.3} />
                            <stop offset="95%" stopColor={C.accent} stopOpacity={0} />
                          </linearGradient>
                        </defs>
                        <XAxis dataKey="i" hide />
                        <YAxis domain={['auto', 'auto']} tick={{ fill: C.muted, fontSize: 10 }} />
                        <Tooltip contentStyle={{ background: '#0d0f1a', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 12 }} />
                        <Area type="monotone" dataKey="equity" stroke={C.accent} fillOpacity={1} fill="url(#colorEquity)" strokeWidth={3} />
                      </AreaChart>
                    </ResponsiveContainer>
                  </GlassCard>
                  {btTradeList.length > 0 && (
                    <GlassCard style={{ padding: '20px 0' }}>
                      <div style={{ padding: '0 24px 16px', borderBottom: `1px solid ${C.border}`, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <h3 style={{ margin: 0, fontSize: 14, fontWeight: 700 }}>Simulation Ledger</h3>
                        <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                          <button onClick={() => setBtPage(p => Math.max(0, p - 1))} style={{ background: 'none', border: 'none', color: C.muted, cursor: 'pointer' }}>← Prev</button>
                          <span style={{ fontSize: 10, color: C.muted }}>Page {btPage + 1} / {totalPages}</span>
                          <button onClick={() => setBtPage(p => Math.min(totalPages - 1, p + 1))} style={{ background: 'none', border: 'none', color: C.muted, cursor: 'pointer' }}>Next →</button>
                        </div>
                      </div>
                      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                        <thead><tr style={{ background: 'rgba(255,255,255,0.01)' }}>
                          {['DATE', 'ENTRY', 'EXIT', 'PNL', 'RESULT'].map(h => (
                            <th key={h} style={{ padding: '12px 24px', fontSize: 9, color: C.muted, textAlign: 'left', letterSpacing: 1 }}>{h}</th>
                          ))}
                        </tr></thead>
                        <tbody>
                          {pagedTrades.map((t, i) => (
                            <tr key={i} style={{ borderBottom: '1px solid rgba(255,255,255,0.03)' }}>
                              <td style={{ padding: '12px 24px', fontSize: 11, color: C.muted }}>{t.date}</td>
                              <td style={{ padding: '12px 24px', fontSize: 11, fontFamily: "'Fira Code', monospace" }}>${t.entry.toFixed(2)}</td>
                              <td style={{ padding: '12px 24px', fontSize: 11, fontFamily: "'Fira Code', monospace" }}>${t.exit_price.toFixed(2)}</td>
                              <td style={{ padding: '12px 24px', fontSize: 11, color: t.pnl > 0 ? C.success : C.danger, fontWeight: 700 }}>{t.pnl > 0 ? '+' : ''}{t.pnl.toFixed(2)}%</td>
                              <td style={{ padding: '12px 24px' }}><span style={{ fontSize: 9, fontWeight: 900, color: t.result === 'WIN' ? C.success : C.danger }}>{t.result}</span></td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </GlassCard>
                  )}
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: 400, background: 'rgba(255,255,255,0.01)', borderRadius: 20, border: '1px dashed rgba(255,255,255,0.06)', gap: 16 }}>
                  {btError ? (
                    <p style={{ color: C.danger, background: `${C.danger}11`, padding: '12px 24px', borderRadius: 12, border: `1px solid ${C.danger}33` }}>{btError}</p>
                  ) : (
                    <>
                      <div style={{ fontSize: 48 }}>🧪</div>
                      <p style={{ color: C.muted, margin: 0 }}>Configure parameters and launch a simulation</p>
                    </>
                  )}
                </div>
              )}
            </div>
          </div>
        )}

        {/* ══════════════════════════════════════ */}
        {/* CONSOLE TERMINAL                       */}
        {/* ══════════════════════════════════════ */}
        {tab === 'terminal' && (
          <GlassCard style={{ padding: 0, overflow: 'hidden', background: '#05070a', border: `1px solid ${C.accent}33` }}>
            <div style={{ padding: '12px 20px', background: 'rgba(255,255,255,0.03)', borderBottom: `1px solid ${C.border}`, display: 'flex', alignItems: 'center', gap: 8 }}>
              <div style={{ width: 12, height: 12, borderRadius: '50%', background: '#ff5f56' }} />
              <div style={{ width: 12, height: 12, borderRadius: '50%', background: '#ffbd2e' }} />
              <div style={{ width: 12, height: 12, borderRadius: '50%', background: '#27c93f' }} />
              <span style={{ marginLeft: 12, fontSize: 10, fontWeight: 700, color: C.muted, textTransform: 'uppercase', letterSpacing: 1 }}>Bot Kernel // Standard Out — {botLogs.length} entries</span>
            </div>
            <div style={{ height: 520, padding: 20, overflowY: 'auto', display: 'flex', flexDirection: 'column-reverse', fontFamily: "'Fira Code', monospace", fontSize: 12, lineHeight: 1.7 }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {botLogs.length === 0 ? (
                  <span style={{ color: C.muted }}>No log entries yet. Firebase must be connected for live log streaming.</span>
                ) : botLogs.map((log: any) => (
                  <div key={log.id} style={{ display: 'flex', gap: 12, padding: '4px 8px', borderRadius: 6, background: log.level === 'ERROR' ? `${C.danger}08` : 'transparent' }}>
                    <span style={{ color: C.muted, flexShrink: 0 }}>[{new Date(log.ts_ms).toLocaleTimeString([], { hour12: false })}]</span>
                    <span style={{ fontWeight: 800, flexShrink: 0, color: log.level === 'ERROR' ? C.danger : log.level === 'WARNING' ? C.warning : C.cyan, minWidth: 60 }}>{log.level}</span>
                    <span style={{ color: log.level === 'ERROR' ? '#ff9999' : C.text }}>{log.message}</span>
                  </div>
                ))}
              </div>
            </div>
          </GlassCard>
        )}

      </div>
    </div>
  );
};

export default AdminBotControl;
