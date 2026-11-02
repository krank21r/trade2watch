/**
 * SMC engine — shared config TYPE only.
 *
 * config.ts is a foundation file and stays untouched; this module derives the
 * structural config type from it so every engine module speaks about the same
 * tunable shape without duplicating it.
 */

import { SMC_CONFIG } from './config'
import type { StrategyMode } from './types'

export type SmcCfg = typeof SMC_CONFIG

/**
 * Score gate per strategy mode (§21 calibration).
 *
 * STRICT demands every confirmation (price in zone + 15M + 5M trigger), so
 * only A-grade (≥ 80) confluence qualifies. BALANCED / AGGRESSIVE already
 * trade confirmation strictness for frequency — the score gate relaxes by
 * the same step, otherwise B-grade setups (70–79) could NEVER fire in any
 * mode and the board would stay WATCHLIST forever. The +5 cross-exchange
 * confluence bonus (analysis.ts) applies on top of these thresholds.
 */
export function minimumScoreFor(mode: StrategyMode): number {
  switch (mode) {
    case 'STRICT':
      return SMC_CONFIG.minimumScore // 80 — every gate
    case 'BALANCED':
      return SMC_CONFIG.minimumScore - 5 // 75 — 5M trigger skipped
    case 'AGGRESSIVE':
      return SMC_CONFIG.minimumScore - 10 // 70 — zone + structure only
  }
}
