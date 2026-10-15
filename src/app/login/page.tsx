'use client'

import { FormEvent, Suspense, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { motion } from 'framer-motion'
import { LogIn, TrendingUp } from 'lucide-react'

function LoginForm() {
  const router = useRouter()
  const params = useSearchParams()
  const next = params.get('next') || '/'
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setErr(null)
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      })
      const body = (await res.json()) as { ok: boolean; error?: string }
      if (!res.ok || !body.ok) {
        setErr(body.error ?? `login failed (${res.status})`)
        setBusy(false)
        return
      }
      try {
        localStorage.setItem('t2w_last_user', username.trim().toLowerCase())
      } catch { /* private mode */ }
      router.replace(next)
      router.refresh()
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'network error')
      setBusy(false)
    }
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, ease: 'easeOut' }}
      className="w-full max-w-sm rounded-2xl border border-tv-line bg-tv-panel p-6 sm:p-7"
      style={{ boxShadow: 'var(--hairline-shadow)' }}
    >
      <div className="mb-6 flex items-center gap-2.5">
        <span className="btn inline-flex h-9 w-9 items-center justify-center rounded-xl bg-bull text-white shadow-sm hover:bg-bull-deep active:bg-bull-ink">
          <TrendingUp className="h-4.5 w-4.5" aria-hidden />
        </span>
        <div className="text-lg font-extrabold tracking-tight leading-none">
          Trade<b className="text-bull">2watch</b>
        </div>
      </div>

      <h1 className="text-xl font-extrabold tracking-tight text-tv-ink">Sign in</h1>
      <p className="mt-1 text-[13px] leading-relaxed text-tv-muted">
        Your watchlist, position sizing and trade journal are kept private to your account.
      </p>

      <form onSubmit={submit} className="mt-5 flex flex-col gap-3.5">
        <label className="flex flex-col gap-1.5">
          <span className="cell-label">Username</span>
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            required
            suppressHydrationWarning
            className="min-h-[44px] rounded-[0.625rem] border border-tv-line bg-tv-panel2/60 px-3.5 text-[14px] font-medium text-tv-ink outline-none transition-all duration-150 ease-[cubic-bezier(.4,0,.2,1)] placeholder:text-tv-muted2 focus:border-bull-line focus:bg-tv-panel"
            placeholder="e.g. kranthi"
          />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="cell-label">Password</span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
            suppressHydrationWarning
            className="min-h-[44px] rounded-[0.625rem] border border-tv-line bg-tv-panel2/60 px-3.5 text-[14px] font-medium text-tv-ink outline-none transition-all duration-150 ease-[cubic-bezier(.4,0,.2,1)] placeholder:text-tv-muted2 focus:border-bull-line focus:bg-tv-panel"
            placeholder="••••••••••"
          />
        </label>

        {err && (
          <div role="alert" className="rounded-[0.625rem] border border-bear-line bg-bear-soft px-3.5 py-2.5 text-[12.5px] font-medium text-bear">
            {err}
          </div>
        )}

        <button
          type="submit"
          disabled={busy || !username || !password}
          suppressHydrationWarning
          className="btn min-h-[44px] w-full bg-bull text-[14px] text-white shadow-sm hover:bg-bull-deep active:bg-bull-ink disabled:cursor-not-allowed disabled:opacity-50"
        >
          <LogIn className="h-4 w-4" aria-hidden />
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>

      <p className="mt-5 border-t border-tv-line pt-4 text-[11px] leading-relaxed text-tv-muted2">
        Access is limited to the three accounts provisioned by the owner. Analysis only — not financial advice.
      </p>
    </motion.div>
  )
}

export default function LoginPage() {
  return (
    <div className="relative flex min-h-[100dvh] flex-col items-center justify-center bg-tv-bg px-4 py-10 text-tv-ink">
      <div aria-hidden className="t2w-grid-bg pointer-events-none absolute inset-0" />
      <Suspense fallback={null}>
        <LoginForm />
      </Suspense>
      <p className="relative z-10 mt-6 text-[11px] text-tv-muted2">Trade2watch — research tool · not financial advice</p>
    </div>
  )
}
