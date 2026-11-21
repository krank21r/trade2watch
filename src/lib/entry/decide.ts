/**
 * Entry Decision engine — fuses the platform's three systems into ONE call
 * per symbol, so choosing a trade entry is a single glance instead of
 * cross-referencing three tabs:
 *
 *   Trade Setups   — deterministic structure zones + bias (every 45s)
 *   AI Signals     — multi-agent desk: direction + confidence + plan (news-aware)
 *   Liquidity Lab  — order-book tape: flow, pools, accuracy gates (crypto only)
 *
 * Actions (the answer to "what do I do right now?"):
 *   TAKE         — systems agree, price is inside the displayed entry zone at
 *                  this moment, and the tape confirms (or there is no tape —
 *                  stocks, vendor outage) — act now.
 *   WAIT         — direction is agreed, but the entry is not actionable yet
 *                  (tape unconfirmed / price away from the zone) — the card
 *                  spells out exactly what must happen first.
 *   SKIP         — the systems contradict each other or the thesis is void.
 *   STAND_ASIDE  — no edge (neutral regime, desk has no opinion).
 *
 * The 0-100 score is a transparency meter, not a promise. Components are
 * shown as the checklist in the UI: consensus 40, tape 30, location 15,
 * reward 10, desk confidence 5.
 *
 * Degradation is honest: a missing/stale AI run, an unavailable liquidity
 * check (stocks, vendor outage, timeout) each become a named gate state —
 * never a silent zero.
 */

import { db } from '@/lib/db'
import {
  detectZoneTouch,
  generateSetups,
  type BoardSetup,
  type SideSetup,
  type SideState,
} from '@/lib/setups/generate'
import { getCandles } from '@/lib/market/providers'
import { buildLiquidityReport, LiquidityError } from '@/lib/liquidity/engine'
import type { LiquidityReport } from '@/lib/liquidity/types'

// ─── payload types (shared with the client) ──────────────────────────────────

export type DecisionAction = 'TAKE' | 'WAIT' | 'SKIP' | 'STAND_ASIDE'

export type BoardVote = 'LONG' | 'SHORT' | 'NEUTRAL'
export type AiVote = 'LONG' | 'SHORT' | 'NEUTRAL' | 'ABSENT'
export type FlowVote = 'LONG' | 'SHORT' | 'NO_TRADE' | 'ABSENT'

export type GateState = 'pass' | 'fail' | 'warn' | 'na'

export interface DecisionGate {
  name: string
  state: GateState
  detail: string
}

export interface DecisionPlan {
  side: 'LONG' | 'SHORT'
  entryLow: number
  entryHigh: number
  stop: number
  t1: number
  t2: number
  /** risk:reward at T1, e.g. 2.0 */
  rr: number
  source: 'Trade Setups' | 'AI desk' | 'Liquidity Lab'
}

export interface EntryDecision {
  symbol: string
  pair: string
  displayName: string
  currency: string
  market: 'crypto' | 'stock'
  price: number
  change24h: number | null
  action: DecisionAction
  score: number // 0-100
  consensus: 'LONG' | 'SHORT' | 'NONE'
  votes: { board: BoardVote; ai: AiVote; flow: FlowVote }
  aiConfidence: number | null
  aiFresh: boolean
  aiRunAt: string | null
  liquidityBlockers: string[]
  zoneState: SideSetup['state'] | null
  zoneDistPct: number | null
  plan: DecisionPlan | null
  gates: DecisionGate[]
  why: string
  becomesTake: string
}

export interface EntryDecisionsPayload {
  decisions: EntryDecision[]
  failed: Record<string, string>
  updatedAt: string
}

// ─── liquidity report cache (per symbol, 120s) ───────────────────────────────

interface LiqSlot {
  at: number
  report: LiquidityReport | null
  error: string | null
}

const liqCache = new Map<string, LiqSlot>()
const LIQ_TTL = 120_000
const LIQ_TIMEOUT_MS = 25_000

async function liqFor(symbol: string): Promise<LiqSlot> {
  const hit = liqCache.get(symbol)
  if (hit && Date.now() - hit.at < LIQ_TTL) return hit
  try {
    const report = await Promise.race([
      buildLiquidityReport(symbol, '4h'),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('liquidity check timed out')), LIQ_TIMEOUT_MS)),
    ])
    const slot: LiqSlot = { at: Date.now(), report, error: null }
    liqCache.set(symbol, slot)
    if (liqCache.size > 40) for (const [k, v] of liqCache) if (Date.now() - v.at > LIQ_TTL) liqCache.delete(k)
    return slot
  } catch (e) {
    const msg = e instanceof LiquidityError ? e.message : String(e).slice(0, 80)
    // cache failures briefly (half TTL) so polls don't hammer a dead vendor
    const slot: LiqSlot = { at: Date.now() - LIQ_TTL / 2, report: null, error: msg }
    liqCache.set(symbol, slot)
    return slot
  }
}

// ─── latest AI desk call for a symbol ────────────────────────────────────────

const AI_STALE_MS = 24 * 60 * 60 * 1000 // 24h — matches the 4H/1D signal cadence

interface AiCall {
  direction: 'LONG' | 'SHORT' | 'NEUTRAL'
  confidence: number
  fresh: boolean
  runAt: Date | null
  entryLow: number | null
  entryHigh: number | null
  stop: number | null
  target1: number | null
  target2: number | null
}

async function aiFor(symbol: string, market: 'crypto' | 'stock'): Promise<AiCall | null> {
  const run = await db.signalRun.findFirst({
    where: { symbol, market, status: 'completed' },
    orderBy: { createdAt: 'desc' },
    select: {
      direction: true,
      confidence: true,
      completedAt: true,
      createdAt: true,
      entryLow: true,
      entryHigh: true,
      stop: true,
      target1: true,
      target2: true,
    },
  })
  if (!run || !run.direction) return null
  const ref = run.completedAt ?? run.createdAt
  const fresh = ref !== null && Date.now() - ref.getTime() < AI_STALE_MS
  return {
    direction: run.direction as AiCall['direction'],
    confidence: typeof run.confidence === 'number' ? run.confidence : 0,
    fresh,
    runAt: ref,
    entryLow: run.entryLow,
    entryHigh: run.entryHigh,
    stop: run.stop,
    target1: run.target1,
    target2: run.target2,
  }
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function sideFor(setup: BoardSetup, dir: 'LONG' | 'SHORT'): SideSetup | null {
  return dir === 'LONG' ? setup.long : setup.short
}

function rrAtT1(side: { entryLow: number; entryHigh: number; stop: number; t1: number }): number {
  const mid = (side.entryLow + side.entryHigh) / 2
  const risk = Math.abs(mid - side.stop)
  if (risk <= 0) return 0
  return Math.abs(side.t1 - mid) / risk
}

function fmtPrice(v: number): string {
  return '$' + (v >= 1000 ? Math.round(v).toLocaleString('en-US') : String(Math.round(v * 100) / 100))
}

// ─── per-symbol fusion ───────────────────────────────────────────────────────

async function decideOne(rawSymbol: string): Promise<EntryDecision> {
  // 1. board (deterministic structure) — also resolves market + display data
  const payload = await generateSetups([rawSymbol])
  const setup = payload.setups.find((s) => s.symbol === rawSymbol.toUpperCase())
  if (!setup) throw new Error(payload.failed[rawSymbol] ?? 'setup unavailable')

  const market = setup.market

  // 2. AI desk call (latest completed run) — stocks + crypto both supported
  const ai = await aiFor(setup.symbol, market).catch(() => null)

  // 3. liquidity tape — crypto only (Liquidity Lab pipeline is crypto-only)
  let flowVote: FlowVote = 'ABSENT'
  let flowDetail = market === 'stock' ? 'crypto-only system' : 'unavailable'
  const liquidityBlockers: string[] = []
  let liqEntry: LiquidityReport['entry'] | null = null
  if (market === 'crypto') {
    const slot = await liqFor(setup.symbol)
    if (slot.report) {
      liqEntry = slot.report.entry
      if (liqEntry.direction === 'NO_TRADE') {
        flowVote = 'NO_TRADE'
        flowDetail = `${slot.report.flow.verdict.toLowerCase().replace(/_/g, ' ')} (score ${slot.report.flow.score}/10)`
        liquidityBlockers.push(...(liqEntry.blockers ?? []).slice(0, 2))
      } else {
        flowVote = liqEntry.direction
        flowDetail = `${liqEntry.model.toLowerCase().replace(/_/g, ' ')} · ${slot.report.flow.verdict.toLowerCase().replace(/_/g, ' ')}`
      }
    } else {
      flowDetail = slot.error ?? 'unavailable'
    }
  }

  // 4. votes
  const boardVote: BoardVote = setup.bias
  const aiVote: AiVote = ai ? ai.direction : 'ABSENT'
  const aiFresh = ai?.fresh ?? false
  const aiConfidence = ai?.confidence ?? null
  const aiRunAt = ai?.runAt ? ai.runAt.toISOString() : null
  const votes = { board: boardVote, ai: aiVote, flow: flowVote }

  // 5. consensus — majority of directional votes (board, ai, flow)
  const directional: Array<'LONG' | 'SHORT'> = []
  if (boardVote !== 'NEUTRAL') directional.push(boardVote)
  if (aiVote === 'LONG' || aiVote === 'SHORT') directional.push(aiVote)
  if (flowVote === 'LONG' || flowVote === 'SHORT') directional.push(flowVote)

  let consensus: 'LONG' | 'SHORT' | 'NONE' = 'NONE'
  let conflict: 'LONG' | 'SHORT' | null = null
  if (directional.length >= 2) {
    const longs = directional.filter((d) => d === 'LONG').length
    const shorts = directional.filter((d) => d === 'SHORT').length
    if (longs > shorts && longs >= 2) consensus = 'LONG'
    else if (shorts > longs && shorts >= 2) consensus = 'SHORT'
  } else if (directional.length === 1 && boardVote !== 'NEUTRAL') {
    // a single directional vote can only carry the plan if it is the
    // deterministic board's own bias (structure is the anchor system)
    consensus = boardVote
  }
  if (consensus !== 'NONE') {
    const opposite = consensus === 'LONG' ? 'SHORT' : 'LONG'
    if (directional.includes(opposite)) conflict = opposite
  }

  // 6. no consensus → STAND_ASIDE
  if (consensus === 'NONE') {
    const neutralDesk = aiVote === 'NEUTRAL' && aiFresh
    const gates: DecisionGate[] = [
      { name: 'Desk agreement', state: 'na', detail: 'no directional consensus across systems' },
      { name: 'Liquidity tape', state: flowVote === 'ABSENT' ? 'na' : 'warn', detail: flowDetail },
      { name: 'Entry zone', state: 'na', detail: 'no side selected' },
      { name: 'Risk:reward', state: 'na', detail: 'no side selected' },
      { name: 'Desk confidence', state: aiVote === 'ABSENT' ? 'na' : 'warn', detail: neutralDesk ? 'AI desk says stand aside (fresh)' : 'no fresh AI call' },
    ]
    return {
      symbol: setup.symbol,
      pair: setup.pair,
      displayName: setup.displayName,
      currency: setup.currency,
      market,
      price: setup.price,
      change24h: setup.change24h,
      action: 'STAND_ASIDE',
      score: 0,
      consensus: 'NONE',
      votes,
      aiConfidence,
      aiFresh,
      aiRunAt,
      liquidityBlockers,
      zoneState: null,
      zoneDistPct: null,
      plan: null,
      gates,
      why: neutralDesk
        ? 'The AI desk and structure both see no edge right now — flat is the position.'
        : 'No directional consensus across the three systems — no trade to consider.',
      becomesTake: 'Re-evaluate after the regime breaks out of the range or a fresh desk call lands.',
    }
  }

  const dir = consensus
  const opposite = dir === 'LONG' ? 'SHORT' : 'LONG'
  const side = sideFor(setup, dir)
  const aiMatches = aiVote === dir
  const flowMatches = flowVote === dir

  // 7. plan levels — liquidity zone when the tape fires, else AI plan, else board zone
  let plan: DecisionPlan | null = null
  if (liqEntry && liqEntry.direction === dir && liqEntry.model !== 'NONE') {
    plan = {
      side: dir,
      entryLow: liqEntry.entryLow,
      entryHigh: liqEntry.entryHigh,
      stop: liqEntry.stop,
      t1: liqEntry.target1,
      t2: liqEntry.target2,
      rr: rrAtT1({ entryLow: liqEntry.entryLow, entryHigh: liqEntry.entryHigh, stop: liqEntry.stop, t1: liqEntry.target1 }),
      source: 'Liquidity Lab',
    }
  } else if (
    aiMatches &&
    ai?.entryLow != null &&
    ai?.entryHigh != null &&
    ai?.stop != null &&
    ai?.target1 != null &&
    ai?.target2 != null
  ) {
    plan = {
      side: dir,
      entryLow: ai.entryLow,
      entryHigh: ai.entryHigh,
      stop: ai.stop,
      t1: ai.target1,
      t2: ai.target2,
      rr: rrAtT1({ entryLow: ai.entryLow, entryHigh: ai.entryHigh, stop: ai.stop, t1: ai.target1 }),
      source: 'AI desk',
    }
  } else if (side) {
    plan = {
      side: dir,
      entryLow: side.entryLow,
      entryHigh: side.entryHigh,
      stop: side.stop,
      t1: side.t1,
      t2: side.t2,
      rr: rrAtT1({ entryLow: side.entryLow, entryHigh: side.entryHigh, stop: side.stop, t1: side.t1 }),
      source: 'Trade Setups',
    }
  }

  // 7b. plan-zone state — the gate must measure the zone the card actually
  // displays (Liquidity Lab / AI desk / board levels). Before this, the gate
  // checked the board's own swing zone while the card showed the AI desk's
  // plan — so price could sit inside the DISPLAYED zone (even wicked into it)
  // and the card still said WAIT. Wick detection reuses the board's candle
  // rule: a wick into the zone triggers the entry even after price moves out.
  let planZoneState: SideState | null = null
  let planZoneDistPct: number | null = null
  let planZoneTouch: { at: number; price: number } | null = null
  if (plan) {
    const isLong = plan.side === 'LONG'
    const px = setup.price
    if (isLong ? px <= plan.stop : px >= plan.stop) {
      planZoneState = 'VOID'
    } else if (px >= plan.entryLow && px <= plan.entryHigh) {
      planZoneState = 'LIVE'
    } else {
      const candles = await getCandles(setup.symbol, market, setup.timeframe).catch(() => [])
      planZoneTouch = candles.length ? detectZoneTouch(candles, plan, isLong) : null
      planZoneState = planZoneTouch ? 'HIT' : 'WAITING'
      if (planZoneState === 'WAITING') {
        const dist = isLong ? px - plan.entryHigh : plan.entryLow - px
        planZoneDistPct = (Math.abs(dist) / px) * 100
      }
    }
  }

  // 8. gates
  const zoneState = side?.state ?? null
  const zoneDistPct = side?.distPct ?? null
  const rr = plan?.rr ?? 0

  const agreementGate: DecisionGate = conflict
    ? { name: 'Desk agreement', state: 'fail', detail: `${conflict.toLowerCase()} evidence contradicts — systems disagree` }
    : aiMatches && boardVote === dir
      ? { name: 'Desk agreement', state: 'pass', detail: `structure + AI desk both ${dir.toLowerCase()}${aiFresh ? '' : ' (stale AI run)'}` }
      : aiMatches
        ? { name: 'Desk agreement', state: 'pass', detail: `AI desk ${dir.toLowerCase()}${aiFresh ? '' : ' (stale run)'}` }
        : boardVote === dir
          ? { name: 'Desk agreement', state: 'warn', detail: aiVote === 'NEUTRAL' ? `structure ${dir.toLowerCase()}, AI desk is neutral` : `structure ${dir.toLowerCase()}, no fresh AI corroboration` }
          : { name: 'Desk agreement', state: 'warn', detail: 'only the liquidity tape supports this side' }

  const flowGate: DecisionGate =
    flowMatches
      ? { name: 'Liquidity tape', state: 'pass', detail: `flow confirms — ${flowDetail}` }
      : flowVote === 'NO_TRADE'
        ? { name: 'Liquidity tape', state: 'warn', detail: liquidityBlockers[0] ?? `tape unconfirmed — ${flowDetail}` }
        : flowVote === opposite
          ? { name: 'Liquidity tape', state: 'fail', detail: `tape is ${opposite.toLowerCase()} — ${flowDetail}` }
          : { name: 'Liquidity tape', state: 'na', detail: flowDetail }

  const zoneGate: DecisionGate =
    planZoneState === 'LIVE'
      ? { name: 'Entry zone', state: 'pass', detail: 'price is inside the entry zone right now' }
      : planZoneState === 'HIT'
        ? { name: 'Entry zone', state: 'pass', detail: `zone wicked to ${fmtPrice(planZoneTouch?.price ?? 0)} — entry triggered, manage by the plan` }
        : planZoneState === 'WAITING'
          ? { name: 'Entry zone', state: 'warn', detail: `${(planZoneDistPct ?? 0).toFixed(1)}% away — set limits and wait` }
          : planZoneState === 'VOID'
            ? { name: 'Entry zone', state: 'fail', detail: 'zone void — price is beyond the plan stop' }
            : { name: 'Entry zone', state: 'fail', detail: 'no actionable plan levels' }

  const rrGate: DecisionGate =
    rr >= 2
      ? { name: 'Risk:reward', state: 'pass', detail: `1:${rr.toFixed(1)} at T1 — house floor met` }
      : rr >= 1.5
        ? { name: 'Risk:reward', state: 'warn', detail: `1:${rr.toFixed(1)} at T1 — below the 1:2 floor` }
        : { name: 'Risk:reward', state: 'fail', detail: `1:${rr.toFixed(1)} at T1 — no edge in the geometry` }

  const confGate: DecisionGate =
    aiConfidence == null
      ? { name: 'Desk confidence', state: 'na', detail: 'no AI run yet — start one from the AI Signals tab' }
      : !aiMatches
        ? { name: 'Desk confidence', state: 'na', detail: `AI desk is ${aiVote.toLowerCase()} — no directional call to grade` }
        : aiConfidence >= 70
          ? { name: 'Desk confidence', state: 'pass', detail: `${aiConfidence}% — above the 70% accuracy bar` }
          : aiConfidence >= 55
            ? { name: 'Desk confidence', state: 'warn', detail: `${aiConfidence}% — below the 70% accuracy bar` }
            : { name: 'Desk confidence', state: 'fail', detail: `${aiConfidence}% — weak conviction` }

  const gates = [agreementGate, flowGate, zoneGate, rrGate, confGate]

  // 9. score 0-100 — consensus 40, tape 30, location 15, reward 10, confidence 5
  let score = 0
  const boardStrong = side?.tag === 'PREFERRED'
  if (boardVote === dir) score += boardStrong ? 15 : 8
  if (aiMatches && ai) score += 25 * (ai.confidence / 100) * (ai.fresh ? 1 : 0.4)
  if (flowMatches) score += 30
  else if (flowVote === 'NO_TRADE') score += 5
  else if (flowVote === 'ABSENT') score += 12
  if (planZoneState === 'LIVE') score += 15
  else if (planZoneState === 'HIT') score += 8
  else if (planZoneState === 'WAITING') score += 4
  if (rr >= 3.5) score += 10
  else if (rr >= 2.5) score += 8
  else if (rr >= 2) score += 6
  else if (rr >= 1.5) score += 3
  score = Math.round(Math.min(100, Math.max(0, score)))

  // 10. action — conflict or void zone veto first, then tape cap, then zone.
  // Tape rule: an explicit NO_TRADE vetoes TAKE; an ABSENT tape (stocks have
  // no order-book pipeline, vendor outage) must not — otherwise stocks could
  // never reach TAKE at all. ABSENT stays a named, visible gate either way.
  const tapeOk = flowMatches || flowVote === 'ABSENT'
  let action: DecisionAction
  if (conflict && score < 50) action = 'SKIP'
  else if (planZoneState === 'VOID') action = 'SKIP'
  else if (flowVote === opposite) action = 'SKIP'
  else if (planZoneState === 'LIVE' && tapeOk && !conflict && rr >= 2) action = 'TAKE'
  else action = 'WAIT'

  // 11. why + becomes-take
  const why =
    action === 'TAKE'
      ? `${dir} agreed by ${flowMatches ? 'all three systems' : 'structure and AI desk'} and price is inside the entry zone now — execute at the plan levels.`
      : action === 'SKIP'
        ? conflict
          ? `Evidence conflicts: ${conflict.toLowerCase()} signals against this ${dir.toLowerCase()} — do not force it.`
          : planZoneState === 'VOID'
            ? `The ${dir.toLowerCase()} zone is void (stop-side invalidated) — wait for fresh structure.`
            : `The tape contradicts the ${dir.toLowerCase()} — skip until flow and structure agree.`
        : planZoneState === 'HIT'
          ? `${dir} entry zone was wicked to ${fmtPrice(planZoneTouch?.price ?? 0)} — the entry triggered, but the remaining gates are not clear yet.`
          : `${dir} direction is set (${[boardVote === dir ? 'structure' : null, aiMatches ? 'AI desk' : null, flowMatches ? 'tape' : null].filter(Boolean).join(' + ')}), but the entry is not actionable yet.`

  let becomesTake: string
  if (action === 'WAIT') {
    const fixes: string[] = []
    if (planZoneState === 'WAITING') fixes.push(`price reaches the entry zone (${(planZoneDistPct ?? 0).toFixed(1)}% away)`)
    if (planZoneState === 'HIT') fixes.push('price re-enters the zone for a fresh fill')
    if (flowVote === 'NO_TRADE') fixes.push('order flow aligns with the direction')
    if (conflict) fixes.push(`the ${conflict.toLowerCase()} evidence flips or expires`)
    if (!aiMatches && aiVote === 'ABSENT') fixes.push('a fresh AI desk call confirms')
    if (rr < 2 && plan) fixes.push('targets stretch to the 1:2 floor')
    becomesTake = fixes.length ? `Becomes TAKE when: ${fixes.slice(0, 2).join(' and ')}.` : 'Becomes TAKE when the remaining gate clears.'
  } else if (action === 'SKIP') {
    becomesTake = 'Re-evaluate after the conflicting evidence resolves.'
  } else {
    becomesTake = 'Act now — then manage by the plan (bank half at T1, stop to entry).'
  }

  return {
    symbol: setup.symbol,
    pair: setup.pair,
    displayName: setup.displayName,
    currency: setup.currency,
    market,
    price: setup.price,
    change24h: setup.change24h,
    action,
    score,
    consensus: dir,
    votes,
    aiConfidence,
    aiFresh,
    aiRunAt,
    liquidityBlockers,
    zoneState: planZoneState ?? zoneState,
    zoneDistPct: planZoneDistPct ?? zoneDistPct,
    plan,
    gates,
    why,
    becomesTake,
  }
}

// ─── orchestrator ────────────────────────────────────────────────────────────

const ACTION_RANK: Record<DecisionAction, number> = { TAKE: 0, WAIT: 1, SKIP: 2, STAND_ASIDE: 3 }

export async function buildEntryDecisions(symbols: string[]): Promise<EntryDecisionsPayload> {
  const uniq = [...new Set(symbols.map((s) => s.trim().toUpperCase()))].slice(0, 8)
  const settled = await Promise.allSettled(uniq.map((s) => decideOne(s)))

  const decisions: EntryDecision[] = []
  const failed: Record<string, string> = {}
  settled.forEach((r, i) => {
    if (r.status === 'fulfilled') decisions.push(r.value)
    else failed[uniq[i]] = String(r.reason).slice(0, 120)
  })

  decisions.sort((a, b) => {
    const ra = ACTION_RANK[a.action]
    const rb = ACTION_RANK[b.action]
    if (ra !== rb) return ra - rb
    return b.score - a.score
  })

  return { decisions, failed, updatedAt: new Date().toISOString() }
}
