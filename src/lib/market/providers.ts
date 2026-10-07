/**
 * Market data providers — keyless, verified working from this environment:
 *  - Crypto: Binance public REST (klines + 24h ticker)
 *  - Stocks: Yahoo Finance v8 chart + v1 search (quotes, OHLCV, metadata)
 *  - News:   Google News RSS (works for any query)
 * All responses cached in memory with short TTLs to stay polite with vendors.
 */

import type { Candle } from './indicators'

// ─── in-memory cache ─────────────────────────────────────────────────────────

const cache = new Map<string, { at: number; ttl: number; data: unknown }>()

async function cached<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < hit.ttl) return hit.data as T
  const data = await fn()
  cache.set(key, { at: Date.now(), ttl: ttlMs, data })
  return data
}

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'

async function fetchJson<T>(url: string, timeoutMs = 12000, headers?: Record<string, string>): Promise<T> {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': UA, Accept: 'application/json', ...headers },
      cache: 'no-store',
    })
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`)
    return (await res.json()) as T
  } finally {
    clearTimeout(t)
  }
}

async function fetchText(url: string, timeoutMs = 12000): Promise<string> {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': UA }, cache: 'no-store' })
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`)
    return await res.text()
  } finally {
    clearTimeout(t)
  }
}

// ─── crypto: Binance ─────────────────────────────────────────────────────────

export interface Ticker {
  symbol: string // normalized, e.g. "BTC"
  market: 'crypto' | 'stock'
  displayName: string
  price: number
  change24h: number // percent
  currency: string
}

type BinanceKline = [number, string, string, string, string, string, ...unknown[]]

export async function fetchCryptoCandles(symbol: string, interval = '4h', limit = 200): Promise<Candle[]> {
  const pair = `${symbol.toUpperCase()}USDT`
  const raw = await cached(`bin:k:${pair}:${interval}:${limit}`, 60_000, async () =>
    fetchJson<BinanceKline[]>(
      `https://api.binance.com/api/v3/klines?symbol=${pair}&interval=${interval}&limit=${limit}`,
    ),
  )
  return raw.map((k) => ({
    time: k[0],
    open: parseFloat(k[1]),
    high: parseFloat(k[2]),
    low: parseFloat(k[3]),
    close: parseFloat(k[4]),
    volume: parseFloat(k[5]),
  }))
}

export async function fetchCryptoTicker(symbol: string): Promise<Ticker> {
  const pair = `${symbol.toUpperCase()}USDT`
  const d = await cached(`bin:t:${pair}`, 15_000, async () =>
    fetchJson<{ lastPrice: string; priceChangePercent: string }>(
      `https://api.binance.com/api/v3/ticker/24hr?symbol=${pair}`,
    ),
  )
  return {
    symbol: symbol.toUpperCase(),
    market: 'crypto',
    displayName: symbol.toUpperCase(),
    price: parseFloat(d.lastPrice),
    change24h: parseFloat(d.priceChangePercent),
    currency: 'USD',
  }
}

// ─── stocks: Yahoo Finance ───────────────────────────────────────────────────

interface YahooChart {
  chart: {
    result: Array<{
      meta: {
        symbol: string
        currency: string
        regularMarketPrice: number
        chartPreviousClose: number
        shortName?: string
        longName?: string
        instrumentType?: string
      }
      timestamp: number[]
      indicators: {
        quote: Array<{
          open: (number | null)[]
          high: (number | null)[]
          low: (number | null)[]
          close: (number | null)[]
          volume: (number | null)[]
        }>
      }
    }>
    error: { description: string } | null
  }
}

export async function fetchStockCandles(ticker: string, interval = '1d', range = '1y'): Promise<Candle[]> {
  const t = encodeURIComponent(ticker.toUpperCase())
  const data = await cached(`yh:c:${t}:${interval}:${range}`, 60_000, async () =>
    fetchJson<YahooChart>(`https://query1.finance.yahoo.com/v8/finance/chart/${t}?interval=${interval}&range=${range}`),
  )
  const r = data.chart.result?.[0]
  if (!r) throw new Error(`Yahoo returned no data for ${ticker}`)
  const q = r.indicators.quote[0]
  const candles: Candle[] = []
  for (let i = 0; i < r.timestamp.length; i++) {
    const o = q.open[i]
    const h = q.high[i]
    const l = q.low[i]
    const c = q.close[i]
    if (o == null || h == null || l == null || c == null) continue
    candles.push({ time: r.timestamp[i] * 1000, open: o, high: h, low: l, close: c, volume: q.volume[i] ?? 0 })
  }
  return candles
}

export async function fetchStockTicker(ticker: string): Promise<Ticker> {
  const t = encodeURIComponent(ticker.toUpperCase())
  const data = await cached(`yh:q:${t}`, 15_000, async () =>
    fetchJson<YahooChart>(`https://query1.finance.yahoo.com/v8/finance/chart/${t}?interval=1d&range=1d`),
  )
  const r = data.chart.result?.[0]
  if (!r) throw new Error(`Yahoo returned no data for ${ticker}`)
  const prev = r.meta.chartPreviousClose ?? r.meta.regularMarketPrice
  return {
    symbol: r.meta.symbol,
    market: 'stock',
    displayName: r.meta.longName || r.meta.shortName || r.meta.symbol,
    price: r.meta.regularMarketPrice,
    change24h: prev ? ((r.meta.regularMarketPrice - prev) / prev) * 100 : 0,
    currency: r.meta.currency || 'USD',
  }
}

/** Resolve a free-form query to a stock ticker via Yahoo search (best effort). */
export async function searchStockTicker(query: string): Promise<{ symbol: string; name: string } | null> {
  try {
    const d = await cached(`yh:s:${query.toLowerCase()}`, 300_000, async () =>
      fetchJson<{ quotes: Array<{ symbol: string; shortname?: string; longname?: string; quoteType?: string }> }>(
        `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(query)}&quotesCount=6&newsCount=0`,
      ),
    )
    const eq = d.quotes?.find((q) => q.quoteType === 'EQUITY' || q.quoteType === 'ETF')
    return eq ? { symbol: eq.symbol, name: eq.longname || eq.shortname || eq.symbol } : null
  } catch {
    return null
  }
}

// ─── news: Google News RSS ───────────────────────────────────────────────────

export interface NewsItem {
  title: string
  source: string
  pubDate: string
}

export async function fetchNews(query: string, limit = 10): Promise<NewsItem[]> {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`
  const key = `news:${query.toLowerCase()}:${limit}`
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < hit.ttl) return hit.data as NewsItem[]
  const xml = await fetchText(url)
  const items: NewsItem[] = []
  const blockRe = /<item>([\s\S]*?)<\/item>/g
  const titleRe = /<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/
  const dateRe = /<pubDate>([\s\S]*?)<\/pubDate>/
  const srcRe = /<source[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/source>/
  let m: RegExpExecArray | null
  while ((m = blockRe.exec(xml)) !== null && items.length < limit) {
    const block = m[1]
    const title = titleRe.exec(block)?.[1]?.trim() ?? ''
    const rawTitle = title.replace(/ - [^-]+$/, '').trim() // strip " - Source" suffix
    items.push({
      title: rawTitle || title,
      source: srcRe.exec(block)?.[1]?.trim() ?? 'Google News',
      pubDate: dateRe.exec(block)?.[1]?.trim() ?? '',
    })
  }
  // successful non-empty results cache 10 min; empty results only 45s so a
  // later run retries instead of inheriting a vendor hiccup
  cache.set(key, { at: Date.now(), ttl: items.length ? 600_000 : 45_000, data: items })
  return items
}

/** Yahoo Finance search news — fallback source when Google News throttles us. */
export async function fetchYahooNews(ticker: string, limit = 8): Promise<NewsItem[]> {
  const t = encodeURIComponent(ticker.toUpperCase())
  const d = await cached(`yh:n:${t}:${limit}`, 300_000, async () =>
    fetchJson<{ news?: Array<{ title: string; publisher?: string; providerPublishTime?: number }> }>(
      `https://query1.finance.yahoo.com/v1/finance/search?q=${t}&quotesCount=0&newsCount=${limit}`,
    ),
  )
  return (d.news ?? []).slice(0, limit).map((n) => ({
    title: n.title ?? '',
    source: n.publisher ?? 'Yahoo Finance',
    pubDate: n.providerPublishTime ? new Date(n.providerPublishTime * 1000).toUTCString() : '',
  }))
}

// ─── unified helpers ─────────────────────────────────────────────────────────

export const CRYPTO_HINT = /^(BTC|ETH|SOL|BNB|XRP|ADA|DOGE|AVAX|DOT|LINK|TON|MATIC|LTC|BCH|NEAR|ARB|OP|SUI|APT|INJ|FIL|ATOM|ETC|XLM|UNI|PEPE|TRX|ICP|HBAR|VET|ALGO|AAVE|RUNE|TIA|SEI|FDUSD)$/i

export async function getTicker(symbol: string, market: 'crypto' | 'stock'): Promise<Ticker> {
  return market === 'crypto' ? fetchCryptoTicker(symbol) : fetchStockTicker(symbol)
}

export async function getCandles(
  symbol: string,
  market: 'crypto' | 'stock',
  timeframe: string,
): Promise<Candle[]> {
  return market === 'crypto'
    ? fetchCryptoCandles(symbol, timeframe, 200)
    : fetchStockCandles(symbol, timeframe === '1d' ? '1d' : timeframe, '1y')
}
