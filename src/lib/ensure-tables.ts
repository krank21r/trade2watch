/**
 * Table bootstrap — self-healing schema for ephemeral SQLite databases.
 *
 * Why: the production deployment runs SQLite on an ephemeral filesystem, so on
 * a fresh instance the DB file exists but may predate tables added after the
 * initial `prisma db push`. Every write would then fail with "table does not
 * exist".
 *
 * This module runs the exact DDL `prisma db push` would generate, guarded by
 * IF NOT EXISTS — idempotent, effectively free after the first call per
 * process (memoized). Local databases created by db:push are untouched.
 */

import { db } from '@/lib/db'

const DDL: string[] = [
  // per-user personal trade journal (server-synced "I took this trade" plans)
  `CREATE TABLE IF NOT EXISTS "UserTradeStore" (
    "userId" TEXT NOT NULL PRIMARY KEY,
    "trades" TEXT NOT NULL,
    "updatedAt" REAL NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS "UserTradeStore_updatedAt_idx" ON "UserTradeStore"("updatedAt")`,
]

// per-user synced preferences (watchlist blob — cross-device profile)
const PREF_DDL: string[] = [
  `CREATE TABLE IF NOT EXISTS "UserPrefStore" (
    "userId" TEXT NOT NULL PRIMARY KEY,
    "data" TEXT NOT NULL,
    "updatedAt" REAL NOT NULL
  )`,
]

let done: Promise<void> | null = null
let prefDone: Promise<void> | null = null

async function run(): Promise<void> {
  for (const sql of DDL) {
    await db.$executeRawUnsafe(sql)
  }
}

/** Idempotent — resolves once per process; rethrows nothing on repeat calls. */
export function ensureUserTradeTable(): Promise<void> {
  if (!done) {
    done = run().catch((err) => {
      done = null // allow retry on the next request
      throw err
    })
  }
  return done
}

/** Same self-heal contract as the trade store, for the prefs blob table. */
export function ensureUserPrefTable(): Promise<void> {
  if (!prefDone) {
    prefDone = Promise.all(PREF_DDL.map((sql) => db.$executeRawUnsafe(sql)))
      .then(() => {})
      .catch((err) => {
        prefDone = null
        throw err
      })
  }
  return prefDone
}
