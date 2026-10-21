'use client'

/**
 * Trader Desk — the trader-skill strategy (github.com/Jakeschincariol/trader-skill,
 * MIT) running as a paper desk inside Trade2watch:
 *
 *   1 · Pick targets   crypto screener (rules + weighted rank) or copy a
 *                      famous investor's 13F weights
 *   2 · Budget & rules trader-budget sizing: cash buffer, per-position cap,
 *                      minimum order, rounding — every dollar accounted for
 *   3 · Tickets        trader-risk PASS/BLOCK, then an explicit yes per
 *                      ticket — no trade goes through without your approval
 *   4 · Portfolio      live marks, drift vs targets, rebalance proposals,
 *                      price alerts that ring once
 *
 * Paper only: nothing here can reach a real exchange.
 */

import { useCallback, useEffect, useState } from 'react'
import {
  Loader2, RotateCcw, Check, X, BellRing, Bell, Scale, Wallet, Trash2, Crosshair,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useToast } from '@/hooks/use-toast'
import { ScreenerPanel } from './ScreenerPanel'
import { CopycatPanel } from './CopycatPanel'
import {
  jfetch, usd, pctS, signed, qtyS,
  type AccountResponse, type AlertView, type DeskTicket, type PlanResponse,
  type RebalanceResponse, type WeightRow,
} from './types'

type Stage = 1 | 2 | 3 | 4

const STAGE_LABELS: Record<Stage, string> = {
  1: 'Pick targets',
  2: 'Budget & rules',
  3: 'Tickets — your yes',
  4: 'Portfolio',
}

function RuleInput({
  label, value, onChange, suffix, width = 'w-20',
}: {
  label: string
  value: number
  onChange: (v: number) => void
  suffix?: string
  width?: string
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[10.5px] font-semibold uppercase tracking-wide text-tv-muted">{label}</span>
      <span className="relative inline-flex items-center">
        <Input
          type="number"
          value={Number.isFinite(value) ? value : ''}
          onChange={(e) => onChange(Number(e.target.value))}
          suppressHydrationWarning
          className={`h-8 ${width} rounded-lg border-tv-line bg-tv-panel2 pr-7 text-[12px] tabular-nums`}
        />
        {suffix && <span className="pointer-events-none absolute right-2 text-[10.5px] text-tv-muted2">{suffix}</span>}
      </span>
    </label>
  )
}

function TicketCard({
  t, onDecide, busy,
}: {
  t: DeskTicket
  onDecide: (id: string, action: 'approve' | 'reject') => void
  busy: boolean
}) {
  const done = t.status !== 'proposed'
  const pass = t.verdict === 'PASS'
  const p = t.plan
  return (
    <div
      className={`rounded-xl border p-3 ${
        t.status === 'approved'
          ? 'border-bull-line bg-bull-soft/60'
          : t.status === 'armed'
            ? 'border-amber-300 bg-amber-50/60'
            : t.status === 'rejected' || t.status === 'expired'
              ? 'border-tv-line bg-tv-panel2 opacity-70'
              : pass
                ? 'border-bull-line bg-tv-panel'
                : 'border-warn-line bg-warn-soft/50'
      }`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span
          className={`rounded-md px-1.5 py-0.5 text-[10px] font-extrabold tracking-wide ${
            pass ? 'bg-bull text-white' : 'bg-warn text-white'
          }`}
        >
          {t.verdict}
        </span>
        <span className="text-[13px] font-extrabold text-tv-ink">
          {t.side === 'buy' ? 'BUY' : 'SELL'} {t.symbol}
        </span>
        <span className="text-[13px] font-bold tabular-nums text-tv-ink">{usd(t.notional)}</span>
        {t.refPrice ? <span className="text-[11px] text-tv-muted">@ {usd(t.refPrice)} ref</span> : null}
        <span className="ml-auto text-[10.5px] uppercase tracking-wide text-tv-muted2">{t.status}</span>
      </div>
      {t.why && <p className="mt-1 text-[11px] leading-snug text-tv-muted">{t.why}</p>}
      {p && (
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-tv-line/70 bg-tv-panel2/70 px-2.5 py-1.5 text-[11px]">
          <span className="flex items-center gap-1 font-semibold text-tv-ink">
            <Crosshair className="h-3 w-3 text-tv-muted2" /> Entry
            <span className="tabular-nums">{usd(p.entryLow)}–{usd(p.entryHigh)}</span>
          </span>
          <span className="font-semibold text-bear">
            Stop <span className="tabular-nums">{usd(p.stop)}</span>
          </span>
          <span className="font-semibold text-bull">
            T1 <span className="tabular-nums">{usd(p.target1)}</span>
          </span>
          <span className="font-semibold text-bull">
            T2 <span className="tabular-nums">{usd(p.target2)}</span>
          </span>
          <span className="ml-auto tabular-nums text-tv-muted">R:R {p.riskReward.split(' · ')[0]}</span>
        </div>
      )}
      {t.reasons.length > 0 && (
        <ul className="mt-1 space-y-0.5">
          {t.reasons.map((r, i) => (
            <li key={i} className="text-[11px] leading-snug text-warn">– {r}</li>
          ))}
        </ul>
      )}
      {t.status === 'armed' && (
        <p className="mt-1 text-[11px] font-semibold text-amber-700">
          Armed at the entry zone — it fills automatically when price enters{' '}
          {p ? `${usd(p.entryLow)}–${usd(p.entryHigh)}` : 'the zone'} (48h window), never above it.
        </p>
      )}
      {t.status === 'approved' && t.fillPrice ? (
        <p className="mt-1 text-[11px] font-semibold text-bull-ink">
          Filled {qtyS(t.filledQty ?? 0)} @ {usd(t.fillPrice)} on the paper account
          {p ? ` — stop ${usd(p.stop)} · T1 ${usd(p.target1)} · T2 ${usd(p.target2)} (alerts set)` : ''}
        </p>
      ) : null}
      {!done && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            disabled={busy || !pass}
            onClick={() => onDecide(t.id, 'approve')}
            className="h-7 gap-1 rounded-lg bg-bull px-3 text-[11.5px] font-bold text-white hover:bg-bull-deep disabled:opacity-40"
          >
            <Check className="h-3.5 w-3.5" /> Yes, fill it
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => onDecide(t.id, 'reject')}
            className="h-7 gap-1 rounded-lg border-tv-line px-3 text-[11.5px] font-semibold text-tv-muted hover:text-bear"
          >
            <X className="h-3.5 w-3.5" /> No
          </Button>
          {pass && p && t.side === 'buy' ? (
            <span className="text-[10.5px] text-tv-muted2">
              Fills now while price is in the entry zone; above it, your yes arms the ticket until price pulls back.
            </span>
          ) : null}
        </div>
      )}
    </div>
  )
}

export function TraderDesk() {
  const { toast } = useToast()

  // stage-1 handoff
  const [weights, setWeights] = useState<WeightRow[] | null>(null)
  const [source, setSource] = useState('')
  const [market, setMarket] = useState<'crypto' | 'stock'>('crypto')

  // stage-2 rules
  const [budget, setBudget] = useState(5000)
  const [cashBufferPct, setCashBufferPct] = useState(10)
  const [maxPositionPct, setMaxPositionPct] = useState(25)
  const [minOrderUsd, setMinOrderUsd] = useState(5)
  const [maxOrderUsd, setMaxOrderUsd] = useState(2000)
  const [topN, setTopN] = useState(8)

  // plan + desk state
  const [plan, setPlan] = useState<PlanResponse | null>(null)
  const [planBusy, setPlanBusy] = useState(false)
  const [acct, setAcct] = useState<AccountResponse | null>(null)
  const [tickets, setTickets] = useState<DeskTicket[]>([])
  const [decideBusy, setDecideBusy] = useState<string | null>(null)
  const [rebal, setRebal] = useState<RebalanceResponse | null>(null)
  const [rebalBusy, setRebalBusy] = useState(false)
  const [band, setBand] = useState(5)
  const [alertForm, setAlertForm] = useState({ symbol: '', kind: 'above' as AlertView['kind'], price: '' })
  const [stage, setStage] = useState<Stage>(1)

  const refreshTickets = useCallback(async () => {
    try {
      const d = await jfetch<{ tickets: DeskTicket[] }>('/api/trader/tickets')
      setTickets(d.tickets)
    } catch {
      /* desk may not exist yet */
    }
  }, [])

  const refreshAccount = useCallback(async () => {
    try {
      const d = await jfetch<AccountResponse>('/api/trader/account')
      setAcct(d)
      for (const r of d.alertsRang ?? []) {
        toast({
          title: `🔔 ${r.symbol} ${r.kind === 'above' ? 'crossed above' : 'fell below'} ${usd(r.price)}`,
          description: `Last price ${usd(r.lastPrice ?? undefined)} — alert rings once.`,
        })
      }
      for (const t of d.armedFilled ?? []) {
        toast({
          title: `🎯 Armed order filled: BUY ${t.symbol} ${usd(t.notional)}`,
          description: t.plan
            ? `Price entered the entry zone ${usd(t.plan.entryLow)}–${usd(t.plan.entryHigh)} — filled @ ${usd(t.fillPrice)}. Stop ${usd(t.plan.stop)} · T1 ${usd(t.plan.target1)} · T2 ${usd(t.plan.target2)}.`
            : `Filled @ ${usd(t.fillPrice)}.`,
        })
      }
      if ((d.armedFilled?.length ?? 0) > 0) refreshTickets()
    } catch {
      /* desk may not exist yet */
    }
  }, [toast, refreshTickets])

  useEffect(() => {
    refreshAccount()
    refreshTickets()
    const iv = setInterval(() => {
      refreshAccount()
      refreshTickets()
    }, 45_000)
    return () => clearInterval(iv)
  }, [refreshAccount, refreshTickets])

  const useWeights = (w: WeightRow[], src: string) => {
    setWeights(w)
    setSource(src)
    setMarket(src.includes('screen') ? 'crypto' : 'stock')
    setTopN(Math.min(topN, w.length) || 8)
    setStage(2)
    toast({ title: 'Targets locked in', description: `${w.length} weights from ${src}. Now set the budget and rules.` })
  }

  const buildPlan = async () => {
    if (!weights?.length) return
    setPlanBusy(true)
    try {
      const d = await jfetch<PlanResponse>('/api/trader/plan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          weights, market, source,
          budget, cashBufferPct, maxPositionPct, minOrderUsd, maxOrderUsd,
          top: Math.max(1, Math.min(topN, weights.length)),
        }),
      })
      setPlan(d)
      setStage(3)
      refreshTickets()
      refreshAccount()
      const pass = d.tickets.filter((t) => t.verdict === 'PASS').length
      toast({
        title: `${pass}/${d.tickets.length} orders passed risk`,
        description: 'Approve each ticket below — nothing fills without your yes.',
      })
    } catch (e) {
      toast({ title: 'Plan failed', description: (e as Error).message, variant: 'destructive' })
    } finally {
      setPlanBusy(false)
    }
  }

  const decide = async (id: string, action: 'approve' | 'reject') => {
    setDecideBusy(id)
    try {
      const d = await jfetch<{ ticket: DeskTicket; note: string }>(`/api/trader/tickets/${id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      })
      toast({
        title: action === 'approve' ? `Filled ${d.ticket.symbol} — ${usd(d.ticket.notional)}` : `${d.ticket.symbol} rejected`,
        description: d.note,
      })
      refreshTickets()
      refreshAccount()
    } catch (e) {
      toast({ title: 'Could not decide', description: (e as Error).message, variant: 'destructive' })
    } finally {
      setDecideBusy(null)
    }
  }

  const proposeRebalance = async () => {
    setRebalBusy(true)
    try {
      const d = await jfetch<RebalanceResponse>('/api/trader/rebalance', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ band }),
      })
      setRebal(d)
      refreshTickets()
      setStage(3)
      toast({
        title: d.tickets.length ? `${d.tickets.length} rebalance tickets proposed` : 'Nothing to rebalance',
        description: d.notes.join(' ') || 'Sells first, then buys — approve each ticket.',
      })
    } catch (e) {
      toast({ title: 'Rebalance failed', description: (e as Error).message, variant: 'destructive' })
    } finally {
      setRebalBusy(false)
    }
  }

  const addAlert = async () => {
    try {
      await jfetch('/api/trader/alerts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol: alertForm.symbol, kind: alertForm.kind, price: Number(alertForm.price) }),
      })
      setAlertForm({ symbol: '', kind: 'above', price: '' })
      refreshAccount()
      toast({ title: 'Alert set', description: 'It rings once when the level is crossed.' })
    } catch (e) {
      toast({ title: 'Alert failed', description: (e as Error).message, variant: 'destructive' })
    }
  }

  const removeAlert = async (id: string) => {
    try {
      await jfetch(`/api/trader/alerts?id=${id}`, { method: 'DELETE' })
      refreshAccount()
    } catch (e) {
      toast({ title: 'Could not remove alert', description: (e as Error).message, variant: 'destructive' })
    }
  }

  const reset = async () => {
    try {
      await jfetch('/api/trader/account', { method: 'POST' })
      setPlan(null)
      setRebal(null)
      setTickets([])
      setWeights(null)
      setSource('')
      setStage(1)
      refreshAccount()
      toast({ title: 'Paper desk reset', description: 'Account, tickets, positions, targets and alerts wiped.' })
    } catch (e) {
      toast({ title: 'Reset failed', description: (e as Error).message, variant: 'destructive' })
    }
  }

  const proposed = tickets.filter((t) => t.status === 'proposed')
  const armed = tickets.filter((t) => t.status === 'armed')
  const selectedWeights = plan?.sizing.positions ?? []

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 p-3 sm:p-5">
      {/* header + paper account */}
      <div className="flex flex-wrap items-center gap-3">
        <div>
          <h1 className="text-lg font-extrabold tracking-tight text-tv-ink">Trader Desk</h1>
          <p className="text-[11.5px] text-tv-muted">
            The trader-skill pipeline: targets → budget sizing → risk gate → your yes → paper portfolio.
          </p>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-1.5 rounded-lg border border-tv-line bg-tv-panel2 px-2.5 py-1.5 text-[11.5px] font-semibold text-tv-ink">
            <Wallet className="h-3.5 w-3.5 text-bull" /> Cash {usd(acct?.account.cash ?? 0)}
          </span>
          <span className="inline-flex items-center gap-1.5 rounded-lg border border-tv-line bg-tv-panel2 px-2.5 py-1.5 text-[11.5px] font-semibold text-tv-ink">
            <Scale className="h-3.5 w-3.5 text-bull" /> Positions {usd(acct?.invested ?? 0)}
          </span>
          <span className="inline-flex items-center gap-1.5 rounded-lg border border-bull-line bg-bull-soft px-2.5 py-1.5 text-[11.5px] font-extrabold text-bull-ink">
            Total {usd(acct?.total ?? 0)}
          </span>
          <Button
            size="sm"
            variant="outline"
            onClick={reset}
            className="h-8 gap-1 rounded-lg border-tv-line text-[11.5px] font-semibold text-tv-muted hover:text-bear"
          >
            <RotateCcw className="h-3.5 w-3.5" /> Reset
          </Button>
        </div>
      </div>

      {/* stage stepper */}
      <div className="flex items-center gap-1.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {([1, 2, 3, 4] as Stage[]).map((s) => (
          <button
            key={s}
            suppressHydrationWarning
            onClick={() => setStage(s)}
            className={`btn shrink-0 rounded-lg border px-2.5 py-1 text-[11.5px] font-bold ${
              stage === s
                ? 'border-bull-line bg-bull-soft text-bull-ink'
                : 'border-tv-line bg-tv-panel2 text-tv-muted hover:text-tv-ink'
            }`}
          >
            {s} · {STAGE_LABELS[s]}
          </button>
        ))}
      </div>

      {/* ── stage 1: targets ─────────────────────────────────────────────── */}
      {stage === 1 && (
        <div className="grid gap-4 lg:grid-cols-2">
          <section className="rounded-2xl border border-tv-line bg-tv-panel p-4">
            <h2 className="mb-1 text-[13px] font-extrabold text-tv-ink">Crypto screener</h2>
            <p className="mb-3 text-[11px] leading-snug text-tv-muted">
              Screen ~32 Binance assets against explicit rules; every pass and fail is explained; passers are
              ranked by a weighted percentile score. A screen is a filter, not a recommendation.
            </p>
            <ScreenerPanel onUseWeights={useWeights} />
          </section>
          <section className="rounded-2xl border border-tv-line bg-tv-panel p-4">
            <h2 className="mb-1 text-[13px] font-extrabold text-tv-ink">Copy an investor (stocks)</h2>
            <p className="mb-3 text-[11px] leading-snug text-tv-muted">
              Reads a fund's latest 13F-HR from SEC EDGAR, rebuilds the portfolio as weights and diffs the
              previous quarter. Holdings are up to 45 days old — that is the law, not the tool.
            </p>
            <CopycatPanel onUseWeights={useWeights} />
          </section>
        </div>
      )}

      {/* ── stage 2: budget & rules ──────────────────────────────────────── */}
      {stage === 2 && (
        <section className="rounded-2xl border border-tv-line bg-tv-panel p-4">
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <h2 className="text-[13px] font-extrabold text-tv-ink">Budget & sizing rules</h2>
            {weights && (
              <span className="rounded-full border border-bull-line bg-bull-soft px-2 py-0.5 text-[11px] font-bold text-bull-ink">
                {weights.length} targets from {source || 'targets'}
              </span>
            )}
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setStage(1)}
              className="ml-auto h-7 rounded-lg text-[11.5px] font-semibold text-tv-muted"
            >
              ← change targets
            </Button>
          </div>

          {!weights ? (
            <p className="rounded-lg border border-warn-line bg-warn-soft px-3 py-2 text-[12px] text-warn">
              Pick targets first — run the screener or copy an investor in stage 1.
            </p>
          ) : (
            <>
              <div className="flex flex-wrap gap-3">
                <RuleInput label="Budget" value={budget} onChange={setBudget} suffix="USD" width="w-28" />
                <RuleInput label="Cash buffer" value={cashBufferPct} onChange={setCashBufferPct} suffix="%" />
                <RuleInput label="Max position" value={maxPositionPct} onChange={setMaxPositionPct} suffix="%" />
                <RuleInput label="Min order" value={minOrderUsd} onChange={setMinOrderUsd} suffix="USD" />
                <RuleInput label="Max order" value={maxOrderUsd} onChange={setMaxOrderUsd} suffix="USD" />
                <RuleInput label="Top N" value={topN} onChange={setTopN} width="w-16" />
                <div className="ml-auto self-end">
                  <Button
                    onClick={buildPlan}
                    disabled={planBusy}
                    className="h-8 gap-1.5 rounded-lg bg-bull px-4 text-[12px] font-bold text-white hover:bg-bull-deep"
                  >
                    {planBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                    {planBusy ? 'Sizing…' : 'Size it → tickets'}
                  </Button>
                </div>
              </div>
              <p className="mt-2 text-[11px] leading-snug text-tv-muted">
                1 · {usd((budget * cashBufferPct) / 100)} stays in cash · 2 · weights renormalise to 100% · 3 ·
                nothing over {usd((budget * maxPositionPct) / 100)} per position (the excess is shared out) · 4 ·
                slices under {usd(minOrderUsd)} are dropped · 5 · rounding never spends money you do not have.
              </p>

              {plan && (
                <div className="mt-4">
                  <div className="mb-2 grid grid-cols-2 gap-2 text-[11.5px] sm:grid-cols-4">
                    <div className="rounded-lg border border-tv-line bg-tv-panel2 px-2.5 py-1.5">
                      <div className="text-tv-muted">Investing</div>
                      <div className="font-bold tabular-nums text-tv-ink">{usd(plan.sizing.invested)}</div>
                    </div>
                    <div className="rounded-lg border border-tv-line bg-tv-panel2 px-2.5 py-1.5">
                      <div className="text-tv-muted">Cash buffer</div>
                      <div className="font-bold tabular-nums text-tv-ink">{usd(plan.sizing.cashBuffer)}</div>
                    </div>
                    <div className="rounded-lg border border-tv-line bg-tv-panel2 px-2.5 py-1.5">
                      <div className="text-tv-muted">Left idle</div>
                      <div className="font-bold tabular-nums text-tv-ink">{usd(plan.sizing.idle)}</div>
                    </div>
                    <div className="rounded-lg border border-tv-line bg-tv-panel2 px-2.5 py-1.5">
                      <div className="text-tv-muted">Position cap</div>
                      <div className="font-bold tabular-nums text-tv-ink">{usd(plan.sizing.cap)}</div>
                    </div>
                  </div>
                  <div className="max-h-64 overflow-y-auto rounded-lg border border-tv-line">
                    <table className="w-full text-[11.5px]">
                      <thead className="sticky top-0 bg-tv-panel2 text-tv-muted">
                        <tr className="text-left">
                          <th className="px-2.5 py-1.5 font-semibold">Asset</th>
                          <th className="px-2 py-1.5 text-right font-semibold">Weight</th>
                          <th className="px-2 py-1.5 text-right font-semibold">Dollars</th>
                          <th className="px-2 py-1.5 text-right font-semibold">Price</th>
                          <th className="px-2 py-1.5 font-semibold">Note</th>
                        </tr>
                      </thead>
                      <tbody>
                        {selectedWeights.map((p) => (
                          <tr key={p.ticker} className="border-t border-tv-line/60">
                            <td className="px-2.5 py-1.5 font-bold text-tv-ink">{p.ticker}</td>
                            <td className="px-2 py-1.5 text-right tabular-nums">{p.weight.toFixed(2)}%</td>
                            <td className="px-2 py-1.5 text-right font-bold tabular-nums text-tv-ink">{usd(p.dollars)}</td>
                            <td className="px-2 py-1.5 text-right tabular-nums text-tv-muted">{p.price ? usd(p.price) : '—'}</td>
                            <td className="px-2 py-1.5 text-tv-muted">{p.capped ? 'capped' : ''}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {plan.sizing.dropped.length > 0 && (
                    <ul className="mt-2 space-y-0.5">
                      {plan.sizing.dropped.map((d, i) => (
                        <li key={i} className="text-[11px] text-warn">Dropped {d.ticker}: {d.reason}</li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </>
          )}
        </section>
      )}

      {/* ── stage 3: tickets ─────────────────────────────────────────────── */}
      {stage === 3 && (
        <section className="rounded-2xl border border-tv-line bg-tv-panel p-4">
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <h2 className="text-[13px] font-extrabold text-tv-ink">Tickets — nothing fills without your yes</h2>
            <span className="rounded-full border border-tv-line bg-tv-panel2 px-2 py-0.5 text-[11px] font-bold text-tv-muted">
              {proposed.length} awaiting decision
            </span>
            {armed.length > 0 && (
              <span className="rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-[11px] font-bold text-amber-700">
                {armed.length} armed at entry zone
              </span>
            )}
          </div>
          {tickets.length === 0 ? (
            <p className="rounded-lg border border-warn-line bg-warn-soft px-3 py-2 text-[12px] text-warn">
              No tickets yet — size a plan in stage 2 or propose a rebalance in stage 4.
            </p>
          ) : (
            <div className="grid max-h-[420px] gap-2 overflow-y-auto pr-1">
              {tickets.map((t) => (
                <TicketCard key={t.id} t={t} onDecide={decide} busy={decideBusy === t.id} />
              ))}
            </div>
          )}
        </section>
      )}

      {/* ── stage 4: portfolio ───────────────────────────────────────────── */}
      {stage === 4 && (
        <div className="flex flex-col gap-4">
          <section className="rounded-2xl border border-tv-line bg-tv-panel p-4">
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <h2 className="text-[13px] font-extrabold text-tv-ink">Paper portfolio</h2>
              {acct?.targetSource && (
                <span className="rounded-full border border-tv-line bg-tv-panel2 px-2 py-0.5 text-[11px] font-semibold text-tv-muted">
                  targets: {acct.targetSource}
                </span>
              )}
              <span className="ml-auto text-[11.5px] font-semibold text-tv-muted">
                {usd(acct?.account.cash ?? 0)} cash · {usd(acct?.invested ?? 0)} invested · {usd(acct?.total ?? 0)} total
              </span>
            </div>
            {!acct || acct.rows.length === 0 ? (
              <p className="rounded-lg border border-warn-line bg-warn-soft px-3 py-2 text-[12px] text-warn">
                Nothing held yet — approve some tickets in stage 3.
              </p>
            ) : (
              <div className="max-h-72 overflow-y-auto rounded-lg border border-tv-line">
                <table className="w-full text-[11.5px]">
                  <thead className="sticky top-0 bg-tv-panel2 text-tv-muted">
                    <tr className="text-left">
                      <th className="px-2.5 py-1.5 font-semibold">Asset</th>
                      <th className="px-2 py-1.5 text-right font-semibold">Qty</th>
                      <th className="px-2 py-1.5 text-right font-semibold">Avg</th>
                      <th className="px-2 py-1.5 text-right font-semibold">Last</th>
                      <th className="px-2 py-1.5 text-right font-semibold">Value</th>
                      <th className="px-2 py-1.5 text-right font-semibold">P&amp;L</th>
                      <th className="px-2 py-1.5 text-right font-semibold">Stop / T1 / T2</th>
                      <th className="px-2 py-1.5 text-right font-semibold">Now %</th>
                      <th className="px-2 py-1.5 text-right font-semibold">Target %</th>
                      <th className="px-2 py-1.5 text-right font-semibold">Drift</th>
                    </tr>
                  </thead>
                  <tbody>
                    {acct.rows.map((r) => (
                      <tr key={r.symbol} className="border-t border-tv-line/60">
                        <td className="px-2.5 py-1.5 font-bold text-tv-ink">{r.symbol}</td>
                        <td className="px-2 py-1.5 text-right tabular-nums">{qtyS(r.qty)}</td>
                        <td className="px-2 py-1.5 text-right tabular-nums text-tv-muted">{usd(r.avgPrice)}</td>
                        <td className="px-2 py-1.5 text-right tabular-nums">{usd(r.price)}</td>
                        <td className="px-2 py-1.5 text-right font-bold tabular-nums text-tv-ink">{usd(r.value)}</td>
                        <td className={`px-2 py-1.5 text-right tabular-nums ${r.pnlPct >= 0 ? 'text-bull' : 'text-bear'}`}>
                          {pctS(r.pnlPct, 1)}
                        </td>
                        <td className="px-2 py-1.5 text-right tabular-nums text-[10.5px]">
                          {r.levels ? (
                            <>
                              <span className="text-bear">{usd(r.levels.stop)}</span>
                              {' / '}
                              <span className="text-bull">{usd(r.levels.target1)}</span>
                              {' / '}
                              <span className="text-bull">{usd(r.levels.target2)}</span>
                            </>
                          ) : (
                            <span className="text-tv-muted2">—</span>
                          )}
                        </td>
                        <td className="px-2 py-1.5 text-right tabular-nums">{r.currentPct.toFixed(1)}</td>
                        <td className="px-2 py-1.5 text-right tabular-nums text-tv-muted">
                          {r.tracked ? r.targetPct.toFixed(1) : '—'}
                        </td>
                        <td className={`px-2 py-1.5 text-right tabular-nums ${
                          Math.abs(r.drift) > band ? (r.drift > 0 ? 'text-warn' : 'text-bull') : 'text-tv-muted2'
                        }`}>
                          {r.tracked ? signed(r.drift, 1) : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <div className="mt-3 flex flex-wrap items-end gap-2">
              <RuleInput label="Rebalance band" value={band} onChange={setBand} suffix="pts" width="w-16" />
              <Button
                size="sm"
                onClick={proposeRebalance}
                disabled={rebalBusy || !acct?.account.exists}
                className="h-8 gap-1.5 rounded-lg bg-bull px-3.5 text-[12px] font-bold text-white hover:bg-bull-deep"
              >
                {rebalBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Scale className="h-3.5 w-3.5" />}
                Propose rebalance
              </Button>
              <p className="text-[11px] text-tv-muted">
                Only assets drifting more than the band trade. Sells first; buys scale down to the cash above your buffer.
              </p>
            </div>

            {rebal && rebal.rows.length > 0 && (
              <div className="mt-3 max-h-56 overflow-y-auto rounded-lg border border-tv-line">
                <table className="w-full text-[11px]">
                  <thead className="sticky top-0 bg-tv-panel2 text-tv-muted">
                    <tr className="text-left">
                      <th className="px-2.5 py-1.5 font-semibold">Asset</th>
                      <th className="px-2 py-1.5 text-right font-semibold">Now %</th>
                      <th className="px-2 py-1.5 text-right font-semibold">Target %</th>
                      <th className="px-2 py-1.5 text-right font-semibold">Drift</th>
                      <th className="px-2 py-1.5 font-semibold">Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rebal.rows.map((r) => (
                      <tr key={r.symbol} className="border-t border-tv-line/60">
                        <td className="px-2.5 py-1.5 font-bold text-tv-ink">{r.symbol}</td>
                        <td className="px-2 py-1.5 text-right tabular-nums">{r.currentPct.toFixed(1)}</td>
                        <td className="px-2 py-1.5 text-right tabular-nums text-tv-muted">{r.targetPct.toFixed(1)}</td>
                        <td className="px-2 py-1.5 text-right tabular-nums">{signed(r.drift, 1)}</td>
                        <td className={`px-2 py-1.5 font-bold ${
                          r.action === 'buy' ? 'text-bull' : r.action === 'sell' ? 'text-bear' : 'text-tv-muted'
                        }`}>
                          {r.action}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {rebal?.notes.length ? (
              <ul className="mt-2 space-y-0.5">
                {rebal.notes.map((n, i) => (
                  <li key={i} className="text-[11px] text-warn">– {n}</li>
                ))}
              </ul>
            ) : null}
          </section>

          {/* alerts */}
          <section className="rounded-2xl border border-tv-line bg-tv-panel p-4">
            <h2 className="mb-1 flex items-center gap-1.5 text-[13px] font-extrabold text-tv-ink">
              <BellRing className="h-4 w-4 text-bull" /> Price alerts
            </h2>
            <p className="mb-3 text-[11px] text-tv-muted">
              Information only — when a level is hit the alert rings once; nothing is sold. Checked every 45s
              against live prices.
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <Input
                value={alertForm.symbol}
                onChange={(e) => setAlertForm((f) => ({ ...f, symbol: e.target.value.toUpperCase().slice(0, 10) }))}
                placeholder="BTC"
                suppressHydrationWarning
                className="h-8 w-24 rounded-lg border-tv-line bg-tv-panel2 text-[12px]"
              />
              <select
                value={alertForm.kind}
                onChange={(e) => setAlertForm((f) => ({ ...f, kind: e.target.value as AlertView['kind'] }))}
                className="h-8 rounded-lg border border-tv-line bg-tv-panel2 px-2 text-[12px] text-tv-ink"
              >
                <option value="above">crosses above</option>
                <option value="below">falls below</option>
                <option value="stop">stop (below)</option>
              </select>
              <Input
                value={alertForm.price}
                onChange={(e) => setAlertForm((f) => ({ ...f, price: e.target.value }))}
                placeholder="price"
                type="number"
                suppressHydrationWarning
                className="h-8 w-28 rounded-lg border-tv-line bg-tv-panel2 text-[12px] tabular-nums"
              />
              <Button
                size="sm"
                onClick={addAlert}
                disabled={!alertForm.symbol || !(Number(alertForm.price) > 0)}
                className="h-8 gap-1 rounded-lg bg-bull px-3 text-[12px] font-bold text-white hover:bg-bull-deep"
              >
                <Bell className="h-3.5 w-3.5" /> Set
              </Button>
            </div>
            {acct?.alerts.length ? (
              <ul className="mt-3 grid max-h-44 gap-1.5 overflow-y-auto">
                {acct.alerts.map((a) => (
                  <li
                    key={a.id}
                    className={`flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-[11.5px] ${
                      a.triggered ? 'border-bull-line bg-bull-soft text-bull-ink' : 'border-tv-line bg-tv-panel2 text-tv-ink'
                    }`}
                  >
                    <Bell className={`h-3.5 w-3.5 ${a.triggered ? 'text-bull' : 'text-tv-muted2'}`} />
                    <span className="font-bold">{a.symbol}</span>
                    <span>
                      {a.kind === 'above' ? 'crosses above' : a.kind === 'below' ? 'falls below' : 'stop at'} {usd(a.price)}
                    </span>
                    {a.lastPrice ? <span className="text-tv-muted">· now {usd(a.lastPrice)}</span> : null}
                    <span className="ml-auto text-[10.5px] text-tv-muted2">
                      {a.triggered ? `rang ${a.triggeredAt ? new Date(a.triggeredAt).toLocaleString() : ''}` : 'watching'}
                    </span>
                    <button
                      suppressHydrationWarning
                      onClick={() => removeAlert(a.id)}
                      className="btn rounded p-1 text-tv-muted2 hover:text-bear"
                      aria-label={`remove ${a.symbol} alert`}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-3 text-[11.5px] text-tv-muted2">No alerts yet.</p>
            )}
          </section>
        </div>
      )}
    </div>
  )
}
