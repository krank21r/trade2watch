import { NextRequest, NextResponse } from 'next/server'
import { generateSetups } from '@/lib/setups/generate'

export const dynamic = 'force-dynamic'

/**
 * GET /api/setups?symbols=BTC,ETH,SOL
 * Live, auto-generated trade setups (no LLM, no stale config).
 */
export async function GET(req: NextRequest) {
  const raw = req.nextUrl.searchParams.get('symbols') ?? 'BTC,ETH,SOL,AAPL,TSLA,NVDA'
  const symbols = raw
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter((s) => /^[A-Z0-9.\-]{1,10}$/.test(s))
    .slice(0, 8)

  if (symbols.length === 0) {
    return NextResponse.json({ setups: [], failed: {}, updatedAt: new Date().toISOString() })
  }

  try {
    const data = await generateSetups(symbols)
    return NextResponse.json(data, { headers: { 'Cache-Control': 'no-store' } })
  } catch (e) {
    return NextResponse.json({ error: String(e).slice(0, 300) }, { status: 500 })
  }
}
