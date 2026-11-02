/**
 * SMC strategy configuration (§40) — every tunable in ONE place.
 * Defaults follow the build spec; nothing here is claimed to be optimal.
 */

import type { StrategyMode, TF } from './types'

export const SMC_CONFIG = {
  symbol: 'BTCUSDT',

  // swing sensitivity (§6)
  swingLeft: 2,
  swingRight: 2,

  // indicators (§14/§15)
  atrPeriod: 14,
  volumePeriod: 20,
  volumeThreshold: 1.5, // volume_ratio >= 1.5 → expansion

  // displacement (§14)
  displacementAtr: 1.2, // body >= 1.2 × ATR(14)
  displacementLookback: 6, // ...within the last N candles

  // risk (§19)
  slMode: 'ORDER_BLOCK_STOP' as 'ORDER_BLOCK_STOP' | 'STRUCTURE_STOP' | 'ATR_STOP',
  slAtrBuffer: 0.15, // SL = OB extreme ∓ 0.15 × ATR(14)

  // entry (§17/§18/§47)
  mode: 'STRICT' as StrategyMode,
  entryModel: 'OB_RANGE' as 'OB_RANGE' | 'OB_MIDPOINT' | 'FVG_OVERLAP',
  entryConfirmationTimeframe: '5M' as TF,
  entryModeA: 'CONSERVATIVE' as 'CONSERVATIVE' | 'AGGRESSIVE', // 5M CHoCH+BOS vs 5M displacement

  // gates (§20/§21/§45)
  minimumRr: 2.0, // RR at TP2 must meet this or the setup is rejected
  minimumScore: 80, // LONG/SHORT only when score >= 80 (STRICT)

  // freshness windows (in bars of the relevant timeframe)
  obExpiryBars: 120, // OB older than N bars on its own TF → EXPIRED
  sweepRecencyBars: 12, // sweep must have happened within N bars before/around OB leg
  confirm15Lookback: 10, // 15M confirmation within last N 15M candles
  confirm5Lookback: 12, // 5M confirmation within last N 5M candles
  bosRecencyBars: 30, // "recent" BOS/CHoCH window for the structure flag

  // liquidity (§12/§13)
  equalToleranceAtr: 0.12, // equal highs/lows tolerance × ATR
  sweepWickAtr: 0.05, // wick must exceed the level by ≥ this × ATR to count

  // order blocks (§9/§10)
  obRangeMode: 'FULL_RANGE' as 'FULL_RANGE' | 'BODY_ONLY',
  obMaxDisplacementGap: 4, // displacement/BOS must occur within N candles after the OB candle

  // OB strength weights (§10) — max 100
  obScoreWeights: {
    bos: 20,
    htfAlignment: 20,
    liquiditySweep: 15,
    fvg: 10,
    strongDisplacement: 10,
    volumeExpansion: 5,
    fresh: 10,
    cleanStructure: 10,
  },

  // signal score weights (§21) — max 100
  scoreWeights: {
    htfAlignment: 20,
    bos: 15,
    choch: 10,
    liquiditySweep: 15,
    obQuality: 10,
    fvg: 10,
    displacement: 5,
    volume: 5,
    rr: 5,
    freshOb: 5,
  },

  // quality bands (§21)
  qualityBands: { aPlus: 90, a: 80, b: 70, c: 60 },

  // signal lifecycle (§34/§46)
  maxHoldDays: 10, // open signal older than this → EXPIRED
} as const

export const TF_MS: Record<TF, number> = {
  '1D': 86_400_000,
  '4H': 14_400_000,
  '1H': 3_600_000,
  '15M': 900_000,
  '5M': 300_000,
}

/** The analysis pipeline timeframes (§16/§28): 1D context is fetched but the strategy runs on these. */
export const STRATEGY_TFS: TF[] = ['4H', '1H', '15M', '5M']

export const SMC_DISCLAIMER =
  'This system provides technical market analysis and trade setups. It does not guarantee profitability. Signals should be independently reviewed before execution.'
