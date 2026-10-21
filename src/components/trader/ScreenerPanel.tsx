'use client'

/**
 * Stage "signals" (crypto): the trader-screener — pick a preset or edit the
 * rules JSON, run the screen, and every passer arrives as a signal with an
 * entry zone, stop loss and two targets. "I took this trade" freezes the plan
 * into the shared trade journal (src/lib/mytrades.ts), which then tracks the
 * position against real candles and updates the status automatically.
 */

import { useEffect, useRef, useState } from 'react'
import { Loader2, Play, XCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useToast } from '@/hooks/use-toast'
import { fetchMyTrades, saveMyTrades, type MyTrade } from '@/lib/mytrades'
import { usd, jfetch, pctS, type ScreenResponse, type ScreenRowView } from './types'

const PRESET_JSON: Record<string, string> = {
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
      top: 8,
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
      top: 8,
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
      top: 8,
    },
    null,
    2,
  ),
}

/** The desk key namespace inside the shared trade journal. */
export const deskKey = (symbol: string): string => `DESK:${symbol}:long`

export function buildDeskTrade(r: ScreenRowView, entryFill: number, screenName: string, now = Date.now()): MyTrade {
  const plan = r.plan!
  return {
    id: `${deskKey(r.symbol)}:${now}`,
    key: deskKey(r.symbol),
    symbol: r.symbol,
    market: 'crypto',
    displayName: r.name,
    pair: `${r.symbol}/USD`,
    currency: 'USD',
    side: 'long',
    tag: 'DESK',
    strategy: `Desk signal — ${screenName}`,
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

export function ScreenerPanel({ onTaken, disabled }: { onTaken?: () => void; disabled?: boolean }) {
  const { toast } = useToast()
  const [preset, setPreset] = useState<string>('momentum')
  const [specText, setSpecText] = useState<string>(PRESET_JSON.momentum)
  const [res, setRes] = useState<ScreenResponse | null>(null)
  const [busy, setBusy] = useState(false)
  const [taking, setTaking] = useState<string | null>(null)
  const [entryInput, setEntryInput] = useState<string>('')
  const [saving, setSaving] = useState(false)
  const openDeskSymbols = useRef<Set<string>>(new Set())

  const refreshJournal = async () => {
    try {
      const list = await fetchMyTrades()
      openDeskSymbols.current = new Set(list.filter((t) => t.tag === 'DESK' && t.status === 'OPEN').map((t) => t.key))
    } catch {
      /* journal unreachable — take buttons stay enabled; the confirm re-checks */
    }
  }

  useEffect(() => {
    void refreshJournal()
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
        body: JSON.stringify({ spec }),
      })
      setRes(data)
      toast({
        title: `${data.result.passed} of ${data.result.scanned} assets pass “${data.result.name}”`,
        description: 'Signals carry entry, stop and targets — take one to start tracking it.',
      })
    } catch (e) {
      const msg = JSON.parse(specText) && e instanceof SyntaxError ? 'Rules are not valid JSON.' : (e as Error).message
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
    if (!r.plan) return
    const entryFill = Number(entryInput)
    if (!Number.isFinite(entryFill) || entryFill <= 0) {
      toast({ title: 'Entry price looks wrong', description: 'Enter the price you actually filled at.', variant: 'destructive' })
      return
    }
    setSaving(true)
    try {
      const list = await fetchMyTrades()
      if (list.some((t) => t.key === deskKey(r.symbol) && t.status === 'OPEN')) {
        toast({ title: `Already tracking ${r.symbol}`, description: 'Close the open desk trade first.' })
        setTaking(null)
        return
      }
      const t = buildDeskTrade(r, entryFill, res?.result.name ?? 'screen')
      const next = [t, ...list]
      saveMyTrades(next)
      window.dispatchEvent(new Event('t2w:trades-changed'))
      openDeskSymbols.current.add(t.key)
      setTaking(null)
      onTaken?.()
      toast({
        title: `🎯 Trade taken — ${t.pair} LONG`,
        description: `Plan frozen · fill ${usd(t.entryFill)} · stop ${usd(t.stop)} · T1 ${usd(t.t1)} · T2 ${usd(t.t2)} — status updates automatically.`,
      })
    } catch {
      toast({ title: 'Could not save the trade', description: 'Try again in a moment.', variant: 'destructive' })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        {(['momentum', 'breakout', 'calm'] as const).map((k) => (
          <button
            key={k}
            suppressHydrationWarning
            onClick={() => pickPreset(k)}
            className={`btn rounded-lg border px-2.5 py-1 text-[11.5px] font-semibold capitalize ${
              preset === k
                ? 'border-bull-line bg-bull-soft text-bull-ink'
                : 'border-tv-line bg-tv-panel2 text-tv-muted hover:text-tv-ink'
            }`}
          >
            {k === 'calm' ? 'Calm trends' : k}
          </button>
        ))}
        <Button
          size="sm"
          onClick={run}
          disabled={busy || disabled}
          className="ml-auto h-8 gap-1.5 rounded-lg bg-bull px-3 text-[12px] font-bold text-white hover:bg-bull-deep"
        >
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
          {busy ? 'Screening…' : 'Run screen'}
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
          Metrics: momentum24h · momentum7d · momentum30d · volatility30d (daily-return σ) · volumeRatio · drawdownFrom30dHigh
        </p>
      </details>

      {res && (
        <div className="max-h-80 min-w-0 overflow-auto rounded-lg border border-tv-line">
          <table className="w-full min-w-[520px] text-[11.5px]">
            <thead className="sticky top-0 bg-tv-panel2 text-tv-muted">
              <tr className="text-left">
                <th className="px-2.5 py-1.5 font-semibold">#</th>
                <th className="px-2 py-1.5 font-semibold">Asset</th>
                <th className="px-2 py-1.5 text-right font-semibold">Price</th>
                <th className="px-2 py-1.5 text-right font-semibold">Entry</th>
                <th className="px-2 py-1.5 text-right font-semibold">Stop</th>
                <th className="px-2 py-1.5 text-right font-semibold">T1 · T2</th>
                <th className="px-2 py-1.5 text-right font-semibold">R:R</th>
                <th className="px-2 py-1.5 text-right font-semibold">Take</th>
              </tr>
            </thead>
            <tbody>
              {res.result.rows.map((r, i) => {
                const p = r.plan
                const tracked = openDeskSymbols.current.has(deskKey(r.symbol))
                return (
                  <TakeRow
                    key={r.symbol}
                    r={r}
                    index={i}
                    taking={taking === r.symbol}
                    entryInput={entryInput}
                    setEntryInput={setEntryInput}
                    saving={saving}
                    tracked={tracked}
                    onStart={() => startTake(r)}
                    onConfirm={() => void confirmTake(r)}
                    onCancel={() => setTaking(null)}
                  />
                )
              })}
              {!res.result.rows.length && (
                <tr>
                  <td colSpan={8} className="px-3 py-4 text-center text-tv-muted">
                    Nothing passed these rules — loosen them and run again.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {res && res.result.rows.length > 0 && (
        <p className="text-[10.5px] leading-relaxed text-tv-muted2">
          Levels come from the same technical math as the AI Signals desk (4h). Taking a signal freezes the plan —
          after TP1 the tracker moves the stop to entry; TP2 closes the trade as a full win; the stop closes it as a loss.
        </p>
      )}

      {res === null && (
        <div className="flex items-center gap-1.5 rounded-lg border border-tv-line bg-tv-panel2 px-3 py-2 text-[11.5px] text-tv-muted">
          <XCircle className="h-3.5 w-3.5" /> Run a screen to get signals with entry, stop and targets.
        </div>
      )}
    </div>
  )
}

// ─── one signal row (+ inline "I took this trade" confirm row) ───────────────

function TakeRow({
  r,
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
  return (
    <>
      <tr
        title={r.passes.join(' · ') || r.fails.join(' · ')}
        className="border-t border-tv-line/60 hover:bg-tv-panel2/60"
      >
        <td className="px-2.5 py-1.5 text-tv-muted">{index + 1}</td>
        <td className="px-2 py-1.5">
          <span className="font-bold text-tv-ink">{r.symbol}</span>
          <span className="ml-1.5 hidden text-tv-muted 2xl:inline">{r.name}</span>
        </td>
        <td className="px-2 py-1.5 text-right tabular-nums">{usd(r.metrics.price)}</td>
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
              aria-label={`Take ${r.symbol} long — I took this trade`}
              className="rounded-lg border border-bull/50 bg-bull/15 px-2 py-1 text-[10.5px] font-bold text-bull transition hover:bg-bull/25 disabled:cursor-not-allowed disabled:opacity-40"
            >
              ▶ Take
            </button>
          )}
        </td>
      </tr>
      {taking && (
        <tr className="border-t border-bull-line/40 bg-bull-soft/50">
          <td colSpan={8} className="px-3 py-2">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 text-[11.5px]">
              <span className="font-bold text-bull-ink">Take {r.symbol} LONG — confirm your fill</span>
              <input
                value={entryInput}
                onChange={(e) => setEntryInput(e.target.value)}
                inputMode="decimal"
                aria-label="Entry fill price"
                className="w-24 rounded-lg border border-tv-line bg-tv-panel2 px-2 py-1 text-right font-mono text-[11.5px] tabular-nums text-tv-ink outline-none focus:border-bull-line"
              />
              {p && (
                <span className="tabular-nums text-tv-muted">
                  plan frozen · stop {usd(p.stop)} · T1 {usd(p.target1)} · T2 {usd(p.target2)}
                </span>
              )}
              <button
                suppressHydrationWarning
                onClick={onConfirm}
                disabled={saving}
                className="ml-auto rounded-lg bg-bull px-2.5 py-1 text-[11px] font-bold text-white hover:bg-bull-deep disabled:opacity-50"
              >
                {saving ? 'Saving…' : '✓ Confirm — I took this trade'}
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
