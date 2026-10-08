import { NextRequest, NextResponse } from 'next/server'
import { runBacktest } from '@/lib/smc/backtest'
import { SMC_DISCLAIMER } from '@/lib/smc/config'
import type { StrategyMode } from '@/lib/smc/types'

export const dynamic = 'force-dynamic'
export const maxDuration = 120

const SYMBOL_RE = /^[A-Z]{2,10}USDT?$/i
const MODES: StrategyMode[] = ['STRICT', 'BALANCED', 'AGGRESSIVE']

/**
 * GET /api/smc/backtest?symbol=BTCUSDT&days=30&mode=STRICT&folds=4
 *
 * On-demand heavy endpoint (§29/§30/§31): replays the live SMC pipeline over
 * `days` of history with structural no-look-ahead time-slicing, simulates the
 * same lifecycle the real signals get, reports aggregate + per-fold
 * (walk-forward) stats. Cached 10 minutes per parameter set; concurrent calls
 * for the same parameters share one run.
 */
export async function GET(req: NextRequest) {
  const rawSymbol = (req.nextUrl.searchParams.get('symbol') ?? 'BTCUSDT').trim().toUpperCase()
  if (!SYMBOL_RE.test(rawSymbol)) {
    return NextResponse.json(
      { ok: false, symbol: rawSymbol, error: `invalid symbol '${rawSymbol}'`, disclaimer: SMC_DISCLAIMER },
      { status: 400, headers: { 'Cache-Control': 'no-store' } },
    )
  }

  const daysRaw = Number(req.nextUrl.searchParams.get('days') ?? '30')
  const days = Number.isFinite(daysRaw) ? Math.min(90, Math.max(7, Math.floor(daysRaw))) : 30

  const rawMode = (req.nextUrl.searchParams.get('mode') ?? 'STRICT').trim().toUpperCase()
  if (!MODES.includes(rawMode as StrategyMode)) {
    return NextResponse.json(
      { ok: false, symbol: rawSymbol, error: `invalid mode '${rawMode}' (STRICT | BALANCED | AGGRESSIVE)`, disclaimer: SMC_DISCLAIMER },
      { status: 400, headers: { 'Cache-Control': 'no-store' } },
    )
  }
  const mode = rawMode as StrategyMode

  const foldsRaw = Number(req.nextUrl.searchParams.get('folds') ?? '4')
  const folds = Number.isFinite(foldsRaw) ? Math.min(8, Math.max(2, Math.floor(foldsRaw))) : 4

  const key = `${rawSymbol}:${days}:${mode}:${folds}`
  const hit = resultCache.get(key)
  if (hit && Date.now() - hit.at < RESULT_TTL) {
    return NextResponse.json(hit.data, { headers: { 'Cache-Control': 'no-store' } })
  }

  // single-flight: concurrent identical requests share one heavy run
  const inflight = inflightRuns.get(key)
  if (inflight) return NextResponse.json(await inflight, { headers: { 'Cache-Control': 'no-store' } })

  const run = (async () => {
    try {
      const result = await runBacktest(rawSymbol, { days, mode, folds })
      resultCache.set(key, { at: Date.now(), data: result })
      return result as object
    } catch (e) {
      return {
        ok: false,
        symbol: rawSymbol,
        error: String(e instanceof Error ? e.message : e).slice(0, 300),
        disclaimer: SMC_DISCLAIMER,
      }
    } finally {
      inflightRuns.delete(key)
    }
  })()
  inflightRuns.set(key, run)
  const body = await run

  const status = body instanceof Object && 'ok' in body && (body as { ok: boolean }).ok ? 200 : 503
  return NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } })
}

const RESULT_TTL = 10 * 60_000
const resultCache = new Map<string, { at: number; data: object }>()
const inflightRuns = new Map<string, Promise<object>>()
