import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getTicker } from '@/lib/market/providers'

export const dynamic = 'force-dynamic'

const OUTCOME_REFRESH_MS = 15 * 60 * 1000 // re-evaluate open outcomes at most every 15 min
const MAX_EVALUATIONS = 6 // per request, to stay polite with data vendors

/**
 * Lazy outcome evaluation: for completed directional signals, compare the
 * current price against T1 / stop. TARGET1 wins if it was hit first in our
 * optimistic reading — refined over time as price evolves.
 */
async function evaluateOutcomes(
  runs: Array<{
    id: string
    symbol: string
    market: string
    direction: string | null
    status: string
    entryLow: number | null
    entryHigh: number | null
    stop: number | null
    target1: number | null
    outcome: string | null
    outcomeCheckedAt: Date | null
  }>,
) {
  let budget = MAX_EVALUATIONS
  for (const r of runs) {
    if (budget <= 0) break
    if (r.status !== 'completed' || !r.direction || r.direction === 'NEUTRAL') continue
    if (r.entryLow === null || r.stop === null || r.target1 === null) continue
    if (r.outcome && r.outcome !== 'OPEN') continue // final outcomes stay settled
    if (r.outcomeCheckedAt && Date.now() - r.outcomeCheckedAt.getTime() < OUTCOME_REFRESH_MS) continue

    budget--
    try {
      const t = await getTicker(r.symbol, r.market === 'stock' ? 'stock' : 'crypto')
      const px = t.price
      let outcome = 'OPEN'
      if (r.direction === 'LONG') {
        if (px <= r.stop) outcome = 'STOP_HIT'
        else if (px >= r.target1) outcome = 'TARGET1_HIT'
      } else {
        if (px >= r.stop) outcome = 'STOP_HIT'
        else if (px <= r.target1) outcome = 'TARGET1_HIT'
      }
      await db.signalRun.update({
        where: { id: r.id },
        data: { outcome, outcomeCheckedAt: new Date(), outcomePrice: px },
      })
      r.outcome = outcome
      r.outcomeCheckedAt = new Date()
    } catch {
      // vendor unavailable — leave outcome as-is, retry next read
    }
  }
}

// GET /api/signals — recent signal history
export async function GET(req: NextRequest) {
  try {
    const limit = Math.min(50, Math.max(1, Number(req.nextUrl.searchParams.get('limit') ?? 20)))
    const runs = await db.signalRun.findMany({
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: {
        id: true,
        symbol: true,
        market: true,
        displayName: true,
        status: true,
        stage: true,
        progress: true,
        direction: true,
        confidence: true,
        priceAtRun: true,
        entryLow: true,
        entryHigh: true,
        stop: true,
        target1: true,
        target2: true,
        riskReward: true,
        regime: true,
        outcome: true,
        outcomeCheckedAt: true,
        outcomePrice: true,
        createdAt: true,
        completedAt: true,
        error: true,
      },
    })

    await evaluateOutcomes(runs as Parameters<typeof evaluateOutcomes>[0])

    return NextResponse.json({ runs })
  } catch (e) {
    console.error('[api/signals] error:', e)
    return NextResponse.json({ error: 'Failed to load signals.' }, { status: 500 })
  }
}
