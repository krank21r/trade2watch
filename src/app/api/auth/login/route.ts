import { NextRequest, NextResponse } from 'next/server'
import { authenticate, createToken, NAME_COOKIE, SESSION_COOKIE, UID_COOKIE } from '@/lib/auth'

export const dynamic = 'force-dynamic'

/** POST /api/auth/login — { username, password } → signed session cookies */
export async function POST(req: NextRequest) {
  let username = ''
  let password = ''
  try {
    const body = (await req.json()) as { username?: string; password?: string }
    username = String(body.username ?? '')
    password = String(body.password ?? '')
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid request body' }, { status: 400 })
  }

  const user = authenticate(username, password)
  if (!user) {
    return NextResponse.json({ ok: false, error: 'wrong username or password' }, { status: 401 })
  }

  let token: string
  let maxAge: number
  try {
    ;({ token, maxAge } = await createToken(user))
  } catch (e) {
    // Almost always a missing/empty AUTH_SECRET on the server (it throws).
    // Surface a clear, actionable message instead of an unhandled 500.
    console.error('[api/auth/login] token signing failed:', e)
    return NextResponse.json(
      {
        ok: false,
        error:
          'Sign-in is temporarily unavailable: the server session key (AUTH_SECRET) is missing or misconfigured. Set AUTH_SECRET (and the T2W_PASS_* variables) in the hosting environment, then redeploy.',
      },
      { status: 503 },
    )
  }

  const secure = process.env.NODE_ENV === 'production'
  const common = { maxAge, sameSite: 'lax' as const, secure, path: '/' }

  const res = NextResponse.json({ ok: true, user })
  res.cookies.set(SESSION_COOKIE, token, { ...common, httpOnly: true })
  // readable convenience cookies — client-side user scoping + display only
  res.cookies.set(UID_COOKIE, user.id, { ...common, httpOnly: false })
  res.cookies.set(NAME_COOKIE, encodeURIComponent(user.name), { ...common, httpOnly: false })
  return res
}
