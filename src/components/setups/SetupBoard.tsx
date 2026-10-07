'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { fmtPrice } from '@/components/signals/types'
import type { BoardSetup, SetupsPayload, SideSetup } from '@/lib/setups/generate'

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

const QUICK = ['BTC', 'ETH', 'SOL', 'AAPL', 'TSLA', 'NVDA']
const POLL_MS = 45_000

function lsGet(k: string, d: string): string {
  try {
    return localStorage.getItem(k) ?? d
  } catch {
    return d
  }
}

const chipCls: Record<string, string> = {
  liveShort: 'bg-[rgba(239,83,80,.15)] text-[#ef5350] border-[rgba(239,83,80,.45)]',
  liveLong: 'bg-[rgba(38,166,154,.15)] text-[#26a69a] border-[rgba(38,166,154,.45)]',
  waiting: 'bg-[rgba(245,181,68,.1)] text-[#f5b544] border-[rgba(245,181,68,.35)]',
  void: 'bg-[rgba(139,147,167,.12)] text-[#8b93a7] border-[#3a4560]',
}

/** One-chip summary per asset for the ZoneWatch strip. */
function summarize(s: BoardSetup): { cls: string; txt: string } {
  const l = s.long
  const sh = s.short
  if (sh?.state === 'LIVE') return { cls: chipCls.liveShort, txt: 'SHORT ZONE LIVE' }
  if (l?.state === 'LIVE') return { cls: chipCls.liveLong, txt: 'LONG ZONE LIVE' }
  const waits: string[] = []
  if (l?.state === 'WAITING' && l.distPct !== null) waits.push(`${l.distPct.toFixed(1)}% to LONG`)
  if (sh?.state === 'WAITING' && sh.distPct !== null) waits.push(`${sh.distPct.toFixed(1)}% to SHORT`)
  const voids: string[] = []
  if (l?.state === 'VOID') voids.push('LONG void')
  if (sh?.state === 'VOID') voids.push('SHORT void')
  if (voids.length === 2) return { cls: chipCls.void, txt: 'SETUP VOID' }
  if (waits.length === 0 && voids.length === 1) return { cls: chipCls.void, txt: `${voids[0].toUpperCase()} — WAIT` }
  if (voids.length === 1) return { cls: chipCls.waiting, txt: `${waits[0]} · ${voids[0]}` }
  return { cls: chipCls.waiting, txt: waits.length ? `WAITING · ${waits.join(' · ')}` : 'WAITING' }
}

function SideCard({ side, kind, symbol, currency }: { side: SideSetup; kind: 'long' | 'short'; symbol: string; currency: string }) {
  const isLong = kind === 'long'
  const badgeCls = isLong ? chipCls.liveLong : chipCls.liveShort
  const stateChip =
    side.state === 'LIVE' ? (
      <span className={`px-2.5 py-0.5 rounded-full text-[10px] font-bold border ${badgeCls}`}>
        {isLong ? 'LONG ZONE LIVE' : 'SHORT ZONE LIVE'}
      </span>
    ) : side.state === 'VOID' ? (
      <span className={`px-2.5 py-0.5 rounded-full text-[10px] font-bold border ${chipCls.void}`}>VOID — THESIS DEAD</span>
    ) : (
      <span className={`px-2.5 py-0.5 rounded-full text-[10px] font-bold border ${chipCls.waiting}`}>
        WAITING · {side.dist !== null && fmtPrice(side.dist, currency)} ({side.distPct?.toFixed(1)}%) to zone
      </span>
    )

  return (
    <div className={`rounded-[14px] border ${C.panel} p-5 flex flex-col gap-3`}>
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h3 className={`text-[15px] font-bold ${C.text}`}>{side.strategy}</h3>
          <p className={`text-[11px] mt-0.5 ${C.muted}`}>{side.trigger}</p>
        </div>
        <span className={`px-2.5 py-1 rounded-full text-[10px] font-bold border ${side.tag === 'PREFERRED' ? 'bg-[rgba(245,181,68,.14)] text-[#f5b544] border-[rgba(245,181,68,.45)]' : badgeCls}`}>
          {side.tag}
        </span>
      </div>
      <div>{stateChip}</div>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-2 text-[13px]">
        <Cell k={`Entry zone (limit)`} v={`${fmtPrice(side.entryLow, currency)} – ${fmtPrice(side.entryHigh, currency)}`} cls={C.amber} strong />
        <Cell k="Stop" v={fmtPrice(side.stop, currency)} sub={side.stopNote} cls={C.red} />
        <Cell k="Target 1" v={fmtPrice(side.t1, currency)} cls={C.blue} />
        <Cell k="Target 2" v={fmtPrice(side.t2, currency)} cls={C.blue} />
        {side.runner !== null && <Cell k="Runner" v={fmtPrice(side.runner, currency)} cls={C.blue} />}
        <Cell k="Risk : Reward" v={side.rr} cls={C.green} />
      </div>
      <p className={`text-[12px] ${C.red}`}>⛔ {side.invalidation}</p>
      <p className={`text-[11px] ${C.muted}`}>
        Sizing: risk ÷ ({fmtPrice((side.entryLow + side.entryHigh) / 2, currency)} − {fmtPrice(side.stop, currency)}) — auto-calculated below.
      </p>
      <span className="sr-only">{symbol} {side.strategy} setup</span>
    </div>
  )
}

function Cell({ k, v, sub, cls, strong }: { k: string; v: string; sub?: string; cls: string; strong?: boolean }) {
  return (
    <div>
      <div className={`text-[11px] ${C.muted}`}>{k}</div>
      <div className={`font-semibold tabular-nums ${cls} ${strong ? 'text-[15px]' : ''}`}>{v}</div>
      {sub && <div className={`text-[10px] ${C.muted}`}>{sub}</div>}
    </div>
  )
}

export function SetupBoard() {
  const [symbols, setSymbols] = useState<string[]>(['BTC', 'ETH', 'SOL'])
  const [data, setData] = useState<SetupsPayload | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState('BTC')
  const [input, setInput] = useState('')
  const [dismissed, setDismissed] = useState<Set<string>>(new Set())
  const [acct, setAcct] = useState('')
  const [riskPct, setRiskPct] = useState('1')
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    setAcct(lsGet('tw_acct', ''))
    setRiskPct(lsGet('tw_risk', '1'))
    return () => {
      mounted.current = false
    }
  }, [])

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/setups?symbols=${symbols.join(',')}`, { cache: 'no-store' })
      if (!res.ok) throw new Error(`API ${res.status}`)
      const d = (await res.json()) as SetupsPayload
      if (!mounted.current) return
      setData(d)
      setError(null)
    } catch (e) {
      if (mounted.current) setError(String(e).slice(0, 120))
    } finally {
      if (mounted.current) setLoading(false)
    }
  }, [symbols])

  useEffect(() => {
    setLoading(true)
    load()
    const t = setInterval(load, POLL_MS)
    return () => clearInterval(t)
  }, [load])

  // keep selection valid
  const active: BoardSetup | undefined =
    data?.setups.find((s) => s.symbol === selected) ?? data?.setups[0]

  const persist = (k: string, v: string, setter: (x: string) => void) => {
    setter(v)
    try {
      localStorage.setItem(k, v)
    } catch { /* private mode */ }
  }

  const addSymbol = () => {
    const s = input.trim().toUpperCase()
    if (!/^[A-Z0-9.\-]{1,10}$/.test(s)) return
    if (!symbols.includes(s)) setSymbols((prev) => [...prev, s].slice(0, 8))
    setSelected(s)
    setInput('')
  }

  const savePct = (x: number, min: number, max: number) => Math.min(max, Math.max(min, x))

  const sizingFor = (side: SideSetup | null) => {
    if (!side) return null
    const a = parseFloat(acct)
    const r = parseFloat(riskPct)
    if (!(a > 0) || !(r > 0)) return null
    const mid = (side.entryLow + side.entryHigh) / 2
    const dist = Math.abs(mid - side.stop)
    if (!(dist > 0)) return null
    const riskDollars = (a * r) / 100
    const units = riskDollars / dist
    const notional = units * (active?.price ?? mid)
    const unitName = active?.market === 'crypto' ? (active?.symbol ?? '') : 'shares'
    return {
      unitsTxt: `${units >= 100 ? Math.round(units).toLocaleString('en-US') : Math.round(units * 10000) / 10000} ${unitName}`,
      notionalTxt: `notional ≈ ${fmtPrice(notional, 'USD')} · risk $${Math.round(riskDollars).toLocaleString('en-US')} · stop dist ${fmtPrice(dist, 'USD')}`,
    }
  }

  const banners: Array<{ key: string; side: 'long' | 'short'; setup: BoardSetup; s: SideSetup }> = []
  for (const setup of data?.setups ?? []) {
    if (setup.long?.state === 'LIVE' && !dismissed.has(`${setup.symbol}:long`))
      banners.push({ key: `${setup.symbol}:long`, side: 'long', setup, s: setup.long })
    if (setup.short?.state === 'LIVE' && !dismissed.has(`${setup.symbol}:short`))
      banners.push({ key: `${setup.symbol}:short`, side: 'short', setup, s: setup.short })
  }

  const gaugePct = (v: number) =>
    active ? savePct(((v - active.gauge.min) / (active.gauge.max - active.gauge.min)) * 100, 0, 100) : 0

  return (
    <div className="min-h-full flex flex-col px-4 sm:px-6 py-5 gap-5 max-w-6xl w-full mx-auto">
      {/* toolbar */}
      <div className={`rounded-[14px] border ${C.panel} p-4 flex flex-wrap items-center gap-2.5`}>
        <div className={`text-[13px] font-bold mr-1 ${C.text}`}>Watchlist</div>
        {(data?.setups ?? []).map((s) => (
          <button
            key={s.symbol}
            onClick={() => setSelected(s.symbol)}
            suppressHydrationWarning
            aria-pressed={active?.symbol === s.symbol}
            className={`px-3 py-1.5 rounded-full text-[12px] font-semibold border transition-colors ${
              active?.symbol === s.symbol
                ? 'bg-[#1a2030] text-[#f5b544] border-[rgba(245,181,68,.45)]'
                : 'bg-transparent text-[#8b93a7] border-[#232b3d] hover:text-[#e6e9f0] hover:border-[#3a4560]'
            }`}
          >
            {s.symbol}
          </button>
        ))}
        <div className="flex items-center gap-1.5 ml-auto flex-wrap">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && addSymbol()}
            placeholder="Add symbol (BTC, AAPL…)"
            aria-label="Add symbol"
            suppressHydrationWarning
            className={`w-40 sm:w-48 px-3 py-1.5 rounded-lg text-[12px] ${C.panel2} border border-[#232b3d] ${C.text} placeholder:text-[#5a6377] focus:outline-none focus:border-[#f5b544]/50`}
          />
          <button
            onClick={addSymbol}
            suppressHydrationWarning
            className="px-3 py-1.5 rounded-lg text-[12px] font-semibold bg-[#1a2030] border border-[#232b3d] text-[#e6e9f0] hover:border-[#f5b544]/50 transition-colors"
          >
            + Add
          </button>
          <button
            onClick={() => { setLoading(true); load() }}
            suppressHydrationWarning
            className="px-3 py-1.5 rounded-lg text-[12px] font-semibold bg-[#1a2030] border border-[#232b3d] text-[#e6e9f0] hover:border-[#f5b544]/50 transition-colors"
            aria-label="Refresh setups"
          >
            ⟳ Refresh
          </button>
        </div>
        <div className={`w-full flex flex-wrap items-center gap-2 text-[11px] ${C.muted}`}>
          <span>Quick:</span>
          {QUICK.filter((q) => !symbols.includes(q)).map((q) => (
            <button
              key={q}
              onClick={() => { setSymbols((prev) => [...prev, q].slice(0, 8)); setSelected(q) }}
              suppressHydrationWarning
              className="px-2 py-0.5 rounded-full border border-[#232b3d] hover:border-[#3a4560] hover:text-[#e6e9f0] transition-colors"
            >
              +{q}
            </button>
          ))}
          <span className="ml-auto">
            {data ? `Live · regenerated ${new Date(data.updatedAt).toLocaleTimeString()} · auto every 45s` : 'connecting…'}
          </span>
        </div>
      </div>

      {/* live-zone banners — only fire when price is genuinely inside a zone */}
      {banners.map((b) => (
        <div
          key={b.key}
          role="status"
          className={`rounded-xl px-4 py-3 text-[13px] font-semibold border flex items-center gap-3 ${
            b.side === 'long'
              ? 'bg-[rgba(38,166,154,.12)] text-[#26a69a] border-[rgba(38,166,154,.4)]'
              : 'bg-[rgba(239,83,80,.12)] text-[#ef5350] border-[rgba(239,83,80,.4)]'
          }`}
        >
          <span>
            {b.side === 'long' ? '🟢' : '🔴'} {b.setup.symbol} {b.side.toUpperCase()} ZONE ACTIVE — price {fmtPrice(b.setup.price, b.setup.currency)}{' '}
            {b.side === 'long' ? '≤' : '≥'} {fmtPrice(b.side === 'long' ? b.s.entryHigh : b.s.entryLow, b.setup.currency)}. Limit{' '}
            {fmtPrice(b.s.entryLow, b.setup.currency)} – {fmtPrice(b.s.entryHigh, b.setup.currency)}, stop {fmtPrice(b.s.stop, b.setup.currency)}, T1{' '}
            {fmtPrice(b.s.t1, b.setup.currency)}, T2 {fmtPrice(b.s.t2, b.setup.currency)}.
          </span>
          <button
            onClick={() => setDismissed((prev) => new Set(prev).add(b.key))}
            aria-label={`Dismiss ${b.setup.symbol} ${b.side} banner`}
            suppressHydrationWarning
            className="ml-auto shrink-0 w-7 h-7 rounded-full bg-[rgba(255,255,255,.08)] hover:bg-[rgba(255,255,255,.16)] text-[#e6e9f0] text-xs"
          >
            ✕
          </button>
        </div>
      ))}

      {/* ZoneWatch strip */}
      <section aria-label="ZoneWatch — live zone monitor">
        <h2 className={`text-[13px] font-bold mb-2 ${C.text}`}>ZoneWatch — every zone, one board</h2>
        {loading && !data ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {[0, 1, 2].map((i) => (
              <div key={i} className={`h-[92px] rounded-[14px] border ${C.panel} animate-pulse`} />
            ))}
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {(data?.setups ?? []).map((s) => {
              const chip = summarize(s)
              return (
                <button
                  key={s.symbol}
                  onClick={() => setSelected(s.symbol)}
                  suppressHydrationWarning
                  aria-pressed={active?.symbol === s.symbol}
                  className={`text-left rounded-[14px] border p-4 transition-colors ${
                    active?.symbol === s.symbol ? 'border-[rgba(245,181,68,.45)] bg-[#1a2030]' : `${C.panel} hover:border-[#3a4560]`
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className={`text-[13px] font-bold ${C.text}`}>
                      {s.displayName} <span className={C.muted}>· {s.pair}</span>
                    </span>
                    <span className={`text-[12px] font-semibold ${s.change24h >= 0 ? C.green : C.red}`}>
                      {s.change24h >= 0 ? '+' : ''}{s.change24h.toFixed(2)}%
                    </span>
                  </div>
                  <div className="text-xl font-bold tabular-nums mt-1" style={{ letterSpacing: '-1px' }}>
                    {fmtPrice(s.price, s.currency)}
                  </div>
                  <div className="mt-2">
                    <span className={`inline-block px-2.5 py-0.5 rounded-full text-[10px] font-bold border ${chip.cls}`}>{chip.txt}</span>
                  </div>
                </button>
              )
            })}
          </div>
        )}
        {data && Object.keys(data.failed).length > 0 && (
          <p className={`text-[11px] mt-2 ${C.muted}`}>
            No data: {Object.entries(data.failed).map(([k, v]) => `${k} (${v.slice(0, 40)})`).join(', ')}
          </p>
        )}
        {error && (
          <p className="text-[12px] mt-2 text-[#ef5350]">
            Feed error: {error} — retrying automatically.{' '}
            <button onClick={() => { setLoading(true); load() }} suppressHydrationWarning className="underline">Retry now</button>
          </p>
        )}
      </section>

      {/* selected asset detail */}
      {active && (
        <section aria-label={`${active.displayName} setup detail`} className="flex flex-col gap-5">
          {/* header + gauge */}
          <div className={`rounded-[14px] border ${C.panel} p-5`}>
            <div className="flex items-start justify-between gap-4 flex-wrap">
              <div>
                <div className="flex items-center gap-2.5 flex-wrap">
                  <h2 className={`text-lg font-bold ${C.text}`}>
                    {active.displayName} — {active.pair}
                  </h2>
                  <span className="px-2.5 py-0.5 rounded-full text-[10px] font-bold border bg-[rgba(74,158,255,.12)] text-[#4a9eff] border-[rgba(74,158,255,.4)]">
                    {active.biasTag}
                  </span>
                </div>
                <p className={`text-xs mt-1 ${C.muted}`}>
                  {active.regime.replace('_', ' ')} regime · {active.timeframe} candles · RSI(14){' '}
                  <b className={active.rsi !== null ? (active.rsi >= 70 ? C.red : active.rsi <= 30 ? C.green : C.text) : ''}>
                    {active.rsi !== null ? active.rsi.toFixed(1) : '—'}
                  </b>{' '}
                  · ATR {active.atrPct !== null ? `${active.atrPct.toFixed(2)}%` : '—'}
                </p>
              </div>
              <div className="text-right">
                <div className="text-3xl font-bold tabular-nums" style={{ letterSpacing: '-1px' }}>
                  {fmtPrice(active.price, active.currency)}
                </div>
                <div className={`text-sm font-semibold ${active.change24h >= 0 ? C.green : C.red}`}>
                  {active.change24h >= 0 ? '+' : ''}{active.change24h.toFixed(2)}% 24h
                </div>
              </div>
            </div>

            <p className={`text-[13px] mt-3 ${C.amber}`}>{active.biasNote}</p>

            {/* gauge */}
            <div className="mt-4" aria-hidden="true">
              <div className="relative h-3 rounded-full bg-[#0b0e14] border border-[#232b3d] overflow-visible">
                {active.long && (
                  <div
                    className="absolute top-0 h-full rounded-full bg-[rgba(38,166,154,.55)]"
                    style={{ left: `${gaugePct(active.long.entryLow)}%`, width: `${Math.max(gaugePct(active.long.entryHigh) - gaugePct(active.long.entryLow), 1.5)}%` }}
                  />
                )}
                {active.short && (
                  <div
                    className="absolute top-0 h-full rounded-full bg-[rgba(239,83,80,.55)]"
                    style={{ left: `${gaugePct(active.short.entryLow)}%`, width: `${Math.max(gaugePct(active.short.entryHigh) - gaugePct(active.short.entryLow), 1.5)}%` }}
                  />
                )}
                <div
                  className="absolute -top-1.5 -bottom-1.5 w-[2px] bg-white"
                  style={{ left: `${gaugePct(active.price)}%` }}
                />
              </div>
              <div className="flex justify-between text-[10px] mt-1.5" style={{ color: '#5a6377' }}>
                <span>{fmtPrice(active.gauge.min, active.currency)}</span>
                <span className="text-[#e6e9f0] font-semibold">▲ {fmtPrice(active.price, active.currency)}</span>
                <span>{fmtPrice(active.gauge.max, active.currency)}</span>
              </div>
              <div className={`text-[11px] mt-1 ${C.muted}`}>
                <span className="text-[#26a69a]">■</span> long zone&nbsp;&nbsp;
                <span className="text-[#ef5350]">■</span> short zone&nbsp;&nbsp;— zones regenerate with market structure
              </div>
            </div>
          </div>

          {/* setup cards — preferred side first */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {([['long', active.long], ['short', active.short]] as Array<['long' | 'short', SideSetup | null]>)
              .filter((pair): pair is ['long' | 'short', SideSetup] => pair[1] !== null)
              .sort((a, b) => (a[1].tag === 'PREFERRED' ? -1 : 0) - (b[1].tag === 'PREFERRED' ? -1 : 0))
              .map(([kind, side]) => (
                <SideCard key={kind} side={side} kind={kind} symbol={active.symbol} currency={active.currency} />
              ))}
          </div>

          {/* sizing */}
          <div className={`rounded-[14px] border ${C.panel} p-5`}>
            <h3 className={`text-[13px] font-bold mb-3 ${C.text}`}>Position sizing — risk-first</h3>
            <div className="flex flex-wrap gap-3 mb-4">
              <label className={`text-[12px] ${C.muted}`}>
                <span className="block mb-1">Account ($)</span>
                <input
                  value={acct}
                  onChange={(e) => persist('tw_acct', e.target.value, setAcct)}
                  inputMode="decimal"
                  placeholder="10000"
                  suppressHydrationWarning
                  className={`w-36 px-3 py-2 rounded-lg text-[13px] ${C.panel2} border border-[#232b3d] ${C.text} placeholder:text-[#5a6377] focus:outline-none focus:border-[#f5b544]/50`}
                />
              </label>
              <label className={`text-[12px] ${C.muted}`}>
                <span className="block mb-1">Risk per trade (%)</span>
                <input
                  value={riskPct}
                  onChange={(e) => persist('tw_risk', e.target.value, setRiskPct)}
                  inputMode="decimal"
                  placeholder="1"
                  suppressHydrationWarning
                  className={`w-28 px-3 py-2 rounded-lg text-[13px] ${C.panel2} border border-[#232b3d] ${C.text} placeholder:text-[#5a6377] focus:outline-none focus:border-[#f5b544]/50`}
                />
              </label>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-[13px]">
              {([['long', active.long], ['short', active.short]] as Array<['long' | 'short', SideSetup | null]>).map(
                ([kind, side]) => {
                  const sz = sizingFor(side)
                  const label = kind === 'long' ? 'LONG side' : 'SHORT side'
                  return (
                    <div key={kind} className={`rounded-lg border ${C.panel2} p-3`}>
                      <div className={`text-[11px] font-bold mb-1 ${C.amber}`}>{label}</div>
                      {sz ? (
                        <>
                          <div className={`font-bold ${C.text}`}>{sz.unitsTxt}</div>
                          <div className={`text-[11px] ${C.muted}`}>{sz.notionalTxt}</div>
                        </>
                      ) : (
                        <div className={C.muted}>Enter account &amp; risk to size</div>
                      )}
                    </div>
                  )
                },
              )}
            </div>
          </div>

          {/* key levels */}
          <div className={`rounded-[14px] border ${C.panel} p-5`}>
            <h3 className={`text-[13px] font-bold mb-3 ${C.text}`}>Key levels — live structure</h3>
            <ul className="flex flex-col gap-1.5">
              {active.levels.map((l, i) => (
                <li key={i} className="flex items-baseline gap-3 text-[13px]">
                  <span className={`w-28 shrink-0 font-semibold tabular-nums whitespace-nowrap ${l.t === 'res' ? C.red : l.t === 'sup' ? C.green : C.blue}`}>
                    {l.t === 'res' ? 'RES' : l.t === 'sup' ? 'SUP' : 'EMA'} {fmtPrice(l.v, active.currency)}
                  </span>
                  <span className={C.muted}>{l.w}</span>
                </li>
              ))}
            </ul>
          </div>
        </section>
      )}

      {/* footer / disclaimer */}
      <footer className={`mt-auto pt-2 pb-4 text-[11px] leading-relaxed ${C.muted} border-t border-[#232b3d]`}>
        Setups are <b className={C.text}>auto-generated from live market data</b> (Binance · Yahoo Finance) every 45 seconds — levels
        follow the market, so they never go stale.{' '}
        <a href="/app.html" target="_blank" rel="noreferrer" className="underline hover:text-[#e6e9f0]">
          Legacy static view ↗
        </a>
        <br />
        <b className={C.amber}>Disclaimer:</b> Technical analysis of public market data for decision support only. Not financial
        advice — no auto-trading. Crypto and stocks are volatile; never trade money you can&apos;t afford to lose.
      </footer>
    </div>
  )
}
