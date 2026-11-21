/**
 * Production-desk mirror — makes this instance show EXACTLY the signal
 * history the published site serves, instead of running its own desk.
 *
 * When SIGNALS_MIRROR_BASE_URL is configured:
 *  - the auto scheduler stops running local pipelines and pulls the remote
 *    signal list on its normal cadence instead (boot catch-up pulls once at
 *    startup, so a freshly-woken sandbox syncs within a minute);
 *  - the pull is a FULL REPLACE: every remote row is upserted by id and
 *    local-only rows are deleted, so the AI Signals history, entry-decision
 *    cards and alert watcher match the published site row-for-row;
 *  - "Run multi-agent analysis" is proxied to the remote desk, so even
 *    manual runs are executed by the same brain the published site uses.
 *
 * Read-only upstream by design: the mirror only ever GETs/POSTs the public
 * session-authed endpoints with a stored login — it never mutates remote
 * state beyond what a normal user's dashboard click would.
 */

const PULL_LIMIT = 50

interface MirrorCfg {
  base: string
  user: string
  pass: string
}

function cfg(): MirrorCfg | null {
  const base = process.env.SIGNALS_MIRROR_BASE_URL?.trim().replace(/\/+$/, '')
  if (!base || !/^https?:\/\//.test(base)) return null
  const user = process.env.T2W_MIRROR_USER?.trim() || 'kranthi'
  const pass = process.env.T2W_MIRROR_PASS?.trim() || 'trade2watch'
  return { base, user, pass }
}

export function mirrorConfigured(): boolean {
  return cfg() !== null
}

// ─── session (module-level cookie, re-login on 401) ──────────────────────────

let cookie: string | null = null
let cookieTriedAt = 0

async function login(c: MirrorCfg): Promise<boolean> {
  const res = await fetch(`${c.base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: c.user, password: c.pass }),
    cache: 'no-store',
    signal: AbortSignal.timeout(20_000),
  })
  if (!res.ok) {
    console.error('[signals-mirror] login failed:', res.status)
    return false
  }
  const raw = res.headers.getSetCookie?.() ?? []
  const jar = raw.map((line) => line.split(';')[0]).filter(Boolean)
  cookie = jar.length ? jar.join('; ') : null
  cookieTriedAt = Date.now()
  return cookie !== null
}

async function authedFetch(c: MirrorCfg, path: string, init?: RequestInit, timeoutMs = 25_000): Promise<Response> {
  const doFetch = () =>
    fetch(`${c.base}${path}`, {
      ...init,
      cache: 'no-store',
      headers: { ...(init?.headers ?? {}), ...(cookie ? { Cookie: cookie } : {}) },
      signal: AbortSignal.timeout(timeoutMs),
    })
  let res = await doFetch()
  if (res.status === 401 && Date.now() - cookieTriedAt > 60_000) {
    // session expired upstream — one re-login, then retry
    if (await login(c)) res = await doFetch()
  }
  return res
}

// ─── row mapping (remote JSON → Prisma data) ─────────────────────────────────

const dateOrNull = (v: unknown): Date | null => {
  if (typeof v !== 'string' && typeof v !== 'number') return null
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? null : d
}

function rowToData(row: Record<string, unknown>): import('@prisma/client').Prisma.SignalRunUpsertArgs['create'] {
  return {
    id: String(row.id),
    symbol: String(row.symbol ?? ''),
    market: String(row.market ?? 'crypto'),
    displayName: (row.displayName as string | null) ?? null,
    source: (row.source as string | null) ?? null,
    status: String(row.status ?? 'completed'),
    stage: String(row.stage ?? 'done'),
    progress: Number(row.progress ?? 100) || 0,
    error: (row.error as string | null) ?? null,
    priceAtRun: (row.priceAtRun as number | null) ?? null,
    change24h: (row.change24h as number | null) ?? null,
    regime: (row.regime as string | null) ?? null,
    timeframe: (row.timeframe as string | null) ?? null,
    direction: (row.direction as string | null) ?? null,
    confidence: (row.confidence as number | null) ?? null,
    entryLow: (row.entryLow as number | null) ?? null,
    entryHigh: (row.entryHigh as number | null) ?? null,
    stop: (row.stop as number | null) ?? null,
    target1: (row.target1 as number | null) ?? null,
    target2: (row.target2 as number | null) ?? null,
    riskReward: (row.riskReward as string | null) ?? null,
    outcome: (row.outcome as string | null) ?? null,
    outcomeCheckedAt: dateOrNull(row.outcomeCheckedAt),
    outcomePrice: (row.outcomePrice as number | null) ?? null,
    createdAt: dateOrNull(row.createdAt) ?? new Date(),
    completedAt: dateOrNull(row.completedAt),
  }
}

// ─── pull (full replace) ─────────────────────────────────────────────────────

export interface MirrorPullResult {
  ok: boolean
  pulled: number
  error?: string
}

export async function mirrorPull(): Promise<MirrorPullResult> {
  const c = cfg()
  if (!c) return { ok: false, pulled: 0, error: 'mirror-not-configured' }
  try {
    const { db } = await import('@/lib/db')
    if (!cookie && !(await login(c))) return { ok: false, pulled: 0, error: 'mirror-login-failed' }

    const res = await authedFetch(c, `/api/signals?limit=${PULL_LIMIT}`)
    if (!res.ok) return { ok: false, pulled: 0, error: `mirror-http-${res.status}` }
    const d = (await res.json().catch(() => null)) as { runs?: Record<string, unknown>[] } | null
    const rows = d?.runs
    if (!Array.isArray(rows)) return { ok: false, pulled: 0, error: 'mirror-bad-payload' }

    for (const row of rows) {
      const data = rowToData(row)
      await db.signalRun.upsert({
        where: { id: data.id },
        update: { ...data, id: undefined },
        create: data,
      })
    }
    // Full replace: drop local-only rows so this instance's history is an
    // exact copy of the remote one. Guard: never wipe when the remote came
    // back empty (its ephemeral DB may have been recycled mid-cycle).
    if (rows.length > 0) {
      const keep = rows.map((r) => String(r.id))
      const gone = await db.signalRun.deleteMany({ where: { id: { notIn: keep } } })
      if (gone.count > 0) console.log(`[signals-mirror] dropped ${gone.count} local-only rows`)
    }
    return { ok: true, pulled: rows.length }
  } catch (e) {
    return { ok: false, pulled: 0, error: String(e).slice(0, 160) }
  }
}

// ─── proxied manual run ──────────────────────────────────────────────────────

/**
 * Run the multi-agent analysis ON the remote desk and mirror the finished
 * row back. Returns the same { runId, run } shape the local route answers
 * with, so the dashboard needs no special-casing.
 */
export async function mirrorRun(
  symbol: string,
  market: 'crypto' | 'stock',
): Promise<{ ok: boolean; runId?: string; run?: Record<string, unknown>; error?: string }> {
  const c = cfg()
  if (!c) return { ok: false, error: 'mirror-not-configured' }
  try {
    const { db } = await import('@/lib/db')
    if (!cookie && !(await login(c))) return { ok: false, error: 'The published desk did not accept the mirror login.' }

    const res = await authedFetch(
      c,
      '/api/signals/run',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol, market }),
      },
      280_000, // remote pipeline runs inside the request — give it room
    )
    const d = (await res.json().catch(() => null)) as
      | { run?: Record<string, unknown>; error?: string }
      | null
    if (!res.ok || !d?.run) {
      return { ok: false, error: d?.error ?? `The published desk answered HTTP ${res.status}.` }
    }

    const data = rowToData(d.run)
    await db.signalRun.upsert({ where: { id: data.id }, update: { ...data, id: undefined }, create: data })
    return { ok: true, runId: data.id, run: d.run }
  } catch (e) {
    return { ok: false, error: String(e).slice(0, 160) }
  }
}
