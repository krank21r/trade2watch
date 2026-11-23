'use client'

import { useState, useEffect } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { Bell, TrendingUp } from 'lucide-react'
import { SignalDashboard } from '@/components/signals/SignalDashboard'
import LiquidityLab from '@/components/liquidity/LiquidityLab'
import { ThemeToggle } from '@/components/theme-toggle'
import { UserMenu } from '@/components/user-menu'
import { useSignalNotifier } from '@/hooks/use-signal-notifier'

type Tab = 'signals' | 'liquidity'

const TABS: Array<{ key: Tab; label: string; short: string }> = [
  { key: 'signals', label: 'AI Signals', short: 'Signals' },
  { key: 'liquidity', label: 'Liquidity Lab', short: 'Liquidity' },
]

export default function Home() {
  const [tab, setTab] = useState<Tab>('signals')
  // app-wide signal watcher — new desk results toast + desktop-notify on ANY
  // tab and feed the header bell badge; the dashboard handles its own toasts
  // while the AI Signals tab is open (the watcher stays quiet there)
  const { unread, markSeen } = useSignalNotifier(tab === 'signals')

  // opening AI Signals = everything up to now has been seen
  useEffect(() => {
    if (tab === 'signals') markSeen()
  }, [tab, markSeen])

  return (
    <div className="relative h-[100dvh] flex flex-col bg-tv-bg text-tv-ink overflow-hidden">
      {/* top bar — flat hairline chrome, color reserved for the data.
          mobile: two rows (brand+account, then tabs); sm+: single row */}
      <nav className="relative z-10 shrink-0 flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-4 px-4 sm:px-6 py-3 border-b border-tv-line">
        {/* mobile row 1 = brand + status/account; sm:contents dissolves the
            wrapper so its children become direct nav flex items again */}
        <div className="flex w-full items-center justify-between sm:contents">
          {/* brand — ink monogram tile, quiet wordmark */}
          <div className="flex items-center gap-2.5 sm:order-1">
            <span
              className="inline-flex h-7 w-7 items-center justify-center rounded-lg bg-tv-ink text-tv-bg"
              aria-hidden
            >
              <TrendingUp className="h-4 w-4" aria-hidden />
            </span>
            <div className="text-[15px] font-semibold tracking-tight leading-none">
              Trade2watch
            </div>
          </div>

          {/* status + account */}
          <div className="flex items-center gap-2 sm:gap-2.5 text-xs text-tv-muted sm:order-3 sm:ml-auto">
            <button
              onClick={() => {
                markSeen()
                setTab('signals')
              }}
              aria-label={`AI signal alerts${unread > 0 ? ` — ${unread} new` : ''}`}
              title="AI signal alerts — the desk notifies you here the moment a new plan is ready"
              className="relative inline-flex h-7 w-7 items-center justify-center rounded-lg border border-tv-line bg-tv-inset text-tv-muted transition hover:text-tv-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bull/50"
            >
              <Bell className="h-3.5 w-3.5" aria-hidden />
              {unread > 0 && (
                <span
                  className="absolute inline-flex items-center justify-center rounded-full bg-bull px-1 text-[9px] font-bold leading-none text-white tabular-nums"
                  style={{ top: -4, right: -4, minWidth: 15, height: 15 }}
                  aria-hidden
                >
                  {unread > 9 ? '9+' : unread}
                </span>
              )}
            </button>
            <span className="hidden md:inline-flex items-center gap-2">
              <span className="inline-block w-1.5 h-1.5 rounded-full bg-bull" aria-hidden />
              <span className="tabular-nums">Live</span>
            </span>
            <UserMenu />
            <ThemeToggle />
          </div>
        </div>

        {/* segmented tabs — neutral; active = ink on inset surface.
            mobile: full-width row 2 with short labels; both tabs fit at 390px */}
        <div
          role="tablist"
          aria-label="Sections"
          className="flex w-full sm:w-auto sm:order-2 max-w-full items-center overflow-x-auto rounded-lg border border-tv-line bg-tv-inset p-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
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
                className="btn relative shrink-0 rounded-[0.4375rem] px-3 sm:px-3.5 py-1.5 text-[12.5px] sm:text-[13px]"
              >
                {active && (
                  <motion.span
                    layoutId="tab-pill"
                    transition={{ type: 'spring', stiffness: 400, damping: 32 }}
                    className="absolute inset-0 rounded-[0.4375rem] border border-tv-line bg-tv-panel shadow-xs"
                  />
                )}
                <span
                  className={`relative z-10 whitespace-nowrap transition-colors ${
                    active ? 'text-tv-ink' : 'text-tv-muted hover:text-tv-ink'
                  }`}
                >
                  {/* short label on mobile; display:none spans are excluded
                      from the a11y tree so the accessible name is correct */}
                  <span className="sm:hidden">{t.short}</span>
                  <span className="hidden sm:inline">{t.label}</span>
                </span>
              </button>
            )
          })}
        </div>
      </nav>

      {/* content */}
      <main className="relative z-10 flex-1 min-h-0">
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={tab}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.2, ease: 'easeOut' }}
            className="absolute inset-0 overflow-y-auto"
          >
            {tab === 'signals' ? <SignalDashboard /> : <LiquidityLab />}
          </motion.div>
        </AnimatePresence>
      </main>

      {/* status footer — pinned to the bottom of the shell */}
      <footer className="relative z-10 mt-auto shrink-0 flex items-center justify-between gap-3 px-4 sm:px-6 py-2.5 border-t border-tv-line text-[11px] text-tv-muted2">
        <span className="truncate">Research tool — not financial advice</span>
        <span className="hidden sm:block shrink-0 tabular-nums">Bybit · Binance · Yahoo Finance</span>
      </footer>
    </div>
  )
}
