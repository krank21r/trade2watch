/**
 * SMC engine — market structure: BOS / CHoCH detection (§7/§8) and HH/HL/LH/LL
 * swing labels (§7).
 *
 * Model (all inputs are CLOSED candles):
 *   - Only CONFIRMED swings participate (confirmedAt !== null) — DEVELOPING
 *     swings are never used (no-look-ahead contract).
 *   - Swings are alternation-repaired: two consecutive same-kind swings
 *     collapse into the more extreme one (max HIGH / min LOW).
 *   - Walking candles in order, the reference levels are the most recent
 *     confirmed swing high/low not yet broken. A candle whose CLOSE breaks a
 *     reference level — AND whose close time is at/after that swing's
 *     confirmedAt (THE mandatory no-look-ahead guard) — fires one event:
 *       · BOS when it extends the current trend,
 *       · CHoCH when it flips it.
 *   - At most ONE event per candle. If both sides break on the same close,
 *     the break AGAINST the current trend wins (that is the information the
 *     trend state does not already contain).
 */

import type { Candle } from '@/lib/market/indicators'
import type { StructureEvent, SwingPoint } from './types'
import { atr } from './atr'
import type { SmcCfg } from './cfg'

export interface StructureResult {
  events: StructureEvent[]
  trend: 'BULLISH' | 'BEARISH' | 'NEUTRAL'
  labels: Array<{ swing: SwingPoint; tag: 'HH' | 'HL' | 'LH' | 'LL' }>
}

/** Keep only confirmed swings, time-sorted, with same-kind runs collapsed to the extreme. */
export function confirmedAlternating(swings: SwingPoint[]): SwingPoint[] {
  const confirmed = swings
    .filter((s) => s.confirmedAt !== null)
    .sort((a, b) => a.time - b.time)
  const out: SwingPoint[] = []
  for (const s of confirmed) {
    const prev = out[out.length - 1]
    if (prev && prev.kind === s.kind) {
      // Same kind twice in a row → keep the more extreme one entirely.
      const keepNewer =
        s.kind === 'HIGH' ? s.price > prev.price : s.price < prev.price
      out[out.length - 1] = keepNewer ? s : prev
    } else {
      out.push(s)
    }
  }
  return out
}

export function analyzeStructure(
  candles: Candle[],
  swings: SwingPoint[],
  tfMs: number,
  cfg: SmcCfg,
  atrVal?: number | null,
): StructureResult {
  const repaired = confirmedAlternating(swings)
  const highs = repaired.filter((s) => s.kind === 'HIGH')
  const lows = repaired.filter((s) => s.kind === 'LOW')

  const atrValue = atrVal === undefined ? atr(candles, cfg.atrPeriod) : atrVal

  const events: StructureEvent[] = []
  let trend: 'BULLISH' | 'BEARISH' | 'NEUTRAL' = 'NEUTRAL'

  let hi = 0 // next not-yet-absorbed swing HIGH (confirmation order)
  let lo = 0
  let lastSwingHigh: SwingPoint | null = null
  let lastSwingLow: SwingPoint | null = null

  for (const c of candles) {
    const closeTime = c.time + tfMs

    // Absorb swings whose confirmation candle closed by this candle's close.
    // A swing cannot be broken by any candle before its own confirmation
    // (the confirming candle and the ones between it and the swing have
    // strictly lower highs / higher lows by swing definition), so absorbing
    // first is safe and keeps lastSwing* the most recent confirmed reference.
    while (hi < highs.length) {
      const h = highs[hi]
      if (h.confirmedAt === null || h.confirmedAt > closeTime) break
      lastSwingHigh = h
      hi++
    }
    while (lo < lows.length) {
      const l = lows[lo]
      if (l.confirmedAt === null || l.confirmedAt > closeTime) break
      lastSwingLow = l
      lo++
    }

    const bullBreak =
      lastSwingHigh !== null &&
      c.close > lastSwingHigh.price &&
      // MANDATORY no-look-ahead guard: the swing must have been confirmed
      // by the time this candle closed.
      lastSwingHigh.confirmedAt !== null &&
      lastSwingHigh.confirmedAt <= closeTime
    const bearBreak =
      lastSwingLow !== null &&
      c.close < lastSwingLow.price &&
      lastSwingLow.confirmedAt !== null &&
      lastSwingLow.confirmedAt <= closeTime

    if (!bullBreak && !bearBreak) continue

    // One event per candle max — prefer the break against the current trend.
    const pickBull = bullBreak && bearBreak ? trend !== 'BULLISH' : bullBreak

    const ref = pickBull ? lastSwingHigh : lastSwingLow
    if (!ref) continue // unreachable; narrows the type
    const direction = pickBull ? 'BULLISH' : 'BEARISH'
    const body = atrValue && atrValue > 0 ? Math.abs(c.close - c.open) / atrValue : 0
    events.push({
      type: trend !== 'NEUTRAL' && trend !== direction ? 'CHOCH' : 'BOS',
      direction,
      breakLevel: ref.price,
      swingTime: ref.time,
      candleTime: c.time,
      confirmedAt: closeTime,
      strength: Math.min(100, Math.round(body * 60)),
    })
    trend = direction

    // Consume the broken swing: the next reference is the next confirmed
    // swing of the same kind after it — null until one confirms (the
    // absorption loop above sets it as soon as its confirmation closes).
    if (pickBull) lastSwingHigh = null
    else lastSwingLow = null
  }

  // HH/HL/LH/LL labels over the repaired swing sequence (cosmetic map for the
  // UI). First swing of a kind is tagged from the final trend as a rough
  // prior; subsequent swings compare price against the previous same-kind swing.
  const labels: StructureResult['labels'] = []
  let prevHigh: number | null = null
  let prevLow: number | null = null
  for (const s of repaired) {
    if (s.kind === 'HIGH') {
      const tag: 'HH' | 'LH' =
        prevHigh === null ? (trend === 'BEARISH' ? 'LH' : 'HH') : s.price > prevHigh ? 'HH' : 'LH'
      labels.push({ swing: s, tag })
      prevHigh = s.price
    } else {
      const tag: 'HL' | 'LL' =
        prevLow === null ? (trend === 'BEARISH' ? 'LL' : 'HL') : s.price > prevLow ? 'HL' : 'LL'
      labels.push({ swing: s, tag })
      prevLow = s.price
    }
  }

  return { events, trend, labels }
}

/** Events confirmed within the last `bars` candles of `tfMs` (§ "recent" windows). */
export function recentEvents(
  events: StructureEvent[],
  tfMs: number,
  bars: number,
  now: number = Date.now(),
): StructureEvent[] {
  const cutoff = now - bars * tfMs
  return events.filter((e) => e.confirmedAt >= cutoff)
}
