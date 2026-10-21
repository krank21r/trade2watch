'use client'

/**
 * Stage 1 (crypto): the trader-screener desk — pick a preset or edit the
 * rules JSON, run the screen, see every pass/fail explained, then hand the
 * ranked weights to the budget stage.
 */

import { useState } from 'react'
import { Loader2, Play, CheckCircle2, XCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useToast } from '@/hooks/use-toast'
import {
  jfetch, pctS, usd,
  type ScreenResponse, type WeightRow,
} from './types'

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

export function ScreenerPanel({
  onUseWeights,
  disabled,
}: {
  onUseWeights: (weights: WeightRow[], source: string) => void
  disabled?: boolean
}) {
  const { toast } = useToast()
  const [preset, setPreset] = useState<string>('momentum')
  const [specText, setSpecText] = useState<string>(PRESET_JSON.momentum)
  const [res, setRes] = useState<ScreenResponse | null>(null)
  const [busy, setBusy] = useState(false)

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
        description: 'Rank the passers, then send the weights to the budget stage.',
      })
    } catch (e) {
      const msg = JSON.parse(specText) && e instanceof SyntaxError ? 'Rules are not valid JSON.' : (e as Error).message
      toast({ title: 'Screen failed', description: msg, variant: 'destructive' })
    } finally {
      setBusy(false)
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
        <div className="max-h-72 min-w-0 overflow-auto rounded-lg border border-tv-line">
          <table className="w-full min-w-[420px] text-[11.5px]">
            <thead className="sticky top-0 bg-tv-panel2 text-tv-muted">
              <tr className="text-left">
                <th className="px-2.5 py-1.5 font-semibold">#</th>
                <th className="px-2 py-1.5 font-semibold">Asset</th>
                <th className="px-2 py-1.5 text-right font-semibold">Price</th>
                <th className="px-2 py-1.5 text-right font-semibold">Entry</th>
                <th className="px-2 py-1.5 text-right font-semibold">Stop</th>
                <th className="px-2 py-1.5 text-right font-semibold">T1 · T2</th>
                <th className="hidden px-2 py-1.5 text-right font-semibold 2xl:table-cell">7d</th>
                <th className="hidden px-2 py-1.5 text-right font-semibold 2xl:table-cell">30d</th>
                <th className="hidden px-2 py-1.5 text-right font-semibold 2xl:table-cell">Vol σ</th>
                <th className="px-2 py-1.5 text-right font-semibold">Score</th>
              </tr>
            </thead>
            <tbody>
              {res.result.rows.map((r, i) => (
                <tr
                  key={r.symbol}
                  title={r.passes.join(' · ') || r.fails.join(' · ')}
                  className="border-t border-tv-line/60 hover:bg-tv-panel2/60"
                >
                  <td className="px-2.5 py-1.5 text-tv-muted">{i + 1}</td>
                  <td className="px-2 py-1.5">
                    <span className="font-bold text-tv-ink">{r.symbol}</span>
                    <span className="ml-1.5 hidden text-tv-muted 2xl:inline">{r.name}</span>
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{usd(r.metrics.price)}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums text-tv-ink">
                    {r.plan ? `${usd(r.plan.entryLow)}–${usd(r.plan.entryHigh)}` : '—'}
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums text-bear">
                    {r.plan ? usd(r.plan.stop) : '—'}
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums text-bull">
                    {r.plan ? `${usd(r.plan.target1)} · ${usd(r.plan.target2)}` : '—'}
                  </td>
                  <td className={`hidden px-2 py-1.5 text-right tabular-nums 2xl:table-cell ${r.metrics.momentum7d >= 0 ? 'text-bull' : 'text-bear'}`}>
                    {pctS(r.metrics.momentum7d, 1)}
                  </td>
                  <td className={`hidden px-2 py-1.5 text-right tabular-nums 2xl:table-cell ${r.metrics.momentum30d >= 0 ? 'text-bull' : 'text-bear'}`}>
                    {pctS(r.metrics.momentum30d, 1)}
                  </td>
                  <td className="hidden px-2 py-1.5 text-right tabular-nums text-tv-muted 2xl:table-cell">{r.metrics.volatility30d.toFixed(1)}</td>
                  <td className="px-2 py-1.5 text-right font-bold tabular-nums text-bull-ink">
                    {r.score !== null ? r.score.toFixed(2) : '—'}
                  </td>
                </tr>
              ))}
              {!res.result.rows.length && (
                <tr>
                  <td colSpan={10} className="px-3 py-4 text-center text-tv-muted">
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
          Entry zone · stop loss · T1/T2 use the same level math as the desk tickets (4h). The final
          levels are fixed on each ticket in stage 3 — the desk never chases above the entry zone.
        </p>
      )}

      {res && res.weights.length > 0 && (
        <div className="flex items-center justify-between gap-2 rounded-lg border border-bull-line bg-bull-soft px-3 py-2">
          <div className="flex items-center gap-1.5 text-[11.5px] text-bull-ink">
            <CheckCircle2 className="h-3.5 w-3.5" />
            {res.weights.length} ranked weights ready (score-proportional, sum 100%)
          </div>
          <Button
            size="sm"
            onClick={() => onUseWeights(res.weights, `crypto screen “${res.result.name}”`)}
            className="h-7 rounded-lg bg-bull px-2.5 text-[11.5px] font-bold text-white hover:bg-bull-deep"
          >
            Use these weights →
          </Button>
        </div>
      )}
      {res && res.weights.length === 0 && (
        <div className="flex items-center gap-1.5 rounded-lg border border-warn-line bg-warn-soft px-3 py-2 text-[11.5px] text-warn">
          <XCircle className="h-3.5 w-3.5" /> No weights — the screen returned nothing usable.
        </div>
      )}
    </div>
  )
}
