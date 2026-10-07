'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import { SignalCard } from './SignalCard'
import { PipelinePanel } from './PipelinePanel'
import { ReportsPanel } from './ReportsPanel'
import { fmtPrice, type SignalRunDetail, type SignalRunRow } from './types'

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

export function SignalDashboard() {
  const [symbol, setSymbol] = useState('BTC')
  const [market, setMarket] = useState<'crypto' | 'stock'>('crypto')
  const [run, setRun] = useState<SignalRunDetail | null>(null)
  const [history, setHistory] = useState<SignalRunRow[]>([])
  const [starting, setStarting] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const loadHistory = useCallback(async () => {
    try {
      const res = await fetch('/api/signals?limit=15', { cache: 'no-store' })
      const d = await res.json()
      if (Array.isArray(d.runs)) setHistory(d.runs)
    } catch {
      /* history is non-critical */
    }
  }, [])

  const pollRun = useCallback(
    async (id: string) => {
      try {
        const res = await fetch(`/api/signals/run/${id}`, { cache: 'no-store' })
        const d = await res.json()
        if (d.run) {
          setRun(d.run)
          if (d.run.status !== 'running') {
            if (pollRef.current) clearInterval(pollRef.current)
            pollRef.current = null
            setStarting(false)
            loadHistory()
          }
        }
      } catch {
        /* transient poll failure — keep polling */
      }
    },
    [loadHistory],
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
    return () => {
      ac.abort()
      if (pollRef.current) clearInterval(pollRef.current)
    }
  }, [])

  const startRun = useCallback(
    async (sym: string, mkt: 'crypto' | 'stock') => {
      setFormError(null)
      setStarting(true)
      try {
        const res = await fetch('/api/signals/run', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ symbol: sym, market: mkt }),
        })
        const d = await res.json()
        if (!res.ok) {
          setFormError(d.error || 'Failed to start analysis.')
          setStarting(false)
          return
        }
        // show placeholder immediately
        setRun({
          id: d.runId,
          symbol: sym.toUpperCase(),
          market: mkt,
          displayName: null,
          status: 'running',
          stage: 'queued',
          progress: 2,
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
        })
        if (pollRef.current) clearInterval(pollRef.current)
        pollRef.current = setInterval(() => pollRun(d.runId), 2500)
        pollRun(d.runId)
      } catch {
        setFormError('Network error starting analysis.')
        setStarting(false)
      }
    },
    [pollRun],
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

  return (
    <div className="max-w-[1400px] mx-auto px-4 sm:px-6 py-5 sm:py-6">
      <div className="grid grid-cols-1 lg:grid-cols-[380px_1fr] gap-5 items-start">
        {/* ── left column: form + history ── */}
        <div className="space-y-5 order-2 lg:order-1">
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.25, ease: 'easeOut' }}
            className="rounded-2xl border border-tv-line bg-tv-panel shadow-sm p-4 sm:p-5 space-y-4"
          >
            <div className="flex items-center gap-2.5">
              <span
                className="h-8 w-8 rounded-xl bg-warn/15 border border-warn/30 text-warn inline-flex items-center justify-center text-sm"
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
                  className={`relative flex-1 rounded-full px-3.5 py-1.5 text-[12.5px] font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-warn/50 ${
                    market === m ? 'text-warn' : 'text-tv-muted hover:text-tv-ink'
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
                className="w-full rounded-xl bg-tv-panel2 border border-tv-line px-3 py-2 text-sm font-bold tracking-wide text-tv-ink placeholder:text-tv-muted2 placeholder:font-normal focus:outline-none focus:ring-2 focus:ring-warn/40 focus:border-warn/60 transition"
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
                  className={`rounded-full px-3 py-1 text-[12px] font-semibold border transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-warn/50 ${
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
              className="w-full rounded-xl px-4 py-2.5 text-sm font-semibold bg-gradient-to-b from-warn to-warn/90 text-tv-bg hover:brightness-110 active:scale-[0.99] transition shadow-sm disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-warn/50"
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
                    className={`w-full text-left rounded-xl px-3 py-2.5 border-b border-tv-div last:border-0 hover:bg-tv-panel2 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-warn/50 ${
                      selected ? 'bg-tv-panel2 ring-1 ring-warn/40' : ''
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[13px] font-semibold text-tv-ink">
                        {h.symbol}
                        <span className="ml-1.5 text-[10.5px] font-medium text-tv-muted">{h.market === 'crypto' ? '₿' : '📈'}</span>
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

        {/* ── right column: run view ── */}
        <div className="space-y-5 order-1 lg:order-2 min-w-0">
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
