/**
 * SEC EDGAR 13F-HR client for the Copy Investor desk.
 *
 * Ported from the MIT-licensed "trader-skill" repo by Jake Schincariol
 * (trader-copycat/edgar13f.py) to TypeScript for the Trade2watch dashboard.
 *
 * What a 13F is, and is not:
 *   - Filed once a quarter, up to 45 days after the quarter ends; the holdings
 *     are a snapshot of the last day of the quarter and can be 4.5 months old.
 *   - Lists long positions in US-listed stocks (plus some options/converts).
 *     No shorts, cash, bonds, foreign listings or in-quarter trades.
 *   - Filed by the FIRM, not by the person the firm is known for.
 *
 * SEC rules: every request carries a User-Agent identifying the app
 * (SEC_USER_AGENT env override), and calls are spaced well under 10/sec.
 * All data comes from free public endpoints:
 *   https://data.sec.gov/submissions/CIK##########.json
 *   https://www.sec.gov/Archives/edgar/data/{cik}/{accession}/index.json
 *   https://www.sec.gov/files/company_tickers.json
 */

import { XMLParser } from 'fast-xml-parser'
import { cached } from './cache'

const SUBMISSIONS_URL = 'https://data.sec.gov/submissions/CIK%s.json'
const ARCHIVE_URL = 'https://www.sec.gov/Archives/edgar/data/%s/%s/'

const FORMS = new Set(['13F-HR', '13F-HR/A'])
const DOLLARS_FROM = new Date('2023-01-03T00:00:00Z') // filings from this date report dollars; older report thousands
const SEC_PAUSE_MS = 160 // well under SEC's 10 requests/second

export class EdgarError extends Error {}

// ─── polite fetch: identify to SEC + space calls out ────────────────────────

let lastSecCall = 0
async function pauseForSec() {
  const wait = lastSecCall + SEC_PAUSE_MS - Date.now()
  if (wait > 0) await new Promise((r) => setTimeout(r, wait))
  lastSecCall = Date.now()
}

function secUserAgent(): string {
  return (
    process.env.SEC_USER_AGENT?.trim() ||
    'Trade2watch research dashboard (13F copycat desk) owner@trade2watch.app'
  )
}

async function secGet(url: string): Promise<Response> {
  await pauseForSec()
  const res = await fetch(url, {
    headers: { 'User-Agent': secUserAgent(), Accept: 'application/json, text/xml, */*' },
    cache: 'no-store',
    signal: AbortSignal.timeout(30_000),
  })
  if (res.status === 403) {
    throw new EdgarError(
      'SEC returned 403 for this request. That usually means the User-Agent is missing/generic ' +
        '(set SEC_USER_AGENT as "AppName contact@email") or the rate limit was hit.',
    )
  }
  if (res.status === 404) throw new EdgarError(`SEC has no file at ${url}`)
  if (!res.ok) throw new EdgarError(`SEC request failed (HTTP ${res.status}) for ${url}`)
  return res
}

async function secJson<T = unknown>(url: string): Promise<T> {
  try {
    return (await (await secGet(url)).json()) as T
  } catch (e) {
    if (e instanceof EdgarError) throw e
    throw new EdgarError(`SEC did not return JSON for ${url}: ${String(e)}`)
  }
}

async function secText(url: string): Promise<string> {
  return (await secGet(url)).text()
}

// ─── filings ────────────────────────────────────────────────────────────────

export interface FilingRow {
  form: string
  accession: string
  filed: string
  period: string
  primary: string
}

interface SubmissionsJson {
  name?: string
  filings?: { recent?: Record<string, string[]> }
}

/** cik as 10 digits, zero-padded. */
export function cik10(value: string | number): string {
  return String(value).replace(/\D/g, '').padStart(10, '0')
}

export async function fetchFilerIdentity(cik: string): Promise<{ cik: string; name: string }> {
  const sub = await cached(`sub:${cik10(cik)}`, 60 * 60_000, () =>
    secJson<SubmissionsJson>(SUBMISSIONS_URL.replace('%s', cik10(cik))),
  )
  return { cik: cik10(cik), name: sub.name?.trim() || `CIK ${cik10(cik)}` }
}

/** 13F filings for a CIK, newest filing first. */
export async function list13fFilings(cik: string): Promise<FilingRow[]> {
  const sub = await cached(`sub:${cik10(cik)}`, 60 * 60_000, () =>
    secJson<SubmissionsJson>(SUBMISSIONS_URL.replace('%s', cik10(cik))),
  )
  const rec = sub.filings?.recent ?? {}
  const forms: string[] = rec.form ?? []
  const acc: string[] = rec.accessionNumber ?? []
  const filed: string[] = rec.filingDate ?? []
  const period: string[] = rec.reportDate ?? []
  const out: FilingRow[] = []
  for (let i = 0; i < forms.length; i++) {
    if (!FORMS.has(forms[i])) continue
    out.push({
      form: forms[i],
      accession: acc[i] ?? '',
      filed: filed[i] ?? '',
      period: period[i] ?? '',
      primary: primary[i] ?? '',
    })
  }
  out.sort((a, b) => (b.filed + b.accession).localeCompare(a.filed + a.accession))
  return out
}

/** The original 13F-HR for a period (default newest) + its amendments. */
export function pickFiling(
  filings: FilingRow[],
  opts: { period?: string; accession?: string } = {},
): { chosen: FilingRow; amendments: FilingRow[] } {
  let chosen: FilingRow | undefined
  if (opts.accession) {
    chosen = filings.find((f) => f.accession === opts.accession)
    if (!chosen) throw new EdgarError(`accession ${opts.accession} is not in this filer's 13F list`)
  } else {
    let originals = filings.filter((f) => f.form === '13F-HR')
    if (opts.period) originals = originals.filter((f) => f.period === opts.period)
    originals.sort((a, b) => (b.period + b.filed).localeCompare(a.period + a.filed))
    chosen = originals[0]
  }
  if (!chosen) throw new EdgarError('no 13F-HR filing found for this filer on SEC EDGAR')
  const amendments = filings.filter(
    (f) => f.form === '13F-HR/A' && f.period === chosen!.period && f.accession !== chosen!.accession,
  )
  return { chosen, amendments }
}

/** 1 for dollars (filed on/after 2023-01-03), 1000 for older filings. */
export function valueMultiplier(filed: string): 1 | 1000 {
  const d = new Date(`${filed.slice(0, 10)}T00:00:00Z`)
  return Number.isNaN(d.getTime()) || d >= DOLLARS_FROM ? 1 : 1000
}

// ─── information table parsing ──────────────────────────────────────────────

export interface InfoRow {
  issuer: string
  title: string
  cusip: string
  value: number // dollars
  shares: number
  shareType: string
  putCall: string
  manager: string
}

interface RawInfoRow {
  nameOfIssuer?: string
  titleOfClass?: string
  cusip?: string
  value?: string | number
  sshPrnamt?: string | number
  sshPrnamtType?: string
  putCall?: string
  otherManager?: string
}

function toRows(x: unknown): RawInfoRow[] {
  if (Array.isArray(x)) return x.flatMap(toRows)
  if (x && typeof x === 'object') return [x as RawInfoRow]
  return []
}

const numField = (v: string | number | undefined) => Number(String(v ?? '0').replace(/,/g, '')) || 0

/** Rows of a 13F information table XML, values in dollars. */
export function parseInfoTable(xml: string, multiplier = 1): InfoRow[] {
  const parser = new XMLParser({ removeNSPrefix: true, ignoreAttributes: true, trimValues: true })
  let doc: Record<string, unknown>
  try {
    doc = parser.parse(xml)
  } catch {
    throw new EdgarError('information table is not valid XML')
  }
  // find the key holding infoTable entries regardless of wrapper element
  let raw: RawInfoRow[] = []
  const visit = (node: unknown) => {
    if (!node || typeof node !== 'object') return
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (k === 'infoTable') raw = raw.concat(toRows(v))
      else if (v && typeof v === 'object') visit(v)
    }
  }
  visit(doc)
  if (!raw.length) throw new EdgarError('no infoTable rows found — is this a 13F information table?')

  return raw.map((r) => ({
    issuer: String(r.nameOfIssuer ?? '').trim(),
    title: String(r.titleOfClass ?? '').trim(),
    cusip: String(r.cusip ?? '').trim().toUpperCase(),
    value: numField(r.value) * multiplier,
    shares: numField(r.sshPrnamt),
    shareType: String(r.sshPrnamtType ?? 'SH').trim().toUpperCase(),
    putCall: String(r.putCall ?? '').trim().toUpperCase(),
    manager: String(r.otherManager ?? '').trim(),
  }))
}

export interface CoverFacts {
  tableValueTotal?: number
  tableEntryTotal?: number
  periodOfReport?: string
}

export function parseCover(xml: string, multiplier = 1): CoverFacts {
  try {
    const parser = new XMLParser({ removeNSPrefix: true, ignoreAttributes: true, trimValues: true })
    const doc = parser.parse(xml) as Record<string, unknown>
    const pick = (k: string): string | undefined => {
      const v = doc[k]
      return typeof v === 'string' || typeof v === 'number' ? String(v) : undefined
    }
    const tv = pick('tableValueTotal')
    const te = pick('tableEntryTotal')
    return {
      tableValueTotal: tv ? numField(tv) * multiplier : undefined,
      tableEntryTotal: te ? numField(te) : undefined,
      periodOfReport: pick('periodOfReport'),
    }
  } catch {
    return {}
  }
}

// ─── aggregation ────────────────────────────────────────────────────────────

export interface Position extends InfoRow {
  pctOf13f: number
  rows: number
  cusips: string[]
  tickers: string[]
  classes: string[]
}

export function isStock(p: Pick<InfoRow, 'shareType' | 'putCall'>): boolean {
  return p.shareType === 'SH' && !p.putCall
}

function round2(x: number): number {
  return Math.round(x * 100) / 100
}
function round1(x: number): number {
  return Math.round(x * 10) / 10
}
export function usd(x: number): string {
  return x.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })
}

/** One position per (CUSIP, PUT/CALL, share type), summing manager split rows. */
export function aggregate(rows: InfoRow[]): { positions: Position[]; total: number } {
  const total = rows.reduce((s, r) => s + r.value, 0)
  const groups = new Map<string, Position>()
  for (const r of rows) {
    const key = `${r.cusip}|${r.putCall}|${r.shareType}`
    const g = groups.get(key)
    if (g) {
      g.value += r.value
      g.shares += r.shares
      g.rows += 1
    } else {
      groups.set(key, { ...r, pctOf13f: 0, rows: 1, cusips: [r.cusip], tickers: [], classes: [] })
    }
  }
  const positions = [...groups.values()]
  for (const p of positions) p.pctOf13f = total ? round2((100 * p.value) / total) : 0
  positions.sort((a, b) => b.value - a.value || a.cusip.localeCompare(b.cusip))
  return { positions, total }
}

/** Sum share classes of one issuer (same 6-char CUSIP issuer code) — stock rows only. */
export function combineClasses(positions: Position[], total: number): Position[] {
  const out: Position[] = []
  const byIssuer = new Map<string, Position>()
  for (const p of positions) {
    if (!isStock(p)) {
      out.push(p)
      continue
    }
    const key = p.cusip.slice(0, 6)
    const q = byIssuer.get(key)
    if (!q) {
      const copy = { ...p, cusips: [p.cusip], tickers: [...p.tickers], classes: [p.title] }
      byIssuer.set(key, copy)
      out.push(copy)
      continue
    }
    q.value += p.value
    q.shares += p.shares
    q.rows += p.rows
    q.cusips.push(p.cusip)
    q.classes.push(p.title)
    for (const t of p.tickers) if (!q.tickers.includes(t)) q.tickers.push(t)
  }
  for (const q of out) q.pctOf13f = total ? round2((100 * q.value) / total) : 0
  out.sort((a, b) => b.value - a.value || a.cusip.localeCompare(b.cusip))
  return out
}

// ─── quarter-over-quarter diff ──────────────────────────────────────────────

export type DiffStatus = 'NEW' | 'SOLD OUT' | 'ADDED' | 'TRIMMED' | 'UNCHANGED'

export interface DiffRow {
  status: DiffStatus
  issuer: string
  title: string
  cusip: string
  ticker: string
  sharesBefore: number
  sharesAfter: number
  change: number
  changePct: number | null
  valueAfter: number
  valueBefore: number
}

const RANK: Record<DiffStatus, number> = { NEW: 0, 'SOLD OUT': 1, ADDED: 2, TRIMMED: 3, UNCHANGED: 4 }

/** Compare two quarters by CUSIP (+PUT/CALL): NEW / SOLD OUT / ADDED / TRIMMED / UNCHANGED. */
export function diff(current: Position[], prior: Position[]): DiffRow[] {
  const now = new Map(current.map((p) => [`${p.cusip}|${p.putCall}`, p] as const))
  const priorMap = new Map(prior.map((p) => [`${p.cusip}|${p.putCall}`, p] as const))
  const out: DiffRow[] = []
  for (const [key, p] of now) {
    const q = priorMap.get(key)
    let status: DiffStatus
    let change: number
    if (!q) {
      status = 'NEW'
      change = p.shares
    } else if (p.shares > q.shares) {
      status = 'ADDED'
      change = p.shares - q.shares
    } else if (p.shares < q.shares) {
      status = 'TRIMMED'
      change = p.shares - q.shares
    } else {
      status = 'UNCHANGED'
      change = 0
    }
    out.push({
      status,
      issuer: p.issuer,
      title: p.title,
      cusip: p.cusip,
      ticker: p.tickers[0] ?? '',
      sharesBefore: q?.shares ?? 0,
      sharesAfter: p.shares,
      change,
      changePct: q && q.shares ? round1((100 * change) / q.shares) : null,
      valueAfter: p.value,
      valueBefore: q?.value ?? 0,
    })
  }
  for (const [key, q] of priorMap) {
    if (now.has(key)) continue
    out.push({
      status: 'SOLD OUT',
      issuer: q.issuer,
      title: q.title,
      cusip: q.cusip,
      ticker: q.tickers[0] ?? '',
      sharesBefore: q.shares,
      sharesAfter: 0,
      change: -q.shares,
      changePct: -100,
      valueAfter: 0,
      valueBefore: q.value,
    })
  }
  out.sort(
    (a, b) =>
      RANK[a.status] - RANK[b.status] ||
      Math.max(b.valueAfter, b.valueBefore) - Math.max(a.valueAfter, a.valueBefore),
  )
  return out
}

// ─── full holdings fetch ────────────────────────────────────────────────────

export interface QuarterHoldings {
  meta: {
    filerCik: string
    filerName: string
    period: string
    filed: string
    form: string
    accession: string
    total: number
    coverTotal: number | null
    totalCheck: string
    notes: string[]
  }
  positions: Position[]
  rows: InfoRow[]
}

function archiveBase(cik: string, accession: string): string {
  return ARCHIVE_URL.replace('%s', String(parseInt(cik10(cik), 10))).replace(
    '%s',
    accession.replace(/-/g, ''),
  )
}

function infoTableNames(indexJson: { directory?: { item?: Array<{ name?: string }> } }): string[] {
  const names = (indexJson.directory?.item ?? []).map((it) => String(it.name ?? ''))
  const xmls = names.filter(
    (n) =>
      n.toLowerCase().endsWith('.xml') &&
      !['primary_doc.xml', 'filingsummary.xml'].includes(n.toLowerCase()),
  )
  if (!xmls.length)
    throw new EdgarError(
      'no information table XML in this filing (filings before mid-2013 are plain text and unsupported)',
    )
  return xmls
}

async function loadQuarter(
  cik: string,
  chosen: FilingRow,
  amendments: FilingRow[],
  filerName: string,
): Promise<QuarterHoldings> {
  const base = archiveBase(cik, chosen.accession)
  let indexJson: { directory?: { item?: Array<{ name?: string }> } }
  try {
    indexJson = await secJson(base + 'index.json')
  } catch {
    throw new EdgarError('could not read the filing folder on SEC EDGAR (index.json)')
  }
  const xmls = infoTableNames(indexJson)
  const table = xmls.find((n) => /info|table|13f/i.test(n)) ?? xmls[0]

  const mult = valueMultiplier(chosen.filed)
  const rows = parseInfoTable(await secText(base + table), mult)

  const meta: QuarterHoldings['meta'] = {
    filerCik: cik10(cik),
    filerName,
    period: chosen.period,
    filed: chosen.filed,
    form: chosen.form,
    accession: chosen.accession,
    total: 0,
    coverTotal: null,
    totalCheck: '',
    notes: [],
  }
  try {
    const cover = parseCover(await secText(`${base}primary_doc.xml`), mult)
    if (cover.tableValueTotal) meta.coverTotal = cover.tableValueTotal
  } catch {
    /* cover is optional for our purposes */
  }
  if (amendments.length)
    meta.notes.push(
      `Also filed for this quarter: ${amendments
        .map((a) => `${a.accession} (${a.filed})`)
        .join(', ')}. An amendment can restate the table or add confidential holdings.`,
    )

  const { positions, total } = aggregate(rows)
  meta.total = total
  if (meta.coverTotal) {
    meta.totalCheck =
      Math.abs(meta.coverTotal - total) < 1000
        ? 'Rows match the cover-page total.'
        : `Cover page says ${usd(meta.coverTotal)}; the rows add up to ${usd(total)}.`
  }
  return { meta, positions, rows }
}

/** Latest quarter's holdings for a CIK (original 13F-HR; amendments are noted). */
export async function fetchLatest13f(
  cik: string,
  opts: { period?: string; accession?: string } = {},
): Promise<QuarterHoldings> {
  const c = cik10(cik)
  const cacheKey = `13f:${c}:${opts.accession ?? opts.period ?? 'latest'}`
  return cached(cacheKey, 6 * 60 * 60_000, async () => {
    const filings = await list13fFilings(c)
    if (!filings.length) throw new EdgarError('this filer has no 13F-HR filings on SEC EDGAR')
    const { chosen, amendments } = pickFiling(filings, opts)
    const identity = await fetchFilerIdentity(c)
    return loadQuarter(c, chosen, amendments, identity.name)
  })
}

/** The holdings for an arbitrary (usually previous) quarter — used by the diff. */
export async function fetch13fByPeriod(cik: string, period: string): Promise<QuarterHoldings> {
  const c = cik10(cik)
  return cached(`13f:${c}:${period}`, 6 * 60 * 60_000, async () => {
    const filings = await list13fFilings(c)
    const { chosen, amendments } = pickFiling(filings, { period })
    const identity = await fetchFilerIdentity(c)
    return loadQuarter(c, chosen, amendments, identity.name)
  })
}
