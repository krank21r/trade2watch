/**
 * GET /api/entry-decision?symbols=BTC,ETH,SOL — one fused trade call per symbol.
 *
 * Synthesizes the three systems (Trade Setups structure zones + AI Signals desk
 * call + Liquidity Lab order-book tape) into a single actionable decision:
 * TAKE / WAIT / SKIP / STAND ASIDE with a 0-100 quality score, a named checklist
 * of gates, and the exact levels to execute at.
 *
 * Heavy parts are cached server-side (setups 30s, liquidity reports 120s with a
 * 25s timeout guard), so polling stays cheap after the first computation.
 */

import { NextRequest, NextResponse } from 'next/server'
import { SESSION_COOKIE, verifyToken } from '@/lib/auth'
import { buildEntryDecisions } from '@/lib/entry/decide'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

// short response cache so the 60s UI poll + symbol switching never recompute
const respCache = new Map<string, { at: number; data: unknown }>()
const RESP_TTL = 45_000

export async function GET(req: NextRequest) {
  const session = await verifyToken(req.cookies.get(SESSION_COOKIE)?.value)
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const raw = req.nextUrl.searchParams.get('symbols') ?? 'BTC,ETH,SOL,AAPL,TSLA,NVDA'
  const symbols = raw
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter((s) => /^[A-Z0-9.\-]{1,10}$/.test(s))
    .slice(0, 8)

  if (symbols.length === 0) {
    return NextResponse.json({ decisions: [], failed: {}, updatedAt: new Date().toISOString() })
  }

  const key = [...symbols].sort().join(',')
  const hit = respCache.get(key)
  if (hit && Date.now() - hit.at < RESP_TTL) {
    return NextResponse.json(hit.data, { headers: { 'X-Cache': 'hit', 'Cache-Control': 'no-store' } })
  }

  try {
    const data = await buildEntryDecisions(symbols)
    respCache.set(key, { at: Date.now(), data })
    if (respCache.size > 30) {
      for (const [k, v] of respCache) if (Date.now() - v.at > RESP_TTL) respCache.delete(k)
    }
    return NextResponse.json(data, { headers: { 'Cache-Control': 'no-store' } })
  } catch (e) {
    console.error('[api/entry-decision] error:', e)
    return NextResponse.json({ error: String(e).slice(0, 300) }, { status: 500 })
  }
}
