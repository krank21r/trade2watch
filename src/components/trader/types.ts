'use client'

/** Shared types + helpers for the Trader Desk UI. */

export interface WeightRow {
  ticker: string
  name: string
  weight: number
}

export interface DeskTicket {
  id: string
  batchId: string
  symbol: string
  side: 'buy' | 'sell'
  notional: number
  refPrice: number | null
  why: string | null
  verdict: 'PASS' | 'BLOCK'
  reasons: string[]
  status: 'proposed' | 'approved' | 'rejected' | 'expired'
  fillPrice: number | null
  filledQty: number | null
  createdAt: string
}

export interface SizedPosition {
  ticker: string
  name: string
  weight: number
  dollars: number
  capped: boolean
  price?: number
  shares?: number
}

export interface SizeResultView {
  budget: number
  cashBufferPct: number
  cashBuffer: number
  investable: number
  maxPositionPct: number
  cap: number
  minOrderUsd: number
  positions: SizedPosition[]
  invested: number
  idle: number
  dropped: Array<{ ticker: string; reason: string }>
}

export interface PlanResponse {
  ok: boolean
  error?: string
  batchId: string
  source: string
  sizing: SizeResultView
  tickets: DeskTicket[]
  notes: string[]
}

export interface PortfolioRowView {
  symbol: string
  qty: number
  avgPrice: number
  price: number
  value: number
  pnlPct: number
  currentPct: number
  targetPct: number
  drift: number
  tracked: boolean
}

export interface AlertView {
  id: string
  symbol: string
  market: 'crypto' | 'stock'
  kind: 'above' | 'below' | 'stop'
  price: number
  note: string | null
  triggered: boolean
  triggeredAt: string | null
  createdAt: string
  lastPrice?: number | null
}

export interface AccountResponse {
  ok: boolean
  error?: string
  account: { budget: number; cash: number; exists: boolean }
  total: number
  invested: number
  rows: PortfolioRowView[]
  targets: Array<{ symbol: string; name: string; weight: number }> | null
  targetSource: string | null
  alerts: AlertView[]
  alertsRang: AlertView[]
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
}

export interface ScreenResponse {
  ok: boolean
  error?: string
  result: { name: string; scanned: number; passed: number; asOf: string; rows: ScreenRowView[]; failedRows: ScreenRowView[] }
  weights: WeightRow[]
}

export interface RebalanceResponse {
  ok: boolean
  error?: string
  band: number
  total: number
  rows: Array<{
    symbol: string
    qty: number
    price: number
    value: number
    currentPct: number
    targetPct: number
    drift: number
    action: string
  }>
  tickets: DeskTicket[]
  notes: string[]
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

export const signed = (x: number | null | undefined, digits = 2): string =>
  x === null || x === undefined || !Number.isFinite(x) ? '—' : `${x >= 0 ? '+' : ''}${x.toFixed(digits)}`

export const qtyS = (x: number): string => {
  const s = x.toFixed(4).replace(/0+$/, '').replace(/\.$/, '')
  return s || '0'
}
