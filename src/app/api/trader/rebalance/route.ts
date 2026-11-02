import { NextRequest, NextResponse } from 'next/server'
import { SESSION_COOKIE, verifyToken } from '@/lib/auth'
import { DeskError, rebalance } from '@/lib/trader/desk'

export const dynamic = 'force-dynamic'
export const maxDuration = 120

async function userId(req: NextRequest): Promise<string | null> {
  const session = await verifyToken(req.cookies.get(SESSION_COOKIE)?.value)
  return session?.id ?? null
}

/**
 * POST /api/trader/rebalance — the drift table + proposed trades as tickets.
 * Body: { band?: number } (percentage points; default 5).
 * Sells first, buys scaled to the cash above the buffer, min/max respected.
 */
export async function POST(req: NextRequest) {
  const uid = await userId(req)
  if (!uid) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  let body: { band?: unknown } = {}
  try {
    body = await req.json()
  } catch {
    /* empty body is fine — default band */
  }
  const band = body.band === undefined ? undefined : Number(body.band)
  try {
    const result = await rebalance(uid, band)
    return NextResponse.json({ ok: true, ...result })
  } catch (e) {
    if (e instanceof DeskError) return NextResponse.json({ ok: false, error: e.message }, { status: 400 })
    console.error('[api/trader/rebalance] error:', e)
    return NextResponse.json({ ok: false, error: 'rebalance failed' }, { status: 500 })
  }
}
