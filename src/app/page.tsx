'use client'

import { useState } from 'react'
import { SignalDashboard } from '@/components/signals/SignalDashboard'

type Tab = 'classic' | 'signals'

export default function Home() {
  const [tab, setTab] = useState<Tab>('signals')

  return (
    <div className="h-[100dvh] flex flex-col bg-[#0b0e14] text-[#e6e9f0] overflow-hidden">
      {/* shell nav — matches Trade2watch styling */}
      <nav className="shrink-0 flex items-center gap-1.5 flex-wrap px-5 py-3 border-b border-[#232b3d] bg-[#0b0e14]">
        <div className="text-lg font-extrabold tracking-wide mr-4">
          Trade<b className="text-[#f5b544]">2watch</b>
        </div>
        {(
          [
            { key: 'signals', label: '⚡ AI Signals' },
            { key: 'classic', label: 'Trade Setups' },
          ] as Array<{ key: Tab; label: string }>
        ).map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            aria-current={tab === t.key ? 'page' : undefined}
            suppressHydrationWarning
            className={`px-4 py-2 rounded-full text-[13px] font-semibold border transition-colors ${
              tab === t.key
                ? 'bg-[#1a2030] text-[#f5b544] border-[rgba(245,181,68,.45)]'
                : 'bg-transparent text-[#8b93a7] border-[#232b3d] hover:text-[#e6e9f0] hover:border-[#3a4560]'
            }`}
          >
            {t.label}
          </button>
        ))}
        <div className="ml-auto flex items-center gap-1.5 text-xs text-[#8b93a7]">
          <span
            className="inline-block w-2 h-2 rounded-full"
            style={{ background: tab === 'signals' ? '#26a69a' : '#4a9eff' }}
          />
          {tab === 'signals' ? 'AI desk ready' : 'Live setups'}
        </div>
      </nav>

      {/* content */}
      <main className="flex-1 min-h-0 relative">
        {tab === 'classic' ? (
          <iframe
            src="/app.html"
            title="Trade2watch — Multi-Asset Trade Setup Dashboard"
            className="absolute inset-0 h-full w-full border-0"
            allow="autoplay"
          />
        ) : (
          <div className="absolute inset-0 overflow-y-auto">
            <SignalDashboard />
          </div>
        )}
      </main>
    </div>
  )
}
