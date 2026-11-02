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
export type ExchangeId = 'BYBIT' | 'BINANCE'

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

// ─── live performance (computed from the SQLite signal log) ──────────────────

export interface SmcPerformance {
  total: number // rows ever logged for the symbol
  longs: number
  shorts: number
  open: number // still ACTIVE / TP1_HIT / TP2_HIT
  resolved: number
  wins: number
  losses: number
  breakevens: number
  expired: number
  winRatePct: number // wins / (wins + losses); BEs excluded
  totalR: number
  avgR: number
}

// ─── cross-exchange confluence (Bybit × Binance dual-tape validation) ───────

/** Reconciliation rules (see analysis.ts):
 *  FULL          — both tapes agree on the same LONG/SHORT  → signal, +5 score
 *  PARTIAL       — one tape confirms, the other sees the setup (WATCHLIST)
 *                  → signal kept, flagged as single-tape confirmed
 *  CONFLICT      — one says LONG, the other SHORT          → NO_TRADE
 *  SINGLE_SOURCE — the other feed is down                  → signal stands alone
 *  A one-tape LONG/SHORT where the other tape shows NO setup downgrades to
 *  WATCHLIST — a real SMC zone exists on both tapes; signals require BOTH. */
export type ConsensusAgreement = 'FULL' | 'PARTIAL' | 'CONFLICT' | 'SINGLE_SOURCE'

/** One row of the live gate checklist (8 gates, display order). */
export interface GateRow {
  key: 'bias4h' | 'h1' | 'ob' | 'zone' | 'm15' | 'm5' | 'rr' | 'score'
  label: string
  /** gate passed */
  ok: boolean
  /** gate not applicable in the current strategy mode (rendered as "—") */
  na: boolean
  /** one human line: what the gate sees right now */
  note: string | null
}

export interface ExchangeConsensus {
  bybit: SignalType | 'UNAVAILABLE'
  binance: SignalType | 'UNAVAILABLE'
  agreement: ConsensusAgreement
  /** human line explaining the cross-exchange verdict */
  note: string | null
}

/** Does the featured order-block zone exist on BOTH exchange tapes? */
export interface ObCrossCheck {
  direction: Direction | null
  bybit: boolean
  binance: boolean
  /** intersection of the two zones / smaller zone, 0-100; null when uncheckable */
  overlapPct: number | null
}

// ─── THE consolidated response — primary contract (§23/§25/§50) ─────────────

export interface SmcAnalysis {
  ok: true
  symbol: string
  /** BOTH = both tapes healthy and merged; BYBIT / BINANCE_FALLBACK = single tape */
  dataSource: 'BYBIT' | 'BINANCE_FALLBACK' | 'BOTH'
  /** which feeds answered with usable closed candles */
  exchanges: { bybit: boolean; binance: boolean }
  consensus: ExchangeConsensus
  ob_cross_check: ObCrossCheck | null
  /** live gate checklist for the relevant side — answers "what is still missing" */
  gates: GateRow[]
  /** which side the checklist describes (null = no directional setup at all) */
  gate_side: 'LONG' | 'SHORT' | null
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
  /** close time of the entry-trigger event that confirmed the signal
   *  (5M BOS/displacement in STRICT, 15M confirm in BALANCED, OB's 1H BOS
   *  fallback) — null when the current state is WATCHLIST / NO_TRADE */
  signal_confirmed_at: number | null
  /** WATCHLIST only: exactly which confirmation is still missing before this
   *  becomes LONG/SHORT. null for every other state. */
  watch_note: string | null
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
  performance: SmcPerformance | null
  disclaimer: string
}

export interface SmcAnalysisError {
  ok: false
  symbol: string
  dataSource: 'UNAVAILABLE'
  error: string
  disclaimer: string
}

// ─── multi-pair scanner (GET /api/smc/scan) ─────────────────────────────────

export interface SmcScanRow {
  symbol: string
  ok: boolean
  error?: string
  signal: SignalType
  score: number
  quality: 'A+' | 'A' | 'B' | 'C' | '—'
  bias: 'BULLISH' | 'BEARISH' | 'NEUTRAL'
  price: number
  change24h: number
  /** how many healthy tapes confirmed: 2 = Bybit + Binance agree, 1 = single tape */
  confirmations?: 0 | 1 | 2
  agreement?: ConsensusAgreement | null
  /** one-line status: watchlist missing-requirement note, or the top reason */
  note: string | null
  /** the engine's provisional trade plan for this signal — null when no levels exist yet */
  trade: {
    entry_low: number
    entry_high: number
    entry_mid: number
    stop_loss: number
    tp1: number
    tp2: number
    tp3: number
  } | null
  /** R multiples for tp1/tp2/tp3 — null alongside a null trade */
  rr: { tp1: number; tp2: number; tp3: number } | null
  /** close time of the entry-trigger event that confirmed a LIVE signal — null otherwise */
  confirmedAt: number | null
  generatedAt: number
}

export interface SmcScanResponse {
  ok: true
  mode: StrategyMode
  generatedAt: number
  rows: SmcScanRow[]
}

// ─── cross-symbol signal journal (GET /api/smc/signals) ─────────────────────

export interface SmcJournalConfirmedRow extends SmcHistoryRow {
  symbol: string
  mode: string
}

export interface SmcJournalStagedRow {
  id: string
  symbol: string
  direction: 'BULLISH' | 'BEARISH'
  mode: string
  obLow: number
  obHigh: number
  score: number
  quality: string
  note: string
  entryLow: number | null
  entryHigh: number | null
  stopLoss: number | null
  firstSeen: number
  lastSeen: number
}

export interface SmcJournalResponse {
  ok: true
  confirmed: SmcJournalConfirmedRow[]
  staged: SmcJournalStagedRow[]
  generatedAt: number
}
