'use client'

// ─── Backtest card — on-demand replay of the live SMC pipeline (§29/§30/§31) ─
// Heavy by design (paginated history + thousands of pipeline replays), so it
// runs ONLY on an explicit button press against GET /api/smc/backtest and
// never participates in the 45s polling loop. Fixed parameters everywhere —
// nothing is optimised on history, so every walk-forward fold is out-of-sample.

import { useCallback, useState } from 'react'
import { motion } from 'framer-motion'
import type { BacktestResult } from '@/lib/smc/backtest'

const DAYS_OPTIONS = [14, 30, 90] as const
const API = '/api/smc/backtest?symbol=BTCUSDT'

type BtState =
  | { phase: 'idle' }
  | { phase: 'running'; days: number }
  | { phase: 'done'; data: BacktestResult }
  | { phase: 'error'; message: string; days: number }

function StatCell({ label, value, cls = 'text-tv-ink', sub }: { label: string; value: string; cls?: string; sub?: string }) {
  return (
    <div className="rounded-xl border border-tv-line bg-tv-panel2/60 px-3 py-2.5">
      <div className="text-[9.5px] font-bold uppercase tracking-[0.12em] text-tv-muted2">{label}</div>
      <div className={`mt-1 text-[17px] font-extrabold leading-none tabular-nums ${cls}`}>{value}</div>
      {sub && <div className="mt-1 text-[10px] text-tv-muted2">{sub}</div>}
    </div>
  )
}

const rCls = (r: number) => (r > 0 ? 'text-bull' : r < 0 ? 'text-bear' : 'text-tv-muted')

export function BacktestCard() {
  const [state, setState] = useState<BtState>({ phase: 'idle' })
  const [days, setDays] = useState<number>(30)

  const run = useCallback(
    async (d: number) => {
      setState({ phase: 'running', days: d })
      try {
        const res = await fetch(`${API}&days=${d}&mode=STRICT&folds=4`, { cache: 'no-store' })
        const body = (await res.json()) as BacktestResult | { ok: false; error: string }
        if (body.ok === false) {
          setState({ phase: 'error', message: body.error.slice(0, 200), days: d })
        } else if (!res.ok) {
          setState({ phase: 'error', message: `API ${res.status}`, days: d })
        } else {
          setState({ phase: 'done', data: body })
        }
      } catch (e) {
        setState({ phase: 'error', message: String(e instanceof Error ? e.message : e).slice(0, 200), days: d })
      }
    },
    [],
  )

  const fmtPf = (pf: number | null) => (pf === null ? '∞' : pf.toFixed(2))
  const fmtDay = (t: number) =>
    new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })

  return (
    <motion.section
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25, ease: 'easeOut', delay: 0.22 }}
      aria-label="Backtest"
      className="rounded-2xl border border-tv-line bg-tv-panel shadow-sm p-4 sm:p-5"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-[11px] font-bold uppercase tracking-[0.14em] text-tv-muted">
          Backtest <span className="normal-case tracking-normal text-tv-muted2">— pipeline replay · fixed params · no look-ahead · walk-forward folds</span>
        </h3>
        <div className="ml-auto flex flex-wrap items-center gap-1.5" role="group" aria-label="Backtest window">
          {DAYS_OPTIONS.map((d) => (
            <button
              key={d}
              onClick={() => setDays(d)}
              aria-pressed={days === d}
              suppressHydrationWarning
              className={`inline-flex min-h-[44px] items-center rounded-full border px-3 py-2 text-[11.5px] font-bold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bull/50 ${
                days === d ? 'border-info/40 bg-info/10 text-info' : 'border-tv-line bg-tv-panel2 text-tv-muted hover:border-tv-line-strong hover:text-tv-ink'
              }`}
            >
              {d}d
            </button>
          ))}
          <button
            onClick={() => void run(days)}
            disabled={state.phase === 'running'}
            suppressHydrationWarning
            className="inline-flex min-h-[44px] items-center gap-1.5 rounded-full border border-bull/40 bg-bull/10 px-4 py-2 text-[11.5px] font-bold text-bull transition hover:bg-bull/20 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bull/50"
          >
            {state.phase === 'running' ? (
              <>
                <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-bull/30 border-t-bull" aria-hidden="true" />
                replaying {state.days}d…
              </>
            ) : (
              <>⟳ Run backtest</>
            )}
          </button>
        </div>
      </div>

      {state.phase === 'idle' && (
        <p className="mt-3 text-[12px] leading-relaxed text-tv-muted2">
          Replays the exact live pipeline (same engines, same config gates) over historical candles with hard
          time-slicing so no decision ever sees a candle that hadn't closed. Runs on demand — it takes 10–30s.
        </p>
      )}

      {state.phase === 'error' && (
        <div role="status" className="mt-3 rounded-xl border border-bear/30 px-3 py-2.5 text-[12px]" style={{ background: 'var(--bear-soft)' }}>
          <span className="text-bear">Backtest failed: {state.message}</span>{' '}
          <button onClick={() => void run(state.days)} suppressHydrationWarning className="min-h-[44px] underline hover:text-tv-ink">
            retry
          </button>
        </div>
      )}

      {state.phase === 'done' && (
        <div className="mt-3 flex flex-col gap-3">
          {state.data.stats.trades === 0 ? (
            <p className="text-[12px] leading-relaxed text-tv-muted2">
              0 qualified setups in the last {state.data.days} days — the engine is conservative by design ({state.data.decisionPoints.toLocaleString('en-US')} decision points replayed).
            </p>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
                <StatCell label="Trades" value={String(state.data.stats.trades)} sub={`${state.data.stats.longs}L · ${state.data.stats.shorts}S`} />
                <StatCell
                  label="Win rate"
                  value={`${state.data.stats.winRatePct}%`}
                  cls={state.data.stats.winRatePct >= 50 ? 'text-bull' : state.data.stats.winRatePct > 0 ? 'text-warn' : 'text-tv-ink'}
                  sub={`${state.data.stats.breakevens} BE · ${state.data.stats.expired} exp`}
                />
                <StatCell label="Total" value={`${state.data.stats.totalR > 0 ? '+' : ''}${state.data.stats.totalR}R`} cls={rCls(state.data.stats.totalR)} />
                <StatCell label="Avg / trade" value={`${state.data.stats.avgR > 0 ? '+' : ''}${state.data.stats.avgR}R`} cls={rCls(state.data.stats.avgR)} />
                <StatCell label="Profit factor" value={fmtPf(state.data.stats.profitFactor)} />
                <StatCell label="Max drawdown" value={`−${state.data.stats.maxDrawdownR}R`} cls="text-bear" />
              </div>

              {/* walk-forward folds */}
              <div>
                <div className="mb-1.5 text-[9.5px] font-bold uppercase tracking-[0.12em] text-tv-muted2">
                  Walk-forward folds — consistent numbers across folds = stability
                </div>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                  {state.data.folds.map((f) => (
                    <div key={f.index} className="rounded-xl border border-tv-line bg-tv-panel2/60 px-3 py-2">
                      <div className="text-[9.5px] font-bold uppercase tracking-wider text-tv-muted2">
                        Fold {f.index} · {fmtDay(f.from)}–{fmtDay(f.to)}
                      </div>
                      <div className="mt-1 flex items-baseline gap-2 text-[12px] font-bold tabular-nums">
                        <span className="text-tv-ink">{f.stats.trades} tr</span>
                        <span className={f.stats.winRatePct >= 50 ? 'text-bull' : 'text-tv-muted'}>{f.stats.winRatePct}%</span>
                        <span className={rCls(f.stats.totalR)}>
                          {f.stats.totalR > 0 ? '+' : ''}
                          {f.stats.totalR}R
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <p className="text-[10.5px] leading-relaxed text-tv-muted2">
                {state.data.dataSource} · {state.data.candleCounts['5M'].toLocaleString('en-US')} 5M ·{' '}
                {state.data.candleCounts['1H'].toLocaleString('en-US')} 1H · {state.data.candleCounts['4H'].toLocaleString('en-US')} 4H ·{' '}
                {state.data.candleCounts['1D'].toLocaleString('en-US')} 1D candles · entry = OB-zone mid, pessimistic SL-first lifecycle.{' '}
                {state.data.disclaimer}
              </p>
            </>
          )}
        </div>
      )}
    </motion.section>
  )
}
