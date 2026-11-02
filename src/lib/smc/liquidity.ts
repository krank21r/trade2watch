/**
 * SMC engine — liquidity pools & sweeps (§12/§13).
 *
 * Buy-side liquidity rests ABOVE old highs (EQUAL_HIGH, PDH, PWH, SWING_HIGH),
 * sell-side liquidity below old lows. A SWEEP = a wick pushes through the
 * level by more than cfg.sweepWickAtr × ATR **and a LATER candle closes back
 * on the original side** (the stop-run that reverses). Wicks alone are not
 * sweeps, closes through are breakouts — only the wick-then-close-back
 * pattern marks liquidity taken.
 */

import type { Candle } from '@/lib/market/indicators'
import type { LiquidityLevel, LiquiditySweep, LiqType, SwingPoint } from './types'
import type { SmcCfg } from './cfg'

const HIGH_TYPES: LiqType[] = ['EQUAL_HIGH', 'PDH', 'PWH', 'SWING_HIGH']
const LOW_TYPES: LiqType[] = ['EQUAL_LOW', 'PDL', 'PWL', 'SWING_LOW']

export function isHighType(t: LiqType): boolean {
  return HIGH_TYPES.includes(t)
}

interface SweepOutcome {
  swept: boolean
  sweptAt: number | null
  extreme: number
}

/** Walk candles after level.time: wick beyond level → candidate; later close back → swept. */
function sweepOutcome(
  level: LiquidityLevel,
  candles: Candle[],
  atrVal: number | null,
  tfMs: number,
  cfg: SmcCfg,
): SweepOutcome {
  const out: SweepOutcome = { swept: false, sweptAt: null, extreme: level.price }
  if (atrVal === null || atrVal <= 0) return out
  const threshold = cfg.sweepWickAtr * atrVal
  const high = isHighType(level.type)
  let crossed = false
  for (const c of candles) {
    if (c.time <= level.time) continue
    if (high) {
      if (c.high - level.price > threshold) {
        crossed = true
        out.extreme = Math.max(out.extreme, c.high)
      } else if (crossed && c.close < level.price) {
        out.swept = true
        out.sweptAt = c.time + tfMs
        return out
      }
    } else {
      if (level.price - c.low > threshold) {
        crossed = true
        out.extreme = Math.min(out.extreme, c.low)
      } else if (crossed && c.close > level.price) {
        out.swept = true
        out.sweptAt = c.time + tfMs
        return out
      }
    }
  }
  return out
}

function utcDayKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

/** ISO-8601 week key (Mon–Sun), UTC based. */
function isoWeekKey(ms: number): string {
  const d = new Date(Date.UTC(new Date(ms).getUTCFullYear(), new Date(ms).getUTCMonth(), new Date(ms).getUTCDate()))
  const dayNum = d.getUTCDay() || 7
  d.setUTCDate(d.getUTCDate() + 4 - dayNum) // this week's Thursday
  const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1)
  const week = Math.ceil(((d.getTime() - yearStart) / 86_400_000 + 1) / 7)
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`
}

function dayExtreme(candles: Candle[], key: string, wantHigh: boolean): { price: number; time: number } | null {
  let best: { price: number; time: number } | null = null
  for (const c of candles) {
    if (utcDayKey(c.time) !== key) continue
    const price = wantHigh ? c.high : c.low
    if (!best || (wantHigh ? price > best.price : price < best.price)) best = { price, time: c.time }
  }
  return best
}

function weekExtreme(candles: Candle[], key: string, wantHigh: boolean): { price: number; time: number } | null {
  let best: { price: number; time: number } | null = null
  for (const c of candles) {
    if (isoWeekKey(c.time) !== key) continue
    const price = wantHigh ? c.high : c.low
    if (!best || (wantHigh ? price > best.price : price < best.price)) best = { price, time: c.time }
  }
  return best
}

export function detectLiquidity(
  candles1H: Candle[],
  swings1H: SwingPoint[],
  atrVal: number | null,
  tfMs: number,
  cfg: SmcCfg,
  candles15M: Candle[],
  candles1D: Candle[],
): LiquidityLevel[] {
  const levels: LiquidityLevel[] = []

  // ── EQUAL_HIGH / EQUAL_LOW (§12): consecutive same-kind confirmed swings
  // within cfg.equalToleranceAtr × ATR of each other. Level sits at the LATER
  // swing (that is the pooled stop cluster). ─────────────────────────────────
  if (atrVal !== null && atrVal > 0) {
    const tol = cfg.equalToleranceAtr * atrVal
    for (const kind of ['HIGH', 'LOW'] as const) {
      const swings = swings1H
        .filter((s) => s.kind === kind && s.confirmedAt !== null)
        .sort((a, b) => a.time - b.time)
      for (let i = 1; i < swings.length; i++) {
        if (Math.abs(swings[i].price - swings[i - 1].price) <= tol) {
          levels.push({
            type: kind === 'HIGH' ? 'EQUAL_HIGH' : 'EQUAL_LOW',
            price: swings[i].price,
            strength: 70,
            time: swings[i].time,
            swept: false,
            sweptAt: null,
          })
        }
      }
    }
  }

  // ── SWING_HIGH / SWING_LOW: last 6 UNBROKEN confirmed swings (no later
  // close beyond them), strength 40 + recency bonus up to 60. ────────────────
  for (const kind of ['HIGH', 'LOW'] as const) {
    const confirmed = swings1H
      .filter((s) => s.kind === kind && s.confirmedAt !== null)
      .sort((a, b) => a.time - b.time)
    const unbroken = confirmed.filter((s) => {
      for (const c of candles1H) {
        if (c.time <= s.time) continue
        if (kind === 'HIGH' ? c.close > s.price : c.close < s.price) return false
      }
      return true
    })
    const last6 = unbroken.slice(-6)
    last6.forEach((s, pos) => {
      const bonus = last6.length > 1 ? Math.round((20 * pos) / (last6.length - 1)) : 20
      levels.push({
        type: kind === 'HIGH' ? 'SWING_HIGH' : 'SWING_LOW',
        price: s.price,
        strength: Math.min(60, 40 + bonus),
        time: s.time,
        swept: false,
        sweptAt: null,
      })
    })
  }

  // ── PDH / PDL: previous COMPLETE UTC day from the 15M series, strength 80 ──
  if (candles15M.length > 0) {
    const today = utcDayKey(Date.now())
    const days = [...new Set(candles15M.map((c) => utcDayKey(c.time)))].sort()
    const prevDay = [...days].reverse().find((d) => d < today)
    if (prevDay) {
      const h = dayExtreme(candles15M, prevDay, true)
      const l = dayExtreme(candles15M, prevDay, false)
      if (h) levels.push({ type: 'PDH', price: h.price, strength: 80, time: h.time, swept: false, sweptAt: null })
      if (l) levels.push({ type: 'PDL', price: l.price, strength: 80, time: l.time, swept: false, sweptAt: null })
    }
  }

  // ── PWH / PWL: previous COMPLETE ISO week from the 1D series, strength 90 ──
  if (candles1D.length > 0) {
    const thisWeek = isoWeekKey(Date.now())
    const weeks = [...new Set(candles1D.map((c) => isoWeekKey(c.time)))].sort()
    const prevWeek = [...weeks].reverse().find((w) => w < thisWeek)
    if (prevWeek) {
      const h = weekExtreme(candles1D, prevWeek, true)
      const l = weekExtreme(candles1D, prevWeek, false)
      if (h) levels.push({ type: 'PWH', price: h.price, strength: 90, time: h.time, swept: false, sweptAt: null })
      if (l) levels.push({ type: 'PWL', price: l.price, strength: 90, time: l.time, swept: false, sweptAt: null })
    }
  }

  // ── sweep marking ──────────────────────────────────────────────────────────
  for (const lvl of levels) {
    const o = sweepOutcome(lvl, candles1H, atrVal, tfMs, cfg)
    lvl.swept = o.swept
    lvl.sweptAt = o.sweptAt
  }

  // ── dedupe within tolerance, keep the strongest pool ───────────────────────
  const tol = atrVal !== null && atrVal > 0 ? cfg.equalToleranceAtr * atrVal : 0
  const kept: LiquidityLevel[] = []
  for (const lvl of [...levels].sort((a, b) => b.strength - a.strength)) {
    if (!Number.isFinite(lvl.price) || lvl.price <= 0) continue
    if (kept.some((k) => Math.abs(k.price - lvl.price) <= tol)) continue
    kept.push(lvl)
  }
  return kept
}

const SWEEP_BASE: Record<LiqType, number> = {
  PWH: 95,
  PWL: 95,
  PDH: 85,
  PDL: 85,
  EQUAL_HIGH: 80,
  EQUAL_LOW: 80,
  SWING_HIGH: 50,
  SWING_LOW: 50,
}

export function detectSweeps(
  levels: LiquidityLevel[],
  candles1H: Candle[],
  atrVal: number | null,
  tfMs: number,
  cfg: SmcCfg,
): LiquiditySweep[] {
  const out: LiquiditySweep[] = []
  for (const lvl of levels) {
    if (!lvl.swept || lvl.sweptAt === null) continue
    const o = sweepOutcome(lvl, candles1H, atrVal, tfMs, cfg)
    if (!o.swept || o.sweptAt === null) continue
    const depthAtr = atrVal && atrVal > 0 ? Math.abs(o.extreme - lvl.price) / atrVal : 0
    const bonus = Math.min(15, Math.round(depthAtr * 10)) // wick-depth bonus
    out.push({
      direction: isHighType(lvl.type) ? 'BEARISH' : 'BULLISH',
      levelType: lvl.type,
      level: lvl.price,
      extreme: o.extreme,
      confirmedAt: o.sweptAt,
      strength: Math.min(100, SWEEP_BASE[lvl.type] + bonus),
    })
  }
  return out.sort((a, b) => b.confirmedAt - a.confirmedAt).slice(0, 20)
}
