import { NextResponse } from 'next/server'
import { CURATED_FILERS } from '@/lib/copycat/filers'

export const dynamic = 'force-dynamic'

/** GET /api/copycat/filers — the curated list of well-known 13F filers. */
export async function GET() {
  return NextResponse.json({ ok: true, filers: CURATED_FILERS })
}
