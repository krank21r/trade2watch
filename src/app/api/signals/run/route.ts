import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { runSignalPipeline } from '@/lib/signals/engine'
import { CRYPTO_HINT } from '@/lib/market/providers'

export const dynamic = 'force-dynamic'

// POST /api/signals/run — start a new multi-agent analysis
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}))
    const rawSymbol = String(body?.symbol ?? '').trim().toUpperCase()
    const market = body?.market === 'stock' ? 'stock' : body?.market === 'crypto' ? 'crypto' : null

    if (!rawSymbol || rawSymbol.length > 12) {
      return NextResponse.json({ error: 'Provide a symbol, e.g. BTC, ETH, AAPL, TSLA.' }, { status: 400 })
    }
    if (!market) {
      return NextResponse.json({ error: "market must be 'crypto' or 'stock'." }, { status: 400 })
    }
    if (market === 'crypto' && !CRYPTO_HINT.test(rawSymbol)) {
      return NextResponse.json(
        { error: `"${rawSymbol}" is not a recognized Binance pair base. Try BTC, ETH, SOL... or switch to Stocks.` },
        { status: 400 },
      )
    }

    const run = await db.signalRun.create({
      data: { symbol: rawSymbol, market, status: 'running', stage: 'queued', progress: 2 },
    })

    // fire-and-forget: the pipeline updates the DB row as it progresses;
    // the client polls GET /api/signals/run/[id].
    void runSignalPipeline(run.id, rawSymbol, market).catch((e) =>
      console.error('[api/signals/run] pipeline crashed:', e),
    )

    return NextResponse.json({ runId: run.id }, { status: 202 })
  } catch (e) {
    console.error('[api/signals/run] error:', e)
    return NextResponse.json({ error: 'Failed to start analysis.' }, { status: 500 })
  }
}
