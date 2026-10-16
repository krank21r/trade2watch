import { NextRequest, NextResponse } from 'next/server'
import { db, ensureTables } from '@/lib/db'
import { autoDeskStatus, setAutoEnabled } from '@/lib/signals/scheduler'

export const dynamic = 'force-dynamic'

// GET /api/signals/auto — auto-desk status + recent auto runs
export async function GET() {
  try {
    // cold serverless instances start with an empty /tmp SQLite (and warm old
    // ones may predate the `source` column) — bootstrap before querying
    await ensureTables()
    const recent = await db.signalRun.findMany({
      where: { source: 'auto' },
      orderBy: { createdAt: 'desc' },
      take: 5,
      select: {
        id: true,
        symbol: true,
        status: true,
        direction: true,
        confidence: true,
        priceAtRun: true,
        createdAt: true,
      },
    })
    return NextResponse.json({ status: autoDeskStatus(), recent })
  } catch (e) {
    console.error('[api/signals/auto] error:', e)
    return NextResponse.json({ error: 'Failed to load auto-desk status.' }, { status: 500 })
  }
}

// POST /api/signals/auto — { enabled: boolean } pause/resume the auto desk
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}))
    if (typeof body?.enabled === 'boolean') setAutoEnabled(body.enabled)
    return NextResponse.json({ status: autoDeskStatus() })
  } catch (e) {
    console.error('[api/signals/auto] error:', e)
    return NextResponse.json({ error: 'Failed to update auto-desk.' }, { status: 500 })
  }
}
