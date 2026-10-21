/**
 * Trader Desk service — the trader-skill pipeline (MIT, Jake Schincariol)
 * adapted to a crypto-first paper desk:
 *
 *   targets (screener / copied 13F)
 *     → trader-budget  sizing      (src/lib/copycat/size.ts — faithful port)
 *     → trader-risk    PASS/BLOCK  (src/lib/copycat/risk.ts — faithful port)
 *     → trader-broker  tickets     (this file — proposals only, an explicit
 *                                   yes fills the paper account at the live
 *                                   price, matched by fingerprint)
 *     → trader-rebalance drift bands → new tickets
 *     → trader-alerts  price levels ring once
 *
 * Nothing here can reach a real exchange. The paper account is per signed-in
 * user and lives in SQLite.
 */

import { createHash } from 'crypto'
import { db } from '@/lib/db'
import { getTicker } from '@/lib/market/providers'
import {
  SizeError,
  size,
  type SizeResult,
  type WeightRow,
} from '@/lib/copycat/size'
import {
  checkOrders,
  checkSellOrders,
  type RiskVerdict,
  type StartAccount,
} from '@/lib/copycat/risk'

export const EPS = 1e-9
const CENT = 0.005

export interface DeskRules {
  budget: number
  cashBufferPct: number
  maxPositionPct: number
  minOrderUsd: number
  maxOrderUsd: number
  maxOrdersPerDay: number
}

export const DEFAULT_RULES: DeskRules = {
  budget: 5000,
  cashBufferPct: 10,
  maxPositionPct: 25,
  minOrderUsd: 5,
  maxOrderUsd: 2000,
  maxOrdersPerDay: 10,
}

export class DeskError extends Error {}

const money = (x: number): string =>
  `$${x.toLocaleString('en-US', { maximumFractionDigits: 2 })}`

const round2 = (x: number): number => Math.round(x * 100) / 100

/**
 * Same idea as check.py/ticket.py's fingerprint: a short hash of the exact
 * order core, so the broker stage only ever fills the order that risk passed.
 */
export function fingerprint(parts: {
  batchId: string
  symbol: string
  side: string
  notional: number
}): string {
  const blob = JSON.stringify({
    batchId: parts.batchId,
    symbol: parts.symbol,
    side: parts.side,
    notional: round2(parts.notional),
    type: 'market',
    time_in_force: 'day',
  })
  return createHash('sha256').update(blob).digest('hex').slice(0, 16)
}

async function livePrice(symbol: string, market: 'crypto' | 'stock'): Promise<number> {
  const t = await getTicker(symbol, market)
  if (!t || !(t.price > 0)) throw new DeskError(`no live price for ${symbol}`)
  return t.price
}

/** The paper account (positions valued by the caller), created on first plan. */
async function ensureAccount(uid: string, budget: number) {
  const existing = await db.traderAccount.findUnique({ where: { userId: uid } })
  if (existing) return existing
  return db.traderAccount.create({ data: { userId: uid, budget, cash: budget } })
}

/** StartAccount for risk checks: current cash + position values at live prices. */
async function startAccountFor(uid: string): Promise<StartAccount | undefined> {
  const account = await db.traderAccount.findUnique({ where: { userId: uid } })
  if (!account) return undefined
  const positions = await db.traderPosition.findMany({ where: { userId: uid } })
  const posValues: Record<string, number> = {}
  for (const p of positions) {
    if (p.qty <= EPS) continue
    try {
      posValues[p.symbol] = round2(p.qty * (await livePrice(p.symbol, 'crypto')))
    } catch {
      posValues[p.symbol] = round2(p.qty * p.avgPrice) // fall back to cost basis
    }
  }
  return { cash: account.cash, positions: posValues }
}

// ─── plan: weights → sizing → risk → tickets ────────────────────────────────

export interface PlanParams {
  weights: WeightRow[]
  rules: DeskRules
  market: 'crypto' | 'stock'
  source: string
  top?: number
  blocked?: string[]
}

export interface DeskTicketView {
  id: string
  batchId: string
  symbol: string
  side: 'buy' | 'sell'
  notional: number
  refPrice: number | null
  why: string | null
  verdict: 'PASS' | 'BLOCK'
  reasons: string[]
  status: 'proposed' | 'approved' | 'rejected' | 'expired'
  fillPrice: number | null
  filledQty: number | null
  createdAt: string
}

export interface PlanResult {
  batchId: string
  source: string
  market: 'crypto' | 'stock'
  sizing: SizeResult
  tickets: DeskTicketView[]
  notes: string[]
}

/**
 * trader-budget → trader-risk in one step: size the weights to the budget,
 * check every proposed order, apply the placed-today rules (duplicates and
 * the daily limit, exactly like check.py) and store the batch as tickets.
 * Nothing is filled here — approval happens ticket by ticket.
 */
export async function buildPlan(uid: string, params: PlanParams): Promise<PlanResult> {
  const { weights, market, source } = params
  const rules = { ...DEFAULT_RULES, ...params.rules }
  if (!weights.length) throw new DeskError('no target weights to size — run the screener or analyze a filer first')
  if (!(rules.budget > 0)) throw new DeskError('enter a budget in dollars')

  // live prices for context (share counts); whole-share mode is off for crypto
  const prices: Record<string, number> = {}
  await Promise.all(
    weights.map(async (w) => {
      try {
        prices[w.ticker.toUpperCase()] = await livePrice(w.ticker, market)
      } catch {
        /* priced below where available */
      }
    }),
  )

  const sizing = size(weights, {
    cashBufferPct: rules.cashBufferPct,
    maxPositionPct: rules.maxPositionPct,
    minOrderUsd: rules.minOrderUsd,
    blocked: params.blocked ?? [],
    wholeShares: false,
  }, rules.budget, prices, params.top)

  // risk: check against the current paper account if one exists, else the
  // fresh budget-funded account (exactly check.py's starting-account rule)
  const start = await startAccountFor(uid)
  const buys = sizing.positions
    .filter((p) => p.dollars > 0)
    .map((p) => ({ symbol: p.ticker, notional: p.dollars }))
  const risk = checkOrders(
    buys,
    {
      budget: rules.budget,
      cashBufferPct: rules.cashBufferPct,
      maxPositionPct: rules.maxPositionPct,
      minOrderUsd: rules.minOrderUsd,
      maxOrderUsd: rules.maxOrderUsd,
      maxOrdersPerDay: rules.maxOrdersPerDay,
      blocked: params.blocked ?? [],
    },
    start,
  )

  // placed-today state: duplicates + the daily order limit (check.py rules)
  const todayStart = new Date()
  todayStart.setUTCHours(0, 0, 0, 0)
  const placedToday = await db.traderTicket.findMany({
    where: { userId: uid, status: 'approved', decidedAt: { gte: todayStart } },
    select: { symbol: true, side: true },
  })
  const placedKeys = new Set(placedToday.map((t) => `${t.symbol.toUpperCase()}|${t.side}`))
  const notes: string[] = []

  const verdicts: Array<RiskVerdict & { symbol: string }> = risk.verdicts
  const batchId = `plan-${Date.now()}`
  const rows: Array<{
    symbol: string
    side: 'buy' | 'sell'
    notional: number
    refPrice: number | null
    why: string
    verdict: 'PASS' | 'BLOCK'
    reasons: string[]
  }> = []

  let passedSoFar = 0
  for (const v of verdicts) {
    const reasons = [...v.reasons]
    const key = `${v.symbol}|buy`
    if (placedKeys.has(key)) reasons.push(`duplicate: a buy of ${v.symbol} was already approved today`)
    const capN = Math.max(0, Math.floor(rules.maxOrdersPerDay))
    if (capN && placedToday.length + passedSoFar >= capN && v.status === 'PASS') {
      reasons.push(
        `daily limit: ${placedToday.length} approved today plus ${passedSoFar} passed earlier in this batch, your limit is ${capN} a day`,
      )
    }
    const willPass = v.status === 'PASS' && reasons.length === 0
    if (willPass) passedSoFar += 1
    const pos = sizing.positions.find((p) => p.ticker === v.symbol)
    let why = pos ? `${pos.weight.toFixed(2)}% of the ${market} sleeve` : ''
    if (source) why += `${why ? ', ' : ''}${source}`
    if (pos?.capped) why += `; capped at ${rules.maxPositionPct}% of the budget`
    rows.push({
      symbol: v.symbol,
      side: 'buy',
      notional: round2(v.notional),
      refPrice: prices[v.symbol] ?? null,
      why: why.trim(),
      verdict: willPass ? 'PASS' : 'BLOCK',
      reasons,
    })
  }
  if (!rows.length) notes.push('the sizing produced no orders — every slice was dropped (raise the budget or the caps)')

  await ensureAccount(uid, rules.budget)
  await db.traderTicket.createMany({
    data: rows.map((r) => ({
      userId: uid,
      batchId,
      source: source.slice(0, 80),
      market,
      symbol: r.symbol,
      side: r.side,
      notional: r.notional,
      refPrice: r.refPrice,
      fingerprint: fingerprint({ batchId, symbol: r.symbol, side: r.side, notional: r.notional }),
      why: r.why,
      verdict: r.verdict,
      reasons: r.reasons,
    })),
  })

  const tickets = await db.traderTicket.findMany({
    where: { userId: uid, batchId },
    orderBy: { notional: 'desc' },
  })

  return {
    batchId,
    source,
    market,
    sizing,
    tickets: tickets.map(toTicketView),
    notes,
  }
}

// ─── tickets: the explicit yes / no ─────────────────────────────────────────

function toTicketView(t: {
  id: string
  batchId: string
  symbol: string
  side: string
  notional: number
  refPrice: number | null
  why: string | null
  verdict: string
  reasons: unknown
  status: string
  fillPrice: number | null
  filledQty: number | null
  createdAt: Date
}): DeskTicketView {
  return {
    id: t.id,
    batchId: t.batchId,
    symbol: t.symbol,
    side: t.side === 'sell' ? 'sell' : 'buy',
    notional: t.notional,
    refPrice: t.refPrice,
    why: t.why,
    verdict: t.verdict === 'BLOCK' ? 'BLOCK' : 'PASS',
    reasons: Array.isArray(t.reasons) ? (t.reasons as string[]) : [],
    status: (['proposed', 'approved', 'rejected', 'expired'].includes(t.status)
      ? t.status
      : 'proposed') as DeskTicketView['status'],
    fillPrice: t.fillPrice,
    filledQty: t.filledQty,
    createdAt: t.createdAt.toISOString(),
  }
}

export async function listTickets(uid: string, batchId?: string): Promise<DeskTicketView[]> {
  const rows = await db.traderTicket.findMany({
    where: { userId: uid, ...(batchId ? { batchId } : {}) },
    orderBy: [{ createdAt: 'desc' }, { notional: 'desc' }],
    take: 200,
  })
  return rows.map(toTicketView)
}

/**
 * The only path from proposal to fill. Two gates, exactly like the repo:
 * the exact order (fingerprint) must have passed risk, and the user must
 * have said yes to THIS ticket. Then the fill happens at the live price on
 * the paper account.
 */
export async function decideTicket(
  uid: string,
  ticketId: string,
  action: 'approve' | 'reject',
): Promise<{ ticket: DeskTicketView; rangNote?: string }> {
  const t = await db.traderTicket.findUnique({ where: { id: ticketId } })
  if (!t || t.userId !== uid) throw new DeskError('ticket not found')
  if (t.status !== 'proposed') throw new DeskError(`this ticket was already ${t.status}`)
  if (action === 'reject') {
    const updated = await db.traderTicket.update({
      where: { id: t.id },
      data: { status: 'rejected', decidedAt: new Date() },
    })
    return { ticket: toTicketView(updated) }
  }

  // gate 1: only PASS tickets can be approved
  if (t.verdict !== 'PASS') throw new DeskError('risk BLOCKed this order — it can never be approved')
  // gate 2: the fingerprint must still match what risk passed
  const fp = fingerprint({ batchId: t.batchId, symbol: t.symbol, side: t.side, notional: t.notional })
  if (fp !== t.fingerprint) throw new DeskError('this exact order was not the one risk passed')

  const market = t.market === 'stock' ? 'stock' : 'crypto'
  const price = await livePrice(t.symbol, market)
  const filledQty = Math.round((t.notional / price) * 10_000) / 10_000

  const account = await ensureAccount(uid, DEFAULT_RULES.budget)

  // apply the fill to the paper account (buy: cash out, position in)
  const result = await db.$transaction(async (tx) => {
    const cashAfter =
      t.side === 'buy' ? round2(account.cash - t.notional) : round2(account.cash + t.notional)
    if (t.side === 'buy' && cashAfter < -CENT)
      throw new DeskError(`not enough cash on the paper account (${money(account.cash)} left)`)
    await tx.traderAccount.update({ where: { userId: uid }, data: { cash: Math.max(cashAfter, 0) } })

    const existing = await tx.traderPosition.findUnique({
      where: { userId_symbol: { userId: uid, symbol: t.symbol } },
    })
    if (t.side === 'buy') {
      if (existing) {
        const qty = existing.qty + filledQty
        const avg = qty > EPS ? (existing.avgPrice * existing.qty + price * filledQty) / qty : price
        await tx.traderPosition.update({
          where: { id: existing.id },
          data: { qty, avgPrice: avg },
        })
      } else {
        await tx.traderPosition.create({
          data: { userId: uid, symbol: t.symbol, qty: filledQty, avgPrice: price },
        })
      }
    } else {
      const qty = (existing?.qty ?? 0) - filledQty
      if (!existing || qty <= 0.00001) {
        if (existing) await tx.traderPosition.delete({ where: { id: existing.id } })
      } else {
        await tx.traderPosition.update({ where: { id: existing.id }, data: { qty } })
      }
    }
    return tx.traderTicket.update({
      where: { id: t.id },
      data: { status: 'approved', decidedAt: new Date(), fillPrice: price, filledQty },
    })
  })

  return { ticket: toTicketView(result) }
}

/** Expire stale proposals (older than 48h) so the ticket list stays honest. */
export async function expireStaleTickets(uid: string): Promise<void> {
  const cutoff = new Date(Date.now() - 48 * 3600 * 1000)
  await db.traderTicket.updateMany({
    where: { userId: uid, status: 'proposed', createdAt: { lt: cutoff } },
    data: { status: 'expired' },
  })
}

// ─── portfolio: live marks + drift vs targets ───────────────────────────────

export interface PortfolioRow {
  symbol: string
  qty: number
  avgPrice: number
  price: number
  value: number
  pnlPct: number
  currentPct: number
  targetPct: number
  drift: number
  tracked: boolean
}

export interface PortfolioResult {
  account: { budget: number; cash: number; exists: boolean }
  total: number
  invested: number
  rows: PortfolioRow[]
  targets: Array<{ symbol: string; name: string; weight: number }> | null
  targetSource: string | null
}

export async function portfolio(uid: string): Promise<PortfolioResult> {
  const account = await db.traderAccount.findUnique({ where: { userId: uid } })
  const positions = await db.traderPosition.findMany({ where: { userId: uid } })
  const targetRow = await db.traderTarget.findUnique({ where: { userId: uid } })
  const targets = targetRow
    ? (JSON.parse(targetRow.weights) as Array<{ symbol: string; name: string; weight: number }>)
    : null

  const rows: PortfolioRow[] = []
  let invested = 0
  const prices: Record<string, number> = {}
  await Promise.all(
    positions.map(async (p) => {
      try {
        prices[p.symbol] = await livePrice(p.symbol, 'crypto')
      } catch {
        prices[p.symbol] = p.avgPrice
      }
    }),
  )
  for (const p of positions) {
    const price = prices[p.symbol] ?? p.avgPrice
    const value = p.qty * price
    invested += value
  }
  const cash = account?.cash ?? 0
  const total = cash + invested

  const weightMap = new Map((targets ?? []).map((w) => [w.symbol.toUpperCase(), w]))
  for (const p of positions) {
    const price = prices[p.symbol] ?? p.avgPrice
    const value = p.qty * price
    const tw = weightMap.get(p.symbol)
    rows.push({
      symbol: p.symbol,
      qty: p.qty,
      avgPrice: p.avgPrice,
      price,
      value: round2(value),
      pnlPct: p.avgPrice > 0 ? ((price - p.avgPrice) / p.avgPrice) * 100 : 0,
      currentPct: total > 0 ? (value / total) * 100 : 0,
      targetPct: 0, // filled below when targets exist
      drift: 0,
      tracked: !!tw,
    })
  }

  if (targets && total > 0) {
    const buf = (total * DEFAULT_RULES.cashBufferPct) / 100
    const cap = (total * DEFAULT_RULES.maxPositionPct) / 100
    const targetUsd = cappedTargets(
      Object.fromEntries(targets.map((w) => [w.symbol.toUpperCase(), w.weight])),
      Math.max(total - buf, 0),
      cap,
    )
    for (const r of rows) {
      const tgt = targetUsd[r.symbol] ?? 0
      r.targetPct = Math.round(((tgt / total) * 100) * 100) / 100
      r.drift = Math.round((r.currentPct - r.targetPct) * 100) / 100
    }
  }

  rows.sort((a, b) => b.value - a.value)
  return {
    account: { budget: account?.budget ?? 0, cash: round2(cash), exists: !!account },
    total: round2(total),
    invested: round2(invested),
    rows,
    targets,
    targetSource: targetRow?.source ?? null,
  }
}

// ─── rebalance: drift bands → new tickets (sells first) ─────────────────────

/**
 * capped_targets(): dollar target per ticker, proportional to weight, none
 * above the cap. Anything over the cap is pinned at the cap and the rest of
 * the sleeve is re-shared over the others (weights renormalised over the
 * still-active tickers on every pass — the repo's loop does exactly that).
 */
function cappedTargets(weights: Record<string, number>, sleeve: number, cap: number): Record<string, number> {
  const targetUsd: Record<string, number> = {}
  const active = { ...weights }
  let moneyLeft = sleeve
  for (;;) {
    if (!Object.keys(active).length || moneyLeft <= EPS) break
    const wsum = Object.values(active).reduce((s, w) => s + w, 0)
    if (!(wsum > 0)) break
    const trial: Record<string, number> = {}
    for (const [t, w] of Object.entries(active)) trial[t] = (moneyLeft * w) / wsum
    const over = Object.entries(trial).filter(([, v]) => v > cap + EPS)
    if (!over.length) {
      Object.assign(targetUsd, trial)
      break
    }
    for (const [t, v] of over) {
      targetUsd[t] = cap
      moneyLeft -= cap
      delete active[t]
    }
  }
  return targetUsd
}

export interface RebalanceResult {
  band: number
  total: number
  cashBuffer: number
  cap: number
  rows: Array<{
    symbol: string
    qty: number
    price: number
    value: number
    currentPct: number
    targetPct: number
    drift: number
    action: 'hold' | 'buy' | 'sell' | 'untracked, left alone'
  }>
  tickets: DeskTicketView[]
  notes: string[]
  batchId: string | null
}

/**
 * Port of rebalance.py's plan(): only assets drifting more than the band
 * trade; sells are proposed before buys so the cash is there; buys scale
 * down together when there is not enough free cash above the buffer; trades
 * under the minimum are skipped, trades over the max are cut.
 */
export async function rebalance(uid: string, bandPct?: number): Promise<RebalanceResult> {
  const account = await db.traderAccount.findUnique({ where: { userId: uid } })
  if (!account) throw new DeskError('no paper account yet — build a plan first')
  const targetRow = await db.traderTarget.findUnique({ where: { userId: uid } })
  if (!targetRow) throw new DeskError('no targets stored — build a plan first')
  const targets = JSON.parse(targetRow.weights) as Array<{ symbol: string; name: string; weight: number }>

  const band = Number.isFinite(Number(bandPct)) ? Math.min(50, Math.max(0, Number(bandPct))) : 5
  const positions = await db.traderPosition.findMany({ where: { userId: uid } })
  const cash = account.cash

  const held: Record<string, number> = {}
  for (const p of positions) if (p.qty > EPS) held[p.symbol] = p.qty
  const weights: Record<string, number> = {}
  const names: Record<string, string> = {}
  for (const w of targets) {
    weights[w.symbol.toUpperCase()] = (weights[w.symbol.toUpperCase()] ?? 0) + w.weight
    names[w.symbol.toUpperCase()] = w.name
  }

  const need = [...new Set([...Object.keys(held), ...Object.keys(weights)])].sort(
    (a, b) => (weights[b] ?? 0) - (weights[a] ?? 0) || a.localeCompare(b),
  )
  const prices: Record<string, number> = {}
  for (const t of need) {
    try {
      prices[t] = await livePrice(t, 'crypto')
    } catch {
      throw new DeskError(`no live price for ${t} right now — retry in a moment`)
    }
  }
  const value: Record<string, number> = {}
  for (const t of need) value[t] = (held[t] ?? 0) * prices[t]
  const total = cash + Object.values(value).reduce((s, v) => s + v, 0)
  if (total <= EPS) throw new DeskError('the paper account is empty: nothing to rebalance (build a plan first)')

  const rules = DEFAULT_RULES
  const buf = (total * rules.cashBufferPct) / 100
  const cap = (total * rules.maxPositionPct) / 100
  const targetUsd = cappedTargets(weights, total - buf, cap)

  type Sell = { ticker: string; usd: number; why: string }
  type Buy = { ticker: string; usd: number; why: string }
  const rows: RebalanceResult['rows'] = []
  const sells: Sell[] = []
  const buys: Buy[] = []
  const notes: string[] = []

  for (const t of need) {
    const tracked = t in weights
    const tgt = targetUsd[t] ?? 0
    const curPct = (100 * value[t]) / total
    const tgtPct = (100 * tgt) / total
    const drift = curPct - tgtPct
    let action: RebalanceResult['rows'][number]['action'] = 'hold'
    if (!tracked) {
      action = Object.keys(held).includes(t) ? 'untracked, left alone' : 'hold'
    } else if (Math.abs(drift) > band + EPS) {
      const delta = tgt - value[t]
      const why = `drifted ${drift >= 0 ? '+' : ''}${drift.toFixed(1)} points from its ${tgtPct.toFixed(1)}% target (band ${band})`
      if (delta < 0) {
        sells.push({ ticker: t, usd: -delta, why })
        action = 'sell'
      } else {
        buys.push({ ticker: t, usd: delta, why })
        action = 'buy'
      }
    }
    rows.push({
      symbol: t,
      qty: held[t] ?? 0,
      price: prices[t],
      value: round2(value[t]),
      currentPct: Math.round(curPct * 100) / 100,
      targetPct: Math.round(tgtPct * 100) / 100,
      drift: Math.abs(drift) >= 0.005 ? Math.round(drift * 100) / 100 : 0,
      action,
    })
  }

  // sells first, sized and bounded
  const startAcct: StartAccount = {
    cash,
    positions: Object.fromEntries(need.filter((t) => held[t]).map((t) => [t, value[t]])),
  }
  const sellOrders: Array<{ ticker: string; usd: number }> = []
  for (const s of sells) {
    let usd = s.usd
    if (rules.maxOrderUsd && usd > rules.maxOrderUsd + EPS) {
      notes.push(`${s.ticker} sell cut to your ${money(rules.maxOrderUsd)} max order; run again after it fills`)
      usd = rules.maxOrderUsd
    }
    const qty = Math.floor((usd / prices[s.ticker]) * 10_000 + EPS) / 10_000
    const cappedQty = Math.min(qty, held[s.ticker] ?? 0)
    const usdCapped = cappedQty * prices[s.ticker]
    if (cappedQty <= EPS || usdCapped < rules.minOrderUsd - EPS) {
      notes.push(`${s.ticker} sell of ${money(usdCapped)} is under your ${money(rules.minOrderUsd)} minimum order: skipped`)
      continue
    }
    sellOrders.push({ ticker: s.ticker, usd: round2(usdCapped) })
  }
  const sellRisk = checkSellOrders(
    sellOrders.map((s) => ({ symbol: s.ticker, notional: s.usd })),
    { minOrderUsd: rules.minOrderUsd, maxOrderUsd: rules.maxOrderUsd },
    startAcct,
  )

  // buys: only spend cash above the buffer; scale down together if short
  let cashAfter = sellRisk.cashAfter
  const spendable = Math.max(cashAfter - buf, 0)
  const want = buys.reduce((s, b) => s + b.usd, 0)
  let scale = 1
  if (want > spendable + EPS) {
    scale = want ? spendable / want : 0
    notes.push(`buys scaled to ${Math.round(scale * 100)}%: only ${money(spendable)} is free above your ${money(buf)} cash buffer`)
  }
  const buyOrders: Array<{ ticker: string; usd: number }> = []
  for (const b of buys) {
    let usd = b.usd * scale
    if (rules.maxOrderUsd && usd > rules.maxOrderUsd + EPS) {
      notes.push(`${b.ticker} buy cut to your ${money(rules.maxOrderUsd)} max order; run again after it fills`)
      usd = rules.maxOrderUsd
    }
    usd = Math.floor(usd + EPS)
    if (usd < rules.minOrderUsd - EPS || usd < 1) {
      notes.push(`${b.ticker} buy of ${money(usd)} is under your ${money(rules.minOrderUsd)} minimum order: skipped`)
      continue
    }
    buyOrders.push({ ticker: b.ticker, usd: round2(usd) })
  }

  // risk checks for buys against the post-sell account (values shift after sells)
  const postSellPositions: Record<string, number> = {}
  for (const t of need) {
    if (!held[t]) continue
    const sold = sellOrders.filter((s) => s.ticker === t).reduce((s, x) => s + x.usd, 0)
    postSellPositions[t] = Math.max(value[t] - sold, 0)
  }
  const buyRisk = checkOrders(
    buyOrders.map((b) => ({ symbol: b.ticker, notional: b.usd })),
    {
      budget: rules.budget,
      cashBufferPct: rules.cashBufferPct,
      maxPositionPct: rules.maxPositionPct,
      minOrderUsd: rules.minOrderUsd,
      maxOrderUsd: rules.maxOrderUsd,
      maxOrdersPerDay: rules.maxOrdersPerDay,
      blocked: [],
    },
    { cash: cashAfter, positions: postSellPositions },
  )

  // store tickets, sells first
  const batchId = `rebal-${Date.now()}`
  const rowsToStore: Array<{
    symbol: string
    side: 'buy' | 'sell'
    notional: number
    refPrice: number
    why: string
    verdict: 'PASS' | 'BLOCK'
    reasons: string[]
  }> = []
  sellOrders.forEach((s, i) => {
    const v = sellRisk.verdicts[i]
    rowsToStore.push({
      symbol: s.ticker,
      side: 'sell',
      notional: s.usd,
      refPrice: prices[s.ticker],
      why: sells.find((x) => x.ticker === s.ticker)?.why ?? 'rebalance sell',
      verdict: v.status,
      reasons: v.reasons,
    })
  })
  buyOrders.forEach((b, i) => {
    const v = buyRisk.verdicts[i]
    rowsToStore.push({
      symbol: b.ticker,
      side: 'buy',
      notional: b.usd,
      refPrice: prices[b.ticker],
      why: buys.find((x) => x.ticker === b.ticker)?.why ?? 'rebalance buy',
      verdict: v.status,
      reasons: v.reasons,
    })
  })

  let tickets: DeskTicketView[] = []
  if (rowsToStore.length) {
    await db.traderTicket.createMany({
      data: rowsToStore.map((r) => ({
        userId: uid,
        batchId,
        source: `rebalance (${targetRow.source})`,
        market: 'crypto',
        symbol: r.symbol,
        side: r.side,
        notional: r.notional,
        refPrice: r.refPrice,
        fingerprint: fingerprint({ batchId, symbol: r.symbol, side: r.side, notional: r.notional }),
        why: r.why,
        verdict: r.verdict,
        reasons: r.reasons,
      })),
    })
    const stored = await db.traderTicket.findMany({ where: { userId: uid, batchId } })
    tickets = stored
      .map(toTicketView)
      .sort((a, b) => (a.side === 'sell' ? 0 : 1) - (b.side === 'sell' ? 0 : 1) || b.notional - a.notional)
  } else {
    notes.push('nothing is outside the band — every position is within its drift band')
  }

  return {
    band,
    total: round2(total),
    cashBuffer: round2(buf),
    cap: round2(cap),
    rows,
    tickets,
    notes,
    batchId: rowsToStore.length ? batchId : null,
  }
}

// ─── alerts: information only, ring once ────────────────────────────────────

export interface AlertView {
  id: string
  symbol: string
  market: 'crypto' | 'stock'
  kind: 'above' | 'below' | 'stop'
  price: number
  note: string | null
  triggered: boolean
  triggeredAt: string | null
  createdAt: string
  lastPrice?: number | null
}

function alertToView(a: {
  id: string
  symbol: string
  market: string
  kind: string
  price: number
  note: string | null
  triggered: boolean
  triggeredAt: Date | null
  createdAt: Date
}): AlertView {
  return {
    id: a.id,
    symbol: a.symbol,
    market: a.market === 'stock' ? 'stock' : 'crypto',
    kind: (['above', 'below', 'stop'].includes(a.kind) ? a.kind : 'above') as AlertView['kind'],
    price: a.price,
    note: a.note,
    triggered: a.triggered,
    triggeredAt: a.triggeredAt?.toISOString() ?? null,
    createdAt: a.createdAt.toISOString(),
  }
}

/** Check untriggered alerts against live prices; each rings at most once. */
export async function checkAlerts(uid: string): Promise<{ alerts: AlertView[]; rang: AlertView[] }> {
  const rows = await db.traderAlert.findMany({
    where: { userId: uid },
    orderBy: { createdAt: 'desc' },
    take: 100,
  })
  const rang: AlertView[] = []
  const out: AlertView[] = []
  for (const a of rows) {
    const view = alertToView(a)
    if (!a.triggered) {
      try {
        const price = await livePrice(a.symbol, a.market === 'stock' ? 'stock' : 'crypto')
        view.lastPrice = price
        const hit =
          a.kind === 'above' ? price >= a.price : a.kind === 'below' ? price <= a.price : price <= a.price
        if (hit) {
          const updated = await db.traderAlert.update({
            where: { id: a.id },
            data: { triggered: true, triggeredAt: new Date() },
          })
          const v = alertToView(updated)
          v.lastPrice = price
          out.push(v)
          rang.push(v)
          continue
        }
      } catch {
        /* price feed hiccup: stays untriggered */
      }
    }
    out.push(view)
  }
  return { alerts: out, rang }
}

export async function addAlert(
  uid: string,
  input: { symbol: string; kind: 'above' | 'below' | 'stop'; price: number; note?: string; market?: 'crypto' | 'stock' },
): Promise<AlertView> {
  const symbol = String(input.symbol ?? '').trim().toUpperCase().slice(0, 10)
  if (!symbol) throw new DeskError('alert needs a symbol')
  if (!['above', 'below', 'stop'].includes(input.kind)) throw new DeskError('kind must be above, below or stop')
  if (!(Number(input.price) > 0)) throw new DeskError('alert needs a positive price level')
  const row = await db.traderAlert.create({
    data: {
      userId: uid,
      symbol,
      market: input.market === 'stock' ? 'stock' : 'crypto',
      kind: input.kind,
      price: Number(input.price),
      note: input.note?.slice(0, 120) ?? null,
    },
  })
  return alertToView(row)
}

export async function deleteAlert(uid: string, id: string): Promise<void> {
  const a = await db.traderAlert.findUnique({ where: { id } })
  if (!a || a.userId !== uid) throw new DeskError('alert not found')
  await db.traderAlert.delete({ where: { id } })
}

// ─── reset: wipe the paper desk ─────────────────────────────────────────────

export async function resetDesk(uid: string): Promise<void> {
  await db.$transaction([
    db.traderTicket.deleteMany({ where: { userId: uid } }),
    db.traderPosition.deleteMany({ where: { userId: uid } }),
    db.traderAccount.deleteMany({ where: { userId: uid } }),
    db.traderTarget.deleteMany({ where: { userId: uid } }),
    db.traderAlert.deleteMany({ where: { userId: uid } }),
  ])
}

/** Store the target weights a plan was built from (for rebalance drift). */
export async function saveTargets(
  uid: string,
  source: string,
  weights: Array<{ symbol: string; name: string; weight: number }>,
): Promise<void> {
  await db.traderTarget.upsert({
    where: { userId: uid },
    create: { userId: uid, source: source.slice(0, 80), weights: JSON.stringify(weights) },
    update: { source: source.slice(0, 80), weights: JSON.stringify(weights), updatedAt: new Date() },
  })
}

export { SizeError }
