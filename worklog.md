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
