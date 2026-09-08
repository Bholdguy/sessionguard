# SessionGuard — Product Requirements Document (PRD)

**Hackathon:** Binance Agent OS Mini Hackathon — Track A ("Build an AI agent with Agent OS")
**Document status:** Draft for approval. No implementation begins until this PRD and the six companion documents (ARCHITECTURE, SECURITY, TESTING, DEMO, DECISIONS, `.env.example`, TASKS) are internally consistent and the Track A submission audit in §12 is signed off.
**Date:** 2026-09-08
**Owner:** bholdguyyy161@gmail.com

---

## Section 0 — Verified Platform Facts (research gate)

Every capability the build brief depends on was checked against Binance's live developer documentation and launch materials on 2026-09-08. This section is the single source of truth for platform behaviour; the rest of the PRD only references it. Where the public docs do **not** pin something down, that is stated explicitly and carried into `DECISIONS.md` as a runtime-discovery requirement rather than an assumption.

### 0.1 MCP endpoint

| Item | Verified value | Source |
|---|---|---|
| Agentic MCP endpoint | `https://agent.binance.com/mcp/agentic` | Binance MCP Server docs (`developers.binance.com/en/docs/agent-native/mcp-server`, `.../mcp-server/agentic`); crypto.news, HackerNoon launch coverage |
| Transport | MCP over **Streamable HTTP** | Binance MCP Server docs; TechCrunch 2026-08-20 |
| Compatible clients named by Binance | Claude, Claude Code, Codex / ChatGPT, Cursor, VS Code, Grok Bot | Binance MCP Server docs; crypto.news |

### 0.2 Authentication / authorization flow

- **OAuth 2.1 authorization-code + PKCE**, presented to the user as a Binance consent screen labelled **"Binance Agentic Account Access."** The user must be logged in to Binance.com in a desktop browser before connecting the client. (Binance MCP Server / agentic docs.)
- The MCP **client** performs the OAuth dance and holds the resulting **bearer token**; the token is sent as `Authorization: Bearer <token>` on the Streamable-HTTP requests to `agent.binance.com/mcp/agentic`.
- Per-client bootstrap commands documented by Binance:
  - Claude Code / Desktop: `claude mcp add` (or Settings → Connectors).
  - Codex CLI: `codex mcp add … --oauth-client-id codex`.
  - VS Code: MCP Servers settings → add HTTP server with the endpoint.
  - ChatGPT: Developer Mode → connector with the endpoint URL.
- **Public market-data calls require no authentication**; account, trade, and transfer calls require the corresponding scope to have been granted on the consent screen.
- Token lifetime / refresh semantics are **not published** in the public docs. SessionGuard treats the token as opaque and short-lived, supports a refresh-token grant if the client advertises one, and **fails closed on any `401`/`403`** (see §0.7 and `SECURITY.md`).

### 0.3 Scopes (exactly four categories, per the agentic docs)

| Scope | What it grants | SessionGuard usage |
|---|---|---|
| **Market data** | Public tickers, order books, candlesticks (klines), funding rates. No auth. | **Read** — mark price + klines for P&L and freshness gate. |
| **Account** | Read the **Agentic sub-account** balances, positions, bills; optional **read-only** view of the main account. | **Read** — starting equity snapshot, balance reads. |
| **Trade** | Place / cancel orders across **Spot, Margin, Convert, USDⓈ-M Futures, COIN-M Futures**, subject to what the user authorized. | **Forward or block** — spot only for the demo (see §4). |
| **Transfer** | Move funds **between wallets inside the same Agentic sub-account only**. | **Never called.** SessionGuard neither invokes nor proxies transfer tools. |

### 0.4 Withdrawal restriction (confirmed, and load-bearing for SECURITY.md)

> There is **no withdrawal scope**. The agent can **never** move funds out of the Agentic sub-account to an external address, and cannot pull funds from the main Binance account. Initial funding of the sub-account is **manual**, via the Binance web UI.
> — Binance MCP Server / agentic docs; corroborated by TechCrunch, crypto.news, PRNewswire, HackerNoon.

Consequence for SessionGuard: there is no withdrawal tool in the upstream surface to guard, and SessionGuard's own code contains **no code path that references, wraps, or forwards a withdrawal or external-transfer operation**. `SECURITY.md` §5 records the grep-able assertion that enforces this.

### 0.5 Confirm-before-execute (Binance's own step)

> "The agent restates the order — symbol, side, type, amount — and waits for your yes before sending it." This applies to **every non-read action** — orders, cancels, and transfers. Users may configure an agent to act autonomously once permissions are set, or to require approval on every order.
> — Binance MCP Server / agentic docs; TechCrunch 2026-08-20.

Consequence: Binance's confirmation happens **downstream of SessionGuard**, at the Binance MCP layer. A trade SessionGuard **blocks never reaches** that confirmation prompt — it is stopped one layer earlier. This is the exact point the demo (§10 step 7) calls out.

### 0.6 MCP tool names — **not published; must be discovered at runtime**

Binance's public documentation describes tool **capabilities** ("check the market, check balances, place/cancel orders, transfer within the sub-account") but does **not** publish the literal MCP tool-name identifiers or their JSON parameter schemas. Secondary coverage (crypto.news, awesome-mcp aggregators) refers to roughly "7 trading tools (place order, test order, query order, cancel order, cancel-all, open orders, all-orders history) and 2 account tools (account info with balances, trade-execution history)" plus market-data tools, but **none of these are authoritative name strings.**

**Decision (recorded in `DECISIONS.md` D-1):** SessionGuard does **not** hard-code any upstream tool name. At boot it calls MCP `tools/list` on `agent.binance.com/mcp/agentic`, then resolves a fixed set of **logical capabilities** to the concrete discovered tool names via a `ToolCatalog` (see §8 Step 1 and §9.7). If any required capability cannot be resolved, SessionGuard refuses to start (fail closed). The logical capabilities SessionGuard depends on:

| Logical capability | Purpose | Expected upstream shape (to be confirmed by `tools/list`) |
|---|---|---|
| `market.price` | Live mark/last price for a symbol | input `{ symbol }` → `{ price }` |
| `market.klines` | Recent candles (fallback mark price, sanity) | input `{ symbol, interval, limit }` |
| `account.balances` | Agentic sub-account balances → starting equity, equity reads | input `{}` → balances array |
| `account.trades` | Execution history (fills) for reconciliation | input `{ symbol?, startTime? }` |
| `trade.placeOrder` | The spot order the agent proposes — **forwarded or blocked** | input `{ symbol, side, type, quantity | quoteOrderQty, price?, timeInForce? }` |
| `trade.testOrder` | Dry-run validation before a real forward (if exposed) | same shape as `trade.placeOrder` |
| `trade.queryOrder` | Confirm fill price/qty when the place response is thin | input `{ symbol, orderId }` |
| `trade.openOrders` | Position/exposure reconciliation | input `{ symbol? }` |

`transfer.*` and any `withdraw.*` / futures / margin tools are **explicitly excluded from the catalog** and will be rejected if an agent tries to call them through the proxy (`UNSUPPORTED_TOOL`, logged; not one of the four risk codes because it is a scope refusal, not a session-risk halt — see §9.4).

### 0.7 Fail-closed triggers derived from the platform facts

SessionGuard blocks the next trade with `DATA_UNAVAILABLE` when any of these occur while assembling rule context:

1. `market.price` / `market.klines` call errors, times out (`dataFetchTimeoutMs`), or returns an unparseable / non-positive price.
2. The freshest `market.price` for the ticket's symbol is older than `priceStalenessSeconds`.
3. `account.balances` call errors, times out, or returns a payload missing the quote asset (USDT) balance.
4. The upstream returns `401` / `403` (token expired or scope revoked mid-session).
5. `tools/list` resolution degraded since boot (a required capability disappeared).

Cached or last-known values are **never** substituted. "No data, no trade."

### 0.8 Hackathon Track A facts

| Item | Verified value | Source |
|---|---|---|
| Deadline | **2026-09-08, 23:59 UTC** (today) | Binance blog "The Binance Agent OS Mini Hackathon"; Blockchain.News |
| Track A prize pool | $20,000 USDC ($2,000 / $1,500 / $1,000 + $300 × 50) | Binance blog |
| Entry steps | (1) Follow **@Binance** and repost the announcement; (2) reply or **quote-repost** with the submission — for Track A a **video/demo plus GitHub** (if applicable); (3) **complete the survey** | Binance blog; X announcement |
| Mandatory scope | Submission must be **an AI agent built with Agent OS** | Binance blog |
| Eligibility | Not open to US, UK, EEA, Hong Kong, Singapore, or Binance prohibited-list jurisdictions | Binance blog |

Full pre-submission audit against these: §12.

---

## 1. Product Name and Pitch

**SessionGuard.**

A session-level supervisor for AI trading agents on Binance Agent OS. It sits as a stateful MCP proxy between any MCP-compatible agent and Binance's Agentic MCP server (`agent.binance.com/mcp/agentic`), tracks cumulative account state across every tool call, and cuts execution the moment the **session** — not any single trade — crosses a risk boundary.

One-line: *the layer that remembers what happened five trades ago, so a sequence of individually-legal trades can't quietly drain an account.*

### 1.1 What SessionGuard is **not** (guardrails on scope)

- **Not** a trading bot. It never proposes, sizes, or times a trade. It only observes what the agent proposes and forwards or blocks it.
- **Not** a single-trade validator. Per-ticket size/leverage/symbol checks are TradeGuard's layer; SessionGuard operates one level up, on the running session.
- **Not** a transparent pass-through wrapper. A wrapper that just relays calls has no session memory and cannot fire any of the four block codes; that would be a failed build, not a minimal one.
- **Not** an ML system. The "learning loop" (§7 Experience C) is a human reading an audit log and tightening a config — the honest version given the timeframe.
- **Not** a custody or withdrawal tool. See §0.4 and `SECURITY.md` §5.

### 1.2 The dominant mechanism (must survive every downstream document)

```
agent trade call
  │
  ▼
[1] intercepted by SessionGuard proxy         (agent never talks to Binance directly)
  │
  ▼
[2] session state refreshed
      • running realized + unrealized P&L      (decimal.js, from the fill ledger + live mark)
      • rolling trade count                     (timestamps in the velocity window)
      • per-symbol position / direction trend   (last trade qty, last-trade-was-loss)
      • live market read + account read         (fresh, or the next step fails closed)
  │
  ▼
[3] deterministic rule evaluation, FIXED ORDER, pure code, no LLM:
      (0) kill-switch check      → if session HALTED, reject with the stored code
      (1) data-availability      → DATA_UNAVAILABLE
      (2) drawdown               → DRAWDOWN_BREACH
      (3) velocity               → VELOCITY_EXCEEDED
      (4) ladder                 → LADDER_DETECTED
      evaluation stops at the first failing rule
  │
  ▼
[4] decision:
      ALLOWED  → forward the call unmodified to agent.binance.com/mcp/agentic
      BLOCKED  → do not forward; return a structured MCP error carrying exactly one code
  │
  ▼
[5] audit log entry + receipt written           (append-only; full state snapshot; reconstructs the run)
  │
  ▼
[6] on ALLOWED + fill: parse fill → append to ledger → recompute state for the next call
```

Properties that every artifact must preserve, and that reviewers should check each artifact against:

- **P-1 Determinism of the decision.** The agent's model parses intent and proposes trades. Every threshold comparison and the send/block decision are computed by deterministic TypeScript. No LLM output is ever used as the number that decides a block, or as the block code.
- **P-2 Decimal-safe math.** All money, price, quantity, and P&L arithmetic uses `decimal.js`. No `number` arithmetic touches a currency or quantity value anywhere in the pipeline. Values are stored as decimal strings and parsed to `Decimal` at use.
- **P-3 Fail closed.** Any error, timeout, staleness, or incompleteness in a market-data or account read blocks the next trade with `DATA_UNAVAILABLE`. Cached / last-known / "assume unchanged" / zero substitution are all forbidden.
- **P-4 One named code per rejection.** Every block carries exactly one of `DRAWDOWN_BREACH | VELOCITY_EXCEEDED | LADDER_DETECTED | DATA_UNAVAILABLE`. Free text is a secondary `detail` field only, never the signal.
- **P-5 No withdrawal, no proposing.** SessionGuard never calls a withdrawal or external-transfer tool, contains no code path that could, and never authors a trade of its own.
- **P-6 State isolation.** Session state (P&L ledger, trade-timestamp list, per-symbol trend, kill-switch flag, config) lives entirely inside SessionGuard's own process/store. It is never placed in the agent's context or returned to the agent except as a read-only receipt. A reasoning failure in the agent cannot mutate or erase it.

---

## 2. Why This Should Be Built

A typical hackathon demo connects an agent to Binance's MCP server, fires one clean trade, and shows a green check. That demo can't fail, because it never runs long enough to. Production fails at the **seams between trades**, not inside them.

Grounded in the brief's research appendix (the source of truth for *why each rule exists*):

| Research finding (appendix) | Failure mechanism | SessionGuard rule that addresses it |
|---|---|---|
| **r/ClaudeAI — $31k lost** letting Claude handle real money. "Position sizing was a soft preference rather than a hard gate"; "once the drawdown flywheel crossed the recovery horizon, every subsequent trade expanded the blast radius." | Cumulative drawdown compounds across many individually-legal trades; no hard cumulative gate. | **`DRAWDOWN_BREACH`** — cumulative session P&L vs a hard configured % of starting equity. |
| **r/Daytrading — +$2k over 3 months, −$8k in 7 seconds.** Grid/martingale, no hard stop, one-way candle. | An unattended ladder of orders with no session circuit-breaker. | **`DRAWDOWN_BREACH`** + **`LADDER_DETECTED`**. |
| **r/AI_Agents — 3-week live MCP agent (Claude Code + Hyperliquid):** "churned one silver position 7 times in 17 minutes for 3 cents profit and 14 cents fees." | Trade-frequency churn; fees bleed the account; nothing counts the calls. | **`VELOCITY_EXCEEDED`** — rolling trade-count window; plus the fee-to-gross-P&L metric (§9.9 metric 4). |
| **Quora — "bots that increase lot size after a loss"** cited as the core danger pattern; **r/CryptoCurrency (Trading Parrot)** — DCA safety orders stack, floating drawdown grows silently. | Martingale: size up after a loss on the same symbol. | **`LADDER_DETECTED`** — size increase after a realized loss on the same symbol beyond a configured multiple. |
| **r/ai_trading — 249 paper bots, −$392k, $5.29M open risk.** "Open risk is the number I wasn't watching… I'd been looking at realised P&L." | Unrealized exposure ignored. | P&L computation includes **unrealized** mark-to-market, not just realized (§8 Step 4). |
| **r/algotrading — config revert re-enabled old symbols;** 453 wins wiped by 2 out-of-norm trades. **r/KuCoinTradingBot** — bots left running through a crash, no pause. | Silent config drift; no pause mechanism; no audit trail of what changed. | Schema-validated **config** with a version counter in every audit row (§8 Step 8); **manual reset** (§8 Step 10); **audit log** (§8 Step 9). |
| **TradeGuard (competing Track A entry, `github.com/devIykee/tradeguard`)** — its own README: *"No velocity or drawdown rule. Rate limiting across trades and cumulative-loss circuit breaking are not implemented."* | Named, admitted gap in the strongest existing entry. | SessionGuard **is** exactly that layer. It does not compete with per-ticket validation; it sits above it. |

The catastrophic cost is never the single bad trade. It is a sequence of individually-legal trades that a per-order validator structurally cannot see, because it evaluates one ticket at a time and holds no memory of the ten before it.

---

## 3. Why This Fits the Hackathon

- **Track A asks for an AI agent built with Agent OS.** SessionGuard's supervised system is a two-part agent system: a reference trading agent (System 1) built on Agent OS's MCP surface, and SessionGuard (System 2) which is itself an MCP server speaking the Agent OS tool surface. The core value cannot exist without Agent OS's live MCP endpoint — it needs real trade calls flowing through a real execution path to have anything to supervise. The sponsor primitive (the MCP server's trade / account / market-data tools) is the substrate SessionGuard watches.
- **It answers a gap a competing entry names in its own docs.** TradeGuard's README explicitly disclaims velocity and drawdown circuit-breaking. SessionGuard implements precisely that, one layer up.
- **It is honest about the model boundary.** The LLM proposes; deterministic code decides. That is a defensible, demonstrable design under judging scrutiny, not a black box.

Design principles restated (P-1…P-6 in §1.2). These are stated up front, not left implicit, and are load-bearing acceptance criteria in `TESTING.md`.

---

## 4. Core Thesis

**Product thesis.** The unit of failure in agent trading is the *session*, not the ticket. Users need a supervisor that remembers what happened five trades ago, not just a gate that checks the trade in front of it.

**Technical thesis.** A stateful MCP proxy can sit transparently between any MCP-compatible agent and Binance's Agentic MCP server, maintaining running P&L, trade-frequency, and position-trend state entirely outside the agent's context, so the agent's reasoning failures can't corrupt the safety state. The agent parses intent and proposes trades; SessionGuard's deterministic code computes every threshold check and owns the send/block decision. The model never authors the decision.

**Business thesis.** Anyone deploying an autonomous trading agent with real capital needs an independent kill switch that survives the agent hanging, hallucinating, or reasoning badly across many turns. That is a standing infrastructure need, not a one-time script.

### 4.1 Reference vertical

**Spot crypto trading via a single Binance Agentic sub-account, `BTCUSDT` / `ETHUSDT` / `BNBUSDT` only.**

Explicitly out of scope for the demo, with the platform reason:

| Ruled out | Reason (verified) |
|---|---|
| Futures / leverage control | Behind the **Trade** scope's futures sub-permissions; the reference vertical stays spot-only so failure modes are demonstrable in minutes. The brief assumed "not exposed by current Agent OS MCP scopes" — see `DECISIONS.md` D-2: futures *is* exposed as a scope, but leverage-parameter control is not something the brief's rules need, so spot-only stands. |
| Multi-exchange | Out of scope; SessionGuard binds to one upstream MCP endpoint. |
| Multi-account correlation | One Agentic sub-account per session. |
| Strategy generation | SessionGuard never proposes trades (P-5). |
| `Transfer` scope | Not needed; never called (§0.3). |

### 4.2 Named block codes (canonical enum)

```ts
// src/domain/blockCode.ts
export enum BlockCode {
  DRAWDOWN_BREACH = "DRAWDOWN_BREACH",   // cumulative session P&L crossed the configured drawdown %
  VELOCITY_EXCEEDED = "VELOCITY_EXCEEDED", // trade count in the rolling window exceeded the configured limit
  LADDER_DETECTED = "LADDER_DETECTED",   // position size increased after a loss on the same symbol beyond the configured multiple
  DATA_UNAVAILABLE = "DATA_UNAVAILABLE", // market price or account state could not be read fresh; fail closed
}

// Non-risk refusals (logged, not a session halt, not one of the four):
export enum RefusalCode {
  UNSUPPORTED_TOOL = "UNSUPPORTED_TOOL", // agent tried a tool outside the ToolCatalog (transfer/withdraw/futures/margin)
  SYMBOL_NOT_WHITELISTED = "SYMBOL_NOT_WHITELISTED", // symbol outside config.allowedSymbols
  SESSION_NOT_ARMED = "SESSION_NOT_ARMED", // no active session
}
```

`RefusalCode` values are deliberately separate from `BlockCode`: a scope refusal or a not-armed proxy is not a *session-risk* event and must not be conflated with the four risk halts in metrics or the demo narrative.

---

## 5. The Supervisor Model

### 5.1 System 1 — reference workload (intentionally naive)

A minimal trading agent that receives a prompt like *"trade BTCUSDT based on current market conditions"* and calls the trade tool directly. It has **no built-in risk logic**. Two interchangeable implementations:

- **1a — Claude Code agent:** Claude Code pointed at SessionGuard's MCP endpoint (not Binance's) with a system prompt that instructs it to trade a symbol and nothing about risk limits.
- **1b — Script agent:** a small deterministic TypeScript script that emits a pre-scripted sequence of `trade.placeOrder` calls. Used for the deterministic demo scenarios (§8 Step 13) so runs don't depend on live-market luck or model nondeterminism.

Both connect to SessionGuard identically. System 1 is meant to behave exactly like the naive agents in the research that lost $31k and $8k.

### 5.2 System 2 — SessionGuard (the product)

An MCP proxy server that exposes the **same tool surface** as Binance's Agentic MCP server (names resolved from `tools/list` at boot, §0.6). Every call from System 1 passes through it. After every fill it updates session state (P&L, trade count, position trend), checks that state against config in the fixed rule order, and either forwards the call to Binance or blocks it and logs why.

SessionGuard contains **no LLM**. Its decision path is pure TypeScript + `decimal.js`.

---

## 6. Internal Module Boundaries (implementation map)

Full call-flow diagrams live in `ARCHITECTURE.md`; this is the module inventory the build steps populate.

```
src/
  mcp/
    inboundServer.ts      // MCP server SessionGuard exposes to System 1 (Streamable HTTP)
    upstreamClient.ts     // MCP client SessionGuard uses to reach agent.binance.com/mcp/agentic
    toolCatalog.ts        // tools/list discovery → logical capability resolution (§0.6, §9.7)
    passthrough.ts        // forwards ALLOWED calls unmodified; verbatim request, verbatim response
  domain/
    blockCode.ts          // BlockCode + RefusalCode enums
    types.ts              // Ticket, Fill, Ledger, Session, Config, Decision, AuditLogEntry, snapshots
    decimal.ts            // decimal.js config (precision, rounding), parse/format helpers, guards
  state/
    sessionStore.ts       // Session lifecycle: arm, halt, reset; kill-switch flag; config version
    ledger.ts             // append-only fills; average-cost realized P&L; per-symbol position/trend
    pnl.ts                // running realized + unrealized P&L from ledger + MarketSnapshot
    velocityWindow.ts     // rolling trade-timestamp list + window count
  market/
    marketReader.ts       // market.price / market.klines with timeout, freshness stamp, fail-closed
    accountReader.ts      // account.balances → equity; starting-equity snapshot; fail-closed
  rules/
    evaluate.ts           // fixed-order pipeline: killSwitch → dataAvailability → drawdown → velocity → ladder
    dataAvailability.ts   // rule 1
    drawdown.ts           // rule 2
    velocity.ts           // rule 3
    ladder.ts             // rule 4
  audit/
    auditLog.ts           // append-only JSONL writer + reader; state snapshots; run reconstruction
    receipt.ts            // structured receipt returned to the agent on every decision
  config/
    schema.ts             // zod schema for config.json; load + validate + version
    load.ts
  admin/
    resetEndpoint.ts      // manual re-arm (CLI + HTTP)
    configEndpoint.ts     // live config swap (validated, versioned)
  view/
    dashboard.ts          // terminal / barebones web view polling /state
  evidence/
    scenarioRunner.ts     // scripted scenarios (happy / drawdown / velocity / ladder / data-loss)
    baseline.ts           // supervised vs unsupervised runs → evidence/results.csv → headline sentence
  index.ts                // wire-up, boot sequence, fail-closed startup assertions
```

Boot sequence (fail closed at every step):

1. Load + validate `config.json` (zod). Invalid → exit non-zero.
2. Connect `upstreamClient` to `agent.binance.com/mcp/agentic`; run OAuth if no token; `tools/list`.
3. `toolCatalog` resolves all required logical capabilities. Any unresolved → exit non-zero.
4. `accountReader` takes the starting-equity snapshot. Read fails → exit non-zero (can't arm a session without a baseline).
5. `sessionStore` arms the session (`ACTIVE`).
6. `inboundServer` starts accepting MCP connections from System 1.
7. `dashboard` starts polling.

---

## 7. End-to-End User Experience

### Experience A — Happy path

The agent places a handful of small, well-spaced spot trades on `BTCUSDT`. Each passes SessionGuard's checks: session drawdown within `drawdownPctLimit`, trade count within the velocity window, no ladder pattern, market + account reads fresh. Trades are forwarded unmodified to `agent.binance.com/mcp/agentic`, execute on Binance (through Binance's own confirm-before-execute step, §0.5), and fills come back. SessionGuard's dashboard shows running P&L ticking, all green, `killSwitch: ACTIVE`.

**User can:** watch live P&L, trade count, and per-symbol exposure change in real time; see each ALLOWED decision with its rule-by-rule evidence in the audit log.

### Experience B — Live failure and automatic recovery

The agent hits a losing streak (scripted losing sequence, or a volatile testnet window). Every individual order is within TradeGuard-style limits — size, symbol, no leverage. SessionGuard's running drawdown (realized + unrealized, decimal.js) crosses `drawdownPctLimit` mid-sequence. The **next** `trade.placeOrder` is evaluated: kill-switch still `ACTIVE`, data fresh, then the drawdown rule fails. SessionGuard does **not** forward the call. It returns an MCP error:

```
BlockCode: DRAWDOWN_BREACH
detail: "Session drawdown -6.2% exceeds -5.0% limit. Trading halted."
```

The session flips to `HALTED` with `haltReason = DRAWDOWN_BREACH`. Every subsequent trade call is rejected at rule 0 (kill-switch) with the same stored code until a human runs the manual reset.

**User can:** see the exact trade that would have executed, the exact drawdown number that tripped it (computed in code, not by the model), and the halted state on the dashboard.

### Experience C — Systemic learning loop

After a trip, the audit log shows the exact trade-by-trade sequence that led to the breach, with cumulative P&L per trade. The user reads it, decides the drawdown limit was too tight (or the velocity window too short), edits `config.json`, the `configEndpoint` validates and version-bumps it, and the user re-arms the session via the reset endpoint. No ML — the system makes the failure pattern **visible** so the human tightens the config. That is the honest learning loop for the timeframe.

**User can:** adjust any threshold without touching code, re-arm, and watch the agent resume trading under the new config, with the config version recorded in every subsequent audit row.

---

## 8. Sequential Build Steps

The fifteen steps plus sub-steps **7a** and **13a** from the brief, in the brief's order, none dropped, reordered, or merged. Any proposed change to a step is argued in `DECISIONS.md`, not applied silently. Each step carries: **Build / Why / User-can / Backend / Frontend / Data-API-UI / Test / DoD.**

> Note on rule *evaluation* order vs *build* order. The brief introduces `DATA_UNAVAILABLE` as sub-step 7a (after the ladder rule). The operating prompt fixes the **runtime** evaluation order as data-availability → drawdown → velocity → ladder. These are not in conflict: 7a is when the fail-closed rule is *implemented*; the fixed order is how the rules *run* once all exist. `rules/evaluate.ts` is authored in Step 5 with the final order and empty slots, and each subsequent step fills its slot. Recorded as `DECISIONS.md` D-3.

---

### Step 1 — MCP proxy skeleton

- **Build:** A Node/TypeScript MCP server (`inboundServer.ts`) that exposes the same tool names as Binance's Agentic MCP server and forwards calls unmodified via `upstreamClient.ts`. `toolCatalog.ts` discovers upstream tools with `tools/list` and mirrors their schemas outward. No risk logic yet.
- **Why:** Without a transparent stateful proxy in the path there is nothing to supervise; a bare pass-through is the substrate every later step attaches to. (Also the brief's Step 1 DoD.)
- **User can:** point an MCP client (Claude Code or the script agent) at SessionGuard and place a trade that reaches Binance and fills, exactly as if connected directly.
- **Backend:** `mcp/inboundServer.ts`, `mcp/upstreamClient.ts`, `mcp/toolCatalog.ts`, `mcp/passthrough.ts`, `index.ts` boot wiring.
- **Frontend:** none.
- **Data / API / UI:** new outbound dependency on `agent.binance.com/mcp/agentic`; `ToolCatalog` mapping table (logical → concrete). No persistence yet.
- **Test:** unit — `toolCatalog` resolves a mocked `tools/list` payload; `passthrough` forwards request args byte-for-byte and returns the upstream response unmodified. Manual — connect Claude Code, list tools, place one tiny real spot order on the Agentic sub-account, confirm fill.
- **DoD:** an agent connects to SessionGuard and successfully places a trade that reaches Binance. `tools/list` through the proxy returns the upstream tool set. Forwarded request/response bodies are identical to a direct call (diff = empty).

---

### Step 2 — Authenticate to Binance Agent OS

- **Build:** OAuth 2.1 + PKCE bearer-token handling for `upstreamClient.ts` against `agent.binance.com/mcp/agentic`, per §0.2. Token acquired via the MCP client OAuth flow (or `mcp-remote` bootstrap), stored in memory + `.env` (`BINANCE_AGENT_OS_BEARER_TOKEN`), attached as `Authorization: Bearer`. Detect `401/403` and surface as a fail-closed condition (feeds Step 7a).
- **Why:** Account reads and real order placement on the Agentic sub-account require the **Account** and **Trade** scopes; the demo's happy path needs a real fill. (Brief Step 2 DoD.)
- **User can:** complete the Binance "Agentic Account Access" consent once; SessionGuard then reads balances and places a real spot order on the sub-account.
- **Backend:** `upstreamClient.ts` auth module; token refresh if the client advertises a refresh grant; `401/403 → DATA_UNAVAILABLE` hook (wired fully in 7a).
- **Frontend:** none (consent screen is Binance's).
- **Data / API / UI:** `.env` keys — `BINANCE_AGENT_OS_MCP_URL`, `BINANCE_AGENT_OS_BEARER_TOKEN`, optional `BINANCE_AGENT_OS_REFRESH_TOKEN`, `BINANCE_AGENT_OS_OAUTH_CLIENT_ID`. Scopes requested: `market data`, `account`, `trade` (spot). **Never** `transfer`.
- **Test:** manual — read Agentic sub-account balances; place and fill one real spot order. Unit — `401` from a mocked upstream produces a `DATA_UNAVAILABLE` fail-closed signal, never a silent retry-with-stale.
- **DoD:** SessionGuard reads balances and places a real spot order on the Agentic sub-account. A revoked/expired token produces a fail-closed block, not an unguarded forward.
- **`DECISIONS.md` link:** D-4 — the brief says "implement bearer token handling per Agent OS MCP docs"; the docs delegate the OAuth dance to the MCP **client**, so SessionGuard consumes a token rather than implementing an authorization server. Proxy-auth topology (SessionGuard holds the Binance token; System 1 connects to SessionGuard over localhost with no auth) is documented there.

---

### Step 3 — Capture fills into session state

- **Build:** After each forwarded `trade.placeOrder`, parse the upstream response for fill price / quantity / commission / `transactTime`. If the response is thin (accepted but not yet filled), call `trade.queryOrder` to resolve fills. Append each fill to an in-memory append-only `Ledger` (`ledger.ts`).
- **Why:** Every later rule reads from the ledger; without accurate fills the P&L, ladder, and velocity state are fiction. (Brief Step 3 DoD.)
- **User can:** nothing user-visible yet; the ledger now reflects real trades.
- **Backend:** `state/ledger.ts` (append-only `Fill[]`, per-symbol `SymbolPosition`), fill-parsing in `passthrough.ts` post-forward hook.
- **Frontend:** none.
- **Data / API / UI:** `Fill` and `SymbolPosition` interfaces (§9.2, §9.3). In-memory now; JSONL persistence arrives in Step 9.
- **Test:** unit — parse a recorded fill payload (partial fill, multi-fill, commission in non-quote asset) into correct `Fill` rows; `trade.queryOrder` fallback path. Manual — place two test trades, assert the ledger has two fills with prices matching the Binance UI.
- **DoD:** the ledger accurately reflects two manually-placed test trades (price, qty, commission, timestamp), verified against the Binance sub-account trade history.

---

### Step 4 — Compute running P&L

- **Build:** `pnl.ts` computes **realized** P&L from the ledger (average-cost method per symbol, spot; position can flatten or flip) plus **unrealized** P&L from the current mark price (`market.price` via `marketReader.ts`). All arithmetic in `decimal.js` (`domain/decimal.ts` sets precision 34, `ROUND_HALF_EVEN`). `runningEquity = startingEquity + realizedPnl + unrealizedPnl` (commissions already subtracted into realized). `drawdownPct = (runningEquity − startingEquity) / startingEquity × 100`.
- **Why:** The $31k thread and the −$392k paper-bot thread both failed on cumulative P&L / open risk that nobody was totalling. Unrealized must be included — "open risk is the number I wasn't watching." (Brief Step 4 DoD.)
- **User can:** nothing user-visible yet.
- **Backend:** `state/pnl.ts`, `market/marketReader.ts` (with timeout + freshness stamp), `domain/decimal.ts`.
- **Frontend:** none.
- **Data / API / UI:** `MarketSnapshot` interface (§9.5); `pnl.ts` output `{ realizedPnl, unrealizedPnl, runningEquity, drawdownPct }` all as decimal strings.
- **Test:** unit — a scripted 3-trade sequence's P&L matches a hand-calculated expected value **exactly** (string equality on the decimal, not `toBeCloseTo`). Property test — a profitable fill never *reduces* `realizedPnl`. Edge — position flip (net long → net short) accounting.
- **DoD:** P&L number matches the manual calculation for a scripted 3-trade sequence exactly, not approximately.

---

### Step 5 — Drawdown threshold check

- **Build:** `rules/drawdown.ts`: compare `drawdownPct` (from Step 4) against `−config.drawdownPctLimit`. If `drawdownPct <= −drawdownPctLimit`, return a failing `RuleResult` with `code = DRAWDOWN_BREACH`, `observed`, `threshold`, and a templated `detail`. Author `rules/evaluate.ts` now with the final fixed order (kill-switch → data-availability → drawdown → velocity → ladder) and stub-pass the not-yet-built rules. On a failing decision, `sessionStore` flips to `HALTED` and stores the code.
- **Why:** The $31k drawdown flywheel — "position sizing was a soft preference rather than a hard gate." This is the hard gate. Directly fills TradeGuard's stated "no… drawdown rule" gap.
- **User can:** see a trade blocked with reason code `DRAWDOWN_BREACH`, and the session go `HALTED`.
- **Backend:** `rules/drawdown.ts`, `rules/evaluate.ts`, `state/sessionStore.ts` halt/kill-switch.
- **Frontend:** none yet (dashboard is Step 11); block is visible in the returned MCP error and logs.
- **Data / API / UI:** `RuleResult`, `Decision` interfaces (§9.6). MCP error payload shape carrying `BlockCode`.
- **Test:** unit — at `−4.9%` allow, at `−5.0%` block, at `−6.2%` block; `observed`/`threshold` are code-computed, never from any model. Integration — a scripted losing sequence trips the halt at the configured %. Invariant — once `HALTED`, the next call is rejected at rule 0.
- **DoD:** a scripted losing sequence trips the halt at the configured %.

---

### Step 6 — Trade-velocity counter

- **Build:** `velocityWindow.ts`: maintain a list of ISO timestamps of **allowed + forwarded** trades. `rules/velocity.ts`: count entries within `[now − config.velocityWindowSeconds, now]`; if `count >= config.velocityMaxTrades`, fail with `VELOCITY_EXCEEDED`.
- **Why:** The Hyperliquid agent churned one position 7× in 17 minutes — "direction cost $3.02, fees cost $7.78 — because nothing counted the calls." This counts the calls. Fills TradeGuard's stated "no velocity… rule" gap.
- **User can:** see a rapid-fire sequence blocked with `VELOCITY_EXCEEDED`.
- **Backend:** `state/velocityWindow.ts`, `rules/velocity.ts`, hook into the post-forward path so only executed trades count.
- **Frontend:** none yet.
- **Data / API / UI:** `Session.tradeTimestamps: string[]`; window params from config.
- **Test:** unit — 4 trades in a 15-min window with limit 5 → allow; 5th within the window → block; a trade whose timestamp has aged out of the window no longer counts. Integration — rapid-fire scripted sequence trips the halt.
- **DoD:** a rapid-fire test sequence trips the halt.

---

### Step 7 — Position / ladder trend tracker

- **Build:** `ledger.ts` tracks per symbol: `lastTradeQty` (abs base qty of the most recent fill), `lastRealizedDelta` (realized P&L change from the most recent fill), `lastTradeWasLoss` (`lastRealizedDelta < 0`). `rules/ladder.ts`: if the incoming ticket **increases exposure in the same direction** on symbol `S`, and `S.lastTradeWasLoss`, and `ticket.quantity > S.lastTradeQty × config.ladderMultipleLimit`, fail with `LADDER_DETECTED`.
- **Why:** Quora and Trading Parrot — "bots that increase lot size after a loss" are the core blow-up pattern; martingale/DCA safety orders stack while floating drawdown grows silently.
- **User can:** see a martingale-style "size up after a loss" trade blocked with `LADDER_DETECTED`.
- **Backend:** `state/ledger.ts` trend fields, `rules/ladder.ts`.
- **Frontend:** none yet.
- **Data / API / UI:** `SymbolPosition` trend fields (§9.3); `config.ladderMultipleLimit` (decimal string).
- **Test:** unit — loss then 2× size on same symbol with multiple 1.5 → block; loss then 1.2× → allow; **win** then 3× → allow (ladder only fires after a loss); opposite-direction (reducing) trade after a loss → allow. Integration — scripted martingale sequence trips the halt.
- **DoD:** a scripted martingale-style sequence trips the halt.

---

### Step 7a — Fail-closed on missing data

- **Build:** `rules/dataAvailability.ts` as the **first** rule after the kill-switch. `marketReader.ts` and `accountReader.ts` wrap every read with `dataFetchTimeoutMs`, a freshness stamp, and payload validation. Any error / timeout / stale (`fetchedAt` older than `priceStalenessSeconds`) / incomplete (missing quote-asset balance, non-positive price) / upstream `401`/`403` → fail with `DATA_UNAVAILABLE`. No cached, last-known, zero, or "assume previous" substitution (P-3).
- **Why:** The brief's fail-closed rule — "No data, no trade." A false "state looks fine" from stale data is how a drawdown breach slips through unseen.
- **User can:** see a trade blocked with `DATA_UNAVAILABLE` when a data source is down, instead of it slipping through on assumed state.
- **Backend:** `rules/dataAvailability.ts`, hardening in `market/marketReader.ts` and `market/accountReader.ts`, `401/403` hook from Step 2.
- **Frontend:** none yet.
- **Data / API / UI:** `MarketSnapshot.stale`, `AccountSnapshot.stale`; config `priceStalenessSeconds`, `dataFetchTimeoutMs`.
- **Test:** unit — mocked market read that (a) throws, (b) times out, (c) returns `price: "0"`, (d) returns a 30-second-old timestamp with `priceStalenessSeconds: 10`, (e) returns `401` → all block with `DATA_UNAVAILABLE`; a missing data point is **never** coerced to `0` or to the previous value. Integration — a forced API failure trips the halt instead of silently passing.
- **DoD:** a forced (mocked) API failure trips the halt with `DATA_UNAVAILABLE` instead of silently passing.

---

### Step 8 — Config file

- **Build:** `config/schema.ts` — a zod schema for `config.json`: `drawdownPctLimit` (decimal string, > 0), `velocityWindowSeconds` (int, > 0), `velocityMaxTrades` (int, > 0), `ladderMultipleLimit` (decimal string, >= 1), `allowedSymbols` (non-empty array from `{BTCUSDT, ETHUSDT, BNBUSDT}`), `priceStalenessSeconds` (int, > 0), `dataFetchTimeoutMs` (int, > 0). `config/load.ts` validates on boot (invalid → exit non-zero) and assigns a monotonically increasing `configVersion`.
- **Why:** r/algotrading — a silent config revert re-enabled old symbols and wiped 453 winning trades. Config must be explicit, schema-checked, versioned, and visible in the audit trail.
- **User can:** edit thresholds in `config.json` and change trip behaviour without touching code.
- **Backend:** `config/schema.ts`, `config/load.ts`; `Session.config` + `Session.configVersion`.
- **Frontend:** none yet (live-edit UI is via `configEndpoint`, Step 10 neighbourhood; dashboard shows current values in Step 11).
- **Data / API / UI:** `config.json` file; `Config` interface (§9.8); `.env` may override the file path via `SESSIONGUARD_CONFIG_PATH`.
- **Test:** unit — a schema-invalid config (negative drawdown, unknown symbol, `ladderMultipleLimit: 0.5`) is rejected; a valid edit changes trip behaviour with no code change; `configVersion` increments on reload.
- **DoD:** changing config changes trip behaviour without code changes; invalid config is refused at boot.

---

### Step 9 — Audit log

- **Build:** `audit/auditLog.ts` — append-only JSONL (`evidence/audit-<sessionId>.jsonl`). One row per: `SESSION_START`, `TOOL_CALL` (with `ALLOWED`/`BLOCKED`, `code`, all `ruleResults`, full `StateSnapshot`, and a `forwardedResponseDigest` for allowed calls), `CONFIG_CHANGE` (old/new version), `RESET`. `audit/receipt.ts` returns a structured receipt to the agent on every decision. A reader reconstructs the full run (trade-by-trade cumulative P&L curve) from the file.
- **Why:** r/KuCoinTradingBot / r/algotrading — no audit trail meant nobody could see what the bots did until the account was down 15–50%. Experience C's learning loop needs the trade-by-trade curve.
- **User can:** read a complete, ordered log of every call and every block, and reconstruct a past demo run exactly.
- **Backend:** `audit/auditLog.ts`, `audit/receipt.ts`; ledger + session persistence to JSONL.
- **Frontend:** none yet (dashboard reads this in Step 11).
- **Data / API / UI:** `AuditLogEntry`, `StateSnapshot` interfaces (§9.7); JSONL file format; `GET /audit` endpoint returning the rows.
- **Test:** unit — every decision writes exactly one row; rows are append-only (no rewrites); the reconstruction function reproduces the cumulative P&L curve from rows alone. Integration — run a full scenario, kill the process, re-read the log, assert the run is fully reconstructable.
- **DoD:** the log fully reconstructs a demo run after the fact.

---

### Step 10 — Manual reset

- **Build:** `admin/resetEndpoint.ts` — a CLI command (`npm run rearm`) and an HTTP endpoint (`POST /admin/rearm`) that clears the kill-switch flag, resets session state (new `sessionId`, fresh starting-equity snapshot, cleared ledger + velocity window), and writes a `RESET` audit row. `admin/configEndpoint.ts` — `POST /admin/config` validates and version-bumps a new config. Both are bound to localhost and require `SESSIONGUARD_ADMIN_TOKEN`.
- **Why:** r/KuCoinTradingBot — "no pause mechanism." A halt with no re-arm is a dead system; a re-arm with no audit row is an invisible override.
- **User can:** re-arm the session after a human review, optionally under a new config, and let the agent resume trading.
- **Backend:** `admin/resetEndpoint.ts`, `admin/configEndpoint.ts`, `state/sessionStore.ts` reset path.
- **Frontend:** CLI output; dashboard reflects the new `sessionId` and `ACTIVE` status (Step 11).
- **Data / API / UI:** `POST /admin/rearm`, `POST /admin/config`; `.env` — `SESSIONGUARD_ADMIN_TOKEN`, `SESSIONGUARD_ADMIN_PORT`.
- **Test:** unit — re-arm clears the halt and starts a new session id; a re-arm without the admin token is refused; every re-arm writes exactly one `RESET` row. Integration — halt on drawdown, re-arm, next trade is allowed again.
- **DoD:** the agent can resume trading after a human re-arms.

---

### Step 11 — Minimal dashboard / CLI view

- **Build:** `view/dashboard.ts` — a terminal view (and a barebones single-file web view at `GET /`) that polls `GET /state` every ~1s and shows: running P&L (realized / unrealized / total, decimal), `drawdownPct` vs limit, trade count in window vs limit, per-symbol net exposure and last-trade-was-loss flag, kill-switch status, `haltReason`, current `configVersion` and threshold values.
- **Why:** The judge (and the operator) must watch state change in real time; "open risk is the number I wasn't watching" is only fixed if the number is on screen.
- **User can:** watch live session P&L, trade count, and kill-switch status change during a run.
- **Backend:** `GET /state` JSON endpoint (reads `sessionStore` + `pnl` + `velocityWindow`); `view/dashboard.ts`.
- **Frontend:** terminal renderer; minimal inline-HTML/JS web view (no framework, polls `/state`).
- **Data / API / UI:** `GET /state` response shape = `StateSnapshot` + config summary.
- **Test:** manual — run a scenario, confirm the dashboard numbers match the audit log's final `StateSnapshot`. Unit — `/state` serializes decimals as strings, never `number`.
- **DoD:** a judge can watch state change in real time during the demo.

---

### Step 12 — Wire up System 1 (reference agent)

- **Build:** Point the Claude Code agent (1a) and the script agent (1b) at SessionGuard's MCP endpoint instead of `agent.binance.com/mcp/agentic`. System-prompt for 1a: trade a named symbol on market conditions, **no** risk instructions. 1b emits a configurable `trade.placeOrder` sequence.
- **Why:** Proves the proxy is transparent to a real MCP agent and that the naive agent (the $31k / $8k persona) trades end-to-end through it without knowing SessionGuard is there.
- **User can:** run the reference agent and see it trade end-to-end through SessionGuard.
- **Backend:** agent connection config; no SessionGuard code change beyond ensuring `tools/list` passthrough is agent-compatible.
- **Frontend:** none.
- **Data / API / UI:** MCP client config pointing at `SESSIONGUARD_INBOUND_URL` (localhost).
- **Test:** manual — 1a places a real small trade through the proxy and it fills. Integration — 1b's sequence produces the expected ledger and decisions.
- **DoD:** the agent successfully trades end-to-end through the proxy.

---

### Step 13 — Script the three demo scenarios

- **Build:** `evidence/scenarioRunner.ts` — deterministic pre-scripted `trade.placeOrder` sequences for **happy path**, **drawdown breach**, **velocity breach** (plus `ladder` and `data-loss` for `TESTING.md`). Determinism via a **MockUpstream** MCP server that returns scripted fills/prices, so runs don't depend on live-market luck. One real happy-path trade against the Agentic sub-account is kept for the live-fill moment; the losing scenarios run against MockUpstream.
- **Why:** The brief requires scenarios "deterministic, not dependent on live market luck." A losing streak cannot be reliably summoned from a live market on demo day.
- **User can:** nothing yet (prep); scenarios run on demand.
- **Backend:** `evidence/scenarioRunner.ts`, `test/mockUpstream.ts` (scripted fills, prices, error injection).
- **Frontend:** none.
- **Data / API / UI:** scenario definition files (JSON: ordered tickets + mock fill/price responses + expected terminal decision).
- **Test:** each scenario run 10× produces byte-identical audit logs (modulo timestamps); expected terminal `BlockCode` matches.
- **DoD:** all three scenarios run reliably on repeat.

---

### Step 13a — Baseline comparison + headline metric

- **Build:** `evidence/baseline.ts` — run each scripted losing scenario **twice**: once through SessionGuard, once with the reference agent hitting the (mock) upstream directly with no supervisor. Log per run to `evidence/results.csv`: `scenario, mode (supervised|unsupervised), halted (bool), halt_trade_index, final_drawdown_pct, trades_executed, fee_to_gross_pnl`. Then generate **one sentence** from the CSV (not hand-typed), e.g. *"Across N scripted sessions, SessionGuard halted before further loss in every case; the unsupervised agent kept trading through all N."*
- **Why:** The proof of the whole thesis is supervised-vs-unsupervised on the *same* sequence. A hand-typed claim is not evidence; a CSV-backed generated sentence is.
- **User can:** re-run one script and get the same sentence and the same CSV rows.
- **Backend:** `evidence/baseline.ts`, CSV writer, sentence generator (pure function of the CSV).
- **Frontend:** none (the sentence + CSV are the artifact).
- **Data / API / UI:** `evidence/results.csv` schema (above); `evidence/headline.txt` output.
- **Test:** the generator is a pure function — same CSV in → same sentence out; the sentence's numbers equal the CSV's row counts; re-running `baseline.ts` reproduces the CSV row-for-row.
- **DoD:** the sentence is reproducible by re-running the script, and the CSV backs it row for row.

---

### Step 14 — Record demo video + polish README

- **Build:** Record the deterministic §10 script. Write `README.md` with an architecture diagram (from `ARCHITECTURE.md`), the setup steps (`.env.example` → OAuth → `tools/list` → arm → run agent), and links to the six companion docs.
- **Why:** Track A requires a video/demo and a GitHub repo.
- **User can:** watch the video and reproduce the demo from the README.
- **Backend / Frontend:** none (docs + recording).
- **Data / API / UI:** `README.md`, `docs/architecture.svg`, `demo.mp4`.
- **Test:** a fresh clone + README steps reaches a working armed proxy and a passing scenario run.
- **DoD:** video + GitHub match Binance's Track A submission requirements (§12).

---

### Step 15 — Submit

- **Build:** Complete the three Track A entry actions: (1) follow **@Binance** and repost the announcement; (2) quote-repost with the video/demo + GitHub link; (3) complete the survey. All before **2026-09-08 23:59 UTC**.
- **Why:** An unsubmitted build scores zero.
- **User can:** see the entry posted.
- **Data / API / UI:** the X post URL, the survey confirmation.
- **Test:** manual checklist in §12; each of the three actions confirmed done.
- **DoD:** all three entry steps confirmed before 23:59 UTC today.

---

## 9. Data Model & Metrics

`decimal.js` is configured once (`domain/decimal.ts`): `Decimal.set({ precision: 34, rounding: Decimal.ROUND_HALF_EVEN })`. Money / price / quantity / P&L are **decimal strings at rest**, parsed to `Decimal` at use, formatted back to string for storage and transport. A lint rule + a `TESTING.md` invariant forbid `number` arithmetic on these fields.

### 9.1 `Ticket` — an intercepted trade proposal

```ts
export type Side = "BUY" | "SELL";
export type OrderType = "MARKET" | "LIMIT";

export interface Ticket {
  ticketId: string;          // uuid, assigned by SessionGuard at intercept
  sessionId: string;
  receivedAt: string;        // ISO-8601 UTC
  toolName: string;          // resolved logical capability, e.g. "trade.placeOrder"
  upstreamToolName: string;  // concrete Binance tool name from ToolCatalog
  symbol: string;            // e.g. "BTCUSDT"
  side: Side;
  type: OrderType;
  quantity: string | null;   // decimal string, base asset (null if quoteOrderQty used)
  quoteOrderQty: string | null; // decimal string, quote asset (null if quantity used)
  price: string | null;      // decimal string for LIMIT, null for MARKET
  timeInForce: string | null;
  rawParams: Record<string, unknown>; // verbatim args from the agent; NEVER mutated before forwarding
}
```

### 9.2 `Fill` — a realized execution

```ts
export interface Fill {
  fillId: string;
  sessionId: string;
  ticketId: string;
  symbol: string;
  side: Side;
  price: string;             // decimal string, actual execution price
  quantity: string;          // decimal string, base asset filled
  quoteQuantity: string;     // decimal string = price * quantity
  commission: string;        // decimal string
  commissionAsset: string;
  timestamp: string;         // ISO-8601 UTC from exchange transactTime
  raw: Record<string, unknown>;
}
```

### 9.3 `SymbolPosition` — per-symbol position and trend

```ts
export interface SymbolPosition {
  symbol: string;
  netQuantity: string;       // signed decimal string (+ long, - short); spot stays >= 0 in practice
  avgEntryPrice: string;     // decimal string, average cost of the open position
  realizedPnl: string;       // decimal string, quote asset (USDT), cumulative for this symbol
  lastTradeQty: string;      // decimal string, abs base qty of the most recent fill on this symbol
  lastRealizedDelta: string; // decimal string, realized-P&L change from the most recent fill
  lastTradeWasLoss: boolean; // lastRealizedDelta < 0
  lastTradeSide: Side | null;
  updatedAt: string;
}
```

### 9.4 `Ledger` — append-only fills + derived positions

```ts
export interface Ledger {
  sessionId: string;
  fills: Fill[];                              // append-only; never edited or reordered
  positions: Record<string, SymbolPosition>; // keyed by symbol
  realizedPnl: string;                       // decimal string, sum over symbols, USDT
  totalCommission: string;                   // decimal string, USDT-equivalent
  updatedAt: string;
}
```

### 9.5 Market and account snapshots

```ts
export interface MarketSnapshot {
  symbol: string;
  markPrice: string;         // decimal string, > 0
  fetchedAt: string;         // ISO-8601 UTC
  source: "mcp:market.price" | "mcp:market.klines";
  stale: boolean;            // now - fetchedAt > config.priceStalenessSeconds
  ok: boolean;               // fetch succeeded and payload validated
}

export interface AccountSnapshot {
  fetchedAt: string;
  balances: Record<string, string>; // asset -> (free + locked) decimal string
  equityUsdt: string;               // decimal string, quote-valued total
  stale: boolean;
  ok: boolean;
}
```

### 9.6 Rules, decision

```ts
export type RuleName = "KILL_SWITCH" | "DATA_AVAILABILITY" | "DRAWDOWN" | "VELOCITY" | "LADDER";

export interface RuleResult {
  rule: RuleName;
  pass: boolean;
  code: BlockCode | null;    // set iff pass === false
  observed: string;          // code-computed evidence, e.g. "-6.2" or "6"  (NEVER from an LLM)
  threshold: string;         // e.g. "-5.0" or "5"
  detail: string;            // templated string; secondary to `code` (P-4)
}

export type DecisionOutcome = "ALLOWED" | "BLOCKED";

export interface Decision {
  ticketId: string;
  sessionId: string;
  decidedAt: string;
  outcome: DecisionOutcome;
  code: BlockCode | null;    // set iff outcome === "BLOCKED"; exactly one code
  ruleResults: RuleResult[]; // fixed order; stops at the first failing rule
  stateSnapshot: StateSnapshot;
}
```

### 9.7 Session, config, audit, tool catalog

```ts
export type SessionStatus = "ACTIVE" | "HALTED";

export interface Session {
  sessionId: string;
  startedAt: string;
  startingEquity: string;    // decimal string USDT, snapshot at arm time
  status: SessionStatus;
  haltReason: BlockCode | null;
  haltedAt: string | null;
  haltDetail: string | null; // human-readable; not the source of any deciding number
  config: Config;
  configVersion: number;
  tradeTimestamps: string[]; // ISO-8601 of ALLOWED + forwarded trades (velocity window input)
}

export interface Config {
  drawdownPctLimit: string;      // decimal string, > 0  (e.g. "5" means halt at -5%)
  velocityWindowSeconds: number; // int > 0  (e.g. 900)
  velocityMaxTrades: number;     // int > 0  (e.g. 5)
  ladderMultipleLimit: string;   // decimal string >= 1  (e.g. "1.5")
  allowedSymbols: string[];      // subset of ["BTCUSDT","ETHUSDT","BNBUSDT"], non-empty
  priceStalenessSeconds: number; // int > 0  (e.g. 10)
  dataFetchTimeoutMs: number;    // int > 0  (e.g. 3000)
}

export interface StateSnapshot {
  runningPnlUsdt: string;        // decimal string (realized + unrealized)
  realizedPnlUsdt: string;
  unrealizedPnlUsdt: string;
  drawdownPct: string;           // decimal string, negative = loss
  tradeCountInWindow: number;
  velocityWindowSeconds: number;
  perSymbol: Record<string, {
    netQuantity: string;
    lastTradeQty: string;
    lastTradeWasLoss: boolean;
  }>;
  killSwitch: SessionStatus;
  haltReason: BlockCode | null;
  configVersion: number;
}

export type AuditCallType = "SESSION_START" | "TOOL_CALL" | "CONFIG_CHANGE" | "RESET";

export interface AuditLogEntry {
  logId: number;                 // monotonic, per session
  sessionId: string;
  timestamp: string;
  callType: AuditCallType;
  toolName: string | null;
  outcome: DecisionOutcome | null;
  code: BlockCode | null;
  ruleResults: RuleResult[];
  stateSnapshot: StateSnapshot;
  forwardedResponseDigest: string | null; // sha256 + {fillPrice, fillQty} summary; not the full payload
}

// ToolCatalog: logical capability -> concrete upstream tool, resolved from tools/list at boot
export type LogicalTool =
  | "market.price" | "market.klines"
  | "account.balances" | "account.trades"
  | "trade.placeOrder" | "trade.testOrder" | "trade.queryOrder" | "trade.openOrders";

export interface ToolCatalog {
  resolvedAt: string;
  map: Record<LogicalTool, string>;      // logical -> concrete Binance tool name
  rawList: Array<{ name: string; description?: string; inputSchema: unknown }>;
  // capabilities NOT in `map` (transfer/withdraw/futures/margin) are refused with RefusalCode.UNSUPPORTED_TOOL
}
```

### 9.8 Persisted schemas (JSONL / CSV, mirroring the brief's tables)

| Store | Fields |
|---|---|
| `sessions` (`sessionStore`) | `session_id, started_at, starting_equity, status, halt_reason, halted_at, config_version` |
| `fills` (`ledger`) | `fill_id, session_id, ticket_id, symbol, side, price, quantity, quote_quantity, commission, commission_asset, timestamp` |
| `audit_log` (`evidence/audit-<sessionId>.jsonl`) | `log_id, session_id, timestamp, call_type, tool_name, outcome, code, rule_results_json, state_snapshot_json, forwarded_response_digest` |
| `config` (`config.json` + version) | `drawdown_pct_limit, velocity_window_seconds, velocity_max_trades, ladder_multiple_limit, allowed_symbols, price_staleness_seconds, data_fetch_timeout_ms, config_version` |
| `evidence/results.csv` (Step 13a) | `scenario, mode, halted, halt_trade_index, final_drawdown_pct, trades_executed, fee_to_gross_pnl` |

### 9.9 Core metrics (no vanity metrics)

1. **Session drawdown at time of halt** — proves the trigger fired at the configured threshold, not early/late. Source: the `DRAWDOWN` `RuleResult.observed` vs `threshold` on the halting row.
2. **Trades blocked vs trades allowed** — ratio shows the supervisor is doing work, not passing everything. Source: count of `TOOL_CALL` rows by `outcome`.
3. **Time-to-halt after threshold breach** — latency of the safety layer; should be near-instant (single-digit ms; the block is synchronous, before forwarding). Source: `decidedAt − receivedAt` on the halting ticket.
4. **Fee-to-gross-P&L ratio per session** — surfaces the churn problem directly (the Hyperliquid fee-bleed finding). Source: `totalCommission / abs(grossRealizedPnl)`.
5. **Headline comparison metric** — supervised vs unsupervised outcome across the same scripted scenarios, generated from `evidence/results.csv`, not hand-typed (Step 13a).

---

## 10. The Deterministic Judge Demo

Full script and setup in `DEMO.md`. Summary (11 steps, deterministic, MockUpstream for the losing sequence so nothing depends on live-market timing):

1. Presenter starts the SessionGuard proxy and the reference agent, both visibly running in the terminal.
2. Presenter states the on-screen config: **−5% session drawdown limit, 5 trades / 15 min velocity limit**, symbols `BTCUSDT/ETHUSDT/BNBUSDT`.
3. Agent places trade 1 (`BTCUSDT` small buy). Terminal: **allowed**, forwarded to Binance, fill confirmed. Dashboard P&L updates.
4. Agent places trades 2 and 3 — scripted small losses. Running P&L ticks down on the live dashboard.
5. Agent places trade 4 — a scripted larger loss that pushes cumulative drawdown past **−5%**.
6. SessionGuard **blocks trade 5** before it reaches Binance. Terminal shows the exact line: `DRAWDOWN_BREACH — session drawdown -6.2% exceeds -5% limit. Trading halted.`
7. Presenter points out: **Binance's own confirm-before-execute step never even saw this trade** — it was stopped one layer earlier (§0.5).
8. Presenter opens the audit log: the full trade-by-trade cumulative P&L curve that led to the halt.
9. Presenter re-runs the **same losing sequence** with the reference agent hitting the upstream directly, no supervisor: it keeps trading through the full drawdown. Presenter reads the one generated headline sentence from `evidence/results.csv`.
10. Presenter switches config live (loosen the limit), re-arms the session, shows the agent resuming trading.
11. Presenter closes: *"Every guardrail built for this hackathon checks if one ticket is too big. The trades that actually blew up real accounts — the $31,000 Claude thread, the bot that lost $8,000 in seven seconds — were all individually legal. SessionGuard is the layer that remembers what happened five trades ago. That's the layer nobody else built."*

Optional B-roll (not in the timed run): a `VELOCITY_EXCEEDED` scenario and a `DATA_UNAVAILABLE` scenario, each ~15 seconds, to show all four codes fire.

---

## 11. Companion Documents (generated after PRD approval)

| Doc | Contents |
|---|---|
| `ARCHITECTURE.md` | Two-system model; the module boundaries in §6; the exact call flow for a **forwarded** trade and a **blocked** trade (sequence diagrams); the MockUpstream test rig. |
| `SECURITY.md` | Threats specific to this design: prompt injection trying to bypass a block; stale price feeding a false drawdown; bearer-token handling, expiry, `401/403` fail-closed; and the grep-able proof that **no withdrawal / external-transfer path exists anywhere in the codebase**. |
| `TESTING.md` | Unit tests per rule (drawdown, velocity, ladder, data-availability); the demo scenarios as integration tests; invariants that must never break (a profitable fill never reduces the cumulative drawdown used for future checks; an expired or halted session never forwards a trade; a missing data point is never treated as `0` or as "assume previous value"; decimals never touch `number` math). |
| `DEMO.md` | The 11-step judge script above, kept deterministic, with the exact terminal lines and the MockUpstream scenario definitions. |
| `DECISIONS.md` | Every divergence between this PRD and the brief's assumptions, with the platform evidence (D-1 tool-name discovery; D-2 futures scope exists but is unused; D-3 rule build-order vs eval-order; D-4 proxy-auth topology; and any found later). |
| `.env.example` | `BINANCE_AGENT_OS_MCP_URL`, `BINANCE_AGENT_OS_BEARER_TOKEN`, `BINANCE_AGENT_OS_REFRESH_TOKEN`, `BINANCE_AGENT_OS_OAUTH_CLIENT_ID`, `SESSIONGUARD_INBOUND_URL`, `SESSIONGUARD_INBOUND_PORT`, `SESSIONGUARD_ADMIN_PORT`, `SESSIONGUARD_ADMIN_TOKEN`, `SESSIONGUARD_CONFIG_PATH`, and the config threshold mirror (`SG_DRAWDOWN_PCT_LIMIT`, `SG_VELOCITY_WINDOW_SECONDS`, `SG_VELOCITY_MAX_TRADES`, `SG_LADDER_MULTIPLE_LIMIT`, `SG_ALLOWED_SYMBOLS`, `SG_PRICE_STALENESS_SECONDS`, `SG_DATA_FETCH_TIMEOUT_MS`). |
| `TASKS.md` | A sequential checklist, ordered exactly by §8, each item a single checkable action with its DoD attached. |

---

## 12. Track A Submission Audit (execution gate)

No coding starts until every row is **PASS** or has a named owner + due time before 23:59 UTC.

| Requirement (verified §0.8) | Plan element | Status |
|---|---|---|
| Submission is an **AI agent built with Agent OS** | System 1 (reference agent) + System 2 (SessionGuard MCP server) both speak the Agent OS MCP surface at `agent.binance.com/mcp/agentic`; SessionGuard's value depends on the live endpoint. | PASS (by design) |
| **Video / demo** | Step 14 records the deterministic §10 / `DEMO.md` script. | PENDING — Step 14 |
| **GitHub repo** | Public repo with README (architecture diagram + setup), the six companion docs, `evidence/` (audit logs, `results.csv`, `headline.txt`). | PENDING — Step 14 |
| **Follow @Binance + repost the announcement** | Step 15 action 1. | PENDING — Step 15 |
| **Quote-repost with the submission (video + GitHub)** | Step 15 action 2. | PENDING — Step 15 |
| **Complete the survey** | Step 15 action 3. | PENDING — Step 15 |
| **Deadline 2026-09-08 23:59 UTC** | All of Steps 1–15 today; if time-boxed, the minimum shippable is Steps 1–11 + 13 + 13a + 14 + 15 (a live agent is nice-to-have; MockUpstream scenarios carry the demo). | AT RISK — same-day; see `TASKS.md` triage note |
| **Eligibility** (not US/UK/EEA/HK/SG/prohibited list) | Operator to self-confirm jurisdiction before posting. | OWNER: operator |
| **No withdrawal / custody risk in the artifact** | §0.4 + `SECURITY.md` §5 grep assertion; `transfer`/`withdraw` never in the ToolCatalog. | PASS (by design) |

---

## 13. Open Questions to Resolve Before / During Build (tracked in DECISIONS.md)

1. **Concrete upstream tool names + parameter shapes** — resolved at boot via `tools/list`; `ToolCatalog` must be validated against the real payload on first connect (D-1).
2. **Token refresh semantics** — undocumented; confirm whether the MCP client exposes a refresh grant, else treat every `401` as a hard fail-closed and require operator re-auth (D-4).
3. **Whether the Agentic sub-account can run fully-autonomous trade scope** (no per-order confirmation) for the live happy-path trade, or whether the presenter confirms each — DEMO.md must handle both.
4. **Spot fill payload shape** — partial fills, multi-fill arrays, commission asset (BNB vs quote) — lock the parser against a recorded real response in Step 3.
5. **MockUpstream fidelity** — it must mimic the real fill/price payloads closely enough that the same parser handles both (asserted in Step 13 tests).

---

*End of PRD. Awaiting approval to generate ARCHITECTURE.md, SECURITY.md, TESTING.md, DEMO.md, DECISIONS.md, .env.example, and TASKS.md.*
