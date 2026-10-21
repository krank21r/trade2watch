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
  passed: boolean
  score: number | null
  rankGaps: string[]
  fails: string[]
  passes: string[]
  metrics: {
    symbol: string
    name: string
    price: number
    change24hPct: number
    quoteVolume24h: number
    momentum7d: number
    momentum30d: number
    volatility30d: number
    volumeRatio: number
    drawdownFrom30dHigh: number
  }
  /** Entry zone / stop / T1 / T2 preview (same math as the frozen plan) — null when data is thin. */
  plan: TicketPlanView | null
}

export interface ScreenResponse {
  ok: boolean
  error?: string
  result: { name: string; scanned: number; passed: number; asOf: string; rows: ScreenRowView[]; failedRows: ScreenRowView[] }
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

export const usd = (x: number | null | undefined): string =>
  x === null || x === undefined || !Number.isFinite(x)
    ? '—'
    : `$${x.toLocaleString('en-US', { maximumFractionDigits: 2 })}`

export const pctS = (x: number | null | undefined, digits = 2): string =>
  x === null || x === undefined || !Number.isFinite(x) ? '—' : `${x >= 0 ? '' : ''}${x.toFixed(digits)}%`
