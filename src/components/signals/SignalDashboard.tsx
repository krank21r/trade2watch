'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import { SignalCard } from './SignalCard'
import { PipelinePanel } from './PipelinePanel'
import { ReportsPanel } from './ReportsPanel'
import { fmtPrice, type SignalRunDetail, type SignalRunRow } from './types'
import { useToast } from '@/hooks/use-toast'

const QUICK_PICKS: Array<{ symbol: string; market: 'crypto' | 'stock'; label: string }> = [
  { symbol: 'BTC', market: 'crypto', label: 'BTC' },
  { symbol: 'ETH', market: 'crypto', label: 'ETH' },
  { symbol: 'SOL', market: 'crypto', label: 'SOL' },
  { symbol: 'AAPL', market: 'stock', label: 'AAPL' },
  { symbol: 'TSLA', market: 'stock', label: 'TSLA' },
  { symbol: 'NVDA', market: 'stock', label: 'NVDA' },
]

function outcomeChip(outcome?: string | null): { label: string; color: string } {
  switch (outcome) {
    case 'TARGET1_HIT':
      return { label: '🎯 T1 hit', color: 'var(--bull)' }
    case 'TARGET2_HIT':
      return { label: '🚀 T2 hit', color: 'var(--bull)' }
    case 'STOP_HIT':
      return { label: '🛑 Stopped', color: 'var(--bear)' }
    case 'INVALIDATED':
      return { label: '⚠ Invalidated', color: 'var(--warn)' }
    default:
      return { label: 'Open', color: 'var(--tv-muted)' }
  }
}

function dirBadge(direction?: string | null): { label: string; bg: string; fg: string; border: string } | null {
  if (direction === 'LONG') return { label: 'LONG', bg: 'var(--bull-soft)', fg: 'var(--bull)', border: 'var(--bull-line)' }
  if (direction === 'SHORT') return { label: 'SHORT', bg: 'var(--bear-soft)', fg: 'var(--bear)', border: 'var(--bear-line)' }
  if (direction === 'NEUTRAL') return { label: 'WAIT', bg: 'var(--warn-soft)', fg: 'var(--warn)', border: 'var(--warn-line)' }
  return null
}

// ─── auto desk + entry alerts (client helpers) ──────────────────────────────

interface AutoStatus {
  enabled: boolean
  running: boolean
  intervalMs: number
  symbols: string[]
  bootedAt: string
  lastTickAt: string | null
  nextTickAt: string | null
  lastResult: { symbol: string; status: string; direction: string | null; confidence: number | null; runId: string; at: string } | null
  lastError: string | null
  runCount: number
  external: boolean
}

const ALERT_FRESH_MS = 36 * 60 * 60 * 1000 // signals older than 36h stop alerting
const NEAR_ZONE_PCT = 0.75 // "close to entry" threshold (% from zone edge)

interface EntryAlertView {
  run: SignalRunRow
  pctAway: number
}

/** Compute actionable entry states from signal history (price vs entry zone). */
function entryAlertViews(history: SignalRunRow[]): { active: EntryAlertView[]; near: EntryAlertView[]; waiting: number } {
  const now = Date.now()
  const active: EntryAlertView[] = []
  const near: EntryAlertView[] = []
  let waiting = 0
  for (const r of history) {
    if (r.status !== 'completed') continue
    if (r.direction !== 'LONG' && r.direction !== 'SHORT') continue
    if (r.outcome && r.outcome !== 'OPEN') continue
    if (r.entryLow === null || r.entryHigh === null) continue
    if (now - new Date(r.createdAt).getTime() > ALERT_FRESH_MS) continue
    const px = r.outcomePrice
    if (px === null || px === undefined || !Number.isFinite(px)) {
      waiting++
      continue
    }
    let pctAway: number
    if (px >= r.entryLow && px <= r.entryHigh) {
      pctAway = 0
    } else if (r.direction === 'LONG') {
      pctAway = px > r.entryHigh ? ((px - r.entryHigh) / px) * 100 : ((r.entryLow - px) / px) * 100
    } else {
      pctAway = px < r.entryLow ? ((r.entryLow - px) / px) * 100 : ((px - r.entryHigh) / px) * 100
    }
    if (pctAway <= 0) active.push({ run: r, pctAway: 0 })
    else if (pctAway <= NEAR_ZONE_PCT) near.push({ run: r, pctAway })
    else waiting++
  }
  return { active, near, waiting }
}

function fmtAgo(iso: string | null, now: number): string {
  if (!iso || !now) return ''
  const diff = now - new Date(iso).getTime()
  if (diff < 90_000) return 'just now'
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`
  if (diff < 48 * 3_600_000) return `${Math.round(diff / 3_600_000)}h ago`
  return `${Math.round(diff / (24 * 3_600_000))}d ago`
}

function fmtIn(iso: string | null, now: number): string {
  if (!iso || !now) return ''
  const diff = new Date(iso).getTime() - now
  if (diff <= 0) return 'due now'
  if (diff < 3_600_000) return `~${Math.max(1, Math.round(diff / 60_000))}m`
  return `~${Math.round(diff / 3_600_000)}h`
}

function placeholderRun(sym: string, mkt: 'crypto' | 'stock'): SignalRunDetail {
  return {
    id: 'pending',
    symbol: sym.toUpperCase(),
    market: mkt,
    displayName: null,
    status: 'running',
    stage: 'queued',
    progress: 3,
    error: null,
    priceAtRun: null,
    change24h: null,
    regime: null,
    timeframe: null,
    direction: null,
    confidence: null,
    entryLow: null,
    entryHigh: null,
    stop: null,
    target1: null,
    target2: null,
    runner: null,
    riskReward: null,
    invalidation: null,
    planNote: null,
    createdAt: new Date().toISOString(),
    completedAt: null,
    artifacts: null,
  }
}

export function SignalDashboard() {
  const [symbol, setSymbol] = useState('BTC')
  const [market, setMarket] = useState<'crypto' | 'stock'>('crypto')
  const [run, setRun] = useState<SignalRunDetail | null>(null)
  const [history, setHistory] = useState<SignalRunRow[]>([])
  const [starting, setStarting] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [auto, setAuto] = useState<AutoStatus | null>(null)
  const [autoBusy, setAutoBusy] = useState(false)
  const [clock, setClock] = useState(0) // client time for countdowns (avoids hydration drift)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const missesRef = useRef(0)
  const seenRef = useRef<Set<string> | null>(null) // run ids already toasted/seen
  const mountedAt = useRef(Date.now())
  const { toast } = useToast()

  const stopPolling = useCallback(() => {
    if (pollRef.current) clearInterval(pollRef.current)
    pollRef.current = null
  }, [])

  const loadHistory = useCallback(async () => {
    try {
      const res = await fetch('/api/signals?limit=15', { cache: 'no-store' })
      const d = await res.json()
      if (Array.isArray(d.runs)) setHistory(d.runs)
    } catch {
      /* history is non-critical */
    }
  }, [])

  const loadAuto = useCallback(async () => {
    try {
      const res = await fetch('/api/signals/auto', { cache: 'no-store' })
      const d = await res.json()
      if (d.status) setAuto(d.status)
    } catch {
      /* auto status is non-critical */
    }
  }, [])

  const toggleAuto = useCallback(async () => {
    try {
      const res = await fetch('/api/signals/auto', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !(auto?.enabled ?? true) }),
      })
      const d = await res.json()
      if (d.status) setAuto(d.status)
    } catch {
      /* non-critical */
    }
  }, [auto?.enabled])

  const runAutoNow = useCallback(async () => {
    setAutoBusy(true)
    try {
      const res = await fetch('/api/signals/auto/tick', { method: 'POST' })
      const d = await res.json()
      if (d.ran) {
        toast({
          title: `🤖 Auto desk — ${d.symbol} ${d.direction ?? d.status}`,
          description:
            d.status === 'completed'
              ? d.direction === 'NEUTRAL'
                ? `No edge detected — the desk stands aside on ${d.symbol}.`
                : `${d.direction} @ confidence ${d.confidence ?? '—'}% — the plan is in the signal view.`
              : `The ${d.symbol} analysis failed — the desk will retry.`,
          variant: d.status === 'completed' ? undefined : 'destructive',
        })
      }
    } catch {
      /* keep quiet — status poll will reflect reality */
    } finally {
      setAutoBusy(false)
      void loadAuto()
      void loadHistory()
    }
  }, [toast, loadAuto, loadHistory])

  const pollRun = useCallback(
    async (id: string) => {
      try {
        const res = await fetch(`/api/signals/run/${id}`, { cache: 'no-store' })
        const d = await res.json()
        if (d.run) {
          missesRef.current = 0
          setRun(d.run)
          if (d.run.status !== 'running') {
            stopPolling()
            setStarting(false)
            loadHistory()
          }
        } else {
          // 404 / tracking lost (server restart, serverless instance swap) —
          // never spin forever: give up after ~30s of consecutive misses.
          missesRef.current++
          if (missesRef.current > 12) {
            stopPolling()
            setStarting(false)
            setRun((r) =>
              r && r.status === 'running'
                ? { ...r, status: 'failed', error: 'Run tracking was lost (the server restarted). Please run the analysis again.' }
                : r,
            )
          }
        }
      } catch {
        /* transient poll failure — keep polling */
      }
    },
    [loadHistory, stopPolling],
  )

  useEffect(() => {
    // mount-fetch history via promise chain (setState happens async, after data arrives)
    const ac = new AbortController()
    fetch('/api/signals?limit=15', { cache: 'no-store', signal: ac.signal })
      .then((r) => r.json())
      .then((d) => {
        if (Array.isArray(d.runs)) setHistory(d.runs)
      })
      .catch(() => {
        /* history is non-critical */
      })
    setClock(Date.now())
    void loadAuto()
    // live desk: refresh history + auto status every 60s, countdown clock every 30s
    const h = setInterval(() => void loadHistory(), 60_000)
    const a = setInterval(() => void loadAuto(), 60_000)
    const c = setInterval(() => setClock(Date.now()), 30_000)
    return () => {
      ac.abort()
      stopPolling()
      clearInterval(h)
      clearInterval(a)
      clearInterval(c)
    }
  }, [stopPolling, loadAuto, loadHistory])

  // toast new AUTO results that complete while the page is open
  useEffect(() => {
    if (seenRef.current === null) {
      seenRef.current = new Set(history.map((r) => r.id)) // first paint — seed silently
      return
    }
    const seen = seenRef.current
    for (const r of history) {
      if (seen.has(r.id)) continue
      seen.add(r.id)
      if (r.source !== 'auto' || new Date(r.createdAt).getTime() < mountedAt.current) continue
      if (r.status === 'completed') {
        toast({
          title: `🤖 Auto signal — ${r.symbol} ${r.direction ?? ''}`,
          description:
            r.direction === 'NEUTRAL'
              ? `No edge detected — the desk stands aside on ${r.symbol}.`
              : `${r.direction} @ ${fmtPrice(r.priceAtRun)} · confidence ${r.confidence ?? '—'}% — the full plan is in this view.`,
        })
      } else if (r.status === 'failed') {
        toast({
          title: `🤖 Auto run failed — ${r.symbol}`,
          description: 'The desk will retry on its next tick.',
          variant: 'destructive',
        })
      }
    }
  }, [history, toast])

  const startRun = useCallback(
    async (sym: string, mkt: 'crypto' | 'stock') => {
      setFormError(null)
      setStarting(true)
      missesRef.current = 0
      // Show the pipeline panel immediately: the POST now runs the whole
      // analysis server-side (serverless-safe — there is no runId to poll
      // until it finishes). A gentle progress climb keeps the panel alive
      // while the request is in flight; real stage data replaces it at the end.
      setRun(placeholderRun(sym, mkt))
      stopPolling()
      pollRef.current = setInterval(() => {
        setRun((r) =>
          r && r.status === 'running' && r.progress < 90
            ? { ...r, progress: Math.min(90, r.progress + 1 + Math.round(Math.random() * 2)) }
            : r,
        )
      }, 2200)
      try {
        const res = await fetch('/api/signals/run', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ symbol: sym, market: mkt }),
        })
        const d = await res.json()
        if (!res.ok) {
          stopPolling()
          setRun(null)
          setFormError(d.error || 'Failed to start analysis.')
          return
        }
        if (d.run) {
          // authoritative: the server ran the pipeline inside the request and
          // returns the finished row (works on Vercel serverless + local dev)
          stopPolling()
          setRun(d.run)
          loadHistory()
        } else if (d.runId) {
          // legacy async server — poll for the result
          setRun((r) => (r ? { ...r, id: d.runId } : r))
          stopPolling()
          pollRef.current = setInterval(() => pollRun(d.runId), 2500)
          pollRun(d.runId)
        } else {
          stopPolling()
          setRun(null)
          setFormError('Unexpected server response — please try again.')
        }
      } catch {
        stopPolling()
        setRun(null)
        setFormError('Network error starting analysis.')
      } finally {
        setStarting(false)
      }
    },
    [pollRun, loadHistory, stopPolling],
  )

  const openRun = useCallback(
    async (id: string) => {
      setRun({ id, status: 'loading' } as SignalRunDetail)
      const res = await fetch(`/api/signals/run/${id}`, { cache: 'no-store' })
      const d = await res.json()
      if (d.run) setRun(d.run)
      window.scrollTo({ top: 0, behavior: 'smooth' })
    },
    [],
  )

  const busy = run?.status === 'running'
  const alerts = entryAlertViews(history)

  const autoDesc = (() => {
    if (!auto) return 'Connecting to the auto desk…'
    if (auto.external)
      return `On production the desk is driven by external cron: one watchlist symbol (${auto.symbols.join(', ')}) per tick.`
    const parts = [
      `Every ${Math.max(1, Math.round(auto.intervalMs / 60_000))} min it analyzes the stalest of ${auto.symbols.join(' / ')} and alerts you when price reaches an entry zone.`,
    ]
    const next = auto.enabled && auto.nextTickAt ? ` Next tick ${fmtIn(auto.nextTickAt, clock)}.` : ''
    const last = auto.lastResult
      ? ` Last: ${auto.lastResult.symbol} ${auto.lastResult.direction ?? auto.lastResult.status}${auto.lastResult.confidence ? ` ${auto.lastResult.confidence}%` : ''}${fmtAgo(auto.lastResult.at, clock) ? ` · ${fmtAgo(auto.lastResult.at, clock)}` : ''}.`
      : ''
    return parts.join('') + next + last
  })()

  return (
    <div className="max-w-[1400px] mx-auto px-4 sm:px-6 py-5 sm:py-6">
      <div className="grid grid-cols-1 lg:grid-cols-[380px_1fr] gap-5 items-start">
        {/* ── left column: auto desk + form + history ── */}
        <div className="space-y-5 order-2 lg:order-1">
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.25, ease: 'easeOut' }}
            className="rounded-2xl border border-tv-line bg-tv-panel shadow-sm p-4 sm:p-5 space-y-3"
          >
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2.5">
                <span
                  className="h-8 w-8 rounded-xl bg-info/12 border border-info/30 text-info inline-flex items-center justify-center text-sm"
                  aria-hidden="true"
                >
                  🤖
                </span>
                <h3 className="text-sm font-semibold tracking-tight text-tv-ink">Auto desk</h3>
                <span
                  className={`h-2 w-2 rounded-full ${auto?.enabled ? 'bg-bull' : 'bg-tv-muted2'}`}
                  aria-hidden="true"
                />
                <span
                  className="text-[11px] font-bold"
                  style={{ color: auto?.enabled ? 'var(--bull)' : 'var(--tv-muted)' }}
                >
                  {auto?.enabled ? 'ON' : 'PAUSED'}
                </span>
              </div>
              <button
                onClick={() => void toggleAuto()}
                suppressHydrationWarning
                className="rounded-full px-3 py-1 text-[11px] font-semibold border border-tv-line bg-tv-panel2 text-tv-muted hover:text-tv-ink transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bull/50"
              >
                {auto?.enabled ? 'Pause' : 'Resume'}
              </button>
            </div>
            <p className="text-[11.5px] leading-relaxed text-tv-muted">{autoDesc}</p>
            <button
              onClick={() => void runAutoNow()}
              disabled={autoBusy || auto?.running}
              suppressHydrationWarning
              className="w-full rounded-xl px-3 py-2 text-[12.5px] font-semibold border border-info/35 bg-info/10 text-info hover:bg-info/15 transition disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-info/50"
            >
              {autoBusy || auto?.running ? 'Desk analyzing…' : 'Run a desk analysis now'}
            </button>
          </motion.div>

          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.25, ease: 'easeOut' }}
            className="rounded-2xl border border-tv-line bg-tv-panel shadow-sm p-4 sm:p-5 space-y-4"
          >
            <div className="flex items-center gap-2.5">
              <span
                className="h-8 w-8 rounded-xl bg-bull/10 border border-bull/25 text-bull inline-flex items-center justify-center text-sm"
                aria-hidden="true"
              >
                🎯
              </span>
              <h3 className="text-sm font-semibold tracking-tight text-tv-ink">New analysis</h3>
            </div>

            <div className="bg-tv-panel2 rounded-full p-1 flex">
              {(['crypto', 'stock'] as const).map((m) => (
                <button
                  key={m}
                  onClick={() => setMarket(m)}
                  suppressHydrationWarning
                  className={`relative flex-1 rounded-full px-3.5 py-1.5 text-[12.5px] font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bull/50 ${
                    market === m ? 'text-bull' : 'text-tv-muted hover:text-tv-ink'
                  }`}
                >
                  {market === m && (
                    <motion.span
                      layoutId="market-pill"
                      className="absolute inset-0 rounded-full border border-tv-line-strong/60 bg-tv-panel shadow-sm"
                      transition={{ type: 'spring', stiffness: 420, damping: 34 }}
                    />
                  )}
                  <span className="relative z-10">{m === 'crypto' ? '₿ Crypto' : ' Stocks'}</span>
                </button>
              ))}
            </div>

            <label className="flex flex-col gap-1.5 text-xs font-semibold text-tv-muted">
              Symbol
              <input
                value={symbol}
                onChange={(e) => setSymbol(e.target.value.toUpperCase())}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !busy && !starting) startRun(symbol, market)
                }}
                suppressHydrationWarning
                placeholder={market === 'crypto' ? 'BTC, ETH, SOL…' : 'AAPL, TSLA, NVDA…'}
                className="w-full rounded-xl bg-tv-panel2 border border-tv-line px-3 py-2 text-sm font-bold tracking-wide text-tv-ink placeholder:text-tv-muted2 placeholder:font-normal focus:outline-none focus:ring-2 focus:ring-bull/40 focus:border-bull/60 transition"
              />
            </label>

            <div className="flex flex-wrap gap-1.5">
              {QUICK_PICKS.filter((q) => q.market === market).map((q) => (
                <button
                  key={q.symbol}
                  onClick={() => {
                    setSymbol(q.symbol)
                    setMarket(q.market)
                  }}
                  suppressHydrationWarning
                  className={`rounded-full px-3 py-1 text-[12px] font-semibold border transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bull/50 ${
                    symbol === q.symbol
                      ? 'bg-info/12 text-info border-info/35'
                      : 'bg-tv-panel2 border-tv-line text-tv-muted hover:text-tv-ink'
                  }`}
                >
                  {q.label}
                </button>
              ))}
            </div>

            <button
              onClick={() => startRun(symbol, market)}
              disabled={busy || starting}
              suppressHydrationWarning
              className="w-full rounded-xl px-4 py-2.5 text-sm font-semibold bg-gradient-to-b from-bull to-bull-deep text-white hover:brightness-110 active:scale-[0.99] transition shadow-sm disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bull/50 dark:text-emerald-950"
            >
              {busy || starting ? 'Analysis running…' : 'Run multi-agent analysis'}
            </button>

            {formError && (
              <p
                role="alert"
                className="rounded-xl bg-bear/12 text-bear border border-bear/40 px-3 py-2.5 text-[13px] leading-relaxed"
              >
                {formError}
              </p>
            )}

            <p className="text-[11.5px] leading-relaxed text-tv-muted">
              ~10 LLM calls across 6 stages (analysts → debate → plan → risk → portfolio manager). Takes 1–2 minutes.
            </p>
          </motion.div>

          {/* history */}
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.25, ease: 'easeOut', delay: 0.05 }}
            className="rounded-2xl border border-tv-line bg-tv-panel shadow-sm p-4 sm:p-5"
          >
            <div className="flex items-center gap-2.5 mb-3">
              <span
                className="h-8 w-8 rounded-xl bg-info/12 border border-info/30 text-info inline-flex items-center justify-center text-sm"
                aria-hidden="true"
              >
                📜
              </span>
              <h3 className="text-sm font-semibold tracking-tight text-tv-ink">Signal history</h3>
            </div>
            <div className="max-h-[440px] overflow-y-auto">
              {history.length === 0 && <p className="px-3 py-6 text-center text-xs text-tv-muted">No analyses yet — run one above.</p>}
              {history.map((h, i) => {
                const badge = dirBadge(h.direction)
                const oc = outcomeChip(h.outcome)
                const selected = run?.id === h.id
                return (
                  <motion.button
                    key={h.id}
                    onClick={() => openRun(h.id)}
                    suppressHydrationWarning
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.25, ease: 'easeOut', delay: Math.min(i, 15) * 0.03 }}
                    className={`w-full text-left rounded-xl px-3 py-2.5 border-b border-tv-div last:border-0 hover:bg-tv-panel2 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bull/50 ${
                      selected ? 'bg-tv-panel2 ring-1 ring-bull/40' : ''
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[13px] font-semibold text-tv-ink">
                        {h.symbol}
                        <span className="ml-1.5 text-[10.5px] font-medium text-tv-muted">{h.market === 'crypto' ? '₿' : '📈'}</span>
                        {h.source === 'auto' && (
                          <span className="ml-1 text-[10px]" title="Generated by the auto desk" suppressHydrationWarning>
                            🤖
                          </span>
                        )}
                      </span>
                      {badge && (
                        <span
                          className="px-2 py-0.5 rounded-full text-[10.5px] font-bold"
                          style={{ background: badge.bg, color: badge.fg, border: `1px solid ${badge.border}` }}
                        >
                          {badge.label}
                        </span>
                      )}
                    </div>
                    <div className="flex items-center justify-between gap-2 mt-1 text-[11.5px] tabular-nums text-tv-muted">
                      <span>
                        {fmtPrice(h.priceAtRun)} · conf {h.confidence ?? '—'}%
                      </span>
                      <span className="px-2 py-0.5 rounded-full text-[10.5px] font-bold" style={{ color: oc.color }}>
                        {h.status === 'running' ? '⏳ running' : h.status === 'failed' ? '❌ failed' : oc.label}
                      </span>
                    </div>
                  </motion.button>
                )
              })}
            </div>
          </motion.div>
        </div>

        {/* ── right column: entry alerts + run view ── */}
        <div className="space-y-5 order-1 lg:order-2 min-w-0">
          {(alerts.active.length > 0 || alerts.near.length > 0 || alerts.waiting > 0) && (
            <div className="space-y-2" aria-label="Entry alerts">
              {alerts.active.slice(0, 3).map(({ run: r }) => {
                const isLong = r.direction === 'LONG'
                const c = isLong
                  ? { bg: 'var(--bull-soft)', fg: 'var(--bull)', bd: 'var(--bull-line)' }
                  : { bg: 'var(--bear-soft)', fg: 'var(--bear)', bd: 'var(--bear-line)' }
                return (
                  <motion.button
                    key={r.id}
                    onClick={() => void openRun(r.id)}
                    suppressHydrationWarning
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.25, ease: 'easeOut' }}
                    className="w-full text-left rounded-2xl border px-4 py-3 flex items-center justify-between gap-3 shadow-sm hover:brightness-[1.03] transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bull/50"
                    style={{ background: c.bg, borderColor: c.bd }}
                  >
                    <div className="min-w-0">
                      <p className="text-[13px] font-bold truncate" style={{ color: c.fg }}>
                        🎯 {r.symbol} {r.direction} — ENTRY ZONE ACTIVE
                      </p>
                      <p className="text-[11.5px] text-tv-muted mt-0.5 tabular-nums truncate">
                        entry {fmtPrice(r.entryLow)} – {fmtPrice(r.entryHigh)} · stop {fmtPrice(r.stop)} · T1{' '}
                        {fmtPrice(r.target1)} · conf {r.confidence ?? '—'}%
                      </p>
                    </div>
                    <span className="text-[11px] font-bold shrink-0" style={{ color: c.fg }}>
                      View plan →
                    </span>
                  </motion.button>
                )
              })}
              {(alerts.near.length > 0 || alerts.waiting > 0) && (
                <div className="rounded-2xl border border-warn-line bg-warn-soft/40 px-4 py-2.5 space-y-0.5">
                  {alerts.near.slice(0, 2).map(({ run: r, pctAway }) => (
                    <p key={r.id} className="text-[12px] text-warn font-medium">
                      ⏳ {r.symbol} {r.direction} — price {pctAway.toFixed(1)}% from the entry zone
                    </p>
                  ))}
                  {alerts.waiting > 0 && (
                    <p className="text-[11.5px] text-tv-muted">
                      {alerts.waiting} open signal{alerts.waiting > 1 ? 's' : ''} waiting for entry — the desk re-analyzes on schedule.
                    </p>
                  )}
                </div>
              )}
            </div>
          )}

          {!run && (
            <motion.div
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.25, ease: 'easeOut', delay: 0.1 }}
              className="rounded-2xl border border-dashed border-tv-line-strong bg-tv-panel2/50 p-10 text-center text-tv-muted"
            >
              <p className="text-3xl mb-3">🤖📈</p>
              <h2 className="text-lg font-bold tracking-tight mb-2 text-tv-ink">AI trade-setup desk</h2>
              <p className="text-[13px] leading-relaxed max-w-md mx-auto">
                A multi-agent system inspired by{' '}
                <a
                  href="https://github.com/TAuricResearch/TradingAgents"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-info underline decoration-dotted rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-info/50"
                >
                  TradingAgents
                </a>
                : analyst team → bull/bear debate → trade-plan engineer → risk committee → portfolio manager. Entries, stops
                and targets are computed from live price structure (ATR, pivots, EMAs) — never invented by the LLM.
              </p>
              <p className="text-[11.5px] mt-4">
                Pick a symbol on the left and hit <b>Run multi-agent analysis</b>.
              </p>
            </motion.div>
          )}

          {run && run.status === 'loading' && (
            <motion.div
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.25, ease: 'easeOut' }}
              className="rounded-2xl border border-tv-line bg-tv-panel shadow-sm p-10 text-center text-sm text-tv-muted"
            >
              Loading run…
            </motion.div>
          )}

          {run && run.status === 'running' && (
            <PipelinePanel stage={run.stage} progress={run.progress} status={run.status} />
          )}

          {run && run.status === 'failed' && (
            <>
              <PipelinePanel stage={run.stage} progress={run.progress} status={run.status} error={run.error} />
              {run.stage && (
                <p className="text-xs text-center text-tv-muted">
                  Partial artifacts (if any) are preserved — pick a different symbol or retry.
                </p>
              )}
            </>
          )}

          {run && run.status === 'completed' && (
            <>
              <SignalCard run={run} />
              <PipelinePanel stage={run.stage} progress={run.progress} status={run.status} />
              <ReportsPanel run={run} />
            </>
          )}
        </div>
      </div>

      <footer className="mt-8 pt-4 border-t border-tv-line text-[11.5px] leading-relaxed text-tv-muted">
        <b className="text-tv-ink">Trade2watch AI Signals</b> — multi-agent analysis inspired by TradingAgents (MIT).
        Decisions are generated by LLMs from public market data (Binance, Yahoo Finance, Google News) with deterministic
        risk engineering.{' '}
        <b className="text-tv-ink">Not financial advice.</b> Crypto and stocks are volatile — never trade money you
        can&apos;t afford to lose. Always re-validate levels before acting.
      </footer>
    </div>
  )
}
