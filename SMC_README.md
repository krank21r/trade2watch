# Trade2Watch — SMC Engine (Smart Money Concepts)

BTCUSDT Smart Money / Order Block trade-setup engine, built as an addition to the
existing Trade2Watch app. **Analysis + signals + tracking only — it never places
trades, holds keys, or touches exchange trading endpoints (§58).**

> ⚠️ **Risk disclaimer (§59):** This system provides technical market analysis and
> trade setups. It does not guarantee profitability. Signals should be
> independently reviewed before execution.

---

## 1. Architecture (as adapted)

The original spec targeted FastAPI + PostgreSQL + Redis. Per the spec's own §61
("inspect the existing repository… do not unnecessarily replace… reuse"), the
engine was implemented natively in the existing stack:

| Spec              | Implemented as                                             |
| ----------------- | ---------------------------------------------------------- |
| Python/FastAPI    | TypeScript pure-function modules + Next.js API route        |
| PostgreSQL        | SQLite via Prisma (`SmcSignal` table)                       |
| Redis live state  | In-memory response cache (30–120 s TTL)                     |
| Bybit WebSocket   | Bybit v5 REST poll every 45 s (client) / cache TTL (server) |
| Pandas/NumPy      | Hand-written TS math (Wilder ATR, SMA) — zero deps          |

Everything is deterministic and LLM-free. Market data is **Bybit v5 public REST**
(keyless, read-only) with per-timeframe fallback to Binance's official public
mirror. If both fail the API returns `DATA UNAVAILABLE` — **no fake data, ever (§62)**.

## 2. Files

```
src/lib/smc/
  types.ts        contracts: SwingPoint, StructureEvent, OrderBlock, FVG,
                  LiquidityLevel/Sweep, TfSummary, Reason, SmcAnalysis (API shape)
  config.ts       ALL strategy tunables (§40): swings 2/2, ATR 14, displacement
                  1.2×ATR, SL 0.15×ATR, min RR 2.0 @TP2, min score 80, STRICT,
                  OB/signal score weights, quality bands
  bybit.ts        multi-TF loader (1D/4H/1H/15M/5M) + ticker, forming-candle
                  drop, Binance mirror fallback, source labeling
  atr.ts swings.ts structure.ts displacement.ts volume.ts fvg.ts
  orderblocks.ts  liquidity.ts mtf.ts risk.ts scoring.ts signal.ts analysis.ts
src/app/api/smc/analysis/route.ts   GET endpoint (§25 consolidated response)
src/components/smc/SmcBoard.tsx     dashboard UI (4th tab "🎯 SMC Setup")
src/components/smc/ui.tsx           shared primitives
prisma/schema.prisma                SmcSignal model
```

## 3. No-look-ahead contract (§35 — mandatory)

- Engines only ever see **closed** candles; the forming candle is dropped at the
  provider level (both Bybit and Binance).
- A swing is **confirmed** only after `right` subsequent candles have closed
  (`confirmedAt = candles[i+right].time + tfMs`); developing swings are never used.
- BOS/CHoCH fire on candle **closes** (never wicks) and only against swings whose
  `confirmedAt ≤ candle close time`.
- The lifecycle tracker scans candles strictly **after** a signal's creation time.

## 4. Strategy pipeline (§2/§49)

```
1D context → 4H bias → 1H structure (BOS/CHoCH) → 1H Order Block (8-factor
strength 0-100) → liquidity map (EQH/EQL/PDH/PDL/PWH/PWL/swings) → sweeps →
FVG → displacement → volume → 15M confirmation → 5M confirmation (STRICT mode)
→ entry zone / SL / TP1-3 → RR gate (≥2.0 @TP2) → score (§21, 0-100) →
LONG / SHORT / WATCHLIST / NO_TRADE
```

- **STRICT** (default): full §17 checklist incl. 15M + 5M confirmation.
- **BALANCED**: drops the 5M requirement. **AGGRESSIVE**: drops 15M too.
- The engine must be conservative: insufficient confluence ⇒ `NO_TRADE`
  (§45); OB approaching but unconfirmed ⇒ `WATCHLIST`. `NO_TRADE` is normal.
- Scores are **setup quality scores (0–100), NOT win probabilities**.
- Signals are deduped per `(symbol, obTime, direction)`; a closed setup is never
  resurrected. Every emitted LONG/SHORT is persisted and tracked against real
  5M candles (pessimistic same-candle rule: stop before targets) through
  `ACTIVE → TP1_HIT → TP2_HIT → TP3_HIT / SL_HIT / EXPIRED` with
  `WIN / LOSS / BREAKEVEN / EXPIRED` results and R multiples.

## 5. API

`GET /api/smc/analysis?symbol=BTCUSDT&mode=STRICT` → consolidated payload:
current price, 24h change, market bias, per-TF trend/structure summaries,
active order blocks (with strength scores), FVGs (with fill %), liquidity
levels (armed/swept), recent sweeps, the signal with quality + score + reasons
(factor / result / points each), trade plan (entry zone, SL, TP1-3, R:R),
explanation lines, signal history, disclaimer. Errors: HTTP 503 with
`{ ok:false, dataSource:'UNAVAILABLE', error }`.

Example LONG (illustrative shape — actual output is always live data):

```json
{ "signal": "LONG", "quality": "A", "score": 87,
  "trade": { "entry_low": 112050, "entry_high": 112250, "entry_mid": 112150,
             "stop_loss": 111750, "tp1": 112900, "tp2": 113700, "tp3": 115000 },
  "risk_reward": { "tp1": 2.1, "tp2": 4.3, "tp3": 7.6 },
  "reasons": [ { "factor": "4H trend", "result": "BULLISH", "points": 20 }, … ] }
```

## 6. Database

`SmcSignal` (SQLite): plan snapshot (entry/SL/TPs/RR/quality/score/mode),
`obTime` dedupe key, `reasons` JSON, lifecycle `status`, `result`, `rMultiple`,
TP/SL hit timestamps. Indexes on `(symbol, status)` and `(symbol, createdAt)`;
unique `(symbol, obTime, direction)`. Timestamp columns are Float (epoch ms —
exact below 2^53, JSON-safe).

## 7. Environment variables

```bash
DATABASE_URL="file:./db/custom.db"   # already configured
# Future/optional (not required today):
# COINGLASS_API_KEY=                 # derivatives confluence (§36/§37)
# TELEGRAM_BOT_TOKEN= / TELEGRAM_CHAT_ID=   # alerts (§38)
# WEBHOOK_SECRET=                    # tradingview webhook (§39)
```

No keys are needed for market data (Bybit/Binance public endpoints). No secret
ever reaches the frontend.

## 8. Run

```bash
bun install
bun run db:push
bun run dev        # http://localhost:3000 → "🎯 SMC Setup" tab
bun run lint
```

## 9. Known limitations & future work

- No chart overlays yet (planned: TradingView Lightweight-Charts with OB/FVG/
  liquidity/level toggles, §29); the dashboard is panel-based.
- Backtester + walk-forward validation (§32/§33) and a performance page (§31
  filters) are the next milestone; signal rows already carry everything needed.
- Alerts (Telegram/webhook), CoinGlass derivatives confluence, 1M timeframe:
  designed for but not enabled (no credentials / v1 scope).
- Outcome tracking runs on analysis polls — like the rest of the app it
  progresses while the app is polled; historical candles make gaps honest.
- Adding symbols (ETHUSDT, XRPUSDT, SOLUSDT) is a config change: the engines
  are symbol-agnostic; the UI pins BTCUSDT for now.

*Not financial advice.*
