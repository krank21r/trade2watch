/**
 * GET  /api/prefs — the signed-in user's synced preferences document
 *      (currently { watchlist: string[] }), identical on every device.
 * PUT  /api/prefs — merge-update the document (last writer wins across
 *      devices, same semantics as the trade journal).
 *
 * Exists:false lets the first device to go live push its browser-local list
 * up (one-time migration, mirrors the journal's behavior).
 */

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { SESSION_COOKIE, verifyToken } from '@/lib/auth'
import { ensureUserPrefTable } from '@/lib/ensure-tables'

export const dynamic = 'force-dynamic'

const MAX = 8
const SYM_RE = /^[A-Z0-9.\-]{1,10}$/

async function userId(req: NextRequest): Promise<string | null> {
  const session = await verifyToken(req.cookies.get(SESSION_COOKIE)?.value)
  return session?.id ?? null
}

function sanitizeList(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null
  const list = raw
    .filter((s): s is string => typeof s === 'string')
    .map((s) => s.trim().toUpperCase())
    .filter((s) => SYM_RE.test(s))
    .slice(0, MAX)
  return list
}

export async function GET(req: NextRequest) {
  const uid = await userId(req)
  if (!uid) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })

  try {
    await ensureUserPrefTable()
    const row = await db.userPrefStore.findUnique({ where: { userId: uid } })
    if (!row) {
      return NextResponse.json({ ok: true, exists: false, prefs: {} }, { headers: { 'Cache-Control': 'no-store' } })
    }
    const prefs = JSON.parse(row.data ?? '{}') as Record<string, unknown>
    return NextResponse.json({ ok: true, exists: true, prefs }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (err) {
    console.error('[prefs] load error:', err)
    return NextResponse.json({ ok: false, error: 'storage unavailable' }, { status: 500 })
  }
}

export async function PUT(req: NextRequest) {
  const uid = await userId(req)
  if (!uid) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })

  let patch: Record<string, unknown>
  try {
    const body = (await req.json()) as Record<string, unknown>
    patch = body && typeof body === 'object' ? body : {}
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid body' }, { status: 400 })
  }

  // build the patch — only known keys pass validation
  const doc: Record<string, unknown> = {}
  if ('watchlist' in patch) {
    const list = sanitizeList(patch.watchlist)
    if (list === null) return NextResponse.json({ ok: false, error: 'invalid watchlist' }, { status: 400 })
    doc.watchlist = list
  }
  if (Object.keys(doc).length === 0) {
    return NextResponse.json({ ok: false, error: 'nothing to update' }, { status: 400 })
  }

  try {
    await ensureUserPrefTable()
    const existing = await db.userPrefStore.findUnique({ where: { userId: uid } })
    const merged = existing
      ? { ...(JSON.parse(existing.data ?? '{}') as Record<string, unknown>), ...doc }
      : doc
    await db.userPrefStore.upsert({
      where: { userId: uid },
      create: { userId: uid, data: JSON.stringify(doc), updatedAt: Date.now() },
      update: { data: JSON.stringify(merged), updatedAt: Date.now() },
    })
    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('[prefs] save error:', err)
    return NextResponse.json({ ok: false, error: 'storage unavailable' }, { status: 500 })
  }
}
