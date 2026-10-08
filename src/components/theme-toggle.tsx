'use client'

import { useSyncExternalStore } from 'react'
import { useTheme } from 'next-themes'
import { Moon, Sun } from 'lucide-react'

const noopSubscribe = () => () => {}

export function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme()
  // false during SSR/first render, true once hydrated — no setState-in-effect needed
  const mounted = useSyncExternalStore(
    noopSubscribe,
    () => true,
    () => false,
  )

  // Before mount, assume the default (light) — avoids hydration mismatch.
  const isDark = mounted ? resolvedTheme !== 'light' : false

  return (
    <button
      type="button"
      onClick={() => setTheme(isDark ? 'light' : 'dark')}
      aria-label={isDark ? 'Switch to light theme' : 'Switch to dark theme'}
      title={isDark ? 'Switch to light theme' : 'Switch to dark theme'}
      suppressHydrationWarning
      className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-tv-line bg-tv-panel2 text-tv-muted transition-colors hover:text-tv-ink hover:border-tv-line-strong"
    >
      {isDark ? <Sun className="h-4 w-4" aria-hidden /> : <Moon className="h-4 w-4" aria-hidden />}
    </button>
  )
}
