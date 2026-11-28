import React from 'react';
import { Sparkles } from 'lucide-react';
import { PageHeader } from './Premium';
import AIChart from './AIChart';
import AIChatPanel from './AIChatPanel';

const AIWorkspace: React.FC = () => (
  <div className="h-full overflow-y-auto p-5 lg:p-6 pb-28 lg:pb-6">
    <div className="mx-auto max-w-7xl">
      <PageHeader
        icon={<Sparkles size={16} />}
        title="AI Workspace"
        badge="FREE"
        subtitle="Talk to the assistant about this chart, the recorded feeds and the terminal. It reads live data before every answer."
        live
      />
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-5">
        <div className="premium-card flex h-[420px] flex-col overflow-hidden lg:col-span-3 lg:h-[calc(100dvh-220px)] lg:min-h-[460px]">
          <AIChart />
        </div>
        <div className="premium-card flex h-[560px] flex-col overflow-hidden lg:col-span-2 lg:h-[calc(100dvh-220px)] lg:min-h-[460px]">
          <AIChatPanel />
        </div>
      </div>
      <div className="mt-2 font-mono text-[9px] text-slate-600">
        Chart from the live candle stream · assistant answers use funding, open interest, liquidations, positioning and options where available · not investment advice
      </div>
    </div>
  </div>
);

export default AIWorkspace;
