/**
 * Builds a deterministic technical snapshot for a symbol — the factual
 * backbone fed to every agent, and the raw material the trade-plan
 * engineer uses to compute entries/stops/targets.
 */

import {
  atr,
  bollinger,
  ema,
  macd,
  pivotLevels,
  rsi,
  slopePct,
  type Candle,
} from './indicators'

export type Regime = 'TRENDING_UP' | 'TRENDING_DOWN' | 'RANGING'

export interface TechnicalSnapshot {
  symbol: string
  market: 'crypto' | 'stock'
  displayName: string
  currency: string
  price: number
  change24h: number
  timeframe: string
  regime: Regime
  regimeNote: string

  ema20: number | null
  ema50: number | null
  ema200: number | null
  rsi14: number | null
  macd: { macd: number; signal: number; hist: number } | null
  macdCross: 'BULLISH' | 'BEARISH' | 'NONE'
  atr: number | null
  atrPct: number | null // ATR as % of price — volatility
  bb: { upper: number | null; mid: number | null; lower: number | null }

  supports: number[]
  resistances: number[]
  rangeHigh: number // 30-candle (or 90d) high
  rangeLow: number
  pctFromRangeHigh: number
  pctFromRangeLow: number
  volumeTrend: 'RISING' | 'FALLING' | 'FLAT'
  slope: number // % per candle over last 20

  recentCandles: string[] // human-readable last 10 candles
  candlesAnalyzed: number
}

export function buildSnapshot(
  candles: Candle[],
  meta: { symbol: string; market: 'crypto' | 'stock'; displayName: string; currency: string; price: number; change24h: number; timeframe: string },
): TechnicalSnapshot {
  const closes = candles.map((c) => c.close)
  const n = closes.length
  const last = (arr: (number | null)[]): number | null => (arr.length ? arr[arr.length - 1] : null)

  const e20 = last(ema(closes, 20))
  const e50 = last(ema(closes, 50))
  const e200 = last(ema(closes, 200))
  const r = last(rsi(closes, 14))
  const m = macd(closes)
  const mNow = m.length ? m[m.length - 1] : null
  const mPrev = m.length > 1 ? m[m.length - 2] : null
  const a = last(atr(candles, 14))
  const bb = bollinger(closes, 20, 2)
  const { supports, resistances } = pivotLevels(candles, 3)

  // regime: EMA stack + slope
  const slope = slopePct(closes, 20)
  let regime: Regime = 'RANGING'
  let regimeNote = 'EMAs flat or interleaved — no dominant trend'
  if (e50 !== null && e200 !== null && e20 !== null) {
    if (e50 > e200 && meta.price > e50 && slope > 0.03) {
      regime = 'TRENDING_UP'
      regimeNote = `EMA20 > EMA50 > EMA200 with price above EMA50 (slope +${slope.toFixed(2)}%/candle)`
    } else if (e50 < e200 && meta.price < e50 && slope < -0.03) {
      regime = 'TRENDING_DOWN'
      regimeNote = `EMA20 < EMA50 < EMA200 with price below EMA50 (slope ${slope.toFixed(2)}%/candle)`
    } else if (e50 > e200 && meta.price > e50) {
      regime = 'TRENDING_UP'
      regimeNote = `Price above rising EMA50 (slope +${slope.toFixed(2)}%/candle) — mild uptrend`
    } else if (e50 < e200 && meta.price < e50) {
      regime = 'TRENDING_DOWN'
      regimeNote = `Price below falling EMA50 (slope ${slope.toFixed(2)}%/candle) — mild downtrend`
    }
  }

  let macdCross: 'BULLISH' | 'BEARISH' | 'NONE' = 'NONE'
  if (mNow && mPrev) {
    if (mPrev.hist <= 0 && mNow.hist > 0) macdCross = 'BULLISH'
    else if (mPrev.hist >= 0 && mNow.hist < 0) macdCross = 'BEARISH'
  }

  const lookback = Math.min(90, n)
  const window = candles.slice(-lookback)
  const rangeHigh = Math.max(...window.map((c) => c.high))
  const rangeLow = Math.min(...window.map((c) => c.low))

  // volume trend: avg vol of last 5 vs previous 20
  let volumeTrend: 'RISING' | 'FALLING' | 'FLAT' = 'FLAT'
  if (n >= 25) {
    const v5 = candles.slice(-5).reduce((acc, c) => acc + c.volume, 0) / 5
    const v20 = candles.slice(-25, -5).reduce((acc, c) => acc + c.volume, 0) / 20
    if (v20 > 0) {
      const ratio = v5 / v20
      volumeTrend = ratio > 1.2 ? 'RISING' : ratio < 0.8 ? 'FALLING' : 'FLAT'
    }
  }

  const recentCandles = candles.slice(-10).map((c) => {
    const d = new Date(c.time)
    const dir = c.close >= c.open ? '+' : '-'
    return `${d.toISOString().slice(0, 10)} O:${fmt(c.open)} H:${fmt(c.high)} L:${fmt(c.low)} C:${fmt(c.close)} ${dir}${(((c.close - c.open) / c.open) * 100).toFixed(2)}%`
  })

  return {
    symbol: meta.symbol,
    market: meta.market,
    displayName: meta.displayName,
    currency: meta.currency,
    price: meta.price,
    change24h: meta.change24h,
    timeframe: meta.timeframe,
    regime,
    regimeNote,
    ema20: e20,
    ema50: e50,
    ema200: e200,
    rsi14: r,
    macd: mNow,
    macdCross,
    atr: a,
    atrPct: a !== null ? (a / meta.price) * 100 : null,
    bb,
    supports,
    resistances,
    rangeHigh,
    rangeLow,
    pctFromRangeHigh: ((meta.price - rangeHigh) / rangeHigh) * 100,
    pctFromRangeLow: ((meta.price - rangeLow) / rangeLow) * 100,
    volumeTrend,
    slope,
    recentCandles,
    candlesAnalyzed: n,
  }
}

function fmt(x: number): string {
  return x >= 1000 ? Math.round(x).toLocaleString('en-US') : String(Math.round(x * 100) / 100)
}

/** Compact, token-efficient textual rendering for LLM prompts. */
export function snapshotToText(s: TechnicalSnapshot): string {
  const lines: string[] = []
  lines.push(`${s.displayName} (${s.symbol}) — ${s.market === 'crypto' ? 'Crypto' : 'Stock'}, ${s.timeframe} candles, ${s.candlesAnalyzed} bars analyzed`)
  lines.push(`Price: ${money(s.price, s.currency)} | 24h change: ${s.change24h >= 0 ? '+' : ''}${s.change24h.toFixed(2)}%`)
  lines.push(`Regime: ${s.regime} — ${s.regimeNote}`)
  lines.push(`EMA20: ${n(s.ema20)} | EMA50: ${n(s.ema50)} | EMA200: ${n(s.ema200)}`)
  lines.push(`RSI(14): ${n(s.rsi14)}`)
  if (s.macd) lines.push(`MACD: ${s.macd.macd.toFixed(2)} vs signal ${s.macd.signal.toFixed(2)} (hist ${s.macd.hist.toFixed(2)}, ${s.macdCross} cross)`)
  if (s.atr !== null) lines.push(`ATR(14): ${n(s.atr)} (${s.atrPct?.toFixed(2)}% of price — per-candle volatility)`)
  if (s.bb.lower !== null && s.bb.upper !== null) lines.push(`Bollinger(20,2): ${n(s.bb.lower)} / ${n(s.bb.mid)} / ${n(s.bb.upper)}`)
  lines.push(`Support levels: ${s.supports.map((x) => n(x)).join(', ') || 'none detected'}`)
  lines.push(`Resistance levels: ${s.resistances.map((x) => n(x)).join(', ') || 'none detected'}`)
  lines.push(`${s.timeframe === '1d' ? '1-year' : '90-bar'} range: ${n(s.rangeLow)} – ${n(s.rangeHigh)} (price ${s.pctFromRangeLow.toFixed(1)}% above low, ${s.pctFromRangeHigh.toFixed(1)}% below high)`)
  lines.push(`Volume trend: ${s.volumeTrend}`)
  lines.push(`Last 10 candles:`)
  lines.push(...s.recentCandles.map((c) => `  ${c}`))
  return lines.join('\n')
}

function money(x: number, cur: string): string {
  return `${cur === 'USD' ? '$' : cur + ' '}${x >= 1000 ? Math.round(x).toLocaleString('en-US') : Math.round(x * 100) / 100}`
}
function n(x: number | null): string {
  return x === null ? 'n/a' : x >= 1000 ? Math.round(x).toLocaleString('en-US') : String(Math.round(x * 100) / 100)
}
