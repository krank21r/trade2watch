/**
 * SMC engine — displacement candles (§14).
 *
 * A displacement candle is a candle whose BODY is at least
 * `cfg.displacementAtr` × ATR(14) — smart money stepping on the gas. Used as
 * confirmation of intent behind a structure break and as the AGGRESSIVE-mode
 * 5M entry trigger.
 */

import type { Candle } from '@/lib/market/indicators'
import type { DisplacementEvent, Direction } from './types'
import type { SmcCfg } from './cfg'

/** Latest displacement candle within the last `cfg.displacementLookback` candles. */
export function detectDisplacement(
  candles: Candle[],
  atrVal: number | null,
  cfg: SmcCfg,
): DisplacementEvent | null {
  if (atrVal === null || atrVal <= 0 || candles.length === 0) return null
  const window = candles.slice(-cfg.displacementLookback)
  let best: DisplacementEvent | null = null
  for (const c of window) {
    const body = Math.abs(c.close - c.open)
    const ratio = body / atrVal
    if (ratio < cfg.displacementAtr) continue
    const ev: DisplacementEvent = {
      direction: c.close >= c.open ? 'BULLISH' : 'BEARISH',
      time: c.time,
      body,
      atrRatio: ratio,
    }
    if (!best || ev.atrRatio > best.atrRatio) best = ev
  }
  return best
}

/**
 * First displacement candle with time >= fromTime (earliest in the leg),
 * optionally filtered by direction. Used by the order-block scorer to prove
 * strong displacement on the OB→BOS leg.
 */
export function findDisplacement(
  candles: Candle[],
  atrVal: number | null,
  cfg: SmcCfg,
  fromTime: number,
  direction?: Direction,
): DisplacementEvent | null {
  if (atrVal === null || atrVal <= 0) return null
  for (const c of candles) {
    if (c.time < fromTime) continue
    const body = Math.abs(c.close - c.open)
    if (body / atrVal < cfg.displacementAtr) continue
    const dir: Direction = c.close >= c.open ? 'BULLISH' : 'BEARISH'
    if (direction && dir !== direction) continue
    return { direction: dir, time: c.time, body, atrRatio: body / atrVal }
  }
  return null
}
