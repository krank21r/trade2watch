import { type NextRequest, NextResponse } from 'next/server'
import { getCandles } from '@/lib/market/providers'

// GET /api/candles?symbol=BTC&market=crypto
// Returns recent candles (crypto: 4h · stocks: 1d) — used by the client to
// track taken trades (TP1/TP2/SL hit detection) against real wick history.
export async function GET(req: NextRequest) {
  const symbol = (req.nextUrl.searchParams.get('symbol') ?? '').trim().toUpperCase()
  const market = req.nextUrl.searchParams.get('market') === 'stock' ? 'stock' : 'crypto'
  if (!/^[A-Z0-9.\-]{1,10}$/.test(symbol)) {
    return NextResponse.json({ error: 'valid symbol required' }, { status: 400 })
  }
  try {
    const timeframe = market === 'crypto' ? '4h' : '1d'
    const candles = await getCandles(symbol, market, timeframe)
    return NextResponse.json(
      { symbol, market, timeframe, candles, updatedAt: Date.now() },
      { headers: { 'Cache-Control': 'no-store' } },
    )
  } catch (e) {
    return NextResponse.json({ error: String(e).slice(0, 140) }, { status: 502 })
  }
}
