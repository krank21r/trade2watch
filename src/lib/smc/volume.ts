/**
 * SMC engine — relative volume (§15).
 *
 * volume_ratio = last closed candle volume / SMA(volume, period over the
 * candles BEFORE it). >= cfg.volumeThreshold (1.5) means a volume expansion —
 * institutional participation behind the move.
 */

import type { Candle } from '@/lib/market/indicators'

export function volumeRatio(candles: Candle[], period: number): number | null {
  const n = candles.length
  if (period <= 0 || n < period + 1) return null
  const last = candles[n - 1].volume
  let sum = 0
  for (let i = n - 1 - period; i <= n - 2; i++) sum += candles[i].volume
  const avg = sum / period
  if (avg <= 0) return null
  return last / avg
}
