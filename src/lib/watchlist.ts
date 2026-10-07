// Shared watchlist used by BOTH the Trade Setups board and the Trade Confirmed
// board (localStorage key 'tw_watchlist'). The shipped default used to be
// crypto-only (BTC,ETH,SOL) — it now includes the core stock names so entry
// confirmations are checked across crypto AND stocks out of the box.
//
// Migration: browsers that still hold the old crypto-only default (i.e. the
// user never customized the list) are transparently upgraded to the new
// default. Any customized list is respected as-is.

export const DEFAULT_WATCHLIST = ['BTC', 'ETH', 'SOL', 'AAPL', 'TSLA', 'NVDA']

const OLD_DEFAULT = ['BTC', 'ETH', 'SOL']
const KEY = 'tw_watchlist'
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
    const arr = sanitize(localStorage.getItem(KEY) ?? '')
    if (!arr.length) return [...DEFAULT_WATCHLIST]
    const isOldDefault =
      arr.length === OLD_DEFAULT.length && OLD_DEFAULT.every((s, i) => arr[i] === s)
    return isOldDefault ? [...DEFAULT_WATCHLIST] : arr
  } catch {
    return [...DEFAULT_WATCHLIST]
  }
}

export function saveWatchlist(symbols: string[]): void {
  try {
    localStorage.setItem(KEY, sanitize(symbols.join(',')).join(','))
  } catch {
    /* private mode */
  }
}
