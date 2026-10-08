/**
 * SMC engine — signal scoring & quality bands (§21/§50).
 *
 * scoreCandidate applies cfg.scoreWeights (max 100) to the confluence parts
 * and returns ALL TEN reason rows every time — a missing factor is a row with
 * 0 points and result 'MISSING' / 'NOT MET' (§50 explainability: the UI shows
 * the whole checklist, not just the hits).
 */

import type { DisplacementEvent, Direction, FVG, LiquiditySweep, OrderBlock, Reason, StructureEvent } from './types'
import type { SmcCfg } from './cfg'

export interface ScoreInput {
  /** intended trade direction ('BULLISH' for LONG / 'BEARISH' for SHORT) */
  side: Direction
  /** 4H bias */
  htfTrend: 'BULLISH' | 'BEARISH' | 'NEUTRAL'
  /** recent 1H structure events (already windowed to cfg.bosRecencyBars) */
  recent1HEvents: StructureEvent[]
  /** recent sweeps (already filtered to the relevant window by the caller) */
  recentSweeps: LiquiditySweep[]
  /** the candidate order block */
  ob: OrderBlock | null
  /** matching ACTIVE/PARTIALLY_FILLED FVG near the OB (or null) */
  fvg: FVG | null
  /** matching recent displacement (or null) */
  displacement: DisplacementEvent | null
  /** 1H volume_ratio */
  volumeRatio: number | null
  /** RR at TP2 from the trade plan (null when no plan) */
  rr2: number | null
}

export interface ScoreResult {
  score: number
  quality: 'A+' | 'A' | 'B' | 'C' | '—'
  reasons: Reason[]
}

export function scoreCandidate(input: ScoreInput, cfg: SmcCfg): ScoreResult {
  const w = cfg.scoreWeights
  const reasons: Reason[] = []

  // ── htfAlignment (20): 4H bias matches the side ──────────────────────────
  reasons.push({
    factor: 'HTF alignment',
    result: input.htfTrend === input.side ? 'MET' : 'NOT MET',
    points: input.htfTrend === input.side ? w.htfAlignment : 0,
  })

  // ── bos (15): recent 1H BOS in the side's direction ───────────────────────
  const bosHit = input.recent1HEvents.some((e) => e.type === 'BOS' && e.direction === input.side)
  const bosWrong = !bosHit && input.recent1HEvents.some((e) => e.type === 'BOS')
  reasons.push({
    factor: 'Recent BOS (1H)',
    result: bosHit ? 'MET' : input.recent1HEvents.length === 0 ? 'MISSING' : bosWrong ? 'NOT MET' : 'MISSING',
    points: bosHit ? w.bos : 0,
  })

  // ── choch (10): recent CHoCH in the side's direction ──────────────────────
  const chochHit = input.recent1HEvents.some((e) => e.type === 'CHOCH' && e.direction === input.side)
  const chochAny = input.recent1HEvents.some((e) => e.type === 'CHOCH')
  reasons.push({
    factor: 'Recent CHoCH (1H)',
    result: chochHit ? 'MET' : chochAny ? 'NOT MET' : 'MISSING',
    points: chochHit ? w.choch : 0,
  })

  // ── liquiditySweep (15): matching recent sweep ────────────────────────────
  const sweepHit = input.recentSweeps.some((s) => s.direction === input.side)
  reasons.push({
    factor: 'Liquidity sweep',
    result: sweepHit ? 'MET' : input.recentSweeps.length === 0 ? 'MISSING' : 'NOT MET',
    points: sweepHit ? w.liquiditySweep : 0,
  })

  // ── obQuality (10): OB strength bands ─────────────────────────────────────
  const obPts = !input.ob ? 0 : input.ob.strengthScore >= 70 ? w.obQuality : input.ob.strengthScore >= 50 ? 5 : 0
  reasons.push({
    factor: 'Order block quality',
    result: !input.ob ? 'MISSING' : obPts > 0 ? 'MET' : 'NOT MET',
    points: obPts,
  })

  // ── fvg (10): matching active FVG near the OB ─────────────────────────────
  const fvgHit =
    input.fvg !== null &&
    input.fvg.direction === input.side &&
    (input.fvg.status === 'ACTIVE' || input.fvg.status === 'PARTIALLY_FILLED')
  reasons.push({
    factor: 'FVG confluence',
    result: input.fvg === null ? 'MISSING' : fvgHit ? 'MET' : 'NOT MET',
    points: fvgHit ? w.fvg : 0,
  })

  // ── displacement (5): matching recent displacement candle ─────────────────
  const dispHit = input.displacement !== null && input.displacement.direction === input.side
  reasons.push({
    factor: 'Displacement',
    result: input.displacement === null ? 'MISSING' : dispHit ? 'MET' : 'NOT MET',
    points: dispHit ? w.displacement : 0,
  })

  // ── volume (5): 1H volume_ratio ≥ threshold ───────────────────────────────
  const volHit = input.volumeRatio !== null && input.volumeRatio >= cfg.volumeThreshold
  reasons.push({
    factor: 'Volume expansion',
    result: input.volumeRatio === null ? 'MISSING' : volHit ? 'MET' : 'NOT MET',
    points: volHit ? w.volume : 0,
  })

  // ── rr (5): RR at TP2 meets the minimum ───────────────────────────────────
  const rrHit = input.rr2 !== null && input.rr2 >= cfg.minimumRr
  reasons.push({
    factor: `Risk-reward ≥ ${cfg.minimumRr}R`,
    result: input.rr2 === null ? 'MISSING' : rrHit ? 'MET' : 'NOT MET',
    points: rrHit ? w.rr : 0,
  })

  // ── freshOb (5): OB never traded back into ────────────────────────────────
  reasons.push({
    factor: 'Fresh order block',
    result: !input.ob ? 'MISSING' : input.ob.fresh ? 'MET' : 'NOT MET',
    points: input.ob?.fresh ? w.freshOb : 0,
  })

  const score = Math.min(100, reasons.reduce((a, r) => a + r.points, 0))
  const qb = cfg.qualityBands
  const quality: ScoreResult['quality'] =
    score >= qb.aPlus ? 'A+' : score >= qb.a ? 'A' : score >= qb.b ? 'B' : score >= qb.c ? 'C' : '—'
  return { score, quality, reasons }
}
