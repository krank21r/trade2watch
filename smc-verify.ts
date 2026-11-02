/**
 * TEMPORARY verification scratch script (deleted after use — not a test file).
 * Drives the SMC engine with deterministic synthetic candles to prove the
 * STRICT LONG gate stack, trade plan, and DB lifecycle behave per spec.
 */
import type { Candle } from '@/lib/market/indicators'
import { SMC_CONFIG, TF_MS } from '@/lib/smc/config'
import { atr } from '@/lib/smc/atr'
import { detectSwings } from '@/lib/smc/swings'
import { analyzeStructure } from '@/lib/smc/structure'
import { detectFvgs } from '@/lib/smc/fvg'
import { detectOrderBlocks } from '@/lib/smc/orderblocks'
import { detectLiquidity, detectSweeps } from '@/lib/smc/liquidity'
import { evaluateSignal } from '@/lib/smc/signal'
import { buildTrade } from '@/lib/smc/risk'
import { db } from '@/lib/db'

const H = 3_600_000
const cfg = { ...SMC_CONFIG }

function mk(time: number, o: number, c: number, hi: number, lo: number, vol = 100): Candle {
  return { time, open: o, close: c, high: hi, low: lo, volume: vol }
}

/**
 * Range → 6 rally waves (8 up candles + 2 bearish pullback candles each) →
 * adaptive tail that descends exactly into the most recent BULLISH order
 * block detected on the series-so-far (so price ends INSIDE the zone, §17.5).
 */
function build1H(): Candle[] {
  const t0 = Date.now() - 400 * H
  const out: Candle[] = []
  for (let i = 0; i < 260; i++) {
    const o = 100 + 0.3 * Math.sin(i / 6)
    const c = 100 + 0.28 * Math.sin((i + 1) / 6)
    out.push(mk(t0 + out.length * H, o, c, Math.max(o, c) + 0.05, Math.min(o, c) - 0.05, 90))
  }
  let price = out[out.length - 1].close
  for (let k = 0; k < 6; k++) {
    for (let u = 0; u < 8; u++) {
      const o = price
      const c = price + 0.12
      price = c
      out.push(mk(t0 + out.length * H, o, c, Math.max(o, c) + 0.08, Math.min(o, c) - 0.08, 160))
    }
    for (let b = 0; b < 2; b++) {
      const o = price
      const c = price - 0.2
      price = c
      out.push(mk(t0 + out.length * H, o, c, o + 0.08, c - 0.08, 95))
    }
  }
  // adaptive tail into the latest bullish OB
  const preSwings = detectSwings(out, cfg.swingLeft, cfg.swingRight, TF_MS['1H'])
  const preStruct = analyzeStructure(out, preSwings, TF_MS['1H'], cfg)
  const preObs = detectOrderBlocks(
    out, preStruct.events, detectFvgs(out, TF_MS['1H']), atr(out, cfg.atrPeriod), cfg, 'BULLISH', [], TF_MS['1H'],
  )
  const target = preObs.find((o) => o.direction === 'BULLISH')
  if (!target) throw new Error('no bullish OB in pre-tail series')
  console.log('pre-tail 1H trend:', preStruct.trend, '| target OB:', target.low.toFixed(2), '-', target.high.toFixed(2), target.status)
  const obMid = (target.low + target.high) / 2
  const steps = 6
  const stepSize = (obMid - price) / steps
  for (let s = 0; s < steps; s++) {
    const o = price
    const c = price + stepSize
    price = c
    out.push(mk(t0 + out.length * H, o, c, o + 0.06, c - 0.06, 80))
  }
  return out
}

/** Mostly-monotone uptrend with a boosted BOS candle near the end. */
function buildConfirm(tfMs: number, count: number, base: number): Candle[] {
  const t0 = Date.now() - count * tfMs
  const out: Candle[] = []
  let price = base
  for (let i = 0; i < count; i++) {
    const o = price
    let c = i % 14 === 13 ? price - base * 0.0018 : price + base * 0.0009
    if (i === count - 2) c = o + base * 0.005
    price = c
    out.push(mk(t0 + i * tfMs, o, c, Math.max(o, c) + base * 0.0006, Math.min(o, c) - base * 0.0006, 100))
  }
  return out
}

const c1H = build1H()
const atr1H = atr(c1H, cfg.atrPeriod)
const swings1H = detectSwings(c1H, cfg.swingLeft, cfg.swingRight, TF_MS['1H'])
const s1H = analyzeStructure(c1H, swings1H, TF_MS['1H'], cfg, atr1H)
console.log('1H trend:', s1H.trend, '| last event:', s1H.events[s1H.events.length - 1]?.type, s1H.events[s1H.events.length - 1]?.direction)
const fvgs1H = detectFvgs(c1H, TF_MS['1H'])
const obs = detectOrderBlocks(c1H, s1H.events, fvgs1H, atr1H, cfg, 'BULLISH', [], TF_MS['1H'])
console.log(
  'OBs:',
  obs.map((o) => `${o.direction} ${o.low.toFixed(2)}-${o.high.toFixed(2)} ${o.status} sc=${o.strengthScore} fresh=${o.fresh}`),
)

const bullObs = obs.filter((o) => o.direction === 'BULLISH' && (o.status === 'ACTIVE' || o.status === 'TESTED' || o.status === 'MITIGATED'))
if (bullObs.length === 0) throw new Error('no tradeable bullish OB produced by synthetic data')
const entryOb = bullObs[0]
const price = (entryOb.low + entryOb.high) / 2
console.log('entry OB zone:', entryOb.low.toFixed(2), '-', entryOb.high.toFixed(2), '| status:', entryOb.status, '| simulated price:', price.toFixed(2))

const emptyTrade = buildTrade(entryOb, 'LONG', atr1H, [], swings1H, cfg)
console.log('fallback trade rrs:', emptyTrade && [emptyTrade.rr1, emptyTrade.rr2, emptyTrade.rr3], '| sl:', emptyTrade?.stop_loss.toFixed(2))
const risk1 = emptyTrade ? emptyTrade.entry_mid - emptyTrade.stop_loss : 1
const fakeLevels = [{ type: 'SWING_HIGH' as const, price: price + 1.4 * risk1, strength: 60, time: 1, swept: false, sweptAt: null }]
const floored = buildTrade(entryOb, 'LONG', atr1H, fakeLevels, swings1H, cfg)
console.log('pool at 1.4R → tp1 floored to 2R?', floored?.tp1.toFixed(2), 'rr1:', floored?.rr1)

const c15M = buildConfirm(TF_MS['15M'], 200, price)
const c5M = buildConfirm(TF_MS['5M'], 240, price)
const a15M = analyzeStructure(c15M, detectSwings(c15M, cfg.swingLeft, cfg.swingRight, TF_MS['15M']), TF_MS['15M'], cfg)
const a5M = analyzeStructure(c5M, detectSwings(c5M, cfg.swingLeft, cfg.swingRight, TF_MS['5M']), TF_MS['5M'], cfg)
const last15 = a15M.events[a15M.events.length - 1]
const last5 = a5M.events[a5M.events.length - 1]
console.log('15M last event:', last15?.type, last15?.direction, '| candles ago:', last15 && Math.round((c15M.length - 1 - c15M.findIndex((c) => c.time === last15.candleTime))))
console.log('5M last event:', last5?.type, last5?.direction, '| candles ago:', last5 && Math.round((c5M.length - 1 - c5M.findIndex((c) => c.time === last5.candleTime))))

const levels = detectLiquidity(c1H, swings1H, atr1H, TF_MS['1H'], cfg, c15M, [])
const sweeps = detectSweeps(levels, c1H, atr1H, TF_MS['1H'], cfg)
console.log('levels:', levels.length, '| sweeps:', sweeps.length)

const evaluation = evaluateSignal(
  {
    price,
    mode: 'STRICT',
    t4: { trend: 'BULLISH' },
    h1: { trend: s1H.trend, events: s1H.events, obs, atr: atr1H, volumeRatio: 2.0, displacement: null, lastCandleTime: c1H[c1H.length - 1].time, swings: swings1H },
    m15: { events: a15M.events, lastCandleTime: c15M[c15M.length - 1].time },
    m5: { events: a5M.events, displacement: null, lastCandleTime: c5M[c5M.length - 1].time },
    levels,
    sweeps,
    fvgs: fvgs1H,
  },
  cfg,
)
console.log('EVAL:', evaluation.signal, '| score:', evaluation.score, '| quality:', evaluation.quality)
console.log('explanation:', evaluation.explanation)
console.log('reasons:', evaluation.reasons.map((r) => `${r.factor}=${r.points}`).join(' '))
console.log('trade rrs:', evaluation.trade && [evaluation.trade.rr1, evaluation.trade.rr2, evaluation.trade.rr3])

// ── DB lifecycle end-to-end: fake BTC-priced LONG row opened 2 days ago ──
const now = Date.now()
const p = 80800
const created = await db.smcSignal.create({
  data: {
    symbol: 'BTCUSDT', direction: 'LONG', quality: 'A', score: 85, mode: 'STRICT',
    entryLow: p - 100, entryHigh: p + 100, entryMid: p,
    stopLoss: p - 200, tp1: p + 200, tp2: p + 400, tp3: p + 600,
    rr1: 1, rr2: 2, rr3: 3,
    obTime: 123456, obLow: p - 100, obHigh: p + 100,
    status: 'ACTIVE',
    createdAt: now - 2 * 86_400_000,
    updatedAt: now - 2 * 86_400_000,
  },
})
console.log('inserted fake row', created.id, '(entry 80800, SL 80600, TPs 81000/81200/81400, opened 2d ago)')
const { runSmcAnalysis } = await import('@/lib/smc/analysis')
await runSmcAnalysis('BTCUSDT')
const after = await db.smcSignal.findUnique({ where: { id: created.id } })
console.log('lifecycle after run:', after && { status: after.status, result: after.result, rMultiple: after.rMultiple, tp1: after.tp1At !== null, tp2: after.tp2At !== null, sl: after.slAt !== null, closed: after.closedAt !== null })
await db.smcSignal.delete({ where: { id: created.id } })
console.log('cleaned up fake row')
await db.$disconnect()
