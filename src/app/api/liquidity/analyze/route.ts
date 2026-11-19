/**
 * GET /api/liquidity/analyze?symbol=BTC&tf=4h — the Liquidity Lab pipeline.
 *
 * Runs the 5-stage analysis (liquidity → order flow → price movement →
 * market structure → trade entry) for one crypto symbol and returns the
 * full LiquidityReport. Reports are cached in memory for 45s so the UI's
 * 60s auto-refresh and quick pill-switching stay polite to the vendors.
 */

import { NextRequest, NextResponse } from 'next/server'
import { SESSION_COOKIE, verifyToken } from '@/lib/auth'
import { buildLiquidityReport, LiquidityError } from '@/lib/liquidity/engine'
import type { LiquidityReport, LiqTimeframe } from '@/lib/liquidity/types'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

const TFS: LiqTimeframe[] = ['15m', '1h', '4h']

// 45s in-memory report cache per symbol+timeframe
const reportCache = new Map<string, { at: number; report: LiquidityReport }>()
const CACHE_TTL = 45_000

async function userId(req: NextRequest): Promise<string | null> {
  const session = await verifyToken(req.cookies.get(SESSION_COOKIE)?.value)
  return session?.id ?? null
}

export async function GET(req: NextRequest) {
  const uid = await userId(req)
  if (!uid) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })

  const symbol = (req.nextUrl.searchParams.get('symbol') ?? 'BTC').trim().toUpperCase()
  const tfParam = req.nextUrl.searchParams.get('tf') ?? '4h'
  if (!/^[A-Z0-9]{2,12}$/.test(symbol)) {
    return NextResponse.json({ ok: false, error: 'invalid symbol' }, { status: 400 })
  }
  if (!TFS.includes(tfParam as LiqTimeframe)) {
    return NextResponse.json({ ok: false, error: 'tf must be 15m, 1h or 4h' }, { status: 400 })
  }
  const tf = tfParam as LiqTimeframe

  const key = `${symbol}:${tf}`
  const hit = reportCache.get(key)
  if (hit && Date.now() - hit.at < CACHE_TTL) {
    return NextResponse.json(hit.report, { headers: { 'X-Cache': 'hit' } })
  }

  try {
    const report = await buildLiquidityReport(symbol, tf)
    reportCache.set(key, { at: Date.now(), report })
    // keep the cache from growing unbounded across many symbols
    if (reportCache.size > 120) {
      for (const [k, v] of reportCache) if (Date.now() - v.at > CACHE_TTL) reportCache.delete(k)
    }
    return NextResponse.json(report, { headers: { 'X-Cache': 'miss' } })
  } catch (e) {
    if (e instanceof LiquidityError) {
      return NextResponse.json({ ok: false, error: e.message }, { status: 400 })
    }
    console.error('[api/liquidity/analyze] failed:', e)
    return NextResponse.json({ ok: false, error: 'the liquidity analysis failed — try again' }, { status: 502 })
  }
}
