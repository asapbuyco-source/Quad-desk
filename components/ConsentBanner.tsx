import React, { useEffect, useState } from 'react';
import { Cookie } from 'lucide-react';

const CONSENT_KEY = 'qd.consent';

export function getConsent(): string {
  try { return localStorage.getItem(CONSENT_KEY) || ''; } catch { return ''; }
}

/**
 * Minimal GDPR/CCPA-style consent banner. Non-essential scripts (ads/analytics)
 * only run after "Accept".
 */
const ConsentBanner: React.FC = () => {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    try {
      if (!localStorage.getItem(CONSENT_KEY)) {
        const t = setTimeout(() => setVisible(true), 1200);
        return () => clearTimeout(t);
      }
    } catch { /* storage blocked */ }
  }, []);

  const choose = (value: 'granted' | 'denied') => {
    try { localStorage.setItem(CONSENT_KEY, value); } catch { /* ignore */ }
    window.dispatchEvent(new CustomEvent('qd-consent', { detail: value }));
    setVisible(false);
  };

  if (!visible) return null;

  return (
    <div className="fixed bottom-4 left-4 right-4 z-[80] mx-auto max-w-xl">
      <div className="fintech-card flex flex-col gap-3 p-4 sm:flex-row sm:items-center">
        <Cookie size={18} className="shrink-0 text-brand-accent" />
        <p className="flex-1 text-[11px] leading-relaxed text-slate-400">
          We use essential cookies to run the terminal. With your permission we also use cookies for
          analytics and advertising on public pages.{' '}
          <a href="/privacy" className="text-brand-accent hover:underline">Privacy policy</a>
        </p>
        <div className="flex shrink-0 gap-2">
          <button
            onClick={() => choose('denied')}
            className="rounded-lg border border-white/10 px-3 py-1.5 text-[11px] font-semibold text-slate-300 hover:bg-white/5"
          >
            Essential only
          </button>
          <button
            onClick={() => choose('granted')}
            className="rounded-lg bg-brand-accent px-3 py-1.5 text-[11px] font-bold text-white hover:bg-brand-accent/90"
          >
            Accept
          </button>
        </div>
      </div>
    </div>
  );
};

export default ConsentBanner;
