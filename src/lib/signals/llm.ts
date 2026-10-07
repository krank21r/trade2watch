/**
 * LLM wrapper for the signal engine — z-ai-web-dev-sdk (backend only).
 *
 * Two protective mechanisms:
 *  1. Global call queue with minimum spacing — the z-ai API throttles bursts,
 *     so parallel agent calls are spaced ~1.6s apart instead of fired at once.
 *  2. Rate-limit retry with escalating backoff (5s → 30s).
 *
 * JSON responses are extracted robustly: fenced-code stripping, brace
 * matching, and a self-correcting retry that feeds the parse error back.
 */

import ZAI from 'z-ai-web-dev-sdk'

type ChatMessage = { role: 'assistant' | 'user'; content: string }

const globalForLLM = globalThis as unknown as {
  __t2wZai: Awaited<ReturnType<typeof ZAI.create>> | undefined
  __t2wLlmChain: Promise<void> | undefined
  __t2wLlmLastStart: number
}

async function client() {
  if (!globalForLLM.__t2wZai) {
    globalForLLM.__t2wZai = await ZAI.create()
  }
  return globalForLLM.__t2wZai
}

const MIN_SPACING_MS = 1600

/** Enforce global minimum spacing between LLM call starts. */
async function acquireSlot(): Promise<void> {
  const g = globalForLLM
  const prev = g.__t2wLlmChain ?? Promise.resolve()
  let release: () => void = () => {}
  g.__t2wLlmChain = new Promise<void>((res) => {
    release = res
  })
  await prev.catch(() => {})
  const now = Date.now()
  const wait = g.__t2wLlmLastStart + MIN_SPACING_MS - now
  if (wait > 0) await new Promise((r) => setTimeout(r, wait))
  g.__t2wLlmLastStart = Date.now()
  release()
}

async function chatOnce(messages: ChatMessage[], timeoutMs: number): Promise<string> {
  const zai = await client()
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const completion = await zai.chat.completions.create({
      messages,
      thinking: { type: 'disabled' },
    })
    const content = completion.choices[0]?.message?.content ?? ''
    if (!content.trim()) throw new Error('Empty LLM response')
    return content
  } finally {
    clearTimeout(t)
  }
}

async function chat(messages: ChatMessage[], timeoutMs = 90_000): Promise<string> {
  let attempt = 0
  for (;;) {
    attempt++
    await acquireSlot()
    try {
      return await chatOnce(messages, timeoutMs)
    } catch (e) {
      const msg = String(e)
      const rateLimited = msg.includes('429') || msg.toLowerCase().includes('too many requests')
      const backoffs = [5_000, 10_000, 20_000, 30_000]
      if (rateLimited && attempt <= backoffs.length) {
        await new Promise((r) => setTimeout(r, backoffs[attempt - 1]))
        continue
      }
      throw e
    }
  }
}

/** Plain-text completion. */
export async function llmText(system: string, user: string): Promise<string> {
  return chat([
    { role: 'assistant', content: system },
    { role: 'user', content: user },
  ])
}

/**
 * JSON completion with robust extraction + self-correcting retry.
 * `schemaHint` is a short JSON example the model must match exactly.
 */
export async function llmJson<T>(system: string, user: string, schemaHint: string, maxRetries = 2): Promise<T> {
  const baseSystem = `${system}\n\nIMPORTANT: Respond with ONLY a single valid JSON object. No markdown fences, no commentary, no text before or after. Shape:\n${schemaHint}`

  let lastErr: unknown = null
  let attempt = 0
  while (attempt <= maxRetries) {
    const userMsg =
      attempt === 0
        ? user
        : `${user}\n\nYour previous reply could not be parsed as JSON (${String(lastErr).slice(0, 160)}). Return ONLY the JSON object matching the required shape.`
    const raw = await chat([
      { role: 'assistant', content: baseSystem },
      { role: 'user', content: userMsg },
    ])
    try {
      return extractJson<T>(raw)
    } catch (e) {
      lastErr = e
      attempt++
    }
  }
  throw new Error(`LLM JSON parse failed after ${maxRetries + 1} attempts: ${String(lastErr).slice(0, 200)}`)
}

/** Strip markdown fences, then parse the outermost JSON object. */
export function extractJson<T>(raw: string): T {
  let text = raw.trim()
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fence) text = fence[1].trim()
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) throw new Error('no JSON object found')
  return JSON.parse(text.slice(start, end + 1)) as T
}
