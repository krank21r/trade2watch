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

import ZAI, { type ZAIConfig } from 'z-ai-web-dev-sdk'

type ChatMessage = { role: 'assistant' | 'user'; content: string }

const globalForLLM = globalThis as unknown as {
  __t2wZai: Awaited<ReturnType<typeof ZAI.create>> | undefined
  __t2wLlmChain: Promise<void> | undefined
  __t2wLlmLastStart: number
}

/**
 * Build the SDK config from environment variables.
 *
 * The SDK's ONLY built-in config discovery is a `.z-ai-config` file in cwd,
 * the home directory or /etc — and `ZAI.create()` accepts no arguments. That
 * works in the local sandbox but NOT on a self-hosted/Vercel deployment,
 * which is why every agent reported "Configuration file not found" in
 * production. When ZAI_BASE_URL + ZAI_API_KEY are set we construct the
 * client directly from them; otherwise we fall back to file discovery.
 *
 *   ZAI_BASE_URL  e.g. https://api.z.ai/api/paas/v4  (required with API key)
 *   ZAI_API_KEY   the provider API key               (required with base URL)
 *   ZAI_MODEL     optional model name, e.g. glm-4.6  (required by most public APIs)
 *   ZAI_TOKEN / ZAI_CHAT_ID / ZAI_USER_ID  optional extra gateway headers
 */
function zaiConfigFromEnv(): ZAIConfig | null {
  const baseUrl = process.env.ZAI_BASE_URL?.trim()
  const apiKey = process.env.ZAI_API_KEY?.trim()
  if (!baseUrl || !apiKey) return null
  const cfg: ZAIConfig = { baseUrl, apiKey }
  const token = process.env.ZAI_TOKEN?.trim()
  const chatId = process.env.ZAI_CHAT_ID?.trim()
  const userId = process.env.ZAI_USER_ID?.trim()
  if (token) cfg.token = token
  if (chatId) cfg.chatId = chatId
  if (userId) cfg.userId = userId
  return cfg
}

async function client() {
  if (!globalForLLM.__t2wZai) {
    const envCfg = zaiConfigFromEnv()
    try {
      globalForLLM.__t2wZai = envCfg
        ? // the constructor is typed private but is public at runtime — this
          // cast is the SDK's only programmatic-config injection path
          new (ZAI as unknown as new (cfg: ZAIConfig) => ZAI)(envCfg)
        : await ZAI.create()
    } catch (e) {
      throw new Error(
        `LLM provider is not configured. On a self-hosted/Vercel deployment set ZAI_BASE_URL (e.g. https://api.z.ai/api/paas/v4), ZAI_API_KEY and ZAI_MODEL (e.g. glm-4.6) in the environment, then redeploy. (${String(e).slice(0, 140)})`,
      )
    }
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
    const model = process.env.ZAI_MODEL?.trim()
    const completion = await zai.chat.completions.create({
      ...(model ? { model } : {}),
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
