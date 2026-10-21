'use client'

import { useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { TrendingUp } from 'lucide-react'
import { SignalDashboard } from '@/components/signals/SignalDashboard'
import { SetupBoard } from '@/components/setups/SetupBoard'
import { TraderDesk } from '@/components/trader/TraderDesk'
import { ThemeToggle } from '@/components/theme-toggle'
import { UserMenu } from '@/components/user-menu'

type Tab = 'setups' | 'signals' | 'trader'

const TABS: Array<{ key: Tab; label: string }> = [
  { key: 'setups', label: 'Trade Setups' },
  { key: 'signals', label: '⚡ AI Signals' },
  { key: 'trader', label: '🧢 Trader Desk' },
]

export default function Home() {
  const [tab, setTab] = useState<Tab>('setups')

  return (
    <div className="relative h-[100dvh] flex flex-col bg-tv-bg text-tv-ink overflow-hidden">
      {/* design-canvas backdrop — faint 28px slate grid on white */}
      <div aria-hidden className="t2w-grid-bg pointer-events-none absolute inset-0" />

      {/* top bar */}
      <nav className="relative z-10 shrink-0 flex items-center gap-2 sm:gap-3 flex-wrap px-3 sm:px-5 py-2.5 border-b border-tv-line bg-tv-panel/90 backdrop-blur-xl">
        {/* brand — emerald logo tile, extrabold wordmark */}
        <div className="flex items-center gap-2.5 mr-1 sm:mr-3">
          <span className="btn inline-flex h-8 w-8 items-center justify-center rounded-xl bg-bull text-white shadow-sm hover:bg-bull-deep active:bg-bull-ink">
            <TrendingUp className="h-4.5 w-4.5" aria-hidden />
          </span>
          <div className="text-base sm:text-lg font-extrabold tracking-tight leading-none">
            Trade<b className="text-bull">2watch</b>
          </div>
        </div>

        {/* segmented tabs — .btn primitive, horizontally scrollable on narrow screens */}
        <div
          role="tablist"
          aria-label="Sections"
          className="flex max-w-full items-center overflow-x-auto rounded-xl border border-tv-line bg-tv-panel2/70 p-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
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
                className="btn relative shrink-0 rounded-[0.5rem] px-3.5 sm:px-4 py-1.5 text-[12.5px] sm:text-[13px] font-semibold"
              >
                {active && (
                  <motion.span
                    layoutId="tab-pill"
                    transition={{ type: 'spring', stiffness: 400, damping: 32 }}
                    className="absolute inset-0 rounded-[0.5rem] border border-bull-line bg-bull-soft"
                  />
                )}
                <span className={`relative z-10 whitespace-nowrap transition-colors ${active ? 'text-bull-ink' : 'text-tv-muted hover:text-tv-ink'}`}>
                  {t.label}
                </span>
              </button>
            )
          })}
        </div>

        {/* status + theme */}
        <div className="ml-auto flex items-center gap-2 sm:gap-2.5 text-xs text-tv-muted">
          <span className="hidden sm:inline-flex items-center gap-1.5">
            <span
              className="inline-block w-2 h-2 rounded-full animate-pulse"
              style={{ background: 'var(--bull)' }}
            />
            {tab === 'setups' ? 'Live setups + confirmations' : tab === 'signals' ? 'AI desk ready' : 'Paper trading desk ready'}
          </span>
          <UserMenu />
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
            {tab === 'setups' ? <SetupBoard /> : tab === 'signals' ? <SignalDashboard /> : <TraderDesk />}
          </motion.div>
        </AnimatePresence>
      </main>

      {/* status footer — always pinned to the bottom of the shell */}
      <footer className="relative z-10 shrink-0 flex items-center justify-between gap-3 px-3 sm:px-5 py-2 border-t border-tv-line bg-tv-panel/90 backdrop-blur-xl text-[11px] text-tv-muted">
        <span className="hidden sm:block truncate">
          Live data · Bybit · Binance · Yahoo Finance · setups refresh every 45s · paper desk never places real orders
        </span>
        <span className="sm:hidden truncate">Trade2watch</span>
        <span className="shrink-0">Research tool — not financial advice</span>
      </footer>
    </div>
  )
}
