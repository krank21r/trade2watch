'use client'

/** Shared types + helpers for the Trader Desk UI (signals → take → track). */

export interface TicketPlanView {
  entryLow: number
  entryHigh: number
  stop: number
  target1: number
  target2: number
  riskReward: string
  atr: number | null
  regime: string
  timeframe: string
}

export interface ScreenRowView {
  symbol: string
  name: string
  market: 'crypto' | 'stock'
  passed: boolean
  score: number | null
  rankGaps: string[]
  fails: string[]
  passes: string[]
  /** True for pinned majors (BTC, ETH, SOL, XRP) — always shown regardless of rank. */
  pinned?: boolean
  metrics: {
    symbol: string
    name: string
    market: 'crypto' | 'stock'
    price: number
    change24hPct: number
    momentum24h: number
    quoteVolume24h: number
    momentum7d: number
    momentum30d: number
    absMomentum7d: number
    absMomentum30d: number
    volatility30d: number
    volumeRatio: number
    drawdownFrom30dHigh: number
  }
  /**
   * The ONE desk signal for this asset — the analysis (regime, EMAs, slope,
   * MACD, RSI, momentum) picks LONG or SHORT, never both. plan is its entry
   * zone / stop / T1 / T2; null when the data is thin (row renders "—").
   */
  side: 'LONG' | 'SHORT' | null
  /** Evidence behind the direction pick ("uptrend regime · price above EMA50 …"). */
  sideReason: string | null
  plan: TicketPlanView | null
}

export interface ScreenResponse {
  ok: boolean
  error?: string
  result: { name: string; market: string; scanned: number; passed: number; asOf: string; rows: ScreenRowView[]; failedRows: ScreenRowView[] }
  note?: string
}

/** fetch + throw-on-error helper: every trader API answers {ok, error?}. */
export async function jfetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { cache: 'no-store', ...init })
  let body: unknown = null
  try {
    body = await res.json()
  } catch {
    /* non-JSON error page */
  }
  const data = body as { ok?: boolean; error?: string }
  if (!res.ok || (data && data.ok === false)) {
    throw new Error(data?.error || `request failed (${res.status})`)
  }
  return body as T
}

/** $ formatter that keeps every price band readable ($84k BTC → $1.387 XRP → PEPE). */
export const usd = (x: number | null | undefined): string => {
  if (x === null || x === undefined || !Number.isFinite(x)) return '—'
  const digits = x >= 10 ? 2 : x >= 1 ? 3 : x >= 0.01 ? 4 : 8
  return `$${x.toLocaleString('en-US', { maximumFractionDigits: digits })}`
}

export const pctS = (x: number | null | undefined, digits = 2): string =>
  x === null || x === undefined || !Number.isFinite(x) ? '—' : `${x >= 0 ? '' : ''}${x.toFixed(digits)}%`
