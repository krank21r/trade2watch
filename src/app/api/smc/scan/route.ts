import { NextRequest, NextResponse } from 'next/server'
import { runSmcAnalysis } from '@/lib/smc/analysis'
import type { SmcScanResponse, SmcScanRow, StrategyMode } from '@/lib/smc/types'

export const dynamic = 'force-dynamic'

/**
 * GET /api/smc/scan?mode=STRICT
 *
 * Multi-pair scanner — runs the FULL engine (same 30s response cache as the
 * analysis endpoint, so a 45s UI poll re-computes nothing) for every liquid
 * USDT pair and strips the result down to a scanner chip row. A LONG/SHORT on
 * ANY pair becomes visible at a glance instead of hiding behind the one symbol
 * the board happens to display.
 *
 * Equities (AAPL/TSLA/NVDA) are NOT scanned: the SMC engine's data layer is
 * Bybit/Binance spot — no equities source exists (honest scope, §62).
 */
const SCAN_SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'DOGEUSDT'] as const

const MODES: StrategyMode[] = ['STRICT', 'BALANCED', 'AGGRESSIVE']

export async function GET(req: NextRequest) {
  const rawMode = req.nextUrl.searchParams.get('mode')?.trim().toUpperCase() ?? ''
  let mode: StrategyMode | undefined
  if (rawMode) {
    if (!MODES.includes(rawMode as StrategyMode)) {
      return NextResponse.json(
        { ok: false, error: `invalid mode '${rawMode}' (STRICT | BALANCED | AGGRESSIVE)` },
        { status: 400, headers: { 'Cache-Control': 'no-store' } },
      )
    }
    mode = rawMode as StrategyMode
  }

  const settled = await Promise.allSettled(SCAN_SYMBOLS.map((s) => runSmcAnalysis(s, mode)))

  const rows: SmcScanRow[] = settled.map((r, i) => {
    const symbol = SCAN_SYMBOLS[i]
    if (r.status === 'fulfilled') {
      const d = r.value
      const reasonNote =
        d.reasons[0] && d.reasons[0].factor
          ? `${d.reasons[0].factor} — ${d.reasons[0].result}`
          : null
      return {
        symbol,
        ok: true,
        signal: d.signal,
        score: d.score,
        quality: d.quality,
        bias: d.market_bias,
        price: d.current_price,
        change24h: d.change24h,
        note: d.watch_note ?? d.explanation[0] ?? reasonNote,
        generatedAt: d.generatedAt,
      }
    }
    return {
      symbol,
      ok: false,
      error: String(r.reason instanceof Error ? r.reason.message : r.reason).slice(0, 160),
      signal: 'NO_TRADE',
      score: 0,
      quality: '—',
      bias: 'NEUTRAL',
      price: 0,
      change24h: 0,
      note: null,
      generatedAt: Date.now(),
    }
  })

  const body: SmcScanResponse = {
    ok: true,
    mode: mode ?? 'STRICT',
    generatedAt: Date.now(),
    rows,
  }
  return NextResponse.json(body, { headers: { 'Cache-Control': 'no-store' } })
}
