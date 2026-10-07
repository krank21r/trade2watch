'use client'

import { useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { TrendingUp } from 'lucide-react'
import { SignalDashboard } from '@/components/signals/SignalDashboard'
import { SetupBoard } from '@/components/setups/SetupBoard'
import { ThemeToggle } from '@/components/theme-toggle'

type Tab = 'setups' | 'signals'

const TABS: Array<{ key: Tab; label: string }> = [
  { key: 'setups', label: 'Trade Setups' },
  { key: 'signals', label: '⚡ AI Signals' },
]

export default function Home() {
  const [tab, setTab] = useState<Tab>('setups')

  return (
    <div className="relative h-[100dvh] flex flex-col bg-tv-bg text-tv-ink overflow-hidden">
      {/* ambient top glow — theme-aware */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-56 opacity-70"
        style={{
          background: 'radial-gradient(60% 100% at 50% 0%, var(--warn-soft), transparent 70%)',
        }}
      />

      {/* top bar */}
      <nav className="relative z-10 shrink-0 flex items-center gap-2 sm:gap-3 flex-wrap px-3 sm:px-5 py-2.5 border-b border-tv-line bg-tv-bg/80 backdrop-blur-xl">
        {/* brand */}
        <div className="flex items-center gap-2.5 mr-1 sm:mr-3">
          <span className="inline-flex h-8 w-8 items-center justify-center rounded-xl bg-warn/15 border border-warn/30 text-warn">
            <TrendingUp className="h-4.5 w-4.5" aria-hidden />
          </span>
          <div className="text-base sm:text-lg font-extrabold tracking-tight leading-none">
            Trade<b className="text-warn">2watch</b>
          </div>
        </div>

        {/* segmented tabs */}
        <div
          role="tablist"
          aria-label="Sections"
          className="flex items-center rounded-full border border-tv-line bg-tv-panel2 p-1"
        >
          {TABS.map((t) => {
            const active = tab === t.key
            return (
              <button
                key={t.key}
                role="tab"
                aria-selected={active}
                aria-current={active ? 'page' : undefined}
                onClick={() => setTab(t.key)}
                suppressHydrationWarning
                className={`relative rounded-full px-3.5 sm:px-4 py-1.5 text-[12.5px] sm:text-[13px] font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-warn/50 ${
                  active ? 'text-warn' : 'text-tv-muted hover:text-tv-ink'
                }`}
              >
                {active && (
                  <motion.span
                    layoutId="tab-pill"
                    transition={{ type: 'spring', stiffness: 400, damping: 32 }}
                    className="absolute inset-0 rounded-full border border-tv-line-strong/60 bg-tv-panel shadow-sm"
                  />
                )}
                <span className="relative z-10 whitespace-nowrap">{t.label}</span>
              </button>
            )
          })}
        </div>

        {/* status + theme */}
        <div className="ml-auto flex items-center gap-2 sm:gap-2.5 text-xs text-tv-muted">
          <span className="hidden sm:inline-flex items-center gap-1.5">
            <span
              className="inline-block w-2 h-2 rounded-full animate-pulse"
              style={{ background: tab === 'signals' ? 'var(--bull)' : 'var(--warn)' }}
            />
            {tab === 'signals' ? 'AI desk ready' : 'Live setups'}
          </span>
          <ThemeToggle />
        </div>
      </nav>

      {/* content */}
      <main className="relative z-10 flex-1 min-h-0">
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={tab}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.22, ease: 'easeOut' }}
            className="absolute inset-0 overflow-y-auto"
          >
            {tab === 'setups' ? <SetupBoard /> : <SignalDashboard />}
          </motion.div>
        </AnimatePresence>
      </main>

      {/* status footer — always pinned to the bottom of the shell */}
      <footer className="relative z-10 shrink-0 flex items-center justify-between gap-3 px-3 sm:px-5 py-2 border-t border-tv-line bg-tv-bg/80 backdrop-blur-xl text-[11px] text-tv-muted">
        <span className="hidden sm:block truncate">
          Live data · Binance · Yahoo Finance · setups refresh every 45s
        </span>
        <span className="sm:hidden truncate">Trade2watch</span>
        <span className="shrink-0">Research tool — not financial advice</span>
      </footer>
    </div>
  )
}
