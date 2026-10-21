import { NextRequest, NextResponse } from 'next/server'
import { SESSION_COOKIE, verifyToken } from '@/lib/auth'
import { planLevels } from '@/lib/trader/desk'
import {
  PRESETS,
  ScreenError,
  UNIVERSE_SIZE,
  buildFeed,
  validateSpec,
  type Market,
  type ScreenRow,
  type ScreenerSpec,
} from '@/lib/trader/screener'

export const dynamic = 'force-dynamic'
export const maxDuration = 120

async function userId(req: NextRequest): Promise<string | null> {
  const session = await verifyToken(req.cookies.get(SESSION_COOKIE)?.value)
  return session?.id ?? null
}

/** GET /api/trader/screen — the preset screens (so the UI can offer them). */
export async function GET() {
  return NextResponse.json({
    ok: true,
    presets: PRESETS.map((p) => ({ key: p.key, label: p.label, spec: p.spec })),
    universe: UNIVERSE_SIZE,
    metrics: [
      'momentum24h', 'momentum7d', 'momentum30d', 'absMomentum7d', 'absMomentum30d',
      'volatility30d', 'volumeRatio', 'drawdownFrom30dHigh', 'price', 'change24hPct', 'quoteVolume24h',
    ],
  })
}

/**
 * POST /api/trader/screen — run the screen and return the signal feed.
 * Body: { market?: "crypto" | "stock" | "all", spec } (the repo's rules JSON:
 * {rules, rank, missing, top}) or { preset: "best" | "momentum" | "breakout" | "calm" }.
 *
 * Every feed row carries BOTH a longPlan and a shortPlan (entry zone, stop,
 * T1, T2, R:R) — the pinned crypto majors (BTC, ETH, SOL, XRP) are always
 * included for the crypto side.
 */
export async function POST(req: NextRequest) {
  const uid = await userId(req)
  if (!uid) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  let body: { market?: unknown; spec?: unknown; preset?: unknown }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid request body' }, { status: 400 })
  }

  const market: Market | 'all' = body.market === 'crypto' || body.market === 'stock' ? body.market : 'all'

  let spec: ScreenerSpec
  if (typeof body.preset === 'string') {
    const preset = PRESETS.find((p) => p.key === body.preset)
    if (!preset) return NextResponse.json({ ok: false, error: 'unknown preset' }, { status: 400 })
    spec = preset.spec
  } else if (body.spec && typeof body.spec === 'object') {
    spec = body.spec as ScreenerSpec
  } else {
    return NextResponse.json({ ok: false, error: 'pass a spec ({rules, rank, top}) or a preset' }, { status: 400 })
  }

  try {
    validateSpec(spec)
    const markets: Market[] = market === 'all' ? ['crypto', 'stock'] : [market]

    // one market failing (e.g. Yahoo throttling) must not sink the other
    const feeds = await Promise.all(
      markets.map(async (m) => {
        try {
          return await buildFeed(spec, m)
        } catch (e) {
          if (e instanceof ScreenError) throw e
          console.error(`[api/trader/screen] ${m} scan failed:`, e)
          return null
        }
      }),
    )
    if (feeds.every((f) => f === null)) {
      return NextResponse.json({ ok: false, error: 'the screen failed to run — try again' }, { status: 502 })
    }
    const rows: ScreenRow[] = feeds.flatMap((f) => f?.rows ?? [])

    // Entry zone / stop / T1 / T2 previews for BOTH directions on every feed
    // row — the same planLevels() the journal freezes on take (a preview is
    // never a blocker: null simply renders as "—" and that side is untakeable).
    await Promise.all(
      rows.flatMap((row) => [
        planLevels(row.symbol, row.market, 'LONG').then((p) => {
          row.longPlan = p
        }),
        planLevels(row.symbol, row.market, 'SHORT').then((p) => {
          row.shortPlan = p
        }),
      ]),
    )

    const scanned = feeds.reduce((s, f) => s + (f?.scanned ?? 0), 0)
    return NextResponse.json({
      ok: true,
      result: {
        name: spec.name ?? 'screen',
        market,
        scanned,
        passed: rows.length,
        asOf: new Date().toISOString(),
        rows,
        failedRows: [],
      },
      note: 'A screen is a filter, not a recommendation — every signal comes with a long AND a short plan (entry, stop, targets); taking one freezes the plan into your trade tracker.',
    })
  } catch (e) {
    if (e instanceof ScreenError) return NextResponse.json({ ok: false, error: e.message }, { status: 400 })
    console.error('[api/trader/screen] error:', e)
    return NextResponse.json({ ok: false, error: 'the screen failed to run — try again' }, { status: 502 })
  }
}
