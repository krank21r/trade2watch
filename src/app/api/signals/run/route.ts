import { NextRequest, NextResponse, after } from 'next/server'
import { db, ensureTables } from '@/lib/db'
import { runSignalPipeline } from '@/lib/signals/engine'
import { mirrorConfigured, mirrorRun } from '@/lib/signals/mirror'
import { CRYPTO_HINT } from '@/lib/market/providers'

export const dynamic = 'force-dynamic'
// The pipeline runs AFTER the response via after() (waitUntil on Vercel fluid
// compute) — the POST answers instantly with the runId and the client polls
// GET /api/signals/run/[id], which reads live stage/progress from the shared
// Neon database. The old design ran the whole pipeline inside the request —
// correct in the /tmp-SQLite era when a second request could not even find
// the row — but on Vercel the LLM egress is slower and hits rate-limit
// backoffs, so the request held its connection for 3-5 minutes and browsers/
// the edge proxy gave up before the engine finished ("Run multi-agent
// analysis not working on production"). maxDuration keeps the full 300s
// window available to the post-response pipeline.
export const maxDuration = 300

// POST /api/signals/run — start a new multi-agent analysis; returns the
// running row immediately (client polls /api/signals/run/[id] to completion).
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

    // Mirror mode: execute the analysis ON the published desk so both sites
    // stay row-for-row identical (the finished row is mirrored back here).
    if (mirrorConfigured()) {
      const m = await mirrorRun(rawSymbol, market)
      if (m.ok && m.run) {
        return NextResponse.json({ runId: m.runId, run: m.run }, { status: 200 })
      }
      return NextResponse.json(
        { error: m.error ?? 'The published desk could not run this analysis.' },
        { status: 502 },
      )
    }

    const run = await db.signalRun.create({
      data: { symbol: rawSymbol, market, status: 'running', stage: 'queued', progress: 2, source: 'manual' },
    })

    // Schedule the pipeline for after this response is sent. after() keeps
    // the serverless instance alive (waitUntil) until it finishes, inside the
    // maxDuration window. The engine catches its own errors and marks the row
    // 'failed', so the poller always observes a terminal state even on crash.
    after(async () => {
      await runSignalPipeline(run.id, rawSymbol, market)
    })

    const fresh = await db.signalRun.findUnique({ where: { id: run.id } })
    return NextResponse.json({ runId: run.id, run: fresh ?? run }, { status: 200 })
  } catch (e) {
    console.error('[api/signals/run] error:', e)
    return NextResponse.json({ error: 'Failed to start analysis.' }, { status: 500 })
  }
}
