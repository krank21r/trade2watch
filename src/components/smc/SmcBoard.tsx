'use client'

// ─── SMC board — Smart Money Concepts setup desk ────────────────────────────
// Consumes GET /api/smc/analysis?symbol=BTCUSDT (SmcAnalysis contract, §23/§25)
// every 45s. Client-side polling with AbortController; hydration-safe time
// strings via a mounted flag. If the engine is unavailable the board shows a
// dedicated DATA UNAVAILABLE panel — never stale or faked data (§62).

import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'
import { motion } from 'framer-motion'
import { fmtPrice } from '@/components/signals/types'
import {
  Chip,
  EmptyLine,
  LadderRow,
  LIQ_LABEL,
  SCROLL_CLS,
  SmcPanel,
  biasCls,
  dirDotCls,
  dirSoftBg,
  dirTextCls,
  fmtClock,
  fmtDay,
  fmtWhen,
  fvgStatusCls,
  fvgStatusLabel,
  obStatusCls,
  qualityCls,
  trendCls,
} from '@/components/smc/ui'
import type { SmcAnalysis, SmcAnalysisError, SmcHistoryRow, SignalType } from '@/lib/smc/types'
import { BacktestCard } from '@/components/smc/BacktestCard'

const POLL_MS = 45_000
const API = '/api/smc/analysis?symbol=BTCUSDT'

type HistFilter = 'ALL' | 'LONG' | 'SHORT' | 'WIN' | 'LOSS'
const HIST_FILTERS: Array<{ key: HistFilter; label: string }> = [
  { key: 'ALL', label: 'All' },
  { key: 'LONG', label: 'Long' },
  { key: 'SHORT', label: 'Short' },
  { key: 'WIN', label: 'Win' },
  { key: 'LOSS', label: 'Loss' },
]

const SIGNAL_THEME: Record<
  SignalType,
  {
    icon: string
    word: string
    sub: string
    wordCls: string
    cardCls: string
    cardStyle: CSSProperties
    hairline: string
    barCls: string
    noteCls: string
  }
> = {
  LONG: {
    icon: '▲',
    word: 'LONG',
    sub: 'bullish SMC confluence — entry plan below',
    wordCls: 'text-bull',
    cardCls: 'border-bull/25',
    cardStyle: {
      background: 'linear-gradient(180deg, var(--tv-panel) 55%, var(--bull-soft))',
      boxShadow: 'var(--card-glow)',
    },
    hairline: 'linear-gradient(90deg, transparent, var(--bull), var(--info), var(--bull), transparent)',
    barCls: 'bg-bull/70',
    noteCls: 'border-warn/30 bg-warn/5',
  },
  SHORT: {
    icon: '▼',
    word: 'SHORT',
    sub: 'bearish SMC confluence — entry plan below',
    wordCls: 'text-bear',
    cardCls: 'border-bear/25',
    cardStyle: {
      background: 'linear-gradient(180deg, var(--tv-panel) 55%, var(--bear-soft))',
      boxShadow: 'var(--card-glow-bear)',
    },
    hairline: 'linear-gradient(90deg, transparent, var(--bear), var(--bear-soft), var(--bear), transparent)',
    barCls: 'bg-bear/70',
    noteCls: 'border-warn/30 bg-warn/5',
  },
  WATCHLIST: {
    icon: '⏳',
    word: 'WATCHLIST',
    sub: 'conditions building — awaiting confirmation',
    wordCls: 'text-warn',
    cardCls: 'border-warn/40 bg-tv-panel',
    cardStyle: { boxShadow: '0 0 28px var(--warn-soft)' },
    hairline: 'linear-gradient(90deg, transparent, var(--warn), transparent)',
    barCls: 'bg-warn/70',
    noteCls: 'border-warn/30 bg-warn/5',
  },
  NO_TRADE: {
    icon: '⛔',
    word: 'NO TRADE',
    sub: 'no qualified setup right now',
    wordCls: 'text-tv-muted',
    cardCls: 'border-tv-line bg-tv-panel2/40',
    cardStyle: {},
    hairline: '',
    barCls: 'bg-tv-muted/40',
    noteCls: 'border-tv-line bg-tv-panel2/50',
  },
}

/** status chip for a history row — ACTIVE pulses, TPs bull, SL bear, rest muted */
function StatusChip({ status }: { status: string }) {
  if (status === 'ACTIVE') {
    return (
      <span className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border border-bull/40 bg-bull/10 px-2 py-0.5 text-[10px] font-bold text-bull">
        <span className="relative flex h-1.5 w-1.5">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-bull/60" aria-hidden="true" />
          <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-bull" aria-hidden="true" />
        </span>
        ACTIVE
      </span>
    )
  }
  const cls =
    status === 'TP1_HIT' || status === 'TP2_HIT' || status === 'TP3_HIT'
      ? 'border-bull/40 bg-bull/10 text-bull'
      : status === 'SL_HIT'
        ? 'border-bear/40 bg-bear/10 text-bear'
        : 'border-tv-line bg-tv-panel2 text-tv-muted'
  return (
    <Chip cls={cls}>{status.replace('_', ' ')}</Chip>
  )
}

/** result + R-multiple chip — bull when r >= 0, bear otherwise */
function ResultChip({ row }: { row: SmcHistoryRow }) {
  const parts: string[] = []
  if (row.result) parts.push(row.result)
  if (row.rMultiple !== null) parts.push(`${row.rMultiple >= 0 ? '+' : ''}${row.rMultiple.toFixed(2)}R`)
  if (parts.length === 0) return <span className="text-tv-muted2">—</span>
  const cls =
    row.rMultiple === null
      ? 'border-tv-line bg-tv-panel2 text-tv-muted'
      : row.rMultiple >= 0
        ? 'border-bull/40 bg-bull/10 text-bull'
        : 'border-bear/40 bg-bear/10 text-bear'
  return (
    <span className={`inline-block whitespace-nowrap rounded-full border px-2 py-0.5 text-[10px] font-bold tabular-nums ${cls}`}>
      {parts.join(' ')}
    </span>
  )
}

function Skeleton() {
  return (
    <div className="mx-auto flex min-h-full w-full max-w-[1400px] flex-col gap-5 px-4 py-5 sm:px-6 sm:py-6" aria-busy="true">
      <div className="h-28 animate-pulse rounded-3xl border border-tv-line bg-tv-panel" />
      <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="h-24 animate-pulse rounded-2xl border border-tv-line bg-tv-panel" />
        ))}
      </div>
      <div className="h-64 animate-pulse rounded-3xl border border-tv-line bg-tv-panel" />
    </div>
  )
}

function UnavailablePanel({ message, disclaimer, onRetry }: { message: string; disclaimer: string | null; onRetry: () => void }) {
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
          {disclaimer ?? 'The SMC engine shows nothing rather than stale or fake data — retry in a moment.'}
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
  const [data, setData] = useState<SmcAnalysis | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [errDisclaimer, setErrDisclaimer] = useState<string | null>(null)
  const [isMounted, setIsMounted] = useState(false)
  const [histFilter, setHistFilter] = useState<HistFilter>('ALL')
  const mountedRef = useRef(true)
  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    setIsMounted(true)
    return () => {
      mountedRef.current = false
      abortRef.current?.abort()
    }
  }, [])

  const load = useCallback(async () => {
    abortRef.current?.abort()
    const ctrl = new AbortController()
    abortRef.current = ctrl
    try {
      const res = await fetch(API, { cache: 'no-store', signal: ctrl.signal })
      const body = (await res.json()) as SmcAnalysis | SmcAnalysisError
      if (!mountedRef.current) return
      if (body.ok === false) {
        // engine's explicit failure payload (§62) — show nothing fake
        setError(body.error)
        setErrDisclaimer(body.disclaimer)
        setData(null)
      } else if (!res.ok) {
        setError(`API ${res.status}`)
        setData(null)
      } else {
        setData(body)
        setError(null)
        setErrDisclaimer(null)
      }
    } catch (e) {
      if (!mountedRef.current) return
      if (e instanceof DOMException && e.name === 'AbortError') return
      setError(String(e instanceof Error ? e.message : e).slice(0, 160))
    } finally {
      if (mountedRef.current && abortRef.current === ctrl) setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
    const t = setInterval(() => void load(), POLL_MS)
    return () => clearInterval(t)
  }, [load])

  const retry = useCallback(() => {
    setLoading(true)
    void load()
  }, [load])

  if (!data) {
    if (loading) return <Skeleton />
    return <UnavailablePanel message={error ?? 'SMC engine unreachable'} disclaimer={errDisclaimer} onRetry={retry} />
  }

  // ── derived (data narrowed non-null) ──
  const theme = SIGNAL_THEME[data.signal]
  const trade = data.trade
  const rr = data.risk_reward
  // ladder direction: the signal, falling back to market bias for odd states
  const isLong =
    data.signal === 'SHORT' ? false : data.signal === 'LONG' ? true : data.market_bias !== 'BEARISH'
  const mid = trade?.entry_mid ?? 0
  const stopPct = trade ? Math.abs((mid - trade.stop_loss) / mid) * 100 : 0
  const planRows = trade
    ? [
        { key: 'tp3', icon: '🎯', label: 'TP3 · Runner', sub: `+${rr.tp3.toFixed(1)}R`, value: fmtPrice(trade.tp3), cls: 'text-info', accent: false, big: false },
        { key: 'tp2', icon: '🎯', label: 'TP2 · Final target', sub: `+${rr.tp2.toFixed(1)}R`, value: fmtPrice(trade.tp2), cls: 'text-info', accent: false, big: false },
        { key: 'tp1', icon: '🎯', label: 'TP1 · Bank half', sub: `+${rr.tp1.toFixed(1)}R`, value: fmtPrice(trade.tp1), cls: 'text-info', accent: false, big: false },
        { key: 'entry', icon: '▶', label: 'ENTRY — limit zone', sub: `assumed fill ≈ mid ${fmtPrice(trade.entry_mid)}`, value: `${fmtPrice(trade.entry_low)} – ${fmtPrice(trade.entry_high)}`, cls: 'text-warn', accent: true, big: true },
        { key: 'stop', icon: '🛑', label: 'STOP LOSS', sub: `${stopPct.toFixed(2)}% ${trade.stop_loss < mid ? 'below' : 'above'} mid · risk 1R`, value: fmtPrice(trade.stop_loss), cls: 'text-bear', accent: false, big: false },
      ]
    : []
  // read top-down like a chart: longs highest-first, shorts stop-first
  const orderedRows = isLong ? planRows : [...planRows].reverse()

  const watchNote =
    data.explanation[0] ??
    (data.reasons[0] ? `${data.reasons[0].factor} — ${data.reasons[0].result}` : null) ??
    'No qualified setup — the engine is standing aside.'

  const histRows = data.history.filter((h) =>
    histFilter === 'ALL'
      ? true
      : histFilter === 'LONG'
        ? h.direction === 'LONG'
        : histFilter === 'SHORT'
          ? h.direction === 'SHORT'
          : histFilter === 'WIN'
            ? h.result === 'WIN'
            : h.result === 'LOSS',
  )

  const motionT = (delay: number) => ({
    initial: { opacity: 0, y: 10 },
    animate: { opacity: 1, y: 0 },
    transition: { duration: 0.25, ease: 'easeOut' as const, delay },
  })

  return (
    <div className="mx-auto flex min-h-full w-full max-w-[1400px] flex-col gap-5 px-4 py-5 sm:px-6 sm:py-6">
      <span className="sr-only">
        {data.symbol} SMC analysis: {data.signal.replace('_', ' ')} signal, quality {data.quality}, score {data.score} of 100, market bias {data.market_bias}.
      </span>

      {/* a later poll failed but we still hold the last good analysis */}
      {error && (
        <div
          role="status"
          className="flex flex-wrap items-center gap-2 rounded-xl border border-bear/30 px-3 py-2.5 text-[12.5px]"
          style={{ background: 'var(--bear-soft)' }}
        >
          <span className="text-bear">
            Feed error: {error} — showing the last good analysis ({isMounted ? fmtClock(data.generatedAt) : '--:--:--'}),
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

      {/* ── header ── */}
      <motion.header {...motionT(0)} className="flex flex-wrap items-start gap-4 rounded-3xl border border-tv-line bg-tv-panel shadow-sm p-4 sm:p-6">
        <span
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl text-[20px]"
          style={{ background: 'var(--bull-soft)' }}
          aria-hidden="true"
        >
          🧠
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[11px] font-bold uppercase tracking-[0.14em] text-tv-muted">SMC setup</div>
          <div className="mt-0.5 flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h1 className="text-xl font-extrabold tracking-tight text-tv-ink sm:text-2xl">{data.symbol}</h1>
            <span className="text-2xl font-bold tabular-nums tracking-tight text-tv-ink sm:text-3xl">
              {fmtPrice(data.current_price)}
            </span>
            <span
              className={`rounded-full border px-2.5 py-0.5 text-[11px] font-bold tabular-nums ${
                data.change24h >= 0 ? 'border-bull/30 bg-bull/10 text-bull' : 'border-bear/30 bg-bear/10 text-bear'
              }`}
            >
              {data.change24h >= 0 ? '+' : ''}
              {data.change24h.toFixed(2)}% 24h
            </span>
          </div>
          <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
            <Chip cls={biasCls(data.market_bias)}>{data.market_bias}</Chip>
            {data.quality !== '—' && (
              <Chip cls={qualityCls(data.quality)}>
                {data.quality} · {data.score}
              </Chip>
            )}
            <Chip cls="border-info/35 bg-info/10 text-info">{data.mode}</Chip>
            <Chip>{data.dataSource === 'BINANCE_FALLBACK' ? 'Binance fallback' : 'Bybit'}</Chip>
          </div>
        </div>
        <div className="ml-auto text-right text-[11px] tabular-nums text-tv-muted">
          <span role="status" aria-live="polite">
            {loading ? 'refreshing…' : `refreshed ${isMounted ? fmtClock(data.generatedAt) : '--:--:--'}`} · auto every 45s
          </span>
        </div>
      </motion.header>

      {/* ── multi-timeframe strip ── */}
      <motion.section {...motionT(0.05)} aria-label="Multi-timeframe structure" className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        {(['4H', '1H', '15M', '5M'] as const).map((tf) => {
          const s = data.per_tf[tf]
          const role =
            data.timeframes.trend === tf
              ? 'Trend'
              : data.timeframes.structure === tf
                ? 'Structure'
                : data.timeframes.setup === tf
                  ? 'Setup'
                  : data.timeframes.entry === tf
                    ? 'Entry'
                    : ''
          return (
            <div key={tf} className="rounded-2xl border border-tv-line bg-tv-panel shadow-sm p-3.5 sm:p-4">
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-[13.5px] font-bold text-tv-ink">{tf}</span>
                <span className="text-[10px] font-bold uppercase tracking-wider text-tv-muted2">{role}</span>
              </div>
              <div className={`mt-1 text-[13.5px] font-bold ${trendCls(s.trend)}`}>{s.trend}</div>
              <div className="mt-1 truncate text-[11px] text-tv-muted" title={s.note}>
                {s.note}
              </div>
              {(s.bos || s.choch) && (
                <div className="mt-2 flex flex-wrap gap-1">
                  {s.bos && <Chip cls="border-info/40 bg-info/10 text-info">BOS</Chip>}
                  {s.choch && <Chip cls="border-warn/40 bg-warn/10 text-warn">CHoCH</Chip>}
                </div>
              )}
            </div>
          )
        })}
      </motion.section>

      {/* ── signal hero ── */}
      <motion.section
        {...motionT(0.1)}
        aria-label="SMC signal"
        className={`relative overflow-hidden rounded-3xl border p-4 sm:p-6 ${theme.cardCls}`}
        style={theme.cardStyle}
      >
        {theme.hairline && (
          <span aria-hidden className="absolute inset-x-0 top-0 h-px" style={{ background: theme.hairline }} />
        )}
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="text-[11px] font-bold uppercase tracking-[0.14em] text-tv-muted">Signal — {data.mode} mode</div>
            <div className={`mt-1 flex items-center gap-2.5 text-3xl font-extrabold tracking-tight sm:text-4xl ${theme.wordCls}`}>
              <span aria-hidden="true">{theme.icon}</span>
              <span>{theme.word}</span>
            </div>
            <div className="mt-1.5 text-[12.5px] text-tv-muted">{theme.sub}</div>
          </div>
          <div className="shrink-0 text-right">
            <span className={`inline-block rounded-full border px-2.5 py-1 text-[12.5px] font-extrabold ${qualityCls(data.quality)}`}>
              {data.quality}
            </span>
            <div className="mt-1 text-3xl font-extrabold tabular-nums tracking-tight text-tv-ink sm:text-4xl">
              {data.score}
              <span className="text-lg font-bold text-tv-muted2">/100</span>
            </div>
            <div className="text-[10px] font-bold uppercase tracking-wider text-tv-muted">Setup Quality Score</div>
            <div className="text-[10px] text-tv-muted2">quality score — not a win probability</div>
            <div className="mt-2 ml-auto h-1.5 w-28 overflow-hidden rounded-full border border-tv-line bg-tv-panel2">
              <div className={`h-full rounded-full ${theme.barCls}`} style={{ width: `${Math.min(100, Math.max(0, data.score))}%` }} />
            </div>
          </div>
        </div>

        {trade ? (
          <>
            <div className="mt-4 flex flex-col gap-2 border-t border-dashed border-tv-line pt-4" role="list" aria-label={`${theme.word} plan levels`}>
              {orderedRows.map((r) => (
                <LadderRow key={r.key} icon={r.icon} label={r.label} sub={r.sub} value={r.value} cls={r.cls} accent={r.accent} big={r.big} />
              ))}
            </div>
            <div className="flex items-center justify-between gap-3 pt-1 text-[12.5px]">
              <span className="text-tv-muted">Risk : Reward</span>
              <Chip cls="border-bull/40 bg-bull/10 text-bull">1 : {rr.tp2.toFixed(1)} at TP2</Chip>
            </div>
          </>
        ) : (
          <div className={`mt-4 flex items-start gap-2.5 rounded-xl border px-3.5 py-3 ${theme.noteCls}`}>
            <span className="shrink-0" aria-hidden="true">
              {theme.icon}
            </span>
            <p className="text-[12.5px] leading-relaxed text-tv-ink/90">{watchNote}</p>
          </div>
        )}
      </motion.section>

      {/* ── score breakdown + engine explanation ── */}
      <motion.section {...motionT(0.15)} aria-label="Score breakdown and engine explanation" className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-2xl border border-tv-line bg-tv-panel shadow-sm p-4 sm:p-5">
          <h3 className="mb-3 text-[11px] font-bold uppercase tracking-[0.14em] text-tv-muted">
            Score breakdown <span className="normal-case tracking-normal text-tv-muted2">— why this rating</span>
          </h3>
          {data.reasons.length === 0 ? (
            <EmptyLine>no scored factors</EmptyLine>
          ) : (
            <ul role="list" className={`flex max-h-80 flex-col gap-1.5 pr-1 ${SCROLL_CLS}`}>
              {data.reasons.map((r, i) => (
                <li key={i} className="flex items-start justify-between gap-3 rounded-xl border border-tv-line bg-tv-panel2/50 px-3 py-2">
                  <div className="min-w-0">
                    <div className="text-[12.5px] font-semibold text-tv-ink">{r.factor}</div>
                    <div className="mt-0.5 text-[11px] leading-snug text-tv-muted">{r.result}</div>
                  </div>
                  <span
                    className={`shrink-0 pt-0.5 text-[13px] font-bold tabular-nums ${
                      r.points > 0 ? 'text-bull' : r.points < 0 ? 'text-bear' : 'text-tv-muted2'
                    }`}
                  >
                    {r.points > 0 ? `+${r.points}` : r.points}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="rounded-2xl border border-tv-line bg-tv-panel shadow-sm p-4 sm:p-5">
          <h3 className="mb-3 text-[11px] font-bold uppercase tracking-[0.14em] text-tv-muted">Engine explanation</h3>
          {data.explanation.length === 0 ? (
            <EmptyLine>nothing to explain right now</EmptyLine>
          ) : (
            <ul className="flex flex-col gap-2">
              {data.explanation.map((line, i) => (
                <li key={i} className="flex gap-2 text-[12.5px] leading-relaxed text-tv-ink/90">
                  <span className="mt-[3px] shrink-0 text-[10px] text-bull" aria-hidden="true">
                    ◆
                  </span>
                  <span className="min-w-0">{line}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </motion.section>

      {/* ── building-block panels ── */}
      <motion.section {...motionT(0.2)} aria-label="SMC building blocks" className="grid gap-4 lg:grid-cols-2">
        {/* order blocks */}
        <SmcPanel title="Order blocks" hint="1H" count={data.order_blocks.length}>
          {data.order_blocks.length === 0 ? (
            <EmptyLine>none right now</EmptyLine>
          ) : (
            <ul role="list" className={`flex max-h-72 flex-col gap-1.5 pr-1 ${SCROLL_CLS}`}>
              {data.order_blocks.map((ob) => (
                <li
                  key={`${ob.time}:${ob.direction}`}
                  className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-xl border border-tv-line bg-tv-panel2/50 px-3 py-2"
                >
                  <span className={`h-2 w-2 shrink-0 rounded-full ${dirDotCls(ob.direction)}`} aria-hidden="true" />
                  <span className={`text-[12px] font-bold ${dirTextCls(ob.direction)}`}>{ob.direction} OB</span>
                  <span className="text-[11.5px] tabular-nums text-tv-muted">
                    {fmtPrice(ob.low)} – {fmtPrice(ob.high)}
                  </span>
                  <span className="ml-auto flex flex-wrap items-center gap-1">
                    {ob.fresh ? (
                      <Chip cls="border-bull/40 bg-bull/10 text-bull">FRESH</Chip>
                    ) : ob.testedCount > 0 ? (
                      <Chip>{ob.testedCount} tests</Chip>
                    ) : null}
                    <Chip cls={obStatusCls[ob.status]}>{ob.status}</Chip>
                    <span className="text-[11px] font-bold tabular-nums text-warn" title={`strength ${ob.strengthScore}/100`}>
                      ⭐ {ob.strengthScore}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </SmcPanel>

        {/* fair value gaps */}
        <SmcPanel title="Fair value gaps" hint="imbalance zones" count={data.fvgs.length}>
          {data.fvgs.length === 0 ? (
            <EmptyLine>none right now</EmptyLine>
          ) : (
            <ul role="list" className={`flex max-h-72 flex-col gap-1.5 pr-1 ${SCROLL_CLS}`}>
              {data.fvgs.map((f, i) => (
                <li key={`${f.time}:${f.direction}:${i}`} className="rounded-xl border border-tv-line bg-tv-panel2/50 px-3 py-2">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className={`text-[12px] font-bold ${dirTextCls(f.direction)}`}>
                      {f.direction === 'BULLISH' ? '▲' : '▼'} {f.direction} FVG
                    </span>
                    <span className="text-[11.5px] tabular-nums text-tv-muted">
                      {fmtPrice(f.low)} – {fmtPrice(f.high)}
                    </span>
                    <Chip cls={fvgStatusCls(f.status)}>{fvgStatusLabel(f.status)}</Chip>
                    <span className="ml-auto text-[10.5px] tabular-nums text-tv-muted2">{Math.round(f.fillPct)}% filled</span>
                  </div>
                  <div
                    className="mt-2 h-1.5 overflow-hidden rounded-full bg-tv-line/50"
                    role="img"
                    aria-label={`${f.direction} FVG ${Math.round(f.fillPct)}% filled`}
                  >
                    <div
                      className={`h-full rounded-full ${f.direction === 'BULLISH' ? 'bg-bull/60' : 'bg-bear/60'}`}
                      style={{ width: `${Math.min(100, Math.max(0, f.fillPct))}%` }}
                    />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </SmcPanel>

        {/* liquidity levels */}
        <SmcPanel title="Liquidity levels" hint="resting pools" count={data.liquidity_levels.length}>
          {data.liquidity_levels.length === 0 ? (
            <EmptyLine>none right now</EmptyLine>
          ) : (
            <ul role="list" className={`flex max-h-72 flex-col gap-1.5 pr-1 ${SCROLL_CLS}`}>
              {data.liquidity_levels.map((l, i) => (
                <li
                  key={`${l.type}:${l.price}:${i}`}
                  className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-xl border border-tv-line bg-tv-panel2/50 px-3 py-2"
                >
                  <span className="text-[12px] font-semibold text-tv-ink">{LIQ_LABEL[l.type]}</span>
                  <span className="text-[11.5px] tabular-nums text-tv-muted">{fmtPrice(l.price)}</span>
                  <span className="text-[11px] font-bold tabular-nums text-warn" title={`strength ${l.strength}/100`}>
                    ⭐ {l.strength}
                  </span>
                  <span className="ml-auto">
                    {l.swept ? (
                      <Chip cls="border-tv-line-strong bg-tv-panel2 text-tv-muted">
                        SWEPT{l.sweptAt !== null && isMounted ? ` · ${fmtWhen(l.sweptAt)}` : ''}
                      </Chip>
                    ) : (
                      <Chip cls="border-info/40 bg-info/10 text-info">ARMED</Chip>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </SmcPanel>

        {/* liquidity sweeps */}
        <SmcPanel title="Liquidity sweeps" hint="recent" count={data.sweeps.length}>
          {data.sweeps.length === 0 ? (
            <EmptyLine>none right now</EmptyLine>
          ) : (
            <ul role="list" className={`flex max-h-72 flex-col gap-1.5 pr-1 ${SCROLL_CLS}`}>
              {data.sweeps.map((s, i) => (
                <li key={`${s.confirmedAt}:${s.levelType}:${i}`} className="flex items-center gap-2.5 rounded-xl border border-tv-line bg-tv-panel2/50 px-3 py-2">
                  <span
                    className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[12px] ${dirTextCls(s.direction)}`}
                    style={{ background: dirSoftBg(s.direction) }}
                    aria-hidden="true"
                  >
                    {s.direction === 'BULLISH' ? '▲' : '▼'}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className={`text-[12px] font-bold ${dirTextCls(s.direction)}`}>
                      {s.direction === 'BULLISH' ? 'Sell-side sweep' : 'Buy-side sweep'}
                    </div>
                    <div className="mt-0.5 truncate text-[10.5px] text-tv-muted2">
                      {LIQ_LABEL[s.levelType]} {fmtPrice(s.level)} · wick {fmtPrice(s.extreme)}
                    </div>
                  </div>
                  <span className="shrink-0 text-[10.5px] tabular-nums text-tv-muted">{isMounted ? fmtWhen(s.confirmedAt) : '—'}</span>
                </li>
              ))}
            </ul>
          )}
        </SmcPanel>
      </motion.section>

      {/* ── backtest (on-demand, never polled) ── */}
      <BacktestCard />

      {/* ── signal history ── */}
      <motion.section {...motionT(0.25)} aria-label="Signal history" className="rounded-2xl border border-tv-line bg-tv-panel shadow-sm p-4 sm:p-5">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <h3 className="text-[11px] font-bold uppercase tracking-[0.14em] text-tv-muted">
            Signal history <span className="normal-case tracking-normal text-tv-muted2">— every generated signal is tracked</span>
          </h3>
          <div className="ml-auto flex flex-wrap gap-1.5" role="group" aria-label="Filter signal history">
            {HIST_FILTERS.map((f) => (
              <button
                key={f.key}
                onClick={() => setHistFilter(f.key)}
                aria-pressed={histFilter === f.key}
                suppressHydrationWarning
                className={`inline-flex min-h-[44px] items-center rounded-full border px-3.5 py-2 text-[11.5px] font-bold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bull/50 ${
                  histFilter === f.key
                    ? 'border-bull/40 bg-bull/10 text-bull'
                    : 'border-tv-line bg-tv-panel2 text-tv-muted hover:border-tv-line-strong hover:text-tv-ink'
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>
        {data.performance && data.performance.total > 0 && (
          <div className="mb-3 flex flex-wrap items-center gap-1.5" aria-label="Live signal performance">
            <span className="text-[9.5px] font-bold uppercase tracking-[0.12em] text-tv-muted2">Live log</span>
            <span className="rounded-full border border-tv-line bg-tv-panel2 px-2.5 py-1 text-[10.5px] font-bold tabular-nums text-tv-ink">
              {data.performance.total} signals ({data.performance.longs}L/{data.performance.shorts}S)
            </span>
            {data.performance.open > 0 && (
              <span className="rounded-full border border-warn/35 bg-warn/10 px-2.5 py-1 text-[10.5px] font-bold tabular-nums text-warn">
                {data.performance.open} open
              </span>
            )}
            {data.performance.resolved > 0 && (
              <>
                <span className="rounded-full border border-tv-line bg-tv-panel2 px-2.5 py-1 text-[10.5px] font-bold tabular-nums text-tv-ink">
                  win {data.performance.winRatePct}%
                </span>
                <span className="rounded-full border border-tv-line bg-tv-panel2 px-2.5 py-1 text-[10.5px] font-bold tabular-nums text-tv-ink">
                  avg {data.performance.avgR > 0 ? '+' : ''}{data.performance.avgR}R
                </span>
                <span
                  className={`rounded-full border px-2.5 py-1 text-[10.5px] font-bold tabular-nums ${
                    data.performance.totalR > 0 ? 'border-bull/35 bg-bull/10 text-bull' : data.performance.totalR < 0 ? 'border-bear/35 bg-bear/10 text-bear' : 'border-tv-line bg-tv-panel2 text-tv-ink'
                  }`}
                >
                  {data.performance.totalR > 0 ? '+' : ''}{data.performance.totalR}R total
                </span>
                <span className="rounded-full border border-tv-line bg-tv-panel2 px-2.5 py-1 text-[10.5px] font-bold tabular-nums text-tv-muted">
                  {data.performance.wins}W/{data.performance.losses}L/{data.performance.breakevens}BE/{data.performance.expired}exp
                </span>
              </>
            )}
          </div>
        )}
        {histRows.length === 0 ? (
          <EmptyLine>no signals yet — the engine is conservative by design</EmptyLine>
        ) : (
          <div className={`max-h-96 rounded-xl border border-tv-line ${SCROLL_CLS}`}>
            <table className="w-full min-w-[720px] border-collapse text-left text-[12px]">
              <caption className="sr-only">SMC signal history</caption>
              <thead className="sticky top-0 z-10 bg-tv-panel2">
                <tr className="text-[10px] uppercase tracking-wider text-tv-muted">
                  <th scope="col" className="px-3 py-2 font-bold">Date</th>
                  <th scope="col" className="px-3 py-2 font-bold">Side</th>
                  <th scope="col" className="px-3 py-2 text-right font-bold">Entry</th>
                  <th scope="col" className="px-3 py-2 text-right font-bold">SL</th>
                  <th scope="col" className="px-3 py-2 text-right font-bold">TP1</th>
                  <th scope="col" className="px-3 py-2 text-right font-bold">Score</th>
                  <th scope="col" className="px-3 py-2 font-bold">Q</th>
                  <th scope="col" className="px-3 py-2 font-bold">Status</th>
                  <th scope="col" className="px-3 py-2 text-right font-bold">Result</th>
                </tr>
              </thead>
              <tbody>
                {histRows.map((h) => (
                  <tr key={h.id} className="border-t border-tv-line/60">
                    <td className="whitespace-nowrap px-3 py-2 tabular-nums text-tv-muted">{isMounted ? fmtDay(h.createdAt) : '—'}</td>
                    <td className="px-3 py-2">
                      <span
                        className={`inline-block whitespace-nowrap rounded-full border px-2 py-0.5 text-[10px] font-bold ${
                          h.direction === 'LONG' ? 'border-bull/35 bg-bull/10 text-bull' : 'border-bear/35 bg-bear/10 text-bear'
                        }`}
                      >
                        {h.direction}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-tv-ink">{fmtPrice(h.entryMid)}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-bear">{fmtPrice(h.stopLoss)}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-info">{fmtPrice(h.tp1)}</td>
                    <td className="px-3 py-2 text-right font-bold tabular-nums text-tv-ink">{h.score}</td>
                    <td className="px-3 py-2">
                      <span className={`inline-block rounded-full border px-2 py-0.5 text-[10px] font-bold ${qualityCls(h.quality)}`}>
                        {h.quality}
                      </span>
                    </td>
                    <td className="px-3 py-2">
                      <StatusChip status={h.status} />
                    </td>
                    <td className="px-3 py-2 text-right">
                      <ResultChip row={h} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </motion.section>

      {/* ── footer / disclaimer ── */}
      <footer className="mt-auto border-t border-tv-line pb-1 pt-3 text-[11px] leading-relaxed text-tv-muted">
        <b className="text-warn">Disclaimer:</b> {data.disclaimer}
        <br />
        Data: {data.dataSource === 'BINANCE_FALLBACK' ? 'Bybit public API · Binance fallback active' : 'Bybit public API'} · analysis only — no auto-trading
      </footer>
    </div>
  )
}
