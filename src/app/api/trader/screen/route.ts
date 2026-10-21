import { NextRequest, NextResponse } from 'next/server'
import { SESSION_COOKIE, verifyToken } from '@/lib/auth'
import { planLevels } from '@/lib/trader/desk'
import {
  PRESETS,
  ScreenError,
  runScreen,
  validateSpec,
  weightsFromScreen,
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
    metrics: [
      'momentum24h', 'momentum7d', 'momentum30d', 'volatility30d',
      'volumeRatio', 'drawdownFrom30dHigh', 'price', 'change24hPct', 'quoteVolume24h',
    ],
  })
}

/**
 * POST /api/trader/screen — run the crypto screen.
 * Body: { spec } (the repo's rules JSON: {rules, rank, missing, top}) or
 * { preset: "momentum" | "breakout" | "calm" }.
 */
export async function POST(req: NextRequest) {
  const uid = await userId(req)
  if (!uid) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  let body: { spec?: unknown; preset?: unknown }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid request body' }, { status: 400 })
  }

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
    const result = await runScreen(spec)
    // Entry zone / stop / T1 / T2 previews for the ranked passers — the same
    // planLevels() the tickets use, so stage 1 already shows a full trade plan
    // (a preview is never a blocker: null simply renders as "—").
    await Promise.all(
      result.rows.map(async (row) => {
        row.plan = await planLevels(row.symbol, 'crypto')
      }),
    )
    return NextResponse.json({
      ok: true,
      result,
      weights: weightsFromScreen(result),
      note: 'A screen is a filter, not a recommendation. Weights are score-proportional over the ranked passers.',
    })
  } catch (e) {
    if (e instanceof ScreenError) return NextResponse.json({ ok: false, error: e.message }, { status: 400 })
    console.error('[api/trader/screen] error:', e)
    return NextResponse.json({ ok: false, error: 'the screen failed to run — try again' }, { status: 502 })
  }
}
