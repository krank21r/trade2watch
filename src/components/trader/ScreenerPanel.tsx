'use client'

/**
 * The desk signal feed — crypto + US stocks. Pick a market scope and a preset
 * (or edit the rules JSON), run it, and every asset arrives as ONE signal —
 * the technical analysis (regime, EMAs, slope, MACD, RSI, momentum) picks
 * LONG or SHORT, never both — with an entry zone, stop loss and two targets.
 * The pinned crypto majors (BTC, ETH, SOL, XRP) are always included.
 * "I took this trade" freezes the signal's plan into the shared trade
 * journal (src/lib/mytrades.ts), which then tracks the position against
 * real candles and updates the status automatically.
 */

import { useEffect, useRef, useState } from 'react'
import { Loader2, Play, XCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useToast } from '@/hooks/use-toast'
import { fetchMyTrades, saveMyTrades, type MyTrade } from '@/lib/mytrades'
import { usd, jfetch, type ScreenResponse, type ScreenRowView, type TicketPlanView } from './types'

type Side = 'long' | 'short'
type MarketScope = 'all' | 'crypto' | 'stock'

const PRESET_JSON: Record<string, string> = {
  best: JSON.stringify(
    {
      rules: [],
      rank: [
        { metric: 'absMomentum7d', order: 'desc', weight: 2 },
        { metric: 'absMomentum30d', order: 'desc', weight: 1.5 },
        { metric: 'volumeRatio', order: 'desc', weight: 1 },
        { metric: 'volatility30d', order: 'asc', weight: 0.75 },
      ],
      top: 12,
    },
    null,
    2,
  ),
  momentum: JSON.stringify(
    {
      rules: [
        { metric: 'momentum7d', op: '>=', value: 0 },
        { metric: 'momentum30d', op: '>=', value: 0 },
        { metric: 'volumeRatio', op: '>=', value: 0.7 },
      ],
      rank: [
        { metric: 'momentum7d', order: 'desc', weight: 2 },
        { metric: 'momentum30d', order: 'desc', weight: 1.5 },
        { metric: 'volumeRatio', order: 'desc', weight: 1 },
        { metric: 'volatility30d', order: 'asc', weight: 1 },
      ],
      top: 12,
    },
    null,
    2,
  ),
  breakout: JSON.stringify(
    {
      rules: [
        { metric: 'drawdownFrom30dHigh', op: '<=', value: 6 },
        { metric: 'volumeRatio', op: '>=', value: 1 },
      ],
      rank: [
        { metric: 'momentum24h', order: 'desc', weight: 2 },
        { metric: 'volumeRatio', order: 'desc', weight: 1.5 },
        { metric: 'momentum7d', order: 'desc', weight: 1 },
      ],
      top: 12,
    },
    null,
    2,
  ),
  calm: JSON.stringify(
    {
      rules: [
        { metric: 'volatility30d', op: '<=', value: 5 },
        { metric: 'momentum30d', op: '>=', value: 0 },
      ],
      rank: [
        { metric: 'volatility30d', order: 'asc', weight: 2 },
        { metric: 'momentum30d', order: 'desc', weight: 1.5 },
        { metric: 'momentum7d', order: 'desc', weight: 1 },
      ],
      top: 12,
    },
    null,
    2,
  ),
}

const PRESET_LABELS: Array<[string, string]> = [
  ['best', 'Best signals'],
  ['momentum', 'Momentum'],
  ['breakout', 'Breakout watch'],
  ['calm', 'Calm trends'],
]

const MARKET_LABELS: Array<[MarketScope, string]> = [
  ['all', 'All markets'],
  ['crypto', 'Crypto'],
  ['stock', 'US Stocks'],
]

/** The desk key namespace inside the shared trade journal — one slot per symbol+side. */
export const deskKey = (symbol: string, side: Side): string => `DESK:${symbol}:${side}`

export function buildDeskTrade(
  r: ScreenRowView,
  side: Side,
  entryFill: number,
  screenName: string,
  now = Date.now(),
): MyTrade {
  const plan = r.plan!
  return {
    id: `${deskKey(r.symbol, side)}:${now}`,
    key: deskKey(r.symbol, side),
    symbol: r.symbol,
    market: r.market,
    displayName: r.name,
    pair: r.market === 'crypto' ? `${r.symbol}/USD` : r.symbol,
    currency: 'USD',
    side,
    tag: 'DESK',
    strategy: `Desk signal — ${screenName} · ${side === 'long' ? 'Long' : 'Short'}`,
    entryLow: plan.entryLow,
    entryHigh: plan.entryHigh,
    entryFill,
    stop: plan.stop,
    t1: plan.target1,
    t2: plan.target2,
    runner: null,
    rr: plan.riskReward,
    confirmedAt: now,
    confirmedPrice: r.metrics.price,
    via: 'spot',
    takenAt: now,
    status: 'OPEN',
    tp1HitAt: null,
    tp2HitAt: null,
    slHitAt: null,
    outcome: null,
    closedAt: null,
    closePrice: null,
  }
}

interface Signal {
  r: ScreenRowView
  side: Side
  plan: TicketPlanView
}

export function ScreenerPanel({ onTaken, disabled }: { onTaken?: () => void; disabled?: boolean }) {
  const { toast } = useToast()
  const [market, setMarket] = useState<MarketScope>('all')
  const [preset, setPreset] = useState<string>('best')
  const [specText, setSpecText] = useState<string>(PRESET_JSON.best)
  const [res, setRes] = useState<ScreenResponse | null>(null)
  const [busy, setBusy] = useState(false)
  const [taking, setTaking] = useState<string | null>(null) // symbol currently confirming
  const [entryInput, setEntryInput] = useState<string>('')
  const [saving, setSaving] = useState(false)
  const openDeskSymbols = useRef<Set<string>>(new Set())

  const refreshJournal = async () => {
    try {
      const list = await fetchMyTrades()
      // one open position per SYMBOL — a long and a short on the same asset
      // would be a hedge, not two signals
      openDeskSymbols.current = new Set(list.filter((t) => t.tag === 'DESK' && t.status === 'OPEN').map((t) => t.symbol))
    } catch {
      /* journal unreachable — take buttons stay enabled; the confirm re-checks */
    }
  }

  useEffect(() => {
    void refreshJournal()
    // closing/deleting a tracked trade elsewhere must clear the "✓ Tracking" badge
    const h = () => void refreshJournal()
    window.addEventListener('t2w:trades-changed', h)
    return () => window.removeEventListener('t2w:trades-changed', h)
  }, [])

  const pickPreset = (key: string) => {
    setPreset(key)
    if (PRESET_JSON[key]) setSpecText(PRESET_JSON[key])
  }

  const run = async () => {
    setBusy(true)
    try {
      const spec = JSON.parse(specText)
      const data = await jfetch<ScreenResponse>('/api/trader/screen', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ market, spec }),
      })
      setRes(data)
      const signals = data.result.rows.filter((r) => r.plan).length
      toast({
        title: `${data.result.passed} assets · ${signals} signals (${data.result.name})`,
        description: 'One directional signal per asset — long or short, picked by the analysis. Take one to start tracking it.',
      })
    } catch (e) {
      const msg = e instanceof SyntaxError ? 'Rules are not valid JSON.' : (e as Error).message
      toast({ title: 'Screen failed', description: msg, variant: 'destructive' })
    } finally {
      setBusy(false)
    }
  }

  const startTake = (r: ScreenRowView) => {
    if (!r.plan) return
    setTaking(r.symbol)
    setEntryInput(String(r.metrics.price))
  }

  const confirmTake = async (r: ScreenRowView) => {
    if (!r.plan || !r.side) return
    const side = r.side.toLowerCase() as Side
    const entryFill = Number(entryInput)
    if (!Number.isFinite(entryFill) || entryFill <= 0) {
      toast({ title: 'Entry price looks wrong', description: 'Enter the price you actually filled at.', variant: 'destructive' })
      return
    }
    setSaving(true)
    try {
      const list = await fetchMyTrades()
      if (list.some((t) => t.tag === 'DESK' && t.status === 'OPEN' && t.symbol === r.symbol)) {
        toast({ title: `Already tracking ${r.symbol}`, description: 'Close the open desk trade first — one position per asset.' })
        setTaking(null)
        return
      }
      const t = buildDeskTrade(r, side, entryFill, res?.result.name ?? 'screen')
      const next = [t, ...list]
      saveMyTrades(next)
      window.dispatchEvent(new Event('t2w:trades-changed'))
      openDeskSymbols.current.add(t.symbol)
      setTaking(null)
      onTaken?.()
      toast({
        title: `🎯 Trade taken — ${t.pair} ${side.toUpperCase()}`,
        description: `Plan frozen · fill ${usd(t.entryFill)} · stop ${usd(t.stop)} · T1 ${usd(t.t1)} · T2 ${usd(t.t2)} — status updates automatically.`,
      })
    } catch {
      toast({ title: 'Could not save the trade', description: 'Try again in a moment.', variant: 'destructive' })
    } finally {
      setSaving(false)
    }
  }

  // one signal per asset — the analysis already picked the side
  const signals: Signal[] = []
  if (res) {
    for (const r of res.result.rows) {
      if (r.plan && r.side) signals.push({ r, side: r.side.toLowerCase() as Side, plan: r.plan })
    }
  }

  return (
    <div className="flex min-w-0 flex-col gap-3">
      {/* market scope */}
      <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Market scope">
        {MARKET_LABELS.map(([k, label]) => (
          <button
            key={k}
            suppressHydrationWarning
            onClick={() => setMarket(k)}
            className={`btn rounded-lg border px-2.5 py-1 text-[11.5px] font-semibold ${
              market === k
                ? 'border-info-line bg-info-soft text-info'
                : 'border-tv-line bg-tv-panel2 text-tv-muted hover:text-tv-ink'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {/* presets + run */}
      <div className="flex flex-wrap items-center gap-2">
        {PRESET_LABELS.map(([k, label]) => (
          <button
            key={k}
            suppressHydrationWarning
            onClick={() => pickPreset(k)}
            className={`btn rounded-lg border px-2.5 py-1 text-[11.5px] font-semibold ${
              preset === k
                ? 'border-bull-line bg-bull-soft text-bull-ink'
                : 'border-tv-line bg-tv-panel2 text-tv-muted hover:text-tv-ink'
            }`}
          >
            {label}
          </button>
        ))}
        <Button
          size="sm"
          onClick={run}
          disabled={busy || disabled}
          className="ml-auto h-8 gap-1.5 rounded-lg bg-bull px-3 text-[12px] font-bold text-white hover:bg-bull-deep"
        >
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
          {busy ? 'Screening…' : 'Get signals'}
        </Button>
      </div>

      <details className="group">
        <summary className="cursor-pointer text-[11.5px] font-semibold text-tv-muted hover:text-tv-ink">
          Rules JSON (the repo's rules.example.json shape — edit freely)
        </summary>
        <textarea
          value={specText}
          onChange={(e) => setSpecText(e.target.value)}
          spellCheck={false}
          rows={10}
          className="mt-2 w-full rounded-lg border border-tv-line bg-tv-panel2 p-2.5 font-mono text-[11px] leading-relaxed text-tv-ink outline-none focus:border-bull-line"
        />
        <p className="mt-1 text-[10.5px] text-tv-muted2">
          Metrics: momentum24h · momentum7d · momentum30d · absMomentum7d · absMomentum30d · volatility30d (daily-return
          σ) · volumeRatio · drawdownFrom30dHigh — same vocabulary for crypto and US stocks
        </p>
      </details>

      {res && (
        <div className="max-h-96 min-w-0 overflow-auto rounded-lg border border-tv-line">
          <table className="w-full min-w-[560px] text-[11.5px]">
            <thead className="sticky top-0 bg-tv-panel2 text-tv-muted">
              <tr className="text-left">
                <th className="px-2.5 py-1.5 font-semibold">#</th>
                <th className="px-2 py-1.5 font-semibold">Asset</th>
                <th className="px-2 py-1.5 text-right font-semibold">Price</th>
                <th className="px-2 py-1.5 font-semibold">Dir</th>
                <th className="px-2 py-1.5 text-right font-semibold">Entry</th>
                <th className="px-2 py-1.5 text-right font-semibold">Stop</th>
                <th className="px-2 py-1.5 text-right font-semibold">T1 · T2</th>
                <th className="px-2 py-1.5 text-right font-semibold">R:R</th>
                <th className="px-2 py-1.5 text-right font-semibold">Take</th>
              </tr>
            </thead>
            <tbody>
              {signals.map((s, i) => (
                <TakeRow
                  key={`${s.r.symbol}:${s.side}`}
                  r={s.r}
                  side={s.side}
                  index={i + 1}
                  taking={taking === s.r.symbol}
                  entryInput={entryInput}
                  setEntryInput={setEntryInput}
                  saving={saving}
                  tracked={openDeskSymbols.current.has(s.r.symbol)}
                  onStart={() => startTake(s.r)}
                  onConfirm={() => void confirmTake(s.r)}
                  onCancel={() => setTaking(null)}
                />
              ))}
              {!signals.length && (
                <tr>
                  <td colSpan={9} className="px-3 py-4 text-center text-tv-muted">
                    Nothing passed these rules — loosen them and run again.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {res && signals.length > 0 && (
        <p className="text-[10.5px] leading-relaxed text-tv-muted2">
          One directional signal per asset — the technical read (trend regime, EMAs, slope, MACD, RSI, momentum) picks
          LONG or SHORT, never both (hover the Dir badge for the evidence). Levels come from the same math as the AI
          Signals desk (4h crypto · 1d stocks). Taking a signal freezes the plan — after TP1 the tracker moves the stop
          to entry; TP2 closes the trade as a full win; the stop closes it as a loss.
        </p>
      )}

      {res === null && (
        <div className="flex items-center gap-1.5 rounded-lg border border-tv-line bg-tv-panel2 px-3 py-2 text-[11.5px] text-tv-muted">
          <XCircle className="h-3.5 w-3.5" /> Press “Get signals” for one directional setup (long or short) per asset on
          crypto majors and top US stocks.
        </div>
      )}
    </div>
  )
}

// ─── one signal row (+ inline "I took this trade" confirm row) ───────────────

function TakeRow({
  r,
  side,
  index,
  taking,
  entryInput,
  setEntryInput,
  saving,
  tracked,
  onStart,
  onConfirm,
  onCancel,
}: {
  r: ScreenRowView
  side: Side
  index: number
  taking: boolean
  entryInput: string
  setEntryInput: (v: string) => void
  saving: boolean
  tracked: boolean
  onStart: () => void
  onConfirm: () => void
  onCancel: () => void
}) {
  const p = r.plan
  const isLong = side === 'long'
  return (
    <>
      <tr
        title={[r.sideReason, r.passes.join(' · ') || r.fails.join(' · ')].filter(Boolean).join(' — ') || undefined}
        className="border-t border-tv-line/60 hover:bg-tv-panel2/60"
      >
        <td className="px-2.5 py-1.5 text-tv-muted">{index}</td>
        <td className="px-2 py-1.5">
          <span className="font-bold text-tv-ink">{r.symbol}</span>
          {r.pinned && (
            <span className="ml-1 text-[9px] text-warn" title="Pinned major — always shown">
              ★
            </span>
          )}
          <span className="ml-1.5 hidden text-tv-muted 2xl:inline">{r.name}</span>
          <span className="ml-1.5 rounded border border-tv-line px-1 py-px text-[8.5px] font-bold uppercase tracking-wide text-tv-muted2">
            {r.market === 'stock' ? 'US' : 'Crypto'}
          </span>
        </td>
        <td className="px-2 py-1.5 text-right tabular-nums">{usd(r.metrics.price)}</td>
        <td className="px-2 py-1.5">
          <span
            title={r.sideReason ?? undefined}
            className={`rounded-full border px-1.5 py-0.5 text-[9px] font-bold uppercase ${
              isLong ? 'border-bull/40 bg-bull/10 text-bull' : 'border-bear/40 bg-bear/10 text-bear'
            }`}
          >
            {side}
          </span>
        </td>
        <td className="px-2 py-1.5 text-right tabular-nums text-tv-ink">
          {p ? `${usd(p.entryLow)}–${usd(p.entryHigh)}` : '—'}
        </td>
        <td className="px-2 py-1.5 text-right tabular-nums text-bear">{p ? usd(p.stop) : '—'}</td>
        <td className="px-2 py-1.5 text-right tabular-nums text-bull">{p ? `${usd(p.target1)} · ${usd(p.target2)}` : '—'}</td>
        <td className="px-2 py-1.5 text-right tabular-nums text-tv-muted">{p ? rrShort(p.riskReward) : '—'}</td>
        <td className="px-2 py-1.5 text-right">
          {tracked ? (
            <span className="rounded-lg border border-bull-line bg-bull-soft px-2 py-1 text-[10.5px] font-bold text-bull-ink">
              ✓ Tracking
            </span>
          ) : (
            <button
              suppressHydrationWarning
              onClick={onStart}
              disabled={!p || taking}
              aria-label={`Take ${r.symbol} ${side} — I took this trade`}
              className={`rounded-lg border px-2 py-1 text-[10.5px] font-bold transition disabled:cursor-not-allowed disabled:opacity-40 ${
                isLong
                  ? 'border-bull/50 bg-bull/15 text-bull hover:bg-bull/25'
                  : 'border-bear/50 bg-bear/15 text-bear hover:bg-bear/25'
              }`}
            >
              ▶ Take
            </button>
          )}
        </td>
      </tr>
      {taking && p && (
        <tr className={`border-t ${isLong ? 'border-bull-line/40 bg-bull-soft/50' : 'border-bear/40 bg-bear/10'}`}>
          <td colSpan={9} className="px-3 py-2">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 text-[11.5px]">
              <span className={`font-bold ${isLong ? 'text-bull-ink' : 'text-bear'}`}>
                Take {r.symbol} {side.toUpperCase()} — confirm your fill
              </span>
              <input
                value={entryInput}
                onChange={(e) => setEntryInput(e.target.value)}
                inputMode="decimal"
                aria-label="Entry fill price"
                className="w-24 rounded-lg border border-tv-line bg-tv-panel2 px-2 py-1 text-right font-mono text-[11.5px] tabular-nums text-tv-ink outline-none focus:border-bull-line"
              />
              <span className="tabular-nums text-tv-muted">
                plan frozen · stop {usd(p.stop)} · T1 {usd(p.target1)} · T2 {usd(p.target2)}
              </span>
              <button
                suppressHydrationWarning
                onClick={onConfirm}
                disabled={saving}
                className={`ml-auto rounded-lg px-2.5 py-1 text-[11px] font-bold text-white disabled:opacity-50 ${
                  isLong ? 'bg-bull hover:bg-bull-deep' : 'bg-bear hover:bg-bear/90'
                }`}
              >
                {saving ? 'Saving…' : `✓ Confirm — I took this trade`}
              </button>
              <button
                suppressHydrationWarning
                onClick={onCancel}
                className="rounded-lg border border-tv-line bg-tv-panel2 px-2.5 py-1 text-[11px] font-semibold text-tv-muted hover:text-tv-ink"
              >
                Cancel
              </button>
            </div>
          </td>
        </tr>
      )}
    </>
  )
}

/** "1 : 2.0 at T1 · 1 : 3.5 at T2" → "1 : 2.0" (the T1 multiple). */
function rrShort(rr: string): string {
  const m = /1\s*:\s*[\d.]+/.exec(rr)
  return m ? m[0].replace(/\s+/g, ' ') : rr.split('·')[0].trim()
}
