/**
 * AI-signal push notifications — "know when to enter the trade".
 *
 * When the auto desk completes a directional analysis (LONG/SHORT with a real
 * plan), this module pushes the entry/stop/target levels to the user:
 *   - Telegram (TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID) — same bot as SMC alerts
 *   - generic JSON webhook (SIGNALS_WEBHOOK_URL)
 *
 * Delivery rules (mirrors src/lib/smc/alerts.ts):
 *   - OFF unless SIGNALS_ALERTS_ENABLED=1 AND at least one destination is set.
 *   - READ-ONLY credentials: alerting only ever SENDS messages — no trading
 *     capability and no exchange access of any kind.
 *   - DEDUPED per (symbol, market, direction) inside a time window: the desk
 *     re-analyzes the same symbols on a schedule and a standing plan must not
 *     spam the user on every tick. Two layers: an in-memory map (per process)
 *     plus a best-effort DB check (per-instance /tmp SQLite — helps when the
 *     same warm serverless instance runs consecutive ticks).
 *   - BOUNDED: 8s delivery timeout, failures logged and dropped. Callers AWAIT
 *     this inside the tick request — on Vercel serverless a background task is
 *     frozen the moment the response is sent, so delivery must be in-request.
 */

const TELEGRAM_API = 'https://api.telegram.org'

export interface SignalAlertPayload {
  runId: string
  symbol: string
  market: 'crypto' | 'stock'
  direction: 'LONG' | 'SHORT'
  confidence: number | null
  regime: string | null
  timeframe: string | null
  entryLow: number | null
  entryHigh: number | null
  stop: number | null
  target1: number | null
  target2: number | null
  runner: number | null
  riskReward: string | null
  planNote: string | null
  priceAtRun: number | null
  dashboardUrl: string
}

// ─── configuration (env only — nothing hard-coded) ──────────────────────────

function telegramCfg(): { token: string; chatId: string } | null {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim()
  const chatId = process.env.TELEGRAM_CHAT_ID?.trim()
  return token && chatId ? { token, chatId } : null
}

function webhookCfg(): string | null {
  const url = process.env.SIGNALS_WEBHOOK_URL?.trim()
  return url && /^https?:\/\//.test(url) ? url : null
}

export function signalsAlertsEnabled(): boolean {
  if (process.env.SIGNALS_ALERTS_ENABLED?.trim() !== '1') return false
  return telegramCfg() !== null || webhookCfg() !== null
}

function dedupeMs(): number {
  const h = Number(process.env.SIGNALS_ALERTS_DEDUPE_HOURS ?? 6)
  return Math.max(1, Math.min(72, Number.isFinite(h) ? h : 6)) * 3_600_000
}

// ─── dedupe ──────────────────────────────────────────────────────────────────

const sent = new Map<string, number>() // key → sent-at ms

function sweepSent(windowMs: number): void {
  if (sent.size < 200) return
  const cutoff = Date.now() - windowMs
  for (const [k, at] of sent) if (at < cutoff) sent.delete(k)
}

/** Best-effort cross-tick dedupe via the (per-instance) database. */
async function alertedInWindowDb(p: SignalAlertPayload, since: Date): Promise<boolean> {
  try {
    const { db } = await import('@/lib/db')
    const found = await db.signalRun.findFirst({
      where: {
        symbol: p.symbol,
        market: p.market,
        source: 'auto',
        direction: p.direction,
        status: 'completed',
        id: { not: p.runId },
        createdAt: { gte: since },
      },
      select: { id: true },
    })
    return !!found
  } catch {
    return false // no db on this instance — fall back to in-memory only
  }
}

// ─── formatting ──────────────────────────────────────────────────────────────

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

const money = (n?: number | null) =>
  typeof n === 'number' && Number.isFinite(n) ? n.toLocaleString('en-US', { maximumFractionDigits: n < 10 ? 4 : 2 }) : '—'

export function telegramText(p: SignalAlertPayload): string {
  const px = p.priceAtRun
  const inZone = typeof px === 'number' && p.entryLow !== null && p.entryHigh !== null && px >= p.entryLow && px <= p.entryHigh
  const lines: string[] = []
  lines.push(`🎯 <b>ENTRY SIGNAL — ${esc(p.symbol)} ${p.direction}</b> <i>(${p.market})</i>`)
  const meta = [`confidence <b>${p.confidence ?? '—'}%</b>`]
  if (p.regime) meta.push(esc(p.regime))
  if (p.timeframe) meta.push(esc(p.timeframe))
  lines.push(meta.join(' · '))
  lines.push(`entry <b>${money(p.entryLow)} – ${money(p.entryHigh)}</b> · stop ${money(p.stop)}`)
  const tps = [`T1 ${money(p.target1)}`, `T2 ${money(p.target2)}`]
  if (p.runner !== null && p.runner !== undefined) tps.push(`runner ${money(p.runner)}`)
  lines.push(`${tps.join(' · ')}${p.riskReward ? ` · R:R ${esc(p.riskReward)}` : ''}`)
  if (typeof px === 'number' && Number.isFinite(px)) {
    lines.push(
      inZone
        ? `price now ${money(px)} → ✅ <b>IN ENTRY ZONE — time to act</b>`
        : `price now ${money(px)} → ⏳ not in the zone yet — set your alert levels`,
    )
  }
  if (p.planNote) lines.push(`\n📝 ${esc(p.planNote.slice(0, 300))}`)
  lines.push(`\nOpen the dashboard: ${p.dashboardUrl}`)
  lines.push('<i>analysis only — no auto-trading. Not financial advice.</i>')
  return lines.join('\n')
}

// ─── delivery ────────────────────────────────────────────────────────────────

async function postJson(url: string, body: unknown, timeoutMs = 8_000): Promise<void> {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
      cache: 'no-store',
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
  } finally {
    clearTimeout(t)
  }
}

async function deliverTelegram(p: SignalAlertPayload, cfg: { token: string; chatId: string }): Promise<void> {
  await postJson(`${TELEGRAM_API}/bot${cfg.token}/sendMessage`, {
    chat_id: cfg.chatId,
    text: telegramText(p),
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  })
}

async function deliverWebhook(p: SignalAlertPayload, url: string): Promise<void> {
  await postJson(url, { type: 'signal_alert', sentAt: Date.now(), ...p })
}

/**
 * Send one entry alert for a completed directional auto run. Never throws —
 * returns which destinations accepted it (or why it was skipped).
 */
export async function sendSignalAlert(
  p: SignalAlertPayload,
): Promise<{ telegram: boolean; webhook: boolean; skipped?: string }> {
  const out = { telegram: false, webhook: false, skipped: undefined as string | undefined }
  if (!signalsAlertsEnabled()) {
    out.skipped = 'alerts-disabled'
    return out
  }

  const windowMs = dedupeMs()
  const key = `${p.symbol}:${p.market}:${p.direction}`
  const at = sent.get(key)
  if (at !== undefined && Date.now() - at < windowMs) {
    out.skipped = 'recent-alert'
    return out
  }
  if (await alertedInWindowDb(p, new Date(Date.now() - windowMs))) {
    sent.set(key, Date.now())
    out.skipped = 'recent-alert-db'
    return out
  }
  sent.set(key, Date.now())
  sweepSent(windowMs)

  const tg = telegramCfg()
  const hook = webhookCfg()
  const jobs: Array<Promise<void>> = []
  if (tg)
    jobs.push(
      deliverTelegram(p, tg)
        .then(() => {
          out.telegram = true
        })
        .catch((e) => console.error('[signals-alert] telegram failed:', String(e))),
    )
  if (hook)
    jobs.push(
      deliverWebhook(p, hook)
        .then(() => {
          out.webhook = true
        })
        .catch((e) => console.error('[signals-alert] webhook failed:', String(e))),
    )
  await Promise.allSettled(jobs)
  return out
}
