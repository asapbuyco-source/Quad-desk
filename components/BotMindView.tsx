import React from 'react';
import { motion as m } from 'framer-motion';
import { useStore } from '../store';

const motion = m as any;

const StatCard: React.FC<{ label: string; value: string | number; color?: string; sub?: string }> = ({ label, value, color, sub }) => (
  <div className="bg-[#0d1117] border border-[#21262d] rounded-lg p-3 flex flex-col gap-1">
    <span className="text-[10px] uppercase tracking-wider text-[#8b949e]">{label}</span>
    <span className={`text-lg font-mono font-bold ${color || 'text-white'}`}>{value}</span>
    {sub && <span className="text-[10px] text-[#8b949e]">{sub}</span>}
  </div>
);

const GateBar: React.FC<{ name: string; count: number; max: number }> = ({ name, count, max }) => {
  const pct = max > 0 ? Math.min(count / max * 100, 100) : 0;
  return (
    <div className="flex items-center gap-2 text-[10px]">
      <span className="w-32 text-[#8b949e] truncate">{name}</span>
      <div className="flex-1 bg-[#21262d] rounded-full h-2">
        <div className="bg-[#58a6ff] h-2 rounded-full" style={{ width: `${pct}%` }} />
      </div>
      <span className="w-8 text-right font-mono text-[#c9d1d9]">{count}</span>
    </div>
  );
};

const BotMindView: React.FC = () => {
  const { metrics } = useStore(state => state.market);
  const bot = useStore(state => state.botSettings);

  const isRunning = bot.status === 'ONLINE';
  const zAbs = Math.abs(bot.currentZScore || 0);
  const bayes = (bot.currentBayes || 0.5) * 100;
  const gateEntries = bot.gateStats ? Object.entries(bot.gateStats) : [];
  const maxGate = Math.max(...gateEntries.map(([, v]) => v), 1);
  const topGates = gateEntries
    .filter(([, v]) => v > 0)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 8);

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      className="flex flex-col gap-4 p-4 overflow-y-auto h-full"
    >
      {/* Status Bar */}
      <div className="flex items-center gap-3">
        <span className={`w-2.5 h-2.5 rounded-full ${isRunning ? 'bg-green-400 animate-pulse' : 'bg-red-500'}`} />
        <span className="text-sm font-semibold text-white">{bot.tradingPair || 'BTC/USDT'}</span>
        <span className="text-[10px] px-2 py-0.5 rounded bg-[#21262d] text-[#8b949e]">{bot.botMode || 'LIVE'}</span>
        <span className="text-[10px] px-2 py-0.5 rounded bg-[#21262d] text-[#8b949e]">
          {bot.environment?.toUpperCase() || 'LIVE'}
        </span>
        {bot.operatorPaused && (
          <span className="text-[10px] px-2 py-0.5 rounded bg-yellow-900 text-yellow-400">PAUSED</span>
        )}
        <span className="ml-auto text-[10px] text-[#8b949e] font-mono">
          {bot.lastHeartbeat ? `${Math.round((Date.now() - bot.lastHeartbeat) / 1000)}s ago` : '—'}
        </span>
      </div>

      {/* Key Metrics */}
      <div className="grid grid-cols-4 gap-2">
        <StatCard label="Z-Score" value={bot.currentZScore?.toFixed(2) ?? '—'} color={zAbs > 1.5 ? 'text-red-400' : zAbs > 1.0 ? 'text-yellow-400' : 'text-green-400'} />
        <StatCard label="RSI" value={bot.currentRSI?.toFixed(1) ?? '—'} color={(bot.currentRSI || 50) > 70 ? 'text-red-400' : (bot.currentRSI || 50) < 30 ? 'text-green-400' : 'text-white'} />
        <StatCard label="Bayes" value={`${bayes.toFixed(1)}%`} color={bayes > 65 ? 'text-green-400' : bayes > 50 ? 'text-yellow-400' : 'text-red-400'} />
        <StatCard label="OFI" value={bot.currentOFI?.toFixed(2) ?? '—'} color={(bot.currentOFI || 0) > 0.3 ? 'text-green-400' : (bot.currentOFI || 0) < -0.3 ? 'text-red-400' : 'text-white'} />
      </div>

      {/* Signal & Regime */}
      <div className="grid grid-cols-2 gap-2">
        <StatCard
          label="Last Signal"
          value={bot.lastSignal || 'WAIT'}
          color={bot.lastSignal === 'WAIT' ? 'text-[#8b949e]' : bot.lastSignal?.includes('BUY') || bot.lastSignal?.includes('LONG') ? 'text-green-400' : 'text-red-400'}
          sub={bot.lastUlis !== '—' ? `ULIS: ${bot.lastUlis}` : undefined}
        />
        <StatCard label="Regime" value={bot.currentRegime || 'NEUTRAL'} sub={`ATR: ${((bot.currentATR || 0) * 100).toFixed(2)}%`} />
      </div>

      {/* Bot Reasoning */}
      <div className="bg-[#0d1117] border border-[#21262d] rounded-lg p-3">
        <span className="text-[10px] uppercase tracking-wider text-[#8b949e]">Bot Reasoning</span>
        <p className="text-xs font-mono text-[#c9d1d9] mt-1 leading-relaxed whitespace-pre-wrap">
          {bot.lastAnalysis || 'Waiting for market data...'}
        </p>
      </div>

      {/* Gate Rejection Breakdown */}
      <div className="bg-[#0d1117] border border-[#21262d] rounded-lg p-3">
        <span className="text-[10px] uppercase tracking-wider text-[#8b949e]">
          Gate Rejections ({topGates.length > 0 ? topGates.reduce((s, [, v]) => s + v, 0) : 0} total)
        </span>
        <div className="flex flex-col gap-1.5 mt-2">
          {topGates.map(([name, count]) => (
            <GateBar key={name} name={name.replace(/_/g, ' ')} count={count} max={maxGate} />
          ))}
          {topGates.length === 0 && (
            <span className="text-[10px] text-[#484f58] font-mono">No rejections yet</span>
          )}
        </div>
      </div>

      {/* Live Market Snapshot */}
      <div className="bg-[#0d1117] border border-[#21262d] rounded-lg p-3">
        <span className="text-[10px] uppercase tracking-wider text-[#8b949e]">Live Market</span>
        <div className="grid grid-cols-4 gap-2 mt-2">
          <span className="text-[10px] text-[#8b949e]">Price</span>
          <span className="text-[10px] font-mono text-white col-span-3">${metrics?.price?.toFixed?.(2) || '—'}</span>
          <span className="text-[10px] text-[#8b949e]">CVD Trend</span>
          <span className="text-[10px] font-mono text-white col-span-3">{metrics?.cvdContext?.trend || '—'} ({metrics?.cvdContext?.value?.toFixed?.(0) || '—'})</span>
          <span className="text-[10px] text-[#8b949e]">Divergence</span>
          <span className="text-[10px] font-mono text-white col-span-3">{metrics?.cvdContext?.divergence || '—'}</span>
          <span className="text-[10px] text-[#8b949e]">Skew</span>
          <span className="text-[10px] font-mono text-white col-span-3">{metrics?.skewness?.toFixed?.(3) || '—'}</span>
        </div>
      </div>

      {/* Trade Stats */}
      <div className="grid grid-cols-3 gap-2">
        <StatCard label="Trades" value={bot.totalTrades || 0} />
        <StatCard label="Active" value={bot.activePositions || 0} color={(bot.activePositions || 0) > 0 ? 'text-green-400' : 'text-[#8b949e]'} />
        <StatCard label="P&L" value={`$${(bot.globalSessionPnl || 0).toFixed(2)}`} color={(bot.globalSessionPnl || 0) >= 0 ? 'text-green-400' : 'text-red-400'} />
      </div>
    </motion.div>
  );
};

export default BotMindView;
