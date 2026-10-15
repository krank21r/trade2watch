import type { Candle } from '@/lib/market/indicators'
import { scopedGetJson, scopedSetJson } from '@/lib/user-scope'

// ─── "I took this trade" — personal trade tracker ────────────────────────────
// When the user takes a confirmed setup, the plan is FROZEN here: entry fill
// (zone mid), stop, TP1, TP2 never change even though the app keeps regenerating
// zones from live structure. From that moment the tracker checks real candles
// against the frozen plan:
//   TP1 hit  → half banked, stop moves to entry (the plan's own rule)
//   TP2 hit  → trade closed, full win
//   SL hit before TP1 → stopped out (-1R)
//   SL (at entry) hit after TP1 → breakeven close (half at TP1)
// Same-candle ambiguity is resolved pessimistically: stop before targets.

export type TradeStatus = 'OPEN' | 'CLOSED'
export type TradeOutcome = 'TP2' | 'TP1_BE' | 'SL' | 'MANUAL'

export interface MyTrade {
  id: string // `${key}:${takenAt}`
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
  entryFill: number // assumed fill = entry-zone mid
  stop: number
  t1: number
  t2: number
  runner: number | null
  rr: string
  confirmedAt: number // when the setup confirmed (zone hit / wick)
  confirmedPrice: number
  via: 'spot' | 'wick'
  takenAt: number // when the user pressed "I took this trade"
  status: TradeStatus
  tp1HitAt: number | null
  tp2HitAt: number | null
  slHitAt: number | null
  outcome: TradeOutcome | null
  closedAt: number | null
  closePrice: number | null
}

const TRADES_KEY = 'my_trades'
const MAX_TRADES = 40

export const zoneMid = (low: number, high: number): number => (low + high) / 2

function trim(list: MyTrade[]): MyTrade[] {
  const open = list.filter((t) => t.status === 'OPEN')
  const closed = list.filter((t) => t.status === 'CLOSED').slice(0, MAX_TRADES - open.length)
  return [...open, ...closed]
}

/** Instant local cache (per user + per browser) — painted before the server sync. */
export function loadMyTrades(): MyTrade[] {
  const raw = scopedGetJson<MyTrade[]>(TRADES_KEY, [])
  return Array.isArray(raw) ? raw.filter((t) => t && typeof t.id === 'string') : []
}

function cacheMyTrades(list: MyTrade[]) {
  scopedSetJson(TRADES_KEY, trim(list))
}

async function putMyTrades(list: MyTrade[]): Promise<void> {
  const res = await fetch('/api/trades', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ trades: trim(list) }),
  })
  if (!res.ok) throw new Error(`trades sync ${res.status}`)
}

/**
 * Server truth for the journal — identical across every device signed in to
 * the same account. Falls back to the local cache when the API is unreachable.
 * One-time migration: an account that never saved to the server adopts this
 * browser's pre-sync journal (first device to go live wins the upload).
 */
export async function fetchMyTrades(): Promise<MyTrade[]> {
  try {
    const res = await fetch('/api/trades', { cache: 'no-store' })
    if (res.ok) {
      const body = (await res.json()) as { ok: boolean; exists: boolean; trades?: MyTrade[] }
      if (body.ok && body.exists) {
        const list = Array.isArray(body.trades) ? body.trades.filter((t) => t && typeof t.id === 'string') : []
        cacheMyTrades(list)
        return list
      }
      if (body.ok && !body.exists) {
        const local = loadMyTrades()
        if (local.length > 0) {
          await putMyTrades(local)
          return local
        }
        return []
      }
    }
  } catch {
    /* offline or API down — keep serving the local cache */
  }
  return loadMyTrades()
}

/** Persist the journal: local cache for instant paint + server sync (fire-and-forget). */
export function saveMyTrades(list: MyTrade[]) {
  const trimmed = trim(list)
  cacheMyTrades(trimmed)
  void putMyTrades(trimmed).catch(() => {
    /* offline — the next save re-syncs */
  })
}

export function riskOf(t: MyTrade): number {
  return Math.abs(t.entryFill - t.stop) || 1e-9
}

/** Signed R multiple of `price` vs the frozen fill (+1R = one unit of risk in favour). */
export function rNow(t: MyTrade, price: number): number {
  const risk = riskOf(t)
  const raw = t.side === 'long' ? (price - t.entryFill) / risk : (t.entryFill - price) / risk
  return Math.round(raw * 100) / 100
}

/** Net R for a closed trade under the plan's half-at-TP1 rule. */
export function netR(t: MyTrade): number {
  const risk = riskOf(t)
  const rAt = (p: number) => (t.side === 'long' ? (p - t.entryFill) / risk : (t.entryFill - p) / risk)
  let out: number
  if (t.outcome === 'SL') out = -1
  else if (t.outcome === 'TP1_BE') out = 0.5 * rAt(t.t1) // half banked at TP1, rest ≈ entry
  else if (t.outcome === 'TP2') out = 0.5 * rAt(t.t1) + 0.5 * rAt(t.t2)
  else if (t.outcome === 'MANUAL')
    out =
      (t.tp1HitAt !== null ? 0.5 * rAt(t.t1) : 0) +
      (t.tp1HitAt !== null ? 0.5 : 1) * rAt(t.closePrice ?? t.entryFill)
  else out = rNow(t, t.closePrice ?? t.entryFill)
  return Math.round(out * 100) / 100
}

export function netRTxt(t: MyTrade): string {
  const r = netR(t)
  return `${r > 0 ? '+' : ''}${r.toFixed(2)}R`
}

const TF_MS = { crypto: 14_400_000, stock: 86_400_000 } // candle length: 4h / 1d

/**
 * Advance a trade's TP/SL state using real candles. Pure — returns a new
 * object (same reference if nothing changed). Tracking window = candles that
 * were still forming or opened after `takenAt`.
 */
export function trackTrade(t: MyTrade, candles: Candle[]): MyTrade {
  if (t.status === 'CLOSED' || candles.length === 0) return t
  const tfMs = TF_MS[t.market] ?? TF_MS.crypto
  const window = candles.filter((c) => c.time + tfMs > t.takenAt)
  if (window.length === 0) return t

  const isLong = t.side === 'long'
  let tp1HitAt = t.tp1HitAt
  let tp2HitAt = t.tp2HitAt
  let slHitAt = t.slHitAt

  for (const c of window) {
    // after TP1 the plan moves the stop to entry (breakeven)
    const stopLevel = tp1HitAt !== null ? t.entryFill : t.stop
    const stopHit = isLong ? c.low <= stopLevel : c.high >= stopLevel
    const tp1Hit = tp1HitAt === null && (isLong ? c.high >= t.t1 : c.low <= t.t1)
    const tp2Hit = isLong ? c.high >= t.t2 : c.low <= t.t2

    if (stopHit) {
      // pessimistic: within one candle assume the stop traded before targets
      slHitAt = slHitAt ?? c.time
      break
    }
    if (tp1Hit) tp1HitAt = c.time
    if (tp2Hit) {
      tp2HitAt = c.time
      break
    }
  }

  let status: TradeStatus = 'OPEN'
  let outcome: TradeOutcome | null = null
  let closedAt: number | null = null
  let closePrice: number | null = null
  if (tp2HitAt !== null) {
    status = 'CLOSED'
    outcome = 'TP2'
    closedAt = tp2HitAt
    closePrice = t.t2
  } else if (slHitAt !== null) {
    status = 'CLOSED'
    if (tp1HitAt !== null) {
      outcome = 'TP1_BE'
      closePrice = t.entryFill
    } else {
      outcome = 'SL'
      closePrice = t.stop
    }
    closedAt = slHitAt
  }

  if (
    tp1HitAt === t.tp1HitAt &&
    tp2HitAt === t.tp2HitAt &&
    slHitAt === t.slHitAt &&
    status === t.status &&
    outcome === t.outcome
  ) {
    return t
  }
  return { ...t, tp1HitAt, tp2HitAt, slHitAt, status, outcome, closedAt, closePrice }
}

/** Outcome badge text for a closed trade. */
export function outcomeTxt(t: MyTrade): string {
  switch (t.outcome) {
    case 'TP2':
      return '🏆 TP2 hit — full win'
    case 'TP1_BE':
      return '⚖️ TP1 banked · stopped at entry'
    case 'SL':
      return '🛑 Stopped out'
    case 'MANUAL':
      return '✋ Closed manually'
    default:
      return 'Closed'
  }
}
