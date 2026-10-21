/**
 * Position sizing for the Copy Investor desk.
 *
 * Faithful TypeScript port of trader-skill/trader-budget/size.py
 * (MIT, Jake Schincariol): turns target weights (the portfolio you want to
 * copy) and your rules (budget, cash buffer, a cap on any one stock, a minimum
 * order) into dollar amounts per stock.
 *
 * How the money is split:
 *   1. cash buffer   budget × cash_buffer_pct stays in cash, never invested
 *   2. weights       renormalised to 100 over the stocks you keep (blocked
 *                    tickers are dropped first; top N keeps the N biggest)
 *   3. cap           no stock gets more than max_position_pct of the budget;
 *                    anything over the cap is shared out to the others by
 *                    weight, again and again until nobody is over
 *   4. min order     a slice under min_order_usd is dropped and its weight
 *                    shared out, so you never place a $2 order
 *   5. rounding      whole dollars by default; the rounding dollar goes to the
 *                    biggest position that is not capped, so every dollar of
 *                    the investable money is used
 *   6. whole shares  optional; needs prices; buys whole shares, then spends
 *                    what is left one share at a time on the stock furthest
 *                    below its slice
 *
 * Money that cannot be invested (every stock at its cap, or whole-share
 * leftovers) is reported as "idle", never hidden.
 */

const EPS = 1e-9

export interface WeightRow {
  ticker: string
  name: string
  weight: number
}

export interface DroppedRow {
  ticker: string
  reason: string
}

export interface SizedPosition {
  ticker: string
  name: string
  weight: number // renormalised % of the stock sleeve
  sourceWeight: number // raw weight as given
  dollars: number
  capped: boolean
  price?: number
  shares?: number
}

export interface SizeConfig {
  cashBufferPct: number // 0..100, default 10
  maxPositionPct: number // 0..100, default 25
  minOrderUsd: number // default 5
  blocked: string[]
  wholeShares: boolean
}

export interface SizeResult {
  budget: number
  cashBufferPct: number
  cashBuffer: number
  investable: number
  maxPositionPct: number
  cap: number
  minOrderUsd: number
  wholeShares: boolean
  positions: SizedPosition[]
  invested: number
  idle: number
  dropped: DroppedRow[]
}

export class SizeError extends Error {}

/** Drop blocked / non-positive weights, keep the top N, renormalise to 100. */
function normalise(
  rows: WeightRow[],
  blocked: string[],
  top: number | undefined,
): { keep: (WeightRow & { sourceWeight: number })[]; dropped: DroppedRow[] } {
  const blockedSet = new Set((blocked ?? []).map((b) => String(b).trim().toUpperCase()))
  const dropped: DroppedRow[] = []
  const seen = new Set<string>()
  const keep: (WeightRow & { sourceWeight: number })[] = []
  for (const r of rows) {
    const ticker = String(r.ticker).trim().toUpperCase()
    if (seen.has(ticker)) throw new SizeError(`${ticker} is listed twice in the weights`)
    seen.add(ticker)
    if (blockedSet.has(ticker)) dropped.push({ ticker, reason: 'on your blocked list' })
    else if (!(Number(r.weight) > 0)) dropped.push({ ticker, reason: 'weight is zero or negative' })
    else keep.push({ ...r, ticker, weight: Number(r.weight), sourceWeight: Number(r.weight) })
  }
  keep.sort((a, b) => b.weight - a.weight)
  let kept = keep
  if (top && top > 0) {
    for (const r of keep.slice(top)) dropped.push({ ticker: r.ticker, reason: `outside the top ${top}` })
    kept = keep.slice(0, top)
  }
  const total = kept.reduce((s, r) => s + r.weight, 0)
  for (const r of kept) r.weight = total ? (100 * r.weight) / total : 0
  return { keep: kept, dropped }
}

/**
 * Exact (unrounded) dollars per ticker with the cap enforced. Proportional to
 * weight; any stock over the cap is pinned at the cap and the rest of the
 * money is shared over the others, repeated until no stock is over.
 */
function allocate(
  rows: { ticker: string; weight: number }[],
  investable: number,
  cap: number,
): { exact: Map<string, number>; capped: Set<string> } {
  const exact = new Map<string, number>()
  const capped = new Set<string>()
  let active = [...rows]
  let money = investable
  while (active.length) {
    const wsum = active.reduce((s, r) => s + r.weight, 0)
    const trial = new Map(active.map((r) => [r.ticker, (money * r.weight) / wsum] as const))
    const over = active.filter((r) => (trial.get(r.ticker) ?? 0) > cap + EPS)
    if (!over.length) {
      for (const [t, v] of trial) exact.set(t, v)
      break
    }
    for (const r of over) {
      exact.set(r.ticker, cap)
      capped.add(r.ticker)
      money -= cap
    }
    active = active.filter((r) => !capped.has(r.ticker))
    if (money <= EPS) {
      for (const r of active) exact.set(r.ticker, 0)
      break
    }
  }
  return { exact, capped }
}

/**
 * Round to whole dollars and keep the total. The total placed is the exact
 * total rounded DOWN, so it never spends money you do not have. Each slice is
 * rounded to the nearest dollar, then the difference (usually one dollar) goes
 * to the biggest stock that is not capped, then the next, never pushing anyone
 * over the cap.
 */
function roundToUnit(
  exact: Map<string, number>,
  capped: Set<string>,
  order: string[],
  cap: number,
  unit = 1,
): Map<string, number> {
  const units = (x: number) => Math.floor(x / unit + EPS)
  const capU = units(cap)
  const totalU = units([...exact.values()].reduce((s, v) => s + v, 0))
  const out = new Map<string, number>()
  for (const [t, v] of exact) out.set(t, capped.has(t) ? capU : Math.floor(v / unit + 0.5 + EPS))
  let diff = totalU - [...out.values()].reduce((s, v) => s + v, 0)
  const takers = order.filter((t) => !capped.has(t))
  let guard = 0
  while (diff !== 0 && takers.length && guard < 100_000) {
    let moved = false
    for (const t of takers) {
      if (diff === 0) break
      const cur = out.get(t) ?? 0
      if (diff > 0 && cur + 1 <= capU) {
        out.set(t, cur + 1)
        diff -= 1
        moved = true
      } else if (diff < 0 && cur > 0) {
        out.set(t, cur - 1)
        diff += 1
        moved = true
      }
    }
    if (!moved) break
    guard += 1
  }
  const res = new Map<string, number>()
  for (const [t, u] of out) res.set(t, Math.round(u * unit * 100) / 100)
  return res
}

/**
 * Whole shares: floor each slice, then buy one more share at a time for the
 * stock furthest below its slice while cash lasts and the cap holds.
 */
function wholeShares(
  dollars: Map<string, number>,
  prices: Record<string, number>,
  order: string[],
  cap: number,
  money: number,
): Map<string, number> {
  const shares = new Map<string, number>()
  for (const t of order) shares.set(t, dollars.get(t)! > 0 ? Math.floor(dollars.get(t)! / prices[t] + EPS) : 0)
  let left = money - order.reduce((s, t) => s + shares.get(t)! * prices[t], 0)
  for (;;) {
    let best: string | null = null
    let gap = 0
    for (const t of order) {
      const p = prices[t]
      if (p > left + EPS || (shares.get(t)! + 1) * p > cap + EPS) continue
      const g = dollars.get(t)! - shares.get(t)! * p
      if (best === null || g > gap + EPS) {
        best = t
        gap = g
      }
    }
    if (best === null) break
    shares.set(best, shares.get(best)! + 1)
    left -= prices[best]
  }
  return shares
}

function usdNum(x: number): string {
  const r = Math.round(x * 100) / 100
  return Number.isInteger(r) ? String(r) : r.toFixed(2)
}

/**
 * Pure function: weights + rules → the full sizing result.
 * `prices` is only required for whole-share mode.
 */
export function size(
  rows: WeightRow[],
  cfg: SizeConfig,
  budget: number,
  prices: Record<string, number> = {},
  top?: number,
): SizeResult {
  const budgetN = Number(budget)
  if (!(budgetN > 0)) throw new SizeError('no budget: enter how much money you want to copy with')
  const bufPct = cfg.cashBufferPct
  const capPct = cfg.maxPositionPct
  const minOrder = cfg.minOrderUsd || 0
  if (!(bufPct >= 0 && bufPct < 100)) throw new SizeError('cash buffer must be between 0 and 100')
  if (!(capPct > 0 && capPct <= 100)) throw new SizeError('max position must be above 0 and at most 100')
  const whole = cfg.wholeShares
  if (whole) {
    const missing = rows.map((r) => String(r.ticker).toUpperCase()).filter((t) => !prices[t])
    if (missing.length)
      throw new SizeError(`whole shares need a live price for: ${missing.join(', ')} — retry, or switch to dollar slices`)
  }

  const { keep, dropped } = normalise(rows, cfg.blocked ?? [], top)
  if (!keep.length) throw new SizeError('nothing to size: no weights left after the blocked list')

  const cashBuffer = Math.round(budgetN * (bufPct / 100) * 100) / 100
  const investable = Math.round((budgetN - cashBuffer) * 100) / 100
  const cap = Math.round(budgetN * (capPct / 100) * 100) / 100

  let live = keep.map((r) => ({ ...r }))
  let exact = new Map<string, number>()
  let capped = new Set<string>()
  let dollars = new Map<string, number>()
  let shares: Map<string, number> | null = null
  let finalDropped = dropped

  // min-order loop: drop the worst under-minimum slice, redistribute, repeat
  for (;;) {
    live = keep.map((r) => ({ ...r }))
    const tot = live.reduce((s, r) => s + r.sourceWeight, 0)
    for (const r of live) r.weight = (100 * r.sourceWeight) / tot
    const alloc = allocate(live, investable, cap)
    exact = alloc.exact
    capped = alloc.capped
    const order = [...live].sort((a, b) => (exact.get(b.ticker) ?? 0) - (exact.get(a.ticker) ?? 0)).map((r) => r.ticker)
    dollars = roundToUnit(exact, capped, order, cap, 1)
    shares = null
    if (whole) {
      shares = wholeShares(dollars, prices, order, cap, [...dollars.values()].reduce((s, v) => s + v, 0))
      dollars = new Map(order.map((t) => [t, Math.round(shares!.get(t)! * prices[t] * 100) / 100]))
    }
    const small = live.filter((r) => dollars.get(r.ticker)! < minOrder - EPS)
    if (!small.length) break
    const worst = [...small].sort((a, b) => a.sourceWeight - b.sourceWeight || a.ticker.localeCompare(b.ticker))[0]
    if (whole && shares && shares.get(worst.ticker) === 0 && prices[worst.ticker] > 0) {
      finalDropped.push({
        ticker: worst.ticker,
        reason: `one share costs $${usdNum(prices[worst.ticker])}, more than its slice; it cannot be bought in whole shares`,
      })
    } else {
      finalDropped.push({
        ticker: worst.ticker,
        reason: `its slice ($${usdNum(dollars.get(worst.ticker) ?? 0)}) is under your $${usdNum(minOrder)} minimum order`,
      })
    }
    const idx = keep.findIndex((r) => r.ticker === worst.ticker)
    if (idx >= 0) keep.splice(idx, 1)
    if (!keep.length)
      throw new SizeError('every slice is under your minimum order; raise the budget or copy fewer stocks')
  }

  const positions: SizedPosition[] = [...live]
    .sort((a, b) => b.weight - a.weight)
    .map((r) => {
      const t = r.ticker
      const p: SizedPosition = {
        ticker: t,
        name: r.name,
        weight: Math.round(r.weight * 100) / 100,
        sourceWeight: r.sourceWeight,
        dollars: dollars.get(t) ?? 0,
        capped: capped.has(t),
      }
      if (prices[t]) {
        p.price = prices[t]
        p.shares = whole ? shares!.get(t)! : Math.round(((p.dollars as number) / prices[t]) * 10_000) / 10_000
      }
      return p
    })
  const invested = Math.round(positions.reduce((s, p) => s + p.dollars, 0) * 100) / 100
  return {
    budget: budgetN,
    cashBufferPct: bufPct,
    cashBuffer,
    investable,
    maxPositionPct: capPct,
    cap,
    minOrderUsd: minOrder,
    wholeShares: whole,
    positions,
    invested,
    idle: Math.round((investable - invested) * 100) / 100,
    dropped: finalDropped,
  }
}

export interface ProposedOrder {
  symbol: string
  side: 'buy'
  notional?: string
  qty?: string
  type: 'market'
  time_in_force: 'day'
  why: string
}

/** Proposed buy orders, one per position (proposals only — nothing is placed). */
export function ordersFrom(result: SizeResult, source = ''): ProposedOrder[] {
  const out: ProposedOrder[] = []
  for (const p of result.positions) {
    if (p.dollars <= 0) continue
    let why = `${p.weight.toFixed(2)}% of the stock sleeve`
    if (source) why += `, copying ${source}`
    if (p.capped) why += `; capped at ${result.maxPositionPct}% of the budget`
    const o: ProposedOrder = { symbol: p.ticker, side: 'buy', type: 'market', time_in_force: 'day', why }
    if (result.wholeShares && p.shares) o.qty = String(Math.floor(p.shares))
    else o.notional = usdNum(p.dollars)
    out.push(o)
  }
  return out
}
