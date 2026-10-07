'use client'

import { STAGES, STAGE_ORDER } from './types'

const C = {
  panel: 'bg-[#131722] border-[#232b3d]',
  muted: 'text-[#8b93a7]',
  text: 'text-[#e6e9f0]',
  green: '#26a69a',
  amber: '#f5b544',
  red: '#ef5350',
}

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
    <div className={`rounded-[14px] border ${C.panel} p-5`}>
      <div className="flex items-center justify-between mb-4">
        <h3 className={`text-sm font-bold ${C.text}`}>
          {failed ? '❌ Analysis failed' : done ? '✅ Analysis complete' : '🤖 Agents at work'}
        </h3>
        <span className={`text-xs font-semibold ${C.muted}`}>{done ? '100%' : `${progress}%`}</span>
      </div>

      <div className="h-1.5 rounded-full bg-[#1a2030] overflow-hidden border border-[#232b3d] mb-4">
        <div
          className="h-full rounded-full transition-all duration-700"
          style={{ width: `${done ? 100 : progress}%`, background: failed ? C.red : C.green }}
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
                className="w-6 h-6 rounded-full flex items-center justify-center text-[11px] shrink-0 border"
                style={{
                  background: isDone ? 'rgba(38,166,154,.15)' : isCurrent ? 'rgba(245,181,68,.15)' : '#1a2030',
                  borderColor: isDone ? 'rgba(38,166,154,.4)' : isCurrent ? 'rgba(245,181,68,.4)' : '#232b3d',
                }}
              >
                {isDone ? '✓' : STAGE_ICONS[s.key] ?? '•'}
              </span>
              <span
                className={`text-[13px] ${isCurrent ? 'font-bold' : 'font-medium'}`}
                style={{ color: isDone ? C.green : isCurrent ? C.amber : '#8b93a7' }}
              >
                {s.label}
                {isCurrent && !failed && <span className="ml-2 text-[11px] opacity-80">working…</span>}
              </span>
            </li>
          )
        })}
      </ol>

      {failed && error && (
        <p className="mt-3 text-xs leading-relaxed px-3 py-2.5 rounded-lg bg-[rgba(239,83,80,.12)] text-[#ef5350] border border-[rgba(239,83,80,.4)]">
          {error}
        </p>
      )}
    </div>
  )
}
