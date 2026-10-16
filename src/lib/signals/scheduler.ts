/**
 * Auto-desk scheduler — runs the multi-agent signal pipeline automatically
 * so the user doesn't have to click "Run multi-agent analysis" to get fresh
 * signals and entry alerts.
 *
 * How it works:
 *  - started once per server process from src/instrumentation.ts (nodejs only)
 *  - every tick picks the watchlist symbol whose last analysis is the OLDEST
 *    (round-robin by staleness) and runs the full pipeline for it
 *  - one symbol per tick keeps LLM usage sane: with a 20 min interval and 3
 *    symbols every symbol is refreshed once per hour
 *  - state lives on globalThis so HMR / route imports share one instance
 *
 * Runtime notes:
 *  - local / long-running hosts: fully automatic (interval loop)
 *  - Vercel serverless: in-process timers are best-effort at best, so the
 *    loop is NOT started there (VERCEL env set). Production automation is
 *    driven by POST /api/signals/auto/tick from an external cron (GitHub
 *    Actions / cron-job.org) authenticated with the CRON_SECRET header.
 */

import { db, ensureTables } from '@/lib/db'
import { runSignalPipeline } from './engine'

export const AUTO_DEFAULT_SYMBOLS = ['BTC', 'ETH', 'SOL']

function symbols(): string[] {
  return (process.env.SIGNALS_AUTO_SYMBOLS ?? AUTO_DEFAULT_SYMBOLS.join(','))
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter((s) => s.length > 0 && s.length <= 12)
}

function intervalMs(): number {
  const min = Number(process.env.SIGNALS_AUTO_INTERVAL_MIN ?? 20)
  return Math.max(5, Math.min(360, Number.isFinite(min) ? min : 20)) * 60_000
}

interface AutoState {
  enabled: boolean
  timer: ReturnType<typeof setInterval> | null
  busy: boolean
  bootedAt: string
  lastTickAt: string | null
  nextTickAt: string | null
  lastResult: {
    symbol: string
    status: string
    direction: string | null
    confidence: number | null
    runId: string
    at: string
  } | null
  lastError: string | null
  runCount: number
}

const g = globalThis as unknown as { __t2wAutoDesk?: AutoState }

function state(): AutoState {
  g.__t2wAutoDesk ??= {
    enabled: process.env.SIGNALS_AUTO_ENABLED !== '0',
    timer: null,
    busy: false,
    bootedAt: new Date().toISOString(),
    lastTickAt: null,
    nextTickAt: null,
    lastResult: null,
    lastError: null,
    runCount: 0,
  }
  return g.__t2wAutoDesk
}

export interface TickOutcome {
  ran: boolean
  skipped?: string
  symbol?: string
  runId?: string
  status?: string
  direction?: string | null
  confidence?: number | null
}

/** Run one scheduled analysis for the stalest watchlist symbol. */
export async function autoTick(force = false): Promise<TickOutcome> {
  const s = state()
  if (s.busy) return { ran: false, skipped: 'busy' }
  if (!s.enabled && !force) return { ran: false, skipped: 'disabled' }

  s.busy = true
  try {
    await ensureTables()

    // don't collide with a manual run that's still in flight (rows older than
    // 10 min are zombies — the [id] route's stale-heal marks them failed)
    const inflight = await db.signalRun.findFirst({
      where: { status: 'running', createdAt: { gt: new Date(Date.now() - 10 * 60_000) } },
      select: { id: true, symbol: true },
    })
    if (inflight && !force) return { ran: false, skipped: 'run-in-progress', symbol: inflight.symbol }

    // round-robin by staleness: the symbol with the oldest last run (or none) goes first
    const list = symbols()
    const last = await db.signalRun.groupBy({
      by: ['symbol'],
      where: { symbol: { in: list } },
      _max: { createdAt: true },
    })
    const lastAt = new Map(last.map((r) => [r.symbol, r._max.createdAt?.getTime() ?? 0]))
    const symbol = list.sort((a, b) => (lastAt.get(a) ?? 0) - (lastAt.get(b) ?? 0))[0]
    const market = AUTO_DEFAULT_SYMBOLS.includes(symbol) ? 'crypto' : 'stock'

    const run = await db.signalRun.create({
      data: { symbol, market, status: 'running', stage: 'queued', progress: 2, source: 'auto' },
    })
    await runSignalPipeline(run.id, symbol, market)
    const done = await db.signalRun.findUnique({
      where: { id: run.id },
      select: { id: true, status: true, direction: true, confidence: true },
    })

    s.lastTickAt = new Date().toISOString()
    s.runCount++
    s.lastError = done?.status === 'failed' ? 'last run failed — see run detail' : null
    s.lastResult = {
      symbol,
      status: done?.status ?? 'failed',
      direction: done?.direction ?? null,
      confidence: done?.confidence ?? null,
      runId: run.id,
      at: s.lastTickAt,
    }
    return {
      ran: true,
      symbol,
      runId: run.id,
      status: s.lastResult.status,
      direction: s.lastResult.direction,
      confidence: s.lastResult.confidence,
    }
  } catch (e) {
    s.lastError = String(e).slice(0, 200)
    return { ran: false, skipped: 'error' }
  } finally {
    s.busy = false
    if (s.enabled && s.timer) {
      s.nextTickAt = new Date(Date.now() + intervalMs()).toISOString()
    }
  }
}

/** Start the interval loop (no-op on Vercel — use the tick endpoint there). */
export function startAutoDesk(): void {
  const s = state()
  if (s.timer || process.env.VERCEL) return
  const iv = intervalMs()
  // first automatic pass 45s after boot so a fresh dev server settles first
  setTimeout(() => {
    void autoTick().catch(() => {})
  }, 45_000)
  s.timer = setInterval(() => {
    void autoTick().catch(() => {})
  }, iv)
  s.nextTickAt = new Date(Date.now() + iv).toISOString()
}

export function setAutoEnabled(v: boolean): void {
  const s = state()
  s.enabled = v
  if (!v && s.timer) {
    clearInterval(s.timer)
    s.timer = null
    s.nextTickAt = null
  } else if (v && !s.timer && !process.env.VERCEL) {
    s.timer = setInterval(() => {
      void autoTick().catch(() => {})
    }, intervalMs())
    s.nextTickAt = new Date(Date.now() + intervalMs()).toISOString()
  }
}

export function autoDeskStatus() {
  const s = state()
  return {
    enabled: s.enabled,
    running: s.busy,
    intervalMs: intervalMs(),
    symbols: symbols(),
    bootedAt: s.bootedAt,
    lastTickAt: s.lastTickAt,
    nextTickAt: s.nextTickAt,
    lastResult: s.lastResult,
    lastError: s.lastError,
    runCount: s.runCount,
    external: !!process.env.VERCEL, // true → interval loop off, tick via cron
  }
}
