'use client'

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { motion } from 'framer-motion'
import { useToast } from '@/hooks/use-toast'
import { fmtPrice } from '@/components/signals/types'
import { DEFAULT_WATCHLIST, loadWatchlist, saveWatchlist } from '@/lib/watchlist'
import type { BoardSetup, SetupsPayload, SideSetup } from '@/lib/setups/generate'

// Trade2watch design tokens (mirrors public/app.html)
const C = {
  panel: 'bg-tv-panel border-tv-line',
  panel2: 'bg-tv-panel2 border-tv-line',
  muted: 'text-tv-muted',
  text: 'text-tv-ink',
  green: 'text-bull',
  red: 'text-bear',
  amber: 'text-warn',
  blue: 'text-info',
}

// soft icon-disc backgrounds per plan-ladder role (targets → info, entry → warn, stop → bear)
const ICON_SOFT: Record<string, string> = {
  [C.blue]: 'var(--info-soft)',
  [C.amber]: 'var(--warn-soft)',
  [C.red]: 'var(--bear-soft)',
}

const QUICK = ['BTC', 'ETH', 'SOL', 'AAPL', 'TSLA', 'NVDA']
const POLL_MS = 45_000

function lsGet(k: string, d: string): string {
  try {
    return localStorage.getItem(k) ?? d
  } catch {
    return d
  }
}

const chipCls: Record<string, string> = {
  liveShort: 'bg-bear/15 text-bear border-bear/45',
  liveLong: 'bg-bull/15 text-bull border-bull/45',
  hitShort: 'bg-bear/10 text-bear border-bear/35',
  hitLong: 'bg-bull/10 text-bull border-bull/35',
  waiting: 'bg-warn/10 text-warn border-warn/35',
  void: 'bg-tv-muted/12 text-tv-muted border-tv-line-strong',
}

// ─── trade-confirmation tracking — fires when price reaches an entry zone ───

interface ConfirmInfo {
  at: number // timestamp of the FIRST poll that saw price inside the zone
  price: number // price at confirmation
}

const CONF_KEY = 'tw_confirmed'

function loadConfirms(): Record<string, ConfirmInfo> {
  try {
    const raw = JSON.parse(localStorage.getItem(CONF_KEY) ?? '{}') as Record<string, ConfirmInfo>
    return raw && typeof raw === 'object' ? raw : {}
  } catch {
    return {}
  }
}

function saveConfirms(m: Record<string, ConfirmInfo>) {
  try {
    localStorage.setItem(CONF_KEY, JSON.stringify(m))
  } catch {
    /* private mode */
  }
}

/** One-chip summary per asset for the ZoneWatch strip. */
function summarize(s: BoardSetup): { cls: string; txt: string } {
  const l = s.long
  const sh = s.short
  if (sh?.state === 'LIVE') return { cls: chipCls.liveShort, txt: 'SHORT CONFIRMED' }
  if (l?.state === 'LIVE') return { cls: chipCls.liveLong, txt: 'LONG CONFIRMED' }
  // entry hit = confirmed: zone was triggered by a wick, price moved on
  if (sh?.state === 'HIT') return { cls: chipCls.hitShort, txt: 'SHORT HIT — CONFIRMED' }
  if (l?.state === 'HIT') return { cls: chipCls.hitLong, txt: 'LONG HIT — CONFIRMED' }
  const waits: string[] = []
  if (l?.state === 'WAITING' && l.distPct !== null) waits.push(`${l.distPct.toFixed(1)}% to LONG`)
  if (sh?.state === 'WAITING' && sh.distPct !== null) waits.push(`${sh.distPct.toFixed(1)}% to SHORT`)
  const voids: string[] = []
  if (l?.state === 'VOID') voids.push('LONG void')
  if (sh?.state === 'VOID') voids.push('SHORT void')
  if (voids.length === 2) return { cls: chipCls.void, txt: 'SETUP VOID' }
  if (waits.length === 0 && voids.length === 1) return { cls: chipCls.void, txt: `${voids[0].toUpperCase()} — WAIT` }
  if (voids.length === 1) return { cls: chipCls.waiting, txt: `${waits[0]} · ${voids[0]}` }
  return { cls: chipCls.waiting, txt: waits.length ? `WAITING · ${waits.join(' · ')}` : 'WAITING' }
}

// ─── trade-plan ladder — Entry levels · Stop loss · Targets, one glance ─────

function pctFrom(mid: number, v: number): string {
  const p = ((v - mid) / mid) * 100
  return `${p >= 0 ? '+' : ''}${p.toFixed(1)}%`
}

function rMult(v: number, mid: number, risk: number): string {
  return risk > 0 ? `${(Math.abs(v - mid) / risk).toFixed(1)}R` : '—'
}

/** time-only for today, date+time otherwise — wick hits are often hours/days old */
function fmtWhen(t: number): string {
  const d = new Date(t)
  const now = new Date()
  const sameDay =
    d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate()
  return sameDay
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function Badge({ children }: { children: ReactNode }) {
  return (
    <span className="rounded-full border border-tv-line bg-tv-panel2 px-2 py-0.5 text-[10px] font-bold tabular-nums text-tv-muted whitespace-nowrap">{children}</span>
  )
}

function PlanRow({
  icon, label, sub, price, badges, cls, big, accent,
}: {
  icon: string
  label: string
  sub?: string
  price: string
  badges?: Array<string | undefined>
  cls: string
  big?: boolean
  accent?: boolean
}) {
  const rowCls = accent
    ? 'border-warn/40 bg-warn/5'
    : cls === C.red
      ? 'border-bear/30 bg-bear/5'
      : 'border-tv-line bg-tv-panel2/50'
  return (
    <div
      role="listitem"
      className={`flex items-center gap-3 rounded-xl border px-3 py-2.5 ${rowCls}`}
    >
      <span
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[14px]"
        style={{ background: ICON_SOFT[cls] ?? 'var(--tv-panel2)' }}
        aria-hidden="true"
      >
        {icon}
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-[11px] font-bold uppercase tracking-wider text-tv-muted">{label}</div>
        {sub && <div className={`mt-0.5 text-[10.5px] ${C.muted}`}>{sub}</div>}
      </div>
      <div className="shrink-0 text-right">
        <div className={`font-bold tabular-nums ${cls} ${big ? 'text-[16.5px]' : 'text-[15px]'}`}>{price}</div>
        {badges && badges.some((b) => b) && (
          <div className="flex gap-1 justify-end mt-0.5 flex-wrap">
            {badges.filter((b): b is string => !!b).map((b, i) => (
              <Badge key={i}>{b}</Badge>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function TradePlanCard({
  side, kind, preferred, pair, currency, livePrice, confirmedAt,
}: {
  side: SideSetup
  kind: 'long' | 'short'
  preferred: boolean
  pair: string
  currency: string
  livePrice: number
  confirmedAt?: number
}) {
  const isLong = kind === 'long'
  const [copied, setCopied] = useState(false)
  const mid = (side.entryLow + side.entryHigh) / 2
  const risk = Math.abs(mid - side.stop)

  const stateChip =
    side.state === 'LIVE' ? (
      <span className={`px-2.5 py-0.5 rounded-full text-[11px] font-bold border ${isLong ? chipCls.liveLong : chipCls.liveShort}`}>
        ✓ CONFIRMED — IN ENTRY ZONE
      </span>
    ) : side.state === 'HIT' ? (
      <span className={`px-2.5 py-0.5 rounded-full text-[11px] font-bold border ${isLong ? chipCls.hitLong : chipCls.hitShort}`}>
        ✓ CONFIRMED — ENTRY HIT
      </span>
    ) : side.state === 'VOID' ? (
      <span className={`px-2.5 py-0.5 rounded-full text-[11px] font-bold border ${chipCls.void}`}>VOID — THESIS DEAD</span>
    ) : (
      <span className={`px-2.5 py-0.5 rounded-full text-[11px] font-bold border ${chipCls.waiting}`}>
        WAITING · {side.dist !== null && fmtPrice(side.dist, currency)} ({side.distPct?.toFixed(1)}%) away
      </span>
    )

  const copyPlan = async () => {
    const txt = `${pair} ${isLong ? 'LONG' : 'SHORT'} setup — Entry ${fmtPrice(side.entryLow, currency)}–${fmtPrice(
      side.entryHigh,
      currency,
    )} | Stop loss ${fmtPrice(side.stop, currency)} | TP1 ${fmtPrice(side.t1, currency)} | TP2 ${fmtPrice(
      side.t2,
      currency,
    )}${side.runner !== null ? ` | TP3 ${fmtPrice(side.runner, currency)}` : ''} | R:R ${side.rr}`
    try {
      await navigator.clipboard.writeText(txt)
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
    } catch {
      /* clipboard unavailable — silent */
    }
  }

  const entrySub =
    side.state === 'LIVE'
      ? `✓ confirmed${confirmedAt ? ` ${new Date(confirmedAt).toLocaleTimeString()}` : ''} — price ${fmtPrice(livePrice, currency)} inside entry zone`
      : side.state === 'HIT'
        ? `✓ entry triggered — wick ${side.touchedPrice !== null ? fmtPrice(side.touchedPrice, currency) : '—'}${
            side.touchedAt !== null ? ` ${fmtWhen(side.touchedAt)}` : ''
          } · price now ${fmtPrice(livePrice, currency)} (${side.distPct?.toFixed(1) ?? '?'}% away) — trade confirmed`
        : side.state === 'VOID'
          ? 'setup invalidated — wait for fresh structure'
          : `live ${fmtPrice(livePrice, currency)} — ${side.distPct?.toFixed(1) ?? '?'}% away, set limits and wait`

  // targets in the plan's own order: TP3 (furthest) → TP2 → TP1
  const targetRows = (
    [
      side.runner !== null && { key: 'tp3', label: 'TP3 · Runner', v: side.runner, sub: 'trail the rest beyond TP2' },
      { key: 'tp2', label: 'TP2 · Final target', v: side.t2, sub: 'close the position' },
      { key: 'tp1', label: 'TP1 · Bank half', v: side.t1, sub: 'take half off, move stop to entry' },
    ].filter(Boolean) as Array<{ key: string; label: string; v: number; sub: string }>
  ).map((r) => (
    <PlanRow key={r.key} icon="🎯" label={r.label} sub={r.sub} price={fmtPrice(r.v, currency)} cls={C.blue} badges={[pctFrom(mid, r.v), rMult(r.v, mid, risk)]} />
  ))

  const entryRow = (
    <PlanRow
      key="entry"
      icon="▶"
      label="ENTRY — limit zone"
      sub={entrySub}
      price={`${fmtPrice(side.entryLow, currency)} – ${fmtPrice(side.entryHigh, currency)}`}
      cls={C.amber}
      big
      accent
    />
  )
  const stopRow = (
    <PlanRow
      key="stop"
      icon="🛑"
      label="STOP LOSS"
      sub={side.stopNote}
      price={fmtPrice(side.stop, currency)}
      cls={C.red}
      badges={[pctFrom(mid, side.stop), risk > 0 ? `${fmtPrice(risk, currency)} risk/unit` : undefined]}
    />
  )

  return (
    <div
      className={`flex h-full flex-col gap-4 rounded-2xl border p-4 sm:p-6 ${
        preferred
          ? 'border-warn/50 bg-tv-panel shadow-[0_0_28px_var(--warn-soft)]'
          : 'border-tv-line bg-tv-panel shadow-sm'
      }`}
    >
      {/* header */}
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className={`text-[15px] font-bold tracking-tight ${isLong ? C.green : C.red}`}>
              {isLong ? '▲ LONG SETUP' : '▼ SHORT SETUP'}
            </h3>
            {preferred ? (
              <span className="rounded-full bg-warn px-2.5 py-0.5 text-[11px] font-bold text-tv-bg shadow-[0_0_20px_var(--warn-soft)]">★ THE ACTIVE SETUP</span>
            ) : (
              <span className={`px-2.5 py-0.5 rounded-full text-[11px] font-bold border ${isLong ? chipCls.liveLong : chipCls.liveShort}`}>{side.tag}</span>
            )}
          </div>
          <p className={`text-[12.5px] font-semibold mt-1 ${C.text}`}>{side.strategy}</p>
          <p className={`text-[11px] mt-0.5 ${C.muted}`}>{side.trigger}</p>
        </div>
        <div className="flex flex-col items-end gap-2 shrink-0">
          {stateChip}
          <button
            onClick={copyPlan}
            suppressHydrationWarning
            aria-label={`Copy ${pair} ${isLong ? 'long' : 'short'} plan to clipboard`}
            className="rounded-xl border border-tv-line bg-tv-panel2 px-3 py-2 text-[11px] font-bold text-tv-ink transition hover:border-tv-line-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bull/50"
          >
            {copied ? '✓ Copied' : '⧉ Copy plan'}
          </button>
        </div>
      </div>

      {/* the ladder — reads top-down like a chart (highest price first) */}
      <div className="flex flex-col gap-2" role="list" aria-label={`${pair} ${isLong ? 'long' : 'short'} plan levels`}>
        {isLong ? (
          <>
            {targetRows}
            {entryRow}
            {stopRow}
          </>
        ) : (
          <>
            {stopRow}
            {entryRow}
            {[...targetRows].reverse()}
          </>
        )}
      </div>

      {/* R:R + invalidation */}
      <div className="flex items-center justify-between gap-3 text-[12.5px] pt-1 border-t border-dashed border-tv-div">
        <span className={C.muted}>Risk : Reward</span>
        <span className={`font-bold tabular-nums ${C.green}`}>{side.rr}</span>
      </div>
      <p className={`text-[11.5px] leading-relaxed ${C.red}`}>⛔ {side.invalidation}</p>
      <span className="sr-only">
        {pair} {isLong ? 'long' : 'short'} setup — entry {fmtPrice(side.entryLow, currency)} to {fmtPrice(side.entryHigh, currency)}, stop{' '}
        {fmtPrice(side.stop, currency)}, targets {fmtPrice(side.t1, currency)} and {fmtPrice(side.t2, currency)}
      </span>
    </div>
  )
}

function ConfirmationCard({
  side, setup, s, info, sizingTxt, onDismiss,
}: {
  side: 'long' | 'short'
  setup: BoardSetup
  s: SideSetup
  info: ConfirmInfo
  sizingTxt: string | null
  onDismiss: () => void
}) {
  const isLong = side === 'long'
  const [copied, setCopied] = useState(false)
  const accent = isLong ? 'var(--bull)' : 'var(--bear)'
  const mid = (s.entryLow + s.entryHigh) / 2
  const risk = Math.abs(mid - s.stop)
  const rr1 = risk > 0 ? (Math.abs(s.t1 - mid) / risk).toFixed(1) : '—'

  const copyConfirmation = async () => {
    const txt = `${setup.pair} ${isLong ? 'LONG' : 'SHORT'} trade CONFIRMED @ ${fmtPrice(info.price, setup.currency)} — Entry ${fmtPrice(
      s.entryLow,
      setup.currency,
    )}–${fmtPrice(s.entryHigh, setup.currency)} · SL ${fmtPrice(s.stop, setup.currency)} · TP1 ${fmtPrice(s.t1, setup.currency)} · TP2 ${fmtPrice(
      s.t2,
      setup.currency,
    )}${s.runner !== null ? ` · TP3 ${fmtPrice(s.runner, setup.currency)}` : ''} · R:R 1:${rr1} at T1`
    try {
      await navigator.clipboard.writeText(txt)
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
    } catch {
      /* clipboard unavailable — silent */
    }
  }

  return (
    <div
      role="status"
      aria-live="polite"
      className="rounded-2xl border p-4 sm:p-5 flex flex-col gap-3"
      style={{
        background: isLong ? 'var(--bull-soft)' : 'var(--bear-soft)',
        borderColor: isLong ? 'var(--bull-line)' : 'var(--bear-line)',
        boxShadow: `0 0 34px ${isLong ? 'var(--bull-soft)' : 'var(--bear-soft)'}`,
      }}
    >
      <div className="flex items-start gap-3 flex-wrap">
        <span className="relative h-9 w-9 shrink-0" aria-hidden="true">
          <span className="absolute inset-0 animate-ping rounded-full opacity-40" style={{ background: accent }} />
          <span
            className="relative grid h-9 w-9 place-items-center rounded-full text-[15px] font-extrabold"
            style={{ background: accent, color: 'var(--tv-bg)' }}
          >
            ✓
          </span>
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[14.5px] font-extrabold tracking-wide" style={{ color: accent }}>
            TRADE CONFIRMED — {setup.pair} {isLong ? 'LONG' : 'SHORT'}
          </div>
          <div className={`mt-0.5 text-[11.5px] tabular-nums ${C.muted}`}>
            {s.state === 'HIT'
              ? `Wick ${fmtPrice(info.price, setup.currency)} hit the entry zone${info.at ? ` ${fmtWhen(info.at)}` : ''} · price now ${fmtPrice(
                  setup.price,
                  setup.currency,
                )} — entry triggered`
              : `Price ${fmtPrice(info.price, setup.currency)} reached the entry zone · confirmed ${new Date(info.at).toLocaleTimeString()} · live ${
                  fmtPrice(setup.price, setup.currency)
                }`}
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={copyConfirmation}
            suppressHydrationWarning
            aria-label={`Copy ${setup.pair} ${side} trade confirmation`}
            className="rounded-xl border bg-tv-panel2 px-3 py-2 text-[11px] font-bold text-tv-ink transition hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bull/50"
            style={{ borderColor: isLong ? 'var(--bull-line)' : 'var(--bear-line)' }}
          >
            {copied ? '✓ Copied' : '⧉ Copy confirmation'}
          </button>
          <button
            onClick={onDismiss}
            aria-label={`Dismiss ${setup.pair} ${side} confirmation`}
            suppressHydrationWarning
            className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-tv-line bg-tv-panel2 text-xs text-tv-muted transition hover:border-tv-line-strong hover:text-tv-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bull/50"
          >
            ✕
          </button>
        </div>
      </div>

      {/* checklist */}
      <div className="flex flex-wrap gap-1.5">
        {[
          s.state === 'HIT' ? 'Entry zone hit (candle wick)' : 'Price inside entry zone',
          isLong ? 'Stop not breached (price above stop)' : 'Stop not breached (price below stop)',
          `R:R gate passed — 1:${rr1} at T1`,
        ].map(
          (t) => (
            <span
              key={t}
              className="rounded-full border bg-tv-panel/60 px-2.5 py-0.5 text-[11px] font-bold"
              style={{ borderColor: 'var(--bull-line)', color: 'var(--bull)' }}
            >
              ✓ {t}
            </span>
          ),
        )}
      </div>

      {/* plan recap */}
      <div className="text-[12.5px] font-semibold flex flex-wrap gap-x-4 gap-y-1 tabular-nums text-tv-ink">
        <span>
          Entry <span className="text-warn">{fmtPrice(s.entryLow, setup.currency)} – {fmtPrice(s.entryHigh, setup.currency)}</span>
        </span>
        <span>
          SL <span className="text-bear">{fmtPrice(s.stop, setup.currency)}</span>
        </span>
        <span>
          TP1 <span className="text-info">{fmtPrice(s.t1, setup.currency)}</span>
        </span>
        <span>
          TP2 <span className="text-info">{fmtPrice(s.t2, setup.currency)}</span>
        </span>
        {s.runner !== null && (
          <span>
            TP3 <span className="text-info">{fmtPrice(s.runner, setup.currency)}</span>
          </span>
        )}
      </div>
      {sizingTxt && (
        <div className={`text-[11px] tabular-nums ${C.muted}`}>
          Suggested size: <b className="text-warn">{sizingTxt}</b>
        </div>
      )}
      <span className="sr-only">
        {setup.pair} {side} trade confirmed at {new Date(info.at).toLocaleTimeString()} — entry {fmtPrice(s.entryLow, setup.currency)} to{' '}
        {fmtPrice(s.entryHigh, setup.currency)}, stop {fmtPrice(s.stop, setup.currency)}
      </span>
    </div>
  )
}

export function SetupBoard() {
  const [symbols, setSymbols] = useState<string[]>(DEFAULT_WATCHLIST)
  const [data, setData] = useState<SetupsPayload | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState('BTC')
  const [input, setInput] = useState('')
  const [dismissed, setDismissed] = useState<Set<string>>(new Set())
  const [confirms, setConfirms] = useState<Record<string, ConfirmInfo>>({})
  const [acct, setAcct] = useState('')
  const [riskPct, setRiskPct] = useState('1')
  const mounted = useRef(true)
  const confirmsRef = useRef<Record<string, ConfirmInfo>>({})
  const wlLoaded = useRef(false)
  const { toast } = useToast()

  useEffect(() => {
    mounted.current = true
    setAcct(lsGet('tw_acct', ''))
    setRiskPct(lsGet('tw_risk', '1'))
    // restore the shared watchlist (also used by the Trade Confirmed board);
    // loadWatchlist migrates the old crypto-only default to include stocks
    const wl = loadWatchlist()
    setSymbols(wl)
    saveWatchlist(wl)
    wlLoaded.current = true
    const c = loadConfirms()
    confirmsRef.current = c
    setConfirms(c)
    return () => {
      mounted.current = false
    }
  }, [])

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

  // persist watchlist so the Trade Confirmed board tracks the same symbols
  useEffect(() => {
    if (!wlLoaded.current) return
    saveWatchlist(symbols)
  }, [symbols])

  // confirmation tracker — when price reaches an entry zone, record it once,
  // fire a toast, and re-arm automatically if the zone is left/voided
  useEffect(() => {
    if (!data) return
    const prev = confirmsRef.current
    const next: Record<string, ConfirmInfo> = {}
    const fired: Array<{ key: string; symbol: string; side: 'long' | 'short'; info: ConfirmInfo; s: SideSetup; setup: BoardSetup }> = []
    for (const setup of data.setups) {
      for (const kind of ['long', 'short'] as const) {
        const s = setup[kind]
        if (!s) continue
        const key = `${setup.symbol}:${kind}`
        if (s.state === 'LIVE') {
          const prior = prev[key]
          const info: ConfirmInfo = prior ? { ...prior, price: setup.price } : { at: Date.now(), price: setup.price }
          next[key] = info
          if (!prior) fired.push({ key, symbol: setup.symbol, side: kind, info, s, setup })
        } else if (s.state === 'HIT') {
          // entry hit (wick) = confirmed — record with the wick print + candle
          // time so the banner reflects the real trigger, not the poll time
          const prior = prev[key]
          const info: ConfirmInfo = prior
            ? { ...prior }
            : { at: s.touchedAt ?? Date.now(), price: s.touchedPrice ?? setup.price }
          next[key] = info
          if (!prior) fired.push({ key, symbol: setup.symbol, side: kind, info, s, setup })
        }
      }
    }
    confirmsRef.current = next
    setConfirms(next)
    saveConfirms(next)
    for (const f of fired) {
      setDismissed((d) => {
        if (!d.has(f.key)) return d
        const n = new Set(d)
        n.delete(f.key)
        return n
      })
      toast({
        title:
          f.s.state === 'HIT'
            ? `🎯 ${f.symbol} ${f.side.toUpperCase()} CONFIRMED — ENTRY HIT`
            : `✅ ${f.symbol} ${f.side.toUpperCase()} CONFIRMED`,
        description:
          f.s.state === 'HIT'
            ? `A candle wick reached ${fmtPrice(f.info.price, f.setup.currency)} inside the entry zone ${fmtPrice(
                f.s.entryLow,
                f.setup.currency,
              )} – ${fmtPrice(f.s.entryHigh, f.setup.currency)} · SL ${fmtPrice(f.s.stop, f.setup.currency)} · TP1 ${fmtPrice(f.s.t1, f.setup.currency)}`
            : `Price ${fmtPrice(f.info.price, f.setup.currency)} reached the entry zone ${fmtPrice(
                f.s.entryLow,
                f.setup.currency,
              )} – ${fmtPrice(f.s.entryHigh, f.setup.currency)} · SL ${fmtPrice(f.s.stop, f.setup.currency)} · TP1 ${fmtPrice(f.s.t1, f.setup.currency)}`,
      })
    }
  }, [data, toast])

  // keep selection valid
  const active: BoardSetup | undefined =
    data?.setups.find((s) => s.symbol === selected) ?? data?.setups[0]

  const persist = (k: string, v: string, setter: (x: string) => void) => {
    setter(v)
    try {
      localStorage.setItem(k, v)
    } catch { /* private mode */ }
  }

  const addSymbol = () => {
    const s = input.trim().toUpperCase()
    if (!/^[A-Z0-9.\-]{1,10}$/.test(s)) return
    if (!symbols.includes(s)) setSymbols((prev) => [...prev, s].slice(0, 8))
    setSelected(s)
    setInput('')
  }

  const savePct = (x: number, min: number, max: number) => Math.min(max, Math.max(min, x))

  const sizingFor = (side: SideSetup | null) => {
    if (!side) return null
    const a = parseFloat(acct)
    const r = parseFloat(riskPct)
    if (!(a > 0) || !(r > 0)) return null
    const mid = (side.entryLow + side.entryHigh) / 2
    const dist = Math.abs(mid - side.stop)
    if (!(dist > 0)) return null
    const riskDollars = (a * r) / 100
    const units = riskDollars / dist
    const notional = units * (active?.price ?? mid)
    const unitName = active?.market === 'crypto' ? (active?.symbol ?? '') : 'shares'
    return {
      unitsTxt: `${units >= 100 ? Math.round(units).toLocaleString('en-US') : Math.round(units * 10000) / 10000} ${unitName}`,
      notionalTxt: `notional ≈ ${fmtPrice(notional, 'USD')} · risk $${Math.round(riskDollars).toLocaleString('en-US')} · stop dist ${fmtPrice(dist, 'USD')}`,
    }
  }

  // active trade confirmations — LIVE state + tracked confirmation info
  const confirmations: Array<{ key: string; side: 'long' | 'short'; setup: BoardSetup; s: SideSetup; info: ConfirmInfo; sizingTxt: string | null }> = []
  const aNum = parseFloat(acct)
  const rNum = parseFloat(riskPct)
  for (const setup of data?.setups ?? []) {
    for (const kind of ['long', 'short'] as const) {
      const s = setup[kind]
      const key = `${setup.symbol}:${kind}`
      const info = confirms[key]
      if ((s?.state === 'LIVE' || s?.state === 'HIT') && info && !dismissed.has(key)) {
        let sizingTxt: string | null = null
        if (aNum > 0 && rNum > 0) {
          const m = (s.entryLow + s.entryHigh) / 2
          const dist = Math.abs(m - s.stop)
          if (dist > 0) {
            const units = (aNum * rNum) / 100 / dist
            const unitName = setup.market === 'crypto' ? setup.symbol : 'shares'
            sizingTxt = `${units >= 100 ? Math.round(units).toLocaleString('en-US') : Math.round(units * 10000) / 10000} ${unitName} (${fmtPrice(
              dist,
              setup.currency,
            )} stop distance)`
          }
        }
        confirmations.push({ key, side: kind, setup, s, info, sizingTxt })
      }
    }
  }

  const gaugePct = (v: number) =>
    active ? savePct(((v - active.gauge.min) / (active.gauge.max - active.gauge.min)) * 100, 0, 100) : 0

  return (
    <div className="min-h-full mx-auto flex w-full max-w-[1400px] flex-col gap-5 px-4 py-5 sm:px-6 sm:py-6">
      {/* toolbar */}
      <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-tv-line bg-tv-panel shadow-sm p-3 sm:p-4">
        <div className="mr-1 text-[11px] font-bold uppercase tracking-[0.14em] text-tv-muted">Watchlist</div>
        {(data?.setups ?? []).map((s) => (
          <button
            key={s.symbol}
            onClick={() => setSelected(s.symbol)}
            suppressHydrationWarning
            aria-pressed={active?.symbol === s.symbol}
            className={`rounded-full border px-3 py-1.5 text-[12px] font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bull/50 ${
              active?.symbol === s.symbol
                ? 'border-bull/40 bg-bull/10 text-bull'
                : 'border-tv-line bg-tv-panel2 text-tv-muted hover:text-tv-ink hover:border-tv-line-strong'
            }`}
          >
            {s.symbol}
          </button>
        ))}
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && addSymbol()}
            placeholder="Add symbol (BTC, AAPL…)"
            aria-label="Add symbol"
            suppressHydrationWarning
            className="w-40 sm:w-48 rounded-xl border border-tv-line bg-tv-panel2 px-3 py-2 text-sm text-tv-ink placeholder:text-tv-muted2 transition focus:outline-none focus:ring-2 focus:ring-bull/40 focus:border-bull/60"
          />
          <button
            onClick={addSymbol}
            suppressHydrationWarning
            aria-label="Add symbol to watchlist"
            className="rounded-xl border border-tv-line bg-tv-panel2 px-3 py-2 text-[12px] font-semibold text-tv-ink transition hover:border-tv-line-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bull/50"
          >
            + Add
          </button>
          <button
            onClick={() => { setLoading(true); load() }}
            suppressHydrationWarning
            className="rounded-xl border border-tv-line bg-tv-panel2 px-3 py-2 text-[12px] font-semibold text-tv-ink transition hover:border-tv-line-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bull/50"
            aria-label="Refresh setups"
          >
            ⟳ Refresh
          </button>
        </div>
        <div className="flex w-full flex-wrap items-center gap-2 text-[11px] text-tv-muted">
          <span>Quick:</span>
          {QUICK.filter((q) => !symbols.includes(q)).map((q) => (
            <button
              key={q}
              onClick={() => { setSymbols((prev) => [...prev, q].slice(0, 8)); setSelected(q) }}
              suppressHydrationWarning
              className="rounded-full border border-tv-line bg-tv-panel2 px-3 py-1.5 text-[12px] font-semibold text-tv-muted transition hover:text-tv-ink hover:border-tv-line-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bull/50"
            >
              +{q}
            </button>
          ))}
          <span className="ml-auto tabular-nums">
            {data ? `Live · regenerated ${new Date(data.updatedAt).toLocaleTimeString()} · auto every 45s` : 'connecting…'}
          </span>
        </div>
      </div>

      {/* trade confirmations — fire when price genuinely reaches an entry zone */}
      {confirmations.map((c) => (
        <ConfirmationCard
          key={c.key}
          side={c.side}
          setup={c.setup}
          s={c.s}
          info={c.info}
          sizingTxt={c.sizingTxt}
          onDismiss={() => setDismissed((prev) => new Set(prev).add(c.key))}
        />
      ))}

      {/* ZoneWatch strip */}
      <section aria-label="ZoneWatch — live zone monitor">
        <h2 className="mb-3 text-[11px] font-bold uppercase tracking-[0.14em] text-tv-muted">ZoneWatch — every zone, one board</h2>
        {loading && !data ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-[92px] rounded-2xl border border-tv-line bg-tv-panel animate-pulse" />
            ))}
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {(data?.setups ?? []).map((s) => {
              const chip = summarize(s)
              return (
                <button
                  key={s.symbol}
                  onClick={() => setSelected(s.symbol)}
                  suppressHydrationWarning
                  aria-pressed={active?.symbol === s.symbol}
                  className={`rounded-2xl border p-4 text-left shadow-sm transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bull/50 ${
                    active?.symbol === s.symbol ? 'border-bull/40 bg-tv-panel2' : 'border-tv-line bg-tv-panel hover:border-tv-line-strong'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[13px] font-bold text-tv-ink">
                      {s.displayName} <span className={C.muted}>· {s.pair}</span>
                    </span>
                    <span className={`rounded-full border px-2 py-0.5 text-[11px] font-bold tabular-nums ${s.change24h >= 0 ? 'bg-bull/10 text-bull border-bull/30' : 'bg-bear/10 text-bear border-bear/30'}`}>
                      {s.change24h >= 0 ? '+' : ''}{s.change24h.toFixed(2)}%
                    </span>
                  </div>
                  <div className="mt-1 text-xl font-bold tabular-nums tracking-tight text-tv-ink">
                    {fmtPrice(s.price, s.currency)}
                  </div>
                  <div className="mt-2">
                    <span className={`inline-block px-2.5 py-0.5 rounded-full text-[11px] font-bold border ${chip.cls}`}>{chip.txt}</span>
                  </div>
                </button>
              )
            })}
          </div>
        )}
        {data && Object.keys(data.failed).length > 0 && (
          <p className={`text-[11px] mt-2 ${C.muted}`}>
            No data: {Object.entries(data.failed).map(([k, v]) => `${k} (${v.slice(0, 40)})`).join(', ')}
          </p>
        )}
        {error && (
          <p className="text-[12px] mt-2 text-bear">
            Feed error: {error} — retrying automatically.{' '}
            <button onClick={() => { setLoading(true); load() }} suppressHydrationWarning className="underline transition hover:text-tv-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bull/50">Retry now</button>
          </p>
        )}
      </section>

      {/* selected asset detail */}
      {active && (
        <section aria-label={`${active.displayName} setup detail`} className="flex flex-col gap-5">
          {/* header + gauge */}
          <div className="rounded-2xl border border-tv-line bg-tv-panel shadow-sm p-4 sm:p-6">
            <div className="flex items-start justify-between gap-4 flex-wrap">
              <div>
                <div className="flex items-center gap-2.5 flex-wrap">
                  <h2 className="text-lg font-bold tracking-tight text-tv-ink">
                    {active.displayName} — {active.pair}
                  </h2>
                  <span className="rounded-full border border-info/40 bg-info/15 px-2.5 py-0.5 text-[11px] font-bold text-info">
                    {active.biasTag}
                  </span>
                </div>
                <p className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-tv-muted">
                  <span className="rounded-full border border-tv-line bg-tv-panel2 px-2.5 py-0.5 text-[11px] font-bold text-tv-muted">
                    {active.regime.replace('_', ' ')}
                  </span>
                  <span>
                    regime · {active.timeframe} candles · RSI(14){' '}
                    <b className={`tabular-nums ${active.rsi !== null ? (active.rsi >= 70 ? C.red : active.rsi <= 30 ? C.green : C.text) : ''}`}>
                      {active.rsi !== null ? active.rsi.toFixed(1) : '—'}
                    </b>{' '}
                    · ATR {active.atrPct !== null ? `${active.atrPct.toFixed(2)}%` : '—'}
                  </span>
                </p>
              </div>
              <div className="flex flex-col items-end gap-1.5">
                <div className="text-2xl font-bold tabular-nums tracking-tight text-tv-ink sm:text-3xl">
                  {fmtPrice(active.price, active.currency)}
                </div>
                <span
                  className={`rounded-full border px-2.5 py-0.5 text-[11px] font-bold tabular-nums ${
                    active.change24h >= 0 ? 'bg-bull/10 text-bull border-bull/30' : 'bg-bear/10 text-bear border-bear/30'
                  }`}
                >
                  {active.change24h >= 0 ? '+' : ''}{active.change24h.toFixed(2)}% 24h
                </span>
              </div>
            </div>

            <p className="mt-3 text-[13px] text-warn">{active.biasNote}</p>

            {/* gauge */}
            <div className="mt-4" aria-hidden="true">
              <div className="relative h-2.5 rounded-full bg-tv-panel2 border border-tv-line overflow-visible">
                {active.long && (
                  <div
                    className="absolute top-0 h-full rounded-full bg-bull/55"
                    style={{ left: `${gaugePct(active.long.entryLow)}%`, width: `${Math.max(gaugePct(active.long.entryHigh) - gaugePct(active.long.entryLow), 1.5)}%` }}
                  />
                )}
                {active.short && (
                  <div
                    className="absolute top-0 h-full rounded-full bg-bear/55"
                    style={{ left: `${gaugePct(active.short.entryLow)}%`, width: `${Math.max(gaugePct(active.short.entryHigh) - gaugePct(active.short.entryLow), 1.5)}%` }}
                  />
                )}
                <div
                  className="absolute -top-1.5 -bottom-1.5 w-[2px] bg-tv-ink"
                  style={{ left: `${gaugePct(active.price)}%` }}
                />
              </div>
              <div className="mt-1.5 flex justify-between text-[10px] tabular-nums text-tv-muted2">
                <span>{fmtPrice(active.gauge.min, active.currency)}</span>
                <span className="text-tv-ink font-semibold">▲ {fmtPrice(active.price, active.currency)}</span>
                <span>{fmtPrice(active.gauge.max, active.currency)}</span>
              </div>
              <div className={`text-[11px] mt-1 ${C.muted}`}>
                <span className="text-bull">■</span> long zone&nbsp;&nbsp;
                <span className="text-bear">■</span> short zone&nbsp;&nbsp;— zones regenerate with market structure
              </div>
            </div>
          </div>

          {/* the trade plans — preferred side first */}
          <div className="flex flex-col gap-4">
            <h2 className="text-[11px] font-bold uppercase tracking-[0.14em] text-tv-muted">
              Trade plans — <span className="text-warn">entry levels</span>, <span className="text-bear">stop loss</span> &amp;{' '}
              <span className="text-info">targets</span>
            </h2>
            <div className="grid grid-cols-1 gap-4 sm:gap-5 xl:grid-cols-2">
              {([['long', active.long], ['short', active.short]] as Array<['long' | 'short', SideSetup | null]>)
                .filter((pair): pair is ['long' | 'short', SideSetup] => pair[1] !== null)
                .sort((a, b) => (a[1].tag === 'PREFERRED' ? -1 : 0) - (b[1].tag === 'PREFERRED' ? -1 : 0))
                .map(([kind, side], idx) => (
                  <motion.div
                    key={kind}
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.25, ease: 'easeOut', delay: idx * 0.05 }}
                  >
                    <TradePlanCard
                      side={side}
                      kind={kind}
                      preferred={side.tag === 'PREFERRED'}
                      pair={active.pair}
                      currency={active.currency}
                      livePrice={active.price}
                      confirmedAt={confirms[`${active.symbol}:${kind}`]?.at}
                    />
                  </motion.div>
                ))}
            </div>
          </div>

          {/* sizing */}
          <div className="rounded-2xl border border-tv-line bg-tv-panel shadow-sm p-4 sm:p-6">
            <h3 className="mb-3 text-[11px] font-bold uppercase tracking-[0.14em] text-tv-muted">Position sizing — risk-first</h3>
            <div className="flex flex-wrap gap-3 mb-4">
              <label className={`text-[12px] ${C.muted}`}>
                <span className="block mb-1">Account ($)</span>
                <input
                  value={acct}
                  onChange={(e) => persist('tw_acct', e.target.value, setAcct)}
                  inputMode="decimal"
                  placeholder="10000"
                  suppressHydrationWarning
                  className="w-36 rounded-xl border border-tv-line bg-tv-panel2 px-3 py-2 text-sm text-tv-ink placeholder:text-tv-muted2 transition focus:outline-none focus:ring-2 focus:ring-bull/40 focus:border-bull/60"
                />
              </label>
              <label className={`text-[12px] ${C.muted}`}>
                <span className="block mb-1">Risk per trade (%)</span>
                <input
                  value={riskPct}
                  onChange={(e) => persist('tw_risk', e.target.value, setRiskPct)}
                  inputMode="decimal"
                  placeholder="1"
                  suppressHydrationWarning
                  className="w-28 rounded-xl border border-tv-line bg-tv-panel2 px-3 py-2 text-sm text-tv-ink placeholder:text-tv-muted2 transition focus:outline-none focus:ring-2 focus:ring-bull/40 focus:border-bull/60"
                />
              </label>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-[13px]">
              {([['long', active.long], ['short', active.short]] as Array<['long' | 'short', SideSetup | null]>).map(
                ([kind, side]) => {
                  const sz = sizingFor(side)
                  const label = kind === 'long' ? 'LONG side' : 'SHORT side'
                  return (
                    <div key={kind} className="rounded-xl border border-tv-line bg-tv-panel2 p-3">
                      <div className="mb-1 text-[11px] font-bold uppercase tracking-wider text-warn">{label}</div>
                      {sz ? (
                        <>
                          <div className="font-bold tabular-nums text-tv-ink">{sz.unitsTxt}</div>
                          <div className="text-[11px] tabular-nums text-tv-muted">{sz.notionalTxt}</div>
                        </>
                      ) : (
                        <div className={C.muted}>Enter account &amp; risk to size</div>
                      )}
                    </div>
                  )
                },
              )}
            </div>
          </div>

          {/* key levels */}
          <div className="rounded-2xl border border-tv-line bg-tv-panel shadow-sm p-4 sm:p-6">
            <h3 className="mb-3 text-[11px] font-bold uppercase tracking-[0.14em] text-tv-muted">Key levels — live structure</h3>
            <ul className="flex flex-col gap-1.5">
              {active.levels.map((l, i) => (
                <li key={i} className="flex items-baseline gap-3 text-[13px]">
                  <span className={`w-28 shrink-0 font-semibold tabular-nums whitespace-nowrap ${l.t === 'res' ? C.red : l.t === 'sup' ? C.green : C.blue}`}>
                    {l.t === 'res' ? 'RES' : l.t === 'sup' ? 'SUP' : 'EMA'} {fmtPrice(l.v, active.currency)}
                  </span>
                  <span className={C.muted}>{l.w}</span>
                </li>
              ))}
            </ul>
          </div>
        </section>
      )}

      {/* footer / disclaimer */}
      <footer className={`mt-auto pt-2 pb-4 text-[11px] leading-relaxed ${C.muted} border-t border-tv-line`}>
        Setups are <b className={C.text}>auto-generated from live market data</b> (Binance · Yahoo Finance) every 45 seconds — levels
        follow the market, so they never go stale.{' '}
        <a href="/app.html" target="_blank" rel="noreferrer" className="underline hover:text-tv-ink">
          Legacy static view ↗
        </a>
        <br />
        <b className={C.amber}>Disclaimer:</b> Technical analysis of public market data for decision support only. Not financial
        advice — no auto-trading. Crypto and stocks are volatile; never trade money you can&apos;t afford to lose.
      </footer>
    </div>
  )
}
