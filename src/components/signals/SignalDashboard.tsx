'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { SignalCard } from './SignalCard'
import { PipelinePanel } from './PipelinePanel'
import { ReportsPanel } from './ReportsPanel'
import { fmtPrice, type SignalRunDetail, type SignalRunRow } from './types'

const C = {
  panel: 'bg-[#131722] border-[#232b3d]',
  panel2: 'bg-[#1a2030] border-[#232b3d]',
  muted: 'text-[#8b93a7]',
  text: 'text-[#e6e9f0]',
}

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
      return { label: '🎯 T1 hit', color: '#26a69a' }
    case 'TARGET2_HIT':
      return { label: '🚀 T2 hit', color: '#26a69a' }
    case 'STOP_HIT':
      return { label: '🛑 Stopped', color: '#ef5350' }
    case 'INVALIDATED':
      return { label: '⚠ Invalidated', color: '#f5b544' }
    default:
      return { label: 'Open', color: '#8b93a7' }
  }
}

function dirBadge(direction?: string | null): { label: string; bg: string; fg: string; border: string } | null {
  if (direction === 'LONG') return { label: 'LONG', bg: 'rgba(38,166,154,.15)', fg: '#26a69a', border: 'rgba(38,166,154,.4)' }
  if (direction === 'SHORT') return { label: 'SHORT', bg: 'rgba(239,83,80,.15)', fg: '#ef5350', border: 'rgba(239,83,80,.4)' }
  if (direction === 'NEUTRAL') return { label: 'WAIT', bg: 'rgba(245,181,68,.12)', fg: '#f5b544', border: 'rgba(245,181,68,.4)' }
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
    <div className="max-w-[1180px] w-full mx-auto px-5 py-5">
      <div className="grid grid-cols-1 lg:grid-cols-[380px_1fr] gap-5 items-start">
        {/* ── left column: form + history ── */}
        <div className="space-y-5 order-2 lg:order-1">
          <div className={`rounded-[14px] border ${C.panel} p-5`}>
            <h3 className={`text-sm font-bold mb-4 ${C.text}`}>🎯 New analysis</h3>

            <div className="flex gap-2 mb-3">
              {(['crypto', 'stock'] as const).map((m) => (
                <button
                  key={m}
                  onClick={() => setMarket(m)}
                  suppressHydrationWarning
                  className={`flex-1 py-2 rounded-full text-[13px] font-semibold border transition-colors ${
                    market === m
                      ? 'bg-[#1a2030] text-[#f5b544] border-[rgba(245,181,68,.45)]'
                      : 'bg-transparent text-[#8b93a7] border-[#232b3d] hover:text-[#e6e9f0]'
                  }`}
                >
                  {m === 'crypto' ? '₿ Crypto' : ' Stocks'}
                </button>
              ))}
            </div>

            <label className={`flex flex-col gap-1.5 text-xs font-semibold mb-3 ${C.muted}`}>
              Symbol
              <input
                value={symbol}
                onChange={(e) => setSymbol(e.target.value.toUpperCase())}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !busy && !starting) startRun(symbol, market)
                }}
                suppressHydrationWarning
                placeholder={market === 'crypto' ? 'BTC, ETH, SOL…' : 'AAPL, TSLA, NVDA…'}
                className="bg-[#1a2030] border border-[#232b3d] rounded-lg px-3 py-2.5 text-base font-bold tracking-wide text-[#e6e9f0] outline-none focus:border-[#f5b544] w-full"
              />
            </label>

            <div className="flex flex-wrap gap-1.5 mb-4">
              {QUICK_PICKS.filter((q) => q.market === market).map((q) => (
                <button
                  key={q.symbol}
                  onClick={() => {
                    setSymbol(q.symbol)
                    setMarket(q.market)
                  }}
                  suppressHydrationWarning
                  className={`px-3 py-1 rounded-full text-xs font-semibold border transition-colors ${
                    symbol === q.symbol
                      ? 'bg-[rgba(74,158,255,.15)] text-[#4a9eff] border-[rgba(74,158,255,.4)]'
                      : `${C.panel2} text-[#8b93a7] hover:text-[#e6e9f0]`
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
              className="w-full py-3 rounded-full text-sm font-bold text-[#0b0e14] transition-opacity disabled:opacity-50"
              style={{ background: '#f5b544' }}
            >
              {busy || starting ? 'Analysis running…' : 'Run multi-agent analysis'}
            </button>

            {formError && (
              <p className="mt-3 text-xs leading-relaxed px-3 py-2.5 rounded-lg bg-[rgba(239,83,80,.12)] text-[#ef5350] border border-[rgba(239,83,80,.4)]">
                {formError}
              </p>
            )}

            <p className={`mt-3 text-[11.5px] leading-relaxed ${C.muted}`}>
              ~10 LLM calls across 6 stages (analysts → debate → plan → risk → portfolio manager). Takes 1–2 minutes.
            </p>
          </div>

          {/* history */}
          <div className={`rounded-[14px] border ${C.panel} overflow-hidden`}>
            <h3 className={`text-sm font-bold px-5 py-3.5 border-b border-[#232b3d] ${C.text}`}>📜 Signal history</h3>
            <div className="max-h-[420px] overflow-y-auto">
              {history.length === 0 && <p className={`px-5 py-6 text-center text-xs ${C.muted}`}>No analyses yet — run one above.</p>}
              {history.map((h) => {
                const badge = dirBadge(h.direction)
                const oc = outcomeChip(h.outcome)
                return (
                  <button
                    key={h.id}
                    onClick={() => openRun(h.id)}
                    suppressHydrationWarning
                    className={`w-full text-left px-5 py-3 border-b border-dashed border-white/5 last:border-0 hover:bg-[#1a2030] transition-colors ${run?.id === h.id ? 'bg-[#1a2030]' : ''}`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className={`text-[13px] font-bold ${C.text}`}>
                        {h.symbol}
                        <span className={`ml-1.5 text-[10.5px] font-medium ${C.muted}`}>{h.market === 'crypto' ? '₿' : '📈'}</span>
                      </span>
                      {badge && (
                        <span
                          className="px-2 py-0.5 rounded-md text-[10px] font-bold"
                          style={{ background: badge.bg, color: badge.fg, border: `1px solid ${badge.border}` }}
                        >
                          {badge.label}
                        </span>
                      )}
                    </div>
                    <div className={`flex items-center justify-between gap-2 mt-1 text-[11px] ${C.muted}`}>
                      <span>
                        {fmtPrice(h.priceAtRun)} · conf {h.confidence ?? '—'}%
                      </span>
                      <span style={{ color: oc.color }}>
                        {h.status === 'running' ? '⏳ running' : h.status === 'failed' ? '❌ failed' : oc.label}
                      </span>
                    </div>
                  </button>
                )
              })}
            </div>
          </div>
        </div>

        {/* ── right column: run view ── */}
        <div className="space-y-5 order-1 lg:order-2 min-w-0">
          {!run && (
            <div className={`rounded-[14px] border ${C.panel} p-10 text-center`}>
              <p className="text-3xl mb-3">🤖📈</p>
              <h2 className={`text-lg font-bold mb-2 ${C.text}`}>AI trade-setup desk</h2>
              <p className={`text-[13px] leading-relaxed max-w-md mx-auto ${C.muted}`}>
                A multi-agent system inspired by{' '}
                <a
                  href="https://github.com/TAuricResearch/TradingAgents"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[#4a9eff] underline decoration-dotted"
                >
                  TradingAgents
                </a>
                : analyst team → bull/bear debate → trade-plan engineer → risk committee → portfolio manager. Entries, stops
                and targets are computed from live price structure (ATR, pivots, EMAs) — never invented by the LLM.
              </p>
              <p className={`text-[11.5px] mt-4 ${C.muted}`}>
                Pick a symbol on the left and hit <b>Run multi-agent analysis</b>.
              </p>
            </div>
          )}

          {run && run.status === 'loading' && (
            <div className={`rounded-[14px] border ${C.panel} p-10 text-center ${C.muted} text-sm`}>Loading run…</div>
          )}

          {run && run.status === 'running' && (
            <PipelinePanel stage={run.stage} progress={run.progress} status={run.status} />
          )}

          {run && run.status === 'failed' && (
            <>
              <PipelinePanel stage={run.stage} progress={run.progress} status={run.status} error={run.error} />
              {run.stage && (
                <p className={`text-xs text-center ${C.muted}`}>
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

      <footer className={`mt-8 pt-4 border-t border-[#232b3d] text-[11.5px] leading-relaxed ${C.muted}`}>
        <b>Trade2watch AI Signals</b> — multi-agent analysis inspired by TradingAgents (MIT). Decisions are generated by LLMs
        from public market data (Binance, Yahoo Finance, Google News) with deterministic risk engineering.{' '}
        <b>Not financial advice.</b> Crypto and stocks are volatile — never trade money you can&apos;t afford to lose.
        Always re-validate levels before acting.
      </footer>
    </div>
  )
}
