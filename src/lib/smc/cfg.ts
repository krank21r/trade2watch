/**
 * SMC engine — shared config TYPE only.
 *
 * config.ts is a foundation file and stays untouched; this module derives the
 * structural config type from it so every engine module speaks about the same
 * tunable shape without duplicating it.
 */

import { SMC_CONFIG } from './config'

export type SmcCfg = typeof SMC_CONFIG
