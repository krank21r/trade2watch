/**
 * SMC engine — trade plan builder (§18/§19).
 *
 * Pure risk math over an order block and the liquidity map. NO trading logic,
 * NO execution — this only produces the plan numbers (entry zone, stop, three
 * targets, R multiples) for the analysis payload.
 *
 * Entry model OB_RANGE: the plan entry is the OB zone itself, midpoint used
 * for R math. Stop = OB extreme ∓ cfg.slAtrBuffer × ATR. Targets ladder up
 * (LONG) / down (SHORT) the nearest opposing liquidity pools, never BELOW the
 * fallback minimums (2R / 3.5R / 5.5R) — a plan that only offers 1.2R to the
 * first pool is not worth taking, so the floor lifts it.
 */

import type { LiquidityLevel, OrderBlock, SwingPoint } from './types'
import type { SmcCfg } from './cfg'

export interface TradePlan {
  entry_low: number
  entry_high: number
  entry_mid: number
  stop_loss: number
  tp1: number
  tp2: number
  tp3: number
  rr1: number
  rr2: number
  rr3: number
}

const BUY_SIDE_POOLS: Array<LiquidityLevel['type']> = ['EQUAL_HIGH', 'PDH', 'PWH', 'SWING_HIGH']
const SELL_SIDE_POOLS: Array<LiquidityLevel['type']> = ['EQUAL_LOW', 'PDL', 'PWL', 'SWING_LOW']

function nearestPool(
  levels: LiquidityLevel[],
  side: 'LONG' | 'SHORT',
  above: boolean,
  minPrice: number,
  maxPrice: number,
): LiquidityLevel | null {
  const pools = levels.filter(
    (l) =>
      (side === 'LONG' ? BUY_SIDE_POOLS : SELL_SIDE_POOLS).includes(l.type) &&
      l.price > minPrice &&
      l.price < maxPrice,
  )
  if (pools.length === 0) return null
  // prefer unswept pools; nearest to entry within the band
  const sorted = pools.sort((a, b) => {
    if (a.swept !== b.swept) return a.swept ? 1 : -1
    return above ? a.price - b.price : b.price - a.price
  })
  return sorted[0]
}

export function buildTrade(
  ob: OrderBlock,
  side: 'LONG' | 'SHORT',
  atrVal: number | null,
  levels: LiquidityLevel[],
  swings1H: SwingPoint[],
  cfg: SmcCfg,
  entryMid?: number,
  htfSwings?: SwingPoint[],
): TradePlan | null {
  const wantDir = side === 'LONG' ? 'BULLISH' : 'BEARISH'
  if (ob.direction !== wantDir) return null

  const entryLow = ob.low
  const entryHigh = ob.high
  const mid = entryMid ?? (entryLow + entryHigh) / 2
  const buffer = atrVal !== null && atrVal > 0 ? cfg.slAtrBuffer * atrVal : 0
  const stopLoss = side === 'LONG' ? ob.low - buffer : ob.high + buffer
  const risk = side === 'LONG' ? mid - stopLoss : stopLoss - mid
  if (!(risk > 0) || !Number.isFinite(risk)) return null

  const r = (mult: number) => (side === 'LONG' ? mid + mult * risk : mid - mult * risk)

  // ── TP1: nearest opposing pool ≥ 1R away (never closer than 1R) ───────────
  const oneR = side === 'LONG' ? mid + risk : mid - risk
  const bandToward = side === 'LONG' ? Number.MAX_VALUE : 0
  const tp1Pool = nearestPool(levels, side, side === 'LONG', oneR, bandToward)
  let tp1 = tp1Pool ? tp1Pool.price : r(2)

  // ── TP2: next pool beyond TP1, else the major previous 1H swing high/low ──
  const beyondTp1 = nearestPool(
    levels,
    side,
    side === 'LONG',
    side === 'LONG' ? tp1 : -Number.MAX_VALUE,
    side === 'LONG' ? Number.MAX_VALUE : tp1,
  )
  // "previous major swing": max confirmed 1H swing above/below entry not used by TP1
  const swingCandidates = swings1H.filter(
    (s) =>
      s.confirmedAt !== null &&
      s.kind === (side === 'LONG' ? 'HIGH' : 'LOW') &&
      (side === 'LONG' ? s.price > mid : s.price < mid) &&
      s.price !== tp1,
  )
  const majorSwing =
    swingCandidates.length > 0
      ? swingCandidates.reduce((a, b) =>
          side === 'LONG' ? (b.price > a.price ? b : a) : b.price < a.price ? b : a,
        )
      : null
  const tp2Candidate = beyondTp1 ? beyondTp1.price : majorSwing ? majorSwing.price : r(3.5)
  let tp2 = tp2Candidate

  // ── TP3: HTF liquidity — PWH/PWL, else highest 4H/1D-equivalent swing, else 5.5R ──
  const htfPool = levels.find(
    (l) =>
      (l.type === 'PWH' || l.type === 'PWL') &&
      (side === 'LONG' ? l.price > mid : l.price < mid),
  )
  const htfSwingCandidates = (htfSwings ?? []).filter(
    (s) =>
      s.confirmedAt !== null &&
      s.kind === (side === 'LONG' ? 'HIGH' : 'LOW') &&
      (side === 'LONG' ? s.price > mid : s.price < mid),
  )
  const htfSwing =
    htfSwingCandidates.length > 0
      ? htfSwingCandidates.reduce((a, b) =>
          side === 'LONG' ? (b.price > a.price ? b : a) : b.price < a.price ? b : a,
        )
      : null
  let tp3 = htfPool ? htfPool.price : htfSwing ? htfSwing.price : r(5.5)

  // ── fallback floors/ceilings (never below/above the minimum ladder) ───────
  // monotonic guards keep the ladder ordered after the floors are applied
  if (side === 'LONG') {
    tp1 = Math.max(tp1, r(2))
    tp2 = Math.max(tp2, r(3.5), tp1 + 0.1 * risk)
    tp3 = Math.max(tp3, r(5.5), tp2 + 0.1 * risk)
  } else {
    tp1 = Math.min(tp1, r(2))
    tp2 = Math.min(tp2, r(3.5), tp1 - 0.1 * risk)
    tp3 = Math.min(tp3, r(5.5), tp2 - 0.1 * risk)
  }

  const rr = (tp: number) => Math.round((Math.abs(tp - mid) / risk) * 10) / 10
  const plan: TradePlan = {
    entry_low: entryLow,
    entry_high: entryHigh,
    entry_mid: mid,
    stop_loss: stopLoss,
    tp1,
    tp2,
    tp3,
    rr1: rr(tp1),
    rr2: rr(tp2),
    rr3: rr(tp3),
  }

  // §20 gate: RR at TP2 must clear cfg.minimumRr or the setup is rejected.
  if (plan.rr2 < cfg.minimumRr) return null
  return plan
}
