# Worklog

---
Task ID: 1
Agent: Z.ai Code (main)
Task: Pull github.com/krank21r/trade2watch from git and load the app

Work Log:
- Cloned repo (branch main, commit b290239 "Initial commit: Trade2Watch BTC/ETH trade setup web app") to /tmp/trade2watch
- Inspected repo: single-file static SPA (tradewatch.html, 881 lines / 43,369B), chart.webp background, notes.txt, vercel-deploy/ mirror — NOT a Next.js project
- Integration strategy: serve app verbatim from public/ + full-viewport same-origin iframe on the Next.js / route (preserves verified app code 1:1, isolates its CSS reset from Tailwind preflight, keeps localStorage/WebAudio/CoinGecko fetch working)
- Copied tradewatch.html → public/app.html, chart.webp → public/chart.webp
- Vendored pristine upstream clone at upstream/trade2watch/ (with .git) for future pulls/diffs
- Copied notes.txt → TRADE2WATCH_NOTES.md (project reference: setup JSON push mechanics, feature bundle)
- Rewrote src/app/page.tsx: 100dvh wrapper (bg #0b0e14) + iframe src="/app.html", no extra chrome
- Updated src/app/layout.tsx metadata: title "Trade2watch — Multi-Asset Trade Setup" + OG tags
- bun run lint: clean; dev.log: clean compile, no runtime errors

Stage Summary:
- App live at / (iframe of /app.html, served by Next.js on port 3000)
- Agent Browser verification passed: renders fully; all 4 nav views work; live CoinGecko prices (HTTP 200 polls); alert banner fired + dismissed; sizing calculator exact ($10k @1% → 0.4 BTC short, 5 ETH long, notionals correct); inputs mirror across assets; localStorage persistence; freshness ticker counts down; ZoneWatch chips correct; mobile 390px responsive; zero console/page errors
- Source of truth for setup edits: public/app.html (mirrors vercel-deploy/index.html from upstream)

---
Task ID: 2
Agent: Z.ai Code (main)
Task: Explain how the app provides long/short entries to trade

Work Log:
- Traced entry pipeline: setupJson (static config) -> 45s CoinGecko poll -> zoneState() threshold comparison -> UI surfaces
- Live demo via injected fetch shim in iframe (CoinGecko was 429 rate-limited): mocked BTC $64,500 -> red SHORT banner + "SHORT ZONE ACTIVE" state line; mocked BTC $62,450 -> green LONG banner + "LONG ZONE ACTIVE" state line; opposite card flips to "not in play" each time
- Identified caveat: zoneState() has no invalidUp/invalidDown check, so stale setups show misleading "zone live" states when price is far outside range (current real BTC ~$83k vs invalidUp $65.4k still shows SHORT ZONE LIVE)

Stage Summary:
- Entry mechanism fully documented for user; mock-shim technique reusable for future demos; recommendation noted: refresh setupJson in public/app.html to current market structure

---
Task ID: 3
Agent: Z.ai Code (main)
Task: Plan AI signal engine (TradingAgents adaptation) for Trade2watch

Work Log:
- Cloned TauricResearch/TradingAgents, studied pipeline: 4 parallel analysts -> bull/bear debate -> research manager -> trader -> risk debate (aggressive/conservative/neutral) -> portfolio manager -> memory log reflection; structured outputs for the 3 decision agents; 2 LLM tiers (quick/deep)
- Validated sandbox data sources: Binance klines OK (crypto, keyless), Yahoo Finance chart/search/news OK (stocks, keyless), Google News RSS OK, Stooq empty (dropped), CoinGecko currently 429 (use Binance instead)
- Validated z-ai-web-dev-sdk LLM (glm-4-plus) with structured JSON request — works, but wraps JSON in code fences -> engine needs fence-stripping + retry
- Designed TypeScript adaptation: deterministic data+indicator layer (RSI/MACD/EMA/ATR/S-R pivots computed in TS), regime-based strategy (trend: pullback momentum; range: fade edges), ATR stops, S/R targets, R:R gate, LLM agents for analysis/debate/risk, deterministic trade-plan engineering

Stage Summary:
- Full plan ready for user approval (phases 1-5); all external dependencies verified working from sandbox

---
Task ID: 4
Agent: Z.ai Code (main)
Task: Build AI signal engine (TradingAgents adaptation) — phases 1-5

Work Log:
- Phase 1: Prisma SignalRun model (signal fields + artifacts JSON + outcome tracking); src/lib/market/ — indicators.ts (EMA/SMA/RSI/MACD/ATR/Bollinger/pivot S-R clustering/slope, zero deps), providers.ts (Binance klines+ticker, Yahoo chart+search+news, Google News RSS; in-memory TTL cache; empty-news short TTL), snapshot.ts (regime detection TRENDING_UP/DOWN/RANGING via EMA stack+slope)
- Phase 2: src/lib/signals/ — llm.ts (ZAI singleton, global call queue with 1.6s min spacing, 429 backoff 5-30s, fenced-JSON extraction with self-correcting retry), engine.ts (6-stage pipeline: data → 3 parallel analysts → bull/bear debate → research manager → DETERMINISTIC trade-plan engineer → risk committee 3 personas → portfolio manager; desk memory from past runs; house R:R floor ≥2.0/3.5 enforced after PM adjustments; graceful degradation at every step)
- Phase 3: API — POST /api/signals/run (fire-and-forget pipeline), GET /api/signals/run/[id] (poll + zombie self-heal 6min), GET /api/signals (history + lazy outcome evaluation), GET /api/market/quote
- Phase 4: UI — page.tsx tabbed shell (AI Signals default | Trade Setups iframe); components/signals/ SignalDashboard (form+quick picks+history, 2.5s polling), SignalCard (T2W visual language: direction badge, confidence bar, entry/stop/T1/T2/R:R/invalidation, sizing synced to tw_acct/tw_risk localStorage), PipelinePanel (6-stage stepper), ReportsPanel (collapsible agent transcripts)
- Bugs fixed during E2E: missing llmText import; Google News empty results cached 10min (now 45s) + Yahoo news fallback source; z-ai 429 bursts (queue+backoff); R:R gate now applies after PM adjustments; news-analyst anti-hallucination prompt for empty headlines
- Verified runs: BTC LONG 70 (PM adjusted), AAPL NEUTRAL 65, TSLA NEUTRAL 75, NVDA LONG 65 (PM caught inverted R:R and adjusted), ETH LONG 65, BTC NEUTRAL 65 (via UI), SOL NEUTRAL 60 (under rate pressure, degraded gracefully)
- Agent Browser E2E: tab shell, history badges, ETH LONG card, sizing math exact ($10k@1% → 2.1053 ETH), pipeline live progress 22%→complete, agent transcripts, classic iframe tab, mobile 390px — all pass, zero console errors

Stage Summary:
- AI Signals desk fully operational at / (default tab); 7 signal runs persisted in SQLite; engine robust to vendor rate limits; lint clean; dev.log clean

---
Task ID: 5
Agent: Z.ai Code (main)
Task: Fix hydration mismatch console error (fdprocessedid)

Work Log:
- Diagnosed: fdprocessedid attribute is NOT in served SSR HTML (curl grep = 0) nor in our source — injected browser-side by the preview environment's form-processing wrapper / a form-filler extension before React hydration, on every <button>/<input>; matches React's documented "extension messes with HTML" case
- Fix: added suppressHydrationWarning to all instrumented interactive elements — page.tsx tab buttons; SignalDashboard market toggles, symbol input, quick picks, run button, history rows; SignalCard sizing inputs; ReportsPanel section toggles
- bun run lint clean; browser verification: zero console hydration warnings, tabs/history/run-detail/sizing all functional

Stage Summary:
- Hydration console noise eliminated without behavior change; app state and interactions unaffected
