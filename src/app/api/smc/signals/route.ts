import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import type { SmcJournalConfirmedRow, SmcJournalResponse, SmcJournalStagedRow } from '@/lib/smc/types'

export const dynamic = 'force-dynamic'

/**
 * GET /api/smc/signals
 *
 * Cross-symbol signal journal:
 *  - confirmed[]  — every LONG/SHORT the engine has ever logged (any symbol,
 *                   any mode), newest first, with lifecycle status
 *  - staged[]     — watchlist radar log: setups that were staged (WATCHLIST)
 *                   with exactly what was missing — the answer to "I saw a
 *                   setup earlier, where did it go?"
 */
export async function GET() {
  try {
    const [signalRows, watchRows] = await Promise.all([
      db.smcSignal.findMany({ orderBy: { createdAt: 'desc' }, take: 60 }),
      db.smcWatchLog.findMany({ orderBy: { lastSeen: 'desc' }, take: 60 }),
    ])

    const confirmed: SmcJournalConfirmedRow[] = signalRows.map((r) => ({
      id: r.id,
      symbol: r.symbol,
      direction: r.direction as 'LONG' | 'SHORT',
      mode: r.mode,
      quality: r.quality,
      score: r.score,
      entryMid: r.entryMid,
      entryLow: r.entryLow,
      entryHigh: r.entryHigh,
      stopLoss: r.stopLoss,
      tp1: r.tp1,
      tp2: r.tp2,
      tp3: r.tp3,
      status: r.status,
      result: r.result,
      rMultiple: r.rMultiple,
      createdAt: r.createdAt,
      tp1At: r.tp1At,
      tp2At: r.tp2At,
      tp3At: r.tp3At,
      slAt: r.slAt,
    }))

    const staged: SmcJournalStagedRow[] = watchRows.map((r) => ({
      id: r.id,
      symbol: r.symbol,
      direction: r.direction as 'BULLISH' | 'BEARISH',
      mode: r.mode,
      obLow: r.obLow,
      obHigh: r.obHigh,
      score: r.score,
      quality: r.quality,
      note: r.note,
      entryLow: r.entryLow,
      entryHigh: r.entryHigh,
      stopLoss: r.stopLoss,
      firstSeen: r.firstSeen,
      lastSeen: r.lastSeen,
    }))

    const body: SmcJournalResponse = {
      ok: true,
      confirmed,
      staged,
      generatedAt: Date.now(),
    }
    return NextResponse.json(body, { headers: { 'Cache-Control': 'no-store' } })
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: String(e instanceof Error ? e.message : e).slice(0, 200) },
      { status: 500, headers: { 'Cache-Control': 'no-store' } },
    )
  }
}
