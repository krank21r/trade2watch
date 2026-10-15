'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { Ph, type PhName } from './icons'

/* ---------------------------------- data --------------------------------- */

type Topic = { key: string; label: string; icon: PhName }
type Faq = { q: string; a: string }
type Group = { key: string; icon: PhName; title: string; desc: string; faqs: Faq[] }

const TOPICS: Topic[] = [
  { key: 'all', label: 'All topics', icon: 'squares-four' },
  { key: 'getting-started', label: 'Getting started', icon: 'rocket-launch' },
  { key: 'prompt-library', label: 'Prompt library', icon: 'books' },
  { key: 'billing', label: 'Billing & credits', icon: 'credit-card' },
  { key: 'agents', label: 'Skill & agents', icon: 'robot' },
  { key: 'export', label: 'Export', icon: 'export' },
]

const GROUPS: Group[] = [
  {
    key: 'getting-started',
    icon: 'rocket-launch-fill',
    title: 'Getting started',
    desc: 'Create an account, import your first file, and ship your first render in minutes.',
    faqs: [
      {
        q: 'How do I create my first design?',
        a: 'Sign up, open the Canvas, and describe what you want in plain language — or drop in a reference image. Mosaic returns four explorations in about twenty seconds; pick one and keep iterating right on the canvas.',
      },
      {
        q: 'Can I import files from Figma or Sketch?',
        a: 'Yes. Connect Figma through the Mosaic plugin to pull frames across with layers, text styles, and components intact. Sketch files import directly — artboards map to frames and we auto-match any missing fonts.',
      },
      {
        q: 'Do I need design experience to use Mosaic?',
        a: 'Not at all. Mosaic is prompt-first: describe the outcome and the engine handles layout, spacing, and type scale. Every render is fully editable, so designers can fine-tune anything when it matters.',
      },
      {
        q: 'Where should I learn prompt basics?',
        a: 'Start with the starter recipes in the Prompt library — each one shows the anatomy of a good brief, from subject to style to constraints. Five minutes there usually saves an hour of trial and error.',
      },
    ],
  },
  {
    key: 'prompt-library',
    icon: 'book-open-text-fill',
    title: 'Prompt library',
    desc: 'Save, remix, and share reusable prompt recipes across your team.',
    faqs: [
      {
        q: 'What exactly is a prompt recipe?',
        a: 'A recipe is a reusable, parameterized prompt: lock the style, layout, and brand tokens, then expose {{variables}} for the parts that change. Run it ten times for ten campaigns without rewriting a word.',
      },
      {
        q: 'Can I share recipes with my team?',
        a: 'Anything you save to a workspace library is available to every member, with view and edit roles. Teammates can comment on a recipe before running it, and admins can pin the house favorites.',
      },
      {
        q: 'How do I remix someone else’s recipe?',
        a: 'Open any shared recipe and hit Fork — Mosaic detects its variables, copies it into your private library, and lets you swap style references or constraints while the original stays untouched.',
      },
      {
        q: 'Do recipes cost credits to browse?',
        a: 'Browsing, forking, and editing recipes are always free. Credits are only consumed when a recipe runs and a render is produced.',
      },
    ],
  },
  {
    key: 'billing',
    icon: 'credit-card-fill',
    title: 'Billing & credits',
    desc: 'Plans, credit costs, invoices, and refunds — the short version.',
    faqs: [
      {
        q: 'How do credits work?',
        a: 'One credit covers a standard-resolution render; 4K exports cost four. Failed renders are refunded automatically within a minute, and unused credits roll over for 90 days on paid plans.',
      },
      {
        q: 'Can I change or cancel my plan anytime?',
        a: 'Yes. Upgrades apply instantly and are prorated to the day; downgrades and cancellations take effect at the end of the billing period, and you keep full access until then.',
      },
      {
        q: 'Is there a free plan?',
        a: 'Every new workspace starts with 40 monthly credits, full Canvas access, and watermark-free PNG export. No card required, and it stays free for as long as you like.',
      },
      {
        q: 'How do I get invoices for my business?',
        a: 'Head to Settings → Billing → Invoices to download PDFs for any period, add a VAT or GST ID, and opt into auto-emailing each invoice to your finance team.',
      },
    ],
  },
]

const POPULAR = [
  { label: 'Import from Figma', q: 'figma' },
  { label: 'Credit costs', q: 'credits' },
  { label: 'Team sharing', q: 'share' },
]

const METRICS = [
  { pre: '', value: '4.9', suf: '/5', label: 'Average review score' },
  { pre: '+', value: '38', suf: 'k', label: 'Designs shipped every week' },
  { pre: '', value: '12', suf: 'x', label: 'Faster first drafts, brief to render' },
  { pre: '', value: '99.98', suf: '%', label: 'Render uptime, trailing 90 days' },
]

/* --------------------------------- page ---------------------------------- */

export default function HelpCenter() {
  const [topic, setTopic] = useState('all')
  const [query, setQuery] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  // ⌘K / Ctrl+K focuses the search field
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        inputRef.current?.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const q = query.trim().toLowerCase()

  const visibleGroups = useMemo(() => {
    return GROUPS.filter((g) => topic === 'all' || g.key === topic)
      .map((g) => ({
        ...g,
        faqs: q
          ? g.faqs.filter((f) => `${f.q} ${f.a}`.toLowerCase().includes(q))
          : g.faqs,
      }))
      .filter((g) => g.faqs.length > 0)
  }, [topic, q])

  const topicComingSoon = topic !== 'all' && !GROUPS.some((g) => g.key === topic)
  const searchEmpty = !topicComingSoon && visibleGroups.length === 0

  const clear = () => {
    setQuery('')
    setTopic('all')
    inputRef.current?.focus()
  }

  return (
    <div className="flex min-h-screen flex-col bg-slate-50 text-slate-900">
      <Nav />
      <main className="flex-1">
        <Hero
          query={query}
          onQueryChange={setQuery}
          inputRef={inputRef}
          onPopular={(v) => {
            setQuery(v)
            setTopic('all')
          }}
        />
        <TopicPills topic={topic} onSelect={setTopic} />
        <FaqSection
          groups={visibleGroups}
          topic={topic}
          query={q}
          topicComingSoon={topicComingSoon}
          searchEmpty={searchEmpty}
          onClear={clear}
          onBackToAll={() => setTopic('all')}
        />
        <TrustBand />
        <Cta />
      </main>
      <Footer />
    </div>
  )
}

/* --------------------------------- nav ----------------------------------- */

const NAV_LINKS = ['Library', 'Canvas', 'Pricing', 'Help'] as const

function Nav() {
  return (
    <header className="sticky top-0 z-50 border-b border-slate-900/[0.06] bg-slate-50/85 backdrop-blur-xl">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-4 px-4 sm:px-6">
        <a href="#" className="group flex shrink-0 items-center gap-2.5">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-teal-700 shadow-[0_6px_16px_-6px_rgba(15,118,110,0.6)] transition-colors duration-200 group-hover:bg-teal-800">
            <Ph name="sparkle-fill" className="h-[18px] w-[18px] text-white" />
          </span>
          <span className="text-[17px] font-extrabold tracking-tight text-slate-900">
            Mosaic<span className="text-teal-700">.</span>
          </span>
        </a>

        <nav aria-label="Primary" className="hidden items-center gap-7 md:flex">
          {NAV_LINKS.map((label) => (
            <a
              key={label}
              href="#"
              aria-current={label === 'Help' ? 'page' : undefined}
              className={
                label === 'Help'
                  ? 'text-sm font-semibold text-teal-700'
                  : 'text-sm font-medium text-slate-600 transition-colors duration-200 hover:text-slate-900'
              }
            >
              {label}
            </a>
          ))}
        </nav>

        <div className="flex shrink-0 items-center gap-3 sm:gap-5">
          <a
            href="#"
            className="hidden text-sm font-medium text-slate-600 transition-colors duration-200 hover:text-slate-900 sm:inline"
          >
            Sign in
          </a>
          <a
            href="#"
            className="rounded-lg bg-teal-700 px-4 py-2 text-sm font-semibold text-white shadow-[0_10px_24px_-10px_rgba(15,118,110,0.55)] transition-all duration-200 hover:bg-teal-800 hover:shadow-[0_12px_28px_-10px_rgba(15,118,110,0.65)]"
          >
            Start free
          </a>
        </div>
      </div>
    </header>
  )
}

/* --------------------------------- hero ---------------------------------- */

type HeroProps = {
  query: string
  onQueryChange: (v: string) => void
  inputRef: React.RefObject<HTMLInputElement | null>
  onPopular: (q: string) => void
}

function Hero({ query, onQueryChange, inputRef, onPopular }: HeroProps) {
  return (
    <section className="relative overflow-hidden">
      {/* gradient wash + blurred teal blobs */}
      <div
        aria-hidden="true"
        className="absolute inset-0 bg-gradient-to-b from-teal-50/70 to-slate-50"
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -top-28 left-1/2 h-80 w-[36rem] -translate-x-[85%] rounded-full bg-teal-200/40 blur-3xl"
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -top-12 left-1/2 h-72 w-[32rem] -translate-y-1/4 translate-x-[15%] rounded-full bg-teal-300/30 blur-3xl"
      />

      <div className="relative mx-auto max-w-3xl px-4 pb-14 pt-16 text-center sm:px-6 md:pb-16 md:pt-20">
        <span className="inline-flex items-center gap-2 rounded-full border border-teal-200 bg-white/70 px-3.5 py-1.5 text-[12.5px] font-semibold text-teal-700">
          <Ph name="globe-simple" className="h-3.5 w-3.5" />
          Help Center
        </span>

        <h1 className="mt-5 text-[34px] font-extrabold leading-[44px] tracking-tight text-slate-900">
          How can we help you
          <br className="hidden sm:block" /> design today?
        </h1>
        <p className="mx-auto mt-3 max-w-xl text-[15px] leading-relaxed text-slate-500">
          Search 300+ guides and prompt recipes, browse common questions, or
          reach a real human — most replies land in under four minutes.
        </p>

        <div className="mx-auto mt-8 max-w-2xl">
          <div className="flex items-center gap-3 rounded-2xl border border-slate-900/10 bg-white px-5 shadow-[0_16px_44px_-16px_rgba(15,118,110,0.22)] transition-all duration-200 focus-within:border-teal-500 focus-within:ring-4 focus-within:ring-teal-500/15">
            <Ph
              name="magnifying-glass"
              className="h-[18px] w-[18px] shrink-0 text-slate-400"
            />
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={(e) => onQueryChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') onQueryChange('')
              }}
              aria-label="Search the help center"
              placeholder="Search guides, prompts, billing — anything"
              className="h-14 w-full bg-transparent text-[15px] text-slate-900 outline-none placeholder:text-slate-400"
            />
            <kbd className="hidden shrink-0 rounded-md border border-slate-900/[0.06] bg-slate-50 px-1.5 py-1 font-sans text-[11px] font-semibold text-slate-500 sm:inline-block">
              ⌘K
            </kbd>
          </div>

          <p className="mt-3.5 text-[13px] text-slate-500">
            <span className="font-medium text-slate-600">Popular:</span>{' '}
            {POPULAR.map((p, i) => (
              <span key={p.label}>
                <button
                  type="button"
                  onClick={() => onPopular(p.q)}
                  className="text-slate-600 underline-offset-2 transition-colors duration-150 hover:text-teal-700 hover:underline"
                >
                  {p.label}
                </button>
                {i < POPULAR.length - 1 ? ', ' : ''}
              </span>
            ))}
          </p>
        </div>
      </div>
    </section>
  )
}

/* ------------------------------ topic pills ------------------------------ */

function TopicPills({
  topic,
  onSelect,
}: {
  topic: string
  onSelect: (key: string) => void
}) {
  return (
    <section aria-label="Browse by topic" className="border-y border-slate-900/5">
      <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-center gap-2.5 px-4 py-4 sm:px-6">
        {TOPICS.map((t) => {
          const active = topic === t.key
          return (
            <button
              key={t.key}
              type="button"
              onClick={() => onSelect(t.key)}
              aria-pressed={active}
              className={
                active
                  ? 'inline-flex items-center gap-2 rounded-full bg-teal-700 px-4 py-2.5 text-[13.5px] font-semibold text-white shadow-[0_8px_18px_-8px_rgba(15,118,110,0.55)]'
                  : 'inline-flex items-center gap-2 rounded-full border border-slate-900/10 bg-white px-4 py-2.5 text-[13.5px] font-medium text-slate-600 transition-all duration-200 hover:border-teal-300 hover:text-teal-700'
              }
            >
              <Ph
                name={t.icon}
                className={`h-4 w-4 ${active ? 'text-white' : 'text-teal-600'}`}
              />
              {t.label}
            </button>
          )
        })}
      </div>
    </section>
  )
}

/* ------------------------------ FAQ section ------------------------------ */

type FaqSectionProps = {
  groups: Group[]
  topic: string
  query: string
  topicComingSoon: boolean
  searchEmpty: boolean
  onClear: () => void
  onBackToAll: () => void
}

function FaqSection({
  groups,
  topic,
  query,
  topicComingSoon,
  searchEmpty,
  onClear,
  onBackToAll,
}: FaqSectionProps) {
  return (
    <section className="mx-auto w-full max-w-5xl px-4 py-14 sm:px-6 md:py-16">
      {topicComingSoon && (
        <div className="flex flex-col items-center py-14 text-center">
          <Ph name="robot" className="h-7 w-7 text-slate-300" />
          <p className="mt-3 text-[15px] font-semibold text-slate-700">
            Nothing here yet
          </p>
          <p className="mt-1 max-w-sm text-[13.5px] text-slate-500">
            Guides for this topic are on the way — browse All topics in the
            meantime.
          </p>
          <button
            type="button"
            onClick={onBackToAll}
            className="mt-4 text-sm font-semibold text-teal-700 underline-offset-2 hover:underline"
          >
            Back to all topics
          </button>
        </div>
      )}

      {searchEmpty && !topicComingSoon && (
        <div className="flex flex-col items-center py-14 text-center">
          <Ph name="magnifying-glass" className="h-7 w-7 text-slate-300" />
          <p className="mt-3 text-[15px] font-semibold text-slate-700">
            No matches for &ldquo;{query}&rdquo;
          </p>
          <p className="mt-1 max-w-sm text-[13.5px] text-slate-500">
            Try a different phrase, or clear the search to see everything
            again.
          </p>
          <button
            type="button"
            onClick={onClear}
            className="mt-4 text-sm font-semibold text-teal-700 underline-offset-2 hover:underline"
          >
            Clear search
          </button>
        </div>
      )}

      {groups.map((g, gi) => (
        <div key={g.key} className={gi > 0 ? 'mt-12' : ''}>
          <div className="mb-5 flex items-center gap-3.5">
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-teal-700 shadow-[0_8px_20px_-8px_rgba(15,118,110,0.5)]">
              <Ph name={g.icon} className="h-5 w-5 text-white" />
            </span>
            <div className="text-left">
              <h2 className="text-lg font-bold tracking-tight text-slate-900">
                {g.title}
              </h2>
              <p className="mt-0.5 text-[13px] text-slate-500">{g.desc}</p>
            </div>
          </div>

          <div className="grid gap-3">
            {g.faqs.map((f, fi) => {
              const defaultOpen = gi === 0 && fi === 0 && topic === 'all' && !query
              return (
                <details
                  key={f.q}
                  open={defaultOpen || undefined}
                  className="group rounded-xl border border-slate-900/10 bg-white transition-all duration-200 open:border-teal-200 open:shadow-[0_18px_40px_-18px_rgba(15,118,110,0.28)]"
                >
                  <summary className="flex cursor-pointer list-none select-none items-center justify-between gap-4 p-5 [&::-webkit-details-marker]:hidden">
                    <span className="text-[15px] font-semibold text-slate-800">
                      {f.q}
                    </span>
                    <Ph
                      name="caret-down"
                      className="h-4 w-4 shrink-0 text-teal-700 transition-transform duration-200 group-open:rotate-180"
                    />
                  </summary>
                  <div className="faq-answer px-5 pb-5">
                    <p className="max-w-prose text-[14px] leading-relaxed text-slate-500">
                      {f.a}
                    </p>
                  </div>
                </details>
              )
            })}
          </div>
        </div>
      ))}
    </section>
  )
}

/* -------------------------- trust band (metrics) ------------------------- */

function TrustBand() {
  return (
    <section className="border-t border-slate-900/5">
      <div className="mx-auto max-w-5xl px-4 py-14 sm:px-6 md:py-16">
        <div className="flex justify-center">
          <span className="inline-flex items-center gap-2 rounded-full border border-teal-700/20 bg-teal-100/50 px-3.5 py-1.5 text-[11px] font-bold uppercase tracking-[0.16em] text-teal-800">
            <Ph name="shield-check-fill" className="h-3.5 w-3.5" />
            Trusted in production
          </span>
        </div>

        <div className="mt-10 grid grid-cols-2 gap-x-6 gap-y-8 md:grid-cols-4">
          {METRICS.map((m) => (
            <div key={m.label} className="group relative pt-4">
              <div
                aria-hidden="true"
                className="absolute inset-x-0 top-0 h-[3px] rounded-full bg-gradient-to-r from-teal-700 to-teal-500 opacity-0 transition-opacity duration-300 group-hover:opacity-100"
              />
              <div className="text-3xl font-extrabold tracking-tight text-teal-700 tabular-nums">
                {m.pre && <span className="text-teal-500">{m.pre}</span>}
                {m.value}
                <span className="text-teal-500">{m.suf}</span>
              </div>
              <p className="mt-1 text-[13px] font-medium text-slate-500">
                {m.label}
              </p>
            </div>
          ))}
        </div>

        {/* featured quote card */}
        <figure className="relative mt-12 overflow-hidden rounded-3xl border border-teal-700/15 bg-gradient-to-b from-white to-slate-50 shadow-[0_24px_70px_-30px_rgba(15,118,110,0.35)]">
          <div
            aria-hidden="true"
            className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-teal-700 via-teal-500 to-teal-700"
          />
          <div aria-hidden="true" className="teal-grid pointer-events-none absolute inset-0 opacity-60" />
          <div
            aria-hidden="true"
            className="pointer-events-none absolute -left-8 top-1/2 h-[72px] w-[72px] -translate-y-1/2 rounded-full bg-teal-100/60 blur-3xl"
          />

          <div className="relative px-7 py-9 md:px-10 md:py-10">
            <span
              aria-hidden="true"
              className="block h-[68px] select-none font-serif text-[120px] leading-[0.6] text-teal-700/[0.12]"
              style={{ fontFamily: 'Georgia, "Times New Roman", serif' }}
            >
              &ldquo;
            </span>
            <blockquote className="mt-3 max-w-2xl text-lg font-medium leading-relaxed text-slate-900 md:text-xl">
              Mosaic replaced three tools in our pipeline. We brief it on
              Monday morning and review production-ready explorations by lunch
              — the prompt library alone paid for the year.
            </blockquote>

            <figcaption className="mt-7 flex flex-wrap items-center gap-x-5 gap-y-3">
              <span
                aria-hidden="true"
                className="flex h-10 w-10 items-center justify-center rounded-full bg-gradient-to-br from-teal-700 to-teal-500 text-[13px] font-bold text-white shadow-[0_8px_18px_-8px_rgba(15,118,110,0.55)]"
              >
                AK
              </span>
              <span>
                <span className="block text-sm font-semibold text-slate-900">
                  Amira Kaur
                </span>
                <span className="block text-[13px] text-slate-500">
                  Design Lead, Fieldnote
                </span>
              </span>
              <span className="inline-flex items-center gap-1.5 text-[13px] font-medium text-teal-700">
                <Ph name="seal-check-fill" className="h-[15px] w-[15px] text-teal-600" />
                Verified Mosaic customer
              </span>
              <span
                role="img"
                aria-label="Rated five out of five stars"
                className="flex items-center gap-0.5"
              >
                {Array.from({ length: 5 }).map((_, i) => (
                  <Ph key={i} name="star-fill" className="h-4 w-4 text-teal-500" />
                ))}
              </span>
            </figcaption>
          </div>
        </figure>
      </div>
    </section>
  )
}

/* --------------------------------- CTA ----------------------------------- */

function Cta() {
  return (
    <section className="border-t border-slate-900/5">
      <div className="mx-auto max-w-5xl px-4 py-14 sm:px-6 md:py-16">
        <div className="relative overflow-hidden rounded-3xl bg-teal-800 px-6 py-12 text-center shadow-[0_28px_70px_-24px_rgba(15,118,110,0.5)] md:py-14">
          <div
            aria-hidden="true"
            className="pointer-events-none absolute -left-20 -top-20 h-72 w-72 rounded-full bg-teal-600/40 blur-3xl"
          />
          <div
            aria-hidden="true"
            className="pointer-events-none absolute -bottom-24 -right-16 h-72 w-72 rounded-full bg-teal-900/40 blur-3xl"
          />

          <div className="relative">
            <h2 className="text-2xl font-extrabold leading-7 tracking-tight text-white">
              Still stuck? We&rsquo;re real people.
            </h2>
            <p className="mx-auto mt-3 max-w-md text-[15px] leading-relaxed text-teal-100">
              Tell us what you&rsquo;re building — a real designer or engineer
              replies, usually within four minutes, seven days a week.
            </p>

            <div className="mt-7 flex flex-col items-center justify-center gap-3 sm:flex-row">
              <a
                href="#"
                className="group inline-flex items-center justify-center gap-2 rounded-lg bg-white px-5 py-2.5 text-sm font-semibold text-teal-800 transition-colors duration-200 hover:bg-teal-50"
              >
                <Ph name="chat-circle-text-fill" className="h-4 w-4" />
                Message support
                <Ph
                  name="arrow-right"
                  className="h-4 w-4 transition-transform duration-200 group-hover:translate-x-0.5"
                />
              </a>
              <a
                href="#"
                className="inline-flex items-center justify-center gap-2 rounded-lg border border-white/25 px-5 py-2.5 text-sm font-semibold text-white transition-colors duration-200 hover:bg-white/10"
              >
                <Ph name="discord-logo-fill" className="h-4 w-4" />
                Join the community
              </a>
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}

/* -------------------------------- footer --------------------------------- */

function Footer() {
  return (
    <footer className="mt-auto border-t border-slate-900/5 bg-slate-50">
      <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-4 px-4 py-8 sm:flex-row sm:px-6">
        <div className="flex items-center gap-2.5">
          <span className="flex h-6 w-6 items-center justify-center rounded-md bg-teal-700">
            <Ph name="sparkle-fill" className="h-3.5 w-3.5 text-white" />
          </span>
          <span className="text-sm font-semibold text-slate-600">
            Mosaic Help Center
          </span>
        </div>
        <p className="text-[13px] text-slate-400">
          © 2026 Mosaic. Design from a prompt.
        </p>
      </div>
    </footer>
  )
}
