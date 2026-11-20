'use client'

/**
 * useTradeJournal — shared personal trade tracker hook.
 *
 * Encapsulates the journal mechanics the Trade Setups board already had
 * (local-cache paint → server truth → live frozen-plan tracking) so the
 * Entry Decisions tab can track desk-TAKE trades without duplicating logic:
 *
 *   - journal state (MyTrade[]) synced through /api/trades (account-scoped)
 *   - `trackDecision` — freeze an Entry Decision's plan into the journal
 *     (dedup: one OPEN trade per `SYMBOL:side` key, same namespace the
 *     Trade Setups "I took this trade" button uses)
 *   - `closeTrade` — manual close at the live price (MANUAL outcome)
 *   - a 45s candle loop that advances every OPEN trade's TP/SL state
 *     (TP1 → bank half + stop to entry; TP2/SL → close) and fires toasts
 *
 * Only one tab is mounted at a time in the shell, so this hook and the
 * Trade Setups board never write concurrently; each remount re-syncs from
 * the server, which is the source of truth.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  fetchMyTrades,
  loadMyTrades,
  saveMyTrades,
  trackTrade,
  zoneMid,
  netRTxt,
  type MyTrade,
} from '@/lib/mytrades'
import type { Candle } from '@/lib/market/indicators'
import type { EntryDecision } from '@/lib/entry/decide'
import { useToast } from '@/hooks/use-toast'
import { fmtPrice } from '@/components/signals/types'

const POLL_MS = 45_000

export function useTradeJournal() {
  const [myTrades, setMyTrades] = useState<MyTrade[]>([])
  const myTradesRef = useRef<MyTrade[]>([])
  const mounted = useRef(true)
  const { toast } = useToast()

  const commit = useCallback((next: MyTrade[]) => {
    myTradesRef.current = next
    if (mounted.current) setMyTrades(next)
    saveMyTrades(next)
    window.dispatchEvent(new Event('t2w:trades-changed'))
  }, [])

  useEffect(() => {
    mounted.current = true
    // instant paint from the local cache, then the server truth (journal is
    // account-synced — the same open trades show on every device)
    const local = loadMyTrades()
    myTradesRef.current = local
    // eslint-disable-next-line react-hooks/set-state-in-effect -- browser-only persisted state; reading it during render would hydrate-mismatch
    setMyTrades(local)
    void fetchMyTrades().then((server) => {
      if (!mounted.current) return
      myTradesRef.current = server
      setMyTrades(server)
    })
    return () => {
      mounted.current = false
    }
  }, [])

  /** Freeze a desk-TAKE decision's plan into the journal (no-op if already tracked). */
  const trackDecision = useCallback(
    (d: EntryDecision) => {
      if (!d.plan) return
      const side = d.plan.side === 'LONG' ? ('long' as const) : ('short' as const)
      const key = `${d.symbol}:${side}`
      if (myTradesRef.current.some((t) => t.key === key && t.status === 'OPEN')) return
      const now = Date.now()
      const t: MyTrade = {
        id: `${key}:${now}`,
        key,
        symbol: d.symbol,
        market: d.market,
        displayName: d.displayName,
        pair: d.pair,
        currency: d.currency,
        side,
        tag: 'DESK TAKE',
        strategy: `Entry decision — ${d.consensus.toLowerCase()} confirmed by the desk (score ${d.score})`,
        entryLow: d.plan.entryLow,
        entryHigh: d.plan.entryHigh,
        entryFill: zoneMid(d.plan.entryLow, d.plan.entryHigh),
        stop: d.plan.stop,
        t1: d.plan.t1,
        t2: d.plan.t2,
        runner: null,
        rr: `1 : ${d.plan.rr.toFixed(1)} at T1`,
        confirmedAt: now,
        confirmedPrice: d.price,
        via: 'decision',
        takenAt: now,
        status: 'OPEN',
        tp1HitAt: null,
        tp2HitAt: null,
        slHitAt: null,
        outcome: null,
        closedAt: null,
        closePrice: null,
      }
      commit([t, ...myTradesRef.current])
      toast({
        title: `🎯 Trade tracked — ${t.pair} ${side.toUpperCase()}`,
        description: `Desk TAKE frozen · fill assumed ${fmtPrice(t.entryFill, t.currency)} · TP1 ${fmtPrice(t.t1, t.currency)} · TP2 ${fmtPrice(
          t.t2,
          t.currency,
        )} · SL ${fmtPrice(t.stop, t.currency)}`,
      })
    },
    [commit, toast],
  )

  /** Manual close at the live price (falls back to the assumed fill). */
  const closeTrade = useCallback(
    (id: string, livePrice: number | null) => {
      const tr = myTradesRef.current.find((x) => x.id === id)
      if (!tr || tr.status !== 'OPEN') return
      const now = Date.now()
      const closed: MyTrade = {
        ...tr,
        status: 'CLOSED',
        outcome: 'MANUAL',
        closedAt: now,
        closePrice: livePrice ?? tr.entryFill,
      }
      commit(myTradesRef.current.map((x) => (x.id === id ? closed : x)))
      toast({
        title: `✋ ${tr.pair} ${tr.side.toUpperCase()} closed manually`,
        description: `Logged to your history · ${netRTxt(closed)}`,
      })
    },
    [commit, toast],
  )

  // live TP/SL tracking — pull real candles for every open trade and advance
  // the frozen plan (TP1 → breakeven stop; TP2/SL → close). Fires toasts.
  const trackedSymbolsKey = Array.from(
    new Set(myTrades.filter((t) => t.status === 'OPEN').map((t) => `${t.symbol}|${t.market}`)),
  ).join(',')

  useEffect(() => {
    if (!trackedSymbolsKey) return
    let cancelled = false
    const run = async () => {
      const pairs = trackedSymbolsKey.split(',').map((s) => s.split('|') as [string, 'crypto' | 'stock'])
      const results = await Promise.all(
        pairs.map(async ([sym, mkt]) => {
          try {
            const res = await fetch(`/api/candles?symbol=${sym}&market=${mkt}`, { cache: 'no-store' })
            if (!res.ok) return null
            const d = (await res.json()) as { symbol: string; candles: Candle[] }
            return [d.symbol, d.candles] as const
          } catch {
            return null
          }
        }),
      )
      if (cancelled) return
      const candleMap = new Map<string, Candle[]>()
      for (const r of results) if (r) candleMap.set(r[0], r[1])
      let changed = false
      const events: Array<{ t: MyTrade; kind: 'tp1' | 'closed' }> = []
      const next = myTradesRef.current.map((t) => {
        if (t.status !== 'OPEN') return t
        const candles = candleMap.get(t.symbol)
        if (!candles || candles.length === 0) return t
        const after = trackTrade(t, candles)
        if (after !== t) {
          changed = true
          if (after.status === 'CLOSED') events.push({ t: after, kind: 'closed' })
          else if (t.tp1HitAt === null && after.tp1HitAt !== null) events.push({ t: after, kind: 'tp1' })
        }
        return after
      })
      if (!changed) return
      myTradesRef.current = next
      if (mounted.current) setMyTrades(next)
      saveMyTrades(next)
      window.dispatchEvent(new Event('t2w:trades-changed'))
      for (const e of events) {
        if (e.kind === 'tp1') {
          toast({
            title: `✅ ${e.t.pair} ${e.t.side.toUpperCase()} — TP1 hit`,
            description: `Half banked, stop moved to entry ${fmtPrice(e.t.entryFill, e.t.currency)} (per the plan) — tracking updated.`,
          })
        } else {
          const title =
            e.t.outcome === 'TP2'
              ? `🏆 ${e.t.pair} ${e.t.side.toUpperCase()} — TP2 hit, trade closed`
              : e.t.outcome === 'TP1_BE'
                ? `⚖️ ${e.t.pair} ${e.t.side.toUpperCase()} — stopped at entry after TP1`
                : `🛑 ${e.t.pair} ${e.t.side.toUpperCase()} — stopped out`
          toast({
            title,
            description: `${netRTxt(e.t)} — the trade moved to your history.`,
          })
        }
      }
    }
    run()
    const iv = setInterval(run, POLL_MS)
    return () => {
      cancelled = true
      clearInterval(iv)
    }
  }, [trackedSymbolsKey, toast])

  const openTrades = myTrades.filter((t) => t.status === 'OPEN')
  const openBySymbol = new Map(openTrades.map((t) => [t.symbol, t]))

  return { myTrades, openTrades, openBySymbol, trackDecision, closeTrade }
}
