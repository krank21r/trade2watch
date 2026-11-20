'use client'

/**
 * useSignalNotifier — app-wide AI-signal watcher.
 *
 * The AI Signals dashboard only toasts while it is mounted (that tab open).
 * This hook is mounted once at the app root (page.tsx) so a finished desk
 * analysis reaches the user on ANY tab:
 *   - in-app toast for new completed directional signals (LONG/SHORT)
 *   - desktop notification when the user turned Alerts on (same preference
 *     the dashboard's bell toggle writes — scoped key 'desktop-alerts')
 *   - 🔔 unread badge count for the header bell, persisted as a last-seen
 *     marker so it survives reloads; opening AI Signals (or clicking the
 *     bell) clears it
 *   - "price is IN the entry zone" desktop alert on every tab, driven by the
 *     server-side outcome prices already returned by the history endpoint
 *
 * Suppression: while the AI Signals tab is open the dashboard itself toasts
 * richer detail — the watcher stays quiet there (the badge still stays
 * honest). NEUTRAL desk results are deliberately silent here: they only
 * matter when you are looking at the signal list, and a standing "no edge"
 * would otherwise spam the app every desk tick.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { SignalRunRow } from '@/components/signals/types'
import { fmtPrice } from '@/components/signals/types'
import { scopedGetJson, scopedSetJson } from '@/lib/user-scope'
import { useToast } from '@/hooks/use-toast'

const POLL_MS = 60_000
const LAST_SEEN_KEY = 'signals-last-seen' // ISO ts — completed signals older than this count as read
const TITLE_BASE = 'Trade2watch — Multi-Asset Trade Setup'

const directional = (r: SignalRunRow) => r.direction === 'LONG' || r.direction === 'SHORT'

function inZone(r: SignalRunRow): boolean {
  const px = r.outcomePrice
  if (typeof px !== 'number' || !Number.isFinite(px)) return false
  if (r.entryLow === null || r.entryHigh === null) return false
  return px >= r.entryLow && px <= r.entryHigh
}

function desktopEnabled(): boolean {
  return (
    scopedGetJson<boolean>('desktop-alerts', false) &&
    typeof Notification !== 'undefined' &&
    Notification.permission === 'granted'
  )
}

function fireDesktop(title: string, body: string): void {
  if (!desktopEnabled()) return
  try {
    const n = new Notification(title, { body, tag: `t2w:${title}`, icon: '/favicon.ico' })
    n.onclick = () => {
      window.focus()
      n.close()
    }
  } catch {
    /* notifications unsupported here — the in-page toast still covers it */
  }
}

export function useSignalNotifier(onSignalsTab: boolean) {
  const { toast } = useToast()
  const [unread, setUnread] = useState(0)
  const tabRef = useRef(onSignalsTab)
  tabRef.current = onSignalsTab
  const seenRef = useRef<Set<string> | null>(null)
  const zoneSeenRef = useRef<Set<string> | null>(null)
  const mountedAt = useRef(Date.now())

  /** Persist "everything up to now is read" and clear the badge. */
  const markSeen = useCallback(() => {
    scopedSetJson(LAST_SEEN_KEY, new Date().toISOString())
    setUnread(0)
  }, [])

  useEffect(() => {
    let stop = false

    const tick = async () => {
      let runs: SignalRunRow[] | null = null
      try {
        const res = await fetch('/api/signals?limit=15', { cache: 'no-store' })
        const d = await res.json().catch(() => null)
        if (d && Array.isArray(d.runs)) runs = d.runs as SignalRunRow[]
      } catch {
        /* transient — retry on the next tick */
      }
      if (!runs || stop) return

      // First paint: seed silently. The badge counts completed directional
      // signals newer than the persisted last-seen marker (a first-ever
      // visit seeds it to now — history is never announced retroactively).
      if (seenRef.current === null) {
        seenRef.current = new Set(runs.map((r) => r.id))
        zoneSeenRef.current = new Set(runs.filter(inZone).map((r) => r.id))
        if (scopedGetJson<string | null>(LAST_SEEN_KEY, null) === null) {
          markSeen()
        } else {
          const cut = new Date(scopedGetJson<string>(LAST_SEEN_KEY, new Date().toISOString())).getTime()
          setUnread(
            runs.filter(
              (r) => r.status === 'completed' && directional(r) && new Date(r.createdAt).getTime() > cut,
            ).length,
          )
        }
        return
      }

      const seen = seenRef.current
      const fresh: SignalRunRow[] = []
      for (const r of runs) {
        if (seen.has(r.id)) continue
        seen.add(r.id)
        if (new Date(r.createdAt).getTime() < mountedAt.current) continue // pre-mount history — badge rules, not toasts
        fresh.push(r)
      }

      // entry-zone activations — the money alert, valuable on every tab
      const zone = zoneSeenRef.current ?? new Set<string>()
      for (const r of runs) {
        if (r.status !== 'completed' || !directional(r) || !inZone(r)) continue
        if (zone.has(r.id)) continue
        zone.add(r.id)
        fireDesktop(
          `🚀 ${r.symbol} is IN the entry zone`,
          `${r.direction} · entry ${fmtPrice(r.entryLow)} – ${fmtPrice(r.entryHigh)} · stop ${fmtPrice(r.stop)} — check the plan now.`,
        )
      }
      zoneSeenRef.current = zone

      for (const r of fresh) {
        if (r.status !== 'completed') continue // failed runs only matter on the signals tab
        if (!directional(r)) {
          if (tabRef.current) markSeen() // NEUTRAL completed while the user watches the list — keep the badge honest
          continue
        }
        if (tabRef.current) {
          markSeen() // the dashboard is toasting richer detail right there
          continue
        }
        setUnread((u) => u + 1)
        const conf = r.confidence ?? '—'
        toast({
          title: `🤖 New signal — ${r.symbol} ${r.direction}`,
          description: `${r.direction} @ ${fmtPrice(r.priceAtRun)} · confidence ${conf}% · entry ${fmtPrice(r.entryLow)} – ${fmtPrice(r.entryHigh)} — full plan in AI Signals.`,
        })
        fireDesktop(
          `🎯 ${r.symbol} ${r.direction} signal ready`,
          `Entry ${fmtPrice(r.entryLow)} – ${fmtPrice(r.entryHigh)} · stop ${fmtPrice(r.stop)} · T1 ${fmtPrice(r.target1)} · conf ${conf}%`,
        )
      }
    }

    void tick()
    const iv = setInterval(() => void tick(), POLL_MS)
    return () => {
      stop = true
      clearInterval(iv)
    }
  }, [markSeen, toast])

  // unread count leaks into the tab title so a background tab asks for attention
  useEffect(() => {
    document.title = unread > 0 ? `(${unread}) ${TITLE_BASE}` : TITLE_BASE
    return () => {
      document.title = TITLE_BASE
    }
  }, [unread])

  return { unread, markSeen }
}
