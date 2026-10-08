/**
 * Market data for the SMC engine (§4/§5) — Bybit v5 public REST, keyless.
 *
 * READ-ONLY market data. No trading permissions, no keys, ever (§58).
 *
 *  - Klines:  GET /v5/market/kline?category=spot&symbol=BTCUSDT&interval=240&limit=500
 *  - Tickers: GET /v5/market/tickers?category=spot&symbol=BTCUSDT
 *
 * Bybit returns the FORMING candle as the newest row — it is dropped here so
 * every candle handed to the engine is CLOSED (no-look-ahead contract).
 *
 * If Bybit is unreachable, we fall back to Binance's official public mirror
 * (data-api.binance.vision — same klines the rest of the app uses). If both
 * fail the caller gets [] and the API reports DATA UNAVAILABLE (§62) — we
 * NEVER fabricate candles.
 *
 * Candles are cached in memory (this environment's cache layer — stands in
 * for the spec's Redis, §27) with short TTLs so the 45s poll stays polite.
 */

import type { Candle } from '@/lib/market/indicators'
import type { TF } from './types'
import { TF_MS } from './config'

const BYBIT = 'https://api.bybit.com'
const BINANCE_MIRROR = 'https://data-api.binance.vision'

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

// ─── Binance mirror fallback (closed candles only — mirror includes forming) ─

async function binanceKlines(symbol: string, tf: TF): Promise<Candle[]> {
  const url = `${BINANCE_MIRROR}/api/v3/klines?symbol=${symbol}&interval=${BINANCE_INTERVAL[tf]}&limit=${KLINE_LIMIT[tf]}`
  type Row = [number, string, string, string, string, string, ...unknown[]]
  const rows = await fetchJson<Row[]>(url)
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

async function binanceTicker(symbol: string): Promise<{ price: number; change24h: number }> {
  const j = await fetchJson<{ lastPrice: string; priceChangePercent: string }>(
    `${BINANCE_MIRROR}/api/v3/ticker/24hr?symbol=${symbol}`,
  )
  return { price: Number(j.lastPrice), change24h: Number(j.priceChangePercent) }
}

// ─── public API ──────────────────────────────────────────────────────────────

export interface SmcMarketData {
  source: 'BYBIT' | 'BINANCE_FALLBACK'
  candles: Record<TF, Candle[]>
  price: number
  change24h: number
}

/**
 * Load all strategy timeframes for one symbol. Bybit primary, Binance mirror
 * fallback per-timeframe — a single slow TF degrades to the mirror rather
 * than killing the whole analysis. If EVERY source fails for a TF, that TF is
 * an empty array and the orchestrator reports DATA UNAVAILABLE.
 */
export async function loadSmcMarketData(symbol: string, tfs: TF[]): Promise<SmcMarketData> {
  const [candleSets, ticker] = await Promise.all([
    Promise.all(
      tfs.map(async (tf) => {
        try {
          return await cached(`smc:${symbol}:${tf}:bybit`, ttlFor(tf), () => bybitKlines(symbol, tf))
        } catch {
          try {
            return await cached(`smc:${symbol}:${tf}:binance`, ttlFor(tf), () => binanceKlines(symbol, tf))
          } catch {
            return [] as Candle[]
          }
        }
      }),
    ),
    (async () => {
      try {
        return await cached(`smc:${symbol}:ticker:bybit`, 20_000, () => bybitTicker(symbol))
      } catch {
        try {
          return await cached(`smc:${symbol}:ticker:binance`, 20_000, () => binanceTicker(symbol))
        } catch {
          return { price: 0, change24h: 0 }
        }
      }
    })(),
  ])

  const candles = {} as Record<TF, Candle[]>
  let bybitCount = 0
  let binanceCount = 0
  tfs.forEach((tf, i) => {
    candles[tf] = candleSets[i]
    const k = `smc:${symbol}:${tf}:`
    if (cache.get(`${k}bybit`) && candleSets[i].length > 0) bybitCount++
    else if (cache.get(`${k}binance`) && candleSets[i].length > 0) binanceCount++
  })
  const source: SmcMarketData['source'] = binanceCount > bybitCount ? 'BINANCE_FALLBACK' : 'BYBIT'

  return { source, candles, price: ticker.price, change24h: ticker.change24h }
}
