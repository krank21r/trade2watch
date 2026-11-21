/**
 * One-off migration: local SQLite (db/custom.db) → hosted Postgres (Neon).
 *
 * Reads every row from the three tables and writes them into the Postgres
 * database pointed to by DATABASE_URL. Idempotent — existing rows
 * (same primary key) are skipped.
 *
 * Usage: DATABASE_URL=... bun scripts/migrate-to-pg.ts
 */
import { Database } from 'bun:sqlite'
import { PrismaClient } from '@prisma/client'

const DATETIME_COLS = new Set(['createdAt', 'completedAt', 'outcomeCheckedAt'])
const INT_COLS = new Set(['progress', 'confidence'])
const FLOAT_COLS = new Set([
  'priceAtRun',
  'change24h',
  'entryLow',
  'entryHigh',
  'stop',
  'target1',
  'target2',
  'runner',
  'outcomePrice',
  'updatedAt',
])

function toDateTime(v: unknown): Date | null {
  if (v === null || v === undefined || v === '') return null
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v
  if (typeof v === 'number') return new Date(v)
  const s = String(v)
  // Prisma's SQLite connector stores DateTime as epoch milliseconds —
  // sometimes surfaced as a numeric string. 10 digits = seconds.
  if (/^\d{10}$/.test(s)) return new Date(Number(s) * 1000)
  if (/^\d{11,14}$/.test(s)) return new Date(Number(s))
  // Prisma writes ISO-8601 ("2025-01-01T12:34:56.789Z"); SQLite
  // CURRENT_TIMESTAMP writes "2025-01-01 12:34:56" in UTC.
  if (s.includes('T')) {
    const d = new Date(s)
    return isNaN(d.getTime()) ? null : d
  }
  const d = new Date(s.replace(' ', 'T') + 'Z')
  return isNaN(d.getTime()) ? null : d
}

function convert(col: string, v: unknown): unknown {
  if (DATETIME_COLS.has(col)) return toDateTime(v)
  if (v === null || v === undefined) return null
  if (INT_COLS.has(col)) return Math.round(Number(v))
  if (FLOAT_COLS.has(col)) return Number(v)
  return String(v)
}

async function migrateTable(
  pg: PrismaClient,
  table: string,
  insertMany: (rows: Record<string, unknown>[]) => Promise<number>,
) {
  const sqlite = new Database(process.env.SQLITE_PATH ?? 'db/custom.db', { readonly: true })
  const cols = (sqlite.query(`PRAGMA table_info("${table}")`).all() as { name: string }[]).map(
    (c) => c.name,
  )
  const rows = sqlite.query(`SELECT * FROM "${table}"`).all() as Record<string, unknown>[]
  sqlite.close()

  const payloads = rows.map((r) => {
    const p: Record<string, unknown> = {}
    for (const c of cols) p[c] = convert(c, r[c])
    return p
  })

  let written = 0
  for (let i = 0; i < payloads.length; i += 20) {
    written += await insertMany(payloads.slice(i, i + 20))
  }
  console.log(`${table}: ${rows.length} rows read, ${written} rows inserted`)
}

async function main() {
  const pg = new PrismaClient()
  try {
    await migrateTable(pg, 'UserPrefStore', (rows) =>
      pg.userPrefStore.createMany({ data: rows as never, skipDuplicates: true }).then((r) => r.count),
    )
    await migrateTable(pg, 'UserTradeStore', (rows) =>
      pg.userTradeStore.createMany({ data: rows as never, skipDuplicates: true }).then((r) => r.count),
    )
    await migrateTable(pg, 'SignalRun', (rows) =>
      pg.signalRun.createMany({ data: rows as never, skipDuplicates: true }).then((r) => r.count),
    )
    console.log('migration complete')
  } finally {
    await pg.$disconnect()
  }
}

main().catch((e) => {
  console.error('migration failed:', e)
  process.exit(1)
})
