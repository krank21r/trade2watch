/**
 * Deterministic state-machine verification for the live setups board.
 * Run: bun run scripts/verify-setups.ts
 */
import { buildLong, buildShort, evalSideState } from '../src/lib/setups/generate'
import type { TechnicalSnapshot } from '../src/lib/market/snapshot'

function fakeSnapshot(price: number): TechnicalSnapshot {
  return {
    symbol: 'TEST',
    market: 'crypto',
    displayName: 'Test',
    currency: 'USD',
    price,
    change24h: 0,
    timeframe: '4h',
    regime: 'RANGING',
    regimeNote: '',
    ema20: price,
    ema50: price,
    ema200: price,
    rsi14: 50,
    macd: null,
    macdCross: 'NONE',
    atr: 100, // 1% of 10k
    atrPct: 1,
    bb: { upper: null, mid: null, lower: null },
    supports: [9500, 9200, 9000],
    resistances: [10500, 10800, 11000],
    rangeHigh: 10800,
    rangeLow: 9200,
    pctFromRangeHigh: 0,
    pctFromRangeLow: 0,
    volumeTrend: 'FLAT',
    slope: 0,
    recentCandles: [],
    candlesAnalyzed: 200,
  }
}

let fails = 0
function expect(name: string, cond: boolean, detail: string) {
  console.log(`${cond ? '✅' : '❌'} ${name} — ${detail}`)
  if (!cond) fails++
}

// ── case 1: price mid-range → both WAITING, long zone strictly below, short zone strictly above
{
  const px = 10000
  const L = buildLong(fakeSnapshot(px), 'EDGE ONLY')
  const S = buildShort(fakeSnapshot(px), 'EDGE ONLY')
  expect('mid-range: long WAITING', L.state === 'WAITING', `state=${L.state}, dist=${L.dist?.toFixed(0)}`)
  expect('mid-range: short WAITING', S.state === 'WAITING', `state=${S.state}, dist=${S.dist?.toFixed(0)}`)
  expect('long zone below price', L.entryHigh < px, `zoneTop ${L.entryHigh.toFixed(0)} < ${px}`)
  expect('short zone above price', S.entryLow > px, `zoneBot ${S.entryLow.toFixed(0)} > ${px}`)
  expect('long stop below zone', L.stop < L.entryLow, `stop ${L.stop.toFixed(0)} < ${L.entryLow.toFixed(0)}`)
  expect('short stop above zone', S.stop > S.entryHigh, `stop ${S.stop.toFixed(0)} > ${S.entryHigh.toFixed(0)}`)
  expect('long T2 above T1', L.t2 > L.t1 && L.t1 > L.entryHigh, `T1 ${L.t1.toFixed(0)}, T2 ${L.t2.toFixed(0)}`)
  expect('short T2 below T1', S.t2 < S.t1 && S.t1 < S.entryLow, `T1 ${S.t1.toFixed(0)}, T2 ${S.t2.toFixed(0)}`)
  const lrr = L.rr.match(/1 : ([\d.]+) at T1/)
  expect('long T1 R:R ≥ 2.0', lrr !== null && parseFloat(lrr[1]) >= 2, L.rr)
}

// ── case 2: state machine against a HELD zone (what the UI shows between polls)
{
  const zone = buildLong(fakeSnapshot(10000), 'PREFERRED')
  expect('long LIVE: price inside held zone', evalSideState(zone, true, (zone.entryLow + zone.entryHigh) / 2) === 'LIVE', `px ${(zone.entryLow + zone.entryHigh) / 2} in ${zone.entryLow.toFixed(0)}–${zone.entryHigh.toFixed(0)}`)
  expect('long LIVE: price at zone top edge', evalSideState(zone, true, zone.entryHigh) === 'LIVE', `px ${zone.entryHigh.toFixed(0)}`)
  expect('long WAITING: price above zone', evalSideState(zone, true, 10000) === 'WAITING', 'px 10000 > zone top')
  expect('long VOID: price below stop', evalSideState(zone, true, zone.stop - 1) === 'VOID', `px ${zone.stop - 1} ≤ stop ${zone.stop.toFixed(0)}`)

  const szone = buildShort(fakeSnapshot(10000), 'PREFERRED')
  expect('short LIVE: price inside held zone', evalSideState(szone, false, (szone.entryLow + szone.entryHigh) / 2) === 'LIVE', `px ${(szone.entryLow + szone.entryHigh) / 2} in ${szone.entryLow.toFixed(0)}–${szone.entryHigh.toFixed(0)}`)
  expect('short VOID: price beyond stop', evalSideState(szone, false, szone.stop + 1) === 'VOID', `px ${szone.stop + 1} ≥ stop ${szone.stop.toFixed(0)}`)
}

// ── case 3: THE REGRESSION — price far ABOVE short invalidation must be VOID, never "SHORT ZONE LIVE"
{
  const zone = buildShort(fakeSnapshot(10000), 'PREFERRED')
  const px = 12000 // +12% — far beyond stop
  const state = evalSideState(zone, false, px)
  const wouldOldAppFire = px >= zone.entryLow // original zoneState() logic
  expect('VOID beyond short stop', state === 'VOID', `px ${px} ≥ stop ${zone.stop.toFixed(0)} → ${state}`)
  expect('old logic WOULD have fired (bug reproduced)', wouldOldAppFire, 'original zoneState() had no invalid check — this was the ETH $2,548 false banner')
  const rebuilt = buildShort(fakeSnapshot(px), 'PREFERRED')
  expect('rebuilt short never LIVE at price', rebuilt.state !== 'LIVE', `state=${rebuilt.state}`)
}

// ── case 4: price far BELOW long invalidation → long VOID
{
  const zone = buildLong(fakeSnapshot(10000), 'PREFERRED')
  expect('long VOID below stop zone', evalSideState(zone, true, zone.stop - 500) === 'VOID', `px ${zone.stop - 500} ≤ stop ${zone.stop.toFixed(0)}`)
  const rebuilt = buildLong(fakeSnapshot(zone.stop - 500), 'PREFERRED')
  expect('rebuilt long never LIVE below stop zone', rebuilt.state !== 'LIVE', `state=${rebuilt.state} at price ${zone.stop - 500}`)
}

// ── case 5: small-price coin (PEPE-like) keeps proportions
{
  const s = fakeSnapshot(0.0000055)
  s.atr = 0.00000022
  s.supports = [0.0000052, 0.0000049]
  s.resistances = [0.000006, 0.0000066]
  s.rangeHigh = 0.0000066
  s.rangeLow = 0.0000049
  const L = buildLong(s, 'EDGE ONLY')
  const S = buildShort(s, 'EDGE ONLY')
  expect('micro-price: long zone sane', L.entryLow > 0 && L.entryLow < L.entryHigh, `${L.entryLow.toPrecision(4)}–${L.entryHigh.toPrecision(4)}`)
  expect('micro-price: short zone sane', S.entryLow > s.price, `${S.entryLow.toPrecision(4)} > 0.0000055`)
  expect('micro-price: no zero/negative targets', L.t1 > 0 && S.t1 > 0, `T1s ${L.t1.toPrecision(4)} / ${S.t1.toPrecision(4)}`)
}

console.log(fails === 0 ? '\nALL CHECKS PASSED' : `\n${fails} CHECKS FAILED`)
process.exit(fails === 0 ? 0 : 1)
