/** Tiny in-memory cache — local memory only, no external middleware. */

const store = new Map<string, { at: number; data: unknown }>()

export async function cached<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
  const hit = store.get(key)
  if (hit && Date.now() - hit.at < ttlMs) return hit.data as T
  const data = await load()
  store.set(key, { at: Date.now(), data })
  return data
}
