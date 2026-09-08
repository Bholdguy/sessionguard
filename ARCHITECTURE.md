# SessionGuard — ARCHITECTURE.md

Companion to `PRD.md`. Defines the two-system model, SessionGuard's internal module boundaries, and the exact call flow for a **forwarded** trade and a **blocked** trade. Terminology and interfaces are those of PRD §6 and §9. Decisions referenced as `D-n` live in `DECISIONS.md`.

---

## 1. The two-system model

```
┌─────────────────────────────┐          ┌──────────────────────────────────────────────┐          ┌───────────────────────────────┐
│  SYSTEM 1  (reference agent) │          │  SYSTEM 2  (SessionGuard — the product)       │          │  UPSTREAM                     │
│  intentionally naive         │  MCP     │  stateful MCP proxy, NO LLM in decision path  │  MCP     │  MockUpstream (primary, D-0)  │
│                              │  over    │                                              │  over    │   or                          │
│  1a Claude Code agent        │──HTTP───▶│  inbound MCP server ──▶ rules ──▶ passthrough │──HTTP───▶│  agent.binance.com/mcp/agentic │
│  1b deterministic script     │ localhost│         ▲                          │          │  bearer  │  (live, post-submit only)     │
│  (no risk logic either)      │ no auth  │         │   session state          │          │  token   │                               │
└─────────────────────────────┘  (D-4)   │         └──────────┬───────────────┘          │  (D-4)   │  Binance confirm-before-      │
                                          │                    ▼                          │          │  execute step lives HERE (D-5)│
                                          │   ledger · pnl · velocity · sessionStore ·   │          └───────────────────────────────┘
                                          │   toolCatalog · audit log · config           │
                                          │                    │                          │
                                          │                    ▼                          │
                                          │   dashboard  ◀── GET /state   (Step 11)       │
                                          │   admin      ◀── POST /admin/rearm, /config   │
                                          └──────────────────────────────────────────────┘
```

- **System 1** parses intent and proposes trades. It never sees SessionGuard's session state (PRD P-6). Two interchangeable implementations (PRD §5.1); both connect to SessionGuard's inbound endpoint exactly as they would connect to Binance's.
- **System 2** is an MCP server *and* an MCP client. It mirrors the upstream tool surface outward (names resolved at boot, D-1), and holds all risk state in-process.
- **Upstream** is MockUpstream for the demo and all scenarios (D-0, D-7); the live Binance endpoint is attempted only after Step 15 is submittable.
- **Binance's own confirm-before-execute step is downstream of SessionGuard** (D-5): a blocked trade never reaches it; a forwarded trade still passes through it (or the user's autonomous-scope pre-authorization).

---

## 2. Module boundaries

Directory map is PRD §6. Responsibilities and allowed dependencies:

| Module | Responsibility | May depend on | Must NOT depend on |
|---|---|---|---|
| `mcp/inboundServer` | Expose the mirrored tool surface to System 1 over Streamable HTTP (localhost). Assign `ticketId`, build `Ticket` from raw args **without mutating them**. | `mcp/toolCatalog`, `rules/evaluate`, `mcp/passthrough`, `audit/*` | `state/*` internals (goes through `rules/evaluate`) |
| `mcp/upstreamClient` | MCP client to the upstream endpoint. OAuth token attach, `401/403` fail-closed hook (D-4). | `config/*` | `rules/*`, `state/*` |
| `mcp/toolCatalog` | Boot-time `tools/list` with hard timeout (D-1); resolve logical → concrete; exclude transfer/withdraw/futures/margin (D-2, D-6); exit non-zero on failure. | `mcp/upstreamClient` | everything else |
| `mcp/passthrough` | Forward an ALLOWED call **byte-for-byte**; return the upstream response **unmodified**; post-forward hook to parse fills. | `mcp/upstreamClient`, `state/ledger` | `rules/*` |
| `domain/decimal` | `decimal.js` config (precision 34, `ROUND_HALF_EVEN`); `parse`, `format`, `isDecimalString` guards. | — | everything (leaf) |
| `domain/types`, `domain/blockCode` | Interfaces + enums (PRD §9). | `domain/decimal` | — |
| `state/ledger` | Append-only `Fill[]`; per-symbol `SymbolPosition` incl. trend fields; average-cost realized P&L. | `domain/*` | `rules/*`, `mcp/*` |
| `state/pnl` | Running realized + unrealized P&L, `runningEquity`, `drawdownPct` from ledger + `MarketSnapshot`. | `state/ledger`, `domain/*` | `rules/*` |
| `state/velocityWindow` | Rolling timestamp list of ALLOWED+forwarded trades; window count. | `domain/*` | — |
| `state/sessionStore` | `Session` lifecycle: arm, halt (store `BlockCode`), reset (D-8); kill-switch flag; config version. | `domain/*`, `config/*`, `market/accountReader` | `rules/*` |
| `market/marketReader` | `market.price` / `market.klines` with `dataFetchTimeoutMs`, freshness stamp, payload validation, fail-closed. | `mcp/upstreamClient`, `domain/*`, `config/*` | `rules/*` |
| `market/accountReader` | `account.balances` → equity; starting-equity snapshot; fail-closed. | `mcp/upstreamClient`, `domain/*`, `config/*` | `rules/*` |
| `rules/evaluate` | The fixed-order pipeline (D-3). Assembles `RuleContext`, runs rules, stops at first failure, produces `Decision`. **Pure given its context** — no I/O except the readers it is handed. | `rules/dataAvailability|drawdown|velocity|ladder`, `state/*`, `market/*` | `mcp/inboundServer` |
| `rules/dataAvailability|drawdown|velocity|ladder` | One rule each. Pure functions `(RuleContext) => RuleResult`. All comparisons in `decimal.js`. | `domain/*` | `mcp/*`, any I/O |
| `audit/auditLog` | Append-only JSONL writer + reader; run reconstruction. | `domain/*` | `rules/*` |
| `audit/receipt` | Structured receipt returned to System 1 on every decision. | `domain/*` | — |
| `config/schema`, `config/load` | zod schema; boot validation (exit non-zero on invalid); `configVersion`. | `domain/*` | — |
| `admin/resetEndpoint`, `admin/configEndpoint` | Localhost + `SESSIONGUARD_ADMIN_TOKEN`; re-arm (D-8) and live config swap; write `RESET` / `CONFIG_CHANGE` audit rows. | `state/sessionStore`, `config/*`, `audit/*` | `rules/*` |
| `view/dashboard` | Poll `GET /state`; terminal + barebones web view. Read-only. | `state/*` (read), HTTP | `rules/*`, `mcp/*` |
| `evidence/scenarioRunner`, `evidence/baseline` | Scripted scenarios; supervised vs unsupervised runs → `evidence/results.csv` → generated headline sentence. | `mcp/*`, `test/mockUpstream` | — |
| `test/mockUpstream` | MCP server implementing the resolved tool surface with scripted fills/prices/errors (D-0, D-7). | `domain/*` | production `src/*` |

**Hard rule:** the `rules/*` layer performs **no I/O**. All external reads (market, account) happen in `rules/evaluate` *before* rule functions run, and are passed in as a frozen `RuleContext`. This is what makes every rule unit-testable with a plain object and guarantees the decision is a pure function of the context (PRD P-1).

---

## 3. Boot sequence (fail closed at every step)

```
1. config/load: read + zod-validate config.json      ── invalid ─▶ print 1 error, exit(1)
2. mcp/upstreamClient.connect(BINANCE_AGENT_OS_MCP_URL)
     └─ no token ─▶ run client OAuth (mcp-remote bootstrap)   [live only; MockUpstream skips]
3. mcp/toolCatalog.resolve():
     tools/list  with timeout TOOLS_LIST_TIMEOUT_MS (default 5000ms, D-1)
       ├─ timeout ──────────────▶ print 1 error, exit(1)     "tools/list timed out after 5000ms … Exiting."
       ├─ required capability unresolved ─▶ print 1 error, exit(1)  (names the capability + candidates tried)
       └─ optional capability unresolved ─▶ warn, disable that hardening, continue
4. market/accountReader.snapshotStartingEquity()
       └─ read fails ───────────▶ print 1 error, exit(1)     (cannot arm without a baseline, D-8)
5. state/sessionStore.arm()  → status ACTIVE, new sessionId
6. audit/auditLog.write(SESSION_START)  incl. resolved ToolCatalog + raw tools/list payload (D-1)
7. admin endpoints bind to 127.0.0.1:SESSIONGUARD_ADMIN_PORT (require SESSIONGUARD_ADMIN_TOKEN)
8. mcp/inboundServer listen on 127.0.0.1:SESSIONGUARD_INBOUND_PORT (no auth, D-4)
9. view/dashboard begins polling GET /state
```

No step retries indefinitely. Every failure path is: one clear message, non-zero exit (D-1).

---

## 4. Call flow — FORWARDED trade (the happy path)

```
System 1                inboundServer         rules/evaluate         market/account readers      passthrough/upstream        ledger/pnl/velocity        auditLog
   │ trade.placeOrder      │                       │                        │                          │                          │                       │
   ├──────────────────────▶│                       │                        │                          │                          │                       │
   │                       │ build Ticket          │                        │                          │                          │                       │
   │                       │ (rawParams frozen)    │                        │                          │                          │                       │
   │                       ├──────────────────────▶│                        │                          │                          │                       │
   │                       │                       │ (0) kill-switch: ACTIVE → pass                     │                          │                       │
   │                       │                       │ symbol ∈ config.allowedSymbols? ── no ─▶ RefusalCode.SYMBOL_NOT_WHITELISTED (not a BlockCode)          │
   │                       │                       ├───────────────────────▶│ marketReader.get(symbol) │                          │                       │
   │                       │                       │                        │  price fresh & > 0, ok   │                          │                       │
   │                       │                       ├───────────────────────▶│ accountReader.balances() │                          │                       │
   │                       │                       │                        │  quote balance present   │                          │                       │
   │                       │                       │ (1) data-availability: pass                        │                          │                       │
   │                       │                       │ (2) drawdown:  drawdownPct(-2.1) >  -5.0  → pass    │  (pnl from ledger+mark)  │                       │
   │                       │                       │ (3) velocity:  2 in window   <  5        → pass     │                          │                       │
   │                       │                       │ (4) ladder:   not (loss & size>1.5×)     → pass     │                          │                       │
   │                       │                       │ Decision = ALLOWED                                  │                          │                       │
   │                       │◀──────────────────────┤                        │                          │                          │                       │
   │                       │ forward UNMODIFIED     │                        │                          │                          │                       │
   │                       ├───────────────────────┼────────────────────────┼─────────────────────────▶│ upstream places order    │                       │
   │                       │                       │                        │                          │  (Binance confirm step   │                       │
   │                       │                       │                        │                          │   OR MockUpstream auto)  │                       │
   │                       │                       │                        │                          │  fill response ─────────▶│ parse fill            │
   │                       │                       │                        │                          │  (thin? trade.queryOrder)│  append Fill          │
   │                       │                       │                        │                          │                          │  recompute positions, │
   │                       │                       │                        │                          │                          │  realized P&L, trend  │
   │                       │                       │                        │                          │                          │  velocity.push(now)   │
   │                       │◀──────────────────────┼────────────────────────┼──────────────────────────┤ upstream response verbatim                       │
   │                       │ write TOOL_CALL row: ALLOWED, ruleResults[5], StateSnapshot, responseDigest ──────────────────────────────────────────────────▶│
   │◀──────────────────────┤ return { upstreamResponse, receipt }                                                                                          │
```

Notes:
- The upstream response is returned to System 1 **verbatim**; the `receipt` is an *additional* field, never a replacement (PRD P-6 — state is read-only to the agent).
- Fill parsing and state mutation happen **after** the forward and **before** the response is returned, so the next call sees updated state.
- `market`/`account` reads for the *next* call are fresh reads, not the ones cached here (P-3).

---

## 5. Call flow — BLOCKED trade (drawdown breach shown; other codes identical shape)

```
System 1                inboundServer         rules/evaluate         readers                sessionStore              auditLog
   │ trade.placeOrder      │                       │                    │                       │                       │
   ├──────────────────────▶│ build Ticket          │                    │                       │                       │
   │                       ├──────────────────────▶│                    │                       │                       │
   │                       │                       │ (0) kill-switch: ACTIVE → pass              │                       │
   │                       │                       ├───────────────────▶│ market price fresh ok  │                       │
   │                       │                       ├───────────────────▶│ account balances ok    │                       │
   │                       │                       │ (1) data-availability: pass                 │                       │
   │                       │                       │ (2) drawdown:                               │                       │
   │                       │                       │     observed  = "-6.2"   (code-computed)    │                       │
   │                       │                       │     threshold = "-5.0"   (from config)      │                       │
   │                       │                       │     -6.2 <= -5.0  → FAIL, code=DRAWDOWN_BREACH                       │
   │                       │                       │ evaluation STOPS (velocity, ladder not run) │                       │
   │                       │                       │ Decision = BLOCKED, code = DRAWDOWN_BREACH  │                       │
   │                       │                       ├───────────────────────────────────────────▶│ halt(): status HALTED │
   │                       │                       │                                            │ haltReason=DRAWDOWN_.. │
   │                       │                       │                                            │ haltedAt=now           │
   │                       │◀──────────────────────┤                    │                       │                       │
   │                       │  *** call is NOT forwarded — upstream never sees it (D-5) ***       │                       │
   │                       │ write TOOL_CALL row: BLOCKED, DRAWDOWN_BREACH, ruleResults (stops at rule 2), StateSnapshot ─▶│
   │◀──────────────────────┤ return MCP error:                                                                            │
   │                       │   { isError: true,                                                                            │
   │                       │     code: "DRAWDOWN_BREACH",                                                                   │
   │                       │     detail: "Session drawdown -6.2% exceeds -5.0% limit. Trading halted.",                     │
   │                       │     receipt: { stateSnapshot, ruleResults } }                                                  │
```

Every subsequent call while `status === HALTED`:

```
   │ trade.placeOrder ────▶│ build Ticket ───▶ rules/evaluate
   │                       │   (0) kill-switch: HALTED → immediate FAIL with stored haltReason
   │                       │   rules 1–4 NOT evaluated; no market/account read performed
   │                       │ write TOOL_CALL row: BLOCKED, <stored code>
   │◀── MCP error { code: <stored code>, detail: "Session halted (DRAWDOWN_BREACH). Re-arm required." }
```

Recovery: `POST /admin/rearm` (D-8) → new `sessionId`, fresh equity snapshot, cleared ledger + velocity window, `RESET` audit row → next call is evaluated normally.

---

## 6. `RuleContext` assembly (the only place I/O meets rules)

```ts
// rules/evaluate.ts  (sketch)
export async function evaluate(ticket: Ticket, deps: Deps): Promise<Decision> {
  const session = deps.sessionStore.current();

  // (0) kill-switch short-circuit — no I/O
  if (session.status === "HALTED") {
    return blocked(ticket, session, session.haltReason!, /*ruleResults*/[killSwitchFail(session)]);
  }

  // scope refusals — not BlockCodes
  if (!session.config.allowedSymbols.includes(ticket.symbol)) {
    return refusal(ticket, RefusalCode.SYMBOL_NOT_WHITELISTED);
  }

  // fresh reads — every call, never cached (P-3). Failures surface as unavailable snapshots.
  const market = await deps.marketReader.get(ticket.symbol);        // MarketSnapshot { ok, stale, ... }
  const account = await deps.accountReader.balances();              // AccountSnapshot { ok, stale, ... }
  const pnl = deps.pnl.compute(deps.ledger.snapshot(), market, session.startingEquity); // decimal.js
  const ctx: RuleContext = Object.freeze({
    ticket, session, ledger: deps.ledger.snapshot(),
    market, account, pnl,
    tradeCountInWindow: deps.velocityWindow.count(nowIso(), session.config.velocityWindowSeconds),
    now: nowIso(),
  });

  const order = [dataAvailability, drawdown, velocity, ladder];     // FIXED (D-3)
  const results: RuleResult[] = [];
  for (const rule of order) {
    const r = rule(ctx);                                            // pure, sync, decimal.js
    results.push(r);
    if (!r.pass) {
      deps.sessionStore.halt(r.code!, r.detail);
      return blocked(ticket, session, r.code!, results);
    }
  }
  return allowed(ticket, session, results);
}
```

`Deps` is injected, so tests pass fakes for `marketReader` / `accountReader` / `ledger` / `sessionStore` and assert on the returned `Decision` with zero network.

---

## 7. Data stores and lifetimes

| Store | Medium | Lifetime | Written by | Read by |
|---|---|---|---|---|
| `Session` | in-memory (single process) | until process exit or re-arm | `sessionStore` | `rules/evaluate`, `dashboard`, `admin` |
| `Ledger` (`fills`, positions) | in-memory + mirrored to `evidence/fills-<sessionId>.jsonl` | per session (cleared on re-arm, D-8) | `passthrough` post-forward hook | `pnl`, `rules/ladder`, `dashboard` |
| velocity timestamps | in-memory array on `Session` | per session | `passthrough` post-forward hook | `rules/velocity`, `dashboard` |
| audit log | `evidence/audit-<sessionId>.jsonl` (append-only) | permanent | `auditLog` | `dashboard`, run reconstruction, metrics |
| `config.json` + `configVersion` | file + in-memory | until reload/`CONFIG_CHANGE` | operator / `configEndpoint` | everything |
| `evidence/results.csv`, `evidence/headline.txt` | files | permanent | `evidence/baseline` | README, demo |

Single-process, single-session by design (PRD §4.1 "one Agentic sub-account per session"). No database; JSONL + CSV are sufficient for reconstruction and evidence, and keep the repo inspectable by a judge.

---

## 8. Failure-mode → response matrix

| Condition | Detected in | Response | Code |
|---|---|---|---|
| `tools/list` timeout / required capability unresolved | boot (`toolCatalog`) | one error, `exit(1)` (D-1) | — (no session) |
| invalid `config.json` | boot (`config/load`) | one error, `exit(1)` | — |
| starting-equity read fails | boot (`accountReader`) | one error, `exit(1)` | — |
| market price errors / times out / ≤ 0 / stale | `rules/evaluate` pre-rule read | block next trade | `DATA_UNAVAILABLE` |
| account balance read errors / missing quote asset | `rules/evaluate` pre-rule read | block next trade | `DATA_UNAVAILABLE` |
| upstream `401` / `403` mid-session | `upstreamClient` | block next trade; operator re-auth (D-4) | `DATA_UNAVAILABLE` |
| cumulative drawdown ≤ −limit | `rules/drawdown` | block + halt session | `DRAWDOWN_BREACH` |
| trades-in-window ≥ limit | `rules/velocity` | block + halt session | `VELOCITY_EXCEEDED` |
| size-up after loss on same symbol > multiple | `rules/ladder` | block + halt session | `LADDER_DETECTED` |
| agent calls transfer / withdraw / futures / margin tool | `inboundServer` (not in `ToolCatalog`) | refuse, log; no halt | `UNSUPPORTED_TOOL` (RefusalCode) |
| agent calls a whitelisted tool with symbol outside whitelist | `rules/evaluate` | refuse, log; no halt | `SYMBOL_NOT_WHITELISTED` (RefusalCode) |
| call arrives with no armed session | `inboundServer` | refuse, log | `SESSION_NOT_ARMED` (RefusalCode) |
| session already `HALTED` | `rules/evaluate` rule 0 | block, no reads, no forward | stored `haltReason` |
