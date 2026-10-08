'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import { useToast } from '@/hooks/use-toast'
import { fmtPrice } from '@/components/signals/types'
import { DEFAULT_WATCHLIST, loadWatchlist, saveWatchlist } from '@/lib/watchlist'
import type { BoardSetup, SetupsPayload, SideSetup } from '@/lib/setups/generate'

// ─── Trade Confirmed board ───────────────────────────────────────────────────
// A dedicated page that only shows trades whose entry is confirmed — i.e. the
// live price is inside the entry zone (side state === 'LIVE' from the setups
// engine). Shares the watchlist with the Trade Setups tab via localStorage
// ('tw_watchlist') and keeps an append-only confirmation log ('tw_confirmed_log')
// so entries confirmed earlier stay visible after price moves on.

const POLL_MS = 45_000
const LOG_KEY = 'tw_confirmed_log'
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

function lsGet(k: string, d: string): string {
  try {
    return localStorage.getItem(k) ?? d
  } catch {
    return d
  }
}

function loadLog(): ConfirmEvent[] {
  try {
    const raw = JSON.parse(localStorage.getItem(LOG_KEY) ?? '[]') as ConfirmEvent[]
    return Array.isArray(raw) ? raw.filter((e) => e && typeof e.key === 'string') : []
  } catch {
    return []
  }
}

function saveLog(events: ConfirmEvent[]) {
  try {
    localStorage.setItem(LOG_KEY, JSON.stringify(events))
  } catch {
    /* private mode */
  }
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

// ─── plan ladder row ─────────────────────────────────────────────────────────

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
    <div role="listitem" className={`flex items-center gap-3 rounded-xl border px-3 py-2 ${rowCls}`}>
      <span
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[13px]"
        style={{ background: soft }}
        aria-hidden="true"
      >
        {icon}
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-[10.5px] font-bold uppercase tracking-wider text-tv-muted">{label}</div>
        {sub && <div className="mt-0.5 truncate text-[10px] text-tv-muted2">{sub}</div>}
      </div>
      <div className={`shrink-0 text-[14.5px] font-bold tabular-nums ${cls}`}>{value}</div>
    </div>
  )
}

// ─── live confirmation card ──────────────────────────────────────────────────

function ConfirmedCard({
  setup, s, kind, event, sizingTxt, index,
}: {
  setup: BoardSetup
  s: SideSetup
  kind: 'long' | 'short'
  event: ConfirmEvent | undefined
  sizingTxt: string | null
  index: number
}) {
  const isLong = kind === 'long'
  const accent = isLong ? 'text-bull' : 'text-bear'
  const [copied, setCopied] = useState(false)

  const copyPlan = async () => {
    const runner = s.runner ? ` · Runner ${fmtPrice(s.runner, setup.currency)}` : ''
    const txt =
      `${setup.pair} ${kind.toUpperCase()} trade confirmed` +
      (event ? ` at ${fmtTime(event.confirmedAt)}` : '') +
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
      transition={{ duration: 0.25, ease: 'easeOut', delay: Math.min(index, 8) * 0.05 }}
      className={`relative overflow-hidden rounded-3xl border p-4 sm:p-5 ${isLong ? 'border-bull/25' : 'border-bear/25'}`}
      style={{
        background: `linear-gradient(180deg, var(--tv-panel) 55%, ${isLong ? 'var(--bull-soft)' : 'var(--bear-soft)'})`,
        boxShadow: isLong ? 'var(--card-glow)' : 'var(--card-glow-bear)',
      }}
    >
      {/* featured top hairline — teal → teal-mid gradient (rose for shorts) */}
      <span
        aria-hidden
        className="absolute inset-x-0 top-0 h-px"
        style={{
          background: isLong
            ? 'linear-gradient(90deg, transparent, var(--bull), var(--info), var(--bull), transparent)'
            : 'linear-gradient(90deg, transparent, var(--bear), var(--bear-soft), var(--bear), transparent)',
        }}
      />
      {/* header */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="relative flex h-9 w-9 shrink-0 items-center justify-center" aria-hidden="true">
            <span className={`absolute inline-flex h-full w-full animate-ping rounded-full ${isLong ? 'bg-bull/30' : 'bg-bear/30'}`} />
            <span
              className={`relative inline-flex h-9 w-9 items-center justify-center rounded-full text-[15px] font-bold ${isLong ? 'bg-bull/20 text-bull' : 'bg-bear/20 text-bear'}`}
            >
              ✓
            </span>
          </span>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-[15.5px] font-bold tracking-tight text-tv-ink">{setup.pair}</h3>
              <span className={`rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${isLong ? 'border-bull/40 bg-bull/10 text-bull' : 'border-bear/40 bg-bear/10 text-bear'}`}>
                {kind} confirmed
              </span>
              <span className={`rounded-full border px-2 py-0.5 text-[10px] font-bold ${tagCls(s.tag)}`}>{s.tag}</span>
            </div>
            <div className="mt-0.5 text-[11.5px] text-tv-muted">
              {setup.displayName} · {setup.regime.toLowerCase().replace('_', ' ')} · {setup.timeframe}
            </div>
          </div>
        </div>
        <div className="text-right">
          <div className="text-[19px] font-bold tabular-nums tracking-tight text-tv-ink">
            {fmtPrice(setup.price, setup.currency)}
          </div>
          <span
            className={`mt-0.5 inline-block rounded-full px-2 py-0.5 text-[10.5px] font-bold tabular-nums ${
              setup.change24h >= 0 ? 'bg-bull/10 text-bull' : 'bg-bear/10 text-bear'
            }`}
          >
            {setup.change24h >= 0 ? '+' : ''}
            {setup.change24h.toFixed(2)}% 24h
          </span>
        </div>
      </div>

      {/* live line */}
      <div className="mt-3 flex flex-wrap items-center gap-2 text-[11.5px]">
        <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 font-bold ${isLong ? 'border-bull/40 bg-bull/10 text-bull' : 'border-bear/40 bg-bear/10 text-bear'}`}>
          <span className={`inline-block h-1.5 w-1.5 animate-pulse rounded-full ${isLong ? 'bg-bull' : 'bg-bear'}`} aria-hidden="true" />
          IN ZONE
        </span>
        <span className="text-tv-muted">
          {event ? (
            <>
              confirmed {fmtTime(event.confirmedAt)} · in zone {fmtDur(Date.now() - event.confirmedAt)}
            </>
          ) : (
            'price inside entry zone'
          )}
        </span>
      </div>

      {/* ladder */}
      <div role="list" aria-label={`${setup.pair} ${kind} plan`} className="mt-3 space-y-1.5">
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

      {/* footer */}
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-tv-div pt-3">
        <div className="min-w-0 text-[11px] text-tv-muted">
          <span className="rounded-full border border-tv-line bg-tv-panel2 px-2 py-0.5 font-bold tabular-nums text-tv-ink">
            R:R {s.rr}
          </span>
          {sizingTxt && <span className="ml-2 tabular-nums">{sizingTxt}</span>}
        </div>
        <button
          onClick={copyPlan}
          suppressHydrationWarning
          aria-label={`Copy ${setup.pair} ${kind} trade plan`}
          className="shrink-0 rounded-xl border border-tv-line bg-tv-panel2 px-3 py-2 text-[12px] font-semibold text-tv-ink transition hover:border-tv-line-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bull/50"
        >
          {copied ? '✓ Copied' : '⧉ Copy plan'}
        </button>
      </div>
    </motion.article>
  )
}

// ─── board ───────────────────────────────────────────────────────────────────

export function ConfirmedBoard() {
  const [symbols, setSymbols] = useState<string[]>(DEFAULT_WATCHLIST)
  const [data, setData] = useState<SetupsPayload | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [log, setLog] = useState<ConfirmEvent[]>([])
  const [acct, setAcct] = useState('')
  const [riskPct, setRiskPct] = useState('1')
  const mounted = useRef(true)
  const logRef = useRef<ConfirmEvent[]>([])
  const wlLoaded = useRef(false)
  const { toast } = useToast()

  useEffect(() => {
    mounted.current = true
    setAcct(lsGet('tw_acct', ''))
    setRiskPct(lsGet('tw_risk', '1'))
    const wl = loadWatchlist()
    setSymbols(wl)
    saveWatchlist(wl)
    wlLoaded.current = true
    const l = loadLog()
    logRef.current = l
    setLog(l)
    return () => {
      mounted.current = false
    }
  }, [])

  // share watchlist edits with the Trade Setups tab (persist list)
  useEffect(() => {
    if (!wlLoaded.current) return
    saveWatchlist(symbols)
  }, [symbols])

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/setups?symbols=${symbols.join(',')}`, { cache: 'no-store' })
      if (!res.ok) throw new Error(`API ${res.status}`)
      const d = (await res.json()) as SetupsPayload
      if (!mounted.current) return
      setData(d)
      setError(null)
    } catch (e) {
      if (mounted.current) setError(String(e).slice(0, 120))
    } finally {
      if (mounted.current) setLoading(false)
    }
  }, [symbols])

  useEffect(() => {
    setLoading(true)
    load()
    const t = setInterval(load, POLL_MS)
    return () => clearInterval(t)
  }, [load])

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

  // ── derive live confirmations ──
  const aNum = parseFloat(acct)
  const rNum = parseFloat(riskPct)
  const live: Array<{ key: string; setup: BoardSetup; s: SideSetup; kind: 'long' | 'short'; event: ConfirmEvent | undefined; sizingTxt: string | null }> = []
  for (const setup of data?.setups ?? []) {
    for (const kind of ['long', 'short'] as const) {
      const s = setup[kind]
      if (s?.state !== 'LIVE') continue
      const event = log.find((e) => e.key === `${setup.symbol}:${kind}` && !e.exitedAt)
      let sizingTxt: string | null = null
      if (aNum > 0 && rNum > 0) {
        const m = (s.entryLow + s.entryHigh) / 2
        const dist = Math.abs(m - s.stop)
        if (dist > 0) {
          const units = (aNum * rNum) / 100 / dist
          const unitName = setup.market === 'crypto' ? setup.symbol : 'shares'
          sizingTxt = `size ≈ ${
            units >= 100 ? Math.round(units).toLocaleString('en-US') : Math.round(units * 10000) / 10000
          } ${unitName} · risk $${Math.round((aNum * rNum) / 100).toLocaleString('en-US')}`
        }
      }
      live.push({ key: `${setup.symbol}:${kind}`, setup, s, kind, event, sizingTxt })
    }
  }
  const history = log.filter((e) => e.exitedAt)
  const now = Date.now()

  return (
    <div className="min-h-full mx-auto flex w-full max-w-[1400px] flex-col gap-5 px-4 py-5 sm:px-6 sm:py-6">
      {/* header */}
      <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-tv-line bg-tv-panel shadow-sm p-3 sm:p-4">
        <div className="mr-1 flex items-center gap-2">
          <span
            className="inline-flex h-8 w-8 items-center justify-center rounded-xl border text-[14px]"
            style={{ background: 'var(--bull-soft)', borderColor: 'var(--bull-line)' }}
            aria-hidden="true"
          >
            ✅
          </span>
          <div className="text-[11px] font-bold uppercase tracking-[0.14em] text-tv-muted">
            Trade confirmed
          </div>
        </div>
        <span
          role="status"
          aria-live="polite"
          className={`rounded-full border px-2.5 py-1 text-[11px] font-bold tabular-nums ${
            live.length ? 'border-bull/40 bg-bull/10 text-bull' : 'border-tv-line bg-tv-panel2 text-tv-muted'
          }`}
        >
          {live.length} live now
        </span>
        <div className="flex flex-wrap items-center gap-1.5">
          {symbols.map((sym) => (
            <span
              key={sym}
              className="rounded-full border border-tv-line bg-tv-panel2 px-2.5 py-1 text-[11px] font-semibold text-tv-muted"
            >
              {sym}
            </span>
          ))}
        </div>
        <div className="ml-auto text-[11px] tabular-nums text-tv-muted">
          {loading ? 'refreshing…' : `refreshed ${data ? fmtTime(new Date(data.updatedAt).getTime()) : '—'} · auto every 45s`}
        </div>
      </div>

      {error && (
        <div role="alert" className="rounded-xl border px-3 py-2.5 text-[13px]" style={{ background: 'var(--bear-soft)', borderColor: 'var(--bear-line)' }}>
          <span className="text-bear">{error}</span>
        </div>
      )}

      {/* live confirmations */}
      <section aria-label="Confirmed entries" className="flex flex-col gap-4">
        <div className="text-[11px] font-bold uppercase tracking-[0.14em] text-tv-muted">
          Confirmed right now <span className="text-warn">— price inside entry zone</span>
        </div>
        {loading && !data ? (
          <>
            <div className="h-[280px] animate-pulse rounded-2xl border border-tv-line bg-tv-panel" />
            <div className="h-[280px] animate-pulse rounded-2xl border border-tv-line bg-tv-panel" />
          </>
        ) : live.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-tv-line-strong bg-tv-panel2/50 p-10 text-center">
            <div className="text-[15px] font-semibold text-tv-ink">No confirmed entries right now</div>
            <div className="mx-auto mt-1.5 max-w-md text-[12.5px] leading-relaxed text-tv-muted">
              The tracker is watching {symbols.length} symbol{symbols.length === 1 ? '' : 's'} (
              {symbols.join(', ')}). The moment price touches an entry zone on any setup — crypto or stocks —
              the trade appears here automatically.
            </div>
          </div>
        ) : (
          <div className="grid gap-4 lg:grid-cols-2">
            {live.map((c, i) => (
              <ConfirmedCard
                key={c.key}
                setup={c.setup}
                s={c.s}
                kind={c.kind}
                event={c.event}
                sizingTxt={c.sizingTxt}
                index={i}
              />
            ))}
          </div>
        )}
      </section>

      {/* history */}
      {history.length > 0 && (
        <section aria-label="Earlier confirmations" className="flex flex-col gap-3">
          <div className="flex items-center justify-between gap-2">
            <div className="text-[11px] font-bold uppercase tracking-[0.14em] text-tv-muted">
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
              className="rounded-xl border border-tv-line bg-tv-panel2 px-3 py-1.5 text-[11.5px] font-semibold text-tv-muted transition hover:text-tv-ink hover:border-tv-line-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bull/50"
            >
              Clear history
            </button>
          </div>
          <div className="flex flex-col gap-2">
            {history.slice(0, 8).map((e) => (
              <div
                key={`${e.key}:${e.confirmedAt}`}
                className="flex flex-wrap items-center gap-2.5 rounded-xl border border-tv-line bg-tv-panel px-3 py-2.5 text-[12px]"
              >
                <span className="font-bold text-tv-ink">{e.pair}</span>
                <span
                  className={`rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase ${
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
                <span className="ml-auto rounded-full border border-tv-line bg-tv-panel2 px-2 py-0.5 text-[10px] font-bold text-tv-muted">
                  {e.tag}
                </span>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* sizing hint */}
      {live.length > 0 && !(aNum > 0 && rNum > 0) && (
        <div className="text-[11.5px] text-tv-muted">
          Tip: set your account size and risk % on the Trade Setups page to see suggested position sizes here.
        </div>
      )}
    </div>
  )
}
