'use client'

// ─── Trade Confirmed — TOP section of the Trade Setups page ────────────
// Sits where the old ZoneWatch watchlist cards were (user request): the
// confirmed entries are the first thing you see. Compact by design: shows
// trades whose entry is confirmed (price inside the
// entry zone right now, or the zone was HIT by a candle wick), the user's
// open trades with frozen-plan TP/SL tracking, and history rows. Receives the
// shared /api/setups payload from SetupBoard as a prop — one fetch feeds the
// whole page (no duplicate polling). Personal state keeps the same scoped
// keys: 'confirmed_log' + the account-synced trade journal.

import { useEffect, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import { useToast } from '@/hooks/use-toast'
import { fmtPrice } from '@/components/signals/types'
import { loadMyTrades, saveMyTrades, fetchMyTrades, trackTrade, zoneMid, rNow, netR, netRTxt, outcomeTxt, type MyTrade } from '@/lib/mytrades'
import type { Candle } from '@/lib/market/indicators'
import type { BoardSetup, SetupsPayload, SideSetup } from '@/lib/setups/generate'
import { APP_LAUNCH_MS } from '@/lib/setups/generate'
import { scopedGet, scopedGetJson, scopedSetJson } from '@/lib/user-scope'

const POLL_MS = 45_000
const LOG_KEY = 'confirmed_log'
const MAX_LOG = 24

interface ConfirmEvent {
  key: string // "SYMBOL:side"
  symbol: string
  market: 'crypto' | 'stock'
  displayName: string
  pair: string
  currency: string
  side: 'long' | 'short'
  tag: string
  strategy: string
  entryLow: number
  entryHigh: number
  stop: number
  t1: number
  t2: number
  runner: number | null
  rr: string
  confirmedAt: number
  confirmedPrice: number
  lastSeenAt: number
  lastPrice: number
  exitedAt: number | null // set when price left the entry zone
  via?: 'spot' | 'wick' // wick = discovered from candle history (spot polls missed it)
  loggedAt?: number // when this row was created (dedupe window for wick hits)
}

function loadLog(): ConfirmEvent[] {
  const raw = scopedGetJson<ConfirmEvent[]>(LOG_KEY, [])
  if (!Array.isArray(raw)) return []
  // drop malformed rows AND anything confirmed before the app existed —
  // those hits predate the app's suggestions and must not be shown
  return raw.filter(
    (e) => e && typeof e.key === 'string' && typeof e.confirmedAt === 'number' && e.confirmedAt >= APP_LAUNCH_MS,
  )
}

function saveLog(events: ConfirmEvent[]) {
  scopedSetJson(LOG_KEY, events)
}

const fmtTime = (t: number) =>
  new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })

/** time-only for today, date+time otherwise — wick hits are often hours/days old */
const fmtWhen = (t: number) => {
  const d = new Date(t)
  const now = new Date()
  const sameDay =
    d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate()
  return sameDay
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

const fmtDur = (ms: number) => {
  const m = Math.max(0, Math.round(ms / 60_000))
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`
}

function tagCls(tag: string): string {
  if (tag === 'PREFERRED') return 'border-warn/40 bg-warn/10 text-warn'
  if (tag === 'COUNTER-TREND') return 'border-info/35 bg-info/10 text-info'
  return 'border-tv-line bg-tv-panel2 text-tv-muted'
}

// ─── compact plan ladder row ─────────────────────────────────────────────────

function LadderRow({
  icon, label, sub, value, cls, accent,
}: {
  icon: string
  label: string
  sub?: string
  value: string
  cls: string
  accent?: boolean
}) {
  const rowCls = accent
    ? 'border-warn/40 bg-warn/5'
    : cls === 'text-bear'
      ? 'border-bear/30 bg-bear/5'
      : 'border-tv-line bg-tv-panel2/50'
  const soft = accent ? 'var(--warn-soft)' : cls === 'text-bear' ? 'var(--bear-soft)' : 'var(--info-soft)'
  return (
    <div role="listitem" className={`flex items-center gap-2.5 rounded-xl border px-2.5 py-1.5 ${rowCls}`}>
      <span
        className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px]"
        style={{ background: soft }}
        aria-hidden="true"
      >
        {icon}
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-[10px] font-bold uppercase tracking-wider text-tv-muted">{label}</div>
        {sub && <div className="mt-0.5 truncate text-[10px] text-tv-muted2">{sub}</div>}
      </div>
      <div className={`shrink-0 text-[13.5px] font-bold tabular-nums ${cls}`}>{value}</div>
    </div>
  )
}

// ─── compact confirmation card ───────────────────────────────────────────────

function ConfirmedCard({
  setup, s, kind, event, sizingTxt, index, taken, onTake,
}: {
  setup: BoardSetup
  s: SideSetup
  kind: 'long' | 'short'
  event: ConfirmEvent | undefined
  sizingTxt: string | null
  index: number
  taken: boolean
  onTake: () => void
}) {
  const isLong = kind === 'long'
  const [copied, setCopied] = useState(false)

  const copyPlan = async () => {
    const runner = s.runner ? ` · Runner ${fmtPrice(s.runner, setup.currency)}` : ''
    const txt =
      (s.state === 'HIT'
        ? `${setup.pair} ${kind.toUpperCase()} trade confirmed — ENTRY HIT by wick ${fmtPrice(
            s.touchedPrice,
            setup.currency,
          )}${s.touchedAt !== null ? ` ${fmtWhen(s.touchedAt)}` : ''}`
        : `${setup.pair} ${kind.toUpperCase()} trade confirmed` + (event ? ` at ${fmtTime(event.confirmedAt)}` : '')) +
      ` — entry ${fmtPrice(s.entryLow, setup.currency)} to ${fmtPrice(s.entryHigh, setup.currency)}` +
      ` · SL ${fmtPrice(s.stop, setup.currency)}` +
      ` · TP1 ${fmtPrice(s.t1, setup.currency)} · TP2 ${fmtPrice(s.t2, setup.currency)}${runner} · RR ${s.rr}`
    try {
      await navigator.clipboard.writeText(txt)
      setCopied(true)
      setTimeout(() => setCopied(false), 1600)
    } catch {
      /* clipboard unavailable */
    }
  }

  return (
    <motion.article
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.22, ease: 'easeOut', delay: Math.min(index, 8) * 0.04 }}
      className={`relative overflow-hidden rounded-2xl border p-3.5 ${isLong ? 'border-bull/25' : 'border-bear/25'}`}
      style={{
        background: `linear-gradient(180deg, var(--tv-panel) 60%, ${isLong ? 'var(--bull-soft)' : 'var(--bear-soft)'})`,
      }}
    >
      <span
        aria-hidden
        className="absolute inset-x-0 top-0 h-px"
        style={{
          background: isLong
            ? 'linear-gradient(90deg, transparent, var(--bull), transparent)'
            : 'linear-gradient(90deg, transparent, var(--bear), transparent)',
        }}
      />
      {/* header — pair + badges + state line · price right */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <h3 className="text-[14px] font-bold tracking-tight text-tv-ink">{setup.pair}</h3>
            <span className={`rounded-full border px-2 py-0.5 text-[9.5px] font-bold uppercase tracking-wide ${isLong ? 'border-bull/40 bg-bull/10 text-bull' : 'border-bear/40 bg-bear/10 text-bear'}`}>
              {kind} confirmed
            </span>
            <span className={`rounded-full border px-2 py-0.5 text-[9.5px] font-bold ${tagCls(s.tag)}`}>{s.tag}</span>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 text-[11px]">
            {s.state === 'HIT' ? (
              <span className="inline-flex items-center gap-1.5 rounded-full border border-warn/40 bg-warn/10 px-2 py-0.5 font-bold text-warn">
                🎯 ENTRY HIT
              </span>
            ) : (
              <span className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 font-bold ${isLong ? 'border-bull/40 bg-bull/10 text-bull' : 'border-bear/40 bg-bear/10 text-bear'}`}>
                <span className={`inline-block h-1.5 w-1.5 animate-pulse rounded-full ${isLong ? 'bg-bull' : 'bg-bear'}`} aria-hidden="true" />
                IN ZONE
              </span>
            )}
            <span className="text-tv-muted">
              {s.state === 'HIT' ? (
                <>
                  wick {fmtPrice(s.touchedPrice, setup.currency)} hit {s.touchedAt !== null ? fmtWhen(s.touchedAt) : '—'} · now{' '}
                  {s.distPct?.toFixed(1) ?? '?'}% away
                </>
              ) : event ? (
                <>
                  confirmed {fmtTime(event.confirmedAt)} · in zone {fmtDur(Date.now() - event.confirmedAt)}
                </>
              ) : (
                'price inside entry zone'
              )}
            </span>
          </div>
        </div>
        <div className="shrink-0 text-right">
          <div className="text-[16px] font-bold tabular-nums tracking-tight text-tv-ink">
            {fmtPrice(setup.price, setup.currency)}
          </div>
          <span className={`text-[10.5px] font-bold tabular-nums ${setup.change24h >= 0 ? 'text-bull' : 'text-bear'}`}>
            {setup.change24h >= 0 ? '+' : ''}
            {setup.change24h.toFixed(2)}% 24h
          </span>
        </div>
      </div>

      {/* compact ladder */}
      <div role="list" aria-label={`${setup.pair} ${kind} plan`} className="mt-2.5 space-y-1">
        <LadderRow
          icon="◆"
          label="Entry zone"
          sub={s.strategy}
          value={`${fmtPrice(s.entryLow, setup.currency)} – ${fmtPrice(s.entryHigh, setup.currency)}`}
          cls="text-warn"
          accent
        />
        <LadderRow icon="✕" label="Stop loss" sub={s.stopNote} value={fmtPrice(s.stop, setup.currency)} cls="text-bear" />
        <LadderRow icon="◎" label="Target 1" value={fmtPrice(s.t1, setup.currency)} cls="text-info" />
        <LadderRow icon="◎" label="Target 2" value={fmtPrice(s.t2, setup.currency)} cls="text-info" />
        {s.runner !== null && (
          <LadderRow icon="→" label="Runner" value={fmtPrice(s.runner, setup.currency)} cls="text-info" />
        )}
      </div>

      {/* footer — R:R + sizing · actions */}
      <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2 border-t border-tv-div pt-2">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5 text-[10.5px]">
          <span className="rounded-full border border-tv-line bg-tv-panel2 px-2 py-0.5 font-bold tabular-nums text-tv-ink">
            R:R {s.rr}
          </span>
          {sizingTxt && <span className="truncate tabular-nums text-tv-muted">{sizingTxt}</span>}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <button
            onClick={onTake}
            disabled={taken}
            suppressHydrationWarning
            aria-label={`Mark this ${setup.pair} ${kind} setup as taken`}
            className={`rounded-lg border px-2.5 py-1.5 text-[11.5px] font-bold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bull/50 ${
              taken
                ? 'cursor-default border-tv-line bg-tv-panel2 text-tv-muted'
                : 'border-bull/50 bg-bull/15 text-bull hover:bg-bull/25'
            }`}
          >
            {taken ? '✓ In your trades' : '▶ I took this trade'}
          </button>
          <button
            onClick={copyPlan}
            suppressHydrationWarning
            aria-label={`Copy ${setup.pair} ${kind} trade plan`}
            className="shrink-0 rounded-lg border border-tv-line bg-tv-panel2 px-2.5 py-1.5 text-[11.5px] font-semibold text-tv-ink transition hover:border-tv-line-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bull/50"
          >
            {copied ? '✓' : '⧉'}
          </button>
        </div>
      </div>
    </motion.article>
  )
}

// ─── my open trade — compact frozen plan + live TP/SL tracking ──────────────

function OpenTradeCard({
  t, livePrice, onRemove,
}: {
  t: MyTrade
  livePrice: number | null
  onRemove: () => void
}) {
  const isLong = t.side === 'long'
  const r = livePrice !== null ? rNow(t, livePrice) : null
  const afterTp1 = t.tp1HitAt !== null
  return (
    <motion.article
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.22, ease: 'easeOut' }}
      className="rounded-2xl border p-3.5"
      style={{
        background: 'linear-gradient(180deg, var(--tv-panel) 60%, var(--warn-soft))',
        borderColor: 'var(--warn-line)',
      }}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <h3 className="text-[14px] font-bold tracking-tight text-tv-ink">{t.pair}</h3>
            <span className={`rounded-full border px-2 py-0.5 text-[9.5px] font-bold uppercase ${isLong ? 'border-bull/40 bg-bull/10 text-bull' : 'border-bear/40 bg-bear/10 text-bear'}`}>
              {t.side}
            </span>
            <span className="rounded-full border border-warn/40 bg-warn/10 px-2 py-0.5 text-[9.5px] font-bold text-warn">
              OPEN
            </span>
            <span className="text-[10.5px] text-tv-muted">taken {fmtWhen(t.takenAt)} · plan frozen</span>
          </div>
        </div>
        <div className="shrink-0 text-right">
          {livePrice !== null && (
            <div className="text-[16px] font-bold tabular-nums tracking-tight text-tv-ink">
              {fmtPrice(livePrice, t.currency)}
            </div>
          )}
          {r !== null && (
            <span className={`text-[10.5px] font-bold tabular-nums ${r >= 0 ? 'text-bull' : 'text-bear'}`}>
              {r > 0 ? '+' : ''}
              {r.toFixed(2)}R now
            </span>
          )}
        </div>
      </div>

      <div role="list" aria-label={`${t.pair} ${t.side} frozen plan`} className="mt-2.5 space-y-1">
        <LadderRow
          icon="◎"
          label="TP2 — full close"
          sub={t.tp2HitAt !== null ? `hit ${fmtWhen(t.tp2HitAt)} — trade closed` : 'pending — closes the trade'}
          value={fmtPrice(t.t2, t.currency)}
          cls={t.tp2HitAt !== null ? 'text-bull' : 'text-info'}
        />
        <LadderRow
          icon="◎"
          label="TP1 — bank half"
          sub={
            t.tp1HitAt !== null
              ? `hit ${fmtWhen(t.tp1HitAt)} — half taken, stop moved to entry`
              : 'pending — take half off, move stop to entry'
          }
          value={fmtPrice(t.t1, t.currency)}
          cls={t.tp1HitAt !== null ? 'text-bull' : 'text-info'}
        />
        <LadderRow
          icon="◆"
          label="Entry — assumed fill"
          sub={`${fmtPrice(t.entryLow, t.currency)} – ${fmtPrice(t.entryHigh, t.currency)} zone mid`}
          value={fmtPrice(t.entryFill, t.currency)}
          cls="text-warn"
          accent
        />
        <LadderRow
          icon="✕"
          label={afterTp1 ? 'Stop — moved to entry' : 'Stop loss'}
          sub={
            t.slHitAt !== null
              ? `hit ${fmtWhen(t.slHitAt)}`
              : afterTp1
                ? `now at entry ${fmtPrice(t.entryFill, t.currency)} after TP1 (breakeven)`
                : 'original stop'
          }
          value={fmtPrice(afterTp1 ? t.entryFill : t.stop, t.currency)}
          cls="text-bear"
        />
      </div>

      <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2 border-t border-tv-div pt-2">
        <div className="min-w-0 text-[10.5px] text-tv-muted">
          {t.via === 'wick' ? 'wick-confirmed entry' : 'spot-confirmed entry'} · tracked against real candles every 45s
        </div>
        <button
          onClick={onRemove}
          suppressHydrationWarning
          aria-label={`Remove ${t.pair} ${t.side} from tracking`}
          className="shrink-0 rounded-lg border border-tv-line bg-tv-panel2 px-2.5 py-1.5 text-[11.5px] font-semibold text-tv-muted transition hover:border-tv-line-strong hover:text-tv-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bull/50"
        >
          ✋ I closed this trade
        </button>
      </div>
    </motion.article>
  )
}

// ─── the section — mounted inside SetupBoard, shares its data ────────────────

export function ConfirmedSection({ data, loading }: { data: SetupsPayload | null; loading: boolean }) {
  const [log, setLog] = useState<ConfirmEvent[]>([])
  const [acct, setAcct] = useState('')
  const [riskPct, setRiskPct] = useState('1')
  const mounted = useRef(true)
  const logRef = useRef<ConfirmEvent[]>([])
  const myTradesRef = useRef<MyTrade[]>([])
  const { toast } = useToast()
  const [myTrades, setMyTrades] = useState<MyTrade[]>([])
  const openTrades = myTrades.filter((t) => t.status === 'OPEN')
  const closedMyTrades = myTrades
    .filter((t) => t.status === 'CLOSED')
    .sort((a, b) => (b.closedAt ?? 0) - (a.closedAt ?? 0))
  const openTradeKeys = new Set(openTrades.map((t) => t.key))
  const trackedSymbolsKey = Array.from(new Set(openTrades.map((t) => `${t.symbol}|${t.market}`))).join(',')

  useEffect(() => {
    mounted.current = true
    // sizing inputs — same scoped keys the sizing panel above writes to
    setAcct(scopedGet('acct') ?? '')
    setRiskPct(scopedGet('risk') ?? '1')
    const l = loadLog()
    logRef.current = l
    setLog(l)
    // instant paint from the local cache, then the server truth (journal is
    // account-synced — the same open trades show on every device)
    const mt = loadMyTrades()
    myTradesRef.current = mt
    setMyTrades(mt)
    void fetchMyTrades().then((server) => {
      if (!mounted.current) return
      myTradesRef.current = server
      setMyTrades(server)
    })
    return () => {
      mounted.current = false
    }
  }, [])

  // ── my trades — take / remove ────────────────────────────────────────────
  const takeTrade = (setup: BoardSetup, s: SideSetup, kind: 'long' | 'short', event: ConfirmEvent | undefined) => {
    const key = `${setup.symbol}:${kind}`
    if (myTradesRef.current.some((t) => t.key === key && t.status === 'OPEN')) return
    const now = Date.now()
    const t: MyTrade = {
      id: `${key}:${now}`,
      key,
      symbol: setup.symbol,
      market: setup.market,
      displayName: setup.displayName,
      pair: setup.pair,
      currency: setup.currency,
      side: kind,
      tag: s.tag,
      strategy: s.strategy,
      entryLow: s.entryLow,
      entryHigh: s.entryHigh,
      entryFill: zoneMid(s.entryLow, s.entryHigh),
      stop: s.stop,
      t1: s.t1,
      t2: s.t2,
      runner: s.runner,
      rr: s.rr,
      confirmedAt: event ? event.confirmedAt : (s.touchedAt ?? now),
      confirmedPrice: event ? event.confirmedPrice : (s.touchedPrice ?? setup.price),
      via: event?.via ?? (s.state === 'HIT' ? 'wick' : 'spot'),
      takenAt: now,
      status: 'OPEN',
      tp1HitAt: null,
      tp2HitAt: null,
      slHitAt: null,
      outcome: null,
      closedAt: null,
      closePrice: null,
    }
    const next = [t, ...myTradesRef.current]
    myTradesRef.current = next
    setMyTrades(next)
    saveMyTrades(next)
    window.dispatchEvent(new Event('t2w:trades-changed'))
    toast({
      title: `🎯 Trade taken — ${t.pair} ${kind.toUpperCase()}`,
      description: `Plan frozen · fill assumed ${fmtPrice(t.entryFill, t.currency)} · TP1 ${fmtPrice(t.t1, t.currency)} · TP2 ${fmtPrice(
        t.t2,
        t.currency,
      )} · SL ${fmtPrice(t.stop, t.currency)}`,
    })
  }

  const removeTrade = (id: string) => {
    const now = Date.now()
    const tr = myTradesRef.current.find((x) => x.id === id)
    if (!tr || tr.status !== 'OPEN') return
    const live = data?.setups.find((x) => x.symbol === tr.symbol)?.price ?? null
    const closed: MyTrade = { ...tr, status: 'CLOSED', outcome: 'MANUAL', closedAt: now, closePrice: live ?? tr.entryFill }
    const next = myTradesRef.current.map((x) => (x.id === id ? closed : x))
    myTradesRef.current = next
    setMyTrades(next)
    saveMyTrades(next)
    window.dispatchEvent(new Event('t2w:trades-changed'))
    toast({
      title: `✋ ${tr.pair} ${tr.side.toUpperCase()} closed manually`,
      description: `Logged to your history · ${netRTxt(closed)}`,
    })
  }

  // live TP/SL tracking — pull real candles for every open trade and advance
  // the frozen plan (TP1 → breakeven stop; TP2/SL → close). Fires toasts.
  useEffect(() => {
    if (!trackedSymbolsKey) return
    let cancelled = false
    const run = async () => {
      const pairs = trackedSymbolsKey.split(',').map((s) => s.split('|') as [string, 'crypto' | 'stock'])
      const results = await Promise.all(
        pairs.map(async ([sym, mkt]) => {
          try {
            const res = await fetch(`/api/candles?symbol=${sym}&market=${mkt}`, { cache: 'no-store' })
            if (!res.ok) return null
            const d = (await res.json()) as { symbol: string; candles: Candle[] }
            return [d.symbol, d.candles] as const
          } catch {
            return null
          }
        }),
      )
      if (cancelled) return
      const candleMap = new Map<string, Candle[]>()
      for (const r of results) if (r) candleMap.set(r[0], r[1])
      let changed = false
      const events: Array<{ t: MyTrade; kind: 'tp1' | 'closed' }> = []
      const next = myTradesRef.current.map((t) => {
        if (t.status !== 'OPEN') return t
        const candles = candleMap.get(t.symbol)
        if (!candles || candles.length === 0) return t
        const after = trackTrade(t, candles)
        if (after !== t) {
          changed = true
          if (after.status === 'CLOSED') events.push({ t: after, kind: 'closed' })
          else if (t.tp1HitAt === null && after.tp1HitAt !== null) events.push({ t: after, kind: 'tp1' })
        }
        return after
      })
      if (!changed) return
      myTradesRef.current = next
      setMyTrades(next)
      saveMyTrades(next)
      for (const e of events) {
        if (e.kind === 'tp1') {
          toast({
            title: `✅ ${e.t.pair} ${e.t.side.toUpperCase()} — TP1 hit`,
            description: `Take half profit and move your stop to entry ${fmtPrice(e.t.entryFill, e.t.currency)} (per the plan) — tracking updated.`,
          })
        } else {
          const title =
            e.t.outcome === 'TP2'
              ? `🏆 ${e.t.pair} ${e.t.side.toUpperCase()} — TP2 hit, trade closed`
              : e.t.outcome === 'TP1_BE'
                ? `⚖️ ${e.t.pair} ${e.t.side.toUpperCase()} — stopped at entry after TP1`
                : `🛑 ${e.t.pair} ${e.t.side.toUpperCase()} — stopped out`
          toast({
            title,
            description: `Closed ${fmtWhen(e.t.closedAt ?? Date.now())} · ${netRTxt(e.t)}${
              e.t.outcome === 'TP2' ? ' — check the setups above for the next fresh zone' : ''
            }`,
          })
        }
      }
    }
    run()
    const iv = setInterval(run, POLL_MS)
    return () => {
      cancelled = true
      clearInterval(iv)
    }
  }, [trackedSymbolsKey, toast])

  // confirmation tracker — append new LIVE entries to the log, mark exits.
  // Also reconciles WICK HITS the spot polls missed: the server checks real
  // candle highs/lows against each entry zone, so a touch that happened
  // between polls (or while the tab was closed) still gets logged here.
  useEffect(() => {
    if (!data) return
    const now = Date.now()
    const next = logRef.current.map((e) => ({ ...e }))
    const fired: ConfirmEvent[] = []
    const liveKeys = new Set<string>()
    for (const setup of data.setups) {
      for (const kind of ['long', 'short'] as const) {
        const s = setup[kind]
        if (!s) continue
        const key = `${setup.symbol}:${kind}`
        const isLive = s.state === 'LIVE'
        if (isLive) {
          liveKeys.add(key)
          const existing = next.find((e) => e.key === key && !e.exitedAt)
          if (existing) {
            existing.lastSeenAt = now
            existing.lastPrice = setup.price
          } else {
            const ev: ConfirmEvent = {
              key,
              symbol: setup.symbol,
              market: setup.market,
              displayName: setup.displayName,
              pair: setup.pair,
              currency: setup.currency,
              side: kind,
              tag: s.tag,
              strategy: s.strategy,
              entryLow: s.entryLow,
              entryHigh: s.entryHigh,
              stop: s.stop,
              t1: s.t1,
              t2: s.t2,
              runner: s.runner,
              rr: s.rr,
              confirmedAt: now,
              confirmedPrice: setup.price,
              lastSeenAt: now,
              lastPrice: setup.price,
              exitedAt: null,
              via: 'spot',
              loggedAt: now,
            }
            next.unshift(ev)
            fired.push(ev)
          }
        } else if (s.touchedAt !== null && s.touchedPrice !== null) {
          // price is NOT in the zone now, but a recent candle wick was —
          // record it as history (already exited). Dedupe: same candle touch
          // yields the same touchedAt; also suppress re-logs within 6h of the
          // last recorded wick for this key so drifting zones can't spam rows.
          const dupe = next.some(
            (e) =>
              e.key === key &&
              (e.confirmedAt === s.touchedAt ||
                (e.via === 'wick' && typeof e.loggedAt === 'number' && now - e.loggedAt < 6 * 3_600_000)),
          )
          if (!dupe) {
            const ev: ConfirmEvent = {
              key,
              symbol: setup.symbol,
              market: setup.market,
              displayName: setup.displayName,
              pair: setup.pair,
              currency: setup.currency,
              side: kind,
              tag: s.tag,
              strategy: s.strategy,
              entryLow: s.entryLow,
              entryHigh: s.entryHigh,
              stop: s.stop,
              t1: s.t1,
              t2: s.t2,
              runner: s.runner,
              rr: s.rr,
              confirmedAt: s.touchedAt,
              confirmedPrice: s.touchedPrice,
              lastSeenAt: s.touchedAt,
              lastPrice: s.touchedPrice,
              exitedAt: now,
              via: 'wick',
              loggedAt: now,
            }
            next.unshift(ev)
            fired.push(ev) // toast below — the user deserves to know the zone was hit
          }
        }
      }
    }
    let changed = fired.length > 0
    for (const e of next) {
      if (!e.exitedAt && !liveKeys.has(e.key)) {
        e.exitedAt = now
        changed = true
      }
    }
    if (!changed) return
    const trimmed = next.slice(0, MAX_LOG)
    logRef.current = trimmed
    setLog(trimmed)
    saveLog(trimmed)
    for (const f of fired) {
      if (f.via === 'wick') {
        toast({
          title: `🎯 ${f.symbol} ${f.side.toUpperCase()} zone was hit`,
          description: `A candle wick reached ${fmtPrice(f.confirmedPrice, f.currency)} inside the entry zone ${fmtPrice(
            f.entryLow,
            f.currency,
          )} – ${fmtPrice(f.entryHigh, f.currency)} (${fmtWhen(f.confirmedAt)}) — spot polls missed it`,
        })
      } else {
        toast({
          title: `✅ ${f.symbol} ${f.side.toUpperCase()} CONFIRMED`,
          description: `Price ${fmtPrice(f.confirmedPrice, f.currency)} is inside the entry zone ${fmtPrice(
            f.entryLow,
            f.currency,
          )} – ${fmtPrice(f.entryHigh, f.currency)} · SL ${fmtPrice(f.stop, f.currency)}`,
        })
      }
    }
  }, [data, toast])

  // ── derive confirmed trades ──
  // LIVE = price inside the zone right now · HIT = entry triggered by a wick,
  // price has since moved on. Both are confirmed trades and render as cards.
  type CardItem = {
    key: string
    setup: BoardSetup
    s: SideSetup
    kind: 'long' | 'short'
    event: ConfirmEvent | undefined
    sizingTxt: string | null
  }
  const aNum = parseFloat(acct)
  const rNum = parseFloat(riskPct)
  const sizingFor = (setup: BoardSetup, s: SideSetup): string | null => {
    if (!(aNum > 0) || !(rNum > 0)) return null
    const m = (s.entryLow + s.entryHigh) / 2
    const dist = Math.abs(m - s.stop)
    if (!(dist > 0)) return null
    const units = (aNum * rNum) / 100 / dist
    const unitName = setup.market === 'crypto' ? setup.symbol : 'shares'
    return `size ≈ ${
      units >= 100 ? Math.round(units).toLocaleString('en-US') : Math.round(units * 10000) / 10000
    } ${unitName} · risk $${Math.round((aNum * rNum) / 100).toLocaleString('en-US')}`
  }
  const live: CardItem[] = []
  const hits: CardItem[] = []
  for (const setup of data?.setups ?? []) {
    for (const kind of ['long', 'short'] as const) {
      const s = setup[kind]
      if (!s) continue
      if (s.state === 'LIVE') {
        const event = log.find((e) => e.key === `${setup.symbol}:${kind}` && !e.exitedAt)
        live.push({ key: `${setup.symbol}:${kind}`, setup, s, kind, event, sizingTxt: sizingFor(setup, s) })
      } else if (s.state === 'HIT') {
        hits.push({ key: `${setup.symbol}:${kind}`, setup, s, kind, event: undefined, sizingTxt: sizingFor(setup, s) })
      }
    }
  }
  const confirmedCount = live.length + hits.length
  // hide history rows that duplicate a currently displayed HIT card
  const hitTouchIds = new Set(hits.map((h) => `${h.key}:${h.s.touchedAt}`))
  const history = log.filter((e) => e.exitedAt && !hitTouchIds.has(`${e.key}:${e.confirmedAt}`))
  const now = Date.now()
  const symbols = data?.setups.map((s) => s.symbol) ?? []

  return (
    <section
      aria-label="Trade confirmed"
      className="flex flex-col gap-3 rounded-2xl border border-tv-line bg-tv-panel2/30 p-3.5 sm:p-4"
    >
      {/* section header */}
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.14em] text-tv-muted">
          <span className="text-[13px]" aria-hidden="true">✅</span> Trade confirmed
        </h2>
        <span
          role="status"
          aria-live="polite"
          className={`rounded-full border px-2.5 py-0.5 text-[10.5px] font-bold tabular-nums ${
            confirmedCount ? 'border-bull/40 bg-bull/10 text-bull' : 'border-tv-line bg-tv-panel2 text-tv-muted'
          }`}
        >
          {confirmedCount
            ? `${confirmedCount} confirmed${live.length && hits.length ? ` · ${live.length} in zone · ${hits.length} hit` : ''}`
            : '0 confirmed'}
        </span>
        <span className="ml-auto text-[10.5px] tabular-nums text-tv-muted2">
          {loading ? 'refreshing…' : 'auto every 45s'}
        </span>
      </div>

      {/* my open trades — frozen plans with live TP/SL tracking */}
      {openTrades.length > 0 && (
        <div className="flex flex-col gap-2">
          <div className="text-[10.5px] font-bold uppercase tracking-[0.14em] text-tv-muted">
            My open trades <span className="text-warn">— frozen plans · tracked against real candles</span>
          </div>
          <div className="grid gap-3 lg:grid-cols-2">
            {openTrades.map((t) => (
              <OpenTradeCard
                key={t.id}
                t={t}
                livePrice={data?.setups.find((x) => x.symbol === t.symbol)?.price ?? null}
                onRemove={() => removeTrade(t.id)}
              />
            ))}
          </div>
        </div>
      )}

      {/* confirmed trades — in zone + entry hits */}
      {loading && !data ? (
        <div className="h-40 animate-pulse rounded-2xl border border-tv-line bg-tv-panel" />
      ) : confirmedCount === 0 ? (
        <div className="rounded-xl border border-dashed border-tv-line-strong bg-tv-panel2/50 px-4 py-5 text-center">
          <div className="text-[13px] font-semibold text-tv-ink">No confirmed entries right now</div>
          <div className="mx-auto mt-1 max-w-md text-[11.5px] leading-relaxed text-tv-muted">
            The tracker is watching {symbols.length ? symbols.join(', ') : 'your watchlist'}. The moment price touches an
            entry zone — or a candle wick hits one — the trade is confirmed and appears here automatically.
          </div>
        </div>
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          {[...live, ...hits].map((c, i) => (
            <ConfirmedCard
              key={c.key}
              setup={c.setup}
              s={c.s}
              kind={c.kind}
              event={c.event}
              sizingTxt={c.sizingTxt}
              index={i}
              taken={openTradeKeys.has(c.key)}
              onTake={() => takeTrade(c.setup, c.s, c.kind, c.event)}
            />
          ))}
        </div>
      )}

      {/* history */}
      {history.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between gap-2">
            <div className="text-[10.5px] font-bold uppercase tracking-[0.14em] text-tv-muted">
              Earlier <span className="text-tv-muted2">— confirmed, then price moved on</span>
            </div>
            <button
              onClick={() => {
                logRef.current = []
                setLog([])
                saveLog([])
              }}
              suppressHydrationWarning
              aria-label="Clear confirmation history"
              className="rounded-lg border border-tv-line bg-tv-panel2 px-2.5 py-1 text-[11px] font-semibold text-tv-muted transition hover:text-tv-ink hover:border-tv-line-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bull/50"
            >
              Clear history
            </button>
          </div>
          <div className="flex flex-col gap-1.5">
            {history.slice(0, 8).map((e) => (
              <div
                key={`${e.key}:${e.confirmedAt}`}
                className="flex flex-wrap items-center gap-2 rounded-xl border border-tv-line bg-tv-panel px-2.5 py-1.5 text-[11.5px]"
              >
                <span className="font-bold text-tv-ink">{e.pair}</span>
                <span
                  className={`rounded-full border px-1.5 py-0.5 text-[9.5px] font-bold uppercase ${
                    e.side === 'long' ? 'border-bull/35 bg-bull/10 text-bull' : 'border-bear/35 bg-bear/10 text-bear'
                  }`}
                >
                  {e.side}
                </span>
                {e.via === 'wick' ? (
                  <span className="tabular-nums text-tv-muted">
                    🎯 wick {fmtPrice(e.confirmedPrice, e.currency)} hit {fmtWhen(e.confirmedAt)} · zone {fmtPrice(
                      e.entryLow,
                      e.currency,
                    )} – {fmtPrice(e.entryHigh, e.currency)} · last {fmtPrice(e.lastPrice, e.currency)}
                  </span>
                ) : (
                  <span className="tabular-nums text-tv-muted">
                    confirmed {fmtTime(e.confirmedAt)} · in zone {fmtDur((e.exitedAt ?? e.lastSeenAt) - e.confirmedAt)} ·
                    exited {fmtTime(e.exitedAt ?? now)} · last {fmtPrice(e.lastPrice, e.currency)}
                  </span>
                )}
                <span className="ml-auto rounded-full border border-tv-line bg-tv-panel2 px-1.5 py-0.5 text-[9.5px] font-bold text-tv-muted">
                  {e.tag}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* my trade history — taken setups with tracked outcomes */}
      {closedMyTrades.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between gap-2">
            <div className="text-[10.5px] font-bold uppercase tracking-[0.14em] text-tv-muted">
              My trade history <span className="text-tv-muted2">— taken from confirmed setups · outcomes tracked</span>
            </div>
            <button
              onClick={() => {
                const next = myTradesRef.current.filter((t) => t.status === 'OPEN')
                myTradesRef.current = next
                setMyTrades(next)
                saveMyTrades(next)
              }}
              suppressHydrationWarning
              aria-label="Clear my closed trades"
              className="rounded-lg border border-tv-line bg-tv-panel2 px-2.5 py-1 text-[11px] font-semibold text-tv-muted transition hover:text-tv-ink hover:border-tv-line-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bull/50"
            >
              Clear closed
            </button>
          </div>
          <div className="flex flex-col gap-1.5">
            {closedMyTrades.slice(0, 10).map((t) => (
              <div
                key={t.id}
                className="flex flex-wrap items-center gap-2 rounded-xl border border-tv-line bg-tv-panel px-2.5 py-1.5 text-[11.5px]"
              >
                <span className="font-bold text-tv-ink">{t.pair}</span>
                <span
                  className={`rounded-full border px-1.5 py-0.5 text-[9.5px] font-bold uppercase ${
                    t.side === 'long' ? 'border-bull/35 bg-bull/10 text-bull' : 'border-bear/35 bg-bear/10 text-bear'
                  }`}
                >
                  {t.side}
                </span>
                <span className="rounded-full border border-tv-line bg-tv-panel2 px-1.5 py-0.5 text-[9.5px] font-bold">
                  {outcomeTxt(t)}
                </span>
                <span
                  className={`rounded-full px-1.5 py-0.5 text-[9.5px] font-bold tabular-nums ${
                    netR(t) >= 0 ? 'bg-bull/10 text-bull' : 'bg-bear/10 text-bear'
                  }`}
                >
                  {netRTxt(t)}
                </span>
                <span className="tabular-nums text-tv-muted">
                  taken {fmtWhen(t.takenAt)} · closed {t.closedAt !== null ? fmtWhen(t.closedAt) : '—'}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* sizing hint */}
      {confirmedCount > 0 && !(aNum > 0 && rNum > 0) && (
        <div className="text-[11px] text-tv-muted">
          Tip: set your account size and risk % in the sizing panel below to see suggested position sizes here.
        </div>
      )}
    </section>
  )
}
