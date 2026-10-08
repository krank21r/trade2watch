/**
 * SMC engine — orchestrator (§23/§25/§28/§34/§46).
 *
 * runSmcAnalysis(symbol, mode?) runs the full pipeline over CLOSED candles:
 *   market data → per-TF analysis (ATR / swings / structure / displacement /
 *   volume) → liquidity map + sweeps → 1H order blocks → multi-TF summary →
 *   signal evaluation → trade plan → persistence (dedupe + lifecycle) →
 *   the exact SmcAnalysis payload.
 *
 * Persistence (§34/§46):
 *   - LONG/SHORT setups are deduped by (symbol, obTime, direction). A setup
 *     whose row already CLOSED is never resurrected — the displayed signal
 *     downgrades to NO_TRADE.
 *   - Open rows (ACTIVE/TP1_HIT/TP2_HIT) are tracked against 5M closes with
 *     the PESSIMISTIC same-candle rule (SL before TPs).
 *
 * NO trading logic anywhere — analysis, signals and records only (§58).
 */

import { db } from '@/lib/db'
import type { Candle } from '@/lib/market/indicators'
import { SMC_CONFIG, SMC_DISCLAIMER, TF_MS } from './config'
import type { SmcCfg } from './cfg'
import type {
  FVG,
  LiquidityLevel,
  LiquiditySweep,
  OrderBlock,
  Reason,
  SmcAnalysis,
  SmcHistoryRow,
  StrategyMode,
  StructureEvent,
  SwingPoint,
  TF,
} from './types'
import { loadSmcMarketData } from './bybit'
import { atr } from './atr'
import { detectSwings } from './swings'
import { analyzeStructure } from './structure'
import { detectDisplacement } from './displacement'
import { volumeRatio } from './volume'
import { detectFvgs } from './fvg'
import { detectOrderBlocks, isActiveOb } from './orderblocks'
import { detectLiquidity, detectSweeps } from './liquidity'
import { buildMtfs, type MtfTfInput } from './mtf'
import { evaluateSignal } from './signal'
import type { TradePlan } from './risk'

interface TfAnalysis {
  tf: TF
  candles: Candle[]
  atr: number | null
  swings: SwingPoint[]
  events: StructureEvent[]
  trend: 'BULLISH' | 'BEARISH' | 'NEUTRAL'
  displacement: ReturnType<typeof detectDisplacement>
  volumeRatio: number | null
  lastCandleTime: number
}

function analyzeTf(tf: TF, candles: Candle[], cfg: SmcCfg): TfAnalysis {
  const tfMs = TF_MS[tf]
  const atrVal = atr(candles, cfg.atrPeriod)
  const swings = detectSwings(candles, cfg.swingLeft, cfg.swingRight, tfMs)
  const { events, trend } = analyzeStructure(candles, swings, tfMs, cfg, atrVal)
  return {
    tf,
    candles,
    atr: atrVal,
    swings,
    events,
    trend,
    displacement: detectDisplacement(candles, atrVal, cfg),
    volumeRatio: volumeRatio(candles, cfg.volumePeriod),
    lastCandleTime: candles.length > 0 ? candles[candles.length - 1].time : 0,
  }
}

const round = (n: number, d = 4) => Math.round(n * 10 ** d) / 10 ** d

// ─── persistence (SQLite via Prisma) ─────────────────────────────────────────

interface OpenRow {
  id: string
  direction: string
  entryMid: number
  stopLoss: number
  tp1: number
  tp2: number
  tp3: number
  status: string
  result: string | null
  rMultiple: number | null
  tp1At: number | null
  tp2At: number | null
  tp3At: number | null
  slAt: number | null
  closedAt: number | null
  createdAt: number
}

/**
 * Track open signal rows against closed 5M candles. PESSIMISTIC same-candle
 * rule: within one candle the stop is checked BEFORE the targets. A row whose
 * result is already banked (WIN at TP2) keeps its economic outcome — later
 * stops only close the row, they do not downgrade a resolved trade.
 */
async function updateLifecycle(symbol: string, candles5M: Candle[], cfg: SmcCfg, now: number): Promise<void> {
  const openRows = (await db.smcSignal.findMany({
    where: { symbol, status: { in: ['ACTIVE', 'TP1_HIT', 'TP2_HIT'] } },
  })) as OpenRow[]

  for (const row of openRows) {
    const risk = row.direction === 'LONG' ? row.entryMid - row.stopLoss : row.stopLoss - row.entryMid
    if (!(risk > 0)) continue // degenerate row — leave untouched
    const rAt = (p: number) =>
      row.direction === 'LONG' ? (p - row.entryMid) / risk : (row.entryMid - p) / risk

    // only candles that CLOSED after the row was created
    const relevant = candles5M.filter((c) => c.time + TF_MS['5M'] > row.createdAt)

    let { status, result, rMultiple, tp1At, tp2At, tp3At, slAt, closedAt } = row
    for (const c of relevant) {
      if (status === 'TP3_HIT' || status === 'SL_HIT' || status === 'EXPIRED') break
      const closeTime = c.time + TF_MS['5M']
      const long = row.direction === 'LONG'

      // pessimistic: stop first within the same candle
      const stopped = long ? c.low <= row.stopLoss : c.high >= row.stopLoss
      if (stopped) {
        slAt = closeTime
        status = 'SL_HIT'
        closedAt = closeTime
        if (result === null) {
          if (tp1At === null) {
            result = 'LOSS'
            rMultiple = -1
          } else {
            result = 'BREAKEVEN'
            rMultiple = round(0.5 * rAt(row.tp1))
          }
        }
        break
      }

      const hit1 = long ? c.high >= row.tp1 : c.low <= row.tp1
      const hit2 = long ? c.high >= row.tp2 : c.low <= row.tp2
      const hit3 = long ? c.high >= row.tp3 : c.low <= row.tp3
      if (tp1At === null && hit1) {
        tp1At = closeTime
        status = 'TP1_HIT'
      }
      if (tp2At === null && hit2) {
        tp2At = closeTime
        status = 'TP2_HIT'
        if (result === null) {
          result = 'WIN'
          rMultiple = round(0.5 * rAt(row.tp1) + 0.5 * rAt(row.tp2))
        }
      }
      if (hit3) {
        tp3At = closeTime
        status = 'TP3_HIT'
        closedAt = closeTime
        if (result === null) {
          result = 'WIN'
          rMultiple = round(0.5 * rAt(row.tp1) + 0.5 * rAt(row.tp2))
        }
        break
      }
    }

    // expiry: open past cfg.maxHoldDays → EXPIRED at the last 5M close
    const stillOpen = status === 'ACTIVE' || status === 'TP1_HIT' || status === 'TP2_HIT'
    if (stillOpen && result === null && now - row.createdAt > cfg.maxHoldDays * 86_400_000) {
      const lastClose = candles5M.length > 0 ? candles5M[candles5M.length - 1].close : row.entryMid
      status = 'EXPIRED'
      result = 'EXPIRED'
      rMultiple = round(rAt(lastClose))
      closedAt = now
    }

    const changed =
      status !== row.status ||
      result !== row.result ||
      rMultiple !== row.rMultiple ||
      tp1At !== row.tp1At ||
      tp2At !== row.tp2At ||
      tp3At !== row.tp3At ||
      slAt !== row.slAt ||
      closedAt !== row.closedAt
    if (changed) {
      await db.smcSignal.update({
        where: { id: row.id },
        data: { status, result, rMultiple, tp1At, tp2At, tp3At, slAt, closedAt, updatedAt: now },
      })
    }
  }
}

// ─── response cache (30s, keyed symbol+mode) ─────────────────────────────────

const respCache = new Map<string, { at: number; data: SmcAnalysis }>()
const RESP_TTL = 30_000

export async function runSmcAnalysis(symbol: string, mode?: StrategyMode): Promise<SmcAnalysis> {
  const cfg: SmcCfg = { ...SMC_CONFIG, mode: mode ?? SMC_CONFIG.mode }
  const cacheKey = `${symbol.toUpperCase()}:${cfg.mode}`
  const hit = respCache.get(cacheKey)
  if (hit && Date.now() - hit.at < RESP_TTL) return hit.data

  // ── market data (closed candles only, Bybit → Binance fallback) ───────────
  const tfs: TF[] = ['1D', '4H', '1H', '15M', '5M']
  const data = await loadSmcMarketData(symbol, tfs)
  for (const tf of ['4H', '1H', '15M', '5M'] as const) {
    if (data.candles[tf].length < 50) {
      throw new Error('DATA UNAVAILABLE: insufficient closed candles from Bybit and Binance')
    }
  }

  const now = Date.now()

  // ── per-TF analysis ────────────────────────────────────────────────────────
  const a1D = analyzeTf('1D', data.candles['1D'], cfg)
  const a4H = analyzeTf('4H', data.candles['4H'], cfg)
  const a1H = analyzeTf('1H', data.candles['1H'], cfg)
  const a15M = analyzeTf('15M', data.candles['15M'], cfg)
  const a5M = analyzeTf('5M', data.candles['5M'], cfg)

  const currentPrice = data.price > 0 ? data.price : a1H.candles.length > 0 ? a1H.candles[a1H.candles.length - 1].close : 0

  // ── liquidity map + sweeps (1H engine, PDH/PDL from 15M, PWH/PWL from 1D) ──
  const levels = detectLiquidity(a1H.candles, a1H.swings, a1H.atr, TF_MS['1H'], cfg, a15M.candles, a1D.candles)
  const sweeps = detectSweeps(levels, a1H.candles, a1H.atr, TF_MS['1H'], cfg)

  // ── fair value gaps + order blocks on 1H ───────────────────────────────────
  const fvgs1H: FVG[] = detectFvgs(a1H.candles, TF_MS['1H'])
  const obs: OrderBlock[] = detectOrderBlocks(
    a1H.candles,
    a1H.events,
    fvgs1H,
    a1H.atr,
    cfg,
    a4H.trend,
    sweeps,
    TF_MS['1H'],
  )

  // ── multi-TF summary + market bias ─────────────────────────────────────────
  const mtfInput = (a: TfAnalysis): MtfTfInput => ({
    tf: a.tf,
    price: currentPrice,
    trend: a.trend,
    events: a.events,
    atr: a.atr,
    volumeRatio: a.volumeRatio,
    lastCandleTime: a.lastCandleTime,
    tfMs: TF_MS[a.tf],
    displacement: a.displacement,
  })
  const { marketBias, perTf } = buildMtfs(
    { '4H': mtfInput(a4H), '1H': mtfInput(a1H), '15M': mtfInput(a15M), '5M': mtfInput(a5M) },
    cfg,
    a1D.trend,
  )

  // ── signal evaluation ──────────────────────────────────────────────────────
  const evaluation = evaluateSignal(
    {
      price: currentPrice,
      mode: cfg.mode,
      t4: { trend: a4H.trend },
      h1: {
        trend: a1H.trend,
        events: a1H.events,
        obs,
        atr: a1H.atr,
        volumeRatio: a1H.volumeRatio,
        displacement: a1H.displacement,
        lastCandleTime: a1H.lastCandleTime,
        swings: a1H.swings,
      },
      m15: { events: a15M.events, lastCandleTime: a15M.lastCandleTime },
      m5: {
        events: a5M.events,
        displacement: a5M.displacement,
        lastCandleTime: a5M.lastCandleTime,
      },
      levels,
      sweeps,
      fvgs: fvgs1H,
      htfSwings: [...a1D.swings, ...a4H.swings],
    },
    cfg,
  )

  let signal = evaluation.signal
  let trade: TradePlan | null = evaluation.trade
  let score = evaluation.score
  let quality = evaluation.quality
  const explanation = [...evaluation.explanation]
  let featuredOb = evaluation.ob

  // ── persistence: dedupe new setups, never resurrect played ones (§17.10/§46) ─
  try {
    if ((signal === 'LONG' || signal === 'SHORT') && evaluation.ob && trade) {
      const ob = evaluation.ob
      const existing = await db.smcSignal.findUnique({
        where: { symbol_obTime_direction: { symbol, obTime: ob.time, direction: signal } },
      })
      if (!existing) {
        await db.smcSignal.create({
          data: {
            symbol,
            direction: signal,
            quality,
            score,
            mode: cfg.mode,
            entryLow: trade.entry_low,
            entryHigh: trade.entry_high,
            entryMid: trade.entry_mid,
            stopLoss: trade.stop_loss,
            tp1: trade.tp1,
            tp2: trade.tp2,
            tp3: trade.tp3,
            rr1: trade.rr1,
            rr2: trade.rr2,
            rr3: trade.rr3,
            obTime: ob.time,
            obLow: ob.low,
            obHigh: ob.high,
            reasons: evaluation.reasons.map((r) => ({ factor: r.factor, result: r.result, points: r.points })),
            status: 'ACTIVE',
            createdAt: now,
            updatedAt: now,
          },
        })
      } else if (existing.result !== null) {
        // this exact setup was already tracked and closed — never resurrect it
        signal = 'NO_TRADE'
        trade = null
        score = 0
        quality = '—'
        explanation.push('this exact setup was already tracked and closed')
      }
    }

    await updateLifecycle(symbol, a5M.candles, cfg, now)
  } catch (err) {
    // persistence problems must never kill the analysis payload
    console.error('[smc] persistence error:', err)
  }

  // ── history (last 12 rows for this symbol) ─────────────────────────────────
  let history: SmcHistoryRow[] = []
  try {
    const rows = await db.smcSignal.findMany({
      where: { symbol },
      orderBy: { createdAt: 'desc' },
      take: 12,
    })
    history = rows.map((r) => ({
      id: r.id,
      direction: r.direction as SmcHistoryRow['direction'],
      quality: r.quality,
      score: r.score,
      entryMid: r.entryMid,
      entryLow: r.entryLow,
      entryHigh: r.entryHigh,
      stopLoss: r.stopLoss,
      tp1: r.tp1,
      tp2: r.tp2,
      tp3: r.tp3,
      status: r.status,
      result: r.result,
      rMultiple: r.rMultiple,
      createdAt: r.createdAt,
      tp1At: r.tp1At,
      tp2At: r.tp2At,
      tp3At: r.tp3At,
      slAt: r.slAt,
    }))
  } catch (err) {
    console.error('[smc] history load error:', err)
  }

  // ── assemble the consolidated payload (§23/§25) ────────────────────────────
  const activeObs = obs.filter(isActiveOb)

  // featured order block: chosen → strongest active
  if (!featuredOb && activeObs.length > 0) {
    featuredOb = [...activeObs].sort((a, b) => b.strengthScore - a.strengthScore)[0]
  }

  const activeFvgs = fvgs1H.filter((f) => f.status === 'ACTIVE' || f.status === 'PARTIALLY_FILLED')
  const distToFvg = (f: FVG) =>
    currentPrice >= f.low && currentPrice <= f.high ? 0 : currentPrice > f.high ? currentPrice - f.high : f.low - currentPrice
  let featuredFvg: FVG | null = null
  if (signal === 'LONG' || signal === 'SHORT') {
    const dirWant = signal === 'LONG' ? 'BULLISH' : 'BEARISH'
    featuredFvg =
      activeFvgs.filter((f) => f.direction === dirWant).sort((a, b) => distToFvg(a) - distToFvg(b))[0] ?? null
  }
  if (!featuredFvg) {
    featuredFvg =
      activeFvgs.filter((f) => (marketBias === 'BEARISH' ? f.direction === 'BEARISH' : f.direction === 'BULLISH'))[0] ??
      activeFvgs[0] ??
      null
  }

  // liquidity strip: nearest unswept levels, padded with recently swept ones
  const nearestUnswept = levels
    .filter((l) => !l.swept)
    .sort((a, b) => Math.abs(a.price - currentPrice) - Math.abs(b.price - currentPrice))
    .slice(0, 8)
  const recentlySwept = levels
    .filter((l) => l.swept && !nearestUnswept.includes(l))
    .sort((a, b) => (b.sweptAt ?? 0) - (a.sweptAt ?? 0))
  const liquidityLevels: LiquidityLevel[] = [...nearestUnswept]
  for (const l of recentlySwept) {
    if (liquidityLevels.length >= 8) break
    liquidityLevels.push(l)
  }

  // most recent relevant sweep → liquidity.sweep / .type
  const dirWant: 'BULLISH' | 'BEARISH' | null =
    signal === 'LONG' ? 'BULLISH' : signal === 'SHORT' ? 'BEARISH' : null
  const relevantSweep =
    (dirWant ? sweeps.find((s) => s.direction === dirWant) : undefined) ?? sweeps[0] ?? null

  const reasons: Reason[] = evaluation.reasons

  const payload: SmcAnalysis = {
    ok: true,
    symbol,
    dataSource: data.source,
    generatedAt: now,
    current_price: currentPrice,
    change24h: data.change24h,
    market_bias: marketBias,
    timeframes: { trend: '4H', structure: '1H', setup: '15M', entry: '5M' },
    per_tf: perTf,
    trend: { direction: marketBias },
    structure: { bos: perTf['1H'].bos, choch: perTf['1H'].choch },
    order_block: featuredOb
      ? {
          type: featuredOb.direction,
          high: featuredOb.high,
          low: featuredOb.low,
          fresh: featuredOb.fresh,
          strength_score: featuredOb.strengthScore,
          time: featuredOb.time,
        }
      : null,
    order_blocks: [...activeObs].sort((a, b) => b.strengthScore - a.strengthScore).slice(0, 5),
    fvg: featuredFvg ? { present: true, high: featuredFvg.high, low: featuredFvg.low, direction: featuredFvg.direction } : null,
    fvgs: [...activeFvgs].sort((a, b) => b.time - a.time).slice(0, 6),
    liquidity: {
      sweep: relevantSweep !== null,
      type: relevantSweep ? (relevantSweep.direction === 'BULLISH' ? 'SELL_SIDE' : 'BUY_SIDE') : null,
    },
    liquidity_levels: liquidityLevels,
    sweeps: sweeps.slice(0, 5),
    signal,
    quality,
    score,
    mode: cfg.mode,
    trade: trade
      ? {
          entry_low: trade.entry_low,
          entry_high: trade.entry_high,
          entry_mid: trade.entry_mid,
          stop_loss: trade.stop_loss,
          tp1: trade.tp1,
          tp2: trade.tp2,
          tp3: trade.tp3,
        }
      : null,
    risk_reward: trade ? { tp1: trade.rr1, tp2: trade.rr2, tp3: trade.rr3 } : { tp1: 0, tp2: 0, tp3: 0 },
    explanation,
    reasons,
    history,
    disclaimer: SMC_DISCLAIMER,
  }

  respCache.set(cacheKey, { at: Date.now(), data: payload })
  return payload
}
