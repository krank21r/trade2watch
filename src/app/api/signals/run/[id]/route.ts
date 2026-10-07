import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'

export const dynamic = 'force-dynamic'

const STALE_MS = 6 * 60 * 1000 // a run stuck >6min is considered dead

// GET /api/signals/run/[id] — poll run status + full detail
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  try {
    let run = await db.signalRun.findUnique({ where: { id } })
    if (!run) return NextResponse.json({ error: 'Run not found.' }, { status: 404 })

    // self-heal: mark zombie runs (dev server restart mid-run etc.) as failed
    if (run.status === 'running' && Date.now() - run.createdAt.getTime() > STALE_MS) {
      run = await db.signalRun.update({
        where: { id },
        data: { status: 'failed', error: 'Run timed out (server restart or engine stall).', completedAt: new Date() },
      })
    }

    return NextResponse.json({ run })
  } catch (e) {
    console.error('[api/signals/run/id] error:', e)
    return NextResponse.json({ error: 'Failed to load run.' }, { status: 500 })
  }
}
