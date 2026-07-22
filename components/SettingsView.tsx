import React, { useState } from 'react';
import { motion as m } from 'framer-motion';
import { useStore } from '../store';

const motion = m as any;

interface SettingRowProps {
  label: string;
  value: string | number;
  description?: string;
  children?: React.ReactNode;
}

const SettingRow: React.FC<SettingRowProps> = ({ label, value, description }) => (
  <div className="flex items-center justify-between py-2 border-b border-[#21262d] last:border-0">
    <div>
      <span className="text-xs text-[#c9d1d9]">{label}</span>
      {description && <p className="text-[10px] text-[#484f58]">{description}</p>}
    </div>
    <span className="text-xs font-mono text-[#58a6ff]">{value}</span>
  </div>
);

const SettingsView: React.FC = () => {
  const bot = useStore(state => state.botSettings);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');

  const params = [
    { label: 'Exchange', value: bot.exchange?.toUpperCase() || 'BINANCE' },
    { label: 'Symbol', value: bot.tradingPair || 'BTC/USDT' },
    { label: 'Mode', value: bot.botMode || 'LIVE' },
    { label: 'Environment', value: bot.environment === 'live' ? 'LIVE' : 'TESTNET' },
    { label: 'Status', value: bot.status, desc: bot.operatorPaused ? 'Paused by operator' : 'Active' },
    { label: 'Active Positions', value: String(bot.activePositions || 0) },
    { label: 'Total Trades', value: String(bot.totalTrades || 0) },
    { label: 'P&L (Session)', value: `$${(bot.globalSessionPnl || 0).toFixed(2)}` },
    { label: 'P&L (Daily)', value: `$${(bot.globalDailyPnl || 0).toFixed(2)}` },
    { label: 'ULIS Gate', value: 'Enabled' },
    { label: 'Last Heartbeat', value: bot.lastHeartbeat ? `${Math.round((Date.now() - bot.lastHeartbeat) / 1000)}s ago` : '—' },
  ];

  const handlePause = async () => {
    setSaving(true);
    try {
      const { collection, doc, setDoc } = await import('firebase/firestore');
      const { db } = await import('../lib/firebase');
      const cmdRef = doc(collection(db, 'botCommands'), 'operator');
      await setDoc(cmdRef, {
        command: bot.operatorPaused ? 'resume_entries' : 'pause_entries',
        timestamp: Date.now(),
        source: 'dashboard_settings',
      });
      setMsg(bot.operatorPaused ? 'Resume command sent. Bot will resume within 60s.' : 'Pause command sent. Bot will pause within 60s.');
    } catch (e: any) {
      setMsg(`Error: ${e.message}`);
    }
    setSaving(false);
    setTimeout(() => setMsg(''), 5000);
  };

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      className="flex flex-col gap-4 p-4 overflow-y-auto h-full"
    >
      <h2 className="text-sm font-semibold text-white">Bot Settings</h2>

      <div className="bg-[#0d1117] border border-[#21262d] rounded-lg p-3">
        <span className="text-[10px] uppercase tracking-wider text-[#8b949e]">Configuration</span>
        <div className="mt-2">
          {params.map(p => (
            <SettingRow key={p.label} {...p} />
          ))}
        </div>
      </div>

      {/* Operator Controls */}
      <div className="bg-[#0d1117] border border-[#21262d] rounded-lg p-3">
        <span className="text-[10px] uppercase tracking-wider text-[#8b949e]">Operator Controls</span>
        <p className="text-[10px] text-[#484f58] mt-1">
          Pause/resume bot entries. Existing positions remain managed. Changes take effect within 60s.
        </p>
        <button
          onClick={handlePause}
          disabled={saving}
          className={`mt-3 w-full py-2 rounded text-xs font-semibold transition-colors ${
            saving ? 'bg-[#21262d] text-[#484f58]' :
            bot.operatorPaused ? 'bg-green-900 text-green-400 hover:bg-green-800' :
            'bg-yellow-900 text-yellow-400 hover:bg-yellow-800'
          }`}
        >
          {saving ? 'Sending...' : bot.operatorPaused ? '▶ Resume Entries' : '⏸ Pause Entries'}
        </button>
        {msg && <p className="text-[10px] text-[#58a6ff] mt-2 font-mono">{msg}</p>}
      </div>

      {/* Threshold Reference */}
      <div className="bg-[#0d1117] border border-[#21262d] rounded-lg p-3">
        <span className="text-[10px] uppercase tracking-wider text-[#8b949e]">Z-Score Thresholds (Current)</span>
        <div className="mt-2 space-y-1">
          {[
            { label: 'RANGE', value: 'z≥1.06  sl=1.14×  rr=2.3:1  exit=30m' },
            { label: 'NEUTRAL', value: 'z≥1.20  sl=1.43×  rr=2.5:1  exit=30m' },
            { label: 'LIQUIDITY', value: 'z≥1.10  sl=1.43×  rr=2.5:1  exit=30m' },
            { label: 'TREND', value: 'z≥2.00  sl=2.09×  rr=3.0:1  exit=1.5h' },
          ].map(p => (
            <SettingRow key={p.label} {...p} />
          ))}
        </div>
      </div>
    </motion.div>
  );
};

export default SettingsView;
