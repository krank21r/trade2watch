/**
 * Trader Desk — signal levels.
 *
 * The desk pipeline (budget sizing → risk gate → tickets → portfolio) was
 * removed at the user's request. What remains is the deterministic level
 * engine: for a screener passer it builds the same trade plan the AI Signals
 * desk uses (buildTradePlan on a fresh technical snapshot) — an entry zone
 * at/below price, a structural stop beneath it and R:R-floored targets above.
 * The screener attaches these to passing rows; "I took this trade" freezes
 * them into the shared trade journal (src/lib/mytrades.ts), which does all
 * the tracking (TP1 → stop to entry, TP2 = full win, SL = stopped out).
 */

import { getTicker, getCandles } from '@/lib/market/providers'
import { buildSnapshot } from '@/lib/market/snapshot'
import { buildTradePlan } from '@/lib/signals/engine'

const round2 = (x: number): number => Math.round(x * 100) / 100

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
 * Deterministic trade plan for a desk signal — LONG only (desk targets are
 * always buys). Returns null when the market data cannot support a plan; the
 * screener row then renders "—" and cannot be taken.
 */
export async function planLevels(symbol: string, market: 'crypto' | 'stock'): Promise<TicketPlan | null> {
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
    const plan = buildTradePlan('LONG', snapshot)
    if (!plan || !(plan.stop > 0) || !(plan.target1 > plan.stop)) return null
    return {
      entryLow: round2(plan.entryLow),
      entryHigh: round2(plan.entryHigh),
      stop: round2(plan.stop),
      target1: round2(plan.target1),
      target2: round2(plan.target2),
      riskReward: plan.riskReward,
      atr: snapshot.atr && snapshot.atr > 0 ? round2(snapshot.atr) : null,
      regime: snapshot.regime,
      timeframe,
    }
  } catch {
    return null // a plan is an enhancement, never a blocker
  }
}
