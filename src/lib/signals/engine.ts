/**
 * Multi-agent signal engine — a TypeScript adaptation of
 * TauricResearch/TradingAgents, sized for this app.
 *
 * Pipeline (all LLM calls via z-ai SDK, backend only):
 *   1. data        — fetch candles + ticker + news, build technical snapshot (deterministic)
 *   2. analysts    — 3 parallel analysts: technical / news / market-structure
 *   3. debate      — bull vs bear (1 round) → research manager verdict
 *   4. plan        — DETERMINISTIC trade-plan engineer (entries/stops/targets from structure)
 *   5. risk        — aggressive / conservative / neutral critique (parallel)
 *   6. decision    — portfolio manager approves/adjusts/rejects → final signal
 *
 * Key design choice (differs from upstream): the LLM agents decide
 * DIRECTION and confidence; the entry zone, stop and targets are computed
 * mechanically from price structure (S/R pivots, ATR, EMAs) so levels are
 * always internally consistent and never hallucinated.
 */

import { db } from '@/lib/db'
import { getCandles, getTicker, fetchNews, fetchYahooNews, type NewsItem, type Ticker } from '@/lib/market/providers'
import { buildSnapshot, snapshotToText, type TechnicalSnapshot } from '@/lib/market/snapshot'
import { llmJson, llmText } from './llm'

// ─── artifact types (stored as JSON on SignalRun.artifacts) ──────────────────

export interface AgentReport {
  stance: 'BULLISH' | 'BEARISH' | 'NEUTRAL'
  confidence: number
  summary: string
  keyPoints: string[]
}

export interface ResearchVerdict {
  direction: 'LONG' | 'SHORT' | 'NEUTRAL'
  conviction: number
  rationale: string
  keyDrivers: string[]
}

export interface TradePlan {
  strategy: string // e.g. "Trend pullback continuation", "Range-edge fade"
  entryLow: number
  entryHigh: number
  stop: number
  target1: number
  target2: number
  runner: number | null
  riskReward: string
  invalidation: string
  note: string
}

export interface RiskOpinion {
  verdict: 'APPROVE' | 'ADJUST' | 'REJECT'
  note: string
}

export interface FinalVerdict {
  decision: 'APPROVE' | 'ADJUST' | 'REJECT'
  direction: 'LONG' | 'SHORT' | 'NEUTRAL'
  confidence: number
  reasoning: string
  adjustments: Partial<Pick<TradePlan, 'entryLow' | 'entryHigh' | 'stop' | 'target1' | 'target2'>> | null
}

export interface Artifacts {
  snapshotSummary: string
  news: NewsItem[]
  analysts: { technical: AgentReport; news: AgentReport; structure: AgentReport }
  debate: { bull: string; bear: string; manager: ResearchVerdict }
  plan: TradePlan | null
  risk: { aggressive: RiskOpinion; conservative: RiskOpinion; neutral: RiskOpinion }
  memory: Array<{ at: string; direction: string; confidence: number | null; outcome: string }>
  verdict: FinalVerdict
}

// ─── stage progress helper ───────────────────────────────────────────────────

async function setStage(runId: string, stage: string, progress: number, patch: Record<string, unknown> = {}) {
  await db.signalRun.update({ where: { id: runId }, data: { stage, progress, ...patch } })
}

// ─── shared agent prompt vocabulary ──────────────────────────────────────────

const HOUSE_STYLE = `You are part of an AI trading desk (inspired by the TradingAgents framework). Rules:
- Use ONLY the data provided. Never invent numbers, events or headlines.
- Be concise and concrete. Reference actual levels and numbers from the data.
- Crypto and stocks are volatile: always respect risk management.`

const AGENT_REPORT_SHAPE = `{"stance":"BULLISH|BEARISH|NEUTRAL","confidence":0-100,"summary":"2-3 sentences","keyPoints":["point1","point2","point3"]}`

// ─── stage 1: data ───────────────────────────────────────────────────────────

interface RunCtx {
  runId: string
  snapshot: TechnicalSnapshot
  news: NewsItem[]
  ticker: Ticker
  reportsText: string
  memoryText?: string
  artifacts: Partial<Artifacts>
}

async function stageData(ctx: RunCtx, symbol: string, market: 'crypto' | 'stock'): Promise<void> {
  const runId = ctx.runId
  await setStage(runId, 'data', 8)
  const timeframe = market === 'crypto' ? '4h' : '1d'
  const [ticker, candles] = await Promise.all([getTicker(symbol, market), getCandles(symbol, market, timeframe)])
  const snapshot = buildSnapshot(candles, {
    symbol: ticker.symbol,
    market,
    displayName: ticker.displayName,
    currency: ticker.currency,
    price: ticker.price,
    change24h: ticker.change24h,
    timeframe,
  })
  await setStage(runId, 'data', 14, {
    priceAtRun: snapshot.price,
    change24h: snapshot.change24h,
    regime: snapshot.regime,
    timeframe,
    displayName: snapshot.displayName,
  })

  // news: try the company-name query first, fall back to the ticker query,
  // then to Yahoo Finance search news (resilient to per-source throttling)
  const newsQueries =
    market === 'crypto'
      ? [`${snapshot.displayName} cryptocurrency`, `${snapshot.symbol} crypto price`]
      : [`${snapshot.displayName} stock`, `${snapshot.symbol} stock`]
  let news: NewsItem[] = []
  for (const q of newsQueries) {
    news = await fetchNews(q, 8).catch(() => [] as NewsItem[])
    if (news.length > 0) break
  }
  if (news.length === 0) {
    news = await fetchYahooNews(ticker.symbol, 8).catch(() => [] as NewsItem[])
  }

  ctx.snapshot = snapshot
  ctx.news = news
  ctx.ticker = ticker
}

// ─── stage 2: analysts (parallel) ────────────────────────────────────────────

async function analyst(kind: string, system: string, user: string): Promise<AgentReport> {
  try {
    const r = await llmJson<AgentReport>(system, user, AGENT_REPORT_SHAPE)
    return {
      stance: ['BULLISH', 'BEARISH', 'NEUTRAL'].includes(r.stance) ? r.stance : 'NEUTRAL',
      confidence: clamp(Math.round(Number(r.confidence) || 50), 0, 100),
      summary: String(r.summary || ''),
      keyPoints: (Array.isArray(r.keyPoints) ? r.keyPoints : []).slice(0, 5).map(String),
    }
  } catch (e) {
    return {
      stance: 'NEUTRAL',
      confidence: 0,
      summary: `${kind} analysis unavailable this run (${String(e).slice(0, 80)}).`,
      keyPoints: [],
    }
  }
}

async function stageAnalysts(ctx: RunCtx): Promise<void> {
  const runId = ctx.runId
  await setStage(runId, 'analysts', 22)
  const s = ctx.snapshot
  const snapText = snapshotToText(s)

  const [technical, news, structure] = await Promise.all([
    analyst(
      'Technical',
      `${HOUSE_STYLE}\n\nYou are the TECHNICAL ANALYST. Read the indicator snapshot and give a directional read for the next ${s.timeframe === '1d' ? '1-4 weeks' : '1-7 days'}: trend, momentum, volatility, and which levels matter most.`,
      `Technical snapshot:\n${snapText}`,
    ),
    analyst(
      'News',
      `${HOUSE_STYLE}\n\nYou are the NEWS/SENTIMENT ANALYST. Assess whether recent headlines are supportive or hostile for ${s.displayName} over the next ${s.timeframe === '1d' ? '1-4 weeks' : '1-7 days'}. If NO headlines are provided below, you must state that coverage is unavailable, set stance NEUTRAL with confidence below 40, and NEVER invent or reference headlines you were not given.`,
      ctx.news.length
        ? `Recent headlines for ${s.displayName}:\n${ctx.news
            .map((n, i) => `${i + 1}. [${n.source}] ${n.title} (${n.pubDate ? n.pubDate.slice(0, 16) : ''})`)
            .join('\n')}`
        : `No recent headlines were found for ${s.displayName}. Report this honestly.`,
    ),
    analyst(
      'Market-structure',
      `${HOUSE_STYLE}\n\nYou are the MARKET-STRUCTURE ANALYST (stands in for the fundamentals analyst; financial statements are not available in this environment, so analyze range position, volatility regime, volume behavior, and where price sits relative to its ${s.timeframe === '1d' ? '1-year' : '90-bar'} range).`,
      `Market data:\n${snapText}`,
    ),
  ])

  ctx.reportsText = [
    `— TECHNICAL ANALYST (stance ${technical.stance}, confidence ${technical.confidence}) —`,
    technical.summary,
    ...technical.keyPoints.map((k) => `• ${k}`),
    `\n— NEWS/SENTIMENT ANALYST (stance ${news.stance}, confidence ${news.confidence}) —`,
    news.summary,
    ...news.keyPoints.map((k) => `• ${k}`),
    `\n— MARKET-STRUCTURE ANALYST (stance ${structure.stance}, confidence ${structure.confidence}) —`,
    structure.summary,
    ...structure.keyPoints.map((k) => `• ${k}`),
  ].join('\n')

  ctx.artifacts = { ...ctx.artifacts, analysts: { technical, news, structure } }
  await setStage(runId, 'debate', 40)
}

// ─── stage 3: bull/bear debate + research manager ────────────────────────────

async function stageDebate(ctx: RunCtx): Promise<void> {
  const s = ctx.snapshot
  const deskMemory = ctx.memoryText ? `\n\nRecent desk memory for ${s.symbol} (past signals and outcomes):\n${ctx.memoryText}` : ''

  const bull = await llmText(
    `${HOUSE_STYLE}\n\nYou are the BULL RESEARCHER. Build the strongest honest case for a LONG position in ${s.displayName}, grounded in the reports below. Max 130 words. End with your single strongest argument.`,
    `Analyst reports:\n${ctx.reportsText}${deskMemory}`,
  ).catch((e) => `Bull case unavailable: ${String(e).slice(0, 80)}`)

  const bear = await llmText(
    `${HOUSE_STYLE}\n\nYou are the BEAR RESEARCHER. Rebut the bull case and build the strongest honest case for a SHORT (or for standing aside) in ${s.displayName}, grounded in the reports below. Max 130 words. End with your single strongest argument.`,
    `Analyst reports:\n${ctx.reportsText}\n\nBull researcher said:\n${bull}${deskMemory}`,
  ).catch((e) => `Bear case unavailable: ${String(e).slice(0, 80)}`)

  const manager = await llmJson<ResearchVerdict>(
    `${HOUSE_STYLE}\n\nYou are the RESEARCH MANAGER. Weigh the bull/bear debate and the analyst reports, then commit to ONE direction for the next ${s.timeframe === '1d' ? '1-4 weeks' : '1-7 days'}. Conflicting evidence alone is not a reason to be NEUTRAL — pick the side that wins, sized by how decisively it wins. Choose NEUTRAL only if evidence is genuinely balanced or too thin.`,
    `Asset: ${s.displayName} (${s.symbol}), price ${s.price} ${s.currency}, regime ${s.regime}.\n\nData snapshot:\n${snapshotToText(s)}\n\nAnalyst reports:\n${ctx.reportsText}\n\nBull case:\n${bull}\n\nBear case:\n${bear}${deskMemory}`,
    `{"direction":"LONG|SHORT|NEUTRAL","conviction":0-100,"rationale":"3-4 sentences","keyDrivers":["driver1","driver2","driver3"]}`,
  ).catch(
    (): ResearchVerdict => ({
      direction: 'NEUTRAL',
      conviction: 0,
      rationale: 'Research manager failed this run — defaulting to stand aside.',
      keyDrivers: [],
    }),
  )

  manager.conviction = clamp(Math.round(Number(manager.conviction) || 0), 0, 100)
  if (!['LONG', 'SHORT', 'NEUTRAL'].includes(manager.direction)) manager.direction = 'NEUTRAL'

  ctx.artifacts = { ...ctx.artifacts, debate: { bull, bear, manager } }
  await setStage(ctx.runId, 'plan', 55)
}

// ─── stage 4: deterministic trade-plan engineer ──────────────────────────────

export function buildTradePlan(direction: 'LONG' | 'SHORT' | 'NEUTRAL', s: TechnicalSnapshot): TradePlan | null {
  if (direction === 'NEUTRAL') return null
  const px = s.price
  const atrVal = s.atr && s.atr > 0 ? s.atr : px * 0.02 // fallback: 2% of price

  if (direction === 'LONG') {
    const supBelow = s.supports.filter((x) => x < px).sort((a, b) => b - a)[0] ?? null
    const zoneLowRaw = s.regime === 'RANGING' && supBelow !== null ? supBelow : Math.min(supBelow ?? px - atrVal, px - 0.35 * atrVal)
    const entryLow = Math.max(Math.min(zoneLowRaw, px - 0.15 * atrVal), px - 1.2 * atrVal)
    const entryHigh = px
    const stop = Math.min(entryLow - 0.75 * atrVal, (supBelow ?? entryLow) - 0.35 * atrVal)
    const entryMid = (entryLow + entryHigh) / 2
    const risk = entryMid - stop
    // R:R gate: targets must be at least 2×risk (T1) and 3.5×risk (T2) away
    const resAbove = s.resistances.filter((x) => x > entryHigh).sort((a, b) => a - b)
    const t1 = Math.max(resAbove[0] ?? 0, entryMid + 2 * risk)
    const t2 = Math.max(resAbove[1] ?? 0, entryMid + 3.5 * risk, t1 + 1.5 * risk)
    return {
      strategy: s.regime === 'RANGING' ? 'Range-bottom fade' : 'Trend pullback continuation',
      entryLow,
      entryHigh,
      stop,
      target1: t1,
      target2: t2,
      runner: s.regime === 'RANGING' ? null : t2 + 1.5 * atrVal,
      riskReward: `1 : ${(Math.abs(t1 - entryMid) / risk).toFixed(1)} at T1 · 1 : ${(Math.abs(t2 - entryMid) / risk).toFixed(1)} at T2`,
      invalidation: `${s.timeframe} close below ${money(stop, s.currency)} voids the long${s.ema50 ? `; ${s.timeframe} close below ${money(s.ema50, s.currency)} breaks the trend thesis` : ''}`,
      note:
        s.regime === 'RANGING'
          ? 'Ranging market — buy near range support, take profit into mid-range/resistance. Do not chase strength.'
          : 'Uptrend structure — buy the pullback into support/EMA, ride continuation. Never chase a breakout candle.',
    }
  }

  // SHORT
  const resAbove = s.resistances.filter((x) => x > px).sort((a, b) => a - b)[0] ?? null
  const zoneHighRaw = s.regime === 'RANGING' && resAbove !== null ? resAbove : Math.max(resAbove ?? px + atrVal, px + 0.35 * atrVal)
  const entryHigh = Math.min(Math.max(zoneHighRaw, px + 0.15 * atrVal), px + 1.2 * atrVal)
  const entryLow = px
  const stop = Math.max(entryHigh + 0.75 * atrVal, (resAbove ?? entryHigh) + 0.35 * atrVal)
  const entryMid = (entryLow + entryHigh) / 2
  const risk = stop - entryMid
  // R:R gate: targets must be at least 2×risk (T1) and 3.5×risk (T2) away
  const supBelow = s.supports.filter((x) => x < entryLow).sort((a, b) => b - a)
  const t1 = Math.min(supBelow[0] ?? Infinity, entryMid - 2 * risk)
  const t2 = Math.min(supBelow[1] ?? Infinity, entryMid - 3.5 * risk, t1 - 1.5 * risk)
  return {
    strategy: s.regime === 'RANGING' ? 'Range-top fade' : 'Trend breakdown continuation',
    entryLow,
    entryHigh,
    stop,
    target1: t1,
    target2: t2,
    runner: s.regime === 'RANGING' ? null : t2 - 1.5 * atrVal,
    riskReward: `1 : ${(Math.abs(entryMid - t1) / risk).toFixed(1)} at T1 · 1 : ${(Math.abs(entryMid - t2) / risk).toFixed(1)} at T2`,
    invalidation: `${s.timeframe} close above ${money(stop, s.currency)} voids the short${s.ema50 ? `; ${s.timeframe} close above ${money(s.ema50, s.currency)} reclaims the trend` : ''}`,
    note:
      s.regime === 'RANGING'
        ? 'Ranging market — sell near range resistance, cover into mid-range/support. Do not short strength mid-range.'
        : 'Downtrend structure — sell the rally into resistance/EMA, ride continuation. Never short a capitulation candle.',
  }
}

// ─── stage 5: risk debate (parallel) ─────────────────────────────────────────

async function stageRisk(ctx: RunCtx, plan: TradePlan | null): Promise<void> {
  if (!plan) {
    ctx.artifacts = {
      ...ctx.artifacts,
      risk: {
        aggressive: { verdict: 'APPROVE', note: 'No position proposed — nothing to critique.' },
        conservative: { verdict: 'APPROVE', note: 'Standing aside is the lowest-risk action.' },
        neutral: { verdict: 'APPROVE', note: 'No-trade is a valid decision in unclear conditions.' },
      },
    }
    await setStage(ctx.runId, 'decision', 85)
    return
  }

  const planText = planToText(plan, ctx.snapshot.currency)
  const persona = (name: string, guidance: string) =>
    llmJson<RiskOpinion>(
      `${HOUSE_STYLE}\n\nYou are the ${name} member of the risk committee. ${guidance}\nCritique the proposed trade. Max 80 words.`,
      `Asset: ${ctx.snapshot.displayName} @ ${money(ctx.snapshot.price, ctx.snapshot.currency)} (regime ${ctx.snapshot.regime}, ATR ${ctx.snapshot.atr?.toFixed(2) ?? 'n/a'}). Analyst reports:\n${ctx.reportsText}\n\nProposed trade:\n${planText}`,
      `{"verdict":"APPROVE|ADJUST|REJECT","note":"your critique"}`,
    ).catch(
      (): RiskOpinion => ({
        verdict: 'APPROVE',
        note: 'Risk review unavailable this run.',
      }),
    )

  const [aggressive, conservative, neutral] = await Promise.all([
    persona(
      'AGGRESSIVE',
      'You favor seizing opportunity: argue why the desk should take the trade in full size, but stay honest — if the plan is genuinely bad, say REJECT.',
    ),
    persona(
      'CONSERVATIVE',
      'You protect capital: scrutinize stop placement, R:R, regime risk and news risk. Recommend ADJUST with concrete level changes when something is off; REJECT only for genuinely unsafe plans.',
    ),
    persona(
      'NEUTRAL',
      'You are the balanced voice: weigh both sides and judge whether the plan as written is executable as-is.',
    ),
  ])

  ctx.artifacts = { ...ctx.artifacts, risk: { aggressive, conservative, neutral } }
  await setStage(ctx.runId, 'decision', 85)
}

// ─── stage 6: portfolio manager ──────────────────────────────────────────────

async function stageDecision(ctx: RunCtx, plan: TradePlan | null): Promise<void> {
  const s = ctx.snapshot
  const planText = plan ? planToText(plan, s.currency) : 'No mechanical plan (neutral direction — no edge detected).'
  const riskText = ctx.artifacts.risk
    ? [
        `— AGGRESSIVE (${ctx.artifacts.risk.aggressive.verdict}) —`,
        ctx.artifacts.risk.aggressive.note,
        `— CONSERVATIVE (${ctx.artifacts.risk.conservative.verdict}) —`,
        ctx.artifacts.risk.conservative.note,
        `— NEUTRAL (${ctx.artifacts.risk.neutral.verdict}) —`,
        ctx.artifacts.risk.neutral.note,
      ].join('\n')
    : '(risk committee unavailable)'

  const verdict = await llmJson<FinalVerdict>(
    `${HOUSE_STYLE}\n\nYou are the PORTFOLIO MANAGER — the final authority. Decide: APPROVE the trade as written, ADJUST it (provide corrected levels, e.g. tighten a stop or improve R:R), or REJECT (no trade). Direction must stay LONG or SHORT if the trade is approved/adjusted; a REJECT means no position. Confidence reflects the desk's conviction in the FINAL plan (0-100).`,
    `Asset: ${s.displayName} (${s.symbol}) @ ${money(s.price, s.currency)} | regime ${s.regime} | ${s.timeframe} candles\n\nResearch manager verdict: ${ctx.artifacts.debate?.manager.direction} (conviction ${ctx.artifacts.debate?.manager.conviction}) — ${ctx.artifacts.debate?.manager.rationale ?? ''}\n\nAnalyst reports:\n${ctx.reportsText}\n\nProposed trade:\n${planText}\n\nRisk committee:\n${riskText}${ctx.memoryText ? `\n\nRecent desk memory for ${s.symbol}:\n${ctx.memoryText}` : ''}`,
    `{"decision":"APPROVE|ADJUST|REJECT","direction":"LONG|SHORT|NEUTRAL","confidence":0-100,"reasoning":"3-4 sentences","adjustments":null or {"entryLow":number,"entryHigh":number,"stop":number,"target1":number,"target2":number}}`,
  ).catch(
    (): FinalVerdict => ({
      decision: 'REJECT',
      direction: 'NEUTRAL',
      confidence: 0,
      reasoning: 'Portfolio manager unavailable this run — defaulting to no trade.',
      adjustments: null,
    }),
  )

  ctx.artifacts = { ...ctx.artifacts, verdict }

  // merge final plan
  let finalDirection: 'LONG' | 'SHORT' | 'NEUTRAL' = verdict.direction
  let finalPlan: TradePlan | null = plan
  if (verdict.decision === 'REJECT') {
    finalDirection = 'NEUTRAL'
    finalPlan = null
  } else if (finalDirection === 'NEUTRAL') {
    finalPlan = null
  } else if (verdict.decision === 'ADJUST' && verdict.adjustments && plan) {
    finalPlan = {
      ...plan,
      entryLow: numOr(verdict.adjustments.entryLow, plan.entryLow),
      entryHigh: numOr(verdict.adjustments.entryHigh, plan.entryHigh),
      stop: numOr(verdict.adjustments.stop, plan.stop),
      target1: numOr(verdict.adjustments.target1, plan.target1),
      target2: numOr(verdict.adjustments.target2, plan.target2),
      note: `${plan.note} (Adjusted by portfolio manager.)`,
    }
    finalPlan.riskReward = computeRr(finalPlan)
  }

  // house rule: risk management is non-negotiable — after any PM adjustment,
  // re-float targets so R:R stays ≥ 2.0 at T1 and ≥ 3.5 at T2. The PM's
  // reasoning is preserved in artifacts; this only guards the level math.
  if (finalPlan) {
    const mid = (finalPlan.entryLow + finalPlan.entryHigh) / 2
    const risk = Math.abs(mid - finalPlan.stop)
    if (risk > 0) {
      const isLong = finalDirection === 'LONG'
      const minT1 = isLong ? mid + 2 * risk : mid - 2 * risk
      const minT2 = isLong ? mid + 3.5 * risk : mid - 3.5 * risk
      if (isLong) {
        finalPlan.target1 = Math.max(finalPlan.target1, minT1)
        finalPlan.target2 = Math.max(finalPlan.target2, minT2, finalPlan.target1 + 0.5 * risk)
      } else {
        finalPlan.target1 = Math.min(finalPlan.target1, minT1)
        finalPlan.target2 = Math.min(finalPlan.target2, minT2, finalPlan.target1 - 0.5 * risk)
      }
      finalPlan.riskReward = computeRr(finalPlan)
    }
  }

  await setStage(ctx.runId, 'done', 100, {
    status: 'completed',
    direction: finalDirection,
    confidence: clamp(Math.round(Number(verdict.confidence) || 0), 0, 100),
    entryLow: finalPlan?.entryLow ?? null,
    entryHigh: finalPlan?.entryHigh ?? null,
    stop: finalPlan?.stop ?? null,
    target1: finalPlan?.target1 ?? null,
    target2: finalPlan?.target2 ?? null,
    runner: finalPlan?.runner ?? null,
    riskReward: finalPlan?.riskReward ?? null,
    invalidation: finalPlan?.invalidation ?? null,
    planNote: finalPlan?.note ?? (finalDirection === 'NEUTRAL' ? 'No edge detected — stand aside and wait for levels.' : null),
    completedAt: new Date(),
  })
}

// ─── orchestrator ────────────────────────────────────────────────────────────

export async function runSignalPipeline(runId: string, symbol: string, market: 'crypto' | 'stock'): Promise<void> {
  const ctx: RunCtx = {
    runId,
    reportsText: '',
    news: [],
    ticker: null as unknown as Ticker,
    snapshot: null as unknown as TechnicalSnapshot,
    artifacts: {},
  }
  try {
    // stage 1 — data
    await stageData(ctx, symbol, market)

    // desk memory: last 3 resolved runs for this symbol (reflection loop)
    const past = await db.signalRun.findMany({
      where: { symbol: ctx.ticker.symbol, market, status: 'completed' },
      orderBy: { createdAt: 'desc' },
      take: 4,
    })
    ctx.memoryText = past
      .filter((p) => p.id !== runId)
      .slice(0, 3)
      .map(
        (p) =>
          `${p.createdAt.toISOString().slice(0, 16)} — ${p.direction ?? '?'} @ ${p.priceAtRun?.toFixed(2) ?? '?'} (confidence ${p.confidence ?? '?'}), outcome: ${p.outcome ?? 'OPEN'}`,
      )
      .join('\n')

    // stage 2 — analysts
    await stageAnalysts(ctx)

    // stage 3 — debate
    await stageDebate(ctx)

    // stage 4 — deterministic plan
    const managerDirection = ctx.artifacts.debate?.manager.direction ?? 'NEUTRAL'
    const plan = buildTradePlan(managerDirection, ctx.snapshot)
    ctx.artifacts.plan = plan

    // stage 5 — risk debate
    await stageRisk(ctx, plan)

    // stage 6 — final decision
    await stageDecision(ctx, plan)

    // persist artifacts
    await db.signalRun.update({ where: { id: runId }, data: { artifacts: ctx.artifacts as unknown as Record<string, unknown> } })
  } catch (e) {
    console.error('[signal-engine] run failed:', e)
    await db.signalRun
      .update({
        where: { id: runId },
        data: { status: 'failed', error: String(e).slice(0, 500), completedAt: new Date() },
      })
      .catch(() => {})
  }
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x))
}
function numOr(x: unknown, fallback: number): number {
  const v = Number(x)
  return Number.isFinite(v) && v !== 0 ? v : fallback
}
function money(x: number, cur: string): string {
  return `${cur === 'USD' ? '$' : cur + ' '}${x >= 1000 ? Math.round(x).toLocaleString('en-US') : Math.round(x * 100) / 100}`
}
function computeRr(p: TradePlan): string {
  const mid = (p.entryLow + p.entryHigh) / 2
  const risk = Math.abs(mid - p.stop)
  if (risk === 0) return p.riskReward
  return `1 : ${(Math.abs(p.target1 - mid) / risk).toFixed(1)} at T1 · 1 : ${(Math.abs(p.target2 - mid) / risk).toFixed(1)} at T2`
}
function planToText(p: TradePlan, cur: string): string {
  return [
    `Strategy: ${p.strategy} — ${p.note}`,
    `Entry (limit zone): ${money(p.entryLow, cur)} – ${money(p.entryHigh, cur)}`,
    `Stop: ${money(p.stop, cur)}`,
    `Target 1: ${money(p.target1, cur)} | Target 2: ${money(p.target2, cur)}${p.runner ? ` | Runner: ${money(p.runner, cur)}` : ''}`,
    `R:R: ${p.riskReward}`,
    `Invalidation: ${p.invalidation}`,
  ].join('\n')
}
