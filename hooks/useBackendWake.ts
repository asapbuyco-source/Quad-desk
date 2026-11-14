import { useEffect, useRef, useState } from 'react';
import { API_BASE_URL } from '../constants';

export type WakeStatus = 'idle' | 'checking' | 'waking' | 'ready' | 'offline';

interface Options {
  /** Per-request timeout while probing /health. */
  timeoutMs?: number;
  /** Rough cold-start estimate shown as the countdown basis. */
  estimateS?: number;
}

/**
 * Detects a sleeping backend and keeps pinging it until it wakes.
 *
 * Render's free tier spins down after ~15 min idle; the first request cold-starts
 * in roughly 40-60s. We fire /health immediately (which triggers the wake), then
 * poll until it answers so the UI can show a countdown instead of failing silently.
 */
export function useBackendWake(enabled: boolean, opts: Options = {}) {
  const { timeoutMs = 6000, estimateS = 60 } = opts;
  const [status, setStatus] = useState<WakeStatus>('idle');
  const [elapsed, setElapsed] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const cancelled = useRef(false);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!enabled) { setStatus('idle'); return; }
    if (!API_BASE_URL) { setStatus('ready'); return; }  // backend not configured

    cancelled.current = false;
    setStatus('checking');
    setElapsed(0);
    setAttempt(0);
    const started = Date.now();

    const tick = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 500);

    const ping = async (): Promise<boolean> => {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const res = await fetch(`${API_BASE_URL}/health`, { signal: ctrl.signal, cache: 'no-store' });
        clearTimeout(t);
        return res.ok;
      } catch {
        clearTimeout(t);
        return false;
      }
    };

    const loop = async () => {
      const ok = await ping();
      if (cancelled.current) return;
      if (ok) { setStatus('ready'); return; }
      setStatus('waking');
      setAttempt(a => a + 1);
      if (Date.now() - started > 150000) { setStatus('offline'); return; }
      retryTimer.current = setTimeout(loop, 3000);
    };

    loop();
    return () => {
      cancelled.current = true;
      clearInterval(tick);
      if (retryTimer.current) clearTimeout(retryTimer.current);
    };
  }, [enabled, timeoutMs, nonce]);

  return {
    status,
    elapsed,
    attempt,
    estimateS,
    remaining: Math.max(0, estimateS - elapsed),
    retry: () => setNonce(n => n + 1),
  };
}
