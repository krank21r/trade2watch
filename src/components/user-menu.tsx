'use client'

import { useState } from 'react'
import { LogOut } from 'lucide-react'

const readName = (): string => {
  if (typeof document === 'undefined') return ''
  const m = document.cookie.match(/(?:^|;\s*)t2w_name=([^;]+)/)
  return m ? decodeURIComponent(decodeURIComponent(m[1])) : ''
}

/**
 * Nav user chip — avatar initial + display name + sign-out.
 * Identity comes from the readable t2w_name cookie (set at login).
 */
export function UserMenu() {
  // lazy init — the cookie is set by the login response; server render shows
  // the placeholder and the client corrects it (suppressed below)
  const [name, setName] = useState(readName)
  const [busy, setBusy] = useState(false)

  const logout = async () => {
    setBusy(true)
    try {
      await fetch('/api/auth/logout', { method: 'POST' })
    } catch { /* cookie clear happens server-side anyway */ }
    window.location.href = '/login'
  }

  const initial = (name || '?').trim().charAt(0).toUpperCase()

  return (
    <div className="flex items-center gap-2">
      <span
        className="hidden sm:inline-flex items-center gap-2 rounded-full border border-tv-line bg-tv-panel2/70 py-1 pl-1 pr-3"
        title={`Signed in as ${name || 'user'}`}
      >
        <span
          className="flex h-6 w-6 items-center justify-center rounded-full bg-bull-soft text-[11px] font-extrabold text-bull-ink"
          aria-hidden="true"
        >
          {initial}
        </span>
        <span className="text-[12px] font-semibold text-tv-ink" suppressHydrationWarning>
          {name || 'user'}
        </span>
      </span>
      <button
        onClick={logout}
        disabled={busy}
        aria-label="Sign out"
        title="Sign out"
        className="btn min-h-[36px] min-w-[36px] rounded-xl border border-tv-line bg-tv-panel px-2.5 text-tv-muted hover:border-bear-line hover:bg-bear-soft hover:text-bear"
      >
        <LogOut className="h-4 w-4" aria-hidden />
        <span className="sr-only">{busy ? 'Signing out…' : 'Sign out'}</span>
      </button>
    </div>
  )
}
