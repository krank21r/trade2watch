/**
 * Liquidity Lab — market-data providers.
 *
 * Keyless public endpoints only, all with short-TTL in-memory caching and
 * graceful degradation (a venue that fails must not sink the analysis):
 *  - Binance spot order book  (data-api.binance.vision mirrors)
 *  - Bybit v5 linear perp order book
 *  - Binance spot klines WITH taker-buy volume (field 9) → CVD / structure
 *  - Binance futures open-interest history + taker buy/sell volume ratio
 *    (/futures/data/* — kept off /fapi/v1/* which rate-limits harder)
 *
 * Liquidation zones are MODEL ESTIMATES (open interest × leverage bands +
 * wick-cascade detection). CoinGlass's unofficial endpoints are unstable
 * (404s from this environment), so `source: 'coinglass'` is only emitted
 * if a CoinGlass read ever succeeds; estimates are always labeled honestly.
 */

import type { LiquidationZone } from './types'

// ─── fetch plumbing ──────────────────────────────────────────────────────────

const BINANCE_HOSTS = ['https://data-api.binance.vision', 'https://api-gcp.binance.com', 'https://api.binance.com']
let hostIdx = 0

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'

const cache = new Map<string, { at: number; ttl: number; data: unknown }>()

async function cached<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < hit.ttl) return hit.data as T
  const data = await fn()
  cache.set(key, { at: Date.now(), ttl: ttlMs, data })
  return data
}

async function binanceGet<T>(path: string, timeoutMs = 9000): Promise<T> {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    let lastErr: unknown = null
    for (let attempt = 0; attempt < BINANCE_HOSTS.length; attempt++) {
      const host = BINANCE_HOSTS[(hostIdx + attempt) % BINANCE_HOSTS.length]
      try {
        const res = await fetch(host + path, {
          signal: ctrl.signal,
          headers: { 'User-Agent': UA, Accept: 'application/json' },
          cache: 'no-store',
        })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const data = (await res.json()) as T
        hostIdx = (hostIdx + attempt) % BINANCE_HOSTS.length // stick to the working host
        return data
      } catch (e) {
        lastErr = e
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error('all Binance hosts failed')
  } finally {
    clearTimeout(t)
  }
}

async function bybitGet<T>(path: string, timeoutMs = 9000): Promise<T> {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch('https://api.bybit.com' + path, {
      signal: ctrl.signal,
      headers: { 'User-Agent': UA, Accept: 'application/json' },
      cache: 'no-store',
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return (await res.json()) as T
  } finally {
    clearTimeout(t)
  }
}

/** Futures data lives ONLY on fapi.binance.com — the spot mirrors do not serve it. */
async function futuresGet<T>(path: string, timeoutMs = 9000): Promise<T> {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch('https://fapi.binance.com' + path, {
      signal: ctrl.signal,
      headers: { 'User-Agent': UA, Accept: 'application/json' },
      cache: 'no-store',
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return (await res.json()) as T
  } finally {
    clearTimeout(t)
  }
}

// ─── order books ─────────────────────────────────────────────────────────────

export interface BookLevel {
  price: number
  qty: number
  venue: 'binance' | 'bybit'
}

interface RawDepth {
  bids: BookLevel[]
  asks: BookLevel[]
}

export async function fetchBinanceDepth(pair: string): Promise<RawDepth> {
  return cached(`liq:bin:depth:${pair}`, 10_000, async () => {
    const d = await binanceGet<{ bids: [string, string][]; asks: [string, string][] }>(
      `/api/v3/depth?symbol=${pair}&limit=500`,
    )
    return {
      bids: d.bids.map(([p, q]) => ({ price: parseFloat(p), qty: parseFloat(q), venue: 'binance' as const })),
      asks: d.asks.map(([p, q]) => ({ price: parseFloat(p), qty: parseFloat(q), venue: 'binance' as const })),
    }
  })
}

export async function fetchBybitDepth(pair: string): Promise<RawDepth | null> {
  try {
    return await cached(`liq:byb:depth:${pair}`, 10_000, async () => {
      const d = await bybitGet<{ retCode: number; result: { b: [string, string][]; a: [string, string][] } }>(
        `/v5/market/orderbook?category=linear&symbol=${pair}&limit=200`,
      )
      if (d.retCode !== 0) throw new Error(`bybit retCode ${d.retCode}`)
      return {
        bids: d.result.b.map(([p, q]) => ({ price: parseFloat(p), qty: parseFloat(q), venue: 'bybit' as const })),
        asks: d.result.a.map(([p, q]) => ({ price: parseFloat(p), qty: parseFloat(q), venue: 'bybit' as const })),
      }
    })
  } catch {
    return null // a venue failing must not sink the analysis
  }
}

// ─── klines with taker-buy volume (CVD fuel) ─────────────────────────────────

export interface TakerCandle {
  time: number
  open: number
  high: number
  low: number
  close: number
  volume: number
  /** field 9 — base volume bought by takers (aggressive buyers). */
  takerBuy: number
}

export async function fetchSpotKlines(pair: string, interval: string, limit: number): Promise<TakerCandle[]> {
  return cached(`liq:bin:k:${pair}:${interval}:${limit}`, 60_000, async () => {
    const raw = await binanceGet<Array<[number, string, string, string, string, string, ...unknown[]]>>(
      `/api/v3/klines?symbol=${pair}&interval=${interval}&limit=${limit}`,
    )
    return raw.map((k) => ({
      time: k[0],
      open: parseFloat(k[1]),
      high: parseFloat(k[2]),
      low: parseFloat(k[3]),
      close: parseFloat(k[4]),
      volume: parseFloat(k[5]),
      takerBuy: parseFloat(String(k[9] ?? '0')),
    }))
  })
}

// ─── futures flow: open interest + taker ratio ───────────────────────────────

export interface FuturesFlow {
  /** latest open interest in coin units (null when endpoint unavailable). */
  oiCoins: number | null
  /** 24h change of open interest, % (null when unavailable). */
  oiChange24hPct: number | null
  /** avg taker buy/sell volume ratio over the last 3 hourly prints (null when unavailable). */
  takerRatio: number | null
}

export async function fetchFuturesFlow(pair: string): Promise<FuturesFlow> {
  return cached(`liq:bin:flow:${pair}`, 60_000, async () => {
    const out: FuturesFlow = { oiCoins: null, oiChange24hPct: null, takerRatio: null }
    const results = await Promise.allSettled([
      futuresGet<Array<{ sumOpenInterest: string }>>(
        `/futures/data/openInterestHist?symbol=${pair}&period=1h&limit=24`,
      ),
      futuresGet<Array<{ buySellRatio: string }>>(
        `/futures/data/takerlongshortRatio?symbol=${pair}&period=1h&limit=6`,
      ),
    ])
    if (results[0].status === 'fulfilled' && results[0].value.length >= 2) {
      const hist = results[0].value
      const first = parseFloat(hist[0].sumOpenInterest)
      const last = parseFloat(hist[hist.length - 1].sumOpenInterest)
      if (first > 0) {
        out.oiCoins = last
        out.oiChange24hPct = ((last - first) / first) * 100
      }
    }
    if (results[1].status === 'fulfilled' && results[1].value.length > 0) {
      const last3 = results[1].value.slice(-3).map((x) => parseFloat(x.buySellRatio)).filter((x) => x > 0)
      if (last3.length > 0) out.takerRatio = last3.reduce((a, b) => a + b, 0) / last3.length
    }
    return out
  })
}

// ─── liquidation map (model estimate) ────────────────────────────────────────

/**
 * Estimated liquidation leverage zones.
 *
 * Structure: open interest distributed across typical leverage bands — a band
 * with leverage L liquidates roughly at L^-1 × 0.85 from entry (maintenance
 * margin ~15%), i.e. 100x ≈ −0.9%, 50x ≈ −1.7%, 25x ≈ −3.4%, 10x ≈ −8.5%.
 * Events: recent candles whose wick dove/dived beyond 0.7×ATR and recovered
 * mark actual liquidation-cascade locations — those get their own zones.
 */
export function estimateLiquidationZones(
  spot: number,
  oiCoins: number | null,
  candles: TakerCandle[],
  atr: number,
): LiquidationZone[] {
  const zones: LiquidationZone[] = []
  const oiNotional = oiCoins && oiCoins > 0 ? oiCoins * spot : spot * 50 // sane fallback basis

  const bands: Array<{ lev: number; share: number }> = [
    { lev: 100, share: 0.25 },
    { lev: 50, share: 0.3 },
    { lev: 25, share: 0.25 },
    { lev: 10, share: 0.2 },
  ]
  for (const b of bands) {
    const dist = (1 / b.lev) * 0.85
    const halfWidth = Math.max(dist * 0.35, 0.0015)
    const longPx = spot * (1 - dist)
    const shortPx = spot * (1 + dist)
    zones.push({
      side: 'long',
      priceFrom: longPx * (1 - halfWidth),
      priceTo: longPx * (1 + halfWidth),
      estNotional: oiNotional * b.share,
      source: 'estimated',
      label: `~${b.lev}x long liquidations`,
    })
    zones.push({
      side: 'short',
      priceFrom: shortPx * (1 - halfWidth),
      priceTo: shortPx * (1 + halfWidth),
      estNotional: oiNotional * b.share,
      source: 'estimated',
      label: `~${b.lev}x short liquidations`,
    })
  }

  // event zones: wick cascades in the last 24 bars
  const lookback = candles.slice(-24)
  for (const c of lookback) {
    if (atr <= 0) break
    const lowerWick = Math.min(c.open, c.close) - c.low
    const upperWick = c.high - Math.max(c.open, c.close)
    const closePos = c.high === c.low ? 0.5 : (c.close - c.low) / (c.high - c.low)
    if (lowerWick > 0.7 * atr && closePos > 0.55) {
      zones.push({
        side: 'long',
        priceFrom: c.low * 0.9975,
        priceTo: c.low * 1.0025,
        estNotional: oiNotional * 0.08,
        source: 'estimated',
        label: 'long liquidation cascade (wick reclaim)',
      })
    }
    if (upperWick > 0.7 * atr && closePos < 0.45) {
      zones.push({
        side: 'short',
        priceFrom: c.high * 0.9975,
        priceTo: c.high * 1.0025,
        estNotional: oiNotional * 0.08,
        source: 'estimated',
        label: 'short liquidation cascade (wick rejection)',
      })
    }
  }
  return zones
}
