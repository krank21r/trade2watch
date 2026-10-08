/**
 * SMC engine — order blocks (§9/§10).
 *
 * An order block is the last opposite-color candle before a displacement that
 * goes on to break structure (the institutional footprint). Zone mode is
 * FULL_RANGE: [obCandle.low, obCandle.high].
 *
 * Lifecycle (walked forward on CLOSED candles only):
 *   ACTIVE → TESTED (price traded back into the zone, held)
 *          → MITIGATED (wick beyond the zone MIDPOINT but close held the zone)
 *          → INVALIDATED (a close through the far side kills it)
 *          → EXPIRED (older than cfg.obExpiryBars on its own TF).
 *
 * strength_score (§10, max 100): bos 20 (by construction) + htfAlignment 20 +
 * liquiditySweep 15 + fvg 10 + strongDisplacement 10 + volumeExpansion 5 +
 * fresh 10 + cleanStructure 10 — every contribution recorded in `factors`.
 */

import type { Candle } from '@/lib/market/indicators'
import type { Direction, FVG, LiquiditySweep, OrderBlock, StructureEvent } from './types'
import { findDisplacement } from './displacement'
import type { SmcCfg } from './cfg'

const ACTIVE_OB: Array<OrderBlock['status']> = ['ACTIVE', 'TESTED', 'MITIGATED']

export function isActiveOb(ob: OrderBlock): boolean {
  return ACTIVE_OB.includes(ob.status)
}

export function detectOrderBlocks(
  candles: Candle[],
  events: StructureEvent[],
  fvgs: FVG[],
  atrVal: number | null,
  cfg: SmcCfg,
  htfBias: 'BULLISH' | 'BEARISH' | 'NEUTRAL',
  sweeps: LiquiditySweep[],
  tfMs: number,
): OrderBlock[] {
  const out: OrderBlock[] = []
  const seenObTimes = new Set<number>()
  const lastTime = candles.length > 0 ? candles[candles.length - 1].time : 0

  for (const ev of events) {
    const evIdx = candles.findIndex((c) => c.time === ev.candleTime)
    if (evIdx < 0) continue

    // ── locate the OB candle: scan back within the displacement gap window ──
    const from = Math.max(0, evIdx - 1 - cfg.obMaxDisplacementGap)
    let obIdx = -1
    for (let j = evIdx - 1; j >= from; j--) {
      const c = candles[j]
      const bearish = c.close < c.open
      // BULLISH break → want the last BEARISH candle before it (and mirror).
      if (ev.direction === 'BULLISH' ? bearish : !bearish) {
        obIdx = j
        break
      }
    }
    if (obIdx < 0) {
      // No opposite-color candle in the window → extreme of the window.
      if (ev.direction === 'BULLISH') {
        let best = from
        for (let j = from; j <= evIdx - 1; j++) if (candles[j].low < candles[best].low) best = j
        obIdx = best
      } else {
        let best = from
        for (let j = from; j <= evIdx - 1; j++) if (candles[j].high > candles[best].high) best = j
        obIdx = best
      }
    }
    if (obIdx === evIdx) continue // degenerate guard
    const obCandle = candles[obIdx]
    if (obCandle.time === ev.candleTime) continue
    const zoneLow = obCandle.low
    const zoneHigh = obCandle.high
    if (!(zoneHigh > zoneLow)) continue // zero-height zone
    if (seenObTimes.has(obCandle.time)) continue // dedupe by OB candle time
    seenObTimes.add(obCandle.time)

    // ── walk forward from the BOS candle: touches / mitigation / invalidation ──
    const mid = (zoneLow + zoneHigh) / 2
    let testedCount = 0
    let wasIn = false
    let invalidated = false
    let mitigated = false
    for (let j = evIdx; j < candles.length; j++) {
      const c = candles[j]
      const inZone = c.low <= zoneHigh && c.high >= zoneLow
      if (inZone && !wasIn) testedCount++
      wasIn = inZone
      if (ev.direction === 'BULLISH') {
        if (c.close < zoneLow) invalidated = true
        if (c.low < mid && c.close >= zoneLow) mitigated = true
      } else {
        if (c.close > zoneHigh) invalidated = true
        if (c.high > mid && c.close <= zoneHigh) mitigated = true
      }
    }

    let status: OrderBlock['status']
    if (invalidated) status = 'INVALIDATED'
    else if (lastTime - obCandle.time > cfg.obExpiryBars * tfMs) status = 'EXPIRED'
    else if (mitigated) status = 'MITIGATED'
    else if (testedCount > 0) status = 'TESTED'
    else status = 'ACTIVE'
    // fresh = never traded back into (an invalidated OB always registered at
    // least one touch — a close through the zone overlaps it — so no extra guard).
    const fresh = testedCount === 0

    // ── strength score (§10) ────────────────────────────────────────────────
    const factors: Record<string, number> = {}
    const w = cfg.obScoreWeights

    factors.bos = w.bos // always: the OB exists because a break followed

    factors.htfAlignment = htfBias === ev.direction ? w.htfAlignment : 0

    const sweepHit = sweeps.some(
      (s) =>
        s.direction === ev.direction &&
        s.confirmedAt >= obCandle.time - cfg.sweepRecencyBars * tfMs &&
        s.confirmedAt <= ev.candleTime + tfMs,
    )
    factors.liquiditySweep = sweepHit ? w.liquiditySweep : 0

    const fvgHit = fvgs.some(
      (f) =>
        f.direction === ev.direction &&
        f.time >= obCandle.time &&
        f.time <= ev.candleTime + 3 * tfMs &&
        f.status !== 'FILLED' &&
        f.status !== 'INVALIDATED',
    )
    factors.fvg = fvgHit ? w.fvg : 0

    const disp =
      atrVal !== null
        ? findDisplacement(candles, atrVal, cfg, obCandle.time, ev.direction)
        : null
    factors.strongDisplacement =
      disp && disp.time <= ev.candleTime ? w.strongDisplacement : 0

    // volume expansion at the OB candle vs the SMA(volume) before it
    let volumeExpansion = 0
    if (obIdx >= cfg.volumePeriod) {
      let sum = 0
      for (let j = obIdx - cfg.volumePeriod; j <= obIdx - 1; j++) sum += candles[j].volume
      const avg = sum / cfg.volumePeriod
      if (avg > 0 && obCandle.volume / avg >= cfg.volumeThreshold) volumeExpansion = w.volumeExpansion
    }
    factors.volumeExpansion = volumeExpansion

    factors.fresh = fresh ? w.fresh : 0

    let opposite = 0
    for (let j = obIdx + 1; j < evIdx; j++) {
      const bearish = candles[j].close < candles[j].open
      if (ev.direction === 'BULLISH' ? bearish : !bearish) opposite++
    }
    factors.cleanStructure = opposite <= 2 ? w.cleanStructure : 0

    const strengthScore = Math.min(
      100,
      Object.values(factors).reduce((a, b) => a + b, 0),
    )

    out.push({
      direction: ev.direction,
      low: zoneLow,
      high: zoneHigh,
      time: obCandle.time,
      volume: obCandle.volume,
      bosLevel: ev.breakLevel,
      bosTime: ev.candleTime,
      status,
      testedCount,
      strengthScore,
      fresh,
      factors,
    })
  }

  return out.sort((a, b) => b.time - a.time) // time DESC
}

/** Direction helper used by callers picking OBs for a side. */
export function obMatchesSide(ob: OrderBlock, side: 'LONG' | 'SHORT'): boolean {
  const dir: Direction = side === 'LONG' ? 'BULLISH' : 'BEARISH'
  return ob.direction === dir
}
