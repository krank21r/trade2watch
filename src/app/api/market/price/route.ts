import { NextRequest, NextResponse } from 'next/server'
import { getTicker } from '@/lib/market/providers'

export const dynamic = 'force-dynamic'

/**
 * GET /api/market/price?symbol=BTC&market=crypto — lightweight price quote.
 *
 * Used by the client to evaluate entry-zone / stop / target outcomes for runs
 * it keeps in browser-local storage: production runs on ephemeral per-instance
 * /tmp SQLite, so the server-side outcome evaluator (GET /api/signals) cannot
 * see rows written by other instances. Session-gated by the middleware like
 * every other API route.
 */
export async function GET(req: NextRequest) {
  const symbol = (req.nextUrl.searchParams.get('symbol') ?? '').trim().toUpperCase()
  const market = req.nextUrl.searchParams.get('market') === 'stock' ? 'stock' : 'crypto'
  if (!symbol || symbol.length > 12 || !/^[A-Z0-9.\-]+$/.test(symbol)) {
    return NextResponse.json({ error: 'Invalid symbol.' }, { status: 400 })
  }
  try {
    const t = await getTicker(symbol, market)
    return NextResponse.json({ symbol, market, price: t.price, change24h: t.change24h, currency: t.currency })
  } catch (e) {
    console.error('[api/market/price] error:', e)
    return NextResponse.json({ error: 'Price unavailable.' }, { status: 502 })
  }
}
