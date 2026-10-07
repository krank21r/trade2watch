'use client'

import { motion } from 'framer-motion'
import { STAGES, STAGE_ORDER } from './types'

const STAGE_ICONS: Record<string, string> = {
  queued: '⏱',
  data: '📡',
  analysts: '🔍',
  debate: '⚔️',
  plan: '📐',
  risk: '🛡',
  decision: '🏛',
  done: '✅',
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
        <h3 className="text-sm font-semibold tracking-tight text-tv-ink">
          {failed ? '❌ Analysis failed' : done ? '✅ Analysis complete' : '🤖 Agents at work'}
        </h3>
        <span className="text-sm font-bold tabular-nums text-tv-ink">{done ? '100%' : `${progress}%`}</span>
      </div>

      <div className="h-2 rounded-full bg-tv-panel2 border border-tv-line overflow-hidden mb-4">
        <div
          className="h-full rounded-full transition-all duration-700"
          style={{
            width: `${done ? 100 : progress}%`,
            background: failed ? 'var(--bear)' : 'linear-gradient(90deg, var(--bull), var(--info))',
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
                className="h-7 w-7 rounded-full border text-[11px] inline-flex items-center justify-center shrink-0"
                style={{
                  background: isDone ? 'var(--bull-soft)' : isCurrent ? 'var(--warn-soft)' : 'var(--tv-panel2)',
                  borderColor: isDone ? 'var(--bull-line)' : isCurrent ? 'var(--warn-line)' : 'var(--tv-line)',
                }}
              >
                {isDone ? '✓' : STAGE_ICONS[s.key] ?? '•'}
              </span>
              <span
                className={`text-[13px] ${isCurrent ? 'font-bold' : 'font-medium'}`}
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
