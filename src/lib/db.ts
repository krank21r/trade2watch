import { PrismaClient } from '@prisma/client'

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
  __t2wTablesReady?: Promise<void> | undefined
}

export const db =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === 'production' ? [] : ['query'],
  })

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = db

// ─── Serverless bootstrap (Vercel) ──────────────────────────────────────────
// On Vercel the SQLite file lives in the ephemeral /tmp filesystem, so every
// cold start begins with an empty database (no tables). When DATABASE_URL
// points into /tmp, lazily create the schema once per instance so the
// signals API works without a manual migration step. Local dev (file:./db/…)
// is untouched — the bootstrap only activates for /tmp paths.
const DDL = [
  `CREATE TABLE IF NOT EXISTS "SignalRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "symbol" TEXT NOT NULL,
    "market" TEXT NOT NULL,
    "displayName" TEXT,
    "status" TEXT NOT NULL DEFAULT 'running',
    "stage" TEXT NOT NULL DEFAULT 'queued',
    "progress" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "priceAtRun" REAL,
    "change24h" REAL,
    "regime" TEXT,
    "timeframe" TEXT,
    "direction" TEXT,
    "confidence" INTEGER,
    "entryLow" REAL,
    "entryHigh" REAL,
    "stop" REAL,
    "target1" REAL,
    "target2" REAL,
    "runner" REAL,
    "riskReward" TEXT,
    "invalidation" TEXT,
    "planNote" TEXT,
    "artifacts" TEXT,
    "outcome" TEXT,
    "outcomeCheckedAt" DATETIME,
    "outcomePrice" REAL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" DATETIME
  )`,
  `CREATE INDEX IF NOT EXISTS "SignalRun_symbol_createdAt_idx" ON "SignalRun"("symbol", "createdAt")`,
  `CREATE INDEX IF NOT EXISTS "SignalRun_status_idx" ON "SignalRun"("status")`,
  `CREATE INDEX IF NOT EXISTS "SignalRun_createdAt_idx" ON "SignalRun"("createdAt")`,
]

export function ensureTables(): Promise<void> {
  const url = process.env.DATABASE_URL ?? ''
  if (!url.startsWith('file:/tmp')) return Promise.resolve()
  globalForPrisma.__t2wTablesReady ??= (async () => {
    for (const stmt of DDL) {
      try {
        await db.$executeRawUnsafe(stmt)
      } catch {
        // concurrent cold start may have created it first — safe to ignore
      }
    }
  })()
  return globalForPrisma.__t2wTablesReady
}
