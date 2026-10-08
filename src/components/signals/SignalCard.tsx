'use client'

import { useState } from 'react'
import { motion } from 'framer-motion'
import { fmtPrice, type SignalRunDetail } from './types'

function lsGet(k: string, d: string): string {
  try {
    return localStorage.getItem(k) ?? d
  } catch {
    return d
  }
}

export function SignalCard({ run }: { run: SignalRunDetail }) {
  const [acct, setAcct] = useState(() => lsGet('tw_acct', ''))
  const [riskPct, setRiskPct] = useState(() => lsGet('tw_risk', '1'))
  const dir = run.direction
  const isLong = dir === 'LONG'
  const isShort = dir === 'SHORT'
  const cur = 'USD'

  const badgeCls = isLong
    ? 'bg-bull/15 text-bull border-bull/40'
    : isShort
      ? 'bg-bear/15 text-bear border-bear/40'
      : 'bg-warn/12 text-warn border-warn/40'

  const entryMid =
    run.entryLow !== null && run.entryHigh !== null ? (run.entryLow + run.entryHigh) / 2 : null
  const riskDist = entryMid !== null && run.stop !== null ? Math.abs(entryMid - run.stop) : null

  // position sizing — same math as the classic Trade2watch card
  let sizing: { unitsTxt: string; notional: string } | null = null
  const acctN = parseFloat(acct)
  const riskN = parseFloat(riskPct)
  if (acctN > 0 && riskDist && riskDist > 0 && riskN > 0) {
    const risk$ = (acctN * riskN) / 100
    const units = risk$ / riskDist
    const notional = units * (run.priceAtRun ?? 0)
    const unitName = run.market === 'crypto' ? run.symbol : 'shares'
    sizing = {
      unitsTxt: `${
        units >= 100 ? Math.round(units).toLocaleString('en-US') : Math.round(units * 10000) / 10000
      } ${unitName}`,
      notional: `notional ≈ ${fmtPrice(notional, cur)} · risk $${Math.round(risk$).toLocaleString('en-US')} · stop dist ${fmtPrice(riskDist, cur)}`,
    }
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25, ease: 'easeOut' }}
      className="rounded-2xl border border-tv-line bg-tv-panel shadow-sm overflow-hidden"
    >
      {/* header */}
      <div className="flex items-start justify-between gap-3 px-4 sm:px-5 py-4 border-b border-tv-line">
        <div className="min-w-0">
          <div className="flex items-center gap-2.5 flex-wrap">
            <h2 className="text-base font-bold tracking-tight text-tv-ink">
              {run.displayName || run.symbol} — {dir === 'NEUTRAL' ? 'STAND ASIDE' : `${dir} SETUP`}
            </h2>
            <span className={`px-3 py-1 rounded-full text-[11px] font-bold border ${badgeCls}`}>{dir}</span>
          </div>
          <p className="text-xs mt-1 tabular-nums text-tv-muted">
            {run.regime?.replace('_', ' ')} regime · {run.timeframe} candles · analyzed{' '}
            {new Date(run.createdAt).toLocaleTimeString()}
          </p>
        </div>
        <div className="text-right shrink-0">
          <div className="text-2xl sm:text-3xl font-bold tabular-nums" style={{ letterSpacing: '-1px' }}>
            {fmtPrice(run.priceAtRun, cur)}
          </div>
          <div
            className={`text-sm font-semibold tabular-nums ${
              run.change24h !== null && run.change24h >= 0 ? 'text-bull' : 'text-bear'
            }`}
          >
            {run.change24h !== null ? `${run.change24h >= 0 ? '+' : ''}${run.change24h.toFixed(2)}% 24h` : '—'}
          </div>
        </div>
      </div>

      {/* confidence */}
      <div className="px-4 sm:px-5 pt-4">
        <div className="flex justify-between text-xs mb-1.5 text-tv-muted">
          <span>Desk confidence</span>
          <span className="font-bold tabular-nums text-warn">{run.confidence ?? 0}%</span>
        </div>
        <div className="h-2 rounded-full bg-tv-panel2 border border-tv-line overflow-hidden">
          <div
            className="h-full rounded-full transition-all duration-700"
            style={{
              width: `${run.confidence ?? 0}%`,
              background: isLong ? 'var(--bull)' : isShort ? 'var(--bear)' : 'var(--warn)',
            }}
          />
        </div>
      </div>

      {/* plan rows */}
      <div className="px-4 sm:px-5 py-4">
        {dir !== 'NEUTRAL' && run.entryLow !== null ? (
          <>
            <Row k="Strategy" v={run.planNote ?? ''} noteCls />
            <Row k="Entry (limit zone)" v={`${fmtPrice(run.entryLow, cur)} – ${fmtPrice(run.entryHigh, cur)}`} cls="text-warn text-[15px] font-bold" />
            <Row k="Stop" v={fmtPrice(run.stop, cur)} cls="text-bear" />
            <Row k="Target 1 (half)" v={fmtPrice(run.target1, cur)} cls="text-info" />
            <Row k="Target 2 (trail)" v={fmtPrice(run.target2, cur)} cls="text-info" />
            {run.runner !== null && <Row k="Runner" v={fmtPrice(run.runner, cur)} cls="text-info" />}
            <Row k="Risk : Reward" v={run.riskReward ?? '—'} cls="text-bull" />
            <Row k="Invalidation" v={run.invalidation ?? '—'} cls="text-bear" />
          </>
        ) : (
          <div className="rounded-xl px-4 py-3 text-[13px] font-semibold text-center bg-warn/10 text-warn border border-warn/30">
            ⏳ {run.planNote || 'No edge detected — stand aside and wait for levels.'}
          </div>
        )}
      </div>

      {/* sizing */}
      {dir !== 'NEUTRAL' && run.entryLow !== null && (
        <div className="px-4 sm:px-5 pb-4 sm:pb-5">
          <div className="rounded-xl bg-tv-panel2 border border-tv-line p-4">
            <h4 className="text-[11px] font-bold uppercase tracking-[0.14em] mb-3 text-tv-muted">Position sizing</h4>
            <div className="flex gap-4 flex-wrap mb-2">
              <label className="flex flex-col gap-1.5 text-xs font-semibold text-tv-muted">
                Account size ($)
                <input
                  type="number"
                  min="0"
                  step="any"
                  value={acct}
                  onChange={(e) => {
                    setAcct(e.target.value)
                    try {
                      localStorage.setItem('tw_acct', e.target.value)
                    } catch {}
                  }}
                  suppressHydrationWarning
                  className="w-40 rounded-xl bg-tv-panel2 border border-tv-line px-3 py-2 text-sm text-tv-ink focus:outline-none focus:ring-2 focus:ring-bull/40 focus:border-bull/60 transition"
                />
              </label>
              <label className="flex flex-col gap-1.5 text-xs font-semibold text-tv-muted">
                Risk per trade (%)
                <input
                  type="number"
                  min="0"
                  max="100"
                  step="any"
                  value={riskPct}
                  onChange={(e) => {
                    setRiskPct(e.target.value)
                    try {
                      localStorage.setItem('tw_risk', e.target.value)
                    } catch {}
                  }}
                  suppressHydrationWarning
                  className="w-32 rounded-xl bg-tv-panel2 border border-tv-line px-3 py-2 text-sm text-tv-ink focus:outline-none focus:ring-2 focus:ring-bull/40 focus:border-bull/60 transition"
                />
              </label>
            </div>
            <div className="flex justify-between items-baseline gap-3 py-2 border-b border-dashed border-tv-div">
              <span className="text-[13px] text-tv-muted">Sized at worst-case entry</span>
              <span className="text-sm font-semibold text-right tabular-nums text-tv-ink">
                {sizing ? (
                  <>
                    {sizing.unitsTxt}
                    <small className="block text-[11.5px] font-normal tabular-nums text-tv-muted">{sizing.notional}</small>
                  </>
                ) : (
                  'Enter account size above'
                )}
              </span>
            </div>
          </div>
        </div>
      )}
    </motion.div>
  )
}

function Row({ k, v, cls, noteCls }: { k: string; v: string; cls?: string; noteCls?: boolean }) {
  return (
    <div className="flex justify-between items-start gap-3 py-2 border-b border-dashed border-tv-div last:border-0">
      <span className="text-[13px] shrink-0 pt-0.5 text-tv-muted">{k}</span>
      <span className={`text-sm font-semibold text-right tabular-nums ${cls ?? 'text-tv-ink'} ${noteCls ? 'text-left font-normal text-[13.5px] leading-relaxed max-w-[75%]' : ''}`}>
        {v}
      </span>
    </div>
  )
}
