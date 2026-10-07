Trade2watch — project notes
============================

Site: https://trade2watch.vercel.app/ — source C:\Users\Ishi\btc-trade-setup\vercel-deploy\index.html (single-file SPA, self-contained; local reference copy tradewatch.html)
Background image: C:\Users\Ishi\btc-trade-setup\chart.webp (page background, .62 dark overlay)
Alerts watcher: C:\Users\Ishi\btc-alerts\btc_alerts.ps1 (detached PS pid 10760, 60s poll; phone CoinGecko app is primary)

HOME PAGE — footer line (the only Home content):
------------------------------------------------
Setup pushed: 2026-08-11 22:05 local — Trade2watch — multi-asset trade setup dashboard. Disclaimer: Technical analysis of public market data (CoinGecko). Not financial advice. Crypto is volatile — never trade money you can't afford to lose. Levels shift as structure changes; re-validate before acting.

(Source of truth: <span id="setupStamp"> + <footer> in tradewatch.html; stamp text = "Setup pushed: " + SETUP.updated + " — ". Home view itself is an intentionally empty section.)

Current setup (setupJson, BTC + ETH):
-------------------------------------
BTC: SHORT 64,100–64,400 / stop 64,650 / T1 62,800 / T2 62,300 / runner 60,000 / invalid 4h close >65,400
     LONG  62,300–62,600 / stop 61,750 / T1 64,100 / T2 65,000
ETH: SHORT 1,930–1,950 / stop 1,970 / T1 1,880 / T2 1,800
     LONG  1,780–1,800 / stop 1,760 / T1 1,880 / T2 1,920
     invalid daily close >1,975 / <1,760

Phone alert levels (CoinGecko app):
  BTC ≥ $64,400 / ≤ $62,600
  ETH ≥ $1,930 / ≤ $1,800 (suggested, not yet armed)

Push mechanics: edit setupJson (updated field + data) in vercel-deploy/index.html (SOURCE OF TRUTH) → run `cd C:\Users\Ishi\btc-trade-setup\vercel-deploy && vercel --prod --yes` → live at https://trade2watch.vercel.app/ (Vercel account kranthi21r-gmailcoms-projects, project trade2watch). Page re-reads JSON every 45s poll and rebuilds automatically; tab must be open. Mirror edits to tradewatch.html (local reference). Overwrite vercel-deploy/chart.webp to change background.

Feature bundle (deployed 2026-08-11, live 43,369B):
----------------------------------------------------
1. Thesis panel — per-asset `thesis` in setupJson (trend/zones/invalidation/validity), left-aligned text on each watch card.
2. Risk calculator — per-asset account size + risk% inputs (localStorage keys tw_acct/tw_risk, mirrored across assets so both stay in sync; sizing = risk$ / stop distance, worst-case entry price) → position size + notional.
3. In-page alert banner + beep — fixed top banner (.up = short-zone red / .down = long-zone green), fires when live price crosses alert levels while tab open; hysteresis: re-arms only after price leaves the alert zone (rearm levels inside setupJson); WebAudio beep (first click unlocks audio); close button.
4. Freshness ticker — per-asset "Xm Ys ago" age span + "next poll in Xs" countdown.

Verified: 19/19 fake-DOM smoke assertions (incl. sizing math, banner fire/rearm, persistence). Fixed real bug: per-asset sizing inputs shared one localStorage key, last-rendered asset clobbered it — inputs now mirror edits across assets.

Live site: https://trade2watch.vercel.app/ (index.html + chart.webp only; notes.txt NOT deployed)

Not financial advice. Analysis of public CoinGecko data.
