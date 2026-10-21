/**
 * Crypto + US-stock screener for the Trader Desk.
 *
 * Ported from trader-skill/trader-screener/screen.py (MIT, Jake Schincariol):
 * every asset is checked against explicit rules (each pass/fail is explained),
 * the ones that pass are ranked by a weighted percentile score, and nothing
 * here is a recommendation — a screen is a filter, not advice.
 *
 * Metrics are computed from public keyless data:
 *   - crypto: Binance daily klines (24h/7d/30d momentum, 30d daily-return
 *     volatility, volume ratio vs its own 30d average, drawdown from the 30d high)
 *   - stocks: Yahoo Finance daily candles — the exact same metric vocabulary,
 *     so one rules JSON drives both markets.
 *
 * The rules/rank JSON shape is identical to the repo's rules.example.json:
 *
 *   { "rules": [{ "metric": "momentum7d", "op": ">=", "value": 0 }],
 *     "rank":  [{ "metric": "momentum7d", "order": "desc", "weight": 2 }],
 *     "missing": "fail", "top": 12 }
 *
 *   ops: > >= < <= == != between [low, high]
 * Ranking: each rank metric gives a score from 0 (worst) to 1 (best); the
 * final score is their weighted average. Missing rank metrics are skipped and
 * reported as gaps.
 *
 * The signal feed (buildFeed) guarantees the pinned crypto majors —
 * BTC, ETH, SOL, XRP — are ALWAYS present, ranked passers fill the rest,
 * and every selected asset carries BOTH a long and a short trade plan.
 */

import { fetchCryptoCandles, fetchStockCandles } from '@/lib/market/providers'
import type { TicketPlan } from './desk'

export type Market = 'crypto' | 'stock'

export interface ScreenerRule {
  metric: string
  op: '>' | '>=' | '<' | '<=' | '==' | '!=' | 'between'
  value: number | [number, number]
}

export interface ScreenerRankKey {
  metric: string
  order?: 'asc' | 'desc'
  weight?: number
}

export interface ScreenerSpec {
  name?: string
  rules: ScreenerRule[]
  rank: ScreenerRankKey[]
  missing?: 'fail' | 'skip'
  top?: number
}

export interface AssetMetrics {
  symbol: string
  name: string
  market: Market
  price: number
  change24hPct: number
  /** alias of change24hPct — keeps the breakout preset's vocabulary valid */
  momentum24h: number
  quoteVolume24h: number
  momentum7d: number
  momentum30d: number
  /** |momentum| — lets one rank key surface the strongest movers in BOTH directions. */
  absMomentum7d: number
  absMomentum30d: number
  volatility30d: number
  volumeRatio: number
  drawdownFrom30dHigh: number
}

export interface ScreenRow {
  symbol: string
  name: string
  market: Market
  passed: boolean
  score: number | null
  rankParts: Record<string, number>
  rankGaps: string[]
  fails: string[]
  passes: string[]
  metrics: AssetMetrics
  /** True when the row is a pinned major (always shown regardless of rank). */
  pinned?: boolean
  /**
   * Desk plan previews — entry zone / stop / T1 / T2 for the LONG and the
   * SHORT setup, from the same level math the journal freezes. Attached to
   * feed rows by the screen API route; null when the data is too thin.
   */
  longPlan?: TicketPlan | null
  shortPlan?: TicketPlan | null
}

/** The crypto majors that must ALWAYS appear in the feed, named by the user. */
export const PINNED_CRYPTO = ['BTC', 'ETH', 'SOL', 'XRP'] as const

const CRYPTO_UNIVERSE: Array<[string, string]> = [
  ['BTC', 'Bitcoin'], ['ETH', 'Ethereum'], ['SOL', 'Solana'], ['BNB', 'BNB'],
  ['XRP', 'XRP'], ['ADA', 'Cardano'], ['DOGE', 'Dogecoin'], ['AVAX', 'Avalanche'],
  ['DOT', 'Polkadot'], ['LINK', 'Chainlink'], ['TRX', 'TRON'], ['LTC', 'Litecoin'],
  ['BCH', 'Bitcoin Cash'], ['UNI', 'Uniswap'], ['ATOM', 'Cosmos'], ['NEAR', 'NEAR'],
  ['APT', 'Aptos'], ['ARB', 'Arbitrum'], ['OP', 'Optimism'], ['SUI', 'Sui'],
  ['INJ', 'Injective'], ['FIL', 'Filecoin'], ['ETC', 'Ethereum Classic'],
  ['XLM', 'Stellar'], ['HBAR', 'Hedera'], ['VET', 'VeChain'], ['ALGO', 'Algorand'],
  ['AAVE', 'Aave'], ['RUNE', 'THORChain'], ['TIA', 'Celestia'], ['SEI', 'Sei'],
  ['ICP', 'Internet Computer'], ['PEPE', 'Pepe'],
]

/** Curated US large caps — the "best stocks" list (mega caps + retail favorites). */
const STOCK_UNIVERSE: Array<[string, string]> = [
  ['AAPL', 'Apple'], ['MSFT', 'Microsoft'], ['NVDA', 'NVIDIA'], ['GOOGL', 'Alphabet'],
  ['AMZN', 'Amazon'], ['META', 'Meta Platforms'], ['TSLA', 'Tesla'], ['AVGO', 'Broadcom'],
  ['AMD', 'AMD'], ['NFLX', 'Netflix'], ['ORCL', 'Oracle'], ['CRM', 'Salesforce'],
  ['PLTR', 'Palantir'], ['COIN', 'Coinbase'], ['JPM', 'JPMorgan Chase'], ['V', 'Visa'],
  ['BAC', 'Bank of America'], ['WMT', 'Walmart'], ['COST', 'Costco'], ['MCD', "McDonald's"],
  ['KO', 'Coca-Cola'], ['UNH', 'UnitedHealth'], ['LLY', 'Eli Lilly'], ['XOM', 'Exxon Mobil'],
]

export const UNIVERSE_SIZE = { crypto: CRYPTO_UNIVERSE.length, stock: STOCK_UNIVERSE.length }

/** Preset screens — editable in the UI as the repo's rules JSON. */
export const PRESETS: Array<{ key: string; label: string; spec: ScreenerSpec }> = [
  {
    key: 'best',
    label: 'Best signals',
    spec: {
      name: 'Best long & short setups',
      // no gate rules — every asset is ranked; the strongest movers in either
      // direction surface first and each carries a long AND a short plan
      rules: [],
      rank: [
        { metric: 'absMomentum7d', order: 'desc', weight: 2 },
        { metric: 'absMomentum30d', order: 'desc', weight: 1.5 },
        { metric: 'volumeRatio', order: 'desc', weight: 1 },
        { metric: 'volatility30d', order: 'asc', weight: 0.75 },
      ],
      top: 12,
    },
  },
  {
    key: 'momentum',
    label: 'Momentum',
    spec: {
      name: 'Momentum',
      rules: [
        { metric: 'momentum7d', op: '>=', value: 0 },
        { metric: 'momentum30d', op: '>=', value: 0 },
        { metric: 'volumeRatio', op: '>=', value: 0.7 },
      ],
      rank: [
        { metric: 'momentum7d', order: 'desc', weight: 2 },
        { metric: 'momentum30d', order: 'desc', weight: 1.5 },
        { metric: 'volumeRatio', order: 'desc', weight: 1 },
        { metric: 'volatility30d', order: 'asc', weight: 1 },
      ],
      top: 12,
    },
  },
  {
    key: 'breakout',
    label: 'Breakout watch',
    spec: {
      name: 'Breakout watch',
      rules: [
        { metric: 'drawdownFrom30dHigh', op: '<=', value: 6 },
        { metric: 'volumeRatio', op: '>=', value: 1 },
      ],
      rank: [
        { metric: 'momentum24h', order: 'desc', weight: 2 },
        { metric: 'volumeRatio', order: 'desc', weight: 1.5 },
        { metric: 'momentum7d', order: 'desc', weight: 1 },
      ],
      top: 12,
    },
  },
  {
    key: 'calm',
    label: 'Calm trends',
    spec: {
      name: 'Calm trends',
      rules: [
        { metric: 'volatility30d', op: '<=', value: 5 },
        { metric: 'momentum30d', op: '>=', value: 0 },
      ],
      rank: [
        { metric: 'volatility30d', order: 'asc', weight: 2 },
        { metric: 'momentum30d', order: 'desc', weight: 1.5 },
        { metric: 'momentum7d', order: 'desc', weight: 1 },
      ],
      top: 12,
    },
  },
]

export class ScreenError extends Error {}

/** How many ranked assets the signal feed shows (pinned majors come on top). */
export const FEED_CAP = 12

const fmtNum = (v: unknown): string => {
  const n = Number(v)
  if (!Number.isFinite(n)) return String(v)
  return Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/\.?0+$/, '')
}

/** (passed, reason). passed is null when the metric is missing. Mirrors check(). */
function checkRule(m: AssetMetrics, rule: ScreenerRule): { ok: boolean | null; why: string } {
  const have = (m as unknown as Record<string, unknown>)[rule.metric]
  if (have === undefined || have === null || have === '') {
    return { ok: null, why: `${rule.metric} is missing` }
  }
  const val = Number(have)
  if (!Number.isFinite(val)) return { ok: false, why: `${rule.metric} is not a number` }
  let ok: boolean
  let why: string
  if (rule.op === 'between') {
    if (!Array.isArray(rule.value) || rule.value.length !== 2)
      throw new ScreenError(`rule on ${rule.metric}: between needs [low, high]`)
    const [lo, hi] = rule.value
    ok = lo <= val && val <= hi
    why = `${rule.metric} ${fmtNum(val)} is ${ok ? 'within' : 'outside'} ${fmtNum(lo)} to ${fmtNum(hi)}`
  } else {
    const want = Number(rule.value)
    ok = { '>': val > want, '>=': val >= want, '<': val < want, '<=': val <= want, '==': val === want, '!=': val !== want }[rule.op]
    why = ok ? `${rule.metric} ${fmtNum(val)} ${rule.op} ${fmtNum(want)}` : `${rule.metric} ${fmtNum(val)}, needs ${rule.op} ${fmtNum(want)}`
  }
  return { ok, why }
}

/** Weighted percentile rank over the passing rows. Mirrors rank(). */
function rankRows(rows: ScreenRow[], keys: ScreenerRankKey[]): void {
  const winners = rows.filter((r) => r.passed)
  for (const r of winners) {
    r.score = null
    r.rankParts = {}
    r.rankGaps = []
  }
  if (!keys.length || !winners.length) return
  for (const k of keys) {
    const desc = k.order !== 'asc'
    const vals = winners
      .map((r) => ({ r, v: (r.metrics as unknown as Record<string, unknown>)[k.metric] }))
      .filter((x): x is { r: ScreenRow; v: number } => Number.isFinite(Number(x.v)) && typeof x.v !== 'boolean')
      .map((x) => ({ r: x.r, v: Number(x.v) }))
    if (!vals.length) continue
    const ordered = vals.map((x) => x.v).sort((a, b) => a - b)
    const n = ordered.length
    for (const { r, v } of vals) {
      const below = ordered.filter((x) => x < v).length
      const equal = ordered.filter((x) => x === v).length
      const pos = n > 1 ? (below + (equal - 1) / 2) / (n - 1) : 1
      r.rankParts[k.metric] = Math.round((desc ? pos : 1 - pos) * 1000) / 1000
    }
  }
  const weights = new Map(keys.map((k) => [k.metric, Number(k.weight ?? 1)]))
  for (const r of winners) {
    const parts = Object.entries(r.rankParts)
    const total = parts.reduce((s, [m]) => s + (weights.get(m) ?? 1), 0)
    r.score = total
      ? Math.round((parts.reduce((s, [m, p]) => s + p * (weights.get(m) ?? 1), 0) / total) * 1000) / 1000
      : null
    r.rankGaps = keys.filter((k) => !(k.metric in r.rankParts)).map((k) => k.metric)
  }
}

/** Validate a spec the same way check_rules() does. */
export function validateSpec(spec: ScreenerSpec): void {
  if (!spec || !Array.isArray(spec.rules)) throw new ScreenError('rules must be {"rules": [...]}')
  spec.rules.forEach((r, i) => {
    if (!r || typeof r.metric !== 'string' || !r.op || r.value === undefined)
      throw new ScreenError(`rule #${i + 1} needs metric, op and value`)
    if (r.op === 'between' && !(Array.isArray(r.value) && r.value.length === 2))
      throw new ScreenError(`rule #${i + 1}: between needs [low, high]`)
  })
  if (spec.rank && !Array.isArray(spec.rank)) throw new ScreenError('rank must be a list')
  if (spec.missing && spec.missing !== 'fail' && spec.missing !== 'skip')
    throw new ScreenError('missing must be "fail" or "skip"')
}

const METRIC_WINDOW = 31 // 30d lookback + today

/** 30-day daily metrics for one asset (crypto via Binance, stocks via Yahoo). */
async function metricsFor(symbol: string, name: string, market: Market): Promise<AssetMetrics> {
  let candles
  if (market === 'crypto') {
    candles = await fetchCryptoCandles(symbol, '1d', METRIC_WINDOW)
  } else {
    // 1y of daily bars — same cache key the plan engine uses, sliced to the
    // same 31-day metric window so the vocabulary matches crypto exactly
    const yearly = await fetchStockCandles(symbol, '1d', '1y')
    candles = yearly.slice(-METRIC_WINDOW)
  }
  if (candles.length < 8) throw new ScreenError(`${symbol}: not enough price history`)
  const closes = candles.map((c) => c.close)
  const last = closes[closes.length - 1]
  const prevDay = closes[closes.length - 2]
  const d7 = closes[Math.max(0, closes.length - 8)]
  const d30 = closes[0]
  const rets: number[] = []
  for (let i = 1; i < closes.length; i++) rets.push(((closes[i] - closes[i - 1]) / closes[i - 1]) * 100)
  const mean = rets.reduce((s, r) => s + r, 0) / rets.length
  const stdev = Math.sqrt(rets.reduce((s, r) => s + (r - mean) ** 2, 0) / rets.length)
  const volToday = candles[candles.length - 1].volume * last // quote volume of the last day
  const volAvg = candles.slice(0, -1).reduce((s, c) => s + c.volume * c.close, 0) / Math.max(1, candles.length - 1)
  const high30 = Math.max(...closes)
  const momentum7d = ((last - d7) / d7) * 100
  const momentum30d = ((last - d30) / d30) * 100
  const change24h = ((last - prevDay) / prevDay) * 100
  return {
    symbol,
    name,
    market,
    price: last,
    change24hPct: change24h,
    momentum24h: change24h,
    quoteVolume24h: volToday,
    momentum7d,
    momentum30d,
    absMomentum7d: Math.abs(momentum7d),
    absMomentum30d: Math.abs(momentum30d),
    volatility30d: stdev,
    volumeRatio: volAvg > 0 ? volToday / volAvg : 0,
    drawdownFrom30dHigh: ((high30 - last) / high30) * 100,
  }
}

export interface ScreenResult {
  name: string
  market: Market
  scanned: number
  passed: number
  asOf: string
  rows: ScreenRow[]
  failedRows: ScreenRow[]
}

/** Run the screen over one market's universe. Returns ranked passers + failures. */
export async function runScreen(spec: ScreenerSpec, market: Market): Promise<ScreenResult> {
  validateSpec(spec)
  const missing = spec.missing ?? 'fail'
  const universe = market === 'crypto' ? CRYPTO_UNIVERSE : STOCK_UNIVERSE
  const metas = await Promise.all(
    universe.map(async ([symbol, name]) => {
      try {
        return await metricsFor(symbol, name, market)
      } catch {
        return null // delisted / rate-limited symbol: skip quietly
      }
    }),
  )
  const metrics = metas.filter((m): m is AssetMetrics => m !== null)
  const rows: ScreenRow[] = metrics.map((m) => {
    const passes: string[] = []
    const fails: string[] = []
    const gaps: string[] = []
    for (const rule of spec.rules) {
      const { ok, why } = checkRule(m, rule)
      if (ok === null) (missing === 'fail' ? fails : gaps).push(why)
      else if (ok) passes.push(why)
      else fails.push(why)
    }
    return {
      symbol: m.symbol,
      name: m.name,
      market,
      passed: fails.length === 0,
      score: null,
      rankParts: {},
      rankGaps: [],
      fails,
      passes,
      metrics: m,
    }
  })
  rankRows(rows, spec.rank ?? [])
  const passedRows = rows
    .filter((r) => r.passed)
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || a.symbol.localeCompare(b.symbol))
  const failedRows = rows
    .filter((r) => !r.passed)
    .sort((a, b) => b.metrics.quoteVolume24h - a.metrics.quoteVolume24h)
  const top = spec.top && spec.top > 0 ? passedRows.slice(0, spec.top) : passedRows
  return {
    name: spec.name ?? 'screen',
    market,
    scanned: rows.length,
    passed: passedRows.length,
    asOf: new Date().toISOString(),
    rows: top,
    failedRows,
  }
}

/**
 * The signal feed for one market: the top-ranked assets, plus the pinned
 * crypto majors (BTC, ETH, SOL, XRP) ALWAYS present — first when they rank
 * on their own, appended (with an honest fail list) when the rules exclude
 * them. Returns rows ordered: pinned first, then the rest by score.
 */
export async function buildFeed(spec: ScreenerSpec, market: Market, cap = FEED_CAP): Promise<ScreenResult> {
  const result = await runScreen(spec, market)
  if (market !== 'crypto') return result // stocks: pure ranking, no pins

  const pins: string[] = [...PINNED_CRYPTO]
  const ranked = result.rows.slice(0, cap)
  const rankedPins = ranked.filter((r) => pins.includes(r.symbol))
  const rankedRest = ranked.filter((r) => !pins.includes(r.symbol))
  const missingPins = pins
    .filter((p) => !result.rows.some((r) => r.symbol === p))
    .map((p) => result.failedRows.find((r) => r.symbol === p) ?? result.rows.find((r) => r.symbol === p))
    .filter((r): r is ScreenRow => r !== undefined)
    .map((r) => ({ ...r, pinned: true }))
  result.rows = [...rankedPins, ...rankedRest, ...missingPins]
  return result
}
