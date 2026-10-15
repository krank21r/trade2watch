/**
 * SMC engine — orchestrator (§23/§25/§28/§34/§46) with DUAL-EXCHANGE
 * reconciliation (Bybit × Binance).
 *
 * runSmcAnalysis(symbol, mode?) runs the full pipeline ONCE PER EXCHANGE TAPE
 * (both feeds fetched concurrently, closed candles only, no look-ahead):
 *   market data → per-TF analysis (ATR / swings / structure / displacement /
 *   volume) → liquidity map + sweeps → 1H order blocks → multi-TF summary →
 *   signal evaluation
 * then reconciles the two verdicts (cross-exchange confluence):
 *   - both tapes confirm the SAME LONG/SHORT → signal, +5 confluence score
 *   - one tape confirms, the other is WATCHLIST → signal kept, flagged 1/2
 *   - one tape confirms, the other shows NO setup → WATCHLIST (both tapes
 *     must agree before a live signal)
 *   - tapes disagree on direction (LONG vs SHORT) → NO_TRADE
 * The chosen tape's evaluation feeds persistence (dedupe + lifecycle); the
 * payload carries consensus + an OB zone cross-check for the UI.
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
  ExchangeConsensus,
  FVG,
  LiquidityLevel,
  LiquiditySweep,
  ObCrossCheck,
  OrderBlock,
  Reason,
  SignalType,
  SmcAnalysis,
  SmcHistoryRow,
  SmcPerformance,
  StrategyMode,
  StructureEvent,
  SwingPoint,
  TF,
  TfSummary,
} from './types'
import { loadDualSmcMarketData, type FeedData } from './feeds'
import { ensureSmcTables } from './ensure-tables'
import { atr } from './atr'
import { detectSwings } from './swings'
import { analyzeStructure } from './structure'
import { detectDisplacement } from './displacement'
import { volumeRatio } from './volume'
import { detectFvgs } from './fvg'
import { detectOrderBlocks, isActiveOb } from './orderblocks'
import { detectLiquidity, detectSweeps } from './liquidity'
import { buildMtfs, type MtfTfInput } from './mtf'
import { evaluateSignal, type SignalEvaluation } from './signal'
import { sendSmcAlert } from './alerts'
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

// ─── cross-exchange confluence ───────────────────────────────────────────────

/** Score points granted when BOTH exchange tapes confirm the same setup. */
const CONFLUENCE_BONUS = 5

function qualityFor(score: number): SmcAnalysis['quality'] {
  const q = SMC_CONFIG.qualityBands
  return score >= q.aPlus ? 'A+' : score >= q.a ? 'A' : score >= q.b ? 'B' : score >= q.c ? 'C' : '—'
}

/**
 * Everything one exchange tape produces, exactly as the single-tape engine
 * used to — the orchestrator runs this once per venue and reconciles.
 */
interface CoreResult {
  exchange: 'BYBIT' | 'BINANCE'
  a1D: TfAnalysis
  a4H: TfAnalysis
  a1H: TfAnalysis
  a15M: TfAnalysis
  a5M: TfAnalysis
  currentPrice: number
  change24h: number
  levels: LiquidityLevel[]
  sweeps: LiquiditySweep[]
  fvgs1H: FVG[]
  obs: OrderBlock[]
  activeObs: OrderBlock[]
  marketBias: 'BULLISH' | 'BEARISH' | 'NEUTRAL'
  perTf: Record<'4H' | '1H' | '15M' | '5M', TfSummary>
  evaluation: SignalEvaluation
  featuredOb: OrderBlock | null
  activeFvgs: FVG[]
  featuredFvg: FVG | null
  liquidityLevels: LiquidityLevel[]
  relevantSweep: LiquiditySweep | null
}

function computeCore(data: FeedData, cfg: SmcCfg): CoreResult {
  for (const tf of ['4H', '1H', '15M', '5M'] as const) {
    if (data.candles[tf].length < 50) {
      throw new Error(`DATA UNAVAILABLE: ${data.exchange} ${tf} returned insufficient closed candles`)
    }
  }

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

  const activeObs = obs.filter(isActiveOb)
  const featuredOb: OrderBlock | null =
    evaluation.ob ?? [...activeObs].sort((a, b) => b.strengthScore - a.strengthScore)[0] ?? null

  const activeFvgs = fvgs1H.filter((f) => f.status === 'ACTIVE' || f.status === 'PARTIALLY_FILLED')
  const distToFvg = (f: FVG) =>
    currentPrice >= f.low && currentPrice <= f.high ? 0 : currentPrice > f.high ? currentPrice - f.high : f.low - currentPrice
  let featuredFvg: FVG | null = null
  if (evaluation.signal === 'LONG' || evaluation.signal === 'SHORT') {
    const dirWant = evaluation.signal === 'LONG' ? 'BULLISH' : 'BEARISH'
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
    evaluation.signal === 'LONG' ? 'BULLISH' : evaluation.signal === 'SHORT' ? 'BEARISH' : null
  const relevantSweep =
    (dirWant ? sweeps.find((s) => s.direction === dirWant) : undefined) ?? sweeps[0] ?? null

  return {
    exchange: data.exchange,
    a1D,
    a4H,
    a1H,
    a15M,
    a5M,
    currentPrice,
    change24h: data.change24h,
    levels,
    sweeps,
    fvgs1H,
    obs,
    activeObs,
    marketBias,
    perTf,
    evaluation,
    featuredOb,
    activeFvgs,
    featuredFvg,
    liquidityLevels,
    relevantSweep,
  }
}

/** Does the chosen tape's featured OB zone exist on the other tape too? */
function crossCheck(chosen: CoreResult, other: CoreResult | null): ObCrossCheck | null {
  const ob = chosen.evaluation.ob ?? chosen.featuredOb
  if (!ob) return null
  let overlapPct: number | null = null
  let onOther = false
  if (other) {
    let best = 0
    for (const o of other.activeObs.filter((x) => x.direction === ob.direction)) {
      const inter = Math.min(ob.high, o.high) - Math.max(ob.low, o.low)
      if (inter <= 0) continue
      const pct = (inter / Math.min(ob.high - ob.low, o.high - o.low)) * 100
      if (pct > best) best = pct
    }
    overlapPct = Math.round(best)
    onOther = best >= 50 // ≥ half of the smaller zone overlaps → same zone
  }
  return {
    direction: ob.direction,
    bybit: chosen.exchange === 'BYBIT' ? true : onOther,
    binance: chosen.exchange === 'BINANCE' ? true : onOther,
    overlapPct,
  }
}

const isTrade = (s: SignalType): s is 'LONG' | 'SHORT' => s === 'LONG' || s === 'SHORT'

interface Reconciled {
  chosen: CoreResult
  signal: SignalType
  trade: TradePlan | null
  score: number
  quality: SmcAnalysis['quality']
  explanation: string[]
  reasons: Reason[]
  consensus: ExchangeConsensus
  obCross: ObCrossCheck | null
  watchNoteOverride: string | null
  confirmations: 0 | 1 | 2
}

/**
 * Merge the per-exchange verdicts into ONE signal (rules in the header).
 * `chosen` picks which tape feeds the payload + persistence.
 */
function reconcile(cores: CoreResult[]): Reconciled {
  if (cores.length === 1) {
    const c = cores[0]
    const e = c.evaluation
    const other = c.exchange === 'BYBIT' ? 'BINANCE' : 'BYBIT'
    return {
      chosen: c,
      signal: e.signal,
      trade: e.trade,
      score: e.score,
      quality: e.quality,
      explanation: [
        ...e.explanation,
        `${other} tape unreachable — verdict from the ${c.exchange} tape alone (single-source, no cross-exchange validation)`,
      ],
      reasons: [...e.reasons],
      consensus: {
        bybit: c.exchange === 'BYBIT' ? e.signal : 'UNAVAILABLE',
        binance: c.exchange === 'BINANCE' ? e.signal : 'UNAVAILABLE',
        agreement: 'SINGLE_SOURCE',
        note: `${other} feed unavailable — analysis from the ${c.exchange} tape only`,
      },
      obCross: crossCheck(c, null),
      watchNoteOverride: null,
      confirmations: isTrade(e.signal) ? 1 : 0,
    }
  }

  const [by, bn] = cores as [CoreResult, CoreResult] // cores[0] is always the Bybit tape
  const a = by.evaluation
  const b = bn.evaluation

  // both tapes fired the same trade → strongest confirmation
  if (isTrade(a.signal) && isTrade(b.signal)) {
    if (a.signal === b.signal) {
      const chosen = a.score >= b.score ? by : bn
      const e = chosen.evaluation
      const score = Math.min(100, Math.round(e.score + CONFLUENCE_BONUS))
      const reasons: Reason[] = [
        ...e.reasons,
        { factor: 'Cross-exchange confluence', result: `OB zone confirmed on both Bybit + Binance tapes (+${CONFLUENCE_BONUS})`, points: CONFLUENCE_BONUS },
      ]
      return {
        chosen,
        signal: e.signal,
        trade: e.trade,
        score,
        quality: qualityFor(score),
        explanation: [
          ...e.explanation,
          `order block confirmed on both tapes — Bybit and Binance agree on ${e.signal} (confluence +${CONFLUENCE_BONUS})`,
        ],
        reasons,
        consensus: {
          bybit: a.signal,
          binance: b.signal,
          agreement: 'FULL',
          note: `both tapes confirm ${a.signal} — OB zone validated on Bybit + Binance (+${CONFLUENCE_BONUS} score)`,
        },
        obCross: crossCheck(chosen, chosen === by ? bn : by),
        watchNoteOverride: null,
        confirmations: 2,
      }
    }
    // LONG on one tape, SHORT on the other — refuse to pick a side
    return {
      chosen: by,
      signal: 'NO_TRADE',
      trade: null,
      score: 0,
      quality: '—',
      explanation: [
        `the two tapes disagree on direction — Bybit shows ${a.signal} while Binance shows ${b.signal}; no trade until both venues agree`,
      ],
      reasons: [],
      consensus: {
        bybit: a.signal,
        binance: b.signal,
        agreement: 'CONFLICT',
        note: `Bybit ${a.signal} vs Binance ${b.signal} — conflicting tapes`,
      },
      obCross: null,
      watchNoteOverride: null,
      confirmations: 0,
    }
  }

  // exactly one tape fired a trade
  const t = isTrade(a.signal) ? by : isTrade(b.signal) ? bn : null
  if (t) {
    const o = t === by ? bn : by
    const e = t.evaluation
    const oe = o.evaluation
    if (oe.signal === 'WATCHLIST') {
      // setup visible on both venues; confirmations only complete on one tape
      return {
        chosen: t,
        signal: e.signal,
        trade: e.trade,
        score: e.score,
        quality: e.quality,
        explanation: [
          ...e.explanation,
          `the ${o.exchange} tape still shows WATCHLIST — setup visible on both venues, confirmations complete on ${t.exchange} only (no confluence bonus)`,
        ],
        reasons: [...e.reasons],
        consensus: {
          bybit: a.signal,
          binance: b.signal,
          agreement: 'PARTIAL',
          note: `${e.signal} confirmed on the ${t.exchange} tape; ${o.exchange} still WATCHLIST — single-tape confirmation`,
        },
        obCross: crossCheck(t, o),
        watchNoteOverride: null,
        confirmations: 1,
      }
    }
    // the other tape shows NO setup at all → a real SMC zone exists on both
    // venues' tapes; a live signal requires BOTH — downgrade to WATCHLIST
    const note = `confirmed on the ${t.exchange} tape only — ${o.exchange} shows no valid setup; both tapes must agree before this becomes a live ${e.signal}`
    return {
      chosen: t,
      signal: 'WATCHLIST',
      trade: null,
      score: e.score,
      quality: e.quality,
      explanation: [...e.explanation, note],
      reasons: [...e.reasons],
      consensus: {
        bybit: a.signal,
        binance: b.signal,
        agreement: 'PARTIAL',
        note,
      },
      obCross: crossCheck(t, o),
      watchNoteOverride: note,
      confirmations: 1,
    }
  }

  // neither tape fired — agree or not, there is no signal; keep the richer tape
  const better = a.score >= b.score ? by : bn
  const e = better.evaluation
  const agree = a.signal === b.signal
  return {
    chosen: better,
    signal: e.signal,
    trade: null,
    score: e.score,
    quality: e.quality,
    explanation: agree
      ? [...e.explanation, `both tapes agree: ${e.signal}`]
      : [...e.explanation, `tapes differ in degree — Bybit ${a.signal} vs Binance ${b.signal}`],
    reasons: [...e.reasons],
    consensus: {
      bybit: a.signal,
      binance: b.signal,
      agreement: agree ? 'FULL' : 'PARTIAL',
      note: agree ? `both tapes agree: ${e.signal}` : `Bybit ${a.signal} vs Binance ${b.signal}`,
    },
    obCross: crossCheck(better, better === by ? bn : by),
    watchNoteOverride: null,
    confirmations: 0,
  }
}

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
      // lifecycle alert (§35/§36) — idempotent per (row.id, event), fire-and-forget
      if (status !== row.status) {
        const ev =
          status === 'TP1_HIT'
            ? 'TP1_HIT'
            : status === 'TP2_HIT'
              ? 'TP2_HIT'
              : status === 'TP3_HIT'
                ? 'TP3_HIT'
                : status === 'SL_HIT'
                  ? 'SL_HIT'
                  : status === 'EXPIRED' && result === 'EXPIRED'
                    ? 'EXPIRED'
                    : null
        if (ev) {
          void sendSmcAlert({
            signalId: row.id,
            symbol,
            event: ev,
            direction: row.direction === 'SHORT' ? 'SHORT' : 'LONG',
            rMultiple,
            note:
              ev === 'SL_HIT' && result === 'BREAKEVEN'
                ? 'stopped after TP1 — half position banked'
                : ev === 'TP2_HIT'
                  ? 'final banked result — runner tracked to TP3'
                  : undefined,
          })
        }
      }
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

  // ── market data — BOTH exchange tapes, fetched concurrently ────────────────
  const tfs: TF[] = ['1D', '4H', '1H', '15M', '5M']
  const feeds = await loadDualSmcMarketData(symbol, tfs)
  const cores: CoreResult[] = []
  if (feeds.bybit) cores.push(computeCore(feeds.bybit, cfg))
  if (feeds.binance) cores.push(computeCore(feeds.binance, cfg))
  if (cores.length === 0) {
    throw new Error('DATA UNAVAILABLE: no usable closed candles from Bybit or Binance')
  }

  const rec = reconcile(cores)
  const chosen = rec.chosen
  const now = Date.now()

  let signal = rec.signal
  let trade: TradePlan | null = rec.trade
  let score = rec.score
  let quality = rec.quality
  const explanation = [...rec.explanation]

  // ── persistence: dedupe new setups, never resurrect played ones (§17.10/§46) ─
  try {
    // self-healing schema — ephemeral prod SQLite may predate the SMC tables
    await ensureSmcTables()

    // WATCHLIST radar log — snapshot every staged setup so a setup the user
    // spotted earlier is always findable later. Upsert per
    // (symbol, OB candle, direction, mode); refresh note/score on re-sighting.
    if (signal === 'WATCHLIST' && chosen.evaluation.ob) {
      const wob = chosen.evaluation.ob
      const note = (rec.watchNoteOverride ?? chosen.evaluation.watchNote ?? explanation[0] ?? '').slice(0, 400)
      const wKey = {
        symbol,
        obTime: wob.time,
        direction: wob.direction,
        mode: cfg.mode,
      }
      const plan = trade // provisional plan (may be null when RR is the blocker)
      const wData = {
        obLow: wob.low,
        obHigh: wob.high,
        score: Math.round(score),
        quality,
        note,
        entryLow: plan?.entry_low ?? null,
        entryHigh: plan?.entry_high ?? null,
        entryMid: plan?.entry_mid ?? null,
        stopLoss: plan?.stop_loss ?? null,
        tp1: plan?.tp1 ?? null,
        tp2: plan?.tp2 ?? null,
        tp3: plan?.tp3 ?? null,
        lastSeen: now,
      }
      await db.smcWatchLog.upsert({
        where: {
          symbol_obTime_direction_mode: {
            symbol: wKey.symbol,
            obTime: wKey.obTime,
            direction: wKey.direction,
            mode: wKey.mode,
          },
        },
        create: { ...wKey, ...wData, firstSeen: now },
        update: wData,
      })
      // housekeeping: staged setups unseen for 14 days drop off the radar
      await db.smcWatchLog.deleteMany({ where: { lastSeen: { lt: now - 14 * 86_400_000 } } })
    }

    if ((signal === 'LONG' || signal === 'SHORT') && chosen.evaluation.ob && trade) {
      const ob = chosen.evaluation.ob
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
            reasons: rec.reasons.map((r) => ({ factor: r.factor, result: r.result, points: r.points })),
            status: 'ACTIVE',
            createdAt: now,
            updatedAt: now,
          },
        })
        // new-signal alert (§35/§36) — idempotent per row, fire-and-forget
        const created = await db.smcSignal.findUnique({
          where: { symbol_obTime_direction: { symbol, obTime: ob.time, direction: signal } },
        })
        if (created) {
          void sendSmcAlert({
            signalId: created.id,
            symbol,
            event: 'SIGNAL_CREATED',
            direction: signal,
            quality,
            score,
            entryLow: trade.entry_low,
            entryHigh: trade.entry_high,
            entryMid: trade.entry_mid,
            stopLoss: trade.stop_loss,
            tp1: trade.tp1,
            tp2: trade.tp2,
            tp3: trade.tp3,
            note:
              rec.consensus.agreement === 'FULL'
                ? `OB confirmed on both Bybit + Binance tapes (+${CONFLUENCE_BONUS} confluence)`
                : rec.consensus.agreement === 'PARTIAL'
                  ? `single-tape confirmation: ${rec.consensus.note ?? ''}`
                  : undefined,
          })
        }
      } else if (existing.result !== null) {
        // this exact setup was already tracked and closed — never resurrect it
        signal = 'NO_TRADE'
        trade = null
        score = 0
        quality = '—'
        explanation.push('this exact setup was already tracked and closed')
      }
    }

    await updateLifecycle(symbol, chosen.a5M.candles, cfg, now)
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

  // ── live performance (all rows ever logged for this symbol, §32) ──────────
  let performance: SmcPerformance | null = null
  try {
    const perfRows = await db.smcSignal.findMany({
      where: { symbol },
      select: { direction: true, status: true, result: true, rMultiple: true },
    })
    const done = perfRows.filter((r) => r.result !== null)
    const wins = done.filter((r) => r.result === 'WIN').length
    const losses = done.filter((r) => r.result === 'LOSS').length
    const rs = done.map((r) => r.rMultiple ?? 0)
    const totalR = Math.round(rs.reduce((a, b) => a + b, 0) * 100) / 100
    performance = {
      total: perfRows.length,
      longs: perfRows.filter((r) => r.direction === 'LONG').length,
      shorts: perfRows.filter((r) => r.direction === 'SHORT').length,
      open: perfRows.filter((r) => r.result === null).length,
      resolved: done.length,
      wins,
      losses,
      breakevens: done.filter((r) => r.result === 'BREAKEVEN').length,
      expired: done.filter((r) => r.result === 'EXPIRED').length,
      winRatePct: wins + losses > 0 ? Math.round((wins / (wins + losses)) * 1000) / 10 : 0,
      totalR,
      avgR: done.length > 0 ? Math.round((totalR / done.length) * 100) / 100 : 0,
    }
  } catch (err) {
    console.error('[smc] performance load error:', err)
  }

  // ── assemble the consolidated payload (§23/§25 + cross-exchange) ───────────
  const currentPrice = chosen.currentPrice > 0 ? chosen.currentPrice : chosen.a1H.candles[chosen.a1H.candles.length - 1]?.close ?? 0

  const payload: SmcAnalysis = {
    ok: true,
    symbol,
    dataSource: cores.length === 2 ? 'BOTH' : cores[0].exchange === 'BYBIT' ? 'BYBIT' : 'BINANCE_FALLBACK',
    exchanges: {
      bybit: cores.some((c) => c.exchange === 'BYBIT'),
      binance: cores.some((c) => c.exchange === 'BINANCE'),
    },
    consensus: rec.consensus,
    ob_cross_check: rec.obCross,
    generatedAt: now,
    current_price: currentPrice,
    change24h: chosen.change24h,
    market_bias: chosen.marketBias,
    timeframes: { trend: '4H', structure: '1H', setup: '15M', entry: '5M' },
    per_tf: chosen.perTf,
    trend: { direction: chosen.marketBias },
    structure: { bos: chosen.perTf['1H'].bos, choch: chosen.perTf['1H'].choch },
    order_block: chosen.featuredOb
      ? {
          type: chosen.featuredOb.direction,
          high: chosen.featuredOb.high,
          low: chosen.featuredOb.low,
          fresh: chosen.featuredOb.fresh,
          strength_score: chosen.featuredOb.strengthScore,
          time: chosen.featuredOb.time,
        }
      : null,
    order_blocks: [...chosen.activeObs].sort((a, b) => b.strengthScore - a.strengthScore).slice(0, 5),
    fvg: chosen.featuredFvg
      ? { present: true, high: chosen.featuredFvg.high, low: chosen.featuredFvg.low, direction: chosen.featuredFvg.direction }
      : null,
    fvgs: [...chosen.activeFvgs].sort((a, b) => b.time - a.time).slice(0, 6),
    liquidity: {
      sweep: chosen.relevantSweep !== null,
      type: chosen.relevantSweep ? (chosen.relevantSweep.direction === 'BULLISH' ? 'SELL_SIDE' : 'BUY_SIDE') : null,
    },
    liquidity_levels: chosen.liquidityLevels,
    sweeps: chosen.sweeps.slice(0, 5),
    signal,
    // documented contract: only a live LONG/SHORT carries a confirmation time
    signal_confirmed_at: signal === 'LONG' || signal === 'SHORT' ? (chosen.evaluation.confirmAt ?? null) : null,
    watch_note:
      rec.watchNoteOverride ??
      ('watchNote' in chosen.evaluation ? (chosen.evaluation.watchNote ?? null) : null),
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
    reasons: rec.reasons,
    history,
    performance,
    disclaimer: SMC_DISCLAIMER,
  }

  respCache.set(cacheKey, { at: Date.now(), data: payload })
  return payload
}
