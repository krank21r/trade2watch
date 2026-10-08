/**
 * Live trade-setup generator — replaces the original app's static setupJson.
 *
 * Every level is computed from live market structure (Binance/Yahoo candles):
 *   - zones anchored on swing-pivot S/R (never on price itself, so states are honest)
 *   - ATR(14)-derived stops and zone widths
 *   - R:R house gate (T1 ≥ 2×risk, T2 ≥ 3.5×risk)
 *   - a CORRECT zone-state machine: VOID (beyond invalidation) is checked
 *     BEFORE "zone live" — this fixes the original app's false alarms where
 *     a price far above a dead range still fired "SHORT ZONE LIVE".
 *
 * Deterministic and LLM-free: the board regenerates every poll, so levels
 * follow the market and never go stale.
 */

import type { Candle } from '@/lib/market/indicators'
import { CRYPTO_HINT, getCandles, getTicker, searchStockTicker } from '@/lib/market/providers'
import { buildSnapshot, type Regime, type TechnicalSnapshot } from '@/lib/market/snapshot'

// ─── types ───────────────────────────────────────────────────────────────────

export type SideState = 'LIVE' | 'WAITING' | 'VOID'

export interface SideSetup {
  strategy: string
  tag: string // PREFERRED | EDGE ONLY | COUNTER-TREND
  trigger: string
  entryLow: number
  entryHigh: number
  stop: number
  stopNote: string
  t1: number
  t2: number
  runner: number | null
  rr: string
  invalidation: string
  state: SideState
  dist: number | null // price distance to the zone edge (null when LIVE/VOID)
  distPct: number | null
  touchedAt: number | null // candle open time of the most recent wick into the zone
  touchedPrice: number | null // extreme wick print of that touch (candle low/high)
}

export interface LevelRow {
  t: 'res' | 'sup' | 'ema'
  v: number
  w: string
}

export interface BoardSetup {
  symbol: string
  market: 'crypto' | 'stock'
  displayName: string
  pair: string
  currency: string
  price: number
  change24h: number
  timeframe: string
  regime: Regime
  regimeNote: string
  rsi: number | null
  atrPct: number | null
  bias: 'LONG' | 'SHORT' | 'NEUTRAL'
  biasTag: string
  biasNote: string
  long: SideSetup | null
  short: SideSetup | null
  levels: LevelRow[]
  gauge: { min: number; max: number }
  updatedAt: string
}

export interface SetupsPayload {
  setups: BoardSetup[]
  failed: Record<string, string>
  updatedAt: string
}

// ─── pretty names for the majors ─────────────────────────────────────────────

const CRYPTO_NAMES: Record<string, string> = {
  BTC: 'Bitcoin',
  ETH: 'Ethereum',
  SOL: 'Solana',
  BNB: 'BNB',
  XRP: 'XRP',
  ADA: 'Cardano',
  DOGE: 'Dogecoin',
  AVAX: 'Avalanche',
  DOT: 'Polkadot',
  LINK: 'Chainlink',
  LTC: 'Litecoin',
  BCH: 'Bitcoin Cash',
  NEAR: 'NEAR',
  ARB: 'Arbitrum',
  OP: 'Optimism',
  SUI: 'Sui',
  APT: 'Aptos',
  ATOM: 'Cosmos',
  UNI: 'Uniswap',
  AAVE: 'Aave',
  TIA: 'Celestia',
  INJ: 'Injective',
  FIL: 'Filecoin',
  TRX: 'TRON',
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function money(x: number, cur = 'USD'): string {
  const num =
    x >= 1000 ? Math.round(x).toLocaleString('en-US') : String(Math.round(x * 100) / 100)
  return cur === 'USD' ? `$${num}` : `${num} ${cur}`
}

function atrOf(s: TechnicalSnapshot): number {
  return s.atr && s.atr > 0 ? s.atr : s.price * 0.02
}

function rrString(mid: number, risk: number, t1: number, t2: number): string {
  if (risk <= 0) return '—'
  return `1 : ${(Math.abs(t1 - mid) / risk).toFixed(1)} at T1 · 1 : ${(Math.abs(t2 - mid) / risk).toFixed(1)} at T2`
}

// ─── wick-touch detection ────────────────────────────────────────────────────
// Spot-polling alone misses fast touches: price can dip into an entry zone and
// bounce back between two polls (the client samples every 45s, only while the
// tab is open), so a legitimate hit stays invisible. The candle history we
// already fetch is the honest fix — if ANY recent candle's high/low range
// overlapped the zone, the zone WAS hit, exactly as the chart shows it.

const TOUCH_LOOKBACK = 30 // candles ≈ 5 days on 4h crypto · ≈ 6 weeks on 1d stocks

export function detectZoneTouch(
  candles: Candle[],
  side: Pick<SideSetup, 'entryLow' | 'entryHigh' | 'stop'>,
  isLong: boolean,
): { at: number; price: number } | null {
  const recent = candles.slice(-TOUCH_LOOKBACK)
  for (let i = recent.length - 1; i >= 0; i--) {
    const c = recent[i]
    if (!(c.low <= side.entryHigh && c.high >= side.entryLow)) continue // no overlap
    // A close beyond the stop AFTER the touch killed the thesis — don't
    // resurface hits the market has already invalidated.
    const after = recent.slice(i + 1)
    const voided = isLong
      ? after.some((k) => k.close <= side.stop)
      : after.some((k) => k.close >= side.stop)
    if (voided) return null
    return { at: c.time, price: isLong ? c.low : c.high }
  }
  return null
}

/**
 * The zone state machine — single source of truth, shared by the generator
 * and the UI contract. Invalidation (VOID) is checked BEFORE "zone live",
 * which is exactly what the original app's zoneState() was missing.
 */
export function evalSideState(
  side: Pick<SideSetup, 'entryLow' | 'entryHigh' | 'stop'>,
  isLong: boolean,
  price: number,
): SideState {
  if (isLong) {
    if (price <= side.stop) return 'VOID' // thesis dead — never show "zone live"
    return price <= side.entryHigh ? 'LIVE' : 'WAITING'
  }
  if (price >= side.stop) return 'VOID'
  return price >= side.entryLow ? 'LIVE' : 'WAITING'
}

// ─── side builders ───────────────────────────────────────────────────────────

/**
 * LONG setup — zone anchored on the nearest meaningful support BELOW price,
 * kept strictly below current price by a 0.15×ATR no-chase buffer so the
 * state starts honest (WAITING) instead of instantly "live".
 */
export function buildLong(s: TechnicalSnapshot, tag: string): SideSetup {
  const px = s.price
  const a = atrOf(s)
  const ranging = s.regime === 'RANGING'

  const supBelow = s.supports.filter((x) => x < px - 0.05 * a).sort((x, y) => y - x)[0] ?? null

  // zone top anchored on structure: range low (ranging) or swing support;
  // the 0.15×ATR no-chase clamp keeps it strictly below current price so the
  // state starts honest (WAITING) — zones sit AT the level, however far.
  let entryHigh = supBelow !== null ? supBelow + 0.25 * a : px - 0.5 * a
  if (ranging && s.rangeLow < px - 0.15 * a) entryHigh = Math.min(s.rangeLow + 0.4 * a, px - 0.15 * a)
  entryHigh = Math.min(entryHigh, px - 0.15 * a)
  const entryLow = entryHigh - 0.6 * a

  const stop = Math.min(entryLow - 0.75 * a, (supBelow ?? entryLow) - 0.35 * a)
  const mid = (entryLow + entryHigh) / 2
  const risk = mid - stop

  const resAbove = s.resistances.filter((x) => x > entryHigh).sort((x, y) => x - y)
  const t1 = Math.max(resAbove[0] ?? 0, mid + 2 * risk)
  const t2 = Math.max(resAbove[1] ?? 0, mid + 3.5 * risk, t1 + 1.5 * risk)
  const runner = ranging ? null : t2 + 1.5 * a

  // state machine — invalidation FIRST (fixes the original app's false alarms)
  const state = evalSideState({ entryLow, entryHigh, stop }, true, px)
  const dist = state === 'WAITING' ? px - entryHigh : null

  return {
    strategy: ranging ? 'Range-bottom fade' : 'Trend pullback — buy support',
    tag,
    trigger: ranging
      ? 'Drop into the zone at the range low — fade only, skip the middle of the range.'
      : 'Price must pull back into the zone — never chase a breakout candle.',
    entryLow,
    entryHigh,
    stop,
    stopNote: ranging
      ? `below range low ${money(s.rangeLow, s.currency)}`
      : supBelow !== null
        ? `below swing support ${money(supBelow, s.currency)}`
        : 'volatility-adjusted (0.75×ATR under zone)',
    t1,
    t2,
    runner,
    rr: rrString(mid, risk, t1, t2),
    invalidation: `${s.timeframe} close below ${money(stop, s.currency)} voids the long${s.ema50 !== null && s.regime !== 'RANGING' ? `; ${s.timeframe} close below ${money(s.ema50, s.currency)} breaks the trend thesis` : ''}`,
    state,
    dist,
    distPct: dist !== null ? (dist / px) * 100 : null,
    touchedAt: null,
    touchedPrice: null,
  }
}

/** SHORT setup — mirror image, zone anchored on the nearest resistance ABOVE price. */
export function buildShort(s: TechnicalSnapshot, tag: string): SideSetup {
  const px = s.price
  const a = atrOf(s)
  const ranging = s.regime === 'RANGING'

  const resAbove = s.resistances.filter((x) => x > px + 0.05 * a).sort((x, y) => x - y)[0] ?? null

  // zone bottom anchored on structure: range high (ranging) or swing resistance
  let entryLow = resAbove !== null ? resAbove - 0.25 * a : px + 0.5 * a
  if (ranging && s.rangeHigh > px + 0.15 * a) entryLow = Math.max(s.rangeHigh - 0.4 * a, px + 0.15 * a)
  entryLow = Math.max(entryLow, px + 0.15 * a)
  const entryHigh = entryLow + 0.6 * a

  const stop = Math.max(entryHigh + 0.75 * a, (resAbove ?? entryHigh) + 0.35 * a)
  const mid = (entryLow + entryHigh) / 2
  const risk = stop - mid

  const supBelow = s.supports.filter((x) => x < entryLow).sort((x, y) => y - x)
  const t1 = Math.min(supBelow[0] ?? Infinity, mid - 2 * risk)
  const t2 = Math.min(supBelow[1] ?? Infinity, mid - 3.5 * risk, t1 - 1.5 * risk)
  const runner = ranging ? null : t2 - 1.5 * a

  const state = evalSideState({ entryLow, entryHigh, stop }, false, px)
  const dist = state === 'WAITING' ? entryLow - px : null

  return {
    strategy: ranging ? 'Range-top fade' : 'Trend rally-sell — fade resistance',
    tag,
    trigger: ranging
      ? 'Rally into the zone at the range top — fade only, never short mid-range.'
      : 'Price must rally into the zone — never short a fresh breakdown candle.',
    entryLow,
    entryHigh,
    stop,
    stopNote: ranging
      ? `above range high ${money(s.rangeHigh, s.currency)}`
      : resAbove !== null
        ? `above swing resistance ${money(resAbove, s.currency)}`
        : 'volatility-adjusted (0.75×ATR over zone)',
    t1,
    t2,
    runner,
    rr: rrString(mid, risk, t1, t2),
    invalidation: `${s.timeframe} close above ${money(stop, s.currency)} voids the short${s.ema50 !== null && s.regime !== 'RANGING' ? `; ${s.timeframe} close above ${money(s.ema50, s.currency)} reclaims the trend` : ''}`,
    state,
    dist,
    distPct: dist !== null ? (dist / px) * 100 : null,
    touchedAt: null,
    touchedPrice: null,
  }
}

// ─── levels table + gauge ────────────────────────────────────────────────────

function buildLevels(s: TechnicalSnapshot): LevelRow[] {
  const rows: LevelRow[] = []
  for (const v of s.resistances.slice(0, 4)) rows.push({ t: 'res', v, w: 'Swing pivot high — resistance cluster' })
  for (const v of s.supports.slice(0, 4)) rows.push({ t: 'sup', v, w: 'Swing pivot low — support cluster' })
  if (s.ema50 !== null) rows.push({ t: 'ema', v: s.ema50, w: 'EMA50 — dynamic trend reference' })
  if (s.ema200 !== null) rows.push({ t: 'ema', v: s.ema200, w: 'EMA200 — bull/bear divider' })
  rows.push({ t: 'res', v: s.rangeHigh, w: `${s.timeframe === '1d' ? '1-year' : '90-bar'} range high` })
  rows.push({ t: 'sup', v: s.rangeLow, w: `${s.timeframe === '1d' ? '1-year' : '90-bar'} range low` })
  // dedupe within 0.2% proximity, keep the first (higher-priority) label
  rows.sort((x, y) => y.v - x.v)
  const out: LevelRow[] = []
  for (const r of rows) {
    if (!out.some((o) => Math.abs(o.v - r.v) / r.v < 0.002)) out.push(r)
  }
  return out.slice(0, 8)
}

function buildGauge(s: TechnicalSnapshot, long: SideSetup | null, short: SideSetup | null) {
  const stops = [long?.stop, short?.stop].filter((x): x is number => typeof x === 'number')
  const lo = Math.min(s.rangeLow, s.price, ...(stops.length ? stops : [s.price]))
  const hi = Math.max(s.rangeHigh, s.price, ...(stops.length ? stops : [s.price]))
  const pad = (hi - lo) * 0.06 || s.price * 0.02
  return { min: lo - pad, max: hi + pad }
}

// ─── per-symbol assembly ─────────────────────────────────────────────────────

function biasFor(s: TechnicalSnapshot): { bias: 'LONG' | 'SHORT' | 'NEUTRAL'; biasTag: string; biasNote: string } {
  if (s.regime === 'TRENDING_UP') {
    return {
      bias: 'LONG',
      biasTag: 'LONG BIAS',
      biasNote: `Uptrend structure — ${s.regimeNote}. Buy pullbacks into support; shorts are counter-trend fades only.`,
    }
  }
  if (s.regime === 'TRENDING_DOWN') {
    return {
      bias: 'SHORT',
      biasTag: 'SHORT BIAS',
      biasNote: `Downtrend structure — ${s.regimeNote}. Sell rallies into resistance; longs are counter-trend fades only.`,
    }
  }
  return {
    bias: 'NEUTRAL',
    biasTag: 'NEUTRAL — RANGE',
    biasNote: `Range-bound — ${s.regimeNote}. Fade the edges (${money(s.rangeLow, s.currency)} – ${money(s.rangeHigh, s.currency)}), skip the middle.`,
  }
}

async function buildBoardSetup(symbol: string, market: 'crypto' | 'stock', nameHint?: string): Promise<BoardSetup> {
  const timeframe = market === 'crypto' ? '4h' : '1d'
  const [ticker, candles] = await Promise.all([
    getTicker(symbol, market),
    getCandles(symbol, market, timeframe),
  ])
  const s = buildSnapshot(candles, {
    symbol: ticker.symbol,
    market,
    displayName: ticker.displayName,
    currency: ticker.currency,
    price: ticker.price,
    change24h: ticker.change24h,
    timeframe,
  })

  const { bias, biasTag, biasNote } = biasFor(s)
  const long = buildLong(s, bias === 'LONG' ? 'PREFERRED' : s.regime === 'RANGING' ? 'EDGE ONLY' : 'COUNTER-TREND')
  const short = buildShort(s, bias === 'SHORT' ? 'PREFERRED' : s.regime === 'RANGING' ? 'EDGE ONLY' : 'COUNTER-TREND')

  // wick-touch detection from real candles — catches hits that happened
  // between spot polls (or while the tab was closed)
  const longTouch = detectZoneTouch(candles, long, true)
  const shortTouch = detectZoneTouch(candles, short, false)
  long.touchedAt = longTouch?.at ?? null
  long.touchedPrice = longTouch?.price ?? null
  short.touchedAt = shortTouch?.at ?? null
  short.touchedPrice = shortTouch?.price ?? null

  const display =
    market === 'crypto' ? CRYPTO_NAMES[ticker.symbol] ?? ticker.symbol : ticker.displayName || nameHint || ticker.symbol

  return {
    symbol: ticker.symbol,
    market,
    displayName: display,
    pair: market === 'crypto' ? `${ticker.symbol}/USD` : ticker.symbol,
    currency: ticker.currency,
    price: s.price,
    change24h: s.change24h,
    timeframe,
    regime: s.regime,
    regimeNote: s.regimeNote,
    rsi: s.rsi14,
    atrPct: s.atrPct,
    bias,
    biasTag,
    biasNote,
    long,
    short,
    levels: buildLevels(s),
    gauge: buildGauge(s, long, short),
    updatedAt: new Date().toISOString(),
  }
}

async function resolveSymbol(raw: string): Promise<{ symbol: string; market: 'crypto' | 'stock'; name?: string } | null> {
  const sym = raw.toUpperCase()
  if (CRYPTO_HINT.test(sym)) return { symbol: sym, market: 'crypto' }
  try {
    const t = await getTicker(sym, 'stock')
    return { symbol: t.symbol, market: 'stock', name: t.displayName }
  } catch {
    /* fall through to search */
  }
  const found = await searchStockTicker(sym)
  if (found) return { symbol: found.symbol, market: 'stock', name: found.name }
  return null
}

// ─── orchestrator (with short-lived response cache) ──────────────────────────

const respCache = new Map<string, { at: number; data: SetupsPayload }>()
const RESP_TTL = 30_000

export async function generateSetups(symbols: string[]): Promise<SetupsPayload> {
  const key = [...symbols].sort().join(',')
  const hit = respCache.get(key)
  if (hit && Date.now() - hit.at < RESP_TTL) return hit.data

  const settled = await Promise.allSettled(
    symbols.map(async (raw) => {
      const resolved = await resolveSymbol(raw)
      if (!resolved) throw new Error('symbol not found')
      return buildBoardSetup(resolved.symbol, resolved.market, resolved.name)
    }),
  )

  const setups: BoardSetup[] = []
  const failed: Record<string, string> = {}
  settled.forEach((r, i) => {
    if (r.status === 'fulfilled') setups.push(r.value)
    else failed[symbols[i]] = String(r.reason).slice(0, 120)
  })
  setups.sort(
    (a, b) => symbols.indexOf(a.symbol.toUpperCase()) - symbols.indexOf(b.symbol.toUpperCase()),
  )

  const payload: SetupsPayload = { setups, failed, updatedAt: new Date().toISOString() }
  respCache.set(key, { at: Date.now(), data: payload })
  return payload
}
