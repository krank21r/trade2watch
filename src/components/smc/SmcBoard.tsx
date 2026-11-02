'use client'

// ─── SMC board — compact signal-card grid ───────────────────────────────────
// The board IS the cards: one compact card per pair from
// GET /api/smc/scan?mode=… (full engine per pair, dual-tape Bybit × Binance,
// 30s server cache) polled every 45s. Live signals sort to the top; watchlist
// next; no-trade cards stay quiet. All secondary panels (gates, score
// breakdown, building blocks, backtest, journal) were deliberately removed —
// the user asked for signals on compact cards only. If the engine is
// unavailable the board shows a dedicated DATA UNAVAILABLE panel — never
// stale or faked data (§62).

import { useCallback, useEffect, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import { SmcSignalCard } from './SmcSignalCard'
import { fmtClock } from './ui'
import type { SmcScanResponse, StrategyMode } from '@/lib/smc/types'

const POLL_MS = 45_000

const MODE_OPTIONS: StrategyMode[] = ['STRICT', 'BALANCED', 'AGGRESSIVE']
const MODE_HINT: Record<StrategyMode, string> = {
  STRICT: 'every gate — score ≥ 80 · rarest, highest confidence',
  BALANCED: 'skips the 5M trigger — score ≥ 75 · more signals',
  AGGRESSIVE: 'zone + structure only — score ≥ 70 · most signals',
}

/** deterministic sort: live signals first (score desc), then WATCHLIST, then NO_TRADE */
function signalRank(s: string): number {
  return s === 'LONG' || s === 'SHORT' ? 0 : s === 'WATCHLIST' ? 1 : 2
}

function Skeleton() {
  return (
    <div className="mx-auto flex min-h-full w-full max-w-[1400px] flex-col gap-4 px-4 py-5 sm:px-6 sm:py-6" aria-busy="true">
      <div className="h-16 animate-pulse rounded-2xl border border-tv-line bg-tv-panel" />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <div key={i} className="h-56 animate-pulse rounded-2xl border border-tv-line bg-tv-panel" />
        ))}
      </div>
    </div>
  )
}

function UnavailablePanel({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="mx-auto flex min-h-full w-full max-w-[1400px] flex-col justify-center px-4 py-8 sm:px-6">
      <section
        role="alert"
        className="mx-auto w-full max-w-xl rounded-3xl border border-bear/40 p-6 text-center sm:p-8"
        style={{ background: 'var(--bear-soft)' }}
      >
        <div className="text-3xl" aria-hidden="true">
          🛑
        </div>
        <h2 className="mt-2 text-lg font-extrabold tracking-tight text-bear">DATA UNAVAILABLE</h2>
        <p className="mx-auto mt-2 max-w-md break-words text-[12.5px] leading-relaxed text-tv-ink/90">{message}</p>
        <p className="mx-auto mt-2 max-w-md text-[11px] leading-relaxed text-tv-muted">
          The SMC engine shows nothing rather than stale or fake data — retry in a moment.
        </p>
        <button
          onClick={onRetry}
          suppressHydrationWarning
          className="mt-5 inline-flex min-h-[44px] items-center gap-2 rounded-xl border border-bear/40 bg-bear/10 px-5 text-[13px] font-bold text-bear transition hover:bg-bear/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bear/50"
        >
          ⟳ Retry now
        </button>
      </section>
    </div>
  )
}

export function SmcBoard() {
  const [scan, setScan] = useState<SmcScanResponse | null>(null)
  const [scanErr, setScanErr] = useState<string | null>(null)
  const [mode, setMode] = useState<StrategyMode>('STRICT')
  const [loading, setLoading] = useState(true)
  const [isMounted, setIsMounted] = useState(false)
  const mountedRef = useRef(true)
  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    setIsMounted(true)
    return () => {
      mountedRef.current = false
      abortRef.current?.abort()
    }
  }, [])

  const loadScan = useCallback(async () => {
    abortRef.current?.abort()
    const ctrl = new AbortController()
    abortRef.current = ctrl
    try {
      const res = await fetch(`/api/smc/scan?mode=${mode}`, { cache: 'no-store', signal: ctrl.signal })
      const body = (await res.json()) as SmcScanResponse | { ok: false; error: string }
      if (!mountedRef.current) return
      if (res.ok && body.ok) {
        setScan(body)
        setScanErr(null)
      } else {
        setScanErr(!body.ok ? body.error : `API ${res.status}`)
      }
    } catch (e) {
      if (!mountedRef.current) return
      if (e instanceof DOMException && e.name === 'AbortError') return
      setScanErr(String(e instanceof Error ? e.message : e).slice(0, 160))
    } finally {
      if (mountedRef.current && abortRef.current === ctrl) setLoading(false)
    }
  }, [mode])

  useEffect(() => {
    void loadScan()
    const t = setInterval(() => void loadScan(), POLL_MS)
    return () => clearInterval(t)
  }, [loadScan])

  const retry = useCallback(() => {
    setLoading(true)
    void loadScan()
  }, [loadScan])

  if (!scan) {
    if (loading) return <Skeleton />
    return <UnavailablePanel message={scanErr ?? 'SMC engine unreachable'} onRetry={retry} />
  }

  // ── derived (scan narrowed non-null) ──
  const rows = [...scan.rows].sort(
    (a, b) => signalRank(a.signal) - signalRank(b.signal) || b.score - a.score || a.symbol.localeCompare(b.symbol),
  )
  const liveCount = rows.filter((r) => r.signal === 'LONG' || r.signal === 'SHORT').length
  const watchCount = rows.filter((r) => r.signal === 'WATCHLIST').length

  return (
    <div className="mx-auto flex min-h-full w-full max-w-[1400px] flex-col gap-4 px-4 py-5 sm:px-6 sm:py-6">
      <span className="sr-only">
        SMC signal cards for {rows.length} pairs — live signals first. Each card: direction, price, entry zone, stop,
        targets and setup quality.
      </span>

      {/* ── header bar: title + counts + mode pills + refresh clock ── */}
      <motion.header
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.25, ease: 'easeOut' }}
        className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-2xl border border-tv-line bg-tv-panel shadow-sm px-4 py-3"
      >
        <div className="min-w-0">
          <h1 className="text-[15px] font-extrabold tracking-tight text-tv-ink">SMC Signals</h1>
          <p className="text-[10.5px] leading-tight text-tv-muted">Bybit × Binance dual-tape · 6 pairs</p>
        </div>

        <div className="flex items-center gap-1.5" role="status" aria-live="polite">
          {liveCount > 0 && (
            <span className="inline-flex items-center gap-1.5 rounded-full border border-bull/40 bg-bull/10 px-2.5 py-1 text-[10.5px] font-bold text-bull">
              <span className="relative flex h-1.5 w-1.5">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-bull/60" aria-hidden="true" />
                <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-bull" aria-hidden="true" />
              </span>
              {liveCount} live signal{liveCount > 1 ? 's' : ''}
            </span>
          )}
          {watchCount > 0 && (
            <span className="inline-flex items-center rounded-full border border-warn/35 bg-warn/10 px-2.5 py-1 text-[10.5px] font-bold text-warn">
              ⏳ {watchCount} watch
            </span>
          )}
        </div>

        <div className="ml-auto flex flex-wrap items-center gap-1.5" role="group" aria-label="Select strategy mode">
          {MODE_OPTIONS.map((m) => (
            <button
              key={m}
              onClick={() => {
                if (m !== mode) {
                  setMode(m)
                  setLoading(true)
                }
              }}
              aria-pressed={mode === m}
              title={MODE_HINT[m]}
              suppressHydrationWarning
              className={`inline-flex min-h-[44px] items-center rounded-full border px-3.5 py-2 text-[11.5px] font-bold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-warn/50 ${
                mode === m
                  ? 'border-warn/50 bg-warn/10 text-warn'
                  : 'border-tv-line bg-tv-panel2 text-tv-muted hover:border-tv-line-strong hover:text-tv-ink'
              }`}
            >
              {m}
            </button>
          ))}
        </div>

        <span className="w-full text-right text-[10.5px] tabular-nums text-tv-muted2 sm:w-auto" role="status">
          {loading ? 'refreshing…' : `auto 45s · ${isMounted ? fmtClock(scan.generatedAt) : '--:--:--'}`}
        </span>
      </motion.header>

      {/* a later poll failed but we still hold the last good scan */}
      {scanErr && (
        <div
          role="status"
          className="flex flex-wrap items-center gap-2 rounded-xl border border-bear/30 px-3 py-2.5 text-[12.5px]"
          style={{ background: 'var(--bear-soft)' }}
        >
          <span className="text-bear">
            Feed error: {scanErr} — showing the last good scan ({isMounted ? fmtClock(scan.generatedAt) : '--:--:--'}),
            retrying automatically.
          </span>
          <button
            onClick={retry}
            suppressHydrationWarning
            className="min-h-[44px] underline transition hover:text-tv-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bear/50"
          >
            Retry now
          </button>
        </div>
      )}

      {/* ── the cards — live first, watch next, quiet no-trade last ── */}
      <section aria-label="Signal cards" className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {rows.map((r, i) => (
          <motion.div
            key={r.symbol}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.22, ease: 'easeOut', delay: Math.min(i, 8) * 0.04 }}
            className="h-full"
          >
            <SmcSignalCard row={r} mounted={isMounted} />
          </motion.div>
        ))}
      </section>

      {/* one-line legend */}
      <p className="text-[11px] leading-relaxed text-tv-muted2">
        One card per pair — live signals on top. Levels: entry zone · stop · targets (R = risk units, 1R = stop
        distance). Score is setup quality, not a win probability. {scan.mode} mode.
      </p>

      {/* ── footer / disclaimer ── */}
      <footer className="mt-auto border-t border-tv-line pb-1 pt-3 text-[11px] leading-relaxed text-tv-muted">
        <b className="text-warn">Disclaimer:</b> research tool — not financial advice. Crypto is volatile; never trade
        money you can&apos;t afford to lose. Always re-validate levels before acting.
        <br />
        Data: Bybit public API + Binance public API (dual-tape cross-check) · analysis only — no auto-trading.
      </footer>
    </div>
  )
}
