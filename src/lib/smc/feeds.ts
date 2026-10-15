/**
 * Dual-exchange market data for the SMC engine — Bybit v5 + Binance spot,
 * both public REST, keyless, fetched CONCURRENTLY on every evaluation.
 *
 * READ-ONLY market data. No trading permissions, no keys, ever (§58).
 *
 * Why two tapes? An SMC order block is a price-level concept — if a zone is
 * real it must appear on every major venue's tape. The engine therefore runs
 * once per exchange and the orchestrator reconciles:
 *   - OB zones confirmed on BOTH feeds  → signal, +5 confluence score
 *   - zone on one tape only             → WATCHLIST (never a live signal)
 *   - feeds disagree on direction       → NO_TRADE
 *
 *  - Bybit:   GET /v5/market/kline?category=spot&symbol=BTCUSDT&interval=240&limit=500
 *  - Binance: GET /api/v3/klines?symbol=BTCUSDT&interval=4h&limit=500 (official
 *             api.binance.com; data-api.binance.vision mirror when blocked)
 *
 * Both venues return the FORMING candle as the newest row — it is dropped here
 * so every candle handed to the engine is CLOSED (no-look-ahead contract).
 *
 * If one venue is unreachable the other carries the analysis alone
 * (SINGLE_SOURCE consensus). If BOTH fail the caller gets two null feeds and
 * the API reports DATA UNAVAILABLE (§62) — we NEVER fabricate candles.
 *
 * Candles are cached in memory per (symbol, tf, exchange) with short TTLs so
 * the 45s poll stays polite.
 */

import type { Candle } from '@/lib/market/indicators'
import type { TF } from './types'
import { TF_MS } from './config'

const BYBIT = 'https://api.bybit.com'
const BINANCE_HOSTS = ['https://api.binance.com', 'https://data-api.binance.vision']

const BYBIT_INTERVAL: Record<TF, string> = {
  '1D': 'D',
  '4H': '240',
  '1H': '60',
  '15M': '15',
  '5M': '5',
}
const BINANCE_INTERVAL: Record<TF, string> = {
  '1D': '1d',
  '4H': '4h',
  '1H': '1h',
  '15M': '15m',
  '5M': '5m',
}

const KLINE_LIMIT: Record<TF, number> = {
  '1D': 400,
  '4H': 500,
  '1H': 500,
  '15M': 500,
  '5M': 500,
}

// ─── tiny cache (Redis stand-in) ─────────────────────────────────────────────

const cache = new Map<string, { at: number; ttl: number; data: unknown }>()

async function cached<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < hit.ttl) return hit.data as T
  const data = await fn()
  cache.set(key, { at: Date.now(), ttl: ttlMs, data })
  return data
}

function ttlFor(tf: TF): number {
  return tf === '4H' || tf === '1D' ? 120_000 : 45_000
}

async function fetchJson<T>(url: string, timeoutMs = 12_000): Promise<T> {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' },
      cache: 'no-store',
    })
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`)
    return (await res.json()) as T
  } finally {
    clearTimeout(t)
  }
}

// ─── Bybit raw ───────────────────────────────────────────────────────────────

interface BybitKlineResp {
  retCode: number
  retMsg: string
  result?: { list?: string[][] } // [startOpen, open, high, low, close, volume, turnover], DESC
}

interface BybitTickerResp {
  retCode: number
  retMsg: string
  result?: {
    list?: Array<{ lastPrice?: string; price24hPcnt?: string; markPrice?: string }>
  }
}

/** Closed candles only — the forming (newest) Bybit row is dropped. */
async function bybitKlines(symbol: string, tf: TF): Promise<Candle[]> {
  const url = `${BYBIT}/v5/market/kline?category=spot&symbol=${symbol}&interval=${BYBIT_INTERVAL[tf]}&limit=${KLINE_LIMIT[tf]}`
  const j = await fetchJson<BybitKlineResp>(url)
  if (j.retCode !== 0 || !j.result?.list) throw new Error(`bybit ${j.retMsg}`)
  const rows = [...j.result.list].reverse() // → ASC by open time
  const out: Candle[] = []
  for (const r of rows) {
    const time = Number(r[0])
    const candle: Candle = {
      time,
      open: Number(r[1]),
      high: Number(r[2]),
      low: Number(r[3]),
      close: Number(r[4]),
      volume: Number(r[5]),
    }
    // drop the still-forming candle: its close time is in the future
    if (time + TF_MS[tf] > Date.now()) continue
    if (!Number.isFinite(candle.high) || !Number.isFinite(candle.low) || candle.high < candle.low) continue
    out.push(candle)
  }
  return out
}

async function bybitTicker(symbol: string): Promise<{ price: number; change24h: number }> {
  const j = await fetchJson<BybitTickerResp>(`${BYBIT}/v5/market/tickers?category=spot&symbol=${symbol}`)
  if (j.retCode !== 0 || !j.result?.list?.[0]) throw new Error(`bybit ticker ${j.retMsg}`)
  const t = j.result.list[0]
  return {
    price: Number(t.lastPrice ?? t.markPrice ?? 0),
    change24h: Number(t.price24hPcnt ?? 0) * 100, // fraction → %
  }
}

// ─── Binance raw (primary api.binance.com → data-api.binance.vision mirror) ──

type BinanceRow = [number, string, string, string, string, string, ...unknown[]]

async function binanceKlinesFrom(host: string, symbol: string, tf: TF): Promise<Candle[]> {
  const url = `${host}/api/v3/klines?symbol=${symbol}&interval=${BINANCE_INTERVAL[tf]}&limit=${KLINE_LIMIT[tf]}`
  const rows = await fetchJson<BinanceRow[]>(url)
  const out: Candle[] = []
  for (const r of rows) {
    const time = Number(r[0])
    if (time + TF_MS[tf] > Date.now()) continue // drop forming candle
    out.push({
      time,
      open: Number(r[1]),
      high: Number(r[2]),
      low: Number(r[3]),
      close: Number(r[4]),
      volume: Number(r[5]),
    })
  }
  return out
}

/** api.binance.com first, official public mirror on failure/block. */
async function binanceKlines(symbol: string, tf: TF): Promise<Candle[]> {
  let lastErr: unknown
  for (const host of BINANCE_HOSTS) {
    try {
      return await binanceKlinesFrom(host, symbol, tf)
    } catch (err) {
      lastErr = err
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('binance klines failed')
}

async function binanceTicker(symbol: string): Promise<{ price: number; change24h: number }> {
  let lastErr: unknown
  for (const host of BINANCE_HOSTS) {
    try {
      const j = await fetchJson<{ lastPrice: string; priceChangePercent: string }>(
        `${host}/api/v3/ticker/24hr?symbol=${symbol}`,
      )
      return { price: Number(j.lastPrice), change24h: Number(j.priceChangePercent) }
    } catch (err) {
      lastErr = err
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('binance ticker failed')
}

// ─── public API ──────────────────────────────────────────────────────────────

export interface FeedData {
  exchange: 'BYBIT' | 'BINANCE'
  candles: Record<TF, Candle[]>
  price: number
  change24h: number
}

export interface DualSmcMarketData {
  bybit: FeedData | null // null = feed unusable (no candles / all TFs failed)
  binance: FeedData | null
}

async function loadFeed(
  exchange: 'BYBIT' | 'BINANCE',
  symbol: string,
  tfs: TF[],
): Promise<FeedData | null> {
  const tag = exchange.toLowerCase()
  const candleSets = await Promise.all(
    tfs.map(async (tf) => {
      try {
        return await cached(`smc:${symbol}:${tf}:${tag}`, ttlFor(tf), () =>
          exchange === 'BYBIT' ? bybitKlines(symbol, tf) : binanceKlines(symbol, tf),
        )
      } catch {
        return [] as Candle[]
      }
    }),
  )
  const ticker = await (async () => {
    try {
      return await cached(`smc:${symbol}:ticker:${tag}`, 20_000, () =>
        exchange === 'BYBIT' ? bybitTicker(symbol) : binanceTicker(symbol),
      )
    } catch {
      return { price: 0, change24h: 0 }
    }
  })()

  const candles = {} as Record<TF, Candle[]>
  let usable = 0
  tfs.forEach((tf, i) => {
    candles[tf] = candleSets[i]
    if (candleSets[i].length >= 50) usable++
  })
  // a feed is only healthy when EVERY strategy TF returned usable closed candles
  if (usable < tfs.length) return null
  return { exchange, candles, price: ticker.price, change24h: ticker.change24h }
}

/**
 * Load all strategy timeframes for one symbol from BOTH exchanges in
 * parallel. Each feed stands alone: a venue that fails (or returns thin
 * candles) yields null and the analysis continues on the surviving tape.
 */
export async function loadDualSmcMarketData(symbol: string, tfs: TF[]): Promise<DualSmcMarketData> {
  const [bybit, binance] = await Promise.all([loadFeed('BYBIT', symbol, tfs), loadFeed('BINANCE', symbol, tfs)])
  return { bybit, binance }
}
