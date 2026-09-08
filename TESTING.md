# SessionGuard — TESTING.md

Companion to `PRD.md`. Test stack: **Vitest** + `decimal.js`. No network in unit tests — `rules/*` are pure functions over a frozen `RuleContext` (ARCHITECTURE §6); readers, ledger, and session store are injected fakes. Integration tests run the real proxy against **MockUpstream** (D-0, D-7).

Coverage gate: 100% of `rules/*` and `state/pnl` + `state/ledger` branches; every invariant in §7 has at least one dedicated test; the grep assertion in §6 is a required build step.

---

## 1. Unit tests — `rules/drawdown`

Config for this suite: `drawdownPctLimit: "5"`, `startingEquity: "1000"`.

| # | `RuleContext` | Expected `RuleResult` |
|---|---|---|
| DD-1 | realized −10, unrealized −39 → equity 951 → drawdownPct −4.9 | `pass: true` |
| DD-2 | equity 950 → drawdownPct −5.0 (exactly at limit) | `pass: false`, `code: DRAWDOWN_BREACH`, `observed: "-5"`, `threshold: "-5"` |
| DD-3 | equity 938 → drawdownPct −6.2 | `pass: false`, `code: DRAWDOWN_BREACH`, `observed: "-6.2"` |
| DD-4 | equity 1120 → drawdownPct +12 (in profit) | `pass: true` |
| DD-5 | realized +50, unrealized −60 → equity 990 → −1.0 | `pass: true` |
| DD-6 | `observed`/`threshold` are strings produced by `decimal.js` formatting, not from `ctx.ticket` or any tool response | assert provenance: mutate a `detail`-shaped field in the ticket to `"-99"` → `observed` unchanged |
| DD-7 | floating-point trap: equity `999.9999999999999` vs a naive float `1000 * 0.95` | decimal comparison is exact; `pass: true`; no `toBeCloseTo` anywhere |
| DD-8 | drawdown computed **only** from realized when `ctx.market.ok === false` is NOT reached here (data rule fires first) — assert `drawdown` is never called when rule 1 fails | pipeline test in §3 |

---

## 2. Unit tests — `rules/dataAvailability`

Config: `priceStalenessSeconds: 10`, `dataFetchTimeoutMs: 3000`.

| # | `ctx.market` / `ctx.account` | Expected |
|---|---|---|
| DA-1 | market `{ ok: true, stale: false, markPrice: "64000" }`, account `{ ok: true, stale: false, equityUsdt: "1000" }` | `pass: true` |
| DA-2 | market `{ ok: false }` (read threw) | `pass: false`, `code: DATA_UNAVAILABLE` |
| DA-3 | market `{ ok: true, stale: true }` (fetchedAt 30s ago) | `pass: false`, `code: DATA_UNAVAILABLE` |
| DA-4 | market `{ ok: true, markPrice: "0" }` | `pass: false`, `code: DATA_UNAVAILABLE` |
| DA-5 | market `{ ok: true, markPrice: "-1" }` | `pass: false`, `code: DATA_UNAVAILABLE` |
| DA-6 | market ok, account `{ ok: false }` | `pass: false`, `code: DATA_UNAVAILABLE` |
| DA-7 | market ok, account `{ ok: true, balances: {} }` (no USDT key) | `pass: false`, `code: DATA_UNAVAILABLE` |
| DA-8 | market `{ ok: true, markPrice: "90000" }` while klines close is `"64000"` (>20% off) | `pass: false`, `code: DATA_UNAVAILABLE` (sanity clamp, SECURITY §2) |
| DA-9 | reader simulated `401` → `marketReader` returns `{ ok: false, reason: "upstream-401" }` | `pass: false`, `code: DATA_UNAVAILABLE` |
| DA-10 | **no coercion**: `ctx.market` absent/`undefined` | `pass: false`, `code: DATA_UNAVAILABLE` — never treated as `0` or "previous value" (INV-4) |

`marketReader` / `accountReader` own timeout tests (separate suite): a fake upstream that never resolves → reader rejects/returns `{ ok: false }` within `dataFetchTimeoutMs + margin`; asserts no hang.

---

## 3. Unit tests — `rules/evaluate` pipeline order (D-3)

| # | Setup | Expected |
|---|---|---|
| EV-1 | session `HALTED`, `haltReason: VELOCITY_EXCEEDED` | returns immediately with `VELOCITY_EXCEEDED`; `marketReader`/`accountReader` **not called** (spy asserts 0 calls); rules 1–4 not run |
| EV-2 | data unavailable **and** drawdown breached **and** velocity exceeded | single `code: DATA_UNAVAILABLE`; `ruleResults` length 1; drawdown/velocity never evaluated |
| EV-3 | data ok, drawdown breached **and** velocity exceeded | `code: DRAWDOWN_BREACH`; `ruleResults` length 2 (data pass, drawdown fail) |
| EV-4 | data ok, drawdown ok, velocity exceeded **and** ladder pattern present | `code: VELOCITY_EXCEEDED`; `ruleResults` length 3 |
| EV-5 | all pass | `outcome: ALLOWED`; `ruleResults` length 4, all `pass: true` |
| EV-6 | symbol not in `allowedSymbols` | `RefusalCode.SYMBOL_NOT_WHITELISTED`; no reads; not a `BlockCode`; session not halted |
| EV-7 | fixed order asserted structurally: `ruleResults.map(r => r.rule)` on an all-pass run === `["DATA_AVAILABILITY","DRAWDOWN","VELOCITY","LADDER"]` |
| EV-8 | a failing rule calls `sessionStore.halt(code, detail)` exactly once with the same `code` it returned |
| EV-9 | `RuleContext` passed to each rule is frozen (`Object.isFrozen` true); a rule that tries to mutate it throws in the test harness |

---

## 4. Unit tests — `rules/velocity`

Config: `velocityWindowSeconds: 900`, `velocityMaxTrades: 5`.

| # | `tradeTimestamps` relative to `now` | Expected |
|---|---|---|
| VL-1 | `[-800s, -600s, -400s, -100s]` (4 in window) | `pass: true`, `observed: "4"` |
| VL-2 | `[-800s, -700s, -600s, -300s, -100s]` (5 in window) | `pass: false`, `code: VELOCITY_EXCEEDED`, `observed: "5"`, `threshold: "5"` |
| VL-3 | `[-1000s, -950s, -920s, -500s, -100s]` (3 aged out, 2 in window) | `pass: true`, `observed: "2"` |
| VL-4 | timestamp exactly at `now - 900s` boundary | documented: boundary is **inclusive** (counts); test pins the choice |
| VL-5 | only forwarded+allowed trades are in the list — a blocked trade does not append (integration cross-check in §5) |

---

## 5. Unit tests — `rules/ladder`

Config: `ladderMultipleLimit: "1.5"`.

| # | `ctx.ledger.positions[symbol]` + incoming ticket | Expected |
|---|---|---|
| LD-1 | last trade qty `1.0`, `lastTradeWasLoss: true`, incoming same-direction qty `2.0` (2.0 > 1.0×1.5) | `pass: false`, `code: LADDER_DETECTED`, `observed: "2"`, `threshold: "1.5"` |
| LD-2 | last qty `1.0`, loss, incoming `1.2` (< 1.5×) | `pass: true` |
| LD-3 | last qty `1.0`, loss, incoming `1.5` exactly (== 1.5×) | documented: `>` strictly, so `1.5×` **allows**; test pins it |
| LD-4 | last qty `1.0`, **win** (`lastTradeWasLoss: false`), incoming `5.0` | `pass: true` (ladder only fires after a loss) |
| LD-5 | last qty `1.0`, loss, incoming `3.0` but **opposite direction / reduces exposure** | `pass: true` (not a martingale add) |
| LD-6 | no prior trade on symbol (`positions[symbol]` undefined) | `pass: true` |
| LD-7 | last trade flat→loss realized, position now 0, incoming re-entry qty `2.0` after `1.0` loss | `pass: false`, `code: LADDER_DETECTED` (size-up after a realized loss even from flat) |
| LD-8 | `lastRealizedDelta` decimal `-0.00000001` → `lastTradeWasLoss: true` (any negative) |

---

## 6. Unit tests — `state/pnl` and `state/ledger`

| # | Scenario | Expected (exact string equality, `decimal.js`) |
|---|---|---|
| PN-1 | buy 0.01 BTC @ 60000, mark 60000 | realized `"0"`, unrealized `"0"` |
| PN-2 | buy 0.01 @ 60000 (fee 0.6 USDT), mark 61000 | unrealized `"10"`, realized `"-0.6"` (fee), drawdownPct from equity |
| PN-3 | buy 0.01 @ 60000, sell 0.01 @ 59000 (fees 0.6 + 0.59) | realized `"-11.19"`; positions[BTCUSDT].netQuantity `"0"` |
| PN-4 | 3-trade scripted sequence from `evidence/scenarios/drawdown.json` | matches hand-calculated `expected.pnl` **exactly** (the Step 4 DoD) |
| PN-5 | position flip: buy 0.02 @ 60000, sell 0.03 @ 61000 | realized on the 0.02 closed; net `-0.01` (short) @ avg 61000 |
| PN-6 | **profitable fill never reduces cumulative realized** (INV-1): property test over 500 random fill sequences — `realizedPnl` after a positive-delta fill ≥ `realizedPnl` before it |
| PN-7 | commission in BNB, not USDT — converted at a provided rate snapshot; if rate missing → the fill parse fails closed (does not silently drop the fee) |
| PN-8 | all numeric fields in the serialized `StateSnapshot` are `typeof === "string"` (no `number` leaks) |

**Grep assertion (SECURITY §5, required build step):**

```
grep -RInE 'withdraw|external.?address|universalTransfer|sapi/v1/capital|/wallet/withdraw|transfer(To|From)?Master|withdrawApply' src/
# expected: zero matches → test passes; any match → test fails
```

Second grep (P-2): flag `number`-typed arithmetic on money fields —

```
grep -RInE '\b(price|quantity|qty|equity|pnl|drawdown|commission)\b\s*[-+*/]\s*' src/ | grep -v 'new Decimal\|\.plus(\|\.minus(\|\.times(\|\.div(\|\.cmp('
# expected: zero matches
```

---

## 7. Invariants that must never break

Each has ≥1 dedicated test; several are property-based.

| ID | Invariant | Enforced by |
|---|---|---|
| **INV-1** | A profitable fill never *reduces* the cumulative realized P&L used for future drawdown checks. | PN-6 property test |
| **INV-2** | An expired, `HALTED`, or unarmed session **never forwards a trade**. | EV-1; integration IT-6; `SESSION_NOT_ARMED` refusal test |
| **INV-3** | A missing / errored / stale data point is **never** treated as `0` or as "assume previous value". | DA-2, DA-3, DA-10; reader timeout suite |
| **INV-4** | Exactly **one** `BlockCode` per blocked decision; evaluation stops at the first failing rule. | EV-2, EV-3, EV-4 |
| **INV-5** | The drawdown check never runs on a `stale` or `!ok` market snapshot (rule 1 fires first). | EV-2; DA-3 + pipeline spy |
| **INV-6** | The block decision and its `observed`/`threshold` numbers are a **pure function** of `(ledger, live reads, config)` — never of model output or ticket-supplied text. | DD-6; SECURITY §1 injection suite |
| **INV-7** | Only **allowed + forwarded** trades append to the velocity window and the ledger. A blocked trade changes neither. | IT-4 cross-check; VL-5 |
| **INV-8** | After `POST /admin/rearm`: new `sessionId`, drawdown baseline = the **fresh** equity snapshot; pre-reset fills have zero effect on post-reset checks (D-8). | IT-7 |
| **INV-9** | Forwarded request args and the upstream response are byte-identical to a direct call (proxy transparency). | IT-1 diff test |
| **INV-10** | No upstream tool outside the resolved `ToolCatalog` is ever forwarded; transfer/withdraw/futures/margin are refused. | catalog exclusion test; SECURITY §5 |
| **INV-11** | Every decision writes exactly one append-only audit row; the run reconstructs from rows alone. | §8 IT-8 |
| **INV-12** | Boot fails closed: invalid config, `tools/list` timeout, unresolved required capability, or failed starting-equity read → one error message, `exit(1)`, no partial start (D-1). | boot suite BT-1..BT-4 |

---

## 8. Integration tests — MockUpstream (the three demo scenarios + two extra)

MockUpstream implements the resolved tool surface and replays a scenario file: ordered tickets, scripted fill/price responses, optional injected errors, and an `expected` block (terminal outcome, terminal `BlockCode`, final `drawdownPct`, blocked/allowed counts).

| ID | Scenario file | Asserts |
|---|---|---|
| **IT-1** | `happy.json` — 3 small well-spaced BTCUSDT buys, mild positive drift | all `ALLOWED`; forwarded args diff = empty (INV-9); dashboard `/state` final numbers == last audit `StateSnapshot`; session `ACTIVE` |
| **IT-2** | `drawdown.json` — 4 scripted losses, cumulative crosses −5% on trade 4; trade 5 attempted | trades 1–4 `ALLOWED`; trade 5 `BLOCKED` `DRAWDOWN_BREACH`, `observed` ≈ `-6.2`; session `HALTED`; trade 6 blocked at kill-switch with same code; upstream never received trade 5 (MockUpstream call log) |
| **IT-3** | `velocity.json` — 6 trades within 15 min, limit 5 | trades 1–5 `ALLOWED`; trade 6 `BLOCKED` `VELOCITY_EXCEEDED`, `observed: "5"`; `HALTED` |
| **IT-4** | `velocity.json` cross-check | after the block, velocity window count and ledger fill count are unchanged by the blocked trade (INV-7) |
| **IT-5** | `ladder.json` — buy 1.0 (loss), then buy 2.0 same symbol; multiple 1.5 | trade 2 `BLOCKED` `LADDER_DETECTED`, `observed: "2"`; `HALTED` |
| **IT-6** | `data-loss.json` — MockUpstream returns error / 30s-stale price on the 3rd read | trade 3 `BLOCKED` `DATA_UNAVAILABLE`; no forward; `HALTED`; a `HALTED` session never forwards (INV-2) |
| **IT-7** | `drawdown.json` then `POST /admin/rearm` then `happy.json` | re-arm → new `sessionId`, fresh baseline; post-reset trades `ALLOWED`; pre-reset losses do not count (INV-8); exactly one `RESET` audit row |
| **IT-8** | any scenario, kill process mid-run, re-read `evidence/audit-*.jsonl` | trade-by-trade cumulative P&L curve and terminal decision reconstructed from rows == live run (INV-11) |
| **IT-9** | each scenario run 10× | byte-identical audit logs modulo timestamps; identical terminal `BlockCode` (Step 13 DoD) |

---

## 9. Integration tests — baseline comparison (Step 13a)

| ID | Asserts |
|---|---|
| **BL-1** | `evidence/baseline.ts` runs each losing scenario (`drawdown`, `velocity`, `ladder`, `data-loss`) twice: `supervised` and `unsupervised`. |
| **BL-2** | `evidence/results.csv` has one row per (scenario × mode); columns `scenario, mode, halted, halt_trade_index, final_drawdown_pct, trades_executed, fee_to_gross_pnl`. |
| **BL-3** | supervised rows: `halted == true` for every losing scenario; unsupervised rows: `halted == false`, `trades_executed` == full sequence length, `final_drawdown_pct` strictly worse than the supervised row's. |
| **BL-4** | the headline sentence generator is a **pure function** of the CSV: same CSV in → identical `evidence/headline.txt`; the integers in the sentence equal the CSV row counts. |
| **BL-5** | re-running `baseline.ts` reproduces `results.csv` row-for-row (Step 13a DoD). |

---

## 10. Manual verification checklist (live, post-submit only — D-0)

Not on the critical path. Run only after Step 15 is submittable.

| # | Action | Pass condition |
|---|---|---|
| MV-1 | `claude mcp add` SessionGuard; `tools/list` through the proxy | returns the resolved upstream tool set |
| MV-2 | SessionGuard boot against the live endpoint | OAuth completes; `SESSION_START` row shows the resolved `ToolCatalog` |
| MV-3 | one tiny real spot buy on the Agentic sub-account through the proxy | `ALLOWED`, forwarded, fill parsed; ledger price matches the Binance UI trade history (Step 3 DoD) |
| MV-4 | revoke the token in the Binance UI mid-session, attempt a trade | next trade `BLOCKED` `DATA_UNAVAILABLE`; no unguarded forward (SECURITY §3) |
| MV-5 | 3-trade scripted sequence live | P&L on the dashboard matches a hand calculation exactly (Step 4 DoD) |
