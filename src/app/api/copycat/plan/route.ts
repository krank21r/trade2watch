import { NextRequest, NextResponse } from 'next/server'
import { SESSION_COOKIE, verifyToken } from '@/lib/auth'
import { fetchStockTicker } from '@/lib/market/providers'
import { SizeError, ordersFrom, size, type WeightRow } from '@/lib/copycat/size'
import { checkOrders, riskLimitsFrom } from '@/lib/copycat/risk'

export const dynamic = 'force-dynamic'
export const maxDuration = 120

/** Resolve the signed-in user (middleware gates the route; this is defense-in-depth). */
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
 * POST /api/copycat/plan — pure arithmetic: weights + rules → dollar amounts,
 * proposed orders and risk verdicts. Proposals only; nothing is ever placed.
 */
export async function POST(req: NextRequest) {
  const uid = await userId(req)
  if (!uid) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })

  let body: {
    weights?: unknown
    budget?: unknown
    cashBufferPct?: unknown
    maxPositionPct?: unknown
    minOrderUsd?: unknown
    blocked?: unknown
    wholeShares?: unknown
    top?: unknown
    source?: unknown
  }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid request body' }, { status: 400 })
  }

  const weights: WeightRow[] = Array.isArray(body.weights)
    ? body.weights
        .map((w) => w as { ticker?: unknown; name?: unknown; weight?: unknown })
        .filter((w) => typeof w?.ticker === 'string' && Number.isFinite(Number(w.weight)))
        .map((w) => ({
          ticker: String(w.ticker).trim().toUpperCase().slice(0, 6),
          name: String(w.name ?? ''),
          weight: Number(w.weight),
        }))
    : []
  if (!weights.length) return NextResponse.json({ ok: false, error: 'No weights to size — analyze a filer first.' }, { status: 400 })

  const budget = Number(body.budget)
  if (!Number.isFinite(budget) || budget <= 0 || budget > 100_000_000)
    return NextResponse.json({ ok: false, error: 'Enter a budget in dollars (e.g. 5000).' }, { status: 400 })

  const cfg = {
    cashBufferPct: clampPct(body.cashBufferPct, 10, 0, 99),
    maxPositionPct: clampPct(body.maxPositionPct, 25, 1, 100),
    minOrderUsd: clampPct(body.minOrderUsd, 5, 0, 10_000),
    blocked: Array.isArray(body.blocked)
      ? body.blocked.map((b) => String(b).trim().toUpperCase()).filter(Boolean).slice(0, 100)
      : [],
    wholeShares: body.wholeShares === true,
  }
  const top = Number.isFinite(Number(body.top)) ? Math.min(30, Math.max(1, Math.floor(Number(body.top)))) : undefined
  const source = String(body.source ?? '').slice(0, 80)

  try {
    // live prices (Yahoo) — needed for whole shares; nice context otherwise
    const tickers = [...new Set(weights.map((w) => w.ticker))]
    const priceEntries = await Promise.all(
      tickers.map(async (t) => {
        try {
          const tk = await fetchStockTicker(t)
          return [t, tk.price] as const
        } catch {
          return [t, 0] as const
        }
      }),
    )
    const prices: Record<string, number> = Object.fromEntries(priceEntries.filter(([, p]) => p > 0))

    const sizing = size(weights, cfg, budget, prices, top)
    const orders = ordersFrom(sizing, source)
    const risk = checkOrders(
      sizing.positions.filter((p) => p.dollars > 0).map((p) => ({ symbol: p.ticker, notional: p.dollars })),
      riskLimitsFrom(sizing, 2000, 10),
    )
    return NextResponse.json({
      ok: true,
      source,
      prices,
      sizing,
      orders,
      risk,
      note: 'Proposals only — nothing is placed. Execute at your own broker after your own review.',
    })
  } catch (e) {
    if (e instanceof SizeError) return NextResponse.json({ ok: false, error: e.message }, { status: 400 })
    console.error('[api/copycat/plan] error:', e)
    return NextResponse.json({ ok: false, error: 'Sizing failed unexpectedly.' }, { status: 500 })
  }
}
