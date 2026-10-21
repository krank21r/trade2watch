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

/**
 * A starting account state (the paper desk). When omitted, checkOrders keeps
 * its original behaviour: a fresh account funded with the budget.
 */
export interface StartAccount {
  cash: number
  /** symbol → current position value in USD */
  positions: Record<string, number>
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
 * funded with the budget (or from `start` — the paper desk's cash and
 * positions); each PASS deducts cash as if it filled.
 */
export function checkOrders(orders: RiskOrder[], limits: RiskLimits, start?: StartAccount): RiskResult {
  const verdicts: RiskVerdict[] = []
  const startCash = start ? start.cash : limits.budget
  const startPositions = start ? start.positions : {}
  const startTotal = startCash + Object.values(startPositions).reduce((s, v) => s + v, 0)
  const buffer = (startTotal * limits.cashBufferPct) / 100
  const capValue = (startTotal * limits.maxPositionPct) / 100
  const held = new Map<string, number>(
    Object.entries(startPositions).map(([s, v]) => [s.toUpperCase(), v]),
  ) // symbol → value held (existing + bought so far in this batch)
  const seen = new Set<string>()
  let cash = startCash

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

export interface SellOrder {
  symbol: string
  notional: number // dollar value of the proposed sell
}

/**
 * Check proposed SELL orders (the rebalancer's trims). Selling is only ever a
 * reduction of what the paper desk already holds — short selling is off,
 * exactly as in check.py's "short" rule. Each PASS adds the proceeds to cash
 * so later sells in the same batch see the updated holdings.
 */
export function checkSellOrders(
  orders: SellOrder[],
  limits: Pick<RiskLimits, 'minOrderUsd' | 'maxOrderUsd'>,
  start: StartAccount,
): RiskResult {
  const verdicts: RiskVerdict[] = []
  const heldValue = new Map<string, number>(
    Object.entries(start.positions).map(([s, v]) => [s.toUpperCase(), v]),
  )
  const seen = new Set<string>()
  let cash = start.cash

  for (const o of orders) {
    const reasons: string[] = []
    const symbol = String(o.symbol ?? '').trim().toUpperCase()
    const notional = Number(o.notional ?? 0)

    if (!symbol) reasons.push('order has no symbol')
    if (!(notional > 0)) reasons.push('order has no dollar amount')

    // size
    if (notional > 0 && notional < limits.minOrderUsd - CENT)
      reasons.push(`order ${money(notional)} is under your ${money(limits.minOrderUsd)} minimum`)
    if (notional > 0 && notional > limits.maxOrderUsd + CENT)
      reasons.push(`order ${money(notional)} is over your ${money(limits.maxOrderUsd)} maximum order size`)

    // short selling is off: no selling more than you hold
    const held = heldValue.get(symbol) ?? 0
    if (symbol && notional > held + CENT)
      reasons.push(
        `selling ${money(notional)} of ${symbol} but you only hold ${money(held)}; short selling is off`,
      )

    if (seen.has(symbol)) reasons.push(`second order for ${symbol} in this batch`)
    seen.add(symbol)

    const status: RiskVerdict['status'] = reasons.length ? 'BLOCK' : 'PASS'
    if (status === 'PASS') {
      cash += notional
      heldValue.set(symbol, Math.max(held - notional, 0))
    }
    verdicts.push({ symbol, notional, status, reasons })
  }

  return { verdicts, allPass: verdicts.every((v) => v.status === 'PASS'), cashAfter: cash }
}
