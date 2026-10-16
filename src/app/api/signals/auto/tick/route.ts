import { NextResponse } from 'next/server'
import { autoTick } from '@/lib/signals/scheduler'

export const dynamic = 'force-dynamic'
// External cron (Vercel Cron / cron-job.org / GitHub Actions) may hold this
// open for the full pipeline — give it room on Vercel.
export const maxDuration = 300

// /api/signals/auto/tick — run one scheduled analysis NOW.
// Auth: normal session (middleware) OR `Authorization: Bearer $CRON_SECRET`
// (bypassed in middleware) so a scheduler can drive it in production.
// Both methods are exposed: Vercel Cron always fires GET, cron-job.org and
// GitHub Actions workflows typically POST.
async function tick() {
  const t = await autoTick(true)
  return NextResponse.json(t)
}

export async function GET() {
  return tick()
}

export async function POST() {
  return tick()
}
