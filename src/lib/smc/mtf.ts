/**
 * SMC engine — multi-timeframe summary strip (§16/§28).
 *
 * Turns per-TF analysis results into the human-readable TfSummary rows the UI
 * renders (4H bias → 1H structure → 15M setup → 5M entry) plus the top-level
 * market_bias: the 4H trend when decisive, else the 1D/1H fallback.
 */

import type { DisplacementEvent, StructureEvent, TF, TfSummary } from './types'
import { recentEvents } from './structure'
import type { SmcCfg } from './cfg'

export interface MtfTfInput {
  tf: TF
  price: number
  trend: 'BULLISH' | 'BEARISH' | 'NEUTRAL'
  events: StructureEvent[]
  atr: number | null
  volumeRatio: number | null
  /** open time of this TF's last CLOSED candle — the "now" of the series */
  lastCandleTime: number
  tfMs: number
  displacement: DisplacementEvent | null
}

export interface MtfResult {
  marketBias: 'BULLISH' | 'BEARISH' | 'NEUTRAL'
  perTf: Record<'4H' | '1H' | '15M' | '5M', TfSummary>
}

function summarize(input: MtfTfInput, cfg: SmcCfg): { note: string; bos: boolean; choch: boolean } {
  // "now" for the recency window = close time of the last closed candle.
  const recent = recentEvents(input.events, input.tfMs, cfg.bosRecencyBars, input.lastCandleTime + input.tfMs)
  const bos =
    input.trend !== 'NEUTRAL' && recent.some((e) => e.type === 'BOS' && e.direction === input.trend)
  const choch = recent.some((e) => e.type === 'CHOCH')

  const last = recent.length > 0 ? recent[recent.length - 1] : null
  if (!last) {
    const disp = input.displacement
      ? ` · ${input.displacement.direction.toLowerCase()} displacement`
      : ''
    return { note: `no recent break${disp}`, bos: false, choch: false }
  }
  const age = Math.max(0, Math.round((input.lastCandleTime - last.candleTime) / input.tfMs))
  const ageTxt = age === 0 ? 'just now' : `${age} candle${age === 1 ? '' : 's'} ago`
  const extra = input.displacement ? ' · displacement' : ''
  return {
    note: `${last.direction.toLowerCase()} ${last.type} ${ageTxt}${extra}`,
    bos,
    choch,
  }
}

export function buildMtfs(
  inputs: Record<'4H' | '1H' | '15M' | '5M', MtfTfInput>,
  cfg: SmcCfg,
  d1Trend?: 'BULLISH' | 'BEARISH' | 'NEUTRAL',
): MtfResult {
  const perTf = {} as Record<'4H' | '1H' | '15M' | '5M', TfSummary>
  ;(['4H', '1H', '15M', '5M'] as const).forEach((tf) => {
    const input = inputs[tf]
    const { note, bos, choch } = summarize(input, cfg)
    perTf[tf] = {
      tf,
      price: input.price,
      trend: input.trend,
      note,
      bos,
      choch,
      atr: input.atr,
      volumeRatio: input.volumeRatio,
    }
  })

  const t4 = inputs['4H'].trend
  const t1 = inputs['1H'].trend
  const marketBias = t4 !== 'NEUTRAL' ? t4 : d1Trend && d1Trend !== 'NEUTRAL' ? d1Trend : t1
  return { marketBias, perTf }
}
