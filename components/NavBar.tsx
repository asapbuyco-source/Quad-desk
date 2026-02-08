import React from 'react';
import { LayoutGrid, BarChart2, Radio, Hexagon, Settings, Wallet, CandlestickChart, BookOpen } from 'lucide-react';

interface NavBarProps {
  activeTab: string;
  setActiveTab: (tab: string) => void;
}

const NavBar: React.FC<NavBarProps> = ({ activeTab, setActiveTab }) => {
  const tabs = [
    { id: 'dashboard', icon: LayoutGrid, label: 'Desk' },
    { id: 'charting', icon: CandlestickChart, label: 'Chart' },
    { id: 'analytics', icon: BarChart2, label: 'Data' },
    { id: 'intel', icon: Radio, label: 'Intel' },
    { id: 'guide', icon: BookOpen, label: 'Guide' },
  ];

  return (
    <>
      {/* Desktop Floating Dock */}
      <div className="hidden lg:flex flex-col w-20 h-[96vh] my-auto ml-4 fintech-card items-center py-6 z-50">
        <div className="mb-8 text-brand-accent">
            <Hexagon size={28} strokeWidth={2} className="drop-shadow-lg" />
        </div>

        <div className="flex flex-col gap-4 w-full px-2">
          {tabs.map((tab) => {
            const isActive = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                aria-label={`Switch to ${tab.label} tab`}
                className={`
                  relative flex flex-col items-center justify-center gap-1 w-full aspect-square rounded-xl transition-all duration-300 group
                  ${isActive ? 'bg-brand-accent shadow-[0_0_20px_rgba(59,130,246,0.4)]' : 'hover:bg-white/5 text-slate-400'}
                `}
              >
                <tab.icon 
                  size={22} 
                  strokeWidth={2}
                  className={isActive ? 'text-white' : 'text-slate-400'} 
                />
                
                {/* Tooltip */}
                <span className="absolute left-14 bg-black/80 backdrop-blur px-2 py-1 rounded text-[10px] font-bold uppercase text-white opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none whitespace-nowrap border border-white/10 z-50">
                    {tab.label}
                </span>
              </button>
            )
          })}
        </div>

        <div className="mt-auto flex flex-col gap-4 w-full px-2">
           <button aria-label="Wallet" className="w-full aspect-square flex items-center justify-center rounded-xl hover:bg-white/5 text-slate-400 transition-colors">
              <Wallet size={20} />
           </button>
           <button aria-label="Settings" className="w-full aspect-square flex items-center justify-center rounded-xl hover:bg-white/5 text-slate-400 transition-colors">
              <Settings size={20} />
           </button>
        </div>
      </div>

      {/* Mobile Floating Bottom Bar */}
      <div className="lg:hidden fixed bottom-6 left-6 right-6 h-16 fintech-card flex items-center justify-around z-50 px-2 shadow-2xl">
        {tabs.map((tab) => {
           const isActive = activeTab === tab.id;
           return (
             <button 
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                aria-label={`Switch to ${tab.label} tab`}
                className={`
                    relative flex items-center justify-center w-12 h-12 rounded-full transition-all
                    ${isActive ? 'bg-brand-accent text-white shadow-lg shadow-brand-accent/30' : 'text-slate-400'}
                `}
             >
                <tab.icon size={20} strokeWidth={2} />
             </button>
           )
        })}
      </div>
    </>
  );
};

export default NavBar;