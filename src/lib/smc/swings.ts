/**
 * SMC engine — fractal swing detection (§6).
 *
 * A swing HIGH at index i: high[i] STRICTLY greater than the `left` highs
 * before it AND the `right` highs after it (equal highs produce no swing —
 * that is what the EQUAL_HIGH liquidity detector is for).
 * Swing LOW mirrored.
 *
 * NO-LOOK-AHEAD: a swing at i is only CONFIRMED once the right-th candle
 * after it has closed: confirmedAt = candles[i + right].time + tfMs.
 * Indices are scanned from `left` to `length - right - 1` only, so every
 * returned swing is confirmed by an already-closed candle. (The null branch
 * of the formula is kept for contract completeness — a DEVELOPING swing must
 * never be used downstream.)
 */

import type { Candle } from '@/lib/market/indicators'
import type { SwingPoint } from './types'

export function detectSwings(candles: Candle[], left: number, right: number, tfMs: number): SwingPoint[] {
  const out: SwingPoint[] = []
  const n = candles.length
  if (left < 1 || right < 1 || n < left + right + 1) return out

  for (let i = left; i <= n - 1 - right; i++) {
    const c = candles[i]

    let isHigh = true
    for (let j = i - left; j <= i + right; j++) {
      if (j === i) continue
      if (candles[j].high >= c.high) {
        isHigh = false
        break
      }
    }

    let isLow = true
    for (let j = i - left; j <= i + right; j++) {
      if (j === i) continue
      if (candles[j].low <= c.low) {
        isLow = false
        break
      }
    }

    if (!isHigh && !isLow) continue
    // i + right is always < n within this scan range → confirmed.
    const confirmedAt = i + right < n ? candles[i + right].time + tfMs : null

    if (isHigh) out.push({ kind: 'HIGH', index: i, time: c.time, price: c.high, confirmedAt })
    if (isLow) out.push({ kind: 'LOW', index: i, time: c.time, price: c.low, confirmedAt })
  }
  return out
}
