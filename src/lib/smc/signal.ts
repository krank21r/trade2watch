/**
 * SMC engine — signal evaluation (§17/§20/§21/§45).
 *
 * STRICT LONG requires ALL of:
 *   (a) 4H trend BULLISH                      — higher-timeframe bias
 *   (b) 1H trend BULLISH                      — internal structure agrees;
 *       a 1H trend that CONFLICTS the 4H is a hard NO_TRADE (§45), not a
 *       watchlist — never trade against the internal break of structure
 *   (c) an ACTIVE/TESTED/MITIGATED 1H OB in the direction
 *   (d) current price INSIDE the OB zone (§17.5 — entry is the zone)
 *   (e) 15M BOS or CHoCH in the direction within cfg.confirm15Lookback 15M candles
 *   (f) STRICT only — cfg.entryModeA CONSERVATIVE: 5M bullish BOS within
 *       cfg.confirm5Lookback 5M candles. The CHoCH→BOS pattern: a single
 *       recent 5M BOS in the setup direction satisfies it practically — the
 *       BOS can only print after a CHoCH flipped 5M structure, so demanding
 *       a separate CHoCH event would double-count the same break.
 *       entryModeA AGGRESSIVE: a 5M displacement candle instead.
 *   (g) trade plan != null (RR ≥ minimumRr at TP2)
 *   (h) score ≥ cfg.minimumScore
 *
 * BALANCED skips (f). AGGRESSIVE skips (e) too — structure + zone + plan only.
 *
 * WATCHLIST: 4H bias matches + a valid OB exists, but confirmations are
 * missing (price near-but-not-in the zone, or in the zone without 15M/5M
 * confirmation, or RR/score short) — watchNote explains exactly what is missing.
 *
 * NO_TRADE otherwise. NO execution anywhere — analysis only (§58).
 */

import { TF_MS } from './config'
import { minimumScoreFor } from './cfg'
import type { SmcCfg } from './cfg'
import type {
  Direction,
  DisplacementEvent,
  FVG,
  GateRow,
  LiquidityLevel,
  LiquiditySweep,
  OrderBlock,
  Reason,
  SignalType,
  StructureEvent,
  SwingPoint,
} from './types'
import { recentEvents } from './structure'
import { isActiveOb } from './orderblocks'
import { buildTrade, type TradePlan } from './risk'
import { scoreCandidate } from './scoring'

export interface SignalInput {
  price: number
  mode: 'STRICT' | 'BALANCED' | 'AGGRESSIVE'
  t4: { trend: 'BULLISH' | 'BEARISH' | 'NEUTRAL' }
  h1: {
    trend: 'BULLISH' | 'BEARISH' | 'NEUTRAL'
    events: StructureEvent[]
    obs: OrderBlock[]
    atr: number | null
    volumeRatio: number | null
    displacement: DisplacementEvent | null
    lastCandleTime: number
    swings: SwingPoint[]
  }
  m15: { events: StructureEvent[]; lastCandleTime: number }
  m5: { events: StructureEvent[]; displacement: DisplacementEvent | null; lastCandleTime: number }
  levels: LiquidityLevel[]
  sweeps: LiquiditySweep[]
  fvgs: FVG[]
  /** 4H/1D confirmed swings for the TP3 HTF-liquidity lookup */
  htfSwings?: SwingPoint[]
}

export interface SignalEvaluation {
  signal: SignalType
  ob: OrderBlock | null
  trade: TradePlan | null
  reasons: Reason[]
  score: number
  quality: 'A+' | 'A' | 'B' | 'C' | '—'
  explanation: string[]
  watchNote?: string
  /** live gate checklist for `gateSide` — every gate's pass/fail + why */
  gates: GateRow[]
  /** which side the gates describe (null = no directional setup at all) */
  gateSide: 'LONG' | 'SHORT' | null
  /** close time of the LAST gate that passed — the entry trigger (5M BOS /
   *  displacement in STRICT, latest 15M confirm in BALANCED, OB's own BOS in
   *  AGGRESSIVE). null when nothing confirmed. Powers the UI "confirmed Xm ago". */
  confirmAt: number | null
}

interface SideEval {
  side: 'LONG' | 'SHORT'
  dir: Direction
  dead: boolean // 4H bias mismatches → side impossible
  hardConflict: boolean // 1H trend conflicts 4H → §45 NO_TRADE
  htfOk: boolean
  h1Ok: boolean
  ob: OrderBlock | null // OB containing price (entry OB)
  watchOb: OrderBlock | null // nearest valid OB within 1.5×ATR (watchlist)
  watchDist: number
  inZone: boolean
  m15Ok: boolean
  m5Ok: boolean
  confirmAt: number | null // close time of the last-passed confirmation gate
  trade: TradePlan | null
  score: number
  quality: 'A+' | 'A' | 'B' | 'C' | '—'
  reasons: Reason[]
  passed: boolean
  explanation: string[]
}

function distanceToZone(price: number, ob: OrderBlock): number {
  if (price >= ob.low && price <= ob.high) return 0
  return price > ob.high ? price - ob.high : ob.low - price
}

/**
 * Live gate checklist for the relevant side — the UI renders this verbatim so
 * "why is it not confirming" is always answered on screen, per gate.
 */
function buildGates(side: SideEval | null, data: SignalInput, cfg: SmcCfg): GateRow[] {
  const fmt = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 2 })
  const gate = minimumScoreFor(cfg.mode)
  if (!side) {
    // no directional setup at all (4H neutral or conflicting on both sides)
    const dead4h = data.t4.trend === 'NEUTRAL'
    return [
      { key: 'bias4h', label: '4H bias', ok: false, na: false, note: dead4h ? '4H is NEUTRAL — no directional bias' : `4H is ${data.t4.trend.toLowerCase()} — opposite side evaluated` },
      { key: 'h1', label: '1H structure', ok: false, na: false, note: '—' },
      { key: 'ob', label: 'OB valid', ok: false, na: false, note: '—' },
      { key: 'zone', label: 'Price in zone', ok: false, na: false, note: '—' },
      { key: 'm15', label: '15M confirm', ok: false, na: cfg.mode === 'AGGRESSIVE', note: '—' },
      { key: 'm5', label: '5M trigger', ok: false, na: cfg.mode !== 'STRICT', note: '—' },
      { key: 'rr', label: 'RR ≥ 2R', ok: false, na: false, note: '—' },
      { key: 'score', label: `Score ≥ ${gate}`, ok: false, na: false, note: '—' },
    ]
  }
  const dir = side.dir
  const ob = side.ob ?? side.watchOb
  const atr = data.h1.atr
  const distTxt =
    side.inZone || !ob
      ? null
      : atr && side.watchDist !== Infinity
        ? `${fmt(side.watchDist)} (${(side.watchDist / atr).toFixed(1)}× ATR) away — pullback pending`
        : 'outside the zone'
  return [
    {
      key: 'bias4h',
      label: '4H bias',
      ok: !side.dead,
      na: false,
      note: side.dead ? `4H is ${data.t4.trend.toLowerCase()} — ${side.side.toLowerCase()} side impossible` : `4H ${dir.toLowerCase()} — side valid`,
    },
    {
      key: 'h1',
      label: '1H structure',
      ok: side.h1Ok && !side.hardConflict,
      na: false,
      note: side.hardConflict
        ? '1H conflicts the 4H — hard NO_TRADE (§45)'
        : side.h1Ok
          ? `1H ${dir.toLowerCase()} — agrees with the 4H`
          : '1H neutral — waiting for structure to turn',
    },
    {
      key: 'ob',
      label: 'OB valid',
      ok: ob !== null,
      na: false,
      note: ob
        ? `${dir.toLowerCase()} OB ${fmt(ob.low)}–${fmt(ob.high)} · strength ${ob.strengthScore}`
        : 'no valid OB in range (within 1.5× ATR)',
    },
    {
      key: 'zone',
      label: 'Price in zone',
      ok: side.inZone,
      na: false,
      note: side.inZone
        ? `price ${fmt(data.price)} inside the OB — entry condition met`
        : distTxt ?? 'no zone to enter',
    },
    {
      key: 'm15',
      label: '15M confirm',
      ok: side.m15Ok,
      na: cfg.mode === 'AGGRESSIVE',
      note: cfg.mode === 'AGGRESSIVE' ? 'skipped in AGGRESSIVE mode' : side.m15Ok ? `${dir.toLowerCase()} BOS/CHoCH within ${cfg.confirm15Lookback} candles` : `no recent 15M ${dir.toLowerCase()} break`,
    },
    {
      key: 'm5',
      label: '5M trigger',
      ok: side.m5Ok,
      na: cfg.mode !== 'STRICT',
      note: cfg.mode !== 'STRICT' ? 'skipped in this mode' : side.m5Ok ? `${dir.toLowerCase()} entry trigger confirmed` : `waiting for the 5M ${dir.toLowerCase()} ${cfg.entryModeA === 'CONSERVATIVE' ? 'BOS' : 'displacement'}`,
    },
    {
      key: 'rr',
      label: 'RR ≥ 2R',
      ok: side.trade !== null,
      na: ob === null,
      note: side.trade
        ? `TP2 = ${side.trade.rr2}R from this entry`
        : ob === null
          ? '—'
          : `TP2 below ${cfg.minimumRr}R from this zone`,
    },
    {
      key: 'score',
      label: `Score ≥ ${gate}`,
      ok: side.score >= gate,
      na: false,
      note: `${side.score}/100 (${side.quality}) — ${side.score >= gate ? 'gate passed' : `${gate - side.score} more confluence needed`}`,
    },
  ]
}

function evaluateSide(side: 'LONG' | 'SHORT', data: SignalInput, cfg: SmcCfg): SideEval {
  const dir: Direction = side === 'LONG' ? 'BULLISH' : 'BEARISH'
  const h1TfMs = TF_MS['1H']
  const h1Close = data.h1.lastCandleTime + h1TfMs

  const base: SideEval = {
    side,
    dir,
    dead: false,
    hardConflict: false,
    htfOk: false,
    h1Ok: false,
    ob: null,
    watchOb: null,
    watchDist: Infinity,
    inZone: false,
    m15Ok: false,
    m5Ok: false,
    confirmAt: null,
    trade: null,
    score: 0,
    quality: '—',
    reasons: [],
    passed: false,
    explanation: [],
  }

  // (a) 4H bias — without it the side is impossible (no signal, no watchlist).
  if (data.t4.trend !== dir) {
    base.dead = true
    return base
  }
  base.htfOk = true

  // (b) 1H must agree; conflicting 1H structure is a hard NO_TRADE (§45).
  if (data.h1.trend !== 'NEUTRAL' && data.h1.trend !== dir) {
    base.hardConflict = true
    return base
  }
  base.h1Ok = data.h1.trend === dir

  // (c) valid OB in the direction — ACTIVE/TESTED/MITIGATED only.
  const candidates = data.h1.obs
    .filter((o) => o.direction === dir && isActiveOb(o))
    .sort((a, b) => b.strengthScore - a.strengthScore)

  const containing = candidates.filter((o) => data.price >= o.low && data.price <= o.high)
  base.ob = containing.length > 0 ? containing[0] : null
  base.inZone = base.ob !== null

  if (!base.ob) {
    // nearest valid OB within 1.5 × ATR of price → watchlist candidate
    const atrH1 = data.h1.atr
    if (atrH1 !== null && atrH1 > 0) {
      const near = candidates
        .map((o) => ({ o, dist: distanceToZone(data.price, o) }))
        .filter((x) => x.dist <= 1.5 * atrH1)
        .sort((a, b) => a.dist - b.dist)
      if (near.length > 0) {
        base.watchOb = near[0].o
        base.watchDist = near[0].dist
      }
    }
  }

  // (e) 15M confirmation — skipped in AGGRESSIVE strategy mode.
  const m15Close = data.m15.lastCandleTime + TF_MS['15M']
  const m15Recent = recentEvents(data.m15.events, TF_MS['15M'], cfg.confirm15Lookback, m15Close)
  base.m15Ok =
    data.mode === 'AGGRESSIVE' || m15Recent.some((e) => e.direction === dir)

  // (f) 5M entry trigger — STRICT only (see module doc for CHoCH→BOS note).
  if (data.mode === 'STRICT') {
    const m5Close = data.m5.lastCandleTime + TF_MS['5M']
    if (cfg.entryModeA === 'CONSERVATIVE') {
      const m5Recent = recentEvents(data.m5.events, TF_MS['5M'], cfg.confirm5Lookback, m5Close)
      const m5Triggers = m5Recent.filter((e) => e.type === 'BOS' && e.direction === dir)
      base.m5Ok = m5Triggers.length > 0
      if (base.m5Ok) base.confirmAt = Math.max(...m5Triggers.map((e) => e.confirmedAt))
    } else {
      // AGGRESSIVE 5M entry: displacement candle in the direction.
      base.m5Ok = data.m5.displacement !== null && data.m5.displacement.direction === dir
      if (base.m5Ok && data.m5.displacement) base.confirmAt = data.m5.displacement.time + TF_MS['5M']
    }
  } else {
    base.m5Ok = true
    // BALANCED: last passed gate is the 15M confirmation (AGGRESSIVE mode skips it).
    if (data.mode === 'BALANCED') {
      const m15Triggers = m15Recent.filter((e) => e.direction === dir)
      if (m15Triggers.length > 0) base.confirmAt = Math.max(...m15Triggers.map((e) => e.confirmedAt))
    }
  }

  // final fallback: the OB's own 1H BOS is the last thing that provably confirmed
  if (base.confirmAt === null && base.ob) base.confirmAt = base.ob.bosTime + h1TfMs

  // (g) trade plan (RR gate lives inside buildTrade).
  base.trade = base.ob ? buildTrade(base.ob, side, data.h1.atr, data.levels, data.h1.swings, cfg, undefined, data.htfSwings) : null

  // (h) score — computed from the best available context (entry OB, else watch OB).
  const scoreOb = base.ob ?? base.watchOb
  const recent1H = recentEvents(data.h1.events, h1TfMs, cfg.bosRecencyBars, h1Close)
  const fvgMatch = data.fvgs
    .filter(
      (f) =>
        f.direction === dir &&
        (f.status === 'ACTIVE' || f.status === 'PARTIALLY_FILLED') &&
        scoreOb !== null &&
        f.low <= scoreOb.high + 2 * (data.h1.atr ?? 0) &&
        f.high >= scoreOb.low - 2 * (data.h1.atr ?? 0),
    )
    .sort((a, b) => Math.abs(a.time - data.h1.lastCandleTime) - Math.abs(b.time - data.h1.lastCandleTime))[0]
  const scored = scoreCandidate(
    {
      side: dir,
      htfTrend: data.t4.trend,
      recent1HEvents: recent1H,
      recentSweeps: data.sweeps.filter((s) => s.direction === dir),
      ob: scoreOb,
      fvg: fvgMatch ?? null,
      displacement:
        data.h1.displacement && data.h1.displacement.direction === dir ? data.h1.displacement : null,
      volumeRatio: data.h1.volumeRatio,
      rr2: base.trade ? base.trade.rr2 : null,
    },
    cfg,
  )
  base.score = scored.score
  base.quality = scored.quality
  base.reasons = scored.reasons

  base.passed =
    base.h1Ok && base.ob !== null && base.inZone && base.m15Ok && base.m5Ok && base.trade !== null && base.score >= minimumScoreFor(cfg.mode)

  // ── explanation lines for the satisfied checks (§23 style) ────────────────
  const fmt = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 2 })
  const exp = base.explanation
  if (base.h1Ok) exp.push(`1H structure ${data.h1.trend.toLowerCase()} — agrees with the 4H ${dir.toLowerCase()} bias`)
  if (base.ob)
    exp.push(
      `${dir.toLowerCase()} order block ${fmt(base.ob.low)}–${fmt(base.ob.high)} (strength ${base.ob.strengthScore}, ${base.ob.status.toLowerCase()}${base.ob.fresh ? ', fresh' : ''})`,
    )
  if (base.inZone && base.ob) exp.push(`price ${fmt(data.price)} is inside the order block zone (§17.5 entry)`)
  if (base.m15Ok && data.mode !== 'AGGRESSIVE') exp.push(`15M ${dir.toLowerCase()} BOS/CHoCH confirmed within ${cfg.confirm15Lookback} candles`)
  if (base.m5Ok && data.mode === 'STRICT')
    exp.push(
      cfg.entryModeA === 'CONSERVATIVE'
        ? `5M ${dir.toLowerCase()} BOS entry trigger within ${cfg.confirm5Lookback} candles (CHoCH→BOS complete)`
        : `5M ${dir.toLowerCase()} displacement entry trigger`,
    )
  if (base.trade) exp.push(`plan: RR ${base.trade.rr1}R / ${base.trade.rr2}R / ${base.trade.rr3}R (TP1/TP2/TP3)`)
  if (base.passed) exp.push(`score ${base.score}/100 — quality ${base.quality}`)

  return base
}

export function evaluateSignal(data: SignalInput, cfg: SmcCfg): SignalEvaluation {
  const long = evaluateSide('LONG', data, cfg)
  const short = evaluateSide('SHORT', data, cfg)

  const explanations: string[] = []
  const fmt = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 2 })

  let chosen: SideEval | null = null
  if (long.passed) chosen = long
  else if (short.passed) chosen = short

  if (chosen) {
    const signal: SignalType = chosen.side
    return {
      signal,
      ob: chosen.ob,
      trade: chosen.trade,
      reasons: chosen.reasons,
      score: chosen.score,
      quality: chosen.quality,
      explanation: [...chosen.explanation],
      gates: buildGates(chosen, data, cfg),
      gateSide: chosen.side,
      confirmAt: chosen.confirmAt,
    }
  }

  // ── WATCHLIST: 4H bias matches + valid OB exists, confirmations missing ───
  // NOTE: the candidate is EITHER an OB containing price (failing a later
  // gate) OR the nearest OB within 1.5× ATR — both deserve the radar; a
  // price-in-zone setup must never fall through to NO_TRADE.
  const watch =
    !long.dead && (long.ob ?? long.watchOb)
      ? long
      : !short.dead && (short.ob ?? short.watchOb)
        ? short
        : null
  if (watch) {
    const dirTxt = watch.dir === 'BULLISH' ? 'long' : 'short'
    const ob = watch.ob ?? watch.watchOb!
    let watchNote: string
    if (!watch.h1Ok) {
      watchNote = `waiting for 1H structure to turn ${dirTxt} — ${dirTxt} OB ${fmt(ob.low)}–${fmt(ob.high)} is staged`
    } else if (!watch.inZone) {
      const atrTxt = data.h1.atr && watch.watchDist !== Infinity ? ` (${(watch.watchDist / data.h1.atr).toFixed(1)}× ATR)` : ''
      const dist = watch.watchDist !== Infinity ? fmt(watch.watchDist) : '0'
      watchNote = `price ${fmt(data.price)} is ${dist}${atrTxt} from the ${dirTxt} OB ${fmt(ob.low)}–${fmt(ob.high)} — waiting for the pullback into the zone`
    } else if (!watch.m15Ok && data.mode !== 'AGGRESSIVE') {
      watchNote = `price is inside the ${dirTxt} OB zone — waiting for a 15M ${dirTxt} BOS/CHoCH within ${cfg.confirm15Lookback} candles`
    } else if (!watch.m5Ok && data.mode === 'STRICT') {
      watchNote = `15M confirmed — waiting for the 5M ${dirTxt} ${cfg.entryModeA === 'CONSERVATIVE' ? 'BOS' : 'displacement'} entry trigger`
    } else if (!watch.trade) {
      watchNote = `zone is valid but risk-reward at TP2 is below ${cfg.minimumRr}R from this entry — waiting for a better-priced zone`
    } else {
      watchNote = `score ${watch.score} is below the ${minimumScoreFor(cfg.mode)} ${cfg.mode} threshold — waiting for more confluence`
    }
    if (watch.inZone) watch.explanation.push(`price ${fmt(data.price)} is inside the ${dirTxt} order block zone — watchlist until confirmations land`)
    watch.explanation.push(watchNote)
    return {
      signal: 'WATCHLIST',
      ob: watch.ob ?? watch.watchOb,
      trade: watch.trade, // provisional plan (may be null when RR is the blocker)
      reasons: watch.reasons,
      score: watch.score,
      quality: watch.quality,
      explanation: [...watch.explanation],
      gates: buildGates(watch, data, cfg),
      gateSide: watch.side,
      watchNote,
      confirmAt: null,
    }
  }

  // ── NO_TRADE ───────────────────────────────────────────────────────────────
  const conflictSide = long.hardConflict ? long : short.hardConflict ? short : null
  if (conflictSide) {
    explanations.push(
      `NO_TRADE (§45): 1H structure is ${data.h1.trend.toLowerCase()} against the 4H ${data.t4.trend.toLowerCase()} bias — conflicting timeframes never produce a setup`,
    )
  } else {
    explanations.push(
      `NO_TRADE — 4H bias is ${data.t4.trend.toLowerCase()} and no ${data.t4.trend === 'BULLISH' ? 'long' : data.t4.trend === 'BEARISH' ? 'short' : 'directional'} order-block setup qualifies right now`,
    )
  }
  const reasonsSide = !long.dead ? long : !short.dead ? short : long
  return {
    signal: 'NO_TRADE',
    ob: null,
    trade: null,
    reasons: reasonsSide.reasons,
    score: 0,
    quality: '—',
    explanation: explanations,
    gates: buildGates(!long.dead ? long : !short.dead ? short : null, data, cfg),
    gateSide: !long.dead ? 'LONG' : !short.dead ? 'SHORT' : null,
    confirmAt: null,
  }
}
