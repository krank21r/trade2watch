'use client'

import { useState } from 'react'
import type { Artifacts, SignalRunDetail } from './types'

const C = {
  panel: 'bg-[#131722] border-[#232b3d]',
  muted: 'text-[#8b93a7]',
  text: 'text-[#e6e9f0]',
}

function verdictColor(v: string): string {
  return v === 'APPROVE' ? '#26a69a' : v === 'ADJUST' ? '#f5b544' : '#ef5350'
}
function stanceColor(s: string): string {
  return s === 'BULLISH' ? '#26a69a' : s === 'BEARISH' ? '#ef5350' : '#f5b544'
}

function Section({
  title,
  subtitle,
  children,
  defaultOpen = false,
}: {
  title: string
  subtitle?: string
  children: React.ReactNode
  defaultOpen?: boolean
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="border-b border-dashed border-white/5 last:border-0">
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between gap-3 py-3 text-left group"
        aria-expanded={open}
        suppressHydrationWarning
      >
        <span className="flex flex-col">
          <span className={`text-[13px] font-bold group-hover:text-[#f5b544] transition-colors ${C.text}`}>{title}</span>
          {subtitle && (
            <span className="text-[11.5px] mt-0.5" style={{ color: subtitle.split(':')[0] === '' ? undefined : undefined }}>
              {subtitle}
            </span>
          )}
        </span>
        <span className={`text-xs transition-transform ${C.muted}`} style={{ transform: open ? 'rotate(180deg)' : 'none' }}>
          ▼
        </span>
      </button>
      {open && <div className="pb-4 text-[13px] leading-relaxed whitespace-pre-wrap">{children}</div>}
    </div>
  )
}

export function ReportsPanel({ run }: { run: SignalRunDetail }) {
  const a: Artifacts | null = run.artifacts
  if (!a) return null

  const analysts = a.analysts
  const debate = a.debate
  const risk = a.risk
  const verdict = a.verdict

  return (
    <div className={`rounded-[14px] border ${C.panel} px-5 py-2`}>
      <h3 className={`text-sm font-bold py-3 border-b border-[#232b3d] ${C.text}`}>📋 Agent transcripts</h3>

      {analysts && (
        <>
          <Section
            title="🔍 Technical analyst"
            subtitle={`stance ${analysts.technical.stance} · confidence ${analysts.technical.confidence}%`}
          >
            <p style={{ color: stanceColor(analysts.technical.stance) }} className="font-bold mb-1">
              {analysts.technical.stance}
            </p>
            {analysts.technical.summary}
            {analysts.technical.keyPoints.length > 0 && (
              <ul className="mt-2 space-y-1">
                {analysts.technical.keyPoints.map((k, i) => (
                  <li key={i} className="text-[#8b93a7]">
                    • {k}
                  </li>
                ))}
              </ul>
            )}
          </Section>
          <Section
            title="📰 News / sentiment analyst"
            subtitle={`stance ${analysts.news.stance} · confidence ${analysts.news.confidence}%`}
          >
            <p style={{ color: stanceColor(analysts.news.stance) }} className="font-bold mb-1">
              {analysts.news.stance}
            </p>
            {analysts.news.summary}
            {analysts.news.keyPoints.length > 0 && (
              <ul className="mt-2 space-y-1">
                {analysts.news.keyPoints.map((k, i) => (
                  <li key={i} className="text-[#8b93a7]">
                    • {k}
                  </li>
                ))}
              </ul>
            )}
            {a.news && a.news.length > 0 && (
              <div className="mt-3 pt-3 border-t border-white/5">
                <p className="text-[11px] font-bold uppercase tracking-wider text-[#8b93a7] mb-1.5">Headlines reviewed</p>
                <ul className="space-y-1">
                  {a.news.slice(0, 6).map((n, i) => (
                    <li key={i} className="text-[12px] text-[#8b93a7]">
                      [{n.source}] {n.title}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </Section>
          <Section
            title="🏗 Market-structure analyst"
            subtitle={`stance ${analysts.structure.stance} · confidence ${analysts.structure.confidence}%`}
          >
            <p style={{ color: stanceColor(analysts.structure.stance) }} className="font-bold mb-1">
              {analysts.structure.stance}
            </p>
            {analysts.structure.summary}
            {analysts.structure.keyPoints.length > 0 && (
              <ul className="mt-2 space-y-1">
                {analysts.structure.keyPoints.map((k, i) => (
                  <li key={i} className="text-[#8b93a7]">
                    • {k}
                  </li>
                ))}
              </ul>
            )}
          </Section>
        </>
      )}

      {debate && (
        <>
          <Section title="🐂 Bull researcher">
            <span className="text-[#8b93a7]">{debate.bull}</span>
          </Section>
          <Section title="🐻 Bear researcher">
            <span className="text-[#8b93a7]">{debate.bear}</span>
          </Section>
          <Section
            title="🏛 Research manager"
            subtitle={`verdict ${debate.manager.direction} · conviction ${debate.manager.conviction}%`}
            defaultOpen
          >
            <p style={{ color: stanceColor(debate.manager.direction === 'LONG' ? 'BULLISH' : debate.manager.direction === 'SHORT' ? 'BEARISH' : 'NEUTRAL') }} className="font-bold mb-1">
              {debate.manager.direction}
            </p>
            {debate.manager.rationale}
            {debate.manager.keyDrivers?.length > 0 && (
              <ul className="mt-2 space-y-1">
                {debate.manager.keyDrivers.map((k, i) => (
                  <li key={i} className="text-[#8b93a7]">
                    • {k}
                  </li>
                ))}
              </ul>
            )}
          </Section>
        </>
      )}

      {risk && (
        <Section title="🛡 Risk committee">
          <div className="space-y-3">
            {(['aggressive', 'conservative', 'neutral'] as const).map((who) => (
              <div key={who}>
                <span className="font-bold" style={{ color: verdictColor(risk[who].verdict) }}>
                  {who.toUpperCase()} — {risk[who].verdict}
                </span>
                <p className="text-[#8b93a7] mt-0.5">{risk[who].note}</p>
              </div>
            ))}
          </div>
        </Section>
      )}

      {verdict && (
        <Section title={`⚖️ Portfolio manager — ${verdict.decision}`} defaultOpen>
          <p style={{ color: verdictColor(verdict.decision) }} className="font-bold mb-1">
            {verdict.decision} · confidence {verdict.confidence}%
          </p>
          {verdict.reasoning}
        </Section>
      )}
    </div>
  )
}
