// Shared types for the AI Signals UI — mirrors the Prisma SignalRun model.

export interface AgentReport {
  stance: 'BULLISH' | 'BEARISH' | 'NEUTRAL'
  confidence: number
  summary: string
  keyPoints: string[]
}

export interface ResearchVerdict {
  direction: 'LONG' | 'SHORT' | 'NEUTRAL'
  conviction: number
  rationale: string
  keyDrivers: string[]
}

export interface TradePlan {
  strategy: string
  entryLow: number
  entryHigh: number
  stop: number
  target1: number
  target2: number
  runner: number | null
  riskReward: string
  invalidation: string
  note: string
}

export interface RiskOpinion {
  verdict: 'APPROVE' | 'ADJUST' | 'REJECT'
  note: string
}

export interface FinalVerdict {
  decision: 'APPROVE' | 'ADJUST' | 'REJECT'
  direction: 'LONG' | 'SHORT' | 'NEUTRAL'
  confidence: number
  reasoning: string
  adjustments: Partial<Pick<TradePlan, 'entryLow' | 'entryHigh' | 'stop' | 'target1' | 'target2'>> | null
}

export interface NewsItem {
  title: string
  source: string
  pubDate: string
}

export interface Artifacts {
  snapshotSummary?: string
  news?: NewsItem[]
  analysts?: { technical: AgentReport; news: AgentReport; structure: AgentReport }
  debate?: { bull: string; bear: string; manager: ResearchVerdict }
  plan?: TradePlan | null
  risk?: { aggressive: RiskOpinion; conservative: RiskOpinion; neutral: RiskOpinion }
  memory?: Array<{ at: string; direction: string; confidence: number | null; outcome: string }>
  verdict?: FinalVerdict
}

export interface SignalRunRow {
  id: string
  symbol: string
  market: string
  displayName: string | null
  status: string
  stage: string
  progress: number
  error: string | null
  priceAtRun: number | null
  change24h: number | null
  regime: string | null
  timeframe: string | null
  direction: string | null
  confidence: number | null
  entryLow: number | null
  entryHigh: number | null
  stop: number | null
  target1: number | null
  target2: number | null
  runner: number | null
  riskReward: string | null
  invalidation: string | null
  planNote: string | null
  outcome?: string | null
  createdAt: string
  completedAt: string | null
}

export interface SignalRunDetail extends SignalRunRow {
  artifacts: Artifacts | null
}

export const STAGES = [
  { key: 'queued', label: 'Queued' },
  { key: 'data', label: 'Market data' },
  { key: 'analysts', label: 'Analyst team' },
  { key: 'debate', label: 'Bull/Bear debate' },
  { key: 'plan', label: 'Trade plan' },
  { key: 'risk', label: 'Risk committee' },
  { key: 'decision', label: 'Portfolio manager' },
] as const

export const STAGE_ORDER = ['queued', 'data', 'analysts', 'debate', 'plan', 'risk', 'decision', 'done']

export function fmtPrice(x: number | null | undefined, currency = 'USD'): string {
  if (x === null || x === undefined || !Number.isFinite(x)) return '—'
  const num = x >= 1000 ? Math.round(x).toLocaleString('en-US') : String(Math.round(x * 100) / 100)
  return currency === 'USD' ? `$${num}` : `${num} ${currency}`
}
