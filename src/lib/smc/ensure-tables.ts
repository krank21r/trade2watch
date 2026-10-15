/**
 * SMC tables bootstrap — self-healing schema for ephemeral SQLite databases.
 *
 * Why: the production deployment runs SQLite on an ephemeral filesystem, so on
 * a fresh instance the DB file exists but may predate the SMC tables entirely
 * (prisma db push never ran there). Every persistence attempt then fails
 * silently (the orchestrator swallows persistence errors so the analysis
 * payload survives) — signals would fire but never be journaled.
 *
 * This module runs the exact DDL `prisma db push` would generate, guarded by
 * IF NOT EXISTS — idempotent, effectively free after the first call per
 * process (memoized). Local databases created by db:push are untouched.
 */

import { db } from '@/lib/db'

const DDL: string[] = [
  `CREATE TABLE IF NOT EXISTS "SmcSignal" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "symbol" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "setup" TEXT NOT NULL DEFAULT 'SMC_ORDER_BLOCK',
    "quality" TEXT NOT NULL,
    "score" INTEGER NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'STRICT',
    "entryLow" REAL NOT NULL,
    "entryHigh" REAL NOT NULL,
    "entryMid" REAL NOT NULL,
    "stopLoss" REAL NOT NULL,
    "tp1" REAL NOT NULL,
    "tp2" REAL NOT NULL,
    "tp3" REAL NOT NULL,
    "rr1" REAL NOT NULL,
    "rr2" REAL NOT NULL,
    "rr3" REAL NOT NULL,
    "obTime" REAL NOT NULL,
    "obLow" REAL NOT NULL,
    "obHigh" REAL NOT NULL,
    "reasons" JSONB,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "result" TEXT,
    "rMultiple" REAL,
    "tp1At" REAL,
    "tp2At" REAL,
    "tp3At" REAL,
    "slAt" REAL,
    "closedAt" REAL,
    "createdAt" REAL NOT NULL,
    "updatedAt" REAL NOT NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "SmcSignal_symbol_obTime_direction_key" ON "SmcSignal"("symbol", "obTime", "direction")`,
  `CREATE INDEX IF NOT EXISTS "SmcSignal_symbol_status_idx" ON "SmcSignal"("symbol", "status")`,
  `CREATE INDEX IF NOT EXISTS "SmcSignal_symbol_createdAt_idx" ON "SmcSignal"("symbol", "createdAt")`,
  `CREATE TABLE IF NOT EXISTS "SmcWatchLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "symbol" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "obTime" REAL NOT NULL,
    "obLow" REAL NOT NULL,
    "obHigh" REAL NOT NULL,
    "score" INTEGER NOT NULL,
    "quality" TEXT NOT NULL,
    "note" TEXT NOT NULL,
    "entryLow" REAL,
    "entryHigh" REAL,
    "entryMid" REAL,
    "stopLoss" REAL,
    "tp1" REAL,
    "tp2" REAL,
    "tp3" REAL,
    "firstSeen" REAL NOT NULL,
    "lastSeen" REAL NOT NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "SmcWatchLog_symbol_obTime_direction_mode_key" ON "SmcWatchLog"("symbol", "obTime", "direction", "mode")`,
  `CREATE INDEX IF NOT EXISTS "SmcWatchLog_lastSeen_idx" ON "SmcWatchLog"("lastSeen")`,
  `CREATE INDEX IF NOT EXISTS "SmcWatchLog_symbol_lastSeen_idx" ON "SmcWatchLog"("symbol", "lastSeen")`,
  // per-user personal trade journal (server-synced "I took this trade" plans)
  `CREATE TABLE IF NOT EXISTS "UserTradeStore" (
    "userId" TEXT NOT NULL PRIMARY KEY,
    "trades" TEXT NOT NULL,
    "updatedAt" REAL NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS "UserTradeStore_updatedAt_idx" ON "UserTradeStore"("updatedAt")`,
]

let done: Promise<void> | null = null

async function run(): Promise<void> {
  for (const sql of DDL) {
    await db.$executeRawUnsafe(sql)
  }
}

/** Idempotent — resolves once per process; rethrows nothing on repeat calls. */
export function ensureSmcTables(): Promise<void> {
  if (!done) {
    done = run().catch((err) => {
      done = null // allow retry on the next request
      throw err
    })
  }
  return done
}
