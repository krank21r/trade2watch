/**
 * SMC engine — Average True Range (Wilder smoothing, §14).
 *
 * Pure function over CLOSED candles. Returns the LATEST ATR value (not a
 * series) because every downstream consumer only needs the current volatility
 * unit to normalize bodies, wicks and tolerances.
 */

import type { Candle } from '@/lib/market/indicators'

/**
 * Wilder-smoothed ATR. Null when there are fewer than `period + 1` candles
 * (the first True Range needs a previous close to seed against).
 */
export function atr(candles: Candle[], period: number): number | null {
  if (period <= 0 || candles.length < period + 1) return null

  // True Range series: first TR = high - low (no previous close yet).
  const trs: number[] = [candles[0].high - candles[0].low]
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i]
    const prevClose = candles[i - 1].close
    trs.push(Math.max(c.high - c.low, Math.abs(c.high - prevClose), Math.abs(c.low - prevClose)))
  }

  // Seed: simple average of the first `period` TRs.
  let atrVal = 0
  for (let i = 0; i < period; i++) atrVal += trs[i]
  atrVal /= period

  // Wilder smoothing: atr = (prev * (period - 1) + tr) / period.
  for (let i = period; i < trs.length; i++) {
    atrVal = (atrVal * (period - 1) + trs[i]) / period
  }
  return atrVal
}
