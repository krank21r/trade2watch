'use client'

/**
 * EntryDecisions — the fused "what do I do right now?" panel.
 *
 * One card per watchlist symbol, ranked best-first. Each card merges:
 *   - Trade Setups (structure zones + bias)
 *   - AI Signals   (desk call + confidence)
 *   - Liquidity Lab (order-book tape, crypto only)
 * into a single action — TAKE / WAIT / SKIP / STAND ASIDE — with a 0-100
 * score, the named gate checklist, exact execution levels, and the precise
 * condition that turns a WAIT into a TAKE.
 *
 * Clicking a card expands that symbol's full trade-plan detail below
 * (same dropdown the watchlist pills use).
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import { ChevronDown, Play, RefreshCw, X } from 'lucide-react'
import { fmtPrice } from '@/components/signals/types'
import type { DecisionAction, EntryDecision, EntryDecisionsPayload } from '@/lib/entry/decide'
import { rNow, type MyTrade } from '@/lib/mytrades'
import { useToast } from '@/hooks/use-toast'
import { useTradeJournal } from '@/hooks/use-trade-journal'

const POLL_MS = 60_000

// ─── action styling ──────────────────────────────────────────────────────────

const ACTION: Record<DecisionAction, { badge: string; glyph: string; label: string; ring: string }> = {
  TAKE: {
    badge: 'bg-bull text-white border-bull',
    glyph: '▶',
    label: 'TAKE — act now',
    ring: 'border-bull/50',
  },
  WAIT: {
    badge: 'bg-warn/10 text-warn border-warn/40',
    glyph: '…',
    label: 'WAIT — set limits',
    ring: 'border-warn/40',
  },
  SKIP: {
    badge: 'bg-bear/10 text-bear border-bear/40',
    glyph: '✕',
    label: 'SKIP — conflicting',
    ring: 'border-bear/35',
  },
  STAND_ASIDE: {
    badge: 'bg-tv-muted/10 text-tv-muted border-tv-line-strong',
    glyph: '—',
    label: 'STAND ASIDE — no edge',
    ring: 'border-tv-line',
  },
}

const GATE_GLYPH: Record<string, { g: string; cls: string }> = {
  pass: { g: '✓', cls: 'text-bull' },
  warn: { g: '!', cls: 'text-warn' },
  fail: { g: '✕', cls: 'text-bear' },
  na: { g: '·', cls: 'text-tv-muted' },
}

const VOTE_STYLE: Record<string, string> = {
  LONG: 'bg-bull/10 text-bull border-bull/40',
  SHORT: 'bg-bear/10 text-bear border-bear/40',
  NEUTRAL: 'bg-tv-muted/10 text-tv-muted border-tv-line',
  NO_TRADE: 'bg-warn/10 text-warn border-warn/40',
  ABSENT: 'bg-tv-muted/10 text-tv-muted border-tv-line',
}

// ─── sub-components ──────────────────────────────────────────────────────────

function ScoreBar({ score }: { score: number }) {
  return (
    <div className="flex items-center gap-2 min-w-[92px]" title={`Entry quality score ${score}/100`}>
      <div className="h-1.5 flex-1 rounded-full bg-tv-panel2 border border-tv-line overflow-hidden" aria-hidden="true">
        <div
          className={`h-full rounded-full transition-all duration-500 ${score >= 70 ? 'bg-bull' : score >= 45 ? 'bg-warn' : 'bg-bear/70'}`}
          style={{ width: `${Math.max(3, score)}%` }}
        />
      </div>
      <span className="text-[11px] font-semibold tabular-nums text-tv-muted w-7 text-right">{score}</span>
    </div>
  )
}

function VoteChip({ system, vote, sub }: { system: string; vote: string; sub?: string }) {
  const shown = vote === 'ABSENT' ? 'n/a' : vote.replace(/_/g, ' ')
  return (
    <span
      title={`${system}: ${vote}${sub ? ` — ${sub}` : ''}`}
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold whitespace-nowrap ${VOTE_STYLE[vote] ?? VOTE_STYLE.NEUTRAL}`}
    >
      <span className="text-tv-muted font-semibold">{system}</span>
      {shown}
      {sub ? <span className="text-tv-muted font-medium">· {sub}</span> : null}
    </span>
  )
}

function DecisionCard({
  d,
  onOpen,
  onTrack,
  onCloseTrade,
  trackedTrade,
  index,
}: {
  d: EntryDecision
  onOpen: (symbol: string) => void
  onTrack: (d: EntryDecision) => void
  onCloseTrade: (id: string, livePrice: number) => void
  trackedTrade: MyTrade | null
  index: number
}) {
  const a = ACTION[d.action]
  const plan = d.plan
  const dirCls = d.consensus === 'LONG' ? 'text-bull' : d.consensus === 'SHORT' ? 'text-bear' : 'text-tv-muted'
  const liveR = trackedTrade ? rNow(trackedTrade, d.price) : 0

  return (
    <motion.article
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25, ease: 'easeOut', delay: Math.min(index * 0.04, 0.3) }}
      className={`flex h-full flex-col gap-2.5 rounded-2xl border bg-tv-panel p-3.5 shadow-xs transition-colors hover:bg-tv-panel2/40 ${a.ring}`}
    >
      {/* header — action + symbol + score */}
      <div className="flex items-start justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2 min-w-0">
          <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold tracking-wide ${a.badge}`}>
            <span aria-hidden="true">{a.glyph}</span>
            {d.action === 'STAND_ASIDE' ? 'STAND ASIDE' : d.action}
          </span>
          <div className="min-w-0">
            <div className="flex items-baseline gap-1.5">
              <h3 className="text-[14px] font-semibold tracking-tight text-tv-ink truncate">{d.pair}</h3>
              {d.consensus !== 'NONE' && (
                <span className={`text-[12px] font-bold ${dirCls}`}>
                  {d.consensus === 'LONG' ? '▲ BUY' : '▼ SELL'}
                </span>
              )}
            </div>
            <div className="text-[10.5px] text-tv-muted tabular-nums">
              {fmtPrice(d.price, d.currency)}
              {d.change24h != null && (
                <span className={d.change24h >= 0 ? ' text-bull' : ' text-bear'}>
                  {' '}
                  {d.change24h >= 0 ? '+' : ''}
                  {d.change24h.toFixed(1)}%
                </span>
              )}
            </div>
          </div>
        </div>
        <ScoreBar score={d.score} />
      </div>

      {/* consensus chips */}
      <div className="flex flex-wrap items-center gap-1.5">
        <VoteChip system="Setup" vote={d.votes.board} />
        <VoteChip
          system="AI"
          vote={d.votes.ai}
          sub={d.aiConfidence != null ? `${d.aiConfidence}%${d.aiFresh ? '' : ' stale'}` : undefined}
        />
        <VoteChip system="Flow" vote={d.votes.flow} sub={d.market === 'stock' ? 'crypto only' : undefined} />
        {plan && (
          <span className="ml-auto rounded-full border border-info/40 bg-info/10 px-2 py-0.5 text-[10px] font-semibold text-info">
            plan: {plan.source}
          </span>
        )}
      </div>

      {/* execution levels */}
      {plan ? (
        <div className="grid grid-cols-2 gap-1.5 rounded-xl border border-tv-line bg-tv-panel2/60 p-2 text-[11px] sm:grid-cols-4" role="list" aria-label={`${d.pair} decision plan levels`}>
          <div role="listitem">
            <div className="text-[10px] font-semibold uppercase tracking-wider text-warn">Entry</div>
            <div className="font-semibold tabular-nums text-tv-ink">
              {fmtPrice(plan.entryLow, d.currency)}–{fmtPrice(plan.entryHigh, d.currency)}
            </div>
          </div>
          <div role="listitem">
            <div className="text-[10px] font-semibold uppercase tracking-wider text-bear">Stop</div>
            <div className="font-semibold tabular-nums text-tv-ink">{fmtPrice(plan.stop, d.currency)}</div>
          </div>
          <div role="listitem">
            <div className="text-[10px] font-semibold uppercase tracking-wider text-info">TP1 / TP2</div>
            <div className="font-semibold tabular-nums text-tv-ink">
              {fmtPrice(plan.t1, d.currency)} / {fmtPrice(plan.t2, d.currency)}
            </div>
          </div>
          <div role="listitem">
            <div className="text-[10px] font-semibold uppercase tracking-wider text-tv-muted">R:R at T1</div>
            <div className={`font-semibold tabular-nums ${plan.rr >= 2 ? 'text-bull' : 'text-warn'}`}>1 : {plan.rr.toFixed(1)}</div>
          </div>
        </div>
      ) : (
        <div className="rounded-xl border border-tv-line bg-tv-panel2/60 p-2 text-[11px] text-tv-muted">
          No executable plan — {d.why.toLowerCase()}
        </div>
      )}

      {/* gate checklist */}
      <ul className="flex flex-wrap gap-x-3 gap-y-1" aria-label="decision gates">
        {d.gates.map((g) => {
          const gg = GATE_GLYPH[g.state]
          return (
            <li key={g.name} className="flex items-center gap-1 text-[10.5px]" title={`${g.name}: ${g.detail}`}>
              <span aria-hidden="true" className={`font-semibold ${gg.cls}`}>{gg.g}</span>
              <span className="text-tv-muted">{g.name}</span>
            </li>
          )
        })}
      </ul>

      {/* why + next step */}
      <p className="text-[11.5px] leading-snug text-tv-ink/90">{d.why}</p>
      {d.action !== 'TAKE' && d.action !== 'STAND_ASIDE' && (
        <p className="text-[11px] leading-snug font-semibold text-warn">{d.becomesTake}</p>
      )}
      {d.action === 'TAKE' && <p className="text-[11px] leading-snug font-semibold text-bull">{d.becomesTake}</p>}

      {/* actions — tracked state / track-this-trade (TAKE) / open full setup */}
      {trackedTrade ? (
        <div className="mt-auto flex flex-wrap items-center gap-2 rounded-xl border border-bull/30 bg-bull/5 px-2.5 py-1.5">
          <span
            className="inline-flex items-center gap-1.5 text-[10.5px] font-semibold text-bull"
            title={`Frozen plan · fill ${fmtPrice(trackedTrade.entryFill, trackedTrade.currency)} · SL ${fmtPrice(trackedTrade.stop, trackedTrade.currency)} · TP1 ${fmtPrice(trackedTrade.t1, trackedTrade.currency)} · TP2 ${fmtPrice(trackedTrade.t2, trackedTrade.currency)}`}
          >
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-bull" aria-hidden />
            TRACKED {trackedTrade.side.toUpperCase()}
            {trackedTrade.tp1HitAt != null && <span className="text-tv-muted">· TP1 banked</span>}
          </span>
          <span
            className={`text-[11px] font-semibold tabular-nums ${liveR >= 0 ? 'text-bull' : 'text-bear'}`}
            title="Live R multiple — current price vs the frozen fill"
          >
            {liveR > 0 ? '+' : ''}
            {liveR.toFixed(2)}R
          </span>
          <button
            onClick={() => onCloseTrade(trackedTrade.id, d.price)}
            suppressHydrationWarning
            aria-label={`Close the ${trackedTrade.displayName} tracked trade`}
            className="ml-auto inline-flex items-center gap-1 rounded-lg border border-bear/40 px-2 py-1 text-[10.5px] font-semibold text-bear transition-colors hover:bg-bear/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bear/50"
          >
            <X className="h-3 w-3" aria-hidden />
            Close
          </button>
          <button
            onClick={() => onOpen(d.symbol)}
            suppressHydrationWarning
            aria-label={`Open the full ${d.displayName} trade setup`}
            className="inline-flex items-center rounded-lg border border-tv-line bg-tv-panel2 px-2 py-1 text-[10.5px] font-semibold text-tv-ink transition-colors hover:bg-tv-inset focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bull/50"
          >
            Plan
            <ChevronDown className="h-3 w-3" aria-hidden />
          </button>
        </div>
      ) : d.action === 'TAKE' && plan ? (
        <div className="mt-auto flex flex-wrap items-center gap-2">
          <button
            onClick={() => onTrack(d)}
            suppressHydrationWarning
            aria-label={`Track the ${d.displayName} ${d.consensus} trade in your journal`}
            className="inline-flex items-center gap-1.5 rounded-xl bg-bull px-3 py-1.5 text-[11px] font-semibold text-white shadow-xs transition-colors hover:bg-bull/85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bull/50"
          >
            <Play className="h-3 w-3" aria-hidden />
            Track this trade
          </button>
          <button
            onClick={() => onOpen(d.symbol)}
            suppressHydrationWarning
            aria-label={`Open the full ${d.displayName} trade setup`}
            className="rounded-xl border border-tv-line bg-tv-panel2 px-3 py-1.5 text-[11px] font-semibold text-tv-ink transition-colors hover:bg-tv-inset focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bull/50"
          >
            Open full setup
            <ChevronDown className="h-3 w-3" aria-hidden />
          </button>
        </div>
      ) : (
        <button
          onClick={() => onOpen(d.symbol)}
          suppressHydrationWarning
          aria-label={`Open the full ${d.displayName} trade setup`}
          className="mt-auto self-start rounded-xl border border-tv-line bg-tv-panel2 px-3 py-1.5 text-[11px] font-semibold text-tv-ink transition-colors hover:bg-tv-inset focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bull/50"
        >
          Open full setup
          <ChevronDown className="h-3 w-3" aria-hidden />
        </button>
      )}
    </motion.article>
  )
}

// ─── main panel ──────────────────────────────────────────────────────────────

export function EntryDecisions({ symbols, onOpen }: { symbols: string[]; onOpen: (symbol: string) => void }) {
  const [data, setData] = useState<EntryDecisionsPayload | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const mounted = useRef(true)
  const { openTrades, openBySymbol, trackDecision, closeTrade } = useTradeJournal()
  const { toast } = useToast()
  // last seen action per symbol — a WAIT→TAKE flip while the tab is open fires a toast
  const prevActionsRef = useRef<Map<string, DecisionAction>>(new Map())

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const load = useCallback(async () => {
    if (symbols.length === 0) return
    try {
      const res = await fetch(`/api/entry-decision?symbols=${symbols.join(',')}`, { cache: 'no-store' })
      if (!res.ok) throw new Error(`API ${res.status}`)
      const d = (await res.json()) as EntryDecisionsPayload
      if (!mounted.current) return
      setData(d)
      setError(null)
      // WAIT→TAKE transition while the tab is open — surface it immediately
      const prev = prevActionsRef.current
      for (const x of d.decisions) {
        const before = prev.get(x.symbol)
        if (x.action === 'TAKE' && before && before !== 'TAKE') {
          toast({
            title: `⚡ ${x.pair} — now TAKE`,
            description: `${x.consensus} confirmed and price is in the zone — freeze it into the tracker from the card.`,
          })
        }
      }
      prevActionsRef.current = new Map(d.decisions.map((x) => [x.symbol, x.action]))
    } catch (e) {
      if (mounted.current) setError(String(e).slice(0, 120))
    } finally {
      if (mounted.current) setLoading(false)
    }
  }, [symbols, toast])

  useEffect(() => {
    setLoading(true)
    load()
    const t = setInterval(load, POLL_MS)
    return () => clearInterval(t)
  }, [load])

  const decisions = data?.decisions ?? []
  const takeCount = decisions.filter((x) => x.action === 'TAKE').length
  const waitCount = decisions.filter((x) => x.action === 'WAIT').length
  return (
    <section aria-label="Entry decisions" className="rounded-2xl border border-tv-line bg-tv-panel shadow-sm p-3.5 sm:p-4">
      {/* header */}
      <div className="flex flex-wrap items-center gap-2 mb-1">
        <h2 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-tv-muted">
          Entry decisions — <span className="text-tv-ink">one call per symbol</span>
        </h2>
        <span className="rounded-full border border-tv-line bg-tv-panel2 px-2 py-0.5 text-[10px] font-semibold text-tv-muted">
          Trade Setups × AI Signals × Liquidity Lab
        </span>
        <div className="ml-auto flex items-center gap-2">
          {data && (
            <span className="text-[10.5px] tabular-nums text-tv-muted">
              {takeCount > 0 && <b className="text-bull">{takeCount} take · </b>}
              {waitCount > 0 && <b className="text-warn">{waitCount} wait · </b>}
              {openTrades.length > 0 && <b className="text-info">{openTrades.length} tracked · </b>}
              updated {new Date(data.updatedAt).toLocaleTimeString()}
            </span>
          )}
          <button
            onClick={() => { setLoading(true); load() }}
            suppressHydrationWarning
            aria-label="Refresh entry decisions"
            className="inline-flex items-center rounded-xl border border-tv-line bg-tv-panel2 px-2.5 py-1.5 text-[11px] font-semibold text-tv-ink transition-colors hover:bg-tv-inset focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bull/50"
          >
            <RefreshCw className="h-3.5 w-3.5" aria-hidden />
          </button>
        </div>
      </div>
      <p className="text-[11px] text-tv-muted mb-3">
        <b className="text-bull">TAKE</b> = systems agree, the tape confirms and price is in the zone now — one press on{' '}
        <b className="text-tv-ink">Track this trade</b> freezes the plan into the tracker ·{' '}
        <b className="text-warn">WAIT</b> = direction agreed, entry not ready yet (the card says what must happen first) ·{' '}
        <b className="text-bear">SKIP</b> = systems conflict · <b className="text-tv-ink">STAND ASIDE</b> = no edge. Tracked trades follow the plan: bank half at TP1, stop to entry, close at TP2/SL.
      </p>

      {/* body */}
      {error && decisions.length === 0 ? (
        <p className="text-[12px] text-bear">
          Decision feed error: {error} —{' '}
          <button onClick={load} suppressHydrationWarning className="underline hover:text-tv-ink">retry now</button>
        </p>
      ) : loading && decisions.length === 0 ? (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 2xl:grid-cols-3" aria-hidden="true">
          {symbols.slice(0, 6).map((s) => (
            <div key={s} className="h-[168px] animate-pulse rounded-2xl border border-tv-line bg-tv-panel2/50" />
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 2xl:grid-cols-3">
          {decisions.map((d, i) => (
            <DecisionCard
              key={d.symbol}
              d={d}
              onOpen={onOpen}
              onTrack={trackDecision}
              onCloseTrade={closeTrade}
              trackedTrade={openBySymbol.get(d.symbol) ?? null}
              index={i}
            />
          ))}
        </div>
      )}

      {/* per-symbol failures */}
      {data && Object.keys(data.failed).length > 0 && (
        <p className="mt-2 text-[11px] text-tv-muted">
          No decision: {Object.entries(data.failed).map(([k, v]) => `${k} (${v.slice(0, 40)})`).join(', ')}
        </p>
      )}
    </section>
  )
}
