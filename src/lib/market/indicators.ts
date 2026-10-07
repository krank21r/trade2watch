/**
 * Technical indicator library — pure TypeScript, zero dependencies.
 * Adapted from classic TA definitions (Wilder smoothing etc.) to replace
 * the pandas/stockstats stack used by TradingAgents.
 */

export interface Candle {
  time: number // ms epoch (candle open time)
  open: number
  high: number
  low: number
  close: number
  volume: number
}

/** Exponential Moving Average. Returns array aligned to input (null until seeded). */
export function ema(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null)
  if (values.length < period) return out
  const k = 2 / (period + 1)
  let seed = 0
  for (let i = 0; i < period; i++) seed += values[i]
  let prev = seed / period
  out[period - 1] = prev
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k)
    out[i] = prev
  }
  return out
}

/** Simple Moving Average. */
export function sma(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null)
  let sum = 0
  for (let i = 0; i < values.length; i++) {
    sum += values[i]
    if (i >= period) sum -= values[i - period]
    if (i >= period - 1) out[i] = sum / period
  }
  return out
}

/** RSI with Wilder's smoothing. Returns array aligned to input (null until ready). */
export function rsi(closes: number[], period = 14): (number | null)[] {
  const out: (number | null)[] = new Array(closes.length).fill(null)
  if (closes.length < period + 1) return out
  let gain = 0
  let loss = 0
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1]
    if (d >= 0) gain += d
    else loss -= d
  }
  let avgGain = gain / period
  let avgLoss = loss / period
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss)
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1]
    const g = d > 0 ? d : 0
    const l = d < 0 ? -d : 0
    avgGain = (avgGain * (period - 1) + g) / period
    avgLoss = (avgLoss * (period - 1) + l) / period
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss)
  }
  return out
}

export interface MacdPoint {
  macd: number
  signal: number
  hist: number
}

/** MACD (12, 26, 9). Returns array aligned to input (null until ready). */
export function macd(closes: number[], fast = 12, slow = 26, sig = 9): (MacdPoint | null)[] {
  const out: (MacdPoint | null)[] = new Array(closes.length).fill(null)
  const ef = ema(closes, fast)
  const es = ema(closes, slow)
  const macdLine: number[] = []
  const macdIdx: number[] = []
  for (let i = 0; i < closes.length; i++) {
    if (ef[i] !== null && es[i] !== null) {
      macdLine.push((ef[i] as number) - (es[i] as number))
      macdIdx.push(i)
    }
  }
  const sigLine = ema(macdLine, sig)
  for (let j = 0; j < macdLine.length; j++) {
    if (sigLine[j] !== null) {
      out[macdIdx[j]] = {
        macd: macdLine[j],
        signal: sigLine[j] as number,
        hist: macdLine[j] - (sigLine[j] as number),
      }
    }
  }
  return out
}

/** Average True Range (Wilder). Returns array aligned to input (null until ready). */
export function atr(candles: Candle[], period = 14): (number | null)[] {
  const out: (number | null)[] = new Array(candles.length).fill(null)
  if (candles.length < period + 1) return out
  const tr: number[] = [candles[0].high - candles[0].low]
  for (let i = 1; i < candles.length; i++) {
    tr.push(
      Math.max(
        candles[i].high - candles[i].low,
        Math.abs(candles[i].high - candles[i - 1].close),
        Math.abs(candles[i].low - candles[i - 1].close),
      ),
    )
  }
  let prev = tr.slice(1, period + 1).reduce((a, b) => a + b, 0) / period
  out[period] = prev
  for (let i = period + 1; i < candles.length; i++) {
    prev = (prev * (period - 1) + tr[i]) / period
    out[i] = prev
  }
  return out
}

/** Bollinger Bands (20, 2). */
export function bollinger(
  closes: number[],
  period = 20,
  mult = 2,
): { upper: number | null; mid: number | null; lower: number | null } {
  const n = closes.length
  if (n < period) return { upper: null, mid: null, lower: null }
  const slice = closes.slice(-period)
  const mid = slice.reduce((a, b) => a + b, 0) / period
  const variance = slice.reduce((a, b) => a + (b - mid) ** 2, 0) / period
  const sd = Math.sqrt(variance)
  return { upper: mid + mult * sd, mid, lower: mid - mult * sd }
}

/**
 * Swing-pivot detection with ATR clustering → support/resistance levels.
 * A pivot high/low must dominate `span` candles on both sides; pivots within
 * 0.6 × ATR of each other are merged (average), keeping touch counts.
 */
export function pivotLevels(
  candles: Candle[],
  span = 3,
): { supports: number[]; resistances: number[] } {
  const n = candles.length
  if (n < span * 2 + 2) return { supports: [], resistances: [] }
  const a = atr(candles, 14)
  const atrNow =
    (a[a.length - 1] as number | null) ??
    ((candles[n - 1].high - candles[n - 1].low) || candles[n - 1].close * 0.01)
  const tol = Math.max(atrNow * 0.6, candles[n - 1].close * 0.0015)

  const rawH: number[] = []
  const rawL: number[] = []
  for (let i = span; i < n - span; i++) {
    let isHigh = true
    let isLow = true
    for (let j = i - span; j <= i + span; j++) {
      if (j === i) continue
      if (candles[j].high >= candles[i].high) isHigh = false
      if (candles[j].low <= candles[i].low) isLow = false
    }
    if (isHigh) rawH.push(candles[i].high)
    if (isLow) rawL.push(candles[i].low)
  }

  const last = candles[n - 1].close
  const cluster = (levels: number[]): { level: number; touches: number }[] => {
    const sorted = [...levels].sort((x, y) => x - y)
    const groups: number[][] = []
    for (const lv of sorted) {
      const g = groups[groups.length - 1]
      if (g && Math.abs(lv - g[g.length - 1]) <= tol) g.push(lv)
      else groups.push([lv])
    }
    return groups.map((g) => ({
      level: g.reduce((acc, b) => acc + b, 0) / g.length,
      touches: g.length,
    }))
  }

  const sup = cluster(rawL.filter((l) => l <= last))
  const res = cluster(rawH.filter((l) => l >= last))
  // rank: more touches and nearer to price first
  const byScore = (arr: { level: number; touches: number }[]) =>
    arr
      .map((x) => ({ ...x, score: x.touches * 2 - Math.abs(last - x.level) / tol }))
      .sort((x, y) => y.score - x.score)
      .map((x) => x.level)
      .slice(0, 4)

  return { supports: byScore(sup), resistances: byScore(res) }
}

/** Simple linear-regression slope of last `n` closes, normalized to % per candle. */
export function slopePct(closes: number[], n = 20): number {
  const s = closes.slice(-n)
  const len = s.length
  if (len < 3) return 0
  const meanX = (len - 1) / 2
  const meanY = s.reduce((a, b) => a + b, 0) / len
  let num = 0
  let den = 0
  for (let i = 0; i < len; i++) {
    num += (i - meanX) * (s[i] - meanY)
    den += (i - meanX) ** 2
  }
  const slope = den === 0 ? 0 : num / den
  return meanY === 0 ? 0 : (slope / meanY) * 100
}
