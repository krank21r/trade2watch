'use client'

import { useState } from 'react'
import { fmtPrice, type SignalRunDetail } from './types'

// Trade2watch design tokens (mirrors public/app.html)
const C = {
  panel: 'bg-[#131722] border-[#232b3d]',
  panel2: 'bg-[#1a2030] border-[#232b3d]',
  muted: 'text-[#8b93a7]',
  text: 'text-[#e6e9f0]',
  green: 'text-[#26a69a]',
  red: 'text-[#ef5350]',
  amber: 'text-[#f5b544]',
  blue: 'text-[#4a9eff]',
}

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
    ? 'bg-[rgba(38,166,154,.15)] text-[#26a69a] border-[rgba(38,166,154,.4)]'
    : isShort
      ? 'bg-[rgba(239,83,80,.15)] text-[#ef5350] border-[rgba(239,83,80,.4)]'
      : 'bg-[rgba(245,181,68,.12)] text-[#f5b544] border-[rgba(245,181,68,.4)]'

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
    <div className={`rounded-[14px] border ${C.panel} overflow-hidden`}>
      {/* header */}
      <div className="flex items-center justify-between gap-3 px-5 py-4 border-b border-[#232b3d]">
        <div className="min-w-0">
          <div className="flex items-center gap-2.5 flex-wrap">
            <h2 className={`text-base font-bold ${C.text}`}>
              {run.displayName || run.symbol} — {dir === 'NEUTRAL' ? 'STAND ASIDE' : `${dir} SETUP`}
            </h2>
            <span className={`badge px-3 py-1 rounded-full text-[11px] font-bold border ${badgeCls}`}>{dir}</span>
          </div>
          <p className={`text-xs mt-1 ${C.muted}`}>
            {run.regime?.replace('_', ' ')} regime · {run.timeframe} candles · analyzed{' '}
            {new Date(run.createdAt).toLocaleTimeString()}
          </p>
        </div>
        <div className="text-right shrink-0">
          <div className="text-2xl font-bold tabular-nums" style={{ letterSpacing: '-1px' }}>
            {fmtPrice(run.priceAtRun, cur)}
          </div>
          <div className={`text-sm font-semibold ${run.change24h !== null && run.change24h >= 0 ? C.green : C.red}`}>
            {run.change24h !== null ? `${run.change24h >= 0 ? '+' : ''}${run.change24h.toFixed(2)}% 24h` : '—'}
          </div>
        </div>
      </div>

      {/* confidence */}
      <div className="px-5 pt-4">
        <div className={`flex justify-between text-xs mb-1.5 ${C.muted}`}>
          <span>Desk confidence</span>
          <span className="font-bold" style={{ color: '#f5b544' }}>
            {run.confidence ?? 0}%
          </span>
        </div>
        <div className="h-2 rounded-full bg-[#1a2030] overflow-hidden border border-[#232b3d]">
          <div
            className="h-full rounded-full transition-all duration-700"
            style={{
              width: `${run.confidence ?? 0}%`,
              background: isLong ? '#26a69a' : isShort ? '#ef5350' : '#f5b544',
            }}
          />
        </div>
      </div>

      {/* plan rows */}
      <div className="px-5 py-4">
        {dir !== 'NEUTRAL' && run.entryLow !== null ? (
          <>
            <Row k="Strategy" v={run.planNote ?? ''} noteCls />
            <Row k="Entry (limit zone)" v={`${fmtPrice(run.entryLow, cur)} – ${fmtPrice(run.entryHigh, cur)}`} cls="text-[#f5b544] text-[15px]" />
            <Row k="Stop" v={fmtPrice(run.stop, cur)} cls={C.red} />
            <Row k="Target 1 (half)" v={fmtPrice(run.target1, cur)} cls={C.blue} />
            <Row k="Target 2 (trail)" v={fmtPrice(run.target2, cur)} cls={C.blue} />
            {run.runner !== null && <Row k="Runner" v={fmtPrice(run.runner, cur)} cls={C.blue} />}
            <Row k="Risk : Reward" v={run.riskReward ?? '—'} cls={C.green} />
            <Row k="Invalidation" v={run.invalidation ?? '—'} cls={C.red} />
          </>
        ) : (
          <div className="rounded-lg px-4 py-3 text-[13px] font-semibold text-center bg-[rgba(245,181,68,.1)] text-[#f5b544] border border-[rgba(245,181,68,.3)]">
            ⏳ {run.planNote || 'No edge detected — stand aside and wait for levels.'}
          </div>
        )}
      </div>

      {/* sizing */}
      {dir !== 'NEUTRAL' && run.entryLow !== null && (
        <div className="px-5 pb-5">
          <div className={`rounded-[10px] border p-4 ${C.panel2}`}>
            <h4 className={`text-[11px] font-bold tracking-widest uppercase mb-3 ${C.muted}`}>Position sizing</h4>
            <div className="flex gap-4 flex-wrap mb-2">
              <label className={`flex flex-col gap-1.5 text-xs font-semibold ${C.muted}`}>
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
                  className="bg-[#1a2030] border border-[#232b3d] rounded-lg px-2.5 py-2 text-sm w-40 text-[#e6e9f0] outline-none focus:border-[#f5b544]"
                />
              </label>
              <label className={`flex flex-col gap-1.5 text-xs font-semibold ${C.muted}`}>
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
                  className="bg-[#1a2030] border border-[#232b3d] rounded-lg px-2.5 py-2 text-sm w-32 text-[#e6e9f0] outline-none focus:border-[#f5b544]"
                />
              </label>
            </div>
            <div className="flex justify-between items-baseline gap-3 py-2 border-b border-dashed border-white/5">
              <span className={`text-[13px] ${C.muted}`}>Sized at worst-case entry</span>
              <span className={`text-sm font-semibold text-right ${C.text}`}>
                {sizing ? (
                  <>
                    {sizing.unitsTxt}
                    <small className={`block text-[11.5px] font-normal ${C.muted}`}>{sizing.notional}</small>
                  </>
                ) : (
                  'Enter account size above'
                )}
              </span>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function Row({ k, v, cls, noteCls }: { k: string; v: string; cls?: string; noteCls?: boolean }) {
  return (
    <div className="flex justify-between items-start gap-3 py-2 border-b border-dashed border-white/5 last:border-0">
      <span className={`text-[13px] shrink-0 pt-0.5 text-[#8b93a7]`}>{k}</span>
      <span className={`text-sm font-semibold text-right ${cls ?? 'text-[#e6e9f0]'} ${noteCls ? 'text-left font-normal text-[13.5px] leading-relaxed max-w-[75%]' : ''}`}>
        {v}
      </span>
    </div>
  )
}
