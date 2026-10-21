'use client'

/**
 * Stage 1 (stocks): the trader-copycat desk — pick a famous filer (or paste a
 * CIK), read their latest 13F-HR from SEC EDGAR, see what they added/trimmed/
 * sold since last quarter, then hand the copyable weights to the budget stage.
 */

import { useEffect, useMemo, useState } from 'react'
import { Loader2, Search, CheckCircle2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useToast } from '@/hooks/use-toast'
import { jfetch, type WeightRow } from './types'

interface Filer {
  cik: string
  name: string
  person: string
  aliases: string[]
  last_13f: string
  status?: string
}

interface AnalyzeResponse {
  ok: boolean
  error?: string
  filer: { cik: string; name: string; person: string; status: string }
  meta: { period: string; filed: string }
  totalPositions: number
  diff: {
    counts: Record<string, number>
    prior: { period: string; filed: string } | null
    rows: Array<{ ticker: string; name: string; status: string; pctDelta?: number }>
  }
  copyWeights: WeightRow[]
  skipped: Array<{ issuer: string; ticker: string; why: string }>
}

const DIFF_STYLE: Record<string, string> = {
  NEW: 'text-bull',
  ADDED: 'text-bull',
  TRIMMED: 'text-warn',
  SOLD: 'text-bear',
  FLAT: 'text-tv-muted',
}

export function CopycatPanel({
  onUseWeights,
  disabled,
}: {
  onUseWeights: (weights: WeightRow[], source: string) => void
  disabled?: boolean
}) {
  const { toast } = useToast()
  const [filers, setFilers] = useState<Filer[]>([])
  const [query, setQuery] = useState('')
  const [cik, setCik] = useState('')
  const [res, setRes] = useState<AnalyzeResponse | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    jfetch<{ filers: Filer[] }>('/api/copycat/filers')
      .then((d) => setFilers(d.filers))
      .catch(() => setFilers([]))
  }, [])

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return filers
    return filers.filter(
      (f) =>
        f.name.toLowerCase().includes(q) ||
        f.person.toLowerCase().includes(q) ||
        f.aliases.some((a) => a.includes(q)),
    )
  }, [filers, query])

  const analyze = async (targetCik: string, label: string) => {
    setBusy(true)
    setRes(null)
    try {
      const data = await jfetch<AnalyzeResponse>('/api/copycat/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cik: targetCik }),
      })
      setRes(data)
      toast({
        title: `${label}: ${data.copyWeights.length} copyable positions`,
        description: `13F for ${data.meta.period}, filed ${data.meta.filed}. Weights are as-filed and up to 45 days old.`,
      })
    } catch (e) {
      toast({ title: `${label}: analysis failed`, description: (e as Error).message, variant: 'destructive' })
    } finally {
      setBusy(false)
    }
  }

  const sel = (f: Filer) => {
    setCik(f.cik.replace(/^0+/, ''))
    analyze(f.cik, f.person.split('(')[0].trim() || f.name)
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-tv-muted2" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search investors — Buffett, Ackman, Burry, ARK…"
            className="h-8 rounded-lg border-tv-line bg-tv-panel2 pl-8 text-[12px]"
          />
        </div>
        <Input
          value={cik}
          onChange={(e) => setCik(e.target.value.replace(/\D/g, '').slice(0, 10))}
          placeholder="or CIK"
          className="h-8 w-24 rounded-lg border-tv-line bg-tv-panel2 text-[12px]"
        />
        <Button
          size="sm"
          onClick={() => cik.length >= 6 && analyze(cik, `CIK ${cik}`)}
          disabled={busy || cik.length < 6 || disabled}
          className="h-8 rounded-lg bg-bull px-3 text-[12px] font-bold text-white hover:bg-bull-deep"
        >
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Analyze 13F'}
        </Button>
      </div>

      <div className="flex max-h-28 flex-wrap gap-1.5 overflow-y-auto">
        {visible.slice(0, 24).map((f) => (
          <button
            key={f.cik}
            suppressHydrationWarning
            disabled={busy}
            onClick={() => sel(f)}
            className={`btn rounded-full border px-2.5 py-1 text-[11px] font-semibold transition-colors ${
              cik === f.cik
                ? 'border-bull-line bg-bull-soft text-bull-ink'
                : 'border-tv-line bg-tv-panel2 text-tv-muted hover:border-bull-line hover:text-tv-ink'
            } ${f.status ? 'opacity-60' : ''}`}
            title={f.status ? `${f.name} — ${f.status}` : f.name}
          >
            {f.person.replace(/\s*\(.*\)/, '') || f.name}
          </button>
        ))}
        {!visible.length && <span className="px-1 text-[11px] text-tv-muted2">No filer matches “{query}”.</span>}
      </div>

      {res && (
        <>
          <div className="rounded-lg border border-tv-line bg-tv-panel2 px-3 py-2 text-[11px] text-tv-muted">
            <span className="font-bold text-tv-ink">{res.filer.person || res.filer.name}</span>
            {' · '}holdings as of <span className="font-semibold text-tv-ink">{res.meta.period}</span>, filed{' '}
            {res.meta.filed} — a 13F is a quarterly snapshot, up to 45 days old, long US-listed stocks only.
            {res.diff.prior && ` vs ${res.diff.prior.period}: `}
            {Object.entries(res.diff.counts)
              .map(([k, v]) => `${v} ${k.toLowerCase()}`)
              .join(' · ')}
          </div>

          {res.copyWeights.length > 0 ? (
            <div className="flex items-center justify-between gap-2 rounded-lg border border-bull-line bg-bull-soft px-3 py-2">
              <div className="flex items-center gap-1.5 text-[11.5px] text-bull-ink">
                <CheckCircle2 className="h-3.5 w-3.5" />
                {res.copyWeights.length} copyable weights (
                {res.copyWeights.slice(0, 4).map((w) => w.ticker).join(', ')}
                {res.copyWeights.length > 4 ? '…' : ''})
              </div>
              <Button
                size="sm"
                onClick={() => onUseWeights(res.copyWeights, `copying ${res.filer.person || res.filer.name}`)}
                className="h-7 shrink-0 rounded-lg bg-bull px-2.5 text-[11.5px] font-bold text-white hover:bg-bull-deep"
              >
                Use these weights →
              </Button>
            </div>
          ) : (
            <div className="rounded-lg border border-warn-line bg-warn-soft px-3 py-2 text-[11.5px] text-warn">
              No copyable weights — this filer's stocks did not match US tickers this quarter.
            </div>
          )}

          {res.diff.rows.length > 0 && (
            <div className="max-h-40 overflow-y-auto rounded-lg border border-tv-line">
              <table className="w-full text-[11px]">
                <thead className="sticky top-0 bg-tv-panel2 text-tv-muted">
                  <tr className="text-left">
                    <th className="px-2.5 py-1.5 font-semibold">QoQ change</th>
                    <th className="px-2 py-1.5 font-semibold">Ticker</th>
                    <th className="px-2 py-1.5 font-semibold">Name</th>
                    <th className="px-2 py-1.5 text-right font-semibold">Δ weight</th>
                  </tr>
                </thead>
                <tbody>
                  {res.diff.rows.slice(0, 25).map((r, i) => (
                    <tr key={`${r.ticker}-${i}`} className="border-t border-tv-line/60">
                      <td className={`px-2.5 py-1 font-bold ${DIFF_STYLE[r.status] ?? 'text-tv-muted'}`}>{r.status}</td>
                      <td className="px-2 py-1 font-bold text-tv-ink">{r.ticker}</td>
                      <td className="max-w-0 truncate px-2 py-1 text-tv-muted">{r.name}</td>
                      <td className="px-2 py-1 text-right tabular-nums text-tv-muted">
                        {r.pctDelta !== undefined ? `${r.pctDelta >= 0 ? '+' : ''}${r.pctDelta.toFixed(2)}%` : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  )
}
