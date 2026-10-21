/**
 * Trader Desk — signal direction + levels.
 *
 * The desk pipeline (budget sizing → risk gate → tickets → portfolio) was
 * removed at the user's request. What remains is the deterministic signal
 * engine: for a screener row it builds the trade plan the AI Signals desk
 * uses (buildTradePlan on a fresh technical snapshot) — in exactly ONE
 * direction. A LONG plan puts an entry zone at/below price with a structural
 * stop beneath it and R:R-floored targets above; a SHORT plan mirrors it
 * above price. Which side is picked comes from decideSide(): a weighted vote
 * of the snapshot's own evidence (regime, EMA stack, slope, MACD, RSI, range
 * position) plus the screener's 7d/30d momentum — the side with more
 * evidence wins, so every asset arrives as either a LONG or a SHORT signal,
 * never both. "I took this trade" freezes the plan into the shared trade
 * journal (src/lib/mytrades.ts), which does all the tracking (TP1 → stop to
 * entry, TP2 = full win, SL = stopped out).
 */

import { getTicker, getCandles } from '@/lib/market/providers'
import { buildSnapshot, type TechnicalSnapshot } from '@/lib/market/snapshot'
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

export interface DeskSignal {
  /** The ONE direction the analysis picked — every asset is LONG or SHORT, never both. */
  side: 'LONG' | 'SHORT'
  /** Human-readable evidence behind the direction pick ("uptrend regime · price above EMA50 …"). */
  reason: string
  plan: TicketPlan
}

interface Vote {
  side: 'LONG' | 'SHORT'
  w: number
  label: string
}

/**
 * Weighted technical vote that commits to ONE side per asset.
 *
 * Evidence (weights chosen so a genuine trend always beats a minor wobble):
 *   regime TRENDING_UP/DOWN        ±3
 *   price above/below EMA50        ±1.5
 *   EMA20 above/below EMA50        ±1
 *   20-bar slope positive/negative ±1
 *   MACD histogram positive/neg.   ±1
 *   RSI(14) ≥/< 50                 ±0.5
 *   screener 7d / 30d momentum     ±1 each
 *   RANGING only: price hugging    ±1 (fade the range edge, matching the
 *   the range low/high                 plan engine's range-bottom/top strategy)
 *
 * Ties break on 7d momentum, then 24h change, then LONG.
 */
export function decideSide(
  s: TechnicalSnapshot,
  momentum?: { d7?: number; d30?: number; d24?: number },
): { side: 'LONG' | 'SHORT'; reason: string } {
  const votes: Vote[] = []
  const add = (side: 'LONG' | 'SHORT', w: number, label: string) => votes.push({ side, w, label })

  if (s.regime === 'TRENDING_UP') add('LONG', 3, `${s.timeframe} uptrend regime`)
  if (s.regime === 'TRENDING_DOWN') add('SHORT', 3, `${s.timeframe} downtrend regime`)

  if (s.ema50 !== null && s.price !== s.ema50)
    add(s.price > s.ema50 ? 'LONG' : 'SHORT', 1.5, `price ${s.price > s.ema50 ? 'above' : 'below'} EMA50`)
  if (s.ema20 !== null && s.ema50 !== null && s.ema20 !== s.ema50)
    add(s.ema20 > s.ema50 ? 'LONG' : 'SHORT', 1, `EMA20 ${s.ema20 > s.ema50 ? 'above' : 'below'} EMA50`)
  if (s.slope !== 0) add(s.slope > 0 ? 'LONG' : 'SHORT', 1, `${s.timeframe} slope ${s.slope > 0 ? '+' : ''}${s.slope.toFixed(2)}%/bar`)
  if (s.macd && s.macd.hist !== 0) add(s.macd.hist > 0 ? 'LONG' : 'SHORT', 1, `MACD ${s.macd.hist > 0 ? 'bullish' : 'bearish'}`)
  if (s.rsi14 !== null && s.rsi14 !== 50) add(s.rsi14 > 50 ? 'LONG' : 'SHORT', 0.5, `RSI ${s.rsi14.toFixed(0)}`)

  if (s.regime === 'RANGING') {
    // range-edge context only — aligns the side with where the plan engine
    // would place the entry (range-bottom fade long / range-top fade short)
    if (s.pctFromRangeLow < 12) add('LONG', 1, 'price near the range low')
    if (s.pctFromRangeHigh > -12) add('SHORT', 1, 'price near the range high')
  }

  if (momentum?.d7 !== undefined && momentum.d7 !== 0)
    add(momentum.d7 > 0 ? 'LONG' : 'SHORT', 1, `7d momentum ${momentum.d7 > 0 ? '+' : ''}${momentum.d7.toFixed(1)}%`)
  if (momentum?.d30 !== undefined && momentum.d30 !== 0)
    add(momentum.d30 > 0 ? 'LONG' : 'SHORT', 1, `30d momentum ${momentum.d30 > 0 ? '+' : ''}${momentum.d30.toFixed(1)}%`)

  let bull = 0
  let bear = 0
  for (const v of votes) {
    if (v.side === 'LONG') bull += v.w
    else bear += v.w
  }

  let side: 'LONG' | 'SHORT'
  if (bull > bear) side = 'LONG'
  else if (bear > bull) side = 'SHORT'
  else if (momentum?.d7 !== undefined && momentum.d7 !== 0) side = momentum.d7 > 0 ? 'LONG' : 'SHORT'
  else if (momentum?.d24 !== undefined && momentum.d24 !== 0) side = momentum.d24 > 0 ? 'LONG' : 'SHORT'
  else side = 'LONG'

  // reason = the winning side's strongest evidence, heaviest first
  const reason = votes
    .filter((v) => v.side === side)
    .sort((a, b) => b.w - a.w)
    .slice(0, 4)
    .map((v) => v.label)
    .join(' · ')
  return { side, reason: reason || 'technical read balanced — defaulting long' }
}

/**
 * The desk signal for one asset: fresh technical snapshot → ONE direction
 * (decideSide) → deterministic plan for that direction. Returns null when
 * the market data cannot support a signal; the row then renders "—" and
 * cannot be taken.
 */
export async function deskSignal(
  symbol: string,
  market: 'crypto' | 'stock',
  momentum?: { d7?: number; d30?: number; d24?: number },
): Promise<DeskSignal | null> {
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
    const { side, reason } = decideSide(snapshot, momentum)
    const plan = buildTradePlan(side, snapshot)
    if (!plan || !(plan.stop > 0) || !(plan.target1 > 0) || !(plan.target2 > 0)) return null
    if (side === 'LONG' && !(plan.target1 > plan.stop)) return null
    if (side === 'SHORT' && !(plan.target1 < plan.stop)) return null
    return {
      side,
      reason,
      plan: {
        entryLow: roundPx(plan.entryLow),
        entryHigh: roundPx(plan.entryHigh),
        stop: roundPx(plan.stop),
        target1: roundPx(plan.target1),
        target2: roundPx(plan.target2),
        riskReward: plan.riskReward,
        atr: snapshot.atr && snapshot.atr > 0 ? roundPx(snapshot.atr) : null,
        regime: snapshot.regime,
        timeframe,
      },
    }
  } catch {
    return null // a signal is an enhancement, never a blocker
  }
}
