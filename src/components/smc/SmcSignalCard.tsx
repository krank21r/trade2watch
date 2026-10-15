'use client'

// ─── Compact SMC signal card — one pair, one glance ─────────────────────────
// The whole SMC board is a grid of these. Everything else (gates, score
// breakdown, building blocks, backtest, journal) was deliberately removed:
// the card shows ONLY the trade signal — direction badge, live price, the
// provisional plan (entry zone · stop · targets with R multiples) and a few
// verdict chips (score/quality, R:R, cross-tape confirmation).

import { useState } from 'react'
import { fmtPrice } from '@/components/signals/types'
import { Chip, qualityCls } from '@/components/smc/ui'
import type { SmcScanRow, SignalType } from '@/lib/smc/types'

export const SMC_LABEL: Record<string, string> = {
  BTCUSDT: 'BTC',
  ETHUSDT: 'ETH',
  SOLUSDT: 'SOL',
  BNBUSDT: 'BNB',
  XRPUSDT: 'XRP',
  DOGEUSDT: 'DOGE',
}

const BADGE: Record<SignalType, { icon: string; label: string; cls: string; hairline: string }> = {
  LONG: {
    icon: '▲',
    label: 'LONG',
    cls: 'border-bull/45 bg-bull/12 text-bull',
    hairline: 'linear-gradient(90deg, transparent, var(--bull), transparent)',
  },
  SHORT: {
    icon: '▼',
    label: 'SHORT',
    cls: 'border-bear/45 bg-bear/12 text-bear',
    hairline: 'linear-gradient(90deg, transparent, var(--bear), transparent)',
  },
  WATCHLIST: {
    icon: '⏳',
    label: 'WATCH',
    cls: 'border-warn/45 bg-warn/10 text-warn',
    hairline: 'linear-gradient(90deg, transparent, var(--warn), transparent)',
  },
  NO_TRADE: {
    icon: '⛔',
    label: 'NO TRADE',
    cls: 'border-tv-line bg-tv-panel2 text-tv-muted',
    hairline: '',
  },
}

/** one aligned plan row — label · value · R/% note (compact mini-table look) */
function Lvl({
  label,
  value,
  cls,
  note,
  accent,
}: {
  label: string
  value: string
  cls: string
  note?: string
  accent?: boolean
}) {
  return (
    <div
      role="listitem"
      className={`flex items-baseline justify-between gap-2 px-2.5 py-[5px] ${accent ? 'bg-warn/5' : ''}`}
    >
      <span className="w-12 shrink-0 text-[9.5px] font-bold uppercase tracking-[0.12em] text-tv-muted">
        {label}
      </span>
      <span className={`flex-1 truncate text-right text-[12px] font-bold tabular-nums chip-mono ${cls}`}>
        {value}
      </span>
      <span className="w-11 shrink-0 text-right text-[9.5px] font-bold tabular-nums text-tv-muted2">
        {note ?? ''}
      </span>
    </div>
  )
}

export function SmcSignalCard({ row, mounted }: { row: SmcScanRow; mounted: boolean }) {
  const [copied, setCopied] = useState(false)
  const label = SMC_LABEL[row.symbol] ?? row.symbol.replace('USDT', '')
  const badge = BADGE[row.signal]
  const live = row.signal === 'LONG' || row.signal === 'SHORT'
  const trade = row.trade
  const rr = row.rr

  // signal freshness — deterministic from payload stamps, guarded by mounted
  const age = (() => {
    if (!live || !row.confirmedAt) return null
    if (!mounted) return { txt: '—', stale: false }
    const mins = Math.floor(Math.max(0, row.generatedAt - row.confirmedAt) / 60_000)
    const txt =
      mins < 1 ? 'just now' : mins < 60 ? `${mins}m ago` : `${Math.floor(mins / 60)}h${mins % 60 ? ` ${mins % 60}m` : ''} ago`
    return { txt, stale: mins > 60 }
  })()

  const stopPct =
    trade && row.price > 0 ? `${(((trade.stop_loss - row.price) / row.price) * 100).toFixed(1)}%` : undefined

  const copyPlan = async () => {
    if (!trade) return
    const txt = `${label} ${row.signal} — Entry ${fmtPrice(trade.entry_low)}–${fmtPrice(trade.entry_high)} | Stop ${fmtPrice(
      trade.stop_loss,
    )} | TP1 ${fmtPrice(trade.tp1)} | TP2 ${fmtPrice(trade.tp2)} | TP3 ${fmtPrice(trade.tp3)}${
      rr ? ` | R:R 1:${rr.tp2.toFixed(1)}` : ''
    }`
    try {
      await navigator.clipboard.writeText(txt)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      /* clipboard unavailable — silent */
    }
  }

  const rootCls = !row.ok
    ? 'border-tv-line bg-tv-panel opacity-70'
    : live
      ? row.signal === 'LONG'
        ? 'border-bull/30 shadow-[0_0_18px_var(--bull-soft)]'
        : 'border-bear/30 shadow-[0_0_18px_var(--bear-soft)]'
      : row.signal === 'WATCHLIST'
        ? 'border-warn/40'
        : 'border-tv-line bg-tv-panel'

  return (
    <article aria-label={`${label} — ${badge.label.toLowerCase()} signal`} className={`relative flex h-full flex-col gap-2 overflow-hidden rounded-2xl border bg-tv-panel p-3.5 shadow-sm transition ${rootCls}`}>
      {badge.hairline && row.ok && (
        <span aria-hidden className="absolute inset-x-0 top-0 h-px" style={{ background: badge.hairline }} />
      )}

      {/* header — pair + signal badge + copy */}
      <div className="flex items-center gap-1.5">
        <h3 className="text-[15px] font-extrabold tracking-tight text-tv-ink">{label}</h3>
        <span className="text-[9.5px] font-bold uppercase tracking-wider text-tv-muted2">USDT</span>
        <span
          className={`ml-auto inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2.5 py-0.5 text-[10.5px] font-extrabold tracking-wide ${row.ok ? badge.cls : 'border-tv-line bg-tv-panel2 text-tv-muted'}`}
        >
          {row.ok ? (
            <>
              <span aria-hidden="true">{badge.icon}</span>
              {badge.label}
            </>
          ) : (
            '—'
          )}
        </span>
        {live && trade && (
          <button
            onClick={copyPlan}
            suppressHydrationWarning
            aria-label={`Copy ${label} ${row.signal.toLowerCase()} plan to clipboard`}
            title="Copy plan"
            className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-tv-line bg-tv-panel2 text-[12px] text-tv-muted transition hover:text-tv-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bull/50"
          >
            {copied ? '✓' : '⧉'}
          </button>
        )}
      </div>

      {/* price + 24h + confirmed age */}
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-lg font-bold tabular-nums tracking-tight text-tv-ink">
          {row.ok ? fmtPrice(row.price) : '—'}
        </span>
        <span className="flex items-baseline gap-2">
          {row.ok && (
            <span className={`text-[11px] font-bold tabular-nums ${row.change24h >= 0 ? 'text-bull' : 'text-bear'}`}>
              {row.change24h >= 0 ? '+' : ''}
              {row.change24h.toFixed(2)}%
            </span>
          )}
          {age && (
            <span className={`text-[10px] font-bold tabular-nums ${age.stale ? 'text-warn' : 'text-tv-muted2'}`}>
              ⚡ {age.txt}
            </span>
          )}
        </span>
      </div>

      {/* the signal itself — plan levels, or the watch note when no levels exist */}
      {row.ok && trade ? (
        <div className="overflow-hidden rounded-xl border border-tv-line bg-tv-panel2/50" role="list" aria-label={`${label} plan levels`}>
          <div className="divide-y divide-tv-line/60">
            <Lvl
              label="Entry"
              value={`${fmtPrice(trade.entry_low)} – ${fmtPrice(trade.entry_high)}`}
              cls="text-warn"
              accent
            />
            <Lvl label="Stop" value={fmtPrice(trade.stop_loss)} cls="text-bear" note={stopPct} />
            <Lvl label="TP1" value={fmtPrice(trade.tp1)} cls="text-info" note={rr ? `+${rr.tp1.toFixed(1)}R` : undefined} />
            <Lvl label="TP2" value={fmtPrice(trade.tp2)} cls="text-info" note={rr ? `+${rr.tp2.toFixed(1)}R` : undefined} />
            <Lvl label="TP3" value={fmtPrice(trade.tp3)} cls="text-info" note={rr ? `+${rr.tp3.toFixed(1)}R` : undefined} />
          </div>
        </div>
      ) : (
        <p className="line-clamp-2 rounded-xl border border-dashed border-tv-line-strong bg-tv-panel2/40 px-2.5 py-2 text-[11px] leading-snug text-tv-muted">
          {!row.ok ? row.error ?? 'engine unavailable' : row.note ?? 'No qualified setup — the engine is standing aside.'}
        </p>
      )}

      {/* verdict chips */}
      <div className="mt-auto flex flex-wrap items-center gap-1.5 border-t border-dashed border-tv-div pt-2">
        <span className={`inline-flex items-center whitespace-nowrap rounded-full border px-2 py-0.5 text-[10px] font-bold tabular-nums ${qualityCls(row.quality)}`}>
          {row.score} · {row.quality}
        </span>
        {live && rr && <Chip cls="border-bull/40 bg-bull/10 text-bull">1 : {rr.tp2.toFixed(1)} at TP2</Chip>}
        {row.ok && row.confirmations != null && row.confirmations > 0 && (
          <Chip cls={row.confirmations === 2 ? 'border-info/35 bg-info/10 text-info' : 'border-warn/35 bg-warn/10 text-warn'}>
            {row.confirmations === 2 ? 'Bybit × Binance ✓' : '1 tape only'}
          </Chip>
        )}
      </div>

      <span className="sr-only">
        {label}: {row.ok ? `${row.signal.replace('_', ' ')} signal, score ${row.score} of 100, quality ${row.quality}` : 'engine unavailable'}.
      </span>
    </article>
  )
}
