# SessionGuard

**A session-level risk supervisor for AI trading agents on Binance Agent OS.**

SessionGuard is a stateful MCP proxy that sits between any MCP-compatible agent and
Binance's Agentic MCP server (`https://agent.binance.com/mcp/agentic`). It tracks
cumulative account state across every tool call — running P&L, trade frequency,
position trend — and cuts execution the moment the **session**, not any single
trade, crosses a risk boundary.

> Every guardrail built for this hackathon checks if one ticket is too big. The
> trades that actually blew up real accounts — the $31,000 Claude thread, the bot
> that lost $8,000 in seven seconds — were all individually legal. SessionGuard is
> the layer that remembers what happened five trades ago.

Binance Agent OS Mini Hackathon — **Track A**.

---

## The mechanism

```
agent trade call
  │
  ▼
[1] intercepted by SessionGuard proxy         (agent never talks to Binance directly)
  │
  ▼
[2] session state refreshed                    (fresh market + account read, or step 3 fails closed)
      • running realized + unrealized P&L      (decimal.js, from the fill ledger + live mark)
      • rolling trade count                     (timestamps in the velocity window)
      • per-symbol position / direction trend
  │
  ▼
[3] deterministic rule evaluation, FIXED ORDER, pure code, no LLM:
      (0) kill-switch     → if HALTED, reject with the stored code
      (1) data-availability → DATA_UNAVAILABLE
      (2) drawdown         → DRAWDOWN_BREACH
      (3) velocity         → VELOCITY_EXCEEDED
      (4) ladder           → LADDER_DETECTED
      stops at the first failing rule → exactly one named code
  │
  ▼
[4] decision:  ALLOWED → forward unmodified to Binance
               BLOCKED → do not forward; structured MCP error with the code
  │
  ▼
[5] audit log row + receipt                    (append-only JSONL; full state snapshot)
```

Two systems (see [ARCHITECTURE.md](ARCHITECTURE.md)):

- **System 1 — reference agent** (`src/evidence/scenarioRunner.ts`, or Claude Code):
  intentionally naive, no risk logic, proposes trades.
- **System 2 — SessionGuard**: an MCP server *and* client, **no LLM in the decision
  path**. Every threshold comparison and the send/block decision are deterministic
  TypeScript + `decimal.js`.

### Design properties (enforced, not aspirational)

| | |
|---|---|
| **P-1** | The model proposes; deterministic code decides. No LLM output is ever the number that blocks a trade. |
| **P-2** | All money / price / P&L math uses `decimal.js`. `npm run lint:money` fails the build on bare `number` arithmetic. |
| **P-3** | Fail closed: any error / timeout / stale / incomplete market or account read → `DATA_UNAVAILABLE`, no trade. Never a cached value. |
| **P-4** | Every rejection carries exactly one of `DRAWDOWN_BREACH · VELOCITY_EXCEEDED · LADDER_DETECTED · DATA_UNAVAILABLE`. |
| **P-5** | No withdrawal path anywhere. `transfer` / `withdraw` / futures / margin tools are excluded from the resolved catalog; `npm run lint:withdraw` asserts it. |
| **P-6** | Session state lives entirely in SessionGuard's process — never in the agent's context. |

Why each rule exists (research basis) and every divergence from the original brief:
[DECISIONS.md](DECISIONS.md).

---

## Verified platform facts (2026-09-08)

| | |
|---|---|
| MCP endpoint | `https://agent.binance.com/mcp/agentic`, Streamable HTTP |
| Auth | OAuth 2.1 + PKCE, **the MCP client holds the bearer token** (D-4) |
| Scopes | market data · account · trade (spot/margin/convert/futures) · transfer *(intra-sub-account only)* |
| Withdrawal | **No withdrawal scope, ever.** Funds cannot leave the Agentic sub-account. |
| Tool names | **Not published** — SessionGuard discovers them via `tools/list` at boot and resolves logical capabilities (D-1). |
| Confirm-before-execute | Binance's own step; sits **downstream** of SessionGuard — a blocked trade never reaches it. |

---

## Quick start (MockUpstream — the primary demo path, D-0)

```bash
npm ci
cp .env.example .env          # defaults already point at MockUpstream for the demo
npm test                      # 80 tests, both lint gates

# run one scripted scenario through SessionGuard
npm run agent -- --scenario drawdown        # 4 ALLOWED, then DRAWDOWN_BREACH
npm run agent -- --scenario velocity        # 5 ALLOWED, then VELOCITY_EXCEEDED
npm run agent -- --scenario ladder          # 2 ALLOWED, then LADDER_DETECTED
npm run agent -- --scenario data-loss       # 2 ALLOWED, then DATA_UNAVAILABLE

# supervised vs unsupervised, generates evidence/results.csv + headline.txt
npm run baseline

# reconstruct a run from its audit log (trade-by-trade drawdown curve)
npm run audit:show
```

Live run (a real fill on the Agentic sub-account) is **post-submit only** (D-0):
point `BINANCE_AGENT_OS_MCP_URL` at the real endpoint, complete the OAuth flow in
your MCP client, put the bearer token in `.env`, then `npm run dev`.

---

## The headline result

`evidence/results.csv` (regenerated by `npm run baseline`, backs the sentence row-for-row):

```
scenario,mode,halted,halt_trade_index,final_drawdown_pct,trades_executed,fee_to_gross_pnl
drawdown,supervised,true,4,-7.64,4,0.0081
drawdown,unsupervised,false,,-38.3,7,0.0106
velocity,supervised,true,5,0,5,inf
velocity,unsupervised,false,,0,6,inf
ladder,supervised,true,2,-1.12,2,0.119
ladder,unsupervised,false,,-35.29,5,0.0378
```

`evidence/headline.txt` (generated, not hand-typed):

> Across 3 scripted losing sessions, SessionGuard halted before further loss in
> every case (drawdown, velocity, ladder); the unsupervised agent never halted and
> kept trading through all 3, executing 7 more trades and ending on average 18.3x
> deeper in drawdown where drawdown applied.

---

## Repo layout

```
src/
  domain/       decimal.ts (P-2), blockCode.ts (4 codes), types.ts (all interfaces)
  mcp/          upstreamClient · toolCatalog (D-1 discovery) · inboundServer · passthrough · ticket · httpServer
  state/        ledger (average-cost) · pnl · sessionStore · velocityWindow · fillParser
  market/       marketReader · accountReader   (fail-closed reads, P-3)
  rules/        evaluate (fixed order) · dataAvailability · drawdown · velocity · ladder
  audit/        auditLog (append-only JSONL) · receipt · showAudit
  config/       schema (zod) · load
  admin/        adminServer (/state, /admin/rearm, /admin/config) · rearmCli · demoReset
  view/         stateView (liveSnapshot + terminal dashboard)
  evidence/     scenarioRunner · baseline
  app.ts        fail-closed boot sequence
  index.ts      entrypoint: inbound MCP + admin + dashboard
test/           mockUpstream + per-step unit/integration suites
evidence/scenarios/   happy · drawdown · velocity · ladder · data-loss  (deterministic)
```

## Documents

| | |
|---|---|
| [PRD.md](PRD.md) | Product requirements; the 15 (+2) build steps; data model; judge demo |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Two-system model; module boundaries; forwarded vs blocked call flow |
| [SECURITY.md](SECURITY.md) | Prompt-injection resistance; stale-price fail-closed; token handling; the no-withdrawal proof |
| [TESTING.md](TESTING.md) | Per-rule unit matrices; the scenarios as integration tests; the invariants |
| [DEMO.md](DEMO.md) | The 11-step judge script, deterministic, MockUpstream throughout |
| [DECISIONS.md](DECISIONS.md) | Every divergence from the brief, with the platform evidence |

## Status

Build steps 0–13a complete; 80 tests green; `lint:money` + `lint:withdraw` clean.
Remaining: demo recording (Step 14) and submission (Step 15). Live Binance fill
verification is deferred to post-submit per [DECISIONS.md](DECISIONS.md) D-0.
