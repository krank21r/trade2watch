import { NextResponse } from 'next/server'
import { NAME_COOKIE, SESSION_COOKIE, UID_COOKIE } from '@/lib/auth'

export const dynamic = 'force-dynamic'

/** POST /api/auth/logout — clear the session + scope cookies */
export async function POST() {
  const res = NextResponse.json({ ok: true })
  for (const name of [SESSION_COOKIE, UID_COOKIE, NAME_COOKIE]) {
    res.cookies.set(name, '', { maxAge: 0, path: '/' })
  }
  return res
}
