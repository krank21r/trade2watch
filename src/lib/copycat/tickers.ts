/**
 * Issuer-name → ticker resolution over SEC's company_tickers.json.
 *
 * Ported from trader-skill/trader-copycat/edgar13f.py (norm_name / TickerIndex,
 * MIT, Jake Schincariol): 13F information tables identify holdings by issuer
 * NAME + class title + CUSIP, so the desk needs a public name→ticker map.
 * SEC's own mapping lists every US-listed issuer (both share classes of
 * Alphabet, both classes of Berkshire, etc.), which makes class-letter-aware
 * matching possible.
 */

import { cached } from './cache'

const TICKERS_URL = 'https://www.sec.gov/files/company_tickers.json'

export interface TickerEntry {
  cik: string
  ticker: string
  title: string
}

// ─── name normalisation (ported tables) ─────────────────────────────────────

const SUFFIX_STATE = /\s*\/\s*[A-Z]{2,5}\s*\/?\s*$/ // " /NY/" state suffixes
const ABBREV: Record<string, string> = {
  AMER: 'AMERICA', AMERN: 'AMERICAN', FINL: 'FINANCIAL', FIN: 'FINANCIAL',
  PETE: 'PETROLEUM', HLDGS: 'HOLDINGS', HLDG: 'HOLDING', HOLDG: 'HOLDING',
  INTL: 'INTERNATIONAL', GRP: 'GROUP', SVCS: 'SERVICES', SVC: 'SERVICE',
  SYS: 'SYSTEMS', MGMT: 'MANAGEMENT', INDS: 'INDUSTRIES', NATL: 'NATIONAL',
  ENTMT: 'ENTERTAINMENT', PAC: 'PACIFIC', LABS: 'LABORATORIES',
  PPTYS: 'PROPERTIES', RLTY: 'REALTY', TECHS: 'TECHNOLOGIES', TECH: 'TECHNOLOGY',
  COMMNS: 'COMMUNICATIONS', COMMUNICATN: 'COMMUNICATIONS', MFG: 'MANUFACTURING',
  ELEC: 'ELECTRIC', PHARMS: 'PHARMACEUTICALS', BANCORPORATION: 'BANCORP',
  RES: 'RESOURCES', WTR: 'WATER', MTRS: 'MOTORS', AIRLS: 'AIRLINES', CHEM: 'CHEMICAL',
}
const DROP = new Set([
  'INC', 'INCORPORATED', 'CORP', 'CORPORATION', 'CO', 'COMPANY', 'LTD', 'LIMITED',
  'PLC', 'LLC', 'LP', 'SA', 'NV', 'AG', 'SE', 'THE', 'AND', 'OF',
])
const NONCOMMON = /-P[A-Z]*$|-WT[A-Z]*$|-WS$|-U$|-UN$|-R$|-RT$/

export function normName(name: string): string[] {
  let s = (name || '').toUpperCase().replace(/&/g, ' AND ')
  for (let i = 0; i < 2; i++) s = s.replace(SUFFIX_STATE, '')
  s = s.replace(/[''`]/g, '').replace(/[^A-Z0-9 ]+/g, ' ')
  const words = s.split(/\s+/).filter(Boolean).map((w) => ABBREV[w] ?? w)
  return words.filter((w) => !DROP.has(w))
}

export function nameKey(name: string): string {
  return normName(name).join('')
}

/** Class letter from a class title: "CL A" / "CLASS A" / "SER A" → "A". */
export function classLetter(title: string): string | null {
  const m = /\b(?:CL|CLASS|SER|SERIES)\s*([A-Z])\b/.exec((title || '').toUpperCase())
  return m ? m[1] : null
}

/** Strip the class part and corporate noise from a company_tickers title. */
function baseKey(title: string): string {
  let s = (title || '').toUpperCase()
  s = s.replace(/\b(CL|CLASS|SER|SERIES)\s*[A-Z0-9]+\b/g, ' ')
  s = s.replace(/\b(COMMON|CAPITAL|ORDINARY|PREFERRED|NON[-\s]?VOTING|VOTING|DEPOSITARY|SHARES|SHARE|STOCK|EACH|REPRESENTING|NEW|PAR\s+VALUE.*$|\.+\s*P[AR].*$)\b/g, ' ')
  return nameKey(s)
}

// ─── the index ──────────────────────────────────────────────────────────────

interface Index {
  byBase: Map<string, TickerEntry[]>
  byTicker: Map<string, TickerEntry>
}

let indexPromise: Promise<Index> | null = null

async function getIndex(): Promise<Index> {
  if (!indexPromise) {
    indexPromise = (async () => {
      const data = await cached('sec:company_tickers', 24 * 60 * 60_000, async () => {
        const res = await fetch(TICKERS_URL, {
          headers: { 'User-Agent': process.env.SEC_USER_AGENT?.trim() || 'Trade2watch research dashboard owner@trade2watch.app' },
          cache: 'no-store',
          signal: AbortSignal.timeout(30_000),
        })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return res.json()
      })
      const byBase = new Map<string, TickerEntry[]>()
      const byTicker = new Map<string, TickerEntry>()
      const values: unknown[] = Array.isArray(data) ? data : Object.values(data as Record<string, unknown>)
      for (const v of values) {
        const row = v as { cik_str?: number | string; ticker?: string; title?: string }
        if (!row?.ticker || !row?.title) continue
        const entry: TickerEntry = {
          cik: String(row.cik_str ?? '').padStart(10, '0'),
          ticker: String(row.ticker).trim().toUpperCase(),
          title: String(row.title),
        }
        byTicker.set(entry.ticker, entry)
        const key = baseKey(entry.title)
        if (!key) continue
        const list = byBase.get(key)
        if (list) list.push(entry)
        else byBase.set(key, [entry])
      }
      return { byBase, byTicker }
    })().catch((e) => {
      indexPromise = null // allow retry on next call
      throw e
    })
  }
  return indexPromise
}

export interface ResolvedTicker {
  ticker: string
  title: string
  cik: string
}

/**
 * Resolve an issuer name + class title to a ticker. Class-letter aware:
 * Berkshire's "ALPHABET INC, CL A" → GOOGL, "CL C" → GOOG.
 * Returns null when no US-listed match is confident.
 */
export async function resolveTicker(issuer: string, classTitle: string): Promise<ResolvedTicker | null> {
  const index = await getIndex()
  const key = nameKey(issuer)
  if (!key) return null
  const candidates = index.byBase.get(key) ?? []
  if (!candidates.length) return null
  const want = classLetter(classTitle)
  if (want) {
    const hit = candidates.find((c) => classLetter(c.title) === want)
    if (hit) return { ticker: hit.ticker, title: hit.title, cik: hit.cik }
  }
  // no class letter or unknown class: prefer the plain/common class entry
  const plain = candidates.find((c) => !classLetter(c.title)) ?? candidates[0]
  return plain ? { ticker: plain.ticker, title: plain.title, cik: plain.cik } : null
}

/** Cheap existence check for a ticker (used by the risk gate). */
export async function knownTicker(ticker: string): Promise<TickerEntry | undefined> {
  const index = await getIndex()
  return index.byTicker.get(ticker.toUpperCase())
}
