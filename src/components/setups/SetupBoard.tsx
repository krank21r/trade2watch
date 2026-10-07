'use client'

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { useToast } from '@/hooks/use-toast'
import { fmtPrice } from '@/components/signals/types'
import type { BoardSetup, SetupsPayload, SideSetup } from '@/lib/setups/generate'

// Trade2watch design tokens (mirrors public/app.html)
const C = {
  panel: 'bg-[#131722] border-[#232b3d]',
  panel2: 'bg-[#1a2030] border-[#232b3d]',
  muted: 'text-[#8b93a7]',
  text: 'text-[#e6e9f0]',
  green: 'text-[#26a69a]',
  red: 'text-[#ef5350]',
  amber: 'text-[#f5b544]',
  blue: 'text-[#4a9eff]',
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
  liveShort: 'bg-[rgba(239,83,80,.15)] text-[#ef5350] border-[rgba(239,83,80,.45)]',
  liveLong: 'bg-[rgba(38,166,154,.15)] text-[#26a69a] border-[rgba(38,166,154,.45)]',
  waiting: 'bg-[rgba(245,181,68,.1)] text-[#f5b544] border-[rgba(245,181,68,.35)]',
  void: 'bg-[rgba(139,147,167,.12)] text-[#8b93a7] border-[#3a4560]',
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

function Badge({ children }: { children: ReactNode }) {
  return (
    <span className="px-1.5 py-px rounded text-[9.5px] font-bold bg-[rgba(255,255,255,.07)] text-[#8b93a7] whitespace-nowrap">{children}</span>
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
  return (
    <div
      role="listitem"
      className={`flex items-center gap-3 rounded-lg px-3 py-2.5 border ${accent ? 'bg-[rgba(245,181,68,.07)] border-[rgba(245,181,68,.35)]' : 'bg-[rgba(26,32,48,.6)] border-transparent'}`}
    >
      <span className="text-[15px] w-6 text-center shrink-0" aria-hidden="true">{icon}</span>
      <div className="min-w-0 flex-1">
        <div className={`font-bold ${C.text} ${big ? 'text-[12.5px]' : 'text-[11.5px]'}`}>{label}</div>
        {sub && <div className={`text-[10.5px] mt-0.5 ${C.muted}`}>{sub}</div>}
      </div>
      <div className="text-right shrink-0">
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
      <span className={`px-2.5 py-0.5 rounded-full text-[10px] font-bold border ${isLong ? chipCls.liveLong : chipCls.liveShort}`}>
        ✓ CONFIRMED — IN ENTRY ZONE
      </span>
    ) : side.state === 'VOID' ? (
      <span className={`px-2.5 py-0.5 rounded-full text-[10px] font-bold border ${chipCls.void}`}>VOID — THESIS DEAD</span>
    ) : (
      <span className={`px-2.5 py-0.5 rounded-full text-[10px] font-bold border ${chipCls.waiting}`}>
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
      className={`rounded-[14px] border p-5 flex flex-col gap-3.5 ${
        preferred
          ? 'border-[rgba(245,181,68,.5)] bg-[#131722] shadow-[0_0_28px_rgba(245,181,68,.07)]'
          : C.panel
      }`}
    >
      {/* header */}
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className={`text-[16px] font-extrabold tracking-wide ${isLong ? C.green : C.red}`}>
              {isLong ? '▲ LONG SETUP' : '▼ SHORT SETUP'}
            </h3>
            {preferred ? (
              <span className="px-2 py-0.5 rounded-full text-[10px] font-extrabold bg-[#f5b544] text-[#0b0e14]">★ THE ACTIVE SETUP</span>
            ) : (
              <span className={`px-2.5 py-0.5 rounded-full text-[10px] font-bold border ${isLong ? chipCls.liveLong : chipCls.liveShort}`}>{side.tag}</span>
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
            className="px-3 py-1.5 rounded-lg text-[11px] font-bold border border-[#232b3d] bg-[#1a2030] text-[#e6e9f0] hover:border-[#f5b544]/60 transition-colors"
          >
            {copied ? '✓ Copied' : '⧉ Copy plan'}
          </button>
        </div>
      </div>

      {/* the ladder — reads top-down like a chart (highest price first) */}
      <div className="flex flex-col gap-1.5" role="list" aria-label={`${pair} ${isLong ? 'long' : 'short'} plan levels`}>
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
      <div className="flex items-center justify-between gap-3 text-[12.5px] pt-1 border-t border-dashed border-white/5">
        <span className={C.muted}>Risk : Reward</span>
        <span className={`font-bold ${C.green}`}>{side.rr}</span>
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
  const accent = isLong ? '#26a69a' : '#ef5350'
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
      className="rounded-[14px] border px-4 py-4 flex flex-col gap-3"
      style={{
        background: isLong ? 'rgba(38,166,154,.10)' : 'rgba(239,83,80,.10)',
        borderColor: isLong ? 'rgba(38,166,154,.5)' : 'rgba(239,83,80,.5)',
        boxShadow: `0 0 34px ${isLong ? 'rgba(38,166,154,.14)' : 'rgba(239,83,80,.14)'}`,
      }}
    >
      <div className="flex items-start gap-3 flex-wrap">
        <span
          className="animate-pulse w-8 h-8 rounded-full grid place-items-center text-[15px] font-extrabold shrink-0"
          style={{ background: accent, color: '#0b0e14' }}
          aria-hidden="true"
        >
          ✓
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[14.5px] font-extrabold tracking-wide" style={{ color: accent }}>
            TRADE CONFIRMED — {setup.pair} {isLong ? 'LONG' : 'SHORT'}
          </div>
          <div className={`text-[11.5px] mt-0.5 ${C.muted}`}>
            Price {fmtPrice(info.price, setup.currency)} reached the entry zone · confirmed {new Date(info.at).toLocaleTimeString()} · live{' '}
            {fmtPrice(setup.price, setup.currency)}
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={copyConfirmation}
            suppressHydrationWarning
            aria-label={`Copy ${setup.pair} ${side} trade confirmation`}
            className="px-3 py-1.5 rounded-lg text-[11px] font-bold border bg-[#1a2030] text-[#e6e9f0] hover:opacity-80 transition-opacity"
            style={{ borderColor: isLong ? 'rgba(38,166,154,.5)' : 'rgba(239,83,80,.5)' }}
          >
            {copied ? '✓ Copied' : '⧉ Copy confirmation'}
          </button>
          <button
            onClick={onDismiss}
            aria-label={`Dismiss ${setup.pair} ${side} confirmation`}
            suppressHydrationWarning
            className="w-7 h-7 rounded-full bg-[rgba(255,255,255,.08)] hover:bg-[rgba(255,255,255,.16)] text-[#e6e9f0] text-xs"
          >
            ✕
          </button>
        </div>
      </div>

      {/* checklist */}
      <div className="flex flex-wrap gap-1.5">
        {['Price inside entry zone', isLong ? 'Stop not breached (price above stop)' : 'Stop not breached (price below stop)', `R:R gate passed — 1:${rr1} at T1`].map(
          (t) => (
            <span
              key={t}
              className="px-2 py-0.5 rounded-full text-[10px] font-bold border"
              style={{ background: 'rgba(38,166,154,.12)', borderColor: 'rgba(38,166,154,.4)', color: '#26a69a' }}
            >
              ✓ {t}
            </span>
          ),
        )}
      </div>

      {/* plan recap */}
      <div className="text-[12.5px] font-semibold flex flex-wrap gap-x-4 gap-y-1 text-[#e6e9f0]">
        <span>
          Entry <span className="text-[#f5b544]">{fmtPrice(s.entryLow, setup.currency)} – {fmtPrice(s.entryHigh, setup.currency)}</span>
        </span>
        <span>
          SL <span className="text-[#ef5350]">{fmtPrice(s.stop, setup.currency)}</span>
        </span>
        <span>
          TP1 <span className="text-[#4a9eff]">{fmtPrice(s.t1, setup.currency)}</span>
        </span>
        <span>
          TP2 <span className="text-[#4a9eff]">{fmtPrice(s.t2, setup.currency)}</span>
        </span>
        {s.runner !== null && (
          <span>
            TP3 <span className="text-[#4a9eff]">{fmtPrice(s.runner, setup.currency)}</span>
          </span>
        )}
      </div>
      {sizingTxt && (
        <div className={`text-[11px] ${C.muted}`}>
          Suggested size: <b className="text-[#f5b544]">{sizingTxt}</b>
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
  const [symbols, setSymbols] = useState<string[]>(['BTC', 'ETH', 'SOL'])
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
  const { toast } = useToast()

  useEffect(() => {
    mounted.current = true
    setAcct(lsGet('tw_acct', ''))
    setRiskPct(lsGet('tw_risk', '1'))
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
        title: `✅ ${f.symbol} ${f.side.toUpperCase()} CONFIRMED`,
        description: `Price ${fmtPrice(f.info.price, f.setup.currency)} reached the entry zone ${fmtPrice(
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
      if (s?.state === 'LIVE' && info && !dismissed.has(key)) {
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
    <div className="min-h-full flex flex-col px-4 sm:px-6 py-5 gap-5 max-w-6xl w-full mx-auto">
      {/* toolbar */}
      <div className={`rounded-[14px] border ${C.panel} p-4 flex flex-wrap items-center gap-2.5`}>
        <div className={`text-[13px] font-bold mr-1 ${C.text}`}>Watchlist</div>
        {(data?.setups ?? []).map((s) => (
          <button
            key={s.symbol}
            onClick={() => setSelected(s.symbol)}
            suppressHydrationWarning
            aria-pressed={active?.symbol === s.symbol}
            className={`px-3 py-1.5 rounded-full text-[12px] font-semibold border transition-colors ${
              active?.symbol === s.symbol
                ? 'bg-[#1a2030] text-[#f5b544] border-[rgba(245,181,68,.45)]'
                : 'bg-transparent text-[#8b93a7] border-[#232b3d] hover:text-[#e6e9f0] hover:border-[#3a4560]'
            }`}
          >
            {s.symbol}
          </button>
        ))}
        <div className="flex items-center gap-1.5 ml-auto flex-wrap">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && addSymbol()}
            placeholder="Add symbol (BTC, AAPL…)"
            aria-label="Add symbol"
            suppressHydrationWarning
            className={`w-40 sm:w-48 px-3 py-1.5 rounded-lg text-[12px] ${C.panel2} border border-[#232b3d] ${C.text} placeholder:text-[#5a6377] focus:outline-none focus:border-[#f5b544]/50`}
          />
          <button
            onClick={addSymbol}
            suppressHydrationWarning
            className="px-3 py-1.5 rounded-lg text-[12px] font-semibold bg-[#1a2030] border border-[#232b3d] text-[#e6e9f0] hover:border-[#f5b544]/50 transition-colors"
          >
            + Add
          </button>
          <button
            onClick={() => { setLoading(true); load() }}
            suppressHydrationWarning
            className="px-3 py-1.5 rounded-lg text-[12px] font-semibold bg-[#1a2030] border border-[#232b3d] text-[#e6e9f0] hover:border-[#f5b544]/50 transition-colors"
            aria-label="Refresh setups"
          >
            ⟳ Refresh
          </button>
        </div>
        <div className={`w-full flex flex-wrap items-center gap-2 text-[11px] ${C.muted}`}>
          <span>Quick:</span>
          {QUICK.filter((q) => !symbols.includes(q)).map((q) => (
            <button
              key={q}
              onClick={() => { setSymbols((prev) => [...prev, q].slice(0, 8)); setSelected(q) }}
              suppressHydrationWarning
              className="px-2 py-0.5 rounded-full border border-[#232b3d] hover:border-[#3a4560] hover:text-[#e6e9f0] transition-colors"
            >
              +{q}
            </button>
          ))}
          <span className="ml-auto">
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
        <h2 className={`text-[13px] font-bold mb-2 ${C.text}`}>ZoneWatch — every zone, one board</h2>
        {loading && !data ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {[0, 1, 2].map((i) => (
              <div key={i} className={`h-[92px] rounded-[14px] border ${C.panel} animate-pulse`} />
            ))}
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {(data?.setups ?? []).map((s) => {
              const chip = summarize(s)
              return (
                <button
                  key={s.symbol}
                  onClick={() => setSelected(s.symbol)}
                  suppressHydrationWarning
                  aria-pressed={active?.symbol === s.symbol}
                  className={`text-left rounded-[14px] border p-4 transition-colors ${
                    active?.symbol === s.symbol ? 'border-[rgba(245,181,68,.45)] bg-[#1a2030]' : `${C.panel} hover:border-[#3a4560]`
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className={`text-[13px] font-bold ${C.text}`}>
                      {s.displayName} <span className={C.muted}>· {s.pair}</span>
                    </span>
                    <span className={`text-[12px] font-semibold ${s.change24h >= 0 ? C.green : C.red}`}>
                      {s.change24h >= 0 ? '+' : ''}{s.change24h.toFixed(2)}%
                    </span>
                  </div>
                  <div className="text-xl font-bold tabular-nums mt-1" style={{ letterSpacing: '-1px' }}>
                    {fmtPrice(s.price, s.currency)}
                  </div>
                  <div className="mt-2">
                    <span className={`inline-block px-2.5 py-0.5 rounded-full text-[10px] font-bold border ${chip.cls}`}>{chip.txt}</span>
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
          <p className="text-[12px] mt-2 text-[#ef5350]">
            Feed error: {error} — retrying automatically.{' '}
            <button onClick={() => { setLoading(true); load() }} suppressHydrationWarning className="underline">Retry now</button>
          </p>
        )}
      </section>

      {/* selected asset detail */}
      {active && (
        <section aria-label={`${active.displayName} setup detail`} className="flex flex-col gap-5">
          {/* header + gauge */}
          <div className={`rounded-[14px] border ${C.panel} p-5`}>
            <div className="flex items-start justify-between gap-4 flex-wrap">
              <div>
                <div className="flex items-center gap-2.5 flex-wrap">
                  <h2 className={`text-lg font-bold ${C.text}`}>
                    {active.displayName} — {active.pair}
                  </h2>
                  <span className="px-2.5 py-0.5 rounded-full text-[10px] font-bold border bg-[rgba(74,158,255,.12)] text-[#4a9eff] border-[rgba(74,158,255,.4)]">
                    {active.biasTag}
                  </span>
                </div>
                <p className={`text-xs mt-1 ${C.muted}`}>
                  {active.regime.replace('_', ' ')} regime · {active.timeframe} candles · RSI(14){' '}
                  <b className={active.rsi !== null ? (active.rsi >= 70 ? C.red : active.rsi <= 30 ? C.green : C.text) : ''}>
                    {active.rsi !== null ? active.rsi.toFixed(1) : '—'}
                  </b>{' '}
                  · ATR {active.atrPct !== null ? `${active.atrPct.toFixed(2)}%` : '—'}
                </p>
              </div>
              <div className="text-right">
                <div className="text-3xl font-bold tabular-nums" style={{ letterSpacing: '-1px' }}>
                  {fmtPrice(active.price, active.currency)}
                </div>
                <div className={`text-sm font-semibold ${active.change24h >= 0 ? C.green : C.red}`}>
                  {active.change24h >= 0 ? '+' : ''}{active.change24h.toFixed(2)}% 24h
                </div>
              </div>
            </div>

            <p className={`text-[13px] mt-3 ${C.amber}`}>{active.biasNote}</p>

            {/* gauge */}
            <div className="mt-4" aria-hidden="true">
              <div className="relative h-3 rounded-full bg-[#0b0e14] border border-[#232b3d] overflow-visible">
                {active.long && (
                  <div
                    className="absolute top-0 h-full rounded-full bg-[rgba(38,166,154,.55)]"
                    style={{ left: `${gaugePct(active.long.entryLow)}%`, width: `${Math.max(gaugePct(active.long.entryHigh) - gaugePct(active.long.entryLow), 1.5)}%` }}
                  />
                )}
                {active.short && (
                  <div
                    className="absolute top-0 h-full rounded-full bg-[rgba(239,83,80,.55)]"
                    style={{ left: `${gaugePct(active.short.entryLow)}%`, width: `${Math.max(gaugePct(active.short.entryHigh) - gaugePct(active.short.entryLow), 1.5)}%` }}
                  />
                )}
                <div
                  className="absolute -top-1.5 -bottom-1.5 w-[2px] bg-white"
                  style={{ left: `${gaugePct(active.price)}%` }}
                />
              </div>
              <div className="flex justify-between text-[10px] mt-1.5" style={{ color: '#5a6377' }}>
                <span>{fmtPrice(active.gauge.min, active.currency)}</span>
                <span className="text-[#e6e9f0] font-semibold">▲ {fmtPrice(active.price, active.currency)}</span>
                <span>{fmtPrice(active.gauge.max, active.currency)}</span>
              </div>
              <div className={`text-[11px] mt-1 ${C.muted}`}>
                <span className="text-[#26a69a]">■</span> long zone&nbsp;&nbsp;
                <span className="text-[#ef5350]">■</span> short zone&nbsp;&nbsp;— zones regenerate with market structure
              </div>
            </div>
          </div>

          {/* the trade plans — preferred side first */}
          <div className="flex flex-col gap-3">
            <h2 className={`text-[13px] font-bold ${C.text}`}>
              Trade plans — <span className={C.amber}>entry levels</span>, <span className={C.red}>stop loss</span> &amp; <span className={C.blue}>targets</span>
            </h2>
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              {([['long', active.long], ['short', active.short]] as Array<['long' | 'short', SideSetup | null]>)
                .filter((pair): pair is ['long' | 'short', SideSetup] => pair[1] !== null)
                .sort((a, b) => (a[1].tag === 'PREFERRED' ? -1 : 0) - (b[1].tag === 'PREFERRED' ? -1 : 0))
                .map(([kind, side]) => (
                  <TradePlanCard
                    key={kind}
                    side={side}
                    kind={kind}
                    preferred={side.tag === 'PREFERRED'}
                    pair={active.pair}
                    currency={active.currency}
                    livePrice={active.price}
                    confirmedAt={confirms[`${active.symbol}:${kind}`]?.at}
                  />
                ))}
            </div>
          </div>

          {/* sizing */}
          <div className={`rounded-[14px] border ${C.panel} p-5`}>
            <h3 className={`text-[13px] font-bold mb-3 ${C.text}`}>Position sizing — risk-first</h3>
            <div className="flex flex-wrap gap-3 mb-4">
              <label className={`text-[12px] ${C.muted}`}>
                <span className="block mb-1">Account ($)</span>
                <input
                  value={acct}
                  onChange={(e) => persist('tw_acct', e.target.value, setAcct)}
                  inputMode="decimal"
                  placeholder="10000"
                  suppressHydrationWarning
                  className={`w-36 px-3 py-2 rounded-lg text-[13px] ${C.panel2} border border-[#232b3d] ${C.text} placeholder:text-[#5a6377] focus:outline-none focus:border-[#f5b544]/50`}
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
                  className={`w-28 px-3 py-2 rounded-lg text-[13px] ${C.panel2} border border-[#232b3d] ${C.text} placeholder:text-[#5a6377] focus:outline-none focus:border-[#f5b544]/50`}
                />
              </label>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-[13px]">
              {([['long', active.long], ['short', active.short]] as Array<['long' | 'short', SideSetup | null]>).map(
                ([kind, side]) => {
                  const sz = sizingFor(side)
                  const label = kind === 'long' ? 'LONG side' : 'SHORT side'
                  return (
                    <div key={kind} className={`rounded-lg border ${C.panel2} p-3`}>
                      <div className={`text-[11px] font-bold mb-1 ${C.amber}`}>{label}</div>
                      {sz ? (
                        <>
                          <div className={`font-bold ${C.text}`}>{sz.unitsTxt}</div>
                          <div className={`text-[11px] ${C.muted}`}>{sz.notionalTxt}</div>
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
          <div className={`rounded-[14px] border ${C.panel} p-5`}>
            <h3 className={`text-[13px] font-bold mb-3 ${C.text}`}>Key levels — live structure</h3>
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
      <footer className={`mt-auto pt-2 pb-4 text-[11px] leading-relaxed ${C.muted} border-t border-[#232b3d]`}>
        Setups are <b className={C.text}>auto-generated from live market data</b> (Binance · Yahoo Finance) every 45 seconds — levels
        follow the market, so they never go stale.{' '}
        <a href="/app.html" target="_blank" rel="noreferrer" className="underline hover:text-[#e6e9f0]">
          Legacy static view ↗
        </a>
        <br />
        <b className={C.amber}>Disclaimer:</b> Technical analysis of public market data for decision support only. Not financial
        advice — no auto-trading. Crypto and stocks are volatile; never trade money you can&apos;t afford to lose.
      </footer>
    </div>
  )
}
