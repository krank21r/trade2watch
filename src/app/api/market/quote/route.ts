import { NextRequest, NextResponse } from 'next/server'
import { getTicker } from '@/lib/market/providers'

export const dynamic = 'force-dynamic'

// GET /api/market/quote?symbols=BTC,AAPL&market=crypto|stock
export async function GET(req: NextRequest) {
  const raw = req.nextUrl.searchParams.get('symbols') ?? ''
  const market = req.nextUrl.searchParams.get('market') === 'stock' ? 'stock' : 'crypto'
  const symbols = raw
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean)
    .slice(0, 10)

  if (!symbols.length) return NextResponse.json({ quotes: [] })

  const quotes = await Promise.all(
    symbols.map(async (s) => {
      try {
        const t = await getTicker(s, market)
        return { ok: true, ...t }
      } catch (e) {
        return { ok: false, symbol: s, market, error: String(e).slice(0, 120) }
      }
    }),
  )

  return NextResponse.json({ quotes })
}
