
import React from 'react';
import { PeriodType } from '../types';

interface PeriodSelectorProps {
  currentPeriod: PeriodType;
  onPeriodChange: (period: PeriodType) => void;
}

const PeriodSelector: React.FC<PeriodSelectorProps> = ({ currentPeriod, onPeriodChange }) => {
  const periods: PeriodType[] = ['20-DAY', '20-HOUR', '20-PERIOD'];

  return (
    <div className="flex items-center gap-0.5 bg-black/20 p-0.5 rounded-lg border border-white/5">
      {periods.map(period => (
        <button
          key={period}
          onClick={() => onPeriodChange(period)}
          className={`
            px-1.5 py-0.5 text-[9px] font-bold rounded-md transition-all uppercase whitespace-nowrap
            ${currentPeriod === period ? 'bg-brand-accent text-white shadow-sm' : 'text-zinc-500 hover:text-zinc-300 hover:bg-white/5'}
          `}
        >
          {period}
        </button>
      ))}
    </div>
  );
};

export default PeriodSelector;
