'use client'

/**
 * EntryDecisionsTab — the standalone "what do I do right now?" menu item.
 *
 * Renders the fused Entry Decisions panel full-width as its own tab. The
 * watchlist is the shared, persisted list (same source the Trade Setups tab
 * manages via localStorage), so the two menus always agree on symbols.
 *
 * "Open full setup" on a card hands the symbol back to the shell, which
 * switches to the Trade Setups tab and drops that symbol's detail open.
 */

import { useEffect, useState } from 'react'
import { Crosshair } from 'lucide-react'
import { EntryDecisions } from '@/components/entry/EntryDecisions'
import { DEFAULT_WATCHLIST, loadWatchlist, fetchServerWatchlist } from '@/lib/watchlist'

export function EntryDecisionsTab({ onOpen }: { onOpen: (symbol: string) => void }) {
  const [symbols, setSymbols] = useState<string[]>(DEFAULT_WATCHLIST)

  // restore the shared watchlist after mount — deliberately NOT a lazy useState
  // initializer: the persisted list is browser-only state, and reading it during
  // the first render would produce server/client hydration mismatches. The
  // account's server list then wins when one exists (cross-device sync).
  useEffect(() => {
    let cancelled = false
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSymbols(loadWatchlist())
    void fetchServerWatchlist().then((server) => {
      if (!cancelled && server) setSymbols(server)
    })
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <div className="min-h-full mx-auto flex w-full max-w-[1400px] flex-col gap-4 px-4 py-5 sm:px-6 sm:py-6">
      {/* tab header — quiet, same rhythm as the other tabs */}
      <div className="flex flex-wrap items-center gap-2.5">
        <span
          className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-xl border border-tv-line bg-tv-panel2 text-tv-muted"
          aria-hidden
        >
          <Crosshair className="h-4 w-4" aria-hidden />
        </span>
        <div className="min-w-0">
          <h1 className="text-[15px] font-semibold tracking-tight text-tv-ink leading-tight">
            Entry decisions
          </h1>
          <p className="text-[11.5px] text-tv-muted leading-snug">
            One fused call per watchlist symbol — Trade Setups × AI Signals × Liquidity Lab.
          </p>
        </div>
        <span className="ml-auto hidden sm:inline-flex rounded-full border border-tv-line bg-tv-panel2 px-2.5 py-1 text-[10.5px] font-semibold text-tv-muted">
          Open a card&apos;s full setup in Trade Setups
        </span>
      </div>

      <EntryDecisions symbols={symbols} onOpen={onOpen} />
    </div>
  )
}
