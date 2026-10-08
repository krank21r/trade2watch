/**
 * SMC engine — Fair Value Gaps (§11).
 *
 * A 3-candle imbalance: bullish when candle1.high < candle3.low (price moved
 * so fast candle2 left an unfilled range), bearish when candle1.low >
 * candle3.high. The zone is tracked from candle3 onward:
 *   - fill%  = how much of the zone the LATER wicks have retraced,
 *   - FILLED = wicks fully crossed the zone,
 *   - INVALIDATED = a later candle CLOSED through the far side (gap failed).
 */

import type { Candle } from '@/lib/market/indicators'
import type { FVG } from './types'

export function detectFvgs(candles: Candle[], tfMs: number): FVG[] {
  const out: FVG[] = []
  for (let i = 1; i < candles.length - 1; i++) {
    const c1 = candles[i - 1]
    const c3 = candles[i + 1]

    let direction: 'BULLISH' | 'BEARISH' | null = null
    let low = 0
    let high = 0
    if (c1.high < c3.low) {
      direction = 'BULLISH'
      low = c1.high
      high = c3.low
    } else if (c1.low > c3.high) {
      direction = 'BEARISH'
      low = c3.high
      high = c1.low
    }
    if (!direction) continue

    const zone: FVG = {
      direction,
      low,
      high,
      time: c3.time, // open time of the confirming candle
      status: 'ACTIVE',
      fillPct: 0,
    }

    // Walk everything AFTER the gap completed.
    let minLowAfter = Infinity
    let maxHighAfter = -Infinity
    let invalidated = false
    for (let j = i + 2; j < candles.length; j++) {
      const c = candles[j]
      minLowAfter = Math.min(minLowAfter, c.low)
      maxHighAfter = Math.max(maxHighAfter, c.high)
      if (direction === 'BULLISH' && c.close < zone.low) invalidated = true
      if (direction === 'BEARISH' && c.close > zone.high) invalidated = true
    }

    const height = zone.high - zone.low
    let fillPct: number
    if (direction === 'BULLISH') {
      // Wick retracement from the top of the zone downward.
      fillPct = height > 0 ? ((zone.high - minLowAfter) / height) * 100 : 0
      if (minLowAfter <= zone.low) fillPct = 100
    } else {
      fillPct = height > 0 ? ((maxHighAfter - zone.low) / height) * 100 : 0
      if (maxHighAfter >= zone.high) fillPct = 100
    }
    zone.fillPct = Math.max(0, Math.min(100, Math.round(fillPct)))

    if (invalidated) zone.status = 'INVALIDATED'
    else if (zone.fillPct >= 100) zone.status = 'FILLED'
    else if (zone.fillPct > 0) zone.status = 'PARTIALLY_FILLED'
    else zone.status = 'ACTIVE'

    out.push(zone)
  }
  return out
}

/** Inverse tfMs guard helper (kept local so the module stays dependency-free). */
export function gapAgeBars(fvg: FVG, lastCandleTime: number, tfMs: number): number {
  return Math.max(0, Math.floor((lastCandleTime - fvg.time) / tfMs))
}
