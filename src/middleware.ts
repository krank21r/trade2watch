import { NextRequest, NextResponse } from 'next/server'
import { SESSION_COOKIE, verifyToken, type SessionPayload } from '@/lib/auth'

/**
 * Auth gate — every route requires a valid signed session except:
 *   /login, /api/auth/*, static assets.
 * Page requests without a session redirect to /login; API requests get 401.
 * A valid session hitting /login bounces back to the app.
 *
 * CRITICAL: this function runs in the edge middleware — an unhandled throw
 * here produces Vercel's "500 MIDDLEWARE_INVOCATION_FAILED / This page is
 * unavailable", which takes the ENTIRE site down (pages AND every API call,
 * including the multi-agent analysis button). So auth verification is wrapped
 * and any unexpected failure degrades to "not signed in" (redirect/401) —
 * the site stays up and the user can still reach /login.
 */
export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl

  // external-cron bypass: the auto-desk tick endpoint accepts a bearer secret
  // so a scheduler (GitHub Actions / cron-job.org) can drive it in production
  const cronSecret = process.env.CRON_SECRET
  if (
    cronSecret &&
    pathname === '/api/signals/auto/tick' &&
    req.headers.get('authorization') === `Bearer ${cronSecret}`
  ) {
    return NextResponse.next()
  }

  // fail-safe token verification — verifyToken itself never throws, but the
  // try/catch guards against anything unexpected in this edge context
  let session: SessionPayload | null = null
  try {
    session = await verifyToken(req.cookies.get(SESSION_COOKIE)?.value)
  } catch {
    session = null
  }

  const isAuthApi = pathname.startsWith('/api/auth')

  if (isAuthApi) return NextResponse.next()

  if (session) {
    if (pathname === '/login') {
      return NextResponse.redirect(new URL('/', req.url))
    }
    return NextResponse.next()
  }

  if (pathname === '/login') return NextResponse.next()

  if (pathname.startsWith('/api/')) {
    return NextResponse.json({ ok: false, error: 'unauthorized — session required' }, { status: 401 })
  }

  const url = new URL('/login', req.url)
  if (pathname !== '/') url.searchParams.set('next', pathname)
  return NextResponse.redirect(url)
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|txt)$).*)'],
}
