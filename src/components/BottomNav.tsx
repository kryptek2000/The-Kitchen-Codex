import React from 'react';
import { LayoutGrid, BrainCircuit, MessageCircle, MoreHorizontal } from 'lucide-react';

interface BottomNavProps {
  activeTab: string;
  onVault: () => void;
  onStudio: () => void;
  onShiso: () => void;
  onMore: () => void;
}

const item = (active: boolean) =>
  `flex flex-col items-center justify-center gap-0.5 flex-1 py-2 text-[11px] font-medium transition-colors ${
    active ? 'text-amber-400' : 'text-gray-400'
  }`;

export function BottomNav({ activeTab, onVault, onStudio, onShiso, onMore }: BottomNavProps) {
  return (
    <nav
      aria-label="Mobile primary"
      className="md:hidden fixed bottom-0 left-0 right-0 z-40 bg-[#111111] border-t border-white/5 flex items-stretch h-16"
    >
      <button className={item(activeTab === 'grid')} onClick={onVault}>
        <LayoutGrid className="w-5 h-5" /> Vault
      </button>
      <button className={item(activeTab === 'providers')} onClick={onStudio}>
        <BrainCircuit className="w-5 h-5" /> AI Studio
      </button>
      <button className={item(false)} onClick={onShiso}>
        <MessageCircle className="w-5 h-5" /> SHISO
      </button>
      <button className={item(false)} onClick={onMore}>
        <MoreHorizontal className="w-5 h-5" /> More
      </button>
    </nav>
  );
}
