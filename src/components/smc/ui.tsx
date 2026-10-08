// ─── SMC board shared UI primitives ─────────────────────────────────────────
// Same visual language as SetupBoard / ConfirmedBoard: dark-teal tv-* tokens,
// semantic bull/bear/warn/info with soft-tinted pill chips, rounded-2xl cards.
import type { ReactNode } from 'react'
import type { Direction, FVG, LiqType, ObStatus } from '@/lib/smc/types'

/** HH:MM:SS — render behind a mounted flag so server/client markup matches */
export const fmtClock = (t: number): string =>
  new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })

/** time-only for today, short date+time otherwise */
export const fmtWhen = (t: number): string => {
  const d = new Date(t)
  const now = new Date()
  const sameDay =
    d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate()
  return sameDay
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

/** short local date+time for history rows */
export const fmtDay = (t: number): string =>
  new Date(t).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })

/** thin custom scrollbar for long scrolling lists (Tailwind arbitrary variants) */
export const SCROLL_CLS =
  'overflow-y-auto [scrollbar-width:thin] [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-tv-line-strong'

/** neutral pill chip — pass cls for semantic tints */
export function Chip({
  children,
  cls = 'border-tv-line bg-tv-panel2 text-tv-muted',
}: {
  children: ReactNode
  cls?: string
}) {
  return (
    <span className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-[10px] font-bold ${cls}`}>
      {children}
    </span>
  )
}

export const trendCls = (t: 'BULLISH' | 'BEARISH' | 'NEUTRAL'): string =>
  t === 'BULLISH' ? 'text-bull' : t === 'BEARISH' ? 'text-bear' : 'text-tv-muted'

export const biasCls = (b: 'BULLISH' | 'BEARISH' | 'NEUTRAL'): string =>
  b === 'BULLISH'
    ? 'border-bull/40 bg-bull/10 text-bull'
    : b === 'BEARISH'
      ? 'border-bear/40 bg-bear/10 text-bear'
      : 'border-tv-line bg-tv-panel2 text-tv-muted'

export const dirDotCls = (d: Direction): string => (d === 'BULLISH' ? 'bg-bull' : 'bg-bear')

export const dirTextCls = (d: Direction): string => (d === 'BULLISH' ? 'text-bull' : 'text-bear')

export const dirSoftBg = (d: Direction): string =>
  d === 'BULLISH' ? 'var(--bull-soft)' : 'var(--bear-soft)'

export const obStatusCls: Record<ObStatus, string> = {
  ACTIVE: 'border-bull/40 bg-bull/10 text-bull',
  TESTED: 'border-info/40 bg-info/10 text-info',
  MITIGATED: 'border-warn/40 bg-warn/10 text-warn',
  INVALIDATED: 'border-bear/40 bg-bear/10 text-bear',
  EXPIRED: 'border-tv-line-strong bg-tv-panel2 text-tv-muted',
}

export const fvgStatusCls = (s: FVG['status']): string =>
  s === 'ACTIVE'
    ? 'border-bull/40 bg-bull/10 text-bull'
    : s === 'PARTIALLY_FILLED'
      ? 'border-warn/40 bg-warn/10 text-warn'
      : s === 'FILLED'
        ? 'border-tv-line-strong bg-tv-panel2 text-tv-muted'
        : 'border-bear/40 bg-bear/10 text-bear'

export const fvgStatusLabel = (s: FVG['status']): string =>
  s === 'PARTIALLY_FILLED' ? 'PARTIAL' : s === 'INVALIDATED' ? 'INVALID' : s

export const LIQ_LABEL: Record<LiqType, string> = {
  EQUAL_HIGH: 'Equal highs',
  EQUAL_LOW: 'Equal lows',
  PDH: 'Prev day high',
  PDL: 'Prev day low',
  PWH: 'Prev week high',
  PWL: 'Prev week low',
  SWING_HIGH: 'Swing high',
  SWING_LOW: 'Swing low',
}

/** quality badge tint — A+ amber, A bull, B info, C/— muted */
export const qualityCls = (q: string): string =>
  q === 'A+'
    ? 'border-warn/50 bg-warn/15 text-warn'
    : q === 'A'
      ? 'border-bull/40 bg-bull/10 text-bull'
      : q === 'B'
        ? 'border-info/40 bg-info/10 text-info'
        : 'border-tv-line bg-tv-panel2 text-tv-muted'

/** ladder row — mirrors ConfirmedBoard's LadderRow (icon disc · label · value) */
export function LadderRow({
  icon,
  label,
  sub,
  value,
  cls,
  accent,
  big,
}: {
  icon: string
  label: string
  sub?: string
  value: string
  cls: string
  accent?: boolean
  big?: boolean
}) {
  const rowCls = accent
    ? 'border-warn/40 bg-warn/5'
    : cls === 'text-bear'
      ? 'border-bear/30 bg-bear/5'
      : 'border-tv-line bg-tv-panel2/50'
  const soft = accent ? 'var(--warn-soft)' : cls === 'text-bear' ? 'var(--bear-soft)' : 'var(--info-soft)'
  return (
    <div role="listitem" className={`flex items-center gap-3 rounded-xl border px-3 py-2.5 ${rowCls}`}>
      <span
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[14px]"
        style={{ background: soft }}
        aria-hidden="true"
      >
        {icon}
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-[10.5px] font-bold uppercase tracking-wider text-tv-muted">{label}</div>
        {sub && <div className="mt-0.5 truncate text-[10px] text-tv-muted2">{sub}</div>}
      </div>
      <div className={`shrink-0 font-bold tabular-nums ${cls} ${big ? 'text-[15.5px]' : 'text-[14.5px]'}`}>{value}</div>
    </div>
  )
}

/** rounded panel with the boards' uppercase tracking header + optional count chip */
export function SmcPanel({
  title,
  hint,
  count,
  children,
}: {
  title: string
  hint?: string
  count?: number
  children: ReactNode
}) {
  return (
    <section aria-label={title} className="flex flex-col rounded-2xl border border-tv-line bg-tv-panel shadow-sm p-4 sm:p-5">
      <div className="mb-3 flex items-center gap-2">
        <h3 className="text-[11px] font-bold uppercase tracking-[0.14em] text-tv-muted">
          {title}
          {hint && <span className="normal-case tracking-normal text-tv-muted2"> — {hint}</span>}
        </h3>
        {typeof count === 'number' && (
          <span className="ml-auto rounded-full border border-tv-line bg-tv-panel2 px-2 py-0.5 text-[10px] font-bold tabular-nums text-tv-muted">
            {count}
          </span>
        )}
      </div>
      {children}
    </section>
  )
}

/** gentle empty-state line used by every panel */
export function EmptyLine({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-xl border border-dashed border-tv-line-strong bg-tv-panel2/50 px-3 py-3.5 text-center text-[12px] text-tv-muted">
      {children}
    </p>
  )
}
