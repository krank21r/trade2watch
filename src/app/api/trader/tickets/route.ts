import { NextRequest, NextResponse } from 'next/server'
import { SESSION_COOKIE, verifyToken } from '@/lib/auth'
import { expireStaleTickets, listTickets } from '@/lib/trader/desk'

export const dynamic = 'force-dynamic'

async function userId(req: NextRequest): Promise<string | null> {
  const session = await verifyToken(req.cookies.get(SESSION_COOKIE)?.value)
  return session?.id ?? null
}

/** GET /api/trader/tickets — every stored ticket, newest first (optionally ?batch=). */
export async function GET(req: NextRequest) {
  const uid = await userId(req)
  if (!uid) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  try {
    await expireStaleTickets(uid)
    const batch = req.nextUrl.searchParams.get('batch') ?? undefined
    const tickets = await listTickets(uid, batch || undefined)
    return NextResponse.json({ ok: true, tickets })
  } catch (e) {
    console.error('[api/trader/tickets] error:', e)
    return NextResponse.json({ ok: false, error: 'could not load tickets' }, { status: 500 })
  }
}
