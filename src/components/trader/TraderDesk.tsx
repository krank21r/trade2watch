'use client'

/**
 * Trader Desk — simplified at the user's request:
 *
 *   screener signals (entry zone · stop · T1 · T2)
 *     → "I took this trade" freezes the plan into the shared trade journal
 *       (src/lib/mytrades.ts)
 *     → the tracker follows every open trade against real candles and updates
 *       the status automatically:
 *         TP1 hit → half banked, stop moves to entry
 *         TP2 hit → trade closed, full win
 *         stop hit before TP1 → stopped out (-1R)
 *
 * The old budget sizing, risk gate, tickets, portfolio, rebalance and alerts
 * pipeline was removed — this desk is signals → take → track. Trades taken
 * here live in the same per-user journal as the Trade Setups tab's, so every
 * signed-in device sees identical status.
 */

import { useEffect, useRef, useState } from 'react'
import { useToast } from '@/hooks/use-toast'
import {
  fetchMyTrades,
  loadMyTrades,
  saveMyTrades,
  trackTrade,
  rNow,
  netR,
  netRTxt,
  outcomeTxt,
  type MyTrade,
} from '@/lib/mytrades'
import type { Candle } from '@/lib/market/indicators'
import { ScreenerPanel } from './ScreenerPanel'
import { usd } from './types'

const POLL_MS = 45_000

const fmtWhen = (t: number) => {
  const d = new Date(t)
  const now = new Date()
  const sameDay =
    d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate()
  return sameDay
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

export function TraderDesk() {
  const { toast } = useToast()
  const toastRef = useRef(toast)
  toastRef.current = toast

  const [myTrades, setMyTrades] = useState<MyTrade[]>([])
  const myTradesRef = useRef<MyTrade[]>([])
  const [livePrices, setLivePrices] = useState<Record<string, number>>({})
  const mounted = useRef(true)

  const deskTrades = myTrades.filter((t) => t.tag === 'DESK')
  const openTrades = deskTrades.filter((t) => t.status === 'OPEN')
  const closedTrades = deskTrades.filter((t) => t.status === 'CLOSED')
  const trackedSymbolsKey = Array.from(new Set(openTrades.map((t) => `${t.symbol}|${t.market}`))).join(',')

  const applyTrades = (list: MyTrade[]) => {
    myTradesRef.current = list
    setMyTrades(list)
  }

  // ── journal boot: local cache paints instantly, server syncs the truth ────
  useEffect(() => {
    mounted.current = true
    setMyTrades(loadMyTrades())
    void fetchMyTrades().then((server) => {
      if (mounted.current) applyTrades(server)
    })
    return () => {
      mounted.current = false
    }
  }, [])

  const refreshTrades = async () => {
    try {
      const server = await fetchMyTrades()
      if (mounted.current) applyTrades(server)
    } catch {
      /* offline — local cache keeps serving */
    }
  }

  // any take/close elsewhere (ScreenerPanel, Setups tab) refreshes the view
  useEffect(() => {
    const h = () => void refreshTrades()
    window.addEventListener('t2w:trades-changed', h)
    return () => window.removeEventListener('t2w:trades-changed', h)
  }, [])

  // ── live TP/SL tracking — real candles for every open desk trade, 45s ─────
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
      if (cancelled || !mounted.current) return
      const candleMap = new Map<string, Candle[]>()
      for (const r of results) if (r) candleMap.set(r[0], r[1])
      const prices: Record<string, number> = {}
      for (const [sym, candles] of candleMap) if (candles.length) prices[sym] = candles[candles.length - 1].close
      setLivePrices((prev) => ({ ...prev, ...prices }))

      const events: Array<{ pair: string; kind: 'tp1' | 'tp2' | 'sl' | 'be'; t: MyTrade }> = []
      let changed = false
      const next = myTradesRef.current.map((t) => {
        if (t.status !== 'OPEN' || t.tag !== 'DESK') return t
        const candles = candleMap.get(t.symbol)
        if (!candles || candles.length === 0) return t
        const after = trackTrade(t, candles)
        if (after !== t) {
          changed = true
          if (after.tp1HitAt !== null && t.tp1HitAt === null && after.status === 'OPEN')
            events.push({ pair: t.pair, kind: 'tp1', t: after })
          if (after.status === 'CLOSED' && t.status === 'OPEN')
            events.push({ pair: t.pair, kind: after.outcome === 'TP2' ? 'tp2' : after.outcome === 'TP1_BE' ? 'be' : 'sl', t: after })
        }
        return after
      })
      if (changed) {
        applyTrades(next)
        saveMyTrades(next)
        window.dispatchEvent(new Event('t2w:trades-changed'))
      }
      for (const e of events) {
        if (e.kind === 'tp1')
          toastRef.current({
            title: `🎯 ${e.pair} hit TP1`,
            description: `Half banked at ${usd(e.t.t1)} — stop moved to entry ${usd(e.t.entryFill)}; running for TP2.`,
          })
        else if (e.kind === 'tp2')
          toastRef.current({
            title: `🏆 ${e.pair} hit TP2 — full win`,
            description: `Closed at ${usd(e.t.t2)} · ${netRTxt(e.t)}.`,
          })
        else if (e.kind === 'be')
          toastRef.current({
            title: `⚖️ ${e.pair} — TP1 banked, stopped at entry`,
            description: `Breakeven close · ${netRTxt(e.t)}.`,
          })
        else
          toastRef.current({
            title: `🛑 ${e.pair} stopped out`,
            description: `Closed at the stop ${usd(e.t.stop)} · ${netRTxt(e.t)}.`,
          })
      }
    }
    void run()
    const iv = setInterval(run, POLL_MS)
    return () => {
      cancelled = true
      clearInterval(iv)
    }
  }, [trackedSymbolsKey])

  // ── actions ────────────────────────────────────────────────────────────────
  const closeTrade = (id: string) => {
    const tr = myTradesRef.current.find((x) => x.id === id)
    if (!tr || tr.status !== 'OPEN') return
    const live = livePrices[tr.symbol] ?? tr.entryFill
    const closed: MyTrade = { ...tr, status: 'CLOSED', outcome: 'MANUAL', closedAt: Date.now(), closePrice: live }
    const next = myTradesRef.current.map((x) => (x.id === id ? closed : x))
    applyTrades(next)
    saveMyTrades(next)
    window.dispatchEvent(new Event('t2w:trades-changed'))
    toastRef.current({
      title: `✋ ${tr.pair} closed manually`,
      description: `Exit ${usd(live)} · ${netRTxt(closed)} — kept in history.`,
    })
  }

  const deleteTrade = (id: string) => {
    const next = myTradesRef.current.filter((x) => x.id !== id)
    applyTrades(next)
    saveMyTrades(next)
    window.dispatchEvent(new Event('t2w:trades-changed'))
  }

  return (
    <div className="flex flex-col gap-4">
      {/* header */}
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-lg font-extrabold tracking-tight text-tv-ink">Trader Desk</h1>
          <p className="text-[11.5px] text-tv-muted">
            Screener signals with entry, stop and targets → take the trade → the tracker updates the status for you.
          </p>
        </div>
        {openTrades.length > 0 && (
          <span className="rounded-full border border-warn/40 bg-warn/10 px-2.5 py-1 text-[11px] font-bold text-warn">
            ● {openTrades.length} open
          </span>
        )}
      </div>

      {/* ── taken trades — live status tracking ─────────────────────────────── */}
      <section aria-label="Your taken trades" className="rounded-2xl border border-tv-line bg-tv-panel p-4">
        <h2 className="text-[13px] font-extrabold text-tv-ink">Your taken trades</h2>
        <p className="mb-3 text-[11px] text-tv-muted">
          Plan frozen at take time · tracked against real 4h candles every 45s · TP1 banks half & moves the stop to entry.
        </p>

        {openTrades.length === 0 && closedTrades.length === 0 ? (
          <p className="rounded-xl border border-dashed border-tv-line bg-tv-panel2/40 px-3 py-4 text-center text-[11.5px] text-tv-muted">
            Nothing tracked yet — take a signal from the screener below.
          </p>
        ) : (
          <div className="grid gap-2.5 sm:grid-cols-2">
            {openTrades.map((t) => (
              <DeskOpenCard key={t.id} t={t} livePrice={livePrices[t.symbol] ?? null} onClose={() => closeTrade(t.id)} />
            ))}
          </div>
        )}

        {closedTrades.length > 0 && (
          <div className="mt-3">
            <h3 className="mb-1.5 text-[10.5px] font-bold uppercase tracking-wider text-tv-muted2">History</h3>
            <ul className="flex flex-col gap-1">
              {closedTrades.map((t) => (
                <li
                  key={t.id}
                  className="flex flex-wrap items-center gap-x-2 gap-y-0.5 rounded-lg border border-tv-line/60 bg-tv-panel2/40 px-2.5 py-1.5 text-[11.5px]"
                >
                  <span className="font-bold text-tv-ink">{t.pair}</span>
                  <span
                    className={`rounded-full border px-1.5 py-0.5 text-[9.5px] font-bold ${
                      t.outcome === 'TP2' || t.outcome === 'TP1_BE'
                        ? 'border-bull/40 bg-bull/10 text-bull'
                        : t.outcome === 'SL'
                          ? 'border-bear/40 bg-bear/10 text-bear'
                          : 'border-tv-line bg-tv-panel2 text-tv-muted'
                    }`}
                  >
                    {outcomeTxt(t)}
                  </span>
                  <span className={`font-bold tabular-nums ${netR(t) >= 0 ? 'text-bull' : 'text-bear'}`}>{netRTxt(t)}</span>
                  <span className="text-tv-muted2">
                    fill {usd(t.entryFill)} → exit {usd(t.closePrice ?? t.entryFill)} · closed {t.closedAt ? fmtWhen(t.closedAt) : '—'}
                  </span>
                  <button
                    suppressHydrationWarning
                    onClick={() => deleteTrade(t.id)}
                    aria-label={`Delete ${t.pair} from history`}
                    className="ml-auto rounded-md border border-tv-line px-1.5 py-0.5 text-[10px] text-tv-muted2 hover:border-bear/40 hover:text-bear"
                  >
                    ✕
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

      {/* ── signals — crypto screener ───────────────────────────────────────── */}
      <section aria-label="Signals" className="rounded-2xl border border-tv-line bg-tv-panel p-4">
        <h2 className="mb-1 text-[13px] font-extrabold text-tv-ink">Signals — crypto screener</h2>
        <p className="mb-3 text-[11px] leading-snug text-tv-muted">
          ~32 Binance assets against explicit rules (every pass/fail explained); passers arrive as signals with an entry
          zone, stop loss and two targets. A screen is a filter, not a recommendation.
        </p>
        <ScreenerPanel onTaken={() => void refreshTrades()} />
      </section>
    </div>
  )
}

// ─── open trade card — frozen plan + live status ─────────────────────────────

function DeskOpenCard({
  t,
  livePrice,
  onClose,
}: {
  t: MyTrade
  livePrice: number | null
  onClose: () => void
}) {
  const r = livePrice !== null ? rNow(t, livePrice) : null
  const afterTp1 = t.tp1HitAt !== null
  return (
    <article className="rounded-xl border p-3" style={{ borderColor: 'var(--warn-line)', background: 'var(--warn-soft)' }}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <h3 className="text-[13.5px] font-bold tracking-tight text-tv-ink">{t.pair}</h3>
          <span className="rounded-full border border-bull/40 bg-bull/10 px-1.5 py-0.5 text-[9.5px] font-bold uppercase text-bull">
            long
          </span>
          {afterTp1 ? (
            <span className="rounded-full border border-bull/40 bg-bull/10 px-1.5 py-0.5 text-[9.5px] font-bold text-bull">
              🎯 TP1 · running
            </span>
          ) : (
            <span className="rounded-full border border-warn/40 bg-warn/10 px-1.5 py-0.5 text-[9.5px] font-bold text-warn">
              OPEN
            </span>
          )}
          <span className="text-[10.5px] text-tv-muted">taken {fmtWhen(t.takenAt)}</span>
        </div>
        <div className="text-right">
          {livePrice !== null && (
            <div className="text-[14px] font-bold tabular-nums tracking-tight text-tv-ink">{usd(livePrice)}</div>
          )}
          {r !== null && (
            <span className={`text-[10.5px] font-bold tabular-nums ${r >= 0 ? 'text-bull' : 'text-bear'}`}>
              {r > 0 ? '+' : ''}
              {r.toFixed(2)}R now
            </span>
          )}
        </div>
      </div>

      <div className="mt-2 flex flex-wrap gap-1.5 text-[10.5px] tabular-nums">
        <Level label="Entry" value={usd(t.entryFill)} cls="text-warn" />
        <Level
          label={afterTp1 ? 'Stop→entry' : 'Stop'}
          value={usd(afterTp1 ? t.entryFill : t.stop)}
          cls={t.slHitAt !== null ? 'text-bear line-through' : 'text-bear'}
        />
        <Level label="T1" value={usd(t.t1)} cls={afterTp1 ? 'text-bull' : 'text-info'} />
        <Level label="T2" value={usd(t.t2)} cls="text-info" />
      </div>

      <div className="mt-2 flex items-center justify-between border-t border-tv-div pt-2">
        <span className="text-[10.5px] text-tv-muted2">{t.rr ? `R:R ${t.rr.split('·')[0].trim()}` : ''}</span>
        <button
          suppressHydrationWarning
          onClick={onClose}
          aria-label={`Close ${t.pair} trade manually`}
          className="rounded-lg border border-tv-line bg-tv-panel2 px-2.5 py-1 text-[11px] font-bold text-tv-ink transition hover:border-warn/50"
        >
          ✋ Close trade
        </button>
      </div>
    </article>
  )
}

function Level({ label, value, cls }: { label: string; value: string; cls: string }) {
  return (
    <span className="rounded-lg border border-tv-line bg-tv-panel2/70 px-2 py-1">
      <span className="mr-1 text-[9px] font-bold uppercase tracking-wider text-tv-muted2">{label}</span>
      <span className={`font-bold ${cls}`}>{value}</span>
    </span>
  )
}
