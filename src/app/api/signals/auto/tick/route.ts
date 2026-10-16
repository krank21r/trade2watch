import { NextResponse } from 'next/server'
import { autoTick } from '@/lib/signals/scheduler'

export const dynamic = 'force-dynamic'
// External cron (GitHub Actions / cron-job.org) may hold this open for the
// full pipeline — give it room on Vercel.
export const maxDuration = 300

// POST /api/signals/auto/tick — run one scheduled analysis NOW.
// Auth: normal session (middleware) OR `Authorization: Bearer $CRON_SECRET`
// (bypassed in middleware) so an external scheduler can drive it in production.
export async function POST() {
  const t = await autoTick(true)
  return NextResponse.json(t)
}
