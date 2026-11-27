import React, { useEffect, useState } from 'react';
import { Timer, Sparkles } from 'lucide-react';
import { useStore } from '../store';

/** Small countdown shown while the one-shot Pro demo is active. */
const TrialBanner: React.FC = () => {
  const trialUntil = useStore(s => s.auth.trialUntil);
  const setActiveTab = useStore(s => s.setActiveTab);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (!trialUntil) return;
    const id = setInterval(() => setNow(Date.now()), 10000);
    return () => clearInterval(id);
  }, [trialUntil]);

  if (!trialUntil || trialUntil <= now) return null;
  const mins = Math.max(1, Math.ceil((trialUntil - now) / 60000));

  return (
    <div className="pointer-events-none fixed right-4 bottom-24 lg:bottom-auto lg:top-20 z-[60]">
      <div className="pointer-events-auto flex items-center gap-3 rounded-xl border border-brand-accent/30 bg-[#0b1220]/95 px-3 py-2 shadow-xl backdrop-blur-md">
        <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-brand-accent/15 text-brand-accent">
          <Timer size={14} />
        </span>
        <div className="leading-tight">
          <div className="text-[11px] font-bold text-white">Pro demo · {mins} min left</div>
          <div className="font-mono text-[9px] text-slate-500">every desk unlocked</div>
        </div>
        <button
          onClick={() => setActiveTab('pricing')}
          className="ml-1 flex items-center gap-1 rounded-lg bg-brand-accent px-2.5 py-1.5 text-[10px] font-bold text-white hover:bg-brand-accent/90"
        >
          <Sparkles size={11} /> Keep it
        </button>
      </div>
    </div>
  );
};

export default TrialBanner;
