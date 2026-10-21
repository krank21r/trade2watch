/**
 * Well-known 13F filers for the Copy Investor desk.
 * Source: trader-skill/trader-copycat/filers.json (MIT, Jake Schincariol) —
 * every CIK was checked against SEC's submissions API on 2026-10-13;
 * last_13f is the newest 13F-HR seen that day.
 *
 * A 13F is filed by the FIRM, not the person: the person is who the firm is
 * known for, and some of them no longer run it.
 */

export interface CuratedFiler {
  cik: string
  name: string
  person: string
  aliases: string[]
  last_13f: string
  status?: string
}

export const CURATED_FILERS: CuratedFiler[] = [
  { cik: '0001067983', name: 'Berkshire Hathaway Inc', person: 'Warren Buffett (Chairman Emeritus) & Greg Abel (CEO)', aliases: ['berkshire', 'buffett', 'greg abel'], last_13f: '2026-08-14' },
  { cik: '0001336528', name: 'Pershing Square Capital Management', person: 'Bill Ackman', aliases: ['pershing', 'ackman'], last_13f: '2026-05-15' },
  { cik: '0001649339', name: 'Scion Asset Management', person: 'Michael Burry', aliases: ['scion', 'burry'], last_13f: '2025-11-03', status: 'no 13F-HR filed since 2025-11-03' },
  { cik: '0001350694', name: 'Bridgewater Associates', person: 'founded by Ray Dalio', aliases: ['bridgewater', 'dalio'], last_13f: '2026-08-14' },
  { cik: '0001697748', name: 'ARK Investment Management', person: 'Cathie Wood', aliases: ['ark', 'ark invest', 'cathie wood'], last_13f: '2026-08-14' },
  { cik: '0001536411', name: 'Duquesne Family Office', person: 'Stanley Druckenmiller', aliases: ['duquesne', 'druckenmiller'], last_13f: '2026-08-14' },
  { cik: '0001656456', name: 'Appaloosa LP', person: 'David Tepper', aliases: ['appaloosa', 'tepper'], last_13f: '2026-08-14' },
  { cik: '0001061768', name: 'Baupost Group', person: 'Seth Klarman', aliases: ['baupost', 'klarman'], last_13f: '2026-08-13' },
  { cik: '0001040273', name: 'Third Point LLC', person: 'Dan Loeb', aliases: ['third point', 'loeb'], last_13f: '2026-08-14' },
  { cik: '0001709323', name: 'Himalaya Capital Management', person: 'Li Lu', aliases: ['himalaya', 'li lu'], last_13f: '2026-08-14' },
  { cik: '0000921669', name: 'Icahn Carl C', person: 'Carl Icahn', aliases: ['icahn'], last_13f: '2026-08-14' },
  { cik: '0001029160', name: 'Soros Fund Management', person: 'George Soros (family office)', aliases: ['soros'], last_13f: '2026-08-14' },
  { cik: '0001037389', name: 'Renaissance Technologies', person: 'founded by Jim Simons', aliases: ['renaissance', 'rentec'], last_13f: '2026-08-13' },
  { cik: '0001167483', name: 'Tiger Global Management', person: 'Chase Coleman', aliases: ['tiger global', 'chase coleman'], last_13f: '2026-08-14' },
  { cik: '0001135730', name: 'Coatue Management', person: 'Philippe Laffont', aliases: ['coatue', 'laffont'], last_13f: '2026-08-14' },
  { cik: '0001061165', name: 'Lone Pine Capital', person: 'founded by Stephen Mandel', aliases: ['lone pine'], last_13f: '2026-08-14' },
  { cik: '0001791786', name: 'Elliott Investment Management', person: 'founded by Paul Singer', aliases: ['elliott', 'paul singer'], last_13f: '2026-08-14' },
  { cik: '0001569205', name: 'Fundsmith LLP', person: 'Terry Smith', aliases: ['fundsmith', 'terry smith'], last_13f: '2026-08-14' },
  { cik: '0001096343', name: 'Markel Group Inc.', person: 'Tom Gayner', aliases: ['markel', 'gayner'], last_13f: '2026-07-31' },
  { cik: '0001166559', name: 'Gates Foundation Trust', person: 'Bill & Melinda Gates Foundation Trust', aliases: ['gates', 'gates foundation', 'bill gates'], last_13f: '2026-08-14' },
  { cik: '0001549575', name: 'Dalal Street, LLC', person: 'Mohnish Pabrai', aliases: ['pabrai', 'mohnish pabrai'], last_13f: '2026-08-13' },
  { cik: '0001112520', name: 'Akre Capital Management', person: 'founded by Chuck Akre', aliases: ['akre'], last_13f: '2026-08-14' },
  { cik: '0000949509', name: 'Oaktree Capital Management', person: 'Howard Marks', aliases: ['oaktree', 'howard marks'], last_13f: '2026-08-14' },
]

export function findFilerByCik(cik: string): CuratedFiler | undefined {
  return CURATED_FILERS.find((f) => f.cik === cik)
}
