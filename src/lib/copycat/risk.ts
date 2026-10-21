/**
 * Pre-trade risk check for the Copy Investor desk.
 *
 * Ported from trader-skill/trader-risk/check.py (MIT, Jake Schincariol),
 * reduced to the checks that apply here: the desk only ever proposes market
 * day BUY orders sized against a fresh account funded with the budget (there
 * is no linked brokerage account, no portfolio and no selling).
 *
 * Each order gets PASS or BLOCK with the reasons. Orders are checked in order
 * as if each PASS had filled, so five buys that are fine one by one but break
 * the cash buffer together are caught.
 *
 * What blocks an order here:
 *   format     missing symbol, both or neither of qty / notional
 *   asset      anything that is not a plain US stock ticker; options never
 *   blocked    a ticker on your blocked list
 *   size       under min_order_usd, over max_order_usd
 *   position   the stock would be over max_position_pct of the budget
 *   cash       the buy would dip into your cash buffer (running total)
 *   duplicate  the same symbol twice in this batch
 */

import type { SizeResult } from './size'

const TICKER_RE = /^[A-Z]{1,5}([.\-][A-Z]{1,2})?$/
const CENT = 0.005

export interface RiskLimits {
  budget: number
  cashBufferPct: number
  maxPositionPct: number
  minOrderUsd: number
  maxOrderUsd: number
  maxOrdersPerDay: number
  blocked: string[]
}

export interface RiskOrder {
  symbol: string
  notional: number // dollar value of the proposed buy
}

export interface RiskVerdict {
  symbol: string
  notional: number
  status: 'PASS' | 'BLOCK'
  reasons: string[]
}

export interface RiskResult {
  verdicts: RiskVerdict[]
  allPass: boolean
  cashAfter: number
}

export function riskLimitsFrom(sizing: SizeResult, maxOrderUsd = 2000, maxOrdersPerDay = 10): RiskLimits {
  return {
    budget: sizing.budget,
    cashBufferPct: sizing.cashBufferPct,
    maxPositionPct: sizing.maxPositionPct,
    minOrderUsd: sizing.minOrderUsd,
    maxOrderUsd,
    maxOrdersPerDay,
    blocked: [],
  }
}

function money(x: number): string {
  return `$${x.toLocaleString('en-US', { maximumFractionDigits: 2 })}`
}

/**
 * Check proposed buy orders against the limits. Starts from a fresh account
 * funded with the budget; each PASS deducts cash as if it filled.
 */
export function checkOrders(orders: RiskOrder[], limits: RiskLimits): RiskResult {
  const verdicts: RiskVerdict[] = []
  const buffer = (limits.budget * limits.cashBufferPct) / 100
  const capValue = (limits.budget * limits.maxPositionPct) / 100
  const held = new Map<string, number>() // symbol → value bought so far in this batch
  const seen = new Set<string>()
  let cash = limits.budget

  for (const o of orders) {
    const reasons: string[] = []
    const symbol = String(o.symbol ?? '').trim().toUpperCase()
    const notional = Number(o.notional ?? 0)

    // format
    if (!symbol) reasons.push('order has no symbol')
    if (!(notional > 0)) reasons.push('order has no dollar amount')

    // asset — plain US stock tickers only; the desk never proposes options
    if (symbol && !TICKER_RE.test(symbol)) reasons.push(`"${symbol}" is not a plain US stock ticker`)

    // blocked
    if (limits.blocked.map((b) => b.toUpperCase()).includes(symbol))
      reasons.push(`${symbol} is on your blocked list`)

    // size
    if (notional > 0 && notional < limits.minOrderUsd - CENT)
      reasons.push(`order ${money(notional)} is under your ${money(limits.minOrderUsd)} minimum`)
    if (notional > 0 && notional > limits.maxOrderUsd + CENT)
      reasons.push(`order ${money(notional)} is over your ${money(limits.maxOrderUsd)} maximum order size`)

    // position cap
    if (symbol && notional > 0) {
      const after = (held.get(symbol) ?? 0) + notional
      if (after > capValue + CENT)
        reasons.push(
          `${symbol} would hold ${money(after)}, over your ${limits.maxPositionPct}% (${money(capValue)}) position cap`,
        )
    }

    // cash buffer (running)
    if (notional > 0) {
      const cashAfter = cash - notional
      if (cashAfter < buffer - CENT)
        reasons.push(
          `buying would dip into your ${money(buffer)} cash buffer (${money(Math.max(cashAfter, 0))} cash would remain)`,
        )
    }

    // duplicate in batch
    if (seen.has(symbol)) reasons.push(`second order for ${symbol} in this batch`)
    seen.add(symbol)

    const status: RiskVerdict['status'] = reasons.length ? 'BLOCK' : 'PASS'
    if (status === 'PASS') {
      cash -= notional
      if (symbol) held.set(symbol, (held.get(symbol) ?? 0) + notional)
    }
    verdicts.push({ symbol, notional, status, reasons })
  }

  return { verdicts, allPass: verdicts.every((v) => v.status === 'PASS'), cashAfter: cash }
}
