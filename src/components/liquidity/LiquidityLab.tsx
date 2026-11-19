'use client'

/**
 * Liquidity Lab — the 5-stage smart-money pipeline for crypto:
 *
 *   LIQUIDITY → ORDER FLOW → PRICE MOVEMENT → MARKET STRUCTURE → TRADE ENTRY
 *
 * Combined Binance spot + Bybit perp order books, open interest, taker flow,
 * swing-level liquidity pools and estimated liquidation zones. One "Run
 * analysis" press hits GET /api/liquidity/analyze?symbol= and the whole
 * report comes back as one LiquidityReport (src/lib/liquidity/types.ts) —
 * each stage renders independently, auto-refreshes every 60s once loaded.
 * Timeframe is LOCKED to 4H (one timeframe, one signal) and every entry
 * must clear the accuracy gates: structure+flow alignment, discount/premium
 * location, R:R ≥ 2.0 and confidence ≥ 70.
 * Research tool — not financial advice.
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import {
  ArrowDownRight,
  ArrowUpRight,
  ListOrdered,
  Loader2,
  Lock,
  RefreshCw,
  Shield,
  Target,
  Waves,
  Zap,
  type LucideIcon,
} from 'lucide-react'
import type {
  DepthCluster,
  EntrySignal,
  FlowStage,
  LiquidationZone,
  LiquidityReport,
  LiqPool,
  LiqTimeframe,
  MovementStage,
  StructureStage,
} from '@/lib/liquidity/types'

// ─── constants ───────────────────────────────────────────────────────────────

const PINNED_SYMBOLS = ['BTC', 'ETH', 'SOL', 'XRP', 'BNB', 'LINK'] as const
/** single-timeframe policy — one timeframe, one signal. Locked, not user-selectable. */
const TF: LiqTimeframe = '4h'
const REFRESH_MS = 60_000
const MAX_LADDER = 6
const SYMBOL_RE = /^[A-Z0-9]{2,12}$/

/** thin custom scrollbar for long lists (same recipe as smc/ui.tsx) */
const SCROLL_CLS =
  'overflow-y-auto [scrollbar-width:thin] [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-tv-line-strong'

/** GET /api/liquidity/analyze — full report on success, `{ ok: false, error }` on failure */
type AnalyzeResponse = LiquidityReport | { ok: false; error: string }

// ─── number formatting helpers ───────────────────────────────────────────────

/** prices — 2dp with thousands separators ≥1000, 4 significant digits below 1 */
const fmtPx = (v: number): string => {
  if (!Number.isFinite(v)) return '—'
  const a = Math.abs(v)
  if (a >= 1000) return v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  if (a >= 1) return v.toFixed(2)
  return String(parseFloat(v.toPrecision(4)))
}

/** USD notionals — $x.xxB / $x.xxM / $x.xK */
const fmtUsd = (v: number): string => {
  if (!Number.isFinite(v)) return '—'
  const a = Math.abs(v)
  const core =
    a >= 1e9
      ? `$${(a / 1e9).toFixed(2)}B`
      : a >= 1e6
        ? `$${(a / 1e6).toFixed(2)}M`
        : a >= 1e3
          ? `$${(a / 1e3).toFixed(1)}K`
          : `$${a.toFixed(0)}`
  return v < 0 ? `-${core}` : core
}

/** signed percent, 1dp */
const fmtPct = (v: number): string => (Number.isFinite(v) ? `${v > 0 ? '+' : ''}${v.toFixed(1)}%` : '—')

/** signed number, n dp */
const signed = (v: number, dp = 1): string => `${v > 0 ? '+' : ''}${v.toFixed(dp)}`

const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), hi)

// ─── shared atoms (TraderDesk className vocabulary) ──────────────────────────

const VERDICT_CLS = {
  bull: 'border-bull-line bg-bull-soft text-bull-ink',
  bear: 'border-bear-line bg-bear-soft text-bear',
  warn: 'border-warn-line bg-warn-soft text-warn',
  muted: 'border-tv-line bg-tv-panel2 text-tv-muted',
} as const
type VerdictTone = keyof typeof VERDICT_CLS

function Chip({ children, cls = 'border-tv-line bg-tv-panel2 text-tv-muted' }: { children: ReactNode; cls?: string }) {
  return (
    <span className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-[10px] font-bold ${cls}`}>
      {children}
    </span>
  )
}

function VerdictChip({ tone, children }: { tone: VerdictTone; children: ReactNode }) {
  return <Chip cls={`px-2.5 py-1 text-[11px] font-extrabold uppercase tracking-wide ${VERDICT_CLS[tone]}`}>{children}</Chip>
}

/** one label/value line — flex justify-between, muted label, bold tabular value */
function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2 text-[11.5px]">
      <span className="shrink-0 text-tv-muted">{label}</span>
      <span className="min-w-0 text-right font-semibold tabular-nums text-tv-ink">{children}</span>
    </div>
  )
}

/** tiny-uppercase-label level cell used in the entry grid */
function LevelCell({ label, value, cls = 'text-tv-ink', sub }: { label: string; value: string; cls?: string; sub?: string }) {
  return (
    <div className="rounded-lg border border-tv-line bg-tv-panel2/40 px-2.5 py-1.5">
      <div className="text-[9px] font-bold uppercase tracking-wider text-tv-muted2">{label}</div>
      <div className={`text-[12.5px] font-bold tabular-nums ${cls}`}>{value}</div>
      {sub && <div className="text-[10px] tabular-nums text-tv-muted">{sub}</div>}
    </div>
  )
}

/** numbered stage card — the badge sequence gives the pipeline its connector feel */
function StageCard({
  n,
  name,
  icon: Icon,
  borderCls = 'border-tv-line',
  className = '',
  children,
}: {
  n: number
  name: string
  icon: LucideIcon
  borderCls?: string
  className?: string
  children: ReactNode
}) {
  return (
    <section aria-label={`Stage ${n} · ${name}`} className={`min-w-0 rounded-2xl border bg-tv-panel p-4 ${borderCls} ${className}`}>
      <div className="mb-3 flex items-center gap-2">
        <span
          aria-hidden
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg border border-tv-line bg-tv-panel2 text-[11px] font-extrabold text-tv-ink"
        >
          {n}
        </span>
        <span className="text-[10.5px] font-bold uppercase tracking-wider text-tv-muted2">Stage {n} · {name}</span>
        <Icon className="ml-auto h-3.5 w-3.5 shrink-0 text-tv-muted2" aria-hidden />
      </div>
      {children}
    </section>
  )
}

export default function LiquidityLab() {
  const [symbol, setSymbol] = useState('BTC')
  const [custom, setCustom] = useState('')
  const [customErr, setCustomErr] = useState<string | null>(null)
  const [extras, setExtras] = useState<string[]>([])
  const [report, setReport] = useState<LiquidityReport | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [ranAt, setRanAt] = useState<Date | null>(null)

  const mounted = useRef(true)
  const abortRef = useRef<AbortController | null>(null)
  const reportRef = useRef<LiquidityReport | null>(null)
  const busyRef = useRef(false)
  const symRef = useRef(symbol)
  symRef.current = symbol

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      abortRef.current?.abort()
    }
  }, [])

  const run = useCallback(async (sym: string) => {
    abortRef.current?.abort()
    const ac = new AbortController()
    abortRef.current = ac
    busyRef.current = true
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`/api/liquidity/analyze?symbol=${encodeURIComponent(sym)}&tf=${TF}`, {
        cache: 'no-store',
        signal: ac.signal,
      })
      const body = (await res.json()) as AnalyzeResponse
      if (!res.ok || body.ok !== true) throw new Error(body.ok === false && body.error ? body.error : 'analysis failed')
      if (!mounted.current || ac.signal.aborted) return
      reportRef.current = body
      setReport(body)
      setRanAt(new Date())
    } catch (e) {
      if (!mounted.current || ac.signal.aborted) return
      setError(e instanceof Error && e.message ? e.message : 'analysis failed')
    } finally {
      // only the still-current run owns the busy flag — aborted runs stand down
      if (abortRef.current === ac) {
        busyRef.current = false
        if (mounted.current) setLoading(false)
      }
    }
  }, [])

  // switching symbol after a report exists re-reads immediately — the pills
  // and the report should never disagree; before the first run nothing fires
  useEffect(() => {
    if (reportRef.current) void run(symRef.current)
  }, [run, symbol])

  // auto-refresh every 60s — only when a report is already loaded and idle
  useEffect(() => {
    const iv = setInterval(() => {
      if (reportRef.current && !busyRef.current) void run(symRef.current)
    }, REFRESH_MS)
    return () => clearInterval(iv)
  }, [run])

  const addCustom = () => {
    const v = custom.trim().toUpperCase()
    if (!SYMBOL_RE.test(v)) {
      setCustomErr('Use 2–12 letters/digits — a USDT base symbol like DOGE')
      return
    }
    setCustomErr(null)
    setCustom('')
    setExtras((p) => (p.includes(v) ? p : [...p, v]))
    setSymbol(v)
    if (reportRef.current === null) void run(v) // otherwise the selection effect re-reads
  }

  const pills = [...PINNED_SYMBOLS, ...extras]
  const refreshing = loading && report !== null

  return (
    <div className="flex flex-col gap-4">
      {/* ── page header ─────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-lg font-extrabold tracking-tight text-tv-ink">Liquidity Lab</h1>
          <p className="text-[11.5px] text-tv-muted">
            Liquidity → Order flow → Price movement → Market structure → Trade entry — on ONE locked 4H timeframe.
            Combined Binance spot + Bybit perp order books, open interest, taker flow, swing-level liquidity pools and
            estimated liquidation zones; every entry must clear the accuracy gates (structure + flow aligned,
            discount/premium location, R:R ≥ 1:2, confidence ≥ 70%). Crypto only.
          </p>
        </div>
      </div>

      {/* ── control bar ─────────────────────────────────────────────────────── */}
      <div className="rounded-2xl border border-tv-line bg-tv-panel p-4">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2.5">
          {/* symbol pills + custom add */}
          <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Symbol">
            {pills.map((s) => (
              <button
                key={s}
                suppressHydrationWarning
                onClick={() => setSymbol(s)}
                aria-pressed={symbol === s}
                className={`btn rounded-lg border px-2.5 py-1 text-[11.5px] font-semibold ${
                  symbol === s ? 'border-bull-line bg-bull-soft text-bull-ink' : 'border-tv-line bg-tv-panel2 text-tv-muted hover:text-tv-ink'
                }`}
              >
                {s}
              </button>
            ))}
            <input
              value={custom}
              onChange={(e) => {
                setCustom(e.target.value)
                if (customErr) setCustomErr(null)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') addCustom()
              }}
              placeholder="e.g. DOGE"
              aria-label="Custom USDT symbol"
              spellCheck={false}
              className="w-24 rounded-lg border border-tv-line bg-tv-panel2 px-2 py-1 text-[11.5px] font-semibold uppercase text-tv-ink outline-none placeholder:font-normal placeholder:normal-case placeholder:text-tv-muted2 focus:border-bull-line"
            />
            <button
              suppressHydrationWarning
              onClick={addCustom}
              className="btn rounded-lg border border-tv-line bg-tv-panel2 px-2 py-1 text-[11px] font-bold text-tv-muted hover:text-tv-ink"
            >
              Add
            </button>
          </div>

          {/* timeframe — LOCKED: one timeframe, one accurate signal (no multi-TF setups) */}
          <div className="flex items-center gap-2" role="group" aria-label="Timeframe locked to 4H">
            <Chip cls="border-bull-line bg-bull-soft text-bull-ink">
              <Lock className="h-3 w-3" aria-hidden />
              4H locked
            </Chip>
            <span className="text-[10px] leading-tight text-tv-muted2">
              one timeframe · one signal
              <br />
              accuracy-gated entry
            </span>
          </div>

          {/* run + freshness */}
          <div className="flex flex-wrap items-center gap-2.5 md:ml-auto">
            <button
              suppressHydrationWarning
              onClick={() => void run(symbol)}
              disabled={loading}
              className="btn gap-1.5 rounded-xl bg-bull px-4 py-2 text-[12px] font-bold text-white hover:bg-bull-deep disabled:cursor-not-allowed disabled:opacity-50"
            >
              {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <RefreshCw className="h-3.5 w-3.5" aria-hidden />}
              {loading ? 'Analyzing…' : 'Run analysis'}
            </button>
            <div className="leading-tight">
              <div className="text-[11px] text-tv-muted" suppressHydrationWarning>
                {ranAt ? `as of ${ranAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}` : 'not run yet'}
                {refreshing && (
                  <span className="ml-1.5 inline-flex items-center gap-1 font-semibold text-bull">
                    <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
                    refreshing
                  </span>
                )}
              </div>
              <div className="text-[10px] text-tv-muted2">auto every 60s</div>
            </div>
          </div>
        </div>
        {customErr && <p className="mt-2 text-[11px] font-semibold text-warn">⚠ {customErr}</p>}
      </div>

      {/* ── error — warn card; a prior report stays visible below ───────────── */}
      {error && (
        <div role="alert" className="flex flex-wrap items-center gap-3 rounded-2xl border border-warn-line bg-warn-soft p-3.5">
          <Zap className="h-4 w-4 shrink-0 text-warn" aria-hidden />
          <p className="min-w-0 flex-1 text-[11.5px] font-semibold text-warn">Liquidity read failed — {error}</p>
          <button
            suppressHydrationWarning
            onClick={() => void run(symbol)}
            disabled={loading}
            className="btn rounded-xl border border-warn-line bg-tv-panel px-3 py-1.5 text-[11.5px] font-bold text-warn hover:bg-warn/10 disabled:opacity-50"
          >
            Retry
          </button>
        </div>
      )}

      {/* ── empty state ─────────────────────────────────────────────────────── */}
      {!report && !loading && !error && (
        <div className="rounded-xl border border-dashed border-tv-line bg-tv-panel2/40 px-3 py-6 text-center text-[11.5px] text-tv-muted">
          Press <span className="font-bold text-tv-ink">Run analysis</span> for the 5-stage liquidity read on the selected
          symbol.
        </div>
      )}

      {/* ── first-run loading ───────────────────────────────────────────────── */}
      {!report && loading && (
        <div role="status" className="flex items-center justify-center gap-2 rounded-2xl border border-tv-line bg-tv-panel p-8 text-[12px] text-tv-muted">
          <Loader2 className="h-4 w-4 animate-spin text-bull" aria-hidden />
          Reading order books, liquidity pools and flow…
        </div>
      )}

      {/* ── report — five numbered stages in pipeline order ─────────────────── */}
      {report && (
        <div aria-live="polite" aria-busy={loading} className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-tv-muted">
            <span className="font-bold text-tv-ink">{report.symbol}</span>
            <span>{report.displayName}</span>
            <span aria-hidden>·</span>
            <span className="font-semibold">{report.timeframe}</span>
            <span aria-hidden>·</span>
            <span className="tabular-nums">spot {fmtPx(report.spot)}</span>
          </div>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <LiquidityView r={report} />
            <FlowView f={report.flow} />
            <MovementView m={report.movement} />
            <StructureView s={report.structure} spot={report.spot} />
            <EntryView e={report.entry} />
          </div>
        </div>
      )}

      {/* ── footer note ─────────────────────────────────────────────────────── */}
      <p className="text-[10px] text-tv-muted2">
        Order books: Binance spot + Bybit linear perp. Liquidation zones are model estimates (open-interest × leverage
        bands + wick cascades) — not CoinGlass feed. Research tool — not financial advice.
      </p>
    </div>
  )
}

// ─── stage 1 · liquidity ─────────────────────────────────────────────────────

function LiquidityView({ r }: { r: LiquidityReport }) {
  const liq = r.liquidity
  // ladder order: highest ask on top → down to spot → highest bid just below
  const asks = liq.book.clusters.filter((c) => c.side === 'ask').sort((a, b) => b.priceFrom - a.priceFrom).slice(0, MAX_LADDER)
  const bids = liq.book.clusters.filter((c) => c.side === 'bid').sort((a, b) => b.priceFrom - a.priceFrom).slice(0, MAX_LADDER)
  const maxN = Math.max(1, ...asks.map((c) => c.notional), ...bids.map((c) => c.notional))
  const imb = liq.book.imbalancePct
  const imbTone = imb > 5 ? 'text-bull' : imb < -5 ? 'text-bear' : 'text-tv-muted'
  const imbWord = imb > 5 ? 'bids heavier' : imb < -5 ? 'asks heavier' : 'two-sided'

  return (
    <StageCard n={1} name="Liquidity" icon={Waves} className="lg:col-span-2">
      {/* book imbalance gauge — fill grows from the center marker */}
      <div className="mb-4">
        <div className="mb-1.5 flex flex-wrap items-baseline justify-between gap-x-2 gap-y-0.5">
          <span className="text-[10.5px] font-bold uppercase tracking-wider text-tv-muted2">Book imbalance · ±1%</span>
          <span className={`text-[12.5px] font-extrabold tabular-nums ${imbTone}`}>
            {fmtPct(imb)} <span className="text-[10.5px] font-bold">({imbWord})</span>
          </span>
        </div>
        <div className="relative h-2.5 rounded-full bg-tv-panel2">
          {imb >= 0 ? (
            <div className="absolute inset-y-0 left-1/2 rounded-r-full bg-bull/50" style={{ width: `${clamp(Math.abs(imb), 0, 100) / 2}%` }} aria-hidden />
          ) : (
            <div className="absolute inset-y-0 right-1/2 rounded-l-full bg-bear/50" style={{ width: `${clamp(Math.abs(imb), 0, 100) / 2}%` }} aria-hidden />
          )}
          <div className="absolute left-1/2 top-1/2 h-4 w-px -translate-y-1/2 bg-tv-line-strong" aria-hidden />
        </div>
        <p className="mt-1 text-[10.5px] tabular-nums text-tv-muted">
          {fmtUsd(liq.book.bidNotional1pct)} bids · {fmtUsd(liq.book.askNotional1pct)} asks within 1%
        </p>
      </div>

      {/* liquidity ladder — resting walls, width ∝ notional vs the largest */}
      <div className="mb-4">
        <div className="mb-1.5 text-[10.5px] font-bold uppercase tracking-wider text-tv-muted2">Liquidity ladder — resting order walls</div>
        {asks.length === 0 && bids.length === 0 ? (
          <p className="rounded-lg border border-dashed border-tv-line bg-tv-panel2/40 px-3 py-2.5 text-center text-[11px] text-tv-muted">
            No significant resting clusters in ±5%
          </p>
        ) : (
          <div className="flex flex-col gap-1">
            {asks.map((c) => (
              <LadderRow key={`ask-${c.priceFrom}-${c.priceTo}`} c={c} maxN={maxN} />
            ))}

            {/* spot price row between the ask and bid columns */}
            <div className="my-1 flex items-center justify-between gap-2 rounded-lg border border-tv-line bg-tv-panel2/60 px-2.5 py-1">
              <span className="text-[9px] font-bold uppercase tracking-wider text-tv-muted2">Spot</span>
              <span className="text-[13px] font-extrabold tabular-nums tracking-tight text-tv-ink">{fmtPx(liq.book.spot)}</span>
              {r.change24hPct === null ? (
                <span className="text-[10px] tabular-nums text-tv-muted2">24h —</span>
              ) : (
                <Chip cls={r.change24hPct >= 0 ? 'border-bull/40 bg-bull/10 text-bull' : 'border-bear/40 bg-bear/10 text-bear'}>
                  {r.change24hPct >= 0 ? (
                    <ArrowUpRight className="h-3 w-3" aria-hidden />
                  ) : (
                    <ArrowDownRight className="h-3 w-3" aria-hidden />
                  )}
                  {fmtPct(r.change24hPct)} 24h
                </Chip>
              )}
            </div>

            {bids.map((c) => (
              <LadderRow key={`bid-${c.priceFrom}-${c.priceTo}`} c={c} maxN={maxN} />
            ))}
          </div>
        )}
      </div>

      {/* pools + estimated liquidation zones */}
      <div className="grid gap-4 md:grid-cols-2">
        <div className="min-w-0">
          <div className="mb-1.5 text-[10.5px] font-bold uppercase tracking-wider text-tv-muted2">Liquidity pools</div>
          {liq.pools.length === 0 ? (
            <p className="rounded-lg border border-dashed border-tv-line bg-tv-panel2/40 px-3 py-2.5 text-center text-[11px] text-tv-muted">
              No pools mapped in this read
            </p>
          ) : (
            <ul className={`flex max-h-44 flex-col gap-1 pr-1 ${SCROLL_CLS}`}>
              {liq.pools.map((p, i) => (
                <PoolRow key={`${p.kind}-${p.price}-${i}`} p={p} />
              ))}
            </ul>
          )}
        </div>
        <div className="min-w-0">
          <div className="mb-1.5 text-[10.5px] font-bold uppercase tracking-wider text-tv-muted2">Estimated liquidation zones</div>
          {liq.liquidations.length === 0 ? (
            <p className="rounded-lg border border-dashed border-tv-line bg-tv-panel2/40 px-3 py-2.5 text-center text-[11px] text-tv-muted">
              No liquidation zones estimated
            </p>
          ) : (
            <ul className="flex flex-col gap-1">
              {liq.liquidations.map((z, i) => (
                <LiqRow key={`${z.side}-${z.priceFrom}-${i}`} z={z} />
              ))}
            </ul>
          )}
        </div>
      </div>

      {/* nearest pool + honest sources + interpretation */}
      <div className="mt-3 border-t border-tv-div pt-2.5">
        <p className="text-[11.5px] text-tv-muted">
          {liq.nearestPool ? (
            <>
              Nearest pool: <span className="font-bold text-tv-ink">{liq.nearestPool.label} {fmtPx(liq.nearestPool.price)}</span> (
              {fmtPct(liq.nearestPool.distancePct)})
            </>
          ) : (
            'Nearest pool: none mapped'
          )}
        </p>
        <p className="mt-0.5 text-[10px] text-tv-muted2">{liq.sources.join(' · ')}</p>
      </div>
      <p className="mt-2.5 text-[11px] leading-snug text-tv-muted">{liq.read}</p>
    </StageCard>
  )
}

/** one ladder row — bar width ∝ notional vs largest cluster (min 8px via CSS max) */
function LadderRow({ c, maxN }: { c: DepthCluster; maxN: number }) {
  const isAsk = c.side === 'ask'
  const mid = (c.priceFrom + c.priceTo) / 2
  const pct = clamp((c.notional / maxN) * 100, 0, 100)
  return (
    <div
      title={`${c.venue} · ${fmtPx(c.priceFrom)}–${fmtPx(c.priceTo)} · qty ${c.qty} · strength ${c.strength}/10`}
      className="flex items-center gap-2"
    >
      <div className="relative h-6 min-w-0 flex-1 rounded-md bg-tv-inset">
        <div
          aria-hidden
          className={`absolute inset-y-0 left-0 rounded-md border ${isAsk ? 'border-bear/40 bg-bear/30' : 'border-bull/40 bg-bull/30'}`}
          style={{ width: `max(8px, ${pct}%)` }}
        />
        <span className={`absolute left-1.5 top-1/2 -translate-y-1/2 text-[11px] font-bold tabular-nums ${isAsk ? 'text-bear' : 'text-bull'}`}>
          {fmtPx(mid)}
        </span>
      </div>
      <span className="w-16 shrink-0 text-right text-[10px] tabular-nums text-tv-muted hidden sm:inline">{fmtUsd(c.notional)}</span>
    </div>
  )
}

/** one liquidity pool — kind chip (EQH/EQL warn when within 1% of spot) + weight dots */
function PoolRow({ p }: { p: LiqPool }) {
  const above = p.distancePct >= 0
  const eqNear = (p.kind === 'EQH' || p.kind === 'EQL') && Math.abs(p.distancePct) < 1
  const w = Math.round(clamp(p.weight, 0, 10))
  return (
    <li className="flex items-center gap-1.5 rounded-lg border border-tv-line/60 bg-tv-panel2/40 px-2 py-1 text-[11.5px]">
      <span aria-hidden className={`shrink-0 text-[10px] ${above ? 'text-bull' : 'text-bear'}`}>
        {above ? '▲' : '▼'}
      </span>
      <span
        className={`shrink-0 rounded-full border px-1.5 py-0.5 text-[9.5px] font-extrabold tracking-wide ${
          eqNear ? 'border-warn-line bg-warn-soft text-warn' : 'border-tv-line bg-tv-panel2 text-tv-muted'
        }`}
      >
        {p.kind}
      </span>
      <span className="shrink-0 font-bold tabular-nums text-tv-ink">{fmtPx(p.price)}</span>
      <span className="min-w-0 truncate text-[10.5px] text-tv-muted2">{p.label}</span>
      <span className="ml-auto shrink-0 tabular-nums text-tv-muted">{fmtPct(p.distancePct)}</span>
      <span className="shrink-0 text-[9px] tracking-tighter text-tv-muted2" title={`weight ${p.weight}/10`} aria-label={`weight ${p.weight} of 10`}>
        {'●'.repeat(w)}
        {'○'.repeat(10 - w)}
      </span>
    </li>
  )
}

/** one estimated liquidation zone — longs liquidate below spot (bearish), shorts above (bullish) */
function LiqRow({ z }: { z: LiquidationZone }) {
  return (
    <li
      title={z.label}
      className="flex flex-wrap items-center gap-x-2 gap-y-0.5 rounded-lg border border-tv-line/60 bg-tv-panel2/40 px-2 py-1 text-[11.5px]"
    >
      <span
        className={`shrink-0 rounded-full border px-1.5 py-0.5 text-[9.5px] font-bold uppercase ${
          z.side === 'long' ? 'border-bear/40 bg-bear/10 text-bear' : 'border-bull/40 bg-bull/10 text-bull'
        }`}
      >
        {z.side === 'long' ? 'Long liqs' : 'Short liqs'}
      </span>
      <span className="shrink-0 font-semibold tabular-nums text-tv-ink">
        {fmtPx(z.priceFrom)}–{fmtPx(z.priceTo)}
      </span>
      <span className="shrink-0 tabular-nums text-tv-muted">{fmtUsd(z.estNotional)}</span>
      <span className="ml-auto rounded border border-tv-line px-1 py-px text-[9.5px] font-bold uppercase tracking-wide text-tv-muted2">
        {z.source}
      </span>
    </li>
  )
}

// ─── stage 2 · order flow ────────────────────────────────────────────────────

function FlowView({ f }: { f: FlowStage }) {
  const tone: VerdictTone = f.verdict === 'AGGRESSIVE_BUYING' ? 'bull' : f.verdict === 'AGGRESSIVE_SELLING' ? 'bear' : 'muted'
  const markerPct = clamp(((f.score + 10) / 20) * 100, 0, 100)
  const fillPct = (Math.abs(f.score) / 10) * 50
  return (
    <StageCard n={2} name="Order flow" icon={Zap}>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <VerdictChip tone={tone}>{f.verdict.replace(/_/g, ' ')}</VerdictChip>
        <span className="text-[11px] font-bold tabular-nums text-tv-muted">
          {signed(f.score, 1)} / 10 {f.score > 0.05 ? 'buyers' : f.score < -0.05 ? 'sellers' : 'neutral'}
        </span>
      </div>

      {/* −10..10 score meter — marker + fill grow from the center */}
      <div className="mb-3">
        <div className="relative h-2.5 rounded-full bg-tv-panel2">
          {f.score >= 0 ? (
            <div className="absolute inset-y-0 left-1/2 rounded-r-full bg-bull/50" style={{ width: `${clamp(fillPct, 0, 50)}%` }} aria-hidden />
          ) : (
            <div className="absolute inset-y-0 right-1/2 rounded-l-full bg-bear/50" style={{ width: `${clamp(fillPct, 0, 50)}%` }} aria-hidden />
          )}
          <div className="absolute left-1/2 top-1/2 h-4 w-px -translate-y-1/2 bg-tv-line-strong" aria-hidden />
          <div className="absolute top-1/2 h-3.5 w-1 -translate-x-1/2 -translate-y-1/2 rounded-full bg-tv-ink" style={{ left: `${markerPct}%` }} aria-hidden />
        </div>
        <div className="mt-1 flex justify-between text-[9px] font-bold uppercase tracking-wider text-tv-muted2">
          <span>−10 sellers</span>
          <span>0</span>
          <span>buyers +10</span>
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <Row label="CVD trend">
          <span className={f.cvdTrend === 'buying' ? 'text-bull' : f.cvdTrend === 'selling' ? 'text-bear' : 'text-tv-muted'}>{f.cvdTrend}</span>
          {' · '}
          {signed(f.cvdSlope, 2)}
        </Row>
        <Row label="Book imbalance">{fmtPct(f.bookImbalancePct)}</Row>
        <Row label="Open interest 24h">
          {f.oiChange24hPct === null ? (
            '—'
          ) : (
            <Chip cls={f.oiChange24hPct >= 0 ? 'border-bull/40 bg-bull/10 text-bull' : 'border-bear/40 bg-bear/10 text-bear'}>
              {fmtPct(f.oiChange24hPct)}
            </Chip>
          )}
        </Row>
        <Row label="Taker buy/sell">
          {f.takerRatio === null ? '—' : `${f.takerRatio.toFixed(2)}× ${f.takerRatio > 1 ? 'buy dominance' : 'sell dominance'}`}
        </Row>
      </div>
      {f.oiPriceAlignment && (
        <p className="mt-2 rounded-lg border border-tv-line/60 bg-tv-panel2/40 px-2.5 py-1.5 text-[11px] leading-snug text-tv-muted">
          {f.oiPriceAlignment}
        </p>
      )}
      <p className="mt-2.5 text-[11px] leading-snug text-tv-muted">{f.read}</p>
      <p className="mt-1.5 text-[10px] text-tv-muted2">{f.sources.join(' · ')}</p>
    </StageCard>
  )
}

// ─── stage 3 · price movement ────────────────────────────────────────────────

function MovementView({ m }: { m: MovementStage }) {
  const tone: VerdictTone =
    m.verdict === 'EXPANSION_UP' ? 'bull' : m.verdict === 'EXPANSION_DOWN' ? 'bear' : m.verdict === 'SQUEEZE' ? 'muted' : 'warn'
  return (
    <StageCard n={3} name="Price movement" icon={ArrowUpRight}>
      <div className="mb-3">
        <VerdictChip tone={tone}>{m.verdict.replace(/_/g, ' ')}</VerdictChip>
      </div>
      <div className="flex flex-col gap-1.5">
        <Row label="EMA20">{m.ema20 === null ? '—' : fmtPx(m.ema20)}</Row>
        <Row label="EMA50">{m.ema50 === null ? '—' : fmtPx(m.ema50)}</Row>
        <Row label="EMA20 slope / bar">
          <span className={m.slopePctPerBar > 0 ? 'text-bull' : m.slopePctPerBar < 0 ? 'text-bear' : 'text-tv-muted'}>
            {fmtPct(m.slopePctPerBar)}
          </span>
        </Row>
        <Row label="ATR (trailing window)">
          {fmtPx(m.atr)} · {Math.round(m.atrPctile)}th pct
          {m.atrPctile >= 70 ? ' — expansion' : m.atrPctile <= 30 ? ' — compression' : ''}
        </Row>
      </div>

      {/* displacement + unfilled FVG — bull/bear tinted when present */}
      <div className="mt-2 flex flex-col gap-1.5">
        <p
          className={`rounded-lg border px-2.5 py-1.5 text-[11px] leading-snug ${
            m.displacement
              ? m.displacement.direction === 'up'
                ? 'border-bull-line bg-bull-soft text-bull-ink'
                : 'border-bear-line bg-bear-soft text-bear'
              : 'border-tv-line/60 bg-tv-panel2/40 text-tv-muted'
          }`}
        >
          {m.displacement
            ? `Displacement: ${m.displacement.direction} move · body ${m.displacement.bodyAtr.toFixed(1)}×ATR · ${m.displacement.barAgo} bars ago`
            : 'No displacement candles'}
        </p>
        <p
          className={`rounded-lg border px-2.5 py-1.5 text-[11px] leading-snug ${
            m.fvg
              ? m.fvg.direction === 'up'
                ? 'border-bull-line bg-bull-soft text-bull-ink'
                : 'border-bear-line bg-bear-soft text-bear'
              : 'border-tv-line/60 bg-tv-panel2/40 text-tv-muted'
          }`}
        >
          {m.fvg
            ? `Unfilled ${m.fvg.direction === 'up' ? 'bullish' : 'bearish'} FVG ${fmtPx(m.fvg.from)}–${fmtPx(m.fvg.to)}`
            : 'No unfilled FVG'}
        </p>
      </div>
      <p className="mt-2.5 text-[11px] leading-snug text-tv-muted">{m.read}</p>
    </StageCard>
  )
}

// ─── stage 4 · market structure ──────────────────────────────────────────────

function StructureView({ s, spot }: { s: StructureStage; spot: number }) {
  const tone: VerdictTone = s.trend === 'BULL' ? 'bull' : s.trend === 'BEAR' ? 'bear' : 'warn'
  const pos = clamp(s.positionPct, 0, 100)
  const labelPct = clamp(pos, 8, 92) // keep the spot price chip inside the card
  return (
    <StageCard n={4} name="Market structure" icon={Shield}>
      <div className="mb-3 flex flex-wrap items-center gap-1.5">
        <VerdictChip tone={tone}>{s.trend}</VerdictChip>
        {s.labels.map((l, i) => (
          <Chip
            key={`${l}-${i}`}
            cls={
              l === 'HH' || l === 'HL'
                ? 'border-bull/40 bg-bull/10 text-bull'
                : l === 'LH' || l === 'LL'
                  ? 'border-bear/40 bg-bear/10 text-bear'
                  : 'border-tv-line bg-tv-panel2 text-tv-muted'
            }
          >
            {l}
          </Chip>
        ))}
      </div>

      {s.bos && (
        <p
          className={`mb-3 rounded-lg border px-2.5 py-1.5 text-[11px] font-semibold leading-snug ${
            s.bos.type === 'CHOCH'
              ? 'border-warn-line bg-warn-soft text-warn'
              : s.bos.direction === 'bull'
                ? 'border-bull-line bg-bull-soft text-bull-ink'
                : 'border-bear-line bg-bear-soft text-bear'
          }`}
        >
          {s.bos.direction === 'bull' ? 'Bull' : 'Bear'} {s.bos.type} {fmtPx(s.bos.price)} · {s.bos.barAgo} bars ago
        </p>
      )}

      {/* premium / discount meter — bottom 40% discount (buy zone), top 40% premium (sell zone) */}
      <div className="mb-3">
        <div className="mb-1 flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
          <span className="text-[10.5px] font-bold uppercase tracking-wider text-tv-muted2">Premium / discount</span>
          <Chip
            cls={
              s.zone === 'DISCOUNT'
                ? 'border-bull-line bg-bull-soft text-bull-ink'
                : s.zone === 'PREMIUM'
                  ? 'border-bear-line bg-bear-soft text-bear'
                  : 'border-tv-line bg-tv-panel2 text-tv-muted'
            }
          >
            {s.zone} {Math.round(s.positionPct)}%
          </Chip>
        </div>
        <div className="relative mb-1 h-4">
          <span
            className="absolute top-0 -translate-x-1/2 whitespace-nowrap rounded border border-tv-line bg-tv-panel2 px-1 py-px text-[9.5px] font-bold tabular-nums text-tv-ink"
            style={{ left: `${labelPct}%` }}
            title="spot price"
          >
            {fmtPx(spot)}
          </span>
        </div>
        <div className="relative h-3 w-full rounded-full bg-tv-panel2">
          <div className="absolute inset-y-0 left-0 rounded-l-full bg-bull/25" style={{ width: '40%' }} aria-hidden />
          <div className="absolute inset-y-0 right-0 rounded-r-full bg-bear/25" style={{ width: '40%' }} aria-hidden />
          <div className="absolute inset-y-[-3px] left-[40%] w-px bg-tv-line-strong" aria-hidden />
          <div className="absolute inset-y-[-3px] left-[60%] w-px bg-tv-line-strong" aria-hidden />
          <div
            className="absolute top-1/2 h-4 w-1 -translate-x-1/2 -translate-y-1/2 rounded-full bg-tv-ink"
            style={{ left: `${pos}%` }}
            aria-hidden
          />
        </div>
        <div className="mt-1 flex justify-between text-[9px] font-bold uppercase tracking-wider text-tv-muted2">
          <span>Discount — buy zone</span>
          <span>EQ</span>
          <span>Premium — sell zone</span>
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <Row label="Range (swing low–high)">
          {fmtPx(s.rangeLow)}–{fmtPx(s.rangeHigh)}
        </Row>
        <Row label="Equilibrium">{fmtPx(s.equilibrium)}</Row>
      </div>
      <p className="mt-2.5 text-[11px] leading-snug text-tv-muted">{s.read}</p>
    </StageCard>
  )
}

// ─── stage 5 · trade entry — the payoff card ─────────────────────────────────

function EntryView({ e }: { e: EntrySignal }) {
  const isLong = e.direction === 'LONG'
  const isShort = e.direction === 'SHORT'
  const tradeable = isLong || isShort
  return (
    <StageCard
      n={5}
      name="Trade entry"
      icon={Target}
      borderCls={isLong ? 'border-bull-line' : isShort ? 'border-bear-line' : 'border-tv-line'}
    >
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span className={`text-xl font-extrabold tracking-tight ${isLong ? 'text-bull' : isShort ? 'text-bear' : 'text-tv-ink'}`}>
          {e.direction === 'NO_TRADE' ? 'NO TRADE' : e.direction}
        </span>
        {e.model !== 'NONE' && (
          <Chip cls={isLong ? VERDICT_CLS.bull : isShort ? VERDICT_CLS.bear : VERDICT_CLS.muted}>{e.model.replace(/_/g, ' ')}</Chip>
        )}
        <Chip cls={isLong ? 'border-bull/40 bg-bull/10 text-bull' : isShort ? 'border-bear/40 bg-bear/10 text-bear' : 'border-tv-line bg-tv-panel2 text-tv-muted'}>
          Confidence {Math.round(e.confidence)}%
        </Chip>
        {tradeable && (
          <Chip cls="border-bull-line bg-bull-soft text-bull-ink">
            <Shield className="h-3 w-3" aria-hidden />
            accuracy gate passed
          </Chip>
        )}
      </div>

      {tradeable ? (
        <>
          <div className="mb-3 grid gap-2 sm:grid-cols-2">
            <LevelCell label="Entry zone" value={`${fmtPx(e.entryLow)}–${fmtPx(e.entryHigh)}`} />
            <LevelCell label="Stop" value={fmtPx(e.stop)} cls="text-bear" />
            <LevelCell label="Target 1" value={fmtPx(e.target1)} cls="text-bull" sub={e.riskReward} />
            <LevelCell label="Target 2" value={fmtPx(e.target2)} cls="text-bull" />
          </div>
          {e.trigger && (
            <p className="mb-1.5 flex items-start gap-1.5 rounded-lg border border-warn-line bg-warn-soft px-2.5 py-1.5 text-[11px] font-semibold leading-snug text-warn">
              <Zap className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
              <span>Trigger: {e.trigger}</span>
            </p>
          )}
          {e.invalidation && (
            <p className="flex items-start gap-1.5 rounded-lg border border-bear-line bg-bear-soft px-2.5 py-1.5 text-[11px] font-semibold leading-snug text-bear">
              <Shield className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
              <span>Invalidation: {e.invalidation}</span>
            </p>
          )}
        </>
      ) : (
        e.blockers.length > 0 && (
          <ul className="mb-1.5 flex flex-col gap-1 rounded-lg border border-warn-line bg-warn-soft p-2.5">
            {e.blockers.map((b, i) => (
              <li key={i} className="flex items-start gap-1.5 text-[11.5px] leading-snug text-warn">
                <span aria-hidden className="mt-px">
                  •
                </span>
                <span>{b}</span>
              </li>
            ))}
          </ul>
        )
      )}

      {/* evidence chain — the pipeline itself, step by step */}
      {e.evidence.length > 0 && (
        <div className="mt-3">
          <h4 className="mb-1.5 flex items-center gap-1.5 text-[10.5px] font-bold uppercase tracking-wider text-tv-muted2">
            <ListOrdered className="h-3.5 w-3.5" aria-hidden /> Evidence chain — liquidity → flow → movement → structure
          </h4>
          <ol className="flex flex-col gap-1.5 border-l-2 border-tv-line pl-3">
            {e.evidence.map((step, i) => (
              <li key={i} className="flex items-start gap-2 text-[11.5px] leading-snug text-tv-muted">
                <span
                  aria-hidden
                  className="mt-px flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-tv-line bg-tv-panel2 text-[9px] font-extrabold text-tv-ink"
                >
                  {i + 1}
                </span>
                <span className="min-w-0">{step}</span>
              </li>
            ))}
          </ol>
        </div>
      )}
    </StageCard>
  )
}
