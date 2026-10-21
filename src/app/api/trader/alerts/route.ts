import { NextRequest, NextResponse } from 'next/server'
import { SESSION_COOKIE, verifyToken } from '@/lib/auth'
import { DeskError, addAlert, checkAlerts, deleteAlert } from '@/lib/trader/desk'

export const dynamic = 'force-dynamic'

async function userId(req: NextRequest): Promise<string | null> {
  const session = await verifyToken(req.cookies.get(SESSION_COOKIE)?.value)
  return session?.id ?? null
}

/** GET /api/trader/alerts — list + check untriggered ones against live prices (rings once). */
export async function GET(req: NextRequest) {
  const uid = await userId(req)
  if (!uid) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  try {
    const { alerts, rang } = await checkAlerts(uid)
    return NextResponse.json({ ok: true, alerts, rang })
  } catch (e) {
    console.error('[api/trader/alerts] error:', e)
    return NextResponse.json({ ok: false, error: 'could not load alerts' }, { status: 500 })
  }
}

/** POST /api/trader/alerts — add one: { symbol, kind: 'above'|'below'|'stop', price, note?, market? } */
export async function POST(req: NextRequest) {
  const uid = await userId(req)
  if (!uid) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  let body: { symbol?: unknown; kind?: unknown; price?: unknown; note?: unknown; market?: unknown }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid request body' }, { status: 400 })
  }
  try {
    const alert = await addAlert(uid, {
      symbol: String(body.symbol ?? ''),
      kind: body.kind as 'above' | 'below' | 'stop',
      price: Number(body.price),
      note: body.note === undefined ? undefined : String(body.note),
      market: body.market === 'stock' ? 'stock' : 'crypto',
    })
    return NextResponse.json({ ok: true, alert })
  } catch (e) {
    if (e instanceof DeskError) return NextResponse.json({ ok: false, error: e.message }, { status: 400 })
    console.error('[api/trader/alerts] add error:', e)
    return NextResponse.json({ ok: false, error: 'could not add the alert' }, { status: 500 })
  }
}

/** DELETE /api/trader/alerts?id=... — remove one. */
export async function DELETE(req: NextRequest) {
  const uid = await userId(req)
  if (!uid) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  const id = req.nextUrl.searchParams.get('id')
  if (!id) return NextResponse.json({ ok: false, error: 'missing id' }, { status: 400 })
  try {
    await deleteAlert(uid, id)
    return NextResponse.json({ ok: true })
  } catch (e) {
    if (e instanceof DeskError) return NextResponse.json({ ok: false, error: e.message }, { status: 404 })
    console.error('[api/trader/alerts] delete error:', e)
    return NextResponse.json({ ok: false, error: 'could not delete the alert' }, { status: 500 })
  }
}
