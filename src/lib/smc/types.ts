/**
 * SMC engine — shared types & contracts.
 *
 * Everything in src/lib/smc is a PURE function over closed candles.
 * THE NO-LOOK-AHEAD CONTRACT (mandatory):
 *   - Engines only ever see candles that have CLOSED.
 *   - A swing at index i is CONFIRMED only after `right` candles after it have
 *     closed: confirmedAt = candles[i + right].time + tfMs. Before that it is
 *     DEVELOPING (confirmedAt === null) and MUST NOT be used for BOS/CHoCH,
 *     order blocks, liquidity or signals.
 *   - Structure events fire on candle CLOSES (never wicks) and are stamped
 *     with confirmedAt = candle.time + tfMs.
 *
 * The UI consumes exactly one endpoint shape: SmcAnalysis (see bottom).
 */

import type { Candle } from '@/lib/market/indicators'

export type TF = '1D' | '4H' | '1H' | '15M' | '5M'
export type Direction = 'BULLISH' | 'BEARISH'
export type SignalType = 'LONG' | 'SHORT' | 'WATCHLIST' | 'NO_TRADE'
export type StrategyMode = 'STRICT' | 'BALANCED' | 'AGGRESSIVE'

// ─── market structure ────────────────────────────────────────────────────────

export interface SwingPoint {
  kind: 'HIGH' | 'LOW'
  index: number // index into the candle array it was detected on
  time: number // candle open time (ms)
  price: number
  confirmedAt: number | null // close time of the right-th confirming candle; null = developing
}

export interface StructureEvent {
  type: 'BOS' | 'CHOCH'
  direction: Direction
  breakLevel: number // the swing level that was broken
  swingTime: number // open time of the broken swing's candle
  candleTime: number // open time of the candle whose CLOSE broke it
  confirmedAt: number // close time of that candle (event is final only at confirmedAt)
  strength: number // 0-100: how decisively the level broke (body vs ATR)
}

export interface DisplacementEvent {
  direction: Direction
  time: number // candle open time
  body: number // absolute body size
  atrRatio: number // body / ATR(14)
}

// ─── fair value gaps ─────────────────────────────────────────────────────────

export interface FVG {
  direction: Direction
  low: number // bullish: candle1.high · bearish: candle3.high
  high: number // bullish: candle3.low · bearish: candle1.low
  time: number // open time of candle3 (the confirming candle)
  status: 'ACTIVE' | 'PARTIALLY_FILLED' | 'FILLED' | 'INVALIDATED'
  fillPct: number // 0-100
}

// ─── order blocks ────────────────────────────────────────────────────────────

export type ObStatus = 'ACTIVE' | 'TESTED' | 'MITIGATED' | 'INVALIDATED' | 'EXPIRED'

export interface OrderBlock {
  direction: Direction
  low: number // OB candle low (FULL_RANGE mode)
  high: number // OB candle high
  time: number // OB candle open time — stable dedupe key
  volume: number
  bosLevel: number // structure level the displacement went on to break
  bosTime: number // open time of the BOS candle
  status: ObStatus
  testedCount: number
  strengthScore: number // 0-100 (config weights, §10)
  fresh: boolean // never traded back into
  factors: Record<string, number>
}

// ─── liquidity ───────────────────────────────────────────────────────────────

export type LiqType =
  | 'EQUAL_HIGH'
  | 'EQUAL_LOW'
  | 'PDH'
  | 'PDL'
  | 'PWH'
  | 'PWL'
  | 'SWING_HIGH'
  | 'SWING_LOW'

export interface LiquidityLevel {
  type: LiqType
  price: number
  strength: number // 0-100
  time: number // relevant candle open time
  swept: boolean
  sweptAt: number | null
}

/** BULLISH = a sell-side (lows) pool was swept → bullish reversal context. */
export interface LiquiditySweep {
  direction: Direction
  levelType: LiqType
  level: number
  extreme: number // wick extreme beyond the level
  confirmedAt: number // close time of the candle that closed back through the level
  strength: number // 0-100
}

// ─── per-timeframe summary (UI strip) ────────────────────────────────────────

export interface TfSummary {
  tf: TF
  price: number
  trend: 'BULLISH' | 'BEARISH' | 'NEUTRAL'
  note: string // one human line, e.g. "bullish BOS 08:00 · HL intact"
  bos: boolean // recent BOS in trend direction
  choch: boolean // recent CHoCH
  atr: number | null
  volumeRatio: number | null
}

// ─── scoring ─────────────────────────────────────────────────────────────────

export interface Reason {
  factor: string
  result: string
  points: number
}

// ─── signal history row (from SQLite) ────────────────────────────────────────

export interface SmcHistoryRow {
  id: string
  direction: 'LONG' | 'SHORT'
  quality: string
  score: number
  entryMid: number
  entryLow: number
  entryHigh: number
  stopLoss: number
  tp1: number
  tp2: number
  tp3: number
  status: string // ACTIVE | TP1_HIT | TP2_HIT | TP3_HIT | SL_HIT | EXPIRED | INVALIDATED
  result: string | null // WIN | LOSS | BREAKEVEN | EXPIRED
  rMultiple: number | null
  createdAt: number
  tp1At: number | null
  tp2At: number | null
  tp3At: number | null
  slAt: number | null
}

// ─── THE consolidated response — primary contract (§23/§25/§50) ─────────────

export interface SmcAnalysis {
  ok: true
  symbol: string
  dataSource: 'BYBIT' | 'BINANCE_FALLBACK'
  generatedAt: number
  current_price: number
  change24h: number
  market_bias: 'BULLISH' | 'BEARISH' | 'NEUTRAL'
  timeframes: { trend: TF; structure: TF; setup: TF; entry: TF }
  per_tf: Record<'4H' | '1H' | '15M' | '5M', TfSummary>
  trend: { direction: 'BULLISH' | 'BEARISH' | 'NEUTRAL' }
  structure: { bos: boolean; choch: boolean }
  order_block: {
    type: Direction
    high: number
    low: number
    fresh: boolean
    strength_score: number
    time: number
  } | null
  order_blocks: OrderBlock[]
  fvg: { present: boolean; high: number; low: number; direction: Direction } | null
  fvgs: FVG[]
  liquidity: { sweep: boolean; type: 'SELL_SIDE' | 'BUY_SIDE' | null }
  liquidity_levels: LiquidityLevel[]
  sweeps: LiquiditySweep[]
  signal: SignalType
  quality: 'A+' | 'A' | 'B' | 'C' | '—'
  score: number
  mode: StrategyMode
  trade: {
    entry_low: number
    entry_high: number
    entry_mid: number
    stop_loss: number
    tp1: number
    tp2: number
    tp3: number
  } | null
  risk_reward: { tp1: number; tp2: number; tp3: number }
  explanation: string[]
  reasons: Reason[]
  history: SmcHistoryRow[]
  disclaimer: string
}

export interface SmcAnalysisError {
  ok: false
  symbol: string
  dataSource: 'UNAVAILABLE'
  error: string
  disclaimer: string
}
