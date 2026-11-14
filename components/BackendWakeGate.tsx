import React from 'react';
import { Server, RotateCw, WifiOff } from 'lucide-react';
import { useStore } from '../store';
import { useBackendWake } from '../hooks/useBackendWake';

/**
 * Shown while the backend is cold-starting (Render free tier sleeps).
 * Fires the wake request itself and counts down until /health answers.
 */
const BackendWakeGate: React.FC = () => {
  const authed = useStore(s => !!s.auth.user);
  const { status, elapsed, remaining, estimateS, retry } = useBackendWake(authed);

  if (status !== 'waking' && status !== 'offline') return null;

  const pct = Math.min(100, Math.round((elapsed / estimateS) * 100));
  const offline = status === 'offline';

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
      <div className="fintech-card w-full max-w-sm p-6 text-center">
        <div className={`mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl ${
          offline ? 'bg-rose-500/15 text-rose-400' : 'bg-brand-accent/15 text-brand-accent'
        }`}>
          {offline ? <WifiOff size={26} /> : <Server size={26} className={offline ? '' : 'animate-pulse'} />}
        </div>

        <h2 className="text-base font-bold text-white">
          {offline ? 'Server did not wake' : 'Waking the data server'}
        </h2>
        <p className="mt-1 text-xs text-slate-400">
          {offline
            ? 'The backend is not responding. You can retry, or keep using the free live market data.'
            : `The free tier sleeps when idle. This usually takes ${estimateS}s or less.`}
        </p>

        {!offline && (
          <>
            {/* Countdown */}
            <div className="mt-5 font-mono text-4xl font-black tabular-nums text-white">
              {remaining > 0 ? remaining : 0}<span className="text-lg text-slate-500">s</span>
            </div>
            <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-slate-800">
              <div
                className="h-full rounded-full bg-brand-accent transition-[width] duration-500"
                style={{ width: `${pct}%` }}
              />
            </div>
            <div className="mt-2 flex items-center justify-center gap-2 font-mono text-[10px] text-slate-500">
              <RotateCw size={11} className="animate-spin" />
              pinging /health · {elapsed}s elapsed
            </div>
            {elapsed > estimateS && (
              <p className="mt-2 text-[10px] text-slate-500">Taking longer than usual — still trying…</p>
            )}
          </>
        )}

        {offline && (
          <button
            onClick={retry}
            className="mt-5 inline-flex items-center gap-2 rounded-lg bg-brand-accent px-4 py-2 text-xs font-bold text-white hover:bg-brand-accent/90"
          >
            <RotateCw size={14} /> Try again
          </button>
        )}
      </div>
    </div>
  );
};

export default BackendWakeGate;
