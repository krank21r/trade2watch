/**
 * SMC alerts (§35/§36) — Telegram + generic webhook, fully env-gated.
 *
 * Delivery rules:
 *   - OFF unless SMC_ALERTS_ENABLED=1 AND at least one destination is set
 *     (TELEGRAM_BOT_TOKEN+TELEGRAM_CHAT_ID, or SMC_WEBHOOK_URL).
 *   - READ-ONLY credentials: alerting only ever SENDS messages — it has no
 *     trading capability and no exchange access of any kind (§58).
 *   - IDEMPOTENT per (signalId, event): a duplicated analysis pass or a
 *     repeated lifecycle scan can never double-send the same alert.
 *   - Fire-and-forget: a failing destination is logged and dropped; alerting
 *     must never break or slow the analysis path beyond a bounded timeout.
 */

const TELEGRAM_API = 'https://api.telegram.org'

export type SmcAlertEvent =
  | 'SIGNAL_CREATED' // LONG/SHORT setup logged
  | 'TP1_HIT'
  | 'TP2_HIT'
  | 'TP3_HIT'
  | 'SL_HIT'
  | 'EXPIRED'

export interface SmcAlertPayload {
  signalId: string
  symbol: string
  event: SmcAlertEvent
  direction: 'LONG' | 'SHORT'
  quality?: string
  score?: number
  entryLow?: number
  entryHigh?: number
  entryMid?: number
  stopLoss?: number
  tp1?: number
  tp2?: number
  tp3?: number
  rMultiple?: number | null
  note?: string
}

// ─── configuration (env only — nothing hard-coded) ──────────────────────────

function telegramCfg(): { token: string; chatId: string } | null {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim()
  const chatId = process.env.TELEGRAM_CHAT_ID?.trim()
  return token && chatId ? { token, chatId } : null
}

function webhookCfg(): string | null {
  const url = process.env.SMC_WEBHOOK_URL?.trim()
  return url && /^https?:\/\//.test(url) ? url : null
}

export function smcAlertsEnabled(): boolean {
  if (process.env.SMC_ALERTS_ENABLED?.trim() !== '1') return false
  return telegramCfg() !== null || webhookCfg() !== null
}

// ─── idempotency (signalId + event can only ever send once) ─────────────────

const sent = new Map<string, number>() // key → sent-at ms
const SENT_TTL = 14 * 86_400_000 // keep two weeks of memory, then GC

function alreadySent(key: string): boolean {
  const at = sent.get(key)
  if (at !== undefined && Date.now() - at < SENT_TTL) return true
  return false
}

function markSent(key: string): void {
  sent.set(key, Date.now())
  if (sent.size > 5_000) {
    const cutoff = Date.now() - SENT_TTL
    for (const [k, at] of sent) if (at < cutoff) sent.delete(k)
  }
}

// ─── formatting ──────────────────────────────────────────────────────────────

const money = (n?: number) => (typeof n === 'number' && Number.isFinite(n) ? n.toLocaleString('en-US', { maximumFractionDigits: 2 }) : '—')

const EVENT_LABEL: Record<SmcAlertEvent, string> = {
  SIGNAL_CREATED: '📡 new signal',
  TP1_HIT: '🎯 TP1 hit',
  TP2_HIT: '🎯🎯 TP2 hit',
  TP3_HIT: '🏆 TP3 hit',
  SL_HIT: '🛑 stop hit',
  EXPIRED: '⏱ signal expired',
}

function telegramText(p: SmcAlertPayload): string {
  const lines: string[] = []
  lines.push(`<b>${EVENT_LABEL[p.event]}</b> · ${p.symbol} ${p.direction}`)
  if (p.event === 'SIGNAL_CREATED') {
    lines.push(`quality <b>${p.quality ?? '—'}</b> · setup quality score ${p.score ?? 0}/100 (not a win probability)`)
    lines.push(`entry ${money(p.entryLow)}–${money(p.entryHigh)} · stop ${money(p.stopLoss)}`)
    lines.push(`TP1 ${money(p.tp1)} · TP2 ${money(p.tp2)} · TP3 ${money(p.tp3)}`)
  } else if (p.rMultiple !== undefined && p.rMultiple !== null) {
    lines.push(`result so far: <b>${p.rMultiple > 0 ? '+' : ''}${p.rMultiple}R</b>`)
  }
  if (p.note) lines.push(p.note)
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

async function deliverTelegram(p: SmcAlertPayload, cfg: { token: string; chatId: string }): Promise<void> {
  await postJson(`${TELEGRAM_API}/bot${cfg.token}/sendMessage`, {
    chat_id: cfg.chatId,
    text: telegramText(p),
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  })
}

async function deliverWebhook(p: SmcAlertPayload, url: string): Promise<void> {
  await postJson(url, { type: 'smc_alert', sentAt: Date.now(), ...p })
}

/**
 * Send one alert. Returns the destinations that accepted it. Never throws —
 * callers may `void` this freely inside analysis/lifecycle paths.
 */
export async function sendSmcAlert(p: SmcAlertPayload): Promise<{ telegram: boolean; webhook: boolean }> {
  const out = { telegram: false, webhook: false }
  if (!smcAlertsEnabled()) return out

  const key = `${p.signalId}:${p.event}`
  if (alreadySent(key)) return out
  markSent(key)

  const tg = telegramCfg()
  const hook = webhookCfg()
  const jobs: Array<Promise<void>> = []
  if (tg)
    jobs.push(
      deliverTelegram(p, tg)
        .then(() => {
          out.telegram = true
        })
        .catch((e) => console.error('[smc-alert] telegram failed:', String(e))),
    )
  if (hook)
    jobs.push(
      deliverWebhook(p, hook)
        .then(() => {
          out.webhook = true
        })
        .catch((e) => console.error('[smc-alert] webhook failed:', String(e))),
    )
  await Promise.allSettled(jobs)
  return out
}
