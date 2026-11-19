/**
 * Liquidity Lab — the 5-stage signal pipeline contract.
 *
 * Trading order: LIQUIDITY → ORDER FLOW → PRICE MOVEMENT → MARKET STRUCTURE → TRADE ENTRY.
 * The API (GET /api/liquidity/analyze?symbol=BTC — timeframe locked to 4H) returns a LiquidityReport:
 * one JSON object with all five stages, each independently renderable.
 * Crypto only — order books are crypto-specific. Used by src/components/liquidity/LiquidityLab.tsx.
 */

/**
 * Single-timeframe policy: the whole platform reads 4H candles for crypto
 * (1D for stocks) — one timeframe, one signal per asset. The Liquidity Lab
 * used to offer 15m/1h/4h toggles, but multi-timeframe setups produced
 * conflicting entries, so the timeframe is locked to 4H for accuracy.
 */
export type LiqTimeframe = '4h'

// ─── stage 1: liquidity ──────────────────────────────────────────────────────

/** A concentration of resting orders found in the Binance spot + Bybit perp depth. */
export interface DepthCluster {
  side: 'bid' | 'ask'
  priceFrom: number
  priceTo: number
  qty: number
  /** qty × mid price, USD — the size of the wall. */
  notional: number
  /** cluster centre distance from spot, % (positive = above price). */
  distancePct: number
  /** 1-10 relative strength vs the other clusters in this read. */
  strength: number
  venue: 'binance' | 'bybit' | 'combined'
}

export interface OrderBookRead {
  spot: number
  /** USD notional of bids/asks within ±1% of spot. */
  bidNotional1pct: number
  askNotional1pct: number
  /** (bid − ask) / (bid + ask) × 100 — negative means heavier asks above. */
  imbalancePct: number
  clusters: DepthCluster[]
  venues: string[]
  asOf: string
}

/** A pool of resting stop/entry liquidity (where price is likely drawn to sweep). */
export interface LiqPool {
  kind: 'EQH' | 'EQL' | 'PDH' | 'PDL' | 'PWH' | 'PWL' | 'ROUND'
  label: string
  price: number
  /** % from spot (positive above, negative below). */
  distancePct: number
  /** 1-10 — how much liquidity likely rests at this pool. */
  weight: number
}

/** Estimated/observed liquidation leverage zones. */
export interface LiquidationZone {
  /** longs get liquidated BELOW price; shorts ABOVE. */
  side: 'long' | 'short'
  priceFrom: number
  priceTo: number
  estNotional: number
  source: 'coinglass' | 'estimated'
  label: string
}

export interface LiquidityStage {
  book: OrderBookRead
  pools: LiqPool[]
  liquidations: LiquidationZone[]
  nearestPool: { label: string; price: number; distancePct: number; side: 'above' | 'below' } | null
  /** one-paragraph interpretation of the liquidity map. */
  read: string
  /** which venues/APIs actually contributed (honest source list). */
  sources: string[]
}

// ─── stage 2: order flow ─────────────────────────────────────────────────────

export interface FlowStage {
  /** normalized -1..1 — cumulative volume delta slope over the recent window. */
  cvdSlope: number
  cvdTrend: 'buying' | 'selling' | 'balanced'
  bookImbalancePct: number
  /** 24h open interest change, % (null when the OI endpoint is unavailable). */
  oiChange24hPct: number | null
  /** e.g. "OI up + price up — fresh longs are driving the move". */
  oiPriceAlignment: string | null
  /** avg taker buy/sell volume ratio, last 3 hourly prints (>1 = buy dominance). */
  takerRatio: number | null
  verdict: 'AGGRESSIVE_BUYING' | 'AGGRESSIVE_SELLING' | 'BALANCED'
  /** -10..10 (+ = buyers in control). */
  score: number
  read: string
  sources: string[]
}

// ─── stage 3: price movement ─────────────────────────────────────────────────

export interface MovementStage {
  ema20: number | null
  ema50: number | null
  /** EMA20 slope per bar, %. */
  slopePctPerBar: number
  atr: number
  /** ATR percentile vs the trailing window (0-100). */
  atrPctile: number
  /** a body ≥1.8×ATR candle = smart-money displacement. */
  displacement: { direction: 'up' | 'down'; barAgo: number; bodyAtr: number } | null
  /** latest unfilled fair value gap (3-bar imbalance). */
  fvg: { from: number; to: number; direction: 'up' | 'down' } | null
  verdict: 'EXPANSION_UP' | 'EXPANSION_DOWN' | 'GRIND_UP' | 'GRIND_DOWN' | 'SQUEEZE'
  read: string
}

// ─── stage 4: market structure ───────────────────────────────────────────────

export interface StructureStage {
  trend: 'BULL' | 'BEAR' | 'RANGE'
  /** recent swing labels, oldest → newest (e.g. ["HH","HL","HH"]). */
  labels: string[]
  /** break of structure / change of character. */
  bos: { type: 'BOS' | 'CHOCH'; direction: 'bull' | 'bear'; price: number; barAgo: number } | null
  rangeLow: number
  rangeHigh: number
  equilibrium: number
  /** 0 = at range low, 100 = at range high. */
  positionPct: number
  zone: 'DISCOUNT' | 'EQ' | 'PREMIUM'
  read: string
}

// ─── stage 5: trade entry ────────────────────────────────────────────────────

export interface EntrySignal {
  direction: 'LONG' | 'SHORT' | 'NO_TRADE'
  model: 'LIQUIDITY_SWEEP' | 'FVG_RETEST' | 'CONTINUATION' | 'NONE'
  entryLow: number
  entryHigh: number
  stop: number
  /** targets are the OPPOSING liquidity pools — where the money rests. */
  target1: number
  target2: number
  riskReward: string
  /** the exact trigger to watch (e.g. "sweep of EQL 63,336 then reclaim close above it"). */
  trigger: string
  invalidation: string
  /** the full evidence chain: LIQUIDITY → FLOW → MOVEMENT → STRUCTURE. */
  evidence: string[]
  confidence: number
  /** why NO_TRADE (empty when tradeable). */
  blockers: string[]
}

// ─── the report ──────────────────────────────────────────────────────────────

export interface LiquidityReport {
  ok: true
  symbol: string
  displayName: string
  timeframe: LiqTimeframe
  spot: number
  change24hPct: number | null
  asOf: string
  liquidity: LiquidityStage
  flow: FlowStage
  movement: MovementStage
  structure: StructureStage
  entry: EntrySignal
}
