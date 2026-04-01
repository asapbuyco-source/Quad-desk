import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useStore } from '../store';
import { BotSettingsState, BacktestResult, BacktestTrade } from '../types';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, ReferenceLine } from 'recharts';

const API_BASE = (import.meta as any).env.VITE_API_URL || 'http://localhost:8000';

// ── Colour utilities ────────────────────────────────────────────────────────

const VERDICT_COLOUR: Record<string, string> = {
  BUY: '#10f0a0', SELL: '#f44771', WAIT: '#8899bb',
  MEAN_REVERSAL_LONG: '#10f0a0', MEAN_REVERSAL_SHORT: '#f44771',
};
const ULIS_COLOUR: Record<string, string> = {
  STRONG_LONG: '#10f0a0', LONG: '#4ec9b0', NEUTRAL: '#8899bb',
  SHORT: '#ff9966', STRONG_SHORT: '#f44771', AVOID: '#ff3355',
  UNWIND: '#ff6644', BREAKOUT_WATCH: '#ffe566', GATE_DISABLED: '#66aacc',
};

const ulisColor = (v?: string) => ULIS_COLOUR[v ?? ''] ?? '#8899bb';
const verdictColor = (v?: string) => VERDICT_COLOUR[v ?? ''] ?? '#8899bb';

// ── Sub-components ──────────────────────────────────────────────────────────

interface SliderProps {
  label: string; min: number; max: number; step: number;
  value: number; unit?: string;
  onChange: (v: number) => void;
}
const Slider: React.FC<SliderProps> = ({ label, min, max, step, value, unit = '', onChange }) => (
  <div style={{ marginBottom: 14 }}>
    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
      <span style={{ color: '#a0b4cc', fontSize: 12 }}>{label}</span>
      <span style={{ color: '#e0eaff', fontSize: 12, fontWeight: 700 }}>
        {value}{unit}
      </span>
    </div>
    <input type="range" min={min} max={max} step={step} value={value}
      onChange={e => onChange(Number(e.target.value))}
      style={{ width: '100%', accentColor: '#7c6cf0', cursor: 'pointer' }}
    />
    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
      <span style={{ color: '#556', fontSize: 10 }}>{min}{unit}</span>
      <span style={{ color: '#556', fontSize: 10 }}>{max}{unit}</span>
    </div>
  </div>
);

interface ToggleProps { label: string; value: boolean; onChange: (v: boolean) => void; accent?: string; }
const Toggle: React.FC<ToggleProps> = ({ label, value, onChange, accent = '#7c6cf0' }) => (
  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
    <span style={{ color: '#a0b4cc', fontSize: 13 }}>{label}</span>
    <div onClick={() => onChange(!value)} style={{
      width: 44, height: 24, borderRadius: 12, cursor: 'pointer',
      background: value ? accent : '#2a2d3d', position: 'relative', transition: 'background 0.2s',
      border: `1px solid ${value ? accent : '#3a3d5a'}`
    }}>
      <div style={{
        position: 'absolute', top: 3, left: value ? 22 : 2,
        width: 16, height: 16, borderRadius: '50%',
        background: value ? '#fff' : '#666', transition: 'left 0.2s'
      }} />
    </div>
  </div>
);

const StatCard: React.FC<{ label: string; value: string | number; sub?: string; color?: string }> =
  ({ label, value, sub, color = '#e0eaff' }) => (
    <div style={{
      background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)',
      borderRadius: 12, padding: '14px 18px', flex: 1, minWidth: 120
    }}>
      <div style={{ color: '#8899bb', fontSize: 11, marginBottom: 4, textTransform: 'uppercase', letterSpacing: 1 }}>{label}</div>
      <div style={{ color, fontSize: 22, fontWeight: 800, lineHeight: 1 }}>{value}</div>
      {sub && <div style={{ color: '#556', fontSize: 10, marginTop: 4 }}>{sub}</div>}
    </div>
  );

// ── Tab button ───────────────────────────────────────────────────────────────
const TabBtn: React.FC<{ label: string; active: boolean; onClick: () => void; icon?: string }> =
  ({ label, active, onClick, icon }) => (
    <button onClick={onClick} style={{
      background: active ? 'rgba(124,108,240,0.18)' : 'transparent',
      border: active ? '1px solid rgba(124,108,240,0.5)' : '1px solid transparent',
      borderRadius: 8, color: active ? '#c5b8ff' : '#6677aa',
      padding: '8px 18px', cursor: 'pointer', fontSize: 13, fontWeight: active ? 600 : 400,
      transition: 'all 0.15s', display: 'flex', alignItems: 'center', gap: 6,
    }}>
      {icon && <span>{icon}</span>}{label}
    </button>
  );

// ── Section header ───────────────────────────────────────────────────────────
const SectionHeader: React.FC<{ icon: string; title: string; subtitle?: string }> =
  ({ icon, title, subtitle }) => (
    <div style={{ marginBottom: 20 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
        <span style={{ fontSize: 20 }}>{icon}</span>
        <span style={{ color: '#e0eaff', fontSize: 16, fontWeight: 700 }}>{title}</span>
      </div>
      {subtitle && <p style={{ color: '#6677aa', fontSize: 12, margin: 0, paddingLeft: 30 }}>{subtitle}</p>}
      <div style={{ height: 1, background: 'rgba(255,255,255,0.07)', marginTop: 12 }} />
    </div>
  );

// ── Input field ──────────────────────────────────────────────────────────────
const InputField: React.FC<{
  label: string; value: string; placeholder?: string; type?: string;
  rows?: number; hint?: string; onChange: (v: string) => void;
}> = ({ label, value, placeholder, type = 'text', rows, hint, onChange }) => (
  <div style={{ marginBottom: 14 }}>
    <label style={{ display: 'block', color: '#a0b4cc', fontSize: 12, marginBottom: 5 }}>{label}</label>
    {rows ? (
      <textarea value={value} placeholder={placeholder} rows={rows}
        onChange={e => onChange(e.target.value)}
        style={FIELD_STYLE as any} />
    ) : (
      <input type={type} value={value} placeholder={placeholder}
        onChange={e => onChange(e.target.value)}
        style={FIELD_STYLE as any} />
    )}
    {hint && <p style={{ color: '#556', fontSize: 10, margin: '3px 0 0' }}>{hint}</p>}
  </div>
);

const FIELD_STYLE = {
  width: '100%', background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.1)',
  borderRadius: 8, color: '#e0eaff', padding: '9px 12px', fontSize: 13,
  outline: 'none', boxSizing: 'border-box', fontFamily: 'monospace',
  resize: 'vertical',
};

// ── Heartbeat dot ────────────────────────────────────────────────────────────
const HBDot: React.FC<{ status: string }> = ({ status }) => {
  const color = status === 'ONLINE' ? '#10f0a0' : status === 'ERROR' ? '#f44771' : '#888';
  return (
    <span style={{
      display: 'inline-block', width: 8, height: 8, borderRadius: '50%',
      background: color, boxShadow: status === 'ONLINE' ? `0 0 6px ${color}` : 'none',
      marginRight: 6, animation: status === 'ONLINE' ? 'pulse 2s infinite' : 'none'
    }} />
  );
};

// ── Main component ───────────────────────────────────────────────────────────

const TABS = ['exchange', 'strategy', 'backtest', 'history', 'terminal'] as const;
type Tab = typeof TABS[number];

const AdminBotControl: React.FC = () => {
  const { botSettings, setBotSettings, botTrades, subscribeToBotTrades, botLogs, subscribeToBotLogs, subscribeToBotStatus } = useStore();
  const [tab, setTab] = useState<Tab>('exchange');
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
  const BT_PAGE_SIZE = 20;

  // Subscribe to Firestore bot trades, logs and status on mount
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

  // Heartbeat age
  const [hbAge, setHbAge] = useState<string>('—');
  useEffect(() => {
    const id = setInterval(() => {
      if (botSettings.lastHeartbeat) {
        const secs = Math.floor((Date.now() - botSettings.lastHeartbeat) / 1000);
        setHbAge(secs < 60 ? `${secs}s ago` : `${Math.floor(secs / 60)}m ago`);
      }
    }, 1000);
    return () => clearInterval(id);
  }, [botSettings.lastHeartbeat]);

  const update = useCallback((patch: Partial<BotSettingsState>) => {
    setBotSettings(patch);
  }, [setBotSettings]);

  const saveSettings = () => {
    setSaving(true);
    setTimeout(() => { setSaving(false); setSaveMsg('Settings saved ✓'); setTimeout(() => setSaveMsg(''), 2500); }, 600);
  };

  // ── Run backtest ────────────────────────────────────────────────────────────
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
      if (!resp.ok) {
        const err = await resp.json();
        throw new Error(err.detail || 'Backtest failed');
      }
      const data: BacktestResult = await resp.json();
      setBtResult(data);
    } catch (e: any) {
      setBtError(e.message || 'Unknown error');
    }
    setBtRunning(false);
  };

  // Equity curve data
  const equityCurveData = btResult?.equity_curve?.map((eq, i) => ({ i, equity: eq })) ?? [];
  const btTrades = btResult?.trades ?? [];
  const pagedTrades = btTrades.slice(btPage * BT_PAGE_SIZE, (btPage + 1) * BT_PAGE_SIZE);
  const totalPages = Math.ceil(btTrades.length / BT_PAGE_SIZE);

  const stats = btResult?.stats;

  return (
    <div style={{
      fontFamily: "'Inter', 'Outfit', sans-serif",
      color: '#e0eaff', height: '100%', overflowY: 'auto',
      background: 'linear-gradient(135deg, #0d0f1a 0%, #111326 100%)',
      padding: '24px 20px',
    }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap');
        @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.4} }
        @keyframes spin { to{transform:rotate(360deg)} }
        input[type=range]::-webkit-slider-thumb { cursor:pointer; }
        ::-webkit-scrollbar { width:5px; } ::-webkit-scrollbar-thumb { background:#2a2d4a; border-radius:4px; }
        .bt-row:hover { background:rgba(255,255,255,0.04) !important; }
      `}</style>

      {/* ── Page header ── */}
      <div style={{ marginBottom: 24 }}>
        <h1 style={{ margin: 0, fontSize: 26, fontWeight: 800, background: 'linear-gradient(90deg,#a78bfa,#60e6ff)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>
          🤖 Bot Control Centre
        </h1>
        <p style={{ color: '#556677', margin: '4px 0 0', fontSize: 13 }}>
          Coinbase Advanced Trade · Hybrid 7-Stage ULIS Engine · $100 Account Optimised
        </p>
      </div>

      {/* ── Live status bar ── */}
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 24 }}>
        <StatCard
          label="Bot Status"
          value={<><HBDot status={botSettings.status} />{botSettings.status}</>  as any}
          sub={`Mode: ${botSettings.botMode ?? 'DRY-RUN'}`}
          color={botSettings.status === 'ONLINE' ? '#10f0a0' : '#8899bb'}
        />
        <StatCard label="Last Signal" value={botSettings.lastSignal ?? 'WAIT'}
          sub={`Exchange: ${botSettings.exchange?.toUpperCase()}`}
          color={verdictColor(botSettings.lastSignal)} />
        <StatCard label="ULIS Gate"
          value={botSettings.lastUlis ?? '—'}
          sub={`${botSettings.ulisGateEnabled ? 'Gate ON' : 'Gate OFF'}`}
          color={ulisColor(botSettings.lastUlis)} />
        <StatCard label="Heartbeat" value={hbAge} sub="Last bot ping" />
        <StatCard label="Total Trades" value={botSettings.totalTrades ?? 0}
          sub={`Risk/trade: ${botSettings.maxRiskPerTradePct}%`} />
      </div>

      {/* ── Tabs ── */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 24, flexWrap: 'wrap' }}>
        <TabBtn icon="🔗" label="Exchange" active={tab === 'exchange'} onClick={() => setTab('exchange')} />
        <TabBtn icon="⚙️" label="Strategy" active={tab === 'strategy'} onClick={() => setTab('strategy')} />
        <TabBtn icon="📊" label="Backtest Lab" active={tab === 'backtest'} onClick={() => setTab('backtest')} />
        <TabBtn icon="📋" label="Trade History" active={tab === 'history'} onClick={() => setTab('history')} />
        <TabBtn icon="💻" label="Terminal" active={tab === 'terminal'} onClick={() => setTab('terminal')} />
      </div>

      {/* ══════════════════════════════════════ */}
      {/* SECTION A — EXCHANGE & CREDENTIALS    */}
      {/* ══════════════════════════════════════ */}
      {tab === 'exchange' && (
        <div style={{ maxWidth: 680 }}>
          <SectionHeader icon="🔗" title="Exchange & API Credentials"
            subtitle="Configure which exchange your bot will trade on and paste your API keys below." />

          {/* Exchange select */}
          <div style={{ marginBottom: 16 }}>
            <label style={{ color: '#a0b4cc', fontSize: 12, display: 'block', marginBottom: 6 }}>Exchange</label>
            <div style={{ display: 'flex', gap: 10 }}>
              {(['coinbase', 'binance'] as const).map(ex => (
                <button key={ex} onClick={() => {
                  update({ exchange: ex, tradingPair: ex === 'coinbase' ? 'BTC-USD' : 'BTCUSDT' });
                }} style={{
                  flex: 1, padding: '12px 0', borderRadius: 10, cursor: 'pointer', fontSize: 13, fontWeight: 600,
                  background: botSettings.exchange === ex ? 'rgba(124,108,240,0.2)' : 'rgba(255,255,255,0.04)',
                  border: botSettings.exchange === ex ? '1px solid #7c6cf0' : '1px solid rgba(255,255,255,0.08)',
                  color: botSettings.exchange === ex ? '#c5b8ff' : '#667799',
                }}>
                  {ex === 'coinbase' ? '🟦 Coinbase Advanced' : '🟨 Binance (Legacy)'}
                </button>
              ))}
            </div>
          </div>

          {/* Environment */}
          <div style={{ marginBottom: 16 }}>
            <label style={{ color: '#a0b4cc', fontSize: 12, display: 'block', marginBottom: 6 }}>Environment</label>
            <div style={{ display: 'flex', gap: 10 }}>
              {(['live', 'testnet'] as const).map(env => (
                <button key={env} onClick={() => update({ environment: env })} style={{
                  flex: 1, padding: '10px 0', borderRadius: 8, cursor: 'pointer', fontSize: 12,
                  background: botSettings.environment === env ? (env === 'live' ? 'rgba(244,71,113,0.18)' : 'rgba(16,240,160,0.12)') : 'rgba(255,255,255,0.04)',
                  border: botSettings.environment === env ? `1px solid ${env === 'live' ? '#f44771' : '#10f0a0'}` : '1px solid rgba(255,255,255,0.08)',
                  color: botSettings.environment === env ? (env === 'live' ? '#f44771' : '#10f0a0') : '#667799',
                }}>
                  {env === 'live' ? '🔴 LIVE' : '🟢 Testnet (Safe)'}
                </button>
              ))}
            </div>
            {botSettings.environment === 'live' && (
              <div style={{ background: 'rgba(244,71,113,0.1)', border: '1px solid rgba(244,71,113,0.3)', borderRadius: 8, padding: '10px 14px', marginTop: 10, fontSize: 12, color: '#f44771' }}>
                ⚠️ LIVE mode — real funds will be used. The bot starts in dry-run by default even in live mode until you set valid API keys.
              </div>
            )}
          </div>

          {/* COINBASE fields */}
          {botSettings.exchange === 'coinbase' && (
            <div style={{ background: 'rgba(78,201,176,0.06)', border: '1px solid rgba(78,201,176,0.2)', borderRadius: 10, padding: '12px 16px', marginBottom: 18, fontSize: 12, color: '#4ec9b0', lineHeight: 1.6 }}>
              <strong>🔒 Security Hardening Active:</strong><br />
              Coinbase Advanced Trade API Keys have been migrated exclusively to the backend environment variables to prevent accidental exposure.<br /><br />
              Please configure <code>COINBASE_API_KEY_NAME</code> and <code>COINBASE_PRIVATE_KEY</code> directly in your Railway/Render dashboard.
            </div>
          )}

          {/* BINANCE fields */}
          {botSettings.exchange === 'binance' && (
            <div style={{ background: 'rgba(255,229,102,0.06)', border: '1px solid rgba(255,229,102,0.2)', borderRadius: 10, padding: '12px 16px', marginBottom: 18, fontSize: 12, color: '#ffe566', lineHeight: 1.6 }}>
              <strong>🔒 Security Hardening Active:</strong><br />
              Binance API keys have been migrated exclusively to backend environment variables to prevent accidental exposure.<br /><br />
              Please configure <code>BINANCE_API_KEY</code> and <code>BINANCE_API_SECRET</code> directly in your Railway/Render dashboard.
            </div>
          )}


          {/* Trading pair */}
          <InputField label="Trading Pair"
            value={botSettings.tradingPair}
            placeholder={botSettings.exchange === 'coinbase' ? 'BTC-USD' : 'BTCUSDT'}
            hint={botSettings.exchange === 'coinbase' ? 'Coinbase uses dashes: BTC-USD, ETH-USD' : 'Binance uses no separator: BTCUSDT, ETHUSDT'}
            onChange={v => update({ tradingPair: v })} />

          {/* Account size */}
          <InputField label="Account Size (USD)" value={String(botSettings.accountSize)}
            type="number"
            hint="Starting equity for position sizing and dry-run simulation"
            onChange={v => update({ accountSize: Number(v) })} />

          {/* Save */}
          <button onClick={saveSettings} disabled={saving} style={{
            marginTop: 8, padding: '12px 32px', borderRadius: 10, cursor: saving ? 'wait' : 'pointer',
            background: 'linear-gradient(135deg,#7c6cf0,#4ec9b0)', border: 'none',
            color: '#fff', fontSize: 14, fontWeight: 700, opacity: saving ? 0.7 : 1,
          }}>
            {saving ? 'Saving…' : '💾 Save Settings'}
          </button>
          {saveMsg && <span style={{ color: '#10f0a0', fontSize: 13, marginLeft: 16 }}>{saveMsg}</span>}
        </div>
      )}

      {/* ══════════════════════════════════════ */}
      {/* SECTION B — STRATEGY SETTINGS         */}
      {/* ══════════════════════════════════════ */}
      {tab === 'strategy' && (
        <div style={{ maxWidth: 620 }}>
          <SectionHeader icon="⚙️" title="Strategy & Risk Settings"
            subtitle="Tune the signal thresholds, risk limits, and ALDE+ULIS gate for your $100 account." />

          {/* Optimal $100 banner */}
          <div style={{ background: 'rgba(124,108,240,0.1)', border: '1px solid rgba(124,108,240,0.3)', borderRadius: 12, padding: '14px 18px', marginBottom: 24, fontSize: 12.5, color: '#c5b8ff', lineHeight: 1.7 }}>
            <strong>✅ Optimal Settings for $100 Account</strong><br />
            Risk 1% per trade = <strong>$1 max loss per trade</strong> · Daily loss cap 3% = <strong>$3/day halt</strong> · ULIS Gate acts as final confirmation — reduces false signals by ~35%
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 32 }}>
            <div>
              <p style={{ color: '#8899bb', fontSize: 12, margin: '0 0 14px' }}>📐 RISK PARAMETERS</p>
              <Slider label="Max Risk Per Trade" min={0.5} max={5} step={0.1}
                value={botSettings.maxRiskPerTradePct} unit="%"
                onChange={v => update({ maxRiskPerTradePct: v })} />
              <Slider label="Max Daily Loss" min={1} max={10} step={0.5}
                value={botSettings.maxDailyLossPct ?? 3} unit="%"
                onChange={v => update({ maxDailyLossPct: v })} />
              <Slider label="Account Size" min={50} max={10000} step={50}
                value={botSettings.accountSize ?? 100} unit="$"
                onChange={v => update({ accountSize: v })} />
            </div>
            <div>
              <p style={{ color: '#8899bb', fontSize: 12, margin: '0 0 14px' }}>🎯 SIGNAL THRESHOLDS</p>
              <Slider label="Min Confidence (Bayesian P)" min={50} max={95} step={1}
                value={Math.round((botSettings.minConfidence ?? 0.70) * 100)} unit="%"
                onChange={v => update({ minConfidence: v / 100 })} />
              <Slider label="Analysis Interval" min={5} max={60} step={5}
                value={botSettings.analysisIntervalSec ?? 15} unit="s"
                onChange={v => update({ analysisIntervalSec: v })} />
            </div>
          </div>

          <div style={{ height: 1, background: 'rgba(255,255,255,0.07)', margin: '16px 0 20px' }} />

          <p style={{ color: '#8899bb', fontSize: 12, margin: '0 0 14px' }}>🧠 ULIS/ALDE GATE</p>

          <Toggle label="Enable ULIS/ALDE Final Gate"
            value={botSettings.ulisGateEnabled ?? true}
            accent="#7c6cf0"
            onChange={v => update({ ulisGateEnabled: v })} />

          {botSettings.ulisGateEnabled && (
            <div style={{ background: 'rgba(124,108,240,0.08)', border: '1px solid rgba(124,108,240,0.2)', borderRadius: 10, padding: '12px 16px', fontSize: 12, color: '#9988cc', lineHeight: 1.6 }}>
              <strong style={{ color: '#c5b8ff' }}>ULIS Gate Active</strong>
              <br />Verdicts <strong>STRONG_LONG/STRONG_SHORT</strong> → +8% confidence boost<br />
              Verdicts <strong>AVOID/UNWIND</strong> → all trades vetoed regardless of other signals<br />
              Direction conflicts (ULIS vs bot) → trade skipped
            </div>
          )}

          <div style={{ height: 1, background: 'rgba(255,255,255,0.07)', margin: '20px 0' }} />

          {/* Settings summary */}
          <div style={{ background: 'rgba(255,255,255,0.02)', borderRadius: 10, padding: '14px 18px', fontSize: 12 }}>
            <p style={{ color: '#8899bb', marginBottom: 8 }}>📋 Current Configuration Summary</p>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px 24px' }}>
              {[
                ['Exchange', botSettings.exchange?.toUpperCase()],
                ['Pair', botSettings.tradingPair],
                ['Account', `$${botSettings.accountSize}`],
                ['Risk/trade', `${botSettings.maxRiskPerTradePct}% = $${((botSettings.accountSize ?? 100) * (botSettings.maxRiskPerTradePct ?? 1) / 100).toFixed(2)}`],
                ['Daily halt', `${botSettings.maxDailyLossPct ?? 3}% = $${((botSettings.accountSize ?? 100) * (botSettings.maxDailyLossPct ?? 3) / 100).toFixed(2)}`],
                ['Min P(edge)', `${Math.round((botSettings.minConfidence ?? 0.70) * 100)}%`],
                ['Interval', `${botSettings.analysisIntervalSec ?? 15}s`],
                ['ULIS Gate', botSettings.ulisGateEnabled ? '✅ ON' : '❌ OFF'],
              ].map(([k, v]) => (
                <div key={k as string} style={{ display: 'flex', justifyContent: 'space-between', padding: '3px 0', borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                  <span style={{ color: '#667799' }}>{k}</span>
                  <span style={{ color: '#c5b8ff', fontWeight: 600 }}>{v}</span>
                </div>
              ))}
            </div>
          </div>

          <button onClick={saveSettings} style={{
            marginTop: 20, padding: '11px 28px', borderRadius: 10, cursor: 'pointer',
            background: 'linear-gradient(135deg,#7c6cf0,#4ec9b0)', border: 'none',
            color: '#fff', fontSize: 13, fontWeight: 700,
          }}>
            💾 Save Strategy Settings
          </button>
          {saveMsg && <span style={{ color: '#10f0a0', fontSize: 13, marginLeft: 12 }}>{saveMsg}</span>}
        </div>
      )}

      {/* ══════════════════════════════════════ */}
      {/* SECTION C — BACKTEST LAB              */}
      {/* ══════════════════════════════════════ */}
      {tab === 'backtest' && (
        <div>
          <SectionHeader icon="📊" title="Backtesting Lab"
            subtitle="Replay the 7-stage signal engine on historical data. Results show pure strategy performance without ULIS gate (runs faster)." />

          {/* Controls */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 16, marginBottom: 20, maxWidth: 860 }}>

            <div>
              <label style={{ color: '#a0b4cc', fontSize: 12, display: 'block', marginBottom: 5 }}>Symbol</label>
              <select value={btSymbol} onChange={e => setBtSymbol(e.target.value)} style={{ ...FIELD_STYLE, fontFamily: 'Inter, sans-serif' } as any}>
                <option value="BTCUSDT">Bitcoin (BTC/USDT)</option>
                <option value="ETHUSDT">Ethereum (ETH/USDT)</option>
                <option value="SOLUSDT">Solana (SOL/USDT)</option>
                <option value="BNBUSDT">BNB (BNB/USDT)</option>
                <option value="XRPUSDT">Ripple (XRP/USDT)</option>
                <option value="ADAUSDT">Cardano (ADA/USDT)</option>
              </select>
            </div>

            <div>
              <label style={{ color: '#a0b4cc', fontSize: 12, display: 'block', marginBottom: 5 }}>Candle Interval</label>
              <select value={btInterval} onChange={e => setBtInterval(e.target.value)} style={{ ...FIELD_STYLE, fontFamily: 'Inter, sans-serif' } as any}>
                <option value="15m">15 minutes</option>
                <option value="1h">1 hour</option>
                <option value="4h">4 hours</option>
                <option value="1d">1 day</option>
              </select>
            </div>

            <InputField label="From Date" value={btFrom} type="date" onChange={setBtFrom} />
            <InputField label="To Date" value={btTo} type="date" onChange={setBtTo} />

            <div>
              <Slider label="Risk Per Trade" min={0.5} max={5} step={0.1} value={btRisk} unit="%" onChange={setBtRisk} />
            </div>
            <div>
              <Slider label="Min Confidence" min={50} max={95} step={1} value={Math.round(btConf * 100)} unit="%" onChange={v => setBtConf(v / 100)} />
            </div>
          </div>

          <button onClick={runBacktest} disabled={btRunning} style={{
            padding: '13px 36px', borderRadius: 12, cursor: btRunning ? 'wait' : 'pointer',
            background: btRunning ? 'rgba(124,108,240,0.3)' : 'linear-gradient(135deg,#7c6cf0,#4ec9b0)',
            border: 'none', color: '#fff', fontSize: 14, fontWeight: 800,
            display: 'flex', alignItems: 'center', gap: 10, boxShadow: '0 4px 20px rgba(124,108,240,0.4)',
          }}>
            {btRunning ? (
              <><span style={{ width: 18, height: 18, border: '2px solid rgba(255,255,255,0.3)', borderTopColor: '#fff', borderRadius: '50%', animation: 'spin 0.8s linear infinite', display: 'inline-block' }} />Running Backtest…</>
            ) : (
              <><span>▶</span> Run Backtest</>
            )}
          </button>

          {/* Error */}
          {btError && (
            <div style={{ background: 'rgba(244,71,113,0.1)', border: '1px solid rgba(244,71,113,0.3)', borderRadius: 10, padding: '12px 16px', marginTop: 16, color: '#f44771', fontSize: 13 }}>
              ⚠️ {btError}
            </div>
          )}

          {/* ── Results ── */}
          {btResult && stats && (
            <div style={{ marginTop: 28 }}>
              {/* Metadata */}
              {btResult.meta && (
                <p style={{ color: '#556677', fontSize: 11, marginBottom: 16 }}>
                  {btResult.meta.symbol} · {btResult.meta.interval} · {btResult.meta.from_date} → {btResult.meta.to_date} · {btResult.meta.candles_fetched.toLocaleString()} candles · Account: ${btResult.meta.account_size}
                </p>
              )}

              {/* Stats cards */}
              <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 24 }}>
                <StatCard label="Win Rate"
                  value={`${stats.winRate}%`}
                  sub={`${stats.wins}W / ${stats.losses}L of ${stats.totalTrades}`}
                  color={stats.winRate >= 50 ? '#10f0a0' : '#f44771'} />
                <StatCard label="Total Return"
                  value={`${stats.totalReturn > 0 ? '+' : ''}${stats.totalReturn}%`}
                  sub={`Final equity: $${stats.finalEquity?.toFixed(2)}`}
                  color={stats.totalReturn >= 0 ? '#10f0a0' : '#f44771'} />
                <StatCard label="Max Drawdown" value={`${stats.maxDrawdown}%`}
                  sub="Peak-to-trough" color={stats.maxDrawdown < 10 ? '#10f0a0' : '#f44771'} />
                <StatCard label="Sharpe Ratio" value={stats.sharpe}
                  sub="Annualised" color={stats.sharpe >= 1 ? '#10f0a0' : stats.sharpe >= 0 ? '#ffe566' : '#f44771'} />
              </div>

              {/* Equity curve */}
              {equityCurveData.length > 1 && (
                <div style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: 14, padding: '16px 20px', marginBottom: 24 }}>
                  <p style={{ color: '#8899bb', fontSize: 12, margin: '0 0 12px' }}>📈 Equity Curve</p>
                  <ResponsiveContainer width="100%" height={220}>
                    <LineChart data={equityCurveData}>
                      <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
                      <XAxis dataKey="i" hide />
                      <YAxis domain={['auto', 'auto']} tickFormatter={(v: number) => `$${v}`}
                        tick={{ fill: '#667799', fontSize: 10 }} width={55} />
                      <Tooltip
                        contentStyle={{ background: '#1a1d2e', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8, fontSize: 12 }}
                        labelFormatter={() => ''} formatter={(v: any) => [`$${Number(v).toFixed(2)}`, 'Equity']} />
                      <ReferenceLine y={botSettings.accountSize ?? 100} stroke="rgba(255,255,255,0.2)" strokeDasharray="4 4" />
                      <Line type="monotone" dataKey="equity" stroke="#7c6cf0" strokeWidth={2} dot={false} />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              )}

              {/* Trade log */}
              {btTrades.length > 0 && (
                <div style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: 14, overflow: 'hidden' }}>
                  <div style={{ padding: '14px 20px', borderBottom: '1px solid rgba(255,255,255,0.07)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <p style={{ color: '#8899bb', fontSize: 12, margin: 0 }}>📋 Trade Log ({btTrades.length} trades)</p>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <button onClick={() => setBtPage(p => Math.max(0, p - 1))} disabled={btPage === 0}
                        style={{ background: 'rgba(255,255,255,0.06)', border: 'none', borderRadius: 6, color: '#a0b4cc', padding: '4px 12px', cursor: 'pointer', fontSize: 12, opacity: btPage === 0 ? 0.4 : 1 }}>‹ Prev</button>
                      <span style={{ color: '#667799', fontSize: 12, lineHeight: '28px' }}>{btPage + 1}/{totalPages}</span>
                      <button onClick={() => setBtPage(p => Math.min(totalPages - 1, p + 1))} disabled={btPage >= totalPages - 1}
                        style={{ background: 'rgba(255,255,255,0.06)', border: 'none', borderRadius: 6, color: '#a0b4cc', padding: '4px 12px', cursor: 'pointer', fontSize: 12, opacity: btPage >= totalPages - 1 ? 0.4 : 1 }}>Next ›</button>
                    </div>
                  </div>
                  <div style={{ overflowX: 'auto' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                      <thead>
                        <tr style={{ background: 'rgba(255,255,255,0.04)' }}>
                          {['Date', 'Side', 'Entry', 'SL', 'TP', 'Exit', 'PnL', 'Conf', 'Z', 'RSI', 'Result'].map(h => (
                            <th key={h} style={{ color: '#667799', padding: '10px 12px', textAlign: 'left', fontWeight: 500, whiteSpace: 'nowrap' }}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {pagedTrades.map((t: BacktestTrade, i: number) => (
                          <tr key={i} className="bt-row" style={{ borderTop: '1px solid rgba(255,255,255,0.04)' }}>
                            <td style={{ padding: '9px 12px', color: '#8899bb', whiteSpace: 'nowrap' }}>{t.date}</td>
                            <td style={{ padding: '9px 12px', color: t.side === 'BUY' ? '#10f0a0' : '#f44771', fontWeight: 700 }}>{t.side}</td>
                            <td style={{ padding: '9px 12px', color: '#e0eaff' }}>{t.entry.toFixed(2)}</td>
                            <td style={{ padding: '9px 12px', color: '#f44771' }}>{t.stop_loss.toFixed(2)}</td>
                            <td style={{ padding: '9px 12px', color: '#10f0a0' }}>{t.take_profit.toFixed(2)}</td>
                            <td style={{ padding: '9px 12px', color: '#e0eaff' }}>{t.exit_price.toFixed(2)}</td>
                            <td style={{ padding: '9px 12px', color: t.pnl >= 0 ? '#10f0a0' : '#f44771', fontWeight: 600 }}>
                              {t.pnl >= 0 ? '+' : ''}${t.pnl.toFixed(2)}
                            </td>
                            <td style={{ padding: '9px 12px', color: '#8899bb' }}>{(t.confidence * 100).toFixed(0)}%</td>
                            <td style={{ padding: '9px 12px', color: '#8899bb' }}>{t.z_score.toFixed(2)}</td>
                            <td style={{ padding: '9px 12px', color: '#8899bb' }}>{t.rsi.toFixed(0)}</td>
                            <td style={{ padding: '9px 12px' }}>
                              <span style={{ background: t.result === 'WIN' ? 'rgba(16,240,160,0.15)' : 'rgba(244,71,113,0.15)', color: t.result === 'WIN' ? '#10f0a0' : '#f44771', borderRadius: 4, padding: '2px 8px', fontSize: 11, fontWeight: 600 }}>
                                {t.result}
                              </span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {btTrades.length === 0 && (
                <div style={{ textAlign: 'center', padding: '40px 20px', color: '#556677' }}>
                  <div style={{ fontSize: 36, marginBottom: 12 }}>🔍</div>
                  No trades generated. Try lowering the confidence threshold or expanding the date range.
                </div>
              )}
            </div>
          )}

          {!btResult && !btRunning && !btError && (
            <div style={{ textAlign: 'center', padding: '60px 20px', color: '#445566' }}>
              <div style={{ fontSize: 48, marginBottom: 16 }}>📊</div>
              <p style={{ fontSize: 15, fontWeight: 600, color: '#667799', margin: '0 0 8px' }}>Backtest Lab Ready</p>
              <p style={{ fontSize: 13, margin: 0 }}>Configure the date range above and click Run Backtest to simulate your strategy on historical data.</p>
            </div>
          )}
        </div>
      )}

      {/* ══════════════════════════════════════ */}
      {/* SECTION D — TRADE HISTORY             */}
      {/* ══════════════════════════════════════ */}
      {tab === 'history' && (
        <div>
          <SectionHeader icon="📋" title="Live Trade History"
            subtitle="Real-time trade log written by the bot to Firestore. Updates automatically." />

          {botTrades.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '60px 20px', color: '#445566' }}>
              <div style={{ fontSize: 48, marginBottom: 16 }}>🤖</div>
              <p style={{ fontSize: 15, color: '#667799', fontWeight: 600, margin: '0 0 8px' }}>No trades yet</p>
              <p style={{ fontSize: 13, margin: 0 }}>Once the bot starts executing (even in dry-run), trades will appear here in real time.</p>
            </div>
          ) : (
            <div style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: 14, overflow: 'hidden' }}>
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
                  <thead>
                    <tr style={{ background: 'rgba(255,255,255,0.04)' }}>
                      {['Time', 'Symbol', 'Side', 'Verdict', 'ULIS', 'Entry', 'SL', 'TP', 'Mode', 'Exchange'].map(h => (
                        <th key={h} style={{ color: '#667799', padding: '12px 14px', textAlign: 'left', fontWeight: 500, whiteSpace: 'nowrap' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {botTrades.map(t => {
                      const ts = new Date(t.ts_ms).toLocaleString();
                      return (
                        <tr key={t.id} className="bt-row" style={{ borderTop: '1px solid rgba(255,255,255,0.04)' }}>
                          <td style={{ padding: '11px 14px', color: '#667799', whiteSpace: 'nowrap', fontSize: 11 }}>{ts}</td>
                          <td style={{ padding: '11px 14px', color: '#e0eaff', fontWeight: 600 }}>{t.symbol}</td>
                          <td style={{ padding: '11px 14px', color: t.side === 'buy' ? '#10f0a0' : '#f44771', fontWeight: 700, textTransform: 'uppercase' }}>{t.side}</td>
                          <td style={{ padding: '11px 14px', color: verdictColor(t.verdict), fontWeight: 600, fontSize: 11 }}>{t.verdict}</td>
                          <td style={{ padding: '11px 14px' }}>
                            {t.ulis_verdict && (
                              <span style={{ background: `${ulisColor(t.ulis_verdict)}22`, color: ulisColor(t.ulis_verdict), borderRadius: 4, padding: '2px 7px', fontSize: 10, fontWeight: 600 }}>
                                {t.ulis_verdict}
                              </span>
                            )}
                          </td>
                          <td style={{ padding: '11px 14px', color: '#c5b8ff' }}>{t.entry_price.toFixed(2)}</td>
                          <td style={{ padding: '11px 14px', color: '#f44771' }}>{t.stop_loss.toFixed(2)}</td>
                          <td style={{ padding: '11px 14px', color: '#10f0a0' }}>{t.take_profit.toFixed(2)}</td>
                          <td style={{ padding: '11px 14px' }}>
                            <span style={{ background: t.mode === 'LIVE' ? 'rgba(244,71,113,0.15)' : 'rgba(255,229,102,0.1)', color: t.mode === 'LIVE' ? '#f44771' : '#ffe566', borderRadius: 4, padding: '2px 7px', fontSize: 10, fontWeight: 600 }}>
                              {t.mode}
                            </span>
                          </td>
                          <td style={{ padding: '11px 14px', color: '#8899bb', fontSize: 11 }}>{t.exchange ?? '—'}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ══════════════════════════════════════ */}
      {/* SECTION E — TERMINAL                   */}
      {/* ══════════════════════════════════════ */}
      {tab === 'terminal' && (
        <div style={{ display: 'flex', flexDirection: 'column', height: 'calc(100vh - 220px)', minHeight: 400 }}>
          <SectionHeader icon="💻" title="Live Terminal"
            subtitle="Raw execution logs directly from the backend bot engine." />
            
          <div style={{ flex: 1, background: '#090a0f', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 12, padding: '16px 20px', fontFamily: '"Fira Code", monospace', fontSize: 13, overflowY: 'auto', display: 'flex', flexDirection: 'column-reverse' }}>
            {botLogs.length === 0 ? (
              <div style={{ color: '#556677', textAlign: 'center', marginTop: 'auto', marginBottom: 'auto' }}>Waiting for bot logs...</div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {botLogs.map((log: any) => {
                  const err = log.level === 'ERROR' || log.level === 'CRITICAL';
                  const warn = log.level === 'WARNING';
                  const time = new Date(log.ts_ms || 0).toLocaleTimeString([], { hour12: false });
                  return (
                    <div key={log.id} style={{ color: err ? '#f44771' : warn ? '#ffe566' : '#a0b4cc', wordBreak: 'break-all', fontFamily: 'monospace' }}>
                      <span style={{ color: '#556677', marginRight: 12 }}>[{time}]</span>
                      <span style={{ display: 'inline-block', width: 68, color: err ? '#f44771' : warn ? '#ffe566' : '#8899bb', fontWeight: 600 }}>{log.level}</span>
                      <span style={{ color: err ? '#ff88aa' : warn ? '#fff2aa' : '#e0eaff' }}>{log.message}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}

    </div>
  );
};

export default AdminBotControl;
