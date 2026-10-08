/**
 * SMC backtester (§29/§30/§31) — replays the EXACT live pipeline over
 * historical candles and simulates the EXACT lifecycle the engine uses for
 * real signals (pessimistic 5M tracking, SL before TPs, expiry).
 *
 * NO LOOK-AHEAD BIAS — enforced structurally, not by discipline:
 *   1. The dataset is loaded ONCE, closed candles only (forming rows dropped).
 *   2. Every decision point t is a 15M candle CLOSE time. Each timeframe is
 *      hard-sliced to candles whose CLOSE time is ≤ t before any engine call,
 *      so swings/structure/OBs/liquidity/signals can only use information
 *      that existed at t — identical view to what the live engine had then.
 *   3. Outcomes are evaluated on 5M candles that close STRICTLY AFTER t.
 *   4. The same config gates apply (RR ≥ 2.0 at TP2, score ≥ 80 in STRICT,
 *      OB-zone entry, never re-entering a played OB).
 *
 * WALK-FORWARD (§31): parameters are FIXED in config.ts — nothing is
 * optimised on history anywhere in this system, so every window is
 * effectively out-of-sample. The horizon is split into K consecutive folds
 * and each fold reports its own stats: consistent numbers across folds are
 * the stability signal; a strategy that only worked in one fold is flagged.
 *
 * ONE position at a time (mirrors the live desk: a signal is open until
 * TP/SL/expiry resolves it). Entry fill = plan entry_mid (price is required
 * to be INSIDE the OB zone at signal time, so the zone order fills).
 *
 * NO trading logic — this is measurement, not execution (§58).
 */

import type { Candle } from '@/lib/market/indicators'
import { SMC_CONFIG, TF_MS } from './config'
import type { SmcCfg } from './cfg'
import type { StrategyMode, TF } from './types'
import { atr } from './atr'
import { detectSwings } from './swings'
import { analyzeStructure } from './structure'
import { detectDisplacement } from './displacement'
import { volumeRatio } from './volume'
import { detectFvgs } from './fvg'
import { detectOrderBlocks } from './orderblocks'
import { detectLiquidity, detectSweeps } from './liquidity'
import { evaluateSignal } from './signal'

// ─── dataset loading (paginated klines, closed candles only) ────────────────

const BYBIT = 'https://api.bybit.com'
const BINANCE_MIRROR = 'https://data-api.binance.vision'

const BYBIT_INTERVAL: Record<TF, string> = { '1D': 'D', '4H': '240', '1H': '60', '15M': '15', '5M': '5' }
const BINANCE_INTERVAL: Record<TF, string> = { '1D': '1d', '4H': '4h', '1H': '1h', '15M': '15m', '5M': '5m' }

/** candles needed per TF for a `days` horizon: horizon + engine warm-up */
function candlesNeeded(tf: TF, days: number): number {
  switch (tf) {
    case '1D':
      return days + 90 // PWH/PWL + HTF swing warm-up
    case '4H':
      return days * 6 + 60
    case '1H':
      return days * 24 + 100
    case '15M':
      return days * 96 + 120
    case '5M':
      return days * 288 + 200
  }
}

async function fetchJson<T>(url: string, timeoutMs = 15_000): Promise<T> {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' },
      cache: 'no-store',
    })
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`)
    return (await res.json()) as T
  } finally {
    clearTimeout(t)
  }
}

const MAX_PAGES = 40

async function bybitRange(symbol: string, tf: TF, need: number): Promise<Candle[]> {
  const out: Candle[] = []
  let end: number | undefined
  for (let page = 0; page < MAX_PAGES && out.length < need; page++) {
    const url =
      `${BYBIT}/v5/market/kline?category=spot&symbol=${symbol}&interval=${BYBIT_INTERVAL[tf]}&limit=1000` +
      (end !== undefined ? `&end=${end}` : '')
    const j = await fetchJson<{ retCode: number; retMsg: string; result?: { list?: string[][] } }>(url)
    if (j.retCode !== 0 || !j.result?.list) throw new Error(`bybit ${j.retMsg}`)
    const rows = j.result.list
    if (rows.length === 0) break
    for (const r of rows) {
      const time = Number(r[0])
      if (time + TF_MS[tf] > Date.now()) continue // forming candle — never enters the dataset
      out.push({ time, open: Number(r[1]), high: Number(r[2]), low: Number(r[3]), close: Number(r[4]), volume: Number(r[5]) })
    }
    end = Math.min(...rows.map((r) => Number(r[0]))) - 1 // walk further back
    if (rows.length < 1000) break
  }
  // dedupe + ASC
  const seen = new Set<number>()
  return out
    .filter((c) => (seen.has(c.time) ? false : (seen.add(c.time), true)))
    .sort((a, b) => a.time - b.time)
}

async function binanceRange(symbol: string, tf: TF, need: number): Promise<Candle[]> {
  const out: Candle[] = []
  let endTime: number | undefined
  for (let page = 0; page < MAX_PAGES && out.length < need; page++) {
    const url =
      `${BINANCE_MIRROR}/api/v3/klines?symbol=${symbol}&interval=${BINANCE_INTERVAL[tf]}&limit=1000` +
      (endTime !== undefined ? `&endTime=${endTime}` : '')
    const rows = await fetchJson<Array<[number, string, string, string, string, string, ...unknown[]]>>(url)
    if (!Array.isArray(rows) || rows.length === 0) break
    for (const r of rows) {
      const time = Number(r[0])
      if (time + TF_MS[tf] > Date.now()) continue
      out.push({ time, open: Number(r[1]), high: Number(r[2]), low: Number(r[3]), close: Number(r[4]), volume: Number(r[5]) })
    }
    endTime = Math.min(...rows.map((r) => Number(r[0]))) - 1
    if (rows.length < 1000) break
  }
  const seen = new Set<number>()
  return out
    .filter((c) => (seen.has(c.time) ? false : (seen.add(c.time), true)))
    .sort((a, b) => a.time - b.time)
}

export interface SmcDataset {
  source: 'BYBIT' | 'BINANCE_FALLBACK'
  candles: Record<TF, Candle[]>
}

/** dataset cache — heavy pagination result reused for 10 minutes */
const dsCache = new Map<string, { at: number; data: SmcDataset }>()
const DS_TTL = 10 * 60_000

const STRATEGY_TFS: TF[] = ['1D', '4H', '1H', '15M', '5M']

export async function loadBacktestDataset(symbol: string, days: number): Promise<SmcDataset> {
  const key = `${symbol}:${days}`
  const hit = dsCache.get(key)
  if (hit && Date.now() - hit.at < DS_TTL) return hit.data

  let bybitOk = 0
  let binanceOk = 0
  const candles = {} as Record<TF, Candle[]>
  for (const tf of STRATEGY_TFS) {
    const need = candlesNeeded(tf, days)
    let set: Candle[] = []
    try {
      set = await bybitRange(symbol, tf, need)
      if (set.length > 0) bybitOk++
    } catch {
      set = []
    }
    if (set.length < need) {
      try {
        const alt = await binanceRange(symbol, tf, need)
        if (alt.length > set.length) set = alt
        if (set.length > 0) binanceOk++
      } catch {
        /* keep what we have */
      }
    }
    candles[tf] = set
  }
  if (candles['4H'].length < 50 || candles['1H'].length < 50 || candles['15M'].length < 50 || candles['5M'].length < 50) {
    throw new Error('DATA UNAVAILABLE: could not load enough historical candles from Bybit or Binance')
  }

  const data: SmcDataset = { source: binanceOk > bybitOk ? 'BINANCE_FALLBACK' : 'BYBIT', candles }
  dsCache.set(key, { at: Date.now(), data })
  return data
}

// ─── time-slicing (the structural no-look-ahead guard) ──────────────────────

/** candles whose CLOSE time is ≤ t — binary search over ASC times */
function sliceTo(arr: Candle[], tfMs: number, t: number): Candle[] {
  let lo = 0
  let hi = arr.length // exclusive bound
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (arr[mid].time + tfMs <= t) lo = mid + 1
    else hi = mid
  }
  return arr.slice(0, lo)
}

// ─── per-TF analysis (identical to the live orchestrator) ───────────────────

interface TfAnalysis {
  candles: Candle[]
  atr: number | null
  swings: ReturnType<typeof detectSwings>
  events: ReturnType<typeof analyzeStructure>['events']
  trend: ReturnType<typeof analyzeStructure>['trend']
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

// ─── trade simulation (same math as the live lifecycle tracker) ─────────────

export interface BacktestTrade {
  direction: 'LONG' | 'SHORT'
  quality: string
  score: number
  obTime: number
  obLow: number
  obHigh: number
  entryMid: number
  stopLoss: number
  tp1: number
  tp2: number
  tp3: number
  rr2: number
  signalAt: number // decision close time (entry fill)
  exitAt: number | null
  status: 'ACTIVE' | 'TP1_HIT' | 'TP2_HIT' | 'TP3_HIT' | 'SL_HIT' | 'EXPIRED'
  result: 'WIN' | 'LOSS' | 'BREAKEVEN' | 'EXPIRED' | null
  rMultiple: number | null
  mfeR: number // max favourable excursion in R
  maeR: number // max adverse excursion in R (positive number)
}

const round2 = (n: number) => Math.round(n * 100) / 100

interface OpenSim {
  trade: BacktestTrade
  risk: number
  tp1Done: boolean
}

/**
 * Advance an open simulated trade over 5M candles that close in (from, to].
 * PESSIMISTIC same-candle rule, identical R formulas to the live tracker:
 * LOSS = -1R · BREAKEVEN = ½R at TP1 · WIN = ½R(TP1) + ½R(TP2) (runner free).
 * Returns true when the trade resolved.
 */
function advanceSim(open: OpenSim, candles5M: Candle[], from: number, to: number, cfg: SmcCfg): boolean {
  const t = open.trade
  const long = t.direction === 'LONG'
  const rAt = (p: number) => (long ? (p - t.entryMid) / open.risk : (t.entryMid - p) / open.risk)

  for (const c of candles5M) {
    const closeTime = c.time + TF_MS['5M']
    if (closeTime <= from) continue
    if (closeTime > to) break

    // excursion tracking (wick extremes, same candle)
    const fav = long ? c.high - t.entryMid : t.entryMid - c.low
    const adv = long ? t.entryMid - c.low : c.high - t.entryMid
    t.mfeR = Math.max(t.mfeR, round2(fav / open.risk))
    t.maeR = Math.max(t.maeR, round2(adv / open.risk))

    // pessimistic: stop checked BEFORE targets within the same candle
    const stopped = long ? c.low <= t.stopLoss : c.high >= t.stopLoss
    if (stopped) {
      t.status = 'SL_HIT'
      t.exitAt = closeTime
      t.result = open.tp1Done ? 'BREAKEVEN' : 'LOSS'
      t.rMultiple = open.tp1Done ? round2(0.5 * rAt(t.tp1)) : -1
      return true
    }

    const hit1 = long ? c.high >= t.tp1 : c.low <= t.tp1
    const hit2 = long ? c.high >= t.tp2 : c.low <= t.tp2
    const hit3 = long ? c.high >= t.tp3 : c.low <= t.tp3
    if (hit1 && !open.tp1Done) {
      open.tp1Done = true
      t.status = 'TP1_HIT'
    }
    if (hit2) {
      t.status = 'TP2_HIT'
      t.exitAt = closeTime
      t.result = 'WIN'
      t.rMultiple = round2(0.5 * rAt(t.tp1) + 0.5 * rAt(t.tp2))
      return true
    }
    if (hit3) {
      t.status = 'TP3_HIT'
      t.exitAt = closeTime
      t.result = 'WIN'
      t.rMultiple = round2(0.5 * rAt(t.tp1) + 0.5 * rAt(t.tp2))
      return true
    }
  }

  // expiry (§46): open past maxHoldDays → EXPIRED at the last close ≤ to
  if (to - t.signalAt > cfg.maxHoldDays * 86_400_000) {
    const last = candles5M.filter((c) => c.time + TF_MS['5M'] <= to).pop()
    t.status = 'EXPIRED'
    t.exitAt = to
    t.result = 'EXPIRED'
    t.rMultiple = round2(rAt(last ? last.close : t.entryMid))
    return true
  }
  return false
}

// ─── pipeline replay at one decision point ──────────────────────────────────

function pipelineAt(ds: SmcDataset, t: number, cfg: SmcCfg) {
  const c1D = sliceTo(ds.candles['1D'], TF_MS['1D'], t)
  const c4H = sliceTo(ds.candles['4H'], TF_MS['4H'], t)
  const c1H = sliceTo(ds.candles['1H'], TF_MS['1H'], t)
  const c15 = sliceTo(ds.candles['15M'], TF_MS['15M'], t)
  const c5 = sliceTo(ds.candles['5M'], TF_MS['5M'], t)
  // same sufficiency rule as the live orchestrator's DATA UNAVAILABLE check
  if (c4H.length < 50 || c1H.length < 50 || c15.length < 50 || c5.length < 50) return null

  const a1D = analyzeTf('1D', c1D, cfg)
  const a4H = analyzeTf('4H', c4H, cfg)
  const a1H = analyzeTf('1H', c1H, cfg)
  const a15M = analyzeTf('15M', c15, cfg)
  const a5M = analyzeTf('5M', c5, cfg)

  const levels = detectLiquidity(a1H.candles, a1H.swings, a1H.atr, TF_MS['1H'], cfg, a15M.candles, a1D.candles)
  const sweeps = detectSweeps(levels, a1H.candles, a1H.atr, TF_MS['1H'], cfg)
  const fvgs = detectFvgs(a1H.candles, TF_MS['1H'])
  const obs = detectOrderBlocks(a1H.candles, a1H.events, fvgs, a1H.atr, cfg, a4H.trend, sweeps, TF_MS['1H'])

  // decision price = last CLOSED 5M close (the live engine's ticker equals it at a close)
  const price = c5[c5.length - 1].close

  return evaluateSignal(
    {
      price,
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
      m5: { events: a5M.events, displacement: a5M.displacement, lastCandleTime: a5M.lastCandleTime },
      levels,
      sweeps,
      fvgs,
      htfSwings: [...a1D.swings, ...a4H.swings],
    },
    cfg,
  )
}

// ─── stats ───────────────────────────────────────────────────────────────────

export interface BacktestStats {
  trades: number
  longs: number
  shorts: number
  wins: number
  losses: number
  breakevens: number
  expired: number
  winRatePct: number // wins / (wins + losses); BEs excluded, surfaced separately
  totalR: number
  avgR: number
  profitFactor: number | null // gross win R / gross loss R; null = no losing trade
  maxDrawdownR: number
  avgMfeR: number
  avgMaeR: number
}

function statsFor(trades: BacktestTrade[]): BacktestStats {
  const done = trades.filter((t) => t.result !== null)
  const wins = done.filter((t) => t.result === 'WIN').length
  const losses = done.filter((t) => t.result === 'LOSS').length
  const bes = done.filter((t) => t.result === 'BREAKEVEN').length
  const expired = done.filter((t) => t.result === 'EXPIRED').length
  const rs = done.map((t) => t.rMultiple ?? 0)
  const totalR = round2(rs.reduce((a, b) => a + b, 0))
  const posR = rs.filter((r) => r > 0).reduce((a, b) => a + b, 0)
  const negR = Math.abs(rs.filter((r) => r < 0).reduce((a, b) => a + b, 0))

  // equity curve in exit order → max drawdown in R
  let peak = 0
  let eq = 0
  let maxDd = 0
  for (const r of [...done].sort((a, b) => (a.exitAt ?? 0) - (b.exitAt ?? 0)).map((t) => t.rMultiple ?? 0)) {
    eq += r
    peak = Math.max(peak, eq)
    maxDd = Math.max(maxDd, peak - eq)
  }

  return {
    trades: done.length,
    longs: trades.filter((t) => t.direction === 'LONG').length,
    shorts: trades.filter((t) => t.direction === 'SHORT').length,
    wins,
    losses,
    breakevens: bes,
    expired,
    winRatePct: wins + losses > 0 ? Math.round((wins / (wins + losses)) * 1000) / 10 : 0,
    totalR,
    avgR: done.length > 0 ? round2(totalR / done.length) : 0,
    profitFactor: negR > 0 ? Math.round((posR / negR) * 100) / 100 : posR > 0 ? null : 0,
    maxDrawdownR: round2(maxDd),
    avgMfeR: done.length > 0 ? round2(done.reduce((a, t) => a + t.mfeR, 0) / done.length) : 0,
    avgMaeR: done.length > 0 ? round2(done.reduce((a, t) => a + t.maeR, 0) / done.length) : 0,
  }
}

// ─── the run ─────────────────────────────────────────────────────────────────

export interface BacktestFold {
  index: number
  from: number
  to: number
  stats: BacktestStats
}

export interface BacktestResult {
  ok: true
  symbol: string
  mode: StrategyMode
  days: number
  generatedAt: number
  dataSource: 'BYBIT' | 'BINANCE_FALLBACK'
  dataFrom: number
  dataTo: number
  candleCounts: Record<TF, number>
  decisionPoints: number
  stats: BacktestStats
  longStats: BacktestStats
  shortStats: BacktestStats
  folds: BacktestFold[]
  trades: BacktestTrade[] // most recent last, capped by the endpoint
  disclaimer: string
}

export interface BacktestOptions {
  days: number // 7–90
  mode: StrategyMode
  folds: number // 2–8
}

export async function runBacktest(symbol: string, opts: BacktestOptions): Promise<BacktestResult> {
  const cfg: SmcCfg = { ...SMC_CONFIG, mode: opts.mode }
  const ds = await loadBacktestDataset(symbol, opts.days)

  const now = Date.now()
  const horizonStart = now - opts.days * 86_400_000
  const decisionTimes = ds.candles['15M']
    .filter((c) => c.time + TF_MS['15M'] >= horizonStart)
    .map((c) => c.time + TF_MS['15M'])

  const trades: BacktestTrade[] = []
  const played = new Set<string>() // `${obTime}:${direction}` — never re-enter a played OB
  let open: OpenSim | null = null
  let lastChecked = decisionTimes.length > 0 ? decisionTimes[0] : now

  for (const t of decisionTimes) {
    // 1) advance any open trade over the 5M candles that closed since last check
    if (open) {
      const resolved = advanceSim(open, ds.candles['5M'], lastChecked, t, cfg)
      if (resolved) {
        trades.push(open.trade)
        open = null
      }
    }
    lastChecked = t

    // 2) flat → run the pipeline at this 15M close and look for entries
    if (!open) {
      const ev = pipelineAt(ds, t, cfg)
      if (ev && (ev.signal === 'LONG' || ev.signal === 'SHORT') && ev.ob && ev.trade) {
        const key = `${ev.ob.time}:${ev.signal}`
        if (!played.has(key)) {
          played.add(key)
          const risk =
            ev.signal === 'LONG' ? ev.trade.entry_mid - ev.trade.stop_loss : ev.trade.stop_loss - ev.trade.entry_mid
          if (risk > 0) {
            open = {
              tp1Done: false,
              risk,
              trade: {
                direction: ev.signal,
                quality: ev.quality,
                score: ev.score,
                obTime: ev.ob.time,
                obLow: ev.ob.low,
                obHigh: ev.ob.high,
                entryMid: ev.trade.entry_mid,
                stopLoss: ev.trade.stop_loss,
                tp1: ev.trade.tp1,
                tp2: ev.trade.tp2,
                tp3: ev.trade.tp3,
                rr2: ev.trade.rr2,
                signalAt: t,
                exitAt: null,
                status: 'ACTIVE',
                result: null,
                rMultiple: null,
                mfeR: 0,
                maeR: 0,
              },
            }
          }
        }
      }
    }
  }

  // force-resolve a still-open trade at the final 5M close (EXPIRED, same as §46)
  if (open) {
    const tEnd = ds.candles['5M'][ds.candles['5M'].length - 1].time + TF_MS['5M']
    advanceSim(open, ds.candles['5M'], lastChecked, tEnd + 1, cfg)
    trades.push(open.trade)
    open = null
  }

  trades.sort((a, b) => a.signalAt - b.signalAt)

  // walk-forward folds: equal consecutive windows over the decision span
  const spanStart = decisionTimes[0] ?? now
  const spanEnd = decisionTimes[decisionTimes.length - 1] ?? now
  const foldW = (spanEnd - spanStart) / opts.folds
  const folds: BacktestFold[] = []
  for (let i = 0; i < opts.folds; i++) {
    const from = spanStart + i * foldW
    const to = i === opts.folds - 1 ? spanEnd + 1 : spanStart + (i + 1) * foldW
    const inFold = trades.filter((t) => t.signalAt >= from && t.signalAt < to)
    folds.push({ index: i + 1, from: Math.round(from), to: Math.round(to), stats: statsFor(inFold) })
  }

  const dataFrom = Math.min(...STRATEGY_TFS.map((tf) => (ds.candles[tf].length > 0 ? ds.candles[tf][0].time : Infinity)))
  const dataTo = Math.max(...STRATEGY_TFS.map((tf) => (ds.candles[tf].length > 0 ? ds.candles[tf][ds.candles[tf].length - 1].time : 0)))

  return {
    ok: true,
    symbol,
    mode: opts.mode,
    days: opts.days,
    generatedAt: now,
    dataSource: ds.source,
    dataFrom: Number.isFinite(dataFrom) ? dataFrom : 0,
    dataTo,
    candleCounts: {
      '1D': ds.candles['1D'].length,
      '4H': ds.candles['4H'].length,
      '1H': ds.candles['1H'].length,
      '15M': ds.candles['15M'].length,
      '5M': ds.candles['5M'].length,
    },
    decisionPoints: decisionTimes.length,
    stats: statsFor(trades),
    longStats: statsFor(trades.filter((t) => t.direction === 'LONG')),
    shortStats: statsFor(trades.filter((t) => t.direction === 'SHORT')),
    folds,
    trades: trades.slice(-60),
    disclaimer:
      'Backtest result — historical simulation with fixed parameters, no look-ahead. Past performance does not guarantee future results. No trading is executed.',
  }
}
