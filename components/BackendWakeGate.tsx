import React from 'react';
import { Server, RotateCw, WifiOff } from 'lucide-react';
import { useStore } from '../store';
import { useBackendWake } from '../hooks/useBackendWake';

/**
 * Non-blocking status pill shown while the backend is cold-starting (Render
 * free tier sleeps). The app stays usable and each view shows its own loading
 * state; this only informs the user that data is still warming up.
 */
const BackendWakeGate: React.FC = () => {
  const authed = useStore(s => !!s.auth.user);
  const { status, elapsed, remaining, estimateS, retry } = useBackendWake(authed);

  if (status !== 'waking' && status !== 'offline') return null;

  const pct = Math.min(100, Math.round((elapsed / estimateS) * 100));
  const offline = status === 'offline';

  return (
    <div className="pointer-events-none fixed bottom-24 lg:bottom-4 right-4 z-[70] w-[260px] max-w-[calc(100vw-2rem)]">
      <div className="pointer-events-auto fintech-card p-3 shadow-2xl">
        <div className="flex items-start gap-2.5">
          <div className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${
            offline ? 'bg-rose-500/15 text-rose-400' : 'bg-brand-accent/15 text-brand-accent'
          }`}>
            {offline ? <WifiOff size={15} /> : <Server size={15} className="animate-pulse" />}
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-[11px] font-bold text-white">
              {offline ? 'Data server offline' : 'Waking data server'}
            </div>
            <div className="text-[10px] text-slate-400">
              {offline
                ? 'Live views show cached or demo data.'
                : `Background start · ~${remaining > 0 ? remaining : 0}s left`}
            </div>
            {!offline && (
              <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-slate-800">
                <div className="h-full rounded-full bg-brand-accent transition-[width] duration-500" style={{ width: `${pct}%` }} />
              </div>
            )}
          </div>
          {offline ? (
            <button onClick={retry} title="Retry"
              className="shrink-0 rounded-md border border-white/10 p-1 text-slate-300 hover:bg-white/5">
              <RotateCw size={12} />
            </button>
          ) : (
            <RotateCw size={12} className="mt-1 shrink-0 animate-spin text-slate-500" />
          )}
        </div>
        <div className="mt-1.5 font-mono text-[9px] text-slate-600">
          pinging /health · {elapsed}s · app stays usable
        </div>
      </div>
    </div>
  );
};

export default BackendWakeGate;
