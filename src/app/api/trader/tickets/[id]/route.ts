import { NextRequest, NextResponse } from 'next/server'
import { SESSION_COOKIE, verifyToken } from '@/lib/auth'
import { DeskError, decideTicket } from '@/lib/trader/desk'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

async function userId(req: NextRequest): Promise<string | null> {
  const session = await verifyToken(req.cookies.get(SESSION_COOKIE)?.value)
  return session?.id ?? null
}

/**
 * POST /api/trader/tickets/[id] — your yes or no for exactly one ticket.
 * Body: { action: 'approve' | 'reject' }
 *
 * Approval is the broker gate: only a PASS verdict whose fingerprint still
 * matches can fill, and the fill happens on the paper account at the live
 * price. Nothing here can reach a real exchange.
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const uid = await userId(req)
  if (!uid) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  const { id } = await ctx.params
  let body: { action?: unknown }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid request body' }, { status: 400 })
  }
  const action = body.action === 'approve' ? 'approve' : body.action === 'reject' ? 'reject' : null
  if (!action) return NextResponse.json({ ok: false, error: "action must be 'approve' or 'reject'" }, { status: 400 })

  try {
    const result = await decideTicket(uid, id, action)
    return NextResponse.json({
      ok: true,
      ticket: result.ticket,
      note:
        action === 'approve'
          ? `Filled on the paper account at the live price (${result.ticket.fillPrice}).`
          : 'Ticket rejected — it stays on record with your no.',
    })
  } catch (e) {
    if (e instanceof DeskError) return NextResponse.json({ ok: false, error: e.message }, { status: 400 })
    console.error('[api/trader/tickets/id] error:', e)
    return NextResponse.json({ ok: false, error: 'could not decide this ticket' }, { status: 500 })
  }
}
