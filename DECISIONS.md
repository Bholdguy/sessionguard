# SessionGuard — DECISIONS.md

Every place the build diverged from `sessionguard-build-brief.md`, and why. Each entry: **what the brief assumed → what is actually available / chosen → consequence.** Nothing in §8 of the PRD is dropped, reordered, or merged; where a step's *implementation* timing differs from its *runtime* behaviour that is recorded here, not applied silently.

Research basis: Binance developer docs (`developers.binance.com/en/docs/agent-native/mcp-server`, `.../mcp-server/agentic`, `.../llms-full.txt`), Binance blog "The Binance Agent OS Mini Hackathon", and launch coverage (TechCrunch 2026-08-20, crypto.news, HackerNoon, PRNewswire), all checked 2026-09-08.

---

## D-0. Build priority and demo data source (operator addition, approved)

**Brief assumption:** Steps 1–15 all completed, with a real Binance fill on the Agentic sub-account as part of the happy path (Steps 2, 3, 12) and the deterministic scenarios layered on top (Step 13).

**Decision:**

- **Required path:** Steps **1–11, 13, 13a, 14, 15**. These must all be green for a valid submission.
- **MockUpstream is the primary demo data source.** All three scripted scenarios (happy / drawdown / velocity), plus the `ladder` and `data-loss` scenarios, run against MockUpstream so the demo is deterministic and independent of live-market timing, token state, or Binance availability on demo day.
- **A live Binance fill is attempted only after Step 15 is submittable** — i.e. video recorded against MockUpstream, repo pushed, entry actions ready. The live fill is an enhancement to the happy-path segment, never a blocker. If OAuth, scope, or sub-account funding is not ready, the submission still stands on MockUpstream evidence.
- Steps 2, 3, 12 remain in the plan and keep their DoDs; their *live* verification is deferred to the post-Step-15 window. Their *MockUpstream* verification (auth stubbed, fill parser exercised against recorded + mock payloads) is part of the required path.

**Consequence:** `DEMO.md` scripts MockUpstream throughout. `TASKS.md` marks Steps 2/3/12 live-verification items as "post-submit". The critical path to a submittable entry does not touch the live Binance endpoint.

---

## D-1. Upstream MCP tool names are not published — discover at boot, with a hard timeout

**Brief assumption:** The proxy "exposes the same tool names as Binance's MCP server" and forwards specific named calls (`trade`, `account-read`, `market-data` endpoints), implying the names and parameter shapes are known from documentation.

**What is actually available:** Binance's public docs describe tool *capabilities* ("check the market, check balances, place/cancel orders, transfer within the sub-account") but **do not publish** the literal MCP tool-name identifiers or their JSON parameter schemas. Secondary coverage refers loosely to "~7 trading tools and 2 account tools" but none are authoritative name strings.

**Decision:**

- SessionGuard hard-codes **no** upstream tool name. At boot, `mcp/toolCatalog.ts` calls MCP `tools/list` on `agent.binance.com/mcp/agentic` and resolves a fixed set of **logical capabilities** (`market.price`, `market.klines`, `account.balances`, `account.trades`, `trade.placeOrder`, `trade.testOrder`, `trade.queryOrder`, `trade.openOrders`) to concrete discovered names, using name/description/inputSchema matching with an explicit allow-list of candidate patterns per capability.
- **Hard timeout (operator addition, approved):** the `tools/list` call is wrapped with a timeout of `TOOLS_LIST_TIMEOUT_MS` (default **5000 ms**, configurable in `.env`). On timeout, on a `tools/list` error, or on **any required logical capability failing to resolve**, SessionGuard prints **one** clear error line naming the missing capability (or the timeout) and **exits non-zero immediately**. No retry loop, no exponential backoff, no hanging, no partial start. Example messages:
  - `FATAL: tools/list timed out after 5000ms against https://agent.binance.com/mcp/agentic — cannot resolve tool catalog. Exiting.`
  - `FATAL: required capability "trade.placeOrder" did not match any upstream tool (candidates tried: place_order, spot_new_order, new_order, createOrder). Exiting.`
- `trade.testOrder` and `trade.queryOrder` are **optional**: if unresolved, SessionGuard logs a warning and disables the corresponding hardening (dry-run pre-check, thin-response fill resolution) but still starts. `market.klines` is optional if `market.price` resolves. Everything else is required.
- `transfer.*`, `withdraw.*`, futures, and margin tools are **deliberately excluded** from the catalog. A downstream call to any tool not in the resolved `map` is refused with `RefusalCode.UNSUPPORTED_TOOL` and logged; it is not one of the four risk `BlockCode`s because it is a scope refusal, not a session-risk halt.
- The resolved `ToolCatalog` (logical → concrete, plus the raw `tools/list` payload) is written to the first audit row (`SESSION_START`) so a run can be reproduced against the exact upstream surface it saw.

**Consequence:** Step 1's DoD adds "`tools/list` resolves all required capabilities or the process exits with one error". MockUpstream (D-0) publishes tool names in the same shape so the same resolver and parser handle both. Open question OQ-1 (PRD §13) is closed by the boot-time validation.

---

## D-2. Futures / leverage: the brief said "not exposed"; it *is* a scope, but is intentionally unused

**Brief assumption:** "futures/leverage (not exposed by current Agent OS MCP scopes)".

**What is actually available:** The **Trade** scope *does* cover USDⓈ-M and COIN-M futures, per the agentic docs. So futures execution is reachable. However, leverage-*parameter* control (setting margin mode, leverage multiplier) is not something any rule in the brief needs, and futures P&L accounting (funding, liquidation, cross/isolated margin) is materially more complex than spot.

**Decision:** The reference vertical stays **spot-only on `BTCUSDT` / `ETHUSDT` / `BNBUSDT`**, exactly as the brief's §5 intends. SessionGuard requests only the spot portion of the Trade scope. Any futures/margin tool that appears in `tools/list` is excluded from the `ToolCatalog` and refused with `UNSUPPORTED_TOOL`. The brief's stated reason ("not exposed") is corrected to "exposed but intentionally out of scope — spot-only keeps the failure modes demonstrable in minutes and the P&L math exact."

**Consequence:** No change to any build step. `SECURITY.md` notes futures tools are refused, not just unused.

---

## D-3. Rule *build* order (7a last) vs rule *runtime evaluation* order (data-availability first)

**Brief structure:** `DATA_UNAVAILABLE` is introduced as sub-step **7a**, after drawdown (Step 5), velocity (Step 6), and ladder (Step 7).

**Operating-prompt requirement:** the runtime evaluation order is fixed as **data-availability → drawdown → velocity → ladder** (preceded by a kill-switch short-circuit).

**Decision:** These are not in conflict and neither is changed. `rules/evaluate.ts` is authored in **Step 5** with the final fixed order and empty/stub slots for the not-yet-built rules (each stub returns `pass: true`). Each later step fills its own slot:

| Runtime order | Rule | Built in |
|---|---|---|
| 0 | kill-switch short-circuit (halted session → stored code) | Step 5 |
| 1 | data-availability → `DATA_UNAVAILABLE` | Step **7a** |
| 2 | drawdown → `DRAWDOWN_BREACH` | Step 5 |
| 3 | velocity → `VELOCITY_EXCEEDED` | Step 6 |
| 4 | ladder → `LADDER_DETECTED` | Step 7 |

Evaluation stops at the first failing rule, so exactly one `BlockCode` is ever returned (PRD P-4).

**Consequence:** Between Step 7a's completion and its own, the data-availability slot is a permissive stub; `TESTING.md` marks the fail-closed integration test as gated on Step 7a. No step is reordered in `TASKS.md`.

---

## D-4. Bearer-token handling: the brief said "implement per Agent OS MCP docs"; the docs delegate OAuth to the MCP client

**Brief assumption (Step 2):** "implement bearer token handling per Agent OS MCP docs (`agent.binance.com/mcp/agentic`)", implying SessionGuard performs the OAuth flow itself.

**What is actually available:** The agentic docs describe OAuth 2.1 + PKCE driven by the **MCP client** (`claude mcp add`, `codex mcp add --oauth-client-id codex`, VS Code MCP settings, ChatGPT connector). The client obtains the bearer token via a Binance consent screen; there is no documented server-to-server client-credentials grant for a third-party proxy, and token lifetime/refresh semantics are not published.

**Decision — proxy-auth topology:**

- SessionGuard acts as the **MCP client toward Binance**: it runs the standard client OAuth flow once (via `mcp-remote` or an equivalent bootstrap), receives the bearer token, and stores it in memory + `.env` (`BINANCE_AGENT_OS_BEARER_TOKEN`). It attaches `Authorization: Bearer <token>` to every upstream Streamable-HTTP request.
- SessionGuard's **inbound** MCP server (the surface System 1 connects to) is bound to **localhost** and requires **no authentication** from the reference agent.
- On any upstream `401` / `403` (token expired or scope revoked mid-session), SessionGuard does **not** silently retry with stale state. It raises a fail-closed condition: the next trade is blocked with `DATA_UNAVAILABLE`, and the operator must re-authenticate. If the MCP client advertises a refresh-token grant, SessionGuard uses it once and only falls back to operator re-auth if the refresh fails.

**Security scope statement (operator addition, approved — also stated in `SECURITY.md` §3 and §7):** The proxy holding the Binance token while the reference agent connects unauthenticated over localhost is **acceptable for this local, single-operator demo only**. It is **not** a pattern for any hosted, shared, or multi-user deployment. A hosted deployment would require: per-agent authentication to SessionGuard's inbound surface, per-session token isolation, the token held in a secret store rather than `.env`, and an OAuth token-exchange (RFC 8693) or equivalent rather than a single shared bearer. `SECURITY.md` records this as an explicit non-goal for the hackathon artifact.

**Consequence:** Step 2's work is "consume and attach a client-obtained token + handle 401/403 fail-closed", not "build an authorization server". `.env.example` carries the token variables. OQ-2 (PRD §13) remains open only on refresh semantics, with the fail-closed fallback as the safe default.

---

## D-5. Binance's confirm-before-execute step sits *downstream* of SessionGuard

**Brief assumption (Experiences A/B, Demo step 7):** "Trades execute normally on Binance, confirmed through Binance's own confirm-before-execute step" and "Binance's own confirm-before-execute step never even saw this trade."

**What is actually available:** Confirmed. The agentic docs state the agent restates the order and waits for user approval on every non-read action, unless the user has configured autonomous trade scope. This confirmation is enforced at the Binance MCP layer, which is **downstream** of SessionGuard in the call path.

**Decision:** No divergence — the brief is correct. Recorded here only to make the ordering explicit for `ARCHITECTURE.md`: a **blocked** trade is stopped by SessionGuard *before* forwarding, so it never reaches Binance's confirmation prompt; a **forwarded** trade still passes through that prompt (or through the user's autonomous-scope pre-authorization) after SessionGuard allows it. For the deterministic demo, MockUpstream (D-0) stands in for the Binance layer including an auto-approve of forwarded orders, so the run does not stall on an interactive prompt. Whether the live Agentic sub-account is set to autonomous trade scope or per-order confirmation is a `DEMO.md` pre-flight checklist item for the post-submit live attempt only.

**Consequence:** `DEMO.md` handles both live modes in the pre-flight; the timed run uses MockUpstream and never blocks on a prompt.

---

## D-6. `Transfer` scope exists but is never requested or proxied

**Brief assumption (§5):** Lists "Transfer scope" nowhere as in-scope; the withdrawal-scope restriction is called out but intra-sub-account transfer is not discussed.

**What is actually available:** The **Transfer** scope (move funds between wallets *inside* the same Agentic sub-account) is real and separate from withdrawal (which has no scope at all).

**Decision:** SessionGuard requests **only** `market data`, `account`, and `trade` (spot) scopes. It never requests `transfer`. Any transfer tool in `tools/list` is excluded from the `ToolCatalog` and refused with `UNSUPPORTED_TOOL`. This keeps the invariant in PRD P-5 ("never calls a withdrawal or external-transfer tool, contains no code path that could") trivially checkable — there is no transfer or withdrawal capability anywhere in the resolved catalog.

**Consequence:** `SECURITY.md` §5's grep assertion covers `transfer` alongside `withdraw`.

---

## D-7. Deterministic scenarios require a losing streak the live market will not supply on demand

**Brief assumption (Step 13):** Scenarios are "pre-scripted trade sequences ... deterministic, not dependent on live market luck", implied to run through the normal path.

**Decision:** A **MockUpstream** MCP server (`test/mockUpstream.ts`) implements the same resolved tool surface and returns scripted fills and prices (and injected errors for the data-loss scenario). The losing scenarios run against MockUpstream. This is explicitly sanctioned by the brief's own "not dependent on live market luck" requirement; recorded here because it introduces a test double into the demo path that the brief does not name. MockUpstream payload shapes are asserted (in Step 13 tests) to be close enough to recorded real responses that the single fill parser handles both.

**Consequence:** Combined with D-0, MockUpstream is the primary demo data source, not just a test fixture.

---

## D-8. Reset semantics: new session id, fresh equity snapshot

**Brief assumption (Step 10):** "clear the kill-switch flag and reset session state."

**Decision (making "reset session state" precise):** A re-arm allocates a **new `sessionId`**, takes a **fresh starting-equity snapshot** from `account.balances` (fail-closed if that read fails — a session cannot arm without a baseline), clears the fill ledger and the velocity-window timestamp list, sets `status = ACTIVE`, `haltReason = null`, and writes exactly one `RESET` audit row referencing the prior session id. Realized P&L from the prior session is **not** carried forward — the drawdown baseline is the new snapshot. This matches Experience C (the human tightens config, then re-arms into a clean session).

**Consequence:** `TESTING.md` invariant: after re-arm, `drawdownPct` is computed against the new `startingEquity`, and a pre-reset profitable or losing fill has no effect on post-reset checks.

---

## D-9. Hackathon deadline is the same day as the build

**Brief assumption (Step 15):** "before 23:59 UTC today" — the brief was written for same-day submission.

**Verified:** Deadline **2026-09-08 23:59 UTC**; today is 2026-09-08. Track A entry = follow @Binance + repost the announcement, quote-repost with video/demo + GitHub link, complete the survey. Not open to US / UK / EEA / Hong Kong / Singapore / Binance prohibited-list jurisdictions.

**Decision:** The required path (D-0) is sized to be submittable same-day with MockUpstream evidence. `TASKS.md` carries a triage note: if time runs short, the minimum shippable is Steps 1–11 + 13 + 13a + 14 + 15. Operator self-confirms jurisdiction eligibility before posting (owner: operator, not a code task).

**Consequence:** No scope beyond the brief; the live Binance fill is explicitly post-submit (D-0).

---

## D-10. Time-triage priority (operator addition, approved) — apply only if the deadline is at risk

The required path (D-0) stands. If, and only if, time runs short on 2026-09-08, degrade in this exact order:

1. **Cut Step 7 (ladder detection) entirely first**, before cutting anything else. `LADDER_DETECTED` is dropped from the demo; `rules/evaluate.ts` keeps a permanent pass-through stub in the ladder slot so the fixed order and `BlockCode` enum are unchanged. `TESTING.md` LD-* and IT-5 are skipped. The martingale research finding (Quora / Trading Parrot) is acknowledged as covered indirectly by `DRAWDOWN_BREACH`.
2. **Trim the unit-test matrices in Steps 5, 6, 7a to 2–3 cases each** (not the full DD-/VL-/DA- tables). Keep at minimum: one allow at the boundary, one block past it, and — for 7a — one stale + one error case. **Integration scenarios IT-1…IT-9 stay intact** — they carry the demo and matter more than exhaustive unit coverage.
3. **Simplify Step 9's audit row to `{ timestamp, sessionId, logId, callType, outcome, code, detail }`** — drop the raw `tools/list` dump, `forwardedResponseDigest`, and the full `StateSnapshot` embed (keep a compact `{ drawdownPct, tradeCountInWindow, killSwitch }`). Run reconstruction then rebuilds the P&L curve from the compact fields; if that is not enough for the IT-8 curve assertion, keep `drawdownPct` per row at minimum.
4. **Step 11 dashboard: terminal-only.** Skip the single-file web view; keep `GET /state` (the terminal renderer polls it and it is trivial).

**Not cuttable under any circumstances: Step 13a (baseline comparison + headline metric).** If Step 13a is ever at risk, stop and flag it to the operator immediately rather than dropping or degrading it.

**Consequence:** `TASKS.md` items carry `[T1]`…`[T4]` markers on the parts that these tiers remove, so the cut is mechanical if triggered. Nothing here changes the plan unless the deadline is actually at risk.

---

## D-11. Known Limitations (from the conformance audit; not fixed)

Logged for visibility. Each is one line, no fix attempted. The three items fixed in the same pass
(multi-session inbound crash, `audit:show --session` arg parsing, `.env` upstream URL) are **not**
listed here because they were fixed.

### Spec / DoD coverage gaps (audit gap list "B")

- **B1** — Step 8 (config) has zero automated tests: schema validation, `configVersion` increment, `POST /admin/config`, and the `CONFIG_CHANGE` audit row are unverified by the suite (validation logic works under manual check).
- **B2** — Step 9 (audit) is only partly covered: no bearer-redaction test (SECURITY §3/§6), no one-row-per-decision / append-only test, no `CONFIG_CHANGE` / `RESET` row test. `IT-8` (reconstruct + `logIdGaps`) is the only audit test.
- **B3** — No `GET /audit` endpoint exists (TASKS Step 9 bullet); only `GET /state` is served.
- **B4** — `IT-7` is not implemented: the drawdown → `POST /admin/rearm` → happy integration (pre-reset fills have zero effect on post-reset checks; exactly one `RESET` row).
- **B5** — The SECURITY §1 injection suite is absent: no test drives `bypass=true`, `override:"admin"`, a mock `tools/list` advertising `disable_guard`, or `"drawdown limit is -50%"` in a detail-shaped field. INV-6 is covered only by the single `DD-6` provenance case.
- **B6** — Boot fail-closed suite (`BT-1..BT-4`) is partial: `tools/list` timeout and unresolved-required capability are covered; invalid-config `exit(1)` and failed starting-equity-read `exit(1)` are not.

### Fail-closed / invariant gaps in code (audit gap list "C")

- **C1** — `marketReader` only evaluates staleness when the upstream price payload carries a timestamp field; a price with no timestamp is returned `stale:false, ok:true` and passes the data rule (`src/market/marketReader.ts` ~line 88). Contradicts SECURITY §2 / PRD §0.7.2.
- **C2** — `AccountSnapshot.stale` is never set `true` anywhere; the `ctx.account.stale` check in `dataAvailability` is dead.
- **C3** — Post-halt kill-switch audit rows persist a zeroed `StateSnapshot` (`src/rules/evaluate.ts` ~line 109), so `audit:show` shows `0.00%` for every row after the halt and the "full snapshot in every row" claim (SECURITY §6) degrades for the tail of a run.
- **C4** — `src/audit/auditLog.ts` line 29 builds the digest summary with `a + Number(f.quantity)` — `number` arithmetic on a quantity value. Digest string only; no decision consumes it. Both lint scripts and the documented greps miss it (P-2 literal).

### Data-model / doc divergences (audit gap list "D")

- **D1** — `Config` schema requires an 8th field, `priceSanityMaxDeviationPct` (`.strict()`), so a config matching PRD §9.8 exactly (7 fields) is rejected at boot.
- **D2** — `Decision.refusal`, `AuditLogEntry.{refusal,meta}`, `MarketSnapshot.{source:"none",reason}`, `AccountSnapshot.reason`, `ToolCatalog.excluded`, and `ToolCatalog.map: Partial<…>` are all supersets of PRD §9 and undocumented there.
- **D3** — The `SESSION_START` audit row stores only the resolved `map` + `excluded`, not the raw `tools/list` payload that D-1 asks for (weakens "reproduce against the exact upstream surface it saw").
- **D4** — The required-capability set in code is 3 (`market.price`, `account.balances`, `trade.placeOrder`); the D-1 text above implies 5 (also `account.trades`, `trade.openOrders`).
- **D5** — `RefusalCode.SESSION_NOT_ARMED` is defined but never emitted; `sessionStore.current()` throws on an unarmed session instead.
- **D6** — SECURITY §3 says the loopback-http upstream is gated on `NODE_ENV=test`; the code also accepts `demo` (DEMO.md needs it). Separately, `LD-8`'s intended semantic (`lastTradeWasLoss` on *any* negative realized delta) diverges from the implemented `didClose && realizedDelta.isNegative()` in `src/state/ledger.ts`.

### Additional issues found during this fix pass (not in the original B/C/D lists)

- **A1** — `npm run start` (`node --loader tsx …`) fails on Node ≥ 20.6 (`--loader` removed); `npm run dev` (`tsx src/index.ts`) works. `DEMO.md` now uses `npm run dev`.
- **A2** — With the `SG_*` lines present in `.env`, `dotenv` re-injects them into `process.env` at boot and `config/load.applyEnvOverrides` lets them override both `config.json` and a live `POST /admin/config` body, so a live threshold *value* change requires editing the matching `SG_*` line (or removing it) and restarting. `POST /admin/config` still bumps `configVersion` and writes the `CONFIG_CHANGE` row. The `npm run agent` harness uses its own hard-coded `DEFAULT_CONFIG` and is unaffected by either.
