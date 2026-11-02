import { NextRequest, NextResponse } from 'next/server'
import { runSmcAnalysis } from '@/lib/smc/analysis'
import { SMC_DISCLAIMER } from '@/lib/smc/config'
import type { SmcAnalysisError, StrategyMode } from '@/lib/smc/types'

export const dynamic = 'force-dynamic'

const SYMBOL_RE = /^[A-Z]{2,10}USDT?$/i
const MODES: StrategyMode[] = ['STRICT', 'BALANCED', 'AGGRESSIVE']

function errorPayload(symbol: string, message: string) {
  const body: SmcAnalysisError = {
    ok: false,
    symbol,
    dataSource: 'UNAVAILABLE',
    error: message,
    disclaimer: SMC_DISCLAIMER,
  }
  return body
}

/**
 * GET /api/smc/analysis?symbol=BTCUSDT&mode=STRICT
 * The single consolidated SMC payload (§25): bias, per-TF summaries, order
 * blocks, FVGs, liquidity, sweeps, signal, plan, reasons, history.
 */
export async function GET(req: NextRequest) {
  const rawSymbol = (req.nextUrl.searchParams.get('symbol') ?? 'BTCUSDT').trim().toUpperCase()
  if (!SYMBOL_RE.test(rawSymbol)) {
    return NextResponse.json(errorPayload(rawSymbol, `invalid symbol '${rawSymbol}'`), {
      status: 400,
      headers: { 'Cache-Control': 'no-store' },
    })
  }

  const rawMode = req.nextUrl.searchParams.get('mode')?.trim().toUpperCase() ?? ''
  let mode: StrategyMode | undefined
  if (rawMode) {
    if (!MODES.includes(rawMode as StrategyMode)) {
      return NextResponse.json(errorPayload(rawSymbol, `invalid mode '${rawMode}' (STRICT | BALANCED | AGGRESSIVE)`), {
        status: 400,
        headers: { 'Cache-Control': 'no-store' },
      })
    }
    mode = rawMode as StrategyMode
  }

  try {
    const payload = await runSmcAnalysis(rawSymbol, mode)
    return NextResponse.json(payload, { headers: { 'Cache-Control': 'no-store' } })
  } catch (e) {
    return NextResponse.json(errorPayload(rawSymbol, String(e instanceof Error ? e.message : e).slice(0, 300)), {
      status: 503,
      headers: { 'Cache-Control': 'no-store' },
    })
  }
}
