import React from 'react';
import { Bot } from 'lucide-react';
import { useStore } from '../store';

/** Fixed entry point to the AI workspace. */
const AIAssistant: React.FC = () => {
  const activeTab = useStore(s => s.ui.activeTab);
  const setActiveTab = useStore(s => s.setActiveTab);
  if (activeTab === 'ai') return null;

  return (
    <button
      onClick={() => setActiveTab('ai')}
      aria-label="Open AI workspace"
      title="Open AI workspace"
      className="fixed right-4 bottom-24 lg:bottom-20 z-[65] flex h-12 w-12 items-center justify-center rounded-full bg-gradient-to-tr from-brand-accent to-purple-500 text-white shadow-[0_10px_30px_-8px_rgba(59,130,246,0.8)] transition-transform hover:scale-105 active:scale-95"
    >
      <Bot size={21} />
    </button>
  );
};

export default AIAssistant;
