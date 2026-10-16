/**
 * Browser-local store for signal runs.
 *
 * Production (Vercel) keeps SQLite in the ephemeral /tmp of each serverless
 * instance — a row written by one request is invisible to the next, so
 * server-side history can never be relied on there. The client therefore
 * keeps the user's last runs in scoped localStorage and merges them with
 * whatever the server can currently see. Entry-zone alerts and outcome
 * tracking are computed from this merged view, which makes results survive
 * reloads and instance swaps.
 */
import type { SignalRunDetail, SignalRunRow } from '@/components/signals/types'
import { scopedGetJson, scopedSetJson } from '@/lib/user-scope'

const KEY = 'signal-runs-local'
const MAX_LOCAL = 30

export function loadLocalRuns(): SignalRunRow[] {
  const rows = scopedGetJson<SignalRunRow[]>(KEY, [])
  return Array.isArray(rows) ? rows.filter((r) => r && typeof r.id === 'string' && typeof r.createdAt === 'string') : []
}

export function persistRuns(rows: SignalRunRow[]): void {
  scopedSetJson(KEY, rows.slice(0, MAX_LOCAL))
}

function sortDesc(rows: SignalRunRow[]): SignalRunRow[] {
  return rows.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
}

function mergeRuns(server: SignalRunRow[], local: SignalRunRow[]): SignalRunRow[] {
  const byId = new Map<string, SignalRunRow>()
  for (const r of local) byId.set(r.id, r)
  for (const r of server) byId.set(r.id, r) // server row wins — fresher outcome columns
  return sortDesc([...byId.values()])
}

/** Merge fetched server rows into the local store, persist, and return the merged view. */
export function saveRunsMerged(server: SignalRunRow[], local: SignalRunRow[]): SignalRunRow[] {
  const merged = mergeRuns(server, local).slice(0, MAX_LOCAL)
  persistRuns(merged)
  return merged
}

/** Insert/replace one run (e.g. a just-finished analysis) into the local store. */
export function upsertLocalRun(run: SignalRunRow): SignalRunRow[] {
  const merged = mergeRuns([], [run, ...loadLocalRuns()]).slice(0, MAX_LOCAL)
  persistRuns(merged)
  return merged
}

/** Strip artifacts — the local store keeps the row shape, not the full transcripts. */
export function detailToRow(d: SignalRunDetail): SignalRunRow {
  return {
    id: d.id,
    symbol: d.symbol,
    market: d.market,
    displayName: d.displayName,
    status: d.status,
    stage: d.stage,
    progress: d.progress,
    error: d.error,
    priceAtRun: d.priceAtRun,
    change24h: d.change24h,
    regime: d.regime,
    timeframe: d.timeframe,
    direction: d.direction,
    confidence: d.confidence,
    entryLow: d.entryLow,
    entryHigh: d.entryHigh,
    stop: d.stop,
    target1: d.target1,
    target2: d.target2,
    runner: d.runner,
    riskReward: d.riskReward,
    invalidation: d.invalidation,
    planNote: d.planNote,
    source: d.source ?? 'manual',
    outcome: d.outcome ?? null,
    outcomePrice: d.outcomePrice ?? null,
    outcomeCheckedAt: d.outcomeCheckedAt ?? null,
    createdAt: d.createdAt,
    completedAt: d.completedAt,
  }
}
