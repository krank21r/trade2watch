import { NextRequest, NextResponse } from 'next/server'
import { SESSION_COOKIE, verifyToken } from '@/lib/auth'

export const dynamic = 'force-dynamic'

/** GET /api/auth/me — current session user (null when signed out) */
export async function GET(req: NextRequest) {
  const session = await verifyToken(req.cookies.get(SESSION_COOKIE)?.value)
  if (!session) {
    return NextResponse.json({ ok: true, user: null }, { headers: { 'Cache-Control': 'no-store' } })
  }
  return NextResponse.json(
    { ok: true, user: { id: session.id, name: session.name, role: session.role } },
    { headers: { 'Cache-Control': 'no-store' } },
  )
}
