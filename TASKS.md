# SessionGuard — TASKS.md

Sequential checklist, ordered exactly by `PRD.md` §8. No step dropped, reordered, or merged. Each item is a single checkable action with its **DoD** attached (matching the brief's DoD where one exists).

**Legend:** `[R]` required path (D-0: Steps 1–11, 13, 13a, 14, 15). `[P]` post-submit / live-only. `[D-n]` see `DECISIONS.md`.

**Triage note (D-9):** deadline is 2026-09-08 23:59 UTC. If time runs short, the minimum shippable is Steps 1–11 + 13 + 13a + 14 + 15 with MockUpstream evidence. Steps 2/3/12 live verification is explicitly `[P]`.

---

## Step 0 — Repo + toolchain bootstrap  `[R]`

- [ ] Init repo: `npm init`, TypeScript strict, Vitest, `decimal.js`, an MCP server/client lib (Streamable HTTP), zod. `.gitignore` includes `.env`, `evidence/audit-*.jsonl`, `evidence/fills-*.jsonl`.
- [ ] `domain/decimal.ts`: `Decimal.set({ precision: 34, rounding: Decimal.ROUND_HALF_EVEN })`; export `parse`, `format`, `isDecimalString`.
- [ ] `domain/blockCode.ts` + `domain/types.ts`: enums and interfaces verbatim from PRD §9.
- [ ] Copy `.env.example` → `.env`; create `config.json` with the demo thresholds.
- **DoD:** `npm test` runs (zero tests ok); `npm run build` typechecks clean; `domain/*` has no imports from `mcp/*`, `state/*`, `rules/*`.

---

## Step 1 — MCP proxy skeleton  `[R]`

- [ ] `mcp/upstreamClient.ts`: connect to `BINANCE_AGENT_OS_MCP_URL` over Streamable HTTP; expose `listTools()`, `callTool(name, args)`.
- [ ] `mcp/toolCatalog.ts`: `tools/list` with `TOOLS_LIST_TIMEOUT_MS` hard timeout `[D-1]`; resolve the 8 logical capabilities via per-capability candidate patterns; exclude `transfer|withdraw|futures|margin` `[D-6]`; on timeout or unresolved required capability → print ONE error, `exit(1)`.
- [ ] `mcp/inboundServer.ts`: MCP server on `127.0.0.1:SESSIONGUARD_INBOUND_PORT`; mirror the resolved tool schemas outward; build `Ticket` from a fixed param allow-list without mutating `rawParams`.
- [ ] `mcp/passthrough.ts`: forward an allowed call byte-for-byte; return the upstream response unmodified.
- [ ] `test/mockUpstream.ts`: MCP server implementing the resolved surface with scripted responses `[D-7]`.
- [ ] Tests: `toolCatalog` resolves a mocked `tools/list`; `passthrough` request/response diff = empty (INV-9); boot exits non-zero on `tools/list` timeout (BT via INV-12).
- **DoD:** an agent connects to SessionGuard and successfully places a trade that reaches the (mock) upstream and fills; `tools/list` through the proxy returns the upstream tool set; forwarded bodies are byte-identical to a direct call.

---

## Step 2 — Authenticate to Binance Agent OS  `[R]` scaffold / `[P]` live

- [ ] `[R]` `mcp/upstreamClient.ts`: attach `Authorization: Bearer ${BINANCE_AGENT_OS_BEARER_TOKEN}`; refuse non-HTTPS upstream unless `NODE_ENV=test` + `127.0.0.1`.
- [ ] `[R]` `401/403` handler: raise a fail-closed condition consumed by `rules/dataAvailability` (wired fully in Step 7a); optional single refresh via `BINANCE_AGENT_OS_REFRESH_TOKEN` `[D-4]`.
- [ ] `[R]` Unit test: mocked `401` → `DATA_UNAVAILABLE` fail-closed signal, never a silent stale-state retry.
- [ ] `[P]` Run the client OAuth bootstrap against the live endpoint; paste token into `.env`; scopes = `market-data,account,trade:spot` (never `transfer`) `[D-6]`.
- [ ] `[P]` Live read: fetch Agentic sub-account balances.
- **DoD:** `[P]` SessionGuard reads balances and places a real spot order on the Agentic sub-account; a revoked/expired token produces a fail-closed block, not an unguarded forward. `[R]` the `401→DATA_UNAVAILABLE` path is unit-proven against MockUpstream.

---

## Step 3 — Capture fills into session state  `[R]` parser / `[P]` live reconcile

- [ ] `state/ledger.ts`: append-only `Fill[]`; per-symbol `SymbolPosition`; average-cost realized P&L; trend fields (`lastTradeQty`, `lastRealizedDelta`, `lastTradeWasLoss`, `lastTradeSide`).
- [ ] `mcp/passthrough.ts` post-forward hook: parse fill price/qty/commission/`transactTime`; on a thin response call `trade.queryOrder` (if resolved) else mark the fill unresolved and fail closed on the fee.
- [ ] Tests: parse recorded payload shapes (partial fill, multi-fill array, commission in BNB); `trade.queryOrder` fallback; BNB-fee conversion missing → parse fails closed (PN-7).
- [ ] `[P]` place two real test trades; assert ledger prices match the Binance UI trade history.
- **DoD:** the ledger accurately reflects two manually-placed test trades (price, qty, commission, timestamp) — `[R]` via recorded/mock payloads, `[P]` cross-checked against Binance UI.

---

## Step 4 — Compute running P&L  `[R]`

- [ ] `market/marketReader.ts`: `market.price` / `market.klines` with `dataFetchTimeoutMs`, `fetchedAt` stamp, `stale` flag, `ok` flag, sanity clamp vs klines close (`SG_PRICE_SANITY_MAX_DEVIATION_PCT`).
- [ ] `state/pnl.ts`: realized (from ledger) + unrealized (`netQuantity × (markPrice − avgEntryPrice)`); `runningEquity = startingEquity + realized + unrealized`; `drawdownPct = (runningEquity − startingEquity) / startingEquity × 100`. All `decimal.js`.
- [ ] Tests: PN-1..PN-8; the 3-trade scripted sequence matches a hand calculation with **exact string equality** (no `toBeCloseTo`); INV-1 property test (profitable fill never reduces realized); position-flip accounting.
- **DoD:** P&L number matches the manual calculation for a scripted 3-trade sequence exactly, not approximately.

---

## Step 5 — Drawdown threshold check  `[R]`

- [ ] `rules/evaluate.ts`: author the FIXED-ORDER pipeline now — kill-switch → dataAvailability(stub pass) → drawdown → velocity(stub pass) → ladder(stub pass) `[D-3]`; assemble frozen `RuleContext`; stop at first failure; produce `Decision`; on failure call `sessionStore.halt(code, detail)` once.
- [ ] `state/sessionStore.ts`: `Session` lifecycle, kill-switch flag, `configVersion`, `halt()`.
- [ ] `rules/drawdown.ts`: block when `drawdownPct <= −config.drawdownPctLimit`; `observed`/`threshold` code-computed strings.
- [ ] MCP error payload shape carrying `code` + `detail` + `receipt`.
- [ ] Tests: DD-1..DD-8; EV-1..EV-9 (pipeline order, halt short-circuit, provenance INV-6); integration IT-2 (`drawdown.json` trips at the configured %).
- **DoD:** a scripted losing sequence trips the halt at the configured %.

---

## Step 6 — Trade-velocity counter  `[R]`

- [ ] `state/velocityWindow.ts`: timestamp list of ALLOWED+forwarded trades; `count(now, windowSeconds)` with inclusive boundary.
- [ ] `rules/velocity.ts`: block when in-window count `>= config.velocityMaxTrades`.
- [ ] Wire the post-forward hook so only executed trades append (INV-7).
- [ ] Tests: VL-1..VL-5; integration IT-3 (`velocity.json` trips), IT-4 (blocked trade does not append).
- **DoD:** a rapid-fire test sequence trips the halt.

---

## Step 7 — Position / ladder trend tracker  `[R]`

- [ ] `rules/ladder.ts`: if the ticket increases same-direction exposure on symbol S, and `S.lastTradeWasLoss`, and `ticket.quantity > S.lastTradeQty × config.ladderMultipleLimit` → block.
- [ ] Confirm `ledger.ts` trend fields update correctly on flat→re-entry and on position flip.
- [ ] Tests: LD-1..LD-8 (loss+2× blocks, loss+1.2× allows, 1.5× exactly allows, win+5× allows, opposite-direction allows, no-history allows, re-entry-after-loss blocks); integration IT-5 (`ladder.json` trips).
- **DoD:** a scripted martingale-style sequence trips the halt.

---

## Step 7a — Fail-closed on missing data  `[R]`

- [ ] `rules/dataAvailability.ts` replaces the stub as rule 1 `[D-3]`: block with `DATA_UNAVAILABLE` on any `!ok` / `stale` / non-positive price / missing quote-asset balance / sanity-clamp failure / upstream `401-403`.
- [ ] `market/accountReader.ts`: `account.balances` → `equityUsdt`; `ok`/`stale` flags; starting-equity snapshot method.
- [ ] Harden `marketReader` / `accountReader` timeouts; wire the Step 2 `401/403` signal.
- [ ] Tests: DA-1..DA-10 (throw, timeout, price 0/−1, stale 30s, missing USDT, sanity clamp, 401, no-coercion INV-3); reader timeout suite (no hang); integration IT-6 (`data-loss.json` trips, no forward).
- **DoD:** a forced (mocked) API failure trips the halt with `DATA_UNAVAILABLE` instead of silently passing.

---

## Step 8 — Config file  `[R]`

- [ ] `config/schema.ts` (zod): `drawdownPctLimit` decimal string > 0; `velocityWindowSeconds`/`velocityMaxTrades` int > 0; `ladderMultipleLimit` decimal string ≥ 1; `allowedSymbols` non-empty ⊆ {BTCUSDT,ETHUSDT,BNBUSDT}; `priceStalenessSeconds`/`dataFetchTimeoutMs` int > 0.
- [ ] `config/load.ts`: validate at boot (invalid → one error, `exit(1)`); assign monotonic `configVersion`; optional `SG_*` env overrides.
- [ ] Tests: invalid configs rejected (negative drawdown, unknown symbol, `ladderMultipleLimit: 0.5`); a valid edit changes trip behaviour with no code change; `configVersion` increments on reload.
- **DoD:** changing config changes trip behaviour without code changes; invalid config is refused at boot.

---

## Step 9 — Audit log  `[R]`

- [ ] `audit/auditLog.ts`: append-only JSONL at `evidence/audit-<sessionId>.jsonl`; rows for `SESSION_START` (incl. resolved `ToolCatalog` + raw `tools/list` `[D-1]`), `TOOL_CALL`, `CONFIG_CHANGE`, `RESET`; monotonic `logId`; `forwardedResponseDigest` (sha256 + fill summary, never full payload / headers / token).
- [ ] `audit/receipt.ts`: structured receipt returned to the agent on every decision (state + rule results only).
- [ ] Run-reconstruction reader: rebuild the trade-by-trade cumulative P&L curve from rows alone.
- [ ] `GET /audit` endpoint (localhost).
- [ ] Tests: one row per decision (INV-11); append-only (no rewrites); logId-gap detection; IT-8 (kill process, reconstruct == live run); token/redaction test (no `Bearer` string in any row).
- **DoD:** the log fully reconstructs a demo run after the fact.

---

## Step 10 — Manual reset  `[R]`

- [ ] `admin/resetEndpoint.ts`: `npm run rearm` CLI + `POST /admin/rearm` — new `sessionId`, fresh starting-equity snapshot (fail closed if it fails), cleared ledger + velocity window, `status = ACTIVE`, one `RESET` row `[D-8]`.
- [ ] `admin/configEndpoint.ts`: `POST /admin/config` — zod-validate, version-bump, one `CONFIG_CHANGE` row.
- [ ] Both bind to `127.0.0.1:SESSIONGUARD_ADMIN_PORT`, require `SESSIONGUARD_ADMIN_TOKEN`.
- [ ] Tests: re-arm clears halt + new session id; re-arm without token refused; one `RESET` row per re-arm; INV-8 (post-reset baseline is the fresh snapshot; pre-reset fills have no effect); IT-7.
- **DoD:** the agent can resume trading after a human re-arms.

---

## Step 11 — Minimal dashboard / CLI view  `[R]`

- [ ] `GET /state` (localhost): serialize `StateSnapshot` + config summary; all decimals as strings (no `number`).
- [ ] `view/dashboard.ts`: terminal renderer + single-file inline-HTML/JS web view polling `/state` ~1s; shows running P&L (realized/unrealized/total), drawdown vs limit, trades in window vs limit, per-symbol net + last-trade-was-loss, kill-switch, `haltReason`, `configVersion`.
- [ ] Tests: `/state` emits strings not numbers; manual — dashboard final numbers == last audit `StateSnapshot`.
- **DoD:** a judge can watch state change in real time during the demo.

---

## Step 12 — Wire up System 1 (reference agent)  `[R]` script agent / `[P]` Claude Code live

- [ ] `[R]` `evidence/scenarioRunner.ts` (agent 1b): emit a configurable ordered `trade.placeOrder` sequence against `SESSIONGUARD_INBOUND_URL`.
- [ ] `[R]` Integration: 1b's sequence produces the expected ledger and decisions against MockUpstream.
- [ ] `[P]` Point Claude Code (agent 1a) at `SESSIONGUARD_INBOUND_URL`; system prompt trades a named symbol, no risk instructions; place one real small trade end-to-end.
- **DoD:** the agent successfully trades end-to-end through the proxy — `[R]` scripted agent vs MockUpstream, `[P]` Claude Code vs live.

---

## Step 13 — Script the three demo scenarios  `[R]`

- [ ] `evidence/scenarios/{happy,drawdown,velocity}.json` (+ `ladder.json`, `data-loss.json` for TESTING): ordered tickets, scripted MockUpstream fill/price responses, injected errors, `expected` block (terminal outcome, `BlockCode`, final drawdown, counts).
- [ ] `test/mockUpstream.ts` supports scripted fills, prices, and error injection matching recorded real payload shapes.
- [ ] Tests: IT-1..IT-6, IT-9 — each scenario run 10× produces byte-identical audit logs (modulo timestamps) and the same terminal `BlockCode`.
- **DoD:** all three scenarios run reliably on repeat.

---

## Step 13a — Baseline comparison + headline metric  `[R]`

- [ ] `evidence/baseline.ts`: run each losing scenario twice — `supervised` (through SessionGuard) and `unsupervised` (agent → mock upstream directly, no proxy). Append to `evidence/results.csv`: `scenario, mode, halted, halt_trade_index, final_drawdown_pct, trades_executed, fee_to_gross_pnl`.
- [ ] Headline generator: pure function of the CSV → `evidence/headline.txt` (e.g. "Across N scripted sessions, SessionGuard halted before further loss in every case; the unsupervised agent kept trading through all N.").
- [ ] Tests: BL-1..BL-5 — supervised halts every losing scenario; unsupervised never halts and ends deeper; sentence integers == CSV row counts; re-run reproduces the CSV row-for-row.
- **DoD:** the sentence is reproducible by re-running the script, and the CSV backs it row for row.

---

## Step 14 — Record demo video + polish README  `[R]`

- [ ] Run `DEMO.md` pre-flight (0.1–0.7); `npm test` fully green incl. the grep assertions (SECURITY §5, TESTING §6).
- [ ] Record the 11-step script against MockUpstream; optional B-roll for the other two codes.
- [ ] `README.md`: architecture diagram (from `ARCHITECTURE.md`), setup steps (`.env.example` → tools/list → arm → run agent), links to all six companion docs, `evidence/` contents.
- [ ] Fresh-clone check: `npm ci` + README steps → armed proxy + a passing scenario run.
- **DoD:** video + GitHub match Binance's Track A submission requirements (PRD §12).

---

## Step 15 — Submit  `[R]`

- [ ] Operator self-confirms jurisdiction eligibility (not US/UK/EEA/HK/SG/prohibited list) `[D-9]`.
- [ ] Push the public GitHub repo (code + 6 docs + `evidence/`).
- [ ] Follow **@Binance** and repost the hackathon announcement.
- [ ] Quote-repost with the video/demo + GitHub link.
- [ ] Complete the survey.
- [ ] Confirm all three entry actions done before **2026-09-08 23:59 UTC**.
- **DoD:** all three entry steps confirmed before 23:59 UTC today.

---

## Post-submit  `[P]` (only after Step 15 is confirmed — D-0)

- [ ] Live OAuth bootstrap; token into `.env`.
- [ ] MV-1..MV-5 (`TESTING.md` §10): live `tools/list` through the proxy, one tiny real spot fill, token-revocation fail-closed, live 3-trade P&L exactness.
- [ ] If live evidence is clean, add a short addendum clip / note to the repo — never replace the MockUpstream submission.
