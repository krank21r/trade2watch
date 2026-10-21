/**
 * Trader Desk — signal levels.
 *
 * The desk pipeline (budget sizing → risk gate → tickets → portfolio) was
 * removed at the user's request. What remains is the deterministic level
 * engine: for a screener signal it builds the trade plan the AI Signals desk
 * uses (buildTradePlan on a fresh technical snapshot) — in BOTH directions.
 * A LONG plan puts an entry zone at/below price with a structural stop
 * beneath it and R:R-floored targets above; a SHORT plan mirrors it above
 * price. The screener attaches both to feed rows; "I took this trade"
 * freezes the chosen direction into the shared trade journal
 * (src/lib/mytrades.ts), which does all the tracking (TP1 → stop to entry,
 * TP2 = full win, SL = stopped out).
 */

import { getTicker, getCandles } from '@/lib/market/providers'
import { buildSnapshot } from '@/lib/market/snapshot'
import { buildTradePlan } from '@/lib/signals/engine'

const roundPx = (x: number): number => {
  if (!Number.isFinite(x)) return x
  // keep enough precision that entry zones never collapse: 2 decimals for
  // $10+, 3 for $1-$10, 4 significant digits below $1 (tiny crypto prices)
  if (x >= 10) return Math.round(x * 100) / 100
  if (x >= 1) return Math.round(x * 1000) / 1000
  return Number(x.toPrecision(4))
}

export interface TicketPlan {
  entryLow: number
  entryHigh: number
  stop: number
  target1: number
  target2: number
  riskReward: string
  atr: number | null
  regime: string
  timeframe: string
}

/**
 * Deterministic trade plan for a desk signal — LONG or SHORT. Returns null
 * when the market data cannot support a plan; the signal row then renders
 * "—" for that direction and cannot be taken.
 */
export async function planLevels(
  symbol: string,
  market: 'crypto' | 'stock',
  side: 'LONG' | 'SHORT',
): Promise<TicketPlan | null> {
  try {
    const timeframe = market === 'crypto' ? '4h' : '1d'
    const [ticker, candles] = await Promise.all([getTicker(symbol, market), getCandles(symbol, market, timeframe)])
    if (!ticker || !(ticker.price > 0) || candles.length < 30) return null
    const snapshot = buildSnapshot(candles, {
      symbol: ticker.symbol,
      market,
      displayName: ticker.displayName,
      currency: ticker.currency,
      price: ticker.price,
      change24h: ticker.change24h,
      timeframe,
    })
    const plan = buildTradePlan(side, snapshot)
    if (!plan || !(plan.stop > 0) || !(plan.target1 > 0) || !(plan.target2 > 0)) return null
    if (side === 'LONG' && !(plan.target1 > plan.stop)) return null
    if (side === 'SHORT' && !(plan.target1 < plan.stop)) return null
    return {
      entryLow: roundPx(plan.entryLow),
      entryHigh: roundPx(plan.entryHigh),
      stop: roundPx(plan.stop),
      target1: roundPx(plan.target1),
      target2: roundPx(plan.target2),
      riskReward: plan.riskReward,
      atr: snapshot.atr && snapshot.atr > 0 ? roundPx(snapshot.atr) : null,
      regime: snapshot.regime,
      timeframe,
    }
  } catch {
    return null // a plan is an enhancement, never a blocker
  }
}
