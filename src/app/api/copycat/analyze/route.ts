import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { SESSION_COOKIE, verifyToken } from '@/lib/auth'
import {
  EdgarError,
  aggregate,
  combineClasses,
  diff,
  fetch13fByPeriod,
  fetchLatest13f,
  isStock,
  list13fFilings,
  pickFiling,
} from '@/lib/copycat/edgar'
import { resolveTicker } from '@/lib/copycat/tickers'
import { findFilerByCik } from '@/lib/copycat/filers'

export const dynamic = 'force-dynamic'
export const maxDuration = 120

const MAX_POSITIONS = 60
const MAX_DIFF_ROWS = 40
const MAX_WEIGHTS = 30
const MAX_SKIPPED = 15

/** Resolve the signed-in user (middleware gates the route; this is defense-in-depth). */
async function userId(req: NextRequest): Promise<string | null> {
  const session = await verifyToken(req.cookies.get(SESSION_COOKIE)?.value)
  return session?.id ?? null
}

function periodBefore(period: string): string {
  // quarter string YYYY-MM-DD (last day of quarter) → one quarter earlier
  const d = new Date(`${period}T00:00:00Z`)
  if (Number.isNaN(d.getTime())) return ''
  d.setUTCMonth(d.getUTCMonth() - 3)
  return d.toISOString().slice(0, 10)
}

/**
 * POST /api/copycat/analyze — read an investor's latest 13F-HR from SEC EDGAR,
 * rebuild the portfolio as weights, resolve tickers and diff the previous
 * quarter. Read-only public data; nothing is traded.
 */
export async function POST(req: NextRequest) {
  const uid = await userId(req)
  if (!uid) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })

  let cik = ''
  try {
    const body = (await req.json()) as { cik?: unknown }
    cik = String(body?.cik ?? '').replace(/\D/g, '')
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid request body' }, { status: 400 })
  }
  if (!cik || cik.length > 10) {
    return NextResponse.json({ ok: false, error: 'Provide a SEC CIK, e.g. 1067983 (Berkshire).' }, { status: 400 })
  }

  try {
    const latest = await fetchLatest13f(cik)
    const curated = findFilerByCik(String(parseInt(cik, 10)).padStart(10, '0'))

    // share classes of one issuer summed (stock rows only)
    const { positions, total } = aggregate(latest.rows)
    const combined = combineClasses(positions, total)

    // resolve tickers (public SEC name→ticker map, cached 24h)
    const withTickers = await Promise.all(
      combined.map(async (p) => {
        if (!isStock(p)) return { ...p, tickers: [] }
        const hit = await resolveTicker(p.issuer, p.title)
        return { ...p, tickers: hit ? [hit.ticker] : [] }
      }),
    )

    // quarter-over-quarter diff against the previous 13F-HR
    let diffRows: ReturnType<typeof diff> = []
    let priorInfo: { period: string; filed: string } | null = null
    try {
      const filings = await list13fFilings(cik)
      const originals = filings
        .filter((f) => f.form === '13F-HR' && f.period && f.period < latest.meta.period)
        .sort((a, b) => b.period.localeCompare(a.period))
      const prevPeriod = originals[0]?.period || periodBefore(latest.meta.period)
      if (prevPeriod) {
        const prior = await fetch13fByPeriod(cik, prevPeriod)
        priorInfo = { period: prior.meta.period, filed: prior.meta.filed }
        const priorAgg = aggregate(prior.rows)
        const priorCombined = combineClasses(priorAgg.positions, priorAgg.total)
        const priorWithTickers = await Promise.all(
          priorCombined.map(async (p) => {
            if (!isStock(p)) return { ...p, tickers: [] }
            const hit = await resolveTicker(p.issuer, p.title)
            return { ...p, tickers: hit ? [hit.ticker] : [] }
          }),
        )
        diffRows = diff(withTickers, priorWithTickers)
      }
    } catch {
      /* a missing prior quarter must not break the analysis */
    }

    // copyable weights: stock rows with a resolved ticker
    const copyable = withTickers.filter((p) => isStock(p) && p.tickers[0])
    const copyWeights = copyable
      .slice()
      .sort((a, b) => b.value - a.value)
      .slice(0, MAX_WEIGHTS)
      .map((p) => ({ ticker: p.tickers[0], name: p.issuer, weight: p.pctOf13f }))

    const skipped = withTickers
      .filter((p) => !isStock(p) || !p.tickers[0])
      .slice(0, MAX_SKIPPED)
      .map((p) => ({
        issuer: p.issuer,
        ticker: p.tickers[0] ?? '',
        why: isStock(p) ? 'no US-listed ticker matched this issuer name' : `${p.putCall || p.shareType} row, not a stock you can copy`,
      }))

    const counts = diffRows.reduce<Record<string, number>>((acc, r) => {
      acc[r.status] = (acc[r.status] ?? 0) + 1
      return acc
    }, {})

    return NextResponse.json({
      ok: true,
      filer: {
        cik: latest.meta.filerCik,
        name: latest.meta.filerName,
        person: curated?.person ?? '',
        status: curated?.status ?? '',
      },
      meta: { ...latest.meta, total },
      totalPositions: combined.length,
      positions: withTickers.slice(0, MAX_POSITIONS),
      diff: { rows: diffRows.slice(0, MAX_DIFF_ROWS), counts, prior: priorInfo, totalRows: diffRows.length },
      copyWeights,
      skipped,
      fetchedAt: Date.now(),
    })
  } catch (e) {
    const msg = e instanceof EdgarError ? e.message : 'Could not read this filer from SEC EDGAR.'
    console.error('[api/copycat/analyze] error:', e)
    return NextResponse.json({ ok: false, error: msg }, { status: 502 })
  }
}
