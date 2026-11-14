import React, { useEffect, useRef, useState } from 'react';

const CONSENT_KEY = 'qd.consent';
const ADSENSE_CLIENT = (import.meta as any).env?.VITE_ADSENSE_CLIENT || '';

/**
 * Reserved ad slot that only renders when (a) an AdSense client id is
 * configured and (b) the visitor granted consent. Rendering nothing otherwise
 * avoids empty boxes and layout shift.
 */
interface Props {
  slot: string;
  format?: 'auto' | 'horizontal' | 'rectangle';
  className?: string;
  label?: string;
}

const AdSlot: React.FC<Props> = ({ slot, format = 'auto', className = '', label = 'Advertisement' }) => {
  const [consent, setConsent] = useState<string>(() => {
    try { return localStorage.getItem(CONSENT_KEY) || ''; } catch { return ''; }
  });
  const ref = useRef<HTMLModElement | null>(null);
  const pushed = useRef(false);

  useEffect(() => {
    const onConsent = (e: Event) => {
      setConsent((e as CustomEvent).detail || '');
    };
    window.addEventListener('qd-consent', onConsent as EventListener);
    return () => window.removeEventListener('qd-consent', onConsent as EventListener);
  }, []);

  const enabled = !!ADSENSE_CLIENT && consent === 'granted';

  useEffect(() => {
    if (!enabled) return;
    const src = `https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${ADSENSE_CLIENT}`;
    if (!document.querySelector(`script[src="${src}"]`)) {
      const s = document.createElement('script');
      s.src = src;
      s.async = true;
      s.crossOrigin = 'anonymous';
      document.head.appendChild(s);
    }
    if (!pushed.current) {
      try {
        const w = window as any;
        (w.adsbygoogle = w.adsbygoogle || []).push({});
        pushed.current = true;
      } catch { /* ad blocker or script not ready */ }
    }
  }, [enabled]);

  if (!enabled) return null;

  return (
    <div className={`w-full ${className}`}>
      <div className="mb-1 text-center text-[9px] uppercase tracking-widest text-slate-600">{label}</div>
      <ins
        ref={ref as any}
        className="adsbygoogle block"
        style={{ display: 'block' }}
        data-ad-client={ADSENSE_CLIENT}
        data-ad-slot={slot}
        data-ad-format={format}
        data-full-width-responsive="true"
      />
    </div>
  );
};

export default AdSlot;
