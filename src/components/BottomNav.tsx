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
  `relative flex min-h-[60px] min-w-[72px] flex-1 flex-col items-center justify-center gap-1 py-2 text-[12px] font-medium transition-colors duration-[140ms] ${
    active
      ? "text-[var(--accent-text,#F59E0B)] before:absolute before:top-0 before:h-[2px] before:w-8 before:rounded-full before:bg-[var(--accent,#F59E0B)] before:content-['']"
      : 'text-[var(--text-secondary,#9CA3AF)] hover:text-[var(--text-primary,#F3F4F6)]'
  }`;

export function BottomNav({ activeTab, onVault, onStudio, onShiso, onMore }: BottomNavProps) {
  return (
    <nav
      aria-label="Mobile primary"
      className="fixed inset-x-0 bottom-0 z-40 flex h-[76px] items-stretch border-t border-[var(--border-subtle,rgba(255,255,255,0.08))] bg-[var(--bg-header,#111111)] pb-[env(safe-area-inset-bottom)] lg:hidden md:h-20"
    >
      <button type="button" aria-current={activeTab === 'grid' ? 'page' : undefined} className={item(activeTab === 'grid')} onClick={onVault}>
        <LayoutGrid className="w-5 h-5" /> Vault
      </button>
      <button type="button" aria-current={activeTab === 'providers' ? 'page' : undefined} className={item(activeTab === 'providers')} onClick={onStudio}>
        <BrainCircuit className="w-5 h-5" /> AI Studio
      </button>
      <button type="button" className={item(false)} onClick={onShiso}>
        <MessageCircle className="w-5 h-5" /> SHISO
      </button>
      <button type="button" aria-haspopup="dialog" className={item(false)} onClick={onMore}>
        <MoreHorizontal className="w-5 h-5" /> More
      </button>
    </nav>
  );
}
