/**
 * Per-user client-side state scoping.
 *
 * The login flow drops a readable `t2w_uid` cookie; every personal
 * localStorage entry (watchlist, account size, risk %, my-trades, confirm
 * log) is keyed as `t2w:<uid>:<base>` so each of the three users gets a
 * private copy on a shared browser. Legacy unscoped `tw_*` keys are
 * migrated once into the owner's namespace? No — into whoever signs in
 * first on that browser (they were shared before accounts existed).
 */

export function currentUid(): string {
  if (typeof document === 'undefined') return 'guest'
  const m = document.cookie.match(/(?:^|;\s*)t2w_uid=([^;]+)/)
  return m ? decodeURIComponent(m[1]) : 'guest'
}

export function currentName(): string {
  if (typeof document === 'undefined') return ''
  const m = document.cookie.match(/(?:^|;\s*)t2w_name=([^;]+)/)
  return m ? decodeURIComponent(decodeURIComponent(m[1])) : ''
}

/** scoped storage key for a personal state bucket */
export function scopeKey(base: string): string {
  return `t2w:${currentUid()}:${base}`
}

/** one-time migration: legacy shared `tw_<base>` key → scoped key.
 *  Pre-account state belongs to whoever signs in first on that browser. */
function migrateLegacy(base: string): string | null {
  try {
    const legacy = localStorage.getItem(`tw_${base}`)
    if (legacy !== null) {
      localStorage.setItem(scopeKey(base), legacy)
      localStorage.removeItem(`tw_${base}`)
      return legacy
    }
  } catch { /* private mode */ }
  return null
}

export function scopedGet(base: string): string | null {
  try {
    const v = localStorage.getItem(scopeKey(base))
    if (v !== null) return v
    return migrateLegacy(base)
  } catch {
    return null
  }
}

export function scopedSet(base: string, value: string): void {
  try {
    localStorage.setItem(scopeKey(base), value)
  } catch { /* private mode */ }
}

/** scoped JSON helpers */
export function scopedGetJson<T>(base: string, fallback: T): T {
  const raw = scopedGet(base)
  if (raw === null) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

export function scopedSetJson<T>(base: string, value: T): void {
  scopedSet(base, JSON.stringify(value))
}
