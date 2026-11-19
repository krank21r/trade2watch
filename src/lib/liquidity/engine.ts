/**
 * Liquidity Lab — the 5-stage analysis engine.
 *
 * Pipeline (the user's trading order):
 *   1. LIQUIDITY         — Binance spot + Bybit perp order books → resting-order
 *                          clusters, book imbalance; swing-level pools (EQH/EQL,
 *                          PDH/PDL, PWH/PWL, round numbers); estimated liquidation
 *                          leverage zones (OI × leverage bands + wick cascades).
 *   2. ORDER FLOW        — CVD slope (taker-buy deltas), book imbalance, open
 *                          interest 24h change + price alignment, taker ratio.
 *   3. PRICE MOVEMENT    — EMA stack/slope, ATR percentile (squeeze vs expansion),
 *                          displacement candles, unfilled fair-value gaps.
 *   4. MARKET STRUCTURE  — swing pivots → HH/HL vs LH/LL, BOS/CHoCH, dealing
 *                          range, premium/discount vs equilibrium.
 *   5. TRADE ENTRY       — synthesis: direction only where flow and structure
 *                          agree; entry models = liquidity-sweep reclaim, FVG
 *                          retest, trend continuation; targets = the OPPOSING
 *                          liquidity pools (that is where the money rests).
 *
 * Every stage degrades gracefully — a failed venue/endpoint yields nulls and
 * honest source lists, never a thrown analysis.
 */

import { ema } from '@/lib/market/indicators'
import { fetchCryptoTicker } from '@/lib/market/providers'
import {
  estimateLiquidationZones,
  fetchBinanceDepth,
  fetchBybitDepth,
  fetchFuturesFlow,
  fetchSpotKlines,
  type TakerCandle,
} from './providers'
import type {
  DepthCluster,
  EntrySignal,
  FlowStage,
  LiquidityReport,
  LiquidityStage,
  LiqPool,
  LiqTimeframe,
  MovementStage,
  OrderBookRead,
  StructureStage,
} from './types'

export class LiquidityError extends Error {}

const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x))

const roundPx = (x: number): number => {
  if (!Number.isFinite(x)) return x
  if (x >= 10) return Math.round(x * 100) / 100
  if (x >= 1) return Math.round(x * 1000) / 1000
  return Number(x.toPrecision(4))
}

// ─── shared technicals ───────────────────────────────────────────────────────

function wilderAtr(candles: TakerCandle[], period = 14): { atr: number; history: number[] } {
  const trs: number[] = []
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i]
    const p = candles[i - 1]
    trs.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)))
  }
  const history: number[] = []
  if (trs.length < period) return { atr: trs.length ? trs.reduce((a, b) => a + b, 0) / trs.length : 0, history }
  let prev = trs.slice(0, period).reduce((a, b) => a + b, 0) / period
  history.push(prev)
  for (let i = period; i < trs.length; i++) {
    prev = (prev * (period - 1) + trs[i]) / period
    history.push(prev)
  }
  return { atr: prev, history }
}

interface Swing {
  idx: number
  price: number
  kind: 'high' | 'low'
}

function findSwings(candles: TakerCandle[], strength = 2): Swing[] {
  const out: Swing[] = []
  for (let i = strength; i < candles.length - strength; i++) {
    let isHigh = true
    let isLow = true
    for (let j = 1; j <= strength; j++) {
      if (candles[i].high < candles[i - j].high || candles[i].high < candles[i + j].high) isHigh = false
      if (candles[i].low > candles[i - j].low || candles[i].low > candles[i + j].low) isLow = false
    }
    if (isHigh) out.push({ idx: i, price: candles[i].high, kind: 'high' })
    if (isLow) out.push({ idx: i, price: candles[i].low, kind: 'low' })
  }
  return out
}

// ─── stage 1a: order book read ───────────────────────────────────────────────

interface BookSide {
  bids: Array<{ price: number; qty: number; venue: 'binance' | 'bybit' }>
  asks: Array<{ price: number; qty: number; venue: 'binance' | 'bybit' }>
}

function buildBook(spot: number, binance: BookSide, bybit: BookSide | null): OrderBookRead {
  const venues = bybit ? ['binance', 'bybit'] : ['binance']
  const bidLevels = bybit ? [...binance.bids, ...bybit.bids] : binance.bids
  const askLevels = bybit ? [...binance.asks, ...bybit.asks] : binance.asks

  const bucket = spot * 0.0004 // 4 bps buckets
  const agg = (levels: typeof bidLevels, side: 'bid' | 'ask') => {
    const m = new Map<number, { qty: number; notional: number; binance: boolean; bybit: boolean }>()
    for (const l of levels) {
      const k = Math.round(l.price / bucket)
      const e = m.get(k) ?? { qty: 0, notional: 0, binance: false, bybit: false }
      e.qty += l.qty
      e.notional += l.qty * l.price
      if (l.venue === 'binance') e.binance = true
      else e.bybit = true
      m.set(k, e)
    }
    return m
  }

  const bidMap = agg(bidLevels, 'bid')
  const askMap = agg(askLevels, 'ask')

  // notional within ±1% of spot → imbalance
  const lo = spot * 0.99
  const hi = spot * 1.01
  let bidNotional = 0
  for (const [k, e] of bidMap) if (k * bucket >= lo && k * bucket <= spot) bidNotional += e.notional
  let askNotional = 0
  for (const [k, e] of askMap) if (k * bucket <= hi && k * bucket >= spot) askNotional += e.notional

  const imbalancePct = bidNotional + askNotional > 0 ? ((bidNotional - askNotional) / (bidNotional + askNotional)) * 100 : 0

  // cluster detection: merge adjacent buckets whose notional ≥ max(2.5×median, $30k)
  const clustersFor = (m: Map<number, { qty: number; notional: number; binance: boolean; bybit: boolean }>, side: 'bid' | 'ask') => {
    const buckets = [...m.entries()].sort((a, b) => a[0] - b[0])
    const notionals = buckets.map(([, e]) => e.notional).sort((a, b) => a - b)
    const median = notionals.length ? notionals[Math.floor(notionals.length / 2)] : 0
    const minN = Math.max(median * 2.5, 30_000)
    const raw: Array<{ from: number; to: number; qty: number; notional: number; binance: boolean; bybit: boolean }> = []
    let cur: (typeof raw)[number] | null = null
    for (const [k, e] of buckets) {
      if (e.notional < minN) continue
      if (cur && k === Math.round(cur.to / bucket) + 1) {
        cur.to = k * bucket
        cur.qty += e.qty
        cur.notional += e.notional
        cur.binance ||= e.binance
        cur.bybit ||= e.bybit
      } else {
        cur = { from: k * bucket, to: k * bucket, qty: e.qty, notional: e.notional, binance: e.binance, bybit: e.bybit }
        raw.push(cur)
      }
    }
    // only clusters within ±5% of spot, capped 6 per side, ranked by notional
    const near = raw
      .filter((c) => Math.abs((c.from + c.to) / 2 - spot) / spot <= 0.05)
      .sort((a, b) => b.notional - a.notional)
      .slice(0, 6)
    const maxN = near.length ? near[0].notional : 1
    const out: DepthCluster[] = near.map((c) => ({
      side,
      priceFrom: roundPx(c.from),
      priceTo: roundPx(c.to),
      qty: Math.round(c.qty * 1000) / 1000,
      notional: Math.round(c.notional),
      distancePct: Math.round((((c.from + c.to) / 2 - spot) / spot) * 10000) / 100,
      strength: clamp(Math.round((c.notional / maxN) * 10), 1, 10),
      venue: c.binance && c.bybit ? 'combined' : c.binance ? 'binance' : 'bybit',
    }))
    return out
  }

  return {
    spot: roundPx(spot),
    bidNotional1pct: Math.round(bidNotional),
    askNotional1pct: Math.round(askNotional),
    imbalancePct: Math.round(imbalancePct * 10) / 10,
    clusters: [...clustersFor(askMap, 'ask'), ...clustersFor(bidMap, 'bid')],
    venues,
    asOf: new Date().toISOString(),
  }
}

// ─── stage 1b: liquidity pools ───────────────────────────────────────────────

function buildPools(spot: number, klines: TakerCandle[], daily: TakerCandle[], atr: number): LiqPool[] {
  const pools: LiqPool[] = []
  const tol = Math.max(spot * 0.0012, atr * 0.1)
  const swings = findSwings(klines)

  // equal highs / equal lows — multi-touch swing levels = resting stop liquidity
  for (const kind of ['high', 'low'] as const) {
    const sw = swings.filter((s) => s.kind === kind)
    const groups: Array<{ sum: number; n: number; lastIdx: number }> = []
    for (const s of sw) {
      const g = groups.find((x) => Math.abs(x.sum / x.n - s.price) <= tol)
      if (g) {
        g.sum += s.price
        g.n += 1
        g.lastIdx = Math.max(g.lastIdx, s.idx)
      } else groups.push({ sum: s.price, n: 1, lastIdx: s.idx })
    }
    for (const g of groups.filter((x) => x.n >= 2)) {
      const price = g.sum / g.n
      const distancePct = ((price - spot) / spot) * 100
      if (Math.abs(distancePct) > 6) continue
      const recency = clamp(1 - (klines.length - g.lastIdx) / klines.length, 0, 1)
      pools.push({
        kind: kind === 'high' ? 'EQH' : 'EQL',
        label: `equal ${kind}s ×${g.n}`,
        price: roundPx(price),
        distancePct: Math.round(distancePct * 100) / 100,
        weight: clamp(Math.round(3 + (g.n - 2) * 2 + recency * 2), 1, 10),
      })
    }
  }

  // prior day / prior week highs & lows from completed daily candles
  if (daily.length >= 9) {
    const yesterday = daily[daily.length - 2]
    pools.push(
      { kind: 'PDH', label: 'prior day high', price: roundPx(yesterday.high), distancePct: Math.round(((yesterday.high - spot) / spot) * 10000) / 100, weight: 7 },
      { kind: 'PDL', label: 'prior day low', price: roundPx(yesterday.low), distancePct: Math.round(((yesterday.low - spot) / spot) * 10000) / 100, weight: 7 },
    )
    const week = daily.slice(-8, -1)
    const pwh = Math.max(...week.map((c) => c.high))
    const pwl = Math.min(...week.map((c) => c.low))
    pools.push(
      { kind: 'PWH', label: 'prior week high', price: roundPx(pwh), distancePct: Math.round(((pwh - spot) / spot) * 10000) / 100, weight: 8 },
      { kind: 'PWL', label: 'prior week low', price: roundPx(pwl), distancePct: Math.round(((pwl - spot) / spot) * 10000) / 100, weight: 8 },
    )
  }

  // round numbers — psychological resting levels
  const step =
    spot >= 20000 ? 500 : spot >= 5000 ? 100 : spot >= 1000 ? 50 : spot >= 100 ? 10 : spot >= 10 ? 1 : spot >= 1 ? 0.1 : spot >= 0.01 ? 0.01 : 0.001
  const base = Math.floor(spot / step) * step
  for (const mult of [-2, -1, 1, 2]) {
    const price = base + mult * step
    if (price <= 0) continue
    const distancePct = ((price - spot) / spot) * 100
    if (Math.abs(distancePct) > 6) continue
    pools.push({ kind: 'ROUND', label: `round number ${step >= 1 ? price.toFixed(0) : price}`, price: roundPx(price), distancePct: Math.round(distancePct * 100) / 100, weight: 5 })
  }

  pools.sort((a, b) => Math.abs(a.distancePct) - Math.abs(b.distancePct))
  return pools.slice(0, 12)
}

// ─── stage 2: order flow ─────────────────────────────────────────────────────

function buildFlow(
  spot: number,
  klines: TakerCandle[],
  book: OrderBookRead,
  oiChange24hPct: number | null,
  oiCoins: number | null,
  takerRatio: number | null,
): FlowStage {
  const n = klines.length
  // notional-weighted delta in USD (coins delta × close) so slope is dimensionally consistent
  const delta = klines.map((c) => (2 * c.takerBuy - c.volume) * c.close)
  const recent = delta.slice(-12)
  const prior = delta.slice(-48, -12)
  const cvdRecent = recent.reduce((a, b) => a + b, 0)
  const cvdPrior = prior.reduce((a, b) => a + b, 0)
  const notionalVol = (klines.slice(-12).reduce((a, c) => a + c.volume, 0) || 1) * spot
  const cvdSlope = clamp((cvdRecent - cvdPrior) / (notionalVol * 0.25), -1, 1)
  const sig = notionalVol * 0.12
  const cvdTrend: FlowStage['cvdTrend'] =
    cvdRecent > sig ? 'buying' : cvdRecent < -sig ? 'selling' : 'balanced'

  const price24h = n >= 25 ? ((klines[n - 1].close - klines[n - 25].close) / klines[n - 25].close) * 100 : 0
  let oiPriceAlignment: string | null = null
  let oiScore = 0
  if (oiChange24hPct !== null) {
    const oiUp = oiChange24hPct > 0.5
    const oiDown = oiChange24hPct < -0.5
    const pxUp = price24h > 0.3
    const pxDown = price24h < -0.3
    if (oiUp && pxUp) {
      oiPriceAlignment = `OI ${oiChange24hPct.toFixed(1)}% up + price ${price24h.toFixed(1)}% up — fresh longs are driving the move`
      oiScore = 1.5
    } else if (oiUp && pxDown) {
      oiPriceAlignment = `OI ${oiChange24hPct.toFixed(1)}% up + price ${price24h.toFixed(1)}% down — fresh shorts are driving the move`
      oiScore = -1.5
    } else if (oiDown && pxUp) {
      oiPriceAlignment = `OI ${oiChange24hPct.toFixed(1)}% down + price ${price24h.toFixed(1)}% up — short covering rally, not fresh buying`
      oiScore = 0.5
    } else if (oiDown && pxDown) {
      oiPriceAlignment = `OI ${oiChange24hPct.toFixed(1)}% down + price ${price24h.toFixed(1)}% down — longs unwinding / capitulation`
      oiScore = -1
    } else {
      oiPriceAlignment = `OI ${oiChange24hPct >= 0 ? '+' : ''}${oiChange24hPct.toFixed(1)}% with price roughly flat — positioning churn`
    }
  }

  let takerScore = 0
  let takerText = 'taker ratio unavailable'
  if (takerRatio !== null) {
    takerScore = clamp((takerRatio - 1) * 1.5, -1, 1)
    takerText = `taker buy/sell volume ratio ${takerRatio.toFixed(2)} (${takerRatio > 1.05 ? 'buy dominance' : takerRatio < 0.95 ? 'sell dominance' : 'balanced'})`
  }

  const score = clamp(cvdSlope * 4 + (book.imbalancePct / 100) * 3 + oiScore + takerScore, -10, 10)
  const verdict: FlowStage['verdict'] = score >= 3 ? 'AGGRESSIVE_BUYING' : score <= -3 ? 'AGGRESSIVE_SELLING' : 'BALANCED'

  const sources = ['CVD: Binance spot taker volume']
  if (oiChange24hPct !== null) sources.push('open interest: Binance futures 24h history')
  if (takerRatio !== null) sources.push('taker ratio: Binance futures')

  const fmtS = (x: number): string => (x >= 0 ? '+' : '') + x.toFixed(2)
  const read =
    `Cumulative delta over the last 12 bars is ${fmtS(cvdRecent)} vs ${fmtS(cvdPrior)} over the prior 36 — ` +
    `${cvdTrend === 'buying' ? 'aggressive buyers are lifting offers' : cvdTrend === 'selling' ? 'aggressive sellers are hitting bids' : 'no side is pressing'}. ` +
    `Book imbalance within ±1% is ${book.imbalancePct >= 0 ? '+' : ''}${book.imbalancePct.toFixed(1)}% ` +
    `(${book.imbalancePct > 5 ? 'bids stack heavier below — dip demand' : book.imbalancePct < -5 ? 'asks stack heavier above — supply overhead' : 'two-sided book'}). ` +
    `${oiPriceAlignment ?? 'Open interest unavailable.'} ${takerText}. Net flow score ${fmtS(score)}/10 — ${verdict === 'AGGRESSIVE_BUYING' ? 'buyers in control' : verdict === 'AGGRESSIVE_SELLING' ? 'sellers in control' : 'flow is balanced, demand structure confirmation'}.`

  return {
    cvdSlope: Math.round(cvdSlope * 100) / 100,
    cvdTrend,
    bookImbalancePct: book.imbalancePct,
    oiChange24hPct: oiChange24hPct !== null ? Math.round(oiChange24hPct * 100) / 100 : null,
    oiPriceAlignment,
    takerRatio: takerRatio !== null ? Math.round(takerRatio * 1000) / 1000 : null,
    verdict,
    score: Math.round(score * 10) / 10,
    read,
    sources,
  }
}

// ─── stage 3: price movement ─────────────────────────────────────────────────

function buildMovement(klines: TakerCandle[], spot: number): MovementStage {
  const closes = klines.map((c) => c.close)
  const e20 = ema(closes, 20)
  const e50 = ema(closes, 50)
  const ema20 = e20[e20.length - 1]
  const ema50 = e50[e50.length - 1]
  const ema20Prev = e20[e20.length - 4]
  const slopePctPerBar = ema20 !== null && ema20Prev !== null && ema20Prev !== 0 ? ((ema20 - ema20Prev) / 3 / spot) * 100 : 0

  const { atr, history } = wilderAtr(klines)
  const sorted = [...history].sort((a, b) => a - b)
  const rank = sorted.filter((x) => x <= atr).length
  const atrPctile = sorted.length > 1 ? Math.round((rank / sorted.length) * 100) : 50

  // displacement: a body ≥ 1.8×ATR in the last 12 bars
  let displacement: MovementStage['displacement'] = null
  for (let i = klines.length - 1; i >= Math.max(0, klines.length - 12); i--) {
    const body = Math.abs(klines[i].close - klines[i].open)
    if (atr > 0 && body > 1.8 * atr) {
      displacement = {
        direction: klines[i].close > klines[i].open ? 'up' : 'down',
        barAgo: klines.length - 1 - i,
        bodyAtr: Math.round((body / atr) * 10) / 10,
      }
      break
    }
  }

  // latest unfilled fair value gap in the last 12 bars
  let fvg: MovementStage['fvg'] = null
  for (let i = klines.length - 1; i >= Math.max(2, klines.length - 12); i--) {
    const a = klines[i - 2]
    const c = klines[i]
    const later = klines.slice(i + 1)
    if (c.low > a.high) {
      const filled = later.some((x) => x.low <= a.high)
      if (!filled) {
        fvg = { from: roundPx(a.high), to: roundPx(c.low), direction: 'up' }
        break
      }
    }
    if (c.high < a.low) {
      const filled = later.some((x) => x.high >= a.low)
      if (!filled) {
        fvg = { from: roundPx(c.high), to: roundPx(a.low), direction: 'down' }
        break
      }
    }
  }

  const expanding = atrPctile >= 60
  const verdict: MovementStage['verdict'] =
    atrPctile < 25
      ? 'SQUEEZE'
      : expanding
        ? slopePctPerBar > 0.03
          ? 'EXPANSION_UP'
          : slopePctPerBar < -0.03
            ? 'EXPANSION_DOWN'
            : displacement?.direction === 'up'
              ? 'EXPANSION_UP'
              : displacement?.direction === 'down'
                ? 'EXPANSION_DOWN'
                : 'GRIND_UP'
        : slopePctPerBar > 0.02
          ? 'GRIND_UP'
          : slopePctPerBar < -0.02
            ? 'GRIND_DOWN'
            : 'SQUEEZE'

  const read =
    `${verdict.replace('_', ' ').toLowerCase()}: EMA20 ${ema20 !== null ? roundPx(ema20) : '—'} vs EMA50 ${ema50 !== null ? roundPx(ema50) : '—'}, ` +
    `slope ${slopePctPerBar >= 0 ? '+' : ''}${slopePctPerBar.toFixed(2)}%/bar. ATR ${roundPx(atr)} sits at the ${atrPctile}th percentile ` +
    `(${atrPctile >= 60 ? 'volatility expanding — moves carry follow-through' : atrPctile < 25 ? 'volatility compressed — breakouts likely to fail, wait' : 'normal volatility'}). ` +
    (displacement
      ? `Displacement candle ${displacement.barAgo} bars ago: ${displacement.direction === 'up' ? 'bullish' : 'bearish'} body ${displacement.bodyAtr}×ATR — smart money left footprints. `
      : `No displacement candles in the last 12 bars. `) +
    (fvg
      ? `Unfilled ${fvg.direction === 'up' ? 'bullish' : 'bearish'} FVG ${fvg.from}–${fvg.to} — the likeliest retest zone.`
      : `No unfilled fair-value gaps in the last 12 bars.`)

  return {
    ema20: ema20 !== null ? roundPx(ema20) : null,
    ema50: ema50 !== null ? roundPx(ema50) : null,
    slopePctPerBar: Math.round(slopePctPerBar * 1000) / 1000,
    atr: roundPx(atr),
    atrPctile,
    displacement,
    fvg,
    verdict,
    read,
  }
}

// ─── stage 4: market structure ───────────────────────────────────────────────

function buildStructure(spot: number, klines: TakerCandle[]): StructureStage {
  const swings = findSwings(klines.slice(-150))
  const highs = swings.filter((s) => s.kind === 'high').slice(-3)
  const lows = swings.filter((s) => s.kind === 'low').slice(-3)

  const labels: string[] = []
  if (highs.length >= 2) labels.push(highs[highs.length - 1].price > highs[highs.length - 2].price ? 'HH' : 'LH')
  if (lows.length >= 2) labels.push(lows[lows.length - 1].price > lows[lows.length - 2].price ? 'HL' : 'LL')

  const lastHighUp = highs.length >= 2 && highs[highs.length - 1].price > highs[highs.length - 2].price
  const lastLowUp = lows.length >= 2 && lows[lows.length - 1].price > lows[lows.length - 2].price
  const trend: StructureStage['trend'] = lastHighUp && lastLowUp ? 'BULL' : !lastHighUp && !lastLowUp ? 'BEAR' : 'RANGE'

  // BOS/CHoCH: latest close beyond a confirmed swing level.
  // breaking an HH upward = bull BOS (continuation); breaking an LH upward = bull CHoCH
  // breaking an LL downward = bear BOS; breaking an HL downward = bear CHoCH
  let bos: StructureStage['bos'] = null
  const window = klines.slice(-150)
  let bestBar = -1
  for (const s of swings) {
    // s.idx is relative to `window` (swings were found on the same slice)
    const level = s.price
    for (let j = s.idx + 1; j < window.length; j++) {
      const c = window[j].close
      const brokeUp = s.kind === 'high' && c > level
      const brokeDown = s.kind === 'low' && c < level
      if (!brokeUp && !brokeDown) continue
      const barAgo = window.length - 1 - j
      if (barAgo > 20) continue // only recent breaks matter
      if (j > bestBar) {
        bestBar = j
        // a broken HIGH that was itself an LH (lower than the previous high) = CHoCH up;
        // a broken LOW that was itself an HL (higher than the previous low) = CHoCH down
        const prevHigh = highs.length >= 2 ? highs[highs.length - 2].price : null
        const prevLow = lows.length >= 2 ? lows[lows.length - 2].price : null
        let t: 'BOS' | 'CHOCH' = 'BOS'
        if (s.kind === 'high' && prevHigh !== null && s.price < prevHigh) t = 'CHOCH'
        if (s.kind === 'low' && prevLow !== null && s.price > prevLow) t = 'CHOCH'
        bos = { type: t, direction: brokeUp ? 'bull' : 'bear', price: roundPx(level), barAgo }
      }
      break // only the first break of each swing counts
    }
  }

  const rangeHigh = Math.max(...window.map((c) => c.high))
  const rangeLow = Math.min(...window.map((c) => c.low))
  const equilibrium = (rangeHigh + rangeLow) / 2
  const positionPct = rangeHigh > rangeLow ? clamp(((spot - rangeLow) / (rangeHigh - rangeLow)) * 100, 0, 100) : 50
  const zone: StructureStage['zone'] = positionPct < 40 ? 'DISCOUNT' : positionPct > 60 ? 'PREMIUM' : 'EQ'

  const read =
    `Structure is ${trend === 'BULL' ? 'bullish — higher highs and higher lows' : trend === 'BEAR' ? 'bearish — lower highs and lower lows' : 'ranging — no clean swing progression'}` +
    `${labels.length ? ` (recent swings: ${labels.join(' → ')})` : ''}. ` +
    (bos ? `Latest ${bos.type === 'CHOCH' ? 'change of CHARACTER' : 'break of structure'}: ${bos.direction === 'bull' ? 'bullish' : 'bearish'} break of ${bos.price} ${bos.barAgo} bars ago. ` : `No recent structure break in the last 20 bars. `) +
    `Dealing range ${roundPx(rangeLow)}–${roundPx(rangeHigh)}, equilibrium ${roundPx(equilibrium)}. Price sits at ${positionPct.toFixed(0)}% of the range — ` +
    `${zone === 'DISCOUNT' ? 'DISCOUNT (buy zone — longs get paid here)' : zone === 'PREMIUM' ? 'PREMIUM (sell zone — shorts get paid here)' : 'equilibrium (no edge from location alone)'}.`

  return { trend, labels, bos, rangeLow: roundPx(rangeLow), rangeHigh: roundPx(rangeHigh), equilibrium: roundPx(equilibrium), positionPct: Math.round(positionPct), zone, read }
}

// ─── stage 5: trade entry ────────────────────────────────────────────────────

function buildEntry(
  spot: number,
  klines: TakerCandle[],
  pools: LiqPool[],
  book: OrderBookRead,
  flow: FlowStage,
  movement: MovementStage,
  structure: StructureStage,
  tf: LiqTimeframe,
): EntrySignal {
  const atr = movement.atr
  const blockers: string[] = []
  const evidence: string[] = [
    `LIQUIDITY: book imbalance ${book.imbalancePct >= 0 ? '+' : ''}${book.imbalancePct.toFixed(1)}% within ±1%; ${book.clusters.length} resting clusters; nearest pool ${pools.length ? `${pools[0].label} ${roundPx(pools[0].price)} (${pools[0].distancePct >= 0 ? '+' : ''}${pools[0].distancePct}%)` : 'none detected'}`,
    `FLOW: ${flow.verdict.replace(/_/g, ' ').toLowerCase()} (score ${flow.score >= 0 ? '+' : ''}${flow.score}/10) — CVD ${flow.cvdTrend}`,
    `MOVEMENT: ${movement.verdict.replace(/_/g, ' ').toLowerCase()} — ATR ${movement.atrPctile}th pct, slope ${movement.slopePctPerBar >= 0 ? '+' : ''}${movement.slopePctPerBar.toFixed(2)}%/bar`,
    `STRUCTURE: ${structure.trend} ${structure.zone.toLowerCase()} (${structure.positionPct}% of range)${structure.bos ? `, ${structure.bos.direction} ${structure.bos.type} ${structure.bos.barAgo} bars ago` : ''}`,
  ]

  const flowBull = flow.verdict === 'AGGRESSIVE_BUYING' || (flow.verdict === 'BALANCED' && flow.score >= 1)
  const flowBear = flow.verdict === 'AGGRESSIVE_SELLING' || (flow.verdict === 'BALANCED' && flow.score <= -1)
  const structured = structure.trend !== 'RANGE'
  const flowDecisive = Math.abs(flow.score) >= 5

  let direction: EntrySignal['direction'] = 'NO_TRADE'
  if (structure.trend === 'BULL' && flowBull) direction = 'LONG'
  else if (structure.trend === 'BEAR' && flowBear) direction = 'SHORT'
  else if (flowDecisive && structured && ((structure.trend === 'BULL' && flow.score > 0) || (structure.trend === 'BEAR' && flow.score < 0))) {
    // structure direction confirmed by decisive flow even if the flow verdict chip is BALANCED
    direction = structure.trend === 'BULL' ? 'LONG' : 'SHORT'
  } else if (flowDecisive && !structured && Math.abs(flow.score) >= 6) {
    direction = flow.score > 0 ? 'LONG' : 'SHORT'
  } else {
    if (!structured) blockers.push('market structure is ranging — no directional edge')
    if (!flowBull && !flowBear) blockers.push('order flow is balanced — no aggression to follow')
    if (structured && flowBull && structure.trend === 'BEAR') blockers.push('structure is bearish but flow is buying — wait for alignment')
    if (structured && flowBear && structure.trend === 'BULL') blockers.push('structure is bullish but flow is selling — wait for alignment')
    if (movement.verdict === 'SQUEEZE') blockers.push('volatility squeezed — breakouts prone to failure')
    if (blockers.length === 0) blockers.push('no confluence: liquidity, flow and structure do not agree')
  }

  if (direction === 'NO_TRADE') {
    return {
      direction,
      model: 'NONE',
      entryLow: roundPx(spot),
      entryHigh: roundPx(spot),
      stop: roundPx(spot),
      target1: roundPx(spot),
      target2: roundPx(spot),
      riskReward: '—',
      trigger: 'none — stand aside',
      invalidation: 're-evaluate after flow and structure align',
      evidence,
      confidence: 0,
      blockers,
    }
  }

  const long = direction === 'LONG'
  const entryMidOf = (lo: number, hi: number): number => (lo + hi) / 2

  // model selection
  let model: EntrySignal['model'] = 'NONE'
  let entryLow = 0
  let entryHigh = 0
  let stop = 0
  let trigger = ''
  let sweptBarsAgo = -1
  let sweepPool: LiqPool | null = null

  const candidatePools = pools.filter((p) =>
    long ? p.price < spot && p.distancePct >= -1.2 && ['EQL', 'PDL', 'PWL', 'ROUND'].includes(p.kind) : p.price > spot && p.distancePct <= 1.2 && ['EQH', 'PDH', 'PWH', 'ROUND'].includes(p.kind),
  )

  if (candidatePools.length > 0 && atr > 0) {
    const pool = candidatePools[0]
    sweepPool = pool
    for (let i = klines.length - 1; i >= Math.max(0, klines.length - 6); i--) {
      const swept = long ? klines[i].low <= pool.price : klines[i].high >= pool.price
      const reclaimed = long ? klines[i].close > pool.price : klines[i].close < pool.price
      if (swept && reclaimed) {
        sweptBarsAgo = klines.length - 1 - i
        break
      }
    }
    if (long) {
      entryLow = pool.price - 0.15 * atr
      entryHigh = pool.price + 0.25 * atr
      stop = pool.price - 0.75 * atr
    } else {
      entryLow = pool.price - 0.25 * atr
      entryHigh = pool.price + 0.15 * atr
      stop = pool.price + 0.75 * atr
    }
    model = 'LIQUIDITY_SWEEP'
    trigger =
      sweptBarsAgo >= 0
        ? `${pool.label} at ${roundPx(pool.price)} was swept ${sweptBarsAgo} bars ago and reclaimed — enter while price holds ${long ? 'above' : 'below'} it`
        : `${pool.label} at ${roundPx(pool.price)} (${pool.distancePct >= 0 ? '+' : ''}${pool.distancePct}%) — wait for the ${long ? 'wick below' : 'wick above'} it, then a ${long ? 'close back above' : 'close back below'} (sweep + reclaim)`
  } else if (movement.fvg && atr > 0) {
    const f = movement.fvg
    const reachable = long
      ? f.direction === 'up' && f.to < spot && (spot - f.to) / spot <= 0.025
      : f.direction === 'down' && f.from > spot && (f.from - spot) / spot <= 0.025
    if (reachable) {
      model = 'FVG_RETEST'
      if (long) {
        entryLow = f.from
        entryHigh = f.to
        stop = f.from - 0.75 * atr
      } else {
        entryLow = f.from
        entryHigh = f.to
        stop = f.to + 0.75 * atr
      }
      trigger = `retest of the ${f.direction === 'up' ? 'bullish' : 'bearish'} FVG ${f.from}–${f.to} (3-bar imbalance left by displacement)`
    }
  }

  if (model === 'NONE' && structure.trend !== 'RANGE' && movement.ema20 !== null && atr > 0) {
    const zoneOk = long ? structure.zone !== 'PREMIUM' : structure.zone !== 'DISCOUNT'
    if (zoneOk) {
      model = 'CONTINUATION'
      if (long) {
        entryLow = movement.ema20 - 0.6 * atr
        entryHigh = movement.ema20 + 0.2 * atr
        const recentLow = Math.min(...klines.slice(-10).map((c) => c.low))
        stop = Math.min(recentLow, movement.ema50 ?? recentLow) - 0.5 * atr
      } else {
        entryLow = movement.ema20 - 0.2 * atr
        entryHigh = movement.ema20 + 0.6 * atr
        const recentHigh = Math.max(...klines.slice(-10).map((c) => c.high))
        stop = Math.max(recentHigh, movement.ema50 ?? recentHigh) + 0.5 * atr
      }
      trigger = `pullback into the EMA20 band ${roundPx(entryLow)}–${roundPx(entryHigh)} (trend continuation in ${structure.zone.toLowerCase()})`
    }
  }

  if (model === 'NONE') {
    blockers.push('no sweep candidate, no reachable FVG, and EMA-pullback not sensible here')
    return {
      direction: 'NO_TRADE',
      model: 'NONE',
      entryLow: roundPx(spot),
      entryHigh: roundPx(spot),
      stop: roundPx(spot),
      target1: roundPx(spot),
      target2: roundPx(spot),
      riskReward: '—',
      trigger: 'none — stand aside',
      invalidation: 're-evaluate on the next refresh',
      evidence,
      confidence: 0,
      blockers,
    }
  }

  // targets = the OPPOSING liquidity pools
  const entryMid = entryMidOf(entryLow, entryHigh)
  const risk = Math.abs(entryMid - stop)
  const opposing = pools
    .filter((p) => (long ? p.price > entryHigh : p.price < entryLow))
    .sort((a, b) => Math.abs(a.price - entryMid) - Math.abs(b.price - entryMid))
  const clusterTargets = book.clusters
    .filter((c) => (long ? c.side === 'ask' && c.priceFrom > entryHigh : c.side === 'bid' && c.priceTo < entryLow))
    .map((c) => (c.priceFrom + c.priceTo) / 2)

  let t1 = 0
  for (const p of opposing) {
    if ((Math.abs(p.price - entryMid) / risk) >= 1.2) {
      t1 = p.price
      break
    }
  }
  if (!t1) for (const c of clusterTargets) {
    if ((Math.abs(c - entryMid) / risk) >= 1.2) {
      t1 = c
      break
    }
  }
  if (!t1) t1 = long ? entryMid + 1.6 * risk : entryMid - 1.6 * risk

  let t2 = 0
  for (const p of opposing) {
    if (p.price !== t1 && (Math.abs(p.price - entryMid) / risk) >= 2.6) {
      t2 = p.price
      break
    }
  }
  const structuralT2 = long ? Math.max(structure.rangeHigh, entryMid + 3 * risk) : Math.min(structure.rangeLow, entryMid - 3 * risk)
  t2 = t2 || structuralT2
  if (long && t2 <= t1) t2 = Math.max(t1 + 1.5 * risk, structuralT2)
  if (!long && t2 >= t1) t2 = Math.min(t1 - 1.5 * risk, structuralT2)

  // geometry gate
  const valid = long ? entryHigh > entryLow && stop < entryLow && t1 > entryHigh && t2 > t1 : entryHigh > entryLow && stop > entryHigh && t1 < entryLow && t2 < t1
  if (!valid) {
    blockers.push('plan geometry did not validate against live liquidity — levels need a refresh')
    return {
      direction: 'NO_TRADE',
      model: 'NONE',
      entryLow: roundPx(entryLow),
      entryHigh: roundPx(entryHigh),
      stop: roundPx(stop),
      target1: roundPx(t1),
      target2: roundPx(t2),
      riskReward: '—',
      trigger: trigger || 'none — stand aside',
      invalidation: 're-evaluate on the next refresh',
      evidence,
      confidence: 0,
      blockers,
    }
  }

  const rr1 = (Math.abs(t1 - entryMid) / risk).toFixed(1)
  const rr2 = (Math.abs(t2 - entryMid) / risk).toFixed(1)

  let confidence = 40
  if ((long && structure.trend === 'BULL') || (!long && structure.trend === 'BEAR')) confidence += 20
  if (model === 'LIQUIDITY_SWEEP') confidence += sweptBarsAgo >= 0 ? 15 : 12
  if (model === 'FVG_RETEST') confidence += 12
  if (model === 'CONTINUATION') confidence += 8
  if (long ? structure.zone === 'DISCOUNT' : structure.zone === 'PREMIUM') confidence += 8
  if (Math.abs(flow.score) >= 4) confidence += 7
  if (movement.atrPctile >= 25 && movement.atrPctile <= 80) confidence += 5
  if (sweepPool && sweepPool.weight >= 7) confidence += 3

  const invalidation = long
    ? `a ${tf} candle close below ${roundPx(stop)} voids the long${movement.ema50 ? `; close below EMA50 ${roundPx(movement.ema50)} breaks the trend thesis` : ''}`
    : `a ${tf} candle close above ${roundPx(stop)} voids the short${movement.ema50 ? `; close above EMA50 ${roundPx(movement.ema50)} breaks the trend thesis` : ''}`

  return {
    direction,
    model,
    entryLow: roundPx(entryLow),
    entryHigh: roundPx(entryHigh),
    stop: roundPx(stop),
    target1: roundPx(t1),
    target2: roundPx(t2),
    riskReward: `1 : ${rr1} at T1 · 1 : ${rr2} at T2`,
    trigger,
    invalidation,
    evidence,
    confidence: clamp(confidence, 0, 93),
    blockers: [],
  }
}

// ─── the report ──────────────────────────────────────────────────────────────

export async function buildLiquidityReport(symbol: string, tf: LiqTimeframe): Promise<LiquidityReport> {
  const sym = symbol.trim().toUpperCase()
  if (!/^[A-Z0-9]{2,12}$/.test(sym)) throw new LiquidityError('invalid symbol')
  const pair = `${sym}USDT`

  const [ticker, klines, daily, binanceBook, bybitBook, futures] = await Promise.all([
    fetchCryptoTicker(sym).catch(() => null),
    fetchSpotKlines(pair, tf, 220).catch(() => null),
    fetchSpotKlines(pair, '1d', 30).catch(() => null),
    fetchBinanceDepth(pair).catch(() => null),
    fetchBybitDepth(pair),
    fetchFuturesFlow(pair).catch(() => null),
  ])

  if (!klines || klines.length < 60) throw new LiquidityError(`no market data for ${sym} — is it a Binance spot symbol?`)
  if (!binanceBook) throw new LiquidityError(`order book unavailable for ${pair} — try again shortly`)

  const spot = ticker && ticker.price > 0 ? ticker.price : klines[klines.length - 1].close
  const { atr } = wilderAtr(klines)

  const book = buildBook(spot, binanceBook, bybitBook)
  const pools = buildPools(spot, klines, daily ?? [], atr)
  const flow = buildFlow(spot, klines, book, futures?.oiChange24hPct ?? null, futures?.oiCoins ?? null, futures?.takerRatio ?? null)
  const movement = buildMovement(klines, spot)
  const structure = buildStructure(spot, klines)
  const entry = buildEntry(spot, klines, pools, book, flow, movement, structure, tf)

  const liqSources = ['Binance spot order book']
  if (bybitBook) liqSources.push('Bybit linear perp order book')
  liqSources.push('liquidation zones: model estimate (OI × leverage bands + wick cascades)')

  const liquidityStage: LiquidityStage = {
    book,
    pools,
    liquidations: estimateLiquidationZones(spot, futures?.oiCoins ?? null, klines, atr),
    nearestPool: pools.length
      ? { label: pools[0].label, price: pools[0].price, distancePct: pools[0].distancePct, side: pools[0].price >= spot ? 'above' : 'below' }
      : null,
    read:
      `${book.clusters.length} resting clusters found within ±5% of ${roundPx(spot)} ` +
      `(largest ${book.clusters.length ? `$${Math.round(Math.max(...book.clusters.map((c) => c.notional)) / 100000) / 10}M` : 'n/a'}). ` +
      `Imbalance ${book.imbalancePct >= 0 ? '+' : ''}${book.imbalancePct.toFixed(1)}% ` +
      `(${book.imbalancePct > 5 ? 'bids heavier — dip liquidity below' : book.imbalancePct < -5 ? 'asks heavier — supply above' : 'two-sided'}). ` +
      (pools.length
        ? `Key pools: ${pools.slice(0, 3).map((p) => `${p.label.split(' ')[0]} ${p.price}`).join(', ')}. `
        : `No major pools nearby. `) +
      (liquidityStageNearestText(pools) ?? ''),
    sources: liqSources,
  }

  const change24hPct = ticker?.change24h ?? null
  return {
    ok: true,
    symbol: sym,
    displayName: sym,
    timeframe: tf,
    spot: roundPx(spot),
    change24hPct: change24hPct !== null ? Math.round(change24hPct * 100) / 100 : null,
    asOf: new Date().toISOString(),
    liquidity: liquidityStage,
    flow,
    movement,
    structure,
    entry,
  }
}

function liquidityStageNearestText(pools: LiqPool[]): string | null {
  if (!pools.length) return null
  const p = pools[0]
  return `Nearest pool ${p.label} at ${p.price} (${p.distancePct >= 0 ? '+' : ''}${p.distancePct}%, weight ${p.weight}/10).`
}
