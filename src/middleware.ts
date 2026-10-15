import { NextRequest, NextResponse } from 'next/server'
import { SESSION_COOKIE, verifyToken } from '@/lib/auth'

/**
 * Auth gate — every route requires a valid signed session except:
 *   /login, /api/auth/*, static assets.
 * Page requests without a session redirect to /login; API requests get 401.
 * A valid session hitting /login bounces back to the app.
 */
export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl
  const session = await verifyToken(req.cookies.get(SESSION_COOKIE)?.value)
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
