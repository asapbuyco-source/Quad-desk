import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useStore } from '../store';
import { BotSettingsState, BacktestResult, BacktestTrade } from '../types';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, ReferenceLine, AreaChart, Area } from 'recharts';

const API_BASE = (import.meta as any).env.VITE_API_URL || 'http://localhost:8000';

// ── Design Tokens ────────────────────────────────────────────────────────────

const COLORS = {
  bg: '#05070a',
  surface: 'rgba(15, 18, 35, 0.6)',
  border: 'rgba(255, 255, 255, 0.08)',
  accent: '#7c6cf0',
  cyan: '#60e6ff',
  success: '#10f0a0',
  danger: '#f44771',
  warning: '#ffe566',
  muted: '#636e8b',
  text: '#e0eaff',
  glass: 'backdrop-filter: blur(16px); -webkit-backdrop-filter: blur(16px);',
};

const VERDICT_COLOUR: Record<string, string> = {
  BUY: COLORS.success, SELL: COLORS.danger, WAIT: COLORS.muted,
  MEAN_REVERSAL_LONG: COLORS.success, MEAN_REVERSAL_SHORT: COLORS.danger,
};

const ULIS_COLOUR: Record<string, string> = {
  STRONG_LONG: COLORS.success, LONG: '#4ec9b0', NEUTRAL: COLORS.muted,
  SHORT: '#ff9966', STRONG_SHORT: COLORS.danger, AVOID: '#ff3355',
  UNWIND: '#ff6644', BREAKOUT_WATCH: COLORS.warning, GATE_DISABLED: '#66aacc',
};

const ulisColor = (v?: string) => ULIS_COLOUR[v ?? ''] ?? COLORS.muted;
const verdictColor = (v?: string) => VERDICT_COLOUR[v ?? ''] ?? COLORS.muted;

// ── Premium UI Components ────────────────────────────────────────────────────

const GlassCard: React.FC<{ children: React.ReactNode; style?: React.CSSProperties; glow?: boolean }> = ({ children, style, glow }) => (
  <div style={{
    background: COLORS.surface,
    backdropFilter: 'blur(16px)',
    WebkitBackdropFilter: 'blur(16px)',
    border: '1px solid rgba(255, 255, 255, 0.06)',
    borderRadius: 20,
    padding: 24,
    boxShadow: glow ? `0 10px 40px -10px ${COLORS.accent}44` : '0 8px 32px 0 rgba(0, 0, 0, 0.37)',
    ...style
  }}>
    {children}
  </div>
);

const StatCard: React.FC<{ label: string; value: string | number | React.ReactNode; sub?: string; color?: string; trend?: string }> =
  ({ label, value, sub, color = COLORS.text, trend }) => (
    <div style={{
      background: 'rgba(255,255,255,0.025)',
      border: '1px solid rgba(255,255,255,0.05)',
      borderRadius: 16,
      padding: '20px',
      flex: 1,
      minWidth: 160,
      transition: 'transform 0.2s cubic-bezier(0.4, 0, 0.2, 1)',
      cursor: 'default',
    }}>
      <div style={{ color: COLORS.muted, fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 1.5, marginBottom: 8 }}>{label}</div>
      <div style={{ color, fontSize: 24, fontWeight: 800, letterSpacing: -0.5, display: 'flex', alignItems: 'center', gap: 8 }}>
        {value}
        {trend && <span style={{ fontSize: 12, fontWeight: 600, color: trend.startsWith('+') ? COLORS.success : COLORS.danger }}>{trend}</span>}
      </div>
      {sub && <div style={{ color: 'rgba(255,255,255,0.3)', fontSize: 11, marginTop: 6, fontWeight: 500 }}>{sub}</div>}
    </div>
  );

const TabBtn: React.FC<{ label: string; active: boolean; onClick: () => void; icon: string }> =
  ({ label, active, onClick, icon }) => (
    <button onClick={onClick} style={{
      background: active ? `linear-gradient(135deg, ${COLORS.accent}22, ${COLORS.cyan}11)` : 'transparent',
      border: active ? `1px solid ${COLORS.accent}44` : '1px solid transparent',
      borderRadius: 12,
      color: active ? COLORS.text : COLORS.muted,
      padding: '10px 20px',
      cursor: 'pointer',
      fontSize: 14,
      fontWeight: 600,
      transition: 'all 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
      display: 'flex',
      alignItems: 'center',
      gap: 10,
      outline: 'none',
    }}>
      <span style={{ fontSize: 18, filter: active ? 'none' : 'grayscale(100%) opacity(0.5)' }}>{icon}</span>
      {label}
    </button>
  );

const InputField: React.FC<{
  label: string; value: string; placeholder?: string; type?: string;
  rows?: number; hint?: string; onChange: (v: string) => void;
}> = ({ label, value, placeholder, type = 'text', rows, hint, onChange }) => (
  <div style={{ marginBottom: 20 }}>
    <label style={{ display: 'block', color: COLORS.muted, fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 8 }}>{label}</label>
    {rows ? (
      <textarea value={value} placeholder={placeholder} rows={rows}
        onChange={e => onChange(e.target.value)}
        style={FIELD_STYLE as any} />
    ) : (
      <input type={type} value={value} placeholder={placeholder}
        onChange={e => onChange(e.target.value)}
        style={FIELD_STYLE as any} />
    )}
    {hint && <p style={{ color: 'rgba(255,255,255,0.2)', fontSize: 10, marginTop: 6 }}>{hint}</p>}
  </div>
);

const FIELD_STYLE = {
  width: '100%', 
  background: 'rgba(255,255,255,0.03)', 
  border: '1px solid rgba(255,255,255,0.08)',
  borderRadius: 12, 
  color: COLORS.text, 
  padding: '12px 16px', 
  fontSize: 14,
  outline: 'none', 
  boxSizing: 'border-box', 
  fontFamily: "'Fira Code', monospace",
  transition: 'border-color 0.2s',
  '&:focus': { borderColor: COLORS.accent }
};

const HBDot: React.FC<{ status: string }> = ({ status }) => (
  <span style={{
    display: 'inline-block', 
    width: 10, 
    height: 10, 
    borderRadius: '50%',
    background: status === 'ONLINE' ? COLORS.success : status === 'ERROR' ? COLORS.danger : COLORS.muted,
    boxShadow: status === 'ONLINE' ? `0 0 12px ${COLORS.success}` : 'none',
    marginRight: 10,
    animation: status === 'ONLINE' ? 'pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite' : 'none'
  }} />
);

// ── Main Controller Component ────────────────────────────────────────────────

const TABS = [
  { id: 'exchange', icon: '⚡', label: 'Exchange' },
  { id: 'strategy', icon: '🧠', label: 'Strategy' },
  { id: 'backtest', icon: '🧪', label: 'Analytics' },
  { id: 'history',  icon: '📜', label: 'History' },
  { id: 'terminal', icon: '📟', label: 'Console' }
] as const;

type TabId = typeof TABS[number]['id'];

const AdminBotControl: React.FC = () => {
  const { botSettings, setBotSettings, botTrades, subscribeToBotTrades, botLogs, subscribeToBotLogs, subscribeToBotStatus } = useStore();
  const [tab, setTab] = useState<TabId>('exchange');
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState('');
  const unsubRef = useRef<(() => void) | null>(null);

  // Backtest state
  const [btSymbol, setBtSymbol] = useState('BTCUSDT');
  const [btFrom, setBtFrom] = useState('2025-01-01');
  const [btTo, setBtTo] = useState('2025-03-01');
  const [btRisk, setBtRisk] = useState(1.0);
  const [btConf, setBtConf] = useState(0.70);
  const [btInterval, setBtInterval] = useState('1h');
  const [btRunning, setBtRunning] = useState(false);
  const [btResult, setBtResult] = useState<BacktestResult | null>(null);
  const [btError, setBtError] = useState('');
  const [btPage, setBtPage] = useState(0);
  const BT_PAGE_SIZE = 15;

  useEffect(() => {
    unsubRef.current = subscribeToBotTrades();
    const unsubLogs = subscribeToBotLogs();
    const unsubStatus = subscribeToBotStatus();
    return () => { 
      unsubRef.current?.(); 
      unsubLogs();
      unsubStatus();
    };
  }, [subscribeToBotTrades, subscribeToBotLogs, subscribeToBotStatus]);

  const [hbAge, setHbAge] = useState<string>('—');
  useEffect(() => {
    const id = setInterval(() => {
      if (botSettings.lastHeartbeat) {
        const secs = Math.floor((Date.now() - botSettings.lastHeartbeat) / 1000);
        setHbAge(secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m`);
      }
    }, 1000);
    return () => clearInterval(id);
  }, [botSettings.lastHeartbeat]);

  const update = useCallback((patch: Partial<BotSettingsState>) => {
    setBotSettings(patch);
  }, [setBotSettings]);

  const saveSettings = () => {
    setSaving(true);
    setTimeout(() => { 
      setSaving(false); 
      setSaveMsg('Configuration Synchronized'); 
      setTimeout(() => setSaveMsg(''), 3000); 
    }, 800);
  };

  const runBacktest = async () => {
    setBtRunning(true); setBtError(''); setBtResult(null); setBtPage(0);
    try {
      const resp = await fetch(`${API_BASE}/backtest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          symbol: btSymbol.toUpperCase(),
          from_date: btFrom, to_date: btTo,
          risk_pct: btRisk, min_confidence: btConf,
          account_size: botSettings.accountSize,
          interval: btInterval,
        }),
      });
      if (!resp.ok) throw new Error('Simulation Engine Error');
      const data: BacktestResult = await resp.json();
      setBtResult(data);
    } catch (e: any) {
      setBtError(e.message || 'System Failure');
    }
    setBtRunning(false);
  };

  const equityCurveData = btResult?.equity_curve?.map((eq, i) => ({ i, equity: eq })) ?? [];
  const btTrades = btResult?.trades ?? [];
  const pagedTrades = btTrades.slice(btPage * BT_PAGE_SIZE, (btPage + 1) * BT_PAGE_SIZE);
  const totalPages = Math.ceil(btTrades.length / BT_PAGE_SIZE);
  const stats = btResult?.stats;

  return (
    <div style={{
      fontFamily: "'Inter', sans-serif",
      color: COLORS.text, 
      height: '100%', 
      overflowY: 'auto',
      background: COLORS.bg,
      padding: '40px 32px',
      scrollBehavior: 'smooth'
    }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=Fira+Code:wght@400;500&display=swap');
        @keyframes pulse { 0%,100%{opacity:1;transform:scale(1)} 50%{opacity:0.5;transform:scale(1.1)} }
        @keyframes spin { to{transform:rotate(360deg)} }
        @keyframes slideUp { from{opacity:0;transform:translateY(20px)} to{opacity:1;transform:translateY(0)} }
        ::-webkit-scrollbar { width:6px; } 
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.1); border-radius:10px; }
        .tab-content { animation: slideUp 0.4s cubic-bezier(0.4, 0, 0.2, 1); }
      `}</style>

      {/* ── Header ── */}
      <div style={{ marginBottom: 40, display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end' }}>
        <div>
          <h1 style={{ 
            margin: 0, 
            fontSize: 32, 
            fontWeight: 800, 
            letterSpacing: -1,
            background: `linear-gradient(135deg, #fff 0%, ${COLORS.accent} 100%)`, 
            WebkitBackgroundClip: 'text', 
            WebkitTextFillColor: 'transparent' 
          }}>
            Terminal X1
          </h1>
          <p style={{ color: COLORS.muted, margin: '8px 0 0', fontSize: 14, fontWeight: 500 }}>
            Unified Quantitative Execution & Strategy Lab
          </p>
        </div>
        <div style={{ display: 'flex', gap: 12 }}>
           <TabBtn active={false} label="Live Feed" icon="📡" onClick={() => {}} />
        </div>
      </div>

      {/* ── Dashboard Stats ── */}
      <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', marginBottom: 40 }}>
        <StatCard
          label="Engine Status"
          value={<><HBDot status={botSettings.status} />{botSettings.status}</>}
          sub={`${botSettings.botMode ?? 'DRY-RUN'} · ${botSettings.exchange?.toUpperCase()}`}
          color={botSettings.status === 'ONLINE' ? COLORS.success : COLORS.muted}
        />
        <StatCard label="Last Pulse" value={botSettings.lastSignal ?? 'WAIT'}
          sub="Predictive Verdict"
          color={verdictColor(botSettings.lastSignal)} />
        <StatCard label="Neural Gate"
          value={botSettings.lastUlis ?? '—'}
          sub={botSettings.ulisGateEnabled ? 'Bypassing noise' : 'Gate Disabled'}
          color={ulisColor(botSettings.lastUlis)} />
        <StatCard 
          label="Profit & Loss" 
          value={stats ? `${stats.totalReturn}%` : '--'} 
          trend={stats ? (stats.totalReturn > 0 ? `+${(stats.totalReturn).toFixed(2)}%` : `${stats.totalReturn}%`) : undefined}
          sub="Session performance" 
        />
        <StatCard label="Heartbeat" value={hbAge} sub="Gateway Latency" color={COLORS.cyan} />
      </div>

      {/* ── Navigation ── */}
      <GlassCard style={{ padding: 8, marginBottom: 40, borderRadius: 16 }}>
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
          {TABS.map(t => (
            <TabBtn key={t.id} icon={t.icon} label={t.label} active={tab === t.id} onClick={() => setTab(t.id)} />
          ))}
        </div>
      </GlassCard>

      <div className="tab-content">
        {/* ══════════════════════════════════════ */}
        {/* EXCHANGE SETTINGS                    */}
        {/* ══════════════════════════════════════ */}
        {tab === 'exchange' && (
          <div style={{ maxWidth: 800 }}>
            <GlassCard>
              <h2 style={{ fontSize: 20, fontWeight: 700, margin: '0 0 24px' }}>Broker Connectivity</h2>
              
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24, marginBottom: 24 }}>
                <div>
                  <label style={{ color: COLORS.muted, fontSize: 11, fontWeight: 700, textTransform: 'uppercase', marginBottom: 8, display: 'block' }}>Primary Exchange</label>
                  <div style={{ display: 'flex', gap: 12 }}>
                    {(['coinbase', 'binance'] as const).map(ex => (
                      <button key={ex} onClick={() => update({ exchange: ex, tradingPair: ex === 'coinbase' ? 'BTC-USD' : 'BTCUSDT' })} style={{
                        flex: 1, padding: '16px', borderRadius: 14, cursor: 'pointer', fontSize: 13, fontWeight: 600,
                        background: botSettings.exchange === ex ? `${COLORS.accent}22` : 'rgba(255,255,255,0.03)',
                        border: `1px solid ${botSettings.exchange === ex ? COLORS.accent : 'rgba(255,255,255,0.06)'}`,
                        color: botSettings.exchange === ex ? COLORS.text : COLORS.muted,
                        transition: 'all 0.2s'
                      }}>
                        {ex.toUpperCase()}
                      </button>
                    ))}
                  </div>
                </div>
                <div>
                  <label style={{ color: COLORS.muted, fontSize: 11, fontWeight: 700, textTransform: 'uppercase', marginBottom: 8, display: 'block' }}>Risk Environment</label>
                  <div style={{ display: 'flex', gap: 12 }}>
                    {(['live', 'testnet'] as const).map(env => (
                      <button key={env} onClick={() => update({ environment: env })} style={{
                        flex: 1, padding: '16px', borderRadius: 14, cursor: 'pointer', fontSize: 13, fontWeight: 600,
                        background: botSettings.environment === env ? (env === 'live' ? `${COLORS.danger}22` : `${COLORS.success}22`) : 'rgba(255,255,255,0.03)',
                        border: `1px solid ${botSettings.environment === env ? (env === 'live' ? COLORS.danger : COLORS.success) : 'rgba(255,255,255,0.06)'}`,
                        color: botSettings.environment === env ? (env === 'live' ? COLORS.danger : COLORS.success) : COLORS.muted,
                        transition: 'all 0.2s'
                      }}>
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

              <button onClick={saveSettings} disabled={saving} style={{
                width: '100%', padding: '18px', borderRadius: 14, cursor: saving ? 'wait' : 'pointer',
                background: `linear-gradient(135deg, ${COLORS.accent}, ${COLORS.cyan})`,
                border: 'none', color: '#fff', fontSize: 15, fontWeight: 800,
                boxShadow: `0 8px 24px -6px ${COLORS.accent}66`
              }}>
                {saving ? 'Synchronizing Engine...' : 'Initialize Configuration'}
              </button>
              {saveMsg && <p style={{ color: COLORS.success, fontSize: 12, textAlign: 'center', marginTop: 12, fontWeight: 600 }}>{saveMsg}</p>}
            </GlassCard>
          </div>
        )}

        {/* ══════════════════════════════════════ */}
        {/* STRATEGY SETTINGS                    */}
        {/* ══════════════════════════════════════ */}
        {tab === 'strategy' && (
          <div style={{ maxWidth: 900 }}>
             <div style={{ display: 'grid', gridTemplateColumns: 'minmax(400px, 1fr) 300px', gap: 24 }}>
                <GlassCard>
                  <h2 style={{ fontSize: 20, fontWeight: 700, margin: '0 0 24px' }}>Risk Architecture</h2>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 32 }}>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
                      <InputField label="Max Risk %" value={String(botSettings.maxRiskPerTradePct)} onChange={v => update({ maxRiskPerTradePct: Number(v) })} />
                      <InputField label="Target Confidence" value={String(Math.round((botSettings.minConfidence ?? 0.7) * 100))} onChange={v => update({ minConfidence: Number(v)/100 })} />
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
                      <InputField label="Analysis Frequency (s)" value={String(botSettings.analysisIntervalSec)} onChange={v => update({ analysisIntervalSec: Number(v) })} />
                      <InputField label="Daily Loss Cap %" value={String(botSettings.maxDailyLossPct)} onChange={v => update({ maxDailyLossPct: Number(v) })} />
                    </div>
                  </div>
                  
                  <div style={{ margin: '24px 0', padding: '24px', background: 'rgba(255,255,255,0.02)', borderRadius: 16, border: '1px solid rgba(255,255,255,0.05)' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                      <div>
                        <h4 style={{ margin: 0, fontSize: 15, color: COLORS.text }}>Neural Final Gate (ULIS)</h4>
                        <p style={{ margin: '4px 0 0', fontSize: 11, color: COLORS.muted }}>Vetoes high-noise signals automatically</p>
                      </div>
                      <div onClick={() => update({ ulisGateEnabled: !botSettings.ulisGateEnabled })} style={{
                        width: 50, height: 26, borderRadius: 13, cursor: 'pointer',
                        background: botSettings.ulisGateEnabled ? COLORS.accent : '#1a1d2e',
                        position: 'relative', transition: 'all 0.3s'
                      }}>
                         <div style={{ position: 'absolute', top: 3, left: botSettings.ulisGateEnabled ? 27 : 3, width: 20, height: 20, borderRadius: '50%', background: '#fff', transition: 'all 0.3s' }} />
                      </div>
                    </div>
                  </div>
                  <button onClick={saveSettings} style={{ width: '100%', padding: '16px', borderRadius: 12, background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', color: COLORS.cyan, fontWeight: 700, cursor: 'pointer' }}>Commit Changes</button>
                </GlassCard>
                
                <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
                   <GlassCard style={{ padding: 20 }}>
                      <h4 style={{ margin: '0 0 12px', fontSize: 13, color: COLORS.muted }}>Allocation Engine</h4>
                      <div style={{ fontSize: 24, fontWeight: 800 }}>${((botSettings.accountSize ?? 100) * (botSettings.maxRiskPerTradePct ?? 1) / 100).toFixed(2)}</div>
                      <p style={{ fontSize: 11, color: COLORS.muted, margin: '4px 0 0' }}>Est. Max Stop-Loss Drawdown</p>
                   </GlassCard>
                   <GlassCard style={{ padding: 20, borderTop: `4px solid ${COLORS.accent}` }}>
                      <h4 style={{ margin: '0 0 12px', fontSize: 13, color: COLORS.muted }}>Probability Edge</h4>
                      <div style={{ fontSize: 24, fontWeight: 800 }}>{Math.round((botSettings.minConfidence ?? 0.70) * 100)}%</div>
                      <p style={{ fontSize: 11, color: COLORS.muted, margin: '4px 0 0' }}>Bayesian Signal Threshold</p>
                   </GlassCard>
                </div>
             </div>
          </div>
        )}

        {/* ══════════════════════════════════════ */}
        {/* BACKTEST & ANALYTICS                 */}
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
                    <button onClick={runBacktest} disabled={btRunning} style={{ 
                      marginTop: 12, padding: '16px', borderRadius: 12, background: COLORS.accent, border: 'none', color: '#fff', fontWeight: 800, cursor: 'pointer' 
                    }}>
                      {btRunning ? 'Computing...' : 'Launch Simulation'}
                    </button>
                 </div>
              </GlassCard>

              {btResult ? (
                 <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 16 }}>
                       <StatCard label="Win Rate" value={`${stats?.winRate}%`} color={COLORS.success} />
                       <StatCard label="Total PnL" value={`${stats?.totalReturn}%`} color={stats?.totalReturn && stats.totalReturn > 0 ? COLORS.success : COLORS.danger} />
                       <StatCard label="Drawdown" value={`${stats?.maxDrawdown}%`} color={COLORS.warning} />
                       <StatCard label="Sharpe" value={stats?.sharpe ?? '0'} color={COLORS.cyan} />
                    </div>
                    
                    <GlassCard style={{ height: 350 }}>
                       <ResponsiveContainer width="100%" height="100%">
                          <AreaChart data={equityCurveData}>
                            <defs>
                              <linearGradient id="colorEquity" x1="0" y1="0" x2="0" y2="1">
                                <stop offset="5%" stopColor={COLORS.accent} stopOpacity={0.3}/>
                                <stop offset="95%" stopColor={COLORS.accent} stopOpacity={0}/>
                              </linearGradient>
                            </defs>
                            <XAxis dataKey="i" hide />
                            <YAxis domain={['auto', 'auto']} tick={{ fill: COLORS.muted, fontSize: 10 }} />
                            <Tooltip contentStyle={{ background: '#0d0f1a', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 12 }} />
                            <Area type="monotone" dataKey="equity" stroke={COLORS.accent} fillOpacity={1} fill="url(#colorEquity)" strokeWidth={3} />
                          </AreaChart>
                       </ResponsiveContainer>
                    </GlassCard>
                 </div>
              ) : (
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 400, background: 'rgba(255,255,255,0.01)', borderRadius: 20, border: '1px dashed rgba(255,255,255,0.05)' }}>
                   <p style={{ color: COLORS.muted }}>Initialize backtest to visualize performance curve</p>
                </div>
              )}
            </div>
          </div>
        )}

        {/* ══════════════════════════════════════ */}
        {/* TRADE HISTORY                        */}
        {/* ══════════════════════════════════════ */}
        {tab === 'history' && (
          <GlassCard style={{ padding: 0, overflow: 'hidden' }}>
             <div style={{ padding: '24px', borderBottom: `1px solid ${COLORS.border}`, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <h3 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>Transactional Ledger</h3>
                <span style={{ fontSize: 12, color: COLORS.muted, fontWeight: 600 }}>{botTrades.length} Sequences Recorded</span>
             </div>
             <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left' }}>
                   <thead>
                      <tr style={{ background: 'rgba(255,255,255,0.02)' }}>
                         {['TIMESTAMP', 'ASSET', 'DIRECTION', 'ENTRY', 'EXIT', 'PNL %', 'STATUS'].map(h => (
                           <th key={h} style={{ padding: '16px 24px', fontSize: 10, fontWeight: 800, color: COLORS.muted, letterSpacing: 1 }}>{h}</th>
                         ))}
                      </tr>
                   </thead>
                   <tbody>
                      {botTrades.length === 0 ? (
                        <tr><td colSpan={7} style={{ padding: 80, textAlign: 'center', color: COLORS.muted }}>Neutral. No trades detected in current session.</td></tr>
                      ) : botTrades.map(t => {
                        const win = (t.pnl ?? 0) > 0;
                        const netReturn = t.pnl ? ((t.pnl / (t.entry_price * (t.size ?? 1))) * 100).toFixed(2) : null;
                        return (
                          <tr key={t.id} style={{ borderBottom: `1px solid ${COLORS.border}`, transition: 'background 0.2s' }}>
                             <td style={{ padding: '20px 24px', fontSize: 12, color: COLORS.muted }}>{new Date(t.ts_ms).toLocaleString([], { hour12: false })}</td>
                             <td style={{ padding: '20px 24px', fontSize: 13, fontWeight: 700 }}>{t.symbol}</td>
                             <td style={{ padding: '20px 24px' }}>
                                <span style={{ color: t.side === 'buy' ? COLORS.success : COLORS.danger, fontWeight: 800 }}>{t.side?.toUpperCase()}</span>
                             </td>
                             <td style={{ padding: '20px 24px', fontSize: 13, fontFamily: "'Fira Code', monospace" }}>${t.entry_price.toFixed(2)}</td>
                             <td style={{ padding: '20px 24px', fontSize: 13, fontFamily: "'Fira Code', monospace" }}>{t.exit_price ? `$${t.exit_price.toFixed(2)}` : '--'}</td>
                             <td style={{ padding: '20px 24px' }}>
                                {t.pnl !== undefined ? (
                                  <span style={{ color: win ? COLORS.success : COLORS.danger, fontWeight: 700, filter: `drop-shadow(0 0 10px ${win ? COLORS.success : COLORS.danger}33)` }}>
                                    {win ? '+' : ''}{netReturn}%
                                  </span>
                                ) : <span style={{ color: COLORS.warning, fontWeight: 600 }}>ACTIVE</span>}
                             </td>
                             <td style={{ padding: '20px 24px' }}>
                                <span style={{ 
                                  padding: '4px 8px', borderRadius: 6, fontSize: 10, fontWeight: 800,
                                  background: t.mode === 'LIVE' ? `${COLORS.danger}22` : `${COLORS.warning}22`,
                                  color: t.mode === 'LIVE' ? COLORS.danger : COLORS.warning
                                }}>{t.mode}</span>
                             </td>
                          </tr>
                        );
                      })}
                   </tbody>
                </table>
             </div>
          </GlassCard>
        )}

        {/* ══════════════════════════════════════ */}
        {/* CONSOLE TERMINAL                     */}
        {/* ══════════════════════════════════════ */}
        {tab === 'terminal' && (
          <div style={{ animation: 'slideUp 0.3s' }}>
             <GlassCard style={{ padding: 0, overflow: 'hidden', background: '#05070a', border: '1px solid rgba(124,108,240,0.2)' }}>
                <div style={{ padding: '12px 20px', background: 'rgba(255,255,255,0.03)', borderBottom: `1px solid ${COLORS.border}`, display: 'flex', gap: 6 }}>
                   <div style={{ width: 12, height: 12, borderRadius: '50%', background: '#ff5f56' }} />
                   <div style={{ width: 12, height: 12, borderRadius: '50%', background: '#ffbd2e' }} />
                   <div style={{ width: 12, height: 12, borderRadius: '50%', background: '#27c93f' }} />
                   <span style={{ marginLeft: 12, fontSize: 10, fontWeight: 700, color: COLORS.muted, textTransform: 'uppercase', letterSpacing: 1 }}>Bot Kernel v4.2 // Standard Out</span>
                </div>
                <div style={{ 
                  height: 500, padding: 20, overflowY: 'auto', display: 'flex', flexDirection: 'column-reverse',
                  fontFamily: "'Fira Code', monospace", fontSize: 12, lineHeight: 1.6
                }}>
                   <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                      {botLogs.map((log: any) => (
                        <div key={log.id}>
                           <span style={{ color: COLORS.muted }}>[{new Date(log.ts_ms).toLocaleTimeString([], { hour12: false })}]</span>
                           <span style={{ margin: '0 10px', fontWeight: 800, color: log.level === 'ERROR' ? COLORS.danger : log.level === 'WARNING' ? COLORS.warning : COLORS.cyan }}>{log.level}</span>
                           <span style={{ color: log.level === 'ERROR' ? COLORS.danger : COLORS.text }}>{log.message}</span>
                        </div>
                      ))}
                   </div>
                </div>
             </GlassCard>
          </div>
        )}
      </div>
    </div>
  );
};

export default AdminBotControl;
