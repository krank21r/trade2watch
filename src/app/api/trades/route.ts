import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { SESSION_COOKIE, verifyToken } from '@/lib/auth'
import { ensureUserTradeTable } from '@/lib/ensure-tables'
import type { MyTrade } from '@/lib/mytrades'

export const dynamic = 'force-dynamic'

/** Resolve the signed-in user (middleware gates the route; this is defense-in-depth). */
async function userId(req: NextRequest): Promise<string | null> {
  const session = await verifyToken(req.cookies.get(SESSION_COOKIE)?.value)
  return session?.id ?? null
}

function sanitize(raw: unknown): MyTrade[] {
  if (!Array.isArray(raw)) return []
  return raw.filter(
    (t): t is MyTrade =>
      !!t &&
      typeof t === 'object' &&
      typeof (t as MyTrade).id === 'string' &&
      typeof (t as MyTrade).symbol === 'string' &&
      typeof (t as MyTrade).takenAt === 'number',
  )
}

/**
 * GET /api/trades — the signed-in user's personal trade journal
 * ("I took this trade" frozen plans), identical on every device.
 */
export async function GET(req: NextRequest) {
  const uid = await userId(req)
  if (!uid) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })

  try {
    await ensureUserTradeTable() // self-heal on ephemeral prod SQLite
    const row = await db.userTradeStore.findUnique({ where: { userId: uid } })
    if (!row) {
      // exists:false → the client may migrate this browser's local journal up
      return NextResponse.json({ ok: true, exists: false, trades: [] }, { headers: { 'Cache-Control': 'no-store' } })
    }
    const trades = sanitize(JSON.parse(row.trades ?? '[]'))
    return NextResponse.json({ ok: true, exists: true, trades }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (err) {
    console.error('[trades] load error:', err)
    return NextResponse.json({ ok: false, error: 'storage unavailable' }, { status: 500 })
  }
}

/**
 * PUT /api/trades — full-list replace (the client journal is an atomic
 * snapshot; ≤40 entries). Last writer wins across devices.
 */
export async function PUT(req: NextRequest) {
  const uid = await userId(req)
  if (!uid) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })

  let trades: MyTrade[]
  try {
    const body = (await req.json()) as { trades?: unknown }
    trades = sanitize(body.trades)
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid body' }, { status: 400 })
  }

  try {
    await ensureUserTradeTable()
    await db.userTradeStore.upsert({
      where: { userId: uid },
      create: { userId: uid, trades: JSON.stringify(trades), updatedAt: Date.now() },
      update: { trades: JSON.stringify(trades), updatedAt: Date.now() },
    })
    return NextResponse.json({ ok: true, count: trades.length })
  } catch (err) {
    console.error('[trades] save error:', err)
    return NextResponse.json({ ok: false, error: 'storage unavailable' }, { status: 500 })
  }
}
