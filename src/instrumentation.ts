/**
 * Next.js instrumentation — runs once per server process start.
 * Boots the auto-desk scheduler (nodejs runtime only): it periodically runs
 * the multi-agent signal pipeline for the stalest watchlist symbol so fresh
 * signals + entry alerts appear without the user clicking anything.
 * On Vercel the loop is skipped (serverless freezes background timers) —
 * production automation uses POST /api/signals/auto/tick from external cron.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return
  const { startAutoDesk } = await import('@/lib/signals/scheduler')
  startAutoDesk()
}
