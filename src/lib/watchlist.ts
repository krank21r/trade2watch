// Shared watchlist used by BOTH the Trade Setups board and the Trade Confirmed
// board (per-user key, scoped by signed-in user). The shipped default used to
// be crypto-only (BTC,ETH,SOL) — it now includes the core stock names so entry
// confirmations are checked across crypto AND stocks out of the box.
//
// Sync model (mirrors the trade journal): localStorage gives the instant
// paint, /api/prefs is the cross-device truth. Every save is mirrored to the
// server (fire-and-forget); on mount, consumers adopt the server list when one
// exists, so the same account sees the same symbols on laptop and mobile.
//
// Migration: browsers that still hold the old crypto-only default (i.e. the
// user never customized the list) are transparently upgraded to the new
// default. Any customized list is respected as-is.

import { scopedGet, scopedSet } from '@/lib/user-scope'

export const DEFAULT_WATCHLIST = ['BTC', 'ETH', 'SOL', 'AAPL', 'TSLA', 'NVDA']

const OLD_DEFAULT = ['BTC', 'ETH', 'SOL']
const KEY = 'watchlist'
const MAX = 8
const SYM_RE = /^[A-Z0-9.\-]{1,10}$/

function sanitize(raw: string): string[] {
  return raw
    .split(',')
    .map((x) => x.trim())
    .filter((x) => SYM_RE.test(x))
    .slice(0, MAX)
}

export function loadWatchlist(): string[] {
  try {
    const arr = sanitize(scopedGet(KEY) ?? '')
    if (!arr.length) return [...DEFAULT_WATCHLIST]
    const isOldDefault =
      arr.length === OLD_DEFAULT.length && OLD_DEFAULT.every((s, i) => arr[i] === s)
    return isOldDefault ? [...DEFAULT_WATCHLIST] : arr
  } catch {
    return [...DEFAULT_WATCHLIST]
  }
}

/** Mirror the list to the account's synced prefs (fire-and-forget). */
function syncToServer(symbols: string[]): void {
  void fetch('/api/prefs', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ watchlist: sanitize(symbols.join(',')) }),
  }).catch(() => {
    /* offline — the next save re-syncs */
  })
}

export function saveWatchlist(symbols: string[]): void {
  const clean = sanitize(symbols.join(','))
  scopedSet(KEY, clean.join(','))
  syncToServer(clean)
}

/** Local cache write only — no server PUT. Used for mount-time migrations so a
 *  stale local list can never clobber the account's synced list in flight. */
export function saveWatchlistLocal(symbols: string[]): void {
  scopedSet(KEY, sanitize(symbols.join(',')).join(','))
}

/**
 * Server truth for the watchlist — call once on mount after the local paint.
 * Returns the synced list (and refreshes the local cache) when the account has
 * one; when the account has none, this browser's list is pushed up once so the
 * first device seeds the profile. Returns null when the API is unreachable.
 */
export async function fetchServerWatchlist(): Promise<string[] | null> {
  try {
    const res = await fetch('/api/prefs', { cache: 'no-store' })
    if (!res.ok) return null
    const body = (await res.json()) as {
      ok: boolean
      exists: boolean
      prefs?: { watchlist?: unknown }
    }
    if (body.ok && body.exists) {
      const raw = body.prefs?.watchlist
      if (!Array.isArray(raw)) return null
      const list = raw
        .filter((s): s is string => typeof s === 'string')
        .map((s) => s.trim().toUpperCase())
        .filter((s) => SYM_RE.test(s))
        .slice(0, MAX)
      if (!list.length) return null
      scopedSet(KEY, list.join(','))
      return list
    }
    if (body.ok && !body.exists) {
      // account never saved prefs — seed it with this browser's list
      const local = loadWatchlist()
      syncToServer(local)
      return local
    }
    return null
  } catch {
    return null
  }
}
