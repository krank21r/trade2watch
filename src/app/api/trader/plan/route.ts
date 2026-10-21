import { NextRequest, NextResponse } from 'next/server'
import { SESSION_COOKIE, verifyToken } from '@/lib/auth'
import {
  DEFAULT_RULES,
  DeskError,
  buildPlan,
  saveTargets,
  type DeskRules,
} from '@/lib/trader/desk'

export const dynamic = 'force-dynamic'
export const maxDuration = 120

async function userId(req: NextRequest): Promise<string | null> {
  const session = await verifyToken(req.cookies.get(SESSION_COOKIE)?.value)
  return session?.id ?? null
}

const clampPct = (v: unknown, def: number, lo: number, hi: number): number => {
  const n = Number(v)
  if (!Number.isFinite(n)) return def
  return Math.min(hi, Math.max(lo, n))
}

/**
 * POST /api/trader/plan — trader-budget + trader-risk: size the weights to
 * the budget, PASS/BLOCK every order and store the batch as tickets.
 * Body: { weights: [{ticker, name, weight}], market: 'crypto'|'stock',
 *         source, budget?, cashBufferPct?, maxPositionPct?, minOrderUsd?,
 *         maxOrderUsd?, maxOrdersPerDay?, top?, blocked? }
 */
export async function POST(req: NextRequest) {
  const uid = await userId(req)
  if (!uid) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  let body: Record<string, unknown>
  try {
    body = (await req.json()) as Record<string, unknown>
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid request body' }, { status: 400 })
  }

  const weights = Array.isArray(body.weights)
    ? (body.weights as Array<{ ticker?: unknown; name?: unknown; weight?: unknown }>)
        .filter((w) => typeof w?.ticker === 'string' && Number.isFinite(Number(w.weight)) && Number(w.weight) > 0)
        .map((w) => ({
          ticker: String(w.ticker).trim().toUpperCase().slice(0, 10),
          name: String(w.name ?? ''),
          weight: Number(w.weight),
        }))
    : []
  if (!weights.length)
    return NextResponse.json({ ok: false, error: 'No weights to size — run the screener or analyze a filer first.' }, { status: 400 })
  if (weights.length > 40)
    return NextResponse.json({ ok: false, error: 'Too many weights (max 40) — keep the top N.' }, { status: 400 })

  const market = body.market === 'stock' ? 'stock' : 'crypto'
  const source = String(body.source ?? '').slice(0, 80)
  const rules: DeskRules = {
    budget: clampPct(body.budget, DEFAULT_RULES.budget, 1, 100_000_000),
    cashBufferPct: clampPct(body.cashBufferPct, DEFAULT_RULES.cashBufferPct, 0, 99),
    maxPositionPct: clampPct(body.maxPositionPct, DEFAULT_RULES.maxPositionPct, 1, 100),
    minOrderUsd: clampPct(body.minOrderUsd, DEFAULT_RULES.minOrderUsd, 0, 10_000),
    maxOrderUsd: clampPct(body.maxOrderUsd, DEFAULT_RULES.maxOrderUsd, 10, 1_000_000),
    maxOrdersPerDay: clampPct(body.maxOrdersPerDay, DEFAULT_RULES.maxOrdersPerDay, 1, 100),
  }
  const top = Number.isFinite(Number(body.top)) ? Math.min(30, Math.max(1, Math.floor(Number(body.top)))) : undefined
  const blocked = Array.isArray(body.blocked)
    ? (body.blocked as unknown[]).map((b) => String(b).trim().toUpperCase()).filter(Boolean).slice(0, 100)
    : []

  try {
    const plan = await buildPlan(uid, { weights, rules, market, source, top, blocked })
    // remember the targets for the rebalancer's drift table
    await saveTargets(
      uid,
      source || (market === 'crypto' ? 'crypto screen' : 'copied 13F'),
      plan.sizing.positions.map((p) => ({ symbol: p.ticker, name: p.name, weight: p.weight })),
    )
    return NextResponse.json({ ok: true, ...plan, note: 'Proposals only. Nothing is filled until you approve each ticket.' })
  } catch (e) {
    if (e instanceof DeskError || e instanceof Error) {
      const msg = e instanceof DeskError ? e.message : 'planning failed unexpectedly'
      if (!(e instanceof DeskError)) console.error('[api/trader/plan] error:', e)
      return NextResponse.json({ ok: false, error: msg }, { status: e instanceof DeskError ? 400 : 500 })
    }
    return NextResponse.json({ ok: false, error: 'planning failed unexpectedly' }, { status: 500 })
  }
}
