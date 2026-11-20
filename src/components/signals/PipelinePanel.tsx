'use client'

import type { ReactNode } from 'react'
import { motion } from 'framer-motion'
import {
  Bot,
  Check,
  CircleCheck,
  CircleX,
  Clock,
  Landmark,
  Radio,
  Ruler,
  Search,
  Shield,
  Swords,
} from 'lucide-react'
import { STAGES, STAGE_ORDER } from './types'

// quiet lucide stage markers — semantic color is applied by the state ring below
const STAGE_ICONS: Record<string, ReactNode> = {
  queued: <Clock className="h-3.5 w-3.5" aria-hidden="true" />,
  data: <Radio className="h-3.5 w-3.5" aria-hidden="true" />,
  analysts: <Search className="h-3.5 w-3.5" aria-hidden="true" />,
  debate: <Swords className="h-3.5 w-3.5" aria-hidden="true" />,
  plan: <Ruler className="h-3.5 w-3.5" aria-hidden="true" />,
  risk: <Shield className="h-3.5 w-3.5" aria-hidden="true" />,
  decision: <Landmark className="h-3.5 w-3.5" aria-hidden="true" />,
  done: <Check className="h-3.5 w-3.5" aria-hidden="true" />,
}

export function PipelinePanel({
  stage,
  progress,
  status,
  error,
}: {
  stage: string
  progress: number
  status: string
  error?: string | null
}) {
  const currentIdx = STAGE_ORDER.indexOf(stage)
  const failed = status === 'failed'
  const done = status === 'completed'

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25, ease: 'easeOut' }}
      className="rounded-2xl border border-tv-line bg-tv-panel shadow-sm p-4 sm:p-5"
    >
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-semibold tracking-tight text-tv-ink inline-flex items-center gap-2">
          {failed ? (
            <CircleX className="h-3.5 w-3.5 text-bear" aria-hidden="true" />
          ) : done ? (
            <CircleCheck className="h-3.5 w-3.5 text-bull" aria-hidden="true" />
          ) : (
            <Bot className="h-3.5 w-3.5 text-tv-muted" aria-hidden="true" />
          )}
          {failed ? 'Analysis failed' : done ? 'Analysis complete' : 'Agents at work'}
        </h3>
        <span className="text-sm font-bold tabular-nums text-tv-ink">{done ? '100%' : `${progress}%`}</span>
      </div>

      <div className="h-2 rounded-full bg-tv-panel2 border border-tv-line overflow-hidden mb-4">
        <div
          className="h-full rounded-full transition-all duration-700"
          style={{
            width: `${done ? 100 : progress}%`,
            background: failed ? 'var(--bear)' : 'var(--bull)',
          }}
        />
      </div>

      <ol className="space-y-0">
        {STAGES.map((s, i) => {
          const stageIdx = STAGE_ORDER.indexOf(s.key)
          const isDone = currentIdx > stageIdx || done
          const isCurrent = currentIdx === stageIdx && !done && !failed
          return (
            <li key={s.key} className="flex items-center gap-3 py-1.5">
              <span
                className="h-7 w-7 rounded-full border inline-flex items-center justify-center shrink-0"
                style={{
                  background: isDone ? 'var(--bull-soft)' : isCurrent ? 'var(--warn-soft)' : 'var(--tv-panel2)',
                  borderColor: isDone ? 'var(--bull-line)' : isCurrent ? 'var(--warn-line)' : 'var(--tv-line)',
                  color: isDone ? 'var(--bull)' : isCurrent ? 'var(--warn)' : 'var(--tv-muted2)',
                }}
              >
                {isDone ? (
                  <Check className="h-3.5 w-3.5" aria-hidden="true" />
                ) : (
                  STAGE_ICONS[s.key] ?? <span className="h-1 w-1 rounded-full bg-tv-muted2" aria-hidden="true" />
                )}
              </span>
              <span
                className={`text-[13px] ${isCurrent ? 'font-semibold' : 'font-medium'}`}
                style={{ color: isDone ? 'var(--bull)' : isCurrent ? 'var(--warn)' : 'var(--tv-muted)' }}
              >
                {s.label}
                {isCurrent && !failed && (
                  <span className="ml-2 text-[11px] opacity-80 animate-pulse">working…</span>
                )}
              </span>
            </li>
          )
        })}
      </ol>

      {failed && error && (
        <p className="mt-3 rounded-xl bg-bear/12 text-bear border border-bear/40 px-3 py-2.5 text-xs leading-relaxed">
          {error}
        </p>
      )}
    </motion.div>
  )
}
