import { NextRequest, NextResponse } from 'next/server'
import { SESSION_COOKIE, verifyToken } from '@/lib/auth'
import {
  checkAlerts,
  expireStaleTickets,
  monitorArmedTickets,
  portfolio,
  resetDesk,
} from '@/lib/trader/desk'

export const dynamic = 'force-dynamic'

/** Resolve the signed-in user (middleware gates the route; defense-in-depth). */
async function userId(req: NextRequest): Promise<string | null> {
  const session = await verifyToken(req.cookies.get(SESSION_COOKIE)?.value)
  return session?.id ?? null
}

/** GET /api/trader/account — paper account, live-marked positions, drift, alerts (checked here; each rings once). Also fills armed tickets whose entry zone was reached. */
export async function GET(req: NextRequest) {
  const uid = await userId(req)
  if (!uid) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  try {
    await expireStaleTickets(uid)
    const armedFilled = await monitorArmedTickets(uid)
    const [pf, alerts] = await Promise.all([portfolio(uid), checkAlerts(uid)])
    return NextResponse.json({
      ok: true,
      ...pf,
      alerts: alerts.alerts,
      alertsRang: alerts.rang,
      armedFilled,
    })
  } catch (e) {
    console.error('[api/trader/account] error:', e)
    return NextResponse.json({ ok: false, error: 'could not load the desk' }, { status: 500 })
  }
}

/** POST /api/trader/account — reset the whole paper desk (tickets, positions, account, targets, alerts). */
export async function POST(req: NextRequest) {
  const uid = await userId(req)
  if (!uid) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  try {
    await resetDesk(uid)
    return NextResponse.json({ ok: true, note: 'Paper desk reset — account, tickets, positions, targets and alerts wiped.' })
  } catch (e) {
    console.error('[api/trader/account] reset error:', e)
    return NextResponse.json({ ok: false, error: 'reset failed' }, { status: 500 })
  }
}
