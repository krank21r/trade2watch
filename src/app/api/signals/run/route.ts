import { NextRequest, NextResponse } from 'next/server'
import { db, ensureTables } from '@/lib/db'
import { runSignalPipeline } from '@/lib/signals/engine'
import { CRYPTO_HINT } from '@/lib/market/providers'

export const dynamic = 'force-dynamic'
// The multi-agent pipeline runs INSIDE this request. On Vercel serverless a
// fire-and-forget task is frozen the moment the 202 response is sent, and the
// /tmp SQLite database is per-instance — so background execution plus polling
// a second request can neither progress the run nor even find its row (the
// "Run multi-agent analysis not running" bug). Keeping the whole pipeline
// request-scoped makes it work identically in dev and on production. 300s
// covers ~10 LLM calls including rate-limit backoffs.
export const maxDuration = 300

// POST /api/signals/run — start a new multi-agent analysis and run it to
// completion within this request; returns the finished run row.
export async function POST(req: NextRequest) {
  try {
    await ensureTables()
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
      data: { symbol: rawSymbol, market, status: 'running', stage: 'queued', progress: 2, source: 'manual' },
    })

    // Await the full pipeline — it catches its own errors and marks the row
    // 'failed', so this always returns a usable run for the client to render
    // without a second request having to find it (which serverless /tmp
    // SQLite cannot guarantee across instances).
    await runSignalPipeline(run.id, rawSymbol, market)

    const finished = await db.signalRun.findUnique({ where: { id: run.id } })
    if (!finished) {
      return NextResponse.json({ error: 'Failed to load the finished analysis.' }, { status: 500 })
    }

    return NextResponse.json({ runId: run.id, run: finished }, { status: 200 })
  } catch (e) {
    console.error('[api/signals/run] error:', e)
    return NextResponse.json({ error: 'Failed to start analysis.' }, { status: 500 })
  }
}
